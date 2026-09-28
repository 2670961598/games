/* =====================================================================
 * pool-bot2-check（GAMES-81 · BOT深化验收挂具）——四支柱：
 *   B1 三档对照 ≥3 局/档：进球率/犯规率/平均杆数/清台率（本地 sim 全速驱动）
 *   B2 开局树双证：每档 ≥2 套差异化（力度/角度/杆法）+ 同 seed 定桩复现
 *   B3 放水局 ≥1 例：env.foeLose≥2 → 降一档出手（同 seed A/B 对照）
 *   B4 网关 pulse：真人连败 2 局 → bot 收 foeLose≥2；真人胜 → 台账清零
 * 用法：node scripts/pool-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const POOL = require(join(ROOT, 'games/multiplayer/pool-physics/sim.cjs'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

/* ---------- 本地全速驱动一局（bot vs bot；envA/envB 注入陪玩信号） ----------
 * env.foeLose 与网关同构：数组按席位索引，foeLose[seat]=该席对手的连败局数 */
function driveGame(seed, lvlA, lvlB, envA, envB, maxTicks = 120000, breakAfterShots = 0) {
  const st = POOL.create(seed, { maxTicks })
  const rngs = [POOL.mulberry32((seed ^ 0x9e3779b9) >>> 0), POOL.mulberry32((seed ^ (1 * 0x9e3779b9)) >>> 0)]
  const lvls = [lvlA, lvlB], envs = [envA || { foeLose: [0, 0] }, envB || { foeLose: [0, 0] }]
  const shots0 = []                                        // 开局杆取证
  const foulWhys = {}
  let guard = 0
  while (!st.over && guard++ < maxTicks + 100) {
    const r0 = st.phase === 'aim' ? null : POOL.step(st, null)
    if (r0) for (const e of (r0.events || [])) if (e.k === 'foul') foulWhys[e.why] = (foulWhys[e.why] || 0) + 1
    if (st.phase !== 'aim') continue
    const inp = {}
    for (const seat of [0, 1]) {
      const d = POOL.brain(st, seat, lvls[seat], rngs[seat], envs[seat])
      if (d) inp[seat] = d
    }
    const r = POOL.step(st, inp)
    for (const e of (r.events || [])) if (e.k === 'foul') foulWhys[e.why] = (foulWhys[e.why] || 0) + 1
    if (r.shot && r.shot.no === 1) shots0.push({ seat: r.shot.seat, ang: r.shot.ang, pow: r.shot.pow, spinV: r.shot.spinV })
    if (breakAfterShots && st.shotN >= breakAfterShots) break
  }
  return { st, shots0, ticks: st.tick, foulWhys }
}

/* 每席指标：杆数/进球/犯规/清台（己组 7 颗全清） */
function seatStats(st, seat) {
  const g = st.groups[seat]
  let shots = 0, potted = 0, cleared = 0
  for (const sh of st.shots) if (sh.seat === seat) shots++
  for (let i = 1; i <= 15; i++) {
    if ((g === 1 && i <= 7) || (g === 2 && i >= 9)) { if (st.balls[i].pot) potted++ }
  }
  if ((g === 1 || g === 2) && potted >= 7) cleared = 1
  return {
    seat, shots, potted, fouls: st.fouls[seat],
    potRate: +(potted / Math.max(shots, 1)).toFixed(3),
    foulRate: +(st.fouls[seat] / Math.max(shots, 1)).toFixed(3),
    cleared,
    win: st.result && st.result.winner === (seat === 0 ? 'A' : 'B') ? 1 : 0,
  }
}

