/* =====================================================================
 * 星海小镇 mmo-township 服务端 sim（GAMES-52 · E6/W1/T2）——S2 状态同步首证。
 * 设计事实源：docs/designs/mmo-township.md（GAMES-50 评审通过版）。
 *
 * 与 S1（net-tank/slg）的根本差异：sim 仅服务端（客户端零判定）——
 * 服务端权威 10Hz 推进 + 二式快照（全量/增量+自适应阈值）+ AOI 视野过滤
 * （r=300px、15px 滞回、预算 40 分层裁剪）+ 客户端预测和解（ext.ack，
 * 协议 §6 S2/S6/S7 预留位实启，零协议变更）。两端共享的仅一段纯函数：
 * games/multiplayer/mmo-township/predict.cjs（移动积分+碰撞，本文件 require）。
 *
 * 常驻世界语义（设计 §1.1/§5.6）：镇=房间永续不 ended（META.persistent，
 * rooms.js 跳过 abandon）；周期事件（镇日 3000 tick/流星雨）在 state 内；
 * 镇存档 60s+镇日结算落盘、回收重建读档续镇；测试房不读不写存档、
 * maxTicks 强制投影终局（winner A=API 席贡献≥120 / B=未达标）。
 * Bot 居民三档（casual 游手/balanced 勤恳/competitive 商人，设计 §4）：
 * 让矿礼貌层豁免商人档；人口动态调节由 BotHost 常驻镇模式驱动（§4.1）。
 *
 * GAMES-55 BOT 深化：居民是内容不是填充——①三档人格化（每档 brain 个性注释+
 * 行为清单，§4 brain 总纲）②社交涌现（偶遇表情互动/对真人靠近反应差异，全走
 * 席位 rng 服务端侧）③陪聚集（真人少→贴身陪伴、真人多→让资源散布，动态聚集度
 * 参数入 game.json residents 节）④日程系统（镇日内虚拟昼夜切行为集：白天采集/
 * 黄昏集市/夜晚喷泉广场聚集，设计 §1 周期事件对齐）。协议零变更（ext.t.sc 为
 * §6 向后兼容自由键）；确定性红线：无 Date/random 入判定路径。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const P = require('../../../games/multiplayer/mmo-township/predict.cjs')
/* 居民深化参数唯一事实源=game.json residents 节（GAMES-55 任务3：动态聚集度参数
 * 入 game.json）；此处载入+同值兜底——改 game.json 即调参，无需动 sim */
const CFG = require('../../../games/multiplayer/mmo-township/game.json')
const RES = (CFG && CFG.residents) || {}
/* F1'（GAMES-63）席位会话继承开关：false=新语义（默认）——真人接管席位时会话战绩
 * 重开（"延续的是身份不是战绩"）；true=回退旧"席位延续"（托管/前任的 contrib/total
 * 随席位传给新加入者，QA二号 F1' 实测 me.c=42 上手）。改 game.json 即回退，无需动 sim */
const SESS_CFG = (CFG && CFG.session) || {}
const SESS_INHERIT = SESS_CFG.inheritOnTakeover === true

const SAVE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'mmo-township-save.json')

/* ---------- 随机源（协议 §5 纪律：seed=fnv1a32(roomId) 经 mulberry32） ---------- */
function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- 数值表（设计 §1.2/§2.2，可直接对书核验） ---------- */
const TICK_MS = 100
const DAY_TICKS = 3000            // 镇日 5 分钟
const METEOR_AT = 2900            // 周期末流星雨起点（10s）
const STAR_TTL = 600              // 星髓存在 60s
const BAG_CAP = 6                 // 背包 6 格
const DEPOSIT_TICKS = 8           // 倾倒 0.8s
const DEPOSIT_R = 60_000          // 贡献台热区 60px（mpx）
const GATHER_R = 60_000           // 采集热区容错 60px（§5.5 服务端收口）
const KEEP_TICKS = 30             // 松手进度保留 3s
const GOAL_CONTRIB = 120          // 会话达标线（§1.3）
const VALUE = { herb: 2, berry: 3, ore: 5, star: 8 }        // 贡献/单位
const GATHER_TICKS = { herb: 22, berry: 35, ore: 60, star: 20 } // hold 时长（0.1s/tick）
const REGEN_TICKS = { herb: 150, berry: 250, ore: 400 }     // 刷新周期（位满为止）
const SITE_CAP = { herb: 3, berry: 2, ore: 2, star: 1 }
const EXP_LV = [300, 700, 1200, 1800]                       // Lv2..Lv5 累计经验
const POP_BASE = 8                                           // 镇人口 = 8+(level-1)（§4.1）
/* 建筑槽（§1.2）：slot0 喷泉初始；1..4 解锁等级/个人花费（余额=贡献−已花） */
const BUILDINGS = [
  { slot: 0, kind: 'b-fountain', name: '喷泉', lv: 1, cost: 0, box: [678000, 1126000, 44000, 44000] },
  { slot: 1, kind: 'b-flower', name: '花坛', lv: 2, cost: 60, box: [580000, 1240000, 40000, 40000] },
  { slot: 2, kind: 'b-lighthouse', name: '灯塔', lv: 3, cost: 100, box: [806000, 1240000, 36000, 36000] },
  { slot: 3, kind: 'b-starbridge', name: '星桥', lv: 4, cost: 140, box: [600000, 1390000, 48000, 48000] },
  { slot: 4, kind: 'b-wishingwell', name: '许愿池', lv: 5, cost: 180, box: [782000, 1390000, 40000, 40000] },
]
const EMOTES = 8
/* 星髓位（全图偏远处，§2.2）+ 四分区（§2.1，mpx） */
const STAR_SPOTS = [[200, 220], [1200, 320], [160, 2240], [1240, 2240], [700, 680], [1180, 1560]]
const ZONES = [
  { id: 0, n: '星尘草甸', x: 0, y: 0, w: 1400000, h: 1000000 },
  { id: 1, n: '星语森林', x: 0, y: 1000000, w: 420000, h: 1400000 },
  { id: 2, n: '镇中心', x: 420000, y: 1000000, w: 560000, h: 1400000 },
  { id: 3, n: '辉石滩', x: 980000, y: 1000000, w: 420000, h: 1400000 },
]
const SPAWN = { x: 700000, y: 1330000 }   // 落生点（贡献台南侧，不压碰撞盒）
const WISP0 = { x: 700000, y: 1300000 }

/* ---------- AOI 常量（§2.3/§5.2） ---------- */
const AOI_R = 300_000, AOI_OUT = 315_000  // 入 300 / 出 315（15px 滞回带）
const AOI_BUDGET = 40
const FULL_EVERY = 300                    // 每 300 张强制全量（防增量漂移）
const FULL_DIRTY = 24                     // 脏实体 >24（预算 60%）→ 直接全量

const KIND_PRI = { player: 0, herb: 1, berry: 1, ore: 1, star: 1, 'npc-mayor': 2, 'npc-wisp': 3 } // 预算分层（wisp 最先裁）

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const dist2 = (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay)

/* =====================================================================
 * create(seed, opts) —— 世界布局（资源槽位 seed 派生，§2.1）
 * ===================================================================== */
