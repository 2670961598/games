#!/usr/bin/env node
/* GAMES-128 QA一号 · 浏览器冒烟（真网关 :4415）+ perf 帧成本探针 + HF 登记 + 截图（识图锚） */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4415'
const PORT = 8461
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
    const buf = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(PORT, r))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/mini-moba/index.html?gw=${GW}`, { waitUntil: 'domcontentloaded' })
// 等入房+快照流（ents>0）
await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().ents > 0, null, { timeout: 15_000 })
await page.waitForTimeout(6000) // 对局推进 6s（弹道/技能/兵线在屏）
const st = await page.evaluate(() => window.__GAMES_DEBUG__.state())
const perf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
const ev = await page.evaluate(() => (window.__GAMES_DEBUG__.events || []).slice(-400))
const shot = '/tmp/moba128-shot.png'
await page.screenshot({ path: shot })
await browser.close(); srv.close()
const kills = ev.filter((e) => e.k === 'kill').length
const shots = ev.filter((e) => e.k === 'shot').length
const kinds = [...new Set(ev.map((e) => e.k))]
console.log(JSON.stringify({ st, perf, hf, evN: ev.length, kills, shots, kinds, errors, shot }, null, 1))
process.exit(errors.length || !perf.n ? 1 : 0)
