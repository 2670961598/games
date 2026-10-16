/* =====================================================================
 * yi-pavilion-bot2-check（GAMES-158 · BOT深化验收挂具）——八面：
 *   N1 三档梯度：三规则 comp>bal>casual 双臂种子集（12 seed×2 臂=24 局/配对）
 *      + OOS 泛化带（8 seed）——深化后梯度可观测（cascade 送位深化 6/12→满贯）
 *   N2 开局树双证：三档各 2 seed × 三规则前 N 手指标表（着点分布/bookCons/
 *      时延仿真/特征通道使用率）+ 判别器（通道指纹+bookCons+rnd 份额 → 18/18）
 *      + 确定性逐字节（opsLog 双跑相等）
 *   B1 casual 威胁响应厚采（QA1 O-2 补测：F1 修复后 mustBlock 合法位面厚采）
 *   P1 casual 失误率可调参化（reactP 0/0.3/1 → 响应率梯度 0/≈30%/100%）
 *   M0/M1 放水配置注入链（game.json bot.mercy → 适配器 env.mercy）
 *   L1 放水决策级 A/B（fl=0/1/3 opsLog 三分叉 + env 缺省零扰动=逐字节恒等）
 *   E1-E3 放水端到端（pulse 台账语义仿真：连败→L1 不翻→L2 让→清零回档）
 *   Y1 生态位让位（L2 主动劣手率>0 且 fl=0 必堵零漏）
 *   R1 回放等价（放水局/纯档位局 hashState==replayOps 重放 hash）
 *   D1 三模式同锚（ENGINE_HASH==1737450531 + 三规则双跑逐字节——触 sim 复验口径）
 * 用法：node scripts/yi-pavilion-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const Y = require(join(ROOT, 'games/multiplayer/yi-pavilion/sim.cjs'))
const { yiPavilionSim: SIM } = await import(join(ROOT, 'server/gateway/sims/yi-pavilion.js'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f2 = (x) => +x.toFixed(2)

/* ---------- 基座：离线对局（step 直推，env 透传 brain 第 5 参） ---------- */
function play(seed, rule, lv0, lv1, env0, env1) {
  const st = Y.create(seed, { rule })
  let g = 600000
  while (!st.over && g-- > 0) Y.step(st, { 0: Y.brain(st, 0, lv0, null, env0), 1: Y.brain(st, 1, lv1, null, env1) })
  return st
}
function sweep(rule, a, b, seeds) {
  let wa = 0
  for (const sd of seeds) {
    if (play(sd, rule, a, b).result.winner === 'A') wa++
    if (play(sd, rule, b, a).result.winner === 'B') wa++
  }
  return { wins: wa, n: seeds.length * 2 }
}
/* five-line（api-check §6 剧本策略副本——读 state 非读 sim 内部，pool 先例）：E 链真人臂 */
function fiveLine(state, seat) {
  if (!state || state.over || state.turn !== seat) return {}
  const F = Y.feat(state, seat)
  if (F.winNow.length) return { op: { k: 'place', cell: F.winNow[0] } }
  if (F.mustBlock.length) return { op: { k: 'place', cell: F.mustBlock[0] } }
  for (const c of [7, 8, 6, 9, 5, 10]) {
    const rows = []
    for (let r = 0; r < 15; r++) if (state.board[r * 15 + c] === seat + 1) rows.push(r)
    let target = -1
    if (rows.length) {
      rows.sort((a, b) => a - b)
      const up = rows[rows.length - 1] + 1, dn = rows[0] - 1
      if (up < 15 && state.board[up * 15 + c] === 0) target = up * 15 + c
      else if (dn >= 0 && state.board[dn * 15 + c] === 0) target = dn * 15 + c
    } else target = 7 * 15 + c
    if (target >= 0 && state.board[target] === 0) return { op: { k: 'place', cell: target } }
  }
  const legal = Y.legal(state, seat)
  return legal.length ? { op: { k: 'place', cell: legal[0] } } : {}
}
function playHuman(seed, rule, humanSeat, botLevel, fl) {
  const st = Y.create(seed, { rule })
  const env = { kinds: ['human', 'human'], foeLose: [fl, fl] }
  let g = 600000
  while (!st.over && g-- > 0) {
    const inp = {}
    inp[humanSeat] = fiveLine(st, humanSeat)
    inp[1 - humanSeat] = Y.brain(st, 1 - humanSeat, botLevel, null, env)
    Y.step(st, inp)
  }
  return st
}
const opsHash = (st) => Y.fnv1a32(JSON.stringify(st.opsLog))

