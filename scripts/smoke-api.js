#!/usr/bin/env node
// GAMES-6 冻结验收：node scripts/smoke-api.js
// 用临时目录（GAMES_DIR/DATA_DIR 环境变量重定向）+ 随机端口起真实 server 进程，
// 断言：/api/health、/api/games 200 且结构正确、上传测试 html 走通 待审→上架→出现在 /api/games，
// 外加 seed 洗牌/分页/zip/multipart/驳回/校验拒绝（含 GAMES-17 危险 API 静态检查 + 可执行入口断言）
// /统计/跨域关闭/限速/压缩/缓存。
// 全程不触碰仓库真实数据；finally 清理临时目录与子进程。绿 = exit 0。
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { crc32 } from '../server/lib/zip.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 44000 + Math.floor(Math.random() * 10000)
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0
function ok(cond, label, extra) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}${extra !== undefined ? '  →  ' + extra : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 裸 http 请求（不用 fetch：要精确控制 Accept-Encoding/Origin 头，且无自动解压干扰断言） */
function req(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    r.setTimeout(15_000, () => r.destroy(new Error('request timeout')))
    r.on('error', reject)
    r.end(body || undefined)
  })
}
const json = (r) => {
  try {
    return JSON.parse(r.body.toString('utf8'))
  } catch {
    return null
  }
}

// ---- 测试素材 ----

/** 上传用测试 html（pad 过 512B，顺带覆盖静态压缩路径）。恒带内联入口脚本——GAMES-17 起
 *  入口 html 必须含 <script> 可执行入口；inline 参数用于注入危险 API 负例代码 */
function gameHtml(title, scriptSrc, inline) {
  const pad = `<!-- ${'smoke-padding-'.repeat(48)} -->`
  const script = scriptSrc ? `<script src="${scriptSrc}"></script>` : ''
  const code = `<script>${inline || '/* smoke entry */'}</script>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><canvas id="c"></canvas>${script}${code}${pad}</body></html>`
}

/** 构造 stored/deflate 混合 zip（不依赖系统 zip 命令，跨环境可重复） */
function makeZip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    const method = e.deflate ? 8 : 0
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x0800, 6)
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0x2a21, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(name.length, 26)
    local.push(lfh, name, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0x2a21, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, eocd])
}

