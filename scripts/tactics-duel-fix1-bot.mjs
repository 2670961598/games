/* GAMES-120 FIX一号 Bot 三档梯度回归（O1 修复实证）——QA1 抽查口径的扩容版：
 * 配对对抗（sim 级、T0 同部署、双席位交换臂）× 两种子集（In-Sample 8 + Out-of-Sample 8）。
 *
 * 判据（DoD「competitive 胜率显著高于 balanced」的可执行化）：
 *   G1 competitive>balanced：comp-vs-bal 双臂 32 局 ≥20（实测 24=75%；单侧二项 p(≥20|0.5)≈0.057，
 *      p(≥24)=0.0048——报实测值，阈取 20 留鲁棒裕量）；其中 seat0 劣势臂 ≥6/16
 *      （B 起始补偿分 +1 §1.2 下双方互坐点 9-9 恒 B 胜——comp 须靠夺点翻转，实测 8/16）；
 *   G2 competitive>casual：32/32 全胜（QA1 实测 7/12 倒挂面的复验）；
 *   G3 balanced>casual：≥28/32（基线健康，代码路径零扰动自证）。
 * 退出码 0=全过；任何一档红即 1（PM 复验闸）。 */
import { createRequire } from 'node:module'
const D = createRequire(import.meta.url)('/Volumes/BigDisk/Studio/projects/GAMES/repo/games/multiplayer/tactics-duel/sim.cjs')

const deployT0 = (st, s) => D.applyOp(st, s, { k: 'deploy', cells: D.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: D.TEMPLATES[0][i][s] })) })
const play = (seed, lv0, lv1) => {
  const st = D.create(seed)
  deployT0(st, 0); deployT0(st, 1)
  let guard = 200000
  while (!st.over && guard-- > 0) D.step(st, { 0: D.brain(st, 0, lv0), 1: D.brain(st, 1, lv1) })
  return st.result ? st.result : { winner: 'none', reason: 'guard' }
}
const IS = [31, 37, 41, 43, 47, 53, 59, 61]         // QA1 种子邻域（In-Sample）
const OOS = [67, 71, 73, 79, 83, 89, 97, 101]       // 样本外（过拟合哨兵）

const sweep = (a, b, seeds) => {
  let wins = 0, seat0 = 0, lines = []
  for (const sd of seeds) {
    let r = play(sd, a, b); lines.push(`s${sd}:${r.winner}/${r.reason}`); if (r.winner === 'A') { wins++; seat0++ }
    r = play(sd, b, a); lines.push(`s${sd}:${r.winner}/${r.reason}`); if (r.winner === 'B') wins++
  }
  return { wins, n: seeds.length * 2, seat0, lines }
}
const show = (tag, r) => console.log(`${tag}: ${r.wins}/${r.n}（seat0 劣势臂 ${r.seat0}/${r.n / 2}） [${r.lines.join(' ')}]`)

const cb = [sweep('competitive', 'balanced', IS), sweep('competitive', 'balanced', OOS)]
const cc = [sweep('competitive', 'casual', IS), sweep('competitive', 'casual', OOS)]
const bc = [sweep('balanced', 'casual', IS), sweep('balanced', 'casual', OOS)]
const tot = (rs) => rs.reduce((a, x) => ({ wins: a.wins + x.wins, n: a.n + x.n, seat0: a.seat0 + x.seat0, lines: a.lines }), { wins: 0, n: 0, seat0: 0, lines: [] })
console.log('== competitive vs balanced（双臂×两种子集） ==')
show('IS ', cb[0]); show('OOS', cb[1])
console.log('== competitive vs casual =='); show('IS ', cc[0]); show('OOS', cc[1])
console.log('== balanced vs casual（基线） =='); show('IS ', bc[0]); show('OOS', bc[1])

const T = { cb: tot(cb), cc: tot(cc), bc: tot(bc) }
const g1 = T.cb.wins >= 20, g1s = T.cb.seat0 >= 6
const g2 = T.cc.wins === T.cc.n, g3 = T.bc.wins >= 28
console.log(`G1 competitive>balanced（≥20/${T.cb.n}）: ${g1 ? 'PASS' : 'FAIL'} 实测 ${T.cb.wins}/${T.cb.n}`)
console.log(`G1b seat0 劣势臂克服补偿分（≥6/16）: ${g1s ? 'PASS' : 'FAIL'} 实测 ${T.cb.seat0}/16`)
console.log(`G2 competitive>casual（全胜）: ${g2 ? 'PASS' : 'FAIL'} 实测 ${T.cc.wins}/${T.cc.n}`)
console.log(`G3 balanced>casual（≥28/32）: ${g3 ? 'PASS' : 'FAIL'} 实测 ${T.bc.wins}/${T.bc.n}`)
process.exit(g1 && g1s && g2 && g3 ? 0 : 1)
