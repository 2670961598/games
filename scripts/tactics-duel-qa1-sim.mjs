#!/usr/bin/env node
/* =====================================================================
 * GAMES-119 战棋对决 QA一号 —— S1+S5 专项走查（sim 级，脱离网关纯 Node 复核）
 *   D1 确定性审计（QA 复证+扩展）：四地图 seed 各双跑（create×2 同 op 序 →
 *      hashState 相等）+ replayOps 重放对照（在线 == 回放）——DEV A6 单 seed 的
 *      四图覆盖扩展（mapId=seed%4 全遍历）。
 *   D2 S5 回合裁决边界——并发冲突三类（§5.4）：
 *      a 双击/重复提交：第二条 reject（幂等安全）；
 *      b endTurn vs 回合超时：tick 先到 → timeout-turn 代打 + 后到 op reject not-your-turn；
 *      c undo 与在途 op 交错：undo 后旧意图 op 按恢复后态校验 reject。
 *   D3 悔棋裁决：快照整体恢复（位置/HP/死亡/据点翻转/AP 全回滚）+ ≤1 次/回合
 *      （二次 undo reject undo-used）+ 跨回合复位。
 *   D4 超时托管三层：超时单回合=casual 代打（timeout-turn 入账+代打段入日志）/
 *      主动托管=hosted（host on→bot op 入账，任意合法 op 夺回）/断线 afk 三分离
 *      （连续 3 全超时回合 → afk 终局；有 op 回合不计）。
 *   D5 个性化视图分路（§5.3）：deploy 互密置（对方 deploys=null、观战双 null）；
 *      act 操作者=实时 canonical、对手/观战=边界态（不含操作者本回合动作）；
 *      canonical serialize 不受 viewFor 影响。
 *   D6 回放器含系统事件：$timeout 段重放终局 hash == 在线（afk/托管代打局）。
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { createRequire } from 'node:module'
const D = createRequire(import.meta.url)('/Volumes/BigDisk/Studio/projects/GAMES/repo/games/multiplayer/tactics-duel/sim.cjs')

let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const deployT0 = (st, seat) => D.applyOp(st, seat, { k: 'deploy', cells: D.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: D.TEMPLATES[0][i][seat] })) })
const deploysOf = (st) => st.opsLog.filter((o) => o.k === 'deploy').map((o) => JSON.stringify(o))
const stripTick = (log) => log.map((o) => JSON.stringify({ s: o.s, k: o.k, ...o, s: undefined, k: undefined })).join('|')

/* ---------- D1 确定性审计：四图双跑+回放 ---------- */
console.log('[D1] 确定性审计（四地图 seed 双跑 + 回放对照）')
for (const seed of [20261012, 20261013, 20261014, 20261015]) {
  const run = () => {
    const st = D.create(seed, { maxTicks: 60000 })
    deployT0(st, 0); deployT0(st, 1)
    let guard = 60000
    while (!st.over && guard-- > 0) {
      D.step(st, { 0: D.brain(st, 0, 'balanced'), 1: D.brain(st, 1, 'balanced') })
    }
    return st
  }
  const a = run(), b = run()
  const ha = D.hashState(a), hb = D.hashState(b)
  ok(ha === hb, `双跑一致 seed=${seed}（mapId=${seed % 4}）`, `hash=${ha}${ha === hb ? '' : ' vs ' + hb}`)
  ok(a.over, `双跑局终态达成 seed=${seed}`, a.result ? `${a.result.winner}/${a.result.reason}` : '未终局')
  const rep = D.replayOps(seed, a.opsLog, 60000)
  const hr = D.hashState(rep)
  ok(hr === ha, `回放器重放 == 在线终态 seed=${seed}`, `replay=${hr} online=${ha}`)
  ok(deploysOf(a).join('|') === deploysOf(b).join('|'), `双跑部署段逐字节 seed=${seed}`, `${deploysOf(a).length} 段`)
}