function create(seed, opts = {}) {
  const rng = mulberry32(seed >>> 0)
  const jit = (span) => Math.trunc((rng() * 2 - 1) * span)
  const ents = {}
  const addSite = (id, k, x, y) => { ents[id] = { id, k, x, y, cap: SITE_CAP[k], stock: SITE_CAP[k], rt: 0 } }

  // 草甸 草×10（5 列×2 行分层抖动）；森林 果×8；滩 矿×6
  for (let i = 0; i < 10; i++) addSite('h' + i, 'herb', 150000 + (i % 5) * 260000 + jit(60000), 300000 + ((i / 5) | 0) * 450000 + jit(50000))
  for (let i = 0; i < 8; i++) addSite('b' + i, 'berry', 130000 + (i % 2) * 160000 + jit(40000), 1150000 + ((i / 2) | 0) * 330000 + jit(50000))
  for (let i = 0; i < 6; i++) addSite('o' + i, 'ore', 1110000 + (i % 2) * 180000 + jit(40000), 1250000 + ((i / 2) | 0) * 430000 + jit(50000))

  ents['npc-mayor'] = { id: 'npc-mayor', k: 'npc-mayor', x: 760000, y: 1240000 }
  ents['npc-wisp'] = { id: 'npc-wisp', k: 'npc-wisp', x: WISP0.x, y: WISP0.y, ph: 0 }

  const buildings = BUILDINGS.map((b) => ({ slot: b.slot, kind: b.kind, name: b.name, lv: b.lv, cost: b.cost, built: b.slot === 0, by: b.slot === 0 ? -1 : null }))
  const st = {
    v: 1, gameId: 'mmo-township', seed: seed >>> 0, tick: 0,
    testRoom: !!opts.test, maxTicks: opts.test ? (opts.maxTicks ?? null) : null,
    map: { w: P.W, h: P.H, zones: ZONES, spawn: SPAWN, deposit: { x: 700000, y: 1300000 } },
    town: { level: 1, exp: 0, day: 1, dayTick: 0, phase: 'calm', sc: 0 },
    buildings,
    collide: buildings.filter((b) => b.built).map((b) => ({ x: BUILDINGS[b.slot].box[0], y: BUILDINGS[b.slot].box[1], w: BUILDINGS[b.slot].box[2], h: BUILDINGS[b.slot].box[3] })),
    ents, sessions: {}, seatKinds: [],
    stats: { drainRate: 0, online: 0, pop: POP_BASE },
  }

  // 镇存档续镇（§5.6；测试房隔离不读不写）
  if (!st.testRoom) {
    const sv = loadSave()
    if (sv && sv.town) {
      st.town.level = clamp(sv.town.level | 0 || 1, 1, 5)
      st.town.exp = sv.town.exp | 0
      st.town.day = Math.max(1, sv.town.day | 0)
      for (const b of st.buildings) {
        const s = sv.buildings && sv.buildings.find((x) => x.slot === b.slot)
        if (s && s.built && b.built === false) {
          b.built = true; b.by = s.by ?? -1
          const box = BUILDINGS[b.slot].box
          st.collide.push({ x: box[0], y: box[1], w: box[2], h: box[3] })
        }
      }
      st.stats.top = Array.isArray(sv.top) ? sv.top.slice(0, 10) : []
    }
  }
  return st
}

/* ---------- 会话/化身（席位激活扫描：join/让位/补员全在 step 里自愈） ---------- */
function ensureSession(st, seat) {
  let s = st.sessions[seat]
  if (!s) {
    s = st.sessions[seat] = {
      seat, contrib: 0, total: 0, spent: 0, goalMet: false, badges: 0, hist: [],
      bag: { herb: 0, berry: 0, ore: 0, star: 0 }, bagN: 0, dumpT: 0, g: null,
      /* mem（bot 记忆，GAMES-55 扩展）：soc=社交账本{cool,n}（state 可观测）、socTo=
         社交对象（事件 to 字段·聊天气泡位预留）、wpK=日程驻留点（mkt 集市/plz 广场）、
         dw=驻留拍数、flN=陪聚集选点计数（聚集度实测观测位） */
      mem: { mode: 'wander', dt: 0, wp: null, tg: null, holdSent: false, emotePend: -1, soc: { cool: 0, n: 0 }, socTo: null, wpK: null, dw: 0, flN: 0 },
    }
  }
  return s
}
/* F1'（GAMES-63）席位易主会话重开：化身身份延续（位置/镇貌/镇等级不动），战绩不传——
 * 当日贡献/背包/达标/累计/已花/徽记/历史全部归零；mem（bot 记忆）保留，再托管时
 * 居民行为连续性不变。镇经验不回滚（托管期倾倒已入镇账，属镇不属人） */
function resetSession(st, seat) {
  const s = st.sessions[seat]
  if (!s) return
  s.contrib = 0; s.total = 0; s.spent = 0; s.goalMet = false; s.badges = 0; s.hist = []
  s.bag = { herb: 0, berry: 0, ore: 0, star: 0 }; s.bagN = 0; s.dumpT = 0; s.g = null
}
function spawnAvatar(st, seat) {
  const id = 'p' + seat
  if (st.ents[id]) return st.ents[id]
  const ring = seat * 2.399963 // 黄金角散布落生环，防叠位
  const r = 26000 + (seat % 3) * 9000
  const a = { id, k: 'player', seat, x: SPAWN.x + Math.trunc(Math.cos(ring) * r), y: SPAWN.y + Math.trunc(Math.sin(ring) * r), vx: 0, vy: 0, face: 0, mv: 0 }
  st.ents[id] = a
  return a
}

/* =====================================================================
 * step(state, inputs, room) —— tick 内结算序（§5.1：inputs→移动→采集→刷新→
 * 倾倒→建筑/升级→周期事件→投影终局；AOI/组包在 emit）
 * ===================================================================== */
