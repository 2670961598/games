/* =====================================================================
 * 极速卡丁 speed-kart 服务端 sim 适配器（GAMES-109 · E6/W1/T7）——S7 预测与和解首证。
 * 设计事实源：docs/designs/speed-kart.md（GAMES-108 评审合并版）。
 *
 * 模拟核心在单源 shared.cjs（KartSim.create/step/integrate/brain——§2 全整数配方），
 * 本文件只做网关接线：快照组包（10Hz=每 2 tick，§5.4 二式）+ ext.ack（per-connection
 * 输入序号确认，§5.1）+ ext.hash（每 10 张己车权威态校验哈希，§5.1 ④）+ 事件缓冲。
 * 客户端引同一份 shared.cjs 做本地预测（integrate 同式，§5.1 单源纪律）——
 * 赛道静态表随页面资源下发（tracks.cjs 提交常量），welcome 不重复带货（§5.5 带宽
 * 表的 welcome 轨道行由静态资源替代，REPORT 注记）。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const P = require('../../../games/multiplayer/speed-kart/shared.cjs')

/* GAMES-112 放水链配置（game.json bot.mercy → env.mercy 注入 brain；离线/缺省走
 * shared.cjs MERCY_DFT 同值兜底——不读文件的确定性路径与在线逐字节一致，A6 parity） */
const BOT_CFG = JSON.parse(readFileSync(new URL('../../../games/multiplayer/speed-kart/game.json', import.meta.url), 'utf8'))
const MERCY = (BOT_CFG && BOT_CFG.bot && BOT_CFG.bot.mercy) || null

/* ---------- 快照账本（per-connection：稀疏脏字段基线 + 全量节拍） ---------- */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { seq: 0, sinceFull: 0, sinceHash: 0, sent: new Map() }; connState.set(ctx, b) }
  return b
}
/* 事件缓冲：奇数 tick 的 r.events 暂存，随下一张快照（偶数 tick）成批下发（§5.4） */
const roomPend = new WeakMap()

const KART_KEYS = ['laps', 'dr', 'ch', 'bo', 'pen', 'fin', 'draft']
function kartFull(k) {
  return { seat: k.seat, car: k.car, x: k.x, y: k.y, a: k.a, d: k.d, v: k.v, s: k.s, lat: k.lat,
    laps: k.laps, cp: k.cp, dr: k.dr, ch: k.ch, tier: k.tier, bo: k.bo, pen: k.pen, fin: k.fin,
    draft: k.draft, off: k.off, lapTimes: k.lapTimes, best: k.best }
}
function kartIncr(k, b) {
  const out = { seat: k.seat, x: k.x, y: k.y, a: k.a, v: k.v }
  const last = b.sent.get(k.seat) || {}
  for (const f of KART_KEYS) if (k[f] !== last[f]) out[f] = k[f]
  if (k.lapTimes && k.lapTimes.length !== (last.lapN || 0)) out.lap = k.lapTimes[k.lapTimes.length - 1]
  if (k.fin && k.fin !== last.fin) out.finT = k.fin
  b.sent.set(k.seat, { laps: k.laps, dr: k.dr, ch: k.ch, bo: k.bo, pen: k.pen, fin: k.fin, draft: k.draft, lapN: k.lapTimes ? k.lapTimes.length : 0 })
  return out
}

function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seat = ctxRec.seat
  const full = opt.force || b.base === undefined || b.sinceFull >= 300 // 首张恒全量（b.base 未锚定）
  const karts = full ? st.karts.map(kartFull) : st.karts.map((k) => kartIncr(k, b))
  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base, full: full ? 1 : 0, snapSeq: b.seq + 1,
    state: { phase: st.phase, laps: st.track.laps, ranks: st.ranks, champion: st.champion },
    karts,
    events: r && r.events || [], // 事件流顶层（§5.4；snake 同形，账本/客户端零分叉）
    ext: {
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
      // S7 预测支持（GAMES-109 §5.1）：己车增量快照缺的权威 d/s/cp（和解回滚与 hash
      // 校验的完整态需求）随 per-connection ext 通道下发——12B/张，§6 ext 自由键
      pd: seat >= 0 && st.karts[seat] ? { d: st.karts[seat].d, s: st.karts[seat].s, cp: st.karts[seat].cp } : undefined,
    },
  }
  if (seat >= 0 && st.karts[seat]) {
    b.sinceHash++
    if (b.sinceHash >= 10) { b.sinceHash = 0; msg.ext.hash = P.hashKart(st.karts[seat], st.tick) }
  }
  const text = JSON.stringify(msg)
  b.seq++
  if (full) { b.sent.clear(); for (const k of st.karts) b.sent.set(k.seat, { laps: k.laps, dr: k.dr, ch: k.ch, bo: k.bo, pen: k.pen, fin: k.fin, draft: k.draft, lapN: k.lapTimes.length }); b.base = st.tick; b.sinceFull = 0 }
  else b.sinceFull++
  if (room.send) room.send(ctxRec.ctx, text)
  else if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}
function emit(room, r) {
  const st = room.state
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
  const pr = pend.length ? { events: pend.splice(0) } : r
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, pr)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, pr)
}
function onSync(room, ctx) {
  const s = room.seats.find((x) => x.conn === ctx)
  emitOne(room, { ctx, seat: s ? s.seat : -1 }, null, { force: true })
}

/* =====================================================================
 * 适配器出口（rooms.js 注册表形状 + S2 扩展 emit/onSync + S7 seqInput/ack）
 * ===================================================================== */
export const speedKartSim = {
  META: P.META,           // tickMs=50（§2.1 决策 1）、seats=6、roomPrefix='speed'（§5.8）
  LEVELS: P.LEVELS,
  url: '/games/multiplayer/speed-kart/index.html',
  create: (seed, opts = {}) => P.create(seed, {
    test: opts.test, maxTicks: opts.maxTicks,
    track: opts.track, laps: opts.laps, autopilot: opts.autopilot,
  }),
  step: (st, inputs, room) => P.step(st, inputs, room),
  // GAMES-112：bot env 透传（rooms.js botEnv=kinds/foeLose）+ mercy 注入（挂具可显式覆盖）
  brain: (st, seat, level, rng, env) => {
    const e2 = env || {}
    if (!e2.mercy && MERCY) e2.mercy = MERCY
    return P.brain(st, seat, level, rng, e2)
  },
  emit, onSync,
  hashState: (st) => P.hashState(st),
  welcomeExtra: () => ({ // S7 声明块（协议 §6 预留位整组激活，设计 §5.4/附决策 6）
    prediction: { engine: P.ENGINE, tickMs: P.META.tickMs, hash: P.ENGINE_HASH },
  }),
  fnv1a32: P.fnv1a32, mulberry32: P.mulberry32,
}
