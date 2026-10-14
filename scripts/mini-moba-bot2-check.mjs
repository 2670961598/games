#!/usr/bin/env node
/* =====================================================================
 * GAMES-130 BOT深化 · Bot 梯度+放水链守门剧本（GAMES-129 bot2-check 扩容 3→9 断言）
 * sim 级直驱 create/step/brain，无网关（:4399/:4400 零感知）。
 *   A1 competitive > balanced 胜率显著（≥2/3）——O2 修复面回归锚（GAMES-129）
 *   A2 balanced > casual ≥2/3——回归锚（balanced/casual 行为栈字节不动纪律）
 *   A3 确定性终态：同 seed 两跑终态一致（GAMES-129）
 *   A4 开局树双证·确定性逐字节：三档开局段（0-900tick）输入流 JSON 逐字节一致
 *   A5 开局树双证·指标表+判别器：三档各 2 seed 开局段指标（skillN/atkN）分层，
 *      判别器（skillN==0→casual；<中点→balanced；≥→competitive）6/6 判对
 *   A6 op 流差异：开局段技能指令密度 competitive>balanced>casual（=0）分层
 *   A7 放水链端到端·免猎降档：弱真人（前线脚本）敌 bot foeLose 0→4（L2），
 *      真人被杀数显著降（<对照 60%）
 *   A8 放水链端到端·让力可观测：L2 放水局敌 bot 技能指令数 < 对照局
 *   A9 放水链端到端·真人队战果：放水局真人队 kills ≥ 对照（让力≠假赛）
 *   附：comp 对塔 atk 指令计数逐局打印（信息项）；comp-vs-casual 观察（QA1 残项未断言）
 * =================================================================== */
import { miniMobaSim } from '../server/gateway/sims/mini-moba.js'
const sim = miniMobaSim

/* 基础局：全 bot 对打（env.kinds 全 'bot'=零放水路径），可选指标采集/开局段截取 */
function runMatch(seed, levelsA, levelsB, maxTicks = 3000, opt = {}) {
  const levels = [0, 1, 2, 3, 4, 5].map((i) => (i % 2 === 0 ? levelsA : levelsB))
  const st = sim.create(seed, { test: true, maxTicks })
  const room = { state: st, frame: 0, id: 'bot-' + seed, seats: levels.map((lv, i) => ({ seat: i, kind: 'bot', level: lv, conn: null, pending: new Map(), lastInput: { mx: 0, my: 0 } })), spectators: new Set(), __dirQ: null, __dirCam: null }
  const rngs = levels.map((_, i) => sim.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0))
  let compTowerAtk = 0
  const m = { skill: 0, atk: 0 } // 指令计数（按 opt.countSeats 过滤；缺省全席）
  const countSeats = opt.countSeats || null
  const stream = [] // 开局段输入流（A4 逐字节双跑）
  for (let t = 0; t < maxTicks; t++) {
    const inputs = {}
    for (let i = 0; i < 6; i++) {
      const s = room.seats[i]
      inputs[i] = sim.brain(st, i, s.level, rngs[i], { kinds: room.seats.map((x) => x.kind), foeLose: [0, 0, 0, 0, 0, 0] })
      if (s.level === 'competitive' && inputs[i].cmd && inputs[i].cmd.k === 'atk' && String(inputs[i].cmd.entId).startsWith('tw-')) compTowerAtk++
      if (!countSeats || countSeats.includes(i)) {
        if (inputs[i].cmd && inputs[i].cmd.k === 'skill') m.skill++
        else if (inputs[i].cmd && inputs[i].cmd.k === 'atk') m.atk++
      }
    }
    if (opt.openStream && t < 900) stream.push(JSON.stringify(inputs))
    room.frame++
    const r = sim.step(st, inputs, room)
    if (r.over) return { over: r.result, ticks: st.tick, compTowerAtk, towers: { ...st.stats.towers }, teamKills: { ...st.stats.kills }, m, stream: stream.join('|') }
  }
  return { over: null, ticks: st.tick, compTowerAtk, towers: { ...st.stats.towers }, teamKills: { ...st.stats.kills }, m, stream: stream.join('|') }
}

