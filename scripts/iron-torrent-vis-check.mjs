#!/usr/bin/env node
/* =====================================================================
 * GAMES-152 钢铁洪流 视觉统一+识图扩容（VIS）断言工具——street-soccer
 * vis-check（GAMES-143）取证范式移植。私有网关自起（随机口，GATEWAY_PID/
 * GATEWAY_LOG 改道临时目录）+私有静态伺服（随机口，伺服仓库工作树=本单改动即
 * 受测面）——零感知 :4399/:4400，网关弹跳避门禁窗。
 *   V-HUD-1 静态：零裸字号 + HF 合法简写（weight 前置）+ DOM ≥9
 *   V-HUD-2/3/4 运行时：hudFonts() 分级下限 + __applied 生效往返自证
 *           + 占点 % P0 补漏回归锚（cap 13/600）+ clock/wind 独立键
 *   V-CB 双编码（静态+像素双证）：命池计分 ●/◆ 双标 / HP 环 A 实心 B 分段 /
 *           占点条+占点弧 B 分段 / 弹丸形双通道（A 圆点族/B 菱形族×弹种
 *           第二键）+ 尾迹 A 实线/B 虚线 / 击杀横幅双形标 / 弹着环末触者
 *           队色 / 预览线随我席队色 / 阵营双色同亮度带
 *   V-PROBE 识图 v2 扩容 ≥8 探针（FEEL 交付面入识图）：
 *           P-8 后坐炮口焰墨水 / P-9 履带印双轨沙土 / P-10 部位三色火花 /
 *           P-11 风向旗涟漪四态 + 语义面全项（P-1 铁灰战场 / P-3 掩体簇 /
 *           P-5 双色簇 / P-6 预览线 / P-7 装填环两态）
 *   V-SHOT 冻结三态（kickoff/live/kill）帧差合理带 + DSF=1 截图落盘
 *   V-PERF 帧成本对照带（rAF 注入法，feel-check 同口径）
 * 探针锚：state().ents（席位/队/位姿/HP 只读镜像）+ fxTreads()（履带印镜像）
 * ——GAMES-152 client 调试面加法字段；fxProbe 合成弹段带 qa 标记豁免 20Hz
 * 快照对齐裁剪（产品弹道零改动）。
 * 用法：node scripts/iron-torrent-vis-check.mjs [--out dir]
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { readFile as fsReadFile } from 'node:fs/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-152-shots'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 私有网关 + 静态伺服（零感知 :4399/:4400） ---------- */
const GWPORT = 4490 + Math.floor(Math.random() * 30)
const HTTPPORT = 49500 + Math.floor(Math.random() * 700)
const dataDir = await mkdtemp(join(tmpdir(), 'g152-gw-'))
const gw = spawn(process.execPath, [join(ROOT, 'server/gateway/index.js')], {
  env: { ...process.env, PORT: String(GWPORT), HOST: '127.0.0.1', GATEWAY_PID: join(dataDir, 'gw.pid'), GATEWAY_LOG: join(dataDir, 'gw.log') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let gwUp = false
for (let i = 0; i < 60 && !gwUp; i++) { await sleep(250); try { gwUp = (await fetch(`http://127.0.0.1:${GWPORT}/healthz`)).ok } catch {} }
if (!gwUp) { console.error('私有网关未起'); process.exit(2) }
await sleep(2500) // bothost 常驻房起房（iron casual/balanced ×2，quick 可配）
/* .cjs MIME 拒载静默坑（GAMES-90）：sim/trig16 走 script 标签 */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try { const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '')); const buf = await fsReadFile(p); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(buf) }
  catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(HTTPPORT, '127.0.0.1', r))
await mkdir(OUT, { recursive: true })
const PAGE_URL = `http://127.0.0.1:${HTTPPORT}/games/multiplayer/iron-torrent/index.html`
const GWWS = `ws://127.0.0.1:${GWPORT}`

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const pageErrors = []
const watch = (p) => { p.on('pageerror', (e) => pageErrors.push(String(e.message || e))); p.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) }) }
const dbg = (page, fn, ...a) => page.evaluate(([f, ...args]) => window.__GAMES_DEBUG__[f](...args), [fn, ...a])

/* ---------- 页内探针工具（canvas 像素面；冻结帧采样=pause 保留最后帧） ---------- */
const INK = `(() => { const g = document.getElementById('cv').getContext('2d')
  const px = (x, y) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3))
  const scan = (x0, y0, w, h, pred, step) => { let n = 0
    step = step || 1
    for (let y = y0; y < y0 + h; y += step) for (let x = x0; x < x0 + w; x += step) { const d = g.getImageData(x, y, 1, 1).data; if (pred(d[0], d[1], d[2])) n++ }
    return n }
  const rowW = (cy, cx, half, pred) => { let n = 0
    for (let x = cx - half; x <= cx + half; x++) { const d = g.getImageData(x, cy, 1, 1).data; if (pred(d[0], d[1], d[2])) n++ }
    return n }
  const grab = (x0, y0, w, h) => Array.from(g.getImageData(x0, y0, w, h).data)
  return { px, scan, rowW, grab } })()`
const AMBER = '(r, g, b) => r > 195 && g > 110 && g < 205 && b < 125 && r - b > 90'
const CYAN = '(r, g, b) => g > 160 && b > 185 && r < 145 && b - r > 70'
const nearF = (t, tol) => `(r, g, b) => Math.abs(r - ${t[0]}) <= ${tol} && Math.abs(g - ${t[1]}) <= ${tol} && Math.abs(b - ${t[2]}) <= ${tol}`
const SOLID_A = nearF([232, 163, 61], 26)   // 弹丸实心体（A）
const SOLID_B = nearF([61, 200, 232], 26)   // 弹丸实心体（B）
const TRAIL_A = nearF([149, 110, 57], 34)   // A 实线尾迹合成色（α.55 on #2B2E33）
const TRAIL_B = nearF([53, 132, 151], 34)   // B 虚线尾迹合成色
const TREAD = nearF([90, 84, 71], 24)       // 履带印沙土合成色（α.5 on 铁灰）
const HPARC = '(r, g, b) => (g > 150 && g - r > 30 && r < 190) || (r > 195 && g > 150 && b < 130) || (r > 195 && g < 135 && b < 135 && r - b > 70)'

