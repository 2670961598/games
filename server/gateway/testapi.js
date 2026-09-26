/* =====================================================================
 * 网关测试管理 API（GAMES-41 · M1）——每款联机游戏通用的 API 可玩性测试面。
 * 规范：docs/net-protocol.md §8（协议 v1.1）；剧本声明：game.json net.api。
 *
 * 端点（全部仅 127.0.0.1 回环可用；无 CORS——浏览器面天然打不进来）：
 *   POST   /api/test/room   {gameId, seed?, botLevels[]?, timeScale?, startDelayMs?, maxTicks?, hp?}
 *                           → 隔离测试房 + API 玩家自动入席（不进 feed、不计 BotHost 配额）
 *   POST   /api/test/input  {roomId, seat?, op, payload?}
 *                           op ∈ net.api.ops（游戏操作）∪ 框架控制 op：
 *                           $disconnect（模拟掉线）/ $reconnect（凭 token 复席）/ $sync（全量重同步）
 *   GET    /api/test/state  ?roomId=&since= → 状态快照 + 下行消息账本（事件日志游标）
 *   DELETE /api/test/room   {roomId} 或 ?roomId= → 立即回收
 *
 * 与真人同路径（红线）：API 玩家是一条虚拟会话 ctx（conn.send 只记账本），
 * 走 RoomManager.join/input/detach 与 WS 会话逐字节同一条代码路径——
 * 注入的操作经过与真人完全相同的 sanitize/lastInput/pending 帧入口（协议 §4/§5）。
 * ===================================================================== */
import { sendJSON, readBody } from '../lib/http-util.js'

const MAX_TEST_ROOMS = 8      // 并发测试房上限（防泄漏占满）
const MAX_LOG = 8192          // 每房下行消息账本上限（环形截断）
const MAX_SLICE = 512         // 单次 GET /api/test/state 最多回吐的消息数
const MAX_BODY = 16 * 1024    // 与 WS MAX_MSG_BYTES 同口径

/** 回环判定：测试面唯一鉴权（局域网/公网来源一律 403） */
export function isLoopback(req) {
  const ra = (req.socket && req.socket.remoteAddress) || ''
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
}

export class TestHost {
  constructor({ rooms, log = () => {} } = {}) {
    this.rooms = rooms
    this.log = log
    this.tests = new Map() // roomId → { room, vctx, token, playerSeat, log:[{ts,msg}], injects:[] }
  }

  /* ---------- 虚拟会话：conn.send 只入账本，其余与 WS ctx 同构 ---------- */
  makeVctx(roomId) {
    const vctx = { conn: null, room: null, seat: -1, role: null, isTest: true }
    vctx.conn = {
      writable: true,
      send: (text) => {
        const rec = this.tests.get(roomId)
        if (!rec) return
        let msg
        try { msg = JSON.parse(text) } catch { msg = { t: 'raw', text } }
        rec.log.push({ ts: Date.now(), msg })
        if (rec.log.length > MAX_LOG) rec.log.splice(0, rec.log.length - MAX_LOG)
      },
    }
    return vctx
  }

  /** 已被房间管理器回收的残留条目清理（脚本崩溃未 DELETE 的兜底） */
  purge() {
    for (const [id, rec] of this.tests) {
      if (!this.rooms.rooms.has(id) && rec.room.phase === 'ended' && Date.now() - rec.room.endedAt > 60_000) {
        this.tests.delete(id)
      }
    }
  }

