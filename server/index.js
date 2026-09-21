// GAMES 平台 server：静态托管 + 游戏/统计/上传全量 API（Node 原生 http，零运行时依赖）。
// 与 GAMES-4/5 骨架约定对齐：端口默认 4399、/api/health → { ok: true }、games/<type>/<slug>/ 清单扫描。
//
// 路由：
//   GET  /api/health                  存活检查
//   GET  /api/games?page&pageSize&seed&type  游戏大全（分页 + seed 洗牌袋；短 max-age 可缓存）
//   POST /api/upload                  玩家上传（zip/单 html/multipart；限速每 IP 10 次/分钟）
//   GET  /api/uploads                 待审列表 ｜ GET /api/uploads/<id> 单查状态
//   POST /api/uploads/<id>/approve    待审 → 上架（移入 games/ 并写清单）
//   POST /api/uploads/<id>/reject     待审 → 驳回（body 可带 { reason }）
//   POST /api/stats                   时长上报 { visitorId, gameId, seconds } 或 { events: [...] }
//                                     （别名 /api/play-events 兼容 GAMES-5 前端 sendBeacon，ms 字段自动换算）
//   GET  /api/stats/<visitorId>       玩过列表 + 累计时长
//   GET  /games/*                     games/ 目录静态伺服（iframe 游戏入口）
//   GET  /*                           前端静态：WEB_DIR 强制 > dist/ > web/
//
// 性能：keep-alive 65s、文本响应 gzip/br、静态指纹资源 immutable 长缓存、其余 ETag+304、
//       /api/games 结果 3s 内存缓存 + public max-age=30。压测见 README（scripts/bench-api.js）。
// 安全口径：全站不输出任何 CORS 头，且 Origin 与 Host 不一致的请求直接 403（仅同源）。
import http from 'node:http'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, readBody, safeJoin, sendJSON, serveFile, HttpError } from './lib/http-util.js'
import { scanGames } from './lib/scan-games.js'
import { seededShuffle } from './lib/shuffle.js'
import { createRateLimiter } from './lib/ratelimit.js'
import { createStats } from './lib/stats.js'
import { createUploads } from './lib/uploads.js'
import { crc32 } from './lib/zip.js'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const GAMES_DIR = process.env.GAMES_DIR || join(ROOT, 'games')
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'server', 'data')
const DIST_DIR = join(ROOT, 'dist')
const WEB_DIR = join(ROOT, 'web')
const PENDING_DIR = join(GAMES_DIR, '_pending')
const LEDGER_FILE = join(DATA_DIR, 'uploads.jsonl')
const EVENTS_FILE = join(DATA_DIR, 'play-events.jsonl')
const PORT = Number(process.env.PORT) || 4399
const HOST = process.env.HOST || '127.0.0.1'

const UPLOAD_MAX_BYTES = (Number(process.env.UPLOAD_MAX_MB) || 2) * 1024 * 1024
const UPLOAD_RATE_PER_MIN = Number(process.env.UPLOAD_RATE_PER_MIN) || 10
const SCRIPT_HOSTS = (process.env.UPLOAD_SCRIPT_HOSTS || 'cdn.jsdelivr.net,unpkg.com,cdnjs.cloudflare.com,esm.sh')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const JSON_BODY_LIMIT = 1024 * 1024
const GAMES_CACHE_MS = 3000
const GAMES_MAX_PAGE_SIZE = 100
const VISITOR_RE = /^[A-Za-z0-9._:-]{1,64}$/

const stats = createStats({ dir: DATA_DIR, file: EVENTS_FILE })
const uploadLimiter = createRateLimiter({ windowMs: 60_000, max: UPLOAD_RATE_PER_MIN })
const uploads = createUploads({
  pendingDir: PENDING_DIR,
  gamesDir: GAMES_DIR,
  dataDir: DATA_DIR,
  ledgerFile: LEDGER_FILE,
  scriptHosts: SCRIPT_HOSTS,
  maxUploadBytes: UPLOAD_MAX_BYTES,
  onPublished: invalidateGames,
  onRejected: invalidateGames,
})

// ---- /api/games 清单缓存（上架/驳回即时失效，平时 3s 短缓存防扫描风暴） ----
let gamesCache = { at: 0, list: null }
async function gamesList() {
  if (!gamesCache.list || Date.now() - gamesCache.at > GAMES_CACHE_MS) {
    gamesCache = { at: Date.now(), list: await scanGames(GAMES_DIR) }
  }
  return gamesCache.list
}
function invalidateGames() {
  gamesCache = { at: 0, list: null }
}

