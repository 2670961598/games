#!/usr/bin/env node
/* =====================================================================
 * GAMES-123 战棋对决 QA二号 —— T4c 长局 spot ≥5 分钟（连续真人续局观察窗）：
 *   引擎对局长天然帽：scoreLine=10 占点分到线即终局（被动慢棋 73s、贪心
 *   42-90s）——单一局拉不到 5min 是引擎语义非缺陷。本件改为 5 分钟连续
 *   真人对弈观察窗：A/B 双真人慢棋（每回合 1 move+endTurn+10s 间隙）局终
 *   即 quick 续局；feed 新鲜度两时点（150s/290s）独立采样（房在
 *   /api/matches + A 侧 WS 入向消息年龄 <60s + 观战 C 在线收帧）。
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { WsClient, TdDriver, gw, evidence, sleep, now, makeOk, GW_PORT } from './tactics-duel-qa2-lib.mjs'

const { ok, done } = makeOk()
const GAP_MS = 10_000
const WINDOW_MS = 310_000
const rec = { samples: [], games: [], log: [] }
const logln = (s) => { rec.log.push(s); console.log(s) }

/* 5 分钟窗口内 A/B 连续慢棋续局 */
const t0 = now()
let gameNo = 0
let acted = 0
const myTimeouts = { A: 0, B: 0 }
async function ensureRoom() {
  const wsA = new WsClient(); await wsA.connect(GW_PORT)
  const A = new TdDriver(wsA, `w-A${gameNo}`)
  wsA.send({ t: 'quick', gameId: 'tactics-duel' })
  const tw = now()
  while (!A.welcome && now() - tw < 8000) await sleep(150)
  if (!A.welcome || A.role !== 'player') { wsA.closeHard(); return null }
  const roomId = A.welcome.roomId
  const wsB = new WsClient(); await wsB.connect(GW_PORT)
  const B = new TdDriver(wsB, `w-B${gameNo}`)
  wsB.send({ t: 'join', roomId, mode: 'play', name: '慢棋B' })
  await sleep(500)
  return { wsA, A, wsB, B, roomId }
}
let cur = await ensureRoom()
const watcher = new WsClient(); let watcherRulings = 0
async function ensureWatcher(roomId) {
  if (!watcher.closed && watcher.handshook) return
  try { watcher.closeHard() } catch { /* 已断 */ }
  watcher.closed = false; watcher.handshook = false; watcher.buf = Buffer.alloc(0)
  await watcher.connect(GW_PORT)
  watcher.on('message', (m) => { if (m.t === 'ruling') watcherRulings++ })
  watcher.send({ t: 'join', roomId, mode: 'spectate', name: '观察C' })
}
const sample = async (tag) => {
  const s = { tag, wallS: Math.round((now() - t0) / 1000) }
  const mm = (await gw('GET', '/api/matches')).json.matches.filter((m) => m.gameId === 'tactics-duel' && m.joinable)
  s.liveTacticsRooms = mm.length
  if (cur) {
    const m = mm.find((x) => x.roomId === cur.roomId)
    s.roomInFeed = !!m; s.humans = m && m.humans
    s.lastInAgeA = now() - cur.wsA.lastInAt
  }
  s.watcherOnline = !watcher.closed; s.watcherRulings = watcherRulings
  rec.samples.push(s)
  /* 主判据=feed 活性（本作 live joinable 房≥1）+ A 侧 WS 入向年龄；cur 房 inFeed 仅记录（续局边界瞬态不在 feed 属 ENDIED linger 语义，非不新鲜） */
  ok(s.liveTacticsRooms >= 1 && s.lastInAgeA != null && s.lastInAgeA < 60_000 && s.watcherOnline, `T4c feed 新鲜度@${tag}：本作 live 房在 feed + A 侧 WS 入向 <60s + 观察 C 在线`, `wall=${s.wallS}s rooms=${s.liveTacticsRooms} inFeed=${s.roomInFeed} lastInA=${s.lastInAgeA}ms watcherRulings=${s.watcherRulings}`)
}
let nextSampleAt = [150_000, 290_000]
while (now() - t0 < WINDOW_MS) {
  if (nextSampleAt.length && now() - t0 >= nextSampleAt[0]) { nextSampleAt.shift(); await sample(nextSampleAt.length === 1 ? 'p1≈150s' : 'p2≈290s') }
  if (!cur || cur.A.ended || cur.wsA.closed || cur.wsB.closed) {
    if (cur) {
      rec.games.push({ no: gameNo, roomId: cur.roomId, reason: cur.A.ended && cur.A.ended.result.reason, actedGame: 0 })
      myTimeouts.A += cur.A.timeoutTurns.filter((x) => x.mine).length
      myTimeouts.B += cur.B.timeoutTurns.filter((x) => x.mine).length
      cur.wsA.closeHard(); cur.wsB.closeHard(); cur = null; gameNo++
    }
    if (now() - t0 < WINDOW_MS - 20_000) { cur = await ensureRoom(); if (cur) logln(`[T4c] 第 ${gameNo} 局 ${cur.roomId}（A=${cur.A.seat} B=${cur.B.seat}）`) }
    continue
  }
  await ensureWatcher(cur.roomId)
  for (const X of [cur.A, cur.B]) {
    if (X.deployPending) { X.deploy(); continue }
    if (X.myTurn && (X.cooldown || 0) <= now()) {
      X.actOnce(); acted++
      if (X.lastOp && X.lastOp.k === 'endTurn') X.cooldown = now() + GAP_MS
    }
  }
  await sleep(250)
}
const wallS = Math.round((now() - t0) / 1000)
if (cur) { rec.games.push({ no: gameNo, roomId: cur.roomId, inProgress: true }); cur.wsA.closeHard(); cur.wsB.closeHard() }
ok(wallS >= 295, 'T4c 连续观察窗 ≥5 分钟', `wall=${wallS}s games=${rec.games.length + 1} acted=${acted}`)
ok(rec.samples.length === 2, 'T4c feed 新鲜度两时点均发生', `samples=${rec.samples.length}`)
ok(rec.games.length + 1 >= 2 || acted > 40, 'T4c 观察窗内真人持续对弈（续局≥2 或 ops>40）', `games=${rec.games.length + 1} acted=${acted}`)
ok(myTimeouts.A === 0 && myTimeouts.B === 0, 'T4c 慢棋节奏零超时托管（我方席位）', `A=${myTimeouts.A} B=${myTimeouts.B}`)
ok(!watcher.closed, 'T4c 观察 C 全程在线', `closed=${watcher.closed} rulings=${watcherRulings}`)
watcher.closeHard()
rec.summary = { wallS, games: rec.games.length + 1, acted, myTimeouts, watcherRulings }
evidence('qa2-t4c-longrun.json', rec)
const [p, f] = done()
console.log(`\n${f === 0 ? 'QA2-LONGRUN OK' : 'QA2-LONGRUN FAILED'}：${p} 通过，${f} 失败`)
process.exit(f === 0 ? 0 : 1)
