#!/usr/bin/env node
/* =====================================================================
 * GAMES-132 QA二号 · 客户端观战体验冒烟（Playwright）
 * D3b：6 真人 WS 满员房 → 浏览器（第 7 人）撞满员 → 兜底旁观
 * 观测面：welcome.seat=-1 落地 mySeat、快照流渲染 ents、零页面错误、
 * ext.ack=-1 观战语义、HUD 计时推进（对局在屏）。
 * 环境：私有网关 GAMES_GW（默认 :4416），零感知 :4399/:4400。
 * =================================================================== */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4416'
const PORT = 8462
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`); cond ? pass++ : fail++ }
const wsOpen = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(GW.replace('http', 'ws') + '/ws')
  const inbox = []
  ws.onmessage = (ev) => inbox.push(JSON.parse(ev.data))
  ws.onopen = () => resolve({ ws, inbox })
  ws.onerror = () => reject(new Error('ws-error'))
})
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
    const buf = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(PORT, r))

/* 6 真人满员（首连 quick 建房，其余 join） */
const conns = []
const first = await wsOpen()
first.ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
await sleep(700)
const wel = first.inbox.find((m) => m.t === 'welcome')
ok('满员房建立', !!wel, `roomId=${wel && wel.roomId}`)
conns.push(first)
for (let i = 1; i < 6; i++) {
  const c = await wsOpen()
  c.ws.send(JSON.stringify({ t: 'join', roomId: wel.roomId, mode: 'play' }))
  await sleep(250)
  conns.push(c)
}
const seats = [wel.seat, ...conns.slice(1).map((c) => c.inbox.find((m) => m.t === 'welcome')?.seat)]
ok('6 真人满员', new Set(seats).size === 6, `seats=${seats.join(',')}`)

/* 第 7 人=浏览器：撞满员 → 兜底旁观 */
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/mini-moba/index.html?gw=${GW}&room=${wel.roomId}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().ents > 0, null, { timeout: 15_000 })
ok('观战页快照流渲染（ents>0，无 fatal）', true, '')
await page.waitForTimeout(4000)
const st = await page.evaluate(() => window.__GAMES_DEBUG__.state())
const ext = await page.evaluate(() => window.__GAMES_DEBUG__.ext())
ok('第 7 人兜底旁观落地（seat=-1）', st.seat === -1, `seat=${st.seat}`)
ok('观战语义（ext.ack=-1）', ext && ext.ack === -1, `ack=${ext && ext.ack}`)
ok('零页面错误', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean')
const shot = '/tmp/moba132-spec-shot.png'
await page.screenshot({ path: shot })
ok('观战截图落盘（识图锚）', true, shot)
for (const c of conns) c.ws.close()
await browser.close(); srv.close()
console.log(`\nQA二号 观战冒烟：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
