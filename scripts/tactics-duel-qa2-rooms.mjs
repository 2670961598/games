#!/usr/bin/env node
/* =====================================================================
 * GAMES-123 战棋对决 QA二号 —— T3 满员与旁观 + T4 长局 spot（真 WS 客户端）：
 *   T3a Bot 让位循环：纯 bot 房真人 play 加入 → takeover 最大 bot 席 →
 *      离开 → +8.5s 席位保留（10s 窗）→ +12s 席转托管 bot（回收）。
 *      取证面=旁观者 seat 名册时间线 + /api/matches 双保险（房早终局不丢证据）。
 *   T3b 双人满员+第 3 人旁观：A/B 双真人坐满 → C join mode=play 满员静默
 *      转旁观（spectator:true）→ 旁观稳定收 ruling（视图=观战面）。
 *   T4  长局 ≥5 分钟：A/B 真人对弈（回合内快出手 + 回合间 12s 间隙，回合
 *      时限 30s 内），循环内两时点（≈150s/≈290s）抽查 feed 新鲜度。
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { WsClient, TdDriver, pickBotRoom, gw, evidence, sleep, now, makeOk, GW_PORT } from './tactics-duel-qa2-lib.mjs'

const { ok, done } = makeOk()
const GAP_MS = 12_000            // 回合间间隙（拉伸墙钟；回合内出手 ~0.4s/手，远小于 30s 时限）
const rec = { t3a: {}, t3b: {}, t4: { samples: [] }, log: [] }
const logln = (s) => { rec.log.push(s); console.log(s) }

/* ---------- T3a Bot 让位循环 ---------- */
logln('[T3a] Bot 让位循环（真人进房让位 → 离席保留 → 托管回收）')
{
  let room = await pickBotRoom()
  if (!room) { // 无纯 bot 房时经 quick 触发建新房
    const wq = new WsClient(); await wq.connect(GW_PORT)
    wq.send({ t: 'quick', gameId: 'tactics-duel' })
    await sleep(3500); wq.closeHard()
    room = await pickBotRoom()
  }
  ok(!!room, 'T3a 前置：拿到纯 bot 战棋房', room ? `${room.roomId} bots=${room.bots}` : '无房')
  const roomId = room.roomId
  /* 旁观者 S：全程记录 seat 名册时间线（转换证据主面） */
  const wsS = new WsClient(); await wsS.connect(GW_PORT)
  const roster = []
  wsS.on('message', (m) => { if (m.t === 'seat') roster.push({ at: now(), seats: m.seats }) })
  wsS.send({ t: 'join', roomId, mode: 'spectate', name: '名册S' })
  await sleep(500)
  const wsA = new WsClient(); await wsA.connect(GW_PORT)
  const A = new TdDriver(wsA, 'yield-A')
  wsA.send({ t: 'join', roomId, mode: 'play', name: '让位探针A' })
  await sleep(700)
  ok(A.welcome && A.role === 'player', 'T3a 真人 play 加入成功（takeover 让位）', A.welcome ? `seat=${A.seat}` : '无 welcome')
  ok(A.seat === 1, 'T3a 让位=顶替最大 bot 席（协议 §2）', `seat=${A.seat}`)
  const m1 = (await gw('GET', '/api/matches')).json.matches.find((m) => m.roomId === roomId)
  ok(m1 && m1.humans === 1, 'T3a feed：入房后 humans=1', m1 ? `humans=${m1.humans} bots=${m1.bots}` : '房不在 feed')
  rec.t3a = { roomId, seat: A.seat, takeover: true }
  /* 推过部署相位（避免部署超时代置干扰），随后离席 */
  A.deploy()
  await sleep(1500)
  wsA.send({ t: 'leave' }); wsA.closeHard()
  const leftAt = now()
  await sleep(8500)
  const m85 = (await gw('GET', '/api/matches')).json.matches.find((m) => m.roomId === roomId)
  const roster85 = roster.filter((r) => r.at <= leftAt + 8500)
  const seat85 = roster85.length ? roster85[roster85.length - 1].seats.find((s) => s.seat === 1) : null
  ok((m85 && m85.humans === 1) || (seat85 && seat85.kind === 'human'), 'T3a 离席 +8.5s：席位保留（10s 重连窗内）',
    m85 ? `feed humans=${m85.humans}` : `roster kind=${seat85 && seat85.kind}`)
  await sleep(4000)
  const m12 = (await gw('GET', '/api/matches')).json.matches.find((m) => m.roomId === roomId)
  const convSnap = roster.find((r) => r.at > leftAt + 8500 && (r.seats.find((s) => s.seat === 1) || {}).kind === 'bot')
  ok(!!convSnap || (m12 && m12.humans === 0), 'T3a 离席 +12.5s：席转托管 bot（回收，循环闭合）',
    convSnap ? `roster 席1→bot@+${Math.round((convSnap.at - leftAt) / 1000)}s` : (m12 ? `feed humans=${m12.humans}` : 'roster/feed 均未见'))
  rec.t3a.rosterTimeline = roster.map((r) => ({ dt: Math.round((r.at - leftAt) / 1000), seats: r.seats.map((s) => `${s.seat}:${s.kind}`) }))
  wsS.closeHard()
}

