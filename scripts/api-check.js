/* =====================================================================
 * api-check —— 每款联机游戏通用的 API 可玩性断言（GAMES-41 · M1）
 * 用法：node scripts/api-check.js <gameId>       （例：net-tank）
 * 前置：网关(:4400) 运行中；游戏 game.json 已声明 net.api（规范：docs/net-protocol.md §8）。
 *
 * 纯 API 驱动整局（零浏览器）：经 /api/test/* 建隔离测试房 → 注入操作 →
 * 读状态快照断言。剧本（seed/bot 档位/假时钟倍速/胜负期望）全部来自 game.json net.api，
 * 本工具不含任何游戏私有规则；玩家策略走 net.api.script.scenarios[].policy 注册表。
 *
 * 断言组（roadmap §4.2 / 联机红线「API 可玩」）：
 *   L1 仅本机：测试面经非回环地址访问 → 403
 *   A1 能开始：boot(waiting)→live 状态迁移（+ 测试房不进 feed 隔离）
 *   A2 能赢：剧本胜方达成终态（result.winner === expectWinner）
 *   A3 能输：剧本败方终态（对称局）
 *   A4 操作注入→帧反映 <100ms（服务端同钟计时：receivedAt → 帧广播 ts）
 *   A5 断线重连：$disconnect → 席位保留 → $reconnect 凭 token 复席，<10s 状态恢复续玩
 * 报告：JSON 落盘 kernel 证据路径（默认 /Volumes/BigDisk/Studio/kernel/workers/GAMES-41）。
 * 退出码：0=全绿，1=有失败（可挂闸门）；2=用法/环境错误。
 * 与 net-check 分工：本工具管 API 面（逻辑可玩性），net-check 管浏览器面
 * （大厅/入房/让位/feed/旁观/识图截图）——见 docs/net-protocol.md §8.4。
 * ===================================================================== */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4400'
const EVIDENCE_DIR = process.env.GAMES_EVIDENCE || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-41'
const POLL_MS = 120 // 剧本驱动轮询节拍（注入更新频率；帧间输入由 lastInput 宽限沿用）

