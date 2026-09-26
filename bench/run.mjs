#!/usr/bin/env node
/* GAMES-24 基准测量 harness：起静态服务 + Playwright 驱动无头 Chrome，对 bench/out/*.html 跑
 * 三类测量（口径见 bench/README.md）：
 *   start —— 冷启动：每轮全新 context（空缓存空存储），导航→首个呈现帧（tReady）+ 导航时序；
 *            另测同 context 二次加载（vendor 走 HTTP 缓存 = 回访口径）。
 *   fps   —— 帧率：ready+0.5s 暖机后 rAF 时间戳采样 10s；avg/p95/掉帧/逐秒最小帧率 + 实体峰值
 *            （跨引擎同 (game,load) 的实体峰值一致 = 工作负载等价性的地面真值）。
 *   mem   —— 60s 运行内存：机器人自动玩+自动重开，宿主每 2s 采 performance.memory（--enable-
 *            precise-memory-info），报告 增长 = 末样 − 首样。
 * 主口径 = 无头 SwiftShader 软件 GL（≈低端真机 GPU）；--gpu 档用 channel:chromium 走本机真 GPU
 * （ANGLE Metal）复核。用法：node bench/run.mjs [--quick] [--gpu] [--only=name1,name2] */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import os from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))
const PAGES = ['native-tap', 'native-runner', 'phaser3-tap', 'phaser3-runner', 'phaser4-tap', 'phaser4-runner', 'pixi8-tap', 'pixi8-runner']
const arg = (n) => process.argv.includes(`--${n}`)
const QUICK = arg('quick'), GPU = arg('gpu')
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '--only=').slice(8).split(',').filter(Boolean)
const TARGETS = ONLY.length ? PAGES.filter(p => ONLY.includes(p)) : PAGES

/* ---------- 静态服务（vendor 允许缓存以测回访口径；页面 no-store） ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }
const srv = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/])+/, '')
    const buf = await readFile(join(ROOT, p))
    const cc = p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-store'
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': cc })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`

const results = { meta: {}, start: [], fps: [], mem: [], errors: [] }

async function glInfo(browser) {
  const ctx = await browser.newContext()
  const pg = await ctx.newPage()
  const info = await pg.evaluate(() => {
    const c = document.createElement('canvas')
    const g = c.getContext('webgl')
    if (!g) return null
    const d = g.getExtension('WEBGL_debug_renderer_info')
    return { renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER), version: g.getParameter(g.VERSION) }
  })
  await ctx.close()
  return info
}

async function newPage(browser, dpr) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: dpr })
  const pg = await ctx.newPage()
  const errs = []
  pg.on('pageerror', e => errs.push(String(e).slice(0, 200)))
  return { ctx, pg, errs }
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const r1 = (x) => Math.round(x * 10) / 10

/* ---------- 机器人回放：页内决策 → 受信输入（CDP mouse，Phaser 3.90+ 拒合成事件） ---------- */
async function drainBot(pg) {
  const acts = await pg.evaluate(() => (window.__BOT_DRAIN__ ? window.__BOT_DRAIN__() : [])).catch(() => [])
  for (const a of acts) {
    if (a.k === 'tap') { await pg.mouse.move(a.x, a.y); await pg.mouse.down(); await pg.mouse.up(); }
    else { await pg.mouse.move(187.5, 500); await pg.mouse.down(); await pg.mouse.move(187.5 + a.dx, 500 + a.dy, { steps: 2 }); await pg.mouse.up(); }
  }
}
/* 轮询等待 + 输入驱动（80ms 一拍） */
async function drive(pg, condSrc, timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    const done = await pg.evaluate(condSrc).catch(() => null)
    if (done) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`drive timeout (${timeoutMs}ms)`)
    await drainBot(pg)
    await pg.waitForTimeout(80)
  }
}

