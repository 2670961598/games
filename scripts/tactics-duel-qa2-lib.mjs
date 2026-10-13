/* =====================================================================
 * GAMES-123 战棋对决 QA二号 —— 公共库（零依赖 WS 客户端 / 200ms 延迟代理）
 * 复用 GAMES-48 QA2 范式（kernel/workers/GAMES-48/lib.mjs 同源）：
 *   parseFrames 取仓库 server/gateway/lib/ws.js（帧解析单一事实源）；
 *   sim 取 games/multiplayer/tactics-duel/sim.cjs（本地镜像同源引擎）。
 * ===================================================================== */
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

export const REPO = '/Volumes/BigDisk/Studio/projects/GAMES/repo'
export const EV = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-123'
export const GW_HTTP = process.env.GAMES_GW || 'http://127.0.0.1:4423'
export const GW_PORT = Number((GW_HTTP.split(':')[2]) || 4423)
const require = createRequire(import.meta.url)
const { parseFrames } = await import(`file://${REPO}/server/gateway/lib/ws.js`)
export const TD = require(`${REPO}/games/multiplayer/tactics-duel/sim.cjs`)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const now = () => Date.now()
export const quant = (arr, q) => {
  if (!arr.length) return null
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))]
}
export const sum = (a) => a.reduce((x, y) => x + y, 0)

/* ---------- 客户端→服务端帧编码（RFC6455 §5.3 掩码） ---------- */
export function maskFrame(opcode, payload) {
  const mask = randomBytes(4)
  const len = payload.length
  let head
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2) }
  head[0] = 0x80 | opcode
  const out = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, out])
}

/* ---------- 最小 WS 客户端（与网关自研服务端互操作；localhost） ---------- */
export class WsClient extends EventEmitter {
  constructor() { super(); this.buf = Buffer.alloc(0); this.handshook = false; this.closed = false; this.lastInAt = now(); this.inCount = 0 }
  connect(port, host = '127.0.0.1', timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (!this.handshook) { this.sock?.destroy(); reject(new Error('ws handshake timeout')) } }, timeoutMs)
      this.sock = net.connect(port, host)
      this.sock.setNoDelay(true)
      const key = randomBytes(16).toString('base64')
      this.sock.once('connect', () => this.sock.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
      this.sock.on('data', (d) => {
        if (!this.handshook) {
          this.buf = Buffer.concat([this.buf, d])
          const idx = this.buf.indexOf('\r\n\r\n')
          if (idx < 0) return
          const head = this.buf.subarray(0, idx).toString('utf8')
          if (!/^HTTP\/1\.1 101/.test(head)) { clearTimeout(timer); this.sock.destroy(); reject(new Error('ws handshake rejected: ' + head.split('\r\n')[0])); return }
          this.handshook = true
          clearTimeout(timer)
          const rest = this.buf.subarray(idx + 4); this.buf = Buffer.alloc(0)
          if (rest.length) this.onData(rest)
          this.sock.on('close', () => { this.closed = true; this.emit('close') })
          this.sock.on('error', (e) => { if (!this.closed) { this.closed = true; this.emit('error', e) } })
          resolve(this)
          return
        }
        this.onData(d)
      })
      this.sock.once('error', (e) => { clearTimeout(timer); if (!this.handshook) reject(e) })
    })
  }
  onData(d) {
    let frames
    try { [frames, this.buf] = parseFrames(Buffer.concat([this.buf, d])) } catch (e) { this.sock.destroy(); this.emit('error', e); return }
    for (const f of frames) {
      if (f.opcode === 0x8) { try { this.sock.end() } catch { /* 已断 */ }; this.closed = true; this.emit('close'); return }
      if (f.opcode === 0x1) { this.inCount++; this.lastInAt = now(); try { this.emit('message', JSON.parse(f.payload.toString('utf8'))) } catch { /* 非 JSON 忽略 */ } }
    }
  }
  send(obj) { if (!this.closed && this.handshook) try { this.sock.write(maskFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'))) } catch { /* 已断 */ } }
  closeHard() { this.closed = true; try { this.sock.destroy() } catch { /* 已断 */ } }
}

/* ---------- 单向延迟代理：listenPort → upstreamPort，每方向固定 delayMs ---------- */
export function startDelayProxy({ listenPort, upstreamPort, delayMs = 100 }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((csock) => {
      csock.setNoDelay(true); csock.pause()
      const usock = net.connect(upstreamPort, '127.0.0.1')
      usock.setNoDelay(true)
      usock.once('connect', () => csock.resume())
      const kill = () => { try { csock.destroy() } catch { /* 已断 */ } try { usock.destroy() } catch { /* 已断 */ } }
      csock.on('data', (d) => setTimeout(() => { try { usock.write(d) } catch { kill() } }, delayMs))
      usock.on('data', (d) => setTimeout(() => { try { csock.write(d) } catch { kill() } }, delayMs))
      csock.on('close', kill); usock.on('close', kill)
      csock.on('error', kill); usock.on('error', kill)
    })
    server.on('error', reject)
    server.listen(listenPort, '127.0.0.1', () => resolve(server))
  })
}

