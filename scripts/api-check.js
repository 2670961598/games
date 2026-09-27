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
  /**
   * 宏观推进（slg-battlefield A2 能赢，设计书 §6 时间轴 + 经济适配）：
   * 开局 2×inf 车道1 → 双信号塔常驻集结线+驻塔 inf（占塔拿 +2 CP/s 与积分通道兜底）→
   * razor/inf 交替车道1 → tick 300 起 heavy 推进；敌集群 ≥4 barrage、基地 <70% repair。
   * 每次轮询至多回 1 条 cmd（离散指令，S1 帧通道一次一条）。
   */
  'macro-push': (state, seat) => {
    const NOOP = { cmd: { k: 'noop' } }
    const s = state.seats && state.seats[seat]
    if (!s) return NOOP
    const t = state.tick
    const foe = s.team === 'A' ? 'B' : 'A'
    const myBase = (state.bld || []).find((b) => b.kind === 'base' && b.team === s.team)
    const cp = s.cp, tier = s.tier
    const cost = (u) => ({ inf: [20, 30, 40], razor: [45, 65, 85], heavy: [110, 155, 210] })[u][tier - 1] * 1000
    const units = state.units || []
    const pop = units.filter((u) => u.seat === seat).length
    const towers = state.towers || []
    const castable = (id) => s.energy >= [60, 40, 70, 50][id] && (!s.cd || s.cd[id] <= 0)
    /* 技能：repair（基地 <70%）> barrage（敌集群 ≥4，45px 同车道窗口口径同 sim） */
    if (myBase && myBase.hp < 1050 && castable(1)) return { cmd: { k: 'skill', id: 1 } }
    let cl = null
    for (const e of units) {
      if (e.team !== foe) continue
      let c = 0
      for (const o of units) if (o.team === foe && o.lane === e.lane && Math.abs(o.y - e.y) <= 45000) c++
      if (!cl || c > cl.c) cl = { lane: e.lane, row: Math.max(0, Math.min(19, (e.y / 25000) | 0)), c }
    }
    if (cl && cl.c >= 4 && castable(0)) return { cmd: { k: 'skill', id: 0, lane: cl.lane, row: cl.row } }
    /* 集结：双塔车道常驻塔位（占塔/反夺回；车道 1 不设集结 → 直推敌基地） */
    for (const tw of towers) {
      if (s.rally[tw.lane] !== tw.row) return { cmd: { k: 'rally', lane: tw.lane, row: tw.row } }
    }
    /* 驻塔：塔无己方单位驻守（40px 口径同 sim 占点）→ 补 1 inf */
    if (pop < 12 && s.spawnCd <= 0) {
      for (const tw of towers) {
        const holder = units.some((u) => u.seat === seat && u.lane === tw.lane && Math.abs(u.y - tw.y) <= 40000)
        if (!holder && cp >= cost('inf')) return { cmd: { k: 'spawn', unit: 'inf', lane: tw.lane } }
      }
      /* 研究：T2 凑够即升（设计 tick 150 起的 opportunist 版——经济允许时才花） */
      if (tier === 1 && !s.research && t >= 150 && cp >= 150000) return { cmd: { k: 'research', tier: 2 } }
      if (tier === 2 && !s.research && t >= 900 && cp >= 300000) return { cmd: { k: 'research', tier: 3 } }
      /* 主攻车道 1：开场 2×inf → razor/inf 交替（留 CP 缓冲）→ tick 300 起 heavy */
      if (t < 40) { if (cp >= cost('inf')) return { cmd: { k: 'spawn', unit: 'inf', lane: 1 } } }
      else if (t >= 300 && cp >= cost('heavy') + 30000) return { cmd: { k: 'spawn', unit: 'heavy', lane: 1 } }
      else if (cp >= cost('razor') + 25000 && s.spawned % 2 === 0) return { cmd: { k: 'spawn', unit: 'razor', lane: 1 } }
      else if (cp >= cost('inf') + 25000) return { cmd: { k: 'spawn', unit: 'inf', lane: 1 } }
    }
    return NOOP
  },
  /**
   * 采集推进（mmo-township A2 能赢，设计书 §6 剧本策略）：满包回贡献台自动倾倒；
   * 否则价值/距离贪心择最近非空资源位直奔，到位持握（服务端 hold 连采、幂等 start）。
   * S2 语义：move 连续量每拍重发；gather start 幂等（同 entId 续进度），无需跨拍记忆。
   */
  'gather-push': (state, seat) => {
    const NOOP = { mx: 0, my: 0 }
    const me = state.ents && state.ents['p' + seat]
    const sess = state.sessions && state.sessions[seat]
    if (!me || !sess) return NOOP
    const dist = (x, y) => Math.hypot(x - me.x, y - me.y)
    const toward = (x, y) => {
      const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
      return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
    }
    if (sess.bagN >= 6) { // 满包回城：贡献台 60px 内站定自动倾倒
      const dp = state.map.deposit
      return dist(dp.x, dp.y) > 50000 ? toward(dp.x, dp.y) : NOOP
    }
    if (sess.g && sess.g.hold) return NOOP // 持握中：站桩续采（进度服务器权威）
    let best = null, bs = -1
    for (const id in state.ents) {
      const e = state.ents[id]
      if (!e || e.stock <= 0) continue
      const v = { herb: 2, berry: 3, ore: 5, star: 8 }[e.k]
      if (!v) continue
      const s = v / (dist(e.x, e.y) + 200000)
      if (s > bs) { bs = s; best = e }
    }
    if (!best) return NOOP
    return dist(best.x, best.y) > 52000
      ? toward(best.x, best.y)
      : { mx: 0, my: 0, cmd: { k: 'gather', entId: best.id, phase: 'start' } }
  },
  /**
   * 帝国速攻（empire-sprout A2 能赢，设计书 §6 剧本策略全貌）：
   * 查表 build order（t≈150 lumber → ≈350 farm → ≈550 camp，资源就绪门控）
   * → 循环 train camp inf n=5（队列空位即补）→ tick≥1800 且 CD 好：attack lane1 全池
   * → rally lane1 row10 起动态前导（集结线随战线前压 2 行）→ 池回 ≥8 再征。
   * S3 语义：建设 op 走 o 壳、战斗 cmd 走 c 壳（每次轮询至多一条）。
   */
  'empire-rush': (() => {
    const mem = { rally: -9 }   // 策略记忆（跨轮询持久；剧本单房单席无污染）
    return (state, seat) => {
      const NOOP = {}
      const s = state.build && state.build.seats[seat]
      if (!s) return NOOP
      const t = state.tick
      const res = { g: Math.floor(s.res.g / 1000), w: Math.floor(s.res.w / 1000), i: Math.floor(s.res.i / 1000) }
      const qn = s.queues.reduce((a, q) => a + q.n, 0)
      const pool = Object.values(s.pools).reduce((a, x) => a + x.length, 0)
      const plotOf = (kind) => s.plots.findIndex((p) => p && p.kind === kind)
      const freePlot = () => s.plots.findIndex((p) => !p)
      if (t >= 1800) {          // rally 动态前导（c 优先——爆发期集结线先于攒兵）
        let front = -1
        for (const u of state.battle.units) {
          if (u.seat !== seat || u.hp <= 0 || u.lane !== 1) continue
          const rr = (u.y / 25000) | 0
          if (front < 0 || rr < front) front = rr
        }
        const target = front < 0 ? 10 : Math.max(0, front - 2)
        if (Math.abs(target - mem.rally) >= 2) { mem.rally = target; return { c: { k: 'rally', lane: 1, row: target } } }
      }
      const COST = { lumber: { w: 30 }, farm: { w: 40 }, camp: { w: 60, i: 40 }, works: { w: 80, i: 60 } }
      for (const kind of ['lumber', 'farm', 'camp', 'works']) {   // 4 槽 6 选 4：军备线（§2.5a works→razor）
        if (plotOf(kind) >= 0) continue
        if (Object.entries(COST[kind]).every(([r, n]) => res[r] >= n) && freePlot() >= 0) {
          return { o: { k: 'build', plot: freePlot(), kind } }
        }
        break   // 严格顺序：当前目标建不起就攒资源等（防后位抢跑占槽）
      }
      if (t >= 1800 && s.marchCd <= 0 && pool >= 8) {
        const units = {}
        for (const c in s.pools) if (s.pools[c].length) units[c] = s.pools[c].length
        if (Object.keys(units).length) return { o: { k: 'attack', lane: 1, units } }
      }
      if (plotOf('camp') >= 0 && qn + pool < 12 && res.g >= 100) {
        // 军备线（§2.5a）：razor ×1.5 克制步海——inf:razor 2:1 混编（works 建成且铁够时）
        const nInf = s.pools.inf.length, nRaz = s.pools.razor.length
        if (plotOf('works') >= 0 && nRaz * 2 < nInf + qn && res.g >= 225 && res.i >= 90) {
          return { o: { k: 'train', kind: 'works', unit: 'razor', n: Math.min(5, 12 - pool - qn) } }
        }
        return { o: { k: 'train', kind: 'camp', unit: 'inf', n: Math.min(5, 12 - pool - qn) } }
      }
      return NOOP
    }
  })(),
}

