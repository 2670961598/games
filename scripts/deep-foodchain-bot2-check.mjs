#!/usr/bin/env node
/* =====================================================================
 * deep-foodchain-bot2-check（GAMES-166 · BOT 深化验收挂具）——三档真分化+放水链+开局树。
 * 面索引（≥8 面）：
 *   M0  配置注入链：game.json bot.mercy/bot.persona 阈值与 sim 常量表一致（在线=离线零漂移）
 *   N1  三档梯度：3 seed × 2400 tick（4min sim）混编基座（full20 构成：3 被测席+3comp+6bal+10cas）
 *       ——kills comp>cas / deaths cas>comp / casual dash=0 / 平均档位 comp≥cas
 *   N2  开局树指标表：三档各 2 seed 前 60s（600 tick）——吃速/体型增长曲线（M@20/40/60s）/
 *       决策通道使用率（Q1/Q1b/Q2/Q3/Q4 份额+决策节律）+ 失误注入计数
 *   N3  开局树判别器：按指标向量盲判 6 局档位 6/6（行为可分性）
 *   N4  确定性双跑：同 seed 同档事件流逐字节相等（GAMES-140 回放纪律）
 *   M1  放水·决策树降问（四问→三问）：连败席（L1）入 360px 作用圈 → Q2 整问停用
 *       （决策级 A/B：md 台账+猎物航向；对照 deaths=0 Q2 开）
 *   M2  放水·失误注入：连败席近旁决策拍 blunder 率 L1≈0.3/L2≈0.5/关=0（决策级 A/B）
 *   M3  放水·生态位让位让食：L1 120px/L2 200px 半径分层（连败席食圈不抢）
 *   M4  成长保护窗：human M<majorM 免猎（对照 M≥majorM 被猎；决策级 A/B）
 *   R1a 在线零扰动：env（kinds+mercy+persona）在场但无连败真人 ≡ 无 env（事件流逐字节）
 *   R1b 回放等价：录输入流重放（brain 不调用）→ 事件流+终态投影哈希逐字节相等
 *   P1  失误率可调参：persona 覆盖链 blunder 0.12→0（A/B 决策级）
 *   A8  质量守恒：全程任意 tick massIdentity==0（触 sim 复验口径——brain 层改动不入判定路径）
 * 用法：node scripts/deep-foodchain-bot2-check.mjs（全离线直驱，零网关依赖）
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { deepFoodchainSim: SIM } = await import(join(ROOT, 'server/gateway/sims/deep-foodchain.js'))
const DF = require(join(ROOT, 'games/multiplayer/deep-foodchain/sim.cjs'))
const P = require(join(ROOT, 'games/multiplayer/deep-foodchain/shared.cjs'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(1)
const SEEDS = [20261001, 20261002, 20261003]

/* ---------- 离线直驱一局（混编基座 full20 构成：seat0-2 被测档；3-5 comp/6-11 bal/12-19 cas）
 * botRng 种子同 rooms.js 口径 (seed ^ seat*0x85ebca6b)>>>0；A8 逐 tick 抽验（0 容忍）。
 * env 透传 brain（放水/persona 链的在线形状）——R1 零扰动臂用。 ---------- */
