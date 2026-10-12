/* =====================================================================
 * 战棋对决 确定性回合引擎（GAMES-118 · S1+S5 双技术复用首款）
 * 单一事实源：服务端适配器（server/gateway/sims/tactics-duel.js）require 本文件；
 * 客户端本地预演/离线对打（?debug=1）以 classic script 载入同一份代码——
 * 双环境出口见底部 UMD（Node=module.exports / 浏览器=root.TDuelSim）。
 *
 * S1 纪律（设计 §5.1，slg §5.2 继承）：全整数模拟（+ − * >>，除法向零取整）；
 * Q8 定点唯一位=克制 ×1.25=320>>8；索引/tie-break 全序（AOE 按 unit id 升序、
 * Bot argmax tie-break=枚举序）；判定路径零 Math.random/Date.now（随机只在 Bot
 * 决策流与地图选择 seed 派生，§5.5）；serialize 键字母序+数组固定序。
 * S5 范式（设计 §5.2，element §5.1-§5.4 照搬）：op→ruling 单通道、服务器权威
 * 校验、零快照纯事件驱动、个性化视图（部署密置+对手回合批量披露）、托管三层、
 * 输入日志回放 == 在线 hash（§5.6 双跑口径）。
 * ===================================================================== */
'use strict'
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api // Node（.cjs：网关/api-check require）
  root.TDuelSim = api                                                      // 浏览器 classic script（本地预演/离线对打）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

/* ---------- 常量：兵种总表（§2.1，可执行事实源） ---------- */
const TYPE_ORDER = ['sword', 'axe', 'lance', 'bow', 'mage', 'healer']
const UNITS = {
  sword:  { name: '剑士', hp: 28, atk: 9,  def: 3, mv: 3, rg: [1, 1], val: 20 },
  axe:    { name: '斧兵', hp: 32, atk: 12, def: 2, mv: 2, rg: [1, 1], val: 22 },
  lance:  { name: '枪骑', hp: 26, atk: 8,  def: 4, mv: 5, rg: [1, 1], val: 24 },
  bow:    { name: '弓手', hp: 20, atk: 10, def: 1, mv: 3, rg: [2, 3], val: 22 },
  mage:   { name: '法师', hp: 18, atk: 11, def: 1, mv: 3, rg: [1, 2], val: 24 },
  healer: { name: '医者', hp: 22, atk: 4,  def: 2, mv: 3, rg: [1, 2], val: 18 },
}
/* 克制三角（§2.2）：剑→斧→枪→剑（攻击方克防守方 → atk·320>>8） */
const BEATS = { sword: 'axe', axe: 'lance', lance: 'sword' }
/* 地形码：0 平原 1 森林 2 山岩 3 河流 4 据点（可通行=0/1/4；2/3 阻挡） */
const T_PLAIN = 0, T_FOREST = 1, T_ROCK = 2, T_RIVER = 3, T_POINT = 4
const PASSABLE = [true, true, false, false, true]

/* ---------- 地图库（§2.4 四图全表；行 0-1/6-7 恒平原不入表） ---------- */
function buildMap(mapId) {
  const t = new Array(64).fill(T_PLAIN)
  const pts = []
  const F = (r, c) => { t[r * 8 + c] = T_FOREST }
  const R = (r, c) => { t[r * 8 + c] = T_ROCK }
  const RV = (r, c) => { t[r * 8 + c] = T_RIVER }
  if (mapId === 0) {          // M0 原野双丘
    F(3, 1); F(3, 2); F(4, 5); F(4, 6)
    pts.push(2 * 8 + 5, 5 * 8 + 2)
  } else if (mapId === 1) {   // M1 双桥渡口：rows 3-4 全列除 c=2,5 两座桥
    for (const r of [3, 4]) for (let c = 0; c < 8; c++) if (c !== 2 && c !== 5) RV(r, c)
    F(2, 0); F(5, 7); F(2, 6); F(5, 1)
    pts.push(2 * 8 + 3, 5 * 8 + 4)
  } else if (mapId === 2) {   // M2 密林巷道：rows 3-4 除两条纵向净道
    for (const r of [3, 4]) for (let c = 0; c < 8; c++) if (!(r === 3 && (c === 2 || c === 5)) && !(r === 4 && (c === 2 || c === 5))) F(r, c)
    pts.push(2 * 8 + 2, 5 * 8 + 5)
  } else {                    // M3 岩场对峙
    R(2, 3); R(2, 4); R(5, 3); R(5, 4); R(3, 0); R(4, 7)
    F(3, 5); F(4, 2)
    pts.push(2 * 8 + 6, 5 * 8 + 1)
  }
  for (const p of pts) t[p] = T_POINT
  return { terrain: t, points: pts }
}
/* 四图对称自证（QA 断言源 §2.4）：terrain(r,c)==terrain(7-r,7-c) 且据点成 180° 对 */
for (let m = 0; m < 4; m++) {
  const { terrain, points } = buildMap(m)
  for (let i = 0; i < 64; i++) {
    const mir = (7 - ((i / 8) | 0)) * 8 + (7 - (i % 8))
    if (terrain[i] !== terrain[mir]) throw new Error('map ' + m + ' not 180-symmetric at ' + i)
  }
  if (63 - points[0] !== points[1]) throw new Error('map ' + m + ' points not mirrored')
}

/* ---------- 默认阵/模板（§2.4/§4.3，确定性常量；序=TYPE_ORDER） ---------- */
const T0 = [ [50, 13], [53, 10], [51, 12], [59, 4], [60, 3], [58, 5] ]       // [A_cell, B_cell]（B=A 的 180° 镜像）
const T1 = [ [49, 14], [48, 15], [50, 13], [57, 6], [58, 5],  [56, 7] ]      // 左翼集中
const T2 = [ [54, 9],  [55, 8],  [53, 10], [62, 1], [61, 2],  [63, 0] ]      // 右翼集中（T1 的 c→7−c 镜像）
const TEMPLATES = [T0, T1, T2]
const inZone = (seat, cell) => (seat === 0 ? cell >= 48 && cell <= 63 : cell >= 0 && cell <= 15)

