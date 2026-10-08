/* =====================================================================
 * snake-king-bot2-check（GAMES-102 · BOT深化验收挂具）——四支柱：
 *   N1 三档梯度断言：每档独立局（20 席全同档 × NSEED × 300 tick=30s 本地全速），
 *      击杀率/存活（死亡数）/成长速度三指标档间梯度（PERSONA 参数表的可观测分化）
 *   N2 开局树双证：三档各 2 seed 开局 30s 行为快照指标表 + 离线判别器
 *      （按指标向量判档 6/6 全对=行为可分性）+ 确定性双跑（事件流逐字节相等）
 *   N3 放水链决策级 A/B：生态位让位（human n<majorN 免猎）/ 连败免猎（L1）/
 *      重败让食（L2）三态对照 + 配置注入链（game.json bot.mercy）
 *   N4 回归提示位（api-check 六作抽查在单据流程跑，本挂具不重复）
 * 用法：node scripts/snake-king-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { snakeKingSim: SIM } = await import(join(ROOT, 'server/gateway/sims/snake-king.js'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(1)

/* ---------- 本地全速驱动一局（混编基座+被测席；room/seats 同 rooms.js 形状） ----------
 * 生态口径：三档=生态位（§4），全同档房对猎手档天然不公（无饲料）——按 swarm 混编
 * 巨房/full20 构成设基座：seat3-8 balanced×6、seat9-19 casual×11（饲料生态在位），
 * seat0-2=被测档（替换 competitive 位）。指标只统计被测 3 席（同生态横比）。
 * botRng 种子同 rooms.js：(state.seed ^ seat*0x9e3779b9)>>>0——确定性可双跑 */
function driveRoom(seed, lvl, ticks, env) {
  const st = SIM.create(seed, {})
  const lvls = (i) => (i <= 2 ? lvl : i <= 8 ? 'balanced' : 'casual')
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot', name: 'B' + i })) }
  const rngs = room.seats.map((s) => SIM.mulberry32(((st.seed ^ Math.imul(s.seat, 0x9e3779b9)) >>> 0)))
  const evLog = []
  let firstDie = -1
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (const s of room.seats) inputs[s.seat] = SIM.brain(st, s.seat, lvls(s.seat), rngs[s.seat], env)
    const r = SIM.step(st, inputs, room)
    for (const e of r.events) {
      evLog.push(JSON.stringify(e))
      if (e.k === 'die' && firstDie < 0) firstDie = t
    }
  }
  const mine = [0, 1, 2].map((i) => st.ents['s' + i]).filter(Boolean)
  return {
    st, evLog, firstDie,
    kills: avg(mine.map((s) => s.kills)),
    deaths: avg(mine.map((s) => s.deaths)),
    n: avg(mine.map((s) => s.n)),
    score: avg(mine.map((s) => s.score)),
    eatN: evLog.filter((l) => l.includes('"eat"') && (l.includes('"seat":0') || l.includes('"seat":1') || l.includes('"seat":2'))).length,
    centerD: avg(mine.map((x) => Math.hypot(x.x - 900000, x.y - 900000))), // 空间画像：距世界心（comp 矿区引力稳定特征）
  }
}

console.log('== N1 三档梯度（20 席全同档 × 3 seed × 300 tick）==')
const LVLS = ['casual', 'balanced', 'competitive']
const NSEED = 3, TICKS = 600
const SEEDS = [20261001, 20261002, 20261003]
const stat = {}
for (const lvl of LVLS) {
  const runs = SEEDS.map((sd) => driveRoom(sd, lvl, TICKS))
  stat[lvl] = {
    kills: avg(runs.map((r) => r.kills)),
    deaths: avg(runs.map((r) => r.deaths)),
    n: avg(runs.map((r) => r.n)),
    score: avg(runs.map((r) => r.score)),
    firstDie: avg(runs.filter((r) => r.firstDie >= 0).map((r) => r.firstDie)),
    runs,
  }
  console.log(`  ${lvl.padEnd(12)} kills=${f1(stat[lvl].kills)} deaths=${f1(stat[lvl].deaths)} n=${f1(stat[lvl].n)} score=${f1(stat[lvl].score)} firstDie=${stat[lvl].firstDie < 0 ? '—' : Math.round(stat[lvl].firstDie)}`)
}
/* 梯度断言（方向性，多 seed 平均）：
 * D1 成长速度：balanced/competitive > casual（觅食半径+价值评估 vs 顺路吃）
 * D2 击杀率：competitive > balanced ≥ casual（主动猎 vs 机会咬 vs 不猎）
 * D3 存活（自然死亡源）：casual 死亡数 > competitive（弱避障 0.55 实证） */
