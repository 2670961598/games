/* =====================================================================
 * element-duel 服务端 sim 适配器（GAMES-88 · S5 回合权威本格首证）——把
 * games/multiplayer/element-duel/sim.cjs（确定性回合引擎，单一事实源）
 * 适配进网关 sims 注册表。
 *
 * S5 通道（设计 §5，net-protocol §6 S5 位本格首证）：
 *   - op 通道：t:'op' {k:'pick'|'mulligan'|'play'|'attack'|'heroPower'|
 *     'endTurn'|'host'|'concede'}——服务器权威校验（回合/相位/费用/目标域），
 *     非法 {k:'reject'} 事件回流；
 *   - ruling 通道：每 op 裁决 + 回合事件，附全量**个性化** state（§5.3 迷雾
 *     下发：己方见牌面/对方只见张数/观战双隐藏）——按连接逐席发送；
 *   - 零快照流（§5.2）：卡牌无连续运动，两次事件间带宽=心跳，无 snapshot。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const DUEL = require('../../../games/multiplayer/element-duel/sim.cjs')

/* 陪玩放水配置（GAMES-91）：阈值入 game.json bot.mercy 可调——适配器读出经 env.mercy
 * 注入 brain；sim 侧零配置（离线确定性/回放不读 game.json，brain 缺省阈值=2 兜底） */
const GAME_CFG = JSON.parse(readFileSync(new URL('../../../games/multiplayer/element-duel/game.json', import.meta.url), 'utf8'))
const MERCY_CFG = (GAME_CFG.bot && GAME_CFG.bot.mercy) || { minFoeLose: 2 }

/* 引擎/常量声明块（版本护栏，§5.1：welcome.room.duel） */
const ENGINE_HASH = DUEL.fnv1a32(JSON.stringify({ cards: { ...DUEL.MINIONS, ...DUEL.SPELLS }, heroes: DUEL.HEROES, decks: DUEL.DECKS, reactions: Object.keys(DUEL.REACTIONS).sort(), meta: DUEL.META }))

function sendTo(ctx, msg) {
  if (ctx && ctx.conn && ctx.conn.writable) ctx.conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg))
}
/* ruling/start/end 个性化下发：state 换 per-connection 视图（§5.3） */
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
function drainOutbox(room) { // 引擎裁决队列 → 逐连接个性化 ruling
  const st = room.state
  if (!st.outbox || st.outbox.length === 0) return
  const payloads = st.outbox.splice(0, st.outbox.length)
  const players = room.seats.filter((s) => s.conn).map((s) => s.conn)
  for (const p of payloads) {
    for (const ctx of [...players, ...room.spectators]) sendTo(ctx, rulingFor(room, ctx, { events: p }))
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
    const players = room.seats.filter((s) => s.conn).map((s) => s.conn)
    for (const ctx of [...players, ...room.spectators]) sendTo(ctx, rulingFor(room, ctx, { events: [{ k: 'reject', why: res.reject, seat }] }))
    return
  }
  drainOutbox(room)
}

/* ---------- 缺帧自救（协议 §4.1）：$sync=重发个性化全量（§5.2） ---------- */
function onSync(room, ctx) {
  sendTo(ctx, rulingFor(room, ctx, { events: [{ k: 'sync' }] }))
}

export const elementDuelSim = {
  META: DUEL.META,
  LEVELS: DUEL.LEVELS,
  url: '/games/multiplayer/element-duel/index.html',
  create: (seed, opts) => DUEL.create(seed, opts),
  step: (state, inputs, room) => {
    if (room) state._botLevel = state._botLevel || botLevelOf(room)
    return DUEL.step(state, inputs)
  },
  serialize: DUEL.serialize,
  deserialize: null,
  brain: (state, seat, level, rng, env) => DUEL.brain(state, seat, level, rng, env ? Object.assign({}, env, { mercy: MERCY_CFG }) : env),
  op,
  emit,
  onSync,
  hashState: (state) => DUEL.hashState(state),
  welcomeExtra: () => ({ duel: { engine: 'element-int-v1', hash: ENGINE_HASH } }),
  /* 个性化钩子（rooms.broadcast/sendWelcome 调用；§5.3）：state → per-connection 视图 */
  personalize: (room, ctx, msg) => {
    if (!msg || msg.t === 'seat' || msg.t === 'closed') return msg
    const st = room.state
    if (msg.t === 'welcome') { msg.state = DUEL.viewFor(st, ctx.role === 'player' ? ctx.seat : -1); return msg }
    if (msg.t === 'started') { msg.state = DUEL.viewFor(st, -1); return msg } // 双方同视图（pick 期无手牌）
    if (msg.t === 'ruling') return rulingFor(room, ctx, { events: msg.events || [] })
    if (msg.t === 'state') { msg.state = DUEL.viewFor(st, ctx.role === 'player' ? ctx.seat : -1); return msg }
    return msg // end（result 自带 reveal 全披露，§5.3）/ 其他原样
  },
  fnv1a32: DUEL.fnv1a32,
  mulberry32: DUEL.mulberry32,
}