let passed = 0, failed = 0
const checks = []
const ok = (id, name, cond, detail = '') => {
  const pass = !!cond
  if (pass) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  checks.push({ id, name, pass, detail: String(detail) })
  return pass
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 网关 HTTP 小客户端 ---------- */
async function gw(method, path, body, origin = GW) {
  const res = await fetch(origin + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, json }
}
const gwState = async (roomId, since = 0) => gw('GET', `/api/test/state?roomId=${roomId}&since=${since}`)
const gwInput = (roomId, seat, op, payload) => gw('POST', '/api/test/input', { roomId, seat, op, payload })

/* ---------- 玩家策略注册表（net.api.scenarios[].policy 按名引用；新游戏在此登记） ---------- */
const POLICIES = {
  /** 挂机：零输入（可输性剧本——被猎杀方） */
  idle: () => ({ mx: 0, my: 0, fire: 0 }),
  /** 猎杀最近敌：模拟量向量压向最近敌人 + 持续开火；复用 sim 的 sx 卡死账本脱困（net-tank 状态形状） */
  'hunt-nearest': (state, seat) => {
    const me = state.tanks && state.tanks[seat]
    if (!me || !me.alive) return { mx: 0, my: 0, fire: 0 }
    let best = null, bd = Infinity
    for (const t of state.tanks) {
      if (!t.alive || t.team === me.team) continue
      const d = (t.x - me.x) ** 2 + (t.y - me.y) ** 2
      if (d < bd) { bd = d; best = t }
    }
    if (!best) return { mx: 0, my: 0, fire: 0 }
    let dx = best.x - me.x, dy = best.y - me.y
    if ((me.sx || 0) >= 3) { const t0 = dx; dx = -dy; dy = t0 } // 卡死账本 ≥3：方向旋转 90° 蹭出
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    return { mx: Math.round(dx / len * 100), my: Math.round(dy / len * 100), fire: 1 }
  },
}

/* ---------- 剧本局驱动：policy 注入直至终态 ---------- */
async function playScript(roomId, policy, deadlineMs) {
  let cursor = 0
  for (;;) {
    const r = await gwState(roomId, cursor)
    if (!r.json || !r.json.ok) return { error: r.json && r.json.error || `HTTP ${r.status}` }
    cursor = r.json.cursor
    if (r.json.phase === 'ended') return { result: r.json.result, tick: r.json.tick, state: r.json.state }
    if (Date.now() > deadlineMs) return { error: '剧本超时未终局' }
    if (r.json.phase === 'live') {
      const inp = policy(r.json.state, r.json.playerSeat)
      const i = await gwInput(roomId, r.json.playerSeat, 'ctrl', inp)
      if (!i.json || !i.json.ok) return { error: i.json && i.json.error || `注入失败 HTTP ${i.status}` }
    }
    await sleep(POLL_MS)
  }
}

/* ---------- 主流程 ---------- */
const gameId = process.argv[2]
if (!gameId) {
  console.error('用法：node scripts/api-check.js <gameId>   （例：net-tank；剧本声明见 game.json net.api）')
  process.exit(2)
}
const tsStart = Date.now()

/* 游戏 game.json 定位与 net.api 校验 */
let meta = null
for (const type of await readdir(join(ROOT, 'games'))) {
  if (type.startsWith('_') || type.startsWith('.')) continue
  try {
    const p = join(ROOT, 'games', type, gameId, 'game.json')
    meta = JSON.parse(await readFile(p, 'utf8'))
    break
  } catch { /* 换下一个类型目录 */ }
}
if (!meta) { console.error(`✗ 未找到 games/*/${gameId}/game.json`); process.exit(2) }
const api = meta.net && meta.net.api
if (!api || !api.script || !api.script.scenarios) {
  console.error(`✗ ${gameId} 缺 net.api 声明（ops/胜负终态/测试剧本，规范 docs/net-protocol.md §8）——不可 API 验证`)
  process.exit(2)
}
const script = api.script
const OPS = Object.keys(api.ops || {})
console.log(`api-check ${gameId}（${meta.title} · ${meta.net.tech} · ${meta.net.mode}）`)
console.log(`剧本：seed=${script.seed} timeScale=${script.timeScale}x ops=[${OPS.join(',')}] ctl=[${(api.ctlOps || []).join(',')}]`)

/* 网关验活 */
const health = await gw('GET', '/healthz').catch(() => null)
if (!health || !health.json || health.json.ok !== true) {
  console.error(`✗ 网关未运行或验活失败：${GW}/healthz（启动口径 docs/net-protocol.md §9）`)
  process.exit(2)
}
ok('P0', '网关在线', true, `${GW} rooms=${health.json.rooms}`)

/* ---------- L1 仅本机（测试面非回环 403） ---------- */
console.log('[L1] 测试面仅本机可用')
{
  const lan = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)[0]
  if (!lan) {
    ok('L1', '非回环访问拒绝', true, '无外网口，跳过（isLoopback 单测另证于 server/gateway/test.mjs [5]）')
  } else {
    const gwPort = new URL(GW).port || '80'
    const r = await gw('POST', '/api/test/room', { gameId, botLevels: [null] }, `http://${lan}:${gwPort}`)
      .catch((e) => ({ status: 0, err: String(e.message || e) }))
    ok('L1', '非回环访问 → 403 local-only', r.status === 403, r.status === 403 ? `经 ${lan}:${gwPort} 实测 403` : `status=${r.status}${r.err ? ' ' + r.err : ''}`)
  }
}