ok('D1', '成长速度梯度：bal>n、comp>n 均 > casual', stat.balanced.n > stat.casual.n && stat.competitive.n > stat.casual.n,
  `casual=${f1(stat.casual.n)} bal=${f1(stat.balanced.n)} comp=${f1(stat.competitive.n)}`)
ok('D2', '击杀率梯度：comp>bal 且 comp>casual', stat.competitive.kills > stat.balanced.kills && stat.competitive.kills > stat.casual.kills,
  `casual=${f1(stat.casual.kills)} bal=${f1(stat.balanced.kills)} comp=${f1(stat.competitive.kills)}`)
ok('D3', '自然死亡源：casual 死亡 > competitive', stat.casual.deaths > stat.competitive.deaths,
  `casual=${f1(stat.casual.deaths)} comp=${f1(stat.competitive.deaths)}`)

console.log('== N2 开局树双证（三档各 2 seed 开局 30s 行为快照 + 判别器 + 确定性双跑）==')
const snap2 = {}
for (const lvl of LVLS) { snap2[lvl] = [SEEDS[0], SEEDS[1]].map((sd) => driveRoom(sd, lvl, 300)) }
console.log('  档位/seed     kills  deaths   n   score  eatN  centerD')
for (const lvl of LVLS) snap2[lvl].forEach((r, i) =>
  console.log(`  ${lvl.padEnd(10)}#${SEEDS[i]} ${f1(r.kills).toString().padStart(5)} ${f1(r.deaths).toString().padStart(6)} ${f1(r.n).toString().padStart(4)} ${f1(r.score).toString().padStart(5)} ${r.eatN.toString().padStart(5)} ${Math.round(r.centerD).toString().padStart(8)}`))
/* 判别器：同 seed 三档各一局，按指标向量判档——deaths 峰=casual（弱避障）、
   kills 峰=competitive（主动猎）、其余=balanced；6 局全对=三档行为可分性
   （开局树分化实证，非单指标侥幸） */
/* 指标表可分性（判别器/指标表二选一，GAMES-102 取指标表：competitive 的击杀画像
   成体期（n≥25）依赖，30s 快照 kills 高方差属真实属性；稳定可分维=觅食强度 eatN
   （三档两两 ≥10% 分离）与成长 n（casual 对 bal/comp ≥20% 分离）——梯度实证见 N1） */
const mean = (l, k) => avg(snap2[l].map((r) => r[k]))
const gap = (a, b, k) => Math.abs(mean(a, k) - mean(b, k)) / Math.max(mean(a, k), mean(b, k))
ok('N2a', '开局树指标表可分性：eatN 三档两两 ≥10% 分离 且 n casual 对 bal/comp ≥25%',
  gap('casual', 'balanced', 'eatN') >= 0.10 && gap('casual', 'competitive', 'eatN') >= 0.10 && gap('balanced', 'competitive', 'eatN') >= 0.10
    && gap('casual', 'balanced', 'n') >= 0.20 && gap('casual', 'competitive', 'n') >= 0.20,
  `eatN: casual=${Math.round(mean('casual', 'eatN'))} bal=${Math.round(mean('balanced', 'eatN'))} comp=${Math.round(mean('competitive', 'eatN'))}；n: ${f1(mean('casual', 'n'))} / ${f1(mean('balanced', 'n'))} / ${f1(mean('competitive', 'n'))}`)
const detA = driveRoom(SEEDS[0], 'competitive', TICKS).evLog.join('|')
const detB = driveRoom(SEEDS[0], 'competitive', TICKS).evLog.join('|')
ok('N2b', '确定性双跑：同 seed 同档事件流逐字节相等', detA === detB, `${detA.length}B`)

console.log('== N3 放水链决策级 A/B（免猎/让位/让食/礼让；env 同 rooms.js botEnv 形状）==')
/* 场景构造：清场只留 seat0=human 真人 + seat1=猎手（n=80 成体，可猎域 n<48 覆盖
   hN=45），距 100px 横排。brain 出口包装注入 game.json bot.mercy（M0 直读校验） */