/* ---------- 剧本局驱动：policy 注入直至终态 ---------- */
async function playScript(roomId, policy, deadlineMs, isS2 = false) {
  let cursor = 0, seq = 0 // S2：input.frame=客户端输入序号 seq（单调自 0，协议 §6 S2 声明）
  for (;;) {
    const r = await gwState(roomId, cursor)
    if (!r.json || !r.json.ok) return { error: r.json && r.json.error || `HTTP ${r.status}` }
    cursor = r.json.cursor
    if (r.json.phase === 'ended') return { result: r.json.result, tick: r.json.tick, state: r.json.state }
    if (Date.now() > deadlineMs) return { error: '剧本超时未终局' }
    if (r.json.phase === 'live') {
      const inp = policy(r.json.state, r.json.playerSeat)
      if (isS2) inp.frame = seq++
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
const isS2 = meta.net.tech === 'S2' || meta.net.tech === 'S3'   // S3（GAMES-68）：注入带 seq、A4 走快照 ack 口径
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
    if (meta.net.tech === 'S2') {
      /* S2 状态同步：welcome.state 全量世界（实体/碰撞表）+ 首张全量快照（设计 §6 A1） */
      const entN = smoke.state && smoke.state.ents ? Object.keys(smoke.state.ents).length : 0
      ok('A1', 'S2 welcome.state 含实体/碰撞表', entN > 0 && Array.isArray(smoke.state.collide) && smoke.state.collide.length > 0,
        `ents=${entN} collide=${smoke.state.collide && smoke.state.collide.length}`)
      const firstFull = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
        || await (async () => { // live 检测响应可能落在 started 与首张快照之间（1 tick 窗）——短暂轮询补看
          let r = s, c = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            r = q.json; c = q.json.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
          }
          return hit
        })()
      ok('A1', 'S2 首张全量快照（full=1）', !!firstFull,
        firstFull ? `snapSeq=${firstFull.msg.snapSeq} ents=${firstFull.msg.ents.length} aoi.r=${firstFull.msg.ext && firstFull.msg.ext.aoi && firstFull.msg.ext.aoi.r}` : '未见快照')
    } else if (meta.net.tech === 'S3') {
      /* S3 混合同步（GAMES-68）：welcome.state 双层（build 资源/建筑位 + battle 空态墙/心）
         + 首张建设快照（ext.layer='build'，设计 §6 A1）——静默期无战斗帧是正常态（附决策 1） */
      const bs = smoke.state && smoke.state.build, bt = smoke.state && smoke.state.battle
      ok('A1', 'S3 welcome.state 双层（build+battle）',
        !!(bs && Array.isArray(bs.seats) && bs.seats.length && bs.seats[0].res && bs.seats[0].plots
          && bt && Array.isArray(bt.bld) && bt.bld.length === 4 && bt.bld[0].hp > 0),
        `build.seats=${bs && bs.seats.length} battle.bld=${bt && bt.bld.length} 墙HP=${bt && bt.bld[0] && bt.bld[0].hp}`)
      const firstBuild = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1 && e.msg.ext && e.msg.ext.layer === 'build')
        || await (async () => { // 25ms 窗竞态先例：live 检测响应可能落在 started 与首张快照之间——短轮询补看
          let r = s, c = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            r = q.json; c = q.json.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1 && e.msg.ext && e.msg.ext.layer === 'build')
          }
          return hit
        })()
      ok('A1', 'S3 首张建设快照（layer=build, full=1）', !!firstBuild,
        firstBuild ? `snapSeq=${firstBuild.msg.snapSeq} frame=${firstBuild.msg.frame} ents=${firstBuild.msg.ents.length}` : '未见建设快照')
    }
    /* A4 注入 → 帧反映（服务端同钟：receivedAt → 帧广播 ts）。
       S2：注入带 seq（input.frame=输入序号），快照 ext.ack ≥ seq 即证明已处理（§6 A4）。 */
    const injPayload = isS2 ? { mx: 63, my: 0, fire: 0, frame: 1 } : { mx: 63, my: 0, fire: 0 }
    const inj = await gwInput(smoke.roomId, smoke.playerSeat, 'ctrl', injPayload)
    const receivedAt = inj.json && inj.json.receivedAt
    let refl = null, r4 = s, c4 = cursor
    const t4 = Date.now()
    while (!refl && Date.now() - t4 < 3000) {
      const r = await gwState(smoke.roomId, c4)
      r4 = r.json; c4 = r.json.cursor
      refl = isS2
        ? (r4.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.ext && Number(e.msg.ext.ack) >= 1)
        : (r4.events || []).find((e) => e.msg.t === 'frame' && e.msg.inputs && e.msg.inputs[smoke.playerSeat] && e.msg.inputs[smoke.playerSeat].mx === 63)
      if (!refl) await sleep(30)
    }
    smokeEnd.reflMs = refl ? refl.ts - receivedAt : -1
    ok('A4', `操作注入→${isS2 ? '快照 ack 反映' : '帧反映'} <100ms`, !!refl && smokeEnd.reflMs < 100, smokeEnd.reflMs >= 0 ? `实测 ${smokeEnd.reflMs}ms（timeScale=${smokeCfg.timeScale}x）` : '3s 内未见反映')
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
    const r = await playScript(room.roomId, policy, Date.now() + budgetMs, isS2)
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
