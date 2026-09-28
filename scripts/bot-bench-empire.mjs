#!/usr/bin/env node
/* =====================================================================
 * 帝国萌芽 BOT 人格对照台（GAMES-71 验收数据生成器）——离线直跑 sim.cjs，
 * 不起网关（纯 bot 局 + 陪玩剧本局），产出：
 *   1) 每档 × N 局行为差异对照（首征 tick / 建序 / 兵种比例 / 爆发期决策）
 *   2) 开局树双证（每档 ≥2 套建序指纹，rng 定桩派发）
 *   3) 确定性双跑（同 seed 两局 serialize 逐字节一致）
 *   4) 陪玩补短板双证（真人重军→bot 重农 ｜ 真人重农→bot 重军）+ 挂机接管
 *   5) A2/A3 剧本 replica（api-check 胜方预期离线预检）
 * botRng 定桩与 rooms.js 同式：mulberry32((seed ^ seat·0x9e3779b9) >>> 0)。
 * 用法：node scripts/bot-bench-empire.mjs [--games 6]
 * ===================================================================== */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const EMP = require('../games/multiplayer/empire-sprout/sim.cjs')

const argv = process.argv.slice(2)
const N = Number(argv[argv.indexOf('--games') + 1]) || 6
const BASE_SEED = 20260928
const ERUPT = EMP.consts.ERUPT_AT, MAXT = 7200

/* ---------- 一局：seats 由 levels+kinds+policy 描述，返回行为账本 ---------- */
function runGame({ seed, levels, kinds = ['bot', 'bot', 'bot', 'bot'], human = null }) {
  const st = EMP.create(seed, {})
  const rngs = levels.map((_, i) => EMP.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0))
  const env = { kinds }
  const led = levels.map(() => ({
    built: [],                                              // 建序（kind@tick）
    trained: {},                                            // 兵种比例（train-done 计数）
    firstMarch: -1, firstMarchUnits: null, marchN: 0,
    eruptMarch: -1,                                         // 爆发窗 [1800,2100) 出征 tick
    rejects: {},
  }))
  for (let t = 0; t < MAXT; t++) {
    const inputs = {}
    for (let i = 0; i < 4; i++) {
      inputs[i] = kinds[i] === 'human'
        ? (human ? human(st, i) : {})
        : EMP.brain(st, i, levels[i], rngs[i], env)
    }
    const r = EMP.step(st, inputs)
    for (const e of r.events || []) {
      const l = led[e.seat]
      if (!l) continue
      if (e.k === 'built') l.built.push(e.kind + (e.lv > 1 ? '↑' + e.lv : '') + '@' + st.tick)
      else if (e.k === 'train-done') l.trained[e.unit] = (l.trained[e.unit] || 0) + 1
      else if (e.k === 'march') {
        l.marchN++
        if (l.firstMarch < 0) { l.firstMarch = st.tick; l.firstMarchUnits = e.units }
        if (st.tick >= ERUPT && st.tick < 2100 && l.eruptMarch < 0) l.eruptMarch = st.tick
      } else if (e.k === 'reject') l.rejects[e.why] = (l.rejects[e.why] || 0) + 1
    }
    if (r.over) { led.result = r.result; led.endTick = st.tick; break }
  }
  if (!led.result) { led.result = { winner: 'timeout?' }; led.endTick = MAXT }
  return { state: st, led }
}

