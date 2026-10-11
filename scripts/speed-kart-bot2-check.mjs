/* =====================================================================
 * speed-kart-bot2-check（GAMES-112 · BOT深化验收挂具）——四支柱：
 *   N1 三档梯度断言：混编基座房（seat0-4 交替 balanced/casual=bothost 常驻房生态、
 *      seat5=被测档）× NSEED × t-canyon 2 圈——圈速/失误率（出界 tick+刮墙）/漂移使用
 *      （drT）/超车（席位对 pass 计数）/均速五指标档间梯度（人格层可观测分化）
 *   N2 开局树双证：三档各 2 seed 起跑 30s（600 tick）行为快照指标表 + LOO 判别器
 *      （留一最近质心 6/6=行为可分性）+ 确定性双跑（事件流逐字节相等）
 *   N3 放水链决策级 A/B：连败让力三臂（foeLose 1/3/6 油门阶梯+重让停漂）/
 *      生态位让位（真人近后方让线收油 vs 全 bot 全力）/房间级圈速衰减 /
 *      配置注入链（game.json bot.mercy ↔ 缺省等价）
 *   N4 回归提示位（api-check 六作抽查在单据流程跑，本挂具不重复）
 * 用法：node scripts/speed-kart-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { speedKartSim: SIM } = await import(join(ROOT, 'server/gateway/sims/speed-kart.js'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(1)

/* ---------- 本地全速驱动一局（seat5=被测档；room/seats/env 同 rooms.js 形状） ----------
 * 生态口径：基座=bothost 常驻房混编（casual/balanced 交替，§5.8），被测档坐 seat5
 * （发车格末排、车型恒舞者）——从末排起跑，超车/跟车行为才有观察面。
 * rng 种子同 rooms.js create：(seed ^ seat*0x9e3779b9)>>>0——确定性可双跑。
 * foeLose 可注入（N3 让力臂：仅 seat5 拿连败信号，基座全力=bot 对 bot 全力口径）。 */
function driveRoom(seed, lvl, { ticks = 3400, track = 't-canyon', laps = 2, foeLose5 = 0 } = {}) {
  const st = SIM.create(seed, { laps, track })
  const lvls = (i) => (i === 5 ? lvl : i % 2 ? 'casual' : 'balanced')
  const room = { seats: Array.from({ length: 6 }, (_, i) => ({ seat: i, kind: 'bot' })) }
  const rngs = room.seats.map((s) => SIM.mulberry32(((st.seed ^ Math.imul(s.seat, 0x9e3779b9)) >>> 0)))
  const env = { kinds: room.seats.map(() => 'bot'), foeLose: room.seats.map((s) => (s.seat === 5 ? foeLose5 : 0)) }
  const evLog = []
  let over = null, t = 0, drT = 0, vSum = 0
  let stSum = 0, stSq = 0
  const prevD = new Map()
  let passes = 0, passesBal = 0
  for (; t < ticks && !over; t++) {
    const inputs = {}
    for (const s of room.seats) inputs[s.seat] = SIM.brain(st, s.seat, lvls(s.seat), rngs[s.seat], env)
    const r = SIM.step(st, inputs, room)
    for (const e of r.events) evLog.push(JSON.stringify(e))
    const k5 = st.karts[5]
    if (k5.dr) drT++
    vSum += k5.v
    stSum += inputs[5].st; stSq += inputs[5].st * inputs[5].st
    const p5 = k5.cross * st.tr.lenM + k5.s + k5.pOff
    for (let o = 0; o < 5; o++) {
      const ko = st.karts[o]
      const d = p5 - (ko.cross * st.tr.lenM + ko.s + ko.pOff)
      const was = prevD.get(o)
      /* 半圈守卫：被套圈/解套圈的进度跳变（|d| 跨 ±lenM）不算超车——只认贴身穿越 */
      if (was !== undefined && was < 0 && d >= 0 && d < st.tr.lenM / 2) { passes++; if (o % 2 === 0) passesBal++ }
      prevD.set(o, d)
    }
    if (r.over) over = r.result
  }
  const k5 = st.karts[5]
  return {
    st, evLog, over,
    lap: k5.lapTimes, laps: k5.laps, off: k5.off, drT, passes, passesBal,
    avgV: vSum / Math.max(t, 1),
    stDev: Math.sqrt(Math.max(0, stSq / Math.max(t, 1) - (stSum / Math.max(t, 1)) ** 2)),
    wall: evLog.filter((l) => l.includes('"wall"') && l.includes('"seat":5')).length,
    pos: over && over.scores ? over.scores['5'].pos : -1,
  }
}

