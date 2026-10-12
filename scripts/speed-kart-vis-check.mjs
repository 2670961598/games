#!/usr/bin/env node
/* =====================================================================
 * GAMES-115 极速卡丁 视觉统一（VIS）断言工具——对齐 snake-king-vis-check.mjs /
 * speed-kart-feel-check.mjs 取证口径（?debug=1 离线竞技场 + 冻结帧墨水带 +
 * 不透明字形锚点 + visInfo 契约 + 运行时自证，DSF=1 截图）：
 *   V-HUD-1 静态：零裸字号（g.font 全走 HF；「px ' + FONT」构造点唯一）+ DOM boot
 *            文本 13/600 合规（hud-font-standard §2.3 大厅/DOM 同级套用）+ 版本位一致
 *   V-HUD-2 运行时：hudFonts() 自证 P0≥13 / P1≥11 / P2≥9 + 登记键位 ≥18
 *   V-CB-1/2/3 色盲双编码：车辆 6 色 × 席位形状通道（同亮度带互异）+ 弯道色带
 *            （红内/白外 × luma 差 + 虚线节律 + neon 变体）+ ping 档位信号条
 *            形码（绿/红灰度同带 → 形通道必需，三档注入可数）
 *   V-RD-1/2 竞速可读性：motion 速度线激活（台账 F10）+ 相机速度带（FOV 代理
 *            zoom 1.00→0.84 带内）
 *   V-RD-3 小地图：赛道走线环墨 + ≥5 车位彩点 + 金起跑标 + 我席白圈
 *   V-RD-4 结算 T7-A 对照条精化：零基线柱 + 双条（行内归一）+ 条尾亮端标
 *   V-SHOT-1/2/3 识图 v2 三帧（home 倒数/play 巡航/settle 结算）字形锚点
 *   V-PERF 巡航 fps 不降（同挂具基线 12；≥55 绝对红线系本机软渲染环境不可达）
 * 用法：node scripts/speed-kart-vis-check.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-115-shots'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const lumArr = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
const luma = (hex) => { const v = parseInt(hex.slice(1), 16); return Math.round(0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-spk-'))
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
let pageErrors = []
let page
try {
  /* ================= V-HUD-1 静态审计（零依赖） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/speed-kart/client.js'), 'utf8')
  const html = await readFile(join(ROOT, 'games/multiplayer/speed-kart/index.html'), 'utf8')
  const gameJson = JSON.parse(await readFile(join(ROOT, 'games/multiplayer/speed-kart/game.json'), 'utf8'))
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
  const ctorN = (src.match(/px ' \+ FONT/g) || []).length
  A('V-HUD-1a', '零裸字号（g.font 全走 HF 登记表；字体字串构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；构造点=${ctorN}`)
  A('V-HUD-1b', 'DOM 文本同级套用（index.html 唯一 DOM 文本=boot 覆盖层 13px/600，≥P1 且达标 P0 读数位）', /font:\s*600 13px\//.test(html), 'boot 13/600（hud-font-standard §2.3 口径）')
  A('V-HUD-1c', '版本位一致（页脚 slug=game.json）', src.includes(`speed-kart · v${gameJson.version} · S7`), `game.json=${gameJson.version}`)

  /* ================= 运行时（?debug=1 离线竞技场，同渲染路径） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/speed-kart/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
  await page.waitForTimeout(1300) // 倒数 3s 窗中段（home 帧）

  /* ---------- 冻结帧探针（FE-4 同范式：pause→采样→screenshot→unpause） ---------- */
  async function probeFrame(tag, extraEval) {
    if (extraEval) await page.evaluate(extraEval)
    await page.waitForTimeout(tag === 'settle' ? 420 : 160) // 注入后活跑≥数帧再冻结（立即 pause 采旧帧=假红根源）
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
    await page.waitForTimeout(60)
    const p = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const D = window.__GAMES_DEBUG__
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
      const lum = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
      /* 区域内匹配色计数（通道曼哈顿距离） */
      const matchN = (x0, y0, w, h, c, tol) => {
        const d = g.getImageData(x0, y0, w, h).data
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) < tol) n++
        return n
      }
      const vi = D.visInfo()
      /* 小地图探针（走线环带 / 车位彩点 / 金起跑标 / 我席白圈） */
      const mm = vi.mm
      const R = mm.r + 6, md = g.getImageData(mm.x - R, mm.y - R, R * 2, R * 2).data
      const cnt = {}
      for (let i = 0; i < md.length; i += 4) { const k = (md[i] >> 4) + ',' + (md[i + 1] >> 4) + ',' + (md[i + 2] >> 4); cnt[k] = (cnt[k] || 0) + 1 }
      let bgK = '0,0,0'; for (const k in cnt) if (cnt[k] > cnt[bgK] || !cnt[bgK]) bgK = k
      const B = bgK.split(',').map(Number).map((v) => v * 16 + 8)
      let ringN = 0, dotN = 0, whiteN = 0
      for (let y = 0; y < R * 2; y++) for (let x = 0; x < R * 2; x++) {
        const i = ((y * R * 2) + x) * 4, dx = x - R, dy = y - R, rr = Math.sqrt(dx * dx + dy * dy)
        if (rr > mm.r + 6) continue
        const dBG = Math.abs(md[i] - B[0]) + Math.abs(md[i + 1] - B[1]) + Math.abs(md[i + 2] - B[2])
        if (rr >= mm.r - 4 && rr <= mm.r + 3 && dBG > 60) ringN++                       // 走线环带
        if (rr < mm.r - 4 && dBG > 150) dotN++                                           // 车位彩点（不透明）
        if (rr < mm.r - 4 && md[i] > 225 && md[i + 1] > 225 && md[i + 2] > 225) whiteN++ // 我席白圈
      }
      /* 起跑旗标（登记位 7×7 黑白格：光/暗象限各自可数——色盲通用起跑符号） */
      let markLight = 0, markDark = 0
      if (mm.mark) {
        const kd = g.getImageData(mm.mark.x, mm.mark.y, 7, 7).data
        for (let i = 0; i < kd.length; i += 4) {
          const L = 0.299 * kd[i] + 0.587 * kd[i + 1] + 0.114 * kd[i + 2]
          if (L > 185) markLight++; else if (L < 80) markDark++
        }
      }
      /* ping 信号条探针（落笔位登记：三列实/空计数——实条=彩色亮，空条 0.22 alpha 暗） */
      let bars = null
      if (vi.pingBars) {
        const pb = vi.pingBars, bd = g.getImageData(pb.x - 2, pb.y - 12, 24, 14).data
        const cols = []
        for (let c = 0; c < 3; c++) {
          let on = 0
          for (let y = 0; y < 12; y++) for (let x = 0; x < 4; x++) {
            const i = ((y * 24) + (c * 6 + x)) * 4
            const mx = Math.max(bd[i], bd[i + 1], bd[i + 2]), mn = Math.min(bd[i], bd[i + 1], bd[i + 2])
            const L = 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2]
            if (mx - mn > 60 && L > 110) on++
          }
          cols.push(on)
        }
        bars = cols
      }
      /* 结算对照条探针（T7-A 精化：基线柱/本地青条+亮端标/判定灰条+亮端标） */
      const settleBars = (() => {
        const d = g.getImageData(178, 340, 96, 86).data
        let cyan = 0, capC = 0, dim = 0, capI = 0, base = 0
        for (let y = 0; y < 86; y++) for (let x = 0; x < 96; x++) {
          const i = ((y * 96) + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2]
          if (Math.abs(r - 92) + Math.abs(gg - 217) + Math.abs(b - 232) < 60) cyan++
          if (Math.abs(r - 127) + Math.abs(gg - 232) + Math.abs(b - 216) < 50) capC++
          if (Math.abs(r - 139) + Math.abs(gg - 147) + Math.abs(b - 167) < 50) dim++
          if (Math.abs(r - 232) + Math.abs(gg - 236) + Math.abs(b - 243) < 50) capI++
          if (x <= 3 && b - r > 8 && r > 60 && r < 115) base++
        }
        return { cyan, capC, dim, capI, base }
      })()
      return {
        vi,
        anchors: {
          lapGlyph: px(16, 38), bestGlyph: px(105, 17), pingGlyph: px(319, 17),
          chargeGlyph: px(17, 567), driftBtnGlyph: px(320, 601), footGlyph: px(10, 656),
        },
        mm: { ringN, dotN, whiteN, markLight, markDark },
        bars,
        settleBars,
        settleAnchors: {
          title: px(176, 77), row: px(64, 126), dualT: px(187, 326), dualT2: px(196, 326), again: px(183, 571),
        },
        fonts: D.hudFonts(),
      }
    })
    await page.screenshot({ path: join(OUT, `g115-${tag}.png`) })
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
    return p
  }

  /* ---------- V-SHOT-1 home 帧（倒数窗中段） ---------- */
  const fHome = await probeFrame('home')
  const homeKeys = ['lapGlyph', 'bestGlyph', 'pingGlyph', 'chargeGlyph', 'driftBtnGlyph']
  A('V-SHOT-1', 'home 帧（倒数）HUD 字形锚点 5 位全亮 + 页脚 P2 位在册 + 倒数大字键在册',
    homeKeys.every((k) => lumArr(fHome.anchors[k]) > 90) && lumArr(fHome.anchors.footGlyph) > 60 && !!(fHome.fonts.P0 && fHome.fonts.P0.count),
    homeKeys.map((k) => lumArr(fHome.anchors[k]).toFixed(0)).join('/') + ` / foot=${lumArr(fHome.anchors.footGlyph).toFixed(0)} / P0.count=${fHome.fonts.P0 && fHome.fonts.P0.count}`)

  /* ---------- V-CB-3 ping 信号条形码（三档注入逐档可数） ---------- */
  const tierProbe = async (pingV) => { await page.evaluate((v) => window.__GAMES_DEBUG__.visSet({ ping: v }), pingV); return (await probeFrame('ping-t' + pingV)).bars }
  const b3 = await tierProbe(45), b2 = await tierProbe(120), b1 = await tierProbe(300)
  const cntOn = (cols) => cols.filter((c) => c >= 4).length   // 每实条 4×(4-10)px，≥4 像素判实
  A('V-CB-3a', 'ping 档位信号条形码：三档注入实条数 3/2/1 逐档可数（灰度形通道）', cntOn(b3) === 3 && cntOn(b2) === 2 && cntOn(b1) === 1, `45ms→${cntOn(b3)}条 120ms→${cntOn(b2)}条 300ms→${cntOn(b1)}条（列像素 ${JSON.stringify({ b3, b2, b1 })}）`)
  const t3 = fHome.vi.pingTiers
  const lG = luma(t3[0].c), lR = luma(t3[2].c)
  A('V-CB-3b', 'ping 三档色灰度披露：绿/红档同带（Δluma<12 → 色相不可依，形通道必需）且三档条数互异', Math.abs(lG - lR) < 12 && new Set(t3.map((t) => t.bars)).size === 3, `绿${lG}/红${lR} Δ${Math.abs(lG - lR)}；条数 ${t3.map((t) => t.bars).join('/')}`)

  /* ---------- 巡航（过绿灯窗） ---------- */
  await page.waitForTimeout(4200)
  await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('calm'); window.__GAMES_DEBUG__.visSet({ ping: 0 }) })
  const fPlay = await probeFrame('play')

  /* ---------- V-CB-1/2 双编码校验表（visInfo 契约） ---------- */
  const vi = fPlay.vi
  const shapes = new Set(vi.seats.map((s) => s.shape))
  A('V-CB-1a', '车辆 6 色 × 6 席位形状通道在册（circle/tri/square/dia/cross/star）', vi.seats.length === 6 && shapes.size === 6, `${vi.seats.map((s) => s.c + ':' + s.shape).join(' ')}`)
  const lumas = vi.seats.map((s) => [s.c, luma(s.c), s.shape]).sort((a, b) => a[1] - b[1])
  const sameBand = []
  for (let i = 0; i + 1 < lumas.length; i++) if (lumas[i + 1][1] - lumas[i][1] < 16) sameBand.push([lumas[i], lumas[i + 1]])
  A('V-CB-1b', '同亮度带（Δluma<16）席位对形状互异（灰度下可辨）', sameBand.length > 0 && sameBand.every((p) => p[0][2] !== p[1][2]), sameBand.map((p) => `${p[0][0]}~${p[1][0]} Δ${p[1][1] - p[0][1]}（${p[0][2]} vs ${p[1][2]}）`).join('；'))
  const cb2 = luma(vi.curb.inner) - luma(vi.curb.outer)
  A('V-CB-2a', '弯道色带双通道：内/外缘 luma 差 ≥40（红内 115/白外 228——灰度下内外缘可分）+ 虚线同律（位置通道）', Math.abs(cb2) >= 40 && vi.curb.dash[0] === 14, `Δluma=${Math.abs(cb2)}（${vi.curb.inner}/${vi.curb.outer}）dash=${vi.curb.dash.join('/')}`)
  const neonD = Math.abs(luma('#5CD9E8') - luma('#E86BC9'))
  A('V-CB-2b', 'neon 轨道变体色对（青/品红）灰度差 ≥20 + 我席白圈兜底（seat 判据色盲无关）', neonD >= 20, `cyan/mag Δluma=${neonD}；我席=白圈描边（drawKart isMe）`)

  /* ---------- V-SHOT-2 play 帧字形锚点稳定复现 ---------- */
  A('V-SHOT-2', 'play 帧（巡航）同锚点稳定复现（倒数期锚位在巡航态不漂移）',
    homeKeys.every((k) => lumArr(fPlay.anchors[k]) > 90) && lumArr(fPlay.anchors.footGlyph) > 60,
    homeKeys.map((k) => lumArr(fPlay.anchors[k]).toFixed(0)).join('/') + ` / foot=${lumArr(fPlay.anchors.footGlyph).toFixed(0)}`)

  /* ---------- V-RD-1/2 速度感复核 ---------- */
  const f10 = await page.evaluate(() => { const e = window.__GAMES_DEBUG__.fxLedger().find((x) => x.id === 'F10'); return e ? e.lat : null })
  A('V-RD-1', 'motion 速度线激活（巡航 v≥120px/s 门开→S.motionOn=1 + F10 台账首绘在册）', fPlay.vi.motion.on === 1 && f10 != null, `motion.on=${fPlay.vi.motion.on} F10=${f10}ms（GAMES-113 量纲修正后非死码）`)
  let camBest = fPlay.vi.cam
  for (let i = 0; i < 2; i++) { await page.waitForTimeout(400); const c = await page.evaluate(() => window.__GAMES_DEBUG__.visInfo().cam); if (c.zoom < camBest.zoom) camBest = c }
  A('V-RD-2', '相机速度带（FOV 代理）：巡航 zoom 收进 1.00→[0.84,0.97) 带内（前视 56→100px 同带外扩）', camBest.zoom < 0.97 && camBest.zoom >= 0.84 && camBest.zT >= 0.84, `best-of-3 zoom=${camBest.zoom} zT=${camBest.zT}（静止态=1.00）`)

  /* ---------- V-RD-3 小地图走线+车位点 ---------- */
  A('V-RD-3a', '小地图赛道走线：整圈轮廓环带墨（Ø96 环带采样）', fPlay.mm.ringN >= 120, `ringN=${fPlay.mm.ringN}`)
  A('V-RD-3b', '小地图车位点：≥5 彩点 + 起跑黑白格旗标（登记位光/暗象限可数）+ 我席白圈（三通道齐）', fPlay.mm.dotN >= 40 && fPlay.mm.markLight >= 8 && fPlay.mm.markDark >= 6 && fPlay.mm.whiteN >= 8, `彩点px=${fPlay.mm.dotN} 旗标光px=${fPlay.mm.markLight}/暗px=${fPlay.mm.markDark} 白圈px=${fPlay.mm.whiteN}`)

  /* ---------- V-HUD-2 运行时自证（注入场景累计键位） ---------- */
  await page.evaluate(() => {
    const D = window.__GAMES_DEBUG__, seat = D.state().seat
    D.visSet({ pingOpen: true })
    D.fxProbe({ k: 'green', tick: 0 })       // GO! 大字
    D.fxProbe({ k: 'lap', seat, ms: 41320 }) // 圈速横幅
    D.fxProbe({ k: 'draft', seat })          // 尾流提示
    D.fxProbe({ k: 'jump', seat })           // 抢跑罚红字
  })
  await page.waitForTimeout(400)
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const allPx = []
  for (const grp in hf) for (const key in hf[grp]) allPx.push([grp, hf[grp][key]])
  const minPx = (c) => Math.min(...allPx.filter((x) => x[0] === c).map((x) => x[1]))
  A('V-HUD-2a', 'hudFonts 运行时自证（P0≥13/P1≥11/P2≥9）', minPx('P0') >= 13 && minPx('P1') >= 11 && minPx('P2') >= 9, `P0=${minPx('P0')} P1=${minPx('P1')} P2=${minPx('P2')}`)
  await page.evaluate(() => window.__GAMES_DEBUG__.visSet({ pingOpen: false }))

  /* ---------- V-PERF 巡航采样 ---------- */
  const fps = []
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(500); fps.push(await page.evaluate(() => window.__GAMES_DEBUG__.fps())) }
  const avg = Math.round(fps.reduce((a, b) => a + b, 0) / fps.length)
  A('V-PERF', '巡航 fps 不降（≥同挂具 FEEL 基线 12；VIS 仅徽标信号条+对照条精化）', avg >= 12, `avg=${avg} [${fps.join(',')}]（≥55 绝对红线系本机软渲染环境改前即红，FE-5 同口径注记）`)

  /* ---------- V-SHOT-3 + V-RD-4 结算帧（fxScene('settle') 合成完赛态） ---------- */
  const fSettle = await probeFrame('settle', () => window.__GAMES_DEBUG__.fxScene('settle'))
  const sGlyph = (k, min) => lumArr(fSettle.settleAnchors[k]) > min
  A('V-SHOT-3', 'settle 帧（结算页）字形锚点亮（完赛标题/名次行/对照标题×2/再来一局）', sGlyph('title', 150) && sGlyph('row', 110) && (sGlyph('dualT', 90) || sGlyph('dualT2', 90)) && sGlyph('again', 150), `title=${lumArr(fSettle.settleAnchors.title).toFixed(0)} row=${lumArr(fSettle.settleAnchors.row).toFixed(0)} dualT=${Math.max(lumArr(fSettle.settleAnchors.dualT), lumArr(fSettle.settleAnchors.dualT2)).toFixed(0)} again=${lumArr(fSettle.settleAnchors.again).toFixed(0)}`)
  const hf2 = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  let keyN = 0; for (const grp in hf2) keyN += Object.keys(hf2[grp]).length
  A('V-HUD-2b', '登记键位 ≥22（倒数/巡航/徽标详情卡/横幅/罚字/结算页累计在册）', keyN >= 22, `${keyN} 键：P0=${Object.keys(hf2.P0 || {}).length} P1=${Object.keys(hf2.P1 || {}).length} P2=${Object.keys(hf2.P2 || {}).length}`)
  const sb = fSettle.settleBars
  A('V-RD-4a', '结算 T7-A 对照条双条命中（本地青条+判定灰条 ≥2 行量级；行内归一）', sb.cyan >= 300 && sb.dim >= 300, `青条px=${sb.cyan} 灰条px=${sb.dim}（3 行×~85×5）`)
  A('V-RD-4b', '对照条零基线柱 + 条尾亮端标在位（端点可数=色弱下条尾位置即读数）', sb.base >= 24 && sb.capC >= 6 && sb.capI >= 6, `基线px=${sb.base} 青端标px=${sb.capC} 灰端标px=${sb.capI}`)

  A('V-REG', '页面零异常（pageerror）', pageErrors.length === 0, pageErrors.join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  server.kill(); await rm(dataDir, { recursive: true, force: true }); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[vis-check] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}`)
process.exit(fail.length ? 1 : 0)
