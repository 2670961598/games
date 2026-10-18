/* =====================================================================
 * 派对大乱斗 party-brawl 服务端 sim 适配器（GAMES-172 · S6+S7 双技术第三款）——
 * S7 预测和解第二证（多实体预测边界四类谱）+ S6 底盘（20 实体房+圈即 AOI）。
 * 设计事实源：docs/designs/party-brawl.md（GAMES-171）。
 *
 * 模拟核心在单源 sim.cjs（server 与客户端引同一份，§5.1 单源纪律），本文件只做
 * 网关接线：10Hz 二式快照（每 2 tick）+ per-connection ext.ack（输入序号确认）+
 * ext.hash（每 10 张己席权威态哨兵）+ 圈即 AOI（r_AOI=min(500,r_storm+240)+15px
 * 滞回，§5.4 新面②）+ ext.storm 相位参数变才带（~8 次/局，四类谱第四类）+
 * 弹体零快照（§5.4 新面①——shot/nade 事件即弹道完整定义，重连走 welcome.state.projs）。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const P = require('../../../games/multiplayer/party-brawl/sim.cjs')

/* 放水链配置（game.json bot.mercy → env.mercy 注入 brain；缺省 MERCY_DFT 同值兜底
 * ——不读文件的确定性路径与在线逐字节一致，A6 parity，§4.4） */
let _mCfg = null
function mercyCfg() {
  if (_mCfg) return _mCfg
  try {
    const cfg = JSON.parse(readFileSync(new URL('../../../games/multiplayer/party-brawl/game.json', import.meta.url), 'utf8'))
    _mCfg = Object.assign({}, P.MERCY_DFT, (cfg.bot && cfg.bot.mercy) || {})
  } catch { _mCfg = P.MERCY_DFT }
  return _mCfg
}

/* ---------- 快照账本（per-connection：AOI 滞回 + 稀疏脏字段基线 + 全量节拍） ---------- */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { known: new Set(), seq: 0, sinceFull: 0, sinceHash: 0, sent: new Map(), stormSent: -1, cx: 0, cy: 0, aoiR: 500000, force: true }; connState.set(ctx, b) }
  return b
}
/* 事件缓冲：奇数 tick 的 r.events 暂存，随下一张快照（偶数 tick）成批下发（§5.4） */
const roomPend = new WeakMap()

const SEAT_KEYS = ['hp', 'sh', 'w', 'mag', 'am', 'na', 'me', 'bo', 'ki', 'al']
function seatFields(p) {
  return { hp: p.hp, sh: p.sh, w: p.w, mag: p.mag, am: p.ammo, na: p.nades, me: p.meds, bo: p.alive && p.boost > 0 ? 1 : 0, ki: p.kills, al: p.alive }
}
function seatFull(p) {
  return Object.assign({ id: 's' + p.seat, seat: p.seat, x: p.x, y: p.y, a: p.aim }, seatFields(p))
}
function seatIncr(p, b) {
  const out = { id: 's' + p.seat, x: p.x, y: p.y, a: p.aim }
  const cur = seatFields(p)
  const last = b.sent.get(p.seat) || {}
  for (const f of SEAT_KEYS) if (cur[f] !== last[f]) out[f] = cur[f]
  b.sent.set(p.seat, cur)
  return out
}
function boxFull(b) { return { id: b.id, k: b.k, x: b.x, y: b.y, w: b.w, ammo: b.ammo, it: b.it, nades: b.nades, meds: b.meds, spd: b.spd, on: b.on } }

