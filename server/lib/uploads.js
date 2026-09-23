// 玩家上传管线：接收（zip / 单 html / multipart 表单）→ 服务端校验 → 落盘 games/_pending/<id>/
// 状态机：pending（待审）→ approve 上架 games/<type>/<slug>/ 并写入 game.json 清单 ｜ reject 驳回清理。
// 流转记录追加 server/data/uploads.jsonl（审计：谁提交了什么、何时上/驳回）。
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError, exists, safeJoin } from './http-util.js'
import { looksLikeZip, readZip } from './zip.js'
import { toTier } from './scan-games.js'

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

/** 收集已出现的非空元数据（query 或 multipart 字段），缺省键不填——避免空值覆盖另一来源的有效值 */
function readRawMeta(src) {
  const out = {}
  for (const k of ['type', 'slug', 'name', 'levels', 'tier', 'description']) {
    let v = typeof src.get === 'function' ? src.get(k) : src[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}

/** 归一化元数据：越界值收敛到默认（tier 按 D7 收口五枚举：缺省/非法收敛 normal，存量 standard 迁移 normal） */
function normalizeMeta(raw) {
  const levels = Number(raw.levels)
  return {
    type: slugify(raw.type, 'community'),
    slug: slugify(raw.slug, ''),
    name: typeof raw.name === 'string' ? raw.name.slice(0, 64) : '',
    levels: Number.isFinite(levels) && levels >= 1 ? Math.min(9999, Math.floor(levels)) : 1,
    tier: toTier(raw.tier) ?? 'normal',
    description: typeof raw.description === 'string' ? raw.description.slice(0, 256) : '',
  }
}

/** 原子写：先写临时文件再 rename 顶替。直接 writeFile 是 truncate 写，中途崩溃/磁盘满留半截 JSON */
async function writeFileAtomic(target, content) {
  const tmp = `${target}.tmp-${randomUUID().slice(0, 8)}`
  await writeFile(tmp, content)
  await rename(tmp, target)
}

// 危险 API 静态黑名单（GAMES-17 / v1 §28）：alert/prompt 打断 iframe 沉浸，
// 顶层跳转（top/parent.location、target="_top"）会把宿主页导航走——社区包必须在入口就拦下。
// 正则刻意宽松（不剥注释/字符串）：静态检查是第一道闸，绕过（拼串/eval）留给人工审核兜底。
const DANGEROUS_API_RULES = [
  { re: /\balert\s*\(/, label: 'alert(', why: '弹窗打断游戏沉浸' },
  { re: /\bprompt\s*\(/, label: 'prompt(', why: '输入弹窗打断游戏沉浸' },
  { re: /\btop\s*\.\s*location\b/, label: 'top.location', why: '顶层跳转会劫持宿主页面' },
  { re: /\bparent\s*\.\s*location\b/, label: 'parent.location', why: '父窗口跳转会劫持宿主页面' },
  { re: /\btarget\s*=\s*["']?_top\b/i, label: 'target="_top"', why: '顶层打开链接会脱离 iframe 宿主' },
]

/** 危险 API 静态扫描：html 与打包 js 逐条过黑名单，命中即 400 并给可读原因（上传者可据此改包重传） */
export function scanDangerousApi(name, text) {
  for (const rule of DANGEROUS_API_RULES) {
    if (rule.re.test(text)) {
      throw new HttpError(400, `危险 API 检查未通过：${name} 含 ${rule.label}（${rule.why}），请移除后重新上传`)
    }
  }
}

/**
 * iframe 可加载验证（静态取舍，GAMES-17 / v1 §31）：headless 浏览器对本仓过重（零依赖约束），
 * 先断言入口 html 含 <script> 可执行入口——没有任何脚本的纯静态页无法作为游戏在 iframe 里运行。
 */
export function assertExecutableEntry(name, text) {
  if (!/<script\b/i.test(text)) {
    throw new HttpError(400, `入口检查未通过：${name} 不含 <script> 可执行入口（纯静态页无法作为游戏运行）`)
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
    const rawMeta = readRawMeta(query)
    if (/^multipart\/form-data/i.test(ct)) {
      const { fields, files } = parseMultipart(body, ct)
      Object.assign(rawMeta, readRawMeta(fields)) // 非空表单字段优先于 query
      if (!files.length) throw new HttpError(400, 'multipart 表单里没有文件（需带 filename 的文件字段）')
      file = { name: files[0].filename || 'upload', data: files[0].data }
    } else if (/zip/i.test(ct) || (looksLikeZip(body) && !/html/i.test(ct))) {
      file = { name: query.get('filename') || 'upload.zip', data: body }
    } else if (/html/i.test(ct) || /<html[\s>]/i.test(body.toString('utf8'))) {
      file = { name: query.get('filename') || 'index.html', data: body }
    } else {
      throw new HttpError(415, `不支持的 Content-Type "${ct || '(空)'}"：用 text/html、application/zip 或 multipart/form-data`)
    }
    const meta = normalizeMeta(rawMeta)
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
    // 每个 html 都过结构检查（多页游戏包不能只查入口）；危险 API 扫 html 全量 + 打包 js
    //（只扫入口会被 <script src="x.js"> 转嫁绕过）；入口另加可执行断言（iframe 加载验证的静态替代）
    for (const f of files) {
      if (/\.(html?|js|mjs)$/i.test(f.path)) {
        const text = f.data.toString('utf8')
        if (/\.html?$/i.test(f.path)) validateHtml(f.path, text, scriptHosts)
        scanDangerousApi(f.path, text)
      }
    }
    const entry = files.find((f) => f.path === entryFile)
    if (entry && /\.html?$/i.test(entry.path)) assertExecutableEntry(entryFile, entry.data.toString('utf8'))

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
    await writeFileAtomic(join(dir, 'upload.json'), JSON.stringify(rec, null, 2) + '\n')
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

  /**
   * 上架：先把终版 game.json 写进待审目录（原子写），再单次 rename 整目录到 games/<type>/<slug>/。
   * 整目录 rename 同卷原子：要么完整上架要么原地未动——规避逐文件搬运在崩溃/并发下
   * 产出的半成品目录、slug-2 分裂包、两包混装。dest 被并发占位（EEXIST/ENOTEMPTY）则换后缀重试。
   */
  async function approve(id) {
    const pend = await loadPending(id)
    if (!pend) throw new HttpError(404, `上传 ${id} 不存在（可能已流转或被清理）`)
    if (pend.rec.state !== 'pending') throw new HttpError(409, `状态机拒绝：${id} 当前 ${pend.rec.state}，仅待审可上架`)
    const { rec, dir } = pend

    const type = slugify(rec.type, 'community')
    const base = slugify(rec.slug || rec.name, id)
    await mkdir(join(gamesDir, type), { recursive: true })

    // 终版清单写进待审目录（id 由目录路径推导，不写死——rename 重试换 slug 时无需回写）
    let gm = {}
    try {
      gm = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
    } catch {
      /* 上传包里没有 → 新建 */
    }
    delete gm.id // id 一律走 "<type>:<slug>" 目录推导，保证与应答一致
    gm = {
      ...gm,
      name: rec.name || gm.name || base,
      levels: rec.levels,
      tier: rec.tier,
      entry: rec.entryFile,
      uploadedAs: id, // 台账缺失时 get() 可凭此回溯末态
    }
    if (rec.description && !gm.description) gm.description = rec.description
    try {
      await writeFileAtomic(join(dir, 'game.json'), JSON.stringify(gm, null, 2) + '\n')
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(409, `状态机拒绝：${id} 已被并发流转`)
      throw e
    }

    let dest = null
    let slug = base
    for (let n = 1; n <= 100 && !dest; n++) {
      slug = n === 1 ? base : `${base}-${n}`
      const candidate = join(gamesDir, type, slug)
      if (await exists(candidate)) continue
      try {
        await rename(dir, candidate) // 原子上架
        dest = candidate
      } catch (e) {
        if (e.code === 'ENOENT') throw new HttpError(409, `状态机拒绝：${id} 已被并发流转`)
        if (e.code === 'EEXIST' || e.code === 'ENOTEMPTY' || e.code === 'EPERM') continue // 并发占位 → 换后缀
        throw e
      }
    }
    if (!dest) throw new HttpError(409, 'slug 去重 100 次未命中（同名目录堆积）')

    // rename 连 upload.json 一起带过去了：清单扫描只认 game.json，多这一个文件无害，顺手清掉；
    // 同时清并发输家/崩溃窗口可能被整目录 rename 带进来的 writeFileAtomic 残片（*.tmp-xxx）
    await rm(join(dest, 'upload.json'), { force: true }).catch(() => {})
    for (const f of await readdir(dest).catch(() => [])) {
      if (/\.tmp-[0-9a-f]+$/.test(f)) await rm(join(dest, f), { force: true }).catch(() => {})
    }
    const gameId = `${type}:${slug}`
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

  /** 台账断档兜底：上架后、写台账前崩溃 → 凭 game.json 的 uploadedAs 回溯末态 */
  async function findPublishedById(id) {
    let types = []
    try {
      types = await readdir(gamesDir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const t of types) {
      if (!t.isDirectory() || t.name.startsWith('_') || t.name.startsWith('.')) continue
      let slugs = []
      try {
        slugs = await readdir(join(gamesDir, t.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of slugs) {
        if (!s.isDirectory() || s.name.startsWith('.')) continue
        try {
          const gm = JSON.parse(await readFile(join(gamesDir, t.name, s.name, 'game.json'), 'utf8'))
          if (gm.uploadedAs === id) return { state: 'published', type: t.name, slug: s.name }
        } catch {
          /* 跳过 */
        }
      }
    }
    return null
  }

  /** 单查：优先待审目录，其次审计台账末态；台账停在 submitted 且无待审目录 → 可能是 rename 后台账前崩溃，扫清单回溯 */
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
    if (last && (last.event === 'published' || last.event === 'rejected')) {
      return { id, state: last.event, reviewedAt: last.at, type: last.type, slug: last.slug, reason: last.reason }
    }
    const published = await findPublishedById(id)
    if (published) return { id, ...published, reviewedAt: last?.at }
    if (last) return { id, state: 'lost', reviewedAt: last.at } // 提交过但包已不存（清理/孤儿）
    return null
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