/* ---------- 冷启动 ---------- */
async function suiteStart(browser, tag) {
  const reps = QUICK ? 3 : 5
  for (const name of TARGETS) {
    for (const dpr of (QUICK ? [1] : [1, 2])) {
      const cold = [], warm = []
      for (let i = 0; i < reps; i++) {
        const { ctx, pg, errs } = await newPage(browser, dpr)
        try {
          await pg.goto(`${BASE}/out/${name}.html?mode=start&load=1`, { waitUntil: 'commit' })
          await pg.waitForFunction(() => window.__BENCH__ && window.__BENCH__.tReady > 0, null, { timeout: 30000 })
          const c = await pg.evaluate(() => window.__BENCH__.collect())
          cold.push({ tReady: c.tReady, dcl: c.nav?.dcl, load: c.nav?.load, respEnd: c.nav?.respEnd, tScript: c.tScript })
          /* 同 context 二次加载：vendor 走缓存（回访口径） */
          await pg.reload({ waitUntil: 'commit' })
          await pg.waitForFunction(() => window.__BENCH__ && window.__BENCH__.tReady > 0, null, { timeout: 30000 })
          const w = await pg.evaluate(() => window.__BENCH__.collect())
          warm.push({ tReady: w.tReady, dcl: w.nav?.dcl })
          if (errs.length) results.errors.push({ suite: 'start', name, errs })
        } catch (e) { results.errors.push({ suite: 'start', name, err: String(e).slice(0, 200) }) }
        await ctx.close()
      }
      const agg = (arr, k) => r1(med(arr.map(x => x[k]).filter(x => x !== undefined)))
      results.start.push({
        tag, name, dpr, n: cold.length,
        tReadyCold: agg(cold, 'tReady'), dclCold: agg(cold, 'dcl'), respEndCold: agg(cold, 'respEnd'),
        tReadyWarm: agg(warm, 'tReady'), dclWarm: agg(warm, 'dcl'),
        raw: { cold, warm },
      })
      console.log(`  start ${tag} ${name} dpr${dpr}: cold tReady=${agg(cold, 'tReady')}ms dcl=${agg(cold, 'dcl')}ms | warm tReady=${agg(warm, 'tReady')}ms`)
    }
  }
}

/* ---------- 帧率 ---------- */
async function suiteFps(browser, tag, dpr, loads, reps) {
  for (const name of TARGETS) {
    for (const load of loads) {
      const runs = []
      for (let i = 0; i < reps; i++) {
        const { ctx, pg, errs } = await newPage(browser, dpr)
        try {
          await pg.goto(`${BASE}/out/${name}.html?mode=fps&load=${load}`, { waitUntil: 'commit' })
          await drive(pg, () => !!(window.__BENCH__ && window.__BENCH__.fpsDone === true), 90000)
          const c = await pg.evaluate(() => window.__BENCH__.collect())
          runs.push(c)
          if (errs.length) results.errors.push({ suite: 'fps', name, load, errs })
        } catch (e) { results.errors.push({ suite: 'fps', name, load, err: String(e).slice(0, 200) }) }
        await ctx.close()
      }
      for (const c of runs) {
        results.fps.push({
          tag, name, dpr, load,
          avg: c.fps?.avg, p95: c.fps?.p95, p99: c.fps?.p99, max: c.fps?.max,
          long17: c.fps?.long17, long34: c.fps?.long34, min1s: c.fps?.min1s, n: c.fps?.n,
          peak: c.peak, avgEnt: c.avgEnt, restarts: c.restarts, simEvents: c.simEvents, heap: c.heap,
        })
      }
      const b = runs.map(c => c.fps?.avg).filter(Boolean)
      const pk = runs.map(c => c.peak)
      if (b.length) console.log(`  fps ${tag} ${name} dpr${dpr} load${load}: avg=${b.map(r1).join('/')} peakEnt=${pk.join('/')} restarts=${runs.map(c => c.restarts).join('/')}`)
    }
  }
}

