/* =====================================================================
 * 元素对决 确定性回合引擎（GAMES-88 · S5 回合权威本格首证）
 * 单一事实源：服务端适配器（server/gateway/sims/element-duel.js）require 本文件；
 * 客户端离线对打/门禁契约（GAMES-90 F3）以 classic script 载入同一份代码——
 * 双环境出口见底部 UMD（Node=module.exports / 浏览器=root.EDuelSim）。
 *
 * 确定性纪律（设计 §5.5/§5.6 红线）：
 *   - 判定路径零 Math.random/Date.now；随机仅存在于洗牌流（deckSeed 派生）与
 *     Bot 决策流（seed^turnNo^decisionIdx 派生——tick 抖动免疫，双跑前提）；
 *   - 结算序固定（§1.2）：校验扣费→入格/施放→入场效果→反应（邻接上右下左）→
 *     伤害/死亡→英雄 HP≤0 终局；
 *   - hashState 键字母序、数组固定序；tick/deadline/opsLog 不入 hash。
 * ===================================================================== */
'use strict'
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api // Node（.cjs：网关/api-check require）
  root.EDuelSim = api                                                     // 浏览器 classic script（F3 离线对打）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

/* ---------- 常量：卡池 24 + 微粒（§2.2，可直接执行事实源） ---------- */
const MINIONS = {
  F1: { name: '火花精灵', school: 'F', cost: 1, atk: 2, hp: 1, melee: 1 },
  F2: { name: '焰刃武士', school: 'F', cost: 2, atk: 3, hp: 2, melee: 1 },
  F3: { name: '熔岩巨兽', school: 'F', cost: 5, atk: 4, hp: 6, melee: 1, taunt: 1 },
  F4: { name: '烬灭龙', school: 'F', cost: 6, atk: 6, hp: 4, ranged: 1, cry: 'face2' },
  W1: { name: '露珠水灵', school: 'W', cost: 1, atk: 1, hp: 3, melee: 1, taunt: 1 },
  W2: { name: '涌泉守卫', school: 'W', cost: 3, atk: 2, hp: 5, melee: 1, taunt: 1 },
  W3: { name: '深渊触手', school: 'W', cost: 4, atk: 3, hp: 4, ranged: 1, cry: 'freezeTgt' },
  W4: { name: '潮汐巨人', school: 'W', cost: 6, atk: 5, hp: 7, melee: 1, cry: 'heal4' },
  N1: { name: '微风精灵', school: 'N', cost: 1, atk: 1, hp: 2, ranged: 1 },
  N2: { name: '疾风刺客', school: 'N', cost: 2, atk: 3, hp: 2, melee: 1 },
  N3: { name: '云端歌者', school: 'N', cost: 3, atk: 2, hp: 3, ranged: 1, cry: 'draw1' },
  N4: { name: '风暴领主', school: 'N', cost: 5, atk: 4, hp: 5, ranged: 1, cry: 'buffOthersAtk1' },
  T1: { name: '静电飞鸟', school: 'T', cost: 1, atk: 1, hp: 1, ranged: 1, cry: 'face1' },
  T2: { name: '雷纹武者', school: 'T', cost: 2, atk: 2, hp: 3, melee: 1, cry: 'spellBuff' },
  T3: { name: '磁暴炮手', school: 'T', cost: 4, atk: 3, hp: 4, ranged: 1, onAtk: 'splashAdjLow' },
  T4: { name: '雷霆泰君', school: 'T', cost: 6, atk: 4, hp: 5, ranged: 1, cry: 'aoeEnemy2' },
}
const SPELLS = {
  FS1: { name: '火球术', school: 'F', cost: 3, tgt: 'anySingle' },
  FS2: { name: '烈焰行刑', school: 'F', cost: 4, tgt: 'row' },
  WS1: { name: '治愈之潮', school: 'W', cost: 1, tgt: 'ownHeal' },
  WS2: { name: '凛冬封印', school: 'W', cost: 2, tgt: 'enemyMinion' },
  NS1: { name: '顺风祈愿', school: 'N', cost: 3, tgt: 'none' },
  NS2: { name: '迷踪步', school: 'N', cost: 1, tgt: 'ownMove' },
  TS1: { name: '连锁闪电', school: 'T', cost: 2, tgt: 'enemyMinion' },
  TS2: { name: '天罚雷暴', school: 'T', cost: 5, tgt: 'none' },
  X0: { name: '元素微粒', school: 'N', cost: 0, tgt: 'none', extra: 1 },
}
const HEROES = [
  { id: 0, name: '炎阳', school: 'F', power: 'face2' },     // 火弹：任意单体 2
  { id: 1, name: '潮汐', school: 'W', power: 'heal3buff' }, // 涌泉：回 3 或 +0/+2
  { id: 2, name: '疾风', school: 'N', power: 'draw1' },     // 疾影：抽 1
  { id: 3, name: '雷鸣', school: 'T', power: 'arc' },       // 电弧：单体+邻接各 1
]
/* 牌组配方（§2.4：本系 6 卡 ×2 + 外系工具 8，四套预构筑） */
const DECKS = [
  { hero: 0, name: '炎阳烬火', cards: ['F1','F1','F2','F2','F3','F3','F4','F4','FS1','FS1','FS2','FS2','W1','W1','W2','T1','T1','TS1','TS1','NS2'] },
  { hero: 1, name: '潮汐深涌', cards: ['W1','W1','W2','W2','W3','W3','W4','W4','WS1','WS1','WS2','WS2','N3','N3','NS1','FS1','FS1','F2','N1','N1'] },
  { hero: 2, name: '疾风掠地', cards: ['N1','N1','N2','N2','N3','N3','N4','N4','NS1','NS1','NS2','NS2','T1','T1','TS1','TS1','W1','W1','FS1','FS1'] },
  { hero: 3, name: '雷鸣苍穹', cards: ['T1','T1','T2','T2','T3','T3','T4','T4','TS1','TS1','TS2','TS2','N1','N1','N3','N3','NS1','WS2','WS2','W1'] },
]
/* 元素反应表（§1.4：6 对全覆盖；键=系对字典序——triggerReactions 查表侧 [a,b].sort() 拼接，
 * 表键必须同为排序序。GAMES-90 F1：原 'W+N'/'W+T' 未排序致查询永 miss（迷雾/感电死代码），已改 'N+W'/'T+W'） */
const REACTIONS = {
  'F+W': { rt: 'steam', apply: (st, ev, seat) => aoeMinions(st, ev, foe(seat), 1) }, // 蒸气：全部敌方随从 1
  'N+T': { rt: 'chain', apply: (st, ev, seat) => { // 连锁：hp 最高敌随从（平局 cell 小）2 + 其邻接敌随从 1
    const t = pickEnemy(st, seat, (m) => m.hp, 'max')
    if (t >= 0) { hitMinion(st, ev, t, 2); for (const c of adjCells(t)) { const m = st.board[c]; if (m && m.seat !== seat) hitMinion(st, ev, c, 1) } } } },
  'F+T': { rt: 'blast', apply: (st, ev, seat, a, b) => { // 引爆：两枚反应随从所在行全部随从（双方）各 2
    const rows = new Set([(a / 3) | 0, (b / 3) | 0])
    for (let c = 0; c < 9; c++) if (st.board[c] && rows.has((c / 3) | 0)) hitMinion(st, ev, c, 2) } },
  'N+W': { rt: 'mist', apply: (st, ev, seat) => { // 迷雾：己方全体 +0/+2（含刚部署者）
    for (let c = 0; c < 9; c++) { const m = st.board[c]; if (m && m.seat === seat) { m.hp += 2; m.mhp += 2 } } } },
  'F+N': { rt: 'wildfire', apply: (st, ev, seat) => hitHero(st, ev, foe(seat), 2) }, // 燎原：敌方英雄 2
  'T+W': { rt: 'surge', apply: (st, ev) => { for (let c = 0; c < 9; c++) if (st.board[c]) hitMinion(st, ev, c, 1) } }, // 感电：全体 1
}
/* 排序键表自证（QA 取证法固化：凡「排序键查表」常量表逐键断言 k===sorted(k)） */
for (const _rk of Object.keys(REACTIONS)) {
  if (_rk !== _rk.split('+').sort().join('+')) throw new Error('REACTIONS key not sorted: ' + _rk)
}
const RT_NAME = { steam: '蒸气', chain: '连锁', blast: '引爆', mist: '迷雾', wildfire: '燎原', surge: '感电' }
const SCHOOL_COLOR = { F: '#E85D3D', W: '#3DA8E8', N: '#7CE8B8', T: '#E8C93D' }
const SCHOOL_GLYPH = { F: '▲', W: '●', N: '➤', T: '⚡' }