/* ---------- D2 并发冲突三类 ---------- */
console.log('[D2] S5 回合裁决边界——并发冲突（§5.4 串行单通道语义）')
{
  const st = D.create(20261012)
  deployT0(st, 0); deployT0(st, 1)
  ok(st.phase === 'act' && st.turnSeat === 0, '前置：reveal 后先手 A 回合', `phase=${st.phase} turn=${st.turnSeat}`)
  const lance = st.units.find((u) => u.seat === 0 && u.type === 'lance')
  const path = D.reach(st, lance.id).find((r) => r.path.length === 4).path
  const r1 = D.applyOp(st, 0, { k: 'move', unit: lance.id, path })
  const r2 = D.applyOp(st, 0, { k: 'move', unit: lance.id, path })
  ok(r1.ok === true && !!r2.reject, 'a 双击/重复提交：第二条 reject（幂等安全）', `r1=ok r2=${r2.reject}`)
  const sword = st.units.find((u) => u.seat === 0 && u.type === 'sword')
  const p2 = D.reach(st, sword.id).find((r) => r.path.length === 4).path
  D.applyOp(st, 0, { k: 'move', unit: sword.id, path: p2 })
  /* b：endTurn vs 回合超时——步进 tick 到 deadline（恰好一次超时），后到同席 op reject not-your-turn */
  const stB = D.create(20261012)
  deployT0(stB, 0); deployT0(stB, 1)
  while (stB.tick < stB.deadline - 1 && !stB.over) D.step(stB)
  ok(stB.tick === stB.deadline - 1, 'b 前置：步进至回合 deadline-1（单次超时口径）', `tick=${stB.tick} deadline=${stB.deadline}`)
  D.step(stB) // 触发 timeoutTurn（casual 代打整回合，恰好一次）
  const evs = stB.outbox.splice(0).flatMap((o) => o.events)
  ok(evs.some((e) => e.k === 'timeout-turn' && e.seat === 0), 'b 超时代打：timeout-turn 事件入账', JSON.stringify(evs.map((e) => e.k).slice(0, 6)))
  ok(stB.turnSeat === 1 || stB.over, 'b 超时代打后换手 B', `turn=${stB.turnSeat}`)
  const late = D.applyOp(stB, 0, { k: 'endTurn' })
  ok(!!late.reject && late.reject === 'not-your-turn', 'b 迟到 endTurn reject not-your-turn（先到者生效）', late.reject)
  /* c：undo 与在途 op 交错——undo 恢复后，撤销前格上的旧意图 move 按恢复后态校验 */
  const stC = D.create(20261012)
  deployT0(stC, 0); deployT0(stC, 1)
  const l2 = stC.units.find((u) => u.seat === 0 && u.type === 'lance')
  const pathC = D.reach(stC, l2.id).find((r) => r.path.length === 4).path
  D.applyOp(stC, 0, { k: 'move', unit: l2.id, path: pathC })
  const ru = D.applyOp(stC, 0, { k: 'undo' })
  ok(ru.ok === true && stC.units.find((u) => u.id === l2.id).cell === pathC[0] && stC.ap === 4, 'c 前置：undo 后位置/AP 整体恢复', `cell=${stC.units.find((u) => u.id === l2.id).cell} ap=${stC.ap}`)
  /* 旧意图 op：撤销前从「已移动到的格」续走的 op（undo 到达前已组包）——恢复后起点不匹配 → reject */
  const dest = pathC[pathC.length - 1]
  const rOld = D.applyOp(stC, 0, { k: 'move', unit: l2.id, path: [dest, dest - 8 < 0 ? dest + 8 : dest - 8] })
  ok(!!rOld.reject, 'c 撤销前意图 op 按恢复后态校验（起点已变 → reject）', `${rOld.reject}（组包起点=${dest}，恢复后起点=${pathC[0]}）`)
}

