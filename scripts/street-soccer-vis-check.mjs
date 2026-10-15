#!/usr/bin/env node
/* =====================================================================
 * GAMES-143 街头足球 视觉统一+识图扩容（VIS）断言工具——mini-moba
 * vis-check（GAMES-135）取证范式移植。私有网关自起（随机口，
 * GATEWAY_PID/GATEWAY_LOG 改道临时目录）+私有静态伺服（随机口，伺服
 * 仓库工作树=本单改动即受测面）——零感知 :4399/:4400。
 *   V-HUD-1 静态：零裸字号 + HF 合法简写（weight 前置——GAMES-143 修
 *           '15px 700' 非法简写被 canvas 静默忽略=全 HUD 10px 缺省字）
 *           + DOM ≥9
 *   V-HUD-2/3 运行时：hudFonts() __cls 分级下限 + __applied 生效往返自证
 *   V-CB 双编码（静态+像素双证）：A 椭圆/B 方形底盘行宽签名 / 计分形色
 *           双标 / A 实心 B 分段体力弧 / 持球白环 / 轨迹 A 圆点 B 短杠
 *   V-PROBE 识图 v2 六探针扩容 →9 探针：QA1 六探针（沥青底/顶栏/场界/
 *           中线/霓虹门/底栏三钮）+进球横幅字形锚/让位提示环/金球 OT
 *           金色调三态
 *   V-SEM 语义面全项：六色鼎立区隔/持球权镜像/观战导演视角（V-SPEC）
 *   V-SHOT 冻结三态（kickoff/live/goal）帧差合理带 + DSF=1 截图落盘
 *   V-SPEC O-7 参考核验：4 真人满编+第 5 人观战金晕墨水对照
 *           （QA2 基线 7/60 vs 0/60——VIS 后复测不回退）+F11 台账
 *   V-PERF 帧成本对照带
 * 用法：node scripts/street-soccer-vis-check.mjs [--out dir]
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
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-143-shots'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 私有网关 + 静态伺服（零感知 :4399/:4400） ---------- */
const GWPORT = 4490 + Math.floor(Math.random() * 30)
const HTTPPORT = 49500 + Math.floor(Math.random() * 700)
const dataDir = await mkdtemp(join(tmpdir(), 'g143-gw-'))
const gw = spawn(process.execPath, [join(ROOT, 'server/gateway/index.js')], {
  env: { ...process.env, PORT: String(GWPORT), HOST: '127.0.0.1', GATEWAY_PID: join(dataDir, 'gw.pid'), GATEWAY_LOG: join(dataDir, 'gw.log') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let gwUp = false
for (let i = 0; i < 40 && !gwUp; i++) { await sleep(250); try { gwUp = (await fetch(`http://127.0.0.1:${GWPORT}/healthz`)).ok } catch {} }
if (!gwUp) { console.error('私有网关未起'); process.exit(2) }
/* .cjs MIME 拒载静默坑（GAMES-90）：sim/trig16 走 script 标签，octet-stream 会被拒 */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try { const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '')); const buf = await fsReadFile(p); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(buf) }
  catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(HTTPPORT, '127.0.0.1', r))
await mkdir(OUT, { recursive: true })
const PAGE_URL = `http://127.0.0.1:${HTTPPORT}/games/multiplayer/street-soccer/index.html`
const GWWS = `ws://127.0.0.1:${GWPORT}`