function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seat = ctxRec.seat
  const own = seat >= 0 ? st.players[seat] : null
  /* 圈即 AOI（§5.4 新面②）：圆心=己席坐标、r=min(500, r_storm+240)+15px 滞回。
   * GAMES-176 O-2 承接（观战镜头跟随领先者——§5.7「AOI 圆心=镜头点」设计本义）：
   * 已淘汰席/旁观席圆心=排行榜首存活者（st.lb[0]，每拍重算；客户端镜头 lerp 补平滑），
   * r 固定 460（O-1 修复值）；lb 空（终拍/异常）回退圈心 */
  const c = P.stormOf(st, st.tick)
  const leadRec = st.lb && st.lb.length ? st.players[st.lb[0][0]] : null
  const lead = leadRec && leadRec.alive ? leadRec : null
  let cx = b.cx, cy = b.cy, rr = b.aoiR
  if (own && own.alive) { cx = own.x; cy = own.y; rr = Math.min(500000, c.r + 240000) }
  else if (lead) { cx = lead.x; cy = lead.y; rr = 460000 }
  else { cx = c.cx; cy = c.cy; rr = 460000 }
  if (rr + 15000 > b.aoiR) b.aoiR = rr // 15px 滞回带（只扩不缩防抖动，mmo GAMES-53 口径）
  b.cx = cx; b.cy = cy
  /* O-1：spectator 镜头点恒=圈心（无走位抖动），滞回无意义——固定发 §5.7 设计值 460px
   * 不入滞回（旧实现首次 500k 地板滞回锁定 → 恒发 515px，观战带宽面上浮 ~12%） */
  const aoiR = seat < 0 ? 460000 : b.aoiR + 15000

  const cand = []
  for (const p of st.players) {
    const dx = p.x - cx, dy = p.y - cy
    if (dx * dx + dy * dy <= aoiR * aoiR) cand.push(p)
  }
  const boxCand = []
  for (const id in st.boxes) {
    const bx = st.boxes[id]
    const dx = bx.x - cx, dy = bx.y - cy
    if (bx.on && dx * dx + dy * dy <= aoiR * aoiR) boxCand.push(bx)
  }
  const keep = new Set([...cand.map((p) => 's' + p.seat), ...boxCand.map((x) => x.id)])
  const leave = []
  for (const id of b.known) if (!keep.has(id)) leave.push(id)

  const dirtySet = r ? r.dirty : null
  const sendSeats = cand.filter((p) => p.alive || !b.sent.has(p.seat) || (dirtySet && dirtySet.has('s' + p.seat)))
  let full = opt.force || b.force || b.sinceFull >= 300 || leave.length > 12
  b.force = false

  let entsArr
  if (full) entsArr = [...cand.map(seatFull), ...boxCand.map(boxFull)]
  else entsArr = [...sendSeats.map((p) => seatIncr(p, b)), ...boxCand.filter((x) => !b.known.has(x.id)).map((x) => ({ id: x.id, on: 1 }))]

  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base, full: full ? 1 : 0, snapSeq: b.seq + 1,
    state: { alive: st.alive, tick: st.tick },
    ents: entsArr, leave: full ? [] : leave,
    events: (r && r.events) || [],
    ext: {
      aoi: { x: cx, y: cy, r: aoiR },
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
      me: own ? { seat, x: own.x, y: own.y, hp: own.hp, sh: own.sh, w: own.w, mag: own.mag, am: own.ammo, na: own.nades, me: own.meds, spd: own.spd, al: own.alive, rank: own.rank } : undefined, // x/y=GAMES-176：和解权威锚原料（reconcile 死码激活配套）
      lb: st.tick % 10 === 0 ? st.lb.slice(0, 5) : undefined,   // 1Hz top5（§5.4）
      mm: st.tick % 10 === 0 ? st.mm : undefined,               // 1Hz 全房密度点（§7 小地图）
    },
  }
  /* ext.storm：相位切换后首张带（全局 ~8 次/局，§5.4；客户端闭式解原料=相位表常量+本参数链）。
   * 哨兵/计次簿记延迟到长度判定后置位——>1.2KB 退化重发递归重入时哨兵未更新，
   * 重发帧仍附带相位载荷（F-1：先置位再重发=该相位参数对客户端永久丢失，无自愈路径） */
  let stormMark = false
  if (b.stormSent !== st.storm.ph) {
    stormMark = true
    const ph = P.PHASES[st.storm.ph]
    const c0 = st.storm.centers[st.storm.ph], c1 = st.storm.centers[st.storm.ph + 1]
    msg.ext.storm = { p: st.storm.ph, t0: ph.t0, t1: ph.t1, r0: ph.r0, r1: ph.r1, x0: c0.x, y0: c0.y, x1: c1.x, y1: c1.y, dps: ph.dps }
  }
  /* ext.hash：每 10 张己席权威态哨兵（§5.1 ④——分歧计数客户端侧，sync 全量自愈）；
   * sinceHash 清零同 storm 延迟——早清则退化重发帧丢失一次哨兵（10 张后自愈的偶丢源） */
  let hashMark = false
  if (own && own.alive) {
    b.sinceHash++
    if (b.sinceHash >= 10) { hashMark = true; msg.ext.hash = P.hashSeat(own, st.tick) }
  }
  const text = JSON.stringify(msg)
  /* 增量 >1.2KB → 退全量（§5.4 退化阈值） */
  if (!full && text.length > 1200) return emitOne(room, ctxRec, r, { force: true })
  if (stormMark) b.stormSent = st.storm.ph
  if (hashMark) b.sinceHash = 0
  b.seq++
  if (full) {
    b.sent.clear()
    for (const p of cand) b.sent.set(p.seat, seatFields(p))
    b.base = st.tick; b.sinceFull = 0
  } else b.sinceFull++
  b.known = keep
  if (room.send) room.send(ctxRec.ctx, text)
  else if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}
