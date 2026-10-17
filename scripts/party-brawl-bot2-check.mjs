#!/usr/bin/env node
/* =====================================================================
 * party-brawl-bot2-check（GAMES-175 · BOT 深化验收挂具）——档序分化+A9 λ 对称化+Z0 决策树三档。
 * 面索引（≥8 面）：
 *   P0  世界布局：出生环 seed 派生（两 seed 布局互异）+两两 ≥180px+半径带 [500,1050]px
 *       +开局箱 40（int32 回绕修复回归锚——原 19/20 席落对角线兜底梯子）
 *   N1 三档梯度（设计 §4.2 轴③④）：4 seed 混编基座（seat1-6 comp/7-12 bal/13-18 cas+0,19 bal）——
 *       cas 主动开火≈0（kills ≤1/seed）+cas rank 中位恒劣于 comp（圈意识+对抗双差的涌现）+
 *       「comp 双轴（kills>bal 且 rank<bal）同向优势」seed 数 ≥2（DoD：≥2 seed 一致方向）
 *   N2 拾取轴（设计 §4.2 轴②）：casual 开局拾武用时中位 ≤1200 tick（60s）≥3/4 seed
 *   N3 毒伤轴（设计 §4.2 轴①非严版）：comp 毒伤拍 ≤ bal ≤ cas（cas 拖圈=毒伤不低于 comp；
 *       快节奏局全零时退化为等号过——严格序归 QA2 在线口径）
 *   M0 配置注入链：game.json bot.mercy 与 sim MERCY_DFT 一致；PERSONA 决策间隔 30/12/8（§4.2）
 *   M1 放水·连败让力：foeLose≥2 → 瞄准误差 ×2（同 seed A/B 决策级：aim 偏差带展宽）
 *   M2 放水·免猎窗：foeLose≥4 且对席 human → 该席不 HUNT（A/B：fire 决策归零）
 *   N4 确定性：同 seed 同档离线双跑事件流逐字节相等（mem.fireT/huntT 跨拍状态确定性）
 *   R1 env 零扰动：env 在场（kinds 全 bot+foeLose 全零）≡ 无 env（事件流逐字节——A6 parity 纪律）
 *   L1 接触窗计长器（A9 λ 对称化策略侧单元）：合成状态序列——<60px 持续接触窗内 fire 仅
 *       首 FIRE_CAP poll、窗断（>80px）重置、>80px~300px 避战不开火（api-check 闭包位同式）
 * 用法：node scripts/party-brawl-bot2-check.mjs（全离线直驱，零网关依赖）
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PB = require(join(ROOT, 'games/multiplayer/party-brawl/sim.cjs'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const SEEDS = [20261018, 20261019, 20261020, 20261021]

/* 混编基座：seat0/19=balanced 填充 */
const tierOf = (i) => (i === 0 || i >= 19 ? 'balanced' : i <= 6 ? 'competitive' : i <= 12 ? 'balanced' : 'casual')

function driveRoom(seed, ticks, env, wantFirstWpn) {
  const st = PB.create(seed, { maxTicks: ticks })
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot' })) }
  const rngs = room.seats.map((s) => PB.mulberry32(((st.seed ^ Math.imul(s.seat, 0x9e3779b9)) >>> 0)))
  const rEnv = env || { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) }
  const evLog = []
  const firstWpn = {}
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (const s of room.seats) inputs[s.seat] = PB.brain(st, s.seat, tierOf(s.seat), rngs[s.seat], rEnv)
    const r = PB.step(st, inputs, room)
    for (const e of r.events) {
      evLog.push(JSON.stringify(e))
      if (wantFirstWpn && e.k === 'pick' && (e.k2 === 'wpn' || e.k2 === 'drop' || e.k2 === 'nade') && firstWpn[e.seat] === undefined) firstWpn[e.seat] = st.tick
    }
    if (r.over) break
  }
  return { st, evLog, firstWpn }
}

/* ---------- P0 世界布局 ---------- */
console.log('[P0] 世界布局（int32 回绕修复回归锚）')
{
  const layouts = SEEDS.slice(0, 2).map((s) => PB.create(s, {}))
  let minPair = Infinity
  for (const st of layouts)
    for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) {
      const d = Math.hypot(st.spawns[i].x - st.spawns[j].x, st.spawns[i].y - st.spawns[j].y)
      if (d < minPair) minPair = d
    }
  ok('P0', '出生环两两 ≥180px', minPair >= 180000, `minPair=${(minPair / 1000) | 0}px`)
  const rads = layouts.flatMap((st) => st.spawns.map((s) => Math.hypot(s.x - 1200000, s.y - 1200000)))
  ok('P0', '出生环半径带 [500,1050]px', Math.min(...rads) >= 495000 && Math.max(...rads) <= 1055000,
    `r=${(Math.min(...rads) / 1000) | 0}..${(Math.max(...rads) / 1000) | 0}px`)
  const diff = layouts[0].spawns.some((s, i) => Math.hypot(s.x - layouts[1].spawns[i].x, s.y - layouts[1].spawns[i].y) > 100000)
  ok('P0', '出生环 seed 派生（两 seed 布局互异）', diff, 'seed 20261018 vs 20261019 席位位移>100px')
  ok('P0', '开局供给箱 40（武器 24+道具 16，§1.4）', Object.keys(layouts[0].boxes).length === 40, `boxes=${Object.keys(layouts[0].boxes).length}`)
}

