/* =====================================================================
 * tactics-duel-bot2-check（GAMES-121 · BOT深化验收挂具）——四支柱：
 *   N1 三档梯度断言扩容：胜率梯度（fix1 口径双臂×两种子集 32 局/配对）
 *      + 风格指标分层（atk/turn 单调：casual<balanced<competitive；kills
 *      comp>bal）+ 失误率分层（fireOwn casual>0 且 bal=comp=0；空过回合
 *      casual>balanced）——指标全部纯 opsLog/stats 口径（自写观测不额外调
 *      brain，防决策队列污染）
 *   N2 开局树双证：三档各 2 seed 开局 30s（3000 tick=部署 20s+首回合段）
 *      指标表 + 离线判别器（开局窗（seat0 前三手）逐 op 重放一致性：comp
 *      的移动单位=bookNext 提议单位（构造性），balanced 仅随机命中）→ 6/6
 *      全对=行为可分性；+ 确定性双跑（opsLog 逐字节相等）
 *   N3 放水链端到端：M0 配置注入链（game.json bot.mercy → 适配器 env.mercy）
 *      + E 链（网关 pulse 台账语义仿真：连败×3→L2 让力→真人胜→清零→回全档，
 *      终局序列断言）+ 决策级 L1 分叉 + 放水局确定性双跑
 *   N4 回归提示位（api-check 六作抽查+perf-smoke 在单据流程跑，本挂具不重复）
 * 用法：node scripts/tactics-duel-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const D = require(join(ROOT, 'games/multiplayer/tactics-duel/sim.cjs'))
const { tacticsDuelSim: SIM } = await import(join(ROOT, 'server/gateway/sims/tactics-duel.js'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(2)

/* ---------- 基座 ---------- */
const deployT0 = (st, s) => D.applyOp(st, s, { k: 'deploy', cells: D.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: D.TEMPLATES[0][i][s] })) })
const play = (seed, lv0, lv1, env0, env1) => {
  const st = D.create(seed); deployT0(st, 0); deployT0(st, 1)
  let g = 200000
  while (!st.over && g-- > 0) D.step(st, { 0: D.brain(st, 0, lv0, null, env0), 1: D.brain(st, 1, lv1, null, env1) })
  return st
}
const sweep = (a, b, seeds) => {
  let wins = 0, seat0 = 0, lines = []
  for (const sd of seeds) {
    let r = play(sd, a, b).result; lines.push(`s${sd}:${r.winner}`); if (r.winner === 'A') { wins++; seat0++ }
    r = play(sd, b, a).result; lines.push(`s${sd}:${r.winner}`); if (r.winner === 'B') wins++
  }
  return { wins, n: seeds.length * 2, seat0, lines }
}
/* blitz-center（api-check §6 剧本策略副本——读 state 非读 sim 内部，pool 先例）：
 * N3 真人臂。斩杀>最大伤害、火球打聚集、治疗最伤、lance 插点、其余推进。 */
