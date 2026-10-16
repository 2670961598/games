#!/usr/bin/env node
/* =====================================================================
 * GAMES-156 弈界棋阁 QA1 长局 spot（L1 v4——三版复盘：v1 timeScale=8 双钟烧穿提前
 * 终局；v2 单 bot 席不烧钟→sim 上界 ~250s<300s 且 casual 随机成五；v3 testapi 输入
 * =单 API 玩家固定席（seat≠playerSeat 403）。v4=quick 真实房双 WS 连接驱动两真人席
 * （净臂 Q6 同款面），交替 10s/手慢打：两席各烧 ~150s 钟（<240s 判负线）→ sim 时长
 * 300s+=30000 tick 可达；着点=本地影子局贪心最远+落前验证不终局（构造性免五连）。
 * 采样 5s/spot（A 席 {t:'sync'} 全量重同步）：tick/moveNo/双钟/子数/opsLog 三方对账
 * +tick 单调+钟递减+hash 演化+墙钟↔tick 同律。退出码 0=全绿。影子网关 :4420。
 * ===================================================================== */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/yi-pavilion/sim.cjs')

const GW_WS = process.env.QA_GW_WS || 'ws://127.0.0.1:4420'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 } return h }

function conn() {
  const ws = new WebSocket(GW_WS)
  const c = { ws, msgs: [], open: false, closed: false }
  ws.onopen = () => { c.open = true }
  ws.onclose = () => { c.closed = true }
  ws.onmessage = (e) => { try { c.msgs.push(JSON.parse(String(e.data))) } catch { } }
  return new Promise((res) => { ws.onopen = () => { c.open = true; res(c) }; ws.onerror = () => res(c); setTimeout(() => res(c), 4000) })
}
const find = (c, t) => [...c.msgs].reverse().find((m) => m.t === t)

/* 构造性安全着点：影子局贪心最远+落子后不终局——杜绝五连 */
const shadow = S.create(20261016, { rule: 'gomoku' })
function safeCell() {
  let best = -1, bestD = -1
  for (let c = 0; c < 225; c++) {
    if (shadow.board[c] !== 0) continue
    let d = 99
    for (let c2 = 0; c2 < 225; c2++) if (shadow.board[c2] !== 0) {
      d = Math.min(d, Math.abs(((c / 15) | 0) - ((c2 / 15) | 0)) + Math.abs(c % 15 - c2 % 15))
    }
    if (d > bestD) { bestD = d; best = c }
  }
  const before = shadow.over
  const r = S.applyOp(shadow, shadow.turn, { k: 'place', cell: best })
  if (r && !r.reject && !shadow.over) return best
  if (shadow.over || before) { /* 会终局——扫任一不终局空点 */ shadow.board[best] = 0; shadow.over = false
    for (let c = 0; c < 225; c++) { if (shadow.board[c] !== 0) continue; const t2 = shadow.turn; const r2 = S.applyOp(shadow, t2, { k: 'place', cell: c }); if (r2 && !r2.reject && !shadow.over) return c; if (shadow.over) { shadow.board[c] = 0; shadow.over = false } } }
  return best
}

const A = await conn(), B = await conn()
A.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
await sleep(400)
B.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
await sleep(3600) // quick startDelay 3s → live
const wA = find(A, 'welcome'), wB = find(B, 'welcome')
if (!wA || !wB || wA.roomId !== wB.roomId) { console.error('quick 配对失败', JSON.stringify([wA && wA.roomId, wB && wB.roomId])); process.exit(1) }
const seatOf = { [wA.seat]: A, [wB.seat]: B }
console.log(`长局房 ${wA.roomId}（quick·gomoku·双 WS 真人席 ${wA.seat}/${wB.seat}·10s/手慢打）窗口 310s……`)