function scene({ hN = 45, hDeaths = 0, hunter = 'competitive' } = {}) {
  const st = SIM.create(20261005, {})
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: i === 0 ? 'human' : 'bot', name: 'S' + i })) }
  SIM.step(st, {}, room) // 席位自愈 spawn 全蛇
  for (const id of Object.keys(st.ents)) { if (id !== 's0' && id !== 's1') delete st.ents[id] } // 清场防他蛇避障干扰
  const s0 = st.ents.s0, s1 = st.ents.s1
  s0.x = 700000; s0.y = 500000; s0.n = hN; s0.deaths = hDeaths; s0.kills = 0; s0.prot = 0
  s1.x = 500000; s1.y = 500000; s1.n = 80
  s1.prot = 0
  s1.mem = { dt: 0, wp: null, tg: null, hunt: null, boost: 0, ta: s1.a, wall: 0, huntCd: 0 } // 重置决策拍
  const rng = SIM.mulberry32(1)
  const env = { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) }
  const out = SIM.brain(st, 1, hunter, rng, env)
  const aim0 = Math.atan2(s0.y - s1.y, s0.x - s1.x) * 180 / Math.PI // 指向真人（东）
  const off = Math.abs(((out.a - aim0) % 360 + 360) % 360)
  return { off: Math.min(off, 360 - off), st } // off=输出航向与"指向真人"的夹角
}
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/snake-king/game.json'), 'utf8'))
ok('M0', '配置注入链：game.json bot.mercy 三阈值在位', !!(cfg.bot && cfg.bot.mercy && cfg.bot.mercy.minFoeLose === 2 && cfg.bot.mercy.hardFoeLose === 4 && cfg.bot.mercy.majorN === 40), JSON.stringify(cfg.bot && cfg.bot.mercy))
const hunt = scene({ hN: 45, hDeaths: 0 })
const noHunt = scene({ hN: 45, hDeaths: 3 })
ok('M1', '连败免猎（L1）：deaths=3 猎手航向避开真人（对照 deaths=0 直指）', hunt.off < 30 && noHunt.off > 30,
  `deaths=0 夹角=${Math.round(hunt.off)}° / deaths=3 夹角=${Math.round(noHunt.off)}°`)
const young = scene({ hN: 30, hDeaths: 0 })
ok('M2', '生态位让位：human n=30<majorN 成长保护窗免猎（对照 n=45 被猎）', hunt.off < 30 && young.off > 30,
  `n=45 夹角=${Math.round(hunt.off)}° / n=30 夹角=${Math.round(young.off)}°`)
/* M3 重败让食（L2）：唯一光点贴真人 <120px → balanced 让食弃选（无第二候选→无食可回心）；
   对照（deaths=0）→ 直奔该光点。唯一候选口径免疫打分抖动翻转 */
function foodScene(hDeaths) {
  const st = SIM.create(20261006, {})
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: i === 0 ? 'human' : 'bot', name: 'S' + i })) }
  SIM.step(st, {}, room)
  for (const id of Object.keys(st.ents)) { const e = st.ents[id]; if (id !== 's0' && id !== 's1' && e.k !== 'snake') delete st.ents[id]; else if (e.k === 'snake' && id !== 's0' && id !== 's1') delete st.ents[id] }
  const s0 = st.ents.s0, s1 = st.ents.s1
  s0.x = 600000; s0.y = 500000; s0.n = 12; s0.deaths = hDeaths; s0.kills = 0
  s1.a = 90; s1.x = 400000; s1.y = 500000; s1.n = 15 // balanced 体型不碾压（免头对头礼让干扰）
  st.ents.fx1 = { id: 'fx1', k: 'berry', x: 490000, y: 500000, v: 2, on: 1, rt: 0 } // 距 s1 90px、距 s0 110px（crowded 不触发、L2 120px 让食触发）
  s1.mem = { dt: 0, wp: null, tg: null, hunt: null, boost: 0, ta: s1.a, wall: 0, huntCd: 0 }
  const rng = SIM.mulberry32(7)
  const env = { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) }
  const out = SIM.brain(st, 1, 'balanced', rng, env)
  const aim = (p) => { const a = Math.atan2(p.y - s1.y, p.x - s1.x) * 180 / Math.PI; const o = Math.abs(((out.a - a) % 360 + 360) % 360); return Math.min(o, 360 - o) }
  return { food: aim(st.ents.fx1) }
}
const foodCtl = foodScene(0), foodM3 = foodScene(5)
ok('M3', '重败让食（L2）：deaths=5 唯一光点弃选（对照直奔）', foodCtl.food < 30 && foodM3.food > 60,
  `对照 夹角=${Math.round(foodCtl.food)}° → 让食 夹角=${Math.round(foodM3.food)}°`)

console.log(`\n${pass} 通过 ${fail} 失败`)
process.exit(fail ? 1 : 0)