function blitz(state, seat) {
  const K = D
  if (!state || state.over) return {}
  if (state.phase === 'deploy') {
    if (state.deployDone[seat]) return {}
    const T = K.TEMPLATES[0]
    return { op: { k: 'deploy', cells: K.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: T[i][seat] })) } }
  }
  if (state.phase !== 'act' || state.turnSeat !== seat) return {}
  const mine = state.units.filter((u) => u.seat === seat && u.ph !== 'done' && (u.ph !== 'idle' || state.ap > 0))
  if (!mine.length) return { op: { k: 'endTurn' } }
  let atk = null
  for (const u of mine) for (const t of K.atkTargets(state, u.id)) {
    const dmg = K.predictDmg(state, u.id, t)
    const foe0 = state.units.find((x) => x.id === t)
    const kill = foe0 && dmg >= foe0.hp
    if (!atk || (kill && !atk.kill) || (kill === atk.kill && (dmg > atk.dmg || (dmg === atk.dmg && t < atk.tgt)))) atk = { op: { k: 'attack', unit: u.id, tgt: t }, dmg, kill }
  }
  if (atk && atk.kill) return { op: atk.op }
  const mage = mine.find((u) => u.type === 'mage')
  if (mage) {
    let fb = null
    for (const c of K.fireballCells(state, mage.id)) {
      if (c.foes < 2) continue
      const score = 3 * c.foes - c.own
      if (!fb || score > fb.score || (score === fb.score && c.cell < fb.cell)) fb = { op: { k: 'skill', unit: mage.id, cell: c.cell }, score }
    }
    if (fb) return { op: fb.op }
  }
  const healer = mine.find((u) => u.type === 'healer')
  if (healer) {
    const ts = K.healTargets(state, healer.id)
    if (ts.length) {
      let best = null
      for (const t of ts) { const w = state.units.find((x) => x.id === t); const miss = K.UNITS[w.type].hp - w.hp; if (!best || miss > best.miss) best = { op: { k: 'skill', unit: healer.id, cell: w.cell }, miss } }
      return { op: best.op }
    }
  }
  if (atk) return { op: atk.op }
  if (mage) {
    let fb = null
    for (const c of K.fireballCells(state, mage.id)) if (c.foes === 1 && c.own === 0 && (!fb || c.cell < fb.cell)) fb = { op: { k: 'skill', unit: mage.id, cell: c.cell } }
    if (fb) return { op: fb.op }
  }
  const PRIO = { lance: 0, sword: 1, axe: 2, bow: 3, mage: 4, healer: 5 }
  const movers = mine.filter((u) => u.ph === 'idle').sort((a, b) => (PRIO[a.type] - PRIO[b.type]) || (a.id - b.id))
  for (const u of movers) {
    const rs = K.reach(state, u.id)
    const goal = (cell) => {
      let bd = 1e9
      for (const p of state.points) {
        let d = K.dist(cell, p)
        if (state.own[state.points.indexOf(p)] === seat && u.type !== 'healer') d += 6
        if (state.own[state.points.indexOf(p)] !== seat && u.type === 'lance') d -= 3
        if (d < bd) bd = d
      }
      return bd
    }
    let best = null
    for (const r of rs) { const g = goal(r.cell); if (!best || g < best.g || (g === best.g && r.cell < best.cell)) best = { g, ...r } }
    if (best && best.path.length > 1) return { op: { k: 'move', unit: u.id, path: best.path } }
  }
  return { op: { k: 'endTurn' } }
}

/* ================= N1 三档梯度断言扩容 ================= */
console.log('== N1a 胜率梯度（fix1 口径：双臂×IS/OOS 种子集，32 局/配对） ==')
const IS = [31, 37, 41, 43, 47, 53, 59, 61], OOS = [67, 71, 73, 79, 83, 89, 97, 101]
const cb = sweep('competitive', 'balanced', [...IS, ...OOS])
const cc = sweep('competitive', 'casual', [...IS, ...OOS])
const bc = sweep('balanced', 'casual', [...IS, ...OOS])
ok('G1', 'competitive>balanced ≥20/32', cb.wins >= 20, `实测 ${cb.wins}/32 seat0 ${cb.seat0}/16`)
ok('G1b', 'seat0 劣势臂克服补偿分 ≥6/16', cb.seat0 >= 6, `实测 ${cb.seat0}/16`)
ok('G2', 'competitive>casual 全胜', cc.wins === cc.n, `实测 ${cc.wins}/${cc.n}`)
ok('G3', 'balanced>casual ≥28/32', bc.wins >= 28, `实测 ${bc.wins}/${bc.n}`)

console.log('== N1b/N1c 风格+失误率分层（纯 opsLog/stats 口径，同档对同档 6 seed） ==')
const STYLE_SEEDS = [31, 37, 41, 43, 47, 53]
function styleOf(lv) {
  const atkT = [], kills = [], fire = [], empty = []
  for (const sd of STYLE_SEEDS) {
    const st = play(sd, lv, lv)
    const mineOps = st.opsLog.filter((o) => o.s === 0)
    const combat = mineOps.filter((o) => o.k === 'attack' || o.k === 'skill').length
    atkT.push(combat / st.turnCounts[0])
    kills.push(st.stats[0].kills)
    fire.push(st.stats[0].fireOwn)
    const byTurn = {}
    for (const o of mineOps) byTurn[o.tn] = (byTurn[o.tn] || 0) + 1
    let emp = 0
    for (let t = 1; t <= 2 * st.turnCounts[0]; t += 2) if (!byTurn[t]) emp++ // seat0 回合=奇数 tn（A 先手）
    empty.push(emp)
  }
  return { atkT: f1(avg(atkT)), kills: f1(avg(kills)), fire: f1(avg(fire)), empty: f1(avg(empty)) }
}
const SC = styleOf('casual'), SB = styleOf('balanced'), SP = styleOf('competitive')
console.log(`  指标表 atk/turn·kills·fireOwn·空过回合：casual ${JSON.stringify(SC)} balanced ${JSON.stringify(SB)} competitive ${JSON.stringify(SP)}`)
ok('S1', '风格分层：atk/turn 单调 casual<balanced<competitive（边距≥0.2）', SB.atkT - SC.atkT >= 0.2 && SP.atkT - SB.atkT >= 0.2, `${SC.atkT} < ${SB.atkT} < ${SP.atkT}`)
ok('S2', '风格分层：场均击杀 competitive>balanced', SP.kills > SB.kills, `${SP.kills} > ${SB.kills}`)
ok('B1', '失误分层：火球误伤 casual>0 且 balanced=competitive=0', SC.fire > 0 && SB.fire === 0 && SP.fire === 0, `${SC.fire}/${SB.fire}/${SP.fire}`)
ok('B2', '失误分层：空过回合 casual>balanced', SC.empty > SB.empty, `${SC.empty} > ${SB.empty}`)

