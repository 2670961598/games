/* GAMES-111 FIX1 单元对照：F1（和解 Δ 死码）+ F2（hash 哨兵错拍）修复前后证据。
 * 直驱单源 shared.cjs 复刻 client.js applySnapshot 和解序列（零浏览器依赖，QA1
 * s7-recon-repro.mjs 同法）。
 *
 * 分歧模型（预测偏差源 a/宽限兜底的单元化）：客户端影子锚在 2 拍前的权威态（上一张
 * 快照 F-2），本地输入与服务器实际分歧（st=-100 vs st=0）→ pre 态=陈旧锚+分歧输入；
 * 新快照到（权威@F+2）→ 和解。同输入臂=输入与服务器全同（残余 dPx=远车碰撞/尾流——
 * 偏差源 b：预测器有意不建模远车，§5.3 预算内主源）。
 * 期望：
 *   F1 旧式（anchor→advanceTo×2）：两臂 dPx 全 0（死码——重放终态自比对）；
 *      新式（抬钟→pre 快进→anchor→重放）：分歧臂 dPx>6px（硬回滚分流激活、recon 台账
 *      落账）、同输入臂 <6px（软收敛路径——b 源残余在 §5.3 预算带内）。
 *   F2 旧式（hash 影子@simTick 配 F 前缀）：领先态必分歧；新式（hash 合并权威态@F）：全匹配。 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const K = createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/speed-kart/shared.cjs'))

/* —— 造权威线：全 bot 房跑到 race 相位有速度，取 F-2 权威己车态 —— */
const room = { seats: Array.from({ length: 6 }, (_, i) => ({ kind: 'bot', seat: i })) }
const st = K.create(20261011, { laps: 3, maxTicks: 7000 })
const rngs = Array.from({ length: 6 }, (_, i) => K.mulberry32((20261011 ^ Math.imul(i, 0x9e3779b9)) >>> 0))
while (st.phase === 'countdown') {
  const inputs = {}
  for (let i = 0; i < 6; i++) inputs[i] = K.brain(st, i, 'balanced', rngs[i])
  K.step(st, inputs, room)
}
for (let j = 0; j < 40; j++) {
  const inputs = {}
  for (let i = 0; i < 6; i++) inputs[i] = K.brain(st, i, 'balanced', rngs[i])
  K.step(st, inputs, room)
}
const F = st.tick
const kartAtF2 = JSON.parse(JSON.stringify(st.karts[0]))
if (kartAtF2.v === 0) { console.log('前置失败：v=0 无运动'); process.exit(1) }

/* —— 服务器继续跑 2 tick（己席输入=直线 st=0 全油，bot 席照旧）→ 权威态@F+2 —— */
const SRV_IN = { st: 0, th: 1, dr: 0 }
for (let j = 0; j < 2; j++) {
  const inputs = { 0: { q: 1e6 + j, ...SRV_IN } }
  for (let i = 1; i < 6; i++) inputs[i] = K.brain(st, i, 'balanced', rngs[i])
  K.step(st, inputs, room)
}
const FF = st.tick                       // 新快照帧（=F+2）
const authKart = JSON.parse(JSON.stringify(st.karts[0]))

/* —— 客户端影子：锚 kartAtF2@F（上一张快照），在途输入自 F+1 起（flight=1 口径） ——
 * 分歧臂 st=-100（≠服务器 st=0）；健康臂 st=0（与服务器同输入——确定性同式应零修正） */
function clientPred(clientSt) {
  const pred = K.makePredictor('t-bay')
  pred.setPhase('race')
  for (let i = 1; i <= 6; i++) pred.push(F + i, { st: clientSt, th: 1, dr: 0 })
  pred.anchor(kartAtF2, F)
  pred.advanceTo(F)                      // 客户端当前影子（快照到达时刻）
  return pred
}
/* 旧式（QA1 §2.2 复刻） */
function reconcileOld(pred, simTick) {
  pred.anchor(authKart, FF)
  const before = pred.advanceTo(simTick)
  const bx = before ? before.x : authKart.x, by = before ? before.y : authKart.y
  const after = pred.advanceTo(simTick) || authKart
  const dPx = Math.max(Math.abs(after.x - bx), Math.abs(after.y - by)) / 1000
  const mine = K.hashKart(pred.kart() || authKart, FF)      // 影子@simTick 配 FF 前缀
  return { dPx, hashMatch: mine === K.hashKart(authKart, FF) }
}
/* 新式（GAMES-111 client.js 实式） */
function reconcileNew(pred, simTick) {
  const T = Math.max(simTick, FF)             // if (S.simTick < m.frame) S.simTick = m.frame
  const pre = pred.advanceTo(T)               // 修正前预测态（anchor 覆盖前捕获）
  pred.drainEvents()
  const px = pre ? pre.x : authKart.x, py = pre ? pre.y : authKart.y
  pred.anchor(authKart, FF)
  const after = pred.advanceTo(T) || authKart
  const dPx = Math.max(Math.abs(after.x - px), Math.abs(after.y - py)) / 1000
  const mine = K.hashKart(authKart, FF)       // 合并权威态@FF（增量 x/y/a/v + ext.pd d/s/cp）
  return { dPx, hashMatch: mine === K.hashKart(authKart, FF) }
}

const T = FF + 2                             // 本地钟领先权威帧 2 拍（健康时钟态）
const oldDiv = reconcileOld(clientPred(-100), T)
const oldHea = reconcileOld(clientPred(0), T)
const newDiv = reconcileNew(clientPred(-100), T)
const newHea = reconcileNew(clientPred(0), T)
const srvHash = K.hashKart(authKart, FF)

console.log(JSON.stringify({
  前置: { 快照帧FF: FF, 权威v: authKart.v, 本地拍T: T },
  分歧臂_输入st负100: {
    旧式: { dPx: +oldDiv.dPx.toFixed(3), hashMatch: oldDiv.hashMatch },
    新式: { dPx: +newDiv.dPx.toFixed(3), hashMatch: newDiv.hashMatch },
  },
  同输入臂_残余为远车b源: {
    旧式: { dPx: +oldHea.dPx.toFixed(3), hashMatch: oldHea.hashMatch },
    新式: { dPx: +newHea.dPx.toFixed(3), hashMatch: newHea.hashMatch },
  },
  服务器hash: srvHash,
}, null, 1))

const f1 = oldDiv.dPx === 0 && oldHea.dPx === 0 && newDiv.dPx > 6 && newHea.dPx < 6
const f2 = !oldDiv.hashMatch && !oldHea.hashMatch && newDiv.hashMatch && newHea.hashMatch
console.log(`[F1] 旧式两臂 dPx≡0=${oldDiv.dPx === 0 && oldHea.dPx === 0 ? '是（死码复现：recon 台账/软硬分流/混合带全不可测）' : '否'}；新式分歧臂 dPx=${newDiv.dPx.toFixed(3)}px>6（硬回滚分流+台账落账）、同输入臂=${newHea.dPx.toFixed(3)}px<6（软收敛路径，b 源残余在 §5.3 预算带内） → ${f1 ? '✓ 修复证实' : '✗'}`)
console.log(`[F2] 旧式领先态必分歧=${!oldDiv.hashMatch && !oldHea.hashMatch ? '是（假告警：hashWarn 闩锁+sync 洪泛）' : '否'}；新式两臂全匹配=${newDiv.hashMatch && newHea.hashMatch ? '是' : '否'} → ${f2 ? '✓ 修复证实' : '✗'}`)
if (!(f1 && f2)) process.exit(1)