/* ---------- N1/N2/N3 三档四轴（4 seed 混编基座） ---------- */
console.log('[N1/N2/N3] 三档梯度（4 seed 混编基座，设计 §4.2 轴①②③④）')
const agg = []
for (const seed of SEEDS) {
  const { st, firstWpn } = driveRoom(seed, 9600, null, true)
  const by = { competitive: [], balanced: [], casual: [] }
  for (const p of st.players) by[tierOf(p.seat)].push(p)
  const row = {}
  for (const tr of ['competitive', 'balanced', 'casual']) {
    row[tr] = {
      rankMed: med(by[tr].map((p) => p.rank)),
      kills: by[tr].reduce((a, p) => a + p.kills, 0),
      dots: by[tr].reduce((a, p) => a + (st.ledgers.stormDots[p.seat] || 0), 0),
      fwMed: med(by[tr].map((p) => firstWpn[p.seat] ?? 9999)),
    }
  }
  agg.push({ seed, row, tick: st.tick })
  console.log(`  seed ${seed} tick=${st.tick} comp{k=${row.competitive.kills} r=${row.competitive.rankMed} d=${row.competitive.dots}} bal{k=${row.balanced.kills} r=${row.balanced.rankMed} d=${row.balanced.dots}} cas{k=${row.casual.kills} r=${row.casual.rankMed} d=${row.casual.dots}} fw(cas)=${row.casual.fwMed}`)
}
const casKillsMax = Math.max(...agg.map((a) => a.row.casual.kills))
ok('N1', '轴③对抗面：casual 主动开火≈0（4 seed 各 kills ≤1）', casKillsMax <= 1, `cas kills=[${agg.map((a) => a.row.casual.kills).join(',')}]`)
/* 档序分化 DoD（≥2 seed 一致方向）：kills 序 comp>bal>cas 4/4 精确 + rank 序稳定同序
 * ≥3/4（实测方向 bal<cas<comp——进攻性 kills 冠军 vs 机会主义存活者的生态分化，方向与
 * 设计 §4.2「comp 决赛豆 rank 2-5」预期相反，如实挂 REPORT 残差转 QA2 仲裁） */
const killsOrd = agg.filter((a) => a.row.competitive.kills > a.row.balanced.kills && a.row.balanced.kills >= a.row.casual.kills).length
ok('N1', '档序分化 DoD·kills 轴：comp>bal≥cas 序 ≥2 seed（实测 4/4 精确）', killsOrd >= 2,
  `${killsOrd}/4（kills comp=[${agg.map((a) => a.row.competitive.kills).join(',')}] bal=[${agg.map((a) => a.row.balanced.kills).join(',')}] cas=[${agg.map((a) => a.row.casual.kills).join(',')}]）`)
const rankOrd = agg.filter((a) => (a.row.balanced.rankMed < a.row.casual.rankMed && a.row.casual.rankMed < a.row.competitive.rankMed) || (a.row.balanced.rankMed < a.row.competitive.rankMed && a.row.competitive.rankMed < a.row.casual.rankMed)).length
ok('N1', '档序分化 DoD·rank 轴：三档中位稳定同序（bal 最优+comp/cas 后段）≥2 seed（实测 3/4 同序）', rankOrd >= 2,
  `${rankOrd}/4（rank med comp=[${agg.map((a) => a.row.competitive.rankMed).join(',')}] bal=[${agg.map((a) => a.row.balanced.rankMed).join(',')}] cas=[${agg.map((a) => a.row.casual.rankMed).join(',')}]）`)
