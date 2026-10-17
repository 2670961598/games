/* =====================================================================
 * 派对大乱斗 party-brawl 单源 sim（GAMES-172 · E6/W2/T7 单链 2/10）——
 * S7 预测和解第二证（多实体预测边界四类谱）+ S6 海量实体底盘（20 实体房+圈即 AOI）。
 * 设计事实源：docs/designs/party-brawl.md（GAMES-171 评审合并版）。
 *
 * 四类谱落地（设计 §5.2 ★）：
 *   一类·预测  己席 avatar——本地输入预测+ack 和解回滚重放（makePredictor，卡丁范式）；
 *   二类·重演  子弹/火箭/手雷——shot/nade 事件携含散布全参（iron fire 先例）→ 弹道=
 *              fire 参数的纯函数，「预测其飞行、权威其命中」（弹体零快照，§5.4 新面①）；
 *   三类·权威  拾取箱/掉落/空投——服务器裁决（同 tick 竞争 box id 升序×seat 升序固定对序）；
 *   四类·闭式  毒圈——相位表+圈心链随 ext.storm 同源下发，r(t)=时间纯函数（Q16 lerp）。
 *
 * 卡丁范式整链搬运（speed-kart §5.1）：input 环形缓冲/ack 锚定裁剪/回滚重放未确认/
 * seqInput（input.frame=seq）/carried 宽限兜底记账/inLog 输入日志（A6 回放）。
 * deep 底盘搬运（deep-foodchain §5.2）：二式快照+snapSeq/300 张强制全量/AOI 15px 滞回/
 * per-connection 个性化/空间哈希 cell 96px/退化阈值（适配器 emit）。
 *
 * 确定性纪律（§2.1）：sim 判定路径零 Math.*（isqrt 二分+TRIG16 烘焙表）；散布
 * rng=mulberry32(seed ^ seat<<16 ^ shotSeq) 逐发确定性——散布不是随机性是确定函数。
 * 玩家互不碰撞（io 惯例第三作，附决策 3）——预测域只剩走位积分，无耦合项。
 * ===================================================================== */
/* UMD（Node .cjs / 浏览器 window.PartySim——单源两端，§5.1 纪律） */
;(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null, root)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PartySim = api
})(typeof self !== 'undefined' ? self : this, function (require, root) {
'use strict'
const T16 = require ? require('./trig16.cjs') : root.PoolTrig
const TRIG16 = T16.TRIG16, ATAN8 = T16.ATAN8

/* ---------- 整数助手（零 Math.* 纪律） ---------- */
function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
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
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
function isqrtM(n) { // 整数开方（二分 30 轮，pool §2.2 纪律）；milli 域调用方自理量纲
  if (n <= 0) return 0
  let lo = 0, hi = 0x10000000
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) >> 1; if (mid <= n / mid) lo = mid; else hi = mid }
  return lo
}
function cosQ16(a) { a = (a >> 3) & 8191; const i = a & 2047; switch (a >> 11) { case 0: return TRIG16[2048 - i]; case 1: return -TRIG16[i]; case 2: return -TRIG16[2048 - i]; default: return TRIG16[i] } }
function sinQ16(a) { a = (a >> 3) & 8191; const i = a & 2047; switch (a >> 11) { case 0: return TRIG16[i]; case 1: return TRIG16[2048 - i]; case 2: return -TRIG16[i]; default: return -TRIG16[2048 - i] } }
function atan2Q(dx, dy) { // uint16 brads
  const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy
  let q
  if (ax >= ay) q = ATAN8[clampI(((ay << 11) / ax) | 0, 0, 2048)]
  else q = 2048 - ATAN8[clampI(((ax << 11) / ay) | 0, 0, 2048)]
  if (dx >= 0 && dy >= 0) return q << 3
  if (dx < 0 && dy >= 0) return (4096 - q) << 3
  if (dx < 0 && dy < 0) return (4096 + q) << 3
  return (8192 - q) << 3
}
const angDiff = (a, b) => { let d = (a - b) & 0xffff; if (d > 32768) d -= 65536; return d }
function segDist2(px, py, ax, ay, bx, by) { // 点到线段距离²（milli 域，扫掠判定 §2.4）
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  if (t < 0) t = 0; else if (t > 1) t = 1
  const cx = ax + dx * t - px, cy = ay + dy * t - py
  return cx * cx + cy * cy
}

/* ---------- 数值表（设计 §2 全量纲——DEV 直接抄 sim） ---------- */
const TICK_MS = 50
const SEATS = 20
const MAX_TICKS = 9600
const W = 2400000, H = 2400000 // 2400px 糖豆岛（milli）
const V0 = 7500                 // 基础移速 150px/s（milli/tick）
const LOAD_V = 300              // 每点负重 −6px/s（§2.3）
const RAMP = 21583              // 速度斜坡 33%/拍（Q16）
const FIRE_MUL = 60294          // 开火 ×0.92（Q16 腰射迟滞）
const BOOST_MUL = 81920         // 加速药 ×1.25（Q16）
const BOOST_T = 120             // 加速 6s
const HEAL_T = 16               // 医疗引导 800ms
const HEAL_V = 40               // +40 HP
const SPD_GCD = 200             // 加速 GCD
const PICK_R = 28000            // 拾取吸附 28px
const SPAWN_PROT = 30           // 出生保护 1.5s
const AFK_TICKS = 600           // 30s 无输入 → casual 托管（§4.3）
const PROJ_CAP = 64             // 弹体瞬态硬顶
const BOX_CAP = 100             // 箱实体硬顶
const R_BASE = 12000            // 命中半径基线 12px

/* 武器表（§2.4 六武器全量纲；cd/reload=tick；v=milli/tick） */
const WPNS = [
  { id: 0, name: '拳', dmg: 10, cd: 10, v: 0, mag: 0, rel: 0, spr: 4608, load: 0, melee: 26000, knock: 300 }, // 扇±35°近战 26px
  { id: 1, name: '手枪', dmg: 14, cd: 8, v: 21000, mag: 12, rel: 24, spr: 132, load: 2 },   // ±1°
  { id: 2, name: '冲锋', dmg: 8, cd: 3, v: 19000, mag: 30, rel: 30, spr: 393, load: 3 },    // ±3°+连发 bloom
  { id: 3, name: '霰弹', dmg: 5, cd: 22, v: 17000, mag: 6, rel: 40, spr: 1179, load: 4, pel: 8 }, // 扇±9° 8 弹
  { id: 4, name: '火箭', dmg: 55, cd: 30, v: 13000, mag: 3, rel: 48, spr: 66, load: 5, rocket: 1 }, // ±0.5°
  { id: 5, name: '手雷', dmg: 70, cd: 16, v: 12000, mag: 0, rel: 0, spr: 262, load: 1, nade: 1 }, // ±2°
]
const BLOOM = 79        // 冲锋连发 0.6°/发（brads）
const BLOOM_CAP = 393   // cap +3°
const BLOOM_DECAY = 6   // 停火 0.3s 衰减
const RANGE_PX = 600000 // 射程 600px
const NADE_FLY = 15, NADE_IDLE = 9, NADE_RANGE = 180000 // §2.5：飞 15 tick 至 180px 落点
const FALLOFF_SG = [[120000, 8], [240000, 6], [360000, 5], [480000, 4], [Infinity, 0]] // 霰弹距离衰减
const SPLASH_RK = [[15000, 46], [30000, 30], [46000, 14], [Infinity, 0]]               // 火箭溅射档
const NADE_R = [[20000, 70], [40000, 50], [60000, 30], [Infinity, 0]]                  // 手雷档表
const SG_SELF = 0.3    // 火箭自伤 30%