const META = {
  gameId: 'tactics-duel', title: '战棋对决', mode: '1v1-tactics', seats: 2,
  tickMs: 10, persistent: false, takeOver: 'balanced', roomPrefix: 'tactics',
  deployTicks: 2000, turnTicks: 3000, maxTurns: 16, apMax: 4, scoreLine: 10,
}
const LEVELS = ['casual', 'balanced', 'competitive', 'hosted']
/* Bot 拟人延时（tick=10ms，§4.4 决策时机；门控=相位内相对 tick——抖动免疫）。
 * 部署档位刻意前置（80-180 tick < API 轮询首拍 ~500 tick）：双跑局 bot 先交
 * 部署、API 席后交，opsLog 席序对墙钟抖动稳定（§5.6 逐字节断言前提）。 */
const BOT_DELAY = { casual: [80, 180], balanced: [120, 220], competitive: [150, 250], hosted: [100, 200] }

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
const foe = (s) => (s === 0 ? 1 : 0)
const dist = (a, b) => Math.abs(((a / 8) | 0) - ((b / 8) | 0)) + Math.abs((a % 8) - (b % 8))
const NEIGH = (cell) => { // 固定序：上→右→下→左（BFS/枚举全序根）
  const out = [], r = (cell / 8) | 0, c = cell % 8
  if (r > 0) out.push(cell - 8)
  if (c < 7) out.push(cell + 1)
  if (r < 7) out.push(cell + 8)
  if (c > 0) out.push(cell - 1)
  return out
}

/* ---------- 建局 ---------- */
function create(seed, opts = {}) {
  const mapId = (seed >>> 0) % 4
  const { terrain, points } = buildMap(mapId)
  const st = {
    v: 1, seed: seed >>> 0, maxTicks: Number.isInteger(opts.maxTicks) ? opts.maxTicks : 60000,
    tick: 0, mapId, terrain, points,
    phase: 'deploy', over: false, result: null,
    turnSeat: 0, turnNo: 0, turnCounts: [0, 0],
    ap: META.apMax, undoUsed: false,
    units: [], own: [-1, -1], scores: [0, 1], // B 起始 +1（先手补偿 §1.2）
    deploys: [null, null], deployDone: [false, false],
    hostOn: [false, false], afkStreak: [0, 0], turnOps: [0, 0],
    stats: [0, 1].map(() => ({ kills: 0, counterKills: 0, chargeKills: 0, heals: 0, fireOwn: 0, lost: 0 })),
    phaseStartTick: 0, deadline: META.deployTicks,
    opsLog: [], outbox: [],
    _botLevel: null, _snap: null, _boundary: null, _turnEvents: [], _botQ: [[], []],
  }
  return st
}

/* ---------- 事件/账本公共件 ---------- */
function emit(st, events, vis) { st.outbox.push({ events, vis: vis === undefined ? 'all' : vis }) }
function turnEmit(st, ev) { st._turnEvents.push(ev) } // 本回合批量披露暂存（§5.4，endTurn 一次性 vis:'all'）
function logOp(st, seat, k, extra) { st.opsLog.push(Object.assign({ s: seat, k, tn: st.turnNo }, extra || {})) }
const unitById = (st, id) => st.units.find((u) => u.id === id) || null
const unitAt = (st, cell) => st.units.find((u) => u.cell === cell) || null
const cellOf = (u) => u.cell
const aliveOf = (st, seat) => st.units.filter((u) => u.seat === seat)

/* ---------- 伤害一步式（§1.4 固定结算序——跨端一致的根） ---------- */
function dmgCalc(st, a, d, counter) {
  const A = UNITS[a.type], D = UNITS[d.type]
  let atk = A.atk
  if (BEATS[a.type] === d.type) atk = (atk * 320) >> 8                       // ② 克制 ×1.25（Q8）
  const charged = a.type === 'lance' && !counter && a.ms >= 3
  if (charged) atk += 3                                                       // ③ 冲锋（反击方未移动不适用）
  let def = Math.max(0, D.def - (a.type === 'axe' ? 2 : 0))                   // ④ 破甲
  if (d.type === 'sword' && d.hp * 2 <= D.hp) def += 2                        // ⑤ 坚韧
  let dmg = a.type === 'mage' ? atk : atk - def                               // ⑥ 奥术
  if (st.terrain[d.cell] === T_FOREST) dmg -= 1                               // ⑦ 森林掩蔽
  return { dmg: Math.max(1, dmg), charged }                                   // ⑧ 下限 1
}
const inWindow = (type, d) => { const w = UNITS[type].rg; return d >= w[0] && d <= w[1] }
function resolveAttack(st, ev, aId, dId, counter) {
  const a = unitById(st, aId), d = unitById(st, dId)
  if (!a || !d) return
  const { dmg, charged } = dmgCalc(st, a, d, counter)
  d.hp -= dmg
  ev.push(counter ? { k: 'counter', unit: a.id, tgt: d.id, dmg } : { k: 'attack', unit: a.id, seat: a.seat, tgt: d.id, dmg })
  if (d.hp <= 0) {                                                            // ⑨ 死亡即无反击
    ev.push({ k: 'die', unit: d.id, by: a.id })
    st.stats[a.seat].kills++
    if (counter) st.stats[a.seat].counterKills++
    if (charged) st.stats[a.seat].chargeKills++
    st.stats[d.seat].lost++
    st.units.splice(st.units.indexOf(d), 1)
    return
  }
  if (!counter) {                                                             // ⑩ 反击（全强度，dist 在 d 射程窗内）
    const dd = dist(cellOf(a), cellOf(d))
    if (inWindow(d.type, dd)) resolveAttack(st, ev, d.id, a.id, true)
  }
}
function fireball(st, ev, aId, center) {
  const a = unitById(st, aId)
  if (!a) return
  ev.push({ k: 'skill', unit: a.id, seat: a.seat, cell: center })
  const cells = [center, ...NEIGH(center)]                                    // 十字 ≤5 格
  const hits = st.units.filter((u) => cells.includes(u.cell)).sort((x, y) => x.id - y.id) // unit id 升序结算
  for (const u of hits) {
    let dmg = 6                                                               // 奥术：无视防
    if (st.terrain[u.cell] === T_FOREST) dmg -= 1
    dmg = Math.max(1, dmg)
    u.hp -= dmg
    if (u.seat === a.seat && u.id !== a.id) st.stats[a.seat].fireOwn++        // quip 判据：火球误伤己方
    ev.push({ k: 'dmg', tgt: u.id, n: dmg, src: a.id })
    if (u.hp <= 0) { ev.push({ k: 'die', unit: u.id, by: a.id }); st.stats[a.seat].kills++; st.stats[u.seat].lost++; st.units.splice(st.units.indexOf(u), 1) }
  }
}
function checkWipe(st, ev) {                                                  // 全灭检查（每战斗 op 后，§1.4 总序末）
  const a = aliveOf(st, 0).length, b = aliveOf(st, 1).length
  if (a > 0 && b > 0) return false
  endGame(st, a === 0 && b === 0 ? 'draw' : a === 0 ? 'B' : 'A', 'wipe')
  return true
}