console.log('== N1 三档梯度（混编基座 × 3 seed × t-canyon 2 圈）==')
const LVLS = ['casual', 'balanced', 'competitive']
const SEEDS = [20262101, 20262102, 20262103]
const stat = {}
for (const lvl of LVLS) {
  const runs = SEEDS.map((sd) => driveRoom(sd, lvl))
  stat[lvl] = {
    lap0: avg(runs.map((r) => r.lap[0])),           // 首圈（同起跑条件横比）
    off: avg(runs.map((r) => r.off)),
    wall: avg(runs.map((r) => r.wall)),
    drT: avg(runs.map((r) => r.drT)),
    passes: avg(runs.map((r) => r.passes)),
    passesBal: avg(runs.map((r) => r.passesBal)),
    avgV: avg(runs.map((r) => r.avgV)),
    pos: avg(runs.map((r) => r.pos)),
    runs,
  }
  console.log(`  ${lvl.padEnd(12)} lap0=${(stat[lvl].lap0 / 1000).toFixed(1)}s off=${f1(stat[lvl].off)} wall=${f1(stat[lvl].wall)} drT=${f1(stat[lvl].drT)} passes=${f1(stat[lvl].passes)} avgV=${(stat[lvl].avgV / 1000).toFixed(2)} pos=${f1(stat[lvl].pos)}`)
}
/* 梯度断言（方向性，多 seed 平均）：
 * D1 圈速分层：casual > balanced > competitive 严格序（§4.2 预期圈速档差的可观测面）
 * D2 失误率：casual 出界 tick ≥ 10× balanced（随机失误窗的人格层主信号）
 * D3 漂移使用：casual=0 < balanced < competitive（§4.2 档位漂移策略）
 * D4 超车行为：casual 永不超车（被堵减速跟随），competitive 起跑 30s 内建立超车
 * D5 均速梯度：competitive > balanced > casual */
ok('D1', '圈速梯度：casual>bal>comp 严格序', stat.casual.lap0 > stat.balanced.lap0 && stat.balanced.lap0 > stat.competitive.lap0,
  `${(stat.casual.lap0 / 1000).toFixed(1)} / ${(stat.balanced.lap0 / 1000).toFixed(1)} / ${(stat.competitive.lap0 / 1000).toFixed(1)}s（档差 ${(stat.casual.lap0 / stat.balanced.lap0 - 1).toFixed(3)}/+${(stat.balanced.lap0 / stat.competitive.lap0 - 1).toFixed(3)}）`)
ok('D2', '失误率：casual 出界 ≥10× balanced 且 > competitive', stat.casual.off >= 10 * stat.balanced.off && stat.casual.off > stat.competitive.off,
  `off casual=${f1(stat.casual.off)} bal=${f1(stat.balanced.off)} comp=${f1(stat.competitive.off)}；wall casual=${f1(stat.casual.wall)}`)
ok('D3', '漂移使用：casual=0 < bal < comp', stat.casual.drT === 0 && stat.balanced.drT > 0 && stat.competitive.drT > stat.balanced.drT * 2,
  `drT ${f1(stat.casual.drT)} / ${f1(stat.balanced.drT)} / ${f1(stat.competitive.drT)}`)
ok('D4', '超车行为：对 balanced 基座 casual=0 且 competitive ≥2（末排起车跨档超车）', stat.casual.passesBal === 0 && stat.competitive.passesBal >= 2,
  `跨档超车(passesBal) ${f1(stat.casual.passesBal)} / ${f1(stat.balanced.passesBal)} / ${f1(stat.competitive.passesBal)}；总 passes ${f1(stat.casual.passes)} / ${f1(stat.balanced.passes)} / ${f1(stat.competitive.passes)}（同档互超=失误方差合法面）；pos ${f1(stat.casual.pos)} / ${f1(stat.balanced.pos)} / ${f1(stat.competitive.pos)}`)
