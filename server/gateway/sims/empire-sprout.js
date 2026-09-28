/* =====================================================================
 * empire-sprout 服务端 sim 适配器（GAMES-68 · S3 混合同步首证）——把
 * games/multiplayer/empire-sprout/sim.cjs（与客户端内联的同一份确定性模拟，
 * 单一事实源）适配进网关 sims 注册表。
 *
 * S3 双通道（设计 §5.1/§5.2，经 emit 钩子自组下发——rooms.js S2 路径同款）：
 *   - 建设通道（S2 快照）：每 tick 一张二式快照（全量/增量、snapSeq 缺口检测、
 *     300 张周期全量、资源整秒化、增量阈值退化）按连接下发，ext.layer='build'；
 *     AOI 不需要（单屏全量 ~1.5KB，按连接不裁剪——Bot 情报克制与 api-check 读全量，
 *     设计附决策 8：迷雾是呈现层取舍而非保密需求）。
 *   - 战斗通道（S1 帧）：tick ≥ 1800 广播 {t:'frame', frame, inputs, events,
 *     ext.layer:'battle'}（静默期不下发；首帧 frame=1800，events 含 erupt）。
 * attack 桥（§5.4）：sim.step 内结算并合成 cmd 进战斗输入集（桥在 sim 侧，
 * 网关零特例——与真人直接发帧逐字节同形，入输入日志参与确定性回放）。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const EMP = require('../../../games/multiplayer/empire-sprout/sim.cjs')

/* GAMES-71（slg GAMES-46 同款）：启动时读 game.json net.botTuning（陪玩接管
 * 时延等）注入 sim——game.json 是可调事实源，sim.cjs 内置同值默认兜底（离线
 * 端无读取链路时行为一致）。仅影响 Bot 决策（服务端侧），判定路径与确定性
 * 红线不受影响。 */
try {
  const gameJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../../games/multiplayer/empire-sprout/game.json', import.meta.url)), 'utf8'))
  const tuning = gameJson.net && gameJson.net.botTuning
  if (tuning && EMP.setBotTuning) EMP.setBotTuning(tuning)
} catch (err) {
  // game.json 缺失/畸形：维持 sim 内置默认（不阻断网关启动）
  console.error(JSON.stringify({ k: 'emp-tuning-load-failed', error: String(err && err.message || err) }))
}

const FULL_EVERY = 300   // 每 300 张强制全量（防增量漂移，mmo 先例）
const FULL_DIRTY = 16    // 脏实体 >16（设计 §5.2 阈值）→ 直接全量

const teamOf = (seat) => (seat % 2 === 0 ? 'A' : 'B')

/* ---------- 快照实体投影（§5.2：席位实体 + 队实体=战斗层只读镜像） ---------- */
function seatEnt(st, seat) {
  const s = st.build.seats[seat]
  const pool = {}
  for (const c in s.pools) pool[c] = s.pools[c].length
  return {
    id: 's' + seat, seat, team: teamOf(seat),
    res: { g: (s.res.g / 1000) | 0, w: (s.res.w / 1000) | 0, i: (s.res.i / 1000) | 0 },  // 整数单位（milli→显示粒度）
    plots: s.plots.map((p) => (p ? { kind: p.kind, lv: p.lv } : null)),
    queues: s.queues.map((q) => ({ kind: q.kind, unit: q.unit, n: q.n, tier: q.tier || 1 })),
    pool, marchCd: s.marchCd,
  }
}
function teamEnts(st) {
  return [
    { id: 'tA', team: 'A', wall: st.teams.A.wall, keep: st.teams.A.keep, merit: st.teams.A.merit },
    { id: 'tB', team: 'B', wall: st.teams.B.wall, keep: st.teams.B.keep, merit: st.teams.B.merit },
  ]
}

function broadcast(room, msg) {
  const text = JSON.stringify(msg)
  for (const s of room.seats) if (s.conn && s.conn.conn && s.conn.conn.writable) s.conn.conn.send(text)
  for (const c of room.spectators) if (c.conn && c.conn.writable) c.conn.send(text)
}

/* ---------- 每连接快照账本（seq/base/sinceFull/force；mmo 先例） ---------- */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { seq: 0, base: 0, sinceFull: 0, lastFullBytes: 0, force: true }; connState.set(ctx, b) }
  return b
}

function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seatEnts = st.build.seats.map((s) => seatEnt(st, s.seat))
  const tents = teamEnts(st)
  const all = seatEnts.concat(tents)

  /* 脏集：op 应用/整秒资源席位 + 战斗镜像变动（wallhp/keephp/walldown/keepdown 事件） */
  const dirty = new Set()
  if (r && r.dirty) for (const i of r.dirty) dirty.add('s' + i)
  if (r && r.battleEvents) {
    for (let i = 0; i < r.battleEvents.length; i++) {
      const k = r.battleEvents[i].k
      if (k === 'wallhp' || k === 'keephp' || k === 'walldown' || k === 'keepdown') { dirty.add('tA'); dirty.add('tB') }
    }
  }

  let full = opt.force || b.force || b.sinceFull >= FULL_EVERY || dirty.size > FULL_DIRTY
  b.force = false

  let ents
  if (full) ents = all
  else {
    ents = all.filter((e) => dirty.has(e.id))
    if (ctxRec.seat >= 0) { const own = seatEnts[ctxRec.seat]; if (!dirty.has(own.id)) ents.unshift(own) } // 自身实体恒在首位（§5.2）
  }

  const ack = ctxRec.seat >= 0 && room.seats[ctxRec.seat] ? (room.seats[ctxRec.seat].lastSeq ?? -1) : -1
  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base,
    full: full ? 1 : 0, snapSeq: b.seq + 1,
    ext: { layer: 'build', ack },
    ents,
  }
  if (r && r.events && r.events.length) msg.events = r.events
  const text = JSON.stringify(msg)
  if (!full && b.lastFullBytes && text.length > b.lastFullBytes * 0.7) {
    return emitOne(room, ctxRec, r, { force: true })   // 增量字节 > 全量 ×0.7 → 退化全量（§5.2）
  }
  b.seq++
  if (full) { b.lastFullBytes = text.length; b.base = st.tick; b.sinceFull = 0 } else b.sinceFull++
  if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}

function emit(room, r) {
  /* 1) 战斗帧广播（S1 通道）：静默期（r.battleInputs=null）不下发；frame=st.tick（首帧 1800） */
  if (r && r.battleInputs && r.battleEvents) {
    const msg = { t: 'frame', frame: room.state.tick, inputs: r.battleInputs, events: r.battleEvents, ext: { layer: 'battle' } }
    if (r.over) msg.over = true
    broadcast(room, msg)
  }
  /* 2) 建设快照（S2 通道）：按连接二式下发 */
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, r)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, r)
}

function onSync(room, ctx) {
  let seat = -1
  const s = room.seats.find((x) => x.conn === ctx)
  if (s) seat = s.seat
  emitOne(room, { ctx, seat }, null, { force: true })
}

export const empireSproutSim = {
  META: EMP.META,
  LEVELS: EMP.LEVELS,
  url: '/games/multiplayer/empire-sprout/index.html',
  create: (seed, opts) => EMP.create(seed, opts),
  step: (state, inputs, room) => EMP.step(state, inputs, room),
  serialize: EMP.serialize,
  deserialize: EMP.deserialize,
  brain: (state, seat, level, rng, env) => EMP.brain(state, seat, level, rng, env),
  emit,
  onSync,
  fnv1a32: EMP.fnv1a32,
  mulberry32: EMP.mulberry32,
}