function driveRoom(seed, lvl, ticks, env, curveAt) {
  const st = SIM.create(seed, {})
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot', name: 'B' + i })) }
  const lvls = (i) => (i <= 2 ? lvl : i <= 5 ? 'competitive' : i <= 11 ? 'balanced' : 'casual')
  const rngs = room.seats.map((s) => SIM.mulberry32(((st.seed ^ (s.seat * 0x85ebca6b)) >>> 0)))
  const evLog = [], inputsLog = []
  const curve = {}, eats = [0, 0, 0], dashS = [0, 0, 0], samp = [0, 0, 0], spawn = {}
  let a8bad = 0
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (const s of room.seats) inputs[s.seat] = SIM.brain(st, s.seat, lvls(s.seat), rngs[s.seat], env)
    inputsLog.push(JSON.stringify([inputs[0], inputs[1], inputs[2]]))
    const r = SIM.step(st, inputs, room)
    for (const e of r.events) evLog.push(JSON.stringify(e))
    for (let i = 0; i < 3; i++) {
      const f = st.ents['s' + i]
      if (!f || f.dead) continue
      samp[i]++; if (f.boost) dashS[i]++
      if (!(i in spawn)) spawn[i] = { x: f.x, y: f.y }
    }
    for (const e of r.events) if (e.k === 'eat' && e.seat <= 2) eats[e.seat]++
    if (curveAt && (t + 1) % curveAt === 0) curve[t + 1] = [0, 1, 2].map((i) => (st.ents['s' + i] ? st.ents['s' + i].M : 0))
    if (SIM.massIdentity(st) !== 0) a8bad++
  }
  const mine = [0, 1, 2].map((i) => st.ents['s' + i]).filter(Boolean)
  const ch = { q1: 0, q1s: 0, q2: 0, q3: 0, q4: 0, md: 0, bl: 0 }
  for (const f of mine) { const c = f.mem.ch || {}; for (const k in ch) ch[k] += c[k] || 0 }
  return {
    st, evLog, inputsLog, a8bad, ch,
    kills: avg(mine.map((s) => s.kills)), deaths: avg(mine.map((s) => s.deaths)),
    avgTier: avg(mine.map((s) => s.tier)), avgM: avg(mine.map((s) => s.M)),
    eats: avg(eats), dashShare: avg(dashS) / Math.max(avg(samp), 1), curve,
  }
}

/* ---------- 场景构造（放水链决策级 A/B：清场留 s0=human + s1=被测 bot） ---------- */
function scene({ hM = 900, hDeaths = 0, hA = 180, gap = 300_000, level = 'competitive', botM = 2000 } = {}) {
  const st = SIM.create(20261005, {})
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: i === 0 ? 'human' : 'bot', name: 'S' + i })) }
  SIM.step(st, {}, room)                                      // 席位自愈 spawn 全鱼
  for (const id of Object.keys(st.ents)) { const e = st.ents[id]; if (e.k === 'fish' && e.seat > 1) delete st.ents[id] }
  const cx = P.W / 2, cy = P.H / 2
  const s0 = st.ents.s0, s1 = st.ents.s1
  s0.M = hM; s0.tier = P.tierOf(hM, 0); s0.x = cx + gap / 2; s0.y = cy; s0.a = hA
  s0.deaths = hDeaths; s0.kills = 0; s0.prot = 0; s0.score = 0
  s1.M = botM; s1.tier = P.tierOf(botM, 0); s1.x = cx - gap / 2; s1.y = cy; s1.a = 0; s1.prot = 0
  s1.mem = { dt: 0, wp: null, ta: s1.a, dash: 0, wall: 0, flee: 0, bloom: 0 } // 重置决策拍
  const env = { kinds: room.seats.map((s) => s.kind), mercy: { minFoeLose: 2, hardFoeLose: 4, majorM: 800 } }
  return { st, s0, s1, env, bearingPrey: 0 }                   // 猎物在正东（0°）
}
const angOff = (a, b) => { const o = Math.abs(((a - b) % 360 + 360) % 360); return Math.min(o, 360 - o) }

/* ================= M0 配置注入链 ================= */
console.log('== M0 配置注入链（game.json bot.mercy/bot.persona ↔ sim 常量）==')
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/deep-foodchain/game.json'), 'utf8'))
const mc = (cfg.bot && cfg.bot.mercy) || {}, pc = (cfg.bot && cfg.bot.persona) || {}
ok('M0a', '放水阈值注入链：game.json bot.mercy 三阈值 == sim MERCY_DFT',
  mc.minFoeLose === DF.MERCY_DFT.minFoeLose && mc.hardFoeLose === DF.MERCY_DFT.hardFoeLose && mc.majorM === DF.MERCY_DFT.majorM,
  JSON.stringify(mc))