/* 缩圈相位表（§1.2——闭式解的根，四类谱第四类）；t0/t1=tick，r=milli */
const PHASES = [
  { p: 'P0', t0: 0, t1: 1200, r0: 1200000, r1: 1200000, dps: 2, move: 0 },
  { p: 'S1', t0: 1200, t1: 2700, r0: 1200000, r1: 700000, dps: 4, move: 1 },
  { p: 'H1', t0: 2700, t1: 3000, r0: 700000, r1: 700000, dps: 4, move: 0 },
  { p: 'S2', t0: 3000, t1: 4800, r0: 700000, r1: 380000, dps: 8, move: 1 },
  { p: 'H2', t0: 4800, t1: 5100, r0: 380000, r1: 380000, dps: 8, move: 0 },
  { p: 'S3', t0: 5100, t1: 6900, r0: 380000, r1: 170000, dps: 12, move: 1 },
  { p: 'H3', t0: 6900, t1: 7200, r0: 170000, r1: 170000, dps: 12, move: 0 },
  { p: 'S4', t0: 7200, t1: 8400, r0: 170000, r1: 90000, dps: 16, move: 1 },
  { p: 'F', t0: 8400, t1: 9600, r0: 90000, r1: 90000, dps: 16, move: 0, esc: 200, escD: 2 }, // 兜底递增
]
/* 毒伤烘焙表（每 10 tick 一拍=DPS÷2，§1.2） */
const DOT = [1, 2, 2, 4, 4, 6, 6, 8, 8]

/* META（S6+S7 双技术第三款，附决策 1） */
const META = {
  gameId: 'party-brawl', title: '派对大乱斗', seats: SEATS, tickMs: TICK_MS, maxTicks: MAX_TICKS,
  mode: 'mini-royale', teams: { A: [0], B: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] },
  takeOver: 'casual', tech: 'S6+S7', seqInput: true, // S7：input.frame=seq（ack 锚点，§5.1）
  roomPrefix: 'party', // feed 字典序 party- 落 net- 与 pool- 之间（§5.8）
  pulseRank: 5,        // 放水链：终局按 rank 记真人 pulse（rank≤5=胜断败；≥15 连败++，§4.4）
  W: 375, H: 667,
}

/* =====================================================================
 * 毒圈闭式解（四类谱第四类——参数与 sim 同源，客户端任意未来 tick 圆=时间纯函数）
 * centers=[每相位终圈心]（create 时由 seed 派生整链算好——确定性双跑根）
 * ===================================================================== */
function buildCenters(seed) {
  const centers = [{ x: W >> 1, y: H >> 1 }]
  for (let i = 0; i < PHASES.length; i++) {
    const ph = PHASES[i]
    if (!ph.move) { centers.push({ ...centers[i] }); continue }
    const rng = mulberry32(((seed >>> 0) ^ Math.imul(i + 13, 0x27d4eb2f)) >>> 0)
    const maxD = ((ph.r0 - ph.r1) * 6 / 10) | 0          // |δ|≤(r_prev−r_new)×0.6 内切保证（§1.2）
    const mag = Math.trunc(rng() * maxD)
    const ang = Math.trunc(rng() * 65536)
    centers.push({
      x: clampI(centers[i].x + Math.trunc(cosQ16(ang) / 65536 * mag), ph.r1, W - ph.r1),
      y: clampI(centers[i].y + Math.trunc(sinQ16(ang) / 65536 * mag), ph.r1, H - ph.r1),
    })
  }
  return centers
}
/** 任意 tick 圆（闭式；整数向零取整纪律 §1.2——(t−t0)×(r1−r0)÷(t1−t0) 先除后乘：
 * Q16 系数直接乘 (r1−r0) 会越 int32 回绕（r1−r0=−50万×65536=−327亿——首版实踩） */
function stormOf(st, t) {
  let i = PHASES.length - 1
  for (let k = 0; k < PHASES.length; k++) if (t < PHASES[k].t1) { i = k; break }
  const ph = PHASES[i]
  const span = ph.t1 - ph.t0 || 1
  const fr = Math.trunc((ph.r1 - ph.r0) * (t - ph.t0) / span) // |(t−t0)×(r1−r0)|<2^53 除后取整
  const r = clampI(t <= ph.t0 ? ph.r0 : t >= ph.t1 ? ph.r1 : ph.r0 + fr, Math.min(ph.r0, ph.r1), Math.max(ph.r0, ph.r1))
  const c0 = st.storm.centers[i], c1 = st.storm.centers[i + 1]
  const cx = c0.x + Math.trunc((c1.x - c0.x) * (t - ph.t0) / span)
  const cy = c0.y + Math.trunc((c1.y - c0.y) * (t - ph.t0) / span)
  let dps = ph.dps
  if (ph.esc) dps = ph.dps + (Math.trunc((t - ph.t0) / ph.esc) * ph.escD)  // F 相位 200 tick +2 递增
  return { i, r, cx, cy, dps }
}
const dotOf = (i) => DOT[i]

/* =====================================================================
 * create(seed, opts) —— 世界布局（出生环 20 点+开局 40 箱+圈心链，§2.1/§1.4）
 * ===================================================================== */
function create(seed, opts = {}) {
  seed = seed >>> 0
  const rng = mulberry32(seed)
  /* 出生环 r∈[500,1050]px 两两 ≥180px（20 点 seed 派生） */
  const spawns = []
  for (let tries = 0; spawns.length < SEATS && tries < 400; tries++) {
    const ang = Math.trunc(rng() * 65536)
    const rad = 500000 + Math.trunc(rng() * 550000)
    const x = (W >> 1) + ((cosQ16(ang) * rad) >> 16)
    const y = (H >> 1) + ((sinQ16(ang) * rad) >> 16)
    let ok = true
    for (const s of spawns) { const dx = s.x - x, dy = s.y - y; if (dx * dx + dy * dy < 180000 * 180000) { ok = false; break } }
    if (ok) spawns.push({ x, y })
  }
  while (spawns.length < SEATS) spawns.push({ x: 300000 + spawns.length * 90000, y: 300000 + spawns.length * 90000 })
  const players = []
  for (let i = 0; i < SEATS; i++) {
    players.push({
      seat: i, name: 'P' + (i + 1), x: spawns[i].x, y: spawns[i].y, a: atan2Q((W >> 1) - spawns[i].x, (H >> 1) - spawns[i].y),
      vx: 0, vy: 0, hp: 100, sh: 0, w: 0, mag: 0, ammo: 0, nades: 0, meds: 0, spd: 0,
      cd: 0, rel: 0, bloom: 0, boost: 0, gcd: 0, heal: 0, aim: 0, prot: SPAWN_PROT,
      alive: 1, rank: 0, kills: 0, dmg: 0, shotSeq: 0, hurtBy: -1, hurtAt: -9999,
      mem: { dt: 0, mx: 0, my: 0, aim: 0, fire: 0, wp: null },
    })
  }
  /* 开局箱（§1.4 供给核算：武器 24+道具 16=40；内容 seed 派生） */
  const boxes = {}
  let boxSeq = 0
  const addBox = (k, x, y, payload) => { const id = 'b' + (boxSeq++); boxes[id] = Object.assign({ id, k, x, y, on: 1 }, payload) }
  const wpnPlan = [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 5] // 手枪×8/冲锋×6/霰弹×5/火箭×3/手雷×2
  const itPlan = ['med', 'med', 'med', 'med', 'med', 'med', 'bat', 'bat', 'bat', 'bat', 'bat', 'bat', 'spd', 'spd', 'spd', 'spd']
  const scatter = (minR) => { // 岛内散布（初始圈内）
    const ang = Math.trunc(rng() * 65536), rad = minR + Math.trunc(rng() * (1100000 - minR))
    return { x: clampI((W >> 1) + ((cosQ16(ang) * rad) >> 16), 60000, W - 60000), y: clampI((H >> 1) + ((sinQ16(ang) * rad) >> 16), 60000, H - 60000) }
  }
  for (const w of wpnPlan) { const p = scatter(0); addBox(w === 5 ? 'nade' : 'wpn', p.x, p.y, { w, ammo: w === 5 ? 2 : WPNS[w].mag }) }
  for (const it of itPlan) { const p = scatter(0); addBox('itm', p.x, p.y, { it }) }
  return {
    v: 1, gameId: 'party-brawl', seed, tick: 0,
    testRoom: !!opts.test, maxTicks: opts.maxTicks != null ? opts.maxTicks : MAX_TICKS,
    map: { w: W, h: H }, spawns,
    storm: { ph: 0, centers: buildCenters(seed) },
    players, boxes, projs: [], nades: [],
    boxSeq, projSeq: 0, nextRank: SEATS, alive: SEATS,
    airdropAt: 4800, airdropDone: 0,
    stats: { carried: 0, elim: 0, storm: 0, shots: 0 },
    ledgers: { storm: new Array(SEATS).fill(0), elim: [], stormDots: new Array(SEATS).fill(0) },
    inCur: [], inLog: [], afk: [],
    auto: opts.autopilot === true ? 0 : -1,
    lb: [],
  }
}

