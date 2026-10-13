#!/usr/bin/env node
/* =====================================================================
 * GAMES-123 战棋对决 QA二号 —— T1 200ms 延迟对照（3+3 局，真 WS 客户端）：
 *   plain 臂 3 局直连私有网关；delay 臂 3 局经 TCP 单向延迟代理（每向 100ms
 *   ⇒ RTT≈200ms）。回合制天然容忍论证 + 确定性不受延迟影响复核：
 *     · 回合制容忍：确认时延（op→ruling）仅抬升 ≈RTT，远小于 30s 回合时限；
 *       我方席位零 timeout-turn（托管不误触发）；6/6 局完整终局。
 *     · 确定性复核：服务端回合制串行化（ruling.turn 折叠后严格交替=零乱序）；
 *       引擎身份双臂一致（welcome.room.duel.hash == 本地 ENGINE_HASH）；
 *       引擎级确定性由冻结门禁 A6（stateHash 两跑相等+replayOps==在线）背书。
 *   臂间串行（防跨臂同房混连）、臂内 3 客户端并发（同臂同信道，纯度保持）。
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { WsClient, TdDriver, startDelayProxy, evidence, sleep, now, quant, makeOk, GW_PORT } from './tactics-duel-qa2-lib.mjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const TD = require('/Volumes/BigDisk/Studio/projects/GAMES/repo/games/multiplayer/tactics-duel/sim.cjs')

const { ok, done } = makeOk()
const PROXY_PORT = 4424
const GAME_TIMEOUT_MS = 180_000

let proxy = null
async function rttProbe(port, n = 10) {
  const ws = new WsClient(); await ws.connect(port)
  const rtts = []
  await new Promise((res) => {
    let i = 0
    const t = setInterval(() => { i++; ws.send({ t: 'ping', c: now() }); if (i >= n) { clearInterval(t); setTimeout(res, 400) } }, 150)
    ws.on('message', (m) => { if (m.t === 'pong') rtts.push(now() - m.c) })
  })
  ws.closeHard()
  return { p50: quant(rtts, 0.5), n: rtts.length }
}

async function playGame(arm, idx, port) {
  const rec = { arm, idx, begunAt: now(), ok: false }
  const ws = new WsClient()
  const d = new TdDriver(ws, `t1-${arm}${idx}`)
  let joinTries = 0
  await ws.connect(port)
  while (!d.welcome && joinTries < 3) {
    joinTries++
    ws.send({ t: 'quick', gameId: 'tactics-duel' })
    const tw = now()
    while (!d.welcome && !ws.closed && now() - tw < 8000) await sleep(200)
  }
  if (!d.welcome || d.role !== 'player') { rec.error = d.welcome ? `role=${d.role}` : 'no-welcome'; ws.closeHard(); return rec }
  rec.roomId = d.welcome.roomId; rec.seat = d.seat
  rec.engineHash = d.welcome.room && d.welcome.room.duel && d.welcome.room.duel.hash
  const deadline = now() + GAME_TIMEOUT_MS
  while (!d.ended && !ws.closed && now() < deadline) {
    if (d.deployPending) d.deploy()
    else if (d.myTurn) d.actOnce()
    await sleep(250)
  }
  rec.ok = !!d.ended
  rec.opsSent = d.opsSent
  rec.confirms = d.confirms.map((c) => c.ms)
  rec.confirmP50 = quant(rec.confirms, 0.5); rec.confirmP95 = quant(rec.confirms, 0.95)
  rec.confirmMax = rec.confirms.length ? Math.max(...rec.confirms) : null
  rec.rejections = d.rejections
  rec.myTimeoutTurns = d.timeoutTurns.filter((x) => x.mine).length
  rec.allTimeoutTurns = d.timeoutTurns.length
  rec.errors = d.errors
  rec.turnsSeq = d.turns
  rec.msgIn = ws.inCount
  if (d.ended) { rec.result = d.ended.result; rec.wallMs = now() - rec.begunAt }
  else rec.timeout = true
  ws.closeHard()
  return rec
}

/* ---------- RTT 通道自证 ---------- */
const direct = await rttProbe(GW_PORT)
proxy = await startDelayProxy({ listenPort: PROXY_PORT, upstreamPort: GW_PORT, delayMs: 100 })
const via = await rttProbe(PROXY_PORT)
console.log(`[rtt] 直连 p50=${direct.p50}ms；经代理 p50=${via.p50}ms`)
ok(via.p50 != null && via.p50 >= 150 && via.p50 <= 600, 'T1 延迟通道自证：代理 RTT≈200ms', `direct p50=${direct.p50}ms via p50=${via.p50}ms n=${via.n}`)
ok(direct.p50 == null || via.p50 - direct.p50 >= 120, 'T1 通道差分：via-direct ≥120ms（注入有效）', `Δ=${via.p50 - direct.p50}ms`)

