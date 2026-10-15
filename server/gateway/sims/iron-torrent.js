/* =====================================================================
 * iron-torrent 服务端 sim 适配器（GAMES-146 · S4 预测弹道）——把
 * games/multiplayer/iron-torrent/sim.cjs（与客户端同一份确定性模拟，单一事实源）
 * 适配进网关 sims 注册表。
 *
 * S4 通道（设计 §5，net-protocol v1.1 冻结框架零新增消息）：
 *   - 状态域（坦克 tick 步进）+物理域（弹道 Q16 子步）同一 t:'snapshot' 流
 *     （street 单流双域同构，§5.1）；
 *   - 10Hz 二式快照（每 2 tick 组包，奇数 tick 事件入缓冲）+全量每 300 张；
 *   - ext.ack（per-connection 输入序号确认，连续预测-和解锚点，kart 范式）
 *     +ext.hash（每 10 张哨兵）+welcome.room.physics 版本护栏（S4 声明块复用）；
 *   - fire 事件携带含散布的出射角+初速分量（离散段重演起点，§5.3）；
 *   - 增量：坦克脏字段+弹道列表恒带+脏 tile；>全量×0.7 退化全量（§5.3）。
 * ===================================================================== */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const S = require('../../../games/multiplayer/iron-torrent/sim.cjs')

const FULL_EVERY = 300 // 每 300 张强制全量（mmo 范式）

/* ---------- 快照账本（per-connection：稀疏脏字段基线 + 全量节拍） ---------- */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { seq: 0, sinceFull: 0, sinceHash: 0, sent: [null, null, null, null], tiles: null, lastFullBytes: 0, base: -1 }; connState.set(ctx, b) } // base=-1 哨兵：首张恒全量
  return b
}
/* 事件缓冲：奇数 tick 的 r.events 暂存，随下一张快照（偶数 tick）成批下发（kart 范式） */
const roomPend = new WeakMap()

function tankFull(p) {
  return { id: 'p' + p.seat, k: 'p', seat: p.seat, team: p.team, cls: p.cls, x: p.x, y: p.y,
    dir: p.dir, tur: p.tur, hp: p.hp, alive: p.alive ? 1 : 0, a0: p.ammo[0], a1: p.ammo[1], sel: p.sel, cd: p.cd }
}
function tankIncr(p, b) {
  const last = b.sent[p.seat] || {}
  const out = { id: 'p' + p.seat, x: p.x, y: p.y, tur: p.tur, hp: p.hp }
  if (p.dir !== last.dir) out.dir = p.dir
  if ((p.alive ? 1 : 0) !== (last.alive || 0)) out.alive = p.alive ? 1 : 0
  if (p.ammo[0] !== last.a0 || p.ammo[1] !== last.a1 || p.sel !== last.sel) { out.a0 = p.ammo[0]; out.a1 = p.ammo[1]; out.sel = p.sel }
  if (p.cd !== last.cd) out.cd = p.cd
  b.sent[p.seat] = { dir: p.dir, alive: p.alive ? 1 : 0, a0: p.ammo[0], a1: p.ammo[1], sel: p.sel, cd: p.cd }
  return out
}
function projFull(pr) {
  return { id: 'b' + pr.id, seat: pr.seat, ammo: pr.ammo, x: pr.x, y: pr.y, z: pr.z, vx: pr.vx, vy: pr.vy, vz: pr.vz }
}

function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seat = ctxRec.seat
  const full = opt.force || b.base < 0 || b.sinceFull >= FULL_EVERY
  const ents = []
  if (full) {
    for (const p of st.players) if (p) ents.push(tankFull(p))
  } else {
    const dirty = r && r.dirty
    for (const p of st.players) {
      if (!p) continue
      if (p.seat === seat || !dirty || dirty['p' + p.seat]) ents.push(tankIncr(p, b))
    }
  }
  /* 弹道列表恒带（≤8 弹×~20B，§5.3——确定性段重演客户端按 fire 事件起段，此处为观战/reconcile 兜底） */
  const projs = []
  for (const pr of st.projs) projs.push(projFull(pr))
  /* tile：全量带全图耐久档；增量只带脏 tile（hitTile mark('tile'+ti)） */
  let tiles = undefined
  if (full) {
    tiles = []
    for (let i = 0; i < st.tileHp.length; i++) tiles.push(st.tileHp[i])
    b.tiles = tiles.slice()
  } else if (r && r.dirty) {
    tiles = []
    for (const k in r.dirty) if (k.startsWith('tile')) tiles.push({ i: Number(k.slice(4)), hp: st.tileHp[Number(k.slice(4))] })
    if (!tiles.length) tiles = undefined
  }
  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base, full: full ? 1 : 0, snapSeq: b.seq + 1,
    state: {
      phase: st.phase, clock: st.clock, capBar: st.capBar, capTeam: st.capTeam,
      lives: st.lives, map: st.map, wind: st.wind,
    },
    ents, projs,
    events: r && r.events || [],
    ext: {
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
    },
  }
  if (tiles) msg.tiles = tiles
  b.sinceHash++
  if (b.sinceHash >= 10) { b.sinceHash = 0; msg.ext.hash = S.hashQuick(st) } // 确定性哨兵（§5.2 ②）
  const text = JSON.stringify(msg)
  if (!full && b.lastFullBytes && text.length > b.lastFullBytes * 0.7) {
    // 增量退化阈值（§5.3）：脏 >全量×0.7 → 全量
    return emitOne(room, ctxRec, r, { force: true })
  }
  b.seq++
  if (full) {
    b.lastFullBytes = text.length
    b.base = st.tick; b.sinceFull = 0
    b.sent = [null, null, null, null]
  } else b.sinceFull++
  if (room.send) room.send(ctxRec.ctx, text)
  else if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}
function emit(room, r) {
  const st = room.state
  if (r && r.over && st.tick % 2 !== 0) { // 终局拍强制组包：尾拍事件须送达
    const pend0 = roomPend.get(room) || []
    if (r.events) for (const e of r.events) pend0.push(e)
    const pr0 = { events: pend0.splice(0) }
    for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, pr0)
    for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, pr0)
    return
  }
  if (st.tick % 2 !== 0) { // 10Hz：偶数 tick 组包；奇数 tick 事件入缓冲
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
 * 适配器出口（rooms.js 注册表形状 + S2 扩展 emit/onSync）
 * ===================================================================== */
export const ironTorrentSim = {
  META: Object.assign({}, S.META, {
    /* 团队作 pulse 预留（放水链信号源，street GAMES-140 同式——BOT 深化单启用）：
     * 真人所在队胜=断连败/负=连败++；team=seat%2 */
    pulseTeam: (seat, winner) => (seat % 2 === 0 ? 'A' : 'B') === winner,
  }),
  LEVELS: S.LEVELS,
  url: '/games/multiplayer/iron-torrent/index.html',
  create: (seed, opts = {}) => S.create(seed, {
    test: opts.test, maxTicks: opts.maxTicks, autopilot: opts.autopilot,
  }),
  step: (st, inputs, room) => S.step(st, inputs, room),
  brain: (st, seat, level, rng, env) => S.brain(st, seat, level, rng, env), // env 透传位（mercy 参数位预留 §4.3，BOT 深化单启用）
  emit, onSync,
  hashState: (st) => S.hashState(st),
  welcomeExtra: () => ({ // S4 声明块（协议 §6 S4 实证位；§5.2 版本护栏）
    physics: { engine: S.ENGINE, hash: S.ENGINE_HASH, sub: 5 },
  }),
  fnv1a32: S.fnv1a32, mulberry32: S.mulberry32,
}
