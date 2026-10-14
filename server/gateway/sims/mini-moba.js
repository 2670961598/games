import { readFileSync } from 'node:fs'

/* 陪玩放水配置（GAMES-130，element GAMES-91/snake GAMES-102/tactics GAMES-121 同式）：
 * 阈值入 game.json bot.mercy 可调；适配器出口包装注入 env.mercy（离线直调无 env 时
 * brain 缺省兜底）。档位：L1 让力（免猎+换血阈值上调+不放连招）/ L2 重败（行为栈
 * 降档+目标评估噪声）——§4.3 让力模式 v1 预留参数本单启用。 */
const GAME_CFG = JSON.parse(readFileSync(new URL('../../../games/multiplayer/mini-moba/game.json', import.meta.url), 'utf8'))
const MERCY_CFG = (GAME_CFG.bot && GAME_CFG.bot.mercy) || { minFoeLose: 2, hardFoeLose: 4 }

/* =====================================================================
 * 迷你MOBA mini-moba 服务端 sim（GAMES-127 · E6/W2/T2）——S2 状态同步第二款
 * （战场节奏 × 小镇同步管线：10Hz 二式快照 + AOI 即战争迷雾 + 草丛加层 +
 * 移动预测和解 ext.ack，mmo-township 范式复用，设计 §5）。
 * 设计事实源：docs/designs/mini-moba.md（GAMES-126 评审通过版）——数值表
 * §2 可直接对书核验；S2/S5 边界（§5.3）：实时战斗走状态、死亡/击杀/推塔/
 * 圣所/终局走 tick 末原子裁决 ruling 事件账本（不做 op→ruling 回合机）。
 *
 * 确定性口径（设计 §6）：sim 与 brain 零 Math.random（全整数 milli-px +
 * 席位 rng 查表决策）；地图全固定不耗 seed；断言锚=ruling 账本+终局 result。
 * ===================================================================== */

/* ---------- 随机源（协议 §5 纪律：seat rng=fnv1a32 派生 mulberry32） ---------- */
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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const dist2 = (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay)
const PX = (n) => n * 1000 // px → milli-px

/* ---------- 数值表（设计 §1.1/§2，直接对书） ---------- */
const TICK_MS = 100
const PICK_LOCK = 150          // 选英雄·泉水集结期（tick 0-149）
const FIRST_WAVE = 150         // 兵线首波
const WAVE_EVERY = 300         // 30s 一波
const MAX_TICKS_DEF = 7200     // 12 分钟硬顶
const SHRINE_FIRST = 2400      // 圣所首刷（团战节拍器，固定帧锚）
const SHRINE_RESPAWN = 1800    // 击杀后 180s 重刷
const W = PX(1000), H = PX(1700)
const LANE_X = PX(500)         // 主道 x
const AOI_R = PX(320), AOI_OUT = PX(335)   // AOI 即视野圆（§5.2），15px 滞回
const AOI_BUDGET = 40
const FULL_EVERY = 300, FULL_DIRTY = 24
const GRASS_R = PX(55), GRASS_SEE = PX(90) // 草丛隐藏/同草可视半径
const FOUNT_R = PX(140)        // 泉水区
const XP_SHARE_R = PX(260)     // 兵线 XP 共享半径
const ASSIST_R = PX(300)       // 助攻参与半径
const CHASE_PAD = PX(240)      // 普攻追击容差（§2.2）
const EXP_LV = [90, 200, 330, 480, 650, 840, 1050, 1280] // L2..L9 累计 XP
const PASSIVE_GOLD_TICKS = 10  // 被动金 15/10tick
const GCD = 2                  // 公共 CD 150ms→2 tick
const ATKR = 2                 // 追击/交战记忆：敌英雄打我方英雄 → 塔/兵转火 3s

const TEAM_OF = (seat) => seat % 2 === 0 ? 'A' : 'B'

const ENEMY = { A: 'B', B: 'A' }

/* 地图（§2.1：全图 180° 点对称，全固定不耗 seed） */
const MAP = {
  w: W, h: H,
  fountains: { A: { x: PX(500), y: PX(1620), r: FOUNT_R }, B: { x: PX(500), y: PX(80), r: FOUNT_R } },
  grass: [
    { x: PX(640), y: PX(580) }, { x: PX(160), y: PX(620) }, { x: PX(200), y: PX(850) },
    { x: PX(800), y: PX(850) }, { x: PX(360), y: PX(1120) }, { x: PX(840), y: PX(1080) },
  ],
}
const TOWERS = [
  { id: 'tw-B2', team: 'B', tier: 2, x: PX(500), y: PX(280), hp: 3000, ad: 210, need: 'tw-B1' },
  { id: 'tw-B1', team: 'B', tier: 1, x: PX(500), y: PX(550), hp: 2600, ad: 190, need: null },
  { id: 'tw-A1', team: 'A', tier: 1, x: PX(500), y: PX(1150), hp: 2600, ad: 190, need: null },
  { id: 'tw-A2', team: 'A', tier: 2, x: PX(500), y: PX(1420), hp: 3000, ad: 210, need: 'tw-A1' },
]
const CORES = [
  { id: 'core-B', team: 'B', x: PX(500), y: PX(80), hp: 2000, need: 'tw-B2' },
  { id: 'core-A', team: 'A', x: PX(500), y: PX(1620), hp: 2000, need: 'tw-A2' },
]
const TOWER_R = PX(210), TOWER_INT = 10, CORE_BOX = PX(56)
const CAMPS = [ // 8 营地（§2.5）：小营×4 + 灵纹×4
  { id: 'cs0', camp: 'small', x: PX(180), y: PX(450) }, { id: 'cs1', camp: 'small', x: PX(820), y: PX(450) },
  { id: 'cs2', camp: 'small', x: PX(180), y: PX(1250) }, { id: 'cs3', camp: 'small', x: PX(820), y: PX(1250) },
  { id: 'cr0', camp: 'rune', x: PX(150), y: PX(800) }, { id: 'cr1', camp: 'rune', x: PX(850), y: PX(800) },
  { id: 'cr2', camp: 'rune', x: PX(150), y: PX(900) }, { id: 'cr3', camp: 'rune', x: PX(850), y: PX(900) },
]
const CAMP_STAT = {
  small: { hp: 520, ad: 34, int: 12, gold: 40, xp: 45, respawn: 600 },
  rune: { hp: 720, ad: 40, int: 14, gold: 60, xp: 70, respawn: 900 },
  shrine: { hp: 2600, ad: 60, int: 15, gold: 100, xp: 150, respawn: SHRINE_RESPAWN },
}
const MON_AGGRO = PX(60), MON_LEASH = PX(140), MON_RANGE = PX(40)
const CREEP = { melee: { hp: 340, ad: 24, int: 12, range: PX(30), gold: 30, xp: 34 }, ranged: { hp: 230, ad: 32, int: 15, range: PX(120), gold: 38, xp: 46 } }
const CREEP_SPD = PX(90) / 10, CREEP_AGGRO = PX(140)

/* 英雄 × 技能（§2.2：技能=基础值+英雄等级×成长；Q8.8 定点乘子） */
const HEROES = {
  guard: { name: '铁卫', hp: 1350, hpUp: 110, ad: 52, adUp: 6, int: 14, range: PX(40), spd: PX(150) / 10 },
  ranger: { name: '游侠', hp: 950, hpUp: 85, ad: 62, adUp: 7, int: 9, range: PX(160), spd: PX(150) / 10 },
  mage: { name: '星法师', hp: 900, hpUp: 80, ad: 44, adUp: 5, int: 10, range: PX(150), spd: PX(150) / 10 },
  shadow: { name: '影刃', hp: 1050, hpUp: 95, ad: 58, adUp: 7, int: 10, range: PX(45), spd: PX(155) / 10 },
}
/* 技能表：w=前摇 tick / cd / 风格 target:unit|dir|zone|self / 其余数值（§2.2 逐项） */
const SKILLS = {
  guard: [
    { code: 'bash', w: 2, cd: 70, target: 'unit', range: PX(60), dmg: [60, 14], stun: 6 },
    { code: 'charge', w: 1, cd: 90, target: 'dir', range: PX(220), dmg: [40, 8], slow: [179, 15] },
    { code: 'bulwark', w: 2, cd: 550, target: 'self', shield: [150, 30], until: 50, radius: PX(180), ult: 6 },
  ],
  ranger: [
    { code: 'wind', w: 0, cd: 120, target: 'self', haste: [410, 25] },
    { code: 'pierce', w: 2, cd: 80, target: 'dir', range: PX(320), dmg: [70, 16], proj: { speed: PX(600) / 10, half: 128 } },
    { code: 'meteor', w: 3, cd: 600, target: 'zone', ahead: PX(240), r: PX(90), hits: 6, every: 5, dmg: [40, 10], ult: 6 },
  ],
  mage: [
    { code: 'star', w: 2, cd: 70, target: 'zone', range: PX(220), r: PX(70), delay: 4, dmg: [90, 22] },
    { code: 'frost', w: 2, cd: 110, target: 'dir', range: PX(260), dmg: [50, 12], proj: { speed: PX(500) / 10, root: 10 } },
    { code: 'stasis', w: 3, cd: 650, target: 'zone', ahead: PX(200), r: PX(130), until: 40, slow: 128, dot: [25, 7], ult: 6 },
  ],
  shadow: [
    { code: 'blink', w: 0, cd: 100, target: 'unit', range: PX(240), blink: 30 },
    { code: 'venom', w: 1, cd: 80, target: 'zone', r: PX(120), dmg: [40, 10], poison: [8, 2, 6], slow: [205, 20] },
    { code: 'execute', w: 2, cd: 500, target: 'unit', range: PX(90), dmg: [90, 22], exec35: 512, ult: 6 },
  ],
}
const DEFAULT_HERO = ['ranger', 'shadow', 'mage', 'guard', 'guard', 'mage'] // A: 游侠/法师/铁卫；B: 影刃/铁卫/法师（§6 push-lane：API 席=游侠）。GAMES-133 席位对称性实验结论（留档）：双方远程数结构镜像（A=B={游侠,法师,铁卫}多重集，三种排布）下 bot-vs-bot 镜像局确趋于对称（cas-vs-cas=draw/胜负随换席翻转），但冻结剧本 A2 push-lane 静态真人被双远程 casual 稳定反推（0/23~5/13 滚雪球、B 收局，三种排布+席位迭代对称均红）——远程结构镜像与 A2 相克，本单不换英雄面，席位对称由 step/creepStep/towerStep 偶奇轮换迭代序承担；英雄配置不对称（A 双远程/B 单远程）为已知残项转后续（剧本面重写或真人侧补偿后镜像才可行）
/* 装备（§2.7）：6 件一次性，泉水/死亡可购；叠加上限 CD −40%/攻速 −35% */
const ITEMS = {
  boots: { name: '疾风之靴', cost: 800, spd: PX(25) / 10, cdr: 26 },
  blade: { name: '破军刃', cost: 1100, ad: 45 },
  plate: { name: '玄武甲', cost: 1000, hp: 600 },
  frenzy: { name: '狂战徽记', cost: 900, intMul: 218 },
  leech: { name: '噬血珠', cost: 950, leech: 51 }, // 20% ≈ 51/256
  tome: { name: '贤者典籍', cost: 900, cdr: 64, sdMul: 276 }, // CD −25%; 技伤 +8%
}
const ROUTE = { guard: ['plate', 'boots', 'leech'], ranger: ['blade', 'frenzy', 'boots'], mage: ['tome', 'boots', 'blade'], shadow: ['boots', 'blade', 'frenzy'] }
const CDR_CAP = 102, INTMUL_FLOOR = 166 // −40% / −35%（×256 计）