/* ---------- A1+A4+A5 冒烟局（win 配置的隔离房，一房三断言） ---------- */
console.log('[A1/A4/A5] 开始迁移 / 注入延迟 / 断线重连')
const smokeCfg = { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: script.maxTicks, botLevels: script.scenarios.win.botLevels }
const tSmoke = Date.now()
let smoke = null, smokeEnd = { phase: null, tick: 0, seatKept: false, resumeMs: -1, reflMs: -1, startedSeen: false, welcome2Seen: false, feedLeak: false, tickAfter: 0 }
try {
  const created = await gw('POST', '/api/test/room', smokeCfg)
  smoke = created.json && created.json.ok ? created.json : null
  ok('A1', '建房（API 席自动入座）', !!smoke, smoke ? `roomId=${smoke.roomId.slice(0, 10)}… seat=${smoke.playerSeat} seed=${smoke.state.seed}` : `HTTP ${created.status} ${created.json && created.json.error}`)
  if (smoke) {
    ok('A1', 'boot 态 waiting + 席位就绪', smoke.phase === 'waiting' && smoke.seats.length === (meta.net.seats || smoke.seats.length)
      && smoke.seats[smoke.playerSeat].kind === 'human', `phase=${smoke.phase} seats=${smoke.seats.length}`)
    /* 隔离红线：测试房不得进大厅 feed */
    const feed = await gw('GET', '/api/matches')
    const leak = feed.json && feed.json.matches && feed.json.matches.some((m) => m.roomId === smoke.roomId)
    smokeEnd.feedLeak = !!leak
    ok('A1', '测试房不进大厅 feed（隔离）', !leak)
    /* boot → live */
    let s = smoke, cursor = smoke.cursor
    const liveDeadline = Date.now() + (smokeCfg.startDelayMs || 0) + 5000
    while (s.phase !== 'live' && Date.now() < liveDeadline) {
      await sleep(80)
      const r = await gwState(smoke.roomId, cursor)
      s = r.json; cursor = r.json.cursor
    }
    smokeEnd.startedSeen = (s.events || []).some((e) => e.msg.t === 'started')
    ok('A1', 'boot→live 状态迁移（开赛）', s.phase === 'live' && smokeEnd.startedSeen, `phase=${s.phase} started=${smokeEnd.startedSeen}`)
    /* A4 注入 → 帧反映（服务端同钟：receivedAt → 帧广播 ts） */
    const inj = await gwInput(smoke.roomId, smoke.playerSeat, 'ctrl', { mx: 63, my: 0, fire: 0 })
    const receivedAt = inj.json && inj.json.receivedAt
    let refl = null, r4 = s, c4 = cursor
    const t4 = Date.now()
    while (!refl && Date.now() - t4 < 3000) {
      const r = await gwState(smoke.roomId, c4)
      r4 = r.json; c4 = r.json.cursor
      refl = (r4.events || []).find((e) => e.msg.t === 'frame' && e.msg.inputs && e.msg.inputs[smoke.playerSeat] && e.msg.inputs[smoke.playerSeat].mx === 63)
      if (!refl) await sleep(30)
    }
    smokeEnd.reflMs = refl ? refl.ts - receivedAt : -1
    ok('A4', '操作注入→帧反映 <100ms', !!refl && smokeEnd.reflMs < 100, smokeEnd.reflMs >= 0 ? `实测 ${smokeEnd.reflMs}ms（timeScale=${smokeCfg.timeScale}x）` : '3s 内未见帧反映')
    const tGet0 = Date.now()
    await gwState(smoke.roomId, 0)
    ok('A4', '状态快照 GET 往返 <100ms', Date.now() - tGet0 < 100, `${Date.now() - tGet0}ms`)
    /* A5 断开重连（10s 窗内凭 token 复席续玩） */
    const dis = await gwInput(smoke.roomId, smoke.playerSeat, '$disconnect')
    const disAt = dis.json && dis.json.disconnectedAt
    await sleep(1200)
    const mid = await gwState(smoke.roomId)
    smokeEnd.seatKept = mid.json && mid.json.seats && mid.json.seats[smoke.playerSeat].kind === 'human'
    ok('A5', '断线期席位保留（10s 窗，未转 bot）', smokeEnd.seatKept, `seat kind=${mid.json && mid.json.seats[smoke.playerSeat].kind}`)
    const tickBefore = mid.json ? mid.json.tick : 0
    const rec = await gwInput(smoke.roomId, smoke.playerSeat, '$reconnect', { token: smoke.token })
    const resumedAt = rec.json && rec.json.resumedAt
    smokeEnd.resumeMs = resumedAt && disAt ? resumedAt - disAt : -1
    const rAfter = await gwState(smoke.roomId)
    smokeEnd.welcome2Seen = (rAfter.json.events || []).some((e) => e.msg.t === 'welcome' && e.msg.role === 'player' && e.msg.seat === smoke.playerSeat)
    ok('A5', '凭 token 复席 + 全量 state 重同步', rec.json && rec.json.ok && rec.json.seat === smoke.playerSeat && smokeEnd.welcome2Seen,
      `resume=${smokeEnd.resumeMs}ms welcome=重同步下发`)
    await sleep(1000)
    const fin = await gwState(smoke.roomId)
    smokeEnd.tickAfter = fin.json ? fin.json.tick : 0
    ok('A5', '重连后状态恢复续玩（帧继续推进）', smokeEnd.tickAfter > tickBefore || (fin.json && fin.json.phase === 'ended'),
      `tick ${tickBefore}→${smokeEnd.tickAfter}${fin.json && fin.json.phase === 'ended' ? '（恰逢终局）' : ''}`)
    ok('A5', '断线→复席全程 <10s（红线窗）', smokeEnd.resumeMs >= 0 && smokeEnd.resumeMs < 10_000, `${smokeEnd.resumeMs}ms`)
    smokeEnd.phase = fin.json ? fin.json.phase : null
    smokeEnd.tick = smokeEnd.tickAfter
  }
} finally {
  if (smoke) await gw('DELETE', '/api/test/room', { roomId: smoke.roomId }).catch(() => {})
}