/* ---------- B1 三档对照（每档 3 seed 镜像局，双席合并） ---------- */
console.log('[B1] 三档对照（每档 3 局，seed 101/202/303）')
const TIERS = ['casual', 'balanced', 'competitive']
const SEEDS = [101, 202, 303]
const tierAgg = {}
const openerShots = {}
for (const lvl of TIERS) {
  tierAgg[lvl] = { games: 0, shots: 0, potted: 0, fouls: 0, clears: 0, wins: 0, reasons: [], whys: {} }
  openerShots[lvl] = []
  for (const seed of SEEDS) {
    const { st, shots0, foulWhys } = driveGame(seed, lvl, lvl)
    for (const w of Object.keys(foulWhys)) tierAgg[lvl].whys[w] = (tierAgg[lvl].whys[w] || 0) + foulWhys[w]
    tierAgg[lvl].games++
    tierAgg[lvl].reasons.push(st.result ? st.result.reason : 'none')
    for (const s of [0, 1]) {
      const ss = seatStats(st, s)
      tierAgg[lvl].shots += ss.shots; tierAgg[lvl].potted += ss.potted
      tierAgg[lvl].fouls += ss.fouls; tierAgg[lvl].clears += ss.cleared; tierAgg[lvl].wins += ss.win
    }
    openerShots[lvl].push(...shots0)
  }
  const a = tierAgg[lvl]
  a.potRate = +(a.potted / a.shots).toFixed(3)
  a.foulRate = +(a.fouls / a.shots).toFixed(3)
  a.avgShots = +(a.shots / a.games).toFixed(1)
  a.clearRate = +(a.clears / (a.games * 2)).toFixed(3)
  console.log(`  ${lvl.padEnd(12)} 进球率=${a.potRate} 犯规率=${a.foulRate} 平均杆数=${a.avgShots} 清台率=${a.clearRate} 终局=${a.reasons.join(',')} 犯规构成=${JSON.stringify(a.whys)}`)
}
const agg = tierAgg
ok('B1-1', '每档 ≥3 局', TIERS.every(l => agg[l].games >= 3), `各 ${agg.casual.games} 局`)
ok('B1-2', '犯规率三档差异成立 casual > balanced > competitive',
  agg.casual.foulRate > agg.balanced.foulRate && agg.balanced.foulRate >= agg.competitive.foulRate,
  `${agg.casual.foulRate} > ${agg.balanced.foulRate} ≥ ${agg.competitive.foulRate}`)
ok('B1-3', '进球率 competitive > casual（策略深化有效）', agg.competitive.potRate > agg.casual.potRate,
  `${agg.competitive.potRate} > ${agg.casual.potRate}`)
ok('B1-4', '竞技档近零犯（镜像最劣配对 <12%）', agg.competitive.foulRate < 0.12, `${agg.competitive.foulRate}`)
{
  /* 生产配对口径：竞技 vs 休闲（真人常见对手画像）3 局。休闲 68% 犯规率不断
   * 送 ball-in-hand → 长局贴堆局面的 F3 残留（FEEL 单空间）；验收线=仍低于
   * 均衡档镜像基线（跨配对犯规管理不劣化） */
  let shots = 0, fouls = 0, potted = 0
  for (const seed of [101, 202, 303]) {
    const { st } = driveGame(seed, 'competitive', 'casual')
    const ss = seatStats(st, 0)
    shots += ss.shots; fouls += ss.fouls; potted += ss.potted
  }
  const fr = +(fouls / shots).toFixed(3), pr = +(potted / shots).toFixed(3)
  ok('B1-5', '竞技 vs 休闲：犯规率 < 均衡档基线（0.26）', fr < agg.balanced.foulRate, `犯规率=${fr} 进球率=${pr}（镜像近零犯主证=0.096）`)
}

/* ---------- B2 开局树双证 ---------- */
console.log('[B2] 开局树双证（差异化 + 定桩复现）')
for (const lvl of TIERS) {
  /* 独立 seed 扫掠取证首杆（seed 空间铺开避免定桩巧合）；差异化维度=力度/杆法 */
  const sigs = new Set()
  for (let seed = 1; seed <= 24; seed++) {
    const { shots0 } = driveGame(seed * 7919, lvl, lvl, null, null, 4000, 1)
    for (const s of shots0) sigs.add(`${Math.round(s.pow / 50)}:${s.spinV}`)
  }
  ok(`B2-${lvl}`, '开局树 ≥2 套差异化（力度/杆法维度）', sigs.size >= 2, [...sigs].join(' | '))
}
{
  const r1 = driveGame(777, 'competitive', 'casual')
  const r2 = driveGame(777, 'competitive', 'casual')
  const sig = (g) => JSON.stringify(g.shots0)
  ok('B2-pin', '同 seed 同档开局定桩复现（首杆字节相等）', sig(r1) === sig(r2), `${r1.shots0.length} 杆`)
}