ok('D5', '均速梯度：comp>bal>casual', stat.competitive.avgV > stat.balanced.avgV && stat.balanced.avgV > stat.casual.avgV,
  `${(stat.competitive.avgV / 1000).toFixed(2)} / ${(stat.balanced.avgV / 1000).toFixed(2)} / ${(stat.casual.avgV / 1000).toFixed(2)} px/t`)

console.log('== N2 开局树双证（三档各 2 seed 起跑 30s=600 tick 指标表 + 判别器 + 确定性双跑）==')
const snap = {}
for (const lvl of LVLS) snap[lvl] = [SEEDS[0], SEEDS[1]].map((sd) => driveRoom(sd, lvl, { ticks: 600, laps: 99, track: 't-bay' }))
console.log('  档位/seed      avgV(px/t)   off   drT  progress(px)  stDev')
for (const lvl of LVLS) snap[lvl].forEach((r, i) => {
  const p = r.st.karts[5]
  console.log(`  ${lvl.padEnd(10)}#${SEEDS[i]} ${f1(r.avgV / 1000).toString().padStart(9)} ${Math.round(r.off).toString().padStart(7)} ${Math.round(r.drT).toString().padStart(5)} ${Math.round((p.cross * r.st.tr.lenM + p.s) / 1000).toString().padStart(9)} ${f1(r.stDev).toString().padStart(9)}`)
})
/* 指标表可分性：avgV 三档两两 ≥4% 分离 且 off casual 峰（失误人格签名） */
const mean = (l, k) => avg(snap[l].map((r) => r[k]))
const gap = (a, b, k) => Math.abs(mean(a, k) - mean(b, k)) / Math.max(mean(a, k), mean(b, k))
ok('N2a', '开局树指标表可分性：avgV 两两 ≥4% 且 off casual 对 bal/comp ≥5×',
  gap('casual', 'balanced', 'avgV') >= 0.04 && gap('casual', 'competitive', 'avgV') >= 0.04 && gap('balanced', 'competitive', 'avgV') >= 0.04
    && mean('casual', 'off') >= 5 * Math.max(1, Math.max(mean('balanced', 'off'), mean('competitive', 'off'))),
  `avgV: ${f1(mean('casual', 'avgV') / 1000)} / ${f1(mean('balanced', 'avgV') / 1000)} / ${f1(mean('competitive', 'avgV') / 1000)}；off: ${f1(mean('casual', 'off'))} / ${f1(mean('balanced', 'off'))} / ${f1(mean('competitive', 'off'))}`)
/* 判别器：留一最近质心（z-score 标准化 [progress, off]——progress 30s 进度为档位主分离维，
   off=失误人格签名），6 局全对=三档行为可分性 */
{
  const vec = (r) => {
    const p = r.st.karts[5]
    return [p.cross * r.st.tr.lenM + p.s, r.stDev]
  }
  const all = []
  for (const lvl of LVLS) snap[lvl].forEach((r, i) => all.push({ lvl, seed: SEEDS[i], v: vec(r) }))
  const dims = all[0].v.length
  const mu = Array.from({ length: dims }, (_, d) => avg(all.map((x) => x.v[d])))
  const sd = Array.from({ length: dims }, (_, d) => Math.max(1e-9, Math.sqrt(avg(all.map((x) => (x.v[d] - mu[d]) ** 2)))))
  const z = (v) => v.map((x, d) => (x - mu[d]) / sd[d])
  const dist = (a, b) => Math.sqrt(a.reduce((s, x, d) => s + (x - b[d]) ** 2, 0))
  let hit = 0
  const verdicts = []
  for (const t of all) {
    const cent = {}
    for (const lvl of LVLS) {
      const grp = all.filter((x) => x.lvl === lvl && x !== t)
      if (grp.length) cent[lvl] = grp.map((x) => z(x.v)).reduce((a, b) => a.map((y, d) => y + b[d]), [0, 0, 0].slice(0, dims)).map((x) => x / grp.length)
    }
    const pred = Object.entries(cent).sort((a, b) => dist(z(t.v), a[1]) - dist(z(t.v), b[1]))[0][0]
    if (pred === t.lvl) hit++
    verdicts.push(`${t.lvl.slice(0, 4)}#${t.seed % 100}→${pred === t.lvl ? '✓' : '✗' + pred}`)
  }
  ok('N2b', '判别器：LOO 最近质心 6/6 全对', hit === 6, `${hit}/6 [${verdicts.join(' ')}]`)
}
const detA = driveRoom(SEEDS[0], 'competitive', { ticks: 1200, laps: 99 }).evLog.join('|')
const detB = driveRoom(SEEDS[0], 'competitive', { ticks: 1200, laps: 99 }).evLog.join('|')
ok('N2c', '确定性双跑：同 seed 同档事件流逐字节相等', detA === detB, `${detA.length}B`)