  /* ---------- POST /api/test/room ---------- */
  createRoom(body = {}) {
    this.purge()
    if (this.tests.size >= MAX_TEST_ROOMS) return { status: 429, body: { ok: false, error: 'too-many-test-rooms' } }
    const sim = this.rooms.sims.get(body.gameId)
    if (!sim) return { status: 404, body: { ok: false, error: 'game-unknown' } }
    const botLevels = Array.isArray(body.botLevels) ? body.botLevels : []
    const bots = []
    let emptySeats = 0
    for (let i = 0; i < sim.META.seats; i++) {
      const lv = botLevels[i]
      if (lv) bots.push({ level: String(lv) })
      else { bots.push(null); emptySeats++ }
    }
    if (emptySeats === 0) return { status: 400, body: { ok: false, error: 'no-api-seat（botLevels 须留 null 席给 API 玩家）' } }
    const timeScale = Math.min(16, Math.max(0.25, Number(body.timeScale) || 1))
    const startDelayMs = Math.min(30_000, Math.max(0, Number(body.startDelayMs) ?? 600))
    let room
    try {
      room = this.rooms.create({
        gameId: body.gameId, name: `测试房·${sim.META.title}`, bots,
        startDelayMs, maxTicks: body.maxTicks, hp: body.hp,
        seed: body.seed, test: true, timeScale,
      })
    } catch (err) {
      return { status: 400, body: { ok: false, error: String(err && err.message || err) } }
    }
    const rec = { room, vctx: null, token: null, playerSeat: -1, log: [], injects: [] }
    this.tests.set(room.id, rec)
    const vctx = this.makeVctx(room.id)
    this.rooms.attach(vctx)
    const j = this.rooms.join(vctx, { roomId: room.id, mode: 'play', name: 'api-player' })
    if (!j || j.error || vctx.seat < 0) {
      this.rooms.dispose(room, 'test-error')
      this.tests.delete(room.id)
      return { status: 500, body: { ok: false, error: 'api-seat-join-failed' } }
    }
    rec.vctx = vctx
    rec.playerSeat = vctx.seat
    rec.token = room.seats[vctx.seat].token
    this.log({ k: 'test-room-create', roomId: room.id, gameId: body.gameId, seed: room.state.seed, timeScale, playerSeat: rec.playerSeat })
    return { status: 200, body: this.snapshot(rec, 0) }
  }

  /* ---------- GET /api/test/state ---------- */
  snapshot(rec, since) {
    const room = rec.room
    const from = Math.max(0, Math.min(Number.isInteger(since) ? since : 0, rec.log.length))
    const to = Math.max(from, rec.log.length - MAX_SLICE)
    return {
      ok: true, roomId: room.id, gameId: room.gameId,
      phase: room.phase, frame: room.frame, tick: room.state.tick,
      timeScale: room.timeScale, playerSeat: rec.playerSeat, token: rec.token,
      seats: this.rooms.roster(room), state: room.state, result: room.result || null,
      events: rec.log.slice(to), cursor: rec.log.length,
      lastInject: rec.injects.length ? rec.injects[rec.injects.length - 1] : null,
    }
  }

  /* ---------- POST /api/test/input ---------- */
  input(body = {}) {
    const rec = this.tests.get(body.roomId)
    if (!rec) return { status: 404, body: { ok: false, error: 'room-gone' } }
    const op = String(body.op || '')
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}

    /* 框架控制 op —— 连接生命周期也走 API（与 WS close/join resume/sync 同路径） */
    if (op === '$disconnect') {
      if (rec.vctx.role !== 'player') return { status: 409, body: { ok: false, error: 'not-connected' } }
      const seat = rec.vctx.seat
      this.rooms.detach(rec.vctx) // 与 WS close 同一条路：goneAt 计时，10s 重连窗开启
      this.log({ k: 'test-disconnect', roomId: rec.room.id, seat })
      return { status: 200, body: { ok: true, op, seat, disconnectedAt: Date.now() } }
    }
    if (op === '$reconnect') {
      if (this.rooms.rooms.get(body.roomId) !== rec.room) return { status: 409, body: { ok: false, error: 'room-gone' } }
      const seat = Number.isInteger(body.seat) ? body.seat : rec.playerSeat
      const token = String(payload.token || rec.token)
      // 预检（与 rooms.join 的 resume 判定同款）：席位须仍是人类席且 token 匹配；
      // 逾时已转 bot 托管（token 已清）同样拒绝——复席语义不容降级为顶号
      const s = rec.room.seats[seat]
      if (!s || s.kind !== 'human' || !s.token || s.token !== token) {
        return { status: 409, body: { ok: false, error: 'resume-rejected（token/席位不符或已托管）' } }
      }
      const nv = this.makeVctx(body.roomId)
      this.rooms.attach(nv)
      const j = this.rooms.join(nv, { roomId: body.roomId, mode: 'play', resume: { seat, token }, name: 'api-player' })
      if ((j && j.error) || nv.seat !== seat) {
        this.rooms.detach(nv)
        return { status: 409, body: { ok: false, error: 'resume-failed' } }
      }
      rec.vctx = nv
      this.log({ k: 'test-reconnect', roomId: rec.room.id, seat })
      return { status: 200, body: { ok: true, op, seat, resumedAt: Date.now() } }
    }
    if (op === '$sync') { // 全量重同步（与 WS 'sync' 同形：conn.send state 消息）
      if (rec.vctx.room) rec.vctx.conn.send(JSON.stringify({ t: 'state', frame: rec.room.frame, state: rec.room.state }))
      return { status: 200, body: { ok: true, op } }
    }