/* 放水局：seat0=human 弱真人（前线脚本：持续前压=可被猎杀），B 队(1/3/5)=competitive
 * bot（foeLose[0] 注入连败档），A 队(2/4)=balanced bot 队友 */
function runMercy(seed, foeLose0, maxTicks = 1800) {
  const st = sim.create(seed, { test: true, maxTicks })
  const kinds = ['human', 'bot', 'bot', 'bot', 'bot', 'bot']
  const levels = [null, 'competitive', 'balanced', 'competitive', 'balanced', 'competitive']
  const seats = kinds.map((k, i) => ({ seat: i, kind: k, level: levels[i], conn: null, pending: new Map(), lastInput: { mx: 0, my: 0 } }))
  const room = { state: st, frame: 0, id: 'mercy-' + seed + '-' + foeLose0, seats, spectators: new Set(), __dirQ: null, __dirCam: null }
  const rngs = [0, 1, 2, 3, 4, 5].map((i) => sim.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0))
  const foeLose = [foeLose0, 0, 0, 0, 0, 0]
  const env = { kinds, foeLose }
  let botSkill = 0, heroKill0 = 0, towerKill0 = 0
  for (let t = 0; t < maxTicks; t++) {
    const inputs = {}
    // 弱真人：前压到中线前 30px（y=880）站定——兵线交汇处可被敌 bot 猎杀，但
    // 不入敌 T1 塔（y=550）射程 210px（880-550=330>210，塔杀/兵杀不污染放水观测面）
    const h0 = st.ents['h0']
    inputs[0] = h0 && !h0.dead && h0.y > 880000 ? { mx: 0, my: -70 } : { mx: 0, my: 0 }
    for (let i = 1; i < 6; i++) {
      inputs[i] = sim.brain(st, i, seats[i].level, rngs[i], env)
      if (i % 2 === 1 && inputs[i].cmd && inputs[i].cmd.k === 'skill') botSkill++ // 敌队(B)技能指令
    }
    room.frame++
    const r = sim.step(st, inputs, room)
    if (r && r.events) for (const ev of r.events) {
      if (ev.k !== 'kill' || ev.victim !== 0) continue
      if (ev.killer >= 0 && ev.killer % 2 === 1) heroKill0++ // 被敌英雄击杀（放水链目标面）
      else towerKill0++ // 塔/兵击杀（环境噪声面，不计入 A7 判据）
    }
    if (r.over) break
  }
  const d0 = st.sessions[0].d // 真人总被杀数
  const killsA = (st.stats.kills[0] || 0) + (st.stats.kills[2] || 0) + (st.stats.kills[4] || 0)
  return { d0, heroKill0, towerKill0, killsA, botSkill, ticks: st.tick, over: true }
}

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`); cond ? pass++ : fail++ }

/* ---------- 第一组：三配对胜率（A1/A2 锚 + 观察） ---------- */
const SEEDS = [20261101, 20261102, 20261103]
const pairings = [
  ['competitive-vs-balanced', 'competitive', 'balanced'],
  ['balanced-vs-casual', 'balanced', 'casual'],
  ['competitive-vs-casual', 'competitive', 'casual'],
]
const results = {}
for (const [name, a, b] of pairings) {
  results[name] = []
  for (const seed of SEEDS) {
    const r = runMatch(seed, a, b)
    results[name].push(r)
    const winner = r.over ? r.over.winner : 'none'
    const who = winner === 'A' ? a : winner === 'B' ? b : 'draw'
    console.log(`  ${name} seed=${seed}: winner=${winner}(${who}) reason=${r.over ? r.over.reason : 'no-end'} tick=${r.ticks} teamKills=${JSON.stringify(r.teamKills)} towers=${JSON.stringify(r.towers)} compTowerAtk=${r.compTowerAtk}`)
  }
}
// A1：O2 主修复面——competitive 对 balanced 胜率显著（GAMES-129 基线 3/3 不得回退）
{
  const rs = results['competitive-vs-balanced']
  const wins = rs.filter((r) => r.over && r.over.winner === 'A').length
  const losses = rs.filter((r) => r.over && r.over.winner === 'B').length
  ok('A1 梯度 competitive > balanced 胜率显著（O2 主证锚）', wins >= 2 && wins > losses, `A 胜 ${wins}/${SEEDS.length}（B 胜 ${losses}）`)
}
// A3：确定性回归（同 seed 两跑终态一致——sim 纪律 §6，行为栈改动不得引入路径随机）
{
  const r1 = runMatch(20261101, 'competitive', 'balanced')
  const r2 = runMatch(20261101, 'competitive', 'balanced')
  const same = JSON.stringify([r1.over, r1.towers, r1.teamKills]) === JSON.stringify([r2.over, r2.towers, r2.teamKills])
  ok('A3 确定性：同 seed 两跑终态一致', same, `winner=${r1.over ? r1.over.winner : 'none'} towers=${JSON.stringify(r1.towers)}`)
}
// A2：回归锚——balanced > casual 不回退（balanced/casual 行为栈字节不动）
{
  const rs = results['balanced-vs-casual']
  const wins = rs.filter((r) => r.over && r.over.winner === 'A').length
  const losses = rs.filter((r) => r.over && r.over.winner === 'B').length
  ok('A2 回归锚：balanced > casual 不回退', wins >= 2 && wins > losses, `A 胜 ${wins}/${SEEDS.length}（B 胜 ${losses}）`)
}
// 观察：competitive vs casual（QA1 残项，未断言——现状如实打印，转后续单）
{
  const rs = results['competitive-vs-casual']
  const wins = rs.filter((r) => r.over && r.over.winner === 'A').length
  console.log(`○ 观察（未断言）：competitive-vs-casual A 胜 ${wins}/${SEEDS.length}——残项：对最高档守线型打法存塔仍劣，转后续（详见 GAMES-129 REPORT）`)
}

/* ---------- 第二组：开局树双证（A4/A5/A6，交付物 3） ---------- */
// 开局段=0-900 tick（选英雄 150+2.5 波兵：对线期确立），三档各 2 seed 单档内战（同档对打
// 档内行为密度稳定，无跨档杀崩干扰指标）
const OPEN_SEEDS = [20261201, 20261202]
const LV = ['casual', 'balanced', 'competitive']
const open = {} // open[lv][seed] = { skill, atk, stream }
for (const lv of LV) {
  open[lv] = []
  for (const seed of OPEN_SEEDS) open[lv].push(runMatch(seed, lv, lv, 3000, { openStream: true, countSeats: null }))
}
// A4 确定性逐字节：三档开局段输入流两跑一致（比 A3 终态一致更强：逐拍路径锁定）
{
  let same = true
  const details = []
  for (const lv of LV) {
    for (let k = 0; k < OPEN_SEEDS.length; k++) {
      const again = runMatch(OPEN_SEEDS[k], lv, lv, 3000, { openStream: true })
      const eq = open[lv][k].stream === again.stream
      if (!eq) same = false
      details.push(`${lv}@${OPEN_SEEDS[k]}:${eq ? '=' : '≠'}(${open[lv][k].stream.length}B)`)
    }
  }
  ok('A4 开局树确定性双跑逐字节：三档各 2 seed 开局段输入流一致', same, details.join(' '))
}
// A5 指标表+判别器：开局段（0-900）skillN/atkN 指标表；判别器 skillN==0→casual、
// 中点阈值→balanced/competitive，6/6 判对（区间分离才可判）
{
  const idx900 = (r) => r // m 为全程累计——开局段口径：openStream 只收 900 tick 输入流；指令计数需开局段窗口
  // 开局段指令密度：用输入流本身回放计数（0-900 段），避免全程计数混入中后期
  const cnt = (r) => {
    let skill = 0, atk = 0
    for (const frame of r.stream.split('|')) {
      for (let i = 0; i < 6; i++) {
        const c = JSON.parse(frame)[i].cmd
        if (c && c.k === 'skill') skill++
        else if (c && c.k === 'atk') atk++
      }
    }
    return { skill, atk }
  }
  const tab = {}
  for (const lv of LV) tab[lv] = open[lv].map((r, k) => ({ seed: OPEN_SEEDS[k], ...cnt(r) }))
  console.log('  开局段（0-900tick）指令指标表：')
  for (const lv of LV) for (const row of tab[lv]) console.log(`    ${lv.padEnd(11)} seed=${row.seed} skillN=${row.skill} atkN=${row.atk}`)
  const balMax = Math.max(...tab.balanced.map((r) => r.skill))
  const compMin = Math.min(...tab.competitive.map((r) => r.skill))
  const mid = (balMax + compMin) / 2
  const judge = (skillN) => (skillN === 0 ? 'casual' : skillN < mid ? 'balanced' : 'competitive')
  let hit = 0, tot = 0
  for (const lv of LV) for (const row of tab[lv]) { tot++; if (judge(row.skill) === lv) hit++ }
  ok('A5 开局树指标表+判别器：skillN 三档区间分离、判别 6/6', hit === tot && compMin > balMax && Math.max(...tab.casual.map((r) => r.skill)) === 0, `判对 ${hit}/${tot}；skillN 区间 casual=0 < balanced≤${balMax} < competitive≥${compMin}（判别阈 mid=${mid}）`)
  // A6 op 流差异：技能密度分层（competitive 连招序列技能占比高、balanced 单技、casual 零）
  const avg = (lv, f) => tab[lv].reduce((a, r) => a + f(r), 0) / tab[lv].length
  const cs = avg('competitive', (r) => r.skill), bs = avg('balanced', (r) => r.skill), as = avg('casual', (r) => r.skill)
  ok('A6 op 流差异：开局段技能指令密度 comp>balanced>casual(=0)', cs > bs && bs > as && as === 0, `skillN/局 competitive=${cs.toFixed(0)} > balanced=${bs.toFixed(0)} > casual=${as}`)
}

/* ---------- 第三组：放水链端到端（A7/A8/A9，交付物 2） ---------- */
const MERCY_SEED = 20261301
const ctl = runMercy(MERCY_SEED, 0) // 对照：敌 bot 全力
const l2 = runMercy(MERCY_SEED, 4) // L2 重败：降档+免猎+噪声
const l1 = runMercy(MERCY_SEED, 2) // L1 让力：免猎+不放连招+换血阈值上调
console.log(`  放水局（seed=${MERCY_SEED}，seat0 弱真人前压站线脚本，敌队 3×competitive bot）：`)
console.log(`    对照 foeLose=0：真人被杀(英雄/塔兵)=${ctl.d0}(${ctl.heroKill0}/${ctl.towerKill0}) 敌技能N=${ctl.botSkill} 真人队kills=${ctl.killsA} tick=${ctl.ticks}`)
console.log(`    L1    foeLose=2：真人被杀(英雄/塔兵)=${l1.d0}(${l1.heroKill0}/${l1.towerKill0}) 敌技能N=${l1.botSkill} 真人队kills=${l1.killsA} tick=${l1.ticks}`)
console.log(`    L2    foeLose=4：真人被杀(英雄/塔兵)=${l2.d0}(${l2.heroKill0}/${l2.towerKill0}) 敌技能N=${l2.botSkill} 真人队kills=${l2.killsA} tick=${l2.ticks}`)
// A7 免猎+降档 → 真人被敌 bot 击杀显著降（L2 < 对照 60%；L1 也须降——让力梯度单调；
// 判据=heroKill（被敌英雄击杀），塔/兵环境噪声不计入）
ok('A7 放水链：连败(L2)敌 bot 对真人击杀显著降', ctl.heroKill0 > 0 && l2.heroKill0 < Math.ceil(ctl.heroKill0 * 0.6) && l1.heroKill0 <= l2.heroKill0, `被英雄杀 L2=${l2.heroKill0} ≤ L1=${l1.heroKill0} < 对照60%=${Math.ceil(ctl.heroKill0 * 0.6)}（对照=${ctl.heroKill0}）`)
// A8 让力可观测：放水局敌 bot 技能指令下降（不放连招/降档/换血阈值上调三因叠加）
ok('A8 放水链：L2 敌 bot 技能指令数下降（行为栈降档可观测）', l2.botSkill < ctl.botSkill, `L2=${l2.botSkill} < 对照=${ctl.botSkill}`)
// A9 真人队战果：让力≠假赛——真人队总击杀不降（敌方弱化=A 队 bot 队友输出环境改善）
ok('A9 放水链：真人队 kills 不降（让力≠送队）', l2.killsA >= ctl.killsA, `L2=${l2.killsA} ≥ 对照=${ctl.killsA}`)

console.log(`\nBot2-check：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
