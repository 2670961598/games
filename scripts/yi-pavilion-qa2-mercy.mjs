#!/usr/bin/env node
/* =====================================================================
 * GAMES-160 弈界棋阁 QA2 放水链在线复证（M 臂——GAMES-142/151 mercy 范式）
 *   在线链路（QA2 定案口径）：bothost 常驻房全 casual 档（bothost.js:83）——quick 单人
 *   恒落 casual 房（mercy 对 casual 无可观测面）。生产 mercy 生效位=托管接管 bot
 *   （META.takeOver=balanced）：真人断线>10s 席位转 bot。故用「双接管」协议构造
 *   balanced 对手（两 throwaway 连接入房即断 → 10s 后双席转接管 bot → pulse 连接
 *   quick 让位就席）——与 R3 30s 档同一条生产代码路径。
 *   pulse 链：同 WS conn 连败 → rooms.js finish rec.lose++ → doFrame botEnv.foeLose →
 *   sim brain mercy（minFoeLose=2 L1 ΔV 扰动 / hardFoeLose=3 L2 降档+让位）。
 *   观测面（结局面对 balanced 无阈值——fiveLine 对 balanced fl=0 也 8/8 胜，
 *   离线校准在案）：决策级漏堵率（Y1 在线镜像）——
 *   M1 零连败基线（fl=0）：fiveLine 真人臂，bot 单威胁位面漏堵=0（必堵纪律）；
 *   M2 连败推进：concede×3 快速垫 lose（同一 WS conn=pulse 载体）→ fl=3；
 *   M3 L2 让位在线可观测：fl=3 局漏堵 >0（yield 主动劣手经网关链路送达）
 *      ——与 M1 同策略同档位对照（漏堵 0 → >0 即放水信号在线生效）；
 *   M4 fl=2 中间档（L1 仅 ΔV 扰动无让位）：漏堵=0（L2 阈值下的纪律面）；
 *   M5 让力后清零回档：fl=3 局真人胜（win→pulse lose 清零）→ 次局 fl=0
 *      漏堵回 0（放水链回档闭环，E3 在线镜像）。
 *   漏堵判据（视图态可观测）：bot 行棋拍，真人席 feat.winNow 恰 1 格（可堵位面）
 *   → bot 着点≠该格=漏（真人下一手 winNow 即胜）。多威胁位面（不可堵）不计。
 * 退出码 0=全绿。QA 只读：零产品代码改动。影子网关 :4420。
 * ===================================================================== */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/yi-pavilion/sim.cjs')

const WS_URL = process.env.QA_GW_WS || 'ws://127.0.0.1:4420'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function conn() {
  const ws = new WebSocket(WS_URL)
  const c = { ws, msgs: [], open: false, closed: false, roomId: null, seat: null }
  ws.onmessage = (e) => { try { c.msgs.push(JSON.parse(String(e.data))) } catch { } }
  return new Promise((res) => {
    ws.onopen = () => { c.open = true; res(c) }
    ws.onerror = () => res(c)
    setTimeout(() => res(c), 4000)
  })
}
const lastState = (c) => [...c.msgs].reverse().find((m) => m.state && (!m.events || m.events.some((e) => e.k === 'sync') || m.t === 'welcome'))
const endOf = (c) => [...c.msgs].reverse().find((m) => m.t === 'end')
/* 双接管协议：X1/X2 throwaway 入 bothost gomoku 房占双 human 席即断线 → >10s 双席
 * 转托管 bot（balanced）；pulse 连接 quick 让位就席（seat1），对手=接管 balanced。
 * concede 快捷局无需 prep（任意房，pulse 记负即可）；fiveLine 观测局须 prep。 */
async function prepBalancedRoom() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const X1 = await conn(), X2 = await conn()
    X1.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
    await sleep(400)
    X2.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
    await sleep(800)
    const w1 = [...X1.msgs].find((m) => m.t === 'welcome'), w2 = [...X2.msgs].find((m) => m.t === 'welcome')
    const roomId = w1 && w1.roomId
    try { X1.ws.close(); X2.ws.close() } catch { }
    if (!roomId || !w2 || w2.roomId !== roomId) { await sleep(2000); continue }
    await sleep(11500) /* >10s 重连窗+宽限 → 双席托管转换 */
    console.log(`  [prep${attempt}] 双接管房 ${roomId} 备妥（X1/X2 已断线转托管）`)
    return roomId
  }
  return null
}

/* fiveLine（api-check §6 剧本策略副本：读视图态非 sim 内部） */
function fiveLine(state, seat) {
  if (!state || state.over || state.turn !== seat) return {}
  const F = S.feat(state, seat)
  if (F.winNow.length) return { cell: F.winNow[0] }
  if (F.mustBlock.length && state.board[F.mustBlock[0]] === 0) return { cell: F.mustBlock[0] }
  for (const c of [7, 8, 6, 9, 5, 10]) {
    const rows = []
    for (let r = 0; r < 15; r++) if (state.board[r * 15 + c] === seat + 1) rows.push(r)
    let target = -1
    if (rows.length) {
      rows.sort((a, b) => a - b)
      const up = rows[rows.length - 1] + 1, dn = rows[0] - 1
      if (up < 15 && state.board[up * 15 + c] === 0) target = up * 15 + c
      else if (dn >= 0 && state.board[dn * 15 + c] === 0) target = dn * 15 + c
    } else target = 7 * 15 + c
    if (target >= 0 && state.board[target] === 0) return { cell: target }
  }
  const lg = S.legal(state, seat)
  return lg.length ? { cell: lg[0] } : {}
}

