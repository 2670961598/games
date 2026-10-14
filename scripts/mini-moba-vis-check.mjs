#!/usr/bin/env node
/* =====================================================================
 * GAMES-135 迷你MOBA 视觉统一+观战导演（VIS）断言工具——tactics-duel
 * vis-check（GAMES-124）取证范式移植 + QA1（GAMES-128）识图口径扩容。
 * 本作无 offline 模式 → 私有网关自起（随机口，GATEWAY_PID/GATEWAY_LOG
 * 改道临时目录，零感知 :4399/:4400）。四帧映射：home=集结期（welcome 后
 * 未开局）/play=对局中（兵线在场）/settle=结算覆层（mockEnd 渲染路径取证，
 * 真终局仍由 end 消息驱动）/spec=观战导演帧（?spectate=1&room=）：
 *   V-HUD-1 静态：零裸字号 + HF 合法简写（weight 前置）+ DOM ≥9
 *   V-HUD-2/3 运行时：hudFonts() __cls 分级下限 + __applied 生效往返自证
 *           （GAMES-135 发现：旧 HF '13px 700px' 非法简写被 canvas 静默
 *            忽略，全 HUD 实渲染 10px 缺省字——登记表只记调用值不记生效值）
 *   V-CB 双编码：技能四色族+区域技形状签名 / 血条 A 实心 B 分段 /
 *           阵营双色同亮度带→形状强制第二通道
 *   V-BR 战场可读性：区域技签名像素 / 伤害飘字 13px 深底描边 /
 *           视野边界弧 / 小地图信息密度 / 结算页布局（双队战绩行）
 *   V-SHOT 四帧（字形锚点口径，DSF=1 截图）
 *   V-SPEC 观战导演：seat/ack 语义 / 镜头随 AOI 热点 / 跟焦点轮换 /
 *           KDA 面板+簿记（fxProbe 合成 kill 走同一 onEvent 管线）
 *   V-PERF 帧成本对照带（GAMES-118 口径：rAF 包裹计时）
 * 用法：node scripts/mini-moba-vis-check.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { readFile as fsReadFile } from 'node:fs/promises'
import { extname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-135-shots'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 私有网关 + 静态伺服 ---------- */
const GWPORT = 4460 + Math.floor(Math.random() * 30)
const HTTPPORT = 48500 + Math.floor(Math.random() * 900)
const dataDir = await mkdtemp(join(tmpdir(), 'g135-gw-'))
const gw = spawn(process.execPath, [join(ROOT, 'server/gateway/index.js')], {
  env: { ...process.env, PORT: String(GWPORT), HOST: '127.0.0.1', GATEWAY_PID: join(dataDir, 'gw.pid'), GATEWAY_LOG: join(dataDir, 'gw.log') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let gwUp = false
for (let i = 0; i < 40 && !gwUp; i++) { await sleep(250); try { gwUp = (await fetch(`http://127.0.0.1:${GWPORT}/healthz`)).ok } catch {} }
if (!gwUp) { console.error('私有网关未起'); process.exit(2) }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try { const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '')); const buf = await fsReadFile(p); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(buf) }
  catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(HTTPPORT, '127.0.0.1', r))
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const pageErrors = []
let page
try {
  /* ================= V-HUD-1 静态审计 ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/mini-moba/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/(F\.|HF\()/.test(l))
  A('V-HUD-1a', '零裸字号（ctx.font 全走 HF 登记表）', bare.length === 0, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : 'ctx.font 赋值 0 处裸串')
  const hfSrc = src.slice(src.indexOf('function HF'), src.indexOf('function HF') + 260)
  A('V-HUD-1b', 'HF 合法 CSS font 简写（weight 前置 size 后置——旧实现 13px 700px 被静默忽略）', /\+ 'px -apple-system/.test(hfSrc) && /weight \|\| 600\) \+ ' ' \+ px/.test(hfSrc), 'weight+space+px+family 构造在册')
  const html = await readFile(join(ROOT, 'games/multiplayer/mini-moba/index.html'), 'utf8')
  const domPx = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => +m[1])
  A('V-HUD-1c', 'index.html DOM 字号零裸小字（全部 ≥9）', domPx.length > 0 && domPx.every((p) => p >= 9), `DOM px=[${domPx.join(',')}]`)

  /* ================= V-CB 静态（双编码通道在册） ================= */
  A('V-CB-1a', '技能类型×色相四族（位移青绿 #3DE8B0/伤害橙红 #E8633D/控制紫 #9D6FE8/增益金 #E8C46A——SKILL_UI 全表）',
    ['#3DE8B0', '#E8633D', '#9D6FE8', '#E8C46A'].every((c) => src.includes(c)) && /SKILL_UI = \{/.test(src), '四色族+技能名双字编码（色+字）在册')
  A('V-CB-1b', '区域技形状签名（星陨=三芒刺/静滞=内六边 shapePath 6/箭雨=四象点——色弱下形=第二通道）',
    /if \(z\.skill === 'star'\)/.test(src) && /shapePath\(sx\(z\.x\), sy\(z\.y\), z\.r \* 0\.4, 6, 0\)/.test(src) && /星陨=三芒刺 \/ 静滞=内六边 \/ 箭雨=四象点/.test(src), '三分支+文案注释在册')
  A('V-CB-2', '血条阵营双通道（A 实心 / B 分段 4 段——drawHpBar seg 分支）', /if \(seg\) \{[\s\S]{0,80}var n = 4/.test(src) && /drawHpBar\((x|cx), (y|cy) \+ \d+, (44|52|40), (hp|chp), t\[2\], t\[2\] === 'B'\)/.test(src), 'seg 形参 B 席传 1（tw/core/hero 三调用点）')
  const luma = (hex) => { const n = parseInt(hex.slice(1), 16); return Math.round(0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) }
  const la = luma('#E8A33D'), lb = luma('#3DC8E8')
  A('V-CB-3', `阵营双色同亮度带（琥珀 ${la}/青 ${lb} Δ${Math.abs(la - lb)}<25 → 形状通道强制：塔 A 三角旗/B 燕尾旗、水晶 A 三边/B 四边、小兵双层形、己方白圈）`,
    Math.abs(la - lb) < 25 && /三角旗/.test(src) && /燕尾旗/.test(src) && /c\[2\] === 'A' \? 3 : 4/.test(src), 'hud-font-standard §3 口径同带；塔旗/水晶边数形状分支在册')

  /* ================= 运行时：玩家页 ================= */
  page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${HTTPPORT}/games/multiplayer/mini-moba/index.html?gw=http://127.0.0.1:${GWPORT}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().room, null, { timeout: 15_000 })
  await page.screenshot({ path: join(OUT, 'g135-home.png') }) // home 帧：集结期（welcome 已至未开局）

  const INK = `(() => { const g = document.getElementById('cv').getContext('2d')
    const ink = (x0, y0, w, h) => { const d = g.getImageData(x0, y0, w, h).data; const cnt = {}
      for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) + ',' + (d[i+1] >> 4) + ',' + (d[i+2] >> 4); cnt[k] = (cnt[k] || 0) + 1 }
      let bg = 0, bgK = null; for (const k in cnt) if (cnt[k] > bg) { bg = cnt[k]; bgK = k }
      let inkN = 0, total = 0; const B = bgK.split(',').map(Number).map((v) => v * 16 + 8)
      for (let i = 0; i < d.length; i += 4) { total++; if (Math.abs(d[i]-B[0]) + Math.abs(d[i+1]-B[1]) + Math.abs(d[i+2]-B[2]) > 72) inkN++ }
      return +(inkN / total).toFixed(4) }
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
    const scan = (x0, y0, w, h, pred) => { const d = g.getImageData(x0, y0, w, h).data; let n = 0
      for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i+1], d[i+2])) n++; return n }
    return { ink, px, scan } })()`

  /* ---------- V-SHOT-1 home 帧锚点 ---------- */
  const fHome = await page.evaluate(`(() => { const P = ${INK}; const D = window.__GAMES_DEBUG__
    return { top: P.ink(0, 0, 375, 36), hint: document.getElementById('hint').textContent,
      mapRoad: P.scan(160, 560, 60, 60, (r, g, b) => r > 80 && g > 70 && b < 90) } })()`)
  A('V-SHOT-1', 'home 帧（集结期）锚点：顶栏 HUD 带+主画面地图（石径暖色带）+DOM 提示位', fHome.top > 0.05 && fHome.mapRoad > 2000, `顶栏墨水=${fHome.top} 石径px=${fHome.mapRoad} hint="${fHome.hint.slice(0, 18)}"`)

  /* ---------- 开局推进 → play 帧（兵线首波 ~18s） ---------- */
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.entKinds && (window.__GAMES_DEBUG__.entKinds().creep > 0), null, { timeout: 45_000 })
  await sleep(2500) // 兵线推进+HUD 稳态
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm'))
  const fPlay = await page.evaluate(`(() => { const P = ${INK}; const D = window.__GAMES_DEBUG__
    const hf = D.hudFonts()
    return { kinds: D.entKinds(), top: P.ink(0, 0, 375, 36), gold: P.ink(0, 36, 90, 26),
      skillBtns: P.ink(200, 400, 175, 180), creepLane: P.scan(120, 250, 135, 220, (r, g, b) => Math.abs(r-110) + Math.abs(g-96) + Math.abs(b-70) < 60 || Math.abs(r-46) + Math.abs(g-110) + Math.abs(b-140) < 60),
      applied: hf.__applied, cls: hf.__cls } })()`)
  await page.screenshot({ path: join(OUT, 'g135-play.png') })
  A('V-SHOT-2', 'play 帧锚点：顶栏/金币带/技能弧排三带墨水 + 兵线在场（creep>0）+ 主道兵线色像元', fPlay.top > 0.05 && fPlay.gold > 0.02 && fPlay.skillBtns > 0.02 && fPlay.kinds.creep > 0, `kinds=${JSON.stringify(fPlay.kinds)} 顶栏=${fPlay.top} 金币=${fPlay.gold} 技能区=${fPlay.skillBtns}`)

  /* ---------- V-HUD-2/3 运行时自证 ---------- */
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const cls = hf.__cls || {}
  A('V-HUD-2', 'hudFonts() 分级下限自证（P0≥13/P1≥11/P2≥9，运行样本在册）', cls.P0 && cls.P0.min >= 13 && cls.P1 && cls.P1.min >= 11 && cls.P2 && cls.P2.min >= 9 && cls.P0.samples > 0 && cls.P1.samples > 0 && cls.P2.samples > 0, `P0=${cls.P0 && cls.P0.min}(n=${cls.P0 && cls.P0.samples}) P1=${cls.P1 && cls.P1.min}(n=${cls.P1 && cls.P1.samples}) P2=${cls.P2 && cls.P2.min}(n=${cls.P2 && cls.P2.samples})`)
  A('V-HUD-3', '字体生效往返自证（__applied：HF 串赋 ctx.font 后回读 13px——旧实现此处为 false=全 HUD 10px 缺省字）', hf.__applied === true, `__applied=${hf.__applied}`)

  /* ---------- V-BR-2 伤害飘字可读性（13px P0+3px 深底描边） ---------- */
  const fl = await page.evaluate(`(() => { const P = ${INK}; const D = window.__GAMES_DEBUG__
    const d = D.dir()
    D.fxProbe({ k: 'hit', vic: 'h9', dmg: 42, m: 1 })
    return { cam: d.cam } })()`)
  await sleep(120) // 飘字前段高不透明窗
  const flPix = await page.evaluate(`((cam) => { const P = ${INK}
    const cx = 187, cy = 313 // 兜底位=镜头中心上方（float 起点 sy(cam)-18 并上浮）
    const purple = P.scan(cx - 60, cy - 40, 120, 52, (r, g, b) => r > 150 && g < 175 && b > 200 && b - r > 40)
    return { purple } })(${JSON.stringify(fl.cam)})`)
  A('V-BR-2', '伤害飘字可读性（13px/700 P0 dmgF 键在册：法术紫字 ≥15px；3px 深底描边 strokeText 静态在册——深底与地图底色同带不另计像素）', flPix.purple >= 15 && /strokeText\(f\.txt/.test(src), `紫字px=${flPix.purple}；描边=源码 strokeText(f.txt) 在册`)

  /* ---------- V-BR-1 区域技形状签名（星陨三芒刺） ---------- */
  const zone = await page.evaluate(`(() => { const D = window.__GAMES_DEBUG__; const d = D.dir()
    D.fxProbe({ k: 'zone', x: Math.round((d.cam.x) * 1000), y: Math.round((d.cam.y - 60) * 1000), r: 52000, at: 1, dur: 30, skill: 'star' })
    return d.cam })()`)
  await sleep(140)
  const zSig = await page.evaluate(`((cam) => { const P = ${INK}
    const cx = 187, cy = 333 - 60
    const ringBand = P.scan(cx - 56, cy - 56, 112, 112, (r, g, b) => r > 150 && g < 110 && r - g > 70)
    const innerTicks = P.scan(cx - 36, cy - 36, 72, 72, (r, g, b) => r > 130 && g < 110 && r - g > 50)
    return { ringBand, innerTicks } })(${JSON.stringify(zone)})`)
  A('V-BR-1', '区域技双通道（星陨：红虚线预警圈 ≥25px + 三芒刺形状签名 ≥10px——色+形双编码）', zSig.ringBand >= 25 && zSig.innerTicks >= 10, `预警圈px=${zSig.ringBand} 三芒刺px=${zSig.innerTicks}`)

  /* ---------- V-BR-3 视野边界弧（AOI 迷雾圈 335px） ---------- */
  /* 摇杆驱动英雄走向河道路口（泉边弧 95% 出屏——walk 至中场后整圈入屏才可环带采样；席位阵营未知→按当前 y 定方向） */
  const me0 = await page.evaluate(() => window.__GAMES_DEBUG__.dir().me)
  const up = me0 && me0.y > 900
  await page.mouse.move(100, 430); await page.mouse.down()
  for (let i = 1; i <= 12; i++) { await page.mouse.move(100, 430 + (up ? -1 : 1) * i * 11, { steps: 2 }); await sleep(250) }
  await page.mouse.up(); await sleep(600) // 镜头 0.25 收敛
  const vb = await page.evaluate(`(() => { const P = ${INK}; const D = window.__GAMES_DEBUG__; const d = D.dir()
    if (!d.me) return { lit: -1 }
    const cx = 187 + d.me.x - d.cam.x, cy = 333 + d.me.y - d.cam.y // 己身在屏位（弧心）
    const lu = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
    let lit = 0, seen = 0
    const R = d.aoi ? d.aoi.r : 320
    for (let i = 0; i < 32; i++) { const a = i / 32 * Math.PI * 2
      const ax = Math.round(cx + Math.cos(a) * R), ay = Math.round(cy + Math.sin(a) * R)
      if (ax < 2 || ax > 372 || ay < 2 || ay > 664) continue // 出屏角跳过
      seen++
      const arc = lu(P.px(ax, ay)), ref = lu(P.px(Math.round(cx + Math.cos(a) * (R - 14)), Math.round(cy + Math.sin(a) * (R - 14))))
      if (arc - ref > 6) lit++ // 自校准：弧带比同角内侧参考亮（虚线命中样本）
    }
    return { lit, seen, me: d.me, cam: d.cam, r: d.aoi ? d.aoi.r : null } })()`)
  A('V-BR-3', '视野边界弧（AOI 迷雾圈：32 角环带采样，弧带亮于同角内侧参考 ≥5 处——出圈实体即不下发的边界可视化）', vb.lit >= 5 && vb.seen >= 8, `命中=${vb.lit}/${vb.seen} me=${vb.me && vb.me.x + ',' + vb.me.y} cam=${vb.cam && vb.cam.x + ',' + vb.cam.y} r=${vb.r}`)

  /* ---------- V-BR-4 小地图信息密度 ---------- */
  const mm = await page.evaluate(`(() => { const P = ${INK}
    const dots = P.scan(8, 62, 90, 150, (r, g, b) => (r > 180 && g > 120 && g < 210 && b < 120) || (g > 150 && b > 180 && r < 140))
    const grey = P.scan(8, 62, 90, 150, (r, g, b) => r > 120 && r < 200 && g > 140 && b > 150 && r - g < 40 && g - b < 30)
    return { dots, grey } })()`)
  A('V-BR-4', '小地图信息密度（阵营双色点位+兵线灰点双通道：双色点 ≥6px + 兵线动向点 ≥4px）', mm.dots >= 6 && mm.grey >= 4, `双色点px=${mm.dots} 兵线点px=${mm.grey}`)

  /* ---------- V-SHOT-3 + V-BR-5 结算帧（mockEnd 渲染路径取证；真终局仍由 end 消息驱动） ---------- */
  await page.evaluate(() => window.__GAMES_DEBUG__.mockEnd({ winner: 'B', reason: 'core-down' }))
  await sleep(400)
  const fSet = await page.evaluate(`(() => { const P = ${INK}
    return { verdict: P.ink(0, 118, 375, 50), score: P.ink(0, 190, 375, 28), btn: P.ink(105, 318, 165, 44),
      amber: P.scan(20, 196, 140, 20, (r, g, b) => r > 195 && g > 115 && g < 205 && b < 115),
      cyan: P.scan(215, 196, 140, 20, (r, g, b) => g > 165 && b > 195 && r < 130) } })()`)
  await page.screenshot({ path: join(OUT, 'g135-settle.png') })
  A('V-SHOT-3', 'settle 帧三带墨水（胜判大字/双队战绩行/再来一局钮）', fSet.verdict > 0.03 && fSet.score > 0.02 && fSet.btn > 0.06, `大字带=${fSet.verdict} 战绩带=${fSet.score} 按钮带=${fSet.btn}`)
  A('V-BR-5', '结算页布局（双队战绩行左琥珀/右青分色 ≥6px——超时裁定前二序击杀/存塔数字 P0 13px 口径）', fSet.amber >= 6 && fSet.cyan >= 6, `A 行琥珀px=${fSet.amber} B 行青px=${fSet.cyan}`)

  /* ================= 运行时：观战导演页 ================= */
  const roomId = await page.evaluate(() => window.__GAMES_DEBUG__.state().room)
  const sp = await ctx.newPage()
  sp.on('pageerror', (e) => pageErrors.push('spec:' + e.message))
  await sp.goto(`http://127.0.0.1:${HTTPPORT}/games/multiplayer/mini-moba/index.html?gw=http://127.0.0.1:${GWPORT}&room=${roomId}&spectate=1`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await sp.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().ents > 0, null, { timeout: 20_000 })
  await sleep(3500) // 导演镜头缓推+AOI 透出
  const s0 = await sp.evaluate(() => ({ st: window.__GAMES_DEBUG__.state(), ext: window.__GAMES_DEBUG__.ext(), dir: window.__GAMES_DEBUG__.dir() }))
  A('V-SPEC-1', '观战语义落地（seat=-1 显式 spectate 入口 + ext.ack=-1）', s0.st.seat === -1 && s0.ext && s0.ext.ack === -1, `seat=${s0.st.seat} ack=${s0.ext && s0.ext.ack} aoi=${s0.dir.aoi ? s0.dir.aoi.x + ',' + s0.dir.aoi.y : 'null'}`)
  A('V-SPEC-2', '导演镜头随热点（cam 与服务端 AOI 质心距离 <200px 世界坐标，0.08 缓推已收敛）', !!s0.dir.aoi && Math.hypot(s0.dir.cam.x - s0.dir.aoi.x, s0.dir.cam.y - s0.dir.aoi.y) < 200, `cam=${s0.dir.cam.x},${s0.dir.cam.y} aoi=${s0.dir.aoi ? s0.dir.aoi.x + ',' + s0.dir.aoi.y : '-'} Δ=${s0.dir.aoi ? Math.round(Math.hypot(s0.dir.cam.x - s0.dir.aoi.x, s0.dir.cam.y - s0.dir.aoi.y)) : '-'}px`)

  /* KDA 簿记（fxProbe 合成 kill 走同一 onEvent 管线——观战收全事件流为 QA1 S5 已证） */
  await sp.evaluate(() => window.__GAMES_DEBUG__.fxProbe({ k: 'kill', killer: 4, victim: 1, assists: [2, 0], streak: 2, bounty: 150 }))
  await sleep(150)
  const kda = await sp.evaluate(() => window.__GAMES_DEBUG__.dir())
  A('V-SPEC-3', 'KDA 簿记（killer+1/victim+1/assists 各+1——观战面板数据源）', kda.kda['4'] && kda.kda['4'].k === 1 && kda.kda['1'] && kda.kda['1'].d === 1 && kda.kda['2'].a === 1 && kda.kda['0'].a === 1, `kda=${JSON.stringify(kda.kda)}`)

  /* 跟焦点轮换（真触点走输入管线：导演条「下一 ▶」钮） */
  const heroesBefore = kda.heroes
  if (heroesBefore.length) {
    await sp.touchscreen.tap(338, 650) // 下一 ▶ 钮位（btnZones 登记 x=W-37,y=H-17）
    await sleep(60)
    const f1 = await sp.evaluate(() => window.__GAMES_DEBUG__.dir())
    await sleep(1200) // 缓推至焦点
    const f2 = await sp.evaluate(() => window.__GAMES_DEBUG__.dir())
    A('V-SPEC-4', '跟焦点轮换（真触点「下一」→ focus ∈ 英雄席位且切换生效；镜头缓推）', f2.focus >= 0 && heroesBefore.includes(f2.focus), `focus: ${f1.focus} → ${f2.focus}（AOI 内英雄 ${heroesBefore.join(',')}）；cam=${f2.cam.x},${f2.cam.y}`)
    await sp.touchscreen.tap(187, 333) // 任意触点=下一焦点（观战快捷）
    await sleep(80)
    const f3 = await sp.evaluate(() => window.__GAMES_DEBUG__.dir())
    A('V-SPEC-5', '任意触点轮换（观战位点屏即切焦点——无摇杆无技能钮）', f3.focus >= 0 && f3.focus !== f2.focus, `focus: ${f2.focus} → ${f3.focus}`)
  } else {
    A('V-SPEC-4', '跟焦点轮换', false, 'AOI 内无英雄席位（少见：镜头追至空区）')
    A('V-SPEC-5', '任意触点轮换', false, '同上')
  }

  /* V-SHOT-4 观战帧（导演条+KDA 面板+小地图视口框） */
  const fSpec = await sp.evaluate(`(() => { const P = ${INK}
    const dirBar = P.ink(0, 633, 375, 34), kdaPanel = P.ink(0, 517, 375, 100)
    return { dirBar, kdaPanel } })()`)
  await sp.screenshot({ path: join(OUT, 'g135-spec.png') })
  A('V-SHOT-4', 'spec 帧（观战导演）双带墨水（导演条=模式/热点/轮换钮 + KDA 面板=A/B 两列三行）', fSpec.dirBar > 0.04 && fSpec.kdaPanel > 0.03, `导演条=${fSpec.dirBar} KDA 面板=${fSpec.kdaPanel}`)

  /* ---------- V-PERF 帧成本对照带（GAMES-118 口径） ---------- */
  const cost = await page.evaluate((ms) => new Promise((res) => { const orig = window.requestAnimationFrame.bind(window); const t = []
    window.requestAnimationFrame = (cb) => orig((ts) => { const s = performance.now(); try { cb(ts) } finally { t.push(performance.now() - s) } })
    setTimeout(() => { window.requestAnimationFrame = orig; res(t) }, ms) }), 4000)
  const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]
  const p50 = +pct(cost, 0.5).toFixed(2), p95 = +pct(cost, 0.95).toFixed(2)
  const over = +(cost.filter((c) => c > 16.7).length / cost.length).toFixed(4)
  A('V-PERF', 'perf 不降（每帧成本 p95<16.7ms 且超限帧 <2%——VIS 硬化不越带）', cost.length > 50 && p95 < 16.7 && over < 0.02, `n=${cost.length} p50=${p50} p95=${p95}ms 超16.7ms=${(over * 100).toFixed(1)}%`)

  /* ---------- V-REG ---------- */
  A('V-REG', '双页零异常（pageerror/console.error）', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  try { srv.close() } catch {}
  gw.kill()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[vis-check] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}`)
process.exit(fail.length ? 1 : 0)