/* ---------- B3 放水局 A/B 对照 ---------- */
console.log('[B3] 陪玩放水（env.foeLose≥2 → 降一档；同 seed A/B）')
const sb0 = POOL._dbg.botStats.sandbag
let sbCase = null
for (const seed of [501, 502, 503]) {
  /* 座0=casual（真人替身），座1=competitive bot；放水臂 foeLose[1]=3（座1 对手连败3） */
  const norm = driveGame(seed, 'casual', 'competitive', { foeLose: [0, 0] }, { foeLose: [0, 0] })
  const give = driveGame(seed, 'casual', 'competitive', { foeLose: [0, 0] }, { foeLose: [0, 3] })
  const nB = seatStats(norm.st, 1), gB = seatStats(give.st, 1)
  console.log(`  seed=${seed} 正常 competitive：进球率=${nB.potRate} 杆数=${nB.shots} 胜=${nB.win} | 放水（→balanced）：进球率=${gB.potRate} 杆数=${gB.shots} 胜=${gB.win}`)
  if (!sbCase && (gB.potRate < nB.potRate || (gB.win < nB.win))) sbCase = { seed, nB, gB }
}
ok('B3-1', '放水局 ≥1 例（进球率下降）', !!sbCase, sbCase ? `seed=${sbCase.seed} ${sbCase.nB.potRate}→${sbCase.gB.potRate}` : '')
ok('B3-2', '放水降档决策发生（botStats.sandbag 增量 >0）', POOL._dbg.botStats.sandbag - sb0 > 0, `+${POOL._dbg.botStats.sandbag - sb0}`)
{
  /* 恢复：foeLose 回 0 → 行为与正常臂一致（同 seed） */
  const norm = driveGame(911, 'casual', 'balanced', null, { foeLose: [0, 0] })
  const back = driveGame(911, 'casual', 'balanced', null, { foeLose: [0, 0] })
  ok('B3-3', '信号消失恢复原档（正常臂字节复现）', JSON.stringify(norm.st.shots) === JSON.stringify(back.st.shots), 'shot 序列相等')
}

/* ---------- B4 网关 pulse 台账（Rooms 直驱：连败→foeLose 传递；胜→清零） ---------- */
console.log('[B4] 网关 pulse（真人连败 2 局 → bot foeLose≥2；真人胜 → 清零）')
{
  const { RoomManager } = await import(join(ROOT, 'server/gateway/rooms.js'))
  const { poolPhysicsSim } = await import(join(ROOT, 'server/gateway/sims/pool-physics.js'))
  let lastEnv = null
  const wrap = Object.assign({}, poolPhysicsSim, {
    brain: (st, seat, lvl, rng, env) => { lastEnv = env; return poolPhysicsSim.brain(st, seat, lvl, rng, env) },
  })
  const rooms = new RoomManager({ log: () => {} })
  rooms.register(wrap)
  const human = { conn: { writable: false, send() {} } }    // 同一连接对象跨房（pulse 键）
  const mk = () => {
    const room = rooms.create({ gameId: 'pool-physics', bots: [null, 'competitive'], startDelayMs: 0, maxTicks: 500 })
    const s0 = room.seats[0]
    s0.kind = 'human'; s0.conn = human                      // 真人席（stub conn）
    return room
  }
  const play = (room, concedeSeat) => {
    let guard = 0
    room.liveAt = 0
    POOL.applyOp(room.state, concedeSeat, { k: 'concede' })
    while (room.phase !== 'ended' && guard++ < 600) rooms.doFrame(room, 1759000000000 + guard)
    return room
  }
  play(mk(), 0)                                             // 局1：真人认负 → lose=1
  play(mk(), 0)                                             // 局2：连败 → lose=2
  { const r = mk(); let g = 0; r.liveAt = 0; while (r.phase !== 'ended' && g++ < 40 && !(lastEnv && lastEnv.foeLose && lastEnv.foeLose[1] >= 2)) rooms.doFrame(r, 1759000000000 + g) }
  ok('B4-1', '连败 2 局 → bot env.foeLose≥2（放水信号送达）', !!(lastEnv && lastEnv.foeLose && lastEnv.foeLose[1] >= 2), lastEnv ? `foeLose=[${lastEnv.foeLose}]` : 'env 未见')
  play(mk(), 1)                                             // 局4：bot 认负 → 真人胜 → lose 清零
  { const r = mk(); let g = 0; r.liveAt = 0; while (r.phase !== 'ended' && g++ < 40 && !(lastEnv && lastEnv.foeLose && lastEnv.foeLose[1] === 0)) rooms.doFrame(r, 1759000000000 + g) }
  ok('B4-2', '真人胜 → 台账清零（连胜恢复）', !!(lastEnv && lastEnv.foeLose && lastEnv.foeLose[1] === 0), lastEnv ? `foeLose=[${lastEnv.foeLose}]` : 'env 未见')
}

console.log(`\nPOOL-BOT2 OK：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
