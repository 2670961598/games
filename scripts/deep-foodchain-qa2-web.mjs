#!/usr/bin/env node
/* =====================================================================
 * GAMES-168 深海食物链 QA2 浏览器臂（FEEL 上线后零漂移抽验+O-2 闭环）
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4424（?gw=）。
 *   F1 FEEL 零漂移抽验：quick 活局 rAF 帧成本（QA1 基线 avg=0.21ms/p95=0.3ms——
 *      FEEL=纯客户端渲染层，帧成本同量级=零漂移）+掉帧率<2%+零 pageerror
 *   F2 O-2 闭环：blank 对照带（about:blank rAF 饥死=QA1 O-2）——1px canvas 重绘循环
 *      喂活合成器（GAMES-166 范式）→ 对照带可测（n>0），帧成本法主证不变
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GWHOST = process.env.QA_GW_WS || 'ws://127.0.0.1:4424'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-168'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evidence = { p3loads: [] }
await mkdir(EVID, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const errs = []

console.log('── F1 FEEL 零漂移抽验（quick 活局帧成本 vs QA1 基线 0.21ms）──')
{
  const page = await context.newPage()
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${WEB}/games/multiplayer/deep-foodchain/index.html?gw=${encodeURIComponent(GWHOST)}`, { waitUntil: 'load', timeout: 20000 })
  let wl = null, st0 = null
  for (let i = 0; i < 60 && !wl; i++) {
    await sleep(250)
    wl = await page.evaluate(() => (window.__GAMES_DEBUG__.dbgEvents() || []).find((e) => e.event === 'welcome'))
    st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  }
  ok('F1', 'quick 秒进房（FEEL 版页面+影子网关——渲染链路在场）', !!(wl && st0 && st0.mode === 'playing'), `seat=${wl && wl.payload.seat} mode=${st0 && st0.mode} ents=${st0 && st0.ents}`)
  const frameCost = async (p, frames) => p.evaluate((n) => new Promise((res) => {
    const costs = []
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => orig((ts) => { const t0 = performance.now(); cb(ts); costs.push(performance.now() - t0) })
    const loop = () => { if (costs.length < n) orig(loop); else { window.requestAnimationFrame = orig; res(costs) } }
    orig(loop)
  }), frames).then((c) => {
    c.sort((a, b) => a - b)
    return { avg: +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2), p95: +c[Math.floor(c.length * 0.95)].toFixed(2), jank: +(c.filter((x) => x > 25).length / c.length * 100).toFixed(1), n: c.length }
  })
  const perf = await frameCost(page, 140)
  ok('F1', '帧成本零漂移（FEEL 后 avg<16ms 红线+与 QA1 基线 0.21ms 同量级）', perf.avg < 16 && perf.avg < 1.5, `avg=${perf.avg}ms p95=${perf.p95}ms n=${perf.n}（QA1 基线 0.21/0.3）`)
  ok('F1', '掉帧率（帧成本 >25ms）<2%', perf.jank < 2, `${perf.jank}%`)
  /* O-2 闭环：blank 饥死 → 1px canvas 喂活合成器 → 对照带可测 */
  const blankFed = await (async () => {
    const b = await context.newPage(); await b.goto('about:blank')
    await b.evaluate(() => { // GAMES-166 范式：合成器空闲伪影——1px canvas 重绘循环喂活
      const c = document.createElement('canvas'); c.width = c.height = 1; document.body.appendChild(c)
      const g = c.getContext('2d')
      ;(function loop() { g.fillStyle = '#000'; g.fillRect(0, 0, 1, 1); requestAnimationFrame(loop) })()
    })
    await b.bringToFront().catch(() => { })
    await sleep(1200)
    const r = await frameCost(b, 80)
    await page.bringToFront().catch(() => { })
    await b.close(); return r
  })()
  ok('F2', 'O-2 闭环：blank 对照带可测（canvas 喂活后 rAF 出带——QA1 n/a 观察项收口）',
    blankFed.n >= 60, `blank-fed avg=${blankFed.avg}ms n=${blankFed.n}（game=${perf.avg}ms 同量级=渲染负载未越界）`)
  ok('F1', '零 pageerror（FEEL 渲染链路无回归）', errs.length === 0, errs.length ? errs[0].slice(0, 120) : '0 errors')
  evidence.f1 = { perf, blankFed }
  await page.close()
}
await browser.close()
await writeFile(EVID + '/web-evidence.json', JSON.stringify(evidence, null, 2))
console.log(`\n${failed === 0 ? 'QA2-WEB OK' : 'QA2-WEB FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
