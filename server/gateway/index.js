/* =====================================================================
 * 联机实时网关（GAMES-40 · E6/M0）——独立进程 :4400，与 :4399 完全隔离
 * （绝不触碰/重启 :4399；两进程互不依赖）。
 *
 *   HTTP  GET /healthz     → {ok:true}（验活）
 *         GET /api/matches → live 房间 feed（CORS *，大厅跨端口轮询）
 *         /api/test/*      → 测试管理 API（GAMES-41，仅 127.0.0.1；协议 §8）
 *   WS    upgrade 任意路径（约定 /ws）→ 房间协议（docs/net-protocol.md）
 *
 * 组成：lib/ws.js（自研最小 RFC6455，零新依赖）+ rooms.js（房间管理）
 *      + bothost.js（Bot 宿主，常驻 bot 房）+ sims/（每游戏 sim 适配器）
 *      + testapi.js（测试管理 API：隔离测试房/操作注入/状态快照）。
 * 启动（docs/net-protocol.md §9 附录）：
 *   HOST=0.0.0.0 nohup node server/gateway/index.js > server/data/gateway.log 2>&1 &
 * ===================================================================== */
import http from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomManager } from './rooms.js'
import { BotHost } from './bothost.js'
import { netTankSim } from './sims/net-tank.js'
import { slgBattlefieldSim } from './sims/slg-battlefield.js'
import { mmoTownshipSim } from './sims/mmo-township.js'
import { empireSproutSim } from './sims/empire-sprout.js'
import { poolPhysicsSim } from './sims/pool-physics.js'
import { elementDuelSim } from './sims/element-duel.js'
import { snakeKingSim } from './sims/snake-king.js'
import { speedKartSim } from './sims/speed-kart.js'
import { tacticsDuelSim } from './sims/tactics-duel.js'
import { miniMobaSim } from './sims/mini-moba.js'
import { streetSoccerSim } from './sims/street-soccer.js'
import { ironTorrentSim } from './sims/iron-torrent.js'
import { yiPavilionSim } from './sims/yi-pavilion.js'
import { deepFoodchainSim } from './sims/deep-foodchain.js'
import { attachWs } from './lib/ws.js'
import { TestHost, handleTestApi, isLoopback } from './testapi.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.PORT) || 4400
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = join(ROOT, 'server', 'data')
const LOG_FILE = process.env.GATEWAY_LOG || join(DATA_DIR, 'gateway.log')
const PID_FILE = process.env.GATEWAY_PID || join(DATA_DIR, 'gateway.pid') // 测试子进程经 GATEWAY_PID 改道，防覆盖常驻实例的 pid 文件
const TICKER_MS = 50           // 全局驱动精度；房间自身按 tickMs(100ms) 定频
const MAX_MSG_BYTES = 16 * 1024

/* ---------- JSONL 日志（房间生命周期/连接/错误；一行一 JSON） ---------- */
mkdirSync(DATA_DIR, { recursive: true })
const logOut = process.stdout // nohup 重定向到 gateway.log；stdout 仍打一份便于前台调试
function log(obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj })
  logOut.write(line + '\n')
}

/* ---------- 房间管理 + Bot 宿主 ---------- */
const rooms = new RoomManager({ log })
rooms.register(netTankSim)
rooms.register(slgBattlefieldSim)
rooms.register(mmoTownshipSim)
rooms.register(empireSproutSim) // S3 混合同步首证（GAMES-68）
rooms.register(poolPhysicsSim)  // S4 服务端权威物理首证（GAMES-78）
rooms.register(elementDuelSim)  // S5 回合权威本格首证（GAMES-88）
rooms.register(snakeKingSim)    // S6 海量实体首证（GAMES-99，设计 §5.7）
rooms.register(speedKartSim)    // S7 预测与和解首证（GAMES-109，设计 §5.1）
rooms.register(tacticsDuelSim)  // S1+S5 双技术复用首款（GAMES-118，设计 §5）
rooms.register(miniMobaSim)     // S2 状态同步第二款（GAMES-127，设计 §5 战场节奏×小镇管线）
rooms.register(streetSoccerSim) // S3+S4 双技术复用第三款（GAMES-138，设计 §5.1 单流双域+持球权桥）
rooms.register(ironTorrentSim) // S4 预测弹道第二款（GAMES-146，设计 §5.1 连续预测+离散段重演组合）
rooms.register(yiPavilionSim)  // S5 回合权威第三证（GAMES-155，设计 §5 多规则集统一表达）
rooms.register(deepFoodchainSim) // S6 海量实体第二证（GAMES-164：吞噬成长链+体型分级 AOI，设计 §5.7）