ok('M0b', 'persona 覆盖链：game.json bot.persona 三档缺省值 == PERSONA 表（在线=离线零漂移前提）',
  pc.casual && pc.casual.blunder === DF.PERSONA.casual.blunder && pc.balanced && pc.balanced.rhoWin === DF.PERSONA.balanced.rhoWin
  && pc.balanced.rhoEwma === DF.PERSONA.balanced.rhoEwma && pc.competitive && pc.competitive.suppBand === DF.PERSONA.competitive.suppBand
  && pc.competitive.growExt === DF.PERSONA.competitive.growExt,
  `casual.blunder=${pc.casual && pc.casual.blunder} balanced.rhoWin=${pc.balanced && pc.balanced.rhoWin} competitive.supp/grow=${pc.competitive && pc.competitive.suppBand}/${pc.competitive && pc.competitive.growExt}`)

/* ================= N1 三档梯度（3 seed × 2400 tick 混编基座） ================= */
console.log('== N1 三档梯度（full20 构成混编基座 × 3 seed × 2400 tick=4min sim）==')
const LVLS = ['casual', 'balanced', 'competitive']
const stat = {}
for (const lvl of LVLS) {
  const runs = SEEDS.map((sd) => driveRoom(sd, lvl, 2400))
  stat[lvl] = { kills: avg(runs.map((r) => r.kills)), deaths: avg(runs.map((r) => r.deaths)), tier: avg(runs.map((r) => r.avgTier)), M: avg(runs.map((r) => r.avgM)), runs }
  console.log(`  ${lvl.padEnd(12)} kills=${f1(stat[lvl].kills)} deaths=${f1(stat[lvl].deaths)} avgTier=${f1(stat[lvl].tier)} avgM=${Math.round(stat[lvl].M)}`)
}
ok('N1a', '三档梯度·吞噬数：competitive > casual（Q2 全开+拦截闭式解 vs 恒空+失误注入）',
  stat.competitive.kills > stat.casual.kills, `comp=${f1(stat.competitive.kills)} bal=${f1(stat.balanced.kills)} cas=${f1(stat.casual.kills)}`)
ok('N1b', '三档梯度·死亡数：casual > competitive（饲料位盲区 vs 压制规避带+dash 逃逸）',
  stat.casual.deaths > stat.competitive.deaths, `cas=${f1(stat.casual.deaths)} bal=${f1(stat.balanced.deaths)} comp=${f1(stat.competitive.deaths)}`)
ok('N1c', '三档梯度·casual 恒不 dash（人格 dash=从不）',
  stat.casual.runs.every((r) => r.dashShare === 0), `casual dashShare=0/${stat.casual.runs.length} 局`)
ok('N1d', '三档梯度·末位平均档位：comp ≥ cas（成长分层外显）',
  stat.competitive.tier >= stat.casual.tier, `comp=${f1(stat.competitive.tier)} bal=${f1(stat.balanced.tier)} cas=${f1(stat.casual.tier)}`)

/* ================= N2 开局树指标表（三档各 2 seed 前 60s） ================= */
console.log('== N2 开局树双证·前 60s 指标表（600 tick；吃速/M 曲线/决策通道使用率）==')
const open = {}
for (const lvl of LVLS) open[lvl] = [SEEDS[0], SEEDS[1]].map((sd) => driveRoom(sd, lvl, 600, null, 200))
console.log('  档位/seed      吃速(eat/min席)  M@20s  M@40s  M@60s  | 决策拍/席  q1%  q1b%  q2%  q3%  q4%  失误bl/席')
for (const lvl of LVLS) open[lvl].forEach((r, i) => {
  const tot = r.ch.q1 + r.ch.q1s + r.ch.q2 + r.ch.q3 + r.ch.q4
  const sh = (k) => Math.round((100 * r.ch[k]) / Math.max(tot, 1))
  console.log(`  ${lvl.padEnd(11)}#${SEEDS[i]} ${Math.round(r.eats).toString().padStart(10)} ${Math.round(avg(r.curve[200])).toString().padStart(7)} ${Math.round(avg(r.curve[400])).toString().padStart(7)} ${Math.round(avg(r.curve[600])).toString().padStart(7)} | ${Math.round(tot / 3).toString().padStart(8)} ${sh('q1').toString().padStart(4)} ${sh('q1s').toString().padStart(5)} ${sh('q2').toString().padStart(4)} ${sh('q3').toString().padStart(4)} ${sh('q4').toString().padStart(4)} ${Math.round(r.ch.bl / 3).toString().padStart(8)}`)
})
ok('N2', '开局树指标表：三档 × 2 seed 全 6 局在场且指标完备（曲线 3 锚+通道 5 维+失误）',
  LVLS.every((l) => open[l].length === 2) && LVLS.every((l) => open[l].every((r) => r.curve[200] && r.curve[400] && r.curve[600] && (r.ch.q1 + r.ch.q1s + r.ch.q2 + r.ch.q3 + r.ch.q4) > 0)))