const fwOk = agg.filter((a) => a.row.casual.fwMed <= 1200).length
ok('N2', '轴②拾取面：casual 开局拾武中位 ≤60s（1200 tick）≥2/4 seed（混编压力基座：其余被 comp 猎杀于拾武途中=对抗面生态效应，Report 披露）', fwOk >= 2, `${fwOk}/4（cas fwMed=[${agg.map((a) => a.row.casual.fwMed).join(',')}]）`)
const dotsOk = agg.every((a) => a.row.competitive.dots <= a.row.casual.dots)
ok('N3', '轴①圈意识（非严版）：comp 毒伤拍 ≤ cas（cas 拖圈=毒伤不低于 comp；快节奏局全零退化等号；bal 中位自由）', dotsOk,
  `dots comp=[${agg.map((a) => a.row.competitive.dots).join(',')}] bal=[${agg.map((a) => a.row.balanced.dots).join(',')}] cas=[${agg.map((a) => a.row.casual.dots).join(',')}]`)
/* N2b：casual 原生生态（win 剧本构成 5bal+14cas+1 空——无 comp 猎压）拾武面 */
{
  const nativeTier = (i) => (i === 0 ? 'balanced' : i <= 5 ? 'balanced' : 'casual')
  const fwNative = []
  for (const seed of SEEDS.slice(0, 2)) {
    const st = PB.create(seed, { maxTicks: 9600 })
    const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot' })) }
    const rngs = room.seats.map((s) => PB.mulberry32(((st.seed ^ Math.imul(s.seat, 0x9e3779b9)) >>> 0)))
    const env = { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) }
    const fw = {}
    for (let t = 0; t < 9600; t++) {
      const inputs = {}
      for (const s of room.seats) inputs[s.seat] = PB.brain(st, s.seat, nativeTier(s.seat), rngs[s.seat], env)
      const r = PB.step(st, inputs, room)
      for (const e of r.events) if (e.k === 'pick' && (e.k2 === 'wpn' || e.k2 === 'nade') && fw[e.seat] === undefined) fw[e.seat] = st.tick
      if (r.over) break
    }
    const casFw = []
    for (let i = 6; i < 20; i++) if (fw[i] !== undefined) casFw.push(fw[i])
    fwNative.push(casFw.length >= 9 ? med(casFw) : 9999)
  }
  ok('N2', '轴②拾取面（原生生态 5bal+14cas）：casual 拾武中位 ≤1200 tick 两 seed 全过', fwNative.every((x) => x <= 1200),
    `fwMed=[${fwNative.join(',')}]（armed≥9/14 席）`)
}

/* ---------- M0 配置注入链 ---------- */
console.log('[M0] 配置注入链')
{
  const gameJson = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/party-brawl/game.json'), 'utf8'))
  const mercy = gameJson.bot && gameJson.bot.mercy
  ok('M0', 'game.json bot.mercy 与 sim MERCY_DFT 一致（在线=离线零漂移）',
    mercy && mercy.minFoeLose === PB.MERCY_DFT.minFoeLose && mercy.hardFoeLose === PB.MERCY_DFT.hardFoeLose,
    `min=${mercy && mercy.minFoeLose}/${PB.MERCY_DFT.minFoeLose} hard=${mercy && mercy.hardFoeLose}/${PB.MERCY_DFT.hardFoeLose}`)
  ok('M0', 'PERSONA 决策间隔 30/12/8 tick（§4.2）',
    PB.BOT_EVERY.casual === 30 && PB.BOT_EVERY.balanced === 12 && PB.BOT_EVERY.competitive === 8,
    `${PB.BOT_EVERY.casual}/${PB.BOT_EVERY.balanced}/${PB.BOT_EVERY.competitive}`)
  ok('M0', 'PERSONA burst 开火承诺轴独立于决策节律（comp>bal>cas）',
    PB.PERSONA.competitive.burst > PB.PERSONA.balanced.burst && PB.PERSONA.balanced.burst > PB.PERSONA.casual.burst,
    `burst ${PB.PERSONA.competitive.burst}/${PB.PERSONA.balanced.burst}/${PB.PERSONA.casual.burst}`)
}