/* ---------- 移动积分（两端同式纯函数：mmo §5.5 范式，设计 §3.2 速度即时映射） ---------- */
export function moveStep(e, mx, my, spdMpxPerTick, collide, mul256 = 256) {
  collide = null // 塔基座仅渲染占位（st.collide 表照发客户端/A1）；纯纵向兵线无侧滑分量，AABB 推出=永钉塔底（实测 32 兵堆积），全图连通可走优先（§2.1）
  const vx = Math.round(spdMpxPerTick * (mx / 100) * mul256 / 256)
  const vy = Math.round(spdMpxPerTick * (my / 100) * mul256 / 256)
  e.x = clamp(e.x + vx, 0, W); e.y = clamp(e.y + vy, 0, H)
  for (const b of collide || []) { // AABB 推出（两端口径同式；当前表恒空，见上注）
    if (e.x > b.x && e.x < b.x + b.w && e.y > b.y && e.y < b.y + b.h) {
      const dxl = e.x - b.x, dxr = b.x + b.w - e.x, dyt = e.y - b.y, dyb = b.y + b.h - e.y
      const m = Math.min(dxl, dxr, dyt, dyb)
      if (m === dxl) e.x = b.x; else if (m === dxr) e.x = b.x + b.w
      else if (m === dyt) e.y = b.y; else e.y = b.y + b.h
    }
  }
  if (mx || my) e.dir = ((Math.round(Math.atan2(my, mx) / Math.PI * 4) * 45) % 360 + 360) % 360
}

/* =====================================================================
 * create(seed, opts)
 * ===================================================================== */
function create(seed, opts = {}) {
  const st = {
    v: 1, gameId: 'mini-moba', seed: seed >>> 0, tick: 0,
    testRoom: !!opts.test, maxTicks: opts.maxTicks != null ? opts.maxTicks : MAX_TICKS_DEF,
    map: MAP,
    collide: [...TOWERS, ...CORES].map((t) => ({ x: t.x - CORE_BOX / 2, y: t.y - CORE_BOX / 2, w: CORE_BOX, h: CORE_BOX })),
    ents: {}, sessions: {},
    camps: CAMPS.map((c) => ({ ...c, nextAt: 0 })),
    shrine: { nextAt: SHRINE_FIRST },
    projs: [], zones: [], pings: [],
    bless: null, // 龟甲祝祷 {team,until}：对建筑伤 +25%（×288/256）
    coreDown: null, // 水晶告破方（GAMES-133：rulingPass 同拍删实体后的终局旗）
    stats: { kills: { A: 0, B: 0 }, towers: { A: 0, B: 0 } },
  }
  for (const t of TOWERS) st.ents[t.id] = { id: t.id, k: 'tw', team: t.team, tier: t.tier, x: t.x, y: t.y, hp: t.hp, maxhp: t.hp, inv: t.need ? 1 : 0, ad: t.ad, atkT: 0, tg: null, agUntil: 0 }
  for (const c of CORES) st.ents[c.id] = { id: c.id, k: 'core', team: c.team, x: c.x, y: c.y, hp: c.hp, maxhp: c.hp, inv: c.need ? 1 : 0 }
  for (const c of st.camps) spawnMon(st, c.id, c.camp, c.x, c.y, null) // 8 营地开局即刷（§2.5）
  return st
}

function ensureSession(st, seat) {
  let s = st.sessions[seat]
  if (!s) {
    s = st.sessions[seat] = {
      seat, team: TEAM_OF(seat), hero: DEFAULT_HERO[seat] || 'guard', gold: 0,
      items: [], xp: 0, k: 0, d: 0, a: 0, streak: 0, dmg: 0, tdmg: 0,
      hitBy: {}, // victim 视角：袭击者 seat → 最近 tick（助攻归属）
      emp: 0,   // 影刃 blink 强化普攻加成（§2.2）
      mem: { dt: 0, mode: 'lane', tg: null, step: 0, recSent: false, lx: null, ly: null },
    }
  }
  return s
}
function heroStats(seat, s) {
  const base = HEROES[s.hero]
  const lv = s.lv || 1
  let hp = base.hp + base.hpUp * (lv - 1), ad = base.ad + base.adUp * (lv - 1), spd = base.spd
  for (const it of s.items) {
    if (it === 'plate') hp += ITEMS.plate.hp
    else if (it === 'blade') ad += ITEMS.blade.ad
    else if (it === 'boots') spd += ITEMS.boots.spd
  }
  return { hp, ad, spd, range: base.range, int: base.int }
}
function ensureHero(st, seat) {
  const id = 'h' + seat
  if (st.ents[id]) return st.ents[id]
  const s = ensureSession(st, seat)
  s.lv = s.lv || 1
  const stats = heroStats(seat, s)
  const f = MAP.fountains[s.team]
  const h = {
    id, k: 'hero', seat, team: s.team, hero: s.hero, x: f.x, y: f.y, dir: 0,
    hp: stats.hp, maxhp: stats.hp, lv: s.lv, cd: [0, 0, 0], gcd: 0,
    dead: 0, respAt: 0, cc: null, buffs: [], sh: 0,
    atkT: 0, tg: null, cast: null, rec: 0,
  }
  st.ents[id] = h
  return h
}
function heroAd(st, h) {
  const s = st.sessions[h.seat]
  const stats = heroStats(h.seat, s)
  let ad = stats.ad + (s.emp || 0) // 影刃 blink 强化普攻（一发）
  if (buffed(h, 'rune')) ad += 20  // 灵纹 AD+20（§2.5）
  return ad
}
function heroSpd(st, h) {
  const s = st.sessions[h.seat]
  let spd = heroStats(h.seat, s).spd
  let mul = 256
  for (const b of h.buffs) if (b.k === 'haste') mul = Math.max(mul, b.v)
  for (const b of h.buffs) if (b.k === 'slow') mul = Math.min(mul, b.v)
  return [spd, mul]
}
function heroInt(st, h) { // 攻击间隔（frenzy/上限）
  const s = st.sessions[h.seat]
  let mul = 256
  if (s.items.includes('frenzy')) mul = Math.min(mul, ITEMS.frenzy.intMul)
  return Math.max(1, Math.round(HEROES[h.hero].int * Math.max(mul, INTMUL_FLOOR) / 256))
}
function buffed(h, k) { return h.buffs.some((b) => b.k === k) }
function skillDmgMul(st, seat) {
  const s = st.sessions[seat]
  let m = 256
  if (s.items.includes('tome')) m = Math.round(m * ITEMS.tome.sdMul / 256)
  if (s.buffRune && s.buffRune > st.tick) m = Math.round(m * 266 / 256)
  return m
}
function cdMul(seat, s) {
  let cdr = 0
  for (const it of s.items) if (ITEMS[it].cdr) cdr += ITEMS[it].cdr
  return Math.max(256 - Math.min(cdr, CDR_CAP), 256 - CDR_CAP) / 256
}
function inFount(st, e, team) { const f = MAP.fountains[team]; return dist2(e.x, e.y, f.x, f.y) <= f.r * f.r }

/* =====================================================================
 * step(state, inputs, room) —— tick 结算序（§5.1）
 * ===================================================================== */
function step(st, inputs, room) {
  const events = []
  const dirty = new Set()
  const kinds = room ? room.seats.map((s) => s.kind) : null

  /* 0. 席位自愈 */
  for (let i = 0; i < 6; i++) {
    const active = kinds ? (kinds[i] === 'human' || kinds[i] === 'bot') : true
    if (active) { const h = ensureHero(st, i); dirty.add(h.id) }
    else delete st.ents['h' + i]
  }

  /* 1. 输入 → 离散 cmd（死亡期可买装，§2.7）→ 移动/施法/回城 */
  for (let seat = 0; seat < 6; seat++) {
    const h = st.ents['h' + seat]
    if (!h) continue
    const inp = inputs[seat] || {}
    if (inp.cmd) execCmd(st, seat, inp.cmd, dirty, events)
    if (h.dead) continue
    const ccKind = h.cc && h.cc.until > st.tick ? h.cc.kind : null
    const moving = (inp.mx | 0) !== 0 || (inp.my | 0) !== 0
    if (moving) {
      if (h.cast) { h.cast = null; dirty.add(h.id) }         // 新移动输入取消前摇（§3.3）
      if (h.rec) { h.rec = 0; events.push({ k: 'recall', seat, phase: 'break' }); dirty.add(h.id) }
    }
    if (ccKind !== 'stun' && ccKind !== 'root' && !h.rec) {
      const [spd, mul] = heroSpd(st, h)
      const px = h.x, py = h.y
      moveStep(h, inp.mx | 0, inp.my | 0, spd, st.collide, mul)
      if (h.x !== px || h.y !== py) dirty.add(h.id)
    }
  }

  /* 2. 泉水（己方每拍回 1.5% HP；敌方入泉 40 真伤/拍=400/s，§2.1） */
  for (let seat = 0; seat < 6; seat++) {
    const h = st.ents['h' + seat]
    if (!h || h.dead) continue
    if (inFount(st, h, h.team) && h.hp < h.maxhp) {
      h.hp = Math.min(h.maxhp, h.hp + Math.ceil(h.maxhp * 0.015)); dirty.add(h.id)
    }
    if (inFount(st, h, ENEMY[h.team])) damage(st, null, h, 40, 'true', events, dirty)
  }

  /* 3. CD/控制/buff 到期 + 施法前摇推进 */
  for (let seat = 0; seat < 6; seat++) {
    const h = st.ents['h' + seat]
    if (!h) continue
    for (let i = 0; i < 3; i++) if (h.cd[i] > 0) { h.cd[i]--; dirty.add(h.id) }
    if (h.gcd > 0) h.gcd--
    if (h.cc && h.cc.until <= st.tick) { h.cc = null; dirty.add(h.id) }
    if (h.buffs.length) {
      const n = h.buffs.filter((b) => b.until > st.tick)
      if (n.length !== h.buffs.length) { h.buffs = n; dirty.add(h.id) }
    }
    if (h.cast && st.tick >= h.cast.at) { const c = h.cast; h.cast = null; resolveCast(st, h, c, events, dirty) }
  }

  /* 4. 普攻（英雄：目标保持+追击容差+计时结算；弹道兵种伤害即时、可视化走事件 §2.2） */
  for (let seat = 0; seat < 6; seat++) {
    const h = st.ents['h' + seat]
    if (!h || h.dead || (h.cc && h.cc.until > st.tick && h.cc.kind === 'stun')) continue
    if (h.atkT > 0) h.atkT--
    let tg = h.tg ? st.ents[h.tg] : null
    if (tg && (tg.hp <= 0 || tg.dead)) { tg = null; h.tg = null; dirty.add(h.id) }
    if (tg && dist2(h.x, h.y, tg.x, tg.y) > (heroStats(seat, st.sessions[seat]).range + CHASE_PAD) ** 2) { tg = null; h.tg = null; dirty.add(h.id) }
    if (!tg) { tg = autoTarget(st, h); if (tg) { h.tg = tg.id; dirty.add(h.id) } }
    if (tg && h.atkT <= 0) {
      const range = heroStats(seat, st.sessions[seat]).range
      if (dist2(h.x, h.y, tg.x, tg.y) <= range * range) {
        if (tg.k === 'tw' || tg.k === 'core') {
          if (tg.inv) { h.tg = null; dirty.add(h.id) } // 无敌链解除前静默脱靶（reject 只走显式 cmd，A6）
          else towerDamage(st, h, tg, heroAd(st, h), events, dirty)
        } else {
          const dmg = heroAd(st, h)
          const s = st.sessions[seat]
          if (h.hero === 'ranger' || h.hero === 'mage') events.push({ k: 'shot', by: h.id, from: [h.x, h.y], to: [tg.x, tg.y], speed: PX(600) / 10 })
          damage(st, h, tg, dmg, h.hero === 'mage' ? 'magic' : 'phys', events, dirty)
          if (s.emp) { s.emp = 0 } // blink 强化仅一发
          if (s.items.includes('leech') && !h.dead) {
            const heal = Math.max(1, Math.round(dmg * ITEMS.leech.leech / 256))
            h.hp = Math.min(h.maxhp, h.hp + heal); dirty.add(h.id)
          }
        }
        h.atkT = heroInt(st, h)
      }
    }
  }

  /* 5. 兵线（波次+行军+索敌+转火 §2.4） */
  if (st.tick >= FIRST_WAVE && (st.tick - FIRST_WAVE) % WAVE_EVERY === 0) spawnWave(st, dirty)
  creepStep(st, events, dirty)

  /* 6. 野区/圣所（营地怪 aggro/leash、重生；圣所固定首刷 2400） */
  campStep(st, events, dirty)

  /* 7. 塔（aggro 优先兵、转火规则 §2.3） */
  towerStep(st, events, dirty)

  /* 8. 弹道/持续区（服务器权威命中；弹道本体不入脏实体 §5.3 规则 4） */
  projStep(st, events, dirty)
  zoneStep(st, events, dirty)

  /* 9. 回城引导（4s：受击/移动打断已在 §1/§2 落地）+ 复活 + 经济（被动金 15/10tick） */
  for (let seat = 0; seat < 6; seat++) {
    const h = st.ents['h' + seat]
    if (!h) continue
    if (h.rec > 0) {
      h.rec--
      if (h.rec <= 0) {
        const f = MAP.fountains[h.team]
        h.x = f.x; h.y = f.y; h.tg = null
        dirty.add(h.id)
        events.push({ k: 'recall', seat, phase: 'done' })
      }
    }
    if (h.dead && st.tick >= h.respAt) {
      const f = MAP.fountains[h.team]
      h.dead = 0; h.hp = h.maxhp; h.x = f.x; h.y = f.y; h.cc = null; h.buffs = []; h.tg = null; h.cast = null; h.rec = 0
      dirty.add(h.id)
      const s = st.sessions[seat]
      if (s) { // 死亡期顺手买推荐件（bot/挂机友好；真人也可死时手买）
        s.streak = 0
      }
    }
    const s = st.sessions[seat]
    if (s && st.tick % PASSIVE_GOLD_TICKS === 0) s.gold += 15
  }

  /* 10. tick 末原子裁决：死亡/击杀/推塔/圣所（§5.3 裁决化四规则） */
  rulingPass(st, events, dirty)

  /* 11. 终局判定（coreDown 旗=rulingPass 同拍删除实体后的存活口径，GAMES-133） */
  let over = null
  if (st.coreDown) over = { winner: ENEMY[st.coreDown], reason: 'core-down', scores: killScores(st) }
  else if (st.tick + 1 >= st.maxTicks) over = timeoutRuling(st)
  for (const p of st.pings) if (p.at + 50 <= st.tick) p.dead = true
  st.pings = st.pings.filter((p) => !p.dead)

  st.tick++
  return { events, dirty, over: !!over, result: over || null }
}