function step(st, inputs, room) {
  const events = []
  const dirty = new Set()
  const kinds = room ? room.seats.map((s) => s.kind) : null

  /* 0. 席位自愈：激活席（human/bot）补化身+会话；空位化身清场（BotHost 调节/离镇） */
  if (room) {
    for (let i = 0; i < room.seats.length; i++) {
      const kind = room.seats[i].kind
      const active = kind === 'human' || kind === 'bot'
      const av = st.ents['p' + i]
      if (active && !av) { spawnAvatar(st, i); ensureSession(st, i); dirty.add('p' + i) }
      if (!active && av) delete st.ents['p' + i] // 出视野 leave 由各连接 known 集自动下发
      /* F1'（GAMES-63）席位会话继承收口：kind 首次转 human（真人接管托管席/空位）→
       * 会话战绩重开；重连窗内复席（kind 全程 human）不触发。开关见 game.json
       * session.inheritOnTakeover（true=旧席位延续语义，回退位） */
      if (!SESS_INHERIT && kind === 'human' && st.seatKinds[i] !== 'human') resetSession(st, i)
      st.seatKinds[i] = kind
    }
  }
  const activeSeats = Object.keys(st.sessions)
    .map(Number)
    .filter((i) => st.ents['p' + i])
  st.stats.online = activeSeats.length

  /* 1. 输入 → 移动积分（两端同式纯函数，§5.5）+ 离散 cmd */
  for (const seat of activeSeats) {
    const av = st.ents['p' + seat]
    const inp = inputs[seat] || {}
    const px = av.x, py = av.y, pf = av.face
    P.stepAvatar(av, inp.mx | 0, inp.my | 0, st.collide)
    if (av.x !== px || av.y !== py || av.face !== pf) dirty.add(av.id)
    if (inp.cmd) execCmd(st, seat, inp.cmd, dirty, events)
  }

  /* 2. 采集计时（服务器权威；逐 tick 距离/储量校验——隔空采在服务端关死） */
  for (const seat of activeSeats) {
    const sess = st.sessions[seat]
    const av = st.ents['p' + seat]
    const g = sess.g
    if (!g) continue
    if (!g.hold && g.prog > 0 && --g.left <= 0) g.prog = 0 // 松手保留 3s 过期
    if (g.hold) {
      const site = st.ents[g.id]
      if (!site || !GATHER_TICKS[site.k] || site.stock <= 0 || sess.bagN >= BAG_CAP || P.dist(av.x, av.y, site.x, site.y) > GATHER_R) {
        g.hold = false; g.left = KEEP_TICKS
        if (av.g) { av.g = null; dirty.add(av.id) }
      } else {
        g.prog++
        const dur = GATHER_TICKS[site.k]
        av.g = { id: site.id, p: Math.round(g.prog / dur * 100) / 100 }
        dirty.add(av.id)
        if (g.prog >= dur) {
          g.prog = 0
          site.stock--
          site.rt = REGEN_TICKS[site.k] || 0
          sess.bag[site.k]++; sess.bagN++
          events.push({ k: 'gather-done', entId: site.id, seat, res: site.k, n: 1 })
          dirty.add(site.id)
          if (site.stock <= 0 || sess.bagN >= BAG_CAP) { g.hold = false; av.g = null }
        }
      }
    } else if (av.g) { av.g = null; dirty.add(av.id) }
    /* 3. 表情气泡到期清理 */
    if (av.em && st.tick >= av.em.until) { av.em = null; dirty.add(av.id) }
  }

  /* 4. 资源刷新（草 15s/果 25s/矿 40s 回 1，位满为止） */
  for (const id in st.ents) {
    const e = st.ents[id]
    if (!REGEN_TICKS[e.k] || e.stock >= e.cap) continue
    if (e.rt > 0) e.rt--
    if (e.rt <= 0) { e.stock = Math.min(e.cap, e.stock + 1); e.rt = e.stock < e.cap ? REGEN_TICKS[e.k] : 0; dirty.add(id) }
  }

  /* 5. 倾倒（贡献台 60px 自动，0.8s 倒完；个人贡献与镇经验等额，§1.2） */
  const dp = st.map.deposit
  for (const seat of activeSeats) {
    const sess = st.sessions[seat]
    const av = st.ents['p' + seat]
    if (sess.bagN > 0 && P.dist(av.x, av.y, dp.x, dp.y) <= DEPOSIT_R) sess.dumpT++
    else sess.dumpT = 0
    if (sess.dumpT >= DEPOSIT_TICKS) {
      let v = 0
      for (const k in sess.bag) { v += sess.bag[k] * VALUE[k]; sess.bag[k] = 0 }
      sess.bagN = 0; sess.dumpT = 0
      sess.contrib += v; sess.total += v
      st.town.exp += v
      events.push({ k: 'deposit', seat, n: v })
      while (st.town.level < 5 && st.town.exp >= EXP_LV[st.town.level - 1]) {
        st.town.level++
        st.stats.pop = POP_BASE + st.town.level - 1
        events.push({ k: 'levelup', level: st.town.level })
      }
      if (!sess.goalMet && sess.contrib >= GOAL_CONTRIB) sess.goalMet = true // 达标即时（结算发徽记，§1.3）
    }
  }

  /* 6. 巡夜灯灵（氛围实体，固定环游） */
  const wisp = st.ents['npc-wisp']
  if (wisp) {
    wisp.ph = (wisp.ph + 0.045) % (Math.PI * 2)
    wisp.x = WISP0.x + Math.trunc(Math.cos(wisp.ph) * 180000)
    wisp.y = WISP0.y + Math.trunc(Math.sin(wisp.ph * 1.3) * 120000)
    dirty.add(wisp.id)
  }

  /* 7. 周期事件（镇日/流星雨，§1.1：世界不清空、房间不 ended） */
  st.town.dayTick++
  st.town.sc = st.town.dayTick >= SCHED_NIGHT ? 2 : st.town.dayTick >= SCHED_DUSK ? 1 : 0 // 虚拟昼夜时段（日程系统，GAMES-55）
  if (st.town.dayTick === METEOR_AT) {
    st.town.phase = 'meteor'
    const rng2 = mulberry32((st.seed ^ (st.town.day * 0x9e3779b9)) >>> 0)
    for (let i = 0; i < STAR_SPOTS.length; i++) {
      const s = STAR_SPOTS[i]
      st.ents['s' + i] = { id: 's' + i, k: 'star', x: s[0] * 1000 + Math.trunc((rng2() * 2 - 1) * 40000), y: s[1] * 1000 + Math.trunc((rng2() * 2 - 1) * 40000), cap: 1, stock: 1, ttl: STAR_TTL }
      dirty.add('s' + i)
    }
    events.push({ k: 'meteor', day: st.town.day })
  }
  for (let i = 0; i < STAR_SPOTS.length; i++) {
    const s = st.ents['s' + i]
    if (s && --s.ttl <= 0) delete st.ents['s' + i] // 存在 60s，到期自然消失（leave 自动下发）
  }
  if (st.town.dayTick >= DAY_TICKS) {
    // 镇日结算：贡献榜入档、每人重计、徽记落账（覆层 5s 是客户端表现）
    for (const seat of activeSeats) {
      const sess = st.sessions[seat]
      if (sess.goalMet) sess.badges++
      sess.hist.push(sess.contrib)
      sess.contrib = 0; sess.goalMet = false
    }
    events.push({ k: 'settle', day: st.town.day })
    st.town.day++; st.town.dayTick = 0; st.town.phase = 'calm'; st.town.sc = 0 // 新镇日自白天起
    if (room && !st.testRoom) persist(room)
  }

  /* 8. 观测字段（§1.4：高价值线 berry+ore 供给见底率，A3 叙事佐证） */
  {
    let stock = 0, cap = 0
    for (const id in st.ents) {
      const e = st.ents[id]
      if (e.k === 'berry' || e.k === 'ore') { stock += e.stock; cap += e.cap }
    }
    st.stats.drainRate = cap ? Math.round((1 - stock / cap) * 100) / 100 : 0
  }

  /* 9. 存档节拍（60s 周期写；镇日结算已即时写） */
  if (room && !st.testRoom && st.tick > 0 && st.tick % 600 === 0) persist(room)

  /* 10. 测试房投影终局（§6 endState：生产常驻镇不终局） */
  let over = null
  if (st.testRoom && st.maxTicks != null && room) {
    const humans = room.seats.filter((s) => s.kind === 'human').map((s) => s.seat)
    const scores = {}
    for (const seat of activeSeats) scores[seat] = st.sessions[seat].total // 会话累计（镇日结算重置当日榜，投影取累计更稳）
    if (humans.some((seat) => st.sessions[seat] && st.sessions[seat].goalMet)) {
      over = { winner: 'A', reason: 'goal', scores }
    } else if (st.tick >= st.maxTicks) {
      over = { winner: 'B', reason: 'day-end', scores }
    }
  }

  st.tick++
  // rooms.doFrame 契约（net-tank 先例）：over=布尔，result=终局投影（{winner,reason,scores}）
  return { events, dirty, over: !!over, result: over || null }
}