const bothost = new BotHost({ rooms, log })
bothost.register({ gameId: 'net-tank', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 })
bothost.register({ gameId: 'slg-battlefield', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 上线节奏同 net-tank（设计 §8）
bothost.register({ gameId: 'mmo-township', minLive: 1, levels: ['balanced', 'casual'], maxRooms: 1, residents: true }) // 常驻镇 1 个：居民动态调节（GAMES-52 §8）
bothost.register({ gameId: 'empire-sprout', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual+balanced；设计 §7）
bothost.register({ gameId: 'pool-physics', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual+balanced；设计 §7/§5.5）
bothost.register({ gameId: 'element-duel', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual+balanced；设计 §7 房间参数）
bothost.register({ gameId: 'snake-king', minLive: 2, levels: ['casual', 'balanced', 'competitive'], maxRooms: 2, swarm: 20 }) // 常驻巨房 2（casual 房+混编房，实体目标 20；设计 §5.7/§4.1）
bothost.register({ gameId: 'speed-kart', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual 房+混编房，t-bay 轮换；设计 §5.8）
bothost.register({ gameId: 'tactics-duel', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual+balanced；设计 §7 房间参数，终局 3s 补房）
bothost.register({ gameId: 'mini-moba', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual+balanced；设计 §7 房间参数）
bothost.register({ gameId: 'street-soccer', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（casual+balanced；设计 §7 房间参数，终局 3s 补房）
bothost.register({ gameId: 'iron-torrent', minLive: 2, levels: ['casual', 'balanced'], maxRooms: 4 }) // 常驻房 2（设计 §7：casual+balanced，终局 3s 补房，上限 4 房）
bothost.register({ gameId: 'yi-pavilion', minLive: 1, levels: ['casual', 'balanced'], maxRooms: 6, rules: ['gomoku', 'reversi', 'cascade'] }) // 多规则常驻房 3（设计 §7：每模式各一 casual，终局 3s 补房、上限 6 房）
bothost.register({ gameId: 'deep-foodchain', minLive: 2, levels: ['casual', 'balanced', 'competitive'], maxRooms: 2, swarm: 20 }) // 常驻巨房 2（casual 房+混编房，实体目标 20；设计 §5.8——deep- 前缀 feed 排首）
rooms.onEnded = () => bothost.ensure()

const testHost = new TestHost({ rooms, log })

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url.startsWith('/api/test/')) {
    // 测试面唯一鉴权：仅回环可用（局域网/公网 403；无 CORS 头，浏览器打不进来）——协议 §8
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'local-only' }))
      return
    }
    handleTestApi(req, res, url, testHost)
    return
  }
  if (req.method === 'GET' && (url === '/healthz' || url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, ts: Date.now(), rooms: rooms.rooms.size }))
    return
  }
  if (req.method === 'GET' && url === '/api/matches') {
    const body = JSON.stringify({ ok: true, serverTime: Date.now(), matches: rooms.matches() })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*', // 大厅（:4399）跨端口拉取（协议 §1）
      'Cache-Control': 'no-store',
    })
    res.end(body)
    return
  }
  if (req.method === 'OPTIONS' && url === '/api/matches') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
})

/* ---------- WS 会话 ---------- */
function makeCtx(conn) {
  return { conn, room: null, seat: -1, role: null }
}

attachWs(server, (conn, req) => {
  const ctx = makeCtx(conn)
  rooms.attach(ctx)
  log({ k: 'ws-open', from: req.socket.remoteAddress })

  conn.on('message', (text) => {
    if (text.length > MAX_MSG_BYTES) { conn.send(JSON.stringify({ t: 'error', code: 'bad-msg', message: 'too large' })); return }
    let msg
    try { msg = JSON.parse(text) } catch { conn.send(JSON.stringify({ t: 'error', code: 'bad-msg', message: 'invalid json' })); return }
    if (!msg || typeof msg.t !== 'string') { conn.send(JSON.stringify({ t: 'error', code: 'bad-msg', message: 'missing t' })); return }

    switch (msg.t) {
      case 'hello':
        if (msg.v !== 1) conn.send(JSON.stringify({ t: 'error', code: 'version', message: 'supported: 1' }))
        break
      case 'ping':
        conn.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }))
        break
      case 'join': {
        if (typeof msg.roomId !== 'string') { conn.send(JSON.stringify({ t: 'error', code: 'bad-msg', message: 'roomId required' })); break }
        const r = rooms.join(ctx, { roomId: msg.roomId, mode: msg.mode, resume: msg.resume, name: typeof msg.name === 'string' ? msg.name.slice(0, 12) : undefined })
        if (r && r.error) conn.send(JSON.stringify({ t: 'error', code: r.error, message: r.error }))
        break
      }
      case 'quick': {
        const r = rooms.quick(ctx, { gameId: msg.gameId, maxTicks: msg.maxTicks, rule: typeof msg.rule === 'string' ? msg.rule : undefined })
        if (r && r.error) conn.send(JSON.stringify({ t: 'error', code: r.error, message: r.error }))
        break
      }
      case 'input':
        rooms.input(ctx, msg)
        break
      case 'op': // S4+ 一次性指令通道（协议 §6 S5 预留位：shot/place/concede，GAMES-78 首证）
        rooms.op(ctx, msg)
        break
      case 'sync': {
        // 客户端缺帧自救：全量重同步（协议 §4.1）。
        // S2 状态同步游戏（GAMES-52）：sim.onSync 立即回一张全量快照（快照流续接）；
        // S1 帧同步游戏沿用全量 state 消息（重连重演基准）。
        if (ctx.room && ctx.room.sim.onSync) ctx.room.sim.onSync(ctx.room, ctx)
        else if (ctx.room) conn.send(JSON.stringify({ t: 'state', frame: ctx.room.frame, state: ctx.room.state }))
        break
      }
      case 'leave':
        rooms.leave(ctx)
        break
      default:
        conn.send(JSON.stringify({ t: 'error', code: 'bad-msg', message: `unknown t: ${msg.t}` }))
    }
  })

  conn.on('close', () => {
    rooms.detach(ctx)
    log({ k: 'ws-close' })
  })
})

/* ---------- 全局帧驱动 ---------- */
const ticker = setInterval(() => rooms.tickAll(Date.now()), TICKER_MS)

/* ---------- 启动/停机 ---------- */
writeFileSync(PID_FILE, String(process.pid))
server.listen(PORT, HOST, () => {
  log({ k: 'gateway-up', port: PORT, host: HOST, pid: process.pid })
  bothost.start(3000)
})

function shutdown(sig) {
  log({ k: 'gateway-down', sig })
  bothost.stop()
  clearInterval(ticker)
  for (const room of [...rooms.rooms.values()]) rooms.dispose(room, 'shutdown')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (err) => log({ k: 'uncaught', error: String(err && err.stack || err) }))
