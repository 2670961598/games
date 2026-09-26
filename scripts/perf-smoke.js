#!/usr/bin/env node
/* =====================================================================
 * GAMES-30 性能工具（自 GAMES-22 移植，引擎无关口径；基座=原生 GE）：
 * 无头浏览器（playwright，devDependency）逐游戏采样帧率。
 * 流程：临时 DATA_DIR + 随机端口起真实 server → 逐款打开
 *   /games/<type>/<slug>/index.html?debug=1 → 等 boot → __GAMES_DEBUG__.start(1) 进入玩法 →
 *   页面内 rAF 采样 5s 帧间隔 → 汇总 avgFps / 掉帧率（>25ms 占比，60fps 预算 1.5 倍口径）/
 *   long17R（>17.5ms 占比，bench 严格预算口径）/ p50 / p95 / 最差帧。
 * 红线（单据 GAMES-30）：avgFps ≥55 且 掉帧率 <2%，违者 exit 1。
 * 浏览器不可用时降级为结构检查（4 段内联/GE 基座/GE.boot/零外链/体积），mode 字段注明，
 * REPORT 需说明降级原因。用法：
 *   node scripts/perf-smoke.js                # 已迁移波次 20 款（试点 10 + GAMES-49 block-drop/block-fit 10）
 *   node scripts/perf-smoke.js --all          # 全平台扫描
 *   node scripts/perf-smoke.js --slug xxx --ms 8000 --out perf.json
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const ALL = argv.includes('--all')
const SLUG = argOf('--slug')
const TYPE = argOf('--type')
const SAMPLE_MS = Number(argOf('--ms') || 5000)
const OUT = argOf('--out')
const FPS_LINE = 55, JANK_LINE = 0.02            // 质量红线（单据冻结口径）

/* ---------- 收集游戏清单 ---------- */
const WAVE_TYPES = ['tap-burst', 'lane-runner', 'block-drop', 'block-fit']   // 已迁移波次（GAMES-30 + GAMES-49）
async function collectGames() {
  let types
  if (ALL) {
    types = (await readdir(join(ROOT, 'games'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name !== 'demo')
      .map((d) => d.name)
  } else if (TYPE) types = [TYPE]
  else if (SLUG) {                                         // --slug 可指向任意类型：全目录扫描（防清单外空集假绿）
    types = (await readdir(join(ROOT, 'games'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name !== 'demo').map((d) => d.name)
  } else types = WAVE_TYPES
  const list = []
  for (const type of types) {
    if (TYPE && type !== TYPE) continue
    const dirs = (await readdir(join(ROOT, 'games', type), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    for (const slug of dirs) list.push({ type, slug })
  }
  return SLUG ? list.filter((g) => g.slug === SLUG) : list
}

/* ---------- 结构检查（降级模式） ---------- */
async function structuralCheck(games) {
  const results = []
  for (const g of games) {
    const html = await readFile(join(ROOT, 'games', g.type, g.slug, 'index.html'), 'utf8')
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    results.push({
      slug: g.slug, type: g.type,
      structural: {
        scriptSegments: scripts.length,
        geBase: scripts[1] ? scripts[1].includes('原生基座 GE') && scripts[1].includes('mulberry32') : false,
        geBoot: /^GE\.boot\(CONFIG, \w+\);$/.test((scripts[3] || '').trim()),
        noExternalTagRefs: !/<script[^>]+src=|<link[^>]+href=|<img[^>]+src=/.test(html),
        sizeKB: +(html.length / 1024).toFixed(0),
      },
    })
  }
  return results
}

/* ---------- 主流程 ---------- */
const games = await collectGames()
const report = {
  tool: 'scripts/perf-smoke.js (GAMES-30, 原生 GE)',
  generatedAt: new Date().toISOString(),
  sampleMs: SAMPLE_MS,
  redLine: { avgFps: FPS_LINE, jankRatio: JANK_LINE },
  mode: 'headless-browser',
  server: null,
  games: [],
}
let cleanup = []

try {
  let chromium = null
  try { chromium = (await import('playwright')).chromium }
  catch { throw new Error('playwright 未安装（devDependency）：npm i -D playwright') }

  let browser
  const attempts = [
    () => chromium.launch({ headless: true }),
    () => chromium.launch({ headless: true, channel: 'chrome' }),   // 缓存浏览器缺版本时回退系统 Chrome
  ]
  let lastErr
  for (const a of attempts) { try { browser = await a(); break } catch (e) { lastErr = e } }
  if (!browser) throw lastErr

  /* 真实 server：随机端口 + 临时 DATA_DIR，不碰仓库数据 */
  const PORT = 45000 + Math.floor(Math.random() * 10000)
  const dataDir = await mkdtemp(join(tmpdir(), 'perf-smoke-'))
  const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  cleanup.push(() => server.kill('SIGTERM'))
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server boot timeout')), 10_000)
    server.stderr.on('data', (d) => { if (String(d).includes('listening') || String(d).includes(String(PORT))) { clearTimeout(t); res() } })
    fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
    setTimeout(res, 1500)   // 兜底：health 慢也继续
  })
  report.server = `http://127.0.0.1:${PORT}`

  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, hasTouch: true })
  const page = await context.newPage()
  report.errors = []
  page.on('pageerror', (e) => report.errors.push(`[${report.games.length ? report.games[report.games.length - 1]?.slug : '?'}] ${e.message}`))

  for (const g of games) {
    const url = `http://127.0.0.1:${PORT}/games/${g.type}/${g.slug}/index.html?debug=1`
    const entry = { slug: g.slug, type: g.type, url }
    report.games.push(entry)
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 })
      await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
      await page.evaluate(() => window.__GAMES_DEBUG__.start(1))
      await page.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'start'), null, { timeout: 10_000 })
      /* rAF 采样 SAMPLE_MS 毫秒帧间隔（页面内时钟，无 IPC 抖动） */
      const stat = await page.evaluate((ms) => new Promise((resolve) => {
        const gaps = []
        const t0 = performance.now()
        let last = t0
        function tick(t) {
          gaps.push(t - last); last = t
          if (t - t0 < ms) requestAnimationFrame(tick)
          else {
            const sorted = [...gaps].sort((a, b) => a - b)
            const p = (q) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(1)
            resolve({
              frames: gaps.length,
              avgFps: +(gaps.length / ((last - t0) / 1000)).toFixed(1),
              jankRatio: +(gaps.filter((x) => x > 25).length / gaps.length).toFixed(4),   // 掉帧=帧间隔>25ms
              long17R: +(gaps.filter((x) => x > 17.5).length / gaps.length).toFixed(4),   // bench 严格口径：>17.5ms
              p50Ms: p(0.5), p95Ms: p(0.95), worstMs: p(1),
            })
          }
        }
        requestAnimationFrame(tick);
      }), SAMPLE_MS)
      Object.assign(entry, stat, { bootEvents: await page.evaluate(() => window.__GAMES_DEBUG__.events.map((e) => e.event)) })
    } catch (e) {
      entry.error = String(e && e.message ? e.message : e).slice(0, 300)
    }
  }
  await browser.close()
  await rm(dataDir, { recursive: true, force: true })
} catch (e) {
  /* 降级：结构检查（REPORT 必须说明） */
  report.mode = 'structural-check（降级：' + String(e && e.message ? e.message : e).slice(0, 200) + '）'
  report.games = await structuralCheck(games)
} finally {
  for (const fn of cleanup) { try { fn() } catch { /* best effort */ } }
}