/* ---------- D3 悔棋裁决 ---------- */
console.log('[D3] 悔棋裁决（§5.4 快照整体恢复）')
{
  const st = D.create(20261014)
  deployT0(st, 0); deployT0(st, 1)
  const before = { units: st.units.map((u) => ({ ...u })), own: [...st.own], scores: [...st.scores], ap: st.ap }
  /* 制造战斗痕迹：A 前压两单位 + 攻击一次（掉血/可能死亡）+ 占点翻转尝试 */
  const ax = st.units.find((u) => u.seat === 0 && u.type === 'axe')
  const mv = D.reach(st, ax.id).sort((a, b) => b.path.length - a.path.length)[0]
  D.applyOp(st, 0, { k: 'move', unit: ax.id, path: mv.path })
  const sw = st.units.find((u) => u.seat === 0 && u.type === 'sword')
  const mv2 = D.reach(st, sw.id).sort((a, b) => b.path.length - a.path.length)[0]
  D.applyOp(st, 0, { k: 'move', unit: sw.id, path: mv2.path })
  const tgt = D.atkTargets(st, sw.id)[0]
  if (tgt !== undefined) D.applyOp(st, 0, { k: 'attack', unit: sw.id, tgt })
  const mid = { units: st.units.map((u) => ({ ...u })), own: [...st.own], scores: [...st.scores], ap: st.ap }
  const changed = JSON.stringify(before) !== JSON.stringify(mid)
  ok(changed, '前置：回合内已产生移动/战斗痕迹', `ops=${st.opsLog.filter((o) => o.tn === st.turnNo).length}`)
  const r = D.applyOp(st, 0, { k: 'undo' })
  const after = { units: st.units.map((u) => ({ ...u })), own: [...st.own], scores: [...st.scores], ap: st.ap }
  ok(r.ok === true && JSON.stringify(after) === JSON.stringify(before), 'undo 整体恢复（位置/HP/死亡/据点/AP 与 turnStart 逐字节相等）', `ap=${after.ap}`)
  const r2 = D.applyOp(st, 0, { k: 'undo' })
  ok(!!r2.reject && r2.reject === 'undo-used', '二次 undo reject undo-used（≤1 次/回合）', r2.reject)
  /* 跨回合复位：endTurn 换手再换回，undo 可再用 */
  D.applyOp(st, 0, { k: 'endTurn' })
  while (st.turnSeat !== 0 && !st.over) { D.step(st, { 1: D.brain(st, 1, 'casual') }) }
  if (!st.over) {
    const r3 = D.applyOp(st, 0, { k: 'undo' })
    ok(r3.ok === true, '跨回合 undo 复位（新回合可再用）', `turnNo=${st.turnNo} undoUsed=${st.undoUsed}`)
    const r4 = D.applyOp(st, 1, { k: 'undo' })
    ok(!!r4.reject && r4.reject === 'not-your-turn', '非回合席 undo reject not-your-turn', r4.reject)
  } else ok(false, '跨回合 undo 复位（局提前终局——断言未达）', st.result.reason)
}

/* ---------- D4 超时托管三层 ---------- */
console.log('[D4] 托管三层（超时=casual / 主动=hosted 倾向继承 / afk 三分离）')
{
  /* 层1：超时单回合 casual 代打 */
  const st = D.create(20261012)
  deployT0(st, 0); deployT0(st, 1)
  while (st.tick < st.deadline - 1 && !st.over) D.step(st)
  D.step(st)
  ok(st.opsLog.some((o) => o.k === '$timeout' && o.s === 0), '层1 超时代打：$timeout 入账（回放含托管段标记）', `$timeout ×${st.opsLog.filter((o) => o.k === '$timeout').length}`)
  ok(st.turnSeat === 1, '层1 代打完成换手', `turn=${st.turnSeat}`)
  /* 层2：主动托管 host on → hosted 续打（倾向继承）；任意合法 op 夺回 */
  const st2 = D.create(20261013)
  deployT0(st2, 0); deployT0(st2, 1)
  const rh = D.applyOp(st2, 0, { k: 'host', on: true })
  ok(rh.ok === true && st2.hostOn[0] === true, '层2 host on 生效（任意相位合法）', `hostOn=[${st2.hostOn}]`)
  let hostedOps = 0, guard = 3000
  while (!st2.over && guard-- > 0 && hostedOps < 3) {
    D.step(st2)
    const n = st2.opsLog.filter((o) => o.s === 0 && o.tn === st2.turnNo && o.k !== 'host').length
    hostedOps = Math.max(hostedOps, n)
  }
  ok(st2.opsLog.some((o) => o.s === 0 && (o.k === 'move' || o.k === 'attack' || o.k === 'skill' || o.k === 'endTurn')), '层2 hosted 续打入账（bot 席 op 与真人同通道）', `${st2.opsLog.filter((o) => o.s === 0 && o.k !== 'host' && o.k !== 'deploy').length} ops`)
  const evHost = st2.outbox.splice(0).flatMap((o) => o.events).filter((e) => e.k === 'host')
  ok(evHost.some((e) => e.on === true), '层2 host 事件广播（all 可见）', JSON.stringify(evHost))
  const retake = D.applyOp(st2, 0, { k: 'endTurn' })
  ok(retake.ok === true && st2.hostOn[0] === false, '层2 任意合法 op 即夺回（hostOn 自动清）', `hostOn=[${st2.hostOn}] retake=${retake.ok ? 'ok' : retake.reject}`)
  /* 层3：afk 三分离——连续 3 全超时回合（零 op）→ afk 终局；有 op 回合重置计数 */
  const st3 = D.create(20261012)
  deployT0(st3, 0); deployT0(st3, 1)
  let guard3 = 20000
  while (!st3.over && guard3-- > 0) D.step(st3) // 双方零 op：A 3 连全超时 → afk
  ok(st3.over && st3.result.reason === 'afk' && st3.result.winner === 'B', '层3 连续 3 全超时回合 → afk 认负（B 胜）', `${st3.result.winner}/${st3.result.reason} tick=${st3.tick}`)
  ok(st3.opsLog.filter((o) => o.k === '$timeout').length >= 3, '层3 afk 前有 ≥3 段 $timeout 入账', `$timeout ×${st3.opsLog.filter((o) => o.k === '$timeout').length}`)
}