const browser = await chromium.launch({ headless: true })
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
  const grab = () => g.getImageData(0, 0, 375, 667).data.slice()
  return { px, scan, rowW, grab } })()`
const AMBER = '(r, g, b) => r > 195 && g > 110 && g < 205 && b < 125 && r - b > 90'
const CYAN = '(r, g, b) => g > 160 && b > 185 && r < 145 && b - r > 70'
const GREEN = '(r, g, b) => r > 95 && r < 175 && g > 175 && b > 100 && b < 180 && g - r > 40'
const WHITE = '(r, g, b) => r > 195 && g > 195 && b > 185'

let page
try {
  /* ================= V-HUD-1 / V-CB 静态审计 ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/street-soccer/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
  A('V-HUD-1a', '零裸字号（ctx.font 全走 HF 登记表）', bare.length === 0, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : 'ctx.font 赋值 0 处裸串')
  A('V-HUD-1b', 'HF 合法 CSS font 简写（weight 前置 size 后置——旧实现 15px 700 被静默忽略=全 HUD 10px 缺省字）', /\+ '00 ' \+ px \+ 'px -apple-system/.test(src), 'weight+space+px+family 构造在册')
  const html = await readFile(join(ROOT, 'games/multiplayer/street-soccer/index.html'), 'utf8')
  const domPx = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => +m[1])
  A('V-HUD-1c', 'index.html DOM 字号零裸小字（全部 ≥9）', domPx.length > 0 && domPx.every((p) => p >= 9), `DOM px=[${domPx.join(',')}]`)

  A('V-CB-1', '球员底盘形色双通道（A 椭圆 rx14 ry9 / B 方形 24×9——drawPlayer 分支）',
    /if \(p\.team === 0\) \{ ctx\.beginPath\(\); ctx\.ellipse\(x, y \+ 6, 14, 9, 0, 0, 7\); ctx\.fill\(\) \}/.test(src) && /ctx\.fillRect\(x - 12, y - 3, 24, 9\)/.test(src), 'A 椭圆/B 方形两分支在册')
  A('V-CB-2', '球轨迹形链双通道（末触者队伍色：A 圆点链 arc / B 短横杠链 6×2 rect——drawBall）',
    /if \(ball\.lastT % 2 === 0 \|\| boost\) \{ ctx\.beginPath\(\); ctx\.arc\(sx\(tr\.x\), sy\(tr\.y\), sz, 0, 7\); ctx\.fill\(\) \}/.test(src) && /else ctx\.fillRect\(sx\(tr\.x\) - 3, sy\(tr\.y\) - 1, 6, 2\)/.test(src), '圆点/短杠两式在册')
  A('V-CB-3', '体力弧 A 实心/B 分段（§7 阵营双编码——setLineDash(9,4) 分段弧）',
    /segB/.test(src) && /setLineDash\(\[9, 4\]\)/.test(src), 'B 席分段弧分支在册（GAMES-143 补齐：设计 §7 明文，旧实现两席同连续弧）')
  A('V-CB-4', '计分形色双标（顶栏比分旁 A 椭圆标/B 方形标——与底盘同构，色弱下计分归属不依赖色相）',
    /ellipse\(74, 42, 6\.5, 3\.5, 0, 0, 7\)/.test(src) && /fillRect\(127, 39, 13, 7\)/.test(src), 'GAMES-143 新增：A 椭圆标+B 方形标在册')
  const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return Math.round(0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) }
  const la = luma('#E8A33D'), lb = luma('#3DC8E8')
  A('V-CB-5', `阵营双色同亮度带（琥珀 ${la}/青 ${lb} Δ${Math.abs(la - lb)}<25 → 形状通道强制：底盘/轨迹/体力弧/计分标四形位）`,
    Math.abs(la - lb) < 25, 'hud-font-standard §3 口径同带；四形位双通道在册（V-CB-1..4）')

  /* ================= 运行时：玩家页（quick bot 房让位入席） ================= */
  page = await context.newPage(); watch(page)
  await page.goto(`${PAGE_URL}?quick=1&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && ['kick', 'play', 'goal'].includes(s.phase) }, null, { timeout: 20_000 })
  await sleep(1500) // 快照稳态（4 席就位+球场实体在场）

  /* ---------- V-HUD-2/3 运行时自证 ---------- */
  const hf = await dbg(page, 'hudFonts')
  const cls = hf.__cls || {}
  A('V-HUD-2', 'hudFonts() 分级下限自证（P0≥13/P1≥11/P2≥9，运行样本在册）', cls.P0 && cls.P0.min >= 13 && cls.P1 && cls.P1.min >= 11 && cls.P2 && cls.P2.min >= 9 && cls.P0.samples > 0 && cls.P1.samples > 0 && cls.P2.samples > 0, `P0=${cls.P0 && cls.P0.min}(n=${cls.P0 && cls.P0.samples}) P1=${cls.P1 && cls.P1.min}(n=${cls.P1 && cls.P1.samples}) P2=${cls.P2 && cls.P2.min}(n=${cls.P2 && cls.P2.samples})`)
  A('V-HUD-3', '字体生效往返自证（__applied：HF 串赋 ctx.font 后回读 13px——旧非法简写此处 false=全 HUD 10px 缺省字）', hf.__applied === true, `__applied=${hf.__applied}`)
  const st0 = await dbg(page, 'state')
  const myTeam = st0.seat % 2

  /* ================= V-PROBE 识图 v2 九探针（QA1 六+新增三） ================= */
  await dbg(page, 'fxScene', 'calm')
  await sleep(200)
  await dbg(page, 'pause', true) // 冻结采样（GAMES-103 范式：保留最后帧）
  const p1 = await page.evaluate(`(() => { const P = ${INK}
    const near = (c, t, tol) => c && c.slice(0, 3).every((v, i) => Math.abs(v - t[i]) <= tol)
    return { asphalt: P.px(187, 300), topbar: P.px(187, 20), court: P.px(5, 300) } })()`)
  const near = (c, t, tol) => c && c.slice(0, 3).every((v, i) => Math.abs(v - t[i]) <= tol)
  A('P-1', '球场沥青深底 #20242B（围笼球场特征）', near(p1.asphalt, [0x20, 0x24, 0x2b], 14), JSON.stringify(p1.asphalt))
  A('P-2', '顶栏 HUD 深底', near(p1.topbar, [0x17, 0x1a, 0x20], 16), JSON.stringify(p1.topbar))
  A('P-3', '场内外边界可辨（场外页底异色）', !near(p1.court, [0x20, 0x24, 0x2b], 8), JSON.stringify(p1.court))
  const lineFound = await page.evaluate(`(() => { const P = ${INK}
    /* 多列扫描（x160-215 步 5）：单列会被恰好立于中线上的球员/球遮蔽 */
    for (let x = 160; x <= 215; x += 5) for (let dy = -8; dy <= 8; dy++) {
      const c = P.px(x, 306 + dy); if (c[0] > 190 && c[1] > 190 && c[2] > 180) return x + '@' + (dy >= 0 ? '+' : '') + dy }
    return null })()`)
  A('P-4', '粉笔白中线（多列亮像素扫描 ±8——单列可被球员遮蔽）', lineFound !== null, lineFound !== null ? `x=${lineFound}` : '未见')
  const neon = await page.evaluate(`(() => { const P = ${INK}
    for (let x = 142; x <= 230; x += 4) for (let y = 38; y <= 52; y += 2) { const c = P.px(x, y); if (c[2] > 150 && c[1] > 110 && c[0] < 110) return x + ',' + y }
    return null })()`)
  A('P-5', '霓虹门描边（上门青蓝带）', neon !== null, neon || '未见')
  const btnInk = await page.evaluate(`(() => { const P = ${INK}
    let n = 0
    for (let x = 200; x < 350; x += 6) for (let y = 550; y < 666; y += 8) { const d = P.px(x, y); if (d[0] + d[1] + d[2] > 90) n++ }
    return n })()`)
  A('P-6', '底栏操控面墨水（射门/传球/冲刺三钮弧排）', btnInk > 8, `ink=${btnInk}`)
  await dbg(page, 'pause', false)

  /* ---------- P-7 进球横幅字形锚（P0 16px 队色横幅+顶栏 +1 差值标） ---------- */
  await dbg(page, 'fxScene', 'goalFor')
  await sleep(180)
  await dbg(page, 'pause', true)
  const banner = await page.evaluate(`((team) => { const P = ${INK}
    const bannerBand = team === 0 ? P.scan(100, 120, 175, 90, ${AMBER}, 2) : P.scan(100, 120, 175, 90, ${CYAN}, 2)
    /* +1 差值标随 pop 淡出（globalAlpha≈0.6-0.8 与顶栏底混色）→ 放宽判色；窗口避开
     * 比分数字（A 位 x66-84/B 位 x126-142）与时钟（x195+），只取 +1 悬浮带 y8-19 */
    const plusOne = P.scan(44, 8, 24, 12, (r, g, b) => r > 150 && g > 110 && b < 150 && r - b > 50, 1)
      + P.scan(146, 8, 22, 12, (r, g, b) => r > 150 && g > 110 && b < 150 && r - b > 50, 1)
    return { bannerBand, plusOne } })(${myTeam})`)
  A('P-7', '进球横幅字形锚（队色「进球！」P0 16px 横幅带 ≥20px + 金色 +1 差值标 ≥3px——修字号后字形实渲染）', banner.bannerBand >= 20 && banner.plusOne >= 3, `横幅带=${banner.bannerBand}px +1 标=${banner.plusOne}px（team=${myTeam === 0 ? 'A 琥珀' : 'B 青'}）`)
  await dbg(page, 'pause', false)
  await dbg(page, 'fxScene', 'calm')
  await dbg(page, 'fxScene', 'goalFor') // 二轮点火：F04 首绘双样取 min（帧距抖动剔除）
  await sleep(160)
  const led = await dbg(page, 'fxLedger')
  const f04s = led.filter((l) => l.id === 'F04' && l.lat != null)
  const f04min = f04s.length ? Math.min(...f04s.map((l) => l.lat)) : null
  /* VIS 环境帧距可达 30-70ms（无头 vsync 封顶），首绘=事件→下一帧；两轮取 min
   * 剔单帧抖动（80ms 红线主口径归 feel-check FE-2b，本探针双源复证） */
  A('P-7b', 'F04 进球横幅台账在案（两轮首绘 min ≤80ms 红线）', f04min != null && f04min <= 80, `F04×${f04s.length} lat min=${f04min}ms（轮值 ${f04s.map((l) => l.lat).join(',')}）`)
  await dbg(page, 'pause', false)

  /* ---------- P-8 让位提示环（F08 落位环+席位文案） ---------- */
  await dbg(page, 'fxScene', 'calm')
  await dbg(page, 'fxScene', 'seat')
  await sleep(150)
  await dbg(page, 'pause', true)
  const seatRing = await page.evaluate(`(() => { const P = ${INK}
    return { green: P.scan(12, 56, 350, 500, ${GREEN}, 2) } })()`)
  const led8 = await dbg(page, 'fxLedger')
  const f08 = led8.filter((l) => l.id === 'F08')
  A('P-8', '让位提示环（F08 落位绿环+「席位就绪」P1 11px 文案 ≥12px——welcome 就席=bot 让位完成时点）', seatRing.green >= 12, `球场域绿墨水=${seatRing.green}px（环+文案同色 #7ed08a）`)
  A('P-8b', 'F08 台账在案（welcome 真时点+VIS 复现双源）', f08.length >= 1, `F08×${f08.length} lat=${f08[0] && f08[0].lat}ms`)
  await dbg(page, 'pause', false)
  await dbg(page, 'fxScene', 'calm')

  /* ---------- P-9 金球 OT 金色调三态（无 OT 基线→触发窗衰减带→窗尽回落） ----------
   * 口径披露：fxScene('ot') 客户端置 ot=1 会被 20Hz 真快照在 ~50ms 内校正回 0
   * （服务器未进 OT）——非 OT 局客户端可见面=0.06 增益衰减带（实测 r+10）；
   * 全强度 0.10+0.06 组合的真源=服务器 state.ot=1（真 OT 期持续，P-9d 静态在册；
   * rAF 同步读偶捕首帧全强度≈+29，运气帧不作断言锚）。 */
  await dbg(page, 'fxScene', 'otOff')
  await sleep(150)
  await dbg(page, 'pause', true)
  const preCorner = await page.evaluate(`(() => { const P = ${INK}; return P.px(4, 660) })()`)
  await dbg(page, 'pause', false)
  await dbg(page, 'fxScene', 'ot')
  await sleep(60) // 触发窗早段（快照已校正 ot，增益 0.06×~0.93 衰减中）
  await dbg(page, 'pause', true)
  const trigCorner = await page.evaluate(`(() => { const P = ${INK}; return P.px(4, 660) })()`)
  const otBanner = await page.evaluate(`(() => { const P = ${INK}
    return P.scan(90, 140, 195, 70, (r, g, b) => r > 225 && g > 185 && b < 175 && r - b > 80, 2) })()`)
  await dbg(page, 'pause', false)
  await sleep(380) // 窗中段（~440ms，增益衰减过半）
  await dbg(page, 'pause', true)
  const midCorner = await page.evaluate(`(() => { const P = ${INK}; return P.px(4, 660) })()`)
  await dbg(page, 'pause', false)
  await sleep(950) // 触发窗 800ms 衰减尽 → 回落态
  await dbg(page, 'pause', true)
  const postCorner = await page.evaluate(`(() => { const P = ${INK}; return P.px(4, 660) })()`)
  await dbg(page, 'pause', false)
  const dTrig = trigCorner[0] - preCorner[0], dMid = midCorner[0] - preCorner[0], dPost = postCorner[0] - preCorner[0]
  A('P-9', '金球 OT 金色调三态（左下角像元 r 通道：无 OT 基线→触发窗 ≥+8→窗中段衰减 <触发−2→窗尽回落 ≤+3——增益衰减带成形）',
    dTrig >= 8 && dMid <= dTrig - 2 && dMid >= 2 && dPost <= 3, `r 通道 ${preCorner[0]}→${trigCorner[0]}（窗早段 +${dTrig}）→${midCorner[0]}（窗中段 +${dMid}）→${postCorner[0]}（回落 +${dPost}）`)
  A('P-9b', 'OT 触发「金球加时」横幅金字在场（F13 伴随横幅）', otBanner >= 12, `金字带=${otBanner}px`)
  const led13 = await dbg(page, 'fxLedger')
  const f13 = led13.filter((l) => l.id === 'F13')
  A('P-9c', 'F13 金球台账在案', f13.length >= 1, `F13×${f13.length} lat=${f13[0] && f13[0].lat}ms`)
  A('P-9d', 'OT 持续态 0.10 分支在册（真 OT=服务器 state.ot=1 驱动持续金色调+触发窗 0.06 增益叠加——GAMES-143 修死码后公式；非 OT 局实测面=P-9 衰减带）', /snapState\.ot \? 0\.10 : 0\) \+ 0\.06 \* Math\.max/.test(src), 'gq=(ot?0.10:0)+0.06*decay 在册')
  await dbg(page, 'fxScene', 'calm')
  await dbg(page, 'fxScene', 'otOff')

  /* ================= V-SEM 语义面全项 ================= */
  /* 六色鼎立区隔（球场域 ≥2 类球衣彩色簇） */
  await sleep(400)
  await dbg(page, 'pause', true)
  const sem = await page.evaluate(`(() => { const g = document.getElementById('cv').getContext('2d')
    const clusters = {}
    for (let x = 40; x < 340; x += 5) for (let y = 60; y < 520; y += 5) {
      const c = Array.from(g.getImageData(x, y, 1, 1).data)
      if (c[3] < 40) continue
      const [r, gg, b] = c
      if (Math.abs(r - 0x20) < 18 && Math.abs(gg - 0x24) < 18 && Math.abs(b - 0x2b) < 18) continue
      if (r > 200 && gg > 200 && b > 190) continue
      const sat = Math.max(r, gg, b) - Math.min(r, gg, b)
      if (sat > 40) { const key = (r >> 5) + ',' + (gg >> 5) + ',' + (b >> 5); clusters[key] = (clusters[key] || 0) + 1 }
    }
    const kinds = Object.entries(clusters).filter(([, n]) => n >= 3)
    return { colorKinds: kinds.length } })()`)
  A('V-SEM-1', '语义面·六色鼎立区隔：球场域 ≥2 类球衣彩色簇在场（琥珀/青蓝队色可辨）', sem.colorKinds >= 2, `簇型=${sem.colorKinds}`)
  const stSem = await dbg(page, 'state')
  A('V-SEM-2', '语义面·持球权镜像在场（poss∈−1∪0..3=语义渲染依据）', Number.isInteger(stSem.poss) && stSem.poss >= -1 && stSem.poss < 4, `poss=${stSem.poss}`)

  /* 底盘形状签名：A 椭圆下缘带（py+8 行宽 ≥15）/ B 方形下缘齐（py+8 行宽 ≤8） */
  const plates = await page.evaluate(`(() => { const P = ${INK}; const st = window.__GAMES_DEBUG__.state()
    const isA = ${AMBER}, isB = ${CYAN}
    const out = { A: [], B: [], mid: { A: [], B: [] } }
    for (const e of st.ents || []) {
      const cx = 12 + e.x, cy = 56 + e.y
      if (cx < 30 || cx > 345 || cy < 70 || cy > 530) continue
      const pred = e.team === 0 ? isA : isB
      out[e.team === 0 ? 'A' : 'B'].push(P.rowW(cy + 8, cx, 16, pred))
      out.mid[e.team === 0 ? 'A' : 'B'].push(P.rowW(cy + 1, cx, 16, pred))
    }
    return out })()`)
  const aLow = Math.max(0, ...(plates.A || [])), bLow = Math.max(0, ...(plates.B || []))
  const aMid = Math.max(0, ...(plates.mid.A || [])), bMid = Math.max(0, ...(plates.mid.B || []))
  A('V-SEM-3', '底盘形状签名（冻结帧行宽采样：A 椭圆下缘带 py+8 行 ≥15px / B 方形下缘齐 py+8 行 ≤8px——色弱下形=唯一键）',
    (plates.A || []).length > 0 && (plates.B || []).length > 0 && aLow >= 15 && bLow <= 8 && aMid >= 10 && bMid >= 10,
    `A 席 py+8 行宽=[${(plates.A || []).join(',')}]（底盘带 ${aMid}）/ B 席 py+8 行宽=[${(plates.B || []).join(',')}]（底盘带 ${bMid}）`)

  /* 计分形色双标（顶栏 A 椭圆标/B 方形标像素） */
  const marks = await page.evaluate(`(() => { const P = ${INK}
    return { a: P.scan(64, 37, 20, 10, ${AMBER}, 1), b: P.scan(125, 37, 17, 11, ${CYAN}, 1) } })()`)
  A('V-SEM-4', '计分形色双标（顶栏：A 椭圆标 ≥6px / B 方形标 ≥10px——GAMES-143 新增形通道）', marks.a >= 6 && marks.b >= 10, `A 椭圆标=${marks.a}px B 方形标=${marks.b}px`)

  /* 体力弧 A 实心/B 分段（我席档位=seat%2；冻结帧 r20 环带 48 角采样） */
  const arc = await page.evaluate(`((team) => { const P = ${INK}
    let hits = 0, tot = 0
    for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2 - Math.PI / 2
      const x = Math.round(228 + Math.cos(a) * 20), y = Math.round(578 + Math.sin(a) * 20)
      if (y < 546 || y > 664) continue
      tot++
      const c = P.px(x, y)
      if (c[0] > 95 && c[0] < 175 && c[1] > 175 && c[2] > 100 && c[2] < 180 && c[1] - c[0] > 40) hits++
    }
    return { hits, tot } })(${myTeam})`)
  const arcOk = myTeam === 0 ? arc.hits >= 40 : (arc.hits <= 36 && arc.hits >= 8)
  A('V-SEM-5', `体力弧 A 实心/B 分段（我席 team=${myTeam === 0 ? 'A 连续弧命中 ≥40' : 'B 分段弧命中 ≤36（9 实 4 隙）'}——冻结帧 48 角环带）`, arcOk, `绿弧命中=${arc.hits}/${arc.tot}（我席=${st0.seat}）`)

  /* 持球白环（poss≥0 时持球者脚下 r18×12 白椭圆环采样）——口径：冻结帧会与
   * pause 后仍到达的快照 poss 赛态脱拍（冻结帧=旧 owner），改活帧原子采样
   * （同一 JS 任务内读 canvas+state，帧龄 ≤16ms），max-of-N 取稳态持球窗 */
  let best = null, lastPoss = null
  await dbg(page, 'pause', false) // 活帧采样前提：解除语义面冻结（冻结帧=旧 owner，白环竞态）
  for (let i = 0; i < 22 && !(best && best.hits >= 12); i++) {
    await sleep(240)
    const r = await page.evaluate(`(() => { const g = document.getElementById('cv').getContext('2d')
      const poss0 = window.__GAMES_DEBUG__.state().poss
      if (poss0 < 0) return { poss: poss0, hits: 0, stable: false }
      const e = (window.__GAMES_DEBUG__.state().ents || []).find((x) => x.seat === poss0)
      if (!e) return { poss: poss0, hits: 0, stable: false }
      const cx = 12 + e.x, cy = 56 + e.y + 6
      let hits = 0
      for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2
        /* 三径采样（×0.92/1.0/1.08）：ents 坐标整 px 化的 ±0.5px 离心 vs 1.6px 环宽 */
        for (const k of [0.92, 1, 1.08]) {
          const d = g.getImageData(Math.round(cx + Math.cos(a) * 18 * k), Math.round(cy + Math.sin(a) * 12 * k), 1, 1).data
          if (d[0] > 195 && d[1] > 195 && d[2] > 185) { hits++; break }
        } }
      /* 采样前后 poss 双读一致才可信（新鲜快照 poss vs 末绘帧的持球者竞态弃样） */
      const poss1 = window.__GAMES_DEBUG__.state().poss
      return { poss: poss0, hits, stable: poss0 === poss1 } })()`).catch(() => null)
    if (r) lastPoss = r.poss
    if (r && r.stable && r.poss >= 0 && (!best || r.hits > best.hits)) best = r
  }
  A('V-SEM-6', '持球指示白环（poss 持球者脚下 r18×12 椭圆环 20 角活帧采样 ≥10 命中——持球权可视锚，色盲无关白圈；poss 前后双读一致才计样）',
    !!best && best.hits >= 10, best ? `poss=${best.poss} 环命中 best=${best.hits}/20（max-of-22×240ms 稳态样）` : `22×240ms 窗内无稳态持球（游离球局，末见 poss=${lastPoss}）`)
  await page.screenshot({ path: join(OUT, 'vis-live.png') })
  await dbg(page, 'pause', false)

  /* ================= V-SHOT 冻结三态（kickoff/live/goal）帧差合理带 ================= */
  /* 三帧 ImageData 页内暂存（window.__g143Frames）——大数组不走 evaluate 往返 */
  const grabTo = async (key, shot) => {
    await dbg(page, 'pause', true)
    await page.evaluate(`((k) => { const g = document.getElementById('cv').getContext('2d')
      window.__g143Frames = window.__g143Frames || {}
      window.__g143Frames[k] = g.getImageData(0, 0, 375, 667).data.slice() })(${JSON.stringify(key)})`)
    await page.screenshot({ path: join(OUT, shot) })
    await dbg(page, 'pause', false)
  }
  await dbg(page, 'fxScene', 'calm')
  await sleep(250)
  await grabTo('live', 'vis-shot-live.png')
  await dbg(page, 'fxScene', 'kickoff')
  await sleep(200)
  await grabTo('kick', 'vis-shot-kickoff.png')
  await dbg(page, 'fxScene', 'calm')
  await sleep(200)
  await dbg(page, 'fxScene', 'goalFor')
  await sleep(200)
  await grabTo('goal', 'vis-shot-goal.png')
  await dbg(page, 'fxScene', 'calm')
  const diffs = await page.evaluate(`(() => { const f = window.__g143Frames
    if (!f || !f.live || !f.kick || !f.goal) return null
    const d = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) n++; return +(n / (a.length / 4) * 100).toFixed(2) }
    const r = { lk: d(f.live, f.kick), lg: d(f.live, f.goal), kg: d(f.kick, f.goal) }
    window.__g143Frames = null
    return r })()`).catch(() => null)
  const shotDiffs = diffs || { lk: -1, lg: -1, kg: -1 }
  /* 分对阈值：kickoff 幽灵环=细虚线椭圆（~0.1-0.2% 墨水，开球站位期世界层近静）→
   * 下限 0.08%；goal=横幅+爆散+震屏位移（≥0.3%）；上限 85%=同球场基面无整屏覆写 */
  A('V-SHOT-1', '冻结三态帧差合理带（live↔kickoff ≥0.08%（幽灵环可辨）/ goal 两对 ≥0.3%（横幅+爆散）/ 三对 ≤85%（同球场基面无整屏覆写））',
    shotDiffs.lk >= 0.08 && shotDiffs.lg >= 0.3 && shotDiffs.kg >= 0.3 && shotDiffs.lk <= 85 && shotDiffs.lg <= 85 && shotDiffs.kg <= 85,
    `live↔kickoff=${shotDiffs.lk}% live↔goal=${shotDiffs.lg}% kickoff↔goal=${shotDiffs.kg}%（DSF=1 截图三帧落盘）`)

  /* ================= V-SPEC：O-7 观战金晕墨水对照复测（4 真人+第 5 人） ================= */
  console.error('[V-SPEC] 满编 2v2+第 5 人观战（O-7 基线 7/60 vs 0/60 复测）')
  const roomId = await page.evaluate(() => { try { return sessionStorage.getItem('ss-rid') } catch { return null } })
  const seats = [st0.seat]
  const pages = [page]
  for (let i = 0; i < 3 && roomId; i++) {
    const p = await context.newPage(); watch(p)
    await p.goto(`${PAGE_URL}?room=${roomId}&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
    try {
      await p.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 }, null, { timeout: 12_000 })
      seats.push((await dbg(p, 'state')).seat)
      pages.push(p)
    } catch { seats.push(-1) }
  }
  A('V-SPEC-1', '前置：满编 2v2=4 真人四席互异（bot 全让位）', roomId && seats.filter((s) => s >= 0).length === 4 && new Set(seats).size === 4, `rid=${roomId} seats=[${seats.join(',')}]`)
  await sleep(1200)
  let specSt = null, p5 = null
  if (roomId) {
    p5 = await context.newPage(); watch(p5)
    await p5.goto(`${PAGE_URL}?room=${roomId}&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
    try {
      await p5.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat === -1 && s.phase }, null, { timeout: 12_000 })
      specSt = await dbg(p5, 'state')
    } catch { }
  }
  A('V-SPEC-2', '第 5 人=观战位（seat=-1 满员不占席——welcome 实证）', !!specSt, specSt ? `seat=${specSt.seat} phase=${specSt.phase} poss=${specSt.poss}` : '未入观战')
  if (specSt) {
    const ringProbe = (p) => p.evaluate(`(() => { const st = window.__GAMES_DEBUG__.state()
      if (!st || !st.ball) return null
      const cv = document.querySelector('canvas'), g = cv.getContext('2d')
      const bx = 12 + st.ball.x / 1000, by = 56 + st.ball.y / 1000
      let hits = 0, tot = 0
      for (let r = 10; r <= 18; r += 2) for (let a = 0; a < 12; a++) {
        const x = Math.round(bx + Math.cos(a / 12 * 6.283) * r), y = Math.round(by + Math.sin(a / 12 * 6.283) * r)
        if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue
        let d; try { d = g.getImageData(x, y, 1, 1).data } catch { continue }
        tot++
        if (d[0] >= 135 && d[0] <= 235 && d[1] >= 110 && d[1] <= 215 && d[2] <= 130 && d[0] - d[2] >= 45) hits++
      }
      return { hits, tot } })()`)
    let frames = 0; const specHits = []
    for (let i = 0; i < 3; i++) { const r = await ringProbe(p5).catch(() => null); if (r && r.hits >= 3) frames++; if (r) specHits.push(`${r.hits}/${r.tot}`); await sleep(260) }
    let ctl = null
    for (let i = 0; i < 3 && (!ctl || ctl.tot === 0); i++) { ctl = await ringProbe(pages[0]).catch(() => null); if (!ctl || ctl.tot > 0) break; await sleep(260) }
    A('V-SPEC-3', 'O-7 观战金晕墨水复测（球周环形金晕 r10-18×60 采样×3 帧 ≥2 帧 ≥3 命中；不回退 QA2 基线 7/60）', frames >= 2, `观战帧命中 ${specHits.join(' ')}｜对照=球员页同环 ${ctl ? `${ctl.hits}/${ctl.tot}` : 'n/a'}（QA2 基线 7/60 vs 0/60）`)
    const led5 = await dbg(p5, 'fxLedger')
    const f11 = led5.filter((l) => l.id === 'F11')
    A('V-SPEC-4', '观战导演视角兑现（F11 焦点环台账在案——QA1 观察项：观战球光圈脉动=导演锚）', f11.length >= 1, `F11×${f11.length} lat=${f11[0] && f11[0].lat}ms`)
    await p5.screenshot({ path: join(OUT, 'vis-spectate.png') })
  }

  /* ================= V-PERF 帧成本对照带 ================= */
  await sleep(2500)
  const perf = await dbg(page, 'perf')
  A('V-PERF-1', '帧成本 avg <16ms（60fps 预算；VIS 字号放大后不破带）', perf.costAvgMs < 16, `avg=${perf.costAvgMs}ms p95=${perf.costP95Ms}ms jank=${perf.costJankPct}% n=${perf.n}`)
  A('V-PERF-2', '掉帧率（帧成本 >25ms）<2%', perf.costJankPct < 2, `jank=${perf.costJankPct}%`)

  A('V-0', '页面零异常（pageerror/console.error，全部页面整轮）', pageErrors.length === 0, pageErrors.length ? `${pageErrors.length} 例：${String(pageErrors[0]).slice(0, 120)}` : '0 例')
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