/* 一局：mode='concede'（首手投认定输）| 'five'（fiveLine 全力打）。
 * 返回 { result, miss, opps, myMoves }：miss=bot 漏堵次数、opps=可堵单威胁位面数 */
async function game(C, tag, mode, maxMs = 150000) {
  C.msgs = []
  let prepRid = null
  if (mode === 'five') { prepRid = await prepBalancedRoom(); if (!prepRid) { console.error(`  [${tag}] prep 失败`); return null } }
  /* five 局=显式 join 备妥房（quick 的 newest-first 排序会被 prep 窗内他房终局复燃的
   * 新房抢位——显式 roomId 确定性就席）；concede 局=quick 任意房（pulse 只记负） */
  if (prepRid) C.ws.send(JSON.stringify({ t: 'join', roomId: prepRid, mode: 'play' }))
  else C.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
  const t0 = Date.now()
  let w = null
  while (Date.now() - t0 < 12000 && !w) { w = C.msgs.find((m) => m.t === 'welcome'); await sleep(120) }
  if (!w) { console.error(`  [${tag}] ${prepRid ? 'join' : 'quick'} 无 welcome`); return null }
  if (prepRid && w.roomId !== prepRid) { console.error(`  [${tag}] join 落房错位（${w.roomId}≠${prepRid}）`); return { wrongRoom: true } }
  if (prepRid) {
    const opp = (w.room && w.room.seats || []).find((s) => s.seat !== w.seat)
    if (!opp || opp.kind !== 'bot' || opp.level !== 'balanced') { console.error(`  [${tag}] 对手非接管 balanced（kind=${opp && opp.kind} level=${opp && opp.level}）——弃局`); try { C.ws.close() } catch { } return { wrongRoom: true } }
    console.log(`  [${tag}] 对手=接管 balanced bot（房 ${w.roomId} moveNo=${w.state && w.state.moveNo}）`)
  }
  C.roomId = w.roomId; C.seat = w.seat
  const botSeat = 1 - w.seat
  let miss = 0, opps = 0, myMoves = 0, conceded = false, prev = null, awaitBlock = null
  while (Date.now() - t0 < maxMs) {
    C.ws.send(JSON.stringify({ t: 'sync' }))
    await sleep(130)
    const sm = lastState(C)
    if (!sm || !sm.state) continue
    const st = sm.state
    if (st.over || (endOf(C) && endOf(C).result)) break
    if (st.phase !== 'live') continue
    /* 挂起确认：bot 行棋拍检出可堵位面 → 记账 opps 并挂起；后续任一拍 moveNo 前进
     * 时核对 bot 着点是否占该格（bot 决策 gated 1-2s/手，短窗核不着=漏堵恒少计——
     * QA2 首两跑根因）。未占=漏堵。 */
    if (awaitBlock && st.moveNo > awaitBlock.mn) {
      if (awaitBlock.cells.every((c) => st.board[c] === 0)) miss++ /* 威胁集全不理=漏堵 */
      awaitBlock = null
    }
    /* bot 行棋拍：可堵位面检出（真人 winNow 单格=即胜威胁；bot mustBlock 单格且
     * bot 自身无 winNow=活三/冲四威胁格。多格威胁（不可堵）不计） */
    if (st.turn === botSeat && prev !== st.moveNo) {
      const F = S.feat(st, w.seat)
      const FB = S.feat(st, botSeat)
      let cells = null
      if (F.winNow.length === 1) cells = [F.winNow[0]] /* 单端四=单格即胜威胁 */
      else if (!FB.winNow.length && FB.mustBlock.length >= 1 && FB.mustBlock.length <= 2) cells = FB.mustBlock.slice() /* 开三/冲四=威胁集（堵任一=应答） */
      if (cells && cells.every((c) => st.board[c] === 0)) { opps++; awaitBlock = { cells, mn: st.moveNo }; prev = st.moveNo; continue }
      prev = st.moveNo
    }
    if (st.turn === w.seat) {
      if (mode === 'concede' && !conceded) { C.ws.send(JSON.stringify({ t: 'op', k: 'concede' })); conceded = true; await sleep(400); continue }
      if (mode === 'five') {
        const mv = fiveLine(st, w.seat)
        if (mv.cell !== undefined) { C.ws.send(JSON.stringify({ t: 'op', k: 'place', cell: mv.cell })); myMoves++; await sleep(240) }
      }
    }
  }
  const e = endOf(C)
  const res = e && e.result
  if (!res) { console.error(`  [${tag}] 局未终（roomId=${C.roomId}）`) }
  try { C.ws.send(JSON.stringify({ t: 'leave' })) } catch { }
  return { result: res, miss, opps, myMoves, roomId: C.roomId, seat: w.seat }
}
const winMe = (r, seat) => r && r.winner === (seat === 0 ? 'A' : 'B')

