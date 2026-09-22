// HTTP 工具：JSON 应答（压缩/ETag/304）、请求体限长读取、静态文件伺服（强缓存 + gzip/br）。
// 约定与 GAMES-4/5 骨架对齐：JSON 默认 no-store，可缓存性由调用方显式放行（如 /api/games）。
import { stat, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import zlib from 'node:zlib'

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
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
}

// 可压缩类型（文本类）；图片/字体/音视频已是压缩格式，压了白费 CPU
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest', '.xml', '.map', '.csv',
])
const COMPRESS_MIN_BYTES = 512 // 小于该值压缩收益为负（头开销+CPU），直接原样发

// 压缩档位取低质量：流式压缩在热路径上，个人本机场景带宽不缺、CPU 更贵
const GZIP = { level: 4 }
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }

/** 带状态码的业务错误（handler 统一捕转换成 JSON 应答；可携带附加响应头如 Retry-After） */
export class HttpError extends Error {
  constructor(status, message, headers = undefined) {
    super(message)
    this.status = status
    this.headers = headers
  }
}

export async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** 解码 + 归一化，确保解析结果落在 base 目录内（防路径穿越） */
export function safeJoin(base, urlPath) {
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

/** 编码协商：客户端要 br 给 br，其次 gzip，都不要返回 null */
export function negotiateEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '')
  if (/\bbr\b/.test(ae) && typeof zlib.brotliCompressSync === 'function') return 'br'
  if (/\bgzip\b/.test(ae)) return 'gzip'
  return null
}

function compressBuffer(buf, enc) {
  return enc === 'br' ? zlib.brotliCompressSync(buf, BROTLI) : zlib.gzipSync(buf, GZIP)
}

/**
 * JSON 应答。opts:
 *   - cacheControl: 覆盖默认 no-store（如 /api/games 传 public, max-age=30）
 *   - etag: 提供>则支持 If-None-Match → 304（配合 max-age 省带宽）
 *   - headers: 追加响应头（如 429 的 Retry-After）
 */
export function sendJSON(req, res, status, obj, opts = {}) {
  let out = Buffer.from(JSON.stringify(obj))
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': opts.cacheControl ?? 'no-store',
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    ...(opts.headers || {}),
  }
  const isGetHead = req.method === 'GET' || req.method === 'HEAD'
  if (opts.etag && isGetHead) {
    headers.ETag = opts.etag
    if (req.headers['if-none-match'] === opts.etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
  }
  const enc = negotiateEncoding(req)
  if (enc && out.length >= 256) {
    out = compressBuffer(out, enc)
    headers['Content-Encoding'] = enc
  }
  headers['Content-Length'] = out.length
  res.writeHead(status, headers)
  res.end(req.method === 'HEAD' ? undefined : out)
}

/** 读取请求体，超限抛 HttpError(413)。上限在调用方按语义定（JSON 1MB / 上传按配置） */
export async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new HttpError(413, `请求体超过上限（${Math.floor(limit / 1024)}KB）`)
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

/** 静态文件缓存策略：指纹资源 immutable 长缓存，html 永远新鲜，其余 ETag 协商 */
function cachePolicy(filePath, ext) {
  if (ext === '.html' || ext === '.htm') return 'no-store'
  if (filePath.includes(`${sep}assets${sep}`)) return 'public, max-age=31536000, immutable' // vite 指纹产物
  return 'no-cache'
}

/**
 * 流式应答（可选压缩）。关键点：res 'close' 时（客户端中止/关页）立即销毁全链释放 fd——
 * 此时 'finish' 永远不会来，若只等 finish 会造成 fd 永久泄漏（中止 N 个大文件下载就漏 N 个）。
 */
async function streamOut(file, res, headers, enc) {
  const source = createReadStream(file)
  const chain = [source]
  let out = source
  if (enc) {
    const t = enc === 'br' ? zlib.createBrotliCompress(BROTLI) : zlib.createGzip(GZIP)
    chain.push(t)
    out = source.pipe(t)
  }
  res.writeHead(200, headers)
  await new Promise((done) => {
    let settled = false
    const settle = () => {
      if (!settled) {
        settled = true
        done()
      }
    }
    const kill = () => {
      for (const s of chain) s.destroy()
      // 源/压缩流出错时必须主动断开 res：pipe 不会替你 end/destroy 目标，
      // 只销毁流会让应答无限挂起（客户端连状态行都收不到）
      if (!res.writableEnded) res.destroy()
      settle()
    }
    res.on('close', kill) // 正常结束后也会触发，此时流已 end，destroy 是无害幂等操作
    for (const s of chain) s.on('error', kill)
    out.pipe(res).on('finish', settle)
    res.on('error', kill)
  })
}

/**
 * 伺服静态文件（找到返回 true，未命中返回 false 交回路由层 404）。
 * 强缓存两级：/assets/ 指纹文件 immutable 一年；其余弱 ETag + 304 协商。
 * 文本类型按 Accept-Encoding 流式 gzip/brotli。
 */
export async function serveFile(req, res, filePath) {
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
  const ext = extname(file).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  const etag = `W/"${st.size}-${Number(st.mtimeMs).toString(36)}"`
  const headers = {
    'Content-Type': type,
    'Cache-Control': cachePolicy(file, ext),
    ETag: etag,
    Vary: 'Accept-Encoding', // 304 与 200 一致声明变体，避免共享缓存串编码
    'X-Content-Type-Options': 'nosniff',
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return true
  }
  const enc = req.method === 'GET' ? negotiateEncoding(req) : null
  if (enc && COMPRESSIBLE.has(ext) && st.size >= COMPRESS_MIN_BYTES) {
    headers['Content-Encoding'] = enc
    await streamOut(file, res, headers, enc)
    return true
  }
  headers['Content-Length'] = st.size
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return true
  }
  await streamOut(file, res, headers, null)
  return true
}
