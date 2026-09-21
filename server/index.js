// GAMES 平台 server：静态托管 + 最小 API（Node 原生 http，零运行时依赖）。
// 与 GAMES-4 骨架约定对齐：端口默认 4399、/api/health → { ok: true }。
//
// 路由：
//   GET  /api/health       存活检查
//   GET  /api/games        games/ 目录扫描清单（3 秒缓存）
//   POST /api/play-events  游玩时长上报，追加写入 server/data/play-events.jsonl
//   GET  /games/*          games/ 目录原路径静态伺服（iframe 游戏入口）
//   GET  /*                前端静态：dist/（build 产物）优先，无 dist 回退 web/（dev 免构建）
//                           （WEB_DIR 环境变量可强制指定前端根，npm run dev 即此模式）
import http from 'node:http'
import { readFile, stat, mkdir, appendFile, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanGames } from './lib/scan-games.js'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const GAMES_DIR = join(ROOT, 'games')
const DIST_DIR = join(ROOT, 'dist')
const WEB_DIR = join(ROOT, 'web')
const DATA_DIR = join(ROOT, 'server', 'data')
const EVENTS_FILE = join(DATA_DIR, 'play-events.jsonl')
const PORT = Number(process.env.PORT) || 4399
const HOST = process.env.HOST || '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// ---- 工具 ----

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** 解码 + 归一化，确保解析结果落在 base 目录内（防路径穿越） */
function safeJoin(base, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const target = normalize(join(base, '.' + sep + decoded))
  const baseResolved = resolve(base)
  if (target !== baseResolved && !target.startsWith(baseResolved + sep)) return null
  return target
}

async function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function serveFile(req, res, filePath) {
  let st
  try {
    st = await stat(filePath)
  } catch {
    return false
  }
  const file = st.isDirectory() ? join(filePath, 'index.html') : filePath
  try {
    st = await stat(file)
    if (!st.isFile()) return false
  } catch {
    return false
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  const headers = {
    'Content-Type': type,
    'Content-Length': st.size,
    // 静态资源短缓存即可（个人本机开发场景，无需指纹哈希长缓存）
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
  }
  // 弱 ETag + 304（GET/HEAD）
  const etag = `W/"${st.size}-${Number(st.mtimeMs).toString(36)}"`
  headers.ETag = etag
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return true
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  return await new Promise((resolveOk) => {
    createReadStream(file)
      .on('error', () => {
        res.destroy()
        resolveOk(true) // 已 writeHead，只能断连；按“已处理”收尾
      })
      .pipe(res)
      .on('finish', () => resolveOk(true))
  })
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ---- API ----

let gamesCache = { at: 0, list: null }
async function apiGames() {
  const now = Date.now()
  if (!gamesCache.list || now - gamesCache.at > 3000) {
    gamesCache = { at: now, list: await scanGames(GAMES_DIR) }
  }
  return gamesCache.list
}

async function apiPlayEvents(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid json' })
  }
  // 兼容 sendBeacon（可能无 application/json 头）与单条/批量两种形状
  const events = Array.isArray(body.events) ? body.events : [body]
  const rows = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const { visitorId, gameId, ms, at } = ev
    if (typeof gameId !== 'string' || !gameId) continue
    rows.push(
      JSON.stringify({
        at: Number(at) || Date.now(),
        visitorId: typeof visitorId === 'string' ? visitorId : 'anonymous',
        gameId,
        ms: Number(ms) || 0,
      }),
    )
  }
  if (rows.length > 0) {
    await mkdir(DATA_DIR, { recursive: true })
    await appendFile(EVENTS_FILE, rows.join('\n') + '\n', 'utf8')
  }
  return sendJSON(res, 200, { ok: true, stored: rows.length })
}

// ---- 主处理 ----

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname

  try {
    if (path === '/api/health') {
      return sendJSON(res, 200, { ok: true, uptime: process.uptime(), now: Date.now() })
    }
    if (path === '/api/games' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJSON(res, 200, { ok: true, games: await apiGames() })
    }
    if (path === '/api/play-events' && req.method === 'POST') {
      return apiPlayEvents(req, res)
    }

    if (path.startsWith('/games/')) {
      const f = safeJoin(GAMES_DIR, path.slice('/games/'.length))
      if (f && (await serveFile(req, res, f))) return
      return sendJSON(res, 404, { ok: false, error: 'not found' })
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const webRoot = process.env.WEB_DIR
        ? join(ROOT, process.env.WEB_DIR)
        : (await exists(join(DIST_DIR, 'index.html')))
          ? DIST_DIR
          : WEB_DIR
      const f = safeJoin(webRoot, path)
      if (f && (await serveFile(req, res, f))) return
      // 回退 index.html（根路径与未知静态路径一致体验）
      if (await serveFile(req, res, join(webRoot, 'index.html'))) return
      return sendJSON(res, 404, { ok: false, error: 'not found' })
    }

    return sendJSON(res, 405, { ok: false, error: 'method not allowed' })
  } catch (err) {
    return sendJSON(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
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

server.listen(PORT, HOST, () => {
  console.log(`[games-server] http://${HOST}:${PORT}  (games: ${GAMES_DIR})`)
})