function killScores(st) {
  const sc = {}
  for (let i = 0; i < 6; i++) { const s = st.sessions[i]; sc[i] = s ? s.k : 0 }
  return sc
}
function timeoutRuling(st) { // §1.4 超时：水晶 HP% → 存塔分（T1=1/T2=2）→ 击杀 → draw
  const hpPct = (id) => { const c = st.ents[id]; return c ? c.hp / c.maxhp : 0 }
  const a = hpPct('core-A'), b = hpPct('core-B')
  let winner
  if (Math.abs(a - b) > 1e-9) winner = a > b ? 'A' : 'B'
  else if (st.stats.towers.A !== st.stats.towers.B) winner = st.stats.towers.A > st.stats.towers.B ? 'A' : 'B'
  else if (st.stats.kills.A !== st.stats.kills.B) winner = st.stats.kills.A > st.stats.kills.B ? 'A' : 'B'
  else winner = 'draw'
  return { winner, reason: 'timeout', scores: killScores(st) }
}

/* ---------- 普攻仲裁目标（射程内英雄优先，§1.6 点=仲裁最优目标） ---------- */
function autoTarget(st, h) {
  const range = heroStats(h.seat, st.sessions[h.seat]).range
  let best = null, bd = Infinity
  for (const e of Object.values(st.ents)) {
    if (e === h || e.hp <= 0) continue
    if (!isEnemyOf(st, h, e)) continue
    if (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon') continue
    if (e.k === 'tw' || e.k === 'core') continue
    const d = dist2(h.x, h.y, e.x, e.y)
    if (d > range * range) continue
    const pri = e.k === 'hero' ? 0 : 1
    const score = pri * 1e12 + d
    if (score < bd) { bd = score; best = e }
  }
  return best
}
function isEnemyOf(st, a, b) {
  const ta = a.team, tb = b.team
  if (ta == null || tb == null) return ta !== tb // 中立怪 team=null 与任何人为敌
  return ta !== tb
}

/* ---------- 伤害（唯一入口：hit 事件+盾+死亡归属/助攻账本+塔 aggro） ---------- */
function damage(st, src, dst, dmg, kind, events, dirty, isSkill = false) {
  if (!dst || dst.hp <= 0 || dst.dead || dmg <= 0) return
  if (dst.sh > 0) { const use = Math.min(dst.sh, dmg); dst.sh -= use; dmg -= use; if (dmg <= 0) { dirty.add(dst.id); return } }
  // 死亡归属账本（rulingPass 判 killer/助攻/营地还手，§5.3）
  dst.dmgLog = dst.dmgLog || []
  dst.dmgLog.push({ t: st.tick, by: src ? src.id : null, bySeat: src && src.k === 'hero' ? src.seat : null })
  if (dst.dmgLog.length > 8) dst.dmgLog.shift()
  dst.hp -= dmg
  dirty.add(dst.id)
  const ev = { k: 'hit', by: src ? src.id : 'world', vic: dst.id, dmg }
  if (kind === 'magic') ev.m = 1
  events.push(ev)
  if (src && src.k === 'hero') {
    if (dst.k === 'hero') {
      st.sessions[dst.seat].hitBy[src.seat] = st.tick
      st.sessions[src.seat].dmg += dmg
      towerAggroOn(st, dst, src, dirty) // 越塔攻击英雄 → 塔转火 3s（§2.3）
      if (dst.rec) { dst.rec = 0; events.push({ k: 'recall', seat: dst.seat, phase: 'break' }) } // 引导受击打断
    } else if (dst.k === 'mon') {
      dst.lastHit = st.tick; dst.lastBy = src.id
      ;(dst.hitBy = dst.hitBy || {})[src.seat] = st.tick // 圣所参战分（§2.5）
    }
  }
}
function towerAggroOn(st, victim, attacker, dirty) {
  for (const e of Object.values(st.ents)) {
    if (e.k === 'tw' && e.team === victim.team && dist2(e.x, e.y, attacker.x, attacker.y) <= TOWER_R * TOWER_R) {
      e.tg = attacker.id; e.agUntil = st.tick + 30; dirty.add(e.id)
    }
  }
}
function towerDamage(st, h, tg, dmg, events, dirty) {
  let d = dmg
  if (st.bless && st.bless.team === h.team && st.bless.until > st.tick) d = Math.round(d * 288 / 256) // 祝祷对建筑 +25%
  damage(st, h, tg, d, 'phys', events, dirty)
}

/* ---------- 离散 cmd（execCmd 白名单；非法 {k:'reject'} 回流 §5.1） ---------- */
function execCmd(st, seat, cmd, dirty, events) {
  if (!cmd || typeof cmd !== 'object') return
  const h = st.ents['h' + seat]
  const s = st.sessions[seat]
  if (!h || !s) return
  if (cmd.k === 'pick') {
    if (st.tick >= PICK_LOCK) return events.push({ k: 'reject', seat, op: 'pick', why: 'locked' })
    const code = HEROES[cmd.hero] ? cmd.hero : null
    if (!code) return events.push({ k: 'reject', seat, op: 'pick', why: 'noent' })
    for (let i = 0; i < 6; i++) { // 同队不可重复（§1.1）
      if (i === seat) continue
      const o = st.sessions[i]
      if (o && o.team === s.team && o.hero === code && st.ents['h' + i]) return events.push({ k: 'reject', seat, op: 'pick', why: 'dup' })
    }
    if (s.hero !== code && st.ents['h' + seat] && !h.dead && h.hp === h.maxhp && st.tick < PICK_LOCK) {
      s.hero = code
      const stats = heroStats(seat, s)
      h.hero = code; h.maxhp = stats.hp; h.hp = stats.hp
      dirty.add(h.id)
      events.push({ k: 'pick', seat, hero: code })
    }
    return
  }
  if (h.dead && cmd.k !== 'buy') return // 死亡期仅可买装（§2.7）
  if (cmd.k === 'atk') {
    let tg = cmd.entId ? st.ents[cmd.entId] : null
    if (!tg) tg = autoTarget(st, h)
    if (!tg) return events.push({ k: 'reject', seat, op: 'atk', why: 'noent' })
    if (!isEnemyOf(st, h, tg) || (tg.k !== 'hero' && tg.k !== 'creep' && tg.k !== 'mon' && tg.k !== 'tw' && tg.k !== 'core')) return events.push({ k: 'reject', seat, op: 'atk', why: 'noent' })
    if ((tg.k === 'tw' || tg.k === 'core') && tg.inv) return events.push({ k: 'reject', seat, op: 'atk', why: 'invuln' })
    h.tg = tg.id; dirty.add(h.id)
    return
  }
  if (cmd.k === 'skill') {
    const idx = cmd.idx | 0
    if (idx < 0 || idx > 2) return events.push({ k: 'reject', seat, op: 'skill', why: 'idx' })
    const sk = SKILLS[h.hero][idx]
    if (sk.ult && h.lv < sk.ult) return events.push({ k: 'reject', seat, op: 'skill', why: 'lv' })
    if (h.cd[idx] > 0) return events.push({ k: 'reject', seat, op: 'skill', why: 'cd' })
    if (h.gcd > 0) return events.push({ k: 'reject', seat, op: 'skill', why: 'gcd' })
    if (h.cc && h.cc.until > st.tick && h.cc.kind === 'stun') return events.push({ k: 'reject', seat, op: 'skill', why: 'cc' })
    let dir = cmd.dir && Number.isFinite(cmd.dir.dx) && Number.isFinite(cmd.dir.dy) ? { dx: cmd.dir.dx, dy: cmd.dir.dy } : null
    let tg = cmd.entId ? st.ents[cmd.entId] : null
    if (sk.target === 'unit') {
      if (!tg || !isEnemyOf(st, h, tg) || tg.hp <= 0) return events.push({ k: 'reject', seat, op: 'skill', why: 'noent' })
      if (dist2(h.x, h.y, tg.x, tg.y) > (sk.range + CHASE_PAD) ** 2) return events.push({ k: 'reject', seat, op: 'skill', why: 'range' })
    } else if (sk.target === 'dir' && !dir) {
      const near = nearestEnemy(st, h, 1e9) // 缺省=朝最近敌（§1.6）
      dir = near ? { dx: near.x - h.x, dy: near.y - h.y } : { dx: 0, dy: h.team === 'A' ? -1 : 1 }
    }
    h.cast = { idx, at: st.tick + sk.w, dir, tg: tg ? tg.id : null }
    h.cd[idx] = Math.max(1, Math.round(sk.cd * cdMul(seat, s)))
    h.gcd = GCD
    if (sk.w === 0) { const c = h.cast; h.cast = null; resolveCast(st, h, c, events, dirty) }
    dirty.add(h.id)
    return
  }
  if (cmd.k === 'recall') {
    if (h.rec) return
    if (inFount(st, h, h.team)) return events.push({ k: 'reject', seat, op: 'recall', why: 'home' })
    h.rec = 40; h.tg = null; dirty.add(h.id)
    events.push({ k: 'recall', seat, phase: 'start' })
    return
  }
  if (cmd.k === 'buy') {
    const next = cmd.item && ITEMS[cmd.item] ? cmd.item : ROUTE[s.hero].find((x) => !s.items.includes(x))
    if (!next) return events.push({ k: 'reject', seat, op: 'buy', why: 'full' })
    if (s.items.includes(next)) return events.push({ k: 'reject', seat, op: 'buy', why: 'owned' })
    if (!h.dead && !inFount(st, h, h.team)) return events.push({ k: 'reject', seat, op: 'buy', why: 'not-home' })
    if (s.gold < ITEMS[next].cost) return events.push({ k: 'reject', seat, op: 'buy', why: 'no-gold' })
    s.gold -= ITEMS[next].cost
    s.items.push(next)
    const stats = heroStats(seat, s)
    const oldMax = h.maxhp
    h.maxhp = stats.hp
    h.hp = Math.min(h.maxhp, h.hp + (h.maxhp - oldMax))
    dirty.add(h.id)
    events.push({ k: 'buy', seat, item: next })
    return
  }
  if (cmd.k === 'ping') {
    const mark = ['attack', 'retreat', 'focus'].includes(cmd.mark) ? cmd.mark : 'attack'
    const x = clamp(Math.round(Number(cmd.x) || 0), 0, W), y = clamp(Math.round(Number(cmd.y) || 0), 0, H)
    st.pings.push({ seat, mark, x, y, at: st.tick })
    events.push({ k: 'ping', seat, mark, x, y })
    return
  }
}

/* ---------- 技能结算（前摇完成；伤害=基础+等级×成长 ×技伤乘子） ---------- */
function skDmg(st, h, sk) {
  const s = st.sessions[h.seat]
  const base = sk.dmg[0] + sk.dmg[1] * h.lv
  return Math.max(1, Math.round(base * skillDmgMul(st, h.seat) / 256))
}
function resolveCast(st, h, c, events, dirty) {
  const sk = SKILLS[h.hero][c.idx]
  const code = sk.code
  const s = st.sessions[h.seat]
  const tg = c.tg ? st.ents[c.tg] : null
  if (code === 'bash' && tg && tg.hp > 0) {
    damage(st, h, tg, skDmg(st, h, sk), 'phys', events, dirty, true)
    if (tg.k === 'hero' && tg.hp > 0) { tg.cc = { kind: 'stun', until: st.tick + sk.stun }; dirty.add(tg.id) }
  } else if (code === 'charge') {
    const d = c.dir || { dx: 0, dy: h.team === 'A' ? -1 : 1 }
    const len = Math.hypot(d.dx, d.dy) || 1
    const ox = h.x, oy = h.y
    const nx = h.x + Math.round(d.dx / len * sk.range), ny = h.y + Math.round(d.dy / len * sk.range)
    // 路径首个敌人（沿 dash 线最近命中）
    let hit = null, bd = Infinity
    for (const e of Object.values(st.ents)) {
      if (e === h || e.hp <= 0 || !isEnemyOf(st, h, e) || (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon')) continue
      const t = ((e.x - h.x) * (nx - h.x) + (e.y - h.y) * (ny - h.y)) / ((nx - h.x) ** 2 + (ny - h.y) ** 2 || 1)
      if (t < 0 || t > 1) continue
      const px = h.x + t * (nx - h.x), py = h.y + t * (ny - h.y)
      const dd = dist2(e.x, e.y, px, py)
      if (dd <= PX(60) ** 2 && t * sk.range < bd) { bd = t * sk.range; hit = e }
    }
    h.x = clamp(nx, 0, W); h.y = clamp(ny, 0, H); dirty.add(h.id)
    if (hit) {
      damage(st, h, hit, skDmg(st, h, sk), 'phys', events, dirty, true)
      if (hit.k === 'hero' && hit.hp > 0) { hit.buffs = addBuff(hit.buffs, 'slow', sk.slow[0], st.tick + sk.slow[1]); dirty.add(hit.id) }
    }
    events.push({ k: 'shot', by: h.id, skill: code, from: [ox, oy], to: [h.x, h.y], speed: PX(220) / 4 })
  } else if (code === 'bulwark') {
    for (const e of Object.values(st.ents)) {
      if (e.k !== 'hero' || e.team !== h.team || e.dead) continue
      if (e === h || dist2(h.x, h.y, e.x, e.y) <= sk.radius ** 2) {
        e.sh = (e.sh || 0) + sk.shield[0] + sk.shield[1] * h.lv
        e.buffs = addBuff(e.buffs, 'shield', 256, st.tick + sk.until)
        dirty.add(e.id)
      }
    }
  } else if (code === 'wind') {
    h.buffs = addBuff(h.buffs, 'haste', sk.haste[0], st.tick + sk.haste[1]); dirty.add(h.id)
  } else if (code === 'pierce' || code === 'frost') {
    const d = c.dir || { dx: 0, dy: h.team === 'A' ? -1 : 1 }
    const len = Math.hypot(d.dx, d.dy) || 1
    st.projs.push({
      id: 'p' + st.tick + '-' + h.seat, by: h.id, seat: h.seat, team: h.team, skill: code,
      x: h.x, y: h.y, dx: Math.round(d.dx / len * sk.proj.speed), dy: Math.round(d.dy / len * sk.proj.speed),
      left: sk.range, dmg: skDmg(st, h, sk), half: sk.proj.half || null, root: sk.proj.root || null, hit: [],
    })
    events.push({ k: 'shot', by: h.id, skill: code, from: [h.x, h.y], dir: [d.dx / len, d.dy / len], speed: sk.proj.speed, maxDist: sk.range })
  } else if (code === 'meteor' || code === 'star' || code === 'stasis') {
    let x, y
    if (tg) { x = tg.x; y = tg.y }
    else {
      const d = c.dir || { dx: 0, dy: h.team === 'A' ? -1 : 1 }
      const len = Math.hypot(d.dx, d.dy) || 1
      const ahead = sk.ahead || sk.range
      x = h.x + Math.round(d.dx / len * ahead); y = h.y + Math.round(d.dy / len * ahead)
    }
    const z = { id: 'z' + st.tick + '-' + h.seat, by: h.id, seat: h.seat, team: h.team, skill: code, x, y, r: sk.r, born: st.tick }
    if (code === 'star') { z.at = st.tick + sk.delay; z.dmg = skDmg(st, h, sk); z.once = 1 }
    if (code === 'meteor') { z.every = sk.every; z.hits = sk.hits; z.left = sk.hits; z.dmg = skDmg(st, h, sk) }
    if (code === 'stasis') { z.until = st.tick + sk.until; z.slow = sk.slow; z.dot = Math.max(1, Math.round((sk.dot[0] + sk.dot[1] * h.lv) * skillDmgMul(st, h.seat) / 256)); z.every = 10; z.left = 99 }
    st.zones.push(z)
    events.push({ k: 'zone', by: h.id, skill: code, x, y, r: sk.r, at: z.at || 0, dur: z.until || 0 })
  } else if (code === 'blink' && tg) {
    const d = { dx: tg.x - h.x, dy: tg.y - h.y }
    const len = Math.hypot(d.dx, d.dy) || 1
    h.x = clamp(tg.x - Math.round(d.dx / len * PX(sk.blink)), 0, W)
    h.y = clamp(tg.y - Math.round(d.dy / len * PX(sk.blink)), 0, H)
    s.emp = 30 + 6 * h.lv
    h.tg = tg.id
    dirty.add(h.id)
  } else if (code === 'venom') {
    for (const e of Object.values(st.ents)) {
      if (e === h || e.hp <= 0 || !isEnemyOf(st, h, e) || (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon')) continue
      if (dist2(h.x, h.y, e.x, e.y) > sk.r ** 2) continue
      damage(st, h, e, skDmg(st, h, sk), 'magic', events, dirty, true)
      if (e.k === 'hero' && e.hp > 0) {
        e.buffs = addBuff(e.buffs, 'slow', sk.slow[0], st.tick + sk.slow[1])
        e.poison = { by: h.seat, dmg: sk.poison[0] + sk.poison[1] * h.lv, left: sk.poison[2], every: 5, t: 0 }
        dirty.add(e.id)
      }
    }
  } else if (code === 'execute' && tg && tg.hp > 0) {
    let d = skDmg(st, h, sk)
    if (tg.hp / tg.maxhp < 0.35) d = Math.round(d * sk.exec35 / 256)
    damage(st, h, tg, d, 'phys', events, dirty, true)
  }
}
function addBuff(buffs, k, v, until) {
  const rest = buffs.filter((b) => b.k !== k)
  rest.push({ k, v, until })
  return rest
}
function nearestEnemy(st, h, maxR) {
  let best = null, bd = maxR * maxR
  for (const e of Object.values(st.ents)) {
    if (e === h || e.hp <= 0 || !isEnemyOf(st, h, e) || (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon')) continue
    const d = dist2(h.x, h.y, e.x, e.y)
    if (d < bd) { bd = d; best = e }
  }
  return best
}

/* ---------- 弹道推进（首个敌人全伤、后续穿透半伤/定身） ---------- */
function projStep(st, events, dirty) {
  const keep = []
  for (const p of st.projs) {
    p.x += p.dx; p.y += p.dy
    p.left -= Math.hypot(p.dx, p.dy)
    if (p.left <= 0 || p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue
    const by = st.ents[p.by]
    for (const e of Object.values(st.ents)) {
      if (e.hp <= 0 || p.hit.includes(e.id)) continue
      if (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon') continue
      if (!by || !isEnemyOf(st, by, e)) continue
      if (dist2(p.x, p.y, e.x, e.y) > PX(28) ** 2) continue
      p.hit.push(e.id)
      const dmg = p.hit.length === 1 || !p.half ? p.dmg : Math.max(1, Math.round(p.dmg * p.half / 256))
      if (by) damage(st, by, e, dmg, 'magic', events, dirty, true)
      if (p.root && e.k === 'hero' && e.hp > 0) { e.cc = { kind: 'root', until: st.tick + p.root }; dirty.add(e.id) }
    }
    keep.push(p)
  }
  st.projs = keep
}

/* ---------- 持续区（星陨预警/流星箭雨/静滞领域） ---------- */
function zoneStep(st, events, dirty) {
  const keep = []
  for (const z of st.zones) {
    const by = st.ents[z.by]
    const active = z.skill === 'star' ? st.tick >= z.at : true
    if (z.skill === 'star') {
      if (st.tick < z.at) { keep.push(z); continue }
      if (!z.done) {
        z.done = 1
        for (const e of Object.values(st.ents)) {
          if (e.hp <= 0 || !by || !isEnemyOf(st, by, e) || (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon')) continue
          if (dist2(z.x, z.y, e.x, e.y) <= z.r ** 2) damage(st, by, e, z.dmg, 'magic', events, dirty, true)
        }
        events.push({ k: 'boom', by: z.by, skill: 'star', x: z.x, y: z.y, r: z.r })
      }
      continue
    }
    if (z.skill === 'meteor') {
      z.t = (z.t || 0) + 1
      if (z.t % z.every === 0 && z.left > 0) {
        z.left--
        for (const e of Object.values(st.ents)) {
          if (e.hp <= 0 || !by || !isEnemyOf(st, by, e) || (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon')) continue
          if (dist2(z.x, z.y, e.x, e.y) <= z.r ** 2) damage(st, by, e, z.dmg, 'phys', events, dirty, true)
        }
      }
      if (z.left > 0) keep.push(z)
      continue
    }
    if (z.skill === 'stasis') {
      if (st.tick > z.until) continue
      for (const e of Object.values(st.ents)) {
        if (e.hp <= 0 || !by || !isEnemyOf(st, by, e) || e.k !== 'hero') continue
        if (dist2(z.x, z.y, e.x, e.y) > z.r ** 2) continue
        e.buffs = addBuff(e.buffs, 'slow', z.slow, st.tick + 2)
        dirty.add(e.id)
      }
      z.t = (z.t || 0) + 1
      if (z.t % z.every === 0) {
        for (const e of Object.values(st.ents)) {
          if (e.hp <= 0 || !by || !isEnemyOf(st, by, e) || e.k !== 'hero') continue
          if (dist2(z.x, z.y, e.x, e.y) <= z.r ** 2) damage(st, by, e, z.dot, 'magic', events, dirty, true)
        }
      }
      keep.push(z)
    }
  }
  st.zones = keep
}

/* ---------- 兵线（§2.4：路径=主道直线对进；最近索敌+英雄转火） ---------- */
function spawnWave(st, dirty) {
  for (const team of ['A', 'B']) {
    const f = MAP.fountains[team]
    for (let i = 0; i < 4; i++) {
      const ranged = i === 3
      const stat = ranged ? CREEP.ranged : CREEP.melee
      const id = `c${team}${st.tick}-${i}`
      st.ents[id] = {
        id, k: 'creep', team, rng: ranged ? 1 : 0,
        x: f.x + ((i - 1.5) * 24) * 1000, y: f.y + (team === 'A' ? -PX(60) : PX(60)),
        hp: stat.hp, maxhp: stat.hp, atkT: 0, tg: null,
      }
      dirty.add(id)
    }
  }
}
function creepStep(st, events, dirty) {
  for (const e of Object.values(st.ents)) {
    if (e.k !== 'creep' || e.hp <= 0) continue
    if (e.atkT > 0) e.atkT--
    const stat = e.rng ? CREEP.ranged : CREEP.melee
    let tg = e.tg ? st.ents[e.tg] : null
    if (tg && (tg.hp <= 0 || tg.dead)) { tg = null; e.tg = null }
    if (tg && dist2(e.x, e.y, tg.x, tg.y) > (stat.range + PX(80)) ** 2) { tg = null; e.tg = null }
    if (!tg) {
      let bd = CREEP_AGGRO * CREEP_AGGRO, heroAtt = null
      for (const o of Object.values(st.ents)) {
        if (o.hp <= 0 || o.dead || !isEnemyOf(st, e, o)) continue
        if (o.k !== 'creep' && o.k !== 'hero' && o.k !== 'tw' && o.k !== 'core') continue
        const d = dist2(e.x, e.y, o.x, o.y)
        if (o.k === 'hero' && d <= PX(120) ** 2) {
          // 敌英雄 120px 内攻击己方英雄 → 转火 3s（换血成本，§2.4）
          const att = st.sessions[o.seat] ? o : null
          void att
          const victims = Object.values(st.ents).filter((v) => v.k === 'hero' && v.team === e.team && !v.dead && (st.sessions[v.seat].hitBy[o.seat] || -99) >= st.tick - ATKR)
          if (victims.length) { heroAtt = o; break }
        }
        if (d < bd) { bd = d; tg = o }
      }
      if (heroAtt) tg = heroAtt
    }
    const goal = { x: LANE_X, y: e.team === 'A' ? 0 : H } // 对进至敌水晶
    if (!tg) {
      const core = st.ents[ENEMY[e.team] === 'A' ? 'core-A' : 'core-B']
      if (core && !core.inv && Math.abs(e.x - LANE_X) < PX(30) && Math.abs(e.y - core.y) < PX(40)) tg = core
    }
    if (tg) {
      const d = Math.hypot(tg.x - e.x, tg.y - e.y) || 1
      if (d <= stat.range) {
        if (e.atkT <= 0) {
          if (tg.k === 'core' || tg.k === 'tw') {
            if (tg.inv) { e.tg = null } else { damage(st, e, tg, stat.ad, 'phys', events, dirty); e.atkT = stat.int }
          } else { damage(st, e, tg, stat.ad, 'phys', events, dirty); e.atkT = stat.int }
          e.tg = tg.id
        }
      } else {
        moveStep(e, Math.round((tg.x - e.x) / d * 100), Math.round((tg.y - e.y) / d * 100), CREEP_SPD, st.collide)
        e.tg = tg.id
        dirty.add(e.id)
      }
    } else {
      const d = Math.hypot(goal.x - e.x, goal.y - e.y) || 1
      moveStep(e, Math.round((goal.x - e.x) / d * 100), Math.round((goal.y - e.y) / d * 100), CREEP_SPD, st.collide)
      dirty.add(e.id)
    }
  }
}

/* ---------- 野区营地+圣所（§2.5：aggro 60/leash 140/重置） ---------- */
function campStep(st, events, dirty) {
  // 营地重生
  for (const c of st.camps) {
    if (!st.ents['m' + c.id] && c.nextAt > 0 && st.tick >= c.nextAt) {
      spawnMon(st, c.id, c.camp, c.x, c.y, dirty)
      c.nextAt = 0
    }
  }
  // 圣所
  if (!st.ents['mshrine'] && st.shrine.nextAt > 0 && st.tick >= st.shrine.nextAt) {
    spawnMon(st, 'shrine', 'shrine', PX(500), PX(850), dirty)
    events.push({ k: 'shrine-up', at: st.tick })
    st.shrine.nextAt = 0
  }
  for (const e of Object.values(st.ents)) {
    if (e.k !== 'mon' || e.hp <= 0) continue
    if (e.atkT > 0) e.atkT--
    const stat = CAMP_STAT[e.camp]
    let tg = e.tg ? st.ents[e.tg] : null
    if (tg && (tg.hp <= 0 || tg.dead)) { tg = null; e.tg = null }
    const home = { x: e.hx, y: e.hy }
    const dHome = Math.hypot(e.x - home.x, e.y - home.y)
    if (e.camp !== 'shrine' && dHome > MON_LEASH) { // 脱离 leash：回营满血重置
      e.tg = null; e.hp = e.maxhp
      const d = dHome || 1
      moveStep(e, Math.round((home.x - e.x) / d * 100), Math.round((home.y - e.y) / d * 100), PX(120) / 10, st.collide)
      dirty.add(e.id)
      continue
    }
    if (!tg) {
      let bd = MON_AGGRO * MON_AGGRO
      for (const o of Object.values(st.ents)) {
        if (o.k !== 'hero' || o.dead || o.hp <= 0) continue
        const d = dist2(e.x, e.y, o.x, o.y)
        if (d < bd) { bd = d; tg = o }
      }
      if (st.tick - (e.lastHit || -99) <= ATKR && e.lastBy) { const o = st.ents[e.lastBy]; if (o && o.hp > 0) tg = o } // 被打还手
    }
    if (tg) {
      const d = Math.hypot(tg.x - e.x, tg.y - e.y) || 1
      if (d <= MON_RANGE) {
        if (e.atkT <= 0) { damage(st, e, tg, stat.ad, 'phys', events, dirty); e.atkT = stat.int }
        e.tg = tg.id
      } else {
        moveStep(e, Math.round((tg.x - e.x) / d * 100), Math.round((tg.y - e.y) / d * 100), PX(110) / 10, st.collide)
        e.tg = tg.id; dirty.add(e.id)
      }
    } else if (e.x !== e.hx || e.y !== e.hy) {
      const d = Math.hypot(home.x - e.x, home.y - e.y) || 1
      moveStep(e, Math.round((home.x - e.x) / d * 100), Math.round((home.y - e.y) / d * 100), PX(110) / 10, st.collide)
      dirty.add(e.id)
    }
    // 毒（无：营地怪无 DoT 面）
  }
}
function spawnMon(st, id, camp, x, y, dirty) {
  const stat = CAMP_STAT[camp]
  st.ents['m' + id] = { id: 'm' + id, k: 'mon', camp, team: null, x, y, hx: x, hy: y, hp: stat.hp, maxhp: stat.hp, atkT: 0, tg: null, lastHit: -99, lastBy: null }
  if (dirty) dirty.add('m' + id)
}

/* ---------- 塔（§2.3：兵优先、越塔打英雄转火 3s） ---------- */
function towerStep(st, events, dirty) {
  for (const e of Object.values(st.ents)) {
    if (e.k !== 'tw' || e.hp <= 0) continue
    if (e.atkT > 0) e.atkT--
    let tg = e.tg ? st.ents[e.tg] : null
    if (tg && (tg.hp <= 0 || tg.dead)) { tg = null; e.tg = null }
    const aggro = e.agUntil > st.tick && tg && tg.id === e.tg
    if (!aggro) {
      let bestC = null, bdC = Infinity, bestH = null, bdH = Infinity
      for (const o of Object.values(st.ents)) {
        if (o.hp <= 0 || o.dead || !isEnemyOf(st, e, o)) continue
        if (o.k !== 'creep' && o.k !== 'hero') continue
        const d = dist2(e.x, e.y, o.x, o.y)
        if (d > TOWER_R * TOWER_R) continue
        if (o.k === 'creep' ? d < bdC : d < bdH) { if (o.k === 'creep') { bdC = d; bestC = o } else { bdH = d; bestH = o } }
      }
      tg = bestC || bestH
      e.tg = tg ? tg.id : null
    }
    if (tg && e.atkT <= 0) {
      damage(st, e, tg, e.ad, 'phys', events, dirty)
      e.atkT = TOWER_INT
      events.push({ k: 'shot', by: e.id, from: [e.x, e.y], to: [tg.x, tg.y], speed: PX(600) / 10 })
    }
  }
}

/* ---------- tick 末原子裁决（§5.3：死亡/击杀/推塔/营地/圣所 ruling 账本） ---------- */
function rulingPass(st, events, dirty) {
  const dead = []
  for (const e of Object.values(st.ents)) if (e.hp <= 0 && !e.dead) dead.push(e)
  for (const e of dead) {
    if (e.k === 'hero') {
      const s = st.sessions[e.seat]
      const killerSeat = lastDamager(st, e)
      const killerS = killerSeat != null ? st.sessions[killerSeat] : null
      const assists = []
      for (let i = 0; i < 6; i++) {
        if (i === e.seat || i === killerSeat) continue
        const os = st.sessions[i]
        if (!os || os.team === s.team) continue
        if ((s.hitBy[i] || -99) >= st.tick - 50) assists.push(i) // 参与判定：近期 5s 内伤害过受害者（§2.6）
      }
      const pre = killerS ? killerS.streak : 0
      const bounty = killerS ? Math.min(150 + 30 * pre, 300) : 0
      e.dead = 1
      e.respAt = st.tick + (50 + 20 * e.lv)
      e.cc = null; e.buffs = []; e.sh = 0; e.tg = null; e.cast = null; e.rec = 0
      e.poison = null
      if (killerS) {
        killerS.streak = pre + 1
        killerS.k++
        killerS.gold += bounty
        giveXp(st, killerSeat, 120 + 30 * e.lv, dirty)
      }
      const near = assists.filter((i) => st.ents['h' + i] && dist2(st.ents['h' + i].x, st.ents['h' + i].y, e.x, e.y) <= ASSIST_R ** 2)
      if (near.length) {
        const pool = 60 + 15 * e.lv
        const each = Math.floor(pool / near.length)
        for (const i of near) { st.sessions[i].gold += each; st.sessions[i].a++; giveXp(st, i, each, dirty) }
      }
      s.d++
      s.streak = 0
      s.hitBy = {}
      s.buffRune = 0 // 死亡清灵纹（§1.5）
      if (killerS) st.stats.kills[ENEMY[s.team]]++ // 超时裁定口径：只记英雄击杀（世界击杀不计团队账）
      dirty.add(e.id)
      events.push({ k: 'kill', frame: st.tick, victim: e.seat, killer: killerSeat == null ? -1 : killerSeat, assists: near, streak: killerS ? killerS.streak : 0, bounty, lv: e.lv, respAt: e.respAt })
    } else if (e.k === 'creep') {
      const stat = e.rng ? CREEP.ranged : CREEP.melee
      const kSeat = lastDamager(st, e)
      if (kSeat != null && st.sessions[kSeat]) st.sessions[kSeat].gold += stat.gold // 金=最后一下（补刀）
      // XP=共享：260px 内己方英雄均分（余数给最近者）
      const allies = []
      for (let i = 0; i < 6; i++) {
        const h = st.ents['h' + i]
        if (!h || h.dead || !st.sessions[i]) continue
        if (TEAM_OF(i) === e.team) continue
        if (dist2(h.x, h.y, e.x, e.y) <= XP_SHARE_R ** 2) allies.push({ i, d: dist2(h.x, h.y, e.x, e.y) })
      }
      if (allies.length) {
        allies.sort((a, b) => a.d - b.d)
        const each = Math.floor(stat.xp / allies.length)
        let rem = stat.xp - each * allies.length
        for (const a of allies) giveXp(st, a.i, each + (rem-- > 0 ? 1 : 0), dirty)
      }
      delete st.ents[e.id]
    } else if (e.k === 'mon') {
      const kSeat = lastDamager(st, e)
      const stat = CAMP_STAT[e.camp]
      const team = kSeat != null && st.sessions[kSeat] ? st.sessions[kSeat].team : null
      if (e.camp === 'shrine') {
        if (team) {
          for (let i = 0; i < 6; i++) if (st.sessions[i] && st.sessions[i].team === team) st.sessions[i].gold += stat.gold
          st.bless = { team, until: st.tick + 600 } // 祝祷 60s：对建筑 +25%
          // XP 参战分（近期伤害者）
          const parts = []
          for (let i = 0; i < 6; i++) if (st.sessions[i] && st.sessions[i].team === team && (e.hitBy ? e.hitBy[i] : -99) >= st.tick - 300) parts.push(i)
          for (const i of parts) giveXp(st, i, Math.floor(stat.xp / Math.max(1, parts.length)), dirty)
          events.push({ k: 'shrine', frame: st.tick, team, by: kSeat ?? -1 })
        }
        st.shrine.nextAt = st.tick + SHRINE_RESPAWN
        delete st.ents[e.id]
      } else {
        if (kSeat != null && st.sessions[kSeat]) {
          st.sessions[kSeat].gold += stat.gold
          giveXp(st, kSeat, stat.xp, dirty)
          if (e.camp === 'rune') {
            st.sessions[kSeat].buffRune = st.tick + 450 // 灵纹 45s：AD+20 & 技伤+10%
            const h = st.ents['h' + kSeat]
            if (h) { h.buffs = addBuff(h.buffs, 'rune', 256, st.tick + 450); dirty.add(h.id) }
          }
        }
        const c = st.camps.find((c) => 'm' + c.id === e.id)
        if (c) c.nextAt = st.tick + stat.respawn
        events.push({ k: 'camp', camp: e.camp, by: kSeat ?? -1, buff: e.camp === 'rune' && kSeat != null ? 1 : 0 })
        delete st.ents[e.id]
      }
    } else if (e.k === 'tw') {
      const kSeat = lastDamager(st, e)
      const enemyTeam = ENEMY[e.team]
      const teamGold = e.tier === 1 ? 125 : 150
      const soloGold = e.tier === 1 ? 50 : 60
      for (let i = 0; i < 6; i++) if (st.sessions[i] && st.sessions[i].team === enemyTeam) st.sessions[i].gold += teamGold
      if (kSeat != null && st.sessions[kSeat]) st.sessions[kSeat].gold += soloGold
      st.stats.towers[enemyTeam] += e.tier
      delete st.ents[e.id]
      // 无敌链解除（§2.3）：T1 破 → T2 可伤；T2 破 → 水晶可伤（invuln 标志随 tower ruling 解除）
      if (e.tier === 1) { const t2 = st.ents[`tw-${e.team}2`]; if (t2) { t2.inv = 0; dirty.add(t2.id) } }
      if (e.tier === 2) { const core = st.ents[`core-${e.team}`]; if (core) { core.inv = 0; dirty.add(core.id) } }
      events.push({ k: 'tower', frame: st.tick, team: e.team, tid: e.id, by: kSeat ?? -1, teamGold, tier: e.tier })
    } else if (e.k === 'core') {
      delete st.ents[e.id]
      st.coreDown = e.team // GAMES-133 O5：终局旗——实体当拍已删，phase 11 按存在性查
      // hp≤0 永不命中=core-down 终局从未触发（全剧本零 core-down 的底层根因）
      events.push({ k: 'core', frame: st.tick, team: e.team })
    }
  }
  // 毒（跳伤）
  for (let seat = 0; seat < 6; seat++) {
    const h = st.ents['h' + seat]
    if (!h || h.dead || !h.poison) continue
    const p = h.poison
    p.t++
    if (p.t % p.every === 0 && p.left > 0) {
      p.left--
      const by = st.ents['h' + p.by]
      if (by) damage(st, by, h, p.dmg, 'magic', events, dirty, true)
      if (p.left <= 0) h.poison = null
    }
  }
}
function lastDamager(st, e) {
  // 死亡归属：最新一条账目在 2 tick 内且为英雄源才记名；否则=塔/兵/泉/世界击杀
  // killer=-1（§5.3 规则 1"塔/兵击杀 killer=-1"——泉水处决同归世界，不回溯记名）
  if (e.dmgLog && e.dmgLog.length) {
    const rec = e.dmgLog[e.dmgLog.length - 1]
    if (st.tick - rec.t <= 2 && rec.bySeat != null) {
      const src = st.ents[rec.by]
      if (src && src.k === 'hero' && !src.dead) return rec.bySeat
    }
  }
  return null
}
function giveXp(st, seat, xp, dirty) {
  const s = st.sessions[seat]
  if (!s) return
  s.xp += xp
  while (s.lv < 9 && s.xp >= EXP_LV[s.lv - 1]) {
    s.lv++
    const h = st.ents['h' + seat]
    if (h) {
      h.lv = s.lv
      const stats = heroStats(seat, s)
      const gain = stats.hp - h.maxhp
      h.maxhp = stats.hp
      h.hp += Math.max(0, gain)
      dirty.add(h.id)
    }
  }
}

// 伤害来源记账已并入 damage() 唯一入口（dmgLog/hitBy/lastBy）

/* =====================================================================
 * Bot 三档（§4：优先级行为栈仲裁器 P0-P8 + 滞回防抖；决策间隔 10/6/4）
 * ===================================================================== */
const BOT_EVERY = { casual: 10, balanced: 6, competitive: 4 }
const RETREAT_HP = { casual: 0.25, balanced: 0.34, competitive: 0.34 }
const COMBO = { // 英雄连招表（§4.1：competitive P1 序列）
  guard: ['s1', 'a', 'a'], ranger: ['s1', 'a', 'a', 's0'], mage: ['s0', 's1', 'a'], shadow: ['s0', 's1', 'a', 's2'],
}
function underSiege(st, team) { // 己方建筑 350px 内有敌方兵线（围攻态）：击杀窗不换线推塔，留守清防
  for (const b of Object.values(st.ents)) {
    if ((b.k !== 'tw' && b.k !== 'core') || b.team !== team || b.hp <= 0) continue
    for (const o of Object.values(st.ents)) {
      if (o.k !== 'creep' || o.team === team || o.hp <= 0) continue
      if (dist2(o.x, o.y, b.x, b.y) < PX(350) ** 2) return true
    }
  }
  return false
}
function brain(st, seat, level, rng, env) {
  const h = st.ents['h' + seat]
  const s = st.sessions[seat]
  if (!h || !s) return { mx: 0, my: 0 }
  const out = { mx: 0, my: 0 }
  if (h.dead) { s.mem.dt = 0; return out }
  /* 放水链（GAMES-130，§4.3 让力模式启用）：敌队真人连败（rooms.js pulse→foeLose，
   * 团队作信号源=META.pulseTeam 按队记）→ L1 让力 / L2 重败降档。bot 对 bot 全力
   * （kinds 无 human 即零放水）——梯度剧本/冻结门禁零扰动；噪声只耗本席 rng 流
   * （同 seed 同 env 同路径，确定性口径 §6 不破）。 */
  const mercy = (env && env.mercy) || MERCY_CFG
  const isHuman = env && env.kinds ? (x) => env.kinds[x] === 'human' : () => false
  let mercyDeg = 0
  if (env && env.foeLose) {
    for (const e of Object.values(st.ents)) {
      if (e.k !== 'hero' || e.dead || e.team === h.team || !isHuman(e.seat)) continue
      const L = env.foeLose[e.seat] || 0
      if (L >= mercy.hardFoeLose) mercyDeg = 2
      else if (L >= mercy.minFoeLose && mercyDeg < 1) mercyDeg = 1
    }
  }
  if (mercyDeg >= 2 && level !== 'casual') level = level === 'competitive' ? 'balanced' : 'casual' // L2 行为栈降档（让力可观测：决策间隔/撤退阈值/栈开放度随档）
  const mem = s.mem
  const my = h.team === 'A' ? -1 : 1 // 行进方向（A 向上）
  const fount = MAP.fountains[h.team]
  const steer = (x, y, stopR = PX(26)) => {
    const d = Math.hypot(x - h.x, y - h.y)
    if (d <= stopR) return 0
    const m = d < PX(90) ? Math.round(d / PX(90) * 100) : 100
    out.mx = Math.round((x - h.x) / d * m); out.my = Math.round((y - h.y) / d * m)
    return d
  }
  const heroes = (team) => Object.values(st.ents).filter((e) => e.k === 'hero' && e.team === team && !e.dead)
  const foes = heroes(ENEMY[h.team])
  const mates = heroes(h.team).filter((e) => e.seat !== seat)
  const creeps = (team) => Object.values(st.ents).filter((e) => e.k === 'creep' && e.team === team && e.hp > 0)
  const front = (team) => { // 最前兵（A: y 最小；B: y 最大）
    const cs = creeps(team)
    if (!cs.length) return null
    return cs.reduce((a, b) => (my < 0 ? (a.y < b.y ? a : b) : (a.y > b.y ? a : b)))
  }
  const nearFoe = (r) => {
    const inR = foes.filter((f) => dist2(h.x, h.y, f.x, f.y) < r * r)
    if (!inR.length) return null
    return inR.sort((a, b) => a.hp / a.maxhp - b.hp / b.maxhp)[0] // P2 目标仲裁：最低 HP（§4.1；balanced/casual 路径，字节不动）
  }
  /* 目标评估（GAMES-130 深化，落设计 §4.1 competitive 分化位）：有效 HP（HP%÷(1+
   * 近期受击×0.12)——30s 内挨打≈状态差）×威胁（等级高=carry 优先）加权取最小；
   * L2 放水评估噪声 rng 扰动（让力观感=选目标失准）。免猎：L1 连败真人不作主动目标。 */
  const pickFoe = (list) => {
    let best = null, bestS = Infinity
    for (const f of list) {
      if (mercyDeg >= 1 && isHuman(f.seat)) continue
      let hurt = 0
      if (f.dmgLog) for (const d of f.dmgLog) if (d.t >= st.tick - 300) hurt++
      let sc = (f.hp / f.maxhp) / (1 + hurt * 0.12) * (1 - 0.04 * (f.lv - 1))
      if (mercyDeg >= 2) sc += (rng() - 0.5) * 0.3
      if (sc < bestS) { bestS = sc; best = f }
    }
    return best
  }
  const myRange = heroStats(seat, s).range
  const hpPct = h.hp / h.maxhp
  const ad = heroAd(st, h)

  /* 决策拍（N tick 一次）：行为栈 P0..P8 首激活胜出（§4.1） */
  if (mem.dt <= 0) {
    mem.dt = BOT_EVERY[level] || 6
    mem.cmd = null
    mem.win = 0
    const foe = nearFoe(PX(420))
    const enemyT1 = st.ents[`tw-${ENEMY[h.team]}1`], enemyT2 = st.ents[`tw-${ENEMY[h.team]}2`], enemyCore = st.ents[`core-${ENEMY[h.team]}`]
    const pushTarget = enemyT1 && !enemyT1.hp <= 0 ? enemyT1 : enemyT2 || enemyCore // 推塔序
    const curT = st.ents[mem.tg]

    // P0 生存撤退
    if (hpPct < RETREAT_HP[level]) {
      mem.mode = 'retreat'; mem.tg = null
      if (level === 'competitive' && h.hero === 'ranger' && h.cd[0] <= 0) mem.cmd = { k: 'skill', idx: 0 } // wind 逃生
    }
    // P0.5 击杀窗推塔（GAMES-129 O2：敌队有阵亡=复活缺席窗 7-23s，推塔优先级提升——
    // 压制 P1/P2/P6/P7（连招/游走抢占致 competitive 战损 7:1 而存塔 0:1 超时倒挂，
    // QA1 §5））。窗口判据=目标体（敌塔序首活）350px 内无敌方存活英雄（同 lane 推塔
    // towerOpen 半径）：敌人围着我不放行（战斗栈继续），敌人缺席/回撤即放行——复用
    // lane 模式随波推塔（贴兵线/塔射程外待兵/复活即让位））
    else if (level === 'competitive' && st.tick > 600 && foes.length < 3 && pushTarget &&
             !foes.some((f) => dist2(f.x, f.y, pushTarget.x, pushTarget.y) < PX(350) ** 2) &&
             !underSiege(st, h.team)) {
      mem.mode = 'lane'; mem.tg = null; mem.atk = null; mem.win = 1
    }
    // P1 连招（competitive；目标评估=有效 HP×威胁加权 pickFoe，GAMES-130 深化落 §4.1；
    // L1 让力不放连招（§4.3）——同目标降级 harass 单技+普攻）
    else if (level === 'competitive' && hpPct > 0.45) {
      const inR = foes.filter((f) => dist2(h.x, h.y, f.x, f.y) < (myRange + PX(180)) ** 2)
      const pick = pickFoe(inR)
      if (pick) { mem.mode = mercyDeg >= 1 ? 'harass' : 'combo'; mem.tg = pick.id; mem.step = 0 }
      else mem.mode = '_'
    }
    // P2 集火（团战态：300px 内 ≥3 英雄）
    else if (level === 'competitive') {
      /* P2 集火：团战态（300px 内 ≥3 英雄）或集火 ping 或队友 600px 内交战（3 人抱团
       * 快于 2 人——competitive 的团队滚动窗，§4.2 游走预判）；仲裁目标=pickFoe
       * （GAMES-130：集火目标同 P1 评估口径，非纯最低 HP） */
      const crowd = [...foes, ...mates].filter((e) => dist2(h.x, h.y, e.x, e.y) < PX(300) ** 2).length
      const ping = st.pings.find((p) => p.mark === 'focus' && p.at >= st.tick - 50 && s.team === TEAM_OF(p.seat))
      const mateFight = mates.some((m) => foes.some((f) => dist2(m.x, m.y, f.x, f.y) < PX(600) ** 2))
      const pick2 = pickFoe(foes.filter((f) => dist2(h.x, h.y, f.x, f.y) < PX(420) ** 2))
      if ((crowd >= 3 || ping || mateFight) && pick2) { mem.mode = mercyDeg >= 1 ? 'harass' : 'combo'; mem.tg = pick2.id; mem.step = 0 }
      else mem.mode = '_'
    } else mem.mode = '_'

    if (mem.mode === '_') {
      // P3/P3' 补刀（casual=随手打兵；窗口系数 ×1.0/×0.9，§4.2；L2 放水噪声=补刀窗
      // 抖动 0.85-1.15×ad——让力观感，rng 只在放水路径消耗=确定性保持）
      mem.atk = null
      const cs = creeps(ENEMY[h.team]).filter((c) => dist2(h.x, h.y, c.x, c.y) < (myRange + PX(60)) ** 2)
      if (cs.length) {
        const low = cs.reduce((a, b) => (a.hp < b.hp ? a : b))
        const win = level === 'casual' ? true : level === 'balanced'
          ? (mercyDeg >= 2 ? low.hp <= Math.ceil(ad * (0.85 + rng() * 0.3)) : low.hp <= ad)
          : low.hp <= Math.ceil(ad * 0.9)
        if (win) mem.atk = low.id
      }
      // P5 换血（balanced+：HP 优 15% 或 competitive 更主动；L1/L2 让力阈值上调 0.30，
      // §4.3「换血时机阈值上调」——bot 对 bot 零放水时 balanced 字节不动）
      if (mem.mode === '_' || mem.mode === 'lane') {
        if (level !== 'casual' && foe && dist2(h.x, h.y, foe.x, foe.y) < myRange ** 2) {
          const foeH = foe.hp / foe.maxhp
          const edge = mercyDeg >= 1 ? 0.30 : (level === 'competitive' ? 0 : 0.15)
          if (hpPct > foeH + edge) { mem.mode = 'harass'; mem.tg = foe.id }
        }
      }
      // P6 资源（balanced+：空闲且附近营地已刷；competitive 收窄 400→260px——顺路才刷，
      // 离线打野=兵线失护（GAMES-129 O2））。生态位让位（GAMES-130）：营地 320px 内有
      // 同队真人 → 让资源（真人进房成长期，camp 让位=solo 线权）
      if (mem.mode === '_' && level !== 'casual' && !foe) {
        const campR = level === 'competitive' ? PX(260) : PX(400)
        const mon = Object.values(st.ents).find((e) => e.k === 'mon' && e.camp !== 'shrine' && dist2(h.x, h.y, e.x, e.y) < campR ** 2)
        if (mon && !mates.some((m) => isHuman(m.seat) && dist2(m.x, m.y, mon.x, mon.y) < PX(320) ** 2)) { mem.mode = 'camp'; mem.tg = mon.id }
      }
      // P7 游走（competitive）：圣所已刷才游走（GAMES-129 O2——旧"30s 内将刷"预判
      // 令 3 人空站中场等刷=兵线失护被打空（QA1 实测 mineY=none 过半采样），游走
      // 只在可立即收割时触发：mshrine 在场 → 走位贴打；队友交战支援保留）
      if (mem.mode === '_' && level === 'competitive') {
        const mateFight = mates.some((m) => foes.some((f) => dist2(m.x, m.y, f.x, f.y) < PX(300) ** 2))
        if (st.ents['mshrine'] || mateFight) { mem.mode = 'roam' }
      }
      // P8 回城补给
      if (mem.mode === '_') {
        const nextItem = ROUTE[s.hero].find((x) => !s.items.includes(x))
        const lineY = (front(h.team) || { y: h.y }).y
        const laneSafe = my < 0 ? lineY < PX(850) : lineY > PX(850) // 兵线在敌半场
        if (hpPct < 0.35 || (nextItem && s.gold >= ITEMS[nextItem].cost && laneSafe)) { mem.mode = 'home'; mem.recSent = false }
      }
    }
  }
  mem.dt--

  /* 连续输出拍（模式执行） */
  if (mem.mode === 'retreat') {
    steer(fount.x, fount.y, PX(30))
    if (hpPct > 0.92) mem.dt = 0
  } else if (mem.mode === 'combo' || mem.mode === 'harass') {
    const tg = st.ents[mem.tg]
    if (!tg || tg.dead || tg.hp <= 0) { mem.dt = 0; mem.mode = 'lane' }
    else if (inFount(st, tg, ENEMY[h.team])) { mem.dt = 0; mem.mode = 'lane' } // 不追进敌泉水（§2.1 防蹲泉）
    else {
      const d = Math.hypot(tg.x - h.x, tg.y - h.y)
      if (level === 'competitive' && hpPct < RETREAT_HP[level]) { mem.dt = 0; mem.mode = 'retreat' } // GAMES-130 连招链打磨：血崩即时断（不等决策拍 4 tick=塔下挨打窗，P0 语义前移）
      else if (level === 'competitive' && d > PX(860)) { mem.dt = 0; mem.mode = 'lane' } // GAMES-129 O2：深追逃敌越塔=塔伤+回撤节奏黑洞（QA1 y=439 实证），弃追归线（balanced harass 不动）
      else {
      const want = myRange - PX(10)
      if (d > want) steer(tg.x, tg.y, want)
      else if (d < myRange * 0.5 && myRange > PX(80)) steer(h.x - (tg.x - h.x), h.y - (tg.y - h.y), 0) // 游侠拉距
      const seq = COMBO[h.hero] || ['a']
      if (mem.mode === 'combo' && level === 'competitive') {
        const stepCode = seq[mem.step % seq.length]
        const idx = stepCode[1] | 0
        if (stepCode === 'a' || h.cd[idx] > 0) out.cmd = { k: 'atk', entId: tg.id }
        else out.cmd = { k: 'skill', idx, entId: tg.id }
        mem.step++
      } else {
        // harass：单技+普攻（balanced P5；casual 不在此模式）
        const rdy = [0, 1, 2].filter((i) => h.cd[i] <= 0 && (!SKILLS[h.hero][i].ult || h.lv >= SKILLS[h.hero][i].ult))
        if (rdy.length && dist2(h.x, h.y, tg.x, tg.y) < (SKILLS[h.hero][rdy[0]].range || myRange) ** 2 + CHASE_PAD ** 2) out.cmd = { k: 'skill', idx: rdy[0], entId: rdy[0] === 0 && h.hero === 'ranger' ? undefined : tg.id }
        else out.cmd = { k: 'atk', entId: tg.id }
      }
      }
    }
  } else if (mem.mode === 'camp') {
    const mon = st.ents[mem.tg]
    if (!mon || mon.hp <= 0) mem.dt = 0
    else {
      steer(mon.x, mon.y, PX(40))
      if (dist2(h.x, h.y, mon.x, mon.y) < (myRange + PX(10)) ** 2) out.cmd = { k: 'atk', entId: mon.id }
    }
  } else if (mem.mode === 'roam') {
    /* GAMES-130 游走支援深化：有交战队友 → 向其位置支援（旧=固定中场点，支援意图
     * 落空——mates 序确定，首个交战者）；无交战 → 圣所位。 */
    const aim = mates.find((m) => foes.some((f) => dist2(m.x, m.y, f.x, f.y) < PX(600) ** 2))
    if (aim) steer(aim.x, aim.y, PX(160))
    else steer(PX(500), PX(850), PX(60))
    const foe = nearFoe(myRange + PX(60))
    if (foe) { out.cmd = { k: 'atk', entId: foe.id }; mem.mode = mercyDeg >= 1 ? 'harass' : 'combo'; mem.tg = foe.id; mem.step = 0 } // L1 让力：游走接敌同样不放连招
    /* 圣所让位（GAMES-130 生态位让位）：同队真人距圣所不比我远 → 不抢（bless 归
     * 真人，bot 只清场不收 buff） */
    else if (st.ents['mshrine'] && dist2(h.x, h.y, PX(500), PX(850)) < (myRange + PX(80)) ** 2 &&
             !mates.some((m) => isHuman(m.seat) && dist2(m.x, m.y, PX(500), PX(850)) <= dist2(h.x, h.y, PX(500), PX(850)))) out.cmd = { k: 'atk', entId: 'mshrine' }
  } else if (mem.mode === 'home') {
    if (!mem.recSent && !inFount(st, h, h.team) && !h.rec) { out.cmd = { k: 'recall' }; mem.recSent = true }
    if (h.rec) { /* 引导中：站定 */ }
    else if (inFount(st, h, h.team)) {
      const next = ROUTE[s.hero].find((x) => !s.items.includes(x))
      if (next && s.gold >= ITEMS[next].cost) out.cmd = { k: 'buy' }
      if (hpPct > 0.9) mem.dt = 0
    } else mem.recSent = false
  } else {
    /* lane：P4 站线/推线——站兵线后 30px 攻最近敌兵；线过半且无守备 → 推塔
     * （无守备=300px 内无敌方英雄：有守备守线、无守备随波推塔；塔下强杀风险由
     *  P0 撤退阈值兜底——越塔窗口的代价机制 §2.3 由此成立） */
    const mine = front(h.team)
    const foes2 = creeps(ENEMY[h.team]).filter((c) => dist2(h.x, h.y, c.x, c.y) < PX(300) ** 2)
    const foeHeroNear = nearFoe(PX(320))
    if (mem.atk && st.ents[mem.atk]) out.cmd = { k: 'atk', entId: mem.atk }
    else if (foes2.length) out.cmd = { k: 'atk', entId: foes2[0].id }
    const enemyT1 = st.ents[`tw-${ENEMY[h.team]}1`]
    const enemyT2 = st.ents[`tw-${ENEMY[h.team]}2`]
    const core = st.ents[`core-${ENEMY[h.team]}`]
    const tgT = enemyT1 && enemyT1.hp > 0 ? enemyT1 : enemyT2 && enemyT2.hp > 0 ? enemyT2 : core
    const waveAtTower = tgT && mine && dist2(mine.x, mine.y, tgT.x, tgT.y) < (TOWER_R + PX(60)) ** 2
    const pastMid = mine && (my < 0 ? mine.y < PX(850) : mine.y > PX(850))
    /* 击杀窗判定（§1.1 复活缺席窗=推塔决策窗）：目标塔 500px 内无敌方存活英雄
     * （被击退/击杀/回城中）→ 裸推塔成立（兵抗塔 OR 守方缺席二选一即可贴塔） */
    /* GAMES-133 O5：有效守备=目标 350px 内且在己泉外的敌英雄——旧口径把泉中回城/
     * 挂机席也计为守备（泉水中心=水晶位，挂机席永坐泉边把 towerOpen 压死=T2 破后
     * 4100 tick 零 core-down 的直接根因，QA2 O5）；守备须在泉外可交战位才成立。
     * 收尾意识（closer）=balanced/competitive 档（casual=不会收局的散人：镜像
     * casual 双方都收不了局=超时裁定（探针实测零塔破），也避免 A2 剧本 B 方 casual
     * 反推平 push-lane 真人（首版实测 4816 tick B core-down 翻红门禁） */
    const closer = level !== 'casual'
    const towerOpen = tgT && !foes.some((f) => dist2(f.x, f.y, tgT.x, tgT.y) < PX(350) ** 2 && !(closer && tgT.k === 'core' && inFount(st, f, f.team)))
    /* GAMES-129 O2：击杀窗（mem.win）内只随兵贴塔（兵抗塔）——裸贴返场守军=塔下
     * 折损（对 casual 实测 kills 7:1→2:3）；窗内守方缺席本就常态，waveAtTower
     * 即可成立，非窗保持原 pastMid&&(waveAtTower||towerOpen) 口径。
     * GAMES-133 O5 终局放宽（仅 closer 档）：目标=水晶（T2 已破）时胜利条件在场，
     * pastMid 即推——远程贴泉沿 plink（停位=max(射程-10, 泉半径+12)：游侠 160 射程
     * 白嫖、法师/近战泉沿压场随兵推进，泉烧 400/s 由停位半径挡在圈外）；塔段不变 */
    const siegeOk = (closer && tgT && tgT.k === 'core') ? pastMid : (mem.win ? pastMid && waveAtTower : pastMid && (waveAtTower || towerOpen))
    if (tgT && st.tick > 600 && siegeOk) {
      // 推塔窗（§2.8b）：贴兵线推进——兵进塔射程（兵抗塔）贴身打塔；core 段停位
      // 半径须 ≤ 攻击阈值（否则 152>150 死区=停在泉沿永不 plink，首版实测坑）
      const dT = Math.hypot(tgT.x - h.x, tgT.y - h.y)
      const coreStop = Math.max(FOUNT_R + PX(12), myRange - PX(10))
      const stopR = tgT.k === 'core' ? coreStop : Math.max(PX(30), myRange - PX(10))
      const plinkR = tgT.k === 'core' ? Math.max(coreStop, myRange - PX(2)) : myRange - PX(10)
      if (dT <= plinkR) out.cmd = { k: 'atk', entId: tgT.id }
      else steer(tgT.x, tgT.y, stopR)
    } else if (tgT && pastMid && st.tick > 600) {
      // 有守备：塔射程外 40px 待兵（等波比送头强）
      const dT = Math.hypot(tgT.x - h.x, tgT.y - h.y)
      if (dT > TOWER_R + PX(40)) steer(clamp(mine.x + ((seat - 2.5) * 30) * 1000, 0, W), clamp(mine.y - my * PX(30), 0, H), PX(20))
      else steer(tgT.x, tgT.y, TOWER_R + PX(40))
    } else if (mine && (foeHeroNear || foes2.length)) {
      const holdY = mine.y - my * PX(30) // 站兵线后（己方侧）
      steer(clamp(mine.x + ((seat - 2.5) * 30) * 1000, 0, W), clamp(holdY, 0, H), PX(20))
    } else if (mine) {
      steer(clamp(mine.x + ((seat - 2.5) * 30) * 1000, 0, W), clamp(mine.y - my * PX(60), 0, H), PX(20))
    } else {
      steer(LANE_X, PX(850) - my * PX(100), PX(40)) // 无兵期保持中线压力（不再退回家塔）
    }
  }
  if (out.cmd && rng() < 0) void rng // rng 保留位（决策已零随机查表，§6 确定性口径）
  return out
}

/* =====================================================================
 * emit —— S2 二式快照组包（mmo 范式：AOI 视野圆+草丛加层+预算+自适应阈值）
 * ===================================================================== */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { known: new Set(), seq: 0, sinceFull: 0, lastFullBytes: 0, base: 0, force: true }; connState.set(ctx, b) }
  return b
}
function grassHidden(cx, cy, e, known) {
  if (e.k !== 'hero' && e.k !== 'creep' && e.k !== 'mon') return false
  for (const g of MAP.grass) {
    const r = GRASS_R + (known ? PX(10) : 0)
    if (dist2(e.x, e.y, g.x, g.y) <= r * r && dist2(cx, cy, g.x, g.y) > GRASS_SEE * GRASS_SEE) return true
  }
  return false
}
/* 实体线上视图（GAMES-129 O1）：快照只投影客户端消费字段——dmgLog/hitBy/lastHit/
 * lastBy/hx/hy 等服务端簿记（伤害账本/营地记忆）不入线，falsy 瞬态（cd 全 0/buffs
 * 空/cc 无/sh 0）省略（客户端 r.ent 整体替换语义下缺字段=falsy 默认，client.js 读取
 * 均已守卫）。实测常态 13.4→6.2KB/s、1s 滑窗峰值 35.4→16.7KB/s（<25 §5.6 预算）。 */
function entView(e) {
  const v = { id: e.id, k: e.k, team: e.team, x: e.x, y: e.y, hp: e.hp, maxhp: e.maxhp }
  if (e.k === 'hero') {
    v.hero = e.hero; v.lv = e.lv; v.dir = e.dir
    if (e.cd && (e.cd[0] > 0 || e.cd[1] > 0 || e.cd[2] > 0)) v.cd = e.cd
    if (e.dead) { v.dead = 1; v.respAt = e.respAt }
    if (e.cc) v.cc = e.cc
    if (e.buffs && e.buffs.length) v.buffs = e.buffs
    if (e.sh > 0) v.sh = e.sh
  } else if (e.k === 'tw') {
    v.tier = e.tier; if (e.inv) v.inv = e.inv
  } else if (e.k === 'core') {
    if (e.inv) v.inv = e.inv
  } else if (e.k === 'creep') {
    if (e.rng) v.rng = e.rng
  } else if (e.k === 'mon') {
    v.camp = e.camp
  }
  return v
}
function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  let cx = PX(500), cy = PX(850), own = null
  if (ctxRec.seat >= 0) {
    own = st.ents['h' + ctxRec.seat]
    if (own) { cx = own.x; cy = own.y } else ctxRec.seat = -1
  } else {
    // 观战/死亡视角：AOI 以镜头点为准（导演模式=最近事件质心，客户端拖动接管）
    const c = room.__dirCam
    if (c) { cx = c.x; cy = c.y }
  }
  const cand = []
  for (const e of Object.values(st.ents)) {
    if (e.k === 'tw' || e.k === 'core') { cand.push({ e, d2: 0, stat: 1 }); continue } // 静态建筑：恒候选（§2.3）
    const d2 = dist2(cx, cy, e.x, e.y)
    if (d2 <= AOI_R * AOI_R || (b.known.has(e.id) && d2 <= AOI_OUT * AOI_OUT)) cand.push({ e, d2, stat: 0 })
  }
  if (cand.length > AOI_BUDGET) {
    cand.sort((a, c) => (a.stat - c.stat) || (c.d2 - a.d2))
    cand.length = AOI_BUDGET
  }
  const keep = new Set()
  const entsArr = []
  for (const c of cand) {
    if (grassHidden(cx, cy, c.e, b.known.has(c.e.id)) && c.e !== own) continue // 草丛加层（§5.2）
    keep.add(c.e.id)
  }
  const leave = []
  for (const id of b.known) if (!keep.has(id)) leave.push(id)
  const dirtySet = r ? r.dirty : null
  const sendIds = new Set()
  for (const id of keep) if (!b.known.has(id)) sendIds.add(id)
  if (dirtySet) for (const id of dirtySet) if (keep.has(id)) sendIds.add(id)
  if (own && keep.has(own.id)) sendIds.add(own.id)
  let full = opt.force || b.force || b.sinceFull >= FULL_EVERY || sendIds.size > FULL_DIRTY
  b.force = false
  if (own && keep.has(own.id)) entsArr.push(entView(own))
  if (full) {
    for (const c of cand) if (c.e !== own && keep.has(c.e.id)) entsArr.push(entView(c.e))
  } else {
    for (const id of sendIds) if ((!own || id !== own.id) && st.ents[id]) entsArr.push(entView(st.ents[id]))
  }
  const seat = ctxRec.seat
  const sess = seat >= 0 ? st.sessions[seat] : null
  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base,
    full: full ? 1 : 0, snapSeq: b.seq + 1,
    ext: {
      aoi: { x: cx, y: cy, r: AOI_R },
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
      t: { kills: st.stats.kills, towers: st.stats.towers, shrineAt: st.shrine.nextAt, bless: st.bless && st.bless.until > st.tick ? st.bless : null },
      me: sess ? { g: sess.gold, lv: sess.lv || 1, k: sess.k, d: sess.d, a: sess.a, items: sess.items, rune: sess.buffRune > st.tick ? 1 : 0 } : undefined,
    },
    ents: entsArr, leave: full ? [] : leave,
  }
  if (r && r.events && r.events.length) msg.events = r.events
  const text = JSON.stringify(msg)
  if (!full && b.lastFullBytes && text.length > b.lastFullBytes * 0.7) return emitOne(room, { ...ctxRec }, r, { force: true })
  b.seq++
  if (full) { b.lastFullBytes = text.length; b.base = st.tick; b.sinceFull = 0 } else b.sinceFull++
  b.known = keep
  if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}
function emit(room, r) {
  // 导演模式：镜头=最近 8s kill/tower/shrine 事件质心（§5.4）
  const evs = (r && r.events || []).filter((e) => e.k === 'kill' || e.k === 'tower' || e.k === 'shrine')
  if (evs.length) {
    const q = room.__dirQ || (room.__dirQ = [])
    for (const e of evs) {
      const pos = e.k === 'kill' ? entPos(room.state, e.victim) : e.k === 'shrine' ? { x: PX(500), y: PX(850) } : towerPos(e.tid)
      if (pos) q.push({ x: pos.x, y: pos.y, at: room.state.tick })
    }
    if (q.length > 16) q.splice(0, q.length - 16)
  }
  const st = room.state
  const q = room.__dirQ
  if (q && q.length) {
    const fresh = q.filter((p) => st.tick - p.at <= 80)
    if (fresh.length) {
      const cx = Math.round(fresh.reduce((a, p) => a + p.x, 0) / fresh.length)
      const cy = Math.round(fresh.reduce((a, p) => a + p.y, 0) / fresh.length)
      room.__dirCam = room.__dirCam ? { x: Math.round(room.__dirCam.x + (cx - room.__dirCam.x) * 0.2), y: Math.round(room.__dirCam.y + (cy - room.__dirCam.y) * 0.2) } : { x: cx, y: cy }
    }
  }
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, r)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, r)
}
function entPos(st, seat) { const h = st.ents['h' + seat]; return h ? { x: h.x, y: h.y } : null }
function towerPos(tid) { const t = TOWERS.find((t) => t.id === tid); return t ? { x: t.x, y: t.y } : null }
function onSync(room, ctx) {
  let seat = -1
  const s = room.seats.find((x) => x.conn === ctx)
  if (s) seat = s.seat
  emitOne(room, { ctx, seat }, null, { force: true })
}

/* =====================================================================
 * 适配器出口（rooms.js 注册表形状）
 * ===================================================================== */
export const miniMobaSim = {
  META: {
    gameId: 'mini-moba', title: '迷你MOBA', mode: '3v3-moba',
    seats: 6, tickMs: TICK_MS, cmdInput: true,
    roomPrefix: 'moba', // feed 字典序 element<empire<moba<mmo（§7 房间参数，无冲突）
    takeOver: 'balanced', // 断线托管=balanced（§4.3：MOBA 挂机=送塔送赏金）
    /* GAMES-130 团队作 pulse（放水链信号源）：真人所在队胜=断连败/负=连败++——
     * rooms.js finish 按 META.pulseTeam(seat,winner) 记账（1v1/pulsePos 之外的
     * 团队作口径，speed-kart pulsePos=GAMES-112 先例） */
    pulseTeam: (seat, winner) => TEAM_OF(seat) === winner,
  },
  LEVELS: ['casual', 'balanced', 'competitive'],
  url: '/games/multiplayer/mini-moba/index.html',
  create, step,
  /* brain 出口包装（GAMES-130 放水链）：网关 botEnv（kinds/foeLose）+game.json
   * bot.mercy 经 env 注入（tactics GAMES-121 同式）；无 env（离线直调/api-check
   * sim 级剧本）→ 原样透传，brain 缺省兜底零放水 */
  brain: (st, seat, level, rng, env) => brain(st, seat, level, rng, env ? Object.assign({}, env, { mercy: MERCY_CFG }) : env),
  emit, onSync,
  fnv1a32, mulberry32,
}
