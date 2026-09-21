// GAMES 平台静态 + API 服务器（Node 原生 http，零运行时依赖）
// 高并发取向：keep-alive 长连接、brotli/gzip 压缩、强 ETag + 304、哈希资产 immutable 缓存。
//
// 端口：PORT 环境变量，默认 4399；绑定 HOST 默认 0.0.0.0（便于手机经局域网访问）。
// 注意：macOS 下 0.0.0.0 与 127.0.0.1 可同端口并存绑定，选端口须确认回环也空闲（8787 被
// studio-daemon 控制台占用回环，本机踩过：server 报 listening 但 localhost 流量被截）。
// 静态根：
//   dist/  —— web 构建产物（npm run build），未命中文件回退 index.html（SPA）
//   games/ —— 自包含游戏目录，按原路径伺服（/games/<type>/<slug>/...）
import http from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const DIST_DIR = join(ROOT, 'dist')
const GAMES_DIR = join(ROOT, 'games')
const PORT = Number(process.env.PORT) || 4399
const HOST = process.env.HOST || '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

// 可压缩类型：文本类压缩收益高；图片/字体已是压缩格式，跳过
const COMPRESSIBLE = new Set([
  'text/html', 'text/css', 'text/javascript', 'text/plain',
  'application/json', 'application/javascript', 'image/svg+xml',
])
const isCompressible = (type) => COMPRESSIBLE.has(type.split(';')[0].trim())
const typeOf = (file) => MIME[extname(file).toLowerCase()] || 'application/octet-stream'

// 压缩阈值：小于 1KB 时压缩头开销大于收益，直接原样返回
const COMPRESS_MIN_SIZE = 1024

function send(req, res, status, headers, body = null) {
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || body === null) res.end()
  else res.end(body)
}

function sendJson(req, res, status, obj) {
  send(req, res, status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, JSON.stringify(obj))
}

function sendText(req, res, status, text) {
  send(req, res, status, { 'content-type': 'text/plain; charset=utf-8' }, `${text}\n`)
}

// 解析静态路径 → 绝对文件路径；防路径穿越；目录自动找 index.html。
// 未命中：SPA 根回退到根 index.html（也不存在则 null），games 根直接 null。
async function resolveStatic(pathname, root, allowSpaFallback) {
  const decoded = decodeURIComponent(pathname)
  const clean = decoded.replace(/\/+$/, '') || '/'
  let file = resolve(root, `.${clean}`)
  if (file !== root && !file.startsWith(root + sep)) return null // 穿越企图
  const spaFallback = async () => {
    if (!allowSpaFallback) return null
    try {
      return (await stat(join(root, 'index.html'))).isFile() ? join(root, 'index.html') : null
    } catch {
      return null
    }
  }
  let st
  try {
    st = await stat(file)
  } catch {
    return spaFallback()
  }
  if (st.isDirectory()) {
    file = join(file, 'index.html')
    try {
      st = await stat(file)
    } catch {
      return spaFallback()
    }
  }
  return st.isFile() ? file : null
}

// If-None-Match 命中判断（容忍 W/ 前缀与多值列表）
function etagMatches(req, etag) {
  const inm = req.headers['if-none-match']
  if (!inm) return false
  if (inm.trim() === '*') return true
  return inm.split(',').some((raw) => raw.trim().replace(/^W\//, '') === etag)
}

// 哈希文件名的产物（Vite dist/assets/）内容寻址 → 可永久缓存；HTML 始终走 ETag 再验证
function cacheControlFor(pathname, type) {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (type.startsWith('text/html')) return 'no-cache'
  return 'no-cache'
}

async function serveFile(req, res, pathname, file) {
  const st = await stat(file)
  const type = typeOf(file)
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`
  const cacheControl = cacheControlFor(pathname, type)
  const baseHeaders = { etag, 'cache-control': cacheControl, vary: 'Accept-Encoding' }

  if (etagMatches(req, etag)) {
    return send(req, res, 304, baseHeaders)
  }

  let headers = { ...baseHeaders, 'content-type': type, 'last-modified': st.mtime.toUTCString() }

  const acceptEncoding = req.headers['accept-encoding'] || ''
  let encoding = null
  if (isCompressible(type) && st.size >= COMPRESS_MIN_SIZE && req.method !== 'HEAD') {
    if (acceptEncoding.includes('br')) encoding = 'br'
    else if (acceptEncoding.includes('gzip')) encoding = 'gzip'
  }

  // 静态文件同步压缩缓存在内存（产物文件少且小），避免每请求流式压缩的 CPU 重复开销
  if (encoding) {
    const buf = await readFile(file)
    const body = encoding === 'br' ? brotliCompressSync(buf) : gzipSync(buf)
    headers['content-encoding'] = encoding
    headers['content-length'] = body.length
    return send(req, res, 200, headers, body)
  }

  headers['content-length'] = st.size
  if (req.method === 'HEAD') return send(req, res, 200, headers)

  const stream = createReadStream(file)
  stream.on('error', () => {
    if (!res.headersSent) send(req, res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'internal error')
    else res.destroy()
  })
  res.writeHead(200, headers)
  stream.pipe(res)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url

    // ---- API ----
    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'method not allowed' })
      return send(req, res, 200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }, '{"ok":true}')
    }
    if (pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'not found' })

    // ---- 静态 ----
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(req, res, 405, 'method not allowed')
    }

    if (pathname.startsWith('/games/') || pathname === '/games') {
      // 挂载前缀 /games 剥掉后再映射进 games 根目录（否则拼成 games/games/...）
      const gamesPath = pathname.replace(/^\/games/, '') || '/'
      const file = await resolveStatic(gamesPath, GAMES_DIR, false)
      if (!file) return sendText(req, res, 404, `not found: ${pathname}`)
      return await serveFile(req, res, pathname, file)
    }

    const file = await resolveStatic(pathname, DIST_DIR, true) // SPA：未命中回退 index.html
    if (!file) return sendText(req, res, 404, 'dist 未构建：请先执行 npm run build')
    return await serveFile(req, res, pathname, file)
  } catch (err) {
    console.error('[server] request error:', err)
    if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' })
    else res.destroy()
  }
})

// 高并发取向：长 keep-alive（高于常见 LB/代理 60s 空超时，避免连接被抢先掐断）
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
server.maxRequestsPerSocket = 0 // 单连接不限请求数
server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

server.listen(PORT, HOST, () => {
  const nets = Object.values(networkInterfaces()).flat()
  const lan = nets.find((n) => n?.family === 'IPv4' && !n.internal)?.address
  console.log(`[server] GAMES server listening`)
  console.log(`[server]   local   http://localhost:${PORT}`)
  if (lan) console.log(`[server]   network http://${lan}:${PORT}  （手机同局域网访问）`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, closing`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3_000).unref()
  })
}