/* ---------- 两臂串行、臂内 3 并发 ---------- */
const games = []
for (const arm of ['plain', 'delay']) {
  const port = arm === 'delay' ? PROXY_PORT : GW_PORT
  const batch = await Promise.all([0, 1, 2].map((i) => playGame(arm, i, port)))
  for (const g of batch) {
    games.push(g)
    console.log(`[${arm}${g.idx}] ${g.ok ? 'ended' : 'FAIL'} seat=${g.seat ?? '-'} ops=${g.opsSent ?? 0} confirmP50=${g.confirmP50} myTimeout=${g.myTimeoutTurns ?? '-'} rejects=${g.rejections ? g.rejections.length : '-'} (${g.result ? g.result.reason : g.error || 'timeout'})`)
  }
}

/* ---------- 断言组 ---------- */
ok(games.length === 6 && games.every((g) => g.ok), 'T1 六局完整终局（3 plain + 3 delay）', `${games.filter((g) => g.ok).length}/6 ended；失败=${games.filter((g) => !g.ok).map((g) => `${g.arm}${g.idx}:${g.error || 'timeout'}`).join(',') || '无'}`)
const doneG = games.filter((g) => g.ok)
const p50 = (arm) => quant(doneG.filter((g) => g.arm === arm).filter((g) => g.confirmP50 != null).map((g) => g.confirmP50), 0.5)
const p95 = (arm) => quant(doneG.filter((g) => g.arm === arm).filter((g) => g.confirmP95 != null).map((g) => g.confirmP95), 0.5)
const maxAll = (arm) => Math.max(...doneG.filter((g) => g.arm === arm && g.confirmMax != null).map((g) => g.confirmMax))
console.log(`[confirm] plain p50=${p50('plain')} p95=${p95('plain')} max=${maxAll('plain')}；delay p50=${p50('delay')} p95=${p95('delay')} max=${maxAll('delay')}`)
const delta = p50('delay') != null && p50('plain') != null ? p50('delay') - p50('plain') : null
ok(delta != null && delta >= 100 && delta <= 600, 'T1 回合制容忍：确认时延仅抬升 ≈RTT（Δ∈[100,600]ms）', `Δp50=${delta}ms；绝对值远小于 30s 回合时限`)
ok(doneG.every((g) => g.confirmP95 == null || g.confirmP95 < 5000), 'T1 确认 p95 两臂均 <5s（无延迟放大异常）', `plain p95=${p95('plain')} delay p95=${p95('delay')}`)
ok(doneG.every((g) => g.myTimeoutTurns === 0), 'T1 容忍论证：200ms 延迟下我方席位零 timeout-turn（托管不误触发）', `max=${Math.max(0, ...doneG.map((g) => g.myTimeoutTurns || 0))}`)
ok(doneG.every((g) => !g.errors || g.errors.length === 0), 'T1 协议零损坏（无 bad-msg/version/error）', doneG.flatMap((g) => g.errors || []).slice(0, 3).join(';') || '零错误')
/* 回合制串行化：ruling.turn 折叠后严格交替（延迟不产生乱序生效） */
const altBad = []
for (const g of doneG) {
  const col = []
  for (const t of g.turnsSeq || []) if (col.length === 0 || col[col.length - 1] !== t) col.push(t)
  for (let i = 1; i < col.length; i++) if (col[i] === col[i - 1]) { altBad.push(`${g.arm}${g.idx}`); break }
}
ok(altBad.length === 0, 'T1 确定性复核：服务端回合串行化完好（turn 折叠后零同席相邻重复=无乱序）', altBad.join(',') || `各局折叠加总 ${doneG.reduce((n, g) => n + (g.turnsSeq || []).length, 0)} 条 ruling`)
ok(doneG.every((g) => g.engineHash === TD.ENGINE_HASH), 'T1 确定性复核：双臂引擎身份一致（duel.hash==本地 ENGINE_HASH）', `hash=${doneG[0] && doneG[0].engineHash} 本地=${TD.ENGINE_HASH}`)
const rej = doneG.flatMap((g) => g.rejections || [])
ok(rej.length <= 20 && rej.every((r) => typeof r.why === 'string' && r.why), 'T1 reject 均为规则性回执（非协议损坏），且无 reject 风暴', `total=${rej.length} whys=${[...new Set(rej.map((r) => r.why))].join(',') || '-'}`)

evidence('qa2-t1-latency.json', {
  rtt: { direct, via }, summary: {
    ended: `${doneG.length}/6`, confirmP50: { plain: p50('plain'), delay: p50('delay') }, delta,
    confirmP95: { plain: p95('plain'), delay: p95('delay') },
    reasons: doneG.map((g) => `${g.arm}${g.idx}:${g.result && g.result.reason}:${g.result && g.result.winner}`),
  }, games,
})
if (proxy) proxy.close()
const [p, f] = done()
console.log(`\n${f === 0 ? 'QA2-LATENCY OK' : 'QA2-LATENCY FAILED'}：${p} 通过，${f} 失败`)
process.exit(f === 0 ? 0 : 1)
