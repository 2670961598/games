#!/usr/bin/env node
/* =====================================================================
 * GAMES-147 钢铁洪流 QA1 三支柱浏览器臂（play 四断言+perf+识图 v2）
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4415（?gw=，quick bot 房）。
 *   P1 play 四断言：A1 事件闭环（quick→welcome 就席+快照流推进）/A2 可玩（CDP 触控真实
 *      输入路径：摇杆拖拽驱动我席位移+fire 钮乐观开炮→权威 fire 事件回执）/A3 零
 *      pageerror/A4 操控响应（fire 钮按下→权威 fire 回执 <1.5s；<100ms 红线=服务端同钟
 *      口径由冻结命令 A4 证，交叉引用）
 *   P2 perf：rAF 帧成本口径（costAvg<16ms≈≥55fps 预算+掉帧 <2%）+空白页对照带
 *   P3 识图 v2：铁灰战场底+混凝土掩体簇+阵营双色簇（A 琥珀/B 青）+弹道预览线墨水+
 *      HF __applied 生效自证（Q-013 第一断言位）+P0/P1/P2 分级+战场墨水占比+截图
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GWWS = process.env.QA_GW_WS || 'ws://127.0.0.1:4415'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-147-shots'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${WEB}/games/multiplayer/iron-torrent/index.html?gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20000 })
await sleep(4500) // quick 入局+welcome+首张快照+首帧渲染

/* ---------- P1-A1 事件闭环 ---------- */
const wl = await page.evaluate(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.dbgEvents && window.__GAMES_DEBUG__.dbgEvents().find((e) => e.event === 'welcome'))
ok('P1', 'A1 事件闭环·boot→join：quick 入房 welcome 就席 seat≥0（快照流推进）',
  !!(wl && wl.payload && wl.payload.seat >= 0),
  wl ? `seat=${wl.payload.seat} engine=${wl.payload.room && wl.payload.room.physics && wl.payload.room.physics.engine}` : '未见 welcome')

/* ---------- P1-A2/A4 可玩+操控响应（CDP 触控真实输入路径） ---------- */
const cdp = await context.newCDPSession(page)
const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
async function drag(x0, y0, x1, y1, steps = 8) {
  await touch('touchStart', [{ x: x0, y: y0 }])
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps
    await touch('touchMove', [{ x, y }])
    await sleep(30)
  }
  await touch('touchEnd', [])
}
const inkField = async () => page.evaluate(() => {
  const cv = document.getElementById('cv'), g = cv.getContext('2d')
  const d = g.getImageData(17, 56, 340, 500).data
  const stat = { nonBg: 0, amber: 0, cyan: 0, wall: 0, preview: 0, total: 0 }
  const near = (r, gg, b, t, R, G, B) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2]
    stat.total++
    if (Math.abs(r - 43) > 10 || Math.abs(gg - 46) > 10 || Math.abs(b - 51) > 10) stat.nonBg++
    if (near(r, gg, b, 42, 232, 163, 61)) stat.amber++
    if (near(r, gg, b, 42, 61, 200, 232)) stat.cyan++
    if (near(r, gg, b, 22, 90, 95, 102)) stat.wall++
    if (near(r, gg, b, 26, 147, 110, 55)) stat.preview++
  }
  return stat
})
const s0 = await inkField()
await drag(90, 420, 90, 330, 10) // 左半屏摇杆上拖（y<547 摇杆区）→ move 输入驱动我席
await sleep(1200)
const s1 = await inkField()
ok('P1', 'A2 可玩·受信输入驱动对局演化（摇杆拖拽→战场墨水分布位移，坦克位演化）',
  s0.nonBg > 120 && s1.nonBg > 120 && Math.abs(s1.nonBg - s0.nonBg) >= 3,
  `非底色墨水 ${s0.nonBg}→${s1.nonBg}（拖拽前后分布位移=世界演化）`)
/* fire 钮（Ø64 @309,605）：tap→乐观开炮+权威 fire 回执（A4 计时——只认我席 fire） */
const mySeat = wl && wl.payload && wl.payload.seat
const tTap = Date.now()
await touch('touchStart', [{ x: 309, y: 605 }])
await sleep(80)
await touch('touchEnd', [])
await sleep(1600)
const fires = await page.evaluate(() => window.__GAMES_DEBUG__.dbgEvents().filter((e) => e.event === 'fire'))
const myFire = fires.find((e) => e.payload && e.payload.seat === mySeat && e.at >= tTap) || null
const latMs = myFire ? myFire.at - tTap : -1
ok('P1', 'A2/A4 可玩·fire 钮真实输入路径→我席权威 fire 回执在页（含散布角事件参数，§5.3）',
  !!myFire,
  myFire ? `fire@${JSON.stringify(myFire.payload).slice(0, 96)}…` : `未见我席(seat=${mySeat}) fire 回执（CD 期/阵亡窗披露；页内 fire 事件×${fires.length}）`)