/** 跨域关闭：Origin 与 Host 不一致（或 Origin 解析失败）一律 403，且全站从不输出 CORS 头 */
function crossOriginDenied(req) {
  const origin = req.headers.origin
  if (!origin) return false
  try {
    const o = new URL(origin)
    return o.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()
  } catch {
    return true
  }
}

function clientIP(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

// ---- API handlers ----

function intParam(sp, name, { min, max, def }) {
  const raw = sp.get(name)
  if (raw === null || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `参数 ${name} 非法（需 ${min}~${max} 的整数）`)
  }
  return n
}

async function apiGames(req, res, u) {
  const sp = u.searchParams
  const page = intParam(sp, 'page', { min: 1, max: 1_000_000, def: 1 })
  const pageSize = intParam(sp, 'pageSize', { min: 1, max: GAMES_MAX_PAGE_SIZE, def: 20 })
  const seed = sp.get('seed') || ''
  if (seed.length > 64) throw new HttpError(400, '参数 seed 过长（≤64 字符）')
  const type = sp.get('type') || ''

  let list = await gamesList()
  if (type) list = list.filter((g) => g.type === type)
  if (seed) list = seededShuffle(list, seed) // 洗牌袋：同 seed 稳定全排列，翻页不乱序
  const total = list.length
  const start = (page - 1) * pageSize
  const body = {
    ok: true,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    games: list.slice(start, start + pageSize),
  }
  // 短缓存 + ETag 304：列表页高频轮询打到 CDN/浏览器，穿透到扫描的只剩 miss
  const s = JSON.stringify(body)
  const etag = `W/"g-${total}-${crc32(Buffer.from(s)).toString(36)}"`
  sendJSON(req, res, 200, body, { cacheControl: 'public, max-age=30', etag })
}

async function apiUploadPost(req, res) {
  const rl = uploadLimiter(clientIP(req))
  if (!rl.allowed) {
    throw new HttpError(429, `上传限速：每 IP 每分钟 ${UPLOAD_RATE_PER_MIN} 次，请 ${rl.retryAfterSec}s 后再试`, {
      'Retry-After': String(rl.retryAfterSec),
    })
  }
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const { id } = await uploads.save(req, u.searchParams)
  sendJSON(req, res, 201, { ok: true, id, state: 'pending' })
}

async function apiStatsPost(req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req, JSON_BODY_LIMIT)).toString('utf8'))
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  // 单条 / 批量两种形状都收（sendBeacon 批量省请求）
  const events = Array.isArray(body && body.events) ? body.events : [body]
  const rows = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    if (typeof ev.gameId !== 'string' || !ev.gameId || ev.gameId.length > 128) continue
    const visitorId = typeof ev.visitorId === 'string' && VISITOR_RE.test(ev.visitorId) ? ev.visitorId : 'anonymous'
    let s = Number(ev.seconds)
    if (!Number.isFinite(s) || s < 0) s = Number(ev.ms) > 0 ? Number(ev.ms) / 1000 : 0 // GAMES-5 兼容
    rows.push({
      at: Number(ev.at) > 0 ? Number(ev.at) : Date.now(),
      visitorId,
      gameId: ev.gameId,
      s: Math.min(s, 604800), // 单条封顶一周，防脏数据撑爆聚合
    })
  }
  const stored = await stats.record(rows)
  sendJSON(req, res, 200, { ok: true, stored })
}

async function apiStatsGet(req, res, visitorIdRaw) {
  let vid
  try {
    vid = decodeURIComponent(visitorIdRaw)
  } catch {
    throw new HttpError(400, 'visitorId 编码非法')
  }
  if (!VISITOR_RE.test(vid)) throw new HttpError(400, 'visitorId 非法（[A-Za-z0-9._:-]{1,64}）')
  const r = await stats.summary(vid)
  sendJSON(req, res, 200, { ok: true, ...r })
}

// ---- 主处理 ----