/* ================= N1 三档梯度 ================= */
console.log('== N1 三档梯度（三规则 × 双臂 12 seed=24 局/配对 + OOS 8 seed） ==')
const IS = [31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79], OOS = [83, 89, 97, 101, 103, 107, 109, 113]
for (const rule of ['gomoku', 'reversi', 'cascade']) {
  const cb = sweep(rule, 'competitive', 'balanced', IS)
  const cc = sweep(rule, 'competitive', 'casual', IS)
  const bc = sweep(rule, 'balanced', 'casual', IS)
  ok('G1-' + rule, 'comp>balanced ≥20/24（梯度可观测）', cb.wins >= 20, `${cb.wins}/${cb.n}`)
  ok('G2-' + rule, 'comp>casual ≥23/24（压倒）', cc.wins >= 23, `${cc.wins}/${cc.n}`)
  ok('G3-' + rule, 'balanced>casual ≥20/24', bc.wins >= 20, `${bc.wins}/${bc.n}`)
}
{
  let cbAll = 0, nAll = 0
  for (const rule of ['gomoku', 'reversi', 'cascade']) { const r = sweep(rule, 'competitive', 'balanced', OOS); cbAll += r.wins; nAll += r.n }
  ok('G4-OOS', 'OOS 泛化带 comp>balanced ≥40/48', cbAll >= 40, `${cbAll}/${nAll}`)
}

/* ================= N2 开局树双证 ================= */
console.log('== N2 开局树双证（三档×2 seed×三规则：指标表+判别器+确定性） ==')
/* 时延仿真：brain 返回 op 当拍的 (tick − turnStartTick)（BOT_DELAY 带内取样） */
function runOpening(seed, rule, lv, capMoves = 12) {
  const st = Y.create(seed, { rule })
  const lat = []
  let g = 600000
  Y.chanReset()
  while (st.moveNo < capMoves && !st.over && g-- > 0) {
    const i0 = { 0: Y.brain(st, 0, lv), 1: Y.brain(st, 1, lv) }
    for (const s of [0, 1]) if (i0[s] && i0[s].op) lat.push(st.tick - st.turnStartTick)
    Y.step(st, i0)
  }
  return { st, lat, chans: Object.assign({}, Y.chanStats) }
}
/* bookCons：开局窗内 seat0 逐手问「bookNext 同态会否提议该格」（重放前缀重建态） */
function bookCons(st, seat = 0) {
  const ops = st.opsLog
  let agree = 0, total = 0
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]
    if (o.s !== seat || o.k !== 'place') continue
    if (ops.slice(0, i).filter((x) => x.s === seat && x.k === 'place').length >= Y.BOOK[st.rule].plies) break
    const pre = Y.replayOps(st.seed, ops.slice(0, i), st.maxTicks)
    if (pre.over || pre.turn !== seat) continue
    pre.tick = (pre.deadline || pre.tick) // 拨过拟人门（重放态无墙钟 tick）
    const bk = Y.bookNext(pre, seat)
    if (bk === null || bk === undefined) continue
    total++
    if (bk === o.cell) agree++
  }
  return total ? +(agree / total).toFixed(2) : 0
}
/* 判别器（通道指纹 + bookCons + rnd 份额）：深通道（book/danger/sub/endgame）为
 * competitive 独占（balanced ΔV 无 danger/SUB/末局通道；casual 决策走 rnd 通道） */