/* ================= N2 开局树双证 ================= */
console.log('== N2 开局树双证（三档各 2 seed 开局 30s=3000 tick 指标表+判别器+双跑） ==')
const N2_SEEDS = [31, 37]
const runOpening = (seed, lv, ticks = 3000) => {
  const st = D.create(seed)
  let g = 200000
  while (st.tick < ticks && !st.over && g-- > 0) D.step(st, { 0: D.brain(st, 0, lv), 1: D.brain(st, 1, lv) })
  return st
}
const tplMatch = (st, s) => {
  for (let t = 0; t < 3; t++) if (D.TYPE_ORDER.every((tp, i) => st.deploys[s].find((x) => x.unit === tp).cell === D.TEMPLATES[t][i][s])) return t
  return -1
}
/* 判别器核心特征：开局窗（seat0 前三手，tn≤6）逐移动 op 问「competitive brain 在同态
 * 会否出同单位」——重放 opsLog 前缀重建该 op 前的态，调 brain(competitive) 与日志 op
 * 对照。comp 日志=构造性一致（book 只提议单位、搜索在该单位子集内出手，确定性复现）；
 * balanced 日志=两个独立决策流随机命中（≈1/可用单位数）。 */
function bookConsistency(fullSt, seat = 0) {
  const ops = fullSt.opsLog
  let agree = 0, total = 0
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]
    if (o.s !== seat || o.k !== 'move' || o.tn > 2 * D.BOOK_TURNS) continue
    // 首个战斗 op 后接敌，book 退出——窗内出现 attack/skill 即截断（保守口径）
    if (ops.slice(0, i).some((x) => x.s === seat && (x.k === 'attack' || x.k === 'skill'))) break
    const pre = D.replayOps(fullSt.seed, ops.slice(0, i), fullSt.maxTicks)
    if (pre.over || pre.phase !== 'act' || pre.turnSeat !== seat) continue
    pre.tick = pre.phaseStartTick + 300                                   // 重放态无墙钟 tick——拨过 BOT_DELAY 上界（250）解除拟人门
    const live = D.brain(pre, seat, 'competitive')
    if (live && live.op && live.op.k === 'move') { total++; if (live.op.unit === o.unit) agree++ }
  }
  return total ? agree / total : -1
}
const table = []
for (const lv of ['casual', 'balanced', 'competitive']) for (const sd of N2_SEEDS) {
  const st = runOpening(sd, lv)
  const r2 = runOpening(sd, lv)
  table.push({ lv, sd, tpl: tplMatch(st, 0), ops: st.opsLog.filter((o) => o.s === 0).length, turns: st.turnCounts[0],
    cons: f1(bookConsistency(st)), det: JSON.stringify(st.opsLog) === JSON.stringify(r2.opsLog) })
}
console.log('  指标表（档/seed/部署模板/ops/回合/开局窗一致率/双跑一致）：')
for (const r of table) console.log(`    ${r.lv.padEnd(11)} s${r.sd} tpl=${r.tpl} ops=${r.ops} turns=${r.turns} cons=${r.cons} det=${r.det}`)
const classify = (m) => (m.tpl === -1 ? 'casual' : m.cons >= 0.8 ? 'competitive' : m.cons >= 0 && m.cons <= 0.5 ? 'balanced' : 'unknown')
let hit = 0
for (const m of table) { const c = classify(m); if (c === m.lv) hit++; else console.log(`    判别 ${m.lv} s${m.sd} → ${c} ✗`) }
ok('N2a', '开局树判别器 6/6 全对（部署模板+开局窗一致率）', hit === 6, `${hit}/6`)
ok('N2b', '开局确定性双跑逐字节（opsLog 相等）', table.every((r) => r.det), `${table.filter((r) => r.det).length}/6`)
ok('N2c', '开局树在位双证：comp 一致率=1 且 balanced ≤0.5（构造性 vs 随机命中）',
  table.filter((r) => r.lv === 'competitive').every((r) => r.cons === 1) && table.filter((r) => r.lv === 'balanced').every((r) => r.cons <= 0.5),
  `comp=[${table.filter((r) => r.lv === 'competitive').map((r) => r.cons)}] bal=[${table.filter((r) => r.lv === 'balanced').map((r) => r.cons)}]`)

