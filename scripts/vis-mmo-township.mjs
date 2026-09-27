#!/usr/bin/env node
/* =====================================================================
 * GAMES-64 识图 v2 复检（星海小镇 VIS 单专用，quality-pipeline §8.4 口径，
 * 范式=scripts/vis-slg-battlefield.mjs GAMES-57）：
 *   1) 几何断言（真实 375×667 视口、DSF=1）：scrollWidth ≤ clientWidth、无可见元素
 *      越视口、画布完整落于视口内；
 *   2) 墨水带地面真值（CDP canvas 像素直读）：本作带位 顶栏 0-56 / 世界 56-571 /
 *      底栏 571-667（BOT_H=96）；
 *   3) HUD 字号断言（GAMES-64 核心）：__GAMES_DEBUG__.hudFonts() 运行时登记表——
 *      P0 数字 ≥13px、P1 交互标签 ≥11px、P2 辅助 ≥9px（docs/hud-font-standard.md §1）；
 *      条件态键（建造钮/轮盘名/格内计数）走 client.js 源静态审计兜底（§4 口径）；
 *   4) 夜间资源点对比度（本单 §2 可读性校验）：昼/夜两时刻 glyph vs 背景亮度差；
 *   5) 截图落盘 DSF=1：home/play/night/settle/lobby + 灰度素材（色盲形状通道）。
 * 用法：node scripts/vis-mmo-township.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/Volumes/BigDisk/Studio/kernel/workers/GAMES-64-shots'

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

const PORT = 48500 + Math.floor(Math.random() * 3000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-mmo-'))
const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games'), WEB_DIR: 'web' },
  stdio: ['ignore', 'ignore', 'pipe'],
})
await new Promise((res) => {
  const t = setTimeout(res, 8000)
  server.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res() } })
  fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
})
await mkdir(OUT, { recursive: true })

/* 字号分级表（docs/hud-font-standard.md §1；键=client.js HF 登记） */
const TIER = {
  P0: ['top.townLv', 'top.expNum', 'top.meteor', 'top.day', 'bot.bagSum', 'bot.contrib', 'fx.rise'],
  P1: ['world.bldCost', 'world.buildBtn', 'fx.wheelName', 'bot.bagCount', 'fx.toast', 'bot.quickWheel'],
  P2: ['top.expLabel', 'top.ping', 'top.north', 'world.desk', 'world.bldName', 'world.bldLv',
    'world.mayor', 'world.pname', 'world.siteEmpty', 'fx.bubble', 'fx.note', 'fx.wheelHint',
    'fx.wheelGlyph', 'bot.quickGlyph', 'bot.contribLabel'],
}
const FLOOR = { P0: 13, P1: 11, P2: 9 }
const tierOf = (k) => ['P0', 'P1', 'P2'].find((t) => TIER[t].includes(k))

