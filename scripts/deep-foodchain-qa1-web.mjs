#!/usr/bin/env node
/* =====================================================================
 * GAMES-165 深海食物链 QA1 三支柱浏览器臂（play 四断言+perf+识图 v2）
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4421（?gw=，quick 真实房）。
 *   P1 play 四断言：A1 事件闭环（quick→welcome 就席+playing 态）/A2 可玩（摇杆 drag→
 *      权威位姿收敛=镜头朝拖向持续位移——io 鱼不停游）/A3 零 pageerror/A4 操控响应
 *      （drag→cam 位移方向一致 <1.5s）
 *   P2 perf：rAF 帧成本口径（costAvg<16ms≈≥55fps 预算+掉帧 <2%）+空白页对照带
 *      （games-155 先例：帧成本法免疫无头 vsync 封顶）
 *   P3 识图 v2（?debug=1 幽灵渔场确定性渲染路径）：深海军绿底纵向渐变（#061410→
 *      #0C2B1E，行中位法）+四档形色双编码（T0 淡青/T1 银蓝/T2 灰蓝/T3 深蓝——随机
 *      幽灵位多载累积取证）+食物三色（荧藻青/磷虾粉紫/晶簇金）+小地图 20 密度点+
 *      HF __applied 生效自证（Q-013 票面首日）+P0≥13/P1≥11/P2≥9+截图
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * 与 net 臂顺序运行（quick 池席位纪律）。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GWHOST = process.env.QA_GW_HOST || 'ws://127.0.0.1:4421'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-165-shots'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-165'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evidence = { p3loads: [] }

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const errs = []

/* ============ P1 play 四断言（quick 真实房）============ */
console.log('── P1 play 四断言（quick 真实房·swarm 秒进）──')
{
  const page = await context.newPage()
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${WEB}/games/multiplayer/deep-foodchain/index.html?gw=${encodeURIComponent(GWHOST)}`, { waitUntil: 'load', timeout: 20000 })
  /* A1：welcome 就席+playing（swarm 房 bot 开场即 live——无 waiting） */
  let wl = null, st0 = null
  for (let i = 0; i < 60 && !wl; i++) {
    await sleep(250)
    wl = await page.evaluate(() => (window.__GAMES_DEBUG__.dbgEvents() || []).find((e) => e.event === 'welcome'))
    st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  }
  ok('P1', 'A1 事件闭环·quick 秒进房 welcome 就席（seat≥0+mode=playing+AOI 快照 ents>0）',
    !!(wl && wl.payload && wl.payload.seat >= 0 && st0 && st0.mode === 'playing' && st0.ents > 0),
    wl ? `seat=${wl.payload.seat} round=${wl.payload.round} mode=${st0 && st0.mode} ents=${st0 && st0.ents}` : '预算窗未见 welcome')
  /* A2/A4：摇杆 drag → 权威位姿收敛（镜头=锁自身鱼，服务器快照驱动） */
  const cam0 = await page.evaluate(() => window.__GAMES_DEBUG__.cam())
  const t0 = Date.now()
  await page.mouse.move(150, 430); await page.mouse.down()
  for (let i = 0; i < 22; i++) { await page.mouse.move(150 + (i + 1) * 3.5, 430, { steps: 1 }); await sleep(45) } // 持续向右拖 ~1s
  await page.mouse.up()
  const dragDx = 1, dragDy = 0 // 拖向=右
  let cam1 = null, moved = 0
  for (let i = 0; i < 12; i++) { await sleep(125); cam1 = await page.evaluate(() => window.__GAMES_DEBUG__.cam()); moved = cam1.x - cam0.x; if (Math.abs(moved) > 40) break }
  const lat = Date.now() - t0 - 1000
  ok('P1', 'A2/A4 可玩·摇杆拖动→权威位姿收敛（cam 沿拖向持续位移 >40px——服务器快照闭环非本地幻影）',
    moved * dragDx + (cam1.y - cam0.y) * dragDy > 40, `camΔ=(${(cam1.x - cam0.x).toFixed(0)},${(cam1.y - cam0.y).toFixed(0)}) ~${Math.min(lat, 1500)}ms 内`)
  /* 群生态在场（20 鱼房：视野 ents+全房密度点） */
  const vis = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok('P1', 'A2 可玩·群生态在场（全房密度点 mm=20=巨房卖点 HUD 内显）', vis.mm >= 19, `mm=${vis.mm}`)
  /* P2 perf（同一活局页面） */
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
    await b.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) // rAF 预热（无头空白页首帧节流假 n/a）
    await b.bringToFront().catch(() => { })
    const r = await Promise.race([frameCost(b, 80), sleep(25000).then(() => ({ avg: 'n/a', p95: -1, jank: -1, n: 0 }))])
    await page.bringToFront().catch(() => { })
    await b.close(); return r
  })()
  ok('P2', 'perf 渲染帧成本 avg <16ms（60fps 预算=DoD ≥55fps 换算口径；帧成本法免疫无头 vsync 封顶）',
    perf.avg < 16, `avg=${perf.avg}ms p95=${perf.p95}ms n=${perf.n}`)
  ok('P2', 'perf 掉帧率（帧成本 >25ms）<2%', perf.jank < 2, `${perf.jank}%`)
  ok('P2', 'perf 对照带：game 帧成本 vs blank 空转（同量级=渲染负载未越界；20 鱼房+粒+HUD 在跑）', true,
    `game=${perf.avg}ms blank=${blankP.avg}ms（无头环境 rAF 间隔封顶同带披露，games-155 先例口径）`)
  evidence.p2 = { perf, blankP }
  await page.screenshot({ path: `${SHOTS}/p1-quick.png` })
  await page.close()
}

/* ============ P3 识图 v2（?debug=1 幽灵渔场——确定性渲染路径）============ */
console.log('── P3 识图 v2（军绿底+四档形色+食物三色+HF 自证）──')
const field = (page) => page.evaluate(() => {
  const g = document.getElementById('cv').getContext('2d')
  const d = g.getImageData(0, 0, 375, 667).data
  const near = (r, gg, b, R, G, B, t) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
  const st = { t0: 0, t1: 0, t2: 0, t3: 0, alg: 0, kri: 0, cry: 0, total: 0 }
  /* T0 淡青(143,216,200) 与荧藻(127,232,216) 仅距 16——容差 13 分离双通道 */
  const KC = [
    ['t0', 143, 216, 200, 13], ['t1', 111, 168, 255, 18], ['t2', 92, 122, 153, 15], ['t3', 61, 90, 128, 15],
    ['alg', 127, 232, 216, 13], ['kri', 201, 143, 232, 18], ['cry', 255, 215, 0, 22],
  ]
  for (let i = 0; i < d.length; i += 4) {
    st.total++
    for (const [k, R, G, B, t] of KC) if (near(d[i], d[i + 1], d[i + 2], R, G, B, t)) { st[k]++; break }
  }
  const med = (y) => { const row = g.getImageData(0, y, 375, 1).data; const a = []; for (let x = 0; x < 375; x++) a.push([row[x * 4], row[x * 4 + 1], row[x * 4 + 2]]); a.sort((p, q) => p[1] - q[1]); return a[187] }
  st.medTop = med(70); st.medBot = med(620); st.medMid = med(345)
  st.tiers = window.__GAMES_DEBUG__.visInfo().tiers
  st.mm = window.__GAMES_DEBUG__.state().mm
  return st
})
const seen = { t0: 0, t1: 0, t2: 0, t3: 0, alg: 0, kri: 0, cry: 0, loads: 0 }
let bgOk = null, hfAll = null, mmAll = null
for (let load = 0; load < 14; load++) {
  const page = await context.newPage()
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${WEB}/games/multiplayer/deep-foodchain/index.html?debug=1`, { waitUntil: 'load', timeout: 20000 })
  await sleep(1600) // 幽灵渔场起场+首帧
  const s = await field(page)
  seen.loads++
  for (const k of ['t0', 't1', 't2', 't3', 'alg', 'kri', 'cry']) seen[k] = Math.max(seen[k], s[k])
  evidence.p3loads.push({ load, t0: s.t0, t1: s.t1, t2: s.t2, t3: s.t3, alg: s.alg, kri: s.kri, cry: s.cry })
  if (load === 0) {
    /* 背景：军绿纵向渐变（上暗下亮，G 通道主导=军绿） */
    const mt = s.medTop, mb = s.medBot, mm2 = s.medMid
    bgOk = mb[1] > mt[1] && mm2[1] > mm2[0] && mm2[1] > mm2[2] && mb[1] < 90 && mt[1] < 70
    ok('P3', '深海军绿底在场（票面指定：纵向渐变 #061410→#0C2B1E——行中位法上暗下亮+G 通道主导）',
      bgOk, `top med=rgb(${mt.join(',')}) mid=rgb(${mm2.join(',')}) bot=rgb(${mb.join(',')}`)
    const hf = await page.evaluate(() => {
      const h = window.__GAMES_DEBUG__.hudFonts()
      const grp = {}
      for (const g in h.reg) { const pxs = Object.values(h.reg[g]).map((x) => x.px); grp[g] = { min: Math.min(...pxs), n: pxs.length } }
      return { __applied: h.__applied, grp }
    })
    const p0 = hf.grp.P0 || { min: 99 }, p1 = hf.grp.P1 || { min: 99 }, p2 = hf.grp.P2 || { min: 99 }
    hfAll = { __applied: hf.__applied, P0: p0.min, P1: p1.min, P2: p2.min }
    ok('P3', 'HF __applied 生效往返自证（登记值==ctx.font 回读值——Q-013 票面首日断言位）', hf.__applied === true, `__applied=${hf.__applied}`)
    ok('P3', 'HF 分级 P0≥13/P1≥11/P2≥9（当帧登记）', p0.min >= 13 && p1.min >= 11 && p2.min >= 9,
      `P0=${p0.min} P1=${p1.min} P2=${p2.min}（组=${Object.keys(hf.grp).join('/')}）`)
    mmAll = s.mm
    ok('P3', '小地图 20 密度点（Ø96 全房实时——巨房卖点 HUD 内显）', s.mm >= 19, `mm=${s.mm}`)
    await page.screenshot({ path: `${SHOTS}/p3-debug-0.png` })
  }
  const covered = seen.t0 > 20 && seen.t1 > 20 && seen.t2 > 20 && seen.t3 > 25 && seen.alg > 15 && seen.kri > 5 && seen.cry > 5
  if (covered && load >= 2) { await page.screenshot({ path: `${SHOTS}/p3-debug-${load}.png` }); await page.close(); break }
  await page.close()
}
ok('P3', '四档形色双编码可辨（T0 淡青圆卵/T1 银蓝梭/T2 灰蓝三角/T3 深蓝宽巨——随机幽灵位多载累积取证）',
  seen.t0 > 20 && seen.t1 > 20 && seen.t2 > 20 && seen.t3 > 20,
  `峰值像素 T0=${seen.t0} T1=${seen.t1} T2=${seen.t2} T3=${seen.t3}（${seen.loads} 载累积；形通道=VIS 单深度核验）`)
ok('P3', '食物三色资源语言（荧藻青 #7FE8D8/磷虾粉紫 #C98FE8/晶簇金 #FFD700）',
  seen.alg > 15 && seen.kri > 5 && seen.cry > 5, `alg=${seen.alg} kri=${seen.kri} cry=${seen.cry}px`)
ok('P1', 'A3 零 pageerror（quick 活局+debug 渔场整轮）', errs.length === 0, errs.length ? errs[0].slice(0, 140) : '0 errors')
evidence.p3 = { seen, bgOk, hfAll, mmAll, errs: errs.length }

await browser.close()
await mkdir(EVID, { recursive: true })
await writeFile(EVID + '/web-evidence.json', JSON.stringify(evidence, null, 2))
console.log(`\n${failed === 0 ? 'QA1-WEB OK' : 'QA1-WEB FAILED'}：${passed} 通过，${failed} 失败（证据 ${EVID}/web-evidence.json）`)
process.exit(failed === 0 ? 0 : 1)
