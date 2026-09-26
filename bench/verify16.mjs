#!/usr/bin/env node
/* GAMES-24 压力档复测：load16 × DPR{1,2} × 3 重复（SwiftShader 主口径），写入
 * bench/results/stress16.json；analyze.mjs 会自动并入（tag=swiftshader）。 */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { extname, join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))
const PAGES = ['native-tap', 'native-runner', 'phaser3-tap', 'phaser3-runner', 'phaser4-tap', 'phaser4-runner', 'pixi8-tap', 'pixi8-runner']
const MIME = { '.html': 'text/html', '.js': 'text/javascript' }
const srv = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/])+/, '')
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(await readFile(join(ROOT, p)))
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`

async function drainBot(pg) {
  const acts = await pg.evaluate(() => (window.__BOT_DRAIN__ ? window.__BOT_DRAIN__() : [])).catch(() => [])
  for (const a of acts) {
    if (a.k === 'tap') { await pg.mouse.move(a.x, a.y); await pg.mouse.down(); await pg.mouse.up(); }
    else { await pg.mouse.move(187.5, 500); await pg.mouse.down(); await pg.mouse.move(187.5 + a.dx, 500 + a.dy, { steps: 2 }); await pg.mouse.up(); }
  }
}
async function drive(pg, cond, timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    if (await pg.evaluate(cond).catch(() => null)) return
    if (Date.now() - t0 > timeoutMs) throw new Error('drive timeout')
    await drainBot(pg); await pg.waitForTimeout(80)
  }
}

const out = { fps: [], errors: [] }
const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] })
for (const name of PAGES) {
  for (const dpr of [1, 2]) {
    const runs = []
    for (let rep = 0; rep < 3; rep++) {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: dpr })
      const pg = await ctx.newPage()
      const errs = []
      pg.on('pageerror', e => errs.push(String(e).slice(0, 200)))
      try {
        await pg.goto(`${BASE}/out/${name}.html?mode=fps&load=16`, { waitUntil: 'commit' })
        await drive(pg, () => !!(window.__BENCH__ && window.__BENCH__.fpsDone === true), 90000)
        const c = await pg.evaluate(() => window.__BENCH__.collect())
        runs.push(c)
        if (errs.length) out.errors.push({ name, dpr, rep, errs })
      } catch (e) { out.errors.push({ name, dpr, rep, err: String(e).slice(0, 200) }) }
      await ctx.close()
    }
    for (const c of runs) out.fps.push({
      tag: 'swiftshader', name, dpr, load: 16,
      avg: c.fps?.avg, p95: c.fps?.p95, p99: c.fps?.p99, max: c.fps?.max,
      long17: c.fps?.long17, long34: c.fps?.long34, min1s: c.fps?.min1s, n: c.fps?.n,
      peak: c.peak, avgEnt: c.avgEnt, restarts: c.restarts, simEvents: c.simEvents, heap: c.heap,
    })
    const a = runs.map(c => c.fps?.avg)
    console.log(`  fps16 ${name} dpr${dpr}: avg=${a.map(x => Math.round(x * 10) / 10).join('/')} long17=${runs.map(c => c.fps?.long17).join('/')} peak=${runs.map(c => c.peak).join('/')}`)
  }
}
await browser.close(); srv.close()
await mkdir(join(ROOT, 'results'), { recursive: true })
await writeFile(join(ROOT, 'results', 'stress16.json'), JSON.stringify(out, null, 1))
console.log(`done → bench/results/stress16.json (${out.errors.length} errors)`)
