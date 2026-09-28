#!/usr/bin/env node
/* =====================================================================
 * GAMES-68 识图 v2 复检（帝国萌芽 DEV 单，quality-pipeline §8.4 口径，
 * 适配自 vis-slg-battlefield.mjs）：
 *   1) 几何断言（真实 375×667 视口、DSF=1）：scrollWidth ≤ clientWidth、
 *      无可见元素越视口、画布完整落于视口内；
 *   2) 墨水带地面真值（CDP canvas 像素直读）：本作带位 顶栏 0-56 /
 *      表盘区 56-561（城/军双盘）/ 底栏 561-667（兵池/切换钮/快出条）；
 *   3) HUD 字号断言（hud-font-standard §1）：__GAMES_DEBUG__.hudFonts()
 *      运行时登记表——P0 ≥13px / P1 ≥11px / P2 ≥9px；GAMES-75 起双审计：
 *      常显键运行时断言 + 源码静态正则兜条件态键（面板/CD 环），并断言零裸字号；
 *   4) 双表盘切换实测（〔军〕钮 tap → dial()=war）+ 爆发时间轴条/双方战线断言（GAMES-75）；
 *   5) 截图落盘 DSF=1（识图素材）：home(boot)/city(领地盘)/war(战场盘)/war-live(实兵)/late(终局)。
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

  /* 离线 ?debug=1 全时长 7200（GAMES-75：爆发后场景/战线/终局全取证——fast 快进不耗时） */
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/empire-sprout/index.html?debug=1`, { waitUntil: 'load', timeout: 20000 })
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

  /* ---- V3c 爆发时间轴条（GAMES-75：双层 HUD 行分界 = 0──筑城──◆1800──鏖战 条） ---- */
  const tl = await page.evaluate(() => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(10, 50, 355, 7).data
    let amber = 0, bright = 0, n = 0
    for (let x = 0; x < 355; x++) {
      const i = ((3) * 355 + x) * 4   // y=53 行（条带中心）
      const r = d[i], gg = d[i + 1], b = d[i + 2]
      n++
      if (r > 90 && r > b + 40 && gg > 55) amber++
      if (r > 150 && gg > 145 && b > 130) bright++
    }
    return { amber: amber / n, bright }
  })
  ok('V3-5b', '爆发时间轴条·筑城段着墨（琥珀带 ≥筑城段宽 87.75/351≈24%）', tl.amber > 0.15, `amber=${(tl.amber * 100).toFixed(1)}%`)
  ok('V3-5c', '爆发时间轴条·当前刻游标高亮（白亮像素 ≥2）', tl.bright >= 2, `bright=${tl.bright}`)

  /* ---- 字号断言（hudFonts 运行时登记 vs 分级下限，hud-font-standard §1） ----
   * GAMES-75 起登记表=HF 落笔即记（真运行时自证）；本流程常显键运行时断言，
   * 条件态键（面板/CD 环/己方建筑名——自动局不开面板不出征）走 V3-9 静态审计双轨。 */
  const fonts = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const p0Bad = [], p1Bad = [], p2Bad = []
  for (const [grp, keys] of Object.entries({ top: ['res', 'clock'], bottom: ['pool', 'tog'], city: ['hp'] })) {
    for (const k of keys) { const v = fonts[grp] && fonts[grp][k]; if (!(v >= 13)) p0Bad.push(`${grp}.${k}=${v}`) }
  }
  for (const [grp, keys] of Object.entries({ top: ['resLab'], bottom: ['poolLab', 'quick'], city: ['hplabel', 'ownLab'] })) {
    for (const k of keys) { const v = fonts[grp] && fonts[grp][k]; if (!(v >= 11)) p1Bad.push(`${grp}.${k}=${v}`) }
  }
  for (const [grp, keys] of Object.entries({ bottom: ['q'], city: ['ally'] })) {   // allyPlot 盟友首建前不现→静态审计
    for (const k of keys) { const v = fonts[grp] && fonts[grp][k]; if (!(v >= 9)) p2Bad.push(`${grp}.${k}=${v}`) }
  }
  ok('V3-6', 'P0 数字 ≥13px·运行时（资源/倒计时/兵池/切换/城心HP）', p0Bad.length === 0, p0Bad.join(',') || '全达标')
  ok('V3-7', 'P1 交互标签 ≥11px·运行时（资源名/兵池标注/快出/镜像标签）', p1Bad.length === 0, p1Bad.join(',') || '全达标')
  ok('V3-8', 'P2 辅助 ≥9px·运行时（队列/盟友标注/盟友建筑）', p2Bad.length === 0, p2Bad.join(',') || '全达标')

  /* ---- V3-9 静态审计（零裸字号 + 全量 HF 分级下限，含条件态键） ---- */
  const src = await import('node:fs').then((m) => m.readFileSync(join(ROOT, 'games/multiplayer/empire-sprout/client.js'), 'utf8'))
  const bareFonts = (src.match(/ctx\.font\s*=/g) || []).length
  ok('V3-9a', '零裸字号（client.js 唯一 ctx.font 赋值在 HF 内）', bareFonts === 1, `ctx.font 赋值数=${bareFonts}`)
  const TIER = { 0: 13, 1: 11, 2: 9 }
  const KEY_TIER = {
    'top.res': 0, 'top.clock': 0, 'top.merit': 0, 'bottom.pool': 0, 'bottom.tog': 0, 'war.hp': 0, 'war.cd': 0, 'city.hp': 0, 'panel.title': 0, 'panel.n': 0, 'panel.ok': 0, 'panel.lane': 0, 'panel.close': 0,
    'top.resLab': 1, 'top.elap': 1, 'fx.txt': 1, 'bottom.poolLab': 1, 'bottom.quick': 1, 'city.bname': 1, 'city.blv': 1, 'city.hplabel': 1, 'city.ownLab': 1, 'city.add': 1, 'panel.name': 1, 'panel.cost': 1, 'panel.cardBtn': 1, 'panel.empty': 1, 'panel.laneLab': 1, 'fx.float': 1,
    'bottom.q': 2, 'city.ally': 2, 'city.allyPlot': 2, 'city.up': 2, 'city.qp': 2, 'war.keep': 2, 'war.unitTier': 2, 'panel.desc': 2, 'screen.banner': 0,
  }
  const hfCalls = [...src.matchAll(/HF\('([^']+)',\s*'([^']+)',\s*(\d+)(?:,\s*(\d+))?\s*[,)]/g)]
  const tierBad = [], seen = new Set()
  for (const m of hfCalls) {
    const key = `${m[1]}.${m[2]}`, px = +m[3], w = m[4] === undefined ? 400 : +m[4]
    seen.add(key)
    const t = KEY_TIER[key]
    if (t === undefined) { tierBad.push(`${key}=未声明分级`); continue }
    if (px < TIER[t]) tierBad.push(`${key}=${px}<${TIER[t]}`)
    if (t === 0 && w < 600) tierBad.push(`${key}=${w}w<600`)
  }
  if (/HF\('top', 'clock', warn10 \? 14 : 13, 600\)/.test(src)) seen.add('top.clock')   // 脉动三元：两值均 ≥13/600
  for (const key of Object.keys(KEY_TIER)) if (!seen.has(key)) tierBad.push(`${key}=源码未检出`)
  ok('V3-9b', '静态分级审计（全量 HF 键含条件态：下限+P0 字重≥600+键登记）', tierBad.length === 0, tierBad.slice(0, 4).join(',') || `全量 ${seen.size} 键达标`)

  /* ---- V3d 爆发后战场（competitive 局：1800 CD 好即满池压上=timing attack，双方必交锋） ---- */
  await page.evaluate(() => window.__GAMES_DEBUG__.start(2, { bots: ['competitive', 'competitive', 'competitive'] }))
  await page.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'start'), null, { timeout: 8000 })
  await page.evaluate(() => window.__GAMES_DEBUG__.fast(1802))
  await page.waitForTimeout(1600)          // 对撞窗峰值（+1.5s 实时；GAMES-72 实证 tick 1815-1850）
  const post = await page.evaluate(() => {
    const f = window.__GAMES_DEBUG__.front()
    const fonts = window.__GAMES_DEBUG__.hudFonts()
    return { front: f, warHp: fonts.war && fonts.war.hp, unitTier: fonts.war && fonts.war.unitTier, merit: fonts.top && fonts.top.merit, elap: fonts.top && fonts.top.elap, dial: window.__GAMES_DEBUG__.dial() }
  })
  ok('V3-10', '爆发后自动切战斗盘（erupt → dial=war）', post.dial === 'war', `dial=${post.dial}`)
  ok('V3-11', 'P0 运行时·战后（战功/时长/墙心HP ≥13px）', post.merit >= 13 && post.elap >= 13 && post.warHp >= 13, `merit=${post.merit} elap=${post.elap} war.hp=${post.warHp}`)
  ok('V3-12', 'P2 运行时·T 徽 ≥9px（单位在场）', post.unitTier >= 9, `war.unitTier=${post.unitTier}`)
  ok('V3-13', '双方战线可视化（≥1 车道有交锋中线）', post.front.rows.some((r) => r >= 0), JSON.stringify(post.front.rows))
  const inkWarLive = await ink()
  ok('V3-14', '战场盘实兵着墨（单位+战线+血条）', inkWarLive.mid > 0.02, `mid=${(inkWarLive.mid * 100).toFixed(1)}%`)
  await page.screenshot({ path: join(OUT, 'empire-sprout-war-live.png') })

  /* ---- V4 终局结算（fast 至 7200 → timeout 裁定） ---- */
  console.log('[V4] 终局结算')
  await page.evaluate(() => window.__GAMES_DEBUG__.fast(7200))
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