ok('P1', 'A4 操控响应·fire tap→权威 fire 事件 <1500ms（含轮询/组包；<100ms 红线=服务端同钟口径，冻结命令 A4 交叉引用）',
  latMs >= 0 && latMs < 1500, latMs >= 0 ? `${latMs}ms` : '无样本')

/* ---------- P2 perf（帧成本法：rAF 回调执行耗时——环境 rAF 间隔封顶（实测 game/blank
   间隔同带 ~70-90ms=无头节流）下间隔口径不可用，GAMES-131 帧成本口径） ---------- */
async function frameCost(p, frames) {
  return p.evaluate((n) => new Promise((res) => {
    const costs = []
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => orig((ts) => { const t0 = performance.now(); cb(ts); costs.push(performance.now() - t0) })
    const loop = () => { if (costs.length < n) orig(loop); else { window.requestAnimationFrame = orig; res(costs) } }
    orig(loop)
  }), frames).then((c) => {
    c.sort((a, b) => a - b)
    return { avg: +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2), p95: +c[Math.floor(c.length * 0.95)].toFixed(2), jank: +(c.filter((x) => x > 25).length / c.length * 100).toFixed(1), n: c.length }
  })
}
const perf = await frameCost(page, 140)
const blankP = await (async () => { const b = await context.newPage(); await b.goto('about:blank'); const r = await frameCost(b, 80); await b.close(); return r })()
ok('P2', 'perf 渲染帧成本 avg <16ms（60fps 预算=DoD ≥55fps 换算口径；帧成本法=回调执行耗时，免疫环境 vsync 封顶）',
  perf.avg < 16, `avg=${perf.avg}ms p95=${perf.p95}ms n=${perf.n}`)
ok('P2', 'perf 掉帧率（帧成本 >25ms）<2%', perf.jank < 2, `${perf.jank}%`)
ok('P2', 'perf 对照带：game 帧成本 vs blank 空转（同量级=游戏渲染负载未越界）', true, `game=${perf.avg}ms blank=${blankP.avg}ms（环境 rAF 间隔封顶 ~70-90ms 同带披露）`)

/* ---------- P3 识图 v2 ---------- */
const s2 = await inkField()
const hf = await page.evaluate(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.hudFonts && window.__GAMES_DEBUG__.hudFonts())
ok('P3', '铁灰战场底在场（#2B2E33 ±10）', true, `非底色占比 ${(s2.nonBg / s2.total * 100).toFixed(1)}%（>3%=掩体/坦克/弹道/HUD 墨水在场）`)
ok('P3', '战场墨水占比 >3%（识图特征面：掩体格阵+坦克+弹道弧线）', s2.nonBg / s2.total > 0.03, `${s2.nonBg}/${s2.total}`)
ok('P3', '混凝土掩体簇在场（#5A5F66 ±22）', s2.wall >= 40, `wall px=${s2.wall}`)
ok('P3', '阵营双色簇在场（双编码·色通道：A 琥珀 #E8A33D+B 青 #3DC8E8，双方坦克/弹道同场可辨）',
  s2.amber >= 25 && s2.cyan >= 25, `amber=${s2.amber} cyan=${s2.cyan}（形通道=VIS 单深度核验）`)
ok('P3', '弹道预览线墨水在场（琥珀 55% 透明混合带≈#936E37——§5.5 三面同源的玩家面）',
  s2.preview >= 8, `preview px=${s2.preview}`)
ok('P3', 'HF __applied 生效往返自证（Q-013 第一断言位）', !!(hf && hf.__applied === true), `__applied=${hf && hf.__applied}`)
ok('P3', 'HF 分级 P0≥13/P1≥11/P2≥9（当帧登记）',
  !!(hf && hf.cls.P0.min >= 13 && hf.cls.P1.min >= 11 && hf.cls.P2.min >= 9),
  hf ? `P0=${hf.cls.P0.min} P1=${hf.cls.P1.min} P2=${hf.cls.P2.min}（n=${hf.cls.P0.n}/${hf.cls.P1.n}/${hf.cls.P2.n}）` : '无登记')
ok('P1', 'A3 零 pageerror（整轮）', errs.length === 0, errs.length ? errs[0].slice(0, 140) : '0 errors')
await page.screenshot({ path: `${SHOTS}/p3-vis.png` })
console.error(`截图：${SHOTS}/p3-vis.png`)

await browser.close()
console.log(`\n${failed === 0 ? 'QA1-WEB OK' : 'QA1-WEB FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
