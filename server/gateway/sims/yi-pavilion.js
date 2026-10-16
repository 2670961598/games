/* =====================================================================
 * 弈界棋阁 服务端 sim 适配器（GAMES-155 · S5 回合权威第三证）——把
 * games/multiplayer/yi-pavilion/sim.cjs（多规则确定性回合引擎，单一事实源：
 * RULES 五函数注册表 gomoku/reversi/cascade）适配进网关 sims 注册表。
 *
 * S5 面（设计 §5，element/tactics 范式照搬）：
 *   - op 通道：t:'op' {k:'place'|'host'|'concede'}——服务器权威校验（回合归属/
 *     规则合法集/送位窗/夹击位/让子手序），非法 {k:'reject'} 事件回流（仅违规席）；
 *   - ruling 通道：逐 op 实时回执（附全量 canonical state——零隐藏信息=个性化恒等
 *     映射，观战与对局双方视图逐字节相同，设计 §5.2）；
 *   - 零快照流：回合制事件驱动，静默期仅心跳（全目录最低带宽档）；
 *   - 房间参数：rule/handicap 建房绑定（quick 带 rule、handicap 恒 0，设计 §5.3）；
 *   - welcome 声明块 room.duel={engine:'yi-board-int-v1', rule, hash}——一套
 *     engine hash 护栏三模式（单哈希全量覆盖，附决策 13）。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const YP = require('../../../games/multiplayer/yi-pavilion/sim.cjs')

function sendTo(ctx, msg) {
  if (ctx && ctx.conn && ctx.conn.writable) ctx.conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
}
/* ruling 全量下发：canonical 即广播视图（§5.2 恒等——观战/双方同形） */
function rulingFor(room, ctx, payload) {
  const st = room.state
  const msg = Object.assign({
    t: 'ruling', frame: room.frame,
    turn: st.turn, moveNo: st.moveNo, rule: st.rule,
    timerMs: st.over ? 0 : Math.max(0, (st.deadline ? st.deadline - st.tick : YP.STEP_TICKS) * YP.META.tickMs),
    clock: { 0: st.clock[0], 1: st.clock[1] },
  }, payload)
  msg.state = YP.viewFor(st, ctx && ctx.role === 'player' ? ctx.seat : -1)
  return msg
}
/* 引擎裁决队列 → 逐连接分路（'all'=全连接；number=仅该席（reject 只回违规席）） */
function drainOutbox(room) {
  const st = room.state
  if (!st.outbox || st.outbox.length === 0) return
  const payloads = st.outbox.splice(0, st.outbox.length)
  const players = room.seats.filter((s) => s.conn)
  for (const p of payloads) {
    if (p.vis === 'all') {
      for (const ctx of [...players.map((s) => s.conn), ...room.spectators]) sendTo(ctx, rulingFor(room, ctx, { events: p.events }))
    } else if (Number.isInteger(p.vis) && room.seats[p.vis] && room.seats[p.vis].conn) {
      sendTo(room.seats[p.vis].conn, rulingFor(room, room.seats[p.vis].conn, { events: p.events }))
    }
  }
}
function botLevelOf(room) { // quip 兜底档（§4.7）：首个 bot 席档位
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
  const res = YP.applyOp(st, seat, msg)
  if (res && res.reject) {
    const ctx = room.seats[seat] && room.seats[seat].conn
    if (ctx) sendTo(ctx, rulingFor(room, ctx, { events: [{ k: 'reject', why: res.reject, seat }] }))
    return
  }
  drainOutbox(room)
}

/* ---------- 缺帧自救（协议 §4.1）：$sync=重发全量（零隐藏=同一视图） ---------- */
function onSync(room, ctx) {
  sendTo(ctx, rulingFor(room, ctx, { events: [{ k: 'sync' }] }))
}

export const yiPavilionSim = {
  META: YP.META,
  LEVELS: YP.LEVELS,
  url: '/games/multiplayer/yi-pavilion/index.html',
  create: (seed, opts) => YP.create(seed, opts),
  step: (state, inputs, room) => {
    if (room) state._botLevel = state._botLevel || botLevelOf(room)
    return YP.step(state, inputs)
  },
  serialize: YP.serialize,
  deserialize: null,
  brain: (state, seat, level, rng, env) => YP.brain(state, seat, level, rng, env),
  op,
  emit,
  onSync,
  hashState: (state) => YP.hashState(state),
  welcomeExtra: (room) => ({ duel: { engine: 'yi-board-int-v1', rule: room.state.rule, hash: YP.ENGINE_HASH } }),
  /* 个性化钩子（rooms.broadcast/sendWelcome 调用；§5.2——S5 个性化谱系第三作：
   * 恒等映射（全公开）。钩子保留=未来暗棋/残局变体在同一位置挂出，协议零变更。 */
  personalize: (room, ctx, msg) => msg,
  fnv1a32: YP.fnv1a32,
  mulberry32: YP.mulberry32,
}