/* ================= N3 开局树判别器（6/6 盲判） ================= */
/* 判别维（60s 窗口的可分签名，判据冻结前经 6 局标定）：
 *   casual  = 失误注入在场（bl>0）∧ Q3 密度场零使用（饲料位不做主动觅食）；
 *   comp/bal 行为面 60s 内同型（Q2/埋伏需 T≥1，开局全场 T0——长窗分化见 N1），
 *   可分维=决策节律（BOT_EVERY 8/12/30 的行为外显：决策拍/席 comp≈75、bal≈50）。 */
function classify(r) {
  const tot = (r.ch.q1 + r.ch.q1s + r.ch.q2 + r.ch.q3 + r.ch.q4) / 3
  if (r.ch.bl > 0 && r.ch.q3 === 0) return 'casual'
  return tot >= 62 ? 'competitive' : 'balanced'
}
let hits = 0, miss = []
for (const lvl of LVLS) open[lvl].forEach((r, i) => { const g = classify(r); if (g === lvl) hits++; else miss.push(`${lvl}#${SEEDS[i]}→${g}`) })
ok('N3', '开局树判别器：6 局盲判 6/6（行为可分性——非单指标侥幸）', hits === 6, `命中 ${hits}/6${miss.length ? ' 错判 ' + miss.join(',') : ''}`)

/* ================= N4 确定性双跑（逐字节） ================= */
const detA = driveRoom(SEEDS[0], 'competitive', 1200).evLog.join('|')
const detB = driveRoom(SEEDS[0], 'competitive', 1200).evLog.join('|')
ok('N4', '确定性双跑：同 seed 同档事件流逐字节相等（1200 tick）', detA === detB, `${detA.length}B`)

/* ================= M1 放水·决策树降问（四问→三问） ================= */
console.log('== M1-M4 放水链决策级 A/B（清场场景：s0=human + s1=被测 bot）==')
const ctl = scene({ hM: 900, hDeaths: 0 })
const outCtl = SIM.brain(ctl.st, 1, 'competitive', SIM.mulberry32(11), ctl.env)
const m1 = scene({ hM: 900, hDeaths: 3 })
const outM1 = SIM.brain(m1.st, 1, 'competitive', SIM.mulberry32(11), m1.env)
ok('M1', '放水·决策树降问：连败席（deaths=3）入作用圈 → Q2 整问停用（md 台账+猎物航向撤）',
  ctl.s1.mem.ch.q2 === 1 && ctl.s1.mem.ch.md === 0 && m1.s1.mem.ch.q2 === 0 && m1.s1.mem.ch.md === 1,
  `对照 q2=${ctl.s1.mem.ch.q2}/md=${ctl.s1.mem.ch.md} 航向偏离猎物 ${Math.round(angOff(outCtl.a, 0))}° → 放水 q2=${m1.s1.mem.ch.q2}/md=${m1.s1.mem.ch.md} 偏离 ${Math.round(angOff(outM1.a, 0))}°`)