async function handler(req, res) {
  let u
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    return sendJSON(req, res, 400, { ok: false, error: 'malformed url' })
  }
  const path = u.pathname

  try {
    if (crossOriginDenied(req)) {
      return sendJSON(req, res, 403, { ok: false, error: 'cross-origin request denied' })
    }

    if (path === '/api/health') {
      return sendJSON(req, res, 200, { ok: true, uptime: process.uptime(), now: Date.now() })
    }
    if (path === '/api/games' && (req.method === 'GET' || req.method === 'HEAD')) {
      return await apiGames(req, res, u)
    }
    if (path === '/api/upload' && req.method === 'POST') {
      return await apiUploadPost(req, res)
    }
    if (path === '/api/stats' && req.method === 'POST') {
      return await apiStatsPost(req, res)
    }
    if (path === '/api/play-events' && req.method === 'POST') {
      return await apiStatsPost(req, res) // GAMES-5 sendBeacon 别名，同一存储
    }
    let m
    if ((m = /^\/api\/stats\/([^/]+)$/.exec(path)) && (req.method === 'GET' || req.method === 'HEAD')) {
      return await apiStatsGet(req, res, m[1])
    }
    if (path === '/api/uploads' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJSON(req, res, 200, { ok: true, pending: await uploads.listPending() })
    }
    if ((m = /^\/api\/uploads\/([a-z0-9-]+)$/.exec(path)) && req.method === 'GET') {
      const rec = await uploads.get(m[1])
      if (!rec) return sendJSON(req, res, 404, { ok: false, error: 'upload not found' })
      return sendJSON(req, res, 200, { ok: true, upload: rec })
    }
    if ((m = /^\/api\/uploads\/([a-z0-9-]+)\/(approve|reject)$/.exec(path)) && req.method === 'POST') {
      let reason = ''
      if (m[2] === 'reject') {
        try {
          const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
          if (body && typeof body.reason === 'string') reason = body.reason
        } catch {
          /* body 可省略/reason 可选 */
        }
      }
      const r = m[2] === 'approve' ? await uploads.approve(m[1]) : await uploads.reject(m[1], reason)
      return sendJSON(req, res, 200, { ok: true, ...r })
    }

    // 游戏静态资源（iframe 入口）：games/ 原路径伺服
    if (path.startsWith('/games/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJSON(req, res, 405, { ok: false, error: 'method not allowed' })
      }
      const f = safeJoin(GAMES_DIR, path.slice('/games/'.length))
      if (f && (await serveFile(req, res, f))) return
      return sendJSON(req, res, 404, { ok: false, error: 'not found' })
    }

    // 未知 /api/* 按 JSON 404（不能落进 SPA 回退，否则前端 res.json() 拿到 html 报 SyntaxError 掩盖真因）
    if (path.startsWith('/api/')) {
      return sendJSON(req, res, 404, { ok: false, error: 'not found' })
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const webRoot = process.env.WEB_DIR
        ? join(ROOT, process.env.WEB_DIR)
        : (await exists(join(DIST_DIR, 'index.html')))
          ? DIST_DIR
          : WEB_DIR
      const f = safeJoin(webRoot, path)
      if (f && (await serveFile(req, res, f))) return
      if (!extname(path)) {
        if (await serveFile(req, res, join(webRoot, 'index.html'))) return
      }
      return sendJSON(req, res, 404, { ok: false, error: 'not found' })
    }

    return sendJSON(req, res, 405, { ok: false, error: 'method not allowed' })
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJSON(req, res, err.status, { ok: false, error: err.message }, { headers: err.headers })
    }
    if (err && err.code === 'EPIPE') return // 客户端断连，无需应答
    return sendJSON(req, res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
  }
}

const server = http.createServer((req, res) => {
  handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    try {
      res.end(JSON.stringify({ ok: false, error: 'internal' }))
    } catch {
      /* 连接已断 */
    }
  })
})

// 高并发：拉长 keep-alive（默认 5s 太短，浏览器复用连接会频繁被砍）
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
server.maxRequestsPerSocket = 0 // 不限（个人本机无慢速攻击面）

// 非法请求（如 URL 未转义中文被 llhttp 拒收）礼貌回 400，而不是静默断连难排查
server.on('clientError', (err, socket) => {
  if (socket.writable && err && err.code !== 'ECONNRESET') {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\nContent-Length: 45\r\n\r\n{"ok":false,"error":"malformed http request"}')
  } else {
    socket.destroy()
  }
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[games-server] 端口 ${PORT} 已被占用（HOST=${HOST}）：可能已有实例在跑；换端口请用 PORT=xxxx`)
  } else {
    console.error('[games-server] 启动失败:', err)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[games-server] http://${HOST}:${PORT}  (games: ${GAMES_DIR})`)
  console.log(`[games-server] 上传：≤${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)}MB，每 IP ${UPLOAD_RATE_PER_MIN} 次/分钟，script 白名单: ${SCRIPT_HOSTS.join(',')}`)
})