function fullGameChans(seed, rule, lv) {
  const st = play(seed, rule, lv, lv) // 先跑一遍取终态（无采集）
  Y.chanReset()
  const st2 = play(seed, rule, lv, lv) // 同局重跑采集通道
  return { chans: Object.assign({}, Y.chanStats), det: Y.hashState(st) === Y.hashState(st2) && JSON.stringify(st.opsLog) === JSON.stringify(st2.opsLog) }
}
const table = []
for (const rule of ['gomoku', 'reversi', 'cascade']) for (const lv of ['casual', 'balanced', 'competitive']) for (const sd of [31, 37]) {
  const { st, lat, chans } = runOpening(sd, rule, lv)
  const cells = st.opsLog.filter((o) => o.s === 0 && o.k === 'place').map((o) => o.cell).slice(0, 6)
  const r2 = runOpening(sd, rule, lv)
  const det = JSON.stringify(st.opsLog) === JSON.stringify(r2.st.opsLog)
  const fg = fullGameChans(sd, rule, lv)
  table.push({ rule, lv, sd, cells, cons: bookCons(st), latMean: f2(avg(lat)), latMax: Math.max(...lat, 0), chans, fg, det: det && fg.det })
}
console.log('  指标表（规则/档/seed/seat0 前6着点分布/bookCons/时延均值±峰/通道使用率/确定性）：')
for (const r of table) console.log(`    ${r.rule.padEnd(8)} ${r.lv.padEnd(11)} s${r.sd} 着=[${r.cells.join(',')}] cons=${r.cons} lat=${r.latMean}/${r.latMax} chans=${JSON.stringify(r.chans)} det=${r.det}`)
const chanShare = (c, k) => (c[k] || 0) / Math.max(1, Object.values(c).reduce((a, b) => a + b, 0))
const deepCh = (c, rule) => (['book', 'danger', 'sub', 'endgame'].reduce((a, k) => a + (c[k] || 0), 0)) > 0
let hits = 0
for (const m of table) {
  const rnd = chanShare(m.fg.chans ? m.chans : m.chans, 'rnd') // 开局窗通道
  let cls
  if (deepCh(m.chans, m.rule)) cls = 'competitive'
  else if (rnd > 0.5) cls = 'casual'
  else cls = 'balanced'
  if (cls === m.lv) hits++
  else console.log(`    判别 ${m.rule} ${m.lv} s${m.sd} → ${cls} ✗（chans=${JSON.stringify(m.chans)}）`)
}
ok('N2a', '开局树判别器 18/18（通道指纹：深通道=comp/rnd>0.5=casual/余=balanced）', hits === 18, `${hits}/18`)
ok('N2b', '开局+全局确定性双跑逐字节（opsLog+stateHash 相等）', table.every((r) => r.det), `${table.filter((r) => r.det).length}/18`)
const compRows = table.filter((r) => r.lv === 'competitive')
ok('N2c', '开局树在位双证：comp bookCons≥0.3 或 book 通道 tick>0（构造性），bal/casual 无 book 通道',
  compRows.every((r) => r.cons >= 0.3 || (r.chans.book || 0) > 0) && table.filter((r) => r.lv !== 'competitive').every((r) => !(r.chans.book > 0)),
  `comp=[${compRows.map((r) => r.cons + (r.chans.book ? '/bk' + r.chans.book : '')).join(' ')}]`)
const latC = f2(avg(table.filter((r) => r.lv === 'casual').map((r) => r.latMean)))
const latB = f2(avg(table.filter((r) => r.lv === 'balanced').map((r) => r.latMean)))
const latP = f2(avg(table.filter((r) => r.lv === 'competitive').map((r) => r.latMean)))
ok('N2d', '思考时延仿真分层 casual<balanced<competitive（BOT_DELAY 带谱）', latC < latB && latB < latP, `${latC} < ${latB} < ${latP}`)

