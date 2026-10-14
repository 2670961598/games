/* =====================================================================
 * street-soccer 服务端 sim 适配器（GAMES-138 · S3+S4 双技术复用第三款）——把
 * games/multiplayer/street-soccer/sim.cjs（与客户端同一份确定性模拟，单一事实源）
 * 适配进网关 sims 注册表。
 *
 * S3+S4 通道（设计 §5，net-protocol v1.1 冻结框架零新增消息）：
 *   - 单流双域：同一 t:'snapshot' 携带球员域（状态域，tick 步进）+球域（物理域，
 *     Q16 子步）——empire 双通道分帧型的实时体育变体（无静默期，单流更省，§5.1）；
 *   - 10Hz 二式快照（每 2 tick 组包，奇数 tick 事件入缓冲）+全量每 300 张；
 *   - ext.ack（per-connection 输入序号确认，预测和解锚点）+ext.hash（每 10 张
 *     球+全员权威态哨兵，§5.2 ②）+welcome.room.physics 版本护栏（S4 声明块复用）；
 *   - 持球权 flag 服务器唯一裁决零预测（§5.1 归属表）；onSync 缺帧自救=全量一张。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const S = require('../../../games/multiplayer/street-soccer/sim.cjs')

/* 陪玩放水/蜂群参数（GAMES-140，mini-moba GAMES-130 同式）：阈值入 game.json
 * bot.mercy / bot.casual 可调；适配器 brain 出口包装注入 env（离线直调/回放器无 env
 * → sim 内置缺省兜底，行为等价——默认值与 game.json 冻结值一致）。档位：L1 让力
 * （射门散布附加+力量衰减+失误注入）/ L2 重败（行为降档+散布加倍）；casual 失误率
 * （传球/射门/扑抢概率与散布）参数化。 */
const GAME_CFG = JSON.parse(readFileSync(new URL('../../../games/multiplayer/street-soccer/game.json', import.meta.url), 'utf8'))
const MERCY_CFG = (GAME_CFG.bot && GAME_CFG.bot.mercy) || null
const CASUAL_CFG = (GAME_CFG.bot && GAME_CFG.bot.casual) || null

const FULL_EVERY = 300   // 每 300 张强制全量（mmo 范式）

/* ---------- 快照账本（per-connection：稀疏脏字段基线 + 全量节拍） ---------- */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { seq: 0, sinceFull: 0, sinceHash: 0, sent: [null, null, null, null], lastFullBytes: 0, base: -1 }; connState.set(ctx, b) } // base=-1 哨兵：首张恒全量
  return b
}
/* 事件缓冲：奇数 tick 的 r.events 暂存，随下一张快照（偶数 tick）成批下发（kart 范式） */
const roomPend = new WeakMap()

function playerFull(p) {
  return { id: 'p' + p.seat, k: 'p', seat: p.seat, team: p.team, cls: p.cls, x: p.x, y: p.y, dir: p.dir, stam: p.stam,
    lunge: p.lungeT > 0 ? 1 : 0, stum: p.stumbleT > 0 ? 1 : 0 }
}
function playerIncr(p, b) {
  const last = b.sent[p.seat] || {}
  const out = { id: 'p' + p.seat, x: p.x, y: p.y }
  if (p.dir !== last.dir) out.dir = p.dir
  if (p.stam !== last.stam) out.stam = p.stam
  if ((p.lungeT > 0 ? 1 : 0) !== (last.lunge || 0)) out.lunge = p.lungeT > 0 ? 1 : 0
  if ((p.stumbleT > 0 ? 1 : 0) !== (last.stum || 0)) out.stum = p.stumbleT > 0 ? 1 : 0
  b.sent[p.seat] = { dir: p.dir, stam: p.stam, lunge: p.lungeT > 0 ? 1 : 0, stum: p.stumbleT > 0 ? 1 : 0 }
  return out
}
function ballFull(ball) {
  return { id: 'ball', x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, w: ball.w, owner: ball.owner, lastT: ball.lastT }
}

function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seat = ctxRec.seat
  const full = opt.force || b.base < 0 || b.sinceFull >= FULL_EVERY || b.sent === undefined
  const ents = []
  if (full) {
    for (const p of st.players) if (p) ents.push(playerFull(p))
    ents.push(ballFull(st.ball))
  } else {
    const dirty = r && r.dirty
    for (const p of st.players) {
      if (!p) continue
      if (p.seat === seat || !dirty || dirty['p' + p.seat]) ents.push(playerIncr(p, b))
    }
    ents.push({ id: 'ball', x: st.ball.x, y: st.ball.y, owner: st.ball.owner }) // 球恒带（§5.3）
  }
  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base, full: full ? 1 : 0, snapSeq: b.seq + 1,
    state: {
      phase: st.phase === 'ended' ? 'ended' : st.phase, clock: st.clock, ot: st.ot ? 1 : 0,
      score: st.score, poss: st.ball.owner, kickTeam: st.kickTeam,
    },
    ents,
    events: r && r.events || [],
    ext: {
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
    },
  }
  b.sinceHash++
  if (b.sinceHash >= 10) { b.sinceHash = 0; msg.ext.hash = S.hashBall(st) } // 确定性哨兵（§5.2 ②）
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
  if (r && r.over && st.tick % 2 !== 0) { // 终局拍强制组包：尾拍缓冲事件须送达（末进球不被吞）
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
  const pr = pend.length ? { events: pend.splice(0) } : r
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
export const streetSoccerSim = {
  META: Object.assign({}, S.META, {
    /* GAMES-140 团队作 pulse（放水链信号源，mini-moba GAMES-130 同式）：真人所在队
     * 胜=断连败/负=连败++——rooms.js finish 按 META.pulseTeam(seat,winner) 记账；
     * team=seat%2（偶席=A 攻上门，§2.1） */
    pulseTeam: (seat, winner) => (seat % 2 === 0 ? 'A' : 'B') === winner,
  }),
  LEVELS: S.LEVELS,
  url: '/games/multiplayer/street-soccer/index.html',
  create: (seed, opts = {}) => S.create(seed, {
    test: opts.test, maxTicks: opts.maxTicks, autopilot: opts.autopilot,
  }),
  step: (st, inputs, room) => S.step(st, inputs, room),
  /* brain 出口包装（GAMES-140 放水链）：网关 botEnv（kinds/foeLose）+game.json
   * bot.mercy/bot.casual 经 env 注入（mini-moba/tactics 同式）；无 env（离线直调/
   * 回放器 replayInputs）→ 原样透传，sim 内置缺省兜底零放水（A8 逐字节口径） */
  brain: (st, seat, level, rng, env) => S.brain(st, seat, level, rng,
    env ? Object.assign({}, env, { mercy: MERCY_CFG, casual: CASUAL_CFG }) : env),
  emit, onSync,
  hashState: (st) => S.hashState(st),
  welcomeExtra: () => ({ // S4 声明块复用（协议 §6 S4 实证位；§5.2 版本护栏）
    physics: { engine: S.ENGINE, hash: S.ENGINE_HASH, sub: 5 },
  }),
  fnv1a32: S.fnv1a32, mulberry32: S.mulberry32,
}
