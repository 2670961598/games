/* =====================================================================
 * pool-physics 服务端 sim 适配器（GAMES-78 · S4 服务端权威物理首证）——把
 * games/multiplayer/pool-physics/sim.cjs（与客户端内联的同一份确定性定点
 * 物理引擎，单一事实源）适配进网关 sims 注册表。
 *
 * S4 通道（设计 §5，net-protocol §6 S4/S5 预留位实证）：
 *   - op 通道（S5 位）：t:'op' {k:'shot'|'place'|'concede'} 一次性指令——
 *     服务器权威校验（回合/相位/参数 sanitize/放置合法域），非法 reject 事件；
 *   - ruling 通道（S5 位）：回合裁决+球动期起点宣告（shot 携带确定性重演全部
 *     输入——客户端本地 60fps 重演，快照逐字节校验锚，§5.4）；
 *   - 双相快照：静止期事件驱动（带宽趋零）；球动期 10Hz snapshot（16 球四元组
 *     ~400B），ext.physics 声明块；每 300 张强制全量（mmo 范式）。
 * ===================================================================== */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const POOL = require('../../../games/multiplayer/pool-physics/sim.cjs')

const FULL_EVERY = 300   // 每 300 张强制全量（防增量漂移，mmo 先例）

function broadcast(room, msg) {
  const text = JSON.stringify(msg)
  for (const s of room.seats) if (s.conn && s.conn.conn && s.conn.conn.writable) s.conn.conn.send(text)
  for (const c of room.spectators) if (c.conn && c.conn.writable) c.conn.send(text)
}

/* 每房快照账本（全房同流：snapSeq/base/sinceFull 房级即可——无 AOI 无按连接分叉） */
function ledger(room) {
  if (!room.__poolSnap) room.__poolSnap = { seq: 0, base: 0, sinceFull: 0 }
  return room.__poolSnap
}

/* 公共规则态投影（ruling.state / snapshot.meta；~0.6KB） */
function pubState(st) {
  return {
    phase: st.over ? 'ended' : st.phase, turn: st.turn, openTable: st.openTable,
    groups: st.groups, ballInHand: st.ballInHand, shotN: st.shotN,
    timerMs: st.phase === 'aim' ? st.aimTicks * POOL.META.tickMs : 0,
    balls: st.balls.map((b, i) => [i, b.x, b.y, b.pot]),
    potOrder: st.potOrder, pottedBy: st.pottedBy,
  }
}
function pubShot(sh) {
  return sh ? { seat: sh.seat, no: sh.no, ang: sh.ang, pow: sh.pow, spinV: sh.spinV, spinS: sh.spinS, cue: { x: sh.cue.x, y: sh.cue.y } } : undefined
}

function rulingMsg(room, extra) {
  const st = room.state
  return Object.assign({
    t: 'ruling', frame: st.tick,
    turn: st.turn, phase: st.over ? 'ended' : st.phase,
    openTable: st.openTable, groups: st.groups, ballInHand: st.ballInHand,
    timerMs: st.phase === 'aim' ? st.aimTicks * POOL.META.tickMs : 0,
    state: pubState(st),
  }, extra)
}

/* ---------- 下行（rooms.doFrame 每 tick 调） ---------- */
function emit(room, r) {
  if (!r) return
  const st = room.state
  if (r.ruling) {
    broadcast(room, rulingMsg(room, {
      events: r.events || [],
      shot: r.shot ? pubShot(r.shot) : (st.phase === 'motion' ? pubShot(st.lastShot) : undefined),
    }))
  }
  if (r.snapDue) {
    const led = ledger(room)
    led.seq++
    const full = led.sinceFull >= FULL_EVERY ? 1 : 0
    const balls = []
    for (let i = 0; i < 16; i++) {
      const b = st.balls[i]
      if (!full && b.pot) continue            // 增量只带活球 [id,x,y]（§5.2 二式）
      balls.push(full ? [i, b.x, b.y, b.pot] : [i, b.x, b.y])
    }
    const msg = {
      t: 'snapshot', frame: st.tick, base: full ? st.tick : led.base, full,
      snapSeq: led.seq, balls,
      ext: { physics: { engine: POOL.ENGINE, hash: POOL.ENGINE_HASH, sub: st.sub } },
    }
    if (full) { msg.base = st.tick; msg.shot = pubShot(st.lastShot); led.base = st.tick; led.sinceFull = 0 } else led.sinceFull++
    broadcast(room, msg)
  }
}

/* ---------- op 通道（WS t:'op' / 测试注入共用，与真人零分叉） ---------- */
function op(room, seat, msg) {
  const st = room.state
  const res = POOL.applyOp(st, seat, msg)
  if (!res.ok) {
    broadcast(room, rulingMsg(room, { events: [{ k: 'reject', why: res.reject || 'bad-op', seat }] }))
    return
  }
  if (res.ended) return                        // concede：pendingEnd 已置，下一 tick step 收终局
  if (res.shot) {
    broadcast(room, rulingMsg(room, {
      phase: 'motion', events: [{ k: 'shot', seat, no: res.shot.no }], shot: pubShot(res.shot),
    }))
    return
  }
  if (res.placed) {
    broadcast(room, rulingMsg(room, { events: [{ k: 'place', seat, x: st.balls[0].x, y: st.balls[0].y }] }))
  }
}

/* ---------- 缺帧自救（协议 §4.1）：一张全量快照 + 一条 ruling（全量规则态） ---------- */
function onSync(room, ctx) {
  const st = room.state
  const led = ledger(room)
  led.seq++
  const text = JSON.stringify({
    t: 'snapshot', frame: st.tick, base: st.tick, full: 1, snapSeq: led.seq,
    balls: st.balls.map((b, i) => [i, b.x, b.y, b.pot]),
    ext: { physics: { engine: POOL.ENGINE, hash: POOL.ENGINE_HASH, sub: st.sub } },
    shot: pubShot(st.lastShot),
  })
  if (ctx.conn && ctx.conn.writable) ctx.conn.send(text)
  const rl = JSON.stringify(rulingMsg(room, { events: [] }))
  if (ctx.conn && ctx.conn.writable) ctx.conn.send(rl)
}

export const poolPhysicsSim = {
  META: POOL.META,
  LEVELS: POOL.LEVELS,
  url: '/games/multiplayer/pool-physics/index.html',
  create: (seed, opts) => POOL.create(seed, opts),
  step: (state, inputs, room) => POOL.step(state, inputs),
  serialize: POOL.serialize,
  deserialize: null,
  brain: (state, seat, level, rng, env) => POOL.brain(state, seat, level, rng, env),
  op,
  emit,
  onSync,
  hashState: (state) => POOL.hashState(state),
  welcomeExtra: () => ({ physics: { engine: POOL.ENGINE, hash: POOL.ENGINE_HASH } }),
  fnv1a32: POOL.fnv1a32,
  mulberry32: POOL.mulberry32,
}