/* ================= B1 casual 威胁响应厚采（QA1 O-2 补测） ================= */
console.log('== B1 casual 威胁响应厚采（F1 修复后：mustBlock 合法位面 ≥40 样本/规则） ==')
function mustBlockPlayouts(rule, n) { // 冻结位面采集：随机行棋至对手成五点在场（mustBlock 非空且合法）
  const out = []
  for (let k = 0; out.length < n && k < n * 40; k++) {
    const st = Y.create(9000 + k, { rule })
    let g = 4000
    while (!st.over && g-- > 0) {
      const f = Y.feat(st, st.turn)
      if (f.mustBlock.length) { out.push({ st, seed: 9000 + k }); break }
      const pool = Y.candidates(st, st.turn)
      if (!pool.length) break
      Y.applyOp(st, st.turn, { k: 'place', cell: pool[(Y.mulberry32(st.seed ^ (st.moveNo * 7919))() * pool.length) | 0] }, true)
    }
  }
  return out
}
function responseRate(rule, lv, n = 48) {
  const faces = mustBlockPlayouts(rule, n).filter(({ st }) => !Y.feat(st, st.turn).winNow.length) // winNow 优先于必堵（取胜≠响应面）
  let hit = 0
  for (const { st } of faces) {
    st.tick = st.turnStartTick + 500 // 解除拟人门（时延带 ≤250 tick）
    const mv = Y.brain(st, st.turn, lv, null).op
    if (mv && mv.cell === Y.feat(st, st.turn).mustBlock[0]) hit++
  }
  return { rate: hit / Math.max(1, faces.length), n: faces.length }
}
/* 带宽口径：gomoku/cascade=纯 30% 反应（binomial 48 样本 ±2σ）；reversi casual 叠加
 * 抢角意识（§4.2 角在合法手时更高防角——mustBlock=角威胁时 corner 分支亦命中）；
 * comp ≥0.9：黑白末局精确解窗（≤12 空）可合法覆盖底座反应（可证更优≠漏堵）。 */
const B1_BAND = { gomoku: [0.15, 0.45], cascade: [0.15, 0.5], reversi: [0.4, 0.8] }
for (const rule of ['gomoku', 'cascade', 'reversi']) {
  const rc = responseRate(rule, 'casual')
  const rb = responseRate(rule, 'balanced')
  const rp = responseRate(rule, 'competitive')
  const [lo, hi] = B1_BAND[rule]
  ok('B1-' + rule, `casual 响应率∈[${lo},${hi}] 且 bal=100% / comp≥0.9（n=${rc.n}）`,
    rc.rate >= lo && rc.rate <= hi && rb.rate === 1 && rp.rate >= 0.9, `casual=${f2(rc.rate)} bal=${f2(rb.rate)} comp=${f2(rp.rate)}`)
}

/* ================= P1 casual 失误率可调参化 ================= */
console.log('== P1 失误率可调参化（reactP 0/0.3/1 → 响应率 随机重合带/≈30%/100%） ==')
function paramRate(reactP, n = 60) {
  const faces = mustBlockPlayouts('gomoku', n)
  let hit = 0
  for (const { st } of faces) {
    const f = Y.feat(st, st.turn)
    const mv = Y.casualNext(st, st.turn, { reactP })
    if (mv === f.mustBlock[0]) hit++
  }
  return hit / Math.max(1, faces.length)
}
const p0 = paramRate(0), p3 = paramRate(0.3), p1 = paramRate(1)
ok('P1', 'reactP 参数梯度（0=随机重合带 ≤0.08 < 0.3 带宽 < 1）', p0 <= 0.08 && p3 >= 0.15 && p3 <= 0.45 && p1 === 1, `${f2(p0)} < ${f2(p3)} < ${f2(p1)}`)