/* ---------- 终局（§1.5 四通道） ---------- */
function endScores(st) {
  const out = {}
  for (let s = 0; s < 2; s++) {
    out[s === 0 ? 'A' : 'B'] = {
      pts: st.scores[s], kills: st.stats[s].kills,
      value: aliveOf(st, s).reduce((x, u) => x + UNITS[u.type].val, 0),
    }
  }
  return out
}
function endGame(st, winner, reason) {
  if (st.over) return
  st.over = true
  st.phase = 'over'
  st.result = { winner, reason, scores: endScores(st), quip: quip(st, winner), reveal: { deploys: st.deploys } }
  emit(st, [{ k: 'end', winner, reason }], 'all')
}
function timeoutEnd(st) {                                                     // 通道 3：占点分+存活价值 高者胜
  const t = [0, 1].map((s) => st.scores[s] + aliveOf(st, s).reduce((x, u) => x + UNITS[u.type].val, 0))
  endGame(st, t[0] === t[1] ? 'draw' : t[0] > t[1] ? 'A' : 'B', 'timeout')
}

/* ---------- 回合机（§1.2/§1.4 总序红线） ---------- */
function snapOf(st) {                                                         // turnStart 快照（undo 整体恢复 §5.4）
  return { units: st.units.map((u) => ({ ...u })), own: [...st.own], scores: [...st.scores], ap: st.ap }
}
function startTurn(st, seat) {
  st.turnSeat = seat
  st.turnNo++
  st.turnCounts[seat]++
  st.phase = 'act'
  st.phaseStartTick = st.tick
  st.deadline = st.tick + META.turnTicks
  st.ap = META.apMax
  st.undoUsed = false
  st.turnOps = [0, 0]
  st._botQ = [[], []]
  for (const u of st.units) if (u.seat === seat) { u.ph = 'idle'; u.ms = 0 }  // 清激活态
  st._snap = snapOf(st)                                                       // 快照锚=清态后（undo 恢复到「刚开回合」）
  const ev = [{ k: 'turn', seat, turn: st.turnNo }]
  for (let i = 0; i < 2; i++) if (st.own[i] === seat) {                       // 占点分结算（§1.5 通道 2）
    st.scores[seat]++
    ev.push({ k: 'score', seat, pts: st.scores[seat], point: st.points[i] })
  }
  emit(st, ev, 'all')
  if (st.scores[seat] >= META.scoreLine) { endGame(st, seat === 0 ? 'A' : 'B', 'score'); return }
  st._boundary = snapBoundary(st)                                             // 对手/观战视图锚（§5.3 边界态）
}
function snapBoundary(st) {                                                   // 边界态=全量盘面拷贝（轻量：units+own+scores+回合面）
  return {
    phase: 'act', turnSeat: st.turnSeat, turnNo: st.turnNo, turnCounts: [...st.turnCounts],
    ap: st.ap, undoUsed: st.undoUsed, units: st.units.map((u) => ({ ...u })),
    own: [...st.own], scores: [...st.scores], hostOn: [...st.hostOn], over: st.over,
  }
}
function endTurn(st, seat, auto) {
  turnEmit(st, { k: 'endTurn', seat, auto: !!auto })
  emit(st, st._turnEvents.splice(0, st._turnEvents.length), 'all')            // 批量披露（§5.4：一次性整回合事件序）
  st._botQ = [[], []]
  if (st.over) return
  if (st.turnCounts[0] >= META.maxTurns && st.turnCounts[1] >= META.maxTurns) { timeoutEnd(st); return }
  startTurn(st, foe(seat))
}
function reveal(st) {
  const units = []
  for (let s = 0; s < 2; s++) TYPE_ORDER.forEach((tp, i) => {
    const d = st.deploys[s].find((x) => x.unit === tp)
    units.push({ id: s * 6 + i, seat: s, type: tp, cell: d.cell, hp: UNITS[tp].hp, ph: 'idle', ms: 0 })
  })
  st.units = units
  emit(st, [{ k: 'reveal' }], 'all')
  startTurn(st, 0)
}
function autoDeploy(st, seat) {                                               // 部署超时默认阵代置（§1.2；常量=确定性）
  const cells = TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: TEMPLATES[0][i][seat] }))
  applyOp(st, seat, { k: 'deploy', cells }, true)
}
function timeoutTurn(st) {                                                    // 超时托管：casual 代打整回合（§4.5）
  const seat = st.turnSeat
  const ownOps = st.turnOps[seat]
  logOp(st, seat, '$timeout', {})                                             // 先入账（含 afk 终局段——回放须见标记才能重演终局）
  if (ownOps === 0) {                                                         // 全超时回合（零 op）→ afk 计数（代打 op 不入计数）
    st.afkStreak[seat]++
    if (st.afkStreak[seat] >= 3) { endGame(st, seat === 0 ? 'B' : 'A', 'afk'); return }
  } else st.afkStreak[seat] = 0
  turnEmit(st, { k: 'timeout-turn', seat })
  let guard = 32
  while (!st.over && guard-- > 0) {
    const op = casualNext(st, seat)
    if (!op) break
    applyOp(st, seat, op, true)
    if (st.over || st.turnSeat !== seat) return
  }
  if (!st.over && st.turnSeat === seat) { logOp(st, seat, 'endTurn', { auto: 1 }); endTurn(st, seat, true) }
}