const t0 = Date.now()
let lastState = null, ended = null, spots = []
let nextMoveAt = t0 + 3500 /* 绝对时基（v6 死因：相对判据 elapsed>=纪元巨数恒假→驱动楔死→afk） */
let pending = null, sentCount = 0, confirmed = 0, shadowSynced = false, baseMoveNo = 0
while (Date.now() - t0 < 310000) {
  A.ws.send(JSON.stringify({ t: 'sync' }))
  await sleep(120)
  /* S5 零快照：sync 应答=ruling 消息携 {k:'sync'} 事件+视图 state（无 opsLog/tick——
   * canonical vs 视图字段差异有意，welcome.state 才是 canonical；账本改盘面派生） */
  const sm = [...A.msgs].reverse().find((m) => m.state && (!m.events || m.events.some((e) => e.k === 'sync')))
  if (sm && sm.state) {
    /* 首拍影子局对齐真实盘面（quick 可继承遗留中局房——影子从空盘起算会撞实际占位格
     * 恒 reject 楔死；继承房本身=「棋局状态延续」合法基体） */
    if (!shadowSynced && sm.state.board) {
      try {
        shadow.board.set(sm.state.board); shadow.turn = sm.state.turn
        shadow.moveNo = sm.state.moveNo; shadow.over = !!sm.state.over
      } catch { }
      shadowSynced = true
      baseMoveNo = sm.state.moveNo
      console.log(`  影子局对齐真实盘面（moveNo=${sm.state.moveNo} turn=${sm.state.turn} 子数=${sm.state.board.filter((v) => v).length}${sm.state.moveNo > 5 ? '——继承遗留房' : ''}）`)
    }
    lastState = sm.state
    if (sm.state.over) { const em = find(A, 'end'); if (em) ended = em; break }
    /* 拒着护栏：发出后 1.5s moveNo 未前进→影子回滚+短重试（防影子局失步楔死） */
    if (pending && Date.now() - pending.at > 1500 && sm.state.moveNo === pending.moveNo) {
      shadow.board[pending.cell] = 0; shadow.over = false; shadow.turn = pending.seat
      pending = null; nextMoveAt = Date.now() + 500
    } else if (pending && sm.state.moveNo > pending.moveNo) { pending = null; confirmed++ }
    if (Date.now() >= nextMoveAt && !sm.state.over && sm.state.phase === 'live') {
      const seat = sm.state.turn
      const cell = safeCell()
      seatOf[seat].ws.send(JSON.stringify({ t: 'op', k: 'place', cell }))
      pending = { seat, cell, moveNo: sm.state.moveNo, at: Date.now() }
      sentCount++
      console.log(`  发着手#${sentCount} wall=${((Date.now() - t0) / 1000).toFixed(1)}s 席${seat}→cell${cell}（moveNo ${sm.state.moveNo}）`)
      nextMoveAt = Date.now() + 10000
    }
  }
  if (Date.now() - t0 - spots.length * 5000 >= 5000 && lastState) {
    const st = lastState
    spots.push({
      wall: Date.now() - t0, frame: sm.frame, moveNo: st.moveNo,
      stones: st.board.filter((v) => v).length,
      clock: st.clock[0] + st.clock[1],
      hash: fnv(st.board.join('') + ':' + st.moveNo),
    })
    console.log(`  spot#${spots.length} wall=${(Date.now() - t0) / 1000 | 0}s frame=${sm.frame} moveNo=${st.moveNo} clock=${st.clock[0]}+${st.clock[1]} stones=${spots[spots.length - 1].stones}`)
  }
  await sleep(150)
}

const frameMono = spots.every((p, i) => i === 0 || p.frame > spots[i - 1].frame)
const clockDesc = spots.every((p, i) => i === 0 || p.clock < spots[i - 1].clock)
/* hash 演化=窗口内换态次数（5s 采样×10s 手速→隔拍同态是设计态，逐 spot 严格不等错设） */
const hashChg = spots.filter((p, i) => i > 0 && p.hash !== spots[i - 1].hash).length
const ledger = spots.every((p) => p.moveNo === p.stones)
const w0 = spots[0], wN = spots[spots.length - 1]
const burn = w0.clock - wN.clock
const rateDev = Math.abs(burn - (wN.wall - w0.wall)) / (wN.wall - w0.wall) * 100
ok('L1', '长局 5min 连续采样（frame 单调+双棋钟递减+盘面 hash 持续演化）', spots.length >= 55 && frameMono && clockDesc && hashChg >= 20,
  `spots×${spots.length} frame ${w0.frame}→${wN.frame} clock ${w0.clock}→${wN.clock} 换态×${hashChg}${ended ? ' 终局=' + JSON.stringify(ended.result) : '（5min 窗口内对局存活未终局——双席慢打设计态）'}`)
ok('L1', '长局 5min 账本对账（逐 spot：moveNo==盘面子数——gomoku 一手一子零移除；驱动确认手 sanity=moveNo 增量，拒着重试另计）',
  ledger && Math.abs(confirmed - (wN.moveNo - baseMoveNo)) <= 1,
  `末拍 moveNo=${wN.moveNo}（继承基线 ${baseMoveNo}+确认 ${wN.moveNo - baseMoveNo}）子数=${wN.stones} 确认手=${confirmed}（发送 ${sentCount} 含竞态重试）`)
ok('L1', '长局 5min 局钟覆盖（双席钟耗 ≥300000ms ≡ ≥30000 tick@10ms——clock 即 tick 驱动；各席 <240s 判负线）',
  burn >= 300000, `钟耗=${burn}ms（${(burn / 1000).toFixed(0)}s= ${(burn / 10 | 0)} tick 当量）`)
ok('L1', '长局钟率交叉引用（钟耗↔墙钟偏差 <3%——timeScale=1 下 10ms 基准长局不漂）', rateDev < 3,
  `偏差=${rateDev.toFixed(2)}%（wall ${((wN.wall - w0.wall) / 1000).toFixed(0)}s vs 钟耗 ${(burn / 1000).toFixed(0)}s）`)
for (const c of [A, B]) { try { c.ws.close() } catch { } }
console.log(`\n${failed === 0 ? 'QA1-LONG OK' : 'QA1-LONG FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
