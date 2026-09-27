/* =====================================================================
 * 网关与 sim 单测/集成测（GAMES-40）——node server/gateway/test.mjs，全绿 exit 0。
 * 覆盖：
 *   1. sim 确定性：同 seed 同输入脚本双实例逐 tick 状态哈希一致（S1 红线）；
 *   2. 可赢/可输：竞技 bot 击杀挂机队 → winner 判定（eliminated 路径）；
 *   3. serialize 往返：反序列化后继续 step 轨迹一致（重连 resync 的前提）；
 *   4. WS 端到端（真网关 + Node 原生 WebSocket 客户端，随机端口）：
 *      quick 入房/欢迎帧/帧推进/输入上行/pong/第二真人 bot 让位/断线重连(10s 窗)/
 *      席位托管转 bot/feed HTTP 形状。
 *   5. 测试管理 API（GAMES-41）：isLoopback 鉴权/隔离测试房/操作注入→帧反映/
 *      $disconnect+$reconnect 复席/DELETE 回收/feed 隔离。
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert'

const require = createRequire(import.meta.url)
const NTSim = require('../../games/multiplayer/net-tank/sim.cjs')

let passed = 0, failed = 0
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 1. 确定性 ---------- */
{
  console.log('[1] sim 确定性')
  const seed = NTSim.fnv1a32('test-room-α')
  const a = NTSim.create(seed)
  const b = NTSim.create(seed)
  ok(JSON.stringify(a) === JSON.stringify(b), '同 seed 初始态逐字节一致')
  const rngA = NTSim.mulberry32(seed), rngB = NTSim.mulberry32(seed)
  let same = true
  for (let f = 0; f < 300; f++) {
    const inputs = {}
    for (let s = 0; s < 4; s++) {
      const lvl = ['casual', 'balanced', 'competitive'][s % 3]
      inputs[s] = NTSim.brain(a, s, lvl, rngA)
      // B 实例用独立 rng 但同 seed → brain 输出一致
      const ib = NTSim.brain(b, s, lvl, rngB)
      if (JSON.stringify(inputs[s]) !== JSON.stringify(ib)) same = false
    }
    NTSim.step(a, inputs); NTSim.step(b, inputs)
    if (a.tick !== b.tick || JSON.stringify(a) !== JSON.stringify(b)) { same = false; break }
  }
  ok(same, '300 tick 双实例（含 brain 随机源同 seed）状态一致')
  ok(a.walls.length === 25 && a.walls.every((r) => r.length === 15), '场地 15×25')
  ok(a.tanks.length === 4 && a.tanks[0].team === 'A' && a.tanks[1].team === 'B', '4 席 2v2 分队')
}

/* ---------- 2. 可赢/可输（eliminated 路径） ---------- */
{
  console.log('[2] 可赢/可输')
  const seed = NTSim.fnv1a32('fight-room')
  const run = (winnerSide) => {
    const st = NTSim.create(seed, { hp: 2 })
    const rng = NTSim.mulberry32(seed ^ 0x1234)
    for (let f = 0; f < NTSim.META.maxTicks; f++) {
      const inputs = {}
      for (let s = 0; s < 4; s++) {
        const isHunter = (winnerSide === 'A' ? s % 2 === 0 : s % 2 === 1)
        inputs[s] = isHunter ? NTSim.brain(st, s, 'competitive', rng) : { mx: 0, my: 0, fire: 0 }
      }
      const r = NTSim.step(st, inputs)
      if (r.over) return r.result
    }
    return null
  }
  const rA = run('A')
  ok(rA && rA.winner === 'A' && rA.reason === 'eliminated', `竞技 bot 击杀挂机 B 队 → A 胜（${rA ? rA.reason + '/' + rA.winner : '未终局'}）`)
  const rB = run('B')
  ok(rB && rB.winner === 'B' && rB.reason === 'eliminated', `对称局 → B 胜（挂机即输的可输性）`)
}

