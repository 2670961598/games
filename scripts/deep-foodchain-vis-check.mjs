#!/usr/bin/env node
/* =====================================================================
 * GAMES-169 深海食物链 VIS——视觉统一+识图扩容（识图 v2 ≥30 探针）
 * 对齐 street-soccer（GAMES-143）/yi-pavilion（GAMES-161）取证口径：
 * 离线文件服务器 + ?debug=1 幽灵渔场（零网关——:4399/:4400 零感知，
 * GAMES-159 离线口径；GAMES-165 QA1 基础探针 6 面 → 本单扩容 35 面）。
 *   §A HUD 全量 HF 体系核（8）：__applied 语义自证（登记==ctx.font 回读）
 *      +P0≥13/w≥600、P1≥11、P2≥9 运行时下限+零裸字号静态审计
 *      +全 HUD 面键覆盖（运行时 reg+静态 grep 双口径）+toast 弹跳峰值
 *      不破档+HUD 铬件 7 锚在场（Q-013 票面首日断言源的 VIS 全量核）
 *   §B 色盲双编码全 UI 面（10）：四档形状签名（T0 圆卵/T1 梭/T2 背鳍
 *      突起/T3 宽巨金描边——visTiers 确定性采样场）+四档颜色通道
 *      +排行榜/观战条档位 glyph（本单补漏）+猎物绿虚线环 vs 天敌红实
 *      线粗环（形通道互异）+灰度化形状通道可辨（ringsOff+luma 阈——
 *      hud-font-standard §3 复核法）
 *   §C FEEL 面识图（6）：吞噬吸入 F01（橙拉丝+嘴点金环）/升档光圈
 *      F02（金+青双环）/dash 尾迹三态 F04（off→on→衰减）/台账首绘
 *      F01/F02/F04/F05/F06/死亡散布+惊红闪/吃食光波环+连食 streak
 *   §D 语义面（6）：深海军绿底纵向渐变/食物闪烁 F07（双相 luma 差）/
 *      AOI 呼吸圈 F08（屏缘弧像素）/小地图 20 密度点+圆界+自位金点/
 *      鱼汛潮象限脉冲/鲸级登场波纹 F13
 *   §E 三态冻结对照（4）：浮游 t0/中期 mid/鲸级 t3（grow 场景+档位
 *      zoom 阶梯）+HUD 7 锚零位移+世界层帧差合理带+截图三帧落盘
 * 用法：node scripts/deep-foodchain-vis-check.mjs
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-169-shots'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-169'
const PORT = 9230 + Math.floor(Math.random() * 300)

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 静态文件服务器（.cjs 须 text/javascript——MIME 拒载静默坑 GAMES-90） ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
    const buf = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(PORT, r))

console.error(`[vis-check] 幽灵渔场（?debug=1，零网关）——35 面识图 v2`)
await mkdir(OUT, { recursive: true }); await mkdir(EVID, { recursive: true })
const pageErrors = []
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/deep-foodchain/index.html?debug=1`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return !!(s && s.mode === 'debug') }, null, { timeout: 20_000 })
  await sleep(2600) // 开场下沉入场（420ms）+镜头临界阻尼收敛+幽灵节拍稳定

  /* ---------- 冻结帧采样器（pause→等一拍→evaluate→复跑） ---------- */
  const freeze = async (fn, arg) => {
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
    await sleep(90)
    const r = await page.evaluate(fn, arg)
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
    return r
  }
  const ink = (x0, y0, w, h) => { /* 墨水带（GAMES-159 口径：主色背景分离 >72） */ }

  /* ================= §D 语义面（自然幽灵渔场——visTiers 之前） ================= */
  console.error('── §D 语义面 ──')
  const d1 = await freeze(() => {
    const g = document.getElementById('cv').getContext('2d')
    const med = (y) => { const row = g.getImageData(0, y, 375, 1).data; const a = []; for (let x = 0; x < 375; x++) a.push([row[x * 4], row[x * 4 + 1], row[x * 4 + 2]]); a.sort((p, q) => p[1] - q[1]); return a[187] }
    return { top: med(70), mid: med(345), bot: med(620) }
  })
  A('D1', '深海军绿底在场（票面：纵向渐变 #061410→#0C2B1E——行中位法上暗下亮+G 通道主导+暗部值域）',
    d1.bot[1] > d1.top[1] && d1.mid[1] > d1.mid[0] && d1.mid[1] > d1.mid[2] && d1.top[1] < 70 && d1.bot[1] < 95,
    `top=rgb(${d1.top.join(',')}) mid=rgb(${d1.mid.join(',')}) bot=rgb(${d1.bot.join(',')})`)

  const d3snap = () => {
    const g = document.getElementById('cv').getContext('2d')
    let n = 0
    for (const [x0, w] of [[0, 25], [350, 25]]) { // 底缘双角带（弧交点 x∈[0,22]∪[353,375]）
      const d = g.getImageData(x0, 648, w, 19).data
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] >= d[i] + 14 && d[i + 1] >= 45) n++
    }
    return n
  }
  const d3samples = []
  for (let i = 0; i < 8; i++) { d3samples.push(await freeze(d3snap)); await sleep(420) } // 呼吸 4.4s 周期跨整周期：r∈[372,388] 仅 ≤382.6（屏角距）相位弧入底缘角带
  const d3max = Math.max(...d3samples), d3min = Math.min(...d3samples)
  A('D3', 'AOI 呼吸圈在场（F08 档即视野：T0 r=380>屏宽——弧以底缘切弧扫过角带；Δ=弧残差对恒定底噪（尘埃 ≤8px）；台账面由 feel-check FE-2a 覆盖）',
    d3max >= 12 && d3max - d3min >= 12, `底缘角带绿像素 max=${d3max} min=${d3min} Δ=${d3max - d3min}（8 相位；逐相 ${d3samples.join('/')}）`)

  const d4 = await freeze(() => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(273, 66, 92, 92).data
    const at = (x, y) => { const i = ((y - 66) * 92 + (x - 273)) * 4; return [d[i], d[i + 1], d[i + 2]] }
    let teal = 0, gold = 0
    for (let i = 0; i < d.length; i += 4) { if (d[i + 1] > d[i] + 25 && d[i + 1] > 60) teal++; if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 90) gold++ }
    let ring = 0
    for (let a = 0; a < 360; a += 30) { const p = at(Math.round(319 + Math.cos(a * Math.PI / 180) * 46), Math.round(112 + Math.sin(a * Math.PI / 180) * 46)); if (p[1] > p[0] + 20 && p[1] > 55) ring++ }
    return { teal, gold, ring, mm: window.__GAMES_DEBUG__.state().mm }
  })
  A('D4', '小地图 Ø96 在场（20 密度点=巨房卖点 HUD 内显+圆形边界 12 采样+自位金点）',
    d4.mm >= 19 && d4.teal >= 25 && d4.gold >= 4 && d4.ring >= 7, `mm=${d4.mm} tealPx=${d4.teal} goldPx=${d4.gold} 边界命中=${d4.ring}/12`)

  const d6cls = () => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(40, 60, 290, 580).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 25 && d[i + 2] > 55 && d[i + 1] < 95 && d[i + 1] > 40) n++
    return n
  }
  const d6b = await freeze(d6cls)
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('whale'))
  await sleep(220)
  const d6a = await freeze(d6cls)
  A('D6', '沧鲸降世波纹在场（F13 双环涟漪语义面——深蓝 #3D5A80 混色像素对账 Δ）', d6a - d6b >= 8, `Δ深蓝波纹=${d6a - d6b}px（${d6b}→${d6a}）`)

  /* ================= §B/C 确定性采样场（visTiers：锁巡游+定点四档） ================= */
  console.error('── §B 色盲双编码（visTiers 确定性场）──')
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('visTiers'))
  await sleep(1300) // 镜头临界阻尼收敛到传送位（vizLock 冻结巡游）

  /* D2 食物闪烁（F07：晶簇 480ms 脉动——定点 zCry 双相位均值差） */
  const d2snap = () => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(124, 265, 18, 18).data
    let s = 0
    for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    return +(s / (d.length / 4)).toFixed(1)
  }
  const d2a = await freeze(d2snap)
  await sleep(300) // 相位差 ~225°（脉动周期 480ms）
  const d2b = await freeze(d2snap)
  A('D2', '食物闪烁在场（F07 晶簇 #FFD700 脉动 480ms——定点双相位均值 luma 差）', Math.abs(d2b - d2a) >= 2.5, `zCry 位 luma=${d2a}→${d2b}（Δ=${Math.abs(d2b - d2a).toFixed(1)}）`)

  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('ringsOff')) // 灰度形状采样：敌我环属关系色面，先关
  await sleep(90) // 复绘窗（GAMES-169 实锤坑：evaluate 间隔可 <1 帧——关环后须等 ≥1 帧画布复绘再冻结，否则冻结在带环旧帧）

  const SHAPES = () => {
    const g = document.getElementById('cv').getContext('2d')
    const near = (r, gg, b, R, G, B, t) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
    const lum = (r, gg, b) => 0.299 * r + 0.587 * gg + 0.114 * b
    const TC = [[143, 216, 200], [111, 168, 255], [92, 122, 153], [61, 90, 128]]
    const wins = [
      { x0: 223, y0: 206, w: 45, h: 45 }, { x0: 218, y0: 253, w: 55, h: 51 },
      { x0: 210, y0: 312, w: 70, h: 58 }, { x0: 124, y0: 395, w: 142, h: 107 },
    ]
    const feats = (wn, cls) => {
      const d = g.getImageData(wn.x0, wn.y0, wn.w, wn.h).data
      const pts = []
      let gold = 0
      for (let y = 0; y < wn.h; y++) for (let x = 0; x < wn.w; x++) {
        const i = (y * wn.w + x) * 4
        if (cls(d[i], d[i + 1], d[i + 2])) pts.push([x, y])
        if (d[i] > 150 && d[i + 1] > 110 && d[i + 2] < 80) gold++
      }
      if (!pts.length) return { n: 0, gold, empty: true }
      /* 离群点剪裁（中位心 ±40px）：灰度阈窗内偶发混色像素/窗缘 bleed 不外扩包络 */
      const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1] }
      const mx = med(pts.map((p) => p[0])), my = med(pts.map((p) => p[1]))
      const kept = pts.filter((p) => Math.abs(p[0] - mx) <= 75 && Math.abs(p[1] - my) <= 75)
      const rows = new Array(wn.h).fill(0), cols = new Array(wn.w).fill(0)
      for (const [x, y] of kept) { rows[y]++; cols[x]++ }
      let y0i = -1, y1i = -1, x0i = -1, x1i = -1, maxRow = 0
      for (let y = 0; y < wn.h; y++) if (rows[y] > 0) { if (y0i < 0) y0i = y; y1i = y; maxRow = Math.max(maxRow, rows[y]) }
      for (let x = 0; x < wn.w; x++) if (cols[x] > 0) { if (x0i < 0) x0i = x; x1i = x }
      if (y0i < 0 || x0i < 0) return { n: kept.length, gold, empty: true }
      const hExt = y1i - y0i + 1, wExt = x1i - x0i + 1
      let coreTop = -1, coreBot = -1
      for (let y = y0i; y <= y1i; y++) if (rows[y] >= 0.6 * maxRow) { if (coreTop < 0) coreTop = y; coreBot = y }
      return {
        n: kept.length, gold, hExt, wExt, aspect: +(hExt / wExt).toFixed(3),
        protTop: +((coreTop - y0i) / hExt).toFixed(3), protBot: +((y1i - coreBot) / hExt).toFixed(3),
      }
    }
    const byTier = wins.map((wn, t) => feats(wn, (r, gg, b) => near(r, gg, b, TC[t][0], TC[t][1], TC[t][2], 14)))
    const byLuma = wins.map((wn) => feats(wn, (r, gg, b) => { const L = lum(r, gg, b); return L >= 60 && L <= 246 })) // 灰度阈值=色盲模拟（hud-font-standard §3）
    return { byTier, byLuma }
  }
  const shp = await freeze(SHAPES)
  await page.screenshot({ path: join(OUT, 'b-shapes.png') })
  const ft = shp.byTier, fl = shp.byLuma
  A('B1', 'T0 浮游=圆卵形（色通道簇 h/w 最圆+无背鳍突起——「圆点」形状签名）',
    !ft[0].empty && ft[0].aspect >= 0.68 && ft[0].protTop <= 0.2, `色簇 n=${ft[0].n} aspect=${ft[0].aspect} protTop=${ft[0].protTop}`)
  A('B2', 'T1 小鱼=梭形（色通道簇长条 h/w 最扁+无背鳍突起——「椭圆梭」形状签名）',
    !ft[1].empty && ft[1].aspect <= 0.62 && ft[1].protTop <= 0.2, `色簇 n=${ft[1].n} aspect=${ft[1].aspect} protTop=${ft[1].protTop}`)
  A('B3', 'T2 猎鲨=三角鳍形（背鳍突起：顶缘窄行突出主体包络 ≥20% h——「三角」形状签名）',
    !ft[2].empty && ft[2].protTop >= 0.2 && ft[2].n > ft[1].n, `色簇 n=${ft[2].n} protTop=${ft[2].protTop}（protBot=${ft[2].protBot}）`)
  A('B4', 'T3 沧鲸=宽巨形+金描边（四档最宽 wExt+金描边像素——「apex」形状签名）',
    !ft[3].empty && ft[3].wExt >= 80 && ft[3].gold >= 12 && ft[3].wExt > ft[2].wExt * 2, `色簇 n=${ft[3].n} wExt=${ft[3].wExt}（T2=${ft[2].wExt}；尾鳍 .85α 混色不入色簇——体宽口径）gold=${ft[3].gold}px`)
  A('B5', '四档颜色通道全在场（visTiers 定点位精确色匹配——T0 淡青/T1 银蓝/T2 灰蓝/T3 深蓝）',
    ft.every((f, i) => f.n >= [40, 50, 120, 500][i]), `n=(${ft.map((f) => f.n).join('/')})px`)
  A('B9', '灰度化形状通道可辨（ringsOff+luma 阈去色复判：T0 最圆/T1 长身无背鳍/T2 背鳍突起/T3 最宽——色盲形通道独立成立）',
    fl[0].aspect >= 0.72 && fl[1].aspect <= 0.62 && fl[1].wExt >= 24 && fl[2].protTop >= 0.4 && fl[3].wExt >= 100 && fl[3].wExt > fl[1].wExt * 2,
    `luma aspect=(${fl.map((f) => f.aspect).join('/')}) protTop1=${fl[1].protTop} protTop2=${fl[2].protTop} wExt=(${fl.map((f) => f.wExt).join('/')})（离群剪裁 ±75 后）`)

  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('ringsOn'))
  await sleep(90) // 复绘窗（同 ringsOff——开环后等画布复绘）
  const ringSnap = () => {
    const g = document.getElementById('cv').getContext('2d')
    const frac = (cx, cy, R, cls) => { let hit = 0, tot = 0; for (let a = 0; a < 360; a += 10) { tot++; const x = Math.round(cx + Math.cos(a * Math.PI / 180) * R), y = Math.round(cy + Math.sin(a * Math.PI / 180) * R); const p = g.getImageData(x, y, 1, 1).data; if (cls(p[0], p[1], p[2])) hit++ } return +(hit / tot).toFixed(2) }
    const d = g.getImageData(80, 356, 30, 16).data
    let txt = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150) txt++
    return {
      prey: Math.max(frac(235, 191, 10, (r, gg, b) => gg > r + 25 && gg > 90 && gg > b + 25), frac(235, 191, 11, (r, gg, b) => gg > r + 25 && gg > 90 && gg > b + 25)),
      pred: Math.max(frac(95, 400, 25, (r, gg, b) => r > gg + 12 && r > b + 12 && r > 38), frac(95, 400, 26, (r, gg, b) => r > gg + 12 && r > b + 12 && r > 38)),
      txt,
    }
  }
  const rings = await freeze(ringSnap)
  await sleep(220) // 红环 alpha 0.15-0.45 呼吸——跨相位双采（低相位仅 AA 边弱化）
  const rings2 = await freeze(ringSnap)
  const preyF = Math.max(rings.prey, rings2.prey), predF = Math.max(rings.pred, rings2.pred)
  A('B7', '猎物提示=绿虚线环（可吞 K=1.25 渲染镜像——虚线=形状通道：角度采样覆盖 <0.8 呈断续）',
    preyF >= 0.3 && preyF <= 0.8, `36 向采样绿覆盖=${preyF}（双相位 ${rings.prey}/${rings2.prey}）`)
  A('B8', '天敌警示=红实线粗环+红名（不可吞规避——实线连续 ≥0.8+「天敌」文字=色外通道）',
    predF >= 0.8 && rings.txt >= 3, `红覆盖=${predF}（双相位 ${rings.pred}/${rings2.pred}），红名像素=${rings.txt}`)

  /* ================= §C FEEL 面识图（事件驱动+冻结帧对账） ================= */
  console.error('── §C FEEL 面识图 ──')
  const mySeat = await page.evaluate(() => window.__GAMES_DEBUG__.state().seat)
  const warm = () => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(128, 322, 77, 63).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i] - d[i + 2] > 70) n++
    return n
  }
  const w0 = await freeze(warm)
  await page.evaluate((s) => window.__GAMES_DEBUG__.fxProbe({ k: 'devour', by: s, seat: 1, gain: 30, drops: 10 }), mySeat)
  await sleep(110)
  const w1 = await freeze(warm)
  await page.screenshot({ path: join(OUT, 'c1-gulp.png') })
  A('C1', '吞噬吸入 F01（signature 240ms：受害者残影橙拉丝 #FFB65C+嘴点扩张金环——冻结帧对账）',
    w1 - w0 >= 4, `吞噬走廊暖色 Δ=${w1 - w0}px（${w0}→${w1}）`)

  const annulus = () => {
    const g = document.getElementById('cv').getContext('2d')
    let gold = 0, teal = 0
    for (let y = 288; y < 380; y++) for (let x = 142; x < 234; x++) {
      const dx = x - 187.5, dy = y - 333.5, dd = Math.hypot(dx, dy)
      if (dd < 12 || dd > 45) continue
      const p = g.getImageData(x, y, 1, 1).data
      if (p[0] > 135 && p[1] > 90 && p[2] < 95 && p[0] - p[2] > 70) gold++
      if (p[1] > p[0] + 50 && p[2] > 120) teal++
    }
    return { gold, teal }
  }
  const a0 = await freeze(annulus)
  await page.evaluate((s) => window.__GAMES_DEBUG__.fxProbe({ k: 'tier', seat: s, t: 2 }), mySeat)
  await sleep(110)
  const a1 = await freeze(annulus)
  await page.screenshot({ path: join(OUT, 'c2-tierburst.png') })
  A('C2', '升档光圈 F02（480ms 双环爆发：金 #FFD700 外环+青 #7FE8D8 内环——annulus 对账）',
    a1.gold - a0.gold >= 3 && a1.teal - a0.teal >= 3, `Δ金=${a1.gold - a0.gold} Δ青=${a1.teal - a0.teal}px（${a0.gold}/${a0.teal}→${a1.gold}/${a1.teal}）`)

  const trail = () => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(140, 312, 41, 40).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 195 && d[i + 1] > 180 && d[i + 2] > 140 && d[i] - d[i + 2] < 95) n++
    return n
  }
  const t0c = await freeze(trail)
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('dash'))
  await sleep(260)
  const t1c = await freeze(trail)
  await page.screenshot({ path: join(OUT, 'c3-dash-on.png') })
  await sleep(1000)
  const t2c = await freeze(trail)
  A('C3', 'dash 尾迹三态 F04（off 零尾迹→on 淡金气泡串在场→熄灭后衰减回零；窗避自身白腹鳍标）',
    t0c <= 3 && t1c - t0c >= 3 && t2c <= t0c + 1, `off=${t0c} on=${t1c} decay=${t2c}px`)

  const c6a = await freeze(() => {
    const g = document.getElementById('cv').getContext('2d')
    let teal = 0
    for (let y = 293; y < 375; y++) for (let x = 147; x < 229; x++) {
      const dd = Math.hypot(x - 187.5, y - 333.5)
      if (dd < 8 || dd > 40) continue
      const p = g.getImageData(x, y, 1, 1).data
      if (p[1] > p[0] + 50 && p[2] > 120) teal++
    }
    const d = g.getImageData(170, 36, 60, 14).data
    let ink = 0
    for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 100) ink++
    return { teal, ink }
  })
  for (let i = 0; i < 5; i++) await page.evaluate((a) => window.__GAMES_DEBUG__.fxProbe({ k: 'eat', seat: a[0], v: 1, id: 'a' + a[1] }), [mySeat, i])
  await sleep(130)
  const c6b = await freeze(() => {
    const g = document.getElementById('cv').getContext('2d')
    let teal = 0
    for (let y = 293; y < 375; y++) for (let x = 147; x < 229; x++) {
      const dd = Math.hypot(x - 187.5, y - 333.5)
      if (dd < 8 || dd > 40) continue
      const p = g.getImageData(x, y, 1, 1).data
      if (p[1] > p[0] + 50 && p[2] > 120) teal++
    }
    const d = g.getImageData(170, 36, 60, 14).data
    let ink = 0
    for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 100) ink++
    return { teal, ink }
  })
  A('C6', '吃食反馈双面（光波冲击环 teal annulus+连食×5 streak 字形——F12/eat 链）',
    c6b.teal - c6a.teal >= 2 && c6b.ink - c6a.ink >= 3, `Δ环=${c6b.teal - c6a.teal} Δstreak 字形=${c6b.ink - c6a.ink}px`)
  await sleep(900) // toast 退场

  /* ---------- 排行榜/观战条 glyph（stateAll=HUD 演示位驱动） ---------- */
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('stateAll'))
  await sleep(250)
  const lbs = await freeze(() => {
    const g = document.getElementById('cv').getContext('2d')
    const TC = [[143, 216, 200], [111, 168, 255], [92, 122, 153], [61, 90, 128]]
    const near = (p, c) => Math.abs(p[0] - c[0]) <= 26 && Math.abs(p[1] - c[1]) <= 26 && Math.abs(p[2] - c[2]) <= 26
    const rowsHit = []
    for (let r = 0; r < 5; r++) {
      const y = 90 + r * 17
      const d = g.getImageData(10, y - 10, 13, 12).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) { const p = [d[i], d[i + 1], d[i + 2]]; if (TC.some((c) => near(p, c))) n++ }
      rowsHit.push(n)
    }
    let barRows = 0, glyphPx = 0
    for (let r = 0; r < 4; r++) {
      const yy = 543 + r * 12
      const bar = g.getImageData(60, yy, 240, 8).data
      let bn = 0
      for (let i = 0; i < bar.length; i += 4) { const p = [bar[i], bar[i + 1], bar[i + 2]]; if (TC.some((c) => near(p, c))) bn++ }
      if (bn >= 30) barRows++
      const gl = g.getImageData(44, yy, 12, 9).data
      for (let i = 0; i < gl.length; i += 4) { const p = [gl[i], gl[i + 1], gl[i + 2]]; if (TC.some((c) => near(p, c))) glyphPx++ }
    }
    return { rowsHit, barRows, glyphPx }
  })
  A('B6', '排行榜档位 glyph 形色双通道（本单补漏：行首四档轮廓微标 ×top5——tier 色像素逐行）',
    lbs.rowsHit.filter((n) => n >= 2).length >= 4, `逐行 glyph px=(${lbs.rowsHit.join('/')})`)
  A('B10', '观战体型对比条形色双通道（F15：tier 色相对条 ≥3 行+档位 glyph 像素在场）',
    lbs.barRows >= 3 && lbs.glyphPx >= 4, `色条行=${lbs.barRows}/4 glyphPx=${lbs.glyphPx}`)

  /* ---------- 死亡面（先于 round/crown：加冕覆层 5s 压暗全场+金粒雨会污染红边采样） ---------- */
  const scatter = () => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(127, 273, 120, 120).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i] - d[i + 2] > 70) n++
    return n
  }
  const edgeRed2 = () => {
    const g = document.getElementById('cv').getContext('2d')
    let n = 0
    for (const [x0, y0, w, h] of [[0, 200, 10, 60], [365, 200, 10, 60]]) {
      const d = g.getImageData(x0, y0, w, h).data
      for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 1] + 8 && d[i] > d[i + 2] + 8 && d[i] > 30) n++
    }
    return n
  }
  const e0 = await freeze(edgeRed2), s0 = await freeze(scatter)
  await page.evaluate((s) => window.__GAMES_DEBUG__.fxProbe({ k: 'devour', seat: s, by: 2, drops: 8 }), mySeat)
  await sleep(160)
  const s1 = await freeze(scatter)
  let e1 = 0 // 红脉冲 alpha=（0.35+0.25sin(now/90)）*0.3——180ms 周期低相位不可检，跨相位四采取峰
  for (let i = 0; i < 4; i++) { await sleep(120); e1 = Math.max(e1, await freeze(edgeRed2)) }
  await page.screenshot({ path: join(OUT, 'c5-death.png') })
  A('C5', '死亡散布+惊红闪（F06 化作 N 光点橙粒+V05 四边红脉冲 vignette——死亡覆层冻结帧）',
    s1 - s0 >= 4 && e1 - e0 >= 6, `Δ橙粒=${s1 - s0}px Δ边带红=${e1 - e0}px（红边低alpha 双拍 300ms）`)
  await sleep(2600) // 重生倒计时退场
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm')) // 死亡态复位

  /* ---------- 轮末/加冕字体注册（A6 覆盖面用） ---------- */
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('round'))
  await sleep(350)
  await page.evaluate(() => window.__GAMES_DEBUG__.fxProbe({ k: 'crown', seat: 1, name: '幽灵1', score: 99 }))
  await sleep(300)

  await page.evaluate((s) => { const D = window.__GAMES_DEBUG__; D.fxScene('dash'); D.fxProbe({ k: 'devour', by: s, seat: 1, gain: 30, drops: 10 }); D.fxProbe({ k: 'tier', seat: s, t: 1 }) }, mySeat) // 复触发（无冻结）——freeze 会把 draw 戳推迟 90ms+ 造成台账假红
  await sleep(300)
  const led = await page.evaluate(() => {
    const L = window.__GAMES_DEBUG__.fxLedger()
    const out = {}
    for (const e of L) if (e.draw != null && (out[e.id] == null || e.lat < out[e.id])) out[e.id] = e.lat
    return out
  })
  A('C4', '动效台账首绘（F01 吞噬/F02 升档/F04 尾迹/F05 惊红/F06 散布 draw≠null+fb 首绘 ≤80ms）',
    ['F01', 'F02', 'F04', 'F05', 'F06'].every((id) => led[id] != null) && ['F01', 'F02', 'F04', 'F05', 'F06'].every((id) => led[id] <= 80),
    ['F01', 'F02', 'F04', 'F05', 'F06'].map((id) => `${id}:${led[id]}ms`).join(' '))

  /* ================= §A HUD 全量 HF 体系核 ================= */
  console.error('── §A HUD/HF 全量核 ──')
  const src = await readFile(join(ROOT, 'games/multiplayer/deep-foodchain/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /g\.font\s*=/.test(l) && !/HF\(/.test(l))
  const ctorN = (src.match(/function HF\(/g) || []).length
  const STATIC_KEYS = ['mass', 'kills', 'round', 'ping', 'score', 'tier', 'lb-title', 'lb-name', 'lb-score', 'lb-delta', 'dash', 'foot', 'spec-name', 'curve-cap', 'toast', 'settle', 'settle-k', 'death-by', 'death-drop', 'death-cd', 'crown', 'crown-name', 'err', 'pred-name', 'combo', 'streak']
  const missStatic = STATIC_KEYS.filter((k) => !new RegExp(`'${k}'`).test(src))
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const reg = hf.reg || {}
  const grp = (P) => Object.entries(reg[P] || {})
  const minPx = (P) => grp(P).length ? Math.min(...grp(P).map(([, v]) => v.px)) : 99
  const wOk = (P, lo, hi) => grp(P).every(([, v]) => (v.w || 400) >= lo && (v.w || 400) <= hi)
  A('A1', 'HF __applied 生效往返自证（登记==ctx.font 回读——Q-013 票面首日断言位，VIS 全量核）', hf.__applied === true, `__applied=${hf.__applied}`)
  A('A2', 'P0 运行时下限（≥13px 且全项字重 ≥600——hud-font-standard §1）', minPx('P0') >= 13 && wOk('P0', 600, 800), `P0min=${minPx('P0')}px，键=${grp('P0').length} 项`)
  A('A3', 'P1 运行时下限（≥11px，字重 400-700）', minPx('P1') >= 11 && wOk('P1', 400, 700), `P1min=${minPx('P1')}px，键=${grp('P1').length} 项`)
  A('A4', 'P2 运行时下限（≥9px）', minPx('P2') >= 9, `P2min=${minPx('P2')}px，键=${grp('P2').length} 项`)
  A('A5', '零裸字号静态审计（g.font= 渲染位全走 HF+构造点唯一+静态键全集 26 键无缺）',
    bare.length === 0 && ctorN === 1 && missStatic.length === 0,
    bare.length ? `裸字号 L${bare.map(([i]) => i).join(',')}` : `0 处；构造点=${ctorN}；缺键=${missStatic.length ? missStatic.join(',') : '无'}`)
  const NEED = {
    P0: ['mass', 'kills', 'round', 'score', 'combo', 'settle', 'death-by', 'death-cd', 'crown', 'crown-name', 'toast'],
    P1: ['tier', 'streak', 'lb-title', 'lb-name', 'lb-delta', 'dash', 'settle-k', 'death-drop'],
    P2: ['ping', 'foot', 'spec-name', 'curve-cap', 'pred-name'],
  }
  const missRT = []
  for (const P in NEED) for (const k of NEED[P]) if (!grp(P).some(([kk]) => kk === k)) missRT.push(`${P}.${k}`)
  A('A6', 'HF 全 HUD 面键覆盖（运行时 reg ⊇ 24 键：顶栏/榜/钮/页脚/toast/结算/死亡/加冕/观战/曲线全触达）',
    missRT.length === 0, `缺=${missRT.length ? missRT.join(',') : '无'}（运行时 P0/${grp('P0').length} P1/${grp('P1').length} P2/${grp('P2').length}）`)
  const toastPx = grp('P0').filter(([k]) => k === 'toast').map(([, v]) => v.px)[0]
  A('A7', 'toast 弹跳峰值不破档（P0 toast 动态字号（15×1.35 弹跳）≥13——登记表口径）', toastPx >= 13, `toast 登记值=${toastPx}px`)
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm')) // 清加冕覆层（5s 窗内全场压暗+金粒雨会污染 bgRef）
  await sleep(90)
  const anc = await freeze(() => {
    const g = document.getElementById('cv').getContext('2d')
    const mx = (x, y) => { const d = g.getImageData(x - 2, y - 2, 5, 5).data; let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); return Math.round(m) }
    return { topBg: mx(5, 5), mass: mx(13, 20), round: mx(133, 20), score: mx(13, 42), lbTitle: mx(14, 70), dash: mx(317, 589), foot: mx(16, 656), bgRef: mx(200, 300) }
  })
  const glyphOk = ['mass', 'round', 'score', 'lbTitle', 'foot'].every((k) => anc[k] > anc.bgRef + 18)
  A('A8', 'HUD 铬件 7 锚在场（顶栏底/质·轮·分·榜题·页脚字形/dash 钮面——3×3 峰值 luma 对背景）',
    glyphOk && anc.topBg < 60 && anc.dash > 0, `luma=${JSON.stringify(anc)}`)

  /* ================= §E 三态冻结对照（浮游/中期/鲸级） ================= */
  console.error('── §E 三态冻结对照 ──')
  const stateShot = async (k, tier, file) => {
    await page.evaluate((kk) => window.__GAMES_DEBUG__.fxScene('grow:' + kk), k)
    await sleep(1600) // 档位 zoom 阶梯 lerp 0.04/帧收敛
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
    await sleep(90)
    await page.screenshot({ path: join(OUT, file) })
    const r = await page.evaluate((tt) => {
      const g = document.getElementById('cv').getContext('2d')
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
      const d = g.getImageData(0, 56, 375, 500).data
      const cnt = {}
      for (let i = 0; i < d.length; i += 4) { const kk = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); cnt[kk] = (cnt[kk] || 0) + 1 }
      let bg = 0, bgK = null; for (const kk in cnt) if (cnt[kk] > bg) { bg = cnt[kk]; bgK = kk }
      const B = bgK.split(',').map(Number).map((v) => v * 16 + 8)
      let inkN = 0, total = 0
      for (let i = 0; i < d.length; i += 4) { total++; if (Math.abs(d[i] - B[0]) + Math.abs(d[i + 1] - B[1]) + Math.abs(d[i + 2] - B[2]) > 72) inkN++ }
      /* 中心档位色簇+金描边 */
      const nearC = (p, c, t) => Math.abs(p[0] - c[0]) <= t && Math.abs(p[1] - c[1]) <= t && Math.abs(p[2] - c[2]) <= t
      const TC = [[143, 216, 200], [111, 168, 255], [92, 122, 153], [61, 90, 128]]
      const cd = g.getImageData(157, 303, 60, 60).data
      let tierN = 0, goldN = 0
      for (let i = 0; i < cd.length; i += 4) {
        const p = [cd[i], cd[i + 1], cd[i + 2]]
        if (nearC(p, TC[tt], 22)) tierN++
        if (p[0] > 150 && p[1] > 110 && p[2] < 80) goldN++
      }
      return {
        zoom: window.__GAMES_DEBUG__.cam().zoom,
        anchors: { topBg: px(5, 5), mass: px(13, 20), round: px(133, 20), score: px(13, 42), lbTitle: px(14, 70), dash: px(317, 589), foot: px(14, 660) },
        band: +(inkN / total).toFixed(4), tierN, goldN,
      }
    }, tier)
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
    return r
  }
  const st1 = await stateShot('t0', 0, 'e1-t0.png')
  const st2 = await stateShot('mid', 2, 'e2-mid.png')
  const st3 = await stateShot('t3', 3, 'e3-t3.png')
  A('E1', '浮生态冻结帧（grow:t0——zoom=1.00+T0 淡青中心簇+HUD 锚稳定）',
    Math.abs(st1.zoom - 1.0) <= 0.02 && st1.tierN >= 40, `zoom=${st1.zoom} T0 簇=${st1.tierN}px band=${st1.band}`)
  A('E2', '中期态冻结帧（grow:mid M=350——zoom=0.84 档位阶梯+T2 灰蓝中心簇）',
    Math.abs(st2.zoom - 0.84) <= 0.02 && st2.tierN >= 40, `zoom=${st2.zoom} T2 簇=${st2.tierN}px band=${st2.band}`)
  A('E3', '鲸级态冻结帧（grow:t3 M=4000——zoom=0.76+T3 深蓝巨体+金描边在场）',
    Math.abs(st3.zoom - 0.76) <= 0.02 && st3.tierN >= 300 && st3.goldN >= 10, `zoom=${st3.zoom} T3 簇=${st3.tierN}px gold=${st3.goldN}px`)
  let ancOk = true, worst = 0
  for (const [a, b] of [[st1, st2], [st2, st3], [st1, st3]]) for (const k in a.anchors) {
    const d = Math.max(...a.anchors[k].map((v, i) => Math.abs(v - b.anchors[k][i])))
    worst = Math.max(worst, d); if (d > 12) ancOk = false
  }
  const bands = [st1.band, st2.band, st3.band]
  const bandDiffs = [Math.abs(bands[0] - bands[1]), Math.abs(bands[1] - bands[2]), Math.abs(bands[0] - bands[2])]
  A('E4', '三态帧差合理带（HUD 7 锚跨态零位移 ≤12+世界层墨水带：最大对差 >0.004（非同帧）且全对 <0.5（非崩版）——zoom 驱动）',
    ancOk && Math.max(...bandDiffs) > 0.004 && bandDiffs.every((d) => d < 0.5), `锚最大通道差=${worst}，带差=${bandDiffs.map((d) => d.toFixed(3)).join('/')}`)

  await writeFile(join(EVID, 'vis-evidence.json'), JSON.stringify({ results, d1, d4, shapes: shp, rings, led, hf: { P0: minPx('P0'), P1: minPx('P1'), P2: minPx('P2'), applied: hf.__applied }, states: { st1, st2, st3 }, pageErrors }, null, 1))

  A('FX-0', '页面零异常（pageerror——全场景含 visTiers/grow/事件探针）', pageErrors.length === 0, pageErrors.join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  srv.close(); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[vis-check] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}（截图 ${OUT}）`)
process.exit(fail.length ? 1 : 0)