/* ---------- 离散 cmd（execCmd 白名单；畸形=静默 noop，slg 先例） ---------- */
function execCmd(st, seat, cmd, dirty, events) {
  if (!cmd || typeof cmd !== 'object') return
  const av = st.ents['p' + seat]
  const sess = st.sessions[seat]
  if (!av || !sess) return
  if (cmd.k === 'emote') {
    const id = cmd.id | 0
    if (id >= 0 && id < EMOTES) {
      av.em = { id, until: st.tick + 25 }
      dirty.add(av.id)
      /* 社交定向（GAMES-55 §2）：brain 偶遇互动时在 mem.socTo 记对象席位，此处
         附加到事件——`to` = 聊天气泡位预留（客户端据此刻画社交气泡尾标；真人自
         发表情无 to，形状向后兼容） */
      const ev = { k: 'emote', seat, id }
      if (sess.mem && sess.mem.socTo != null && sess.mem.socTo !== seat) ev.to = sess.mem.socTo
      if (sess.mem) sess.mem.socTo = null
      events.push(ev)
    }
  } else if (cmd.k === 'gather') {
    if (typeof cmd.entId === 'string' && cmd.phase === 'start') {
      const site = st.ents[cmd.entId]
      if (site && GATHER_TICKS[site.k] && site.stock > 0) {
        const keep = sess.g && sess.g.id === cmd.entId && sess.g.prog > 0 ? sess.g.prog : 0
        sess.g = { id: cmd.entId, prog: keep, hold: true, left: KEEP_TICKS }
      }
    } else if (cmd.phase === 'stop') {
      if (sess.g) { sess.g.hold = false; sess.g.left = KEEP_TICKS }
    }
  } else if (cmd.k === 'build') {
    const slot = cmd.slot | 0
    const b = st.buildings.find((x) => x.slot === slot)
    if (!b || b.built || st.town.level < b.lv) return
    if (sess.total - sess.spent < b.cost) return // 余额=累计贡献−已花（§1.2：达标口径不扣建筑，累计口径跨镇日）
    sess.spent += b.cost
    b.built = true; b.by = seat
    const box = BUILDINGS[slot].box
    st.collide.push({ x: box[0], y: box[1], w: box[2], h: box[3] })
    events.push({ k: 'build-done', slot, seat, box })
  }
}

/* =====================================================================
 * Bot 居民 brain（§4 三档人格；mem 挂会话、rng 挂席位——同 seed 双跑一致）
 * GAMES-55 人格化总纲（超越参数表——档位=居民人格，行为集随时段/社交/陪聚集切换）：
 *
 * casual 游手「老闲」：白天闲逛全图+喷泉边驻足社交+顺手采草；黄昏逛集市；夜晚
 *   喷泉广场内环扎堆；流星雨必驻足发星光（§4 表）。外向：表情最频，真人靠近
 *   挥手回应并驻足寒暄。
 * balanced 勤恳「矿工阿勤」：白天上班=矿线(辉石滩)-贡献台通勤（ore 主线带让矿
 *   礼貌，空线退草/果），满包回程哼歌（星光示意）；倾倒后歇脚点赞；黄昏下班
 *   清包后集市歇脚；夜晚广场中环。真人靠近点头（点赞示意）不停步。
 * competitive 商人「摊主金算盘」：白天抢高价值线（星髓>矿>果直奔，让矿豁免；
 *   流星雨夜也收摊抢星——生意优先于日程）；黄昏蹲集市守摊；夜晚广场外环摆摊
 *   边。真人靠近鼓掌招揽（冷却最短——生意人勤快）。
 * ===================================================================== */
const BOT_EVERY = { casual: 30, balanced: 12, competitive: 8 }
const BOT_YIELD_R = 120_000 // 让矿礼貌：目标 120px 内有真人在采 → 非 merchant 让 20 tick
/* ---------- GAMES-55 居民深化参数（game.json residents 节为事实源，缺省同值兜底） ---------- */
/* 日程（§4 任务4）：镇日 3000 tick 内虚拟昼夜——白天采集 / 黄昏(duskAt 起)集市 /
 * 夜晚(nightAt 起)喷泉广场聚集；流星雨 2900 落在夜段（广场看星，设计 §1 对齐） */
const SCHED = RES.sched || {}
const SCHED_DUSK = SCHED.duskAt ?? 2100
const SCHED_NIGHT = SCHED.nightAt ?? 2700
/* 陪聚集（§4 任务3）：真人 ≤aloneMaxHumans 时按档位权重贴身陪伴（waypoint 落
 * 真人活动锚环带），≥disperseAt 时让出资源（闲逛点避开真人所在分区）；区间线性过渡 */
const FLOCK = RES.flock || {}
const FLOCK_ALONE = FLOCK.aloneMaxHumans ?? 1
const FLOCK_DISPERSE = FLOCK.disperseAt ?? 3
const FLOCK_R = FLOCK.zoneR ?? 160_000
const FLOCK_SHARE = { casual: 0.85, balanced: 0.5, competitive: 0.15, ...(FLOCK.share || {}) }
/* 社交涌现（§4 任务2）：偶遇半径内触发互动，冷却防刷屏；商人招揽心切冷却最短 */
const SOC = RES.social || {}
const SOC_R = SOC.r ?? 60_000
const SOC_COOL = SOC.coolTicks ?? 120
const SOC_COOL_M = SOC.merchantCoolTicks ?? 60
/* 勤恳上班（§1 任务1）：矿班窗口（oreCycle 内前 oreWindow tick，席位错峰半周期）+
 * 让线半径（真人身边 oreClaimR 内的矿位整体让出）——"礼让三先"保真人的希望线 */
const WORK = RES.work || {}
const ORE_CLAIM_R = WORK.oreClaimR ?? 300_000
const ORE_WIN = WORK.oreWindow ?? 600
const ORE_CYCLE = WORK.oreCycle ?? 1200
/* 日程地标：喷泉广场锚=slot0 盒心；夜聚环带避开喷泉扩张盒外接圆（r≈48px）——
 * 内环游手（围着喷泉）/中环勤恳/外环商人（广场边"摆摊"）；黄昏集市环带挂贡献台
 * （无碰撞盒可贴）：勤恳歇脚内环/游手逛摊/商人守摊外环——档位=时空签名 */
