/* =====================================================================
 * tactics-duel 服务端 sim 适配器（GAMES-118 · S1+S5 双技术复用首款）——把
 * games/multiplayer/tactics-duel/sim.cjs（确定性回合战棋引擎，单一事实源）
 * 适配进网关 sims 注册表。
 *
 * S1 面：sim=纯函数引擎（applyOp 全整数确定性、serialize 键字母序、
 * hashState/回放器双跑口径 §5.6）；客户端同源内联副本做本地预演（§3.1）。
 * S5 面（设计 §5.2，element 范式照搬）：
 *   - op 通道：t:'op' {k:'deploy'|'move'|'attack'|'skill'|'undo'|'endTurn'|
 *     'host'|'concede'}——服务器权威校验（相位/回合归属/AP/激活态/路径/射程窗），
 *     非法 {k:'reject'} 事件回流（仅违规席）；
 *   - ruling 通道：操作者逐 op 实时回执（含全量个性化 state）；对手/观战收
 *     「边界态」（§5.3 对手回合批量披露——outbox vis 标记按连接分路）；
 *   - 零快照流：回合制事件驱动，静默期仅心跳（全目录最低带宽档）。
 * ===================================================================== */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DUEL = require('../../../games/multiplayer/tactics-duel/sim.cjs')

function sendTo(ctx, msg) {
  if (ctx && ctx.conn && ctx.conn.writable) ctx.conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
}
/* ruling 个性化下发：state → per-connection 视图（§5.3 部署密置/边界态） */
function rulingFor(room, ctx, payload) {
  const st = room.state
  const seat = ctx.role === 'player' ? ctx.seat : -1
  const msg = Object.assign({
    t: 'ruling', frame: room.frame,
    turn: st.turnSeat, phase: st.over ? 'ended' : st.phase,
    timerMs: st.over ? 0 : Math.max(0, (st.deadline - st.tick) * DUEL.META.tickMs),
  }, payload)
  msg.state = DUEL.viewFor(st, seat)
  return msg
}
/* 引擎裁决队列 → 逐连接分路（§5.4：操作者实时/对手批量披露——vis 标记：
 * 'all'=全连接（deploy/reveal/turn/score/endTurn 批量/host/undo）；
 * number=仅该席（操作者逐 op ruling）；reject 只回违规席） */
function drainOutbox(room) {
  const st = room.state
  if (!st.outbox || st.outbox.length === 0) return
  const payloads = st.outbox.splice(0, st.outbox.length)
  const players = room.seats.filter((s) => s.conn)
  for (const p of payloads) {
    if (p.vis === 'all') {
      for (const ctx of [...players.map((s) => s.conn), ...room.spectators]) sendTo(ctx, rulingFor(room, ctx, { events: p.events }))
    } else if (Number.isInteger(p.vis) && players[p.vis]) {
      sendTo(players[p.vis].conn, rulingFor(room, players[p.vis].conn, { events: p.events }))
    }
  }
}
function botLevelOf(room) { // quip 兜底档（§4.6）：首个 bot 席档位
  for (const s of room.seats) if (s.kind === 'bot' && s.level && s.level !== 'hosted') return s.level
  return null
}

/* ---------- 下行（rooms.doFrame 每 tick 调；事件驱动——无快照） ---------- */
function emit(room) {
  drainOutbox(room)
}

/* ---------- op 通道（WS t:'op' / 测试注入共用，同一权威入口） ---------- */
function op(room, seat, msg) {
  const st = room.state
  st._botLevel = st._botLevel || botLevelOf(room)
  const res = DUEL.applyOp(st, seat, msg)
  if (res && res.reject) {
    const ctx = room.seats[seat] && room.seats[seat].conn
    if (ctx) sendTo(ctx, rulingFor(room, ctx, { events: [{ k: 'reject', why: res.reject, seat }] }))
    return
  }
  drainOutbox(room)
}

/* ---------- 缺帧自救（协议 §4.1）：$sync=重发个性化全量 ---------- */
function onSync(room, ctx) {
  sendTo(ctx, rulingFor(room, ctx, { events: [{ k: 'sync' }] }))
}

export const tacticsDuelSim = {
  META: DUEL.META,
  LEVELS: DUEL.LEVELS,
  url: '/games/multiplayer/tactics-duel/index.html',
  create: (seed, opts) => DUEL.create(seed, opts),
  step: (state, inputs, room) => {
    if (room) state._botLevel = state._botLevel || botLevelOf(room)
    return DUEL.step(state, inputs)
  },
  serialize: DUEL.serialize,
  deserialize: null,
  brain: (state, seat, level) => DUEL.brain(state, seat, level),
  op,
  emit,
  onSync,
  hashState: (state) => DUEL.hashState(state),
  welcomeExtra: () => ({ duel: { engine: 'tactics-int-v1', hash: DUEL.ENGINE_HASH } }),
  /* 个性化钩子（rooms.broadcast/sendWelcome 调用；§5.3） */
  personalize: (room, ctx, msg) => {
    if (!msg || msg.t === 'seat' || msg.t === 'closed') return msg
    const st = room.state
    const seat = ctx.role === 'player' ? ctx.seat : -1
    if (msg.t === 'welcome') { msg.state = DUEL.viewFor(st, seat); return msg }
    if (msg.t === 'started') { msg.state = DUEL.viewFor(st, seat); return msg }
    if (msg.t === 'ruling') return rulingFor(room, ctx, { events: msg.events || [] })
    if (msg.t === 'state') { msg.state = DUEL.viewFor(st, seat); return msg }
    return msg // end（result 自带 reveal 全披露，§5.3）/ 其他原样
  },
  fnv1a32: DUEL.fnv1a32,
  mulberry32: DUEL.mulberry32,
}