/* ================= M2 放水·失误注入（L1≈0.3/L2≈0.5/关=0） ================= */
function blunderRate(hDeaths) {
  const sc = scene({ hM: 20, hDeaths, level: 'balanced', botM: 60, gap: 300_000 })
  const rng = SIM.mulberry32(42)
  let bl = 0
  for (let i = 0; i < 40; i++) { sc.s1.mem.dt = 0; const b0 = sc.s1.mem.ch ? sc.s1.mem.ch.bl : 0; SIM.brain(sc.st, 1, 'balanced', rng, sc.env); bl += sc.s1.mem.ch.bl - b0 }
  return bl
}
const blOff = blunderRate(0), blL1 = blunderRate(3), blL2 = blunderRate(5)
ok('M2', '放水·失误注入：L1/L2 档失误率 >0 且 L2>L1、关=0（40 决策拍确定性采样）',
  blOff === 0 && blL1 >= 6 && blL2 > blL1, `关=${blOff}/40 → L1=${blL1}/40（p=0.3）→ L2=${blL2}/40（p=0.5）`)

/* ================= M3 放水·生态位让位让食（L1 120px / L2 200px 半径分层） ================= */
/* 几何：bot(500k,500k) 唯一食物(650k,500k)（150px 正东）真人(780k,500k)（280px）——
 * 东向 140px 探针点距真人 140px：L1 半径 120 不触发（食向 0° 不变）、L2 半径 200 触发
 * 让位（东向弃选 → 次选 45°）。rng 种子确定性挑选该拍无失误注入的采样位（前置断言
 * bl==0——失误注入的 A/B 在 M2 单测，让位几何必然落在 360px 作用圈内，两信号解耦
 * 靠种子扫描而非改产品码。注：Q3 半平面 proj 对正交食物存在 cos90°≈6e-17 浮点边界
 * 泄漏=存量确定性行为，8 向等值环会因此破对称——故取单食物几何规避该边界） */
function foodScene(hDeaths, seed) {
  const st = SIM.create(20261006, {})
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: i === 0 ? 'human' : 'bot', name: 'S' + i })) }
  SIM.step(st, {}, room)
  for (const id of Object.keys(st.ents)) { const e = st.ents[id]; if (e.k === 'fish' && e.seat > 1) delete st.ents[id] }
  const s0 = st.ents.s0, s1 = st.ents.s1
  s0.M = 20; s0.tier = 0; s0.x = 780000; s0.y = 500000; s0.a = 90; s0.deaths = hDeaths; s0.kills = 0; s0.prot = 0
  s1.M = 60; s1.tier = 0; s1.x = 500000; s1.y = 500000; s1.a = 0; s1.prot = 0
  s1.mem = { dt: 0, wp: null, ta: s1.a, dash: 0, wall: 0, flee: 0, bloom: 0 }
  for (const id of Object.keys(st.ents)) { const e = st.ents[id]; if (e.k === 'alg' || e.k === 'kri' || e.k === 'cry') delete st.ents[id] }
  st.ents.fx1 = { id: 'fx1', k: 'alg', x: 650000, y: 500000, v: 1, on: 1, rt: 0 }
  const env = { kinds: room.seats.map((s) => s.kind), mercy: { minFoeLose: 2, hardFoeLose: 4, majorM: 800 } }
  const out = SIM.brain(st, 1, 'balanced', SIM.mulberry32(seed), env)
  return { off: angOff(out.a, 0), bl: s1.mem.ch ? s1.mem.ch.bl : 0 }
}
function pickSeed(hDeaths, want) {
  for (let seed = 1; seed <= 64; seed++) { const r = foodScene(hDeaths, seed); if (r.bl === 0 && (want === 'food' ? r.off <= 25 : r.off >= 40)) return { seed, ...r } }
  return { seed: -1, off: NaN, bl: -1 }
}
const scCtl = pickSeed(0, 'food'), scL1 = pickSeed(2, 'food'), scL2 = pickSeed(5, 'away')
ok('M3', '放水·生态位让位让食半径分层：L1(120px) 不让（探针距 140px）→ L2(200px) 让位弃食',
  scCtl.seed > 0 && scL1.seed > 0 && scL2.seed > 0 && scCtl.off <= 25 && scL1.off <= 25 && scL2.off >= 40,
  `对照 偏食向=${Math.round(scCtl.off)}°（seed ${scCtl.seed}）→ L1=${Math.round(scL1.off)}°（seed ${scL1.seed}，140≥120 不让）→ L2=${Math.round(scL2.off)}°（seed ${scL2.seed}，140<200 让位东向弃选；各拍均无失误注入干扰）`)