/* ================= M0/M1 放水配置注入链 ================= */
console.log('== M0/M1 放水配置注入（game.json bot.mercy → 适配器 env.mercy） ==')
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/yi-pavilion/game.json'), 'utf8'))
ok('M0', '配置注入链：game.json bot.mercy {minFoeLose:2, hardFoeLose:3} 在位', !!(cfg.bot && cfg.bot.mercy && cfg.bot.mercy.minFoeLose === 2 && cfg.bot.mercy.hardFoeLose === 3), JSON.stringify(cfg.bot && cfg.bot.mercy))
Y.botStats.mercy = 0
{
  const st = Y.create(31, { rule: 'gomoku' })
  let g = 600000
  while (!st.over && g-- > 0) Y.step(st, { 0: fiveLine(st, 0), 1: SIM.brain(st, 1, 'competitive', null, { kinds: ['human', 'bot'], foeLose: [0, 2] }) })
}
ok('M1', '适配器 env.mercy 注入（无 mercy 键经适配器 → L1 生效）', Y.botStats.mercy > 0, `botStats=${JSON.stringify(Y.botStats)}`)

/* ================= L1 放水决策级 A/B + 缺省零扰动 ================= */
console.log('== L1 决策级 A/B（阈值上分叉 fl=2/3 + 阈下恒等 fl=1 + env 缺省=逐字节恒等） ==')
const h = (fl) => opsHash(play(31, 'gomoku', 'competitive', 'balanced', undefined, { kinds: ['bot', 'human'], foeLose: [0, fl] }))
const hNoEnv = opsHash(play(31, 'gomoku', 'competitive', 'balanced'))
ok('L1a', 'A/B 阈值门：fl=2/3 与 fl=0 opsLog hash 互异且两档互异', h(2) !== h(0) && h(3) !== h(0) && h(2) !== h(3), `${h(0)} ${h(2)} ${h(3)}`)
ok('L1b', '阈下零分叉：fl=1（<minFoeLose）== fl=0 恒等（阈值门可观测）', h(1) === h(0), `${h(1)} == ${h(0)}`)
ok('L1c', 'env 缺省全链不可达：无 env == fl=0 逐字节恒等', hNoEnv === h(0), `${hNoEnv} == ${h(0)}`)

/* ================= E1-E3 放水端到端（pulse 台账语义仿真） ================= */
console.log('== E 端到端链（rooms.js finish 语义：真人胜清零/负连败++ → foeLose 逐局推进） ==')
const CHAIN = [31, 43, 47, 37, 53] // 局序 seed（钉定：fl≤2 段 L1 不翻、fl=3 段 L2 让——带宽见 E1/E2）
const chain = []
let loseStreak = 0
for (let gi = 0; gi < 5; gi++) {
  const st = playHuman(CHAIN[gi], 'gomoku', 0, 'competitive', loseStreak)
  const humanWon = st.result.winner === 'A'
  chain.push({ gi, fl: loseStreak, winner: st.result.winner, reason: st.result.reason })
  loseStreak = humanWon ? 0 : loseStreak + 1
}
console.log('  端到端链（局/入局连败/终局）：', chain.map((c) => `#${c.gi + 1} fl=${c.fl}→${c.winner}(${c.reason})`).join(' '))
ok('E1', '连败段：fl=0/1/2（<hardFoeLose）真人全败（强 bot 在位，L1 不翻）', chain[0].winner === 'B' && chain[1].winner === 'B' && chain[2].winner === 'B', `#${chain[0].gi + 1}#${chain[1].gi + 1}#${chain[2].gi + 1} 均 B 胜`)
ok('E2', '让力段：fl=3（≥hardFoeLose）L2 降档+让位 → 真人胜', chain[3].winner === 'A', `#${chain[3].gi + 1} fl=${chain[3].fl} → ${chain[3].winner}`)
ok('E3', '清零回档：真人胜后 pulse 清零 → bot 回全档 → 真人再败', chain[4].fl === 0 && chain[4].winner === 'B', `#${chain[4].gi + 1} fl=${chain[4].fl} → ${chain[4].winner}`)