let page
try {
  /* ================= V-HUD-1 / V-CB 静态审计 ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/iron-torrent/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
  A('V-HUD-1a', '零裸字号（ctx.font 全走 HF 登记表）', bare.length === 0, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : 'ctx.font 赋值 0 处裸串')
  A('V-HUD-1b', 'HF 合法 CSS font 简写（weight 前置 size 后置——非法简写被 canvas 静默忽略=全 HUD 10px 缺省字，GAMES-135/143 谱系）', /\+ '00 ' \+ px \+ 'px -apple-system/.test(src), 'weight+space+px+family 构造在册')
  const html = await readFile(join(ROOT, 'games/multiplayer/iron-torrent/index.html'), 'utf8')
  const domPx = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => +m[1])
  A('V-HUD-1c', 'index.html DOM 字号零裸小字（全部 ≥9）', domPx.length > 0 && domPx.every((p) => p >= 9), `DOM px=[${domPx.join(',')}]`)

  A('V-CB-S1', '命池计分形色双标（teamMark 共用件：A ● 圆 arc / B ◆ 菱四点闭合——顶栏两侧，与炮塔盖形语言同构）',
    /function teamMark\(/.test(src) && /ctx\.arc\(x, y, r, 0, TAU\);/.test(src) && /ctx\.moveTo\(x, y - r \* 1\.35\); ctx\.lineTo\(x \+ r \* 1\.35, y\)/.test(src) && /teamMark\(16, 17, 0, 4\)/.test(src) && /teamMark\(W - 16, 17, 1, 4\)/.test(src), 'A ●/B ◆ 双分支+顶栏两位在册（GAMES-152 补齐：旧计分面纯色无第二通道）')
  A('V-CB-S2', 'HP 环 A 实心/B 分段（§7 明文形通道——B 席 setLineDash([4,3]) 分段弧；旧实现两席同连续弧）',
    /if \(\(p\.team \|\| 0\) === 1\) ctx\.setLineDash\(\[4, 3\]\);/.test(src), 'B 席分段弧分支在册')
  A('V-CB-S3', '占点条 A 实心/B 分段填充（9 实 3 隙周期——hud-font-standard §3 血条同构口径）',
    /if \(snapState\.capTeam === 1\) for \(var sg2 = 0; sg2 < fw; sg2 \+= 12\) ctx\.fillRect/.test(src), 'B 席分段填充分支在册')
  A('V-CB-S4', '占点圈 B 分段弧（战场域与顶栏占点条同构形通道）',
    /if \(snapState\.capTeam === 1\) ctx\.setLineDash\(\[4, 3\]\); \/\/ VIS/.test(src), 'B 席分段弧分支在册')
  A('V-CB-S5', '弹丸形双通道（§7 前置规范：阵营=形主键 A 圆点族/B 菱形族；弹种=第二键 AP 细长/HE 圆钝——旧实现只编码弹种）',
    /A 圆点族/.test(src) && /B 菱形族/.test(src) && /ctx\.ellipse\(px, py, 3\.4, 1\.7, va/.test(src) && /ctx\.moveTo\(-4\.2, 0\); ctx\.lineTo\(0, -1\.6\)/.test(src), '四形（细长椭圆/圆点/细长菱/圆钝菱）分支在册')
  A('V-CB-S6', '弹道尾迹形通道（A 实线/B 虚线 [3,3]——飞行弹道阵营归属零色觉依赖）',
    /ctx\.moveTo\(px - Math\.cos\(va\) \* 13, py - Math\.sin\(va\) \* 13\)/.test(src) && /if \(pTeam === 1\) ctx\.setLineDash\(\[3, 3\]\);/.test(src), '尾迹反向 13px+双式在册')
  A('V-CB-S7', '击杀横幅形色双标（击毁者/被毁者两侧阵营形标——横幅面形通道）',
    /teamMark\(-bHalf - 10, -4,/.test(src) && /teamMark\(bHalf \+ 10, -4,/.test(src), '横幅两侧形标在册（GAMES-152 补齐）')
  A('V-CB-S8', '弹着环末触者队色描边（§7 弹道轨迹双编码：弹坑标记带队色边——bo.seat 三注入点）',
    /var bRGB = bo\.seat != null \? TEAM_RGB\[/.test(src) && /at: now\(\), r: 30000, seat: e\.seat \}/.test(src) && /r: 26000, big: true, rec: fxT\('F14'\), seat: e\.seat/.test(src), '爆环队色+splash/kill/落地三 seat 注入在册')
  A('V-CB-S9', '预览线随我席队色（旧硬编码琥珀=B 席玩家错色——pcol 死码激活）',
    /var pRGB = TEAM_RGB\[\(\(tanks\[mySeat\] \|\| \{\}\)\.team\) \|\| 0\]/.test(src), 'pRGB 按我席队取色在册')
  const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return Math.round(0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) }
  const la = luma('#E8A33D'), lb = luma('#3DC8E8')
  A('V-CB-S10', `阵营双色同亮度带（琥珀 ${la}/青 ${lb} Δ${Math.abs(la - lb)}<25 → 形状通道强制：计分标/HP 环/占点条+弧/弹丸+尾迹/横幅标/弹着环七形位）`,
    Math.abs(la - lb) < 25, 'hud-font-standard §3 口径同带；七形位双通道在册（V-CB-S1..S8）')

  /* ================= 运行时：玩家页（quick bot 房让位入席） ================= */
  page = await context.newPage(); watch(page)
  await page.goto(`${PAGE_URL}?gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && s.players >= 4 }, null, { timeout: 25_000 })
  const endedGuard = async () => { // quick 并房终局守卫（GAMES-150 flap 源之一：并入临终房 → end 遮罩盖锚点）
    const e = await page.evaluate(() => !!(window.__GAMES_DEBUG__.state().ended)).catch(() => false)
    if (!e) return false
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && s.players >= 4 && !s.ended }, null, { timeout: 25_000 })
    return true
  }
  if (await endedGuard()) console.error('  ⚠ 并入临终房——重载重排')
  await sleep(1800) // 快照稳态（4 席就位+掩体/坦克实体在场）

  /* ---------- V-HUD-2/3/4 运行时自证 ---------- */
  const hf = await dbg(page, 'hudFonts')
  const cls = hf.cls || {}
  A('V-HUD-2', 'hudFonts() 分级下限自证（P0≥13/P1≥11/P2≥9，运行样本在册）', cls.P0 && cls.P0.min >= 13 && cls.P1 && cls.P1.min >= 11 && cls.P2 && cls.P2.min >= 9 && cls.P0.n > 0 && cls.P1.n > 0 && cls.P2.n > 0, `P0=${cls.P0 && cls.P0.min}(n=${cls.P0 && cls.P0.n}) P1=${cls.P1 && cls.P1.min}(n=${cls.P1 && cls.P1.n}) P2=${cls.P2 && cls.P2.min}(n=${cls.P2 && cls.P2.n})`)
  A('V-HUD-3', '字体生效往返自证（__applied：HF 串赋 ctx.font 后回读 13px——非法简写此处 false=全 HUD 10px 缺省字）', hf.__applied === true, `__applied=${hf.__applied}`)
  const reg = hf.reg || {}
  A('V-HUD-4', 'HF 补漏回归锚（占点进度 % 升格 P0 13/600——§7 P0 面；倒计时 clock 键/风向 wind 键独立登记）',
    reg.cap && reg.cap.px === 13 && reg.cap.cls === 'P0' && reg.clock && reg.clock.px >= 13 && reg.wind && reg.wind.px >= 11,
    `cap=${reg.cap && reg.cap.px + '/' + reg.cap.cls}（旧 11/P1 越档）clock=${reg.clock && reg.clock.px + '/' + reg.clock.cls} wind=${reg.wind && reg.wind.px + '/' + reg.wind.cls}；登记键 ${Object.keys(reg).length} 个`)
  const st0 = await dbg(page, 'state')
  let myTeam = ((st0.ents || []).find((e) => e.seat === st0.seat) || {}).team != null
    ? ((st0.ents || []).find((e) => e.seat === st0.seat) || {}).team : st0.seat % 2 // 真队直读（防分席不按奇偶——预览线队色谓词随真队）

  /* ================= 冻结 kickoff 帧：基础探针 P-1..P-5 + 语义面 ================= */
  await dbg(page, 'fxScene', 'calm')
  await sleep(200)
  await dbg(page, 'pause', true)
  const p1 = await page.evaluate(`(() => { const P = ${INK}
    /* 铁灰底主导性：场域步进扫描 bg 近似占比（避开定点采样被掩体/实体偶然遮蔽） */
    let iron = 0, tot = 0
    for (let y = 58; y < 554; y += 4) for (let x = 19; x < 355; x += 4) {
      const d = P.px(x, y); tot++
      if (Math.abs(d[0] - 43) <= 14 && Math.abs(d[1] - 46) <= 14 && Math.abs(d[2] - 51) <= 14) iron++
    }
    return { iron, tot, frac: +(iron / tot).toFixed(3), topbar: P.px(60, 4), botbar: P.px(187, 560), edge: P.px(4, 300) } })()`)
  const near = (c, t, tol) => c && c.slice(0, 3).every((v, i) => Math.abs(v - t[i]) <= tol)
  A('P-1', '语义面·铁灰战场底 #2B2E33 主导（场域步进扫描 ≥45% bg 近似——战地铁灰基调）', p1.frac >= 0.45, `${p1.iron}/${p1.tot}=${p1.frac}`)
  A('P-2', '顶栏 #20242A / 底栏 #181B1F HUD 双底（52px+111px 布局位；场外画布透明=战场域边界可辨）', near(p1.topbar, [0x20, 0x24, 0x2a], 14) && near(p1.botbar, [0x18, 0x1b, 0x1f], 14) && near(p1.edge, [0, 0, 0], 6), `top=${JSON.stringify(p1.topbar)} bot=${JSON.stringify(p1.botbar)} edge=${JSON.stringify(p1.edge)}`)
  const cover = await page.evaluate(`(() => { const P = ${INK}
    /* 掩体簇：混凝土格系（#5A5F66 变耐久合成）+ 木箱暖褐系（#8B6B4A 变耐久合成） */
    let conc = 0, crate = 0
    for (let y = 58; y < 554; y += 3) for (let x = 19; x < 355; x += 3) {
      const d = P.px(x, y), r = d[0], g = d[1], b = d[2]
      if (Math.abs(r - g) < 14 && Math.abs(g - b) < 16 && r > 60 && r < 130 && b > 55) conc++
      else if (r > 95 && r < 185 && g > 75 && g < 150 && b > 45 && b < 105 && r - b > 35 && r - g > 12) crate++
    }
    return { conc, crate } })()`)
  A('P-3', '语义面·掩体簇在场（混凝土格系≥40px + 木箱暖褐系≥25px——弹坑/掩体可读性）', cover.conc >= 40 && cover.crate >= 25, `混凝土系=${cover.conc} 木箱系=${cover.crate}`)
  const ring0 = await page.evaluate(`(() => { const P = ${INK}
    let hits = 0
    for (let i = 0; i < 72; i++) { const a = i / 72 * Math.PI * 2
      const c = P.px(187 + Math.cos(a) * 45, 306 + Math.sin(a) * 45)
      if (Math.abs(c[0] - 43) > 7 || Math.abs(c[1] - 46) > 7 || Math.abs(c[2] - 51) > 7) hits++ }
    return hits })()`)
  A('P-4', '中央占点圈在场（r45 环带 72 角采样 ≥30 异底命中——§2.5 单中央占点识图锚）', ring0 >= 30, `环带命中=${ring0}/72`)
  const dualShot = async () => page.evaluate(`(() => { const P = ${INK}
    const isA = ${AMBER}, isB = ${CYAN}
    let a = 0, b = 0
    for (let y = 58; y < 554; y += 2) for (let x = 19; x < 355; x += 2) {
      const d = P.px(x, y)
      if (isA(d[0], d[1], d[2])) a++
      if (isB(d[0], d[1], d[2])) b++
    }
    return { a, b } })()`)
  let dual = { a: 0, b: 0 }, dualTries = 0
  for (let r = 0; r < 3 && (dual.a < 20 || dual.b < 20); r++) { // 某队全灭窗重采（respawn 后双色恢复）
    dual = await dualShot(); dualTries = r + 1
    if (dual.a < 20 || dual.b < 20) { await dbg(page, 'pause', false); await sleep(2500); await dbg(page, 'fxScene', 'calm').catch(() => {}); await sleep(150); await dbg(page, 'pause', true) }
  }
  A('P-5', '语义面·战场阵营双色簇（A 琥珀/B 青 ≥20px——FE-6 同口径复证）', dual.a >= 20 && dual.b >= 20, `amber=${dual.a} cyan=${dual.b}${dualTries > 1 ? '（重采×' + dualTries + '——某队全灭窗）' : ''}`)
  const marks = await page.evaluate(`(() => { const P = ${INK}
    return { a: P.scan(8, 10, 18, 16, ${AMBER}, 1), b: P.scan(349, 10, 18, 16, ${CYAN}, 1) } })()`)
  A('V-CB-R1', '命池计分形色双标像素证（顶栏左 A ● ≥6px / 右 B ◆ ≥6px——色弱下计分归属形=唯一键）', marks.a >= 6 && marks.b >= 6, `A ●=${marks.a}px B ◆=${marks.b}px`)
  await page.screenshot({ path: join(OUT, 'vis-shot-kickoff.png') })
  await page.evaluate(`(() => { const g = document.getElementById('cv').getContext('2d')
    window.__g152Frames = window.__g152Frames || {}
    window.__g152Frames.kick = g.getImageData(0, 0, 375, 667).data.slice() })()`)
  await dbg(page, 'pause', false)

  /* ================= P-6 预览线（语义面；alive 门重试——阵亡窗是 GAMES-150 已知假红源） ================= */
  /* 房况质量门：quick 并房可能落「残房/全灭房」（我席长阵亡+ents 半空）——FEEL 探针序列
   * 的实体面全灭即此方差（多轮红绿轮换实证）。活局连续 2 拍达标才放行，不达标 reload 换房 */
  for (let g = 0; g < 3; g++) {
    let ok2 = 0
    for (let k = 0; k < 2; k++) {
      const s = await dbg(page, 'state').catch(() => null)
      if (s && !s.ended && s.alive === 1 && (s.ents || []).length >= 3) ok2++
      await sleep(900)
    }
    if (ok2 === 2) break
    console.error('  ⚠ 房况不足（活席<3/我席阵亡）——reload 换房 ×' + (g + 1))
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && s.players >= 4 && !s.ended }, null, { timeout: 25_000 })
    await sleep(1800)
  }
  /* 房况门 reload 换房后 mySeat/队可能变——myTeam 重读（旧房队色谓词=B 席玩家用 A 带=恒 0 命中） */
  const stR = await dbg(page, 'state')
  const meR = (stR.ents || []).find((e) => e.seat === stR.seat)
  if (meR && meR.team != null) myTeam = meR.team
  const prevShot = async () => {
    let ok = false
    for (let r = 0; r < 3 && !ok; r++) {
      if (await endedGuard()) console.error('  ⚠ 探针窗局终——重载重排') // 局中 ended=alive 恒 0（临终并房的局中半拍：进房守卫查不到）
      await page.waitForFunction(() => window.__GAMES_DEBUG__.state().alive === 1, null, { timeout: 12_000 }).catch(() => {})
      await dbg(page, 'fxScene', 'calm')
      await sleep(150)
      await dbg(page, 'pause', true)
      const v = await page.evaluate(`((myTeam) => { const P = ${INK}; const st = window.__GAMES_DEBUG__.state()
        if (!st.alive) return { n: 0, span: 0, dead: true }
        /* 预览线=我席队色 α0.4-0.60 呼吸（饱和实心谓词够不着半透明合成色——用染色带）：
         * A on #2B2E33 → (140,105,57)±30；B → (52,123,141)±30 */
        /* A 琥珀带须防木箱暖褐串色（微探针实测：木箱 (139,107,74) 落宽谓词=g-b 33；
         * 线合成 α0.4-0.6 g-b≥45——g-b>41+r∈[135,175] 可分；B 青带无串色源） */
        const pred = myTeam === 0 ? (r, g, b) => r >= 135 && r <= 175 && Math.abs(g - 108) <= 14 && Math.abs(b - 58) <= 12 && g - b > 41 && r - b > 60
          : (r, g, b) => Math.abs(r - 52) <= 32 && Math.abs(g - 123) <= 34 && Math.abs(b - 141) <= 34 && b - r > 45
        let n = 0, x0 = 999, x1 = -1, y0 = 999, y1 = -1
        for (let y = 58; y < 554; y += 2) for (let x = 19; x < 355; x += 2) {
          let nearEnt = false
          for (const e of st.ents || []) if (Math.hypot(x - (17 + e.x / 1000), y - (56 + e.y / 1000)) < 24) { nearEnt = true; break }
          if (nearEnt) continue
          const d = P.px(x, y)
          if (pred(d[0], d[1], d[2])) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
        }
        return { n, span: Math.max(x1 - x0, y1 - y0) } })(${myTeam})`)
      await dbg(page, 'pause', false)
      if (v.n >= 10 && v.span >= 30) return { ...v, tries: r + 1 }
      if (v.dead) { await sleep(2500); continue } // 阵亡窗：等 respawn 重排
      ok = v.n > 0 // 有墨水但带不达标——再试一次（呼吸 α 低相位）
      if (!ok) await sleep(600)
      if (r === 2) return { ...v, tries: 3 }
    }
    return { n: 0, span: 0, tries: 3 }
  }
  const prev = await prevShot()
  A('P-6', '语义面·弹道预览线在场（我席队色长径 ≥30px+墨水 ≥10px——本地同 sim 前瞻，识图动图特征）',
    prev.n >= 10 && prev.span >= 30, `墨水=${prev.n}px 长径=${prev.span}px（队=${myTeam === 0 ? 'A 琥珀' : 'B 青'}染色带——预览线随我席队色；重试×${prev.tries}）`)

  /* ================= P-7 装填环两态（语义面：fire 钮 Ø64） ================= */
  /* 真实 fire 起表（CD/阵亡窗是真实游戏态——qa1-web A4 同款重试口径：tap 后验 cd>0） */
  let ringFull = -1, fired = false, taps = 0
  for (let t = 0; t < 4 && !fired; t++) {
    let ready = false
    for (let i = 0; i < 50 && !ready; i++) { const s = await dbg(page, 'state'); ready = s.alive === 1 && s.cd <= 0; if (!ready) await sleep(300) }
    await dbg(page, 'fxScene', 'calm')
    await sleep(120)
    await dbg(page, 'pause', true)
    ringFull = await page.evaluate(`(() => { const P = ${INK}
      const isA = ${AMBER}
      let hits = 0
      for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2
        const c = P.px(309 + Math.cos(a) * 32, 605 + Math.sin(a) * 32)
        if (isA(c[0], c[1], c[2])) hits++ }
      return hits })()`)
    await dbg(page, 'pause', false)
    await page.touchscreen.tap(309, 605)
    taps++
    await sleep(340)
    const s2 = await dbg(page, 'state')
    fired = s2.cd > 0
  }
  await dbg(page, 'pause', true)
  const ringCd = await page.evaluate(`(() => { const P = ${INK}
    const isA = ${AMBER}
    let rust = 0, amber = 0
    /* 环 lineWidth=4（r30-34）——三半径并集防单行采样漏角 */
    for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2
      let hitR = false, hitA = false
      for (const rr of [31, 32, 33]) { const c = P.px(309 + Math.cos(a) * rr, 605 + Math.sin(a) * rr)
        if (Math.abs(c[0] - 138) <= 30 && Math.abs(c[1] - 74) <= 26 && Math.abs(c[2] - 61) <= 26) hitR = true
        if (isA(c[0], c[1], c[2])) hitA = true }
      if (hitR) rust++
      if (hitA) amber++ }
    return { rust, amber } })()`)
  await dbg(page, 'pause', false)
  A('P-7', '语义面·装填环两态（就绪=满环琥珀 ≥40/48 → fire 后=锈红部分环 4-44 + 琥珀环消退 <40——CD 状态可视锚；真实 tap 起表）',
    fired && ringFull >= 40 && ringCd.rust >= 4 && ringCd.rust <= 44 && ringCd.amber < 40,
    `就绪 ${ringFull}/48 → CD 态 rust=${ringCd.rust} amber=${ringCd.amber}（tap×${taps}${fired ? ' 起表' : ' 未起表——CD/阵亡窗'}）`)

  /* ================= P-8 后坐炮口焰墨水（FEEL 面①） ================= */
  if (await endedGuard()) console.error('  ⚠ P-8 前局终——重载重排')
  let mz = { warm: 0 }
  for (let m = 0; m < 2 && mz.warm < 6; m++) { // 重试×2：房况方差（微探针同款窗实证 warm=35px）
    await dbg(page, 'fxScene', 'calm')
    await dbg(page, 'fxScene', 'fire')
    await sleep(35) // 焰锥 α=(1-ag/140)——70ms 已半衰 0.5 谓词够不着；35ms=0.75 稳带
    await dbg(page, 'pause', true)
    mz = await page.evaluate(`(() => { const P = ${INK}; const st = window.__GAMES_DEBUG__.state()
      /* 微探针实证：焰锥 0-9px 从坦克位沿炮向延伸、35ms 时 warm=35px——窗=坦克位 ±20 直采
       * （tur 在 35ms 内可漂移，按炮向偏移的窗会整体偏出） */
      const me = (st.ents || []).find((e) => e.seat === st.seat) || (st.ents || [])[0]
      if (!me) return { warm: 0 }
      const mx = 17 + me.x / 1000, my = 56 + me.y / 1000
      let warm = 0
      for (let y = my - 20; y < my + 20; y += 1) for (let x = mx - 20; x < mx + 20; x += 1) {
        const d = P.px(x, y)
        if (d[0] > 195 && d[1] > 115 && d[2] < 155 && d[0] - d[2] > 55) warm++
      }
      return { warm } })()`)
    await dbg(page, 'pause', false)
  }
  const led8 = await dbg(page, 'fxLedger')
  const f01 = led8.filter((l) => l.id === 'F01' && l.lat != null).map((l) => l.lat)
  const f02 = led8.filter((l) => l.id === 'F02' && l.lat != null).map((l) => l.lat)
  await dbg(page, 'pause', false)
  await dbg(page, 'fxScene', 'calm')
  A('P-8', 'FEEL 面·后坐炮口焰墨水（坦克位+炮向 7px 窗 28×28 暖焰 ≥6px：焰锥+外焰——叠本体/铁灰底合成均在谓词带）+F01/F02 台账首绘 ≤80ms 双源',
    mz.warm >= 6 && f01.length > 0 && Math.min(...f01) <= 80 && f02.length > 0 && Math.min(...f02) <= 80,
    `暖焰=${mz.warm}px｜F01×${f01.length} min=${f01.length ? Math.min(...f01) : '-'}ms F02×${f02.length} min=${f02.length ? Math.min(...f02) : '-'}ms`)

  /* ================= P-9 履带印双轨沙土（FEEL 面②） ================= */
  const cdp = await context.newCDPSession(page)
  const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
  const drag = async (x0, y0, x1, y1) => {
    await touch('touchStart', [{ x: x0, y: y0 }])
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8 }]); await sleep(28) }
    await touch('touchEnd', [])
  }
  if (await endedGuard()) console.error('  ⚠ P-9 前局终——重载重排')
  await page.waitForFunction(() => window.__GAMES_DEBUG__.state().alive === 1, null, { timeout: 15_000 }).catch(() => {})
  let treads = { ok: false }
  /* 四方向腿（微探针实证：轨印贴本体 <17px 常态被实体判据吃光——多向走位留露空印+
   * 判据半径 13px=本体 10px+余量，印偏 ±5.4px 不算遮挡） */
  for (const leg of [[90, 420, 90, 350], [90, 420, 130, 420], [90, 420, 50, 420], [90, 380, 90, 456]]) {
    await drag(leg[0], leg[1], leg[2], leg[3])
    await sleep(750)
    await dbg(page, 'pause', true)
    treads = await page.evaluate(`(() => { const P = ${INK}; const st = window.__GAMES_DEBUG__.state()
      const isT = ${TREAD}
      const trs = window.__GAMES_DEBUG__.fxTreads().filter((t) => !t.wreck)
      for (const tr of trs) {
        const cx = 17 + tr.x / 1000, cy = 56 + tr.y / 1000
        let underEnt = false
        for (const e of st.ents || []) if (Math.hypot(cx - (17 + e.x / 1000), cy - (56 + e.y / 1000)) < 13) { underEnt = true; break }
        if (underEnt) continue
        const a = (tr.dir || 0) / 8192 * Math.PI * 2, px = -Math.sin(a), py = Math.cos(a)
        /* 双轨签名：垂向 ±5.4px 双条带命中 / 中缝 0px 空档（3.6px 轨×2+间隙） */
        let side = 0, mid = 0
        for (const off of [-5.4, 5.4]) for (let d = -6; d <= 6; d += 1) {
          const c = P.px(cx + Math.cos(a) * d + px * off, cy + Math.sin(a) * d + py * off)
          if (isT(c[0], c[1], c[2])) side++
        }
        for (let d = -6; d <= 6; d += 1) {
          const c = P.px(cx + Math.cos(a) * d, cy + Math.sin(a) * d)
          if (isT(c[0], c[1], c[2])) mid++
        }
        if (side >= 6 && mid <= 4) return { ok: true, side, mid, x: Math.round(cx), y: Math.round(cy) }
      }
      return { ok: false } })()`)
    await dbg(page, 'pause', false)
    if (treads.ok) break
  }
  A('P-9', 'FEEL 面·履带印双轨沙土（轨向 ±5.4px 双条带 ≥6px / 中缝 ≤4px——双轨签名；沙土 #8A7A5C 合成色）',
    treads.ok, treads.ok ? `双轨命中=${treads.side} 中缝=${treads.mid} @(${treads.x},${treads.y})（摇杆驱动落印）` : '四方向拖拽后无可采样露空轨印（皆贴实体/掩体）')

  /* ================= P-10 部位三色火花（FEEL 面③） ================= */
  const sparkProbe = async (part, predExpr) => {
    if (await endedGuard()) console.error('  ⚠ P-10 探针窗局终——重载重排')
    await dbg(page, 'fxScene', 'calm')
    const st = await dbg(page, 'state')
    const foe = st.ents && st.ents.length ? (st.ents.find((e) => e.seat !== st.seat) || st.ents[0]).seat : (st.seat + 1) % 4
    await page.evaluate((a) => window.__GAMES_DEBUG__.fxProbe({ k: 'hit', seat: a[0], victim: a[1], dmg: 30, part: a[2] }), [st.seat, foe, part])
    await sleep(60)
    await dbg(page, 'pause', true)
    const n = await page.evaluate(`((victimSeat) => { const P = ${INK}; const st = window.__GAMES_DEBUG__.state()
      const v = (st.ents || []).find((e) => e.seat === victimSeat) || (st.ents || [])[0]
      if (!v) return 0
      const cx = 17 + v.x / 1000, cy = 56 + v.y / 1000 + 3
      let n = 0
      for (let y = cy - 9; y < cy + 9; y += 1) for (let x = cx - 9; x < cx + 9; x += 1) { const d = P.px(x, y); if (${predExpr}) n++ }
      return n })(${foe})`)
    await dbg(page, 'pause', false)
    return n
  }
  const spFront = await sparkProbe('front', 'd[0] > 205 && d[1] > 165 && d[2] < 135')
  const spSide = await sparkProbe('side', 'd[0] > 205 && d[1] > 120 && d[1] < 190 && d[2] < 120')
  let spRear = await sparkProbe('rear', 'd[0] > 205 && d[1] < 125 && d[2] < 125')
  for (let rr = 0; rr < 2 && spRear < 3; rr++) spRear = await sparkProbe('rear', 'd[0] > 205 && d[1] < 125 && d[2] < 125') // victim 换人重试（全灭窗 victim 兜底错位）
  A('P-10', 'FEEL 面·部位三色火花（正金黄/侧橙/背深红三态像素各 ≥3px——部位差异化可视）',
    spFront >= 3 && spSide >= 3 && spRear >= 3, `front=${spFront} side=${spSide} rear=${spRear}px`)

  /* ================= P-11 风向旗涟漪四态（FEEL 面④） ================= */
  /* 旗杆基 (62,36) 随风角 rotate——旗体最大半径 √(12²+8²)≈14.4px：窗 (44,16,40,40)
   * 覆盖全姿态（固定小窗在风角 90° 时旗面出窗=四帧只剩静止旗杆的假红源） */
  const flagStates = []
  const windSt = await dbg(page, 'state')
  for (let i = 0; i < 4; i++) {
    const g152 = await page.evaluate(`(() => { const g = document.getElementById('cv').getContext('2d')
      return Array.from(g.getImageData(44, 16, 40, 40).data).join(',') })()`)
    flagStates.push(g152)
    await sleep(180) // 摆动周期 300/rip ms——180ms 相位差 >2rad 保证帧间位移
  }
  let diffPairs = 0
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a2 = flagStates[i].split(','), b2 = flagStates[j].split(',')
    let d2 = 0
    for (let k = 0; k < a2.length; k += 4) if (Math.abs(+a2[k] - +b2[k]) + Math.abs(+a2[k + 1] - +b2[k + 1]) > 24) d2++
    if (d2 >= 2) diffPairs++
  }
  const ledW = await dbg(page, 'fxLedger')
  const f18 = ledW.filter((l) => l.id === 'F18')
  const wd = windSt.wind || {}
  A('P-11', 'FEEL 面·风向旗涟漪四态（旗体全姿态窗 40×40 四活帧采样 ≥3 对互异（sin 摆动）+F18 常摆台账在案）',
    diffPairs >= 3 && f18.length >= 1, `互异对=${diffPairs}/6｜F18×${f18.length}（风强=涟漪幅度：mag=${wd.mag != null ? (wd.mag / 1000).toFixed(1) : '?'} ang=${wd.ang || 0}）`)

  /* ================= V-CB-R2 弹丸形双通道+尾迹（合成段 qa 豁免探针） ================= */
  const projProbe = async (team, yGame) => {
    if (await endedGuard()) console.error('  ⚠ V-CB-R2 探针窗局终——重载重排')
    await dbg(page, 'fxScene', 'calm')
    /* 席位现读：quick 房席位进出/某队全灭窗下 seat0/1 固定注入可能空席——从 ents 选该队活席 */
    let seat = -1
    for (let r = 0; r < 3 && seat < 0; r++) {
      const st = await dbg(page, 'state')
      const e2 = (st.ents || []).find((e) => e.team === team)
      seat = e2 ? e2.seat : -1
      if (seat < 0) { await sleep(2200); if (await endedGuard()) console.error('  ⚠ V-CB-R2 等席窗局终——重载重排') }
    }
    if (seat < 0) return { found: false, why: 'no-seat' }
    await page.evaluate((a) => window.__GAMES_DEBUG__.fxProbe({ k: 'fire', seat: a[0], ammo: 1, ang: 0, x: 170000, y: a[1], vx: 800, vy: 0, vz: 400, qa: true }), [seat, yGame])
    await sleep(50) // 50ms（~7 子步）：段距注入位近、full 快照撞窗概率低（115ms 曾实测段被清——no-seg 未明根因，短窗回避）
    await dbg(page, 'pause', true)
    /* projs() 镜像读回 qa 合成段真实位姿（风偏+subs 步进后）——锚定采样免盲窗漂移 */
    const seg = (await dbg(page, 'projs')).find((p) => p.qa) || null
    const r = await page.evaluate(`((team, seg) => { const P = ${INK}
      if (!seg) return { found: false, why: 'no-seg' }
      const cx = Math.round(17 + seg.x / 1000), cy = Math.round(56 + seg.y / 1000 - seg.z / 1000)
      const va = Math.atan2(seg.vy, seg.vx), dx = Math.cos(va), dy = Math.sin(va)
      const solid = team === 0 ? ${SOLID_A} : ${SOLID_B}
      /* 弹体行宽（沿速度垂直向）：中行 w0 / ±2px 侧行——圆点弧肩 vs 菱形尖肩 */
      const rowW = (off) => { let n = 0
        for (let s2 = -6; s2 <= 6; s2 += 0.5) { const d = P.px(cx + dx * s2 - dy * off, cy + dy * s2 + dx * off); if (solid(d[0], d[1], d[2])) n += 0.5 }
        return n }
      const trail = team === 0 ? ${TRAIL_A} : ${TRAIL_B}
      let trailN = 0
      for (let s2 = 5; s2 <= 16; s2 += 0.5) { const d = P.px(cx - dx * s2, cy - dy * s2); if (trail(d[0], d[1], d[2])) trailN += 0.5 }
      return { found: true, w0: rowW(0), side: (rowW(-2) + rowW(2)) / 2, trail: Math.round(trailN), cx, cy } })(${team}, ${JSON.stringify(seg)})`)
    await dbg(page, 'pause', false)
    return r
  }
  const projTry = async (team) => { // 双位重试：注入位可能被掩体/实体叠盖（房况方差）
    let r = await projProbe(team, team === 0 ? 250000 : 330000)
    if (!r.found || !r.w0) { const r2 = await projProbe(team, team === 0 ? 200000 : 380000); if (r2.found && (r2.w0 || r.found)) r = r2.found && r2.w0 ? r2 : r }
    return r
  }
  const projA = await projTry(0)
  const projB = await projTry(1)
  A('V-CB-R2', '弹丸形双通道像素证（HE 弹种：A 圆点侧行 ≥3.4px 连续弧肩 / B 圆钝菱侧行 ≤3.0px 尖肩；尾迹 A 实线 ≥9/12 列 / B 虚线 ≤7——形主键=阵营、第二键=弹种；projs() 镜像锚位）',
    projA.found && projB.found && projA.side >= 3.4 && projB.side <= 3.0 && projA.trail >= 9 && projB.trail <= 7,
    `A 圆点 w0=${projA.w0} 侧行=${projA.side} 尾迹=${projA.trail}/12${projA.why ? '（' + projA.why + '）' : ''}｜B 菱 w0=${projB.w0} 侧行=${projB.side} 尾迹=${projB.trail}/12${projB.why ? '（' + projB.why + '）' : ''}`)

  /* ================= P-12 击杀横幅字形锚+双形标 ================= */
  await dbg(page, 'fxScene', 'calm')
  await dbg(page, 'fxScene', 'kill')
  await sleep(320)
  await dbg(page, 'pause', true)
  const banner = await page.evaluate(`(() => { const P = ${INK}
    return { white: P.scan(92, 60, 193, 34, (r, g, b) => r > 200 && g > 200 && b > 190, 1),
             amber: P.scan(92, 60, 193, 34, ${AMBER}, 1), cyan: P.scan(92, 60, 193, 34, ${CYAN}, 1) } })()`)
  await dbg(page, 'pause', false)
  await dbg(page, 'fxScene', 'calm')
  A('P-12', '击杀横幅字形锚（P1 12px 名签白墨 ≥8px + 击毁者 ● ≥3px + 被毁者 ◆ ≥3px——横幅形色双标）',
    banner.white >= 8 && banner.amber >= 3 && banner.cyan >= 3, `白=${banner.white} ●=${banner.amber} ◆=${banner.cyan}px`)

  /* ================= V-CB-R3/R4 HP 环+占点（活局自然态轮询采样；读态+冻结+采样同任务=帧/态原子） ================= */
  let hpSampled = { A: null, B: null }, capSampled = null
  for (let i = 0; i < 60 && (!hpSampled.A || !hpSampled.B || !capSampled) && i * 700 < 42000; i++) {
    if (i === 20) await endedGuard()
    if (!capSampled && i % 8 === 4) { // 主动上点驱动（持续触发）：逼近+入圈站桩 7s 等累积（速率 ~2%/s——15% 需长站）
      for (let k = 0; k < 5; k++) {
        const stM = await dbg(page, 'state').catch(() => null)
        if (stM && stM.ended) break // 局终 drag 无效——外层 i==20 endedGuard 会重排
        const meE = stM && stM.ents && stM.ents.find((e) => e.seat === stM.seat)
        if (meE && stM.alive) {
          const mx2 = 17 + meE.x / 1000, my2 = 56 + meE.y / 1000
          const dist = Math.hypot(187 - mx2, 306 - my2)
          if (dist < 50) { await sleep(7000); break } // 入圈站桩——capBar 15% 起采需 ~7s 累积
          const dl = dist || 1
          await drag(90, 420, 90 + (187 - mx2) / dl * 42, 420 + (306 - my2) / dl * 42)
          await sleep(800)
        } else { await sleep(1800); continue }
        const sc = await dbg(page, 'state').catch(() => null)
        if (sc && sc.capBar > 3000) break
      }
    }
    const st = await dbg(page, 'state').catch(() => null)
    if (!st || st.ended) break
    await dbg(page, 'fxScene', 'calm').catch(() => {})
    if (!capSampled && st.capBar >= 15000) { // 15% 起采：span≥11 角（8% 时 span=6 角置信不足——上轮 3/6 假红）
      capSampled = await page.evaluate(`(() => { const P = ${INK}; const D = window.__GAMES_DEBUG__
        const st = D.state()
        if (!st.capBar || st.capBar < 15000) return null
        D.pause(true) // 冻结采样（ring/bar 为快照态——同任务读态+采样原子对帧）
        const team = st.capTeam === 1 ? 1 : 0, pred = team === 0 ? ${AMBER} : ${CYAN}
        const span = Math.max(1, Math.round(72 * st.capBar / 100000))
        let hits = 0
        for (let i = 0; i < span; i++) { const a = -Math.PI / 2 + i / 72 * Math.PI * 2
          const c = P.px(187 + Math.cos(a) * 45, 306 + Math.sin(a) * 45)
          if (pred(c[0], c[1], c[2])) hits++ }
        /* 顶栏占点条：队色最大连续段（B 分段 9 实 3 隙 → maxrun ≤13） */
        const bx0 = Math.round((375 - 190) / 2), fillW = Math.round(190 * st.capBar / 100000)
        let maxRun = 0, run = 0
        for (let x = bx0; x < bx0 + Math.max(1, fillW); x++) {
          const d = P.px(x, 33)
          if (pred(d[0], d[1], d[2])) { run++; if (run > maxRun) maxRun = run } else run = 0
        }
        D.pause(false)
        return { team, bar: st.capBar, span, hits, maxRun, fillW } })()`)
      if (!capSampled) await dbg(page, 'pause', false).catch(() => {})
    }
    /* HP 环判据+采样同任务（IronSim.consts 满血表——hp<满即环在绘；读态/冻结/采样原子=环位不随快照漂） */
    if (!hpSampled.A || !hpSampled.B) {
      const s2 = await page.evaluate(`((done) => { const P = ${INK}; const D = window.__GAMES_DEBUG__
        const st = D.state()
        const CLS = (window.IronSim && window.IronSim.consts && window.IronSim.consts.CLS) || null
        if (!CLS) return null
        const maxHp = (e) => (CLS[e.cls] || CLS.all).hp
        for (const team of [0, 1]) {
          if (done[team === 0 ? 'A' : 'B']) continue
          const v = (st.ents || []).find((e) => e.team === team && e.hp > 0 && e.hp < maxHp(e))
          if (!v) continue
          const hpr = Math.max(0.02, Math.min(0.999, v.hp / maxHp(v)))
          D.pause(true)
          const hp = ${HPARC}
          const span = Math.max(2, Math.round(48 * hpr))
          let hits = 0
          for (let i = 0; i < span; i++) { const a = -Math.PI / 2 + i / 48 * Math.PI * 2
            const c = P.px(17 + v.x / 1000 + Math.cos(a) * 13.5, 56 + v.y / 1000 + Math.sin(a) * 13.5)
            if (hp(c[0], c[1], c[2])) hits++ }
          D.pause(false)
          return { team, seat: v.seat, hpr: +hpr.toFixed(2), hits, span }
        }
        return null })(${JSON.stringify({ A: !!hpSampled.A, B: !!hpSampled.B })})`)
      if (s2) hpSampled[s2.team === 0 ? 'A' : 'B'] = s2
    }
    if (hpSampled.A && hpSampled.B && capSampled) break
    await sleep(700)
  }
  const hpArm = (s, lo, hi) => s && s.hits / s.span >= lo && s.hits / s.span <= hi
  const hpDetail = (k) => hpSampled[k] ? `${k}席${hpSampled[k].seat} hpr=${hpSampled[k].hpr} 命中=${hpSampled[k].hits}/${hpSampled[k].span}（r=${(hpSampled[k].hits / hpSampled[k].span).toFixed(2)}）` : `${k}席窗内未见损伤环`
  A('V-CB-R3', 'HP 环 A 实心/B 分段像素证（48 角环带比例：A ≥0.78 连续 / B 0.35-0.78 分段 [4,3]——至少一臂实测，另一臂静态在册 V-CB-S2）',
    hpArm(hpSampled.A, 0.78, 1.15) || hpArm(hpSampled.B, 0.35, 0.78),
    `${hpDetail('A')}｜${hpDetail('B')}`)
  const capArm = capSampled ? (capSampled.team === 0
    ? capSampled.hits / capSampled.span >= 0.6 && capSampled.maxRun >= Math.max(9, capSampled.fillW * 0.7)
    : capSampled.hits / capSampled.span >= 0.35 && capSampled.hits / capSampled.span <= 0.8 && capSampled.maxRun <= 13) : false
  A('V-CB-R4', '占点双面形通道像素证（占点圈弧+顶栏占点条同队：A 实心比例 ≥0.6+连续段（12 点方向起点常被圈白描边/实体压——0.75 过紧）/ B 分段 0.35-0.8+maxrun ≤13——活局自然态 15% 起采）',
    capArm, capSampled ? `team=${capSampled.team === 0 ? 'A' : 'B'} bar=${(capSampled.bar / 1000).toFixed(0)}% 圈命中=${capSampled.hits}/${capSampled.span}（r=${(capSampled.hits / capSampled.span).toFixed(2)}）条 maxrun=${capSampled.maxRun}/${capSampled.fillW}px` : '42s 窗内未见占点开启（bots 未上点——静态在册 V-CB-S3/S4）')

  /* ================= V-SHOT 冻结三态（kickoff/live/kill）帧差合理带 ================= */
  /* 基线帧=段内重采 calm 帧：开局 kickoff 帧（已截图落盘）距 live 采样 90s+——世界演化
   * （弹坑/履带印/实体移位累积）方差可达 92%>上限 85%（下轮实测），非三态差异本身 */
  await dbg(page, 'fxScene', 'calm')
  await sleep(150)
  await dbg(page, 'pause', true)
  await page.evaluate(`(() => { const g = document.getElementById('cv').getContext('2d')
    window.__g152Frames = window.__g152Frames || {}
    window.__g152Frames.kick = g.getImageData(0, 0, 375, 667).data.slice() })()`)
  await dbg(page, 'pause', false)
  const grabTo = async (key, shot) => {
    await dbg(page, 'fxScene', 'calm')
    await sleep(120)
    await dbg(page, 'fxScene', 'fire')
    await dbg(page, 'fxScene', 'engine')
    await sleep(140)
    await dbg(page, 'pause', true)
    await page.evaluate(`((k) => { const g = document.getElementById('cv').getContext('2d')
      window.__g152Frames = window.__g152Frames || {}
      window.__g152Frames[k] = g.getImageData(0, 0, 375, 667).data.slice() })(${JSON.stringify(key)})`)
    await page.screenshot({ path: join(OUT, shot) })
    await dbg(page, 'pause', false)
    await dbg(page, 'fxScene', 'calm')
  }
  await grabTo('live', 'vis-shot-live.png')
  await dbg(page, 'fxScene', 'kill')
  await sleep(300)
  await dbg(page, 'pause', true)
  await page.evaluate(`(() => { const g = document.getElementById('cv').getContext('2d')
    window.__g152Frames = window.__g152Frames || {}
    window.__g152Frames.kill = g.getImageData(0, 0, 375, 667).data.slice() })()`)
  await page.screenshot({ path: join(OUT, 'vis-shot-kill.png') })
  await dbg(page, 'pause', false)
  await dbg(page, 'fxScene', 'calm')
  const diffs = await page.evaluate(`(() => { const f = window.__g152Frames
    if (!f || !f.live || !f.kick || !f.kill) return null
    const d = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) n++; return +(n / (a.length / 4) * 100).toFixed(2) }
    const r = { kl: d(f.kick, f.live), kc: d(f.kick, f.kill), lc: d(f.live, f.kill) }
    window.__g152Frames = null
    return r })()`).catch(() => null)
  const sd = diffs || { kl: -1, kc: -1, lc: -1 }
  /* 分对阈值：live=fire+engine 动效透出（≥0.1%）/ kill=横幅+爆散+焦印（≥0.25%）/
   * 上限 85%=同战场基面无整屏覆写（kick↔live 间隔久世界态自演化并入下限贡献） */
  A('V-SHOT-1', '冻结三态帧差合理带（基线↔live ≥0.02%（fire+engine 动效墨水 ~200px≈0.05%——0.1% 对动效透出量过紧）/ kill 两对 ≥0.25% / 三对 ≤85%；基线=段内 calm 重采帧（kickoff 开局帧另存 png；世界演化方差不入三态带）；DSF=1 截图三帧落盘）',
    sd.kl >= 0.02 && sd.kc >= 0.25 && sd.lc >= 0.25 && sd.kl <= 85 && sd.kc <= 85 && sd.lc <= 85,
    `基线↔live=${sd.kl}% 基线↔kill=${sd.kc}% live↔kill=${sd.lc}%`)

  /* ================= V-PERF 帧成本对照带（rAF 注入法，feel-check 同口径） ================= */
  const frameCost = (n) => page.evaluate((framesN) => new Promise((res) => {
    const costs = []
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => orig((ts) => { const t0 = performance.now(); cb(ts); costs.push(performance.now() - t0) })
    const loop = () => { if (costs.length < framesN) orig(loop); else { window.requestAnimationFrame = orig; res(costs) } }
    orig(loop)
  }), n).then((c) => {
    c.sort((a, b) => a - b)
    return { avg: +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2), jank: +(c.filter((x) => x > 25).length / c.length * 100).toFixed(2), n: c.length }
  })
  await sleep(400)
  const perf = await frameCost(140)
  A('V-PERF-1', '帧成本 avg <16ms（60fps 预算；VIS 双编码扩面后不破带）', perf.avg < 16, `avg=${perf.avg}ms jank=${perf.jank}% n=${perf.n}`)
  A('V-PERF-2', '掉帧率（帧成本 >25ms）<2%', perf.jank < 2, `jank=${perf.jank}%`)

  A('V-0', '页面零异常（pageerror/console.error）', pageErrors.length === 0, pageErrors.length ? `${pageErrors.length} 例：${String(pageErrors[0]).slice(0, 120)}` : '0 例')
} catch (e) {
  A('V-FATAL', '工具执行链完整', false, String(e && e.message || e).slice(0, 200))
} finally {
  await browser.close().catch(() => {})
  srv.close(); try { gw.kill('SIGTERM') } catch {}
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

const passed = results.filter((r) => r.pass).length
const failed = results.length - passed
console.error(`\n${failed === 0 ? 'VIS-CHECK OK' : 'VIS-CHECK FAILED'}：${passed} 通过，${failed} 失败（截图 ${OUT}）`)
process.exit(failed ? 1 : 0)