/* ---------- 输出 ---------- */
const j = JSON.stringify(report, null, 2)
if (OUT) { const { writeFile } = await import('node:fs/promises'); await writeFile(OUT, j + '\n') }
console.log(j)
if (report.mode.startsWith('headless')) {
  console.error('\n[perf-smoke] 摘要（红线：avgFps≥' + FPS_LINE + ' 且 掉帧<' + (JANK_LINE * 100) + '%）：')
  for (const g of report.games) {
    console.error(`  ${g.slug.padEnd(22)} avgFps ${String(g.avgFps ?? '?').padStart(6)}  jank ${(g.jankRatio != null ? (g.jankRatio * 100).toFixed(1) : '?').padStart(5)}%  long17 ${(g.long17R != null ? (g.long17R * 100).toFixed(1) : '?').padStart(5)}%  p95 ${String(g.p95Ms ?? '?').padStart(6)}ms  ${g.error ? 'ERR: ' + g.error : ''}`)
  }
  const bad = report.games.filter((g) => g.error || (g.avgFps != null && (g.avgFps < FPS_LINE || g.jankRatio >= JANK_LINE)))
  if (bad.length) console.error(`[perf-smoke] 红线违例 ${bad.length} 款：${bad.map((g) => g.slug).join(', ')}`)
  process.exitCode = bad.length ? 1 : 0
}
