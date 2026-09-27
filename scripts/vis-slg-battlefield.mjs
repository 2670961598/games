#!/usr/bin/env node
/* =====================================================================
 * GAMES-57 识图 v2 复检（指挥官战场 VIS 单专用，quality-pipeline §8.4 口径）：
 *   1) 几何断言（真实 375×667 视口、DSF=1）：scrollWidth ≤ clientWidth、无可见元素
 *      越视口、画布完整落于视口内；
 *   2) 墨水带地面真值（CDP canvas 像素直读）：本作带位 顶栏 0-60 / 战场 60-560 /
 *      指挥区 560-667（visual-check.js 的通用四带适配 SLG 布局）；
 *   3) HUD 字号断言（GAMES-57 核心）：__GAMES_DEBUG__.hudFonts() 运行时登记表——
 *      P0 数字 ≥13px、P1 标签 ≥11px、P2 辅助 ≥9px（docs/hud-font-standard.md §1）；
 *   4) 截图落盘 DSF=1（识图素材）：home(joining/boot)/play(对局中)/late(终局结算)。
 * 用法：node scripts/vis-slg-battlefield.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/Volumes/BigDisk/Studio/kernel/workers/GAMES-57-shots'

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

const PORT = 48500 + Math.floor(Math.random() * 3000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-slg-'))
const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
await new Promise((res) => {
  const t = setTimeout(res, 8000)
  server.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res() } })
  fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
})
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const report = { tool: 'scripts/vis-slg-battlefield.mjs (GAMES-57, 识图v2)', generatedAt: new Date().toISOString() }
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))

  /* 离线档 ?debug=1：intro 3s 倒计时 → 对局 → 推进 → 终局结算，四时刻取证 */
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/slg-battlefield/index.html?debug=1&maxTicks=600`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15000 })

  /* ---- V1 几何断言（识图前先拦截 DPR/布局伪影） ---- */
  console.log('[V1] 几何断言')
  const geo = await page.evaluate(() => {
    const de = document.documentElement
    const vw = de.clientWidth
    const bad = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (r.right > vw + 0.5 || r.left < -0.5) bad.push(`${el.tagName}#${el.id || el.className}: left=${r.left.toFixed(1)} right=${r.right.toFixed(1)}`)
    }
    const cv = document.getElementById('cv').getBoundingClientRect()
    return { scrollW: de.scrollWidth, clientW: vw, canvas: { left: cv.left, top: cv.top, right: cv.right, bottom: cv.bottom }, bad }
  })
  ok('V1-1', 'scrollWidth ≤ clientWidth（无横向溢出）', geo.scrollW <= geo.clientW + 0.5, `scroll=${geo.scrollW} client=${geo.clientW}`)
  ok('V1-2', '无可见元素越视口', geo.bad.length === 0, geo.bad.slice(0, 3).join('; '))
  ok('V1-3', '画布完整落于 375×667 视口内', geo.canvas.left >= -0.5 && geo.canvas.right <= geo.clientW + 0.5 && geo.canvas.top >= -0.5 && geo.canvas.bottom <= 667.5, JSON.stringify(geo.canvas))

  /* ---- V2 intro/对局初帧截图（home 时刻） ---- */
  await page.waitForTimeout(600)   // intro 倒计时内（3→2→1 大数字 + 遮罩）
  await page.screenshot({ path: join(OUT, 'slg-battlefield-home.png') })

  /* ---- V3 对局中：跳过 intro 等待，play 时刻 ---- */
  console.log('[V3] 对局态墨水带 + 字号断言')
  await page.waitForFunction(() => {
    const d = window.__GAMES_DEBUG__
    return d && d.fxProbe && d.fxProbe().intro === 0      // intro 结束进入对局
  }, null, { timeout: 12000 })
  await page.waitForTimeout(1500)                          // 出兵卡墨水（bot 出兵 + HUD 全量呈现）
  const inkPlay = await page.evaluate(() => {
    const g = document.getElementById('cv').getContext('2d')
    const W = 375
    const bands = [
      { name: 'top', y0: 0, y1: 60 },          // 顶栏 HUD 带
      { name: 'field', y0: 60, y1: 560 },      // 战场带
      { name: 'cmd', y0: 560, y1: 667 },       // 指挥区带（6 卡 + 4 技能钮）
    ]
    const out = {}
    for (const b of bands) {
      const d = g.getImageData(0, b.y0, W, b.y1 - b.y0).data
      let ink = 0, total = 0
      for (let i = 0; i < d.length; i += 28) {
        total++
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2])
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        if (mx - mn > 24 || lum > 44 || lum < 8) ink++
      }
      out[b.name] = total ? +(ink / total).toFixed(3) : 0
    }
    return out
  })
  ok('V3-1', '顶栏带着墨（HUD 非空白）', inkPlay.top > 0.05, `top=${(inkPlay.top * 100).toFixed(1)}%`)
  ok('V3-2', '战场带着墨', inkPlay.field > 0.02, `field=${(inkPlay.field * 100).toFixed(1)}%`)
  ok('V3-3', '指挥区带着墨（卡面+技能钮）', inkPlay.cmd > 0.05, `cmd=${(inkPlay.cmd * 100).toFixed(1)}%`)
  await page.screenshot({ path: join(OUT, 'slg-battlefield-play.png') })

  /* 灰度化截图（色盲双编码形状通道素材：docs/hud-font-standard.md §3——去掉色相后
     旗帜形状/血条纹理/阴影轮廓应仍可辨敌我）。等待首塔易主，让旗帜上场 */
  await page.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__.state()
    return st && st.towers && st.towers.some((t) => t.owner)
  }, null, { timeout: 30000 }).catch(() => null)
  const grayShot = await page.evaluate(() => {
    const cv = document.getElementById('cv')
    const c2 = document.createElement('canvas')
    c2.width = cv.width; c2.height = cv.height
    const g2 = c2.getContext('2d')
    g2.filter = 'grayscale(1)'
    g2.drawImage(cv, 0, 0)
    return c2.toDataURL('image/png')
  })
  const { writeFile: wf } = await import('node:fs/promises')
  await wf(join(OUT, 'slg-battlefield-play-gray.png'), Buffer.from(grayShot.split(',')[1], 'base64'))

  /* 字号断言：hudFonts 登记表 vs 分级下限 */
  const fonts = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const P0 = { top: ['hp', 'score', 'pop', 'time'], bottom: ['rate', 'energy', 'pop'] }
  const P1 = { bottom: ['cardName', 'cardCost', 'skillName', 'skillCost', 'research'] }
  const p0Bad = [], p1Bad = []
  for (const [grp, keys] of Object.entries(P0)) for (const k of keys) {
    const v = fonts[grp] && fonts[grp][k]
    if (!(v >= 13)) p0Bad.push(`${grp}.${k}=${v}`)
  }
  for (const [grp, keys] of Object.entries(P1)) for (const k of keys) {
    const v = fonts[grp] && fonts[grp][k]
    if (!(v >= 11)) p1Bad.push(`${grp}.${k}=${v}`)
  }
  ok('V3-4', 'P0 数字 ≥13px（HP/积分/兵力/倒计时/CP 增速/能量）', p0Bad.length === 0, p0Bad.join(',') || '全达标')
  ok('V3-5', 'P1 交互标签 ≥11px（卡名/造价/技能/研究）', p1Bad.length === 0, p1Bad.join(',') || '全达标')
  ok('V3-6', 'P2 辅助 ≥9px（克制角标/T 徽/塔名/ping 徽标）', (fonts.bottom.counter >= 9 && fonts.field.tierBadge >= 9 && fonts.tower.name >= 9 && fonts.top.ping >= 9), `counter=${fonts.bottom.counter} tier=${fonts.field.tierBadge} tower=${fonts.tower.name} ping=${fonts.top.ping}`)

  /* ---- V4 终局结算截图（短局 maxTicks=600 → 60s 打满；等待自然终局） ---- */
  console.log('[V4] 终局结算')
  await page.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'end'), null, { timeout: 90000 })
  const resultShown = await page.evaluate(() => document.getElementById('result').style.display === 'flex')
  ok('V4-1', '结算 overlay display:flex', resultShown)
  const btns = await page.evaluate(() => [...document.querySelectorAll('#result button')].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled })))
  ok('V4-2', '按钮集合 [再来一局|战报回放(灰置)|回大厅]', btns.length === 3 && btns[1].disabled && btns[1].t.includes('战报回放'), JSON.stringify(btns.map((b) => b.t)))
  /* §8.4 几何裁决：识图叙述"弹层上部与状态条重叠"时，以 rbox 真实矩形为准
     （半透明遮罩透出下层属设计语义，非越界） */
  const rrect = await page.evaluate(() => {
    const r = document.querySelector('#result .rbox').getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }
  })
  ok('V4-3', '结算弹层完整落于视口内（几何裁决）', rrect.top >= 0 && rrect.bottom <= 667.5 && rrect.left >= -0.5 && rrect.right <= 375.5, JSON.stringify(rrect))
  await page.screenshot({ path: join(OUT, 'slg-battlefield-late.png') })

  ok('V5', '整轮零 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join('; '))
  report.ink = inkPlay; report.fonts = fonts; report.geo = geo; report.buttons = btns; report.pageErrors = pageErrors
  await context.close()
} catch (e) {
  failed++
  console.error('  ✗ 识图复检异常：', String(e && e.message || e))
  report.error = String(e && e.message || e)
}

await browser.close()
await rm(dataDir, { recursive: true, force: true })
try { server.kill('SIGTERM') } catch { /* best effort */ }
report.passed = passed; report.failed = failed
console.log(`\n[vis-slg] ${passed} passed, ${failed} failed；截图 → ${OUT}`)
process.exitCode = failed ? 1 : 0