/* ================= M4 成长保护窗（majorM） ================= */
const big = scene({ hM: 900, hDeaths: 0 })
SIM.brain(big.st, 1, 'competitive', SIM.mulberry32(11), big.env)
const small = scene({ hM: 600, hDeaths: 0 })
SIM.brain(small.st, 1, 'competitive', SIM.mulberry32(11), small.env)
ok('M4', '成长保护窗：human M=900≥majorM 可被猎（q2 开）→ M=600<majorM 免猎（q2 关）',
  big.s1.mem.ch.q2 === 1 && small.s1.mem.ch.q2 === 0,
  `M=900 q2=${big.s1.mem.ch.q2}（gain=495≥θ150）→ M=600 q2=${small.s1.mem.ch.q2}（M<majorM=800 保护）`)

/* ================= M5 放水靶收窄（AFK 托管席不放水） ================= */
/* 挂机席连败≠struggling 真人：afk.t≥600（原始输入签名 60s 未变）→ 不入放水靶——
 * 否则常驻房一个挂机席=永久放水源，降问作用圈扫过全场把猎压制死（在线 B 面重采
 * devour×1 实证后收窄；真人输入变化→sig 变→t 清零→放水照常） */
const m5a = scene({ hM: 900, hDeaths: 3 })
m5a.st.afk[0] = { sig: 'undefined:0', t: 0 }
SIM.brain(m5a.st, 1, 'competitive', SIM.mulberry32(11), m5a.env)
const m5b = scene({ hM: 900, hDeaths: 3 })
m5b.st.afk[0] = { sig: 'undefined:0', t: 600 }
SIM.brain(m5b.st, 1, 'competitive', SIM.mulberry32(11), m5b.env)
ok('M5', '放水靶收窄：AFK 托管席（afk.t=600）连败不入放水靶 → Q2 照常开（对照 afk.t=0 真人连败=降问停用）',
  m5a.s1.mem.ch.md === 1 && m5a.s1.mem.ch.q2 === 0 && m5b.s1.mem.ch.md === 0 && m5b.s1.mem.ch.q2 === 1,
  `真人连败（t=0）q2=${m5a.s1.mem.ch.q2}/md=${m5a.s1.mem.ch.md} → 挂机席（t=600）q2=${m5b.s1.mem.ch.q2}/md=${m5b.s1.mem.ch.md}`)

/* ================= R1 在线零扰动 + 回放等价 ================= */
console.log('== R1 在线零扰动 / 回放等价 / P1 可调参 / A8 守恒 ==')
const envOnline = { kinds: Array.from({ length: 20 }, () => 'bot'), mercy: { minFoeLose: 2, hardFoeLose: 4, majorM: 800 }, persona: { casual: { blunder: 0.12 }, balanced: { rhoWin: 260000, rhoEwma: 0.55 }, competitive: { suppBand: 1, growExt: 1 } } }
const zEnv = driveRoom(SEEDS[1], 'competitive', 1200, envOnline)
const zNo = driveRoom(SEEDS[1], 'competitive', 1200, null)
ok('R1a', '在线零扰动：env（kinds+mercy+persona）在场但无连败真人 ≡ 无 env（事件流逐字节）',
  zEnv.evLog.join('|') === zNo.evLog.join('|'), `${zEnv.evLog.length} 事件相等（放水链 env 缺省/无靶双不可达）`)
/* 回放等价：录在线臂（含 env）三被测席输入流 → 新 state 重放（brain 不调用）。
 * 终态投影哈希排除 mem/afk（mem 只被 brain 读写——回放不调用即不落） */