/* ---------- 可达域/目标域（Bot/客户端预演共用，本地 0ms §3.1） ---------- */
function occupied(st) { const m = new Set(); for (const u of st.units) m.add(u.cell); return m }
function reach(st, unitId) {                                                  // BFS ≤mv 步（含原地；返回 [{cell, path}]，序=BFS 确定序）
  const u = unitById(st, unitId)
  if (!u) return []
  const occ = occupied(st)
  const seen = new Map([[u.cell, null]])
  const frontier = [u.cell]
  const md = UNITS[u.type].mv
  for (let step = 0; step < md; step++) {
    const next = []
    for (const c of frontier) for (const n of NEIGH(c)) {
      if (seen.has(n) || !PASSABLE[st.terrain[n]] || occ.has(n)) continue
      seen.set(n, c)
      next.push(n)
    }
    frontier.length = 0
    frontier.push(...next)
  }
  const out = []
  for (const [cell, parent] of seen) {
    const path = [cell]
    let p = parent
    while (p !== null && p !== undefined) { path.push(p); p = seen.get(p) === undefined ? null : seen.get(p) }
    // 回溯：seen.get(起点)=null → 终止；path 反转得 [起点,…,cell]
    out.push({ cell, path: path.reverse() })
  }
  return out
}
function atkTargets(st, unitId) {                                             // 当前位合法攻击目标（id 升序）
  const u = unitById(st, unitId)
  if (!u || u.ph === 'done') return []
  return st.units.filter((t) => t.seat !== u.seat && inWindow(u.type, dist(u.cell, t.cell))).map((t) => t.id).sort((a, b) => a - b)
}
function fireballCells(st, unitId) {                                          // 火球候选心格（含命中敌数，剪枝用；cell 升序）
  const u = unitById(st, unitId)
  if (!u || u.type !== 'mage') return []
  const out = []
  for (let c = 0; c < 64; c++) {
    if (dist(u.cell, c) > 3) continue
    const cross = [c, ...NEIGH(c)]
    let e = 0, o = 0
    for (const t of st.units) if (cross.includes(t.cell)) { if (t.seat !== u.seat) e++; else o++ }
    out.push({ cell: c, foes: e, own: o })
  }
  return out
}
function healTargets(st, unitId) {                                            // 治疗合法目标（窗 1-2 己方，不含自身）
  const u = unitById(st, unitId)
  if (!u || u.type !== 'healer') return []
  return st.units.filter((t) => t.seat === u.seat && t.id !== u.id && dist(u.cell, t.cell) <= 2 && t.hp < UNITS[t.type].hp)
    .map((t) => t.id).sort((a, b) => a - b)
}
function predictDmg(st, aId, dId) { const a = unitById(st, aId), d = unitById(st, dId); return a && d ? dmgCalc(st, a, d, false).dmg : 0 }

/* ---------- op 权威校验+结算（WS op/测试注入/Bot 三源共用；§5.3） ---------- */
function applyOp(st, seat, op, fromBot) {
  if (st.over) return { reject: 'over' }
  const k = op && op.k
  if (k === 'host') {                                                         // 主动托管开关（任意相位合法；任意合法 op 即夺回）
    st.hostOn[seat] = !!op.on
    emit(st, [{ k: 'host', s: seat, on: st.hostOn[seat] }], 'all')
    logOp(st, seat, 'host', { on: st.hostOn[seat] ? 1 : 0 })
    return { ok: true }
  }
  if (k === 'concede') { logOp(st, seat, 'concede', {}); endGame(st, seat === 0 ? 'B' : 'A', 'resign'); return { ok: true } }
  if (fromBot !== true && st.hostOn[seat]) { st.hostOn[seat] = false; emit(st, [{ k: 'host', s: seat, on: false }], 'all') }
  if (k === 'deploy') {
    if (st.phase !== 'deploy') return { reject: 'not-deploy' }
    if (st.deployDone[seat]) return { reject: 'deployed' }
    const cells = Array.isArray(op.cells) ? op.cells : null
    if (!cells || cells.length !== 6) return { reject: 'bad-deploy' }
    const types = cells.map((x) => x && x.unit)
    if (TYPE_ORDER.some((t) => types.filter((x) => x === t).length !== 1)) return { reject: 'bad-deploy' }
    const used = new Set()
    for (const x of cells) {
      const c = Number(x.cell)
      if (!Number.isInteger(c) || c < 0 || c > 63 || !inZone(seat, c) || st.terrain[c] !== T_PLAIN || used.has(c)) return { reject: 'bad-cell' }
      used.add(c)
    }
    st.deploys[seat] = TYPE_ORDER.map((tp) => ({ unit: tp, cell: Number(cells.find((x) => x.unit === tp).cell) }))
    st.deployDone[seat] = true
    logOp(st, seat, 'deploy', { cells: st.deploys[seat].map((x) => [x.unit, x.cell]) })
    emit(st, [{ k: 'deploy', seat }], 'all')
    if (st.deployDone[0] && st.deployDone[1]) reveal(st)
    return { ok: true }
  }
  if (st.phase !== 'act') return { reject: 'not-act' }
  if (st.turnSeat !== seat) return { reject: 'not-your-turn' }
  if (k === 'endTurn') { st.afkStreak[seat] = 0; logOp(st, seat, 'endTurn', {}); endTurn(st, seat, false); return { ok: true } }
  if (k === 'undo') {                                                         // 悔棋（§5.4：快照整体恢复，≤1 次/回合）
    if (st.undoUsed) return { reject: 'undo-used' }
    if (!st._snap) return { reject: 'no-snap' }
    const s = st._snap
    st.units = s.units.map((u) => ({ ...u }))
    st.own = [...s.own]
    st.scores = [...s.scores]
    st.ap = s.ap
    st.undoUsed = true
    st._botQ[seat] = []
    logOp(st, seat, 'undo', {})
    emit(st, [{ k: 'undo', seat }], 'all')
    return { ok: true }
  }
  const u = unitById(st, Number(op.unit))
  if (!u || u.seat !== seat) return { reject: 'bad-unit' }
  const firstTouch = u.ph === 'idle'
  if (firstTouch && st.ap <= 0) return { reject: 'no-ap' }
  if (k === 'move') {
    if (u.ph !== 'idle') return { reject: 'not-idle' }
    const path = Array.isArray(op.path) ? op.path.map(Number) : null
    if (!path || path.length < 1 || path.length > META.apMax * 2 + 2 || path[0] !== u.cell) return { reject: 'bad-path' }
    const steps = path.length - 1
    if (steps > UNITS[u.type].mv) return { reject: 'too-far' }
    const occ = occupied(st)
    for (let i = 1; i < path.length; i++) {
      if (!NEIGH(path[i - 1]).includes(path[i])) return { reject: 'bad-path' }
      if (!PASSABLE[st.terrain[path[i]]] || occ.has(path[i])) return { reject: 'blocked' }
    }
    if (firstTouch) st.ap--
    u.cell = path[path.length - 1]
    u.ms += steps
    u.ph = 'moved'
    const ev = [{ k: 'move', unit: u.id, seat, path: [...path] }]
    const pi = st.points.indexOf(u.cell)
    if (pi >= 0 && st.own[pi] !== seat) {                                     // 据点占据即翻转（§1.1）
      st.own[pi] = seat
      ev.push({ k: 'point', cell: u.cell, owner: seat })
    }
    st.turnOps[seat]++
    logOp(st, seat, 'move', { unit: u.id, path: [...path] })
    turnEmit(st, ev)
    emit(st, ev, seat)                                                        // 操作者实时 ruling；对手 endTurn 批量披露
    return { ok: true }
  }
  if (k === 'attack') {
    if (u.ph === 'done') return { reject: 'acted' }
    const t = unitById(st, Number(op.tgt))
    if (!t || t.seat === seat) return { reject: 'bad-tgt' }
    if (!inWindow(u.type, dist(u.cell, t.cell))) return { reject: 'out-of-range' }
    if (firstTouch) st.ap--
    u.ph = 'done'
    const ev = []
    resolveAttack(st, ev, u.id, t.id, false)
    st.turnOps[seat]++
    logOp(st, seat, 'attack', { unit: u.id, tgt: t.id })
    turnEmit(st, ev)
    emit(st, ev, seat)
    if (!st.over) checkWipe(st, ev)
    return { ok: true }
  }
  if (k === 'skill') {
    if (u.ph === 'done') return { reject: 'acted' }
    const cell = Number(op.cell)
    if (!Number.isInteger(cell) || cell < 0 || cell > 63) return { reject: 'bad-cell' }
    if (u.type === 'mage') {
      if (dist(u.cell, cell) > 3) return { reject: 'out-of-range' }
      if (firstTouch) st.ap--
      u.ph = 'done'
      const ev = []
      fireball(st, ev, u.id, cell)
      st.turnOps[seat]++
      logOp(st, seat, 'skill', { unit: u.id, cell })
      turnEmit(st, ev)
      emit(st, ev, seat)
      if (!st.over) checkWipe(st, ev)
      return { ok: true }
    }
    if (u.type === 'healer') {
      const t = unitAt(st, cell)
      if (!t || t.seat !== seat || t.id === u.id || dist(u.cell, cell) > 2 || dist(u.cell, cell) < 1 || t.hp >= UNITS[t.type].hp) return { reject: 'bad-tgt' }
      if (firstTouch) st.ap--
      u.ph = 'done'
      const got = Math.min(UNITS[t.type].hp - t.hp, 8)
      t.hp += got
      st.stats[seat].heals += got
      const ev = [{ k: 'heal', unit: u.id, tgt: t.id, n: got }]
      st.turnOps[seat]++
      logOp(st, seat, 'skill', { unit: u.id, cell })
      turnEmit(st, ev)
      emit(st, ev, seat)
      return { ok: true }
    }
    return { reject: 'no-skill' }
  }
  return { reject: 'bad-op' }
}