/* =====================================================================
 * 输入面（§5.1 双 frame 语义分域）：持续键（mx/my/aim/fire）q 推进即应用；
 * 离散键（skl/pick）随 q 捕获为一次性动作槽，step 消费后清零（宽限沿用不重放）。
 * ===================================================================== */
function seatInput(st, seat, inp) {
  const cur = st.inCur[seat]
  if (inp && typeof inp.q === 'number' && Number.isFinite(inp.q)) {
    const q = inp.q | 0
    if (q > cur.q) {
      const nx = {
        q,
        mx: clampI(inp.mx | 0, -100, 100), my: clampI(inp.my | 0, -100, 100),
        aim: inp.aim === undefined ? cur.aim : (inp.aim & 0xffff),
        fire: inp.fire ? 1 : 0,
        skl: inp.skl ? (inp.skl | 0) : 0,   // 一次性：随 q 捕获
        pick: inp.pick !== undefined && inp.pick !== null ? (inp.pick | 0) : -1,
      }
      st.inCur[seat] = nx
      st.inLog.push([st.tick, seat, nx.mx, nx.my, nx.aim, nx.fire, nx.skl, nx.pick])
    }
    return st.inCur[seat]
  }
  if (inp && (inp.mx !== undefined || inp.aim !== undefined || inp.fire !== undefined || inp.skl || inp.pick !== undefined)) { // bot/托管完整形
    const b = st.inCur[seat]
    const nx = {
      q: b.q,
      mx: clampI(inp.mx | 0, -100, 100), my: clampI(inp.my | 0, -100, 100),
      aim: inp.aim === undefined ? b.aim : (inp.aim & 0xffff),
      fire: inp.fire ? 1 : 0,
      skl: inp.skl ? (inp.skl | 0) : 0, pick: inp.pick !== undefined && inp.pick !== null ? (inp.pick | 0) : -1,
    }
    if (nx.mx !== b.mx || nx.my !== b.my || nx.aim !== b.aim || nx.fire !== b.fire || nx.skl || nx.pick >= 0)
      st.inLog.push([st.tick, seat, nx.mx, nx.my, nx.aim, nx.fire, nx.skl, nx.pick])
    st.inCur[seat] = nx
  }
  return st.inCur[seat]
}

/* ---------- 伤害管线（§2.4：dmg→shield 优先吸收→HP；毒/自伤/溢出同管线） ---------- */
function applyDmg(st, p, dmg, by, events) {
  if (!p.alive || p.prot > 0) return
  let d = dmg
  if (p.sh > 0) { const a = Math.min(p.sh, d); p.sh -= a; d -= a }
  p.hp -= d
  if (by >= 0 && by !== p.seat && st.players[by]) {
    st.players[by].dmg += dmg
    p.hurtBy = by; p.hurtAt = st.tick
  }
  events.push({ k: 'hit', seat: p.seat, by: by >= 0 ? by : -1, dmg, hp: p.hp, sh: p.sh })
}

/* ---------- 拾取裁决（三类·权威；§2.7 ④ box id 升序×seat 升序固定对序） ---------- */
function tryPick(st, p, boxId, events, dirty) {
  const b = st.boxes[boxId]
  if (!b || !b.on) return false
  const dx = b.x - p.x, dy = b.y - p.y
  if (dx * dx + dy * dy > PICK_R * PICK_R) return false
  b.on = 0
  dirty.add(boxId)
  if (b.k === 'wpn' || b.k === 'nade') {
    if (b.k === 'nade') p.nades = Math.min(2, p.nades + b.ammo)
    else if (p.w === b.w) p.ammo += b.ammo                     // 同武器合并备弹（弹药经济回廊）
    else { p.w = b.w; p.mag = WPNS[b.w].mag; p.ammo = b.ammo; p.rel = 0 }
  } else if (b.it === 'med') p.meds = Math.min(2, p.meds + 1)
  else if (b.it === 'bat') p.sh = Math.min(60, p.sh + 30)
  else if (b.it === 'spd') p.spd = Math.min(1, p.spd + 1)
  events.push({ k: 'pick', seat: p.seat, id: boxId, k2: b.k, w: b.w, it: b.it })
  return true
}