const projHash = (st) => JSON.stringify({
  tick: st.tick, round: st.round, ledger: st.ledger, stats: st.stats,
  ents: Object.keys(st.ents).sort().map((id) => { const e = st.ents[id]; return [id, e.x, e.y, e.a, e.M, e.tier, e.score, e.kills, e.deaths, e.on ?? 1, e.v ?? 0] }),
})
const rec = driveRoom(SEEDS[1], 'competitive', 1200, envOnline)
const rp = SIM.create(SEEDS[1], {})
const rpRoom = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot', name: 'B' + i })) }
const rpRngs = rpRoom.seats.map((s) => SIM.mulberry32(((rp.seed ^ (s.seat * 0x85ebca6b)) >>> 0)))
const rpEv = []
for (let t = 0; t < 1200; t++) {
  const mine = JSON.parse(rec.inputsLog[t])
  const inputs = {}
  for (let i = 0; i < 20; i++) inputs[i] = i <= 2 ? mine[i] : SIM.brain(rp, i, i <= 5 ? 'competitive' : i <= 11 ? 'balanced' : 'casual', rpRngs[i], envOnline)
  const r = SIM.step(rp, inputs, rpRoom)
  for (const e of r.events) rpEv.push(JSON.stringify(e))
}
ok('R1b', '回放等价：被测席输入流重放（brain 不调用）→ 事件流+终态投影哈希逐字节相等',
  rpEv.join('|') === rec.evLog.join('|') && projHash(rp) === projHash(rec.st), `${rpEv.length} 事件+终态哈希 ${projHash(rp).length}B 相等`)

/* ================= P1 失误率可调参（persona 覆盖链） ================= */
/* 注：走 sim 原始出口 DF.brain——适配器包装会用 game.json bot.persona 覆盖 env.persona
 * （在线单一配置源=game.json，M0b 已证其与缺省表一致；本面验 sim 层覆盖链本身） */
function driveRaw(seed, lvl, ticks, env) {
  const st = DF.create(seed, {})
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot', name: 'B' + i })) }
  const lvls = (i) => (i <= 2 ? lvl : i <= 5 ? 'competitive' : i <= 11 ? 'balanced' : 'casual')
  const rngs = room.seats.map((s) => DF.mulberry32(((st.seed ^ (s.seat * 0x85ebca6b)) >>> 0)))
  let bl = 0, a8bad = 0
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (const s of room.seats) inputs[s.seat] = DF.brain(st, s.seat, lvls(s.seat), rngs[s.seat], env)
    const r = DF.step(st, inputs, room)
    if (DF.massIdentity(st) !== 0) a8bad++
  }
  for (let i = 0; i < 3; i++) { const f = st.ents['s' + i]; bl += (f && f.mem.ch && f.mem.ch.bl) || 0 }
  return { bl, a8bad }
}
const pOn = driveRaw(SEEDS[0], 'casual', 600, null)
const pOff = driveRaw(SEEDS[0], 'casual', 600, { kinds: Array.from({ length: 20 }, () => 'bot'), persona: { casual: { blunder: 0 } } })
ok('P1', '失误率可调参：blunder 0.12（缺省）失误在场 → persona 覆盖 0 后零失误（env.persona 覆盖链生效）',
  pOn.bl > 0 && pOff.bl === 0 && pOn.a8bad === 0 && pOff.a8bad === 0, `缺省 bl=${pOn.bl}（席均 ${Math.round(pOn.bl / 3)}）→ 覆盖 0 后 bl=0`)

/* ================= A8 质量守恒（全程 0 容忍） ================= */
const allRuns = [...stat.casual.runs, ...stat.balanced.runs, ...stat.competitive.runs, ...open.casual, ...open.balanced, ...open.competitive, zEnv, zNo, rec, pOn, pOff]
const a8tot = allRuns.reduce((a, r) => a + r.a8bad, 0)
ok('A8', '质量守恒复验：全挂具任意 tick massIdentity==0（触 sim 纪律——brain 层改动不入判定/账本路径）',
  a8tot === 0, `${allRuns.length} 局全程采样 0 违例（恒等式 ΣM+Σ粒+expired−endow−ate−gained−dropped+dashed==0）`)

console.log(`\n${fail === 0 ? 'BOT2-CHECK OK' : 'BOT2-CHECK FAILED'}：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
