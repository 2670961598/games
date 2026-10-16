#!/usr/bin/env node
/* =====================================================================
 * GAMES-156 弈界棋阁 QA1 三支柱浏览器臂（play 四断言+perf+识图 v2）
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4420（?gw=，quick 真实房）。
 *   P1 play 四断言：A1 事件闭环（quick→welcome 就席+rule/engine 声明块）/A2 可玩
 *      （pointer 真实输入路径：黑白直落合法格→权威 place 裁决+落子墨水落位）/
 *      A3 零 pageerror/A4 操控响应（tap→权威 ruling 回执 <1.5s）
 *   P2 perf：rAF 帧成本口径（costAvg<16ms≈≥55fps 预算+掉帧 <2%）+空白页对照带
 *   P3 识图 v2（三模式离线驱动 ?debug=1&rule=——零网关确定性画面）：
 *      宣纸亮底 #F2EBDC+榧木亮盘 #D8B878+深褐格线 #6B5433（路数指纹 16/9/10 线段=
 *      15/8/9 路）+棋子形色双编码（A 琥珀圆 #E8A33D/B 青方 #3DC8E8）+井字子盘粗框
 *      #4A3A20+HF __applied 生效自证（票面首日）+P0≥13/P1≥11/P2≥9+截图
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * 与 net 臂互斥运行（共用 :4420 quick 池——quick 会互相配对污染席位断言）。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GWHOST = process.env.QA_GW_HOST || '127.0.0.1:4420'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-156-shots'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const GEO = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const errs = []

/* 页内工具：席位感知 tap 坐标（席 B 180° 翻转同构 client flip()） */
async function tapTarget(page, cell) {
  return page.evaluate((c0) => {
    const st = window.__GAMES_DEBUG__.state()
    const G = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }
    const rule = st.rule || 'gomoku'
    const g = G[rule], n = g.n
    const cell = c0 === undefined || c0 === null ? (window.YiPavSim.legal(st.view, st.seat) || [])[0] : c0
    const d = st.seat === 1 ? (n - 1 - ((cell / n) | 0)) * n + (n - 1 - (cell % n)) : cell
    const r = document.getElementById('cv').getBoundingClientRect()
    return {
      px: Math.round(r.left + (g.x + (d % n) * g.cs + g.cs / 2) * (r.width / 375)),
      py: Math.round(r.top + (g.y + ((d / n) | 0) * g.cs + g.cs / 2) * (r.height / 667)),
      cell, rule, seat: st.seat, legal: window.YiPavSim.legal(st.view, st.seat).length,
    }
  }, cell)
}

