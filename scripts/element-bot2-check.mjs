/* =====================================================================
 * element-bot2-check（GAMES-91 · BOT深化验收挂具）——五支柱：
 *   B1 三档对照 ≥3 局/档（seat0=档位 bot vs seat1=balanced 参照）：胜率/反应计数/
 *      平均回合数/法术使用率（本地 sim 全速驱动，四指标对照表）
 *   B2 反应计数梯度：竞技 ≥ 均衡 ≥ 休闲（reactW/reactPot 反应预判实证）
 *      + 胜率阶梯（竞技 > 休闲）
 *   B3 放水局 ≥1 例：env.foeLose≥2 → 降一档（同 seed A/B op 流分化）；
 *      燃脸脚本真人 vs 竞技 bot：放水后胜场提升且 ≥1 胜
 *   B4 网关 pulse + game.json 配置：真人连败 2 局 → bot 收 foeLose≥2 且
 *      env.mercy.minFoeLose=2（game.json bot.mercy 注入链）；真人胜 → 台账清零
 *   B5 离线确定性三联：双跑 op 流+终态 hash 逐字节相等 ×3 seed；
 *      回放器重放 opsLog == 在线终态 hash
 * 用法：node scripts/element-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DUEL = require(join(ROOT, 'games/multiplayer/element-duel/sim.cjs'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(1)

/* ---------- 本地全速驱动一局（bot vs bot / 脚本真人；envs 按席位注入陪玩信号） ----------
 * env.foeLose 与网关同构：数组按席位索引，foeLose[seat]=该席 bot 对席真人的连败局数。
 * opStream：逐决策记账（含脚本真人），确定性对照用 */
function driveGame(seed, lvls, envs, humans) {
  const st = DUEL.create(seed)
  const tally = [0, 1].map(() => ({ plays: 0, spells: 0 }))
  const opStream = []
  let guard = 0
  while (!st.over && guard++ < 60000) {
    const inp = {}
    for (let s = 0; s < 2; s++) {
      let d
      if (humans && humans[s]) {
        const op = humans[s](st, s)
        d = op ? { op } : {}
      } else {
        d = DUEL.brain(st, s, lvls[s], null, envs ? envs[s] : undefined) || {}
      }
      if (d.op) {
        if (d.op.k === 'play') {
          tally[s].plays++
          if (DUEL.SPELLS[st.hands[s][d.op.card]]) tally[s].spells++
        }
        opStream.push(`${s}:${JSON.stringify(d.op)}`)
        inp[s] = d
      }
    }
    DUEL.step(st, inp)
  }
  return { st, tally, opStream }
}

/* 燃脸速攻脚本真人（api-check burn-face 同型，canonical 直驱；无 rng——确定性对照前提） */
const card = (id) => DUEL.MINIONS[id] || DUEL.SPELLS[id]
function burnFace(st, seat) {
  if (st.over) return null
  if (st.phase === 'pick') return st.heroes[seat].hero < 0 ? { k: 'pick', hero: 0 } : null
  if (st.phase === 'mulligan') return st.mullDone[seat] ? null : { k: 'mulligan', keep: st.hands[seat].map((id) => card(id).cost <= 2) }
  if (st.phase !== 'play' || st.turnSeat !== seat) return null
  const e = seat === 0 ? 1 : 0
  const hand = st.hands[seat], me = st.heroes[seat]
  for (let i = 0; i < hand.length; i++) if (hand[i] === 'FS1' && me.manaCur >= 3) return { k: 'play', card: i, tgt: { s: e, c: -1 } }
  let ownN = 0
  for (let c = 0; c < 9; c++) if (st.board[c] && st.board[c].seat === seat) ownN++
  for (let i = 0; i < hand.length; i++) {
    const d = DUEL.MINIONS[hand[i]]
    if (!d || me.manaCur < d.cost || ownN >= 4) continue
    let cell = -1
    for (let c = 0; c < 9 && cell < 0; c++) { // ① 邻接己方异系（反应伙伴）② 近敌行 ③ 任意空格
      if (st.board[c]) continue
      for (const a of DUEL.adjCells(c)) { const nb = st.board[a]; if (nb && nb.seat === seat && nb.school !== d.school) { cell = c; break } }
    }
    if (cell < 0) for (let c = 0; c < 9; c++) if (!st.board[c] && ((c / 3) | 0) === DUEL.nearEnemyRow(seat)) { cell = c; break }
    if (cell < 0) for (let c = 0; c < 9; c++) if (!st.board[c]) { cell = c; break }
    if (cell >= 0) return { k: 'play', card: i, cell }
  }
  if (!me.powerUsed && me.manaCur >= 2 && me.hero === 0) return { k: 'heroPower', tgt: { s: e, c: -1 } }
  for (let f = 0; f < 9; f++) {
    const ts = DUEL.legalAttackTargets(st, seat, f)
    if (!ts.length) continue
    return { k: 'attack', from: f, tgt: { s: e, c: ts.includes(-1) ? -1 : ts[0] } }
  }
  return { k: 'endTurn' }
}