/* ================= N3 放水链 ================= */
console.log('== N3 放水链（M0 配置注入 + E 端到端 + L1 分叉 + 双跑） ==')
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/tactics-duel/game.json'), 'utf8'))
ok('M0', '配置注入链：game.json bot.mercy {minFoeLose:2, hardFoeLose:3} 在位', !!(cfg.bot && cfg.bot.mercy && cfg.bot.mercy.minFoeLose === 2 && cfg.bot.mercy.hardFoeLose === 3), JSON.stringify(cfg.bot && cfg.bot.mercy))
/* M1 适配器注入实证：env 不带 mercy 键 → 适配器出口包装补 game.json 阈值（L2 生效） */
D.botStats.mercy = 0; D.botStats.mercyDeep = 0
{
  const st = D.create(31); deployT0(st, 0); deployT0(st, 1)
  let g = 6000
  while (!st.over && g-- > 0) D.step(st, { 0: {}, 1: SIM.brain(st, 1, 'competitive', null, { kinds: ['human', 'bot'], foeLose: [0, 3] }) })
}
ok('M1', '适配器 env.mercy 注入（无 mercy 键经适配器 → L2 生效）', D.botStats.mercyDeep > 0, `botStats=${JSON.stringify(D.botStats)}`)
/* E 端到端：网关 pulse 台账语义（rooms.js finish：真人胜 lose=0 / 负 lose++）逐局推进；
 * foeLose[1]=bot 席 1 的对席真人（席 0）连败（rooms.js foeLose 按席位索引） */
const chain = []
let loseStreak = 0
for (let gi = 1; gi <= 5; gi++) {
  const seed = 100 + gi // 每局新 seed（房间=新局）
  const env = { kinds: ['human', 'bot'], foeLose: [0, loseStreak] }
  const st = D.create(seed)
  let g = 200000
  while (!st.over && g-- > 0) D.step(st, { 0: blitz(st, 0), 1: D.brain(st, 1, 'competitive', null, env) })
  const humanWon = st.result.winner === 'A'
  chain.push({ gi, foeLose: loseStreak, winner: st.result.winner, reason: st.result.reason })
  loseStreak = humanWon ? 0 : loseStreak + 1
}
console.log('  端到端链（局/入局连败/终局）：', chain.map((c) => `#${c.gi} fl=${c.foeLose}→${c.winner}(${c.reason})`).join(' '))
ok('E1', '连败段：fl<阈值 真人全败（强 bot 在位）', chain[0].winner === 'B' && chain[1].winner === 'B' && chain[2].winner === 'B', `#${chain[0].gi}#${chain[1].gi}#${chain[2].gi} 均 B 胜`)
ok('E2', '让力段：fl=3（≥hardFoeLose）L2 生效 → 真人胜', chain[3].winner === 'A', `#${chain[3].gi} fl=${chain[3].foeLose} → ${chain[3].winner}`)
ok('E3', '清零回档：真人胜后 pulse 清零 → bot 回全档 → 真人再败', chain[4].foeLose === 0 && chain[4].winner === 'B', `#${chain[4].gi} fl=${chain[4].foeLose} → ${chain[4].winner}`)
/* L1 决策级分叉：同 seed 同局，fl=0 vs fl=2 opsLog 不同（噪声注入可观测） */
const h = (fl) => { const st = play(31, 'competitive', 'balanced', undefined, { kinds: ['bot', 'human'], foeLose: [0, fl] }); return D.fnv1a32(JSON.stringify(st.opsLog)) }
ok('L1', 'L1 决策级分叉（fl=2 vs fl=0 opsLog hash 不同）', h(0) !== h(2), `${h(0)} vs ${h(2)}`)
/* 放水局确定性双跑 */
const mercyRun = (seed) => { const st = D.create(seed); deployT0(st, 0); deployT0(st, 1); const env = { kinds: ['human', 'bot'], foeLose: [3, 0] }
  let g = 200000; while (!st.over && g-- > 0) D.step(st, { 0: D.brain(st, 0, 'competitive', null, env), 1: D.brain(st, 1, 'balanced') }); return D.hashState(st) }
ok('M2', '放水局确定性双跑（同 seed 终态 hash 相等）', mercyRun(41) === mercyRun(41), String(mercyRun(41)))

console.log('== N4 回归提示位 ==')
console.log('  （api-check 六作抽查 + perf-smoke 在单据流程跑，本挂具不重复；:4399/:4400 零感知=纯 sim/适配器层挂具）')
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