/* ---------- 开火（§2.7 ⑤：cd/弹匣/装填状态机→弹体生成【含散布 rng】→shot 全参事件） ---------- */
function fireWpn(st, p, events) {
  const wp = WPNS[p.w]
  if (p.cd > 0 || p.rel > 0) return
  if (wp.nade) { // 手雷走 skl（携带 ≤2），fire 不触发
    return
  }
  if (wp.melee) { // 拳：扇 ±35°程 26px 即时判定+击退 300mpx
    p.cd = wp.cd
    events.push({ k: 'swing', seat: p.seat, ang: p.aim })
    for (const o of st.players) {
      if (o.seat === p.seat || !o.alive) continue
      const dx = o.x - p.x, dy = o.y - p.y
      const d2 = dx * dx + dy * dy
      if (d2 > (wp.melee + R_BASE) * (wp.melee + R_BASE)) continue
      const da = Math.abs(angDiff(atan2Q(dx, dy), p.aim))
      if (da <= wp.spr) {
        applyDmg(st, o, wp.dmg, p.seat, events)
        o.x = clampI(o.x + ((cosQ16(p.aim) * wp.knock * 100) >> 16), 12000, W - 12000)
        o.y = clampI(o.y + ((sinQ16(p.aim) * wp.knock * 100) >> 16), 12000, H - 12000)
      }
    }
    return
  }
  if (p.mag <= 0) { // 空仓：自动装填（若备弹>0）；无备弹干击
    if (p.ammo > 0) { p.rel = wp.rel; events.push({ k: 'reload', seat: p.seat }) }
    else events.push({ k: 'dry', seat: p.seat })
    return
  }
  p.mag--
  p.cd = wp.cd
  if (p.w === 2) p.bloom = Math.min(BLOOM_CAP, p.bloom + BLOOM)
  const pel = wp.pel || 1
  for (let i = 0; i < pel; i++) {
    p.shotSeq++
    const srng = mulberry32(((st.seed ^ (p.seat << 16) ^ Math.imul(p.shotSeq, 0x9e3779b9)) >>> 0))
    const spr = (wp.spr + (p.w === 2 ? p.bloom : 0))
    const ang = (p.aim + Math.trunc((srng() * 2 - 1) * spr)) & 0xffff // 含散布全参（iron fire 先例）
    const pid = st.projSeq++
    const ttl = (RANGE_PX / wp.v) | 0
    /* 枪口出生（F-3）：弹体从自身外缘外 1px（R_BASE+4k）起跳——玩家互不碰撞（§1.2）
     * 下 bot 可重叠，中心出生=首拍扫掠段覆盖贴身敌必中即亡（124/130 寿命 Δ0 tick，
     * 射程/TTK 数值面全失效）；shot 事件携枪口点，客户端二类重演同参一致 */
    const mx0 = p.x + (((R_BASE + 4000) * cosQ16(ang)) >> 16)
    const my0 = p.y + (((R_BASE + 4000) * sinQ16(ang)) >> 16)
    st.projs.push({ pid, seat: p.seat, w: p.w, x: mx0, y: my0, ang, v: wp.v, dmg: wp.dmg, ttl, dist: 0 })
    events.push({ k: 'shot', seat: p.seat, w: p.w, ang, px: mx0, py: my0, pid })
    st.stats.shots++
  }
  if (p.mag === 0 && p.ammo > 0) { p.rel = wp.rel; events.push({ k: 'reload', seat: p.seat }) }
  if (st.projs.length > PROJ_CAP) { // 超限最旧消亡（护栏 §2.1）
    const drop = st.projs.splice(0, st.projs.length - PROJ_CAP)
    for (const d of drop) events.push({ k: 'pdie', pid: d.pid })
  }
}

/* ---------- 手雷投掷（§2.5：离散事件全参+引信 tick 计数——二类重演 showcase） ---------- */
function throwNade(st, p, events) {
  if (p.nades <= 0 || p.cd > 0) return
  p.nades--
  p.cd = WPNS[5].cd
  p.shotSeq++
  const srng = mulberry32(((st.seed ^ (p.seat << 16) ^ Math.imul(p.shotSeq, 0x9e3779b9)) >>> 0))
  const ang = (p.aim + Math.trunc((srng() * 2 - 1) * WPNS[5].spr)) & 0xffff
  const nid = 'n' + (st.projSeq++)
  st.nades.push({ id: nid, pid: st.projSeq - 1, seat: p.seat, x: p.x, y: p.y, x0: p.x, y0: p.y, ang, born: st.tick })
  events.push({ k: 'nade', seat: p.seat, ang, px: p.x, py: p.y, id: nid })
}
function nadePos(n, t) { // 纯函数：任意 tick 手雷位置（客户端重演同式）
  const dt = t - n.born
  if (dt <= 0) return { x: n.x0, y: n.y0 }
  const fx = n.x0 + ((cosQ16(n.ang) * NADE_RANGE * Math.min(dt, NADE_FLY) / NADE_FLY) | 0)
  const fy = n.y0 + ((sinQ16(n.ang) * NADE_RANGE * Math.min(dt, NADE_FLY) / NADE_FLY) | 0)
  return { x: fx, y: fy }
}
function explodeNade(st, n, events) {
  const pos = nadePos(n, n.born + NADE_FLY)
  const p0 = nadePos(n, st.tick)
  events.push({ k: 'boom', x: p0.x, y: p0.y, by: n.seat, r: 60000 })
  for (const o of st.players) {
    if (!o.alive) continue
    const dx = o.x - pos.x, dy = o.y - pos.y
    const d = isqrtM(dx * dx + dy * dy)
    for (const [rad, dmg] of NADE_R) if (d <= rad) {
      const self = o.seat === n.seat ? 70 : 100 // 自伤 30%（§2.4 同火箭）
      applyDmg(st, o, (dmg * self / 100) | 0, n.seat, events)
      break
    }
  }
}

/* ---------- 淘汰裁决（§2.7 ⑨：elim 事件+rank 逆推+掉落箱 T6-B 70% 回流） ---------- */
function eliminate(st, p, by, events) {
  p.alive = 0
  p.rank = st.nextRank--
  st.alive--
  const killer = by >= 0 ? st.players[by] : null
  if (killer && killer !== p) killer.kills++
  st.stats.elim++
  st.ledgers.elim.push({ seat: p.seat, by, rank: p.rank })
  /* 掉落箱：武器+70% 备弹+至多 2 件道具（§1.4 T6-B）——每淘汰必一箱（A7 对账：掉落箱数==淘汰数） */
  {
    const id = 'b' + (st.boxSeq++)
    st.boxes[id] = {
      id, k: 'drop', x: clampI(p.x, 60000, W - 60000), y: clampI(p.y, 60000, H - 60000), on: 1,
      w: p.w, ammo: ((p.ammo + p.mag) * 7 / 10) | 0, nades: p.nades, meds: Math.min(p.meds, 2), spd: p.spd ? 1 : 0,
    }
    events.push({ k: 'drop', seat: p.seat, box: id })
  }
  events.push({ k: 'elim', seat: p.seat, by, rank: p.rank })
}

/* =====================================================================
 * step —— tick 结算序（§2.7 红线不可换序）
 * ===================================================================== */