const FOUNTAIN = { x: 700000, y: 1148000 }
const PLAZA_RING = { casual: [52000, 82000], balanced: [82000, 118000], competitive: [118000, 158000] }
const MARKET_RING = { balanced: [30000, 70000], casual: [50000, 100000], competitive: [70000, 120000] }
const HUM_RING = { casual: [60000, 150000], balanced: [80000, 160000], competitive: [90000, 160000] } // 陪玩环带：跟在真人身边晃（不叠身位）
/** 镇日时段（确定性：仅 dayTick） */
function schedOf(dayTick) { return dayTick >= SCHED_NIGHT ? 'night' : dayTick >= SCHED_DUSK ? 'dusk' : 'day' }
/** 真人活动锚（陪聚集）：真人化身质心，每拍由 state 推导（无记忆、零随机） */
function humanAnchor(st, kinds) {
  if (!kinds) return null
  let x = 0, y = 0, n = 0
  for (const s in st.sessions) {
    if (kinds[s] !== 'human') continue
    const av = st.ents['p' + (s | 0)]
    if (av) { x += av.x; y += av.y; n++ }
  }
  return n ? { x: Math.trunc(x / n), y: Math.trunc(y / n), n } : null
}
/** 坐标→分区 id（散布让区判定用；镇中心兜底） */
function zoneOf(x, y) {
  for (const z of ZONES) if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.id
  return 2
}
/* F1 卡死检测（GAMES-54）：有移动意图但连续 25 拍（2.5s@1×）位移 <2px 且无采集/倾倒
 * 进度 → 判卡，切向绕行航点（130px，45 拍上限）后强制重选目标——喷泉轴向自陷带
 * （steer 取整把侧向分量吃尽 → mx=0 永钉墙带，QA§7 F1）的兜底解；配合 steer 保底
 * 侧滑与贡献台散布，三层防钉。 */
const STUCK_TICKS = 25
const STUCK_MOVE = 2000
const DETOUR_MPX = 130_000
const DETOUR_TICKS = 45