/* ---------- B1/B2 三档四指标对照（seat0=档位 vs seat1=balanced 参照，5 seed/档） ---------- */
console.log('── B1/B2 三档四指标对照（vs balanced 参照席，seed 101-105）──')
const TIERS = ['casual', 'balanced', 'competitive']
const SEEDS = [101, 102, 103, 104, 105]
const table = {}
for (const tier of TIERS) {
  const rows = []
  for (const seed of SEEDS) {
    const { st, tally } = driveGame(seed, [tier, 'balanced'])
    ok(`B1-${tier}-${seed}`, '对局收敛终态', !!(st.over && st.result && st.result.winner), `winner=${st.result && st.result.winner} reason=${st.result && st.result.reason}`)
    rows.push({
      win: st.result.winner === 'A' ? 1 : 0,
      reactions: st.stats[0].reactions,
      turns: Math.ceil((st.turnNo + 1) / 2),
      spellRate: tally[0].plays ? tally[0].spells / tally[0].plays : 0,
    })
  }
  table[tier] = rows
  console.log(`  ${tier.padEnd(12)} 胜率 ${rows.reduce((a, r) => a + r.win, 0)}/${rows.length}｜反应 ${rows.map((r) => r.reactions).join(',')}（均 ${f1(avg(rows.map((r) => r.reactions)))}）｜回合 ${rows.map((r) => r.turns).join(',')}（均 ${f1(avg(rows.map((r) => r.turns)))}）｜法术率 ${rows.map((r) => f1(r.spellRate * 100)).join('%,')}%（均 ${f1(avg(rows.map((r) => r.spellRate)) * 100)}%）`)
}
const rc = TIERS.map((t) => avg(table[t].map((r) => r.reactions)))
ok('B2-1', '反应计数梯度：竞技 ≥ 均衡 ≥ 休闲（且竞技>休闲）', rc[2] >= rc[1] && rc[1] >= rc[0] && rc[2] > rc[0], `竞技 ${f1(rc[2])} ≥ 均衡 ${f1(rc[1])} ≥ 休闲 ${f1(rc[0])}`)
const wins = TIERS.map((t) => table[t].reduce((a, r) => a + r.win, 0))
ok('B2-2', '胜率阶梯：竞技 > 休闲（对 balanced 参照）', wins[2] > wins[0], `竞技 ${wins[2]}/5 > 休闲 ${wins[0]}/5（均衡 ${wins[1]}/5）`)
const sc = TIERS.map((t) => avg(table[t].map((r) => r.spellRate)))
ok('B2-3', '法术使用率三档分化（非全同）', new Set(sc.map((x) => f1(x * 100))).size > 1, `竞技 ${f1(sc[2] * 100)}% / 均衡 ${f1(sc[1] * 100)}% / 休闲 ${f1(sc[0] * 100)}%`)

/* ---------- B3 放水局（env.foeLose≥2 → 降一档；同 seed A/B 对照 + 真人胜场） ---------- */
console.log('── B3 放水局（foeLose≥2 → 降一档出手）──')
{
  DUEL.botStats.mercy = 0
  const base = driveGame(501, ['competitive', 'balanced'])
  const m = DUEL.botStats.mercy
  const merc = driveGame(501, ['competitive', 'balanced'], [{ foeLose: [2, 0], mercy: { minFoeLose: 2 } }, { foeLose: [0, 0] }])
  ok('B3-1', '同 seed A/B：放水 op 流分化（V 权重劣化实证）', base.opStream.join('|') !== merc.opStream.join('|'), `决策数 ${base.opStream.length} vs ${merc.opStream.length}；botStats.mercy=${DUEL.botStats.mercy}`)
  ok('B3-2', '放水降档决策计数 >0（观测面）', DUEL.botStats.mercy > 0, `botStats.mercy=${DUEL.botStats.mercy}`)
}
{
  const baseWins = [], mercyWins = []
  for (const seed of [301, 302, 303, 304, 305, 306]) {
    const b = driveGame(seed, [null, 'competitive'], undefined, [burnFace, null])
    baseWins.push(b.st.result.winner === 'A' ? 1 : 0)
    DUEL.botStats.mercy = 0
    const m = driveGame(seed, [null, 'competitive'], [undefined, { foeLose: [0, 2], mercy: { minFoeLose: 2 } }], [burnFace, null])
    ok(`B3-mercy-${seed}`, '放水局收敛', !!(m.st.result && m.st.result.winner), `winner=${m.st.result.winner}（botStats.mercy=${DUEL.botStats.mercy}）`)
    mercyWins.push(m.st.result.winner === 'A' ? 1 : 0)
  }
  const bw = baseWins.reduce((a, b) => a + b, 0), mw = mercyWins.reduce((a, b) => a + b, 0)
  ok('B3-3', '放水局 ≥1 例真人胜（连败 2 局后 bot 降档）', mw >= 1, `放水 ${mw}/6 vs 常态 ${bw}/6`)
  ok('B3-4', '放水后真人胜场不低于常态（陪玩语义）', mw >= bw, `放水 ${mw}/6 ≥ 常态 ${bw}/6`)
}