/** 手工 multipart 表单体（浏览器表单上传路径） */
function multipart(fields, file) {
  const b = '----smoke' + randomUUID().slice(0, 8)
  let head = ''
  for (const [k, v] of Object.entries(fields)) {
    head += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
  }
  head += `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
  return {
    contentType: `multipart/form-data; boundary=${b}`,
    body: Buffer.concat([Buffer.from(head, 'utf8'), Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data), Buffer.from(`\r\n--${b}--\r\n`)]),
  }
}

function gunzip(b) {
  return zlib.gunzipSync(b)
}
function unbrotli(b) {
  return zlib.brotliDecompressSync(b)
}

// ---- 主流程 ----

const tmp = await mkdtemp(join(tmpdir(), 'games-smoke-'))
const gamesDir = join(tmp, 'games')
const dataDir = join(tmp, 'data')
const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  // UPLOAD_RATE_PER_MIN=30：冒烟全程（含 GAMES-17 新增负例）要打 ~20 次上传，默认 10 会在中途误触限速；
  // 限速断言改为「33 连发 > 30」必然触发，两种窗口状态下都成立
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', GAMES_DIR: gamesDir, DATA_DIR: dataDir, UPLOAD_RATE_PER_MIN: '30' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
let childDead = false
child.stdout.on('data', (d) => (serverLog += d))
child.stderr.on('data', (d) => (serverLog += d))
child.on('exit', () => (childDead = true))

try {
  // 等服务就绪
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    if (childDead) break
    try {
      const r = await req('GET', '/api/health')
      up = r.status === 200
    } catch {
      /* 未就绪继续等 */
    }
    if (!up) await sleep(150)
  }
  ok(up, `server 启动就绪（${BASE}）`, childDead ? '子进程已退出：\n' + serverLog : '')

  // ===== 1. health =====
  {
    const r = await req('GET', '/api/health')
    const b = json(r)
    ok(r.status === 200 && b?.ok === true && typeof b.uptime === 'number', 'GET /api/health → 200 {ok:true}')
    ok((r.headers['cache-control'] || '') === 'no-store', 'health 应答 no-store')
  }

  // ===== 2. games 初始为空 =====
  {
    const r = await req('GET', '/api/games')
    const b = json(r)
    ok(r.status === 200 && b?.ok === true && Array.isArray(b.games) && b.games.length === 0 && b.total === 0, 'GET /api/games → 200 空清单')
  }

  // ===== 3. 上传三款测试游戏（html / zip / multipart 三形态）→ 待审 → 上架 =====
  let idA, idB, idC
  {
    // A：裸 html + query 元数据
    let r = await req('POST', '/api/upload?type=community&slug=smoke-a&name=SmokeA&levels=8&tier=s', {
      headers: { 'Content-Type': 'text/html' },
      body: gameHtml('Smoke A'),
    })
    let b = json(r)
    ok(r.status === 201 && b?.ok === true && b?.state === 'pending' && /^up-/.test(b?.id || ''), 'POST /api/upload 单 html → 201 待审', r.body.toString().slice(0, 200))
    idA = b.id

    // 待审出现在列表，但未入 games
    r = await req('GET', '/api/uploads')
    b = json(r)
    ok(r.status === 200 && b?.pending?.some((p) => p.id === idA), 'GET /api/uploads 待审列表含新上传')
    r = await req('GET', '/api/games')
    ok(json(r)?.games?.length === 0, '待审游戏不出现在 /api/games')

    // B：zip（包裹目录 + deflate 条目 + 随包 game.json）
    const zip = makeZip([
      { name: 'smoke-b/index.html', data: gameHtml('Smoke B'), deflate: true },
      { name: 'smoke-b/game.json', data: JSON.stringify({ name: 'Zip Game B', description: 'from zip' }) },
    ])
    r = await req('POST', '/api/upload?type=community&slug=smoke-b', {
      headers: { 'Content-Type': 'application/zip' },
      body: zip,
    })
    b = json(r)
    ok(r.status === 201 && b?.state === 'pending', 'POST /api/upload zip（deflate+包裹目录）→ 201 待审', r.body.toString().slice(0, 200))
    idB = b.id

    // C：multipart 表单（浏览器表单路径，元数据在表单字段）
    const mp = multipart(
      { type: 'community', slug: 'smoke-c', name: 'SmokeC', levels: '3', tier: 'a' },
      { filename: 'game.html', contentType: 'text/html', data: gameHtml('Smoke C') },
    )
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': mp.contentType }, body: mp.body })
    b = json(r)
    ok(r.status === 201 && b?.state === 'pending', 'POST /api/upload multipart 表单 → 201 待审', r.body.toString().slice(0, 200))
    idC = b.id

    // 上架 A/B/C
    for (const [id, slug] of [[idA, 'smoke-a'], [idB, 'smoke-b'], [idC, 'smoke-c']]) {
      r = await req('POST', `/api/uploads/${id}/approve`)
      b = json(r)
      ok(r.status === 200 && b?.state === 'published' && b?.game?.slug === slug && b?.game?.url?.startsWith(`/games/community/${slug}/`), `approve ${slug} → published 且指向 games/ 入口`, r.body.toString().slice(0, 200))
    }
    // 状态可查（台账末态）
    r = await req('GET', `/api/uploads/${idA}`)
    ok(r.status === 200 && json(r)?.upload?.state === 'published', 'GET /api/uploads/<id> 上架后末态 published')
    // 重复上架被状态机拒绝
    r = await req('POST', `/api/uploads/${idA}/approve`)
    ok(r.status === 404, '重复 approve → 404（状态机不再受理）', `status=${r.status}`)
  }

  // ===== 4. /api/games 结构与元数据回读 =====
  {
    const r = await req('GET', '/api/games?pageSize=100')
    const b = json(r)
    ok(r.status === 200 && b?.total === 3 && b?.games?.length === 3, '/api/games 上架后 total=3')
    const fields = ['id', 'slug', 'type', 'name', 'levels', 'tier', 'url']
    const shapeOk = b.games.every((g) => fields.every((f) => g[f] !== undefined) && typeof g.levels === 'number' && typeof g.url === 'string' && g.url.startsWith('/games/'))
    ok(shapeOk, `每项含 ${fields.join('/')} 且类型正确`)
    const a = b.games.find((g) => g.slug === 'smoke-a')
    const bb = b.games.find((g) => g.slug === 'smoke-b')
    const c = b.games.find((g) => g.slug === 'smoke-c')
    ok(a?.id === 'community:smoke-a' && a?.levels === 8 && a?.tier === 's' && a?.name === 'SmokeA', 'A 元数据回读（query 参数 → game.json → 清单）')
    ok(bb?.name === 'Zip Game B' && bb?.url?.endsWith('/index.html'), 'B 元数据回读（随包 game.json 的 name/entry 生效）')
    ok(c?.levels === 3 && c?.tier === 'a' && c?.name === 'SmokeC', 'C 元数据回读（multipart 字段生效）')
  }

  // ===== 5. 分页 + seed 洗牌袋 =====
  {
    let r = await req('GET', '/api/games?seed=s1&pageSize=2&page=1')
    let b = json(r)
    ok(b?.games?.length === 2 && b?.pages === 2, 'seed+分页：pageSize=2 → 2 页')
    const p1 = b.games.map((g) => g.id)
    r = await req('GET', '/api/games?seed=s1&pageSize=2&page=2')
    b = json(r)
    const p2 = b.games.map((g) => g.id)
    ok(p2.length === 1 && !p1.some((id) => p2.includes(id)), '翻页无重复')
    r = await req('GET', '/api/games?seed=s1&pageSize=100')
    const full1 = json(r).games.map((g) => g.id)
    ok(full1.join() === [...p1, ...p2].join(), '同 seed 全量与分页拼接一致（稳定排列）')
    r = await req('GET', '/api/games?seed=s2&pageSize=100')
    const full2 = json(r).games.map((g) => g.id)
    ok([...full1].sort().join() === [...full2].sort().join(), '不同 seed 也是同一集合的全排列')
    r = await req('GET', '/api/games?page=0')
    ok(r.status === 400, 'page=0 → 400')
    r = await req('GET', '/api/games?pageSize=1000')
    ok(r.status === 400, 'pageSize=1000 → 400')
    r = await req('GET', '/api/games?page=999')
    ok(r.status === 200 && json(r)?.games?.length === 0, 'page=999 → 200 空页')
  }

  // ===== 6. 游戏静态入口（iframe URL 可用 + 缓存协商） =====
  {
    const entry = '/games/community/smoke-a/index.html'
    let r = await req('GET', entry)
    ok(r.status === 200 && /text\/html/.test(r.headers['content-type'] || '') && r.body.toString().includes('Smoke A'), '上架游戏入口 URL 可访问')
    const etag = r.headers.etag
    ok(!!etag, '静态应答带 ETag')
    r = await req('GET', entry, { headers: { 'If-None-Match': etag } })
    ok(r.status === 304, 'If-None-Match → 304')
    r = await req('GET', '/games/_pending/x/index.html')
    ok(r.status === 404, '待审目录不经 /games/ 外露')
    // 静态 gzip（html 已 pad >512B）
    r = await req('GET', entry, { headers: { 'Accept-Encoding': 'gzip' } })
    ok(r.headers['content-encoding'] === 'gzip' && gunzip(r.body).toString().includes('Smoke A'), '静态 html gzip 压缩往返一致')
  }

  // ===== 7. /api/games 可缓存（短 max-age + ETag 304）与 API 压缩 =====
  {
    let r = await req('GET', '/api/games')
    ok(/max-age=30/.test(r.headers['cache-control'] || ''), 'Cache-Control: public, max-age=30')
    const etag = r.headers.etag
    r = await req('GET', '/api/games', { headers: { 'If-None-Match': etag } })
    ok(r.status === 304, '/api/games 条件请求 → 304')
    r = await req('GET', '/api/games', { headers: { 'Accept-Encoding': 'gzip' } })
    ok(r.headers['content-encoding'] === 'gzip' && JSON.parse(gunzip(r.body)).ok === true, 'API JSON gzip 往返一致')
    r = await req('GET', '/api/games', { headers: { 'Accept-Encoding': 'br' } })
    ok(r.headers['content-encoding'] === 'br' && JSON.parse(unbrotli(r.body)).ok === true, 'API JSON brotli 往返一致')
  }

  // ===== 8. 驳回路径 =====
  {
    let r = await req('POST', '/api/upload?type=community&slug=smoke-d', {
      headers: { 'Content-Type': 'text/html' },
      body: gameHtml('Smoke D'),
    })
    const idD = json(r).id
    r = await req('POST', `/api/uploads/${idD}/reject`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'smoke reject' }) })
    ok(r.status === 200 && json(r)?.state === 'rejected', 'reject → rejected')
    r = await req('GET', `/api/uploads/${idD}`)
    ok(r.status === 200 && json(r)?.upload?.state === 'rejected', '驳回后末态 rejected（台账）')
    r = await req('GET', '/api/games?pageSize=100')
    ok(json(r)?.total === 3, '驳回不入清单，total 仍 3')
    r = await req('POST', `/api/uploads/${idD}/approve`)
    ok(r.status === 404, '驳回后不可再 approve')
  }

  // ===== 8b. 流转并发竞态（原子目录 rename 的回归保护） =====
  {
    // 同一 id 三个 approve 同时打：必须恰好一个生效
    let r = await req('POST', '/api/upload?type=community&slug=smoke-e', {
      headers: { 'Content-Type': 'text/html' },
      body: gameHtml('Smoke E'),
    })
    const idE = json(r).id
    const rs = await Promise.all([1, 2, 3].map(() => req('POST', `/api/uploads/${idE}/approve`)))
    const codes = rs.map((x) => x.status).sort()
    ok(codes.filter((c) => c === 200).length === 1 && codes.every((c) => c === 200 || c === 404 || c === 409), `同一 id 并发 approve 恰好一个生效（${codes.join(',')}）`)
    r = await req('GET', '/api/games?pageSize=100')
    ok(json(r)?.total === 4, '并发上架后 total=4（无重复目录）')

    // 同 slug 两个不同包并发 approve：不允许混装（后来者应落 -2 目录）
    const r1 = await req('POST', '/api/upload?type=community&slug=smoke-f', {
      headers: { 'Content-Type': 'text/html' },
      body: gameHtml('Smoke F1'),
    })
    const r2 = await req('POST', '/api/upload?type=community&slug=smoke-f', {
      headers: { 'Content-Type': 'text/html' },
      body: gameHtml('Smoke F2'),
    })
    const [a1, a2] = await Promise.all([
      req('POST', `/api/uploads/${json(r1).id}/approve`),
      req('POST', `/api/uploads/${json(r2).id}/approve`),
    ])
    ok(a1.status === 200 && a2.status === 200, `双包并发 approve 均成功（${a1.status}/${a2.status}）`)
    const u1 = json(a1)?.game?.url
    const u2 = json(a2)?.game?.url
    ok(u1 && u2 && u1 !== u2, `同 slug 并发落不同目录（${u1} | ${u2}）`)
    const c1 = await req('GET', u1)
    const c2 = await req('GET', u2)
    const t1 = c1.body.toString()
    const t2 = c2.body.toString()
    ok(
      c1.status === 200 && c2.status === 200 && /Smoke F1/.test(t1) !== /Smoke F1/.test(t2) && /Smoke F2/.test(t1) !== /Smoke F2/.test(t2),
      '两包各自完整上架（无混装）',
    )

    // 上架目录洁净度：无 upload.json、无 writeFileAtomic 残片（并发/崩溃窗口可能带入）
    const junk = []
    for (const s of ['smoke-a', 'smoke-b', 'smoke-c', 'smoke-e', 'smoke-f', u1, u2]) {
      const dir = s.startsWith('/games/') ? join(gamesDir, s.slice('/games/'.length), '..') : join(gamesDir, 'community', s)
      try {
        for (const f of await readdir(dir)) {
          if (f === 'upload.json' || /\.tmp-[0-9a-f]+$/.test(f)) junk.push(`${s}/${f}`)
        }
      } catch {
        /* 目录不存在（u 路径变体）则跳过 */
      }
    }
    ok(junk.length === 0, `上架目录无杂物（${junk.join(',')}）`)
  }

  // ===== 9. 上传校验拒绝（负例） =====
  {
    let r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: '<h1>no html tag</h1>' })
    ok(r.status === 400 && /<html>/.test(json(r)?.error || ''), '缺 <html> → 400')
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: gameHtml('evil', 'https://evil.example/x.js') })
    ok(r.status === 400 && /evil\.example/.test(json(r)?.error || ''), '外域 script src → 400')
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: gameHtml('cdn', 'https://cdn.jsdelivr.net/npm/x') })
    ok(r.status === 201, '白名单 CDN script src → 放行')
    await req('POST', `/api/uploads/${json(r).id}/reject`) // 收尾：清掉这个待审
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: gameHtml('proto', 'data:text/javascript,alert(1)') })
    ok(r.status === 400, 'data: 协议 script src → 400')
    const evilZip = makeZip([{ name: '../../evil.html', data: gameHtml('evil zip') }])
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'application/zip' }, body: evilZip })
    ok(r.status === 400 && /危险路径/.test(json(r)?.error || ''), 'zip 路径穿越条目 → 400')
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/plain' }, body: 'plain text' })
    ok(r.status === 415, '不支持的 Content-Type → 415')
    const big = Buffer.alloc(3 * 1024 * 1024, 0x78) // 3MB > 2MB 上限
    big.fill('<html>')
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: big })
    ok(r.status === 413, '超大小上限 → 413', `status=${r.status}`)
  }

  // ===== 9b. 危险 API 静态检查 + 可执行入口断言（GAMES-17 / v2 G9） =====
  {
    // 单据验收主断言：含 alert( 的游戏 html 上传必须被驳回且原因可读
    let r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: gameHtml('alert-game', null, 'alert("you win")') })
    ok(r.status === 400 && /alert\(/.test(json(r)?.error || ''), '含 alert( 的游戏 html → 400 驳回并给原因', r.body.toString().slice(0, 200))
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: gameHtml('prompt-game', null, 'const n = prompt("name?")') })
    ok(r.status === 400 && /prompt\(/.test(json(r)?.error || ''), '含 prompt( → 400')
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'text/html' }, body: gameHtml('topnav', null, "top.location='https://evil.example'") })
    ok(r.status === 400 && /top\.location/.test(json(r)?.error || ''), '含 top.location 顶层跳转 → 400')
    r = await req('POST', '/api/upload', {
      headers: { 'Content-Type': 'text/html' },
      body: '<!doctype html><html><body><a href="/x" target="_top">全屏</a></body></html>',
    })
    ok(r.status === 400 && /_top/.test(json(r)?.error || ''), '含 target="_top" → 400')
    // 转嫁绕过防护：入口干净但打包 js 藏危险 API，zip 整包也得拦
    const evilJsZip = makeZip([
      { name: 'index.html', data: gameHtml('zip-js-传导') },
      { name: 'evil.js', data: 'function boom(){ alert(1) }' },
    ])
    r = await req('POST', '/api/upload', { headers: { 'Content-Type': 'application/zip' }, body: evilJsZip })
    ok(r.status === 400 && /evil\.js/.test(json(r)?.error || ''), 'zip 内 js 含 alert( → 400（防 script src 转嫁）', r.body.toString().slice(0, 200))
    // iframe 可加载验证（静态取舍）：入口无任何 <script> 的纯静态页不可作为游戏
    r = await req('POST', '/api/upload', {
      headers: { 'Content-Type': 'text/html' },
      body: '<!doctype html><html><head><title>static</title></head><body><h1>纯静态页</h1></body></html>',
    })
    ok(r.status === 400 && /可执行入口/.test(json(r)?.error || ''), '入口无 <script> → 400（可加载验证静态替代）')
  }

  // ===== 10. 统计：上报与查询 =====
  {
    let r = await req('POST', '/api/stats', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: 'smoke-visitor-1', gameId: 'community:smoke-a', seconds: 30 }),
    })
    ok(r.status === 200 && json(r)?.stored === 1, 'POST /api/stats 单条 → stored 1')
    r = await req('POST', '/api/play-events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [
        { visitorId: 'smoke-visitor-1', gameId: 'community:smoke-b', ms: 5000 },
        { visitorId: 'smoke-visitor-1', gameId: 'community:smoke-a', seconds: 90 },
      ] }),
    })
    ok(r.status === 200 && json(r)?.stored === 2, 'POST /api/play-events（别名）批量 + ms 换算 → stored 2')
    r = await req('GET', '/api/stats/smoke-visitor-1')
    const b = json(r)
    const a = b?.games?.find((g) => g.gameId === 'community:smoke-a')
    const bb = b?.games?.find((g) => g.gameId === 'community:smoke-b')
    ok(r.status === 200 && b?.visitorId === 'smoke-visitor-1', 'GET /api/stats/<visitorId> → 200')
    ok(b?.totalSeconds === 125 && a?.plays === 2 && a?.seconds === 120 && bb?.seconds === 5, '累计时长=125s；A 两计 120s；B ms→5s', JSON.stringify(b))
    r = await req('GET', '/api/stats/never-played')
    ok(r.status === 200 && json(r)?.totalSeconds === 0 && json(r)?.games?.length === 0, '未玩访客 → 空统计')
    r = await req('GET', '/api/stats/bad@id!')
    ok(r.status === 400, '非法 visitorId → 400')
    r = await req('POST', '/api/stats', { headers: { 'Content-Type': 'application/json' }, body: '{oops' })
    ok(r.status === 400, '坏 JSON → 400')
  }

  // ===== 11. 跨域关闭（仅同源） =====
  {
    let r = await req('GET', '/api/games', { headers: { Origin: 'http://evil.example' } })
    ok(r.status === 403, '外域 Origin → 403')
    r = await req('GET', '/api/games', { headers: { Origin: BASE } })
    ok(r.status === 200, '同源 Origin → 200')
    const noCors = Object.keys(r.headers).every((k) => !/^access-control-/i.test(k))
    ok(noCors, '应答不含任何 Access-Control-* 头')
  }

  // ===== 12. 404/405 兜底 =====
  {
    let r = await req('GET', '/api/nope')
    ok(r.status === 404 && json(r)?.ok === false, '未知 /api/* → JSON 404')
    r = await req('DELETE', '/api/games')
    ok(r.status === 405, '不支持的方法 → 405')
  }

  // ===== 13. 上传限速（本实例限 30/分钟；33 连发必触发，无论窗口是否已轮转） =====
  {
    let got429 = 0
    let retryAfterOk = true
    let accepted = 0
    for (let i = 0; i < 33; i++) {
      const r = await req('POST', '/api/upload?type=community', {
        headers: { 'Content-Type': 'text/html' },
        body: gameHtml(`burst ${i}`),
      })
      if (r.status === 429) {
        got429++
        if (!r.headers['retry-after'] || Number(r.headers['retry-after']) < 1) retryAfterOk = false
      } else if (r.status === 201) accepted++
    }
    ok(got429 >= 1 && retryAfterOk, `限速生效：33 连发得 ${got429} 个 429 且带 Retry-After（${accepted} 个被受理）`)
  }

  // ===== 14. 终态健康 =====
  {
    const r = await req('GET', '/api/health')
    ok(r.status === 200 && json(r)?.ok === true, '全链路后 server 仍健康')
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (serverLog.trim()) console.log(`--- server 日志 ---\n${serverLog.trim()}`)
  process.exitCode = failed === 0 && passed > 0 ? 0 : 1
} catch (err) {
  failed++
  console.error('✗ 冒烟异常中断：', err)
  console.error(serverLog)
  process.exitCode = 1
} finally {
  // 清理：杀子进程 + 删临时目录（隔离环境本就不含真实数据，双保险）
  child.kill('SIGTERM')
  await Promise.race([new Promise((r) => child.on('exit', r)), sleep(2000).then(() => child.kill('SIGKILL'))])
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
  if (failed > 0) {
    console.error(`SMOKE FAILED（${failed} 项断言未过）`)
  } else {
    console.log('SMOKE OK')
  }
}
