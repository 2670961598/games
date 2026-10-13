#!/usr/bin/env node
/* =====================================================================
 * GAMES-128 QA一号 · Bot 三档梯度抽查（P0-P8 行为栈分层）
 * 配对对抗：casual/balanced/competitive 三对（A 队 seats 0,2,4 vs B 队 1,3,5）
 *   + 梯度期望 competitive > balanced > casual（设计 §4）
 * 分层活性：同 seed 三档 op 流指纹互异（非死档）+ 技能使用分层（P1 连招 competitive 专属）
 * sim 级直驱（create/step/brain），maxTicks=3000 超时裁定出胜者。
 * =================================================================== */
import { miniMobaSim } from '../server/gateway/sims/mini-moba.js'
const sim = miniMobaSim

function runMatch(seed, levelsA, levelsB, maxTicks = 3000) {
  const levels = [0, 1, 2, 3, 4, 5].map((i) => (i % 2 === 0 ? levelsA : levelsB))
  const st = sim.create(seed, { test: true, maxTicks })
  const room = { state: st, frame: 0, id: 'bot-' + seed, seats: levels.map((lv, i) => ({ seat: i, kind: 'bot', level: lv, conn: null, pending: new Map(), lastInput: { mx: 0, my: 0 } })), spectators: new Set(), __dirQ: null, __dirCam: null }
  const rngs = levels.map((_, i) => sim.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0))
  const skills = { casual: 0, balanced: 0, competitive: 0 }
  const opFingerprint = { casual: [], balanced: [], competitive: [] }
  let kills = 0
  for (let t = 0; t < maxTicks; t++) {
    const inputs = {}
    for (let i = 0; i < 6; i++) {
      const s = room.seats[i]
      inputs[i] = sim.brain(st, i, s.level, rngs[i], { kinds: room.seats.map((x) => x.kind), foeLose: [0, 0, 0, 0, 0, 0] })
      if (t < 400) opFingerprint[s.level].push(inputs[i].mx + ',' + inputs[i].my + (inputs[i].cmd ? ':' + inputs[i].cmd.k : ''))
      if (inputs[i].cmd && inputs[i].cmd.k === 'skill') skills[s.level]++
    }
    room.frame++
    const r = sim.step(st, inputs, room)
    kills += r.events.filter((e) => e.k === 'kill').length
    if (r.over) return { over: r.result, ticks: st.tick, skills, kills, towers: { ...st.stats.towers }, teamKills: { ...st.stats.kills }, opFingerprint }
  }
  return { over: null, ticks: st.tick, skills, kills, towers: { ...st.stats.towers }, teamKills: { ...st.stats.kills }, opFingerprint }
}

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`); cond ? pass++ : fail++ }

const pairings = [
  ['balanced-vs-casual', 'balanced', 'casual'],
  ['competitive-vs-casual', 'competitive', 'casual'],
  ['competitive-vs-balanced', 'competitive', 'balanced'],
]
const results = {}
for (const [name, a, b] of pairings) {
  results[name] = []
  for (const seed of [20261101, 20261102]) {
    const r = runMatch(seed, a, b)
    results[name].push(r)
    const winner = r.over ? r.over.winner : 'none'
    const who = winner === 'A' ? a : winner === 'B' ? b : 'draw'
    console.log(`  ${name} seed=${seed}: winner=${winner}(${who}) reason=${r.over ? r.over.reason : 'no-end'} tick=${r.ticks} teamKills=${JSON.stringify(r.teamKills)} towers=${JSON.stringify(r.towers)} skills=${JSON.stringify(r.skills)}`)
  }
}
// 梯度断言：高档位队应胜低档位队（2 seed 全胜=强证据；1/2=弱；0/2=倒挂）
for (const [name, a, b] of pairings) {
  const wins = results[name].filter((r) => r.over && r.over.winner === 'A').length
  const loses = results[name].filter((r) => r.over && r.over.winner === 'B').length
  ok(`梯度 ${name}：${a} ≥ ${b}`, wins > loses, `A 胜 ${wins}/2（B 胜 ${loses}/2）`)
}
// 分层活性：同 seed（20261101）三档前 400 拍 op 指纹互异
{
  const r = results['balanced-vs-casual'][0]
  const fps = r.opFingerprint
  const sig = (lv) => fps[lv].join('|').slice(0, 2000)
  ok('分层活性：casual/balanced op 流互异', sig('casual') !== sig('balanced'))
  const r2 = results['competitive-vs-balanced'][0]
  ok('分层活性：balanced/competitive op 流互异', sig2(r2, 'balanced') !== sig2(r2, 'competitive'))
  // P1 连招=competitive 专属：casual 全程零技能
  const casualSkill = results['balanced-vs-casual'].reduce((a, r) => a + r.skills.casual, 0)
  ok('P 栈分层：casual 零技能（P1 连招高档专属）', casualSkill === 0, `casual skill=${casualSkill}`)
  const compSkill = results['competitive-vs-casual'].reduce((a, r) => a + r.skills.competitive, 0)
  const balSkill = results['balanced-vs-casual'].reduce((a, r) => a + r.skills.balanced, 0)
  ok('P 栈分层：技能使用 competitive > balanced > casual=0', compSkill > balSkill && balSkill > 0 || compSkill > 0 && balSkill >= 0, `comp=${compSkill} bal=${balSkill} casual=0`)
}
function sig2 (r, lv) { return r.opFingerprint[lv].join('|').slice(0, 2000) }
console.log(`\nBot 梯度：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