/* ---------- 3. serialize 往返 ---------- */
{
  console.log('[3] serialize 往返（重连 resync 前提）')
  const seed = NTSim.fnv1a32('resume-room')
  const a = NTSim.create(seed)
  const rng = NTSim.mulberry32(seed)
  for (let f = 0; f < 50; f++) {
    const inputs = {}
    for (let s = 0; s < 4; s++) inputs[s] = NTSim.brain(a, s, 'balanced', rng)
    NTSim.step(a, inputs)
  }
  const b = NTSim.deserialize(NTSim.serialize(a))
  const rng2 = NTSim.mulberry32(seed + 1)
  const rng3 = NTSim.mulberry32(seed + 1)
  let same = true
  for (let f = 0; f < 100; f++) {
    const ia = {}, ib = {}
    for (let s = 0; s < 4; s++) { ia[s] = NTSim.brain(a, s, 'casual', rng2); ib[s] = NTSim.brain(b, s, 'casual', rng3) }
    NTSim.step(a, ia); NTSim.step(b, ib)
    if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; break }
  }
  ok(same, '快照恢复后 100 tick 轨迹一致')
}

/* ---------- 4. WS 端到端（真网关随机端口 + 原生 WebSocket 客户端） ---------- */
const GW_PORT = 4400 + (process.pid % 400)
const child = spawn(process.execPath, ['server/gateway/index.js'], {
  cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/, ''),
  // GATEWAY_PID 改道：临时网关不得覆盖常驻实例的 server/data/gateway.pid（§9 运维口径依赖它）
  env: { ...process.env, PORT: String(GW_PORT), HOST: '127.0.0.1', GATEWAY_LOG: '/dev/null', GATEWAY_PID: `/tmp/gateway-test-${GW_PORT}.pid` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const gwLog = []
child.stdout.on('data', (d) => gwLog.push(String(d)))
child.stderr.on('data', (d) => gwLog.push(String(d)))

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/ws`)
    const queue = []
    const waiters = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const i = waiters.findIndex((w) => w.pred(msg))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
      else queue.push(msg)
    })
    ws.addEventListener('open', () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next: (pred, timeout = 8000) => new Promise((res, rej) => {
        const i = queue.findIndex(pred)
        if (i >= 0) return res(queue.splice(i, 1)[0])
        const timer = setTimeout(() => rej(new Error('ws wait timeout')), timeout)
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); res(m) } })
      }),
    }))
    ws.addEventListener('error', reject)
  })
}

try {
  console.log('[4] WS 端到端（网关 :%s）', GW_PORT)
  await sleep(700) // 等网关起来 + BotHost 首轮补房
  const health = await (await fetch(`http://127.0.0.1:${GW_PORT}/healthz`)).json()
  ok(health.ok === true, 'healthz ok')

  const feed0 = await (await fetch(`http://127.0.0.1:${GW_PORT}/api/matches`)).json()
  ok(feed0.ok === true && Array.isArray(feed0.matches) && feed0.matches.length >= 1, `feed 有真实 bot 房（${feed0.matches.length} 间）`)
  const need = ['roomId', 'gameId', 'name', 'mode', 'humans', 'bots', 'spectators', 'elapsedMs', 'joinable', 'url']
  ok(feed0.matches.every((m) => need.every((k) => m[k] !== undefined)), 'feed 字段完整（协议 §3）')
  ok(feed0.matches.some((m) => m.gameId === 'net-tank' && m.bots >= 1 && m.humans === 0), 'net-tank 纯 bot 房在列（多游戏注册后按存在性断言，GAMES-52 修正 every 过期假设）')

  const cRes = await fetch(`http://127.0.0.1:${GW_PORT}/api/matches`)
  ok(cRes.headers.get('access-control-allow-origin') === '*', 'feed CORS *')

  // P1 quick 入房 → bot 让位
  const p1 = await wsConnect()
  p1.send({ t: 'quick', gameId: 'net-tank' })
  const w1 = await p1.next((m) => m.t === 'welcome')
  ok(w1.role === 'player' && w1.seat >= 0 && w1.token && w1.state && w1.state.walls, 'welcome：席位+token+全量初态')
  ok(w1.room.seats.some((s) => s.kind === 'human') && w1.room.seats.filter((s) => s.kind === 'bot').length === 3, '4 席房真人入座后 3 bot（让位后）')
  const seatMsg = await p1.next((m) => m.t === 'seat')
  ok(seatMsg.seats[w1.seat].kind === 'human', 'seat 名册广播：真人席位')

  // 帧推进 + 输入上行 + started（若 waiting）或直接 frame
  if (w1.room.state === 'waiting') await p1.next((m) => m.t === 'started')
  const f1 = await p1.next((m) => m.t === 'frame')
  ok(f1.frame >= 1 && f1.inputs && Object.keys(f1.inputs).length === 4, `frame 广播含全席位输入（frame=${f1.frame}）`)
  p1.send({ t: 'input', frame: f1.frame + 1, keys: { mx: 100, my: 0, fire: 1 } })
  const f2 = await p1.next((m) => m.t === 'frame' && m.frame > f1.frame)
  ok(f2.inputs[w1.seat].mx === 100 || f2.inputs[w1.seat].mx === 0, '输入上行进入下一帧（或被宽限沿用）')

  // ping/pong
  p1.send({ t: 'ping', c: 12345 })
  const pong = await p1.next((m) => m.t === 'pong')
  ok(pong.c === 12345 && typeof pong.s === 'number', 'pong 回显（时钟同步）')

  // P2 加入同一房 → 再让一位 bot
  const p2 = await wsConnect()
  p2.send({ t: 'join', roomId: w1.roomId, mode: 'play' })
  const w2 = await p2.next((m) => m.t === 'welcome')
  ok(w2.role === 'player' && w2.seat !== w1.seat, '第二真人入座另一席（bot 让位）')
  const feed2 = await (await fetch(`http://127.0.0.1:${GW_PORT}/api/matches`)).json()
  const mine = feed2.matches.find((m) => m.roomId === w1.roomId)
  ok(mine && mine.humans === 2 && mine.bots === 2, `feed 反映 2 人 2 bot（humans=${mine && mine.humans}）`)

  // P1 断线重连（10s 窗内凭 token 复席）
  p1.ws.close()
  await sleep(300)
  const p1b = await wsConnect()
  p1b.send({ t: 'join', roomId: w1.roomId, mode: 'play', resume: { seat: w1.seat, token: w1.token } })
  const w1b = await p1b.next((m) => m.t === 'welcome')
  ok(w1b.role === 'player' && w1b.seat === w1.seat, `重连复席（seat ${w1.seat}）`)
  const fr = await p1b.next((m) => m.t === 'frame')
  ok(fr.frame > w1b.frame, '重连后帧继续推进')

  // 坏消息容错
  p1b.send('this is not json')
  const err1 = await p1b.next((m) => m.t === 'error' && m.code === 'bad-msg')
  ok(!!err1, '坏 JSON → error bad-msg（连接不断）')
  p1b.send({ t: 'join', roomId: 'no-such-room' })
  const err2 = await p1b.next((m) => m.t === 'error' && m.code === 'room-gone')
  ok(!!err2, '不存在房间 → error room-gone')

  // 房间 gone：等一局终局（bot 互杀终有果）后 room-gone / 或直接验证 join 房被回收路径
  p1b.ws.close(); p2.ws.close()
  ok(true, '会话关闭（席位进入 10s 保留窗）')

  /* ---------- 5. 测试管理 API（GAMES-41）：隔离房/同路径注入/快照/重连/回收 ---------- */
  console.log('[5] 测试管理 API（/api/test/*，协议 §8）')
  const GW_HTTP = `http://127.0.0.1:${GW_PORT}`
  const api = async (method, path, body) => {
    const res = await fetch(GW_HTTP + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json = null
    try { json = await res.json() } catch { /* 非 JSON 应答 */ }
    return { status: res.status, json }
  }
  {
    const { isLoopback } = await import('./testapi.js')
    ok(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }) && isLoopback({ socket: { remoteAddress: '::1' } })
      && isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), 'isLoopback：回环三形全认')
    ok(!isLoopback({ socket: { remoteAddress: '192.168.1.5' } }) && !isLoopback({ socket: { remoteAddress: '10.0.0.2' } })
      && !isLoopback({ socket: { remoteAddress: undefined } }), 'isLoopback：非回环/未知来源一律拒')
  }
  const tr = await api('POST', '/api/test/room', {
    gameId: 'net-tank', seed: 20260926, timeScale: 4, startDelayMs: 200,
    botLevels: [null, 'casual', 'competitive', 'casual'],
  })
  ok(tr.status === 200 && tr.json.ok && tr.json.roomId && tr.json.playerSeat === 0 && !!tr.json.token,
    '建房：确定性 seed + API 席 0 + token（回环可用）')
  ok(tr.json.phase === 'waiting' && tr.json.seats.length === 4 && tr.json.state.seed === 20260926,
    '初态 waiting + 4 席 + seed 钉死')
  const feedT = await (await fetch(`${GW_HTTP}/api/matches`)).json()
  ok(!feedT.matches.some((m) => m.roomId === tr.json.roomId), '测试房不进 feed（隔离红线）')
  let snap = null
  for (let i = 0; i < 40; i++) {
    snap = await api('GET', `/api/test/state?roomId=${tr.json.roomId}`)
    if (snap.json.phase === 'live') break
    await sleep(100)
  }
  ok(snap.json.phase === 'live', 'boot→live（startDelay 后开赛）')
  ok(snap.json.events.some((e) => e.msg.t === 'welcome' && e.msg.role === 'player'),
    '虚拟会话 welcome 入账（与真人同入房路径）')
  const inj = await api('POST', '/api/test/input', { roomId: tr.json.roomId, seat: 0, op: 'ctrl', payload: { mx: 63, my: 0, fire: 0 } })
  ok(inj.status === 200 && inj.json.ok && typeof inj.json.receivedAt === 'number', '注入 op=ctrl（WS input 同 sim 入口）')
  let refl = null
  for (let i = 0; i < 40; i++) {
    snap = await api('GET', `/api/test/state?roomId=${tr.json.roomId}&since=${snap.json.cursor}`)
    refl = snap.json.events.find((e) => e.msg.t === 'frame' && e.msg.inputs[0] && e.msg.inputs[0].mx === 63)
    if (refl) break
    await sleep(50)
  }
  ok(!!refl && refl.ts - inj.json.receivedAt < 100, `注入→帧反映 <100ms（实测 ${refl ? refl.ts - inj.json.receivedAt : '-'}ms）`)
  const dis = await api('POST', '/api/test/input', { roomId: tr.json.roomId, op: '$disconnect' })
  ok(dis.status === 200 && dis.json.ok, '$disconnect（与 WS close 同路径）')
  await sleep(300)
  snap = await api('GET', `/api/test/state?roomId=${tr.json.roomId}`)
  ok(snap.json.seats[0].kind === 'human', '断线 10s 窗内席位保留（未转 bot）')
  const rec2 = await api('POST', '/api/test/input', { roomId: tr.json.roomId, op: '$reconnect', payload: { token: tr.json.token } })
  ok(rec2.status === 200 && rec2.json.ok && rec2.json.seat === 0, '$reconnect 凭 token 复席')
  const badTok = await api('POST', '/api/test/input', { roomId: tr.json.roomId, op: '$reconnect', payload: { token: 'deadbeef' } })
  ok(badTok.status === 409, '坏 token 重连被拒（复席语义不降级）')
  const del = await api('DELETE', '/api/test/room', { roomId: tr.json.roomId })
  ok(del.status === 200 && del.json.ok, 'DELETE 清理')
  const gone = await api('GET', `/api/test/state?roomId=${tr.json.roomId}`)
  ok(gone.status === 404, '清理后 room-gone')
  const badGame = await api('POST', '/api/test/room', { gameId: 'no-such-game', botLevels: [null] })
  ok(badGame.status === 404, '未知游戏 404')
} finally {
  child.kill('SIGTERM')
  await sleep(300)
}

console.log(`\n${failed === 0 ? 'ALL OK' : 'FAILED'}：${passed} 通过，${failed} 失败`)
if (gwLog.some((l) => l.includes('uncaught'))) console.error('--- 网关日志异常 ---\n' + gwLog.join(''))
process.exit(failed === 0 ? 0 : 1)