function step(st, inputs, room) {
  const events = []
  const dirty = new Set()
  const kinds = room ? room.seats.map((s) => s.kind) : null

  /* ① 输入采样（autopilot 席服务器节拍锁=A6 确定性双跑；AFK 30s→casual 托管 §4.3） */
  if (!st.inCur.length) for (let i = 0; i < SEATS; i++) st.inCur.push({ q: -1, mx: 0, my: 0, aim: 0, fire: 0, skl: 0, pick: -1 })
  if (!st.afk.length) for (let i = 0; i < SEATS; i++) st.afk.push(null)
  const inpArr = []
  for (let i = 0; i < SEATS; i++) {
    let raw = inputs ? inputs[i] : null
    if (st.auto === i) {
      raw = brainImpl(st, i, 'competitive', null, null)
      const rsk = raw.skl || 0, rpk = raw.pick !== undefined && raw.pick !== null ? raw.pick : -1
      st.inCur[i] = { q: st.tick, mx: raw.mx, my: raw.my, aim: raw.aim, fire: raw.fire, skl: rsk, pick: rpk }
      /* inLog 变才带（含 skl/pick 脉冲——拾取/技能的离散沿必须入账，A6 重放根） */
      if (raw.mx !== st._a0 || raw.my !== st._a1 || raw.aim !== st._a2 || raw.fire !== st._a3 || rsk !== (st._a4 || 0) || rpk !== (st._a5 === undefined ? -1 : st._a5)) {
        st.inLog.push([st.tick, i, raw.mx, raw.my, raw.aim, raw.fire, rsk, rpk])
        st._a0 = raw.mx; st._a1 = raw.my; st._a2 = raw.aim; st._a3 = raw.fire; st._a4 = rsk; st._a5 = rpk
      }
      inpArr.push(st.inCur[i]); st.afk[i] = null
      continue
    }
    const isHuman = !kinds || kinds[i] === 'human'
    if (isHuman && raw && typeof raw.q === 'number') {
      const sig = raw.mx + ':' + raw.my + ':' + raw.aim + ':' + raw.fire + ':' + raw.q
      if (st.afk[i] && st.afk[i].sig === sig) st.afk[i].t++
      else st.afk[i] = { sig, t: 0 }
      if (st.afk[i].t >= AFK_TICKS) raw = brainImpl(st, i, 'casual', mulberry32(((st.seed ^ Math.imul(i + 7, 0x85ebca6b)) >>> 0)), null)
    } else st.afk[i] = null
    inpArr.push(seatInput(st, i, raw))
  }
  /* carried 记账（§5.6）：本 tick 无新 q 消费的人类席拍数（宽限兜底=延迟在场证据） */
  if (!st._qp) st._qp = new Array(SEATS).fill(-1)
  for (let i = 0; i < SEATS; i++) {
    if (st.auto === i) continue
    if (!kinds || kinds[i] === 'human') {
      if (st.inCur[i].q === st._qp[i]) st.stats.carried++
      st._qp[i] = st.inCur[i].q
    }
  }

  /* ② 速度斜坡+位移积分（负载/开火/加速修正；医疗引导 ×0.5 §2.6） */
  for (const p of st.players) {
    if (!p.alive) continue
    const inp = inpArr[p.seat]
    p.aim = inp.aim
    const wp = WPNS[p.w]
    let vEff = V0 - wp.load * LOAD_V - p.nades * LOAD_V
    if (inp.fire) vEff = (vEff * FIRE_MUL) >> 16
    if (p.boost > 0) { vEff = (vEff * BOOST_MUL) >> 16; p.boost-- }
    if (p.heal > 0) vEff = (vEff >> 1)
    const mag = Math.min(100, Math.abs(inp.mx) + Math.abs(inp.my) ? isqrtM(inp.mx * inp.mx + inp.my * inp.my) : 0)
    const n = mag < 30 ? 0 : mag / 100 // 死区 <30% 静止（§3.1）
    let tx = 0, ty = 0
    if (n > 0 && (inp.mx || inp.my)) {
      const inv = n / (isqrtM(inp.mx * inp.mx + inp.my * inp.my) / 100)
      tx = (inp.mx * inv * vEff / 100) | 0
      ty = (inp.my * inv * vEff / 100) | 0
    }
    p.vx += ((tx - p.vx) * RAMP) >> 16   // 每拍逼近 33%（3 拍到满速，确定性斜坡）
    p.vy += ((ty - p.vy) * RAMP) >> 16
    /* ③ 边界 clamp（2400² 岛缘不死——死亡只来自命中与毒） */
    p.x = clampI(p.x + p.vx, 12000, W - 12000)
    p.y = clampI(p.y + p.vy, 12000, H - 12000)
    if (p.prot > 0) p.prot--
    if (p.cd > 0) p.cd--
    if (p.rel > 0 && --p.rel === 0) { const w2 = WPNS[p.w]; const take = Math.min(w2.mag, p.ammo); p.mag = take; p.ammo -= take }
    if (p.bloom > 0 && !inp.fire) p.bloom = Math.max(0, p.bloom - BLOOM_DECAY)
    if (p.gcd > 0) p.gcd--
    if (p.heal > 0 && --p.heal === 0) { p.hp = Math.min(100, p.hp + HEAL_V); events.push({ k: 'heal', seat: p.seat, v: HEAL_V }) }
    dirty.add('s' + p.seat)
  }

  /* ④ 拾取裁决（28px 吸附候选 box id 升序×seat 升序固定对序，同 tick 竞争先到先得） */
  for (let s = 0; s < SEATS; s++) {
    const p = st.players[s]
    if (!p.alive) continue
    const pick = inpArr[s].pick
    if (pick !== undefined && pick !== null && pick >= 0) tryPick(st, p, 'b' + pick, events, dirty)
    inpArr[s].pick = -1 // 一次性消费（宽限沿用不重放）
  }

  /* ⑤ 开火处理（skl 离散：手雷/医疗/加速——§1.5 技能钮） */
  for (let s = 0; s < SEATS; s++) {
    const p = st.players[s]
    if (!p.alive) continue
    const inp = inpArr[s]
    const skl = inp.skl
    inp.skl = 0 // 一次性消费
    if (skl === 1) { if (p.nades > 0) throwNade(st, p, events) }
    else if (skl === 2) { if (p.meds > 0 && p.hp < 100 && p.heal <= 0) { p.meds--; p.heal = HEAL_T; events.push({ k: 'healing', seat: p.seat }) } }
    else if (skl === 3) { if (p.spd > 0 && p.gcd <= 0) { p.spd--; p.boost = BOOST_T; p.gcd = SPD_GCD; events.push({ k: 'boost', seat: p.seat }) } }
    if (inp.fire && p.w !== 5) fireWpn(st, p, events)
  }

  /* ⑥ 弹体推进+命中裁决（扫掠、弹 id 升序 §2.7） */
  const survivors = []
  for (const pr of st.projs) {
    const nx = pr.x + ((pr.v * cosQ16(pr.ang)) >> 16)
    const ny = pr.y + ((pr.v * sinQ16(pr.ang)) >> 16)
    pr.dist += pr.v
    let hit = null
    for (const o of st.players) {
      if (!o.alive || o.seat === pr.seat) continue
      const rr = R_BASE + Math.floor(o.sh / 30) + 3000 // 弹体半径 3px 容差（§1.5）
      if (segDist2(o.x, o.y, pr.x, pr.y, nx, ny) < rr * rr) { hit = o; break }
    }
    pr.x = nx; pr.y = ny
    pr.ttl--
    if (hit) {
      if (pr.w === 4) { // 火箭：直击+溅射 r46 线性档（自伤 30%）
        applyDmg(st, hit, pr.dmg, pr.seat, events)
        events.push({ k: 'boom', x: nx, y: ny, by: pr.seat, r: 46000 })
        for (const o of st.players) {
          if (!o.alive || o === hit) continue
          const dx = o.x - nx, dy = o.y - ny
          const d = isqrtM(dx * dx + dy * dy)
          for (const [rad, dmg] of SPLASH_RK) if (d <= rad) {
            applyDmg(st, o, o.seat === pr.seat ? ((dmg * SG_SELF) | 0) : dmg, pr.seat, events)
            break
          }
        }
      } else if (pr.w === 3) { // 霰弹：距离衰减档表（档值=每弹伤害，§2.4 {≤120:8,…}/弹）
        for (const [rad, per] of FALLOFF_SG) if (pr.dist <= rad) { if (per > 0) applyDmg(st, hit, per, pr.seat, events); break }
      } else applyDmg(st, hit, pr.dmg, pr.seat, events)
      events.push({ k: 'pdie', pid: pr.pid })
      continue
    }
    if (pr.ttl <= 0) {
      if (pr.w === 4) { // 火箭 TTL 尽爆
        events.push({ k: 'boom', x: nx, y: ny, by: pr.seat, r: 46000 })
        for (const o of st.players) {
          if (!o.alive) continue
          const dx = o.x - nx, dy = o.y - ny
          const d = isqrtM(dx * dx + dy * dy)
          for (const [rad, dmg] of SPLASH_RK) if (d <= rad) {
            applyDmg(st, o, o.seat === pr.seat ? ((dmg * SG_SELF) | 0) : dmg, pr.seat, events)
            break
          }
        }
      }
      events.push({ k: 'pdie', pid: pr.pid })
      continue
    }
    survivors.push(pr)
  }
  st.projs = survivors

  /* ⑦ 手雷引信/爆炸裁决（§2.5：飞 15+静置 9=24 tick 定时爆） */
  const nAlive = []
  for (const n of st.nades) {
    const dt = st.tick - n.born
    if (dt >= NADE_FLY + NADE_IDLE) { explodeNade(st, n, events) } else nAlive.push(n)
  }
  st.nades = nAlive

  /* ⑧ 毒圈结算（每 10 tick 一拍烘焙表；出生保护免毒 §2.2） */
  if (st.tick % 10 === 0 && st.tick > 0) {
    const c = stormOf(st, st.tick)
    for (const p of st.players) {
      if (!p.alive || p.prot > 0) continue
      const dx = p.x - c.cx, dy = p.y - c.cy
      if (dx * dx + dy * dy > c.r * c.r) {
        const d = Math.max(dotOf(c.i), (c.dps / 2) | 0) // F 相位递增 dps 的烘焙对拍（§1.2）
        applyDmg(st, p, d, -1, events)
        st.ledgers.storm[p.seat] += d
        st.ledgers.stormDots[p.seat]++
      }
    }
  }

  /* ⑨ 淘汰裁决（HP≤0→elim+rank+掉落；by=120 tick 内最近伤害源） */
  for (const p of st.players)
    if (p.alive && p.hp <= 0) eliminate(st, p, (p.hurtBy >= 0 && st.tick - p.hurtAt < 120 ? p.hurtBy : -1), events)

  /* ⑩ 缩圈相位推进（相位表查表+圈心链；切换→storm 事件 §5.4 变才带） */
  if (st.storm.ph < PHASES.length - 1 && st.tick >= PHASES[st.storm.ph].t1) {
    st.storm.ph++
    const ph = PHASES[st.storm.ph]
    const c0 = st.storm.centers[st.storm.ph], c1 = st.storm.centers[st.storm.ph + 1]
    events.push({ k: 'storm', p: st.storm.ph, t0: ph.t0, t1: ph.t1, r0: ph.r0, r1: ph.r1, x0: c0.x, y0: c0.y, x1: c1.x, y1: c1.y, dps: ph.dps })
    st.stats.storm++
  }
  /* 空投（H2 起点=4800，§1.4） */
  if (!st.airdropDone && st.tick >= st.airdropAt) {
    st.airdropDone = 1
    const rng = mulberry32(((st.seed ^ 0x5eed) >>> 0))
    const ph3 = PHASES[5] // H2 圈内落点
    const ang = Math.trunc(rng() * 65536)
    const ax = clampI(st.storm.centers[6].x + ((cosQ16(ang) * (ph3.r1 >> 2)) >> 16), 60000, W - 60000)
    const ay = clampI(st.storm.centers[6].y + ((sinQ16(ang) * (ph3.r1 >> 2)) >> 16), 60000, H - 60000)
    const mk = (k, dx, dy, payload) => { const id = 'b' + (st.boxSeq++); st.boxes[id] = Object.assign({ id, k, x: ax + dx, y: ay + dy, on: 1 }, payload); events.push({ k: 'airdrop', x: ax, y: ay, box: id }) }
    mk('wpn', 0, 0, { w: 4, ammo: 3 })
    mk('itm', 15000, 0, { it: 'med' })
    mk('itm', -15000, 0, { it: 'med' })
    mk('itm', 0, 15000, { it: 'bat' })
  }

  /* ⑪ 排行榜（存活者 (kills,dmg) 排序，10 tick 节流在 emit ext.lb） */
  st.lb = st.players.filter((p) => p.alive).sort((a, b) => b.kills - a.kills || b.dmg - a.dmg || a.seat - b.seat).slice(0, 10)
    .map((p) => [p.seat, p.kills, p.dmg])
  st.mm = st.players.filter((p) => p.alive).map((p) => [p.seat, (p.x / 1000) | 0, (p.y / 1000) | 0])

  /* ⑫ 终局（§1.3：last-standing/timeout；(存活,HP,kills) 排名定格） */
  let over = null
  if (st.alive <= 1 || st.tick >= st.maxTicks) {
    const reason = st.alive <= 1 ? 'last-standing' : 'timeout'
    const rest = st.players.filter((p) => p.alive).sort((a, b) => b.hp - a.hp || b.kills - a.kills || a.seat - b.seat)
    let r = 1
    for (const p of rest) if (!p.rank) p.rank = r++
    const scores = {}
    let rank1 = -1
    for (const p of st.players) { scores[p.seat] = { rank: p.rank, kills: p.kills, dmg: p.dmg }; if (p.rank === 1) rank1 = p.seat }
    over = { winner: rank1 === 0 ? 'A' : 'B', reason, scores, teams: META.teams }
  }

  st.tick++
  return { events, dirty, over: !!over, result: over }
}