/* ============ M1 零连败基线（fl=0：必堵纪律） ============ */
console.log('── M1 零连败基线（fresh conn·fl=0·fiveLine vs balanced·漏堵须=0）──')
const C1 = await conn()
const g1 = await game(C1, 'M1-fl0', 'five')
ok('M1', 'fl=0 基线：真人 fiveLine 胜 balanced + bot 可堵位面零漏堵（必堵纪律在线在位）',
  g1 && g1.result && winMe(g1.result, g1.seat) && g1.miss === 0 && g1.opps >= 1,
  g1 ? `winner=${g1.result && g1.result.winner} reason=${g1.result && g1.result.reason} 漏堵 ${g1.miss}/${g1.opps} 我方 ${g1.myMoves} 手` : '局未终')

/* ============ M2 连败推进（concede×3 → fl=3）============ */
console.log('── M2 连败推进（同 conn concede×3 → pulse rec.lose=3 → foeLose=3）──')
const losses = []
for (let i = 0; i < 3; i++) { const g = await game(C1, `M2-lose${i + 1}`, 'concede', 30000); losses.push(g && g.result && !winMe(g.result, g.seat)) ; await sleep(600) }
ok('M2', '三连败垫档：同 WS conn concede×3 全负（winner=对家）——pulse lose 累计至 3',
  losses.length === 3 && losses.every(Boolean), losses.map((x) => (x ? '负' : '?')).join('/'))

/* ============ M3 L2 让位在线可观测（fl=3 漏堵>0；多循环采样——yield 0.35 单位面堵率 65%）============ */
console.log('── M3 L2 让位（fl=3：yield 主动劣手经网关链路送达；≤4 循环采样）──')
let g3 = null, m3cyc = 0
for (let cyc = 1; cyc <= 4; cyc++) {
  m3cyc = cyc
  g3 = await game(C1, `M3-fl3-c${cyc}`, 'five')
  console.log(`  循环${cyc}：漏堵 ${g3 ? g3.miss : '?'}/${g3 ? g3.opps : '?'}`)
  if (g3 && g3.miss > 0) break
  /* 未观测到漏堵：再垫三连败（胜局已清零 pulse）重进 fl=3 */
  for (let i = 0; i < 3; i++) { await game(C1, `M3-relose${cyc}-${i + 1}`, 'concede', 30000); await sleep(500) }
}
ok('M3', 'fl=3 让位生效：bot 可堵位面漏堵 >0（L2 yield 与 M1/M4 零漏对照——放水信号在线链路送达）',
  g3 && g3.result && winMe(g3.result, g3.seat) && g3.miss > 0,
  g3 ? `winner=${g3.result && g3.result.winner} 漏堵 ${g3.miss}/${g3.opps}（第${m3cyc}循环；M1 基线 0 漏）` : '局未终')

/* ============ M4/M5 清零回档 + L1 中间档 ============ */
console.log('── M5 清零回档（M3 真人胜 → pulse lose 清零 → 次局 fl=0 漏堵回 0）──')
/* M3 胜利已清零 pulse；先垫 fl=2（两连败）验 L1 中间档无让位，再验清零回档基线 */
const l2a = await game(C1, 'M5-lose-a', 'concede', 30000); await sleep(600)
const l2b = await game(C1, 'M5-lose-b', 'concede', 30000); await sleep(600)
const g4 = await game(C1, 'M4-fl2', 'five')
ok('M4', 'fl=2 中间档（L1 仅 ΔV 扰动无让位）：漏堵=0（hardFoeLose=3 阈下纪律面）',
  g4 && g4.result && winMe(g4.result, g4.seat) && g4.miss === 0 && g4.opps >= 1,
  g4 ? `winner=${g4.result && g4.result.winner} 漏堵 ${g4.miss}/${g4.opps}` : '局未终')
/* M4 又胜 → 清零；再垫一败（fl=1）→ 打一局验回档（fl=1<L2 阈，漏堵=0） */
await game(C1, 'M5-lose-c', 'concede', 30000); await sleep(600)
const g5 = await game(C1, 'M5-fl1', 'five')
ok('M5', '胜后清零回档：fl=1（清零后仅 1 败）漏堵=0——放水链不滞留（E3 在线镜像）',
  g5 && g5.result && winMe(g5.result, g5.seat) && g5.miss === 0 && g5.opps >= 1,
  g5 ? `winner=${g5.result && g5.result.winner} 漏堵 ${g5.miss}/${g5.opps}` : '局未终')

for (const c of [C1]) { try { c.ws.close() } catch { } }
console.log(`\n${failed === 0 ? 'QA2-MERCY OK' : 'QA2-MERCY FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
