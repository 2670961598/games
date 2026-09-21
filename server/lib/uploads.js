// 玩家上传管线：接收（zip / 单 html / multipart 表单）→ 服务端校验 → 落盘 games/_pending/<id>/
// 状态机：pending（待审）→ approve 上架 games/<type>/<slug>/ 并写入 game.json 清单 ｜ reject 驳回清理。
// 流转记录追加 server/data/uploads.jsonl（审计：谁提交了什么、何时上/驳回）。
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError, exists, safeJoin } from './http-util.js'
import { looksLikeZip, readZip } from './zip.js'

const MULTIPART_SLACK = 128 * 1024 // multipart 边界/头部的开销余量（请求体上限 = 文件上限 + 此值）

const SLUG_RE = /[^a-z0-9-]+/g

function slugify(s, fallback) {
  const out = String(s || '')
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return out || fallback
}

/** 提取上传元数据（query 参数或 multipart 字段），越界值收敛到默认 */
function readMeta(src) {
  const get = (k) => (typeof src.get === 'function' ? src.get(k) : src[k])
  const levels = Number(get('levels'))
  const tier = typeof get('tier') === 'string' ? get('tier').trim().slice(0, 16) : ''
  return {
    type: slugify(get('type'), 'community'),
    slug: slugify(get('slug'), ''),
    name: typeof get('name') === 'string' ? get('name').trim().slice(0, 64) : '',
    levels: Number.isFinite(levels) && levels >= 1 ? Math.min(9999, Math.floor(levels)) : 1,
    tier: tier || 'standard',
    description: typeof get('description') === 'string' ? get('description').trim().slice(0, 256) : '',
  }
}

/**
 * HTML 结构安全检查：
 *  1. 必须含 <html> 根元素（防把任意文件改后缀塞进来）
 *  2. <script src> 只允许相对路径或白名单外域（白名单默认主流公共 CDN，可用 UPLOAD_SCRIPT_HOSTS 配置）
 */
export function validateHtml(name, text, scriptHosts) {
  if (!/<html[\s>]/i.test(text)) {
    throw new HttpError(400, `HTML 结构检查未通过：${name} 缺少 <html> 根元素`)
  }
  const srcRe = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let m
  while ((m = srcRe.exec(text))) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!src) continue
    if (/^(https?:)?\/\//i.test(src)) {
      const host = src.replace(/^(https?:)?\/\//i, '').split(/[/?#]/, 1)[0].toLowerCase()
      const ok = scriptHosts.some((w) => host === w || host.endsWith('.' + w))
      if (!ok) throw new HttpError(400, `HTML 检查未通过：script src 外域 ${host} 不在白名单 ${scriptHosts.join('/')}`)
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      // 相对路径（含 /xx、./xx、../xx）→ 同源，放行
    } else {
      throw new HttpError(400, `HTML 检查未通过：script src 协议不被允许（${src.slice(0, 40)}）`)
    }
  }
}

/** 解析 multipart/form-data（浏览器表单上传）。返回 { fields, files }，结构异常抛 400 */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) throw new HttpError(400, 'multipart 请求缺少 boundary')
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim())
  const fields = {}
  const files = []
  let pos = body.indexOf(boundary)
  if (pos < 0) throw new HttpError(400, 'multipart 请求体损坏')
  pos += boundary.length
  while (pos < body.length) {
    // 结束边界 --boundary-- 或下一个 --boundary
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2
    const headEnd = body.indexOf('\r\n\r\n', pos)
    if (headEnd < 0) break
    const head = body.toString('utf8', pos, headEnd)
    const next = body.indexOf(boundary, headEnd + 4)
    const dataEnd = next < 0 ? body.length : next - 2 // 去掉紧贴边界的 \r\n
    const data = body.subarray(headEnd + 4, Math.max(headEnd + 4, dataEnd))
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head)
    if (disp) {
      const nameM = /name="([^"]*)"/i.exec(disp[1])
      const fileM = /filename="([^"]*)"/i.exec(disp[1])
      const ctM = /content-type:\s*([^\r\n;]+)/i.exec(head)
      if (fileM) files.push({ field: nameM?.[1] || '', filename: fileM[1], contentType: ctM?.[1].trim() || '', data })
      else if (nameM) fields[nameM[1]] = data.toString('utf8')
    }
    if (next < 0) break
    pos = next + boundary.length
  }
  return { fields, files }
}

/**
 * zip 条目规整：剥掉单层包裹目录（zip 整目录打包的常见形态），再定位入口 html。
 * 入口优先级：根 index.html > 根目录唯一 html > 全 zip 唯一 html（深度 ≤2）。
 */