/* ---------- T3b 满员 + 第 3 人旁观 ---------- */
logln('[T3b] 双人满员 + 第 3 人旁观稳定')
{
  const wsA = new WsClient(); await wsA.connect(GW_PORT)
  const A = new TdDriver(wsA, 'full-A')
  wsA.send({ t: 'quick', gameId: 'tactics-duel' })
  const t0 = now()
  while (!A.welcome && now() - t0 < 10_000) await sleep(150)
  ok(A.welcome && A.role === 'player', 'T3b A 入房', `seat=${A.seat}`)
  const roomId = A.welcome.roomId
  const wsB = new WsClient(); await wsB.connect(GW_PORT)
  const B = new TdDriver(wsB, 'full-B')
  wsB.send({ t: 'join', roomId, mode: 'play', name: '满员B' })
  await sleep(700)
  ok(B.welcome && B.role === 'player' && B.seat !== A.seat, 'T3b B 入房（双人满员=2 席）', `seat=${B.seat}`)
  const mFull = (await gw('GET', '/api/matches')).json.matches.find((m) => m.roomId === roomId)
  ok(mFull && mFull.humans === 2 && mFull.bots === 0, 'T3b feed：humans=2 满员', mFull ? `humans=${mFull.humans} bots=${mFull.bots}` : '-')
  /* 第 3 人 play 加入 → 满员静默转旁观 */
  const wsC = new WsClient(); await wsC.connect(GW_PORT)
  const C = new TdDriver(wsC, 'spec-C')
  wsC.send({ t: 'join', roomId, mode: 'play', name: '第三者C' })
  await sleep(700)
  ok(C.welcome && C.welcome.role === 'spectator', 'T3b 第 3 人满员加入→静默转旁观（不拒）', C.welcome ? `role=${C.welcome.role}` : '无 welcome')
  const mSpec = (await gw('GET', '/api/matches')).json.matches.find((m) => m.roomId === roomId)
  ok(mSpec && mSpec.spectators === 1, 'T3b feed：spectators=1', mSpec ? `spectators=${mSpec.spectators}` : '-')
  rec.t3b = { roomId, seats: [A.seat, B.seat], specRole: C.welcome && C.welcome.role }

  /* ---------- T4 长局 ≥5 分钟（A/B 慢节奏对弈）+ feed 新鲜度两时点 ---------- */
  logln('[T4] 长局 spot ≥5 分钟（回合间 12s 间隙）+ feed 新鲜度抽查 2 点（循环内 ≈150s/≈290s）')
  A.deploy(); B.deploy()
  const t4start = now()
  const cooldown = new Map()
  let acted = 0
  const sample = async (tag) => {
    const m = (await gw('GET', '/api/matches')).json.matches.find((x) => x.roomId === roomId)
    const s = {
      tag, wallS: Math.round((now() - t4start) / 1000),
      inFeed: !!m, humans: m && m.humans, spectators: m && m.spectators, elapsedMs: m && m.elapsedMs,
      lastInAgeA: now() - wsA.lastInAt, rulingsC: C.turns.length, inCountC: C.inCount,
    }
    rec.t4.samples.push(s)
    ok(s.inFeed && s.lastInAgeA < 60_000, `T4 feed 新鲜度@${tag}：房在 feed + A 侧 WS 入向消息 <60s`, `wall=${s.wallS}s lastInA=${s.lastInAgeA}ms rulingsC=${s.rulingsC}`)
  }
  let nextSampleAt = [150_000, 290_000]
  while (!A.ended && now() - t4start < 310_000) {
    if (nextSampleAt.length && now() - t4start >= nextSampleAt[0]) { nextSampleAt.shift(); await sample(nextSampleAt.length === 1 ? 'p1≈150s' : 'p2≈290s') }
    for (const X of [A, B]) {
      if (X.deployPending) { X.deploy(); continue }
      if (X.myTurn && (cooldown.get(X) || 0) <= now()) {
        X.actOnce(); acted++
        if (X.lastOp && X.lastOp.k === 'endTurn') cooldown.set(X, now() + GAP_MS)
      }
    }
    await sleep(300)
  }
  const wallS = Math.round((now() - t4start) / 1000)
  ok(wallS >= 295 || !!A.ended, 'T4 长局持续 ≥5 分钟（或自然终局）', `wall=${wallS}s ended=${!!A.ended} acted=${acted}`)
  /* 旁观稳定：整段窗口 C 未断 + 收到足量 ruling（观战面 state 持续到达） */
  ok(!wsC.closed && C.turns.length >= 5, 'T3b/T4 旁观 C 全程稳定收 ruling（观战视图持续到达）', `closed=${wsC.closed} rulings=${C.turns.length}`)
  ok(C.rejections.length === 0, 'T3b 旁观者零 reject（旁观连接不发 op）', `rejects=${C.rejections.length}`)
  ok(!!C.view, 'T3b 旁观收到观战面 state（viewFor(-1)）', C.view ? `phase=${C.view.phase}` : '无 view')
  rec.t4 = Object.assign(rec.t4, { wallS, acted, ended: !!A.ended, Aerrors: A.errors, Cerrors: C.errors })
  wsA.closeHard(); wsB.closeHard(); wsC.closeHard()
}

evidence('qa2-t3t4-rooms.json', rec)
const [p, f] = done()
console.log(`\n${f === 0 ? 'QA2-ROOMS OK' : 'QA2-ROOMS FAILED'}：${p} 通过，${f} 失败`)
process.exit(f === 0 ? 0 : 1)
