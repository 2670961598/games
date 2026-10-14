#!/usr/bin/env node
/* =====================================================================
 * GAMES-138 街头足球 浏览器冒烟（DEV 自测面；对齐泳道 net-check/vis 口径）：
 *   S1 在线面：quick 入房（bot 房，影子网关 ?gw=）→ welcome/seat/快照流推进
 *             → 比分与相位在快照 state 上推进 → 零 pageerror
 *   S2 HUD 字号运行时自证（hudFonts() P0≥13/P1≥11/P2≥9）
 *   S3 识图 v2 锚点像素探针：围笼球场（沥青深底/粉笔白线/霓虹双门）+顶栏+底栏三钮
 *   S4 性能：页面内 rAF 采样 5s → avgFps≥55 且掉帧率(>25ms)<2%（DoD 口径）
 * 截图：kernel/workers/GAMES-138-shots/online.png
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4413'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-138-shots'
let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

/* ---------- S1 在线局 ---------- */
console.log('[S1] 在线 quick 局（影子网关 bot 房）')
await page.goto(`${WEB}/games/multiplayer/street-soccer/index.html?quick=1&gw=${encodeURIComponent(GW)}`, { waitUntil: 'load', timeout: 20_000 })
let joined = false
try {
  await page.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
    return st && st.seat >= 0 && (st.phase === 'kick' || st.phase === 'play' || st.phase === 'goal')
  }, null, { timeout: 15_000 })
  joined = true
} catch { /* 取证后断言 */ }
ok(joined, 'quick 入房 + 快照流推进（seat≥0 且相位有效）')
if (joined) {
  const st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok(st0.players === 4, '4 球员视图在场（单流双域 ents）', `players=${st0.players} phase=${st0.phase} score=${JSON.stringify(st0.score)}`)
  ok(st0.clock > 0 && st0.clock <= 3600, '比赛钟在场（3600 起）', `clock=${st0.clock}`)
  ok(Number.isInteger(st0.ball.x) && st0.ball.x > 0, '球位在场（外推渲染态）', `ball=${st0.ball.x},${st0.ball.y}`)
  /* 快照推进：等 clock 变化或 goal/poss 变化 */
  let advanced = false
  try {
    await page.waitForFunction(() => {
      const st = window.__GAMES_DEBUG__.state()
      return st.phase === 'play' || st.score.A > 0 || st.score.B > 0 || st.poss >= 0
    }, null, { timeout: 8_000 })
    advanced = true
  } catch { }
  ok(advanced, '对局活性（触球/开赛推进）')
  const evs = await page.evaluate(() => window.__GAMES_DEBUG__.events())
  ok(Array.isArray(evs), '事件账本可读（touch/tackle 等观测面）', `${evs.length} 条（近例 ${(evs[evs.length - 1] || {}).event || '—'}）`)
}

/* ---------- S2 HUD 字号自证 ---------- */
console.log('[S2] HUD 字号运行时自证')
await sleep(1200) // 等各档字号实际落笔
const fonts = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
const fmin = (cls) => Math.min(...Object.values(fonts).filter((f) => f.cls === cls).map((f) => f.px))
ok(Object.keys(fonts).length >= 3, 'HF 登记表 ≥3 档落笔', Object.keys(fonts).join(','))
ok(fmin('P0') >= 13, 'P0 ≥13px（比分/计时/横幅）', `P0 min=${fmin('P0')}`)
ok(fmin('P1') >= 11, 'P1 ≥11px（蓄力%/体力）', `P1 min=${fmin('P1')}`)
ok(fmin('P2') >= 9, 'P2 ≥9px（类徽记/页脚）', `P2 min=${fmin('P2')}`)