const browser = await chromium.launch({ headless: true })
const report = { tool: 'scripts/vis-mmo-township.mjs (GAMES-64, 识图v2)', generatedAt: new Date().toISOString() }
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))

  /* ?debug=1 幽灵镇（确定性渲染，零网关依赖） */
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/mmo-township/index.html?debug=1`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15000 })
  await page.waitForTimeout(700)

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
  await page.screenshot({ path: join(OUT, 'mmo-township-home.png') })

  /* ---- V2 对局态墨水带 + 事件驱动（飘字/气泡/toast 上场） ---- */
  console.log('[V2] 对局态墨水带 + 字号断言')
  await page.evaluate(() => {
    const d = window.__GAMES_DEBUG__
    d.ev({ k: 'deposit', seat: 3, n: 24 })
    d.ev({ k: 'deposit', seat: 8, n: 12 })
    d.ev({ k: 'emote', seat: 5, id: 0, to: 1 })
    d.ev({ k: 'levelup', level: 3 })
  })
  await page.waitForTimeout(400)
  const inkPlay = await page.evaluate(() => {
    const g = document.getElementById('cv').getContext('2d')
    const W = 375
    const bands = [
      { name: 'top', y0: 0, y1: 56 },        // 顶栏 HUD 带
      { name: 'field', y0: 56, y1: 571 },    // 世界带（H-BOT_H=571）
      { name: 'bot', y0: 571, y1: 667 },     // 底栏带（表情快捷条+背包+贡献）
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
  ok('V2-1', '顶栏带着墨（镇进度/在线列/倒计时）', inkPlay.top > 0.05, `top=${(inkPlay.top * 100).toFixed(1)}%`)
  ok('V2-2', '世界带着墨（贡献台/建筑/镇民）', inkPlay.field > 0.02, `field=${(inkPlay.field * 100).toFixed(1)}%`)
  ok('V2-3', '底栏带着墨（快捷条+背包+贡献）', inkPlay.bot > 0.05, `bot=${(inkPlay.bot * 100).toFixed(1)}%`)
  await page.screenshot({ path: join(OUT, 'mmo-township-play.png') })

  /* 灰度素材（色盲双编码形状通道：docs/hud-font-standard.md §3 口径） */
  const grayShot = await page.evaluate(() => {
    const cv = document.getElementById('cv')
    const c2 = document.createElement('canvas')
    c2.width = cv.width; c2.height = cv.height
    const g2 = c2.getContext('2d')
    g2.filter = 'grayscale(1)'
    g2.drawImage(cv, 0, 0)
    return c2.toDataURL('image/png')
  })
  await writeFile(join(OUT, 'mmo-township-play-gray.png'), Buffer.from(grayShot.split(',')[1], 'base64'))

  /* 字号断言：运行时登记表（当帧实际绘制） */
  const fonts = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const flat = {}
  for (const [g, ks] of Object.entries(fonts)) for (const [k, v] of Object.entries(ks)) flat[`${g}.${k}`] = v
  const mustHave = ['top.townLv', 'top.expNum', 'top.meteor', 'top.day', 'bot.bagSum', 'bot.contrib', 'world.desk', 'world.bldName', 'world.pname']
  ok('V2-4', '常显 HUD 键全部登记（hudFonts 自证有效）', mustHave.every((k) => flat[k] != null), `${Object.keys(flat).length} 键`)
  const liveBad = []
  for (const [k, v] of Object.entries(flat)) {
    const t = tierOf(k)
    if (t && !(v >= FLOOR[t])) liveBad.push(`${k}=${v}<${FLOOR[t]}(${t})`)
  }
  ok('V2-5', '运行时字号全过分级下限（P0≥13/P1≥11/P2≥9）', liveBad.length === 0, liveBad.join(',') || `${Object.keys(flat).length} 键全达标`)

  /* 条件态键静态审计（§4：源码 HF 登记值 + 无裸 px 字号残留） */
  const src = await readFile(join(ROOT, 'games/multiplayer/mmo-township/client.js'), 'utf8')
  const reg = [...src.matchAll(/HF\('([a-z]+)', '([a-zA-Z]+)', (\d+)(?: \+[^,]*)?[,)]/g)]
    .map((m) => ({ k: `${m[1]}.${m[2]}`, px: +m[3] }))
  const staticBad = reg.filter((e) => { const t = tierOf(e.k); return t && !(e.px >= FLOOR[t]) })
  const stray = src.match(/ctx\.font = '\d+px ' \+ FONT/g) || []
  ok('V2-6', '静态审计：全量 HF 登记过分级下限（含条件态键）', staticBad.length === 0 && reg.length >= 26, staticBad.map((e) => `${e.k}=${e.px}`).join(',') || `${reg.length} 键`)
  ok('V2-7', '无裸字号残留（一律走 HF 登记）', stray.length === 0, stray.slice(0, 2).join('; ') || '0 处')

  /* ---- V3 夜间资源点对比度（本单 §2：昼夜过渡可读性校验） ----
     资源点都在分区（镇中心镜头看不见）——先 camTo 平移到最近节点再采样 */
  console.log('[V3] 夜间资源点对比度')
  await page.evaluate(() => {
    const d = window.__GAMES_DEBUG__
    const pr = d.worldProbe()
    if (!pr.nodes.length) return null
    let best = pr.nodes[0], bd = 1e18
    for (const n of pr.nodes) {
      const dd = (n.x / 1000 - pr.cam.x) ** 2 + (n.y / 1000 - pr.cam.y) ** 2
      if (dd < bd) { bd = dd; best = n }
    }
    d.camTo(best.x, best.y)
    return best.k
  })
  await page.waitForTimeout(150)
  const contrastAt = async () => page.evaluate(() => {
    const d = window.__GAMES_DEBUG__
    const pr = d.worldProbe()
    if (!pr.nodes.length) return null
    let best = pr.nodes[0], bd = 1e18
    for (const n of pr.nodes) {
      const dd = (n.x / 1000 - pr.cam.x) ** 2 + (n.y / 1000 - pr.cam.y) ** 2
      if (dd < bd) { bd = dd; best = n }
    }
    const px = best.x / 1000 - pr.cam.x + 187.5, py = best.y / 1000 - pr.cam.y + 333.5
    const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
    let gs = 0, gn = 0
    for (let a = 0; a < 8; a++) for (let r = 2; r <= 6; r += 2) {
      gs += lum(d.px(px + Math.cos(a) * r, py + Math.sin(a) * r)); gn++
    }
    let bs = 0, bn = 0
    for (let a = 0; a < 12; a++) {
      bs += lum(d.px(px + Math.cos(a / 12 * 6.283) * 38, py + Math.sin(a / 12 * 6.283) * 38)); bn++
    }
    return { kind: best.k, glyph: +(gs / gn).toFixed(1), bg: +(bs / bn).toFixed(1), contrast: +Math.abs(gs / gn - bs / bn).toFixed(1), sky: pr.sky.f }
  })
  const dayC = await contrastAt()
  await page.evaluate(() => window.__GAMES_DEBUG__.jumpDayTick(2800))   // f=1 深夜
  await page.waitForTimeout(400)
  const nightC = await contrastAt()
  await page.screenshot({ path: join(OUT, 'mmo-township-night.png') })
  ok('V3-1', '昼间资源点对比度 ≥25（glyph vs 背景亮度差）', dayC && dayC.contrast >= 25, dayC ? `${dayC.kind} Δ=${dayC.contrast}` : '无节点')
  ok('V3-2', '夜间资源点对比度 ≥25', nightC && nightC.contrast >= 25, nightC ? `${nightC.kind} Δ=${nightC.contrast} f=${nightC.sky}` : '无节点')
  ok('V3-3', '夜不劣于昼 25% 以上（过渡不吞可读性）', dayC && nightC && nightC.contrast >= dayC.contrast * 0.75, `昼 ${dayC && dayC.contrast} vs 夜 ${nightC && nightC.contrast}`)
  await page.evaluate(() => {
    const d = window.__GAMES_DEBUG__
    d.jumpDayTick(1200)   // 回昼
    d.camTo(700000, 1300000)   // 镜头回镇中心，供结算取证
  })

  /* ---- V4 镇日结算（进镇结算提示：DOM overlay 几何+字号） ---- */
  console.log('[V4] 镇日结算')
  await page.evaluate(() => window.__GAMES_DEBUG__.ev({ k: 'settle', day: 1 }))
  await page.waitForTimeout(300)
  const settle = await page.evaluate(() => {
    const el = document.getElementById('settle')
    const box = document.querySelector('#settle .sbox')
    const r = box.getBoundingClientRect()
    const row = getComputedStyle(document.querySelector('.srow'))
    const num = getComputedStyle(document.querySelector('.srow b'))
    return { shown: el.style.display === 'flex', box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, rowPx: parseFloat(row.fontSize), numPx: parseFloat(num.fontSize), numW: num.fontWeight }
  })
  ok('V4-1', '结算 overlay display:flex', settle.shown)
  ok('V4-2', '结算弹层完整落于视口内', settle.box.top >= -0.5 && settle.box.bottom <= 667.5 && settle.box.left >= -0.5 && settle.box.right <= 375.5, JSON.stringify(settle.box))
  ok('V4-3', '结算战报行 ≥13px（P0 数字语境）+ 数字 600', settle.rowPx >= 13 && settle.numPx >= 13 && +settle.numW >= 600, `row=${settle.rowPx} num=${settle.numPx}/${settle.numW}`)
  await page.screenshot({ path: join(OUT, 'mmo-township-settle.png') })
  await page.evaluate(() => { document.getElementById('settle').style.display = 'none' })

  /* ---- V5 大厅：21 槽位状态视觉一致性 ---- */
  console.log('[V5] 大厅 21 槽位')
  await page.goto(`http://127.0.0.1:${PORT}/multiplayer.html`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForSelector('.mp-slot', { timeout: 8000 })
  await page.waitForTimeout(600)
  const lobby = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.mp-grid .mp-slot')]
    const on = slots.filter((s) => s.classList.contains('on'))
    const soon = slots.filter((s) => s.classList.contains('soon'))
    const cs = (el, prop) => parseFloat(getComputedStyle(el)[prop])
    const name = document.querySelector('.mp-slot__name'), tag = document.querySelector('.mp-slot__tag')
    const meta = document.querySelector('.mp-card__meta'), ctime = document.querySelector('.mp-card__time')
    const grid = document.getElementById('mp-grid').getBoundingClientRect()
    const onOp = on.length ? getComputedStyle(on[0]).borderColor : ''
    const soonOp = soon.length ? getComputedStyle(soon[0]).borderColor : ''
    return {
      total: slots.length, on: on.length, soon: soon.length,
      namePx: cs(name, 'fontSize'), tagPx: cs(tag, 'fontSize'),
      metaPx: meta ? cs(meta, 'fontSize') : null, timePx: ctime ? cs(ctime, 'fontSize') : null,
      grid: { left: grid.left, right: grid.right }, onOp, soonOp,
    }
  })
  ok('V5-1', '21 槽位齐备（on+soon）', lobby.total === 21 && lobby.on + lobby.soon === 21, `on=${lobby.on} soon=${lobby.soon}`)
  ok('V5-2', '槽名 ≥13px / 槽标 ≥9px（P1/P2）', lobby.namePx >= 13 && lobby.tagPx >= 9, `name=${lobby.namePx} tag=${lobby.tagPx}`)
  ok('V5-3', '对局卡 meta/时长 ≥11px（P1）', (lobby.metaPx == null || lobby.metaPx >= 11) && (lobby.timePx == null || lobby.timePx >= 11), `meta=${lobby.metaPx} time=${lobby.timePx}`)
  ok('V5-4', 'on/soon 状态双通道可辨（边框色+明度差）', lobby.onOp !== lobby.soonOp, `on=${lobby.onOp} soon=${lobby.soonOp}`)
  ok('V5-5', '目录网格不出视口', lobby.grid.left >= -0.5 && lobby.grid.right <= 375.5, JSON.stringify(lobby.grid))
  await page.screenshot({ path: join(OUT, 'mmo-township-lobby.png'), fullPage: false })

  ok('V6', '整轮零 pageerror（游戏+大厅）', pageErrors.length === 0, pageErrors.slice(0, 2).join('; '))
  report.ink = inkPlay; report.fonts = flat; report.geo = geo; report.contrast = { day: dayC, night: nightC }
  report.settle = settle; report.lobby = lobby; report.pageErrors = pageErrors
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
await writeFile(join(OUT, 'vis-mmo-township.json'), JSON.stringify(report, null, 2))
console.log(`\n[vis-mmo] ${passed} passed, ${failed} failed；截图 → ${OUT}`)
process.exitCode = failed ? 1 : 0
