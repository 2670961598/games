#!/usr/bin/env node
/* =====================================================================
 * GAMES-146 钢铁洪流 DEV 浏览器冒烟——quick 入局（:4400 网关）→ 快照流→
 * canvas 墨水在场+HUD __applied 自证+无页面错误+HF 分级+截图留档。
 * 用法：node scripts/iron-torrent-smoke.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const OUT = argOf('--out') || '/tmp/iron-146-shots'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
await mkdir(OUT, { recursive: true })
let pageErrors = []
let page
try {
  page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  /* :4399 已在跑（serve games/）；gw 指 :4400 网关 */
  await page.goto('http://127.0.0.1:4399/games/multiplayer/iron-torrent/index.html?gw=http://127.0.0.1:4400', { waitUntil: 'load', timeout: 15000 })
  await sleep(4500) // quick 入局+welcome+首张快照+首帧渲染
  const seat = await page.evaluate(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.dbgEvents && window.__GAMES_DEBUG__.dbgEvents().find((e) => e.event === 'welcome'))
  A('S1', 'welcome 到达（quick 入局就席）', !!(seat && seat.payload && seat.payload.seat >= 0),
    seat ? `seat=${seat.payload.seat} engine=${seat.payload.engine}#${String(seat.payload.physicsHash).slice(0, 8)}` : '未见 welcome')
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.hudFonts && window.__GAMES_DEBUG__.hudFonts())
  A('S2', 'HUD __applied 生效往返自证（Q-013 第一断言位）', !!(hf && hf.__applied === true), `__applied=${hf && hf.__applied}`)
  A('S3', 'HF 分级 P0≥13/P1≥11/P2≥9（当帧登记）',
    !!(hf && hf.cls.P0.min >= 13 && hf.cls.P1.min >= 11 && hf.cls.P2.min >= 9),
    hf ? `P0=${hf.cls.P0.min} P1=${hf.cls.P1.min} P2=${hf.cls.P2.min}（n=${hf.cls.P0.n}/${hf.cls.P1.n}/${hf.cls.P2.n}）` : '无登记')
  /* 墨水在场：战场铁灰底+掩体+HUD 三带像素采样 */
  const ink = await page.evaluate(() => {
    const cv = document.getElementById('cv')
    const g = cv.getContext('2d')
    const probe = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
    return { top: probe(187, 20), field: probe(187, 300), bot: probe(187, 640) }
  })
  const isGray = (c) => Math.abs(c[0] - c[1]) < 24 && Math.abs(c[1] - c[2]) < 24
  A('S4', '战场三带墨水在场（顶栏/战场/底栏分带）',
    ink.top[0] !== 0 && ink.field[2] > 0 && isGray(ink.field) && ink.bot[0] !== 255,
    `top=${ink.top} field=${ink.field} bot=${ink.bot}`)
  const stats = await page.evaluate(() => {
    const cv = document.getElementById('cv')
    const g = cv.getContext('2d')
    const d = g.getImageData(17, 56, 340, 500).data
    let nonBg = 0
    for (let i = 0; i < d.length; i += 40) { // 稀疏采样
      const r = d[i], gg = d[i + 1], b = d[i + 2]
      if (Math.abs(r - 43) > 8 || Math.abs(gg - 46) > 8 || Math.abs(b - 51) > 8) nonBg++
    }
    return { nonBg, total: Math.floor(d.length / 40) }
  })
  A('S5', '战场域墨水占比 >3%（掩体/坦克/弹道/HUD 渲染在场）',
    stats.nonBg / stats.total > 0.03, `${stats.nonBg}/${stats.total}=${(stats.nonBg / stats.total * 100).toFixed(1)}%`)
  A('S6', '无页面错误', pageErrors.length === 0, pageErrors.length ? pageErrors[0].slice(0, 120) : '0 errors')
  await page.screenshot({ path: join(OUT, 'iron-smoke-play.png') })
  console.error(`截图：${OUT}/iron-smoke-play.png`)
} catch (e) {
  A('S0', '冒烟执行', false, String(e.message || e))
} finally {
  await browser.close()
}
const failed = results.filter((r) => !r.pass).length
console.error(`\n${failed === 0 ? 'IRON-SMOKE OK' : 'IRON-SMOKE FAILED'}：${results.length - failed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