function brain(st, seat, level, rng, env) {
  const av = st.ents['p' + seat]
  const sess = st.sessions[seat]
  if (!av || !sess) return { mx: 0, my: 0 }
  const mem = sess.mem
  const out = { mx: 0, my: 0 }
  const kinds = env && env.kinds
  const humansGathering = []
  if (kinds) {
    for (const s in st.sessions) {
      const o = st.sessions[s]
      if (kinds[s] === 'human' && o.g && o.g.hold && st.ents[o.g.id]) humansGathering.push(st.ents[o.g.id])
    }
  }
  const stars = Object.values(st.ents).filter((e) => e.k === 'star' && e.stock > 0)
  const sites = (ks) => Object.values(st.ents).filter((e) => GATHER_TICKS[e.k] && e.stock > 0 && (!ks || ks.includes(e.k)))

  const near = (x, y) => {
    for (const h of humansGathering) if (P.dist(h.x, h.y, x, y) < BOT_YIELD_R) return true
    return false
  }
  /* 让线加码（GAMES-55）：真人 220px 内的矿位整体让出（不只让正在采的）——
     勤恳"礼让三先"人格；矿线供给慢（40s/株），真人身边的矿是他们的希望线 */
  const nearHuman = (x, y, r) => {
    if (!kinds) return false
    for (const s in st.sessions) {
      if (kinds[s] !== 'human') continue
      const h = st.ents['p' + (s | 0)]
      if (h && P.dist(h.x, h.y, x, y) < r) return true
    }
    return false
  }
  const pickSite = (ks, polite, claimR = 0) => {
    let best = null, bs = -1
    for (const e of sites(ks)) {
      if (polite && near(e.x, e.y)) continue
      if (claimR && nearHuman(e.x, e.y, claimR)) continue
      const d = P.dist(av.x, av.y, e.x, e.y) + 1
      const s = e.stock * VALUE[e.k] * 100000 / d * (0.7 + rng() * 0.6) // 抖动散伙：多商人不同最近位，抢收不打堆
      if (s > bs) { bs = s; best = e }
    }
    return best
  }
  /* ---------- 陪聚集（§3）：真人活动锚+档位聚集权重（参数=game.json residents.flock） ---------- */
  if (!mem.soc) { mem.soc = { cool: 0, n: 0 }; mem.flN = mem.flN || 0 }
  const anchor = humanAnchor(st, kinds)
  const flockW = !anchor || anchor.n >= FLOCK_DISPERSE ? 0
    : (FLOCK_SHARE[level] ?? 0.5) * (anchor.n <= FLOCK_ALONE ? 1 : 1 - (anchor.n - FLOCK_ALONE) / (FLOCK_DISPERSE - FLOCK_ALONE))
  /* 真人是否在辉石滩（矿线，ZONES[3]）——勤恳"见客让线"判定（§1 让矿礼貌的深化） */
  let humansInOreZone = false
  if (anchor && kinds) {
    for (const s in st.sessions) {
      if (kinds[s] !== 'human') continue
      const h = st.ents['p' + (s | 0)]
      if (h && zoneOf(h.x, h.y) === 3) { humansInOreZone = true; break }
    }
  }

  const toWander = (bias) => {
    mem.mode = 'wander'
    if (anchor && flockW > 0 && rng() < flockW) {
      // 陪聚集：闲逛点落在真人活动锚环带内（陪伴感——真人在线少时最常发生）
      const a = rng() * Math.PI * 2
      const r = (0.35 + rng() * 0.65) * FLOCK_R
      mem.wp = { x: clamp(anchor.x + Math.trunc(Math.cos(a) * r), 40000, P.W - 40000), y: clamp(anchor.y + Math.trunc(Math.sin(a) * r), 40000, P.H - 40000) }
      mem.flN++
    } else if (anchor && anchor.n >= FLOCK_DISPERSE && !(bias && bias.length)) {
      // 真人多 → 让出资源：闲逛点避开真人所在分区（散布语义）
      const busy = new Set()
      for (const s in st.sessions) {
        if (!kinds || kinds[s] !== 'human') continue
        const h = st.ents['p' + (s | 0)]
        if (h) busy.add(zoneOf(h.x, h.y))
      }
      const free = ZONES.filter((z) => !busy.has(z.id))
      const pool = free.length ? free : ZONES
      const z = pool[(rng() * pool.length) | 0]
      mem.wp = { x: z.x + ((rng() * 0.7 + 0.15) * z.w) | 0, y: z.y + ((rng() * 0.7 + 0.15) * z.h) | 0 }
    } else if (bias && bias.length) {
      // 蹲守型游荡（商人）：高价值线打空时守在果/矿位附近等刷新，抓即所得
      const e = bias[(rng() * bias.length) | 0]
      mem.wp = { x: e.x + ((rng() * 2 - 1) * 150000) | 0, y: e.y + ((rng() * 2 - 1) * 150000) | 0 }
    } else {
      const z = ZONES[(rng() * ZONES.length) | 0]
      mem.wp = { x: z.x + ((rng() * 0.7 + 0.15) * z.w) | 0, y: z.y + ((rng() * 0.7 + 0.15) * z.h) | 0 }
    }
    mem.tg = null; mem.holdSent = false
  }

  /* ---------- 日程驻留（§4 任务4）：黄昏集市 mkt / 夜晚喷泉广场 plz / 陪玩 hum ---------- */
  const hangout = (place0) => {
    /* 陪玩驻留（§3）：游手白天的小驻优先跟真人——"跟在你身边晃"；真人多/无真人
       时退回喷泉广场（地盘不变，人格不变，只换陪伴对象） */
    const place = place0 === 'hum' && (!anchor || flockW <= 0) ? 'plz' : place0
    mem.mode = 'hangout'; mem.wpK = place
    const ring = (place === 'mkt' ? MARKET_RING : place === 'hum' ? HUM_RING : PLAZA_RING)[level] || PLAZA_RING.balanced
    const c = place === 'mkt' ? st.map.deposit : place === 'hum' ? anchor : FOUNTAIN
    const a = rng() * Math.PI * 2
    const r = ring[0] + rng() * (ring[1] - ring[0])
    mem.wp = { x: clamp(c.x + Math.trunc(Math.cos(a) * r), 40000, P.W - 40000), y: clamp(c.y + Math.trunc(Math.sin(a) * r), 40000, P.H - 40000) }
    if (place === 'hum') mem.flN++
    mem.dw = 25 + ((rng() * 55) | 0) // 到点小驻再换位——广场/集市里的踱步感
    mem.tg = null; mem.holdSent = false
  }

  /* ---------- 社交涌现（§2 任务2）：偶遇互动——全走本席位 rng（服务端侧，不破 S2） ----------
   * 居民间偶遇（≤SOC_R）：概率闸后挥手/大笑（游手更外向）；真人靠近：恒应答且
   * 反应随人格分岔——游手挥手+驻足寒暄 / 勤恳点头(点赞)不停步 / 商人鼓掌招揽。 */
  if (mem.soc.cool > 0) mem.soc.cool--
  else if (av.em == null || st.tick >= av.em.until) {
    let mate = null, md = SOC_R, mateHuman = false
    for (const s in st.sessions) {
      const s2 = s | 0
      if (s2 === seat) continue
      const av2 = st.ents['p' + s2]
      if (!av2) continue
      const d = P.dist(av.x, av.y, av2.x, av2.y)
      if (d < md) { md = d; mate = av2; mateHuman = !!(kinds && kinds[s] === 'human') }
    }
    if (mate && (mateHuman || rng() < 0.6)) {
      mem.emotePend = mateHuman
        ? (level === 'casual' ? 0 : level === 'balanced' ? 7 : 4) // 回应/点头/招揽（§2 反应差异表）
        : (rng() < (level === 'casual' ? 0.5 : 0.2) ? 1 : 0)      // 居民间：挥手为主，游手偶发大笑
      mem.socTo = mate.seat // 事件 to=聊天气泡位预留（execCmd 附加）
      mem.soc.n++
      mem.soc.cool = level === 'competitive' ? SOC_COOL_M : SOC_COOL
      if (mateHuman && level === 'casual') mem.dt = Math.max(mem.dt, 10)       // 游手驻足寒暄
      else if (mateHuman && level === 'competitive') mem.dt = Math.max(mem.dt, 6) // 商人驻摊多吆喝两声
    } else if (mate) mem.soc.cool = SOC_COOL >> 2 // 未成交也短冷却（防逐拍掷骰空转）
  }

  const ph = schedOf(st.town.dayTick) // 当前虚拟昼夜时段（日程系统）
  const wantHang = ph === 'dusk' ? 'mkt' : 'plz' // 黄昏集市 / 夜晚广场

  if (mem.dt <= 0) {
    mem.dt = BOT_EVERY[level] || 12
    mem.holdSent = false
    if (level === 'competitive') {
      if (stars.length && sess.bagN < BAG_CAP) {
        // 流星雨抢收（§4 商人人格：收摊不误生意——星髓优先于日程，昼夜里都冲）
        const tg = stars.reduce((a, b) => (P.dist(av.x, av.y, a.x, a.y) < P.dist(av.x, av.y, b.x, b.y) ? a : b))
        mem.mode = 'gather'; mem.tg = tg.id
      } else if (ph !== 'day') {
        // 黄昏蹲集市守摊 / 夜晚广场外环摆摊边（§1 商人时空签名）
        if (sess.bagN > 0) mem.mode = 'return' // 收摊先清包
        else if (mem.mode !== 'hangout' || mem.wpK !== wantHang) hangout(wantHang)
      } else if (sess.bagN >= BAG_CAP) { mem.mode = 'return' }
      else {
        // 目标粘性：当前目标仍有效则不换（防逐拍改道 ping-pong）
        const cur = mem.tg ? st.ents[mem.tg] : null
        const tg = (cur && cur.stock > 0 && (cur.k === 'ore' || cur.k === 'berry' || cur.k === 'star')) ? cur
          : pickSite(['ore', 'berry'], false) || pickSite(null, false)
        if (tg) { mem.mode = 'gather'; mem.tg = tg.id }
        else { toWander(sites(['ore', 'berry'])); mem.dt = 5 } // 空线快复查（蹲守刷新）
      }
    } else if (level === 'balanced') {
      if (ph !== 'day') {
        // 下班（定时上下班节奏的"下"半场）：清包 → 黄昏集市歇脚 / 夜晚广场中环
        if (sess.bagN > 0) mem.mode = 'return'
        else if (mem.mode !== 'hangout' || mem.wpK !== wantHang) hangout(wantHang)
      } else if (sess.bagN >= BAG_CAP) mem.mode = 'return'
      else if (mem.mode === 'rest' && mem.restT > 0) { /* 倾倒后歇脚继续 */ }
      else {
        // 上班：矿线(辉石滩)-贡献台通勤。矿班窗口（oreCycle 内前 oreWindow tick，
        // 席位错峰半周期——同镇勤恳不同时下矿）+ 见客让线：真人进了辉石滩，
        // 勤恳整线相让转头采草（礼让三先——A2 可赢线由让渡保住）；真人不在时
        // 让线半径兜底（身边的矿位让出）
        const enRoute = stars.filter((s) => P.dist(av.x, av.y, s.x, s.y) < 500000)[0] // 顺路捡 1 枚
        const oreShift = (st.town.dayTick + seat * (ORE_CYCLE >> 1)) % ORE_CYCLE < ORE_WIN && !humansInOreZone
        const tg = enRoute
          || (oreShift ? pickSite(['ore'], true, ORE_CLAIM_R) || pickSite(['herb', 'berry'], true)
            : pickSite(['herb', 'berry'], true) || pickSite(['ore'], true, ORE_CLAIM_R))
          || pickSite(['ore', 'herb', 'berry'], false)
        if (tg) { mem.mode = 'gather'; mem.tg = tg.id } else toWander()
      }
    } else {
      // casual 游手「老闲」：流星雨驻足星光；夜晚广场内环；黄昏逛集市；白天闲逛+喷泉社交+顺手采草
      if (stars.length) {
        mem.mode = 'stargaze'; mem.emotePend = 4
        if (sess.bagN >= 3) mem.mode = 'return'
      } else if (sess.bagN >= 3) mem.mode = 'return'
      else if (ph === 'night') {
        if (mem.mode !== 'hangout' || mem.wpK !== 'plz') hangout('plz')
      } else if (ph === 'dusk') {
        // 黄昏逛集市：逛摊与随处闲逛对半（游手不守摊，只凑热闹）
        if (rng() < 0.5) { if (mem.mode !== 'hangout' || mem.wpK !== 'mkt') hangout('mkt') }
        else toWander()
      } else if (rng() < 0.45) {
        const tg = pickSite(['herb'], true)
        if (tg && P.dist(av.x, av.y, tg.x, tg.y) < 700000) { mem.mode = 'gather'; mem.tg = tg.id } else toWander()
      } else if (rng() < 0.35) {
        // 喷泉边社交/陪玩小驻（白天也常驻广场——游手的地盘；真人少时改跟真人晃 §3）
        if (mem.mode !== 'hangout' || (mem.wpK !== 'plz' && mem.wpK !== 'hum')) hangout(rng() < flockW ? 'hum' : 'plz')
      } else if (rng() < 0.25) mem.emotePend = (rng() * EMOTES) | 0
      else toWander()
    }
  }
  mem.dt--

  /* 表情（决策拍内一次） */
  if (mem.emotePend >= 0) { out.cmd = { k: 'emote', id: mem.emotePend }; mem.emotePend = -1 }

  const steer = (x, y, stopR) => {
    const d = P.dist(av.x, av.y, x, y)
    if (d <= stopR) return 0
    const dx = x - av.x, dy = y - av.y
    const m = d < 45000 ? Math.round(d / 45000 * 60) : 100 // 近处减速防绕圈
    out.mx = Math.round(dx / d * m); out.my = Math.round(dy / d * m)
    /* F1 轴向陷阱保底：侧向分量被取整吃尽（|dx|/d·m<0.5）时补 ±6（≈7.2px/s 滑墙
       分量）——moveAxis 推挤只在有侧向速度时产生滑墙，纯轴向会钉死在墙带 */
    if (!out.mx && dx && out.my) out.mx = dx > 0 ? 6 : -6
    if (!out.my && dy && out.mx) out.my = dy > 0 ? 6 : -6
    return d
  }

  /* F1 绕行中：切向航点优先于任何模式目标；到达（或 45 拍超时）→ 强制重选目标 */
  if (mem.det) {
    const d0 = steer(mem.det.x, mem.det.y, 26000)
    if (d0 === 0 || --mem.det.t <= 0) { mem.det = null; mem.dt = 0 }
    return out
  }

  if (mem.mode === 'wander') {
    if (!mem.wp || steer(mem.wp.x, mem.wp.y, 26000) === 0) mem.dt = 0
  } else if (mem.mode === 'rest') {
    if (--mem.restT <= 0) mem.dt = 0
  } else if (mem.mode === 'stargaze') {
    if (!stars.length) mem.dt = 0
  } else if (mem.mode === 'hangout') {
    /* 日程驻留（§4 任务4）：到点小驻（dw 拍）后踱步换位——黄昏/夜晚的广场集市感；
       白天（游手喷泉社交/商人白日游摊）短驻即回决策拍 */
    if (!mem.wp || steer(mem.wp.x, mem.wp.y, 26000) === 0) {
      if (mem.dw > 0) mem.dw--
      else if (mem.wpK === 'hum') hangout('hum') // 陪玩驻留：到点换位即重锚真人（跟着走）
      else if (ph === 'day') mem.dt = 0
      else hangout(mem.wpK)
    }
  } else if (mem.mode === 'return') {
    /* F1 散布（排队语义的散布解）：满包回城目标不再全员瞄准贡献台圆心（正对喷泉
       盒心的轴向走廊），按席位金角环散布在台热区（60px）内——环点半径 ≤44px +
       停点半径 ≤(52−r)px，站位恒在热区内，倾倒语义不变 */
    const ring = seat * 2.399963
    const rr = 26000 + (seat % 3) * 9000
    const d = steer(st.map.deposit.x + Math.trunc(Math.cos(ring) * rr),
      st.map.deposit.y + Math.trunc(Math.sin(ring) * rr), Math.max(8000, 52000 - rr))
    if (sess.bagN === 0) {
      // 倾倒完成：勤恳档歇脚点赞（§4 emote 列）并翻班（矿班↔草班），商人/游手立即再出发
      if (level === 'balanced') { mem.mode = 'rest'; mem.restT = 12 + ((rng() * 25) | 0); mem.emotePend = 7 }
      else mem.dt = 0
    } else {
      // 满包哼歌（勤恳人格 §1）：回程/排队小概率哼小调（星光示意）
      if (level === 'balanced' && rng() < 0.15 && (av.em == null || st.tick >= av.em.until)) mem.emotePend = 3
      if (d === 0 && sess.dumpT < DEPOSIT_TICKS) { /* 站定等倾倒 */ }
    }
  } else if (mem.mode === 'gather') {
    const tg = mem.tg ? st.ents[mem.tg] : null
    if (!tg || tg.stock <= 0 || (sess.g && sess.g.id !== tg.id && sess.bagN >= BAG_CAP)) { mem.dt = 0; if (sess.g && sess.g.hold) out.cmd = { k: 'gather', entId: sess.g.id, phase: 'stop' } }
    else {
      const d = steer(tg.x, tg.y, 52000)
      if (d === 0) {
        if (!sess.g || sess.g.id !== tg.id || !sess.g.hold) out.cmd = { k: 'gather', entId: tg.id, phase: 'start' } // 重发无害（幂等）
        else if (sess.bagN >= BAG_CAP) out.cmd = { k: 'gather', entId: tg.id, phase: 'stop' }
      } else if (sess.g && sess.g.hold) out.cmd = { k: 'gather', entId: sess.g.id, phase: 'stop' }
    }
  }

  /* F1 卡死检测：有移动意图但连续 STUCK_TICKS 拍位移 <2px，且不在采集/倾倒/歇脚
     进度中 → 判卡，取垂直于当前意图的切向绕行航点（rng 定侧，同 seed 确定性） */
  const mv = Math.abs(av.x - (mem.lx == null ? av.x : mem.lx)) + Math.abs(av.y - (mem.ly == null ? av.y : mem.ly))
  mem.lx = av.x; mem.ly = av.y
  if ((out.mx || out.my) && !(sess.g && sess.g.hold) && sess.dumpT === 0 && mv < STUCK_MOVE) {
    if ((mem.stk || 0) + 1 >= STUCK_TICKS) {
      mem.stk = 0
      const ang = Math.atan2(out.my, out.mx) + (rng() < 0.5 ? 1 : -1) * Math.PI / 2
      mem.det = { x: av.x + Math.round(Math.cos(ang) * DETOUR_MPX), y: av.y + Math.round(Math.sin(ang) * DETOUR_MPX), t: DETOUR_TICKS }
    } else mem.stk = (mem.stk || 0) + 1
  } else mem.stk = 0
  return out
}

