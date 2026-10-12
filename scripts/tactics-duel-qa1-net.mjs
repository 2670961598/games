#!/usr/bin/env node
/* =====================================================================
 * GAMES-119 战棋对决 QA一号 —— 网络级走查（经 /api/test/* 测试面，零浏览器）：
 *   R1 重连三档（5s/10s/30s）：deploy→act 建立回合态 → $disconnect → 各档等待
 *      → $reconnect welcome 全量个性化恢复（turn/phase/AP/acted/timerMs/undoUsed/
 *      托管标志）→ 注入 op 得 ruling（行动序列续接）。30s 档额外验托管续打
 *      （断线期 bot 代管、局不散）。
 *   R2 GAMES-84 abandon 锚复验：双 API 席在场 >15s → 双 $disconnect →
 *      +5s 仍 live（若锚=join 时刻则已 abandon——锚=最后在场时刻的判别性断言）
 *      → +17s ended/abandon。
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4400'
let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const gw = async (method, path, body) => {
  const r = await fetch(GW + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const gwState = async (roomId, since = 0) => gw('GET', `/api/test/state?roomId=${roomId}&since=${since}`)
const gwInput = (roomId, seat, op, payload) => gw('POST', '/api/test/input', { roomId, seat, op, payload })
const T0 = (seat, TYPE_ORDER, TEMPLATES) => ({ k: 'deploy', cells: TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: TEMPLATES[0][i][seat] })) })

/* 建房并推到 A 席 act 相位（deploy T0 + 等 reveal + 我的回合） */
async function setupRoom(botLevel, timeScale) {
  const c = await gw('POST', '/api/test/room', { gameId: 'tactics-duel', seed: 20261190, timeScale, startDelayMs: 400, botLevels: [null, botLevel] })
  if (!c.json || !c.json.ok) return null
  const roomId = c.json.roomId, token = c.json.token, seat = c.json.playerSeat
  const t0 = Date.now()
  for (;;) {
    const r = await gwState(roomId)
    if (r.json && r.json.phase === 'live' && r.json.state && r.json.state.phase === 'deploy' && !r.json.state.deployDone[seat]) break
    if (Date.now() - t0 > 15_000) return { roomId, token, seat, error: 'deploy 相位未达' }
    await sleep(150)
  }
  const dep = await gwInput(roomId, seat, 'op', { op: T0(seat, TD_TYPE, TD_TPL) })
  if (!dep.json || !dep.json.ok) return { roomId, token, seat, error: 'deploy 注入失败' }
  for (;;) {
    const r = await gwState(roomId)
    const s = r.json && r.json.state
    if (s && s.phase === 'act' && s.turnSeat === seat && s.ap === 4) return { roomId, token, seat, state: s }
    if (r.json && r.json.phase === 'ended') return { roomId, token, seat, error: '提前终局' }
    if (Date.now() - t0 > 60_000) return { roomId, token, seat, error: 'act 己方回合未达' }
    await sleep(150)
  }
}
/* TD 常量（从 game 侧 sim 取，避免手抄漂移） */
const { createRequire } = await import('node:module')
const D = createRequire(import.meta.url)('/Volumes/BigDisk/Studio/projects/GAMES/repo/games/multiplayer/tactics-duel/sim.cjs')
const TD_TYPE = D.TYPE_ORDER, TD_TPL = D.TEMPLATES