/* ---------- 陪玩剧本真人策略（对照台内置，非网关路径） ---------- */
/* 重军真人：军备建序 + 常练 inf + 有池就征（api-check empire-rush 精简版） */
function humanArms(st, seat) {
  const s = st.build.seats[seat], t = st.tick
  const res = { g: (s.res.g / 1000) | 0, w: (s.res.w / 1000) | 0, i: (s.res.i / 1000) | 0 }
  const plotOf = (k) => s.plots.findIndex((p) => p && p.kind === k)
  const free = () => s.plots.findIndex((p) => !p)
  const COST = { lumber: { w: 30 }, farm: { w: 40 }, camp: { w: 60, i: 40 }, works: { w: 80, i: 60 } }
  for (const k of ['lumber', 'farm', 'camp', 'works']) {
    if (plotOf(k) >= 0) continue
    if (Object.entries(COST[k]).every(([r, n]) => res[r] >= n) && free() >= 0) return { o: { k: 'build', plot: free(), kind: k } }
    break
  }
  const qn = s.queues.reduce((a, q) => a + q.n, 0)
  const pool = Object.values(s.pools).reduce((a, x) => a + x.length, 0)
  if (t >= ERUPT && s.marchCd <= 0 && pool >= 4) {
    const units = {}
    for (const c in s.pools) if (s.pools[c].length) units[c] = s.pools[c].length
    return { o: { k: 'attack', lane: 1, units } }
  }
  if (plotOf('camp') >= 0 && qn + pool < 12 && res.g >= 100) return { o: { k: 'train', kind: 'camp', unit: 'inf', n: Math.min(5, 12 - pool - qn) } }
  return {}
}
/* 重农真人：经济三件套 + 升经济，永不练兵不出征 */
function humanFarm(st, seat) {
  const s = st.build.seats[seat]
  const res = { w: (s.res.w / 1000) | 0, i: (s.res.i / 1000) | 0 }
  const plotOf = (k) => s.plots.findIndex((p) => p && p.kind === k)
  const free = () => s.plots.findIndex((p) => !p)
  const COST = { farm: { w: 40 }, lumber: { w: 30 }, mine: { w: 50, i: 10 } }
  for (const k of ['farm', 'lumber', 'mine']) {
    if (plotOf(k) >= 0) continue
    if (Object.entries(COST[k]).every(([r, n]) => res[r] >= n) && free() >= 0) return { o: { k: 'build', plot: free(), kind: k } }
    break
  }
  const b = s.plots.find((p) => p && ['farm', 'lumber', 'mine'].includes(p.kind) && p.lv < 3)
  if (b) {
    const C = { farm: [{ w: 80, i: 20 }, { w: 140, i: 50 }], lumber: [{ w: 60, i: 15 }, { w: 110, i: 40 }], mine: [{ w: 90, i: 30 }, { w: 150, i: 70 }] }[b.kind][b.lv - 1]
    if (res.w >= C.w && res.i >= C.i) return { o: { k: 'build', plot: s.plots.indexOf(b), kind: b.kind } }
  }
  return {}
}

const fmtUnits = (u) => u ? Object.entries(u).map(([c, n]) => `${c}:${n}`).join(',') : '-'
const buildPrefix = (l, n = 4) => l.built.slice(0, n).map((x) => x.split('@')[0]).join('→')

let FAIL = 0
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!pass) FAIL++
}

/* ---------- 1) 每档 × N 局对照 + 2) 开局树双证 ---------- */
console.log(`\n══ 一、三档人格对照（每档 ${N} 局纯 bot，观测席=0/2，seed ${BASE_SEED}+k）══`)
const openersSeen = {}
for (const lvl of EMP.LEVELS) {
  openersSeen[lvl] = new Set()
  console.log(`\n[${lvl}]`)
  for (let g = 0; g < N; g++) {
    const { led } = runGame({ seed: BASE_SEED + g, levels: [lvl, lvl, lvl, lvl] })
    const l = led[0]
    openersSeen[lvl].add(buildPrefix(l, 3))
    console.log(`  局${g + 1} 胜方=${led.result.winner}@${led.endTick} 首征=t${l.firstMarch}{${fmtUnits(l.firstMarchUnits)}} 爆发窗出征=${l.eruptMarch >= 0 ? 't' + l.eruptMarch : '未征(守)'} 建序=${buildPrefix(l)} 兵比=${fmtUnits(l.trained)} reject=${JSON.stringify(l.rejects)}`)
  }
  ok(`${lvl} 开局树 ≥2 套（实测 ${openersSeen[lvl].size}）`, openersSeen[lvl].size >= 2, [...openersSeen[lvl]].join(' ｜ '))
}

/* ---------- 3) 确定性双跑 ---------- */
console.log('\n══ 二、确定性双跑（同 seed 两局 serialize 逐字节一致）══')
for (const lvl of EMP.LEVELS) {
  const a = runGame({ seed: 777, levels: [lvl, lvl, lvl, lvl] })
  const b = runGame({ seed: 777, levels: [lvl, lvl, lvl, lvl] })
  const sa = EMP.serialize(a.state), sb = EMP.serialize(b.state)
  ok(`${lvl} 同 seed 双跑一致（${sa.length}B）`, sa === sb)
}
{ // 陪玩局确定性（env 路径）
  const opt = { seed: 888, levels: ['casual', 'casual', 'casual', 'casual'], kinds: ['human', 'bot', 'bot', 'bot'], human: humanArms }
  const a = runGame(opt), b = runGame(opt)
  ok('陪玩局（真人重军+casual bot）同 seed 双跑一致', EMP.serialize(a.state) === EMP.serialize(b.state))
}