/* ---------- 帧推进（事件驱动：计时器外零计算） ---------- */
function step(st, inputs) {
  st.tick++
  if (st.over) return { over: true, result: st.result }
  if (st.tick >= st.maxTicks && st.phase !== 'over') timeoutEnd(st)
  if (st.phase === 'deploy' && st.tick >= st.deadline) {                      // 部署 20s：未交者默认阵代置（§1.2）
    for (let s = 0; s < 2; s++) if (!st.deployDone[s]) autoDeploy(st, s)
  }
  if (inputs) {                                                               // bot 席帧通道 op（与 WS op 同一 applyOp 权威入口）
    for (let s = 0; s < 2; s++) {
      const o = inputs[s] && inputs[s].op
      if (o && typeof o === 'object' && typeof o.k === 'string' && !st.over) applyOp(st, s, o, true)
    }
  }
  for (let s = 0; s < 2; s++) {                                               // 主动托管/断线托管续打（§4.5 倾向继承）
    if (!st.hostOn[s] || st.over) continue
    if (st.phase === 'act' && st.turnSeat !== s) continue
    if (st.phase === 'deploy' && st.deployDone[s]) continue
    const op = hostedNext(st, s)
    if (op) applyOp(st, s, op, true)
  }
  if (st.phase === 'act' && !st.over && st.tick >= st.deadline) timeoutTurn(st)
  return st.over ? { over: true, result: st.result } : {}
}