function emit(room, r) {
  const st = room.state
  if (r && r.over) { // 终局拍冲刷：奇数拍缓冲的终拍 elim/drop 事件随终局下发——
    // 不冲刷则「最后淘汰」对观测者永久丢失（A7 kills 对账 vs 终局 state 的 kills 差 1 根因）
    const pend0 = roomPend.get(room) || []
    if (r.events && r.events.length) pend0.push(...r.events)
    if (pend0.length) {
      const pr0 = { events: pend0.splice(0), dirty: r.dirty }
      for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, pr0)
      for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, pr0)
    }
    return
  }
  if (st.tick % 2 !== 0) { // 10Hz：偶数 tick 组包；奇数 tick 事件入缓冲（§5.4）
    if (r && r.events && r.events.length) {
      let pend = roomPend.get(room)
      if (!pend) { pend = []; roomPend.set(room, pend) }
      for (const e of r.events) pend.push(e)
    }
    return
  }
  const pend = roomPend.get(room) || []
  if (r && r.events && r.events.length) for (const e of r.events) pend.push(e)
  const pr = pend.length ? { events: pend.splice(0), dirty: r && r.dirty } : r
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, pr)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, pr)
}
function onSync(room, ctx) {
  const s = room.seats.find((x) => x.conn === ctx)
  emitOne(room, { ctx, seat: s ? s.seat : -1 }, null, { force: true })
}

/* =====================================================================
 * 适配器出口（rooms.js 注册表形状 + S6 扩展 emit/onSync + S7 seqInput/ack）
 * ===================================================================== */
export const partyBrawlSim = {
  META: P.META,           // tickMs=50（§2.1）、seats=20、roomPrefix='party'（§5.8）
  LEVELS: P.LEVELS,
  url: '/games/multiplayer/party-brawl/index.html',
  create: (seed, opts = {}) => P.create(seed, { test: opts.test, maxTicks: opts.maxTicks, autopilot: opts.autopilot }),
  step: (st, inputs, room) => P.step(st, inputs, room),
  brain: (st, seat, level, rng, env) => {
    const e2 = env || {}
    if (!e2.mercy) e2.mercy = mercyCfg()
    return P.brain(st, seat, level, rng, e2)
  },
  emit, onSync,
  hashState: (st) => P.hashState(st),
  welcomeExtra: () => ({ // S7 声明块（协议 §6 预留位整组激活，设计 §5.4；hash 不符→回退纯插值）
    prediction: { engine: P.ENGINE, tickMs: P.META.tickMs, hash: P.ENGINE_HASH },
  }),
  fnv1a32: P.fnv1a32, mulberry32: P.mulberry32,
}