/* ---------- R1 重连三档 ---------- */
console.log('[R1] 重连三档（5s/10s/30s）——回合态恢复+行动序列续接')
for (const tier of [5000, 10000, 30000]) {
  const room = await setupRoom('balanced', tier >= 30000 ? 2 : 8)
  if (!room || room.error) { ok(false, `重连 ${tier / 1000}s 档：前置失败`, (room && room.error) || '建房失败'); continue }
  const { roomId, token, seat } = room
  /* 建立回合内痕迹：move 一个单位（AP 4→3）——重连恢复须含该态 */
  const s0 = (await gwState(roomId)).json.state
  const lance = s0.units.find((u) => u.seat === seat && u.type === 'lance' && u.ph === 'idle')
  const mv = D.reach(s0, lance.id).filter((r) => r.path.length > 1).sort((a, b) => b.path.length - a.path.length)[0]
  await gwInput(roomId, seat, 'op', { op: { k: 'move', unit: lance.id, path: mv.path } })
  const s1 = (await gwState(roomId)).json.state
  const anchor = { ap: s1.ap, ph: s1.units.find((u) => u.id === lance.id).ph, cell: s1.units.find((u) => u.id === lance.id).cell, turn: s1.turnSeat }
  ok(anchor.ap === 3 && anchor.ph === 'moved', `重连 ${tier / 1000}s 档前置：回合态已建立（AP=3/moved）`, `ap=${anchor.ap} ph=${anchor.ph} turn=${anchor.turn}`)
  /* 断线 → 等档位时长 → 观察中途态 → 重连 */
  const dis = await gwInput(roomId, seat, '$disconnect')
  ok(dis.json && dis.json.ok, `重连 ${tier / 1000}s 档：$disconnect`, dis.json && dis.json.disconnectedAt ? String(dis.json.disconnectedAt) : 'fail')
  await sleep(tier)
  const mid = (await gwState(roomId)).json
  if (tier >= 30000) {
    /* 30s 档：重连窗(10s)已过——托管接管续打（棋局不断）；局应仍在推进或已自然终局 */
    ok(mid.phase === 'live' || mid.phase === 'ended', `重连 30s 档：断线期托管续打（局未散）`, `phase=${mid.phase}`)
    if (mid.phase === 'live') ok(mid.state.turnNo > 1 || mid.state.turnCounts[1] >= 1, '重连 30s 档：bot 已代管推进（回合数前进）', `turnNo=${mid.state.turnNo} counts=[${mid.state.turnCounts}]`)
  } else {
    ok(mid.phase === 'live' && mid.seats[seat].kind === 'human', `重连 ${tier / 1000}s 档：席位保留（10s 窗内）`, `kind=${mid.seats[seat].kind}`)
  }
  const rec = await gwInput(roomId, seat, '$reconnect', { token })
  const endedOk = tier >= 30000 && mid.phase === 'ended' && rec.json && rec.json.error === 'room-gone' // 30s 档终局收房后复连拒绝=正确行为（托管已打完整局）
  ok(rec.json && rec.json.ok || endedOk, `重连 ${tier / 1000}s 档：$reconnect 复席`, endedOk ? '局已终局收房→room-gone（正确）' : (rec.json && rec.json.ok ? 'resume ok' : JSON.stringify(rec.json)))
  const after = (await gwState(roomId)).json
  const wel = (after.events || []).filter((e) => e.msg && e.msg.t === 'welcome').pop()
  const ws = wel && wel.msg && wel.msg.state
  const hasTurnFace = ws && (ws.phase === 'act' || ws.phase === 'over') && Number.isInteger(ws.turn) && Number.isInteger(ws.turnNo || 0)
    && (('ap' in ws) || ws.phase === 'over') && ('undoUsed' in ws) && ('host' in ws) && Number.isFinite(ws.timerMs)
  ok(hasTurnFace || endedOk, `重连 ${tier / 1000}s 档：welcome 全量个性化恢复（turn/phase/AP/undoUsed/host/timerMs）`,
    ws ? `phase=${ws.phase} turn=${ws.turn} ap=${ws.ap} undoUsed=${ws.undoUsed} timerMs=${ws.timerMs}` : '未见 welcome')
  /* 行动序列续接：注入合法 op → ruling 回执 */
  if (after.phase === 'live') {
    const st2 = after.state
    let op = null
    if (st2.phase === 'act' && st2.turnSeat === seat && st2.ap > 0) {
      const u = st2.units.find((x) => x.seat === seat && x.ph === 'idle')
      if (u) { const m = D.reach(st2, u.id).filter((r) => r.path.length > 1)[0]; if (m) op = { k: 'move', unit: u.id, path: m.path } }
      if (!op) op = { k: 'endTurn' }
    } else op = { k: 'endTurn' } /* 非己回合：reject not-your-turn 亦是回执证据（A4 口径） */
    const cursor0 = after.cursor
    await gwInput(roomId, seat, 'op', { op })
    let rulingSeen = false, why = ''
    const tw = Date.now()
    while (!rulingSeen && Date.now() - tw < 4000) {
      const q = await gwState(roomId, cursor0)
      for (const e of q.json.events || []) {
        const evs = e.msg && e.msg.events
        if (e.msg && e.msg.t === 'ruling' && evs && (evs.some((v) => (v.k === 'move' || v.k === 'endTurn')) || evs.some((v) => v.k === 'reject' && v.seat === seat))) rulingSeen = true
      }
      if (!rulingSeen) await sleep(120)
    }
    ok(rulingSeen, `重连 ${tier / 1000}s 档：行动序列续接（注入 op → ruling 回执）`, `op=${op.k}${why}`)
  } else ok(tier >= 30000, `重连 ${tier / 1000}s 档：局已自然终局（续接断言豁免）`, after.result ? `${after.result.winner}/${after.result.reason}` : '')
  await gw('DELETE', '/api/test/room', { roomId }).catch(() => {})
}

/* ---------- R2 GAMES-84 abandon 锚 ---------- */
console.log('[R2] abandon 锚复验（GAMES-84：锚=最后在场时刻，非 join 时刻）')
{
  const c = await gw('POST', '/api/test/room', { gameId: 'tactics-duel', seed: 20261191, timeScale: 1, startDelayMs: 400, botLevels: [null, 'balanced'] })
  const roomId = c.json.roomId
  const token0 = c.json.token, seat0 = c.json.seat
  /* 双席在场 >15s（期间轮询保持测试连接活跃；timeScale=1 deploy 20s 自然覆盖） */
  const t0 = Date.now()
  while (Date.now() - t0 < 16_000) {
    const r = await gwState(roomId)
    const st = r.json && r.json.state
    if (st && st.phase === 'deploy' && !st.deployDone[0]) await gwInput(roomId, 0, 'op', { op: T0(0, TD_TYPE, TD_TPL) })
    await sleep(500)
  }
  ok(true, '前置：API 席在场 >15s（bot 席 conn 恒空——独真人房即 GAMES-84 臂形）', '16s 在场')
  await gwInput(roomId, 0, '$disconnect')
  const disAt = Date.now()
  await sleep(5000)
  const m5 = (await gwState(roomId)).json
  ok(m5.phase === 'live', '双断 +5s：仍 live（锚=最后在场时刻——若锚=join 时刻则首个扫描拍已 abandon）', `phase=${m5.phase}`)
  await sleep(13_000)
  const m18 = (await gwState(roomId)).json
  ok(m18.phase === 'ended' && m18.result && m18.result.reason === 'abandon', '双断 +18s：ended/abandon（15s 收房）',
    m18.result ? `${m18.result.winner}/${m18.result.reason}（断线后 ${Date.now() - disAt}ms）` : `phase=${m18.phase}`)
  await gw('DELETE', '/api/test/room', { roomId }).catch(() => {})
}

console.log(`\n${failed === 0 ? 'QA1-NET OK' : 'QA1-NET FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
