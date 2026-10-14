#!/usr/bin/env node
/* =====================================================================
 * GAMES-129 FIX一号 · Bot 梯度回归剧本（O2 修复守门）
 * 断言（3 seed × 3 配对，sim 级直驱 create/step/brain，maxTicks=3000）：
 *   A1 competitive > balanced 胜率显著（≥2/3）——QA1 0/4 倒挂的主修复面
 *   A2 balanced > casual ≥2/3——回归锚（QA1 原绿不得回退）
 *   A3 确定性回归：同 seed 两跑终态一致（行为栈改动不得引入路径随机）
 *   附：comp 对塔 atk 指令计数逐局打印（信息项——推塔转化现状如实可见）
 *   观察 competitive vs casual（QA1 残项：战损互有、存塔仍劣，未断言，转后续）
 * =================================================================== */
import { miniMobaSim } from '../server/gateway/sims/mini-moba.js'
const sim = miniMobaSim

function runMatch(seed, levelsA, levelsB, maxTicks = 3000) {
  const levels = [0, 1, 2, 3, 4, 5].map((i) => (i % 2 === 0 ? levelsA : levelsB))
  const st = sim.create(seed, { test: true, maxTicks })
  const room = { state: st, frame: 0, id: 'bot-' + seed, seats: levels.map((lv, i) => ({ seat: i, kind: 'bot', level: lv, conn: null, pending: new Map(), lastInput: { mx: 0, my: 0 } })), spectators: new Set(), __dirQ: null, __dirCam: null }
  const rngs = levels.map((_, i) => sim.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0))
  let compTowerAtk = 0
  for (let t = 0; t < maxTicks; t++) {
    const inputs = {}
    for (let i = 0; i < 6; i++) {
      const s = room.seats[i]
      inputs[i] = sim.brain(st, i, s.level, rngs[i], { kinds: room.seats.map((x) => x.kind), foeLose: [0, 0, 0, 0, 0, 0] })
      if (s.level === 'competitive' && inputs[i].cmd && inputs[i].cmd.k === 'atk' && String(inputs[i].cmd.entId).startsWith('tw-')) compTowerAtk++
    }
    room.frame++
    const r = sim.step(st, inputs, room)
    if (r.over) return { over: r.result, ticks: st.tick, compTowerAtk, towers: { ...st.stats.towers }, teamKills: { ...st.stats.kills } }
  }
  return { over: null, ticks: st.tick, compTowerAtk, towers: { ...st.stats.towers }, teamKills: { ...st.stats.kills } }
}

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`); cond ? pass++ : fail++ }

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
// A1：O2 主修复面——competitive 对 balanced 胜率显著（QA1 基线 0/4 → 现须 ≥2/3）
{
  const rs = results['competitive-vs-balanced']
  const wins = rs.filter((r) => r.over && r.over.winner === 'A').length
  const losses = rs.filter((r) => r.over && r.over.winner === 'B').length
  ok('梯度 competitive > balanced 胜率显著（O2 主证）', wins >= 2 && wins > losses, `A 胜 ${wins}/${SEEDS.length}（B 胜 ${losses}）`)
}
// A3：确定性回归（同 seed 两跑终态一致——sim 纪律 §6，行为栈改动不得引入路径随机）
{
  const r1 = runMatch(20261101, 'competitive', 'balanced')
  const r2 = runMatch(20261101, 'competitive', 'balanced')
  const same = JSON.stringify([r1.over, r1.towers, r1.teamKills]) === JSON.stringify([r2.over, r2.towers, r2.teamKills])
  ok('确定性：同 seed 两跑终态一致', same, `winner=${r1.over ? r1.over.winner : 'none'} towers=${JSON.stringify(r1.towers)}`)
}
// A2：回归锚——balanced > casual 不回退（QA1 原绿 2/2）
{
  const rs = results['balanced-vs-casual']
  const wins = rs.filter((r) => r.over && r.over.winner === 'A').length
  const losses = rs.filter((r) => r.over && r.over.winner === 'B').length
  ok('回归锚：balanced > casual 不回退', wins >= 2 && wins > losses, `A 胜 ${wins}/${SEEDS.length}（B 胜 ${losses}）`)
}
// 观察：competitive vs casual（QA1 残项，未断言——战损/存塔现状如实打印，转后续单）
{
  const rs = results['competitive-vs-casual']
  const wins = rs.filter((r) => r.over && r.over.winner === 'A').length
  console.log(`○ 观察（未断言）：competitive-vs-casual A 胜 ${wins}/${SEEDS.length}——残项：对最高档守线型打法存塔仍劣，转后续（详见 GAMES-129 REPORT）`)
}
console.log(`\nBot2-check：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