/* ---------- A2 能赢 / A3 能输（剧本局；额外剧本名以 A+ 标注） ---------- */
for (const [name, sc] of Object.entries(script.scenarios)) {
  const aid = name === 'win' ? 'A2' : name === 'lose' ? 'A3' : `A+(${name})`
  console.log(`[${aid}] 剧本局 ${name}（policy=${sc.policy}，期望胜方 ${sc.expectWinner}）`)
  const t0 = Date.now()
  let room = null
  try {
    const created = await gw('POST', '/api/test/room', { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: script.maxTicks, botLevels: sc.botLevels })
    room = created.json && created.json.ok ? created.json : null
    if (!room) { ok(aid, `${name} 建房`, false, `HTTP ${created.status} ${created.json && created.json.error}`); continue }
    const tickMs = (room.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
    const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
    const policy = POLICIES[sc.policy || 'idle'] || POLICIES.idle
    const r = await playScript(room.roomId, policy, Date.now() + budgetMs)
    const durMs = Date.now() - t0
    if (!r.result) {
      ok(aid, `${name} 达成终态`, false, r.error || '未终局')
    } else {
      const winnerOk = r.result.winner === sc.expectWinner
      const teams = (api.endState && api.endState.teams) || meta.net.teams
      const myTeam = teams && Object.entries(teams).find(([, seats]) => seats.includes(room.playerSeat))
      const detail = `winner=${r.result.winner}（期望 ${sc.expectWinner}） reason=${r.result.reason} scores=${JSON.stringify(r.result.scores)} tick=${r.tick}${myTeam ? ` API 席属 ${myTeam[0]} 队` : ''} ${durMs}ms`
      if (aid === 'A2') ok('A2', '能赢：剧本胜方达成终态（' + r.result.reason + '）', winnerOk, detail)
      else if (aid === 'A3') ok('A3', '能输：剧本败方终态达成（' + r.result.reason + '）', winnerOk, detail)
      else ok(aid, `${name}：期望胜方达成终态`, winnerOk, detail)
    }
  } finally {
    if (room) await gw('DELETE', '/api/test/room', { roomId: room.roomId }).catch(() => {})
  }
}

/* ---------- 报告落盘 + 汇总 ---------- */
const report = {
  tool: 'api-check', spec: 1, gameId, title: meta.title,
  tech: meta.net.tech, gw, ts: tsStart, durationMs: Date.now() - tsStart,
  script, ops: OPS,
  smoke: smokeEnd,
  checks,
  summary: { passed, failed, exitCode: failed === 0 ? 0 : 1 },
}
try {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  const stamp = new Date(tsStart).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  await writeFile(join(EVIDENCE_DIR, `api-check-${gameId}-${stamp}.json`), JSON.stringify(report, null, 2))
  await writeFile(join(EVIDENCE_DIR, `api-check-${gameId}-latest.json`), JSON.stringify(report, null, 2))
  console.log(`\n报告：${EVIDENCE_DIR}/api-check-${gameId}-${stamp}.json`)
} catch (e) {
  console.error(`\n报告落盘失败：${e.message}`)
  failed++
}
console.log(`${failed === 0 ? 'API-CHECK OK' : 'API-CHECK FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