function normalizeZipEntries(entries) {
  const segs = entries.map((e) => e.name.split('/'))
  const first = segs.map((s) => s[0]).filter(Boolean)
  if (entries.length > 1 && first.every((f) => f === first[0])) {
    // 所有条目共享同一顶层目录 → 剥掉（防止解出一层无用包裹）
    for (const e of entries) e.name = e.name.split('/').slice(1).join('/')
    entries = entries.filter((e) => e.name)
    segs.length = 0
  }
  const rootHtml = entries.filter((e) => /^index\.html?$/i.test(e.name))
  if (rootHtml.length) return { entries, entryFile: rootHtml[0].name }
  const rootAny = entries.filter((e) => /^[^/]+\.html?$/i.test(e.name))
  if (rootAny.length === 1) return { entries, entryFile: rootAny[0].name }
  const anyHtml = entries.filter((e) => e.name.split('/').length <= 3 && /\.html?$/i.test(e.name))
  if (anyHtml.length === 1) return { entries, entryFile: anyHtml[0].name }
  throw new HttpError(400, 'zip 内找不到入口 html（需根目录 index.html，或全包唯一 html）')
}

export function createUploads({
  pendingDir, // games/_pending
  gamesDir, // games
  dataDir, // server/data
  ledgerFile, // server/data/uploads.jsonl
  scriptHosts, // script src 外域白名单
  maxUploadBytes,
  onPublished, // 上架后回调（清 /api/games 缓存）
  onRejected,
}) {
  async function ledger(rec) {
    await mkdir(dataDir, { recursive: true })
    await appendFile(ledgerFile, JSON.stringify({ at: Date.now(), ...rec }) + '\n', 'utf8')
  }

  /**
   * 接收并校验一次上传，落盘待审目录。req 为 http.IncomingMessage。
   * 返回 { id }；任何校验失败抛 HttpError(4xx)。
   */
  async function save(req, query) {
    const ct = String(req.headers['content-type'] || '')
    const body = await readWithLimit(req)

    let file // { name, data }
    let meta = readMeta(query)
    if (/^multipart\/form-data/i.test(ct)) {
      const { fields, files } = parseMultipart(body, ct)
      meta = { ...meta, ...readMeta(fields) }
      if (!files.length) throw new HttpError(400, 'multipart 表单里没有文件（需带 filename 的文件字段）')
      file = { name: files[0].filename || 'upload', data: files[0].data }
    } else if (/zip/i.test(ct) || (looksLikeZip(body) && !/html/i.test(ct))) {
      file = { name: query.get('filename') || 'upload.zip', data: body }
    } else if (/html/i.test(ct) || /<html[\s>]/i.test(body.toString('utf8', 0, Math.min(2048, body.length)))) {
      file = { name: query.get('filename') || 'index.html', data: body }
    } else {
      throw new HttpError(415, `不支持的 Content-Type "${ct || '(空)'}"：用 text/html、application/zip 或 multipart/form-data`)
    }
    if (!file.data.length) throw new HttpError(400, '上传内容为空')
    if (file.data.length > maxUploadBytes) {
      throw new HttpError(413, `文件超过大小上限 ${Math.floor(maxUploadBytes / 1024 / 1024)}MB`)
    }

    // 解包 + 校验
    let files // [{ path, data }]
    let entryFile
    const isZip = looksLikeZip(file.data)
    if (isZip) {
      let entries
      try {
        entries = readZip(file.data, { maxEntries: 500, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })
      } catch (e) {
        throw new HttpError(400, e.message) // zip 结构/校验失败属客户端错误，不是服务器故障
      }
      const norm = normalizeZipEntries(entries)
      files = norm.entries.map((e) => ({ path: e.name, data: e.data }))
      entryFile = norm.entryFile
    } else {
      files = [{ path: 'index.html', data: file.data }]
      entryFile = 'index.html'
    }
    // 每个 html 都过结构检查（多页游戏包不能只查入口）
    for (const f of files) {
      if (/\.html?$/i.test(f.path)) validateHtml(f.path, f.data.toString('utf8'), scriptHosts)
    }

    // 落盘待审目录 games/_pending/<id>/
    const id = 'up-' + randomUUID().slice(0, 8)
    const dir = join(pendingDir, id)
    await mkdir(dir, { recursive: true })
    for (const f of files) {
      const target = safeJoin(dir, f.path)
      if (!target) throw new HttpError(400, `上传内含非法路径：${f.path}`)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, f.data)
    }
    const rec = { id, state: 'pending', submittedAt: Date.now(), kind: isZip ? 'zip' : 'html', filename: file.name, bytes: file.data.length, entryFile, ...meta }
    await writeFile(join(dir, 'upload.json'), JSON.stringify(rec, null, 2) + '\n')
    await ledger({ event: 'submitted', id, kind: rec.kind, filename: rec.filename, bytes: rec.bytes })
    return { id }
  }

  async function readWithLimit(req) {
    const chunks = []
    let size = 0
    const limit = maxUploadBytes + MULTIPART_SLACK
    for await (const c of req) {
      size += c.length
      if (size > limit) throw new HttpError(413, `上传超过大小上限（含表单开销 ${Math.floor(limit / 1024)}KB）`)
      chunks.push(c)
    }
    return Buffer.concat(chunks)
  }

  async function loadPending(id) {
    const dir = join(pendingDir, id)
    try {
      return { dir, rec: JSON.parse(await readFile(join(dir, 'upload.json'), 'utf8')) }
    } catch {
      return null
    }
  }

  /** 上架：移入 games/<type>/<slug>/，补写 game.json 清单，清待审目录 */
  async function approve(id) {
    const pend = await loadPending(id)
    if (!pend) throw new HttpError(404, `上传 ${id} 不存在（可能已流转或被清理）`)
    if (pend.rec.state !== 'pending') throw new HttpError(409, `状态机拒绝：${id} 当前 ${pend.rec.state}，仅待审可上架`)
    const { rec, dir } = pend

    const type = slugify(rec.type, 'community')
    let slug = slugify(rec.slug || rec.name, id)
    let n = 2
    while (n < 100 && (await exists(join(gamesDir, type, slug)))) slug = `${slugify(rec.slug || rec.name, id)}-${n++}`
    const dest = join(gamesDir, type, slug)
    await mkdir(dest, { recursive: true })

    for (const f of await readdir(dir)) {
      if (f === 'upload.json') continue
      await rename(join(dir, f), join(dest, f))
    }
    // 写入清单 game.json（已有时合并保字段，无时新建）
    let gm = {}
    try {
      gm = JSON.parse(await readFile(join(dest, 'game.json'), 'utf8'))
    } catch {
      /* 上传包里没有 → 新建 */
    }
    const gameId = `${type}:${slug}`
    gm = {
      ...gm,
      id: gameId,
      type,
      slug,
      name: rec.name || gm.name || slug,
      levels: rec.levels,
      tier: rec.tier,
      entry: rec.entryFile,
    }
    if (rec.description && !gm.description) gm.description = rec.description
    await writeFile(join(dest, 'game.json'), JSON.stringify(gm, null, 2) + '\n')
    await rm(dir, { recursive: true, force: true })
    await ledger({ event: 'published', id, type, slug, gameId })
    if (onPublished) onPublished()
    return { id, state: 'published', game: { id: gameId, type, slug, url: `/games/${type}/${slug}/${rec.entryFile}` } }
  }

  /** 驳回：清待审目录，留审计记录 */
  async function reject(id, reason) {
    const pend = await loadPending(id)
    if (!pend) throw new HttpError(404, `上传 ${id} 不存在（可能已流转或被清理）`)
    if (pend.rec.state !== 'pending') throw new HttpError(409, `状态机拒绝：${id} 当前 ${pend.rec.state}，仅待审可驳回`)
    await rm(pend.dir, { recursive: true, force: true })
    await ledger({ event: 'rejected', id, reason: String(reason || '').slice(0, 200) })
    if (onRejected) onRejected()
    return { id, state: 'rejected' }
  }

  /** 单查：优先待审目录，其次审计台账末态 */
  async function get(id) {
    const pend = await loadPending(id)
    if (pend) return pend.rec
    let last = null
    try {
      const text = await readFile(ledgerFile, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          if (r.id === id) last = r
        } catch {
          /* 跳过损坏行 */
        }
      }
    } catch {
      /* 无台账 */
    }
    if (!last) return null
    return { id, state: last.event, reviewedAt: last.at, type: last.type, slug: last.slug, reason: last.reason }
  }

  /** 待审列表（审阅 UI 用） */
  async function listPending() {
    let dirs = []
    try {
      dirs = await readdir(pendingDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const pend = await loadPending(d.name)
      if (pend && pend.rec.state === 'pending') out.push(pend.rec)
    }
    out.sort((a, b) => a.submittedAt - b.submittedAt)
    return out
  }

  return { save, approve, reject, get, listPending }
}