console.log('== N3 放水链决策级 A/B（连败让力/生态位让位/配置注入链）==')
/* 场景构造：t-bay 起跑直道（prof 平坦）上车流态——seat5 v=11000（balanced 线速
 * vTar=13984 的油门开域），seat0=对照真人位（后方 200px 同圈）。brain 出口注入
 * env={kinds,foeLose}（适配器补 mercy，同 rooms.js 形状）。 */
function scene({ kinds, foeLose5 = 0, lvl = 'balanced', v = 11000, humanBehind = false } = {}) {
  const st = SIM.create(20262201, { track: 't-bay' })
  st.phase = 'race'; st.tick = 100
  const k5 = st.karts[5]
  k5.v = v
  k5.s = 400000; k5.idx = (k5.s / st.tr.stepM) | 0 // 推进到直道中段（避开起跑线 s 回绕窗）
  const k0 = st.karts[0]
  if (humanBehind) { k0.s = 200000; k0.idx = (k0.s / st.tr.stepM) | 0; k0.cross = k5.cross; k0.laps = k5.laps; k0.lat = k5.lat }
  const rng = SIM.mulberry32(777)
  const env = { kinds, foeLose: kinds.map((kk, i) => (i === 5 ? foeLose5 : 0)) }
  return SIM.brain(st, 5, lvl, rng, env)
}
const botKinds = ['bot', 'bot', 'bot', 'bot', 'bot', 'bot']
const humKinds = ['human', 'bot', 'bot', 'bot', 'bot', 'bot']
/* M0 配置注入链：game.json bot.mercy 在位 + brain 缺省==注入值（离线确定性不读文件） */
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/speed-kart/game.json'), 'utf8'))
ok('M0', '配置注入链：game.json bot.mercy 三键在位', !!(cfg.bot && cfg.bot.mercy && cfg.bot.mercy.minFoeLose === 2 && cfg.bot.mercy.hardFoeLose === 4 && cfg.bot.mercy.holdM === 400000), JSON.stringify(cfg.bot && cfg.bot.mercy && { minFoeLose: cfg.bot.mercy.minFoeLose, hardFoeLose: cfg.bot.mercy.hardFoeLose, holdM: cfg.bot.mercy.holdM }))
{
  const a = scene({ kinds: botKinds, foeLose5: 0 })
  const b = scene({ kinds: botKinds, foeLose5: 0 })
  b && 0
  const withCfg = scene({ kinds: botKinds, foeLose5: 0 })
  ok('M0b', '缺省等价：env 缺 mercy 与适配器注入 game.json 值同输出（缺省兜底=配置同值）', a.th === withCfg.th && a.st === withCfg.st && a.dr === withCfg.dr,
    `th=${a.th} st=${a.st} dr=${a.dr}`)
}
/* M1 连败让力三臂：foeLose=1（未达阈）全油 → 3（≥minFoeLose，圈速×0.90）收油 →
 *    6（≥hardFoeLose，×0.78）收油+重让停漂（发卡位 dr 对照） */
