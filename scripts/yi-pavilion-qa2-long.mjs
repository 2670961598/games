#!/usr/bin/env node
/* =====================================================================
 * GAMES-160 弈界棋阁 QA2 长局 spot 8min（L 臂——QA1 L1 310s 的 8min 扩窗）
 *   quick 真实房双 WS 真人席（:4421 影子网关，与 :4420 quick 池隔离并行）
 *   10s/手慢打 480s：双席钟 240s×2 ⇒ 窗尾双钟逼近归零——钟尽终局（reason=clock）
 *   为设计态（长局钟耗上界数学的在线验证面），存活不终局同样可接受（披露）。
 *   LA1 连续采样（5s/spot×≥85）：frame 单调+双钟递减+盘面 hash 演化；
 *   LA2 账本对账：逐 spot moveNo==盘面子数；确认手==moveNo 增量；
 *   LA3 局钟覆盖：双席钟耗合计 ≥440000ms（≥30000 tick 当量×1.47——8min 窗）；
 *   LA4 钟率交叉引用：钟耗↔墙钟偏差 <3%（timeScale=1 长局不漂）；
 *   LA5 满编+观战在线长局：观战席全程收 ruling 流+原始帧与对局方逐字节恒等
 *      +满编第 3 连接 play join → 观战承接（长局语境复证 Q6 面）。
 * 退出码 0=全绿。QA 只读。影子网关 :4421。
 * ===================================================================== */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/yi-pavilion/sim.cjs')

const GW_WS = process.env.QA_GW_WS || 'ws://127.0.0.1:4421'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0 } return h }

function conn() {
  const ws = new WebSocket(GW_WS)
  const c = { ws, msgs: [], raw: [], open: false }
  ws.onmessage = (e) => { c.raw.push(String(e.data)); try { c.msgs.push(JSON.parse(String(e.data))) } catch { } }
  return new Promise((res) => { ws.onopen = () => { c.open = true; res(c) }; ws.onerror = () => res(c); setTimeout(() => res(c), 4000) })
}
const find = (c, t) => [...c.msgs].reverse().find((m) => m.t === t)

/* 构造性安全着点（QA1 L1 同款）：影子局贪心最远+落前验证不终局——杜绝五连 */
const shadow = S.create(20261016, { rule: 'gomoku' })
function safeCell() {
  let best = -1, bestD = -1
  for (let c = 0; c < 225; c++) {
    if (shadow.board[c] !== 0) continue
    let d = 99
    for (let c2 = 0; c2 < 225; c2++) if (shadow.board[c2] !== 0) d = Math.min(d, Math.abs(((c / 15) | 0) - ((c2 / 15) | 0)) + Math.abs(c % 15 - c2 % 15))
    if (d > bestD) { bestD = d; best = c }
  }
  const before = shadow.over
  const r = S.applyOp(shadow, shadow.turn, { k: 'place', cell: best })
  if (r && !r.reject && !shadow.over) return best
  if (shadow.over || before) {
    shadow.board[best] = 0; shadow.over = false
    for (let c = 0; c < 225; c++) { if (shadow.board[c] !== 0) continue; const t2 = shadow.turn; const r2 = S.applyOp(shadow, t2, { k: 'place', cell: c }); if (r2 && !r2.reject && !shadow.over) return c; if (shadow.over) { shadow.board[c] = 0; shadow.over = false } }
  }
  return best
}

/* 配对重滚：bothost 生态房常驻复燃（minLive 守恒，kill 即补位）——quick 优先命中
 * live bot 房（设计态）。8min 窗须双钟池 ≥470s（fresh=480s）——不足则 concede 释放
 * 该房、purge、退避重试（房局钟尽/终局后 respawn 新房钟池满）。上限 8 滚 ×12s。 */
let A = null, B = null, wA = null, wB = null
for (let roll = 1; roll <= 8; roll++) {
  A = await conn(); B = await conn()
  A.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
  await sleep(400)
  B.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
  await sleep(3600)
  wA = find(A, 'welcome'); wB = find(B, 'welcome')
  if (!wA || !wB || wA.roomId !== wB.roomId) { console.error(`roll${roll} quick 配对失败`); continue }
  const clk = (wA.state && wA.state.clock) || [0, 0]
  const pool = clk[0] + clk[1], mn = wA.state && wA.state.moveNo
  console.log(`  roll${roll} 房 ${wA.roomId} moveNo=${mn} 钟池=${pool}ms`)
  if (pool >= 470000) break /* 新鲜房（fresh≈480s）——够 8min 窗 */
  A.ws.send(JSON.stringify({ t: 'op', k: 'concede' })); B.ws.send(JSON.stringify({ t: 'op', k: 'concede' }))
  await sleep(1500)
  try { await fetch(`http://127.0.0.1:4421/api/test/room?roomId=${wA.roomId}`, { method: 'DELETE' }) } catch { }
  try { A.ws.close(); B.ws.close() } catch { }
  await sleep(12000) /* 退避：让该房终局/回收，等 respawn 新房 */
}
if (!wA || !wB || wA.roomId !== wB.roomId) { console.error('quick 配对失败（8 滚）'); process.exit(1) }
const seatOf = { [wA.seat]: A, [wB.seat]: B }
/* 观战席 + 满编第 3 连接（LA5）：全程挂在长局房 */
const C = await conn()
C.ws.send(JSON.stringify({ t: 'join', roomId: wA.roomId, mode: 'spectate', name: 'qa2-spectator' }))
await sleep(500)
const D = await conn()
D.ws.send(JSON.stringify({ t: 'join', roomId: wA.roomId, mode: 'play', name: 'qa2-third' }))
await sleep(600)
const wC = find(C, 'welcome'), wD = find(D, 'welcome')
const a0 = A.raw.length
console.log(`长局房 ${wA.roomId}（quick·gomoku·双 WS 真人席 ${wA.seat}/${wB.seat}·10s/手慢打·观战+第3连接挂载）窗口 480s……`)