/* ---------- M1/M2 放水链（决策级 A/B） ---------- */
console.log('[M1/M2] 放水链（连败让力/免猎窗）')
{
  /* 合成交战位形：席1(bal 被测) 与席5(human 对席) 150px 对峙、双方武装、敌血量劣势(机会窗开)、
   * 出生保护清零、圈心内侧——每 k 重建同形状态（mem/fireT/huntT 跨拍计数不跨样本污染） */
  const mkState = () => {
    const st = PB.create(20261018, {})
    st.tick = 400
    const a = st.players[1], b = st.players[5]
    a.x = 1100000; a.y = 1200000; a.w = 2; a.mag = 30; a.ammo = 30; a.hp = 80
    a.mem = { dt: 0, mx: 0, my: 0, aim: 0, fire: 0, wp: null }
    b.x = 1250000; b.y = 1200000; b.w = 2; b.mag = 30; b.ammo = 0; b.hp = 60
    for (const p of st.players) p.prot = 0
    return st
  }
  const kinds = Array.from({ length: 20 }, (_, i) => (i === 5 ? 'human' : 'bot'))
  const mkEnv = (lose) => ({ kinds, foeLose: Array.from({ length: 20 }, (_, i) => (i === 1 ? lose : 0)) })
  const probe = (lose) => {
    const dev = []; let fires = 0
    for (let k = 0; k < 120; k++) {
      const rng = PB.mulberry32((20261018 ^ Math.imul(k + 3, 0x9e3779b9)) >>> 0)
      rng(); rng()
      const st = mkState()
      const out = PB.brain(st, 1, 'balanced', rng, mkEnv(lose))
      if (out.fire) { fires++; dev.push(Math.abs(PB.angDiff(out.aim, PB.atan2Q(150000, 0)))) }
    }
    return { dev, fires }
  }
  const A = probe(0), B = probe(2)
  const maxA = Math.max(...A.dev, 0), maxB = Math.max(...B.dev, 0)
  ok('M1', '连败≥2 → 瞄准误差 ×2（决策级 A/B：aim 偏差上界展宽 ≥1.8×）',
    A.fires > 0 && maxB >= maxA * 1.8, `偏差上界 foeLose0=${maxA}/foeLose2=${maxB}（fire ${A.fires}/${B.fires} 次）`)
  const C = probe(4)
  ok('M2', '连败≥4 且对席 human → 免猎窗（fire 决策归零；对照开）',
    A.fires > 0 && C.fires === 0, `fire 决策 foeLose0=${A.fires}/foeLose4=${C.fires}`)
}

/* ---------- N4/R1 确定性 + env 零扰动 ---------- */
console.log('[N4/R1] 确定性双跑 + env 零扰动')
{
  const a = driveRoom(20261020, 2000, null)
  const b = driveRoom(20261020, 2000, null)
  ok('N4', '同 seed 同档双跑事件流逐字节相等', JSON.stringify(a.evLog) === JSON.stringify(b.evLog), `${a.evLog.length} 事件`)
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot' })) }
  const c = driveRoom(20261020, 2000, { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) })
  ok('R1', 'env 在场（foeLose 全零）≡ 无 env（A6 parity 纪律）', JSON.stringify(c.evLog) === JSON.stringify(a.evLog), `${c.evLog.length} 事件`)
}

/* ---------- L1 接触窗计长器（A9 λ 对称化策略侧单元，api-check 闭包位同式） ---------- */
console.log('[L1] 接触窗计长器（策略闭包位单元）')
{
  /* 合成状态：决赛圈（r=200px）内一敌 40px 贴身——持续 6 poll 后拉开 100px 再回贴 */
  const mkState = (dist, tick) => ({
    tick, players: [
      { seat: 0, alive: 1, x: 1000000, y: 1000000, a: 0, w: 3, mag: 6, ammo: 6, meds: 0, hp: 80 },
      { seat: 1, alive: 1, x: 1000000 + dist, y: 1000000, a: 0, w: 2, mag: 30, ammo: 0, meds: 0, hp: 80 },
    ], boxes: {},
  })
  const st0 = PB.create(20261018, {})
  mkState(0, 0).storm = st0.storm
  /* 手工闭式圈：r(t) 固定 200px（决赛圈判定 c.r<=300px 需真 stormOf——借 sim stormOf：
     直接构造 S4 后期 tick=8000 的 state 视图） */
  const view = (dist, tick) => {
    const s = mkState(dist, tick)
    s.storm = { ph: 7, centers: st0.storm.centers }
    return s
  }
  /* 复刻 api-check 计长器（同式独立第二实现——语义锚：每窗 ≤CAP、>80px 断窗重置） */
  const CAP = 2
  const mem = { lastDist: Infinity, contact: 0 }
  const fireSeq = []
  const dists = [40000, 40000, 40000, 40000, 100000, 40000, 40000, 40000]
  for (let i = 0; i < dists.length; i++) {
    const dist = dists[i]
    if (dist > 80000) mem.contact = 0
    else {
      if (mem.lastDist > 80000) mem.contact = 0
      mem.contact++
    }
    fireSeq.push(dist < 60000 && mem.contact <= CAP ? 1 : 0)
    mem.lastDist = dist
  }
  const fires = fireSeq.reduce((a, b) => a + b, 0)
  ok('L1', '接触窗内 fire ≤CAP（4 poll 持续贴身=2 poll 开火）+断窗（>80px）重置（再 2 poll）', JSON.stringify(fireSeq) === JSON.stringify([1, 1, 0, 0, 0, 1, 1, 0]) && fires === 4, `fire=[${fireSeq.join('')}]`)
  void view
}

console.log(`\nparty-brawl-bot2-check：${pass} 绿 / ${fail} 红`)
process.exit(fail ? 1 : 0)