    /* 游戏 op：按 net.api.ops 映射到 WS input 消息（S1：payload 即输入向量，可包 keys 壳） */
    if (rec.vctx.role !== 'player') return { status: 409, body: { ok: false, error: 'not-connected（$disconnect 后须先 $reconnect）' } }
    if (Number.isInteger(body.seat) && body.seat !== rec.vctx.seat) return { status: 403, body: { ok: false, error: 'seat（本房 API 玩家固定席）' } }
    const msg = { t: 'input', keys: payload.keys && typeof payload.keys === 'object' ? payload.keys : payload }
    if (payload.frame !== undefined) msg.frame = payload.frame // 可选：预约目标帧（input delay=1）
    this.rooms.input(rec.vctx, msg) // ← 与 WS 'input' 完全同一条 sim 入口（sanitize/lastInput/pending）
    const receivedAt = Date.now()
    rec.injects.push({ ts: receivedAt, op, keys: msg.keys, frame: rec.room.frame })
    if (rec.injects.length > 64) rec.injects.shift()
    return { status: 200, body: { ok: true, op, seat: rec.vctx.seat, frame: rec.room.frame, receivedAt } }
  }

  /* ---------- DELETE /api/test/room ---------- */
  deleteRoom(roomId) {
    const rec = this.tests.get(roomId)
    if (!rec) return { status: 404, body: { ok: false, error: 'room-gone' } }
    try { if (rec.vctx.room) this.rooms.detach(rec.vctx) } catch { /* 已离线则跳过 */ }
    if (this.rooms.rooms.has(roomId)) this.rooms.dispose(rec.room, 'test-cleanup')
    this.tests.delete(roomId)
    this.log({ k: 'test-room-delete', roomId })
    return { status: 200, body: { ok: true, roomId } }
  }
}

/** 请求处理（index.js 在自身 handler 里调用；仅回环可达——index.js 已做 403 闸门） */
export async function handleTestApi(req, res, url, host) {
  const route = `${req.method} ${url}`
  try {
    if (route === 'POST /api/test/room') {
      const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}')
      const r = host.createRoom(body)
      sendJSON(req, res, r.status, r.body)
      return true
    }
    if (route === 'DELETE /api/test/room') {
      let body = {}
      try { body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}') } catch { body = {} }
      const roomId = body.roomId || new URL(req.url, 'http://x').searchParams.get('roomId')
      const r = host.deleteRoom(roomId)
      sendJSON(req, res, r.status, r.body)
      return true
    }
    if (route === 'POST /api/test/input') {
      const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8') || '{}')
      const r = host.input(body)
      sendJSON(req, res, r.status, r.body)
      return true
    }
    if (route === 'GET /api/test/state') {
      const q = new URL(req.url, 'http://x').searchParams
      const rec = host.tests.get(q.get('roomId'))
      if (!rec) { sendJSON(req, res, 404, { ok: false, error: 'room-gone' }); return true }
      sendJSON(req, res, 200, host.snapshot(rec, Number(q.get('since') || 0)))
      return true
    }
    sendJSON(req, res, 404, { ok: false, error: 'not found' })
    return true
  } catch (err) {
    if (err && err.status) { sendJSON(req, res, err.status, { ok: false, error: err.message }); return true }
    sendJSON(req, res, 400, { ok: false, error: String(err && err.message || err) })
    return true
  }
}