/* ---------- 内存（60s，宿主外采） ---------- */
async function suiteMem(browser, tag) {
  for (const name of TARGETS) {
    const { ctx, pg, errs } = await newPage(browser, 1)
    try {
      await pg.goto(`${BASE}/out/${name}.html?mode=mem&load=1`, { waitUntil: 'commit' })
      await drive(pg, () => !!(window.__BENCH__ && window.__BENCH__.tReady > 0), 30000)
      const series = []
      const t0 = Date.now()
      /* 60s：每 2s 采一次堆，期间 150ms 一拍驱动机器人（受信输入） */
      for (let s = 0; s <= 30; s++) {
        const m = await pg.evaluate(() => performance.memory ? {
          used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize,
        } : null)
        if (m) series.push({ t: Date.now() - t0, usedMB: r1(m.used / 1048576), totalMB: r1(m.total / 1048576) })
        if (s < 30) {
          const until = Date.now() + 2000
          while (Date.now() < until) { await drainBot(pg); await pg.waitForTimeout(150) }
        }
      }
      const c = await pg.evaluate(() => window.__BENCH__.collect())
      const first = series[0].usedMB, last = series[series.length - 1].usedMB
      const maxv = Math.max(...series.map(s => s.usedMB))
      results.mem.push({
        tag, name, firstMB: first, lastMB: last, maxMB: r1(maxv),
        growthMB: r1(last - first), growthFromMinMB: r1(maxv - first),
        restarts: c.restarts, simEvents: c.simEvents, peak: c.peak, avgEnt: c.avgEnt,
        series,
      })
      console.log(`  mem ${tag} ${name}: ${first}MB → ${last}MB (max ${r1(maxv)}) growth=${r1(last - first)}MB restarts=${c.restarts} events=${c.simEvents}`)
      if (errs.length) results.errors.push({ suite: 'mem', name, errs })
    } catch (e) { results.errors.push({ suite: 'mem', name, err: String(e).slice(0, 200) }) }
    await ctx.close()
  }
}

/* ---------- 包体 ---------- */
async function collectSizes() {
  const { readFileSync } = await import('node:fs')
  const sizes = JSON.parse(readFileSync(join(ROOT, 'sizes.json'), 'utf8'))
  const vendorFiles = { 'phaser3.min.js': 'phaser3.min.js', 'phaser4.min.js': 'phaser4.min.js', 'pixi8.min.js': 'pixi8.min.js' }
  const vendorStats = {}
  for (const [k, f] of Object.entries(vendorFiles)) {
    const buf = readFileSync(join(ROOT, 'vendor', f))
    vendorStats[k] = { rawKB: r1(buf.length / 1024), gzipKB: r1(gzipSync(buf).length / 1024) }
  }
  results.size = { pages: sizes, vendor: vendorStats }
}

/* ---------- 主流程 ---------- */
console.log(`[g24-bench] targets=${TARGETS.join(',')} quick=${QUICK} gpu=${GPU}`)
const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] })
results.meta = {
  ts: new Date().toISOString(),
  chromium: browser.version(),
  channel: 'default-headless',
  gl: await glInfo(browser),
  cpus: os.cpus().length, model: os.cpus()[0]?.model, platform: `${os.type()} ${os.release()}`,
  viewport: '375×667',
}
console.log(`[g24-bench] chromium=${browser.version()} gl=${results.meta.gl?.renderer}`)

await suiteStart(browser, 'swiftshader')
await suiteFps(browser, 'swiftshader', 1, [1, 4], QUICK ? 1 : 2)
await suiteFps(browser, 'swiftshader', 1, [16], 1)
await suiteFps(browser, 'swiftshader', 2, [1, 16], 1)
await suiteMem(browser, 'swiftshader')
await browser.close()

if (GPU && !QUICK) {
  const browser2 = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-precise-memory-info'] })
  results.meta.glGpu = await glInfo(browser2)
  console.log(`[g24-bench] gpu-channel chromium=${browser2.version()} gl=${results.meta.glGpu?.renderer}`)
  await suiteStart(browser2, 'gpu')                    /* 真 GPU 下冷启动/回访是否同形 */
  await suiteFps(browser2, 'gpu', 1, [1, 4], 1)
  await suiteFps(browser2, 'gpu', 2, [16], 1)
  await browser2.close()
}

await collectSizes()
srv.close()

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
await mkdir(join(ROOT, 'results'), { recursive: true })
await writeFile(join(ROOT, 'results', `results-${stamp}.json`), JSON.stringify(results, null, 1))
await writeFile(join(ROOT, 'results.json'), JSON.stringify(results, null, 1))
console.log(`[g24-bench] done → bench/results/results-${stamp}.json (${results.errors.length} errors)`)
if (results.errors.length) console.log(JSON.stringify(results.errors.slice(0, 6), null, 1))
process.exit(0)