/* ---------- Bot（§4：整数 V + scratch 模拟贪心；决策流 keyed 免 tick 抖动） ---------- */
function botRng(st, seat, idx) {                                              // §5.5 决策流：seed^seat^turnNo^决策序（同 seed 同决策）
  return mulberry32((st.seed ^ 0xC0DE ^ Math.imul(seat + 1, 0x9E3779B9) ^ (st.turnNo << 8) ^ idx) >>> 0)
}
function decIdx(st, seat) { let n = 0; for (const o of st.opsLog) if (o.s === seat && o.tn === st.turnNo) n++; return n }
function gated(st, seat, level) {                                             // 拟人延时门（相位内相对 tick）
  const rng = botRng(st, seat, decIdx(st, seat))
  const [lo, hi] = BOT_DELAY[level] || BOT_DELAY.balanced
  return (st.tick - st.phaseStartTick) < lo + ((rng() * (hi - lo)) | 0)
}
function deployAction(st, seat, level) {
  if (level === 'casual') {                                                   // rng 随机合法（§4.1）
    const rng = botRng(st, seat, 9000 + seat)
    const zone = []
    for (let c = 0; c < 64; c++) if (inZone(seat, c) && st.terrain[c] === T_PLAIN) zone.push(c)
    const picked = []
    while (picked.length < 6) { const c = zone[(rng() * zone.length) | 0]; if (!picked.includes(c)) picked.push(c) }
    return { k: 'deploy', cells: TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: picked[i] })) }
  }
  if (level === 'competitive') {                                              // 三模板 rng 定桩（§4.3，开局一次性）
    const rng = botRng(st, seat, 9001 + seat)
    const T = TEMPLATES[(rng() * 3) | 0]
    return { k: 'deploy', cells: TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: T[i][seat] })) }
  }
  const T = TEMPLATES[0]                                                      // balanced/hosted=默认阵 T0
  return { k: 'deploy', cells: TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: T[i][seat] })) }
}
function cloneState(st) {                                                     // scratch 副本（pool §4.3/element §4.1 克隆先例）
  return {
    v: st.v, seed: st.seed, maxTicks: st.maxTicks, tick: st.tick, mapId: st.mapId,
    terrain: st.terrain, points: st.points,                                   // 不可变共享（零拷贝）
    phase: st.phase, over: st.over, result: null,
    turnSeat: st.turnSeat, turnNo: st.turnNo, turnCounts: [...st.turnCounts],
    ap: st.ap, undoUsed: st.undoUsed,
    units: st.units.map((u) => ({ ...u })),
    own: [...st.own], scores: [...st.scores],
    deploys: st.deploys, deployDone: [...st.deployDone],
    hostOn: [false, false], afkStreak: [...st.afkStreak], turnOps: [...st.turnOps],
    stats: st.stats.map((x) => ({ ...x })),
    phaseStartTick: st.phaseStartTick, deadline: st.deadline,
    opsLog: [], outbox: [], _botLevel: st._botLevel, _snap: null, _boundary: null, _turnEvents: [], _botQ: [[], []],
  }
}
/* 局面价值 V（§4.2 整数权重；opts.faceQ8/pointQ8=托管倾向继承 §4.5） */
const MELEE = { sword: 1, axe: 1, lance: 1, bow: 0, mage: 0, healer: 0 }
function posBonus(st, u, pointQ8) {
  let p = 0
  let md = 99
  for (const pt of st.points) { const d = dist(u.cell, pt); if (d < md) md = d }
  p += Math.max(0, 6 - 2 * md)
  if (st.terrain[u.cell] === T_FOREST) p += 2
  if (st.own[st.points.indexOf(u.cell)] === u.seat) p += 4
  const adv = u.seat === 0 ? 6 - ((u.cell / 8) | 0) : ((u.cell / 8) | 0) - 1
  if (MELEE[u.type] && adv >= 2) p += 1
  if (pointQ8) p = (p * pointQ8) >> 8
  return p
}
function unitPower(u) { return 2 * u.hp + 4 * UNITS[u.type].atk + UNITS[u.type].val }
function riskRough(st, u) {                                                   // 粗算：单最大威胁不叠加（§4.2）
  let mx = 0
  for (const e of st.units) {
    if (e.seat === u.seat) continue
    if (dist(e.cell, u.cell) > UNITS[e.type].mv + UNITS[e.type].rg[1]) continue
    let d = Math.max(1, UNITS[e.type].atk - UNITS[u.type].def - (st.terrain[u.cell] === T_FOREST ? 1 : 0))
    if (d > mx) mx = d
  }
  return mx
}
function threatMap(st, seat) {                                                // 精确威胁图（§4.3：BFS(move) ⊕ 射程窗膨胀）
  const t = new Set()
  for (const e of st.units) {
    if (e.seat !== seat) continue
    const occ = occupied(st)
    occ.delete(e.cell)
    const seen = new Set([e.cell])
    const frontier = [e.cell]
    for (let s = 0; s < UNITS[e.type].mv; s++) {
      const next = []
      for (const c of frontier) for (const n of NEIGH(c)) {
        if (seen.has(n) || !PASSABLE[st.terrain[n]] || occ.has(n)) continue
        seen.add(n); next.push(n)
      }
      frontier.push(...next)
    }
    for (const c of seen) {
      const w = UNITS[e.type].rg
      for (let d = w[0]; d <= w[1]; d++) for (const n of NEIGH(c)) if (Math.abs(((n - c) / 8) | 0) + Math.abs((n % 8) - (c % 8)) === 1) t.add(n)
      if (w[0] === 1) t.add(c)
    }
  }
  return t
}
function riskPrecise(st, u, foes) {                                           // 叠加封顶血量（集火感知 §4.3）
  let sum = 0
  for (const e of foes) {
    if (!canHit(st, e, u)) continue
    sum += Math.max(1, UNITS[e.type].atk - UNITS[u.type].def - (st.terrain[u.cell] === T_FOREST ? 1 : 0))
  }
  return Math.min(u.hp, sum)
}
function canHit(st, e, u) { return dist(e.cell, u.cell) <= UNITS[e.type].mv + UNITS[e.type].rg[1] }
function evaluate(st, seat, opts = {}) {
  if (st.over) return st.result && st.result.winner === 'draw' ? 0 : (st.result && st.result.winner === (seat === 0 ? 'A' : 'B') ? 100000 : -100000)
  const e = foe(seat)
  const faceQ8 = opts.faceQ8 || 256
  const pointQ8 = opts.pointQ8 || 256
  let v = 0
  for (const u of st.units) {
    if (u.seat === seat) v += unitPower(u) + posBonus(st, u, pointQ8) - (opts.precise ? 2 * riskPrecise(st, u, st.units.filter((x) => x.seat === e)) : riskRough(st, u))
    else v -= ((unitPower(u) + posBonus(st, u, 0)) * faceQ8) >> 8
  }
  v += 15 * st.scores[seat] - 15 * st.scores[e]
  let mine = 0, theirs = 0
  for (let i = 0; i < 2; i++) { if (st.own[i] === seat) mine++; else if (st.own[i] === e) theirs++ }
  v += 8 * mine - 8 * theirs
  if (opts.formation) {                                                       // 棋形三项（§4.3 件 4）
    const tm = threatMap(st, e)
    for (const u of st.units) {
      if (u.seat !== seat) continue
      if (!MELEE[u.type] && !tm.has(u.cell)) v += 4
      if (u.type === 'healer') {
        let near = false
        for (const w of st.units) if (w.seat === seat && w.id !== u.id && w.hp < UNITS[w.type].hp && dist(w.cell, u.cell) <= 2) near = true
        if (near) v += 3
      }
    }
    const rows = {}
    for (const u of st.units) if (u.seat === seat && MELEE[u.type]) rows[(u.cell / 8) | 0] = (rows[(u.cell / 8) | 0] || 0) + 1
    for (const r in rows) if (rows[r] >= 2) v += 2
  }
  return v
}
/* 枚举全部单激活复合动作（§4.2 ≈≤720 项；序=单位 id × BFS 格 × 目标 id，确定序） */
function enumerateActivations(st, seat) {
  const acts = []
  for (const u of st.units) {
    if (u.seat !== seat || u.ph === 'done') continue
    const costAP = u.ph === 'idle'
    if (costAP && st.ap <= 0) continue
    const spots = u.ph === 'idle' ? reach(st, u.id) : [{ cell: u.cell, path: [u.cell] }]
    for (const sp of spots) {
      const moveOp = u.ph === 'idle' && sp.path.length > 1 ? { k: 'move', unit: u.id, path: [...sp.path] } : null
      const probe = moveOp ? null : u
      let atkList = []
      if (moveOp) {                                                           // 从 sp 格虚拟出目标域
        const occ = occupied(st); occ.delete(u.cell)
        for (const t of st.units) if (t.seat !== seat && inWindow(u.type, dist(sp.cell, t.cell))) atkList.push(t.id)
      } else atkList = atkTargets(st, u.id)
      for (const tgt of atkList) acts.push(moveOp ? { ops: [moveOp, { k: 'attack', unit: u.id, tgt }] } : { ops: [{ k: 'attack', unit: u.id, tgt }] })
      if (u.type === 'mage') {                                                // 火球候选心：敌单位十字邻域 ∩ dist≤3（剪枝 §4.2）
        const cand = new Set()
        for (const t of st.units) if (t.seat !== seat) for (const c of [t.cell, ...NEIGH(t.cell)]) if (dist(sp.cell, c) <= 3) cand.add(c)
        for (const c of [...cand].sort((a, b) => a - b)) acts.push(moveOp ? { ops: [moveOp, { k: 'skill', unit: u.id, cell: c }] } : { ops: [{ k: 'skill', unit: u.id, cell: c }] })
      }
      if (u.type === 'healer' && !moveOp) {
        for (const tgt of healTargets(st, u.id)) acts.push({ ops: [{ k: 'skill', unit: u.id, cell: unitById(st, tgt).cell }] })
      } else if (u.type === 'healer' && moveOp) {                             // 移动后治疗：枚举 sp 窗内受伤友军
        for (const t of st.units) if (t.seat === seat && t.id !== u.id && dist(sp.cell, t.cell) >= 1 && dist(sp.cell, t.cell) <= 2 && t.hp < UNITS[t.type].hp) acts.push({ ops: [moveOp, { k: 'skill', unit: u.id, cell: t.cell }] })
      }
      if (moveOp) acts.push({ ops: [moveOp] })                                // 纯移动/占位
    }
  }
  acts.push({ ops: [{ k: 'endTurn' }] })
  return acts
}
function simulate(st, seat, act) {                                            // scratch 模拟（克隆态执行复合，不落日志不广播）
  const cl = cloneState(st)
  for (const op of act.ops) {
    const r = applyOp(cl, seat, op, true)
    if (r && r.reject) return null
    if (cl.over) break
  }
  return cl
}
/* 出手核：balanced=贪心 argmax / competitive=击杀偏置+精确威胁+棋形（§4.3 四件套；
 * 2-ply 以「对手最强一手」反评估实现——深度 1 对手前瞻覆盖主风险面，预算保护） */