/* ---------- B4 网关 pulse + game.json bot.mercy 注入链 ---------- */
console.log('── B4 网关 pulse 台账 / game.json 配置注入 ──')
{
  const { RoomManager } = await import(join(ROOT, 'server/gateway/rooms.js'))
  const { elementDuelSim } = await import(join(ROOT, 'server/gateway/sims/element-duel.js'))
  let lastEnv = null, innerEnv = null
  /* 双层取证：lastEnv=rooms 原始 botEnv（foeLose 信号面）；innerEnv=适配器合并
   * game.json bot.mercy 后送达 DUEL.brain 的 env（配置注入链终点的真值） */
  const origBrain = DUEL.brain
  DUEL.brain = (st, seat, lvl, rng, env) => { if (env && env.mercy) innerEnv = env; return origBrain(st, seat, lvl, rng, env) }
  const wrap = Object.assign({}, elementDuelSim, {
    brain: (st, seat, lvl, rng, env) => { lastEnv = env; return elementDuelSim.brain(st, seat, lvl, rng, env) },
  })
  const rooms = new RoomManager({ log: () => {} })
  rooms.register(wrap)
  const human = { conn: { writable: false, send() {} } } // 同一连接对象跨房（pulse 键）
  const mk = () => {
    const room = rooms.create({ gameId: 'element-duel', bots: [null, 'competitive'], startDelayMs: 0, maxTicks: 500 })
    const s0 = room.seats[0]
    s0.kind = 'human'; s0.conn = human
    return room
  }
  const play = (room, concedeSeat) => {
    let guard = 0
    room.liveAt = 0
    DUEL.applyOp(room.state, concedeSeat, { k: 'concede' })
    while (room.phase !== 'ended' && guard++ < 600) rooms.doFrame(room, 1759000000000 + guard)
    return room
  }
  const probe = (want) => {
    const r = mk(); let g = 0; r.liveAt = 0
    while (r.phase !== 'ended' && g++ < 400 && !(lastEnv && lastEnv.foeLose && want(lastEnv))) rooms.doFrame(r, 1759000000000 + g)
    return lastEnv
  }
  play(mk(), 0) // 局1：真人认负 → lose=1
  play(mk(), 0) // 局2：连败 → lose=2
  const env2 = probe((e) => e.foeLose[1] >= 2)
  ok('B4-1', '连败 2 局 → bot env.foeLose≥2（放水信号送达）', !!(env2 && env2.foeLose && env2.foeLose[1] >= 2), env2 ? `foeLose=[${env2.foeLose}]` : 'env 未见')
  ok('B4-2', 'game.json bot.mercy 注入链（适配器 → env.mercy.minFoeLose=2）', !!(innerEnv && innerEnv.mercy && innerEnv.mercy.minFoeLose === 2), innerEnv && innerEnv.mercy ? `minFoeLose=${innerEnv.mercy.minFoeLose}` : 'env.mercy 未见')
  play(mk(), 1) // 局4：bot 认负 → 真人胜 → lose 清零
  const env0 = probe((e) => e.foeLose[1] === 0)
  ok('B4-3', '真人胜 → 台账清零（连胜恢复）', !!(env0 && env0.foeLose && env0.foeLose[1] === 0), env0 ? `foeLose=[${env0.foeLose}]` : 'env 未见')
  DUEL.brain = origBrain
}

/* ---------- B5 离线确定性三联（双跑相等 ×3 seed + 回放器==终态） ---------- */
console.log('── B5 离线确定性三联 ──')
for (const seed of [7, 8, 9]) {
  const a = driveGame(seed, ['balanced', 'competitive'])
  const b = driveGame(seed, ['balanced', 'competitive'])
  const hashA = DUEL.hashState(a.st), hashB = DUEL.hashState(b.st)
  const replay = DUEL.replayOps(seed, a.st.opsLog, a.st.maxTicks)
  ok(`B5-${seed}a`, '双跑 op 流逐字节相等', a.opStream.join('|') === b.opStream.join('|'), `${a.opStream.length} 决策`)
  ok(`B5-${seed}b`, '双跑终态 hash 相等', hashA === hashB, `#${hashA}`)
  ok(`B5-${seed}c`, '回放器重放 opsLog == 终态 hash', DUEL.hashState(replay) === hashA, `#${hashA}`)
}

console.log(`\nELEMENT-BOT2 OK：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