/* =====================================================================
 * emit(room, r) —— S2 二式快照组包下发（AOI 过滤+预算裁剪+自适应阈值，§5.1/§5.2）
 * 每连接视角：已知集 known（滞回出视野）+ snapSeq + 增量/全量切换
 * ===================================================================== */
const connState = new WeakMap() // connCtx → {known:Set, seq, sinceFull, lastFullBytes, base, force}

function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { known: new Set(), seq: 0, sinceFull: 0, lastFullBytes: 0, base: 0, force: true }; connState.set(ctx, b) }
  return b
}

/** 单连接组包下发（emit 每 tick 调用；onSync 立即调用力全量） */
function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  let cx = st.map.deposit.x, cy = st.map.deposit.y
  let own = null
  if (ctxRec.seat >= 0) {
    own = st.ents['p' + ctxRec.seat]
    if (own) { cx = own.x; cy = own.y } else { ctxRec.seat = -1 }
  }
  /* AOI 圆 + 滞回出视野（入 300 / 出 315） */
  const cand = []
  for (const id in st.ents) {
    const e = st.ents[id]
    const d2 = dist2(cx, cy, e.x, e.y)
    if (d2 <= AOI_R * AOI_R || (b.known.has(id) && d2 <= AOI_OUT * AOI_OUT)) cand.push({ e, d2 })
  }
  /* 预算 40 分层裁剪：玩家>资源>NPC，同层远者先裁（wisp 最先） */
  if (cand.length > AOI_BUDGET) {
    cand.sort((a, c) => (KIND_PRI[a.e.k] - KIND_PRI[c.e.k]) || (c.d2 - a.d2))
    cand.length = AOI_BUDGET
  }
  const keep = new Set(cand.map((c) => c.e.id))
  const leave = []
  for (const id of b.known) if (!keep.has(id)) leave.push(id)
  const enter = cand.filter((c) => !b.known.has(c.e.id)).map((c) => c.e.id)

  /* 脏实体 ∩ 视野 → 增量集（自身实体恒在首位，§5.2） */
  const dirtySet = r ? r.dirty : null
  const sendIds = new Set(enter)
  if (dirtySet) for (const id of dirtySet) if (keep.has(id)) sendIds.add(id)
  if (own && keep.has(own.id)) sendIds.add(own.id)

  let full = opt.force || b.force || b.sinceFull >= FULL_EVERY || sendIds.size > FULL_DIRTY
  b.force = false

  const rec = (id) => st.ents[id]
  const entsArr = []
  if (own && keep.has(own.id)) entsArr.push(rec(own.id))
  if (full) {
    for (const c of cand) if (c.e !== own) entsArr.push(c.e)
  } else {
    /* F5（GAMES-54）：旁观连接 own=null——增量分支曾裸读 own.id 抛
       "Cannot read properties of null" 崩整镇（满员旁观=生产崩溃路径） */
    for (const id of sendIds) if (!own || id !== own.id) entsArr.push(rec(id))
  }

  const seat = ctxRec.seat
  const sess = seat >= 0 ? st.sessions[seat] : null
  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base,
    full: full ? 1 : 0, snapSeq: b.seq + 1, // F3：先探账后落账——退化弃帧不再消耗序号（seq 严格 +1）
    ext: {
      aoi: { x: cx, y: cy, r: AOI_R }, ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
      // 镇面板/本人会话随流下发（HUD 事实源，防 welcome 后漂移；协议 §6 ext 向后兼容自由键）
      t: { e: st.town.exp, l: st.town.level, d: st.town.day, dt: st.town.dayTick, ph: st.town.phase, sc: st.town.sc || 0 },
      me: sess ? { c: sess.contrib, t: sess.total, b: sess.bag, n: sess.bagN, g: sess.goalMet ? 1 : 0 } : undefined,
    },
    ents: entsArr, leave: full ? [] : leave,
  }
  if (r && r.events && r.events.length) msg.events = r.events
  const text = JSON.stringify(msg)
  /* 增量字节 > 上次全量 ×0.7 → 退全量（流星雨全场跑动的最坏情形，§5.1）；
     F3：探账用 seq=b.seq+1 但未落账——此弃帧路径不再消耗序号（账本 seq+2 跳根除） */
  if (!full && b.lastFullBytes && text.length > b.lastFullBytes * 0.7) {
    return emitOne(room, { ...ctxRec, seat }, r, { force: true })
  }
  b.seq++
  if (full) { b.lastFullBytes = text.length; b.base = st.tick; b.sinceFull = 0 } else b.sinceFull++
  b.known = keep
  if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}