/* ---------- 4) 陪玩补短板双证 + 挂机接管 ---------- */
console.log('\n══ 三、陪玩补短板（真人=席0，观测 bot=席2=队友；对照=席1/3（无真人队友））══')
{
  const { led } = runGame({ seed: 999, levels: ['balanced', 'balanced', 'balanced', 'balanced'], kinds: ['human', 'bot', 'bot', 'bot'], human: humanArms })
  const mate = led[2], solo = led[1]
  const noWorks = !buildPrefix(mate, 4).includes('works')
  const infOnly = Object.keys(mate.trained).every((c) => c === 'inf')
  const holdOk = mate.firstMarch < 0 || mate.firstMarch > 1900   // 守成=不抢 1800 首波（敌袭破墙的危机征不算抢波）
  ok('真人重军 → bot 补农：经济建序（无 works）', noWorks, `队友bot建序=${buildPrefix(mate)} vs 独走bot=${buildPrefix(solo)}`)
  ok('真人重军 → bot 补农：纯 inf 轻装池', infOnly, `兵比=${fmtUnits(mate.trained)}`)
  ok('真人重军 → bot 补农：守成不抢 1800 首波', holdOk, `队友bot首征=t${mate.firstMarch} vs 独走bot首征=t${solo.firstMarch}`)
}
{
  const { led } = runGame({ seed: 999, levels: ['casual', 'casual', 'casual', 'casual'], kinds: ['human', 'bot', 'bot', 'bot'], human: humanFarm })
  const mate = led[2], solo = led[1]
  const armsBuild = /camp|works/.test(buildPrefix(mate, 4))
  const mixed = Object.keys(mate.trained).some((c) => c !== 'inf')
  ok('真人重农 → casual bot 补军：营类进建序', armsBuild, `队友bot建序=${buildPrefix(mate)} vs 独走casual=${buildPrefix(solo)}`)
  ok('真人重农 → casual bot 补军：混编非纯 inf', mixed, `兵比=${fmtUnits(mate.trained)}`)
  ok('真人重农 → casual bot 补军：出征转主动（爆发窗即征）', mate.firstMarch >= 0 && mate.firstMarch <= 1900, `队友bot首征=t${mate.firstMarch} vs 独走casual首征=t${solo.firstMarch}`)
}
{
  const { led } = runGame({ seed: 999, levels: ['balanced', 'balanced', 'balanced', 'balanced'], kinds: ['human', 'bot', 'bot', 'bot'], human: () => ({}) })
  const mate = led[2]
  ok('真人挂机 → bot 接管（恢复本档人格：军备建序+主动出征）', /camp/.test(buildPrefix(mate, 4)) && mate.firstMarch >= 0 && mate.firstMarch < 2200, `建序=${buildPrefix(mate)} 首征=t${mate.firstMarch} 兵比=${fmtUnits(mate.trained)}`)
}

/* ---------- 5) A2/A3 剧本 replica（api-check 胜方预期离线预检）---------- */
console.log('\n══ 四、A2/A3 剧本 replica（离线预检 api-check 胜方预期）══')
{
  const { led } = runGame({ seed: 20260928, levels: [null, 'casual', 'casual', 'casual'], kinds: ['human', 'bot', 'bot', 'bot'], human: humanArms })
  ok(`A2 能赢（expectWinner A）：实得 ${led.result.winner}`, led.result.winner === 'A', `终局@${led.endTick} ${JSON.stringify(led.result.scores)}`)
}
{
  const { led } = runGame({ seed: 20260928, levels: [null, 'competitive', 'competitive', 'competitive'], kinds: ['human', 'bot', 'bot', 'bot'], human: () => ({}) })
  ok(`A3 能输（expectWinner B）：实得 ${led.result.winner}`, led.result.winner === 'B', `终局@${led.endTick} ${JSON.stringify(led.result.scores)}`)
}

console.log(`\n══ 汇总：${FAIL === 0 ? '全绿 ✔' : FAIL + ' 项红 ✘'} ══`)
process.exit(FAIL === 0 ? 0 : 1)