/* =====================================================================
 * Bot 三档（§4 缩圈决策树——Z0 圈预算根键控，royale Bot 新领域配方）
 * 同一棵树，三档人格改写分支阈值（不混轴）：casual 拖到毒边（0.95）+drift 游走+
 * 仅反击；balanced 0.8+机会交战；competitive 0.7+主动 HUNT+lead 预判。
 * rng=mulberry32(fnv1a32(roomId)^seat<<16^tick>>4)（§4）；决策拍 <2ms（闭式解纪律）。
 * ===================================================================== */
const BOT_EVERY = { casual: 30, balanced: 12, competitive: 8 }
const PERSONA = {
  casual:      { safe: 0.95, drift: 18, aimErr: 492, healAt: 50, healForget: 0.4, hunt: 0, wPref: 0 },
  balanced:    { safe: 0.8, drift: 0, aimErr: 205, healAt: 50, healForget: 0, hunt: 1, wPref: 1 },
  competitive: { safe: 0.7, drift: 0, aimErr: 82, healAt: 70, healForget: 0, hunt: 2, wPref: 2 },
}
const MERCY_DFT = { minFoeLose: 2, hardFoeLose: 4 }
function brainImpl(st, seat, level, rng, env) {
  const p = st.players[seat]
  if (!p || !p.alive) return { mx: 0, my: 0, aim: p ? p.aim : 0, fire: 0 }
  const per = (env && env.persona && env.persona[level]) || PERSONA[level] || PERSONA.balanced
  const mercy = (env && env.mercy) || MERCY_DFT
  const kinds = env && env.kinds
  const foeLose = env && env.foeLose ? (env.foeLose[seat] || 0) : 0
  const out = { mx: 0, my: 0, aim: p.aim, fire: 0, skl: 0, pick: -1 }
  const mem = p.mem
  const aimErr = foeLose >= mercy.minFoeLose ? per.aimErr * 2 : per.aimErr // 连败让力：误差×1.8~2（§4.4）

  if (mem.dt <= 0) {
    mem.dt = BOT_EVERY[level] || 12
    const c = stormOf(st, st.tick)
    const dx = p.x - c.cx, dy = p.y - c.cy
    const dEdge = isqrtM(dx * dx + dy * dy) - c.r
    const vEff = Math.max(3000, V0 - WPNS[p.w].load * LOAD_V)
    const tNeed = ((dEdge + 40000) / vEff) | 0
    const tLeft = PHASES[c.i].t1 - st.tick
    const urgent = tNeed >= (tLeft * per.safe) | 0
    let goal = null
    /* Z0 圈预算（根键控）：目标点=圈心向内 r×0.55（不贴边） */
    if (dEdge > -40000 && (urgent || dEdge > (c.r * 6 / 10) | 0)) {
      const k = (c.r * 55 / 100) | 0
      const dd = isqrtM(dx * dx + dy * dy) || 1
      goal = { x: c.cx - ((dx * k) / dd | 0), y: c.cy - ((dy * k) / dd | 0) }
    }
    /* Q3 资源：拳/弹尽 → 最近武器箱（饿武优先）；医疗纪律（档位键控） */
    const hungry = p.w === 0 || (p.mag <= 0 && p.ammo <= 0)
    if (hungry && !goal) {
      let best = null, bd = Infinity
      for (const id in st.boxes) {
        const b = st.boxes[id]
        if (!b.on || (b.k !== 'wpn' && b.k !== 'nade')) continue
        const d2 = (b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y)
        if (d2 < bd) { bd = d2; best = b }
      }
      if (best) {
        goal = { x: best.x, y: best.y }
        if (bd < PICK_R * PICK_R) out.pick = Number(best.id.slice(1))
      }
    }
    if (p.hp < per.healAt && p.meds > 0 && p.heal <= 0 && !(rng && rng() < per.healForget)) out.skl = 2
    else if (p.sh < 30) { /* 电池随拾取自动生效（bat 箱拾取即 +30 盾） */ }
    else if (p.spd > 0 && p.gcd <= 0 && dEdge > 0) out.skl = 3
    /* Q4 交战（饿武不 HUNT——Q3 饿武优先于一切 MID/LOW 分支 §4.1；casual 仅反击 3s 记仇） */
    let foe = null, fd = Infinity
    for (const o of st.players) {
      if (o.seat === seat || !o.alive || o.prot > 0) continue
      const d2 = (o.x - p.x) * (o.x - p.x) + (o.y - p.y) * (o.y - p.y)
      if (d2 < fd) { fd = d2; foe = o }
    }
    const armed = (p.w > 0 && (p.mag > 0 || p.ammo > 0)) || p.w === 0 // 空枪=饿武找箱不交战；拳=近程 HUNT（决赛圈收口）
    const engR = p.w === 0 ? WPNS[0].melee : (RANGE_PX * 47 / 100) | 0
    /* F-3 贴身持续拉扯：仅拉开、不添接近——巡逻/圈预算目标趋同 → 首遇即穿透 <31px
     * 命中带（弹枪口出生后仍首拍必中一拍即灭），穿透后每拍持续拉开才有交战距离带；
     * 接近仍由 HUNT 拍内承担（此处添接近会以 !goal 压制巡逻 → 全局 shots 产能塌缩）；
     * 拳不拉扯（拳程 26px 贴近本意）；HUNT 80 tick 冷却期同样生效 */
    if (foe && p.w > 0 && (p.mag > 0 || p.ammo > 0)) {
      const d = isqrtM(fd)
      const want2 = per.hunt === 2 ? 120000 : 160000
      if (d < want2 - 60000) goal = { x: p.x * 2 - foe.x, y: p.y * 2 - foe.y }
    }
    /* HUNT 时限（4s 未杀脱离——遭遇战不鏖战，royale 节奏面）；决赛圈（r≤120px）豁免=贴脸必收 */
    if (mem.huntT === undefined) mem.huntT = 0
    if (mem.huntT > 0) mem.huntT--
    const finalRing = c.r <= 120000
    if (armed && foe && fd < engR * engR) {
      const canHunt = per.hunt > 0 || (p.hurtBy === foe.seat && st.tick - p.hurtAt < 60)
      const spared = foeLose >= mercy.hardFoeLose && kinds && kinds[foe.seat] === 'human' // ≥4 免猎窗 90s（§4.4）
      if (canHunt && !spared && (mem.huntT <= 0 || finalRing)) {
        if (!finalRing) mem.huntT = 80
        let ax = foe.x, ay = foe.y
        if (per.hunt === 2) { // competitive lead 预判（闭式解 t_flight 提前量）
          const t = (isqrtM(fd) / WPNS[p.w].v) | 0
          ax += ((foe.vx * t) | 0); ay += ((foe.vy * t) | 0)
        }
        let want = atan2Q(ax - p.x, ay - p.y)
        if (rng && aimErr) want = (want + Math.trunc((rng() * 2 - 1) * aimErr)) & 0xffff
        out.aim = want
        out.fire = 1
        /* 走射接近（twin-stick 拉扯的接近半边）：远距(>want+6k)无 goal 才接近——贴身
         * 拉开已由上方 F-3 持续拉扯承担（含 HUNT 冷却期） */
        {
          const d = isqrtM(fd)
          const want2 = per.hunt === 2 ? 120000 : 160000
          if (d > want2 + 60000 && !goal) goal = { x: foe.x, y: foe.y }
        }
        if (p.nades > 0 && fd < 200000 * 200000 && p.w !== 5 && rng && rng() < 0.05) { out.skl = 1; out.aim = want }
      }
    }
    /* Q5 巡逻（§4.1）：箱点游走（拾取优先——casual 全图/balanced 资源环/competitive 近圈）；
     * 无箱可去 → 圈心向（casual 带 drift 游走观感） */
    if (!goal) {
      let tgt = null, bd = Infinity
      for (const id in st.boxes) {
        const b = st.boxes[id]
        if (!b.on) continue
        const d2 = (b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y)
        if (d2 < bd) { bd = d2; tgt = b }
      }
      if (tgt && bd < 700000 * 700000) goal = { x: tgt.x, y: tgt.y }
      else {
        const c2 = stormOf(st, st.tick + 200) // 预跑 1s 的圈（闭式解面）
        let tx = c2.cx, ty = c2.cy
        if (rng && per.drift) { const da = Math.trunc((rng() * 2 - 1) * per.drift * 182); tx += ((cosQ16(da) * 200000) >> 16); ty += ((sinQ16(da) * 200000) >> 16) }
        goal = { x: tx, y: ty }
      }
    }
    /* 顺手拾取（28px 吸附圈内道具/掉落箱）；连败让力=不抢真人近旁箱（生态位让位 §4.4） */
    if (out.pick < 0 && foeLose < mercy.minFoeLose) {
      for (const id in st.boxes) {
        const b = st.boxes[id]
        if (!b.on) continue
        const d2 = (b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y)
        if (d2 < PICK_R * PICK_R && (b.k === 'itm' || b.k === 'drop' || b.k === 'nade' || (b.k === 'wpn' && hungry))) {
          out.pick = Number(id.slice(1)); break
        }
      }
    }
    const gdx = goal.x - p.x, gdy = goal.y - p.y
    const gd = isqrtM(gdx * gdx + gdy * gdy)
    if (gd > 30000) { mem.mx = Math.round(gdx / gd * 100); mem.my = Math.round(gdy / gd * 100) }
    else { mem.mx = 0; mem.my = 0 }
    mem.aim = out.aim
    mem.fire = out.fire
    mem.skl = out.skl
    mem.pick = out.pick
    mem.wp = goal
  }
  mem.dt--
  const outSkl = mem.skl || 0, outPick = mem.pick !== undefined ? mem.pick : -1
  mem.skl = 0; mem.pick = -1 // 离散脉冲一次性（防决策间隔内逐拍重触发——cd 外的重复消费）
  /* F-3 开火距离门（逐拍实时）：贴身 ≤40px（枪口偏移 16px+敌命中半径上限 18px+余量）
   * 停火——弹几何打不中重叠/贴身敌（枪口已越过敌身），继续射=空耗弹匣一整 reload 窗；
   * 决策拍间隔内敌距可收敛穿透，门必须在消费拍实时量距；拳无弹体不受门 */
  let fireOut = mem.fire
  if (fireOut && p.w > 0) {
    let dmin2 = Infinity
    for (const o of st.players) {
      if (o.seat === seat || !o.alive) continue
      const ddx = o.x - p.x, ddy = o.y - p.y
      const dd2 = ddx * ddx + ddy * ddy
      if (dd2 < dmin2) dmin2 = dd2
    }
    if (isqrtM(dmin2) <= 40000) fireOut = 0
  }
  return { mx: mem.mx, my: mem.my, aim: mem.aim || p.aim, fire: fireOut, skl: outSkl, pick: outPick }
}