/* ---------- 网关 HTTP 小客户端 ---------- */
export async function gw(method, path, body) {
  const res = await fetch(GW_HTTP + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

/* ---------- 战棋驱动：join → deploy → 逐回合 act/endTurn（确定性择路） ---------- */
export class TdDriver {
  constructor(ws, name, { actDelayMs = 400 } = {}) {
    this.ws = ws; this.name = name; this.actDelayMs = actDelayMs
    this.seat = -1; this.role = null; this.welcome = null
    this.view = null; this.ended = null; this.rejections = []
    this.confirms = []       // {k, ms} op→ruling 往返
    this.turns = []          // 收到的 ruling turn 序列（交替性观察）
    this.timeoutTurns = []   // {seat}
    this.errors = []
    this.opsSent = 0
    this.pending = null      // {k, at, resolve}
    ws.on('message', (m) => this.onMsg(m))
    ws.on('error', (e) => this.errors.push(String(e && e.message || e)))
  }
  onMsg(m) {
    if (m.t === 'welcome') { this.welcome = m; this.seat = m.seat; this.role = m.role; this.view = m.state; return }
    if (m.t === 'ruling') {
      if (this.pending && (m.events || []).some((e) => e.k !== 'reveal' || true)) {
        // ruling 即本回合权威回执（含 reject）；对亲自发出的 op 计确认时延
        if (this.pending) { this.confirms.push({ k: this.pending.k, ms: now() - this.pending.at }); this.pending = null }
      }
      this.view = m.state
      this.turns.push(m.turn)
      for (const e of m.events || []) {
        if (e.k === 'reject') this.rejections.push(e)
        if (e.k === 'timeout-turn') this.timeoutTurns.push({ seat: e.seat, mine: e.seat === this.seat })
      }
      return
    }
    if (m.t === 'end') { this.ended = m; return }
    if (m.t === 'started') { this.view = m.state; return }
    if (m.t === 'error') this.errors.push(m.code + ':' + (m.message || ''))
  }
  sendOp(op) {
    this.opsSent++
    this.lastOp = { k: op.k, at: now() }
    this.pending = { k: op.k, at: now() }
    this.ws.send(Object.assign({ t: 'op' }, op))
  }
  /* 我方部署 T0 模板（cells 为 seat 侧常量，无需视野） */
  deploy() {
    this.sendOp({ k: 'deploy', cells: TD.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: TD.TEMPLATES[0][i][this.seat] })) })
  }
  /* 视图回合字段：个性化视图用 turn（viewFor），canonical 用 turnSeat（测试面）——双形兼容 */
  turnOf(v) { return v && (v.turn !== undefined ? v.turn : v.turnSeat) }
  /* 轮到我时行动一步：优先移动首个 idle 单位（本地镜像同源 reach 在个性化视图上计算），否则 endTurn */
  actOnce() {
    const v = this.view
    if (!v || v.phase !== 'act' || this.turnOf(v) !== this.seat) return false
    if (v.ap > 0) {
      const u = (v.units || []).find((x) => x.seat === this.seat && x.ph === 'idle')
      if (u) {
        try {
          const m = TD.reach(v, u.id).filter((r) => r.path.length > 1)[0]
          if (m) { this.sendOp({ k: 'move', unit: u.id, path: m.path }); return true }
        } catch { /* 视图受限时 reach 失败 → endTurn 兜底 */ }
      }
    }
    this.sendOp({ k: 'endTurn' })
    return true
  }
  get myTurn() { const v = this.view; return !!(v && v.phase === 'act' && this.turnOf(v) === this.seat) }
  get deployPending() { const v = this.view; return !!(v && v.phase === 'deploy' && !(v.deployDone || [])[this.seat]) }
}

/* ---------- 大厅 feed：挑一张本作纯 bot 房 ---------- */
export async function pickBotRoom() {
  const r = await gw('GET', '/api/matches')
  const ms = (r.json && r.json.matches || []).filter((m) => m.gameId === 'tactics-duel' && m.humans === 0 && m.joinable)
  ms.sort((a, b) => a.elapsedMs - b.elapsedMs)
  return ms[0] || null
}

/* ---------- 证据落盘 ---------- */
export function evidence(name, obj) {
  mkdirSync(EV, { recursive: true })
  const p = `${EV}/${name}`
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
  console.log(`[evidence] ${p}`)
}

/* ---------- 断言小件 ---------- */
export function makeOk() {
  let passed = 0, failed = 0
  const ok = (cond, name, detail = '') => {
    if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
    else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
  }
  return { ok, done: () => [passed, failed] }
}
