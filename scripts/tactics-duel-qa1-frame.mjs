/* GAMES-119 QA1 帧成本直证：rAF 回调包裹计时（对冲环境 rAF 封顶——成本面证据） */
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 375, height: 667 } })).newPage()
await page.goto('http://127.0.0.1:4399/games/multiplayer/tactics-duel/index.html?debug=1', { waitUntil: 'load', timeout: 20000 })
await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'start'), null, { timeout: 15000 })
await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'act' && v.units && v.units.length === 12 }, null, { timeout: 20000 })
const r = await page.evaluate(() => new Promise((resolve) => {
  const t = window.TDuelSim
  const costs = []
  let n = 0
  const loop = () => {
    const t0 = performance.now()
    // 每帧渲染工作近似：完整重绘由 rAF 主循环执行，这里测同源引擎 BFS 预演+主循环一帧的成本面
    const v = window.__GAMES_DEBUG__.state().view
    const u = v.units && v.units.find((x) => x.seat === 0)
    if (u) { t.reach(v, u.id); t.atkTargets(v, u.id) }
    costs.push(performance.now() - t0)
    if (++n >= 240) {
      costs.sort((a, b) => a - b)
      const over = costs.filter((c) => c > 16.7).length
      resolve({ n, p50: costs[(costs.length * 0.5) | 0].toFixed(2), p95: costs[(costs.length * 0.95) | 0].toFixed(2), max: costs[costs.length - 1].toFixed(2), over167: (100 * over / n).toFixed(1) + '%' })
    } else requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}))
console.log('每帧成本（BFS 移动域+目标域复算，n=240 帧采样）：', JSON.stringify(r))
await browser.close()