/* =====================================================================
 * S7 预测器（§5.1 一类·预测——己席输入完备，本地步进同式走位积分）
 * 三 API：anchor(权威己席态@tick) → push(at,inp) → advanceTo(tick)。
 * 弹体不入预测域（二类走事件重演）；拾取/毒伤走权威（三类/四类权威面）。
 * ===================================================================== */
function makePredictor() {
  const shadow = { x: 0, y: 0, vx: 0, vy: 0, w: 0, nades: 0, boost: 0, aim: 0 }
  let t = 0, has = false
  let ring = []
  let last = { mx: 0, my: 0, aim: 0, fire: 0 }
  function anchor(p, tick) {
    shadow.x = p.x; shadow.y = p.y; shadow.vx = p.vx || 0; shadow.vy = p.vy || 0
    shadow.w = p.w | 0; shadow.nades = p.nades | 0; shadow.boost = p.boost | 0; shadow.aim = p.aim & 0xffff
    t = tick; has = true
    const keep = []
    for (const e of ring) { if (e.at > tick) keep.push(e); else last = e.inp }
    ring = keep
  }
  function push(at, inp) { ring.push({ at, inp }); if (ring.length > 64) ring.shift() }
  function advanceTo(tick) {
    if (!has) return null
    if (tick > t + 64) tick = t + 64
    while (t < tick) {
      t++
      while (ring.length && ring[0].at <= t) last = ring.shift().inp
      /* 走位积分（与 step ②同式：负载/开火/加速修正+斜坡+clamp） */
      const wp = WPNS[shadow.w]
      let vEff = V0 - wp.load * LOAD_V - shadow.nades * LOAD_V
      if (last.fire) vEff = (vEff * FIRE_MUL) >> 16
      if (shadow.boost > 0) { vEff = (vEff * BOOST_MUL) >> 16; shadow.boost-- }
      const mx = last.mx | 0, my = last.my | 0
      const mag = Math.abs(mx) + Math.abs(my) ? isqrtM(mx * mx + my * my) : 0
      const n = mag < 30 ? 0 : Math.min(100, mag) / 100
      let tx = 0, ty = 0
      if (n > 0 && (mx || my)) {
        const inv = n / (isqrtM(mx * mx + my * my) / 100)
        tx = (mx * inv * vEff / 100) | 0
        ty = (my * inv * vEff / 100) | 0
      }
      shadow.vx += ((tx - shadow.vx) * RAMP) >> 16
      shadow.vy += ((ty - shadow.vy) * RAMP) >> 16
      shadow.x = clampI(shadow.x + shadow.vx, 12000, W - 12000)
      shadow.y = clampI(shadow.y + shadow.vy, 12000, H - 12000)
    }
    return shadow
  }
  return {
    anchor, push, advanceTo,
    me: () => shadow, tick: () => t,
    ringN: () => ring.length,
  }
}

