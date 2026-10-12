/* GAMES-119 QA1 Bot 三档梯度抽查（评估函数分层）：配对对抗 + 同 seed 异档 op 流差异（分层活性证） */
import { createRequire } from 'node:module'
const D = createRequire(import.meta.url)('/Volumes/BigDisk/Studio/projects/GAMES/repo/games/multiplayer/tactics-duel/sim.cjs')
const deployT0 = (st, s) => D.applyOp(st, s, { k: 'deploy', cells: D.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: D.TEMPLATES[0][i][s] })) })
const play = (seed, lv0, lv1) => {
  const st = D.create(seed)
  deployT0(st, 0); deployT0(st, 1)
  let guard = 60000
  while (!st.over && guard-- > 0) D.step(st, { 0: D.brain(st, 0, lv0), 1: D.brain(st, 1, lv1) })
  return { winner: st.over ? st.result.winner : 'none', reason: st.result && st.result.reason, ticks: st.tick, ops: st.opsLog.length }
}
const seeds = [31, 37, 41]
const tally = {}
for (const [a, b] of [['balanced', 'casual'], ['competitive', 'casual'], ['competitive', 'balanced']]) {
  const key = `${a} vs ${b}`
  tally[key] = { A: 0, B: 0, n: 0, reasons: [] }
  for (const sd of seeds) {
    const r = play(sd, a, b)
    tally[key].n++
    if (r.winner === 'A') tally[key].A++
    if (r.winner === 'B') tally[key].B++
    tally[key].reasons.push(`${r.winner}/${r.reason}`)
  }
  console.log(`${key}: A(${a}) 胜 ${tally[key].A}/${tally[key].n} B(${b}) 胜 ${tally[key].B}/${tally[key].n} [${tally[key].reasons.join(' ')}]`)
}
/* 分层活性：同 seed 同部署，三档 op 流互异（死档位会与某档逐字节重合） */
const flow = (lv) => { const st = D.create(53); deployT0(st, 0); deployT0(st, 1); let g = 4000, h = [D.hashState(st)]; while (!st.over && g-- > 0) { D.step(st, { 0: D.brain(st, 0, lv), 1: D.brain(st, 1, 'balanced') }); h.push(D.hashState(st)) } return h }
const fc = flow('casual'), fb = flow('balanced'), fp = flow('competitive')
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y)
console.log(`分层活性（seat0 档位互异 → op 流互异）：casual≠balanced=${!eq(fc, fb)} balanced≠competitive=${!eq(fb, fp)} casual≠competitive=${!eq(fc, fp)}`)
const grad = tally['balanced vs casual'].A >= 2 && tally['competitive vs casual'].A >= 2 && tally['competitive vs balanced'].A >= tally['competitive vs balanced'].B
console.log(`梯度判据（balanced>casual 且 competitive>casual 且 competitive≥balanced）：${grad ? 'PASS' : 'FAIL'}`)
process.exit(grad && !eq(fc, fb) && !eq(fb, fp) && !eq(fc, fp) ? 0 : 1)