/* ---------- D5 个性化视图分路 ---------- */
console.log('[D5] 个性化视图分路（§5.3 canonical 不受影响）')
{
  const st = D.create(20261015)
  deployT0(st, 0)
  /* deploy 相位：对方/观战密置 */
  const v0 = D.viewFor(st, 0), v1 = D.viewFor(st, 1), vS = D.viewFor(st, -1)
  ok(Array.isArray(v0.deploys) && !!v0.deploys[0] && v0.deploys[0].length === 6 && v0.deploys[1] === null, 'deploy 己方实时/对方密置（A 视角）', JSON.stringify(v0.deploys.map((d) => (d ? 6 : null))))
  ok(v1.deploys[0] === null && v1.deploys[1] === null, 'deploy 对方视角：A 布置不可见', JSON.stringify(v1.deploys.map((d) => (d ? 6 : null))))
  ok(vS.deploys[0] === null && vS.deploys[1] === null, 'deploy 观战双隐藏', JSON.stringify(vS.deploys.map((d) => (d ? 6 : null))))
  deployT0(st, 1)
  /* A 回合内：move 后操作者视图实时、对手/观战视图=边界态（不含本回合动作） */
  const lance = st.units.find((u) => u.seat === 0 && u.type === 'lance')
  const pick = (id) => D.reach(st, id).filter((r) => r.path.length > 1).sort((a, b) => b.path.length - a.path.length)[0]
  const mv = pick(lance.id)
  ok(!!mv, '前置：lance 有可移动格', mv ? `path=${mv.path.length}` : '无可动格')
  D.applyOp(st, 0, { k: 'move', unit: lance.id, path: mv.path })
  const path = mv.path
  const va = D.viewFor(st, 0), vb = D.viewFor(st, 1), vs2 = D.viewFor(st, -1)
  const liveCell = va.units.find((u) => u.id === lance.id).cell
  const bCell = vb.units.find((u) => u.id === lance.id).cell
  const sCell = vs2.units.find((u) => u.id === lance.id).cell
  ok(liveCell === path[path.length - 1], 'act 操作者视图=实时 canonical（含本回合 move）', `cell=${liveCell}`)
  ok(bCell === path[0] && sCell === path[0], 'act 对手/观战视图=边界态（不含操作者本回合动作）', `B=${bCell} spec=${sCell}（起点=${path[0]}）`)
  ok(va.ap === 3 && vb.ap === 4 && vs2.ap === 4, 'act AP 视图分路（操作者实时 3/边界态 4）', `A=${va.ap} B=${vb.ap} spec=${vs2.ap}`)
  const hLive = D.hashState(st)
  D.viewFor(st, 0); D.viewFor(st, 1); D.viewFor(st, -1)
  ok(D.hashState(st) === hLive, 'viewFor 无副作用（canonical 不受个性化影响）', `hash=${hLive}`)
  /* 终局 reveal：双方部署史全披露 */
  D.applyOp(st, 0, { k: 'concede' })
  const vEnd = D.viewFor(st, 1)
  ok(st.over && vEnd.reveal && Array.isArray(vEnd.reveal.deploys) && !!vEnd.reveal.deploys[0] && !!vEnd.reveal.deploys[1], '终局 reveal 双方部署全披露（§5.3）', vEnd.reveal ? 'deploys 双全' : 'null')
}

/* ---------- D6 回放器含系统事件（afk 局重放） ---------- */
console.log('[D6] 回放器重放 afk/代打局（$timeout 段消费）')
{
  const seed = 20261013
  const st = D.create(seed)
  deployT0(st, 0); deployT0(st, 1)
  let guard = 20000
  while (!st.over && guard-- > 0) D.step(st)
  ok(st.over && st.result.reason === 'afk', '前置：afk 局达成', `${st.result.winner}/${st.result.reason}`)
  const rep = D.replayOps(seed, st.opsLog, 60000)
  ok(D.hashState(rep) === D.hashState(st), 'afk 局重放 == 在线终态（含 $timeout 代打段）', `${D.hashState(rep)} == ${D.hashState(st)}`)
}

console.log(`\n${failed === 0 ? 'QA1-SIM OK' : 'QA1-SIM FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