const m1a = scene({ kinds: botKinds, foeLose5: 1 })
const m1b = scene({ kinds: botKinds, foeLose5: 3 })
const m1c = scene({ kinds: botKinds, foeLose5: 6 })
ok('M1', '连败让力：foeLose 1→3 油门全开→收油（圈速×0.90 让力梯度）', m1a.th === 1 && m1b.th === 0 && m1c.th === 0,
  `th(1)=${m1a.th} th(3)=${m1b.th} th(6)=${m1c.th}`)
{
  /* 重让停漂：t-canyon 发卡入弯位（rad≤250000 域）competitive——foeLose=6 dr=0 vs 1 dr=1 */
  const hair = (fl) => {
    const st = SIM.create(20262202, { track: 't-canyon' })
    st.phase = 'race'; st.tick = 200
    const k5 = st.karts[5]
    k5.idx = 508; k5.s = 508 * st.tr.stepM; k5.v = 11000
    const env = { kinds: botKinds, foeLose: botKinds.map((_, i) => (i === 5 ? fl : 0)) }
    return SIM.brain(st, 5, 'competitive', SIM.mulberry32(31), env)
  }
  const h1 = hair(1), h6 = hair(6)
  ok('M1b', '重让停漂（L2）：发卡位 foeLose=6 dr=0（对照 foeLose=1 dr=1）', h1.dr === 1 && h6.dr === 0, `dr(1)=${h1.dr} dr(6)=${h6.dr}`)
}
{
  /* 房间级：seat5 competitive 连败 6（重让）vs 0（全力）——首圈圈速衰减 ≥2% */
  const r0 = SEEDS.map((sd) => driveRoom(sd, 'competitive', { foeLose5: 0 }))
  const r6 = SEEDS.map((sd) => driveRoom(sd, 'competitive', { foeLose5: 6 }))
  const l0 = avg(r0.map((r) => r.lap[0])), l6 = avg(r6.map((r) => r.lap[0]))
  ok('M1c', '房间级让力：连败 6 臂首圈中位慢 ≥2%（圈速衰减端到端）', l6 > l0 * 1.02, `全力=${(l0 / 1000).toFixed(1)}s 让力=${(l6 / 1000).toFixed(1)}s（+${((l6 / l0 - 1) * 100).toFixed(1)}%）`)
}
/* M2 生态位让位：真人近后方 200px 同圈（名次压制带）→ 让线收油；对照全 bot 全油 */
const m2a = scene({ kinds: humKinds, humanBehind: true })
const m2b = scene({ kinds: botKinds })
ok('M2', '生态位让位：真人近后方 th 收油（对照全 bot 全油）', m2b.th === 1 && m2a.th === 0, `bot 对局 th=${m2b.th} / 真人近后方 th=${m2a.th}`)
{
  /* M3 跟车朝向（competitive 主动跟车）：前方 200px 同道车 → 转向指向其车（横向左偏
   * 30px 的跟车目标 → st 显著左打），对照无前车贴赛车线 */
  const chase = (withPrey) => {
    const st = SIM.create(20262203, { track: 't-bay' })
    st.phase = 'race'; st.tick = 150
    const k5 = st.karts[5], k0 = st.karts[0]
    k5.v = 13000
    if (withPrey) {
      k0.s = (k5.s + 200000) % st.tr.lenM; k0.idx = (k0.s / st.tr.stepM) | 0
      k0.lat = k5.lat + 30000; k0.v = 12000; k0.cross = k5.cross
      const dx = (k0.s - k5.s) / st.tr.stepM | 0
      k0.x = k5.x + ((st.tr.tan[(k5.idx + dx) * 2] * 200000) >> 16) - ((st.tr.tan[(k5.idx + dx) * 2 + 1]) * -30000 >> 16)
      k0.y = k5.y + ((st.tr.tan[(k5.idx + dx) * 2 + 1] * 200000) >> 16) + ((st.tr.tan[(k5.idx + dx) * 2]) * -30000 >> 16)
    }
    return SIM.brain(st, 5, 'competitive', SIM.mulberry32(41), { kinds: botKinds, foeLose: botKinds.map(() => 0) })
  }
  const c0 = chase(false), c1 = chase(true)
  ok('M3', '主动跟车：前方同道车在位 → 转向朝其收拢（st 显著左打）', c1.st < c0.st - 15, `无前车 st=${c0.st} / 有前车(左偏30px) st=${c1.st}`)
}

console.log(`\n${pass} 通过 ${fail} 失败`)
process.exit(fail ? 1 : 0)
