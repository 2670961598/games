#!/usr/bin/env node
/* =====================================================================
 * GAMES-68 识图 v2 复检（帝国萌芽 DEV 单，quality-pipeline §8.4 口径，
 * 适配自 vis-slg-battlefield.mjs）：
 *   1) 几何断言（真实 375×667 视口、DSF=1）：scrollWidth ≤ clientWidth、
 *      无可见元素越视口、画布完整落于视口内；
 *   2) 墨水带地面真值（CDP canvas 像素直读）：本作带位 顶栏 0-56 /
 *      表盘区 56-561（城/军双盘）/ 底栏 561-667（兵池/切换钮/快出条）；
 *   3) HUD 字号断言（hud-font-standard §1）：__GAMES_DEBUG__.hudFonts()
 *      登记表——P0 ≥13px / P1 ≥11px / P2 ≥9px；
 *   4) 双表盘切换实测（〔军〕钮 tap → dial()=war）；
 *   5) 截图落盘 DSF=1（识图素材）：home(boot)/city(领地盘)/war(战场盘)/late(终局)。
 * 用法：node scripts/vis-empire-sprout.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/Volumes/BigDisk/Studio/kernel/workers/GAMES-68-shots'

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

const PORT = 49500 + Math.floor(Math.random() * 3000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-emp-'))
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
const report = { tool: 'scripts/vis-empire-sprout.mjs (GAMES-68, 识图v2)', generatedAt: new Date().toISOString() }
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))

  /* 离线 ?debug=1 + maxTicks=600（60s 打满 → timeout 终局，取证四时刻） */
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/empire-sprout/index.html?debug=1&maxTicks=600`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15000 })

  /* ---- V1 几何断言 ---- */
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
  await page.screenshot({ path: join(OUT, 'empire-sprout-home.png') })

  /* ---- V3 领地表盘（默认盘）墨水带 + 字号 ---- */
  console.log('[V3] 领地表盘墨水带 + 字号断言')
  await page.waitForTimeout(2500)   // 资源累积/首建筑可见（bot 邻位建设）
  const ink = () => page.evaluate(() => {
    const g = document.getElementById('cv').getContext('2d')
    const bands = [
      { name: 'top', y0: 0, y1: 56 },
      { name: 'mid', y0: 56, y1: 561 },
      { name: 'bottom', y0: 561, y1: 667 },
    ]
    const out = {}
    for (const b of bands) {
      const d = g.getImageData(0, b.y0, 375, b.y1 - b.y0).data
      let inkN = 0, total = 0
      for (let i = 0; i < d.length; i += 28) {
        total++
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2])
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        if (mx - mn > 24 || lum > 44 || lum < 8) inkN++
      }
      out[b.name] = total ? +(inkN / total).toFixed(3) : 0
    }
    return out
  })
  const inkCity = await ink()
  ok('V3-1', '顶栏带着墨（三联资源+爆发倒计时）', inkCity.top > 0.05, `top=${(inkCity.top * 100).toFixed(1)}%`)
  ok('V3-2', '表盘区带着墨（建筑位+城心城墙镜像）', inkCity.mid > 0.02, `mid=${(inkCity.mid * 100).toFixed(1)}%`)
  ok('V3-3', '底栏带着墨（兵池徽标+切换钮）', inkCity.bottom > 0.05, `bottom=${(inkCity.bottom * 100).toFixed(1)}%`)
  await page.screenshot({ path: join(OUT, 'empire-sprout-city.png') })

  /* ---- V3b 双表盘切换（〔军〕钮 tap → dial=war）---- */
  await page.touchscreen.tap(331, 602)   // GEO.togWar 中心（300..362, 583..621）
  await page.waitForFunction(() => window.__GAMES_DEBUG__.dial() === 'war', null, { timeout: 3000 })
  ok('V3-4', '双表盘切换（tap〔军〕→ war 盘）', true)
  await page.waitForTimeout(400)
  const inkWar = await ink()
  ok('V3-5', '战场盘表盘区着墨（车道+墙心+血条）', inkWar.mid > 0.02, `mid=${(inkWar.mid * 100).toFixed(1)}%`)
  await page.screenshot({ path: join(OUT, 'empire-sprout-war.png') })
  await page.touchscreen.tap(263, 602)   // 切回城盘

  /* ---- 字号断言（hudFonts 登记表 vs 分级下限，hud-font-standard §1） ---- */
  const fonts = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const p0Bad = [], p1Bad = [], p2Bad = []
  for (const [grp, keys] of Object.entries({ top: ['res', 'clock', 'merit'], bottom: ['pool', 'tog'], war: ['hp', 'cd'], city: ['hp'] })) {
    for (const k of keys) { const v = fonts[grp] && fonts[grp][k]; if (!(v >= 13)) p0Bad.push(`${grp}.${k}=${v}`) }
  }
  for (const [grp, keys] of Object.entries({ top: ['rate'], bottom: ['quick'], city: ['bname', 'blv', 'hplabel'] })) {
    for (const k of keys) { const v = fonts[grp] && fonts[grp][k]; if (!(v >= 11)) p1Bad.push(`${grp}.${k}=${v}`) }
  }
  for (const [grp, keys] of Object.entries({ bottom: ['q'], city: ['ally'], war: ['lane', 'unitTier'] })) {
    for (const k of keys) { const v = fonts[grp] && fonts[grp][k]; if (!(v >= 9)) p2Bad.push(`${grp}.${k}=${v}`) }
  }
  ok('V3-6', 'P0 数字 ≥13px（资源/倒计时/战功/兵池/切换/HP/CD）', p0Bad.length === 0, p0Bad.join(',') || '全达标')
  ok('V3-7', 'P1 交互标签 ≥11px（产出率/快出/建筑名/等级）', p1Bad.length === 0, p1Bad.join(',') || '全达标')
  ok('V3-8', 'P2 辅助 ≥9px（队列/盟友标注/车道/T 徽）', p2Bad.length === 0, p2Bad.join(',') || '全达标')

  /* ---- V4 终局结算（maxTicks=600 → timeout） ---- */
  console.log('[V4] 终局结算')
  await page.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'end'), null, { timeout: 90000 })
  const resultShown = await page.evaluate(() => document.getElementById('result').style.display === 'flex')
  ok('V4-1', '结算 overlay display:flex', resultShown)
  const btns = await page.evaluate(() => [...document.querySelectorAll('#result button')].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled })))
  ok('V4-2', '按钮集合 [再来一局|回大厅]', btns.length === 2 && btns[0].t.includes('再来一局') && btns[1].t.includes('回大厅'), JSON.stringify(btns.map((b) => b.t)))
  const rrect = await page.evaluate(() => {
    const r = document.querySelector('#result .rbox').getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
  })
  ok('V4-3', '结算弹层完整落于视口内', rrect.top >= 0 && rrect.bottom <= 667.5 && rrect.left >= -0.5 && rrect.right <= 375.5, JSON.stringify(rrect))
  await page.screenshot({ path: join(OUT, 'empire-sprout-late.png') })

  ok('V5', '整轮零 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join('; '))
  report.inkCity = inkCity; report.inkWar = inkWar; report.fonts = fonts; report.geo = geo; report.buttons = btns; report.pageErrors = pageErrors
  await context.close()
} catch (e) {
  failed++
  console.error('  ✗ 识图复检异常：', String(e && e.message || e))
  report.error = String(e && e.message || e)
}

await browser.close()
await rm(dataDir, { recursive: true, force: true })
try { server.kill('SIGTERM') } catch { /* best effort */ }
const { writeFile } = await import('node:fs/promises')
await writeFile(join(OUT, 'vis-empire-sprout-report.json'), JSON.stringify(report, null, 2))
report.passed = passed; report.failed = failed
console.log(`\n[vis-emp] ${passed} passed, ${failed} failed；截图 → ${OUT}`)
process.exitCode = failed ? 1 : 0