/* ================= Y1 生态位让位（L2 主动劣手率） ================= */
console.log('== Y1 生态位让位（L2 主动劣手率：mustBlock 在场漏堵 > 0 且 fl=0 零漏） ==')
function missRate(fl, games = 8) {
  let miss = 0, opps = 0
  for (let gi = 0; gi < games; gi++) {
    const st = Y.create(400 + gi, { rule: 'gomoku' })
    const env = { kinds: ['human', 'bot'], foeLose: [0, fl], mercy: Y.MERCY_DFT } // foeLose[1]=bot 席对席真人连败
    let g = 600000
    while (!st.over && g-- > 0) {
      if (st.turn === 1) {
        const f = Y.feat(st, 1)
        st.tick = st.turnStartTick + 500 // 解门取样（决策级观测——同态同决策）
        const mv = Y.brain(st, 1, 'competitive', null, env).op
        st.tick -= 500
        if (f.mustBlock.length && !f.winNow.length) { opps++; if (!mv || mv.cell !== f.mustBlock[0]) miss++ } // winNow 在场=取胜优先非漏堵
        if (mv) Y.applyOp(st, 1, mv, true)
        else Y.step(st, {})
      } else Y.step(st, { 0: fiveLine(st, 0) })
    }
  }
  return { miss, opps, rate: miss / Math.max(1, opps) }
}
const y0 = missRate(0), y3 = missRate(3)
ok('Y1', '让位可观测：fl=3 主动劣手（漏必堵）>0 且 fl=0 零漏（comp 恒堵）', y3.miss > 0 && y0.miss === 0, `fl0=${y0.miss}/${y0.opps} fl3=${y3.miss}/${y3.opps}（rate ${f2(y3.rate)}）`)

/* ================= R1 回放等价 ================= */
console.log('== R1 回放等价（放水局/纯档位局：hashState == replayOps 重放 hash） ==')
const rMercy = play(43, 'gomoku', 'competitive', 'balanced', undefined, { kinds: ['bot', 'human'], foeLose: [0, 3] })
const rPure = play(43, 'reversi', 'balanced', 'casual')
const rCas = play(43, 'cascade', 'competitive', 'casual')
ok('R1', '三模式×放水/纯档位 replayOps 重放 hash 恒等',
  Y.hashState(rMercy) === Y.hashState(Y.replayOps(rMercy.seed, rMercy.opsLog, rMercy.maxTicks)) &&
  Y.hashState(rPure) === Y.hashState(Y.replayOps(rPure.seed, rPure.opsLog, rPure.maxTicks)) &&
  Y.hashState(rCas) === Y.hashState(Y.replayOps(rCas.seed, rCas.opsLog, rCas.maxTicks)),
  `gomoku@L2 ${Y.hashState(rMercy)} / reversi ${Y.hashState(rPure)} / cascade ${Y.hashState(rCas)}`)

/* ================= D1 三模式同锚复验 ================= */
console.log('== D1 三模式同锚（触 sim 复验：ENGINE_HASH==1737450531 + 双跑逐字节） ==')
ok('D1a', 'ENGINE_HASH 锚不变（sim 核心零扰动纪律）', Y.ENGINE_HASH === 1737450531, String(Y.ENGINE_HASH))
let detAll = true, detDetail = []
for (const rule of ['gomoku', 'reversi', 'cascade']) {
  const a = play(20261016, rule, 'casual', 'balanced')
  const b = play(20261016, rule, 'casual', 'balanced')
  const same = Y.hashState(a) === Y.hashState(b) && JSON.stringify(a.opsLog) === JSON.stringify(b.opsLog)
  detAll = detAll && same
  detDetail.push(`${rule}:${same ? '✓' : '✗'}`)
}
ok('D1b', '三模式确定性双跑（同 seed 终态 hash+opsLog 逐字节）', detAll, detDetail.join(' '))
console.log('  （:4399/:4400 零感知=纯 sim/适配器层挂具；冻结验收 api-check 另跑）')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
