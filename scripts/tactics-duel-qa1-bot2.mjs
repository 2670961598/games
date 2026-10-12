import { createRequire } from 'node:module'
const D = createRequire(import.meta.url)('/Volumes/BigDisk/Studio/projects/GAMES/repo/games/multiplayer/tactics-duel/sim.cjs')
const deployT0 = (st, s) => D.applyOp(st, s, { k: 'deploy', cells: D.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: D.TEMPLATES[0][i][s] })) })
const play = (seed, lv0, lv1) => {
  const st = D.create(seed)
  deployT0(st, 0); deployT0(st, 1)
  let guard = 60000
  while (!st.over && guard-- > 0) D.step(st, { 0: D.brain(st, 0, lv0), 1: D.brain(st, 1, lv1) })
  return st.over ? st.result.winner : 'none'
}
for (const [lv0, lv1] of [['balanced', 'competitive'], ['casual', 'competitive']]) {
  const seeds = [31, 37, 41, 43, 47, 53]
  let w0 = 0, w1 = 0, det = []
  for (const sd of seeds) { const w = play(sd, lv0, lv1); if (w === 'A') w0++; if (w === 'B') w1++; det.push(w) }
  console.log(`seat0=${lv0} vs seat1=${lv1}: ${lv0} 胜 ${w0}/6, ${lv1} 胜 ${w1}/6 [${det.join(' ')}]`)
}
function competitive_check(x) { return x }
