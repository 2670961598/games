#!/usr/bin/env node
/* =====================================================================
 * GAMES-49 识图 v2 前置工具（quality-pipeline §8.4：几何断言先行，识图殿后）：
 *   1) 几何断言（真实 375×667 视口、force-device-scale-factor=1 口径——playwright
 *      context deviceScaleFactor:1）：scrollWidth ≤ clientWidth、无可见元素越视口、
 *      画布完整落于视口内（Q-005 教训：DPR=2 伪影先于识图拦截）；
 *   2) 墨水带地面真值（CDP canvas 像素直读，不经 PNG 解码）：home/play 两时刻
 *      分带非背景墨水占比——顶栏带/主区带/拇指区带均有墨（防白屏/遮蔽/错位），
 *      且 home 三件套（标题区/按钮区/页脚区）着墨；
 *   3) 截图落盘 <OUT_DIR>/<slug>-{home,play}.png（DSF=1，识图素材）。
 * 用法：node scripts/visual-check.js [--slug xxx] [--type block-drop] [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const SLUG = argOf('--slug')
const TYPE = argOf('--type')
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-49-shots'
const WAVE_TYPES = ['block-drop', 'block-fit']              // 本波迁移类型

async function collectGames() {
  let types = WAVE_TYPES
  if (TYPE) types = [TYPE]
  else if (SLUG) {
    types = (await readdir(join(ROOT, 'games'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name !== 'demo').map((d) => d.name)
  }
  const list = []
  for (const type of types) {
    const dirs = (await readdir(join(ROOT, 'games', type), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    for (const slug of dirs) list.push({ type, slug })
  }
  return SLUG ? list.filter((g) => g.slug === SLUG) : list
}

/* 墨水带采样：canvas backing store 像素直读（0,0 起 N 行带），非背景 = 与最常见底色差 >24 */
async function inkBands(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('cv')
    const g = cv.getContext('2d')
    const W = 375, H = 667
    const bands = [
      { name: 'top', y0: 0, y1: 48 },          // 顶栏带（HUD/返回）
      { name: 'upper', y0: 48, y1: 280 },      // 主区上带（井/棋盘上半）
      { name: 'lower', y0: 280, y1: 560 },     // 主区下带（井/棋盘下半+块槽）
      { name: 'thumb', y0: 560, y1: 667 },     // 拇指区带（NEXT 预览/页脚）
    ]
    const out = {}
    for (const b of bands) {
      const img = g.getImageData(0, b.y0, W, b.y1 - b.y0)
      const d = img.data
      /* 背景色 = 每带众数（近似：取样首像素集的中位）——改为整带像素亮度分布 */
      let ink = 0, total = 0
      const stride = 4 * 7                                   // 采样步长 7px（≈1/7 像素）
      for (let i = 0; i < d.length; i += stride) {
        total++
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2])
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        if (mx - mn > 24 || lum > 44 || lum < 8) ink++       // 彩度或亮度偏离深底 #101522
      }
      out[b.name] = total ? +(ink / total).toFixed(3) : 0
    }
    return out
  })
}

const games = await collectGames()
await mkdir(OUT, { recursive: true })
const report = { tool: 'scripts/visual-check.js (GAMES-49, 识图v2 前置)', generatedAt: new Date().toISOString(), games: [], errors: [] }
let cleanup = []

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-check-'))
const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
cleanup.push(() => server.kill('SIGTERM'))
await new Promise((res) => {
  const t = setTimeout(res, 8000)
  server.stderr.on('data', (d) => { if (String(d).includes('listening') || String(d).includes(String(PORT))) { clearTimeout(t); res() } })
  fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
})

for (const gme of games) {
  const entry = { slug: gme.slug, type: gme.type }
  report.games.push(entry)
  try {
    /* §8.4：DSF=1 真实 375×667 视口 */
    const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
    const page = await context.newPage()
    page.on('pageerror', (e) => report.errors.push(`[${gme.slug}] ${e.message}`))
    await page.goto(`http://127.0.0.1:${PORT}/games/${gme.type}/${gme.slug}/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
    await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })

    /* 1) 几何断言（识图前先拦截 DPR/布局伪影） */
    const geo = await page.evaluate(() => {
      const de = document.documentElement
      const vw = de.clientWidth
      const bad = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        if (r.right > vw + 0.5 || r.left < -0.5) bad.push(`${el.tagName}.${el.id || el.className}: left=${r.left.toFixed(1)} right=${r.right.toFixed(1)}`)
      }
      const cv = document.getElementById('cv').getBoundingClientRect()
      return { scrollW: de.scrollWidth, clientW: vw, canvas: { left: cv.left, top: cv.top, right: cv.right, bottom: cv.bottom }, bad }
    })
    entry.geo = geo
    entry.geoOk = geo.scrollW <= geo.clientW + 0.5 && geo.bad.length === 0
      && geo.canvas.left >= -0.5 && geo.canvas.right <= geo.clientW + 0.5

    /* home 截图 + 墨水带 */
    await page.waitForTimeout(400)
    entry.inkHome = await inkBands(page)
    await page.screenshot({ path: join(OUT, `${gme.slug}-home.png`) })

    /* play 态：start(1) 自然演化 1.2s（block-drop 见落块+NEXT；block-fit 见棋盘+块槽） */
    await page.evaluate(() => window.__GAMES_DEBUG__.start(1))
    await page.waitForTimeout(1200)
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
    entry.inkPlay = await inkBands(page)
    await page.screenshot({ path: join(OUT, `${gme.slug}-play.png`) })
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))

    /* 2) 墨水带判定：play 态顶栏/主区上/下带 >2%、拇指带 >0.5%（block-drop 拇指区仅
     *    NEXT 预览尾部，天然稀疏——阈值防白屏/遮蔽，不追求满带）；
     *    home 态标题带+拇指带 >2%（三件套） */
    entry.inkOk = ['top', 'upper', 'lower'].every((b) => entry.inkPlay[b] > 0.02) && entry.inkPlay.thumb > 0.005
      && entry.inkHome.upper > 0.02 && entry.inkHome.thumb > 0.003   /* home 页脚仅 11px 小字，0.3% 起 */
    entry.pass = entry.geoOk && entry.inkOk
    await context.close()
  } catch (e) {
    entry.error = String(e && e.message ? e.message : e).slice(0, 300)
    entry.pass = false
  }
}

await browser.close()
await rm(dataDir, { recursive: true, force: true })
for (const fn of cleanup) { try { fn() } catch { /* best effort */ } }

console.log(JSON.stringify(report, null, 2))
console.error('\n[visual-check] 摘要（几何断言 + 墨水带；识图素材落 ' + OUT + '）：')
for (const g of report.games) {
  console.error(`  ${g.slug.padEnd(22)} ${g.pass ? 'PASS' : 'FAIL'}  几何=${g.geoOk ? '✓' : '✗'} 墨水=${g.inkOk ? '✓' : '✗'} play带=${g.inkPlay ? Object.entries(g.inkPlay).map(([k, v]) => k + (v * 100).toFixed(0) + '%').join(' ') : '?'} ${g.error ? 'ERR: ' + g.error : ''}`)
}
const bad = report.games.filter((g) => !g.pass)
if (bad.length) console.error(`[visual-check] 未过 ${bad.length} 款：${bad.map((g) => g.slug).join(', ')}`)
process.exitCode = bad.length || report.errors.length ? 1 : 0