const META = {
  gameId: 'element-duel', title: '元素对决', mode: '1v1-duel', seats: 2,
  tickMs: 10, persistent: false, takeOver: 'hosted', roomPrefix: 'element',
  pickTicks: 1000, mullTicks: 3000, turnTicks: 3000, maxHand: 8, maxBoardPerSeat: 4,
}
const LEVELS = ['casual', 'balanced', 'competitive', 'hosted']
/* Bot 拟人延时（tick=10ms，§4.4 决策时机：0.8-3s；门控=相位内相对 tick——抖动免疫） */
const BOT_DELAY = { casual: [80, 180], balanced: [150, 250], competitive: [200, 300], hosted: [120, 220] }

/* ---------- 确定性 RNG（fnv1a32 + mulberry32，目录通用纪律） ---------- */
function fnv1a32(str) {
  let h = 0x811c9dc5
  const s = typeof str === 'string' ? str : JSON.stringify(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
    h ^= h >>> 13; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 16 // 雪崩
  }
  return h >>> 0
}
function mulberry32(a) {
  let t = a >>> 0
  return function () {
    t = (t + 0x6D2B79F5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1) >>> 0
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61) >>> 0
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
const shuffle = (arr, rng) => { for (let i = arr.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = arr[i]; arr[i] = arr[j]; arr[j] = t } return arr }
const foe = (s) => (s === 0 ? 1 : 0)

/* ---------- 棋盘几何（§1.3：行 0=近 B 英雄侧 / 行 2=近 A 英雄侧，行号绝对） ---------- */
const nearEnemyRow = (seat) => (seat === 0 ? 0 : 2)
function adjCells(c) { // 固定扫描序：上→右→下→左
  const out = [], row = (c / 3) | 0, col = c % 3
  if (row > 0) out.push(c - 3)
  if (col < 2) out.push(c + 1)
  if (row < 2) out.push(c + 3)
  if (col > 0) out.push(c - 1)
  return out
}

/* ---------- 建局 ---------- */
function create(seed, opts = {}) {
  const st = {
    v: 1, seed: seed >>> 0, maxTicks: Number.isInteger(opts.maxTicks) ? opts.maxTicks : 48000,
    tick: 0, phase: 'pick', over: false, result: null,
    turnSeat: 0, turnNo: -1,
    heroes: [0, 1].map(() => ({ hero: -1, hp: 24, manaMax: 0, manaCur: 0, turns: 0, powerUsed: false })),
    hands: [[], []], decks: [[], []], graves: [[], []], // 牌组随英雄定型（pick 后洗），welcome 不泄露牌序
    fatigue: [0, 0], board: new Array(9).fill(null),
    mullDone: [false, false], hostOn: [false, false],
    spellsThisTurn: 0, turnOps: [0, 0], afkStreak: [0, 0],
    phaseStartTick: 0, deadline: META.pickTicks,
    stats: [0, 1].map(() => ({ reactions: 0, heals: 0, burns: 0, tauntKills: 0, killTurn: 0 })),
    opsLog: [], outbox: [], _mullKeep: [null, null], _deckRng: [null, null], _botLevel: null,
  }
  return st
}
/* 英雄定型 → 洗牌流（§5.5：deckSeed=mulberry32(roomSeed ^ (seat+1)·0x9E3779B9)，单一消费） */
function buildDecks(st) {
  for (let s = 0; s < 2; s++) {
    const rng = mulberry32((st.seed ^ Math.imul(s + 1, 0x9E3779B9)) >>> 0)
    st.decks[s] = shuffle([...DECKS[st.heroes[s].hero].cards], rng)
    st._deckRng[s] = rng // 换牌重抽续用同流（§5.5）
  }
}

/* ---------- 事件/伤害结算公共件 ---------- */
function emitRuling(st, events) { st.outbox.push(events) }
function logOp(st, seat, k, extra) { st.opsLog.push(Object.assign({ s: seat, k, tn: st.turnNo }, extra || {})) }
function hitHero(st, ev, seat, n) { st.heroes[seat].hp -= n; ev.push({ k: 'damage', tgt: { s: seat, c: -1 }, n }) }
function hitMinion(st, ev, c, n) { const m = st.board[c]; if (!m) return; m.hp -= n; ev.push({ k: 'damage', tgt: { s: m.seat, c }, n }) }
function aoeMinions(st, ev, seat, n) { for (let c = 0; c < 9; c++) if (st.board[c] && st.board[c].seat === seat) hitMinion(st, ev, c, n) }
function pickEnemy(st, seat, scoreFn, dir) { // 自动目标显式规则（§5.5）：hp 最高、平局 cell 小
  let best = -1, bv = null
  for (let c = 0; c < 9; c++) {
    const m = st.board[c]
    if (!m || m.seat === seat) continue
    const v = scoreFn(m)
    if (bv === null || (dir === 'max' ? v > bv : v < bv)) { bv = v; best = c }
  }
  return best
}
function sweepDeaths(st, ev, bySeat) { // 死亡结算（§1.2 ⑤）；tauntKills 记到攻击方 stats
  for (let c = 0; c < 9; c++) {
    const m = st.board[c]
    if (!m || m.hp > 0) continue
    ev.push({ k: 'death', tgt: { s: m.seat, c }, card: m.c })
    st.graves[m.seat].push(m.c)
    if (m.taunt && bySeat !== undefined) st.stats[bySeat].tauntKills++
    st.board[c] = null
  }
}
function checkLethal(st, ev) { // 终局检查（§1.2 ⑥）
  if (st.over) return true
  const a = st.heroes[0].hp, b = st.heroes[1].hp
  if (a <= 0 || b <= 0) {
    endGame(st, a <= 0 && b <= 0 ? 'draw' : a <= 0 ? 'B' : 'A', 'lethal')
    return true
  }
  return false
}
function endGame(st, winner, reason) {
  if (st.over) return
  st.over = true
  st.phase = 'over'
  if (reason === 'lethal' && (winner === 'A' || winner === 'B')) st.stats[winner === 'A' ? 0 : 1].killTurn = st.turnNo // quip 判据：斩杀回合（§4.6）
  const scores = {}
  for (let s = 0; s < 2; s++) scores[s === 0 ? 'A' : 'B'] = { hp: Math.max(0, st.heroes[s].hp), reactions: st.stats[s].reactions, fatigue: st.fatigue[s] }
  st.result = { winner, reason, scores, quip: quip(st, winner), reveal: { hands: st.hands } }
  emitRuling(st, [{ k: 'end', winner, reason }])
}
function drawCards(st, ev, seat, n) {
  for (let i = 0; i < n; i++) {
    if (st.decks[seat].length === 0) { // 疲劳（§1.5）：空库抽牌→计数+1 扣等量英雄血
      st.fatigue[seat]++
      ev.push({ k: 'fatigue', s: seat, n: st.fatigue[seat] })
      hitHero(st, ev, seat, st.fatigue[seat])
      continue
    }
    const card = st.decks[seat].shift()
    if (st.hands[seat].length >= META.maxHand) { // 满手烧牌（事件公示）
      st.graves[seat].push(card)
      st.stats[seat].burns++
      ev.push({ k: 'burn', s: seat, card })
      continue
    }
    st.hands[seat].push(card)
    ev.push({ k: 'draw', s: seat })
  }
  checkLethal(st, ev)
}
function healHero(st, ev, seat, n) {
  const before = st.heroes[seat].hp
  st.heroes[seat].hp = Math.min(24, before + n)
  const got = st.heroes[seat].hp - before
  if (got > 0) { ev.push({ k: 'heal', tgt: { s: seat, c: -1 }, n: got }); st.stats[seat].heals += got }
}

/* ---------- 回合机（§1.2） ---------- */
function startTurn(st, seat) {
  st.turnSeat = seat
  st.turnNo++
  st.phase = 'play'
  st.phaseStartTick = st.tick
  st.deadline = st.tick + META.turnTicks
  st.turnOps = [0, 0]
  st.spellsThisTurn = 0
  const h = st.heroes[seat]
  h.turns++
  h.manaMax = Math.min(8, h.turns)
  h.manaCur = h.manaMax
  h.powerUsed = false
  for (let c = 0; c < 9; c++) { const m = st.board[c]; if (m && m.seat === seat) { m.ready = true; m.newly = false } }
  const ev = [{ k: 'turn', s: seat, turn: st.turnNo }]
  if (h.hero === 1) healHero(st, ev, seat, 1) // 潮汐被动：回合开始回 1
  drawCards(st, ev, seat, 1)
  emitRuling(st, ev)
  checkLethal(st, ev)
}
function endTurn(st, seat, auto) {
  const ev = [{ k: 'endTurn', s: seat, auto: !!auto }]
  for (let c = 0; c < 9; c++) { const m = st.board[c]; if (m && m.seat === seat && m.frozen > 0) m.frozen-- } // 冻结在拥有者回合结束 -1（§2.5）
  emitRuling(st, ev)
  if (!st.over) startTurn(st, foe(seat))
}
function timeoutTurn(st) { // 超时托管：casual 代打完整回合（§1.2/§4.5）；$timeout 入日志——回放同源
  const seat = st.turnSeat
  const ownOps = st.turnOps[seat]
  logOp(st, seat, '$timeout', {})
  if (ownOps === 0) { // 全超时回合（零 op）→ afk 计数（§1.7；防白嫖；代打 op 不入计数）
    st.afkStreak[seat]++
    if (st.afkStreak[seat] >= 3) { endGame(st, seat === 0 ? 'B' : 'A', 'afk'); return }
  } else st.afkStreak[seat] = 0
  emitRuling(st, [{ k: 'timeout-turn', s: seat }])
  let guard = 24
  while (!st.over && guard-- > 0) {
    const op = casualNext(st, seat)
    if (!op) break
    applyOp(st, seat, op, true)
    if (st.over || st.turnSeat !== seat) return // 代打 endTurn 已把回合交还对方
  }
  if (!st.over && st.turnSeat === seat) { logOp(st, seat, 'endTurn', { auto: 1 }); endTurn(st, seat, true) } // auto=1：回放区分（不清 afk 计数）
}

/* ---------- 部署反应（§1.4：邻接固定序上→右→下→左，逐对一次） ---------- */
function triggerReactions(st, ev, seat, cell) {
  const m = st.board[cell]
  if (!m) return
  for (const c of adjCells(cell)) {
    const nb = st.board[c]
    if (!nb || nb.seat !== seat || nb.school === m.school) continue
    const key = [m.school, nb.school].sort().join('+')
    const r = REACTIONS[key]
    if (!r) continue
    ev.push({ k: 'reaction', rt: r.rt, pair: key, at: cell, with: c, s: seat })
    st.stats[seat].reactions++
    r.apply(st, ev, seat, cell, c)
    sweepDeaths(st, ev, seat)
    if (checkLethal(st, ev)) return
  }
}

/* ---------- 入场效果/法术/技能结算 ---------- */
function battlecry(st, ev, seat, def, cell, tgt) {
  switch (def.cry) {
    case 'face2': hitHero(st, ev, foe(seat), 2); break
    case 'face1': hitHero(st, ev, foe(seat), 1); break
    case 'heal4': healHero(st, ev, seat, 4); break
    case 'draw1': drawCards(st, ev, seat, 1); break
    case 'buffOthersAtk1': for (let c = 0; c < 9; c++) { const m = st.board[c]; if (m && m.seat === seat && c !== cell) m.atk++ } break
    case 'spellBuff': if (st.spellsThisTurn > 0) { const m = st.board[cell]; m.atk++; m.hp++; m.mhp++ } break
    case 'aoeEnemy2': aoeMinions(st, ev, foe(seat), 2); break
    case 'freezeTgt': { const c = tgt && Number(tgt.c); if (Number.isInteger(c) && st.board[c] && st.board[c].seat !== seat) { st.board[c].frozen = 1; ev.push({ k: 'frozen', tgt: { s: foe(seat), c } }) } break }
  }
}
function castSpell(st, ev, seat, id, tgt) {
  st.spellsThisTurn++
  ev.push({ k: 'spell', s: seat, card: id })
  switch (id) {
    case 'FS1': if (tgt.c === -1) hitHero(st, ev, tgt.s, 4); else hitMinion(st, ev, tgt.c, 4); break
    case 'FS2': for (let c = 0; c < 9; c++) if (st.board[c] && ((c / 3) | 0) === tgt.row) hitMinion(st, ev, c, 3); break
    case 'WS1':
      if (tgt.c === -1) healHero(st, ev, seat, 4)
      else { const m = st.board[tgt.c]; if (m) { m.hp += 2; m.mhp += 2; ev.push({ k: 'heal', tgt: { s: seat, c: tgt.c }, n: 2 }) } }
      break
    case 'WS2': { const m = Number.isInteger(tgt.c) ? st.board[tgt.c] : null; if (m) { m.frozen = 1; hitMinion(st, ev, tgt.c, 1); ev.push({ k: 'frozen', tgt: { s: m.seat, c: tgt.c } }) } break }
    case 'NS1': drawCards(st, ev, seat, 2); break
    case 'NS2': { const m = Number.isInteger(tgt.from) ? st.board[tgt.from] : null; if (m && st.board[tgt.to] == null) { st.board[tgt.to] = m; st.board[tgt.from] = null; ev.push({ k: 'move', from: tgt.from, to: tgt.to }) } break } // 传送不触发反应（§1.4）
    case 'TS1': { const m = Number.isInteger(tgt.c) ? st.board[tgt.c] : null; if (m) { hitMinion(st, ev, tgt.c, 2); for (const c of adjCells(tgt.c)) { const x = st.board[c]; if (x && x.seat !== seat) hitMinion(st, ev, c, 1) } } break }
    case 'TS2': aoeMinions(st, ev, foe(seat), 3); break
    case 'X0': st.heroes[seat].manaCur++; break // 元素微粒：本回合 +1 费（§1.5）
  }
  if (st.heroes[seat].hero === 3) hitHero(st, ev, foe(seat), 1) // 雷鸣被动：每法术磨 1
  sweepDeaths(st, ev, seat)
  checkLethal(st, ev)
}
function heroPower(st, ev, seat, tgt) {
  const h = st.heroes[seat]
  ev.push({ k: 'heroPower', s: seat, hero: h.hero })
  switch (h.hero) {
    case 0: if (tgt.c === -1) hitHero(st, ev, tgt.s, 2); else hitMinion(st, ev, tgt.c, 2); break
    case 1:
      if (tgt.c === -1) healHero(st, ev, seat, 3)
      else { const m = st.board[tgt.c]; if (m) { m.hp += 2; m.mhp += 2; ev.push({ k: 'heal', tgt: { s: seat, c: tgt.c }, n: 2 }) } }
      break
    case 2: drawCards(st, ev, seat, 1); break
    case 3: { const c = Number(tgt.c); if (Number.isInteger(c) && c >= 0 && st.board[c]) { hitMinion(st, ev, c, 1); for (const x of adjCells(c)) if (st.board[x]) hitMinion(st, ev, x, 1) } break }
  }
  h.powerUsed = true
  sweepDeaths(st, ev, seat)
  checkLethal(st, ev)
}

/* ---------- 攻击合法性/结算 ---------- */
function hasTaunt(st, seat) { for (let c = 0; c < 9; c++) { const m = st.board[c]; if (m && m.seat === seat && m.taunt) return true } return false }
function legalAttackTargets(st, seat, from) {
  const m = st.board[from]
  if (!m || m.seat !== seat || !m.ready || m.frozen > 0) return []
  const e = foe(seat), out = [], taunt = hasTaunt(st, e), adjSet = new Set(adjCells(from))
  for (let c = 0; c < 9; c++) {
    const t = st.board[c]
    if (!t || t.seat !== e) continue
    if (taunt && !t.taunt) continue        // 嘲讽强制（近战仍受邻接限制）
    if (m.melee && !adjSet.has(c)) continue
    out.push(c)
  }
  if (!taunt && !m.newly && (m.ranged || ((from / 3) | 0) === nearEnemyRow(seat))) out.push(-1) // 打脸：远程任意位/近战须近敌行；部署当回合不可（rush 限随从）
  return out
}
function resolveAttack(st, seat, from, tgt) {
  const m = st.board[from]
  const ev = [{ k: 'attack', s: seat, from, tgt }]
  let atk = m.atk
  if (st.heroes[seat].hero === 0 && m.school === 'F') atk++ // 炎阳被动：火系攻击 +1（结算时计）
  if (tgt.c === -1) hitHero(st, ev, foe(seat), atk)
  else {
    const t = st.board[tgt.c]
    hitMinion(st, ev, tgt.c, atk)
    if (t && t.atk > 0) hitMinion(st, ev, from, t.atk) // 反击
    if (t && m.onAtk === 'splashAdjLow') { // 磁暴：目标邻接 hp 最低敌方随从（平局 cell 小）1 伤害
      let bc = -1, bv = null
      for (const c of adjCells(tgt.c)) { const x = st.board[c]; if (!x || x.seat === seat) continue; if (bv === null || x.hp < bv) { bv = x.hp; bc = c } }
      if (bc >= 0) hitMinion(st, ev, bc, 1)
    }
  }
  m.ready = false
  sweepDeaths(st, ev, seat)
  emitRuling(st, ev)
  checkLethal(st, ev)
}

/* ---------- op 权威校验+结算（WS op/测试注入/Bot 三源共用；§5.1） ---------- */
function applyOp(st, seat, op, fromBot) {
  if (st.over) return { reject: 'over' }
  const k = op && op.k
  if (k === 'host') { // 主动托管开关（§1.6/§5.4；任意 phase 合法）
    st.hostOn[seat] = !!op.on
    emitRuling(st, [{ k: 'host', s: seat, on: st.hostOn[seat] }])
    logOp(st, seat, 'host', { on: st.hostOn[seat] ? 1 : 0 })
    return { ok: true }
  }
  if (k === 'concede') { logOp(st, seat, 'concede', {}); endGame(st, seat === 0 ? 'B' : 'A', 'resign'); return { ok: true } } // GAMES-91：winner 须 'A'/'B'（原误传数字席位——pulse 台账认输局永不入账/客户端胜负文案失配）
  if (fromBot !== true && st.hostOn[seat]) { st.hostOn[seat] = false; emitRuling(st, [{ k: 'host', s: seat, on: false }]) } // 任意合法 op 即夺回（§5.1）
  if (k === 'pick') {
    if (st.phase !== 'pick') return { reject: 'not-pick' }
    if (st.heroes[seat].hero !== -1) return { reject: 'picked' }
    const hero = Number(op.hero)
    if (!Number.isInteger(hero) || hero < 0 || hero > 3) return { reject: 'bad-hero' }
    st.heroes[seat].hero = hero
    logOp(st, seat, 'pick', { hero })
    emitRuling(st, [{ k: 'pick', s: seat, hero }])
    maybeStartMulligan(st)
    return { ok: true }
  }
  if (k === 'mulligan') {
    if (st.phase !== 'mulligan') return { reject: 'not-mulligan' }
    if (st.mullDone[seat]) return { reject: 'mull-done' }
    const keep = Array.isArray(op.keep) ? op.keep : null
    if (!keep || keep.length !== st.hands[seat].length) return { reject: 'bad-keep' }
    st.hands[seat] = st.hands[seat].filter((_, i) => !!keep[i])
    st._mullKeep[seat] = keep.map((x) => !!x)
    st.mullDone[seat] = true
    logOp(st, seat, 'mulligan', { keep: keep.map((x) => (x ? 1 : 0)) })
    emitRuling(st, [{ k: 'mulligan', s: seat, keep: st._mullKeep[seat] }])
    maybeStartFirstTurn(st)
    return { ok: true }
  }
  if (st.phase !== 'play') return { reject: 'not-play' }
  if (st.turnSeat !== seat) return { reject: 'not-your-turn' }
  const h = st.heroes[seat]
  if (k === 'endTurn') { st.afkStreak[seat] = 0; logOp(st, seat, 'endTurn', {}); endTurn(st, seat, false); return { ok: true } } // 主动结束=在场，清 afk 计数
  if (k === 'play') {
    const idx = Number(op.card)
    if (!Number.isInteger(idx) || idx < 0 || idx >= st.hands[seat].length) return { reject: 'bad-card' }
    const id = st.hands[seat][idx], def = MINIONS[id] || SPELLS[id]
    if (!def) return { reject: 'bad-card' }
    if (h.manaCur < def.cost) return { reject: 'no-mana' }
    if (MINIONS[id]) {
      const cell = Number(op.cell)
      if (!Number.isInteger(cell) || cell < 0 || cell > 8 || st.board[cell]) return { reject: 'bad-cell' }
      let ownN = 0
      for (let c = 0; c < 9; c++) if (st.board[c] && st.board[c].seat === seat) ownN++
      if (ownN >= META.maxBoardPerSeat) return { reject: 'board-full' }
      if (def.cry === 'freezeTgt') { const c = op.tgt && Number(op.tgt.c); if (!Number.isInteger(c) || !st.board[c] || st.board[c].seat === seat) return { reject: 'bad-tgt' } }
      h.manaCur -= def.cost
      st.hands[seat].splice(idx, 1)
      st.board[cell] = { c: id, school: def.school, atk: def.atk, hp: def.hp, mhp: def.hp, seat, ready: !!(def.rush || (h.hero === 2 && def.school === 'N')), newly: true, frozen: 0, taunt: !!def.taunt, ranged: !!def.ranged, melee: !!def.melee }
      const ev = [{ k: 'play', s: seat, card: id, cell }]
      battlecry(st, ev, seat, def, cell, op.tgt)   // ③ 入场效果
      sweepDeaths(st, ev, seat)
      triggerReactions(st, ev, seat, cell)         // ④ 反应（内部含死亡/终局）
      st.turnOps[seat]++
      logOp(st, seat, 'play', { card: idx, cell, tgt: op.tgt || null })
      emitRuling(st, ev)
      return { ok: true }
    }
    if (!validSpellTgt(st, seat, id, op.tgt)) return { reject: 'bad-tgt' }
    h.manaCur -= def.cost
    st.hands[seat].splice(idx, 1)
    st.graves[seat].push(id)
    const ev = []
    castSpell(st, ev, seat, id, op.tgt)           // ②-⑤（内含死亡/终局）
    st.turnOps[seat]++
    logOp(st, seat, 'play', { card: idx, tgt: op.tgt || null })
    emitRuling(st, ev)
    return { ok: true }
  }
  if (k === 'attack') {
    const from = Number(op.from)
    const tc = Number(op.tgt && op.tgt.c)
    if (!Number.isInteger(from) || !legalAttackTargets(st, seat, from).includes(tc)) return { reject: 'bad-attack' }
    st.turnOps[seat]++
    logOp(st, seat, 'attack', { from, tgt: { s: foe(seat), c: tc } })
    resolveAttack(st, seat, from, { s: foe(seat), c: tc })
    return { ok: true }
  }
  if (k === 'heroPower') {
    if (h.powerUsed) return { reject: 'power-used' }
    if (h.manaCur < 2) return { reject: 'no-mana' }
    if (!validPowerTgt(st, seat, op.tgt)) return { reject: 'bad-tgt' }
    h.manaCur -= 2
    st.turnOps[seat]++
    logOp(st, seat, 'heroPower', { tgt: op.tgt || null })
    const ev = []
    heroPower(st, ev, seat, op.tgt)
    emitRuling(st, ev)
    return { ok: true }
  }
  return { reject: 'bad-op' }
}
function validSpellTgt(st, seat, id, tgt) {
  const t = tgt && typeof tgt === 'object' ? tgt : {}
  const c = Number(t.c), m = Number.isInteger(c) && c >= 0 ? st.board[c] : null
  switch (id) {
    case 'FS1': return c === -1 ? Number(t.s) === foe(seat) : !!m
    case 'FS2': return Number.isInteger(t.row) && t.row >= 0 && t.row <= 2
    case 'WS1': return c === -1 || !!((m && m.seat === seat))
    case 'WS2': case 'TS1': return !!(m && m.seat !== seat)
    case 'NS1': case 'TS2': case 'X0': return true
    case 'NS2': { // 迷踪步目标是 {from,to} 而非 {c}（GAMES-91：原误读 t.c → m 恒 null → 线上永 bad-tgt 死牌；castSpell 本用 from 无恙）
      const f = Number(t.from), fm = Number.isInteger(f) && f >= 0 ? st.board[f] : null
      return !!(fm && fm.seat === seat && Number.isInteger(t.to) && t.to >= 0 && t.to <= 8 && !st.board[t.to])
    }
  }
  return false
}
function validPowerTgt(st, seat, tgt) {
  const hero = st.heroes[seat].hero
  const t = tgt && typeof tgt === 'object' ? tgt : {}
  const c = Number(t.c), m = Number.isInteger(c) && c >= 0 ? st.board[c] : null
  if (hero === 0) return c === -1 ? Number(t.s) === foe(seat) : !!m
  if (hero === 1) return c === -1 || !!(m && m.seat === seat)
  if (hero === 2) return true
  if (hero === 3) return !!(m && c >= 0)
  return false
}

/* ---------- 相位推进 ---------- */
function maybeStartMulligan(st) {
  if (st.heroes[0].hero < 0 || st.heroes[1].hero < 0) return
  buildDecks(st)
  st.phase = 'mulligan'
  st.phaseStartTick = st.tick
  st.deadline = st.tick + META.mullTicks
  const ev = [{ k: 'phase', p: 'mulligan' }]
  drawCards(st, ev, 0, 3) // 先手 3 张
  drawCards(st, ev, 1, 4) // 后手 4 张
  st.hands[1].push('X0')  // 后手微粒（§1.5）
  emitRuling(st, ev)
}
function maybeStartFirstTurn(st) {
  if (!st.mullDone[0] || !st.mullDone[1]) return
  for (let s = 0; s < 2; s++) { // 洗回重抽（拒绝张已滤出；同流续消费——§5.5 换牌不破坏确定性）
    const keep = st._mullKeep[s] || []
    const want = keep.filter((x) => !x).length
    if (want > 0) { shuffle(st.decks[s], st._deckRng[s]); const ev = []; drawCards(st, ev, s, want); emitRuling(st, ev) }
  }
  startTurn(st, 0)
}
function step(st, inputs) {
  st.tick++
  if (st.over) return { over: true, result: st.result }
  if (st.tick >= st.maxTicks && st.phase !== 'over') { // 硬顶：HP 高者胜（§1.7）
    const a = st.heroes[0].hp, b = st.heroes[1].hp
    endGame(st, a === b ? 'draw' : a > b ? 'A' : 'B', 'timeout')
  }
  if (st.phase === 'pick' && st.tick >= st.phaseStartTick + META.pickTicks) { // 选英雄超时：seed 定（§1.1）
    const rng = mulberry32(st.seed ^ 0x51C4)
    for (let s = 0; s < 2; s++) if (st.heroes[s].hero < 0) applyOp(st, s, { k: 'pick', hero: (rng() * 4) | 0 }, true)
  }
  if (st.phase === 'mulligan' && st.tick >= st.deadline) { // 换牌超时：全保留
    for (let s = 0; s < 2; s++) if (!st.mullDone[s]) applyOp(st, s, { k: 'mulligan', keep: st.hands[s].map(() => true) }, true)
  }
  if (inputs) { // bot 席帧通道 op（与 WS op 同一 applyOp 权威入口）
    for (let s = 0; s < 2; s++) {
      const o = inputs[s] && inputs[s].op
      if (o && typeof o === 'object' && typeof o.k === 'string' && !st.over) applyOp(st, s, o, true)
    }
  }
  for (let s = 0; s < 2; s++) { // 主动托管（§4.5 牌风化 balanced 续打）
    if (!st.hostOn[s] || st.over) continue
    if (st.phase === 'play' && st.turnSeat !== s) continue
    const op = hostedNext(st, s)
    if (op) applyOp(st, s, op, true)
  }
  if (st.phase === 'play' && !st.over && st.tick >= st.deadline) timeoutTurn(st)
  return st.over ? { over: true, result: st.result } : {}
}

/* ---------- Bot（§4：整数 V + scratch 模拟贪心；决策流 keyed 免 tick 抖动） ---------- */
function botRng(st, seat, idx) { // §4 头部公式：seed ^ 0xC0DE ^ (seat+1)*0x9E37 ^ turnNo<<8 ^ idx
  return mulberry32((st.seed ^ 0xC0DE ^ Math.imul(seat + 1, 0x9E37) ^ (st.turnNo << 8) ^ idx) >>> 0)
}
function decIdx(st, seat) { let n = 0; for (const o of st.opsLog) if (o.s === seat && o.tn === st.turnNo) n++; return n }
function gated(st, seat, level) { // 拟人延时门（相位内相对 tick）
  const rng = botRng(st, seat, decIdx(st, seat))
  const [lo, hi] = BOT_DELAY[level] || BOT_DELAY.balanced
  return (st.tick - st.phaseStartTick) < lo + ((rng() * (hi - lo)) | 0)
}
function cloneState(st) { // scratch 副本（合法同 pool §4.3 先例）：不含日志/广播/流
  return {
    v: st.v, seed: st.seed, maxTicks: st.maxTicks, tick: st.tick, phase: st.phase, over: st.over, result: st.result,
    turnSeat: st.turnSeat, turnNo: st.turnNo,
    heroes: st.heroes.map((h) => ({ ...h })),
    hands: st.hands.map((x) => [...x]), decks: st.decks.map((x) => [...x]), graves: st.graves.map((x) => [...x]),
    fatigue: [...st.fatigue], board: st.board.map((m) => (m ? { ...m } : null)),
    mullDone: [...st.mullDone], hostOn: [false, false],
    spellsThisTurn: st.spellsThisTurn, turnOps: [...st.turnOps], afkStreak: [...st.afkStreak],
    phaseStartTick: st.phaseStartTick, deadline: st.deadline,
    stats: st.stats.map((x) => ({ ...x })), opsLog: [], outbox: [],
    _deckRng: [() => 0.5, () => 0.5], _mullKeep: [null, null], _botLevel: st._botLevel,
  }
}
/* 局面价值 V（§4.1 整数权重） */
function posBonus(m, seat, cell) {
  let p = (cell === 0 || cell === 2 || cell === 6 || cell === 8) ? 2 : 0
  if (m.melee && ((cell / 3) | 0) === nearEnemyRow(seat)) p += 3
  if (!m.melee && ((cell / 3) | 0) >= 1) p += 1
  if (m.taunt) p += 2
  return p
}
/* 反应位潜力（GAMES-91 §4 深化：竞技反应预判）——己方每随从的每个邻接空格，
 * 若手牌存在异系随从（后续回合可部署成对触发反应），计 1 个待触发位。
 * 入 V 后产生双动机：贴异系邻居部署（即刻触发）/ 部署时留出邻接空格（摆位） */
function reactPotential(st, seat) {
  const schools = new Set()
  for (const id of st.hands[seat]) { const d = MINIONS[id]; if (d) schools.add(d.school) }
  if (!schools.size) return 0
  let n = 0
  for (let c = 0; c < 9; c++) {
    const m = st.board[c]
    if (!m || m.seat !== seat) continue
    for (const a of adjCells(c)) {
      if (st.board[a]) continue
      for (const s of schools) if (s !== m.school) { n++; break }
    }
  }
  return n
}
function evaluate(st, seat, opts = {}) {
  if (st.over) return st.result.winner === 'draw' ? 0 : (st.result.winner === (seat === 0 ? 'A' : 'B') ? 100000 : -100000)
  const e = foe(seat)
  let v = 0
  for (let c = 0; c < 9; c++) {
    const m = st.board[c]
    if (!m) continue
    const base = 3 * m.atk + 2 * m.hp + posBonus(m, m.seat, c)
    if (m.seat === seat) v += base + (m.ready ? m.atk : 0)
    else v -= base - (m.frozen > 0 ? m.atk + 2 : 0)
  }
  v += 4 * st.heroes[seat].hp - (opts.faceMul || 5) * st.heroes[e].hp
  if (opts.boardMul) for (let c = 0; c < 9; c++) { const m = st.board[c]; if (m && m.seat === e) v -= Math.round((3 * m.atk + 2 * m.hp) * (opts.boardMul - 1)) }
  v += 3 * st.hands[seat].length - 3 * st.hands[e].length
  if (opts.combo) v += 6 * comboPairs(st, seat)
  if (opts.reactW) v += opts.reactW * st.stats[seat].reactions // GAMES-91：反应即分——竞技主动摆反应位的直接动机
  if (opts.reactPot) v += opts.reactPot * reactPotential(st, seat) // 邻接异系部署评分入 V（反应预判）
  if (opts.fatigueW) v -= opts.fatigueW * Math.max(0, 4 - st.decks[seat].length) // 疲劳管理：牌库垫 <4 逐张罚（NS1/技能抽牌时序）
  return v
}
function comboPairs(st, seat) { // 手中反应伙伴对数（§4.3，按反应表 6 对）
  const sch = st.hands[seat].map((id) => (MINIONS[id] || SPELLS[id]).school)
  return countPairs(sch)
}
function countPairs(sch) {
  let n = 0
  for (const [x, y] of [['F','W'],['N','T'],['F','T'],['W','N'],['F','N'],['W','T']]) { let a = 0, b = 0; for (const s of sch) { if (s === x) a++; else if (s === y) b++ } n += Math.min(a, b) }
  return n
}
function comboPairsInDeck(hero) { return countPairs(DECKS[hero].cards.map((id) => (MINIONS[id] || SPELLS[id]).school)) }
/* 枚举全部合法单动作（§4.1：≤120 动作，序固定） */
function enumerateActions(st, seat) {
  const out = []
  const h = st.heroes[seat], e = foe(seat)
  for (let i = 0; i < st.hands[seat].length; i++) {
    const id = st.hands[seat][i], def = MINIONS[id] || SPELLS[id]
    if (!def || h.manaCur < def.cost) continue
    if (MINIONS[id]) {
      let ownN = 0
      for (let c = 0; c < 9; c++) if (st.board[c] && st.board[c].seat === seat) ownN++
      if (ownN >= META.maxBoardPerSeat) continue
      for (let c = 0; c < 9; c++) {
        if (st.board[c]) continue
        if (def.cry === 'freezeTgt') { for (let t = 0; t < 9; t++) if (st.board[t] && st.board[t].seat !== seat) out.push({ k: 'play', card: i, cell: c, tgt: { s: e, c: t } }) }
        else out.push({ k: 'play', card: i, cell: c })
      }
    } else if (id === 'FS1') {
      out.push({ k: 'play', card: i, tgt: { s: e, c: -1 } })
      for (let t = 0; t < 9; t++) if (st.board[t]) out.push({ k: 'play', card: i, tgt: { s: st.board[t].seat, c: t } })
    } else if (id === 'FS2') { for (let r = 0; r < 3; r++) out.push({ k: 'play', card: i, tgt: { row: r } }) }
    else if (id === 'WS1') {
      out.push({ k: 'play', card: i, tgt: { s: seat, c: -1 } })
      for (let t = 0; t < 9; t++) if (st.board[t] && st.board[t].seat === seat) out.push({ k: 'play', card: i, tgt: { s: seat, c: t } })
    } else if (id === 'WS2' || id === 'TS1') { for (let t = 0; t < 9; t++) if (st.board[t] && st.board[t].seat !== seat) out.push({ k: 'play', card: i, tgt: { s: e, c: t } }) }
    else if (id === 'NS2') { for (let f = 0; f < 9; f++) { if (!st.board[f] || st.board[f].seat !== seat) continue; for (let t = 0; t < 9; t++) if (!st.board[t]) out.push({ k: 'play', card: i, tgt: { from: f, to: t } }) } }
    else out.push({ k: 'play', card: i }) // NS1/TS2/X0：无目标
  }
  for (let f = 0; f < 9; f++) for (const t of legalAttackTargets(st, seat, f)) out.push({ k: 'attack', from: f, tgt: { s: e, c: t } })
  if (!h.powerUsed && h.manaCur >= 2) {
    if (h.hero === 0) { out.push({ k: 'heroPower', tgt: { s: e, c: -1 } }); for (let t = 0; t < 9; t++) if (st.board[t]) out.push({ k: 'heroPower', tgt: { s: st.board[t].seat, c: t } }) }
    else if (h.hero === 1) { out.push({ k: 'heroPower', tgt: { s: seat, c: -1 } }); for (let t = 0; t < 9; t++) if (st.board[t] && st.board[t].seat === seat) out.push({ k: 'heroPower', tgt: { s: seat, c: t } }) }
    else if (h.hero === 2) out.push({ k: 'heroPower' })
    else if (h.hero === 3) for (let t = 0; t < 9; t++) if (st.board[t]) out.push({ k: 'heroPower', tgt: { s: st.board[t].seat, c: t } })
  }
  out.push({ k: 'endTurn' })
  return out
}
function simulate(st, seat, act) { // scratch 模拟（克隆态上执行，不落日志不广播）
  const cl = cloneState(st)
  applyOp(cl, seat, act, true)
  return cl
}
/* 斩杀线（§4.2 闭式可达伤害：近战仅近敌行、嘲讽未清归零、法术只计英雄有效部分） */
function lethalReach(st, seat) {
  const e = foe(seat)
  if (hasTaunt(st, e)) return 0
  let d = 0
  for (let c = 0; c < 9; c++) {
    const m = st.board[c]
    if (!m || m.seat !== seat || !m.ready || m.frozen > 0 || m.newly) continue
    if (m.ranged || ((c / 3) | 0) === nearEnemyRow(seat)) d += m.atk + (st.heroes[seat].hero === 0 && m.school === 'F' ? 1 : 0)
  }
  const h = st.heroes[seat]
  if (!h.powerUsed && h.manaCur >= 2 && h.hero === 0) d += 2
  if (h.manaCur >= 3) for (let i = 0; i < st.hands[seat].length; i++) if (st.hands[seat][i] === 'FS1') d += 4
  return d
}
/* 法术时序（GAMES-91 §4 深化：竞技档）——FS1 直伤捏手：仅斩杀窗（敌血 ≤10）/
 * 无可铺场面（费花不出去）/终局倾泻（≥20 半回合）才烧脸，其余回合优先铺场留爆发。
 * 解场/治疗/过牌时序交给 ΔV（过疗零分自然晚放、疲劳罚挡住空库抽牌） */
function timedSpells(st, seat, acts) {
  const h = st.heroes[seat]
  let deployable = false
  for (const id of st.hands[seat]) if (MINIONS[id] && h.manaCur >= MINIONS[id].cost) { deployable = true; break }
  const burn = st.heroes[foe(seat)].hp <= 10 || !deployable || st.turnNo >= 20
  return acts.filter((a) => !(a.k === 'play' && st.hands[seat][a.card] === 'FS1' && a.tgt && a.tgt.c === -1 && !burn))
}
/* 动作费用（费用满用 tiebreak 用） */
function actionCost(st, seat, a) {
  if (a.k === 'play') { const d = MINIONS[st.hands[seat][a.card]] || SPELLS[st.hands[seat][a.card]]; return d ? d.cost : 0 }
  return a.k === 'heroPower' ? 2 : 0
}
/* 三档出牌核（§4.4；GAMES-91 深化；hosted=§4.5 牌风化 balanced）
 *   casual    ——casualNext（随手：可付费牌随机、目标随机、无斩杀意识）
 *   balanced  ——整数 V：场面价值 + 解场优先（boardMul 轻压敌盘）+ 费用满用（manaW tiebreak）
 *   competitive——斩杀线闭式 + combo 模拟 + 反应预判（reactW/reactPot：邻接异系
 *               部署评分入 V）+ 法术时序（timedSpells）+ 疲劳管理（fatigueW 牌库垫罚） */
function smartNext(st, seat, level) {
  const opts = {}
  if (level === 'balanced') { opts.boardMul = 1.15; opts.manaW = 1 }
  if (level === 'competitive') { opts.combo = true; opts.reactW = 4; opts.reactPot = 2; opts.fatigueW = 6; opts.spellTiming = true } // §4.3 comboBonus=competitive 专属项（+6/手中伙伴对；GAMES-90 F4 接线）
  if (level === 'hosted') { // 托管牌风化：按被托管者牌组配方查表（§4.5）
    const hero = st.heroes[seat].hero
    if (hero >= 0) {
      const avg = DECKS[hero].cards.reduce((a, id) => a + (MINIONS[id] || SPELLS[id]).cost, 0) / 20
      opts.faceMul = avg < 2.6 ? 7 : 5
      opts.boardMul = avg >= 2.8 ? 1.3 : 1
      opts.combo = comboPairsInDeck(hero) >= 4
    }
  }
  const h = st.heroes[seat]
  if (level === 'competitive' && lethalReach(st, seat) >= st.heroes[foe(seat)].hp) { // 斩杀模式：法术直伤→技能→全指脸（忽略 V）
    for (let i = 0; i < st.hands[seat].length; i++) { const id = st.hands[seat][i]; if (id === 'FS1' && h.manaCur >= 3) return { k: 'play', card: i, tgt: { s: foe(seat), c: -1 } } }
    if (!h.powerUsed && h.manaCur >= 2 && h.hero === 0) return { k: 'heroPower', tgt: { s: foe(seat), c: -1 } }
    for (const a of enumerateActions(st, seat)) if (a.k === 'attack' && a.tgt.c === -1) return a
  }
  const base = evaluate(st, seat, opts)
  let best = null, bestD = 0 // endTurn 基线 ΔV=0；动作须严格更优才做
  let acts = enumerateActions(st, seat)
  if (opts.spellTiming) acts = timedSpells(st, seat, acts)
  for (const a of acts) {
    let d = evaluate(simulate(st, seat, a), seat, opts) - base
    if (opts.manaW) d += opts.manaW * actionCost(st, seat, a) // 费用满用：同 ΔV 先花大件（balanced）
    if (d > bestD) { bestD = d; best = a }
  }
  return best || { k: 'endTurn' }
}
function casualNext(st, seat) { // 随手（§4.4；GAMES-91 口径）：费用不浪（只出可付费牌、偏大件）但无斩杀意识/目标随机
  const rng = botRng(st, seat, decIdx(st, seat))
  const acts = enumerateActions(st, seat).filter((a) => a.k !== 'endTurn')
  if (!acts.length) return null
  const plays = acts.filter((a) => a.k === 'play')
  if (plays.length && rng() < 0.75) {
    let tot = 0
    const ws = plays.map((a) => { const w = (MINIONS[st.hands[seat][a.card]] || SPELLS[st.hands[seat][a.card]]).cost + 1; tot += w; return w })
    let r = rng() * tot
    for (let i = 0; i < plays.length; i++) { r -= ws[i]; if (r <= 0) return plays[i] }
    return plays[plays.length - 1]
  }
  const atks = acts.filter((a) => a.k === 'attack')
  if (atks.length && rng() < 0.4) {
    const faces = atks.filter((a) => a.tgt.c === -1)
    if (faces.length && rng() < 0.3) return faces[0]
    return atks[(rng() * atks.length) | 0]
  }
  return acts[(rng() * acts.length) | 0]
}
function hostedNext(st, seat) { // 主动托管续打（§4.5 balanced 牌风化）
  if (gated(st, seat, 'hosted')) return null
  if (st.phase === 'pick') return st.heroes[seat].hero >= 0 ? null : pickAction(st, seat, 'balanced')
  if (st.phase === 'mulligan') return st.mullDone[seat] ? null : mulliganAction(st, seat, 'balanced')
  return smartNext(st, seat, 'hosted')
}
function pickAction(st, seat, level) {
  const rng = botRng(st, seat, 900 + seat)
  if (level === 'competitive') return { k: 'pick', hero: st.heroes[foe(seat)].hero === 0 ? 1 : 3 } // 对位反选表
  if (level === 'balanced') return { k: 'pick', hero: [1, 2][(rng() * 2) | 0] } // 均衡池 H1/H2
  return { k: 'pick', hero: (rng() * 4) | 0 }
}
function mulliganAction(st, seat, level) { /* 三档换牌（GAMES-91 §4 深化）：casual 随机 / balanced 保低费 / competitive 曲线+combo */
  const hand = st.hands[seat]
  const def = (id) => MINIONS[id] || SPELLS[id]
  if (level === 'casual') { // 随手：随机保留（每张 1/2；botRng 定桩——同 seed 同结果，确定性不变）
    const rng = botRng(st, seat, 901 + seat)
    return { k: 'mulligan', keep: hand.map(() => rng() < 0.5) }
  }
  const cheap = hand.map((id) => def(id).cost <= 2)
  if (level === 'balanced') return { k: 'mulligan', keep: cheap } // 保低费：曲线下限，不赌 combo（GAMES-91 起与竞技分化）
  const sch = hand.map((id) => def(id).school)
  const pairOf = (i) => { // 反应伙伴对成员（按反应表 6 对——F1 修复后 W+N/W+T 对亦生效）
    for (let j = 0; j < hand.length; j++) if (j !== i && sch[j] !== sch[i] && REACTIONS[[sch[i], sch[j]].sort().join('+')]) return true
    return false
  }
  const keep = hand.map((_, i) => cheap[i] || pairOf(i)) // competitive：≤2 费曲线全保 + combo 伙伴对保留
  if (keep.filter(Boolean).length < 2) { // 曲线兜底：保后不足 2 张 → 补最廉一张，防起手全高费空转
    let bi = -1
    for (let i = 0; i < hand.length; i++) if (!keep[i] && (bi < 0 || def(hand[i]).cost < def(hand[bi]).cost)) bi = i
    if (bi >= 0) keep[bi] = true
  }
  return { k: 'mulligan', keep }
}
/* 陪玩放水降档表（GAMES-91 §4，pool §4.4 同构）：连败真人对席 bot 降一档（V 权重劣化）；
 * hosted（断线代打席）亦适用——其对手若是连败真人，代打放水方向一致 */
const MERCY_DOWN = { competitive: 'balanced', balanced: 'casual', casual: 'casual', hosted: 'balanced' }
const botStats = { mercy: 0 } // 放水降档决策计数（观测面，QA 取证；不入 state/hash，确定性无扰）
function brain(state, seat, level, rng, env) {
  const st = state
  if (st.over) return {}
  /* 陪玩放水（GAMES-91）：env.foeLose[seat]=对席真人连败局数（网关 pulse 台账）≥ 阈值
   * （game.json bot.mercy.minFoeLose 可调，适配器经 env.mercy 注入；缺省 2）→ 降一档出手
   * ＝V 权重劣化（竞技丢 combo/反应预判/法术时序/疲劳管理，均衡丢解场/费用满用）；
   * 真人胜 → 台账清零自动回原档。测试房 vctx 每房新建 → 单局连败 ≤1 < 阈值，A6 双跑无扰 */
  if (env && env.foeLose && env.foeLose[seat] >= ((env.mercy && env.mercy.minFoeLose) || 2)) {
    level = MERCY_DOWN[level] || level
    botStats.mercy++
  }
  if (gated(st, seat, level)) return {}
  if (st.phase === 'pick') return st.heroes[seat].hero >= 0 ? {} : { op: pickAction(st, seat, level) }
  if (st.phase === 'mulligan') return st.mullDone[seat] ? {} : { op: mulliganAction(st, seat, level) }
  if (st.phase !== 'play' || st.turnSeat !== seat) return {}
  const a = level === 'casual' ? casualNext(st, seat) : smartNext(st, seat, level)
  return { op: a || { k: 'endTurn' } }
}

/* ---------- 牌桌评语（§4.6：确定性查表，零随机；优先级取首命中） ---------- */
function quip(st, winner) {
  const s = st.stats[0] // 1v1：席 0 为被评者（bot 对真人打法的评语）
  if (s.reactions >= 5) return '五次元素反应——棋盘在你手里会发光。'
  if (s.killTurn > 0 && s.killTurn <= 6 && winner === 'A') return `第${Math.ceil(s.killTurn / 2)}回合的斩杀，我上一回合就该嗅到。`
  if (s.burns >= 2) return '手牌溢出两张，下次试着早点倾泻。'
  if (s.heals >= 8) return '你把血线攥得很紧，打得像个老潮汐。'
  if (s.reactions <= 1 && st.turnNo >= 16) return '元素是孤立地打出去的——让它们做邻居试试。'
  if (s.tauntKills >= 4) return '我的攻势都撞在你的墙上。'
  return { casual: '陪打愉快，下次我还随手。', balanced: '势均力敌，再来。', competitive: '记住这条斩杀线。' }[st._botLevel || 'balanced'] || '势均力敌，再来。'
}

/* ---------- 个性化视图（§5.3：目录首款迷雾下发；canonical 不受影响） ---------- */
function viewFor(st, seat) { // seat=-1 观战（双隐藏）
  const hand = {}
  for (let s = 0; s < 2; s++) hand[s] = seat === s ? [...st.hands[s]] : { n: st.hands[s].length }
  return {
    phase: st.phase, turn: st.turnSeat, turnNo: st.turnNo,
    timerMs: st.over ? 0 : Math.max(0, (st.deadline - st.tick) * META.tickMs),
    heroes: st.heroes.map((h, s) => ({ hero: h.hero, hp: h.hp, mana: h.manaCur, manaMax: h.manaMax, powerUsed: h.powerUsed, deckN: st.decks[s].length, fatigue: st.fatigue[s], grave: st.graves[s] })),
    board: st.board, hand, host: st.hostOn, spellsThisTurn: st.spellsThisTurn,
    reveal: st.over ? { hands: st.hands } : null,
  }
}
/* canonical serialize（§5.6：键字母序；tick/deadline/opsLog 不入） */
function serialize(st) {
  const sortK = (o) => {
    if (Array.isArray(o)) return o.map(sortK)
    if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o).sort()) r[k] = sortK(o[k]); return r }
    return o
  }
  return JSON.stringify(sortK({
    phase: st.phase, turnSeat: st.turnSeat, turnNo: st.turnNo,
    heroes: st.heroes.map((h) => ({ hero: h.hero, hp: h.hp, manaMax: h.manaMax, manaCur: h.manaCur, turns: h.turns, powerUsed: h.powerUsed })),
    hands: st.hands, decks: st.decks, graves: st.graves, fatigue: st.fatigue, board: st.board,
    mullDone: st.mullDone, hostOn: st.hostOn, spellsThisTurn: st.spellsThisTurn, afkStreak: st.afkStreak, stats: st.stats,
  }))
}
function hashState(st) { return fnv1a32(serialize(st)) }
/* 回放器（§5.6：重放 op 日志即整局复算；Bot 决策固化在日志，回放不重跑） */
function replayOps(seed, ops, maxTicks) {
  const st = create(seed, { maxTicks })
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]
    if (st.over) break
    if (o.k === '$timeout') {
      timeoutTurn(st) // 代打确定性重演（内部自记日志/自收尾 auto endTurn）
      /* GAMES-91：跳过日志中该回合代打段——timeoutTurn 已重演并落日志，再按日志逐条
       * 应用=二次执行（auto endTurn 双触发会把回合多交一拍、多抽一张 → 终态发散） */
      while (i + 1 < ops.length && ops[i + 1].s === o.s && ops[i + 1].tn === o.tn) i++
      continue
    }
    const { s, k } = o
    if (k === 'host') applyOp(st, s, { k: 'host', on: !!o.on })
    else if (k === 'pick') applyOp(st, s, { k: 'pick', hero: o.hero })
    else if (k === 'mulligan') applyOp(st, s, { k: 'mulligan', keep: (o.keep || []).map((x) => !!x) })
    else if (k === 'play') applyOp(st, s, { k: 'play', card: o.card, cell: o.cell, tgt: o.tgt })
    else if (k === 'attack') applyOp(st, s, { k: 'attack', from: o.from, tgt: o.tgt })
    else if (k === 'heroPower') applyOp(st, s, { k: 'heroPower', tgt: o.tgt })
    else if (k === 'endTurn') { if (o.auto) { endTurn(st, s, true) } else applyOp(st, s, { k: 'endTurn' }) } // auto=1=超时代打收尾，不清 afk 计数
    else if (k === 'concede') applyOp(st, s, { k: 'concede' })
  }
  return st
}

return {
  META, LEVELS, MINIONS, SPELLS, HEROES, DECKS, REACTIONS, RT_NAME, SCHOOL_COLOR, SCHOOL_GLYPH,
  fnv1a32, mulberry32, create, step, applyOp, brain, viewFor, serialize, hashState, replayOps,
  legalAttackTargets, enumerateActions, evaluate, lethalReach, quip, adjCells, nearEnemyRow,
  botStats, reactPotential,
}
})