function smartNext(st, seat, level) {
  const opts = {}
  if (level === 'competitive') { opts.precise = true; opts.formation = true; opts.killBonus = 8 }
  if (level === 'hosted') {                                                   // 倾向继承（§4.5）：从已入账输入日志复算两系数
    let atk = 0, moves = 0, pointward = 0
    for (const o of st.opsLog) {
      if (o.s !== seat) continue
      if (o.k === 'attack' || o.k === 'skill') atk++
      if (o.k === 'move' && Array.isArray(o.path) && o.path.length > 1) {
        moves++
        const from = o.path[0], to = o.path[o.path.length - 1]
        let d0 = 99, d1 = 99
        for (const pt of st.points) { d0 = Math.min(d0, dist(from, pt)); d1 = Math.min(d1, dist(to, pt)) }
        if (d1 < d0) pointward++
      }
    }
    const tot = Math.max(1, atk + moves)
    const clampQ8 = (x) => Math.max(128, Math.min(384, Math.round(x * 256)))
    opts.faceQ8 = clampQ8(0.5 + atk / tot)
    opts.pointQ8 = clampQ8(0.5 + (moves ? pointward / moves : 0.5))
  }
  const base = evaluate(st, seat, opts)
  let best = null, bestD = 0                                                  // endTurn 基线 ΔV=0；动作须严格更优
  for (const act of enumerateActivations(st, seat)) {
    if (act.ops[0].k === 'endTurn') continue
    const cl = simulate(st, seat, act)
    if (!cl) continue
    let d = evaluate(cl, seat, opts) - base
    if (opts.killBonus) {                                                     // 击杀确认偏置（防「打残不打死」平局化；普攻/火球皆计）
      const kills = cl.stats[seat].kills - st.stats[seat].kills
      if (kills > 0) d += opts.killBonus * kills
    }
    if (level === 'competitive' && act.ops.length === 1 && act.ops[0].k === 'move') {
      // 2-ply 轻量前瞻：纯移动后让对手取最强一手反评估（站位换打的 Risk 覆盖）
      const foe0 = foe(seat)
      let worst = 0
      for (const fa of enumerateActivations(cl, foe0)) {
        if (fa.ops[0].k === 'endTurn') continue
        const fcl = simulate(cl, foe0, fa)
        if (!fcl) continue
        const fd = evaluate(fcl, seat, opts) - evaluate(cl, seat, opts)
        if (fd < worst) worst = fd
        if (worst < -12) break                                                // 早停（预算保护）
      }
      d += worst
    }
    if (d > bestD) { bestD = d; best = act }
  }
  if (!best) return { k: 'endTurn' }
  st._botQ[seat] = best.ops.slice(1)
  return best.ops[0]
}
function casualNext(st, seat) {                                               // 随手（§4.1：30% 随机攻/20% 火球乱放/20% 随机治疗/否则随机走）
  const rng = botRng(st, seat, decIdx(st, seat))
  const mine = st.units.filter((u) => u.seat === seat && u.ph !== 'done' && (u.ph !== 'idle' || st.ap > 0))
  if (!mine.length) return null
  const atks = []
  for (const u of mine) for (const t of atkTargets(st, u.id)) atks.push({ k: 'attack', unit: u.id, tgt: t })
  if (atks.length && rng() < 0.3) return atks[(rng() * atks.length) | 0]
  const mage = mine.find((u) => u.type === 'mage')
  if (mage && rng() < 0.2) {
    const cells = fireballCells(st, mage.id)
    if (cells.length) return { k: 'skill', unit: mage.id, cell: cells[(rng() * cells.length) | 0].cell }
  }
  const healer = mine.find((u) => u.type === 'healer')
  if (healer && rng() < 0.2) {
    const ts = healTargets(st, healer.id)
    if (ts.length) return { k: 'skill', unit: healer.id, cell: unitById(st, ts[(rng() * ts.length) | 0]).cell }
  }
  const idle = mine.filter((u) => u.ph === 'idle')
  if (idle.length) {
    const u = idle[(rng() * idle.length) | 0]
    const rs = reach(st, u.id)
    if (rs.length) return { k: 'move', unit: u.id, path: rs[(rng() * rs.length) | 0].path }
  }
  return null
}
function hostedNext(st, seat) {                                               // 托管续打（§4.5 balanced 核+倾向继承）
  if (gated(st, seat, 'hosted')) return null
  if (st.phase === 'deploy') return st.deployDone[seat] ? null : deployAction(st, seat, 'balanced')
  if (st.phase !== 'act' || st.turnSeat !== seat) return null
  const q = st._botQ[seat]
  if (q && q.length) return q.shift()
  return smartNext(st, seat, 'hosted')
}
function brain(state, seat, level) {
  const st = state
  if (st.over) return {}
  if (st.phase === 'deploy') {
    if (st.deployDone[seat]) return {}
    if (gated(st, seat, level)) return {}
    return { op: deployAction(st, seat, level) }
  }
  if (st.phase !== 'act' || st.turnSeat !== seat) return {}
  const q = st._botQ[seat]
  if (q && q.length && !gated(st, seat, level)) return { op: q.shift() }      // 复合动作续队列（每 op 一拍，免巨石阻塞）
  if (gated(st, seat, level)) return {}
  if (st.turnOps[seat] > 24) return { op: { k: 'endTurn' } }                  // 安全阀（防意外长回合）
  const a = level === 'casual' ? casualNext(st, seat) : smartNext(st, seat, level)
  return { op: a || { k: 'endTurn' } }
}