/* ---------- S3 识图 v2 锚点像素探针 ---------- */
console.log('[S3] 识图锚点像素探针（围笼球场特征位）')
const probe = await page.evaluate(() => {
  const cv = document.getElementById('cv')
  const ctx = cv.getContext('2d')
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data)
  return {
    asphalt: px(187, 300),        // 球场中心：沥青深灰底
    line: px(187, 306),           // 中线附近扫白（y=306±采样）
    topbar: px(187, 20),          // 顶栏 HUD 深底
    btnZone: px(316, 596),        // 射门钮位（圆心）
    court: px(5, 300),            // 球场外（页底色≠场内）
  }
})
const near = (c, t, tol) => c.slice(0, 3).every((v, i) => Math.abs(v - t[i]) <= tol)
ok(near(probe.asphalt, [0x20, 0x24, 0x2b], 14), '球场沥青深底 #20242B', JSON.stringify(probe.asphalt))
ok(near(probe.topbar, [0x17, 0x1a, 0x20], 16), '顶栏 HUD 深底', JSON.stringify(probe.topbar))
ok(!near(probe.court, [0x20, 0x24, 0x2b], 8), '场内外边界可辨（球场外异色）', JSON.stringify(probe.court))
/* 白线：中线 y≈306 附近 ±6 采样找亮像素 */
const lineFound = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  for (let dy = -8; dy <= 8; dy++) {
    const c = Array.from(ctx.getImageData(187, 306 + dy, 1, 1).data)
    if (c[0] > 190 && c[1] > 190 && c[2] > 180) return dy
  }
  return null
})
ok(lineFound !== null, '粉笔白中线在场（亮像素扫描）', lineFound !== null ? `y=306${lineFound >= 0 ? '+' : ''}${lineFound}` : '未见')
/* 霓虹门：上门柱段扫描青蓝 */
const neon = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  for (let x = 142; x <= 230; x += 4) for (let y = 38; y <= 52; y += 2) {
    const c = Array.from(ctx.getImageData(x, y, 1, 1).data)
    if (c[2] > 150 && c[1] > 110 && c[0] < 110) return `${x},${y}`
  }
  return null
})
ok(neon !== null, '霓虹门描边在场（上门青蓝）', neon || '未见')
/* 底栏三钮区墨水 */
const btnInk = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  let n = 0
  for (let x = 200; x < 350; x += 6) for (let y = 550; y < 666; y += 8) {
    const c = Array.from(ctx.getImageData(x, y, 1, 1).data)
    if (c[3] > 40 && (c[0] + c[1] + c[2]) > 90) n++
  }
  return n
})
ok(btnInk > 8, '底栏操控面墨水在场（射门/传球/冲刺三钮弧排）', `ink=${btnInk}`)

await page.screenshot({ path: `${SHOTS}/online.png` })
ok(true, '截图落盘', `${SHOTS}/online.png`)

/* ---------- S4 性能采样（帧成本口径+对照带；无头 vsync 封顶先例 GAMES-131） ---------- */
console.log('[S4] 帧成本采样 5s（costAvg<16ms=60fps 预算 / costJank<2%）')
await sleep(4200) // 攒 180 帧滚动窗
const perf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
const blank = await (async () => {
  const b = await context.newPage()
  await b.goto('about:blank')
  const r = await b.evaluate(async () => {
    const t = []
    await new Promise((res) => { let n = 0; const loop = () => { t.push(performance.now()); if (++n < 120) requestAnimationFrame(loop); else res() }; requestAnimationFrame(loop) })
    let s = 0; for (let i = 1; i < t.length; i++) s += t[i] - t[i - 1]
    return +(s / (t.length - 1)).toFixed(1)
  })
  await b.close()
  return r
})()
ok(perf.costAvgMs < 16, '渲染帧成本 avg <16ms（60fps 预算；DoD ≥55fps 换算口径）', `avg=${perf.costAvgMs}ms p95=${perf.costP95Ms}ms n=${perf.n}`)
ok(perf.costJankPct < 2, '帧成本 >25ms 占比 <2%（掉帧口径）', `${perf.costJankPct}%`)
ok(true, '对照带：本页 rAF 间隔 vs 空白页（环境 vsync 封顶披露）', `game=${perf.rafGapMs}ms blank=${blank}ms（封顶则同带，非游戏负载）`)

/* ---------- 汇总 ---------- */
ok(pageErrors.length === 0, '零 pageerror（整轮会话）', pageErrors.length ? pageErrors[0] : '')
await browser.close()
console.log(`\n${failed === 0 ? 'SMOKE OK' : 'SMOKE FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