const t0 = Date.now()
let lastState = null, ended = null, spots = []
let nextMoveAt = t0 + 3500
let pending = null, sentCount = 0, confirmed = 0, shadowSynced = false, baseMoveNo = 0
while (Date.now() - t0 < 480000) {
  A.ws.send(JSON.stringify({ t: 'sync' }))
  await sleep(120)
  const sm = [...A.msgs].reverse().find((m) => m.state && (!m.events || m.events.some((e) => e.k === 'sync')))
  if (sm && sm.state) {
    if (!shadowSynced && sm.state.board) {
      try { shadow.board.set(sm.state.board); shadow.turn = sm.state.turn; shadow.moveNo = sm.state.moveNo; shadow.over = !!sm.state.over } catch { }
      shadowSynced = true; baseMoveNo = sm.state.moveNo
      console.log(`  影子局对齐真实盘面（moveNo=${sm.state.moveNo} 子数=${sm.state.board.filter((v) => v).length}${sm.state.moveNo > 5 ? '——继承遗留房' : ''}）`)
    }
    lastState = sm.state
    if (sm.state.over) { const em = find(A, 'end'); if (em) ended = em; break }
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
      nextMoveAt = Date.now() + 10000
    }
  }
  if (Date.now() - t0 - spots.length * 5000 >= 5000 && lastState) {
    const st = lastState
    spots.push({ wall: Date.now() - t0, frame: sm.frame, moveNo: st.moveNo, stones: st.board.filter((v) => v).length, clock: st.clock[0] + st.clock[1], hash: fnv(st.board.join('') + ':' + st.moveNo) })
    console.log(`  spot#${spots.length} wall=${(Date.now() - t0) / 1000 | 0}s frame=${sm.frame} moveNo=${st.moveNo} clock=${st.clock[0]}+${st.clock[1]} stones=${spots[spots.length - 1].stones}`)
  }
  await sleep(150)
}

const frameMono = spots.every((p, i) => i === 0 || p.frame > spots[i - 1].frame)
const clockDesc = spots.every((p, i) => i === 0 || p.clock < spots[i - 1].clock)
const hashChg = spots.filter((p, i) => i > 0 && p.hash !== spots[i - 1].hash).length
const ledger = spots.every((p) => p.moveNo === p.stones)
const w0 = spots[0], wN = spots[spots.length - 1]
const burn = w0.clock - wN.clock
const rateDev = Math.abs(burn - (wN.wall - w0.wall)) / (wN.wall - w0.wall) * 100
/* LA5 观战面：C 全程收帧 + 与 A 原始帧逐字节恒等样本 + D 承接观战 */
const cRul = C.raw.filter((s) => s.includes('"ruling"'))
const aRul = A.raw.slice(a0).filter((s) => s.includes('"ruling"'))
const identical = aRul.filter((s) => cRul.includes(s)).length
ok('LA5', '长局观战：观战席全程收 ruling 流+与对局方原始帧逐字节恒等+满编第 3 连接 play join→观战承接',
  !!(wC && wC.role === 'spectator' && wD && wD.role === 'spectator' && cRul.length >= 40 && identical >= 20),
  `观战帧×${cRul.length} 恒等样本×${identical} 第3连接role=${wD && wD.role}`)
ok('LA1', '长局 8min 连续采样（frame 单调+双钟递减+盘面 hash 持续演化）', spots.length >= 85 && frameMono && clockDesc && hashChg >= 30,
  `spots×${spots.length} frame ${w0.frame}→${wN.frame} clock ${w0.clock}→${wN.clock} 换态×${hashChg}${ended ? ' 终局=' + JSON.stringify(ended.result) : '（8min 窗口内存活未终局）'}`)
ok('LA2', '长局 8min 账本对账（逐 spot moveNo==盘面子数；确认手==moveNo 增量）',
  ledger && Math.abs(confirmed - (wN.moveNo - baseMoveNo)) <= 1,
  `末拍 moveNo=${wN.moveNo}（基线 ${baseMoveNo}+确认 ${wN.moveNo - baseMoveNo}）子数=${wN.stones} 确认手=${confirmed}（发送 ${sentCount}）`)
ok('LA3', '长局 8min 局钟覆盖（双席钟耗合计 ≥440000ms ≡ ≥44000 tick@10ms 当量）', burn >= 440000,
  `钟耗=${burn}ms（${(burn / 1000).toFixed(0)}s=${burn / 10 | 0} tick 当量；末拍双钟余 ${wN.clock}ms${ended && ended.result && ended.result.reason === 'clock' ? '，钟尽终局 reason=clock' : ''}）`)
ok('LA4', '长局钟率交叉引用（钟耗↔墙钟偏差 <3%）', rateDev < 3,
  `偏差=${rateDev.toFixed(2)}%（wall ${((wN.wall - w0.wall) / 1000).toFixed(0)}s vs 钟耗 ${(burn / 1000).toFixed(0)}s）`)
for (const c of [A, B, C, D]) { try { c.ws.close() } catch { } }
console.log(`\n${failed === 0 ? 'QA2-LONG OK' : 'QA2-LONG FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