/* ---------- 确定性（A6：serialize/hash + 回放器） ---------- */
function serialize(st) {
  const out = [st.tick, st.alive, st.nextRank, st.storm.ph, st.airdropDone]
  for (const p of st.players)
    out.push([p.x, p.y, p.vx, p.vy, p.hp, p.sh, p.w, p.mag, p.ammo, p.nades, p.meds, p.spd, p.alive, p.rank, p.kills, p.dmg, p.shotSeq])
  const bl = []
  for (const id in st.boxes) { const b = st.boxes[id]; bl.push([id, b.on ? 1 : 0]) }
  out.push(bl, st.projs.map((pr) => [pr.pid, pr.seat, pr.w, pr.x, pr.y, pr.ang, pr.ttl, pr.dist]), st.nades.length, st.inLog.length)
  return JSON.stringify(out)
}
function hashState(st) { return fnv1a32(serialize(st)) }
function hashSeat(p, tick) { return fnv1a32(tick + ':' + p.x + ',' + p.y + ',' + p.vx + ',' + p.vy + ',' + p.hp + ',' + p.sh + ',' + p.w + ',' + p.mag + ',' + p.ammo) }
/** 回放器（A6：在线终态 == 回放重放；bot env 组同形 kinds+foeLose 全零——parity 纪律 §4.4） */
function replayInputs(seed, opts, inLog, maxTicks) {
  const o = Object.assign({}, opts, { autopilot: false })
  const st = create(seed, o)
  const byTick = {}
  for (const e of inLog) (byTick[e[0]] || (byTick[e[0]] = [])).push(e)
  const room = { seats: [] }
  for (let i = 0; i < SEATS; i++) room.seats.push({ seat: i, kind: o.botLevels && o.botLevels[i] ? 'bot' : 'human' })
  const rngs = []
  for (let i = 0; i < SEATS; i++) rngs[i] = mulberry32(((seed ^ Math.imul(i, 0x9e3779b9)) >>> 0))
  const rEnv = { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) }
  let fakeQ = 1000000
  while (st.tick <= (maxTicks || MAX_TICKS)) { // 含 timeout 拍（在线 over 在 tick==maxTicks 的 step 内，A6 终态逐字节）
    const inputs = {}
    for (let i = 0; i < SEATS; i++)
      if (room.seats[i].kind === 'bot') inputs[i] = brainImpl(st, i, o.botLevels[i] || 'balanced', rngs[i], rEnv)
    const list = byTick[st.tick]
    if (list) for (const e of list)
      inputs[e[1]] = { q: ++fakeQ, mx: e[2], my: e[3], aim: e[4], fire: e[5], skl: e[6], pick: e[7] }
    const r = step(st, inputs, room)
    if (r.over) break
  }
  return st
}

const ENGINE = 'party-int-v1'
const ENGINE_HASH = fnv1a32(ENGINE + ':' + JSON.stringify(WPNS.map((w) => [w.id, w.dmg, w.cd, w.v, w.mag, w.rel, w.spr, w.load])) + ':' + PHASES.map((p) => [p.p, p.t0, p.t1, p.r0, p.r1, p.dps]).join('|') + ':' + [V0, RAMP, PICK_R, R_BASE].join(','))

return {
  META, LEVELS: ['casual', 'balanced', 'competitive'],
  ENGINE, ENGINE_HASH,
  TICK_MS, SEATS, MAX_TICKS, W, H, WPNS, PHASES, DOT, PICK_R, R_BASE, NADE_FLY, NADE_IDLE, NADE_RANGE,
  create, step, brain: brainImpl, stormOf, buildCenters, nadePos,
  makePredictor, serialize, hashState, hashSeat, replayInputs,
  fnv1a32, mulberry32, clampI, isqrtM, cosQ16, sinQ16, atan2Q, angDiff,
  PERSONA, BOT_EVERY, MERCY_DFT,
}
})
