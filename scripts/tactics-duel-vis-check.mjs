#!/usr/bin/env node
/* =====================================================================
 * GAMES-124 战棋对决 视觉统一（VIS）断言工具——vis-element-duel.mjs /
 * snake-king-vis-check.mjs（GAMES-105）取证范式移植 + QA1（GAMES-119）
 * 识图口径三锚点扩容：?debug=1 离线确定性局 + 冻结帧墨水带 + 不透明字形
 * 锚点 + 运行时自证，DSF=1 截图。三帧映射：home=部署（deploy）/
 * play=行动（act）/settle=结算（end 覆层）：
 *   V-HUD-1 静态：零裸字号（ctx.font 全走 F0/F1/F2 HF 登记表；lbl 传参
 *            唯一）+ index.html DOM 字号 ≥9（boot 13/600）
 *   V-HUD-2 运行时：hudFonts() 自证 P0≥13/P1≥11/P2≥9（三帧累计在册）
 *   V-CB-1/2/3/4/5 双编码：阵营同亮度带→形状通道（A 粗描边/B 双细线
 *            运行时环探针）；兵种六字形+六底盘；地形色相+纹样；
 *            据点三角/燕尾旗；威胁标记红晕+角框双通道
 *   V-BR-1/2/3/4/5 棋盘可读性：双色微差格可分（QA1 口径）+ 三态
 *            （选中金环/路径青域/攻击红角框）+ 伤害飘字深底描边 +
 *            结算页布局（双按钮分置）+ 全量可视无小地图裁量
 *   V-SHOT-1/2/3 识图 v2 三帧（home/play/settle 字形锚点口径）
 *   V-PERF 帧成本对照带（GAMES-118 口径：rAF 包裹计时；对照 g122 基线）
 * 用法：node scripts/tactics-duel-vis-check.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-124-shots'
const BASE122 = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-122-shots/g122-base.json'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-td-'))
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
  /* ================= V-HUD-1 静态审计 ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/tactics-duel/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/(F0|F1|F2)\(/.test(l))
  const passThru = bare.filter(([, l]) => /ctx\.font\s*=\s*fnt\s*;/.test(l))
  A('V-HUD-1a', '零裸字号（ctx.font 全走 F0/F1/F2 HF 登记表；唯 lbl 助手 fnt 传参 1 处=调用点全 F0/F1/F2）', bare.length === passThru.length && passThru.length === 1, bare.length !== passThru.length ? `裸字号 L${bare.filter(([, l]) => !/ctx\.font\s*=\s*fnt\s*;/.test(l)).map(([i]) => i).join(',L')}` : `裸字号 0 处 + 传参 1 处（L${passThru[0][0]}）`)
  const html = await readFile(join(ROOT, 'games/multiplayer/tactics-duel/index.html'), 'utf8')
  const domPx = [...html.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => +m[1])
  A('V-HUD-1b', 'index.html DOM 字号零裸小字（全部 ≥9；boot 提示 13/600=P1 档）', domPx.length > 0 && domPx.every((p) => p >= 9) && /font:\s*600 13px/.test(html), `DOM px=[${domPx.join(',')}] boot=600 13px`)
  const bodyOf = (name, endMark) => src.slice(src.indexOf(`function ${name}`), src.indexOf(endMark, src.indexOf(`function ${name}`)))

  /* ================= V-CB 静态（形通道分支在册） ================= */
  const bs = bodyOf('baseShape', 'function unitOffset')
  const shapes = ['ctx.arc(x, y, r, 0, Math.PI * 2)', 'for (let i = 0; i < 8;', 'moveTo(x, y - r); ctx.lineTo(x + r, y)', 'ctx.arc(x, y, r, Math.PI, Math.PI * 2)', 'for (let i = 0; i < 6;', 'roundRect(x - r, y - r, r * 2, r * 2, r * 0.45)']
  A('V-CB-2a', '兵种底盘形状通道六形全落地（圆/八方/菱/半圆弧/六角/圆角方——色相同（阵营色）时形状=第二通道）', shapes.every((s) => bs.includes(s)), `baseShape 六路径签名在册（源码静态审计）`)
  const gl = bodyOf('glyph', 'function baseShape')
  const glN = ['sword', 'axe', 'lance', 'bow', 'mage'].filter((t) => gl.includes(`type === '${t}'`)).length
  A('V-CB-2b', '兵种六字形矢量全落地（五显式分支+医者默认十字=六字形；canvas 矢量非 emoji，DSF=1 可机读）', glN === 5, `显式分支 ${glN}/5 + healer 默认款`)
  const dt = bodyOf('drawTerrain', 'let lastT')
  const terr = [/fillStyle = FOREST/.test(dt) && /for \(const \[dx, dy\] of \[\[12, 14\], \[28, 18\], \[20, 32\]\]\)/.test(dt), /fillStyle = ROCK/.test(dt) && (dt.match(/lineTo\(p\.x \+ \d+, p\.y \+ \d+\)/g) || []).length >= 3, /fillStyle = RIVER/.test(dt) && (dt.match(/quadraticCurveTo/g) || []).length >= 2]
  A('V-CB-3a', '地形色相+纹样双通道（森林三峰树簇/岩石多边岩块/河流双曲波纹——FOREST↔RIVER luma 同带 Δ7 纹样必需）', terr.every(Boolean), `森林=3 峰簇（[[12,14],[28,18],[20,32]]）岩石多边=${(dt.match(/lineTo\(p\.x \+ \d+, p\.y \+ \d+\)/g) || []).length} 边 河流=${(dt.match(/quadraticCurveTo/g) || []).length} 曲`)
  A('V-CB-4a', '据点旗帜双形（A 三角旗 owner≠1 分支 / B 燕尾旗 owner===1 内凹双缺口分支）', /owner === 1[\s\S]{0,200}lineTo\(8, -4\)/.test(dt) && /lineTo\(15, -6\); ctx\.lineTo\(0, 0\)/.test(dt), '三角/燕尾双分支在册（源码静态审计）')
  A('V-CB-1a', '阵营形状通道（A 实心粗描边 2.6 / B 双细线 1.6+内环 0.8——琥珀/青 luma 172/162 同带 Δ10，形状=强制第二通道）', /mine \? 2\.6 : 1\.6/.test(src) && /if \(!mine\) \{ baseShape\(u\.type, cx, cy, 14\)/.test(src), '粗描边/双细线双档 + B 内环 r14 分支在册')
  A('V-CB-1b', '血条/兵力条形状通道（A 实心 / B 分段——hud-standard §3 先例）', /if \(mine\) ctx\.fillRect\(cx - bw \/ 2, p\.y \+ BOARD\.cs - 9, bw \* frac, 4\)/.test(src) && /for \(let i = 0; i < 7; i\+\+\) if \(i \/ 7 < frac\)/.test(src) && /for \(let i = 0; i < 12; i\+\+\) \{ if \(i < Math\.round\(12 \* f\[1\] \/ tot\)\)/.test(src), '单位血条 7 段/兵力对比条 12 段 B 分段分支在册')

  /* ================= 运行时（?debug=1 离线确定性局） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/tactics-duel/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })

  /* ---------- 帧探针工具（冻结帧 + 墨水带 + 像素扫描） ---------- */
  const pause = async (on) => { await page.evaluate((o) => window.__GAMES_DEBUG__.pause(o), on); await page.waitForTimeout(70) }
  const shot = (tag) => page.screenshot({ path: join(OUT, `g124-${tag}.png`) }) // DSF=1 截图（识图协议）
  const probe = (fn, ...args) => page.evaluate(fn, ...args)
  /* 墨水带：带内与主底色差异 >72 的像素占比（snake-king vis 同式） */
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

  /* ---------- V-SHOT-1 home 帧（部署期——冻结假时钟于 welcome 后第一拍） ---------- */
  await probe(() => { const D = window.__GAMES_DEBUG__; D.start(1, { seedSalt: 'vis124' }); D.pause(true) })
  await page.waitForTimeout(150)
  const fHome = await probe(`(() => { const P = ${INK}; const v = window.__GAMES_DEBUG__.state().view
    return { phase: v && v.phase,
      bands: { top: P.ink(0, 0, 375, 56), deployStrip: P.ink(6, 603, 363, 54), goBtn: P.ink(97, 549, 181, 46), board: P.ink(11, 64, 352, 352) },
      topAmber: P.scan(300, 4, 75, 28, (r, g, b) => r > 195 && g > 115 && g < 205 && b < 115),   /* 顶栏右 A 席标签 */
      topCyan: P.scan(0, 4, 75, 28, (r, g, b) => g > 165 && b > 195 && r < 130),                  /* 顶栏左 B 席标签+分 */
      cardAmber: P.scan(6, 595, 363, 66, (r, g, b) => r > 195 && g > 115 && g < 205 && b < 115) /* 兵种条 6 卡字形（我方席琥珀） */ } })()`)
  await shot('home')
  A('V-SHOT-1', 'home 帧（部署期）锚点+布局带（顶栏 A/B 席双色标签 + 兵种条/出战钮/棋盘三带墨水 + 6 卡琥珀字形）', fHome.phase === 'deploy' && fHome.topAmber >= 3 && fHome.topCyan >= 3 && fHome.bands.deployStrip > 0.05 && fHome.bands.goBtn > 0.05 && fHome.bands.board > 0.03 && fHome.cardAmber >= 20, `phase=${fHome.phase} 顶栏琥珀=${fHome.topAmber} 青=${fHome.topCyan} 兵种条=${fHome.bands.deployStrip} 出战钮=${fHome.bands.goBtn} 棋盘=${fHome.bands.board} 卡字形琥珀px=${fHome.cardAmber}`)

  /* ---------- 进 act（我方回合）→ play 帧（24x 假时钟缩墙钟：托管接敌 ~30s→~8s；calm 清横幅=冻结帧范式） ---------- */
  await probe(() => { const D = window.__GAMES_DEBUG__; D.start(1, { seedSalt: 'vis124b', timeScale: 24 }) })
  await pause(false)
  await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'act' && v.units && v.units.length > 0 && v.turn === 0 && v.ap >= 3 }, null, { timeout: 25_000 })
    .catch(() => page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'act' && v.units && v.turn === 0 && v.ap >= 1 }, null, { timeout: 10_000 }))
  await pause(true)
  /* 24x 假时钟下 waitFor→pause 间隙可耗点：ap<2 则放行至下一我方回合再冻结（≤3 次） */
  for (let i = 0; i < 3 && (await probe(() => window.__GAMES_DEBUG__.state().view.ap)) < 2; i++) {
    await pause(false)
    await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'act' && v.turn === 0 && v.ap >= 3 }, null, { timeout: 15_000 }).catch(() => {})
    await pause(true)
  }
  await probe(() => window.__GAMES_DEBUG__.fxScene('calm'))
  await page.waitForTimeout(80)
  const fPlay = await probe(`(() => { const P = ${INK}; const v = window.__GAMES_DEBUG__.state().view
    /* QA1 识图口径：双色微差格逐格分类——采样位=格左上角内衬 5,5（令牌环 r17/血条/角标均不及） */
    const PAL = { A: [42,51,61], B: [37,44,52], F: [30,58,42], R: [74,80,88], V: [34,64,90] }
    const cls = { A: 0, B: 0, F: 0, R: 0, V: 0 }; let sA = null, sB = null
    for (let c = 0; c < 64; c++) { const r = (c / 8) | 0, co = c % 8; const p = P.px(11 + co * 44 + 5, 64 + r * 44 + 5)
      let bk = null, bd = 1e9; for (const k in PAL) { const d = Math.abs(p[0]-PAL[k][0]) + Math.abs(p[1]-PAL[k][1]) + Math.abs(p[2]-PAL[k][2]); if (d < bd) { bd = d; bk = k } }
      if (bd < 24) { cls[bk]++; if (bk === 'A' && !sA) sA = p; if (bk === 'B' && !sB) sB = p } }
    const lu = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
    /* AP 灯珠（亮珠数==min(4,ap)——我方回合琥珀填色；QA1 口径第三锚，托管耗点如实计入） */
    let apLit = 0; for (let i = 0; i < 4; i++) { const p = P.px(20 + i * 22, 474); if (p[0] > 195 && p[1] > 115 && p[1] < 205 && p[2] < 115) apLit++ }
    /* 铜金格线：竖缘带内与两纯色格距均 >24 的线色像元（0.7px 线抗混叠口径） */
    const dA2 = (r, g, b) => Math.abs(r-42) + Math.abs(g-51) + Math.abs(b-61), dB2 = (r, g, b) => Math.abs(r-37) + Math.abs(g-44) + Math.abs(b-52)
    const grid = P.scan(53, 64, 6, 352, (r, g, b) => dA2(r, g, b) > 24 && dB2(r, g, b) > 24 && r > 60 && r < 130)
    return { phase: v.phase, turn: v.turn, cls, apLit, ap: v.ap, sA: sA ? +lu(sA).toFixed(1) : null, sB: sB ? +lu(sB).toFixed(1) : null, grid,
      amberN: P.scan(11, 64, 352, 352, (r, g, b) => r > 195 && g > 115 && g < 205 && b < 115),
      cyanN: P.scan(11, 64, 352, 352, (r, g, b) => g > 165 && b > 195 && r < 130),
      anchors: { apLbl: P.px(112, 470), btnHost: P.px(33, 571), btnEnd: P.px(302, 571), foot: P.px(12, 658) } } })()`)
  await shot('play')
  const gl_ = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
  const ancKeys = ['apLbl', 'btnHost', 'btnEnd']
  A('V-SHOT-2a', 'play 帧 HUD 字形锚点 4 位全亮（AP 标签/双底栏钮/页脚——不透明 chrome 恒绘=零位移口径）', ancKeys.every((k) => gl_(fPlay.anchors[k]) > 90) && gl_(fPlay.anchors.foot) > 60, ancKeys.map((k) => gl_(fPlay.anchors[k]).toFixed(0)).join('/') + ` / foot=${gl_(fPlay.anchors.foot).toFixed(0)}`)
  A('V-SHOT-2b', 'QA1 三锚点复检扩容：双色微差格两色各 ≥20 格可分（地形覆写 F/R/V 另计）+ 双色令牌 ≥25px + AP 灯珠亮数==min(4,ap)', fPlay.cls.A >= 20 && fPlay.cls.B >= 20 && fPlay.amberN >= 25 && fPlay.cyanN >= 25 && fPlay.apLit === Math.min(4, fPlay.ap) && fPlay.ap >= 1, `格 A=${fPlay.cls.A} B=${fPlay.cls.B} 林/岩/河=${fPlay.cls.F}/${fPlay.cls.R}/${fPlay.cls.V} 琥珀px=${fPlay.amberN} 青px=${fPlay.cyanN} AP亮=${fPlay.apLit}/${fPlay.ap}`)

  /* ---------- V-BR-1 棋盘格可读性（微差+格线） ---------- */
  const br = { dA: fPlay.sA != null && fPlay.sB != null ? Math.abs(fPlay.sA - fPlay.sB) : 999, lumaA: fPlay.sA, lumaB: fPlay.sB, grid: fPlay.grid }
  A('V-BR-1', '棋盘双色微差格（实测格样 luma Δ∈[2,30] 微差不喧宾 + 铜金格线 ≥120px 可分结构）', br.dA >= 2 && br.dA <= 30 && br.grid >= 120, `Δluma=${br.dA.toFixed(1)}（A 格 ${br.lumaA}/B 格 ${br.lumaB}）格线px=${br.grid}`)

  /* ---------- V-CB-1c 阵营环结构运行时探针（B 内环 vs A 无内环） ---------- */
  const cb1 = await probe(`(() => { const P = ${INK}; const v = window.__GAMES_DEBUG__.state().view
    /* 0.8px 内环抗混叠：四半径×16 角采样取最大命中（青=B 内环应有、琥珀=A 无内环）；
     * 内带跳过低部角（|sin|>0.6）——濒死红血条位于 cy+13..17 会假阳 */
    const ringHit = (u, isB) => { const ox = 11 + (u.cell % 8) * 44 + 22, oy = 64 + ((u.cell / 8) | 0) * 44 + 22
      const best = { 17: 0, 14: 0 }
      for (const rad of [17, 16.6]) for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8
        const p = P.px(Math.round(ox + Math.cos(a) * rad), Math.round(oy + Math.sin(a) * rad))
        if (isB ? (p[1] > 140 && p[2] > 170 && p[0] < 120) : (p[0] > 195 && p[1] > 115 && p[1] < 205 && p[2] < 115)) best[17]++ }
      for (const rad of [13.4, 13.9, 14.4, 14.9]) for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8
        if (Math.abs(Math.sin(a)) > 0.6) continue
        const p = P.px(Math.round(ox + Math.cos(a) * rad), Math.round(oy + Math.sin(a) * rad))
        if (isB ? (p[2] - p[0] > 40 && p[1] - p[0] > 25 && p[1] > 100 && p[0] < 140) : (p[0] - p[2] > 60 && p[0] > 160)) best[14]++ }
      return best }
    const aU = v.units.find((u) => u.seat === 0), bU = v.units.find((u) => u.seat === 1)
    const A2 = aU ? ringHit(aU, false) : null, B2 = bU ? ringHit(bU, true) : null
    return { a17: A2 ? A2[17] : -1, a14: A2 ? A2[14] : -1, b17: B2 ? B2[17] : -1, b14: B2 ? B2[14] : -1 } })()`)
  A('V-CB-1c', '阵营环结构运行时探针（B 双细线=外环 r17 命中+内环 r14 带命中 ≥2；A 粗描边=外环命中内环带 ≤1——灰度同带下形状可辨）', cb1.a17 >= 4 && cb1.a14 <= 1 && cb1.b17 >= 4 && cb1.b14 >= 2, `A 外/内带=${cb1.a17}/${cb1.a14} B 外/内带=${cb1.b17}/${cb1.b14}（外环 2 半径×16 角/内带 4 半径×16 角）`)

  /* ---------- V-CB-5 威胁标记双通道（选敌=红晕域+红环） ---------- */
  await probe(`(() => { window.__GAMES_DEBUG__.fxScene('select-foe') })()`)
  await page.waitForTimeout(160)
  const th = await probe(`(() => { const P = ${INK}; const v = window.__GAMES_DEBUG__.state().view
    const e = v.units.find((x) => x.seat !== 0); if (!e) return { ok: false }
    const ex = 11 + (e.cell % 8) * 44 + 22, ey = 64 + ((e.cell / 8) | 0) * 44 + 22
    const ring = P.scan(ex - 26, ey - 26, 52, 52, (r, g, b) => r > 150 && r - g > 90)          // 敌选红脉冲环（0.9α）
    const veil = P.scan(11, 64, 352, 352, (r, g, b) => r > 95 && r - g > 40 && r - b > 40)     // 全盘红晕域（域框 0.35α 缘+脉冲填充）
    return { ok: true, ring, veil, f15: window.__GAMES_DEBUG__.fxLedger().find((x) => x.id === 'F15') } })()`)
  await shot('threat')
  A('V-CB-5', '威胁标记双通道（红脉冲环 ≥20px + 红晕域框 ≥60px——红 hue×角框/域两形；色弱下亮度对比亦异于青/金态）', th.ok && th.ring >= 20 && th.veil >= 60, th.ok ? `红环=${th.ring} 红晕=${th.veil} F15=${th.f15 && th.f15.lat}ms` : '无敌方单位')

  /* ---------- V-BR-2 三态区分（真触点选单位→选中金环/路径青域/攻击红角框+预演字） ---------- */
  let sel = null
  const roundStats = []
  /* 接敌驱动器：冻结态下 sendOp 即 offlineApply（同步落 ruling）——择可达域内最近敌格走子，
   * 每步后复扫 atkTargets（moved 态可攻击）；AP/回合耗尽则交还外层放行推进 */
  const drive = `(() => { const D = window.__GAMES_DEBUG__, SIM = window.TDuelSim
    const v0 = D.state().view
    if (!v0 || v0.phase !== 'act' || v0.turn !== 0) return { why: 'not-my-turn' }
    const mdist = (a, b) => Math.abs(((a / 8) | 0) - ((b / 8) | 0)) + Math.abs(a % 8 - b % 8)
    let moves = 0
    for (let guard = 0; guard < 8; guard++) {
      const v = D.state().view
      if (!v || v.phase !== 'act' || v.turn !== 0) return { why: 'turn-ended', moves }
      const foes = v.units.filter((x) => x.seat === 1)
      if (!foes.length) return { why: 'no-foes', moves }
      for (const u of v.units) { if (u.seat !== 0 || u.ph === 'done') continue
        try { const t = SIM.atkTargets(v, u.id); if (t.length > 0) return { found: { unit: u.id, tgt: t[0] }, moves } } catch (e) { return { why: 'err ' + e, moves } } }
      let best = null
      for (const u of v.units) { if (u.seat !== 0 || u.ph === 'done') continue
        let dom; try { dom = SIM.reach(v, u.id) } catch { continue }
        for (const d of dom) { if (d.path.length < 2) continue
          for (const f of foes) { const dd = mdist(d.cell, f.cell)
            if (!best || dd < best.dd || (dd === best.dd && d.path.length < best.path.length)) best = { unit: u.id, path: d.path, dd, foe: f.id } } } }
      if (!best) return { why: 'no-moves', moves }
      D.sendOp({ k: 'move', unit: best.unit, path: best.path }); moves++
    }
    return { why: 'guard-out', moves } })()`
  for (let round = 0; round < 8 && !sel; round++) {
    const r = await probe(drive)
    if (r && r.found) { sel = r.found; break }
    const st = await probe(`(() => { const v = window.__GAMES_DEBUG__.state().view
      let minD = 99; for (const a of (v.units || [])) if (a.seat === 0) for (const b of (v.units || [])) if (b.seat === 1) minD = Math.min(minD, Math.abs((a.cell/8|0)-(b.cell/8|0)) + Math.abs(a.cell%8-b.cell%8))
      return 'turn' + v.turnNo + ' ap' + v.ap + ' 最近敌曼距' + minD + ' units' + (v.units || []).length })()`)
    roundStats.push(`R${round + 1}:${(r && r.why) || 'ok'}${r && r.moves != null ? '+drive' + r.moves : ''}/${st}`)
    await pause(false); await page.waitForTimeout(3000) // 放行（bot+托管推进战线）再择我方回拍冻结
    await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'act' && v.turn === 0 && v.units.some((u) => u.seat === 0 && u.ph !== 'done') }, null, { timeout: 5000 }).catch(() => {})
    await pause(true)
  }
  if (sel) {
    await probe(`(() => { const D = window.__GAMES_DEBUG__; D.fxScene('calm') })()`)
    const cellPt = await probe((a) => { const v = window.__GAMES_DEBUG__.state().view; const u = v.units.find((x) => x.id === a.unit)
      const xy = (c) => ({ x: 11 + (c % 8) * 44, y: 64 + ((c / 8) | 0) * 44 }); const p = xy(u.cell)
      const t = v.units.find((x) => x.id === a.tgt)
      return { tap: [p.x + 22, p.y + 22], cell: u.cell, tcell: t ? t.cell : -1 } }, { unit: sel.unit, tgt: sel.tgt })
    await page.touchscreen.tap(cellPt.tap[0], cellPt.tap[1]) // 真触点走输入管线（fxSelect+S.sel）
    await page.waitForTimeout(160)
    const tri = await probe(`((cellPt) => { const P = ${INK}; const SIM = window.TDuelSim, v = window.__GAMES_DEBUG__.state().view
      let u = null; for (const x of v.units) { if (x.seat !== 0 || x.ph === 'done') continue; try { if (SIM.atkTargets(v, x.id).length > 0) { u = x; break } } catch {} }
      if (!u) return { ok: false }
      const cx = 11 + (cellPt.cell % 8) * 44 + 22, cy = 64 + ((cellPt.cell / 8) | 0) * 44 + 22
      /* 选中金环：令牌外脉冲环带（r18-27）金像元 */
      const gold = P.scan(cx - 27, cy - 27, 54, 54, (r, g, b) => r > 220 && g > 175 && b < 160)
      /* 路径青域：可达域末格（≠自身、无驻单位）内青调像元（域填充+虚线缘） */
      const dom = SIM.reach(v, u.id).filter((d) => d.path.length > 1 && !v.units.some((z) => z.cell === d.cell))
      let cyanDom = 0, domCell = -1
      if (dom.length) { const d0 = dom[dom.length - 1]; domCell = d0.cell; const dx = 11 + (d0.cell % 8) * 44, dy = 64 + ((d0.cell / 8) | 0) * 44
        cyanDom = P.scan(dx + 1, dy + 1, 42, 42, (r, g, b) => b - r > 25 && g - r > 15) }
      /* 攻击红角框：目标格四角红像元 + 预演字带（格上 -N 深底描边） */
      const tc = cellPt.tcell, tx = 11 + (tc % 8) * 44, ty = 64 + ((tc / 8) | 0) * 44
      const corner = P.scan(tx, ty, 44, 44, (r, g, b) => r > 185 && g < 130 && r - g > 80)
      const preview = P.scan(tx - 4, ty - 17, 52, 15, (r, g, b) => r > 185 && g < 130 && r - g > 80)
      return { ok: true, gold, cyanDom, domCell, corner, preview } })(${JSON.stringify(cellPt)})`)
    await shot('tristate')
    A('V-BR-2', '三态视觉区分（选中=金脉冲环 ≥18px / 路径=青域+虚线 ≥15px / 攻击=红角框 ≥25px+预演字 ≥8px——三色相×三形双通道）', tri.ok && tri.gold >= 18 && tri.cyanDom >= 15 && tri.corner >= 25 && tri.preview >= 8, tri.ok ? `金环=${tri.gold} 青域=${tri.cyanDom}（格${tri.domCell}）红角框=${tri.corner} 预演字=${tri.preview}` : '无可攻单位（bot 未接敌）')

    /* ---------- V-BR-3 伤害飘字可读性（深底描边=本单硬化） ---------- */
    await probe((o) => window.__GAMES_DEBUG__.fxProbe({ k: 'attack', unit: o.unit, tgt: o.tgt, dmg: 7 }), sel)
    await page.waitForTimeout(230) // 飘字 t0=事件后 120ms 落笔，230ms 处于前段高不透明窗
    const fl = await probe(`((tc) => { const P = ${INK}; const tx = 11 + (tc % 8) * 44 + 22, ty = 64 + ((tc / 8) | 0) * 44 + 22
      const red = P.scan(tx - 32, ty - 36, 64, 38, (r, g, b) => r > 185 && g < 130 && r - g > 80)
      const dark = P.scan(tx - 32, ty - 36, 64, 38, (r, g, b) => r < 40 && g < 40 && b < 48) // 3px 深底描边 #10151B
      const f05 = window.__GAMES_DEBUG__.fxLedger().find((e) => e.id === 'F05')
      return { red, dark, lat: f05 ? f05.lat : null } })(${JSON.stringify(cellPt.tcell)})`)
    await shot('dmgfloat')
    A('V-BR-3', '伤害飘字可读性（红字 ≥22px + 深底描边 ≥6px 双通道；F05 首绘台账在册）', fl.red >= 22 && fl.dark >= 6 && fl.lat != null, `红=${fl.red} 深底描边=${fl.dark} F05=${fl.lat}ms（19px/600≥P0 13 红线）`)
    await probe(`(() => { window.__GAMES_DEBUG__.fxScene('calm') })()`)
  } else {
    A('V-BR-2', '三态视觉区分（选中/路径/攻击）', false, `重试 8 轮（含接敌驱动）未出现可攻接敌态——如实红。逐轮观测：${roundStats.join(' | ') || '无'}`)
    A('V-BR-3', '伤害飘字可读性', false, '依赖三态场景——同上未达')
  }

  await probe(`(() => { window.__GAMES_DEBUG__.fxScene('calm') })()`)

  /* ---------- V-SHOT-3 + V-BR-4 结算帧（F14 落定后冻结） ---------- */
  await probe(`(() => { window.__GAMES_DEBUG__.fxScene('settle') })()`)
  await page.waitForTimeout(650)
  const fSet = await probe(`(() => { const P = ${INK}
    return { verdict: P.ink(0, 96, 375, 84), rows: P.ink(0, 210, 375, 130), btns: P.ink(35, 530, 305, 70), gap: P.ink(172, 543, 31, 44),
      amberBtn: P.scan(38, 535, 136, 60, (r, g, b) => r > 195 && g > 115 && g < 205 && b < 115),
      cyanBtn: P.scan(203, 535, 136, 60, (r, g, b) => g > 165 && b > 195 && r < 130) } })()`)
  await shot('settle')
  A('V-SHOT-3', 'settle 帧（结算覆层）三带墨水（胜判大字/战报三行+评语/双钮）', fSet.verdict > 0.04 && fSet.rows > 0.03 && fSet.btns > 0.06, `大字带=${fSet.verdict} 战报带=${fSet.rows} 按钮带=${fSet.btns}`)
  A('V-BR-4', '结算页布局（双按钮 130×56 分置间隔带墨水 <0.03 + 左琥珀/右青描边分色 ≥8px——F0 34 大字/F0 13 战报行口径）', fSet.gap < 0.03 && fSet.amberBtn >= 8 && fSet.cyanBtn >= 8, `间隔带=${fSet.gap} 左钮琥珀px=${fSet.amberBtn} 右钮青px=${fSet.cyanBtn}`)

  /* ---------- V-BR-5 小地图裁量（全量可视） ---------- */
  A('V-BR-5', '小地图裁量：N/A——8×8×44px 棋盘 352×352 全量入视口（11+352≤375/64+352≤667）无信息压缩需求；源无 minimap 代码', 11 + 352 <= 375 && 64 + 352 <= 667 && !/minimap|小地图/i.test(src), `BOARD=${11},${64},352×352 全可视；minimap 代码 0 处`)

  /* ---------- V-HUD-2 hudFonts 运行时自证（三帧累计） ---------- */
  const hf = await probe(() => window.__GAMES_DEBUG__.hudFonts())
  const minPx = (c) => hf[c] && hf[c].minPx
  A('V-HUD-2', 'hudFonts 运行时自证（HF 落笔即登记：P0≥13/P1≥11/P2≥9，三帧样本在册）', minPx('P0') >= 13 && minPx('P1') >= 11 && minPx('P2') >= 9 && hf.P0.samples > 0 && hf.P1.samples > 0 && hf.P2.samples > 0, `P0=${minPx('P0')}（n=${hf.P0.samples}）P1=${minPx('P1')}（n=${hf.P1.samples}）P2=${minPx('P2')}（n=${hf.P2.samples}）`)

  /* ---------- V-PERF 帧成本对照带（GAMES-118 口径） ---------- */
  await probe(`(() => { window.__GAMES_DEBUG__.fxScene('calm') })()`)
  await pause(false)
  const cost = await page.evaluate((ms) => new Promise((res) => { const orig = window.requestAnimationFrame.bind(window); const t = []
    window.requestAnimationFrame = (cb) => orig((ts) => { const s = performance.now(); try { cb(ts) } finally { t.push(performance.now() - s) } })
    setTimeout(() => { window.requestAnimationFrame = orig; res(t) }, ms) }), 4000)
  const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]
  const p50 = +pct(cost, 0.5).toFixed(2), p95 = +pct(cost, 0.95).toFixed(2), mx = +Math.max(...cost).toFixed(2)
  const over = +(cost.filter((c) => c > 16.7).length / cost.length).toFixed(4)
  let bandDetail = '无 g122 基线'
  let bandOk = true
  try { const b = JSON.parse(await readFile(BASE122, 'utf8')); if (b.band) { bandOk = p95 <= Math.max(b.band.p95 * 1.5, b.band.p95 + 2); bandDetail = `基线 p50/p95=${b.band.p50}/${b.band.p95}ms → 本单 ${p50}/${p95}ms` } } catch {}
  A('V-PERF', 'perf 不降（每帧成本 p95<16.7ms 且超限帧 <2%；对照 GAMES-122 基线带 ≤max(×1.5,+2ms)——VIS 硬化不越带）', p95 < 16.7 && over < 0.02 && bandOk, `n=${cost.length} p50=${p50} p95=${p95} max=${mx} 超16.7ms=${(over * 100).toFixed(1)}%；${bandDetail}`)

  /* ---------- V-SYNC / V-REG ---------- */
  const gameJson = JSON.parse(await readFile(join(ROOT, 'games/multiplayer/tactics-duel/game.json'), 'utf8'))
  A('V-SYNC', '版本位一致（client 页脚/boot=game.json）', src.includes(`v${gameJson.version} ·`) && src.includes(`version: '${gameJson.version}'`), `game.json=${gameJson.version}`)
  A('V-REG', '页面零异常（pageerror）', pageErrors.length === 0, pageErrors.join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  server.kill(); await rm(dataDir, { recursive: true, force: true }); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[vis-check] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}`)
process.exit(fail.length ? 1 : 0)
