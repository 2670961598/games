#!/usr/bin/env node
/* =====================================================================
 * party-brawl-qa2-eco（GAMES-177 · QA2 生态面 conformance 仲裁探针）
 * 裁量对象：GAMES-175 rank 方向残差——「bal 机会主义存活者最优 vs comp 击杀冠军
 * 死于中段」与设计 §4.2「comp 决赛豆 rank 2-5」预期相反。三候选：
 *   (a) 混编基座改 2/8/10 生态位占比（测试基座 6comp 互猎=归因制造器假说）
 *   (b) comp 决赛圈行为补强（行为性缺陷假说）
 *   (c) 设计书重锚（生态解耦=预期行为假说）
 * 证据面（全离线直驱，零网关依赖——bot2-check driveRoom 同式）：
 *   E1 基线复现：base662（6/6/6+2bal，N1 现行基座）4 seed——残差在场
 *   E2 生态占比敏感性：eco2810（2comp/8bal/10cas）4 seed——comp rank 是否
 *      抵达 2-5 带（comp 数减少 → 互猎 attrition 消除后的上限）
 *   E3 死亡归因账本：elim ledger（by=120 tick 内最近伤害源）× victim/killer
 *      档位矩阵——comp 死于谁（互猎 vs 被 bal/cas 反杀 vs 毒）
 *   E4 N3 严格序评估：comp≤bal≤cas 毒伤拍逐 seed 严格序成立性（在线口径裁量）
 * 用法：node scripts/party-brawl-qa2-eco.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PB = require(join(ROOT, 'games/multiplayer/party-brawl/sim.cjs'))

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const SEEDS = (process.env.ECO_SEEDS || '20261018,20261019,20261020,20261021').split(',').map(Number)
const TIERS = ['competitive', 'balanced', 'casual']
const SHORT = { competitive: 'comp', balanced: 'bal', casual: 'cas' }

/* 基座定义：base662=N1 现行（6/6/6+2bal）；eco2810=候选(a) 2/8/10；
 * prod3611=生产混编巨房实配（bothost.js:106「混编 3/6/11 full20 同型，§6」）——
 * 设计 §4.2 预期的真实适用域（QA 基座与生产实配的占比差=归因主嫌） */
const TIER_OF = {
  base662: (i) => (i === 0 || i >= 19 ? 'balanced' : i <= 6 ? 'competitive' : i <= 12 ? 'balanced' : 'casual'),
  eco2810: (i) => (i <= 1 ? 'competitive' : i <= 9 ? 'balanced' : 'casual'),
  prod3611: (i) => (i <= 2 ? 'competitive' : i <= 8 ? 'balanced' : 'casual'),
}

function driveRoom(seed, ticks, tierOf) {
  const st = PB.create(seed, { maxTicks: ticks })
  const room = { seats: Array.from({ length: 20 }, (_, i) => ({ seat: i, kind: 'bot' })) }
  const rngs = room.seats.map((s) => PB.mulberry32(((st.seed ^ Math.imul(s.seat, 0x9e3779b9)) >>> 0)))
  const rEnv = { kinds: room.seats.map((s) => s.kind), foeLose: room.seats.map(() => 0) }
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (const s of room.seats) inputs[s.seat] = PB.brain(st, s.seat, tierOf(s.seat), rngs[s.seat], rEnv)
    const r = PB.step(st, inputs, room)
    if (r.over) break
  }
  return st
}

function harvest(st, tierOf) {
  const by = { competitive: [], balanced: [], casual: [] }
  for (const p of st.players) by[tierOf(p.seat)].push(p)
  const row = {}
  for (const tr of TIERS) {
    row[tr] = {
      rankMed: med(by[tr].map((p) => p.rank)),
      rankMin: Math.min(...by[tr].map((p) => p.rank)),
      rankMax: Math.max(...by[tr].map((p) => p.rank)),
      kills: by[tr].reduce((a, p) => a + p.kills, 0),
      dots: by[tr].reduce((a, p) => a + (st.ledgers.stormDots[p.seat] || 0), 0),
    }
  }
  /* E3 死亡归因：victim 档 × killer 档矩阵（by=-1=120tick 无最近伤害源：毒/环境） */
  const kills2 = { competitive: { competitive: 0, balanced: 0, casual: 0, env: 0 }, balanced: { competitive: 0, balanced: 0, casual: 0, env: 0 }, casual: { competitive: 0, balanced: 0, casual: 0, env: 0 } }
  const compDeaths = []
  for (const e of st.ledgers.elim) {
    const vt = tierOf(e.seat), kt = e.by >= 0 ? tierOf(e.by) : 'env'
    kills2[vt][kt]++
    if (vt === 'competitive') compDeaths.push({ seat: e.seat, by: e.by, kt, rank: e.rank })
  }
  return { row, kills2, compDeaths, tick: st.tick }
}