/* ---------- 棋桌评语（§4.6：确定性查表，零随机；优先级取首命中） ---------- */
function quip(st, winner) {
  const s = st.stats[0]
  if (s.counterKills >= 3) return '你的后手比先手更锋利。'
  if (st.scores[0] >= 8 && winner === 'A') return '据点才是真正的战场。'
  if (winner === 'A' && st.result && st.result.reason === 'wipe' && s.lost === 0) return '一兵未失，教科书式的推进。'
  if (s.heals >= 24) return '医者跟着你的节奏走了一整场。'
  if (s.chargeKills >= 2) return '枪骑在你手里是标枪。'
  if (s.fireOwn >= 2) return '下次火球，记得看一眼自己人。'
  return { casual: '陪下愉快，随手棋而已。', balanced: '势均力敌，再来。', competitive: '记住这条威胁线。' }[st._botLevel || 'balanced'] || '势均力敌，再来。'
}

/* ---------- 个性化视图（§5.3：部署密置+对手回合边界态；canonical 不受影响） ---------- */
function viewFor(st, seat) {                                                  // seat=-1 观战
  const timerMs = st.over ? 0 : Math.max(0, (st.deadline - st.tick) * META.tickMs)
  if (st.phase === 'deploy') {
    return {
      phase: 'deploy', turn: -1, turnNo: 0, timerMs, mapId: st.mapId,
      terrain: st.terrain, points: st.points,
      units: [], own: [...st.own], scores: [...st.scores], ap: 0, undoUsed: false,
      deploys: seat >= 0 ? [st.deploys[seat], null] : [null, null],           // 己方布置实时/对方密置（观战双隐藏）
      deployDone: [...st.deployDone], host: [...st.hostOn],
    }
  }
  const live = seat === st.turnSeat                                           // 操作者=实时 canonical；对手/观战=边界态
  const b = live ? st : (st._boundary || st)
  return {
    phase: st.over ? 'over' : 'act', turn: st.turnSeat, turnNo: st.turnNo,
    turnCounts: [...st.turnCounts], timerMs, mapId: st.mapId,
    terrain: st.terrain, points: st.points,
    units: b.units.map((u) => ({ ...u })),
    own: [...b.own], scores: [...b.scores], ap: b.ap, undoUsed: b.undoUsed,
    host: [...st.hostOn],
    reveal: st.over ? { deploys: st.deploys } : null,
  }
}
/* canonical serialize（§5.6：键字母序；tick/deadline/opsLog/outbox/流不入） */
function serialize(st) {
  const sortK = (o) => {
    if (Array.isArray(o)) return o.map(sortK)
    if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o).sort()) r[k] = sortK(o[k]); return r }
    return o
  }
  return JSON.stringify(sortK({
    phase: st.phase, turnSeat: st.turnSeat, turnNo: st.turnNo, turnCounts: st.turnCounts,
    ap: st.ap, undoUsed: st.undoUsed,
    units: st.units.map((u) => ({ id: u.id, seat: u.seat, type: u.type, cell: u.cell, hp: u.hp, ph: u.ph, ms: u.ms })),
    terrain: st.terrain, points: st.points, own: st.own, scores: st.scores,
    deployDone: st.deployDone, hostOn: st.hostOn, afkStreak: st.afkStreak, stats: st.stats,
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
      timeoutTurn(st)
      while (i + 1 < ops.length && ops[i + 1].s === o.s && ops[i + 1].tn === o.tn) i++  // 代打段已重演，跳过日志同段
      continue
    }
    const { s, k } = o
    if (k === 'host') applyOp(st, s, { k: 'host', on: !!o.on })
    else if (k === 'deploy') applyOp(st, s, { k: 'deploy', cells: o.cells.map(([unit, cell]) => ({ unit, cell })) })
    else if (k === 'move') applyOp(st, s, { k: 'move', unit: o.unit, path: o.path })
    else if (k === 'attack') applyOp(st, s, { k: 'attack', unit: o.unit, tgt: o.tgt })
    else if (k === 'skill') applyOp(st, s, { k: 'skill', unit: o.unit, cell: o.cell })
    else if (k === 'undo') applyOp(st, s, { k: 'undo' })
    else if (k === 'endTurn') { if (o.auto) endTurn(st, s, true); else applyOp(st, s, { k: 'endTurn' }) }
    else if (k === 'concede') applyOp(st, s, { k: 'concede' })
  }
  return st
}

/* 引擎/常量声明块（版本护栏，§5：welcome.room.duel） */
const ENGINE_HASH = fnv1a32(JSON.stringify({ units: UNITS, order: TYPE_ORDER, beats: BEATS, maps: [0, 1, 2, 3].map((m) => buildMap(m)), templates: TEMPLATES, meta: META }))

return {
  META, LEVELS, UNITS, TYPE_ORDER, BEATS, TEMPLATES, ENGINE_HASH,
  fnv1a32, mulberry32, create, step, applyOp, brain, viewFor, serialize, hashState, replayOps,
  reach, atkTargets, fireballCells, healTargets, predictDmg, dmgCalc, evaluate, enumerateActivations, quip,
  T_PLAIN, T_FOREST, T_ROCK, T_RIVER, T_POINT, PASSABLE, dist, NEIGH,
}
})