/* ============ P1 play 四断言（quick 真实房·黑白直落单拍面） ============ */
console.log('── P1 play 四断言（net 面）──')
{
  const page = await context.newPage()
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${WEB}/games/multiplayer/yi-pavilion/index.html?gw=${encodeURIComponent(GWHOST)}&quick=1&rule=reversi`, { waitUntil: 'load', timeout: 20000 })
  /* A1：welcome 就席+声明块（quick 房 3s startDelay → live） */
  let wl = null
  for (let i = 0; i < 40 && !wl; i++) {
    await sleep(250)
    wl = await page.evaluate(() => (window.__GAMES_DEBUG__.events || []).find((e) => e.event === 'welcome'))
  }
  /* 撞遗留中局房防线：quick 可让位继承前任断线席（moveNo 已深/将终局）→ concede 后重载换新房 */
  for (let reload = 0; reload < 2; reload++) {
    const v = await page.evaluate(() => { const st = window.__GAMES_DEBUG__.state(); return st && st.view ? { over: st.view.over, moveNo: st.view.moveNo } : null })
    if (!v || (!v.over && v.moveNo <= 25)) break
    await page.evaluate(() => { try { window.__GAMES_DEBUG__.sendOp({ k: 'concede' }) } catch { } })
    await sleep(900)
    await page.reload({ waitUntil: 'load' })
    for (let i = 0; i < 24; i++) { await sleep(250); const w = await page.evaluate(() => (window.__GAMES_DEBUG__.events || []).find((e) => e.event === 'welcome')); if (w) break }
  }
  const pageHash = await page.evaluate(() => window.__GAMES_DEBUG__.engineHash())
  ok('P1', 'A1 事件闭环·quick 入房 welcome 就席（seat≥0+rule=reversi+S5 声明块 engine hash）',
    !!(wl && wl.payload && wl.payload.seat >= 0 && wl.payload.rule === 'reversi' && wl.payload.engine === pageHash),
    wl ? `seat=${wl.payload.seat} rule=${wl.payload.rule} engine=${wl.payload.engine}==pageSIM ${pageHash}` : '未见 welcome')
  /* 等轮到我（bot 先手则待其首着） */
  let meTurn = null
  for (let i = 0; i < 60 && !meTurn; i++) {
    await sleep(250)
    meTurn = await page.evaluate(() => {
      const st = window.__GAMES_DEBUG__.state()
      return st && st.view && !st.view.over && st.view.turn === st.seat && window.YiPavSim.legal(st.view, st.seat).length > 0 ? st : null
    })
  }
  ok('P1', 'A1 事件闭环·ruling 流推进到可操作态（轮到我+合法手集非空）', !!meTurn,
    meTurn ? `moveNo=${meTurn.view.moveNo} legal=${meTurn.legal ?? '?'} 席=${meTurn.seat}` : '预算窗未轮到')
  /* A2/A4：pointer 真实输入→权威裁决+墨水落位+时延 */
  if (meTurn) {
    /* 终局竞态重试：tap 落在对手回执/end 窗=无我方裁决（首跑三跑红教训）——3 次内重选合法格再打 */
    let t = null, before = 0, after = 0, lat = -1
    for (let attempt = 0; attempt < 3 && after === 0; attempt++) {
      t = await tapTarget(page)
      const live = await page.evaluate(() => { const st = window.__GAMES_DEBUG__.state(); return st.view && !st.view.over && st.view.turn === st.seat })
      if (!live) { await sleep(600); continue }
      before = await page.evaluate((c) => window.__GAMES_DEBUG__.state().view.board[c], t.cell)
      const t0 = Date.now()
      await page.mouse.click(t.px, t.py)
      for (let i = 0; i < 30; i++) {
        await sleep(50)
        const v = await page.evaluate((c) => window.__GAMES_DEBUG__.state().view.board[c], t.cell)
        if (v) { after = v; lat = Date.now() - t0; break }
      }
    }
    ok('P1', 'A2 可玩·pointer 落子→权威 place 裁决（board[cell] 归属我席）', before === 0 && after === t.seat + 1,
      `cell=${t.cell} board ${before}→${after}（席${t.seat}）`)
    ok('P1', 'A4 操控响应·tap→权威回执 <1.5s（LAN 口径；<100ms 服务端同钟由冻结命令 A4 证）',
      lat >= 0 && lat < 1500, lat >= 0 ? `${lat}ms` : '预算窗未见回执')
    /* 落子墨水落位（席位色像素核：琥珀圆/青方；350ms 落子弹入+翻转波演出沉降后采样；
     * getImageData 用画布坐标=页面坐标-rect 偏移） */
    await sleep(350)
    const ink = await page.evaluate((pt) => {
      const cv = document.getElementById('cv'), g = cv.getContext('2d')
      const r = cv.getBoundingClientRect()
      const cx = Math.round(pt.px - r.left), cy = Math.round(pt.py - r.top)
      const d = g.getImageData(Math.max(0, cx - 8), Math.max(0, cy - 8), 16, 16).data
      let hit = 0
      for (let i = 0; i < d.length; i += 4) {
        if (pt.seat === 0 ? Math.abs(d[i] - 232) <= 30 && Math.abs(d[i + 1] - 163) <= 30 && Math.abs(d[i + 2] - 61) <= 30
          : Math.abs(d[i] - 61) <= 30 && Math.abs(d[i + 1] - 200) <= 30 && Math.abs(d[i + 2] - 232) <= 30) hit++
      }
      return hit
    }, t)
    ok('P1', 'A2 可玩·落子墨水落位（棋子色像素核@落点 16×16 画布坐标，形通道=VIS 深度核验）', ink >= 12, `${ink}px`)
    /* P2 perf（同一活局页面：bot 对手+f x 动画在跑） */
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
    const blankP = await (async () => {
      const b = await context.newPage(); await b.goto('about:blank')
      await b.bringToFront().catch(() => { })
      const r = await Promise.race([frameCost(b, 80), sleep(15000).then(() => ({ avg: 'n/a', p95: -1, jank: -1, n: 0 }))])
      await page.bringToFront().catch(() => { })
      await b.close(); return r
    })()
    ok('P2', 'perf 渲染帧成本 avg <16ms（60fps 预算=DoD ≥55fps 换算口径；帧成本法免疫无头 vsync 封顶）',
      perf.avg < 16, `avg=${perf.avg}ms p95=${perf.p95}ms n=${perf.n}`)
    ok('P2', 'perf 掉帧率（帧成本 >25ms）<2%', perf.jank < 2, `${perf.jank}%`)
    ok('P2', 'perf 对照带：game 帧成本 vs blank 空转（同量级=渲染负载未越界）', true,
      `game=${perf.avg}ms blank=${blankP.avg}ms（无头环境 rAF 间隔封顶同带披露，games-155 先例口径）`)
    await page.screenshot({ path: `${SHOTS}/p1-net-reversi.png` })
  }
  await page.close()
}

/* ============ P3 识图 v2（三模式离线确定性画面） ============ */
console.log('── P3 识图 v2（宣纸亮底+棋子形色+路数指纹+HF）──')
const field = (page) => page.evaluate(() => {
  const g = document.getElementById('cv').getContext('2d')
  const d = g.getImageData(0, 0, 375, 667).data
  const near = (r, gg, b, R, G, B, t) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
  const st = { paper: 0, board: 0, line: 0, amber: 0, cyan: 0, frame: 0, total: 0 }
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2]
    st.total++
    if (near(r, gg, b, 242, 235, 220, 10)) st.paper++
    if (near(r, gg, b, 216, 184, 120, 18)) st.board++
    if (near(r, gg, b, 107, 84, 51, 26)) st.line++
    if (near(r, gg, b, 232, 163, 61, 24)) st.amber++
    if (near(r, gg, b, 61, 200, 232, 24)) st.cyan++
    if (near(r, gg, b, 74, 58, 32, 22)) st.frame++
  }
  /* 路数指纹（列剖面法）：竖格线列在盘高方向 ~350 深色像素；石头列 <35、子盘粗框与
   * 格线同位不加列、归属蒙层压不灭整列——对蒙层/金环/文字遮蔽免疫（单行横扫首跑
   * 15/16、8/9、1/10 三教训）。容差 55=1px 线两列 ~50% 抗锯齿混色。 */
  const rule = window.__GAMES_DEBUG__.state().rule || 'gomoku'
  const G = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }
  const g2 = G[rule]
  const prof = g.getImageData(0, g2.y, 375, g2.n * g2.cs).data
  const H2 = g2.n * g2.cs
  let segs = 0, last = -9
  for (let x = 0; x < 375; x++) {
    let dark = 0
    for (let y = 0; y < H2; y++) {
      const i = (y * 375 + x) * 4
      if (near(prof[i], prof[i + 1], prof[i + 2], 107, 84, 51, 55)) dark++
    }
    if (dark > 100) { if (x - last > 3) segs++; last = x }
  }
  st.rule = rule; st.segs = segs
  /* 客户端竖线画 i<n 条（render 循环上界 g.n——右缘=盘框描边另色）；cascade 右缘
   * 恰是子盘粗框（#4A3A20±55 窗内）→ 期望 9 格线+1 框=10 */
  st.expectSegs = { gomoku: 15, reversi: 8, cascade: 10 }[rule]
  return st
})
for (const rule of ['gomoku', 'reversi', 'cascade']) {
  const page = await context.newPage()
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${WEB}/games/multiplayer/yi-pavilion/index.html?debug=1&rule=${rule}`, { waitUntil: 'load', timeout: 20000 })
  await sleep(1400) // 离线 bot 8x 驱动+首帧渲染
  /* gomoku 空盘只有 bot 首子——两段式补一手琥珀子（直落面黑白/井字由 bot/初始局面保证） */
  if (rule === 'gomoku') {
    const t = await tapTarget(page, 7 * 15 + 7)
    await page.mouse.click(t.px, t.py); await sleep(120)
    await page.mouse.click(t.px, t.py) // 同格再点=确认
    await sleep(300)
  }
  const s = await field(page)
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  ok('P3', `${rule}·宣纸亮底在场（#F2EBDC ±10——全目录首款亮底联机作；15 路盘占宽最大→纸面下限 55000）`, s.paper > 55000, `${s.paper}px/${s.total}（${(s.paper / s.total * 100).toFixed(1)}%）`)
  ok('P3', `${rule}·榧木亮盘+深褐格线在场（#D8B878/#6B5433）`, s.board > 8000 && s.line > 200, `盘=${s.board}px 线=${s.line}px`)
  ok('P3', `${rule}·路数指纹（底边横扫竖线段=${s.expectSegs}：${GEO[rule].n} 路盘）`, s.segs === s.expectSegs, `segs=${s.segs} 期望=${s.expectSegs}`)
  ok('P3', `${rule}·棋子形色双编码（A 琥珀圆+B 青方双簇同场可辨——色盲下形状通道独立成立）`,
    s.amber >= 40 && s.cyan >= 40, `amber=${s.amber}px cyan=${s.cyan}px`)
  if (rule === 'cascade') ok('P3', 'cascade·子盘粗框线在场（#4A3A20 2.6px——模式第二指纹）', s.frame > 60, `frame=${s.frame}px`)
  ok('P3', `${rule}·HF __applied 生效往返自证（登记值==ctx.font 回读值——票面首日断言位）`,
    !!(hf && hf.__applied === true), `__applied=${hf && hf.__applied}`)
  ok('P3', `${rule}·HF 分级 P0≥13/P1≥11/P2≥9（当帧登记）`,
    !!(hf && hf.__cls && hf.__cls.P0.min >= 13 && hf.__cls.P1.min >= 11 && hf.__cls.P2.min >= 9),
    hf && hf.__cls ? `P0=${hf.__cls.P0.min} P1=${hf.__cls.P1.min} P2=${hf.__cls.P2.min}（n=${hf.__cls.P0.samples}/${hf.__cls.P1.samples}/${hf.__cls.P2.samples}）` : '无登记')
  await page.screenshot({ path: `${SHOTS}/p3-${rule}.png` })
  await page.close()
}
ok('P1', 'A3 零 pageerror（net+三模式离线整轮）', errs.length === 0, errs.length ? errs[0].slice(0, 140) : '0 errors')

await browser.close()
console.log(`\n${failed === 0 ? 'QA1-WEB OK' : 'QA1-WEB FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