function runConfig(name, seeds) {
  const tierOf = TIER_OF[name]
  const agg = []
  for (const seed of seeds) {
    const st = driveRoom(seed, 9600, tierOf)
    agg.push({ seed, ...harvest(st, tierOf) })
  }
  console.log(`\n[${name}]（${seeds.join(',')}）`)
  for (const a of agg) {
    const r = a.row
    console.log(`  seed ${a.seed} tick=${a.tick} comp{k=${r.competitive.kills} rankMed=${r.competitive.rankMed}(${r.competitive.rankMin}..${r.competitive.rankMax}) d=${r.competitive.dots}} bal{k=${r.balanced.kills} rankMed=${r.balanced.rankMed} d=${r.balanced.dots}} cas{k=${r.casual.kills} rankMed=${r.casual.rankMed} d=${r.casual.dots}}`)
    console.log(`    归因: ${TIERS.map((vt) => `${SHORT[vt]}←[${TIERS.map((kt) => `${SHORT[kt]}:${a.kills2[vt][kt]}`).join(' ')} env:${a.kills2[vt].env}]`).join('  ')}`)
    if (a.compDeaths.length) console.log(`    comp 死序: ${a.compDeaths.map((d) => `s${d.seat}←${d.kt === 'env' ? 'env' : SHORT[d.kt]}@rank${d.rank}`).join(' ')}`)
  }
  /* E2 汇总：comp rank 中位带 + 决赛豆带命中率 */
  const compRanks = agg.flatMap((a) => a.row.competitive.rankMed === undefined ? [] : [a.row.competitive.rankMed])
  const inBean = agg.filter((a) => a.row.competitive.rankMed >= 2 && a.row.competitive.rankMed <= 5).length
  console.log(`  ▸ comp rankMed=[${compRanks.join(',')}] 决赛豆带(2-5)命中 ${inBean}/${agg.length}；kills comp=[${agg.map((a) => a.row.competitive.kills).join(',')}] bal=[${agg.map((a) => a.row.balanced.kills).join(',')}] cas=[${agg.map((a) => a.row.casual.kills).join(',')}]`)
  /* E4 N3 严格序：comp≤bal≤cas 逐 seed */
  const strictN3 = agg.filter((a) => a.row.competitive.dots <= a.row.balanced.dots && a.row.balanced.dots <= a.row.casual.dots).length
  console.log(`  ▸ N3 严格序 comp≤bal≤cas：${strictN3}/${agg.length}（dots comp=[${agg.map((a) => a.row.competitive.dots).join(',')}] bal=[${agg.map((a) => a.row.balanced.dots).join(',')}] cas=[${agg.map((a) => a.row.casual.dots).join(',')}]）`)
  return agg
}

console.log('=== GAMES-177 QA2 生态仲裁探针（E1-E4）===')
const base = runConfig('base662', SEEDS)
const eco = runConfig('eco2810', SEEDS)
const prod = runConfig('prod3611', SEEDS)

/* 仲裁综合面：各基座下 comp 是否 kills 冠军兼 rank 抵带（设计 §4.2 双轴同向） */
const dual = (agg) => agg.filter((a) => a.row.competitive.kills > Math.max(a.row.balanced.kills, a.row.casual.kills) && a.row.competitive.rankMed <= 5).length
console.log(`\n[仲裁面] comp「kills 冠军 + rankMed≤5」双轴同向：base662 ${dual(base)}/${base.length} ｜ eco2810 ${dual(eco)}/${eco.length} ｜ prod3611 ${dual(prod)}/${prod.length}`)