function emit(room, r) {
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, r)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, r)
}

/* ---------- sync 请求（全量路径，§5.4） ---------- */
function onSync(room, ctx) {
  let seat = -1
  const s = room.seats.find((x) => x.conn === ctx)
  if (s) seat = s.seat
  emitOne(room, { ctx, seat }, null, { force: true })
}

/* =====================================================================
 * 镇存档（§5.6）：60s 节拍+镇日结算+persist 钩子（dispose/shutdown）；
 * 原子写（tmp+rename）；测试房隔离不落盘
 * ===================================================================== */
function persist(room) {
  const st = room.state
  if (st.testRoom) return
  try {
    const top = Object.values(st.sessions)
      .map((s) => ({ name: (room.seats[s.seat] && room.seats[s.seat].name) || ('居民' + s.seat), total: s.total }))
      .sort((a, b) => b.total - a.total).slice(0, 10)
    const data = { v: 1, savedAt: Date.now(), town: { level: st.town.level, exp: st.town.exp, day: st.town.day }, buildings: st.buildings.map((b) => ({ slot: b.slot, built: b.built, by: b.by })), top }
    mkdirSync(dirname(SAVE_FILE), { recursive: true })
    const tmp = SAVE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, SAVE_FILE)
  } catch { /* 存档失败不拖垮镇 */ }
}
function loadSave() {
  try { return JSON.parse(readFileSync(SAVE_FILE, 'utf8')) } catch { return null }
}

/* ---------- 席位激活钩子（BotHost 常驻镇人口调节后广播名册用；化身由 step 自愈） ---------- */
function seatActive() { /* no-op：席位真值在 room.seats，step 每 tick 扫描对齐 */ }

/* =====================================================================
 * 适配器出口（rooms.js 注册表形状 + S2 扩展 emit/onSync/persist/population）
 * ===================================================================== */
export const mmoTownshipSim = {
  META: {
    gameId: 'mmo-township', title: '星海小镇', mode: 'persistent-town',
    seats: 12, tickMs: TICK_MS, cmdInput: true,
    persistent: true,   // 常驻镇：rooms 跳过 abandon/maxTicks 终局（回收走 idle/重启，§1.1）
    takeOver: 'balanced', // 断线逾时化身继续当勤恳居民（§5.4）
  },
  LEVELS: ['casual', 'balanced', 'competitive'],
  url: '/games/multiplayer/mmo-township/index.html',
  create,
  step,
  brain,
  emit,
  onSync,
  persist,
  seatActive,
  population: (st) => POP_BASE + (st.town.level || 1) - 1, // 镇人口目标（§4.1）
  fnv1a32,
  mulberry32,
}
