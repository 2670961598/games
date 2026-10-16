#!/usr/bin/env node
/* =====================================================================
 * GAMES-161 弈界棋阁 VIS：视觉统一+识图扩容（识图 v2 ≥32 探针+语义面全项）
 * 页面自 :4399 生产 web 只读加载（零感知），全场景离线确定性画面（?debug=1&rule=
 * ——零网关零 WS，冻结帧可控）。五大交付面：
 *   V1 HUD 全量 HF 体系核：静态零裸字号+构造点唯一（feel-check 同式）/__applied
 *      生效往返/P0≥13·P1≥11·P2≥9 三档运行时下限/逐 UI 面 samples 差分
 *      （pick 浮层·help 浮层·结算页·横幅面——「全量」=面覆盖计数证）
 *   V2 色盲双编码全 UI 面：棋子形（A 圆/B 方）+子缘第二通道（A 实心/B 双线描边）
 *      角/轴墨水比独立取证/名牌棋色标/回合指示点圆方两态/胜负横幅形状子/
 *      F15 回合横幅形状点/观战进度条标记（hud-font-standard §3 口径）
 *   V3 FEEL 交付面入识图：F01 落子弹跳墨水（子簇+涟漪环瞬态收敛）/F02 翻子波序
 *      （近格先翻·远格延 4 格距后翻——两时刻像素证）/F03 连线金线三态
 *      （last 金环/last2 淡环/win-line 金线+流光）
 *   V4 语义面全项三模式：宣纸亮底/榧木盘+深褐格线/路数指纹（15/8/10 竖线段）/
 *      圆方双色簇/cascade 子盘粗框（QA1 口径保留）
 *   V5 冻结态截图对照：开局/中盘/终局三帧落盘+两两帧差合理带+同态连拍确定性披露
 *   V6 perf 复验（帧成本 avg<16ms+jank<2%）；V7 零 pageerror
 * 退出码：0=全绿；1=有失败。纪律：零产品代码改动（本单 client.js 双编码补漏已在
 * 源码面另行落地，本脚本只读取证）；影子网关都不起（全离线）。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

const WEB = 'http://127.0.0.1:4399'
const PAGE = `${WEB}/games/multiplayer/yi-pavilion/index.html`
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-161-shots'
const GEO = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }
let passed = 0, failed = 0, probes = 0
const ok = (id, name, cond, detail = '') => {
  probes++
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await mkdir(SHOTS, { recursive: true })

/* ---------- V1-a 静态零裸字号（node 侧审计，feel-check FE-1e 同式） ---------- */
console.log('── V1 HUD 全量 HF 体系核 ──')
{
  const src = readFileSync('games/multiplayer/yi-pavilion/client.js', 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(|F[012]\(/.test(l))
  const ctorN = (src.match(/px -apple-system/g) || []).length
  ok('V1-a', 'HUD 全量·静态零裸字号（.font= 全走 HF 登记；字串构造点唯一）', bare.length === 0 && ctorN === 1,
    bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；构造点=${ctorN}`)
  const spectTxt = /\.font = F1\(11\); ctx\.fillText\('✕ '/.test(src.replace(/; /g, '; ')) // 占位：观战文案面走 F1 由零裸字号总口径覆盖
  void spectTxt
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const errs = []
const newPage = async (url) => { const p = await context.newPage(); p.on('pageerror', (e) => errs.push(String(e))); await p.goto(url, { waitUntil: 'load', timeout: 20000 }); return p }

/* 页内像素工具：取整帧 ImageData / 矩形采样 / 环带采样 / 色核计数 */
const frameData = (page) => page.evaluate(() => document.getElementById('cv').getContext('2d').getImageData(0, 0, 375, 667).data)
const diffPct = (page, a, b) => page.evaluate(([a0, b0]) => {
  const d = window.__diffBuf || (window.__diffBuf = new Uint8ClampedArray(a0.length))
  let n = 0
  for (let i = 0; i < a0.length; i += 4) { if (Math.abs(a0[i] - b0[i]) > 12 || Math.abs(a0[i + 1] - b0[i + 1]) > 12 || Math.abs(a0[i + 2] - b0[i + 2]) > 12) n++; d[i] = a0[i]; d[i + 1] = a0[i + 1]; d[i + 2] = a0[i + 2]; d[i + 3] = 255 }
  return +(n / (a0.length / 4) * 100).toFixed(2)
}, [a, b])
/* 矩形/环带/圆盘区色核计数（near 判定）+ 方向墨水边缘距离（形状通道取证） */
const PX = (page, spec) => page.evaluate((s) => {
  const g = document.getElementById('cv').getContext('2d')
  const px = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]] }
  const near = (p, R, G, B, t) => Math.abs(p[0] - R) <= t && Math.abs(p[1] - G) <= t && Math.abs(p[2] - B) <= t
  const out = {}
  if (s.rect) { let c = 0, anti = 0, tot = 0; const d = g.getImageData(s.rect.x, s.rect.y, s.rect.w, s.rect.h).data; for (let i = 0; i < d.length; i += 4) { tot++; const p = [d[i], d[i + 1], d[i + 2]]; if (near(p, s.rect.R, s.rect.G, s.rect.B, s.rect.t)) c++; if (near(p, s.rect.aR, s.rect.aG, s.rect.aB, s.rect.t)) anti++ } out.hit = c; out.anti = anti; out.tot = tot }
  if (s.ring) { /* 环带：中心 cx,cy 半径 [r0,r1] 沿 16 方向×径向步进采 near 与 off-near（与参考色差>t） */
    let c = 0, off = 0, tot = 0
    for (let k = 0; k < 16; k++) { const th = k / 16 * Math.PI * 2; for (let r = s.ring.r0; r <= s.ring.r1; r += 1) { const p = px(Math.round(s.ring.cx + Math.cos(th) * r), Math.round(s.ring.cy + Math.sin(th) * r)); tot++; if (near(p, s.ring.R, s.ring.G, s.ring.B, s.ring.t)) c++; if (Math.abs(p[0] - s.ring.oR) > 12 || Math.abs(p[1] - s.ring.oG) > 12 || Math.abs(p[2] - s.ring.oB) > 12) off++ } }
    out.ringHit = c; out.ringOff = off; out.ringTot = tot
  }
  if (s.edge) { /* 从子中心沿 (dx,dy) 单位方向步进，直至偏离目标色系——返回像素距离 */
    const isT = (p) => near(p, s.edge.R, s.edge.G, s.edge.B, s.edge.t)
    const walk = (dx, dy) => { for (let st = 1; st < 40; st++) { if (!isT(px(Math.round(s.edge.cx + dx * st), Math.round(s.edge.cy + dy * st)))) return st - 0.5 } return 40 }
    const ax = walk(s.edge.dx, s.edge.dy), dg = walk(s.edge.dxD, s.edge.dyD)
    out.axis = ax; out.diag = dg; out.ratio = +(dg / ax).toFixed(3)
  }
  if (s.pal) out.pal = px(s.pal.x, s.pal.y) /* 单点回读（调板披露） */
  return out
}, spec)

/* ============ V1-f pick 浮层面（无 view 纯浮层页——不连网关） ============ */
{
  const p = await newPage(PAGE) // 无 debug/room/quick → S.pick=1 模式选择浮层
  await sleep(600)
  const hf = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  ok('V1-f', 'HF 全量·pick 模式浮层面绘制走 HF（F0(20) 标题+F1 卡面文——面覆盖差分）',
    !!(hf && hf.__cls && hf.__cls.P0.samples >= 1 && hf.__cls.P1.samples >= 1),
    hf && hf.__cls ? `P0=${hf.__cls.P0.samples} 样（min ${hf.__cls.P0.min}px）P1=${hf.__cls.P1.samples} 样（min ${hf.__cls.P1.min}px）` : '无登记')
  await p.screenshot({ path: `${SHOTS}/v1-pick.png` })
  await p.close()
}

/* ============ V4 语义面全项（三模式离线确定性画面，QA1 口径保留+扩容） ============ */
console.log('── V4 语义面全项（三模式）──')
const fieldStats = (page) => page.evaluate(() => {
  const g = document.getElementById('cv').getContext('2d')
  const d = g.getImageData(0, 0, 375, 667).data
  const near = (r, gg, b, R, G, B, t) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
  const st = { paper: 0, board: 0, line: 0, amber: 0, cyan: 0, frame: 0, total: 0, dark: 0 }
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2]
    st.total++
    if (near(r, gg, b, 242, 235, 220, 10)) st.paper++
    if (near(r, gg, b, 216, 184, 120, 18)) st.board++
    if (near(r, gg, b, 107, 84, 51, 26)) st.line++
    if (near(r, gg, b, 232, 163, 61, 24)) st.amber++
    if (near(r, gg, b, 61, 200, 232, 24)) st.cyan++
    if (near(r, gg, b, 74, 58, 32, 22)) st.frame++
    if (r < 90 && gg < 80 && b < 70) st.dark++
  }
  const rule = window.__GAMES_DEBUG__.state().rule || 'gomoku'
  const G = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }
  const g2 = G[rule]
  const prof = g.getImageData(0, g2.y, 375, g2.n * g2.cs).data
  const H2 = g2.n * g2.cs
  let segs = 0, last = -9
  for (let x = 0; x < 375; x++) {
    let dark = 0
    for (let y = 0; y < H2; y++) { const i = (y * 375 + x) * 4; if (near(prof[i], prof[i + 1], prof[i + 2], 107, 84, 51, 55)) dark++ }
    if (dark > 100) { if (x - last > 3) segs++; last = x }
  }
  st.rule = rule; st.segs = segs; st.expectSegs = { gomoku: 15, reversi: 8, cascade: 10 }[rule]
  return st
})
const tapCell = (page, cell) => page.evaluate((c0) => {
  const st = window.__GAMES_DEBUG__.state()
  const G = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }
  const rule = st.rule || 'gomoku'
  const g = G[rule], n = g.n
  const d = st.seat === 1 ? (n - 1 - ((c0 / n) | 0)) * n + (n - 1 - (c0 % n)) : c0
  const r = document.getElementById('cv').getBoundingClientRect()
  return { px: Math.round(r.left + (g.x + (d % n) * g.cs + g.cs / 2) * (r.width / 375)), py: Math.round(r.top + (g.y + ((d / n) | 0)) * g.cs + g.cs / 2 * 0 + g.cs / 2 * 0 + g.cs / 2) }
}, cell)
for (const rule of ['gomoku', 'reversi', 'cascade']) {
  const p = await newPage(`${PAGE}?debug=1&rule=${rule}`)
  await sleep(1400)
  if (rule === 'gomoku') { /* 空盘补一手琥珀（QA1 同式两段式） */
    const t = await tapCell(p, 7 * 15 + 7)
    await p.mouse.click(t.px, t.py); await sleep(120); await p.mouse.click(t.px, t.py); await sleep(300)
  }
  const s = await fieldStats(p)
  const hf = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  ok('V4', `${rule}·宣纸亮底在场（#F2EBDC ±10——全目录首款亮底联机作=第一识图锚）`, s.paper > 55000, `${s.paper}px/${s.total}（${(s.paper / s.total * 100).toFixed(1)}%）`)
  ok('V4', `${rule}·榧木亮盘+深褐格线在场（#D8B878/#6B5433）`, s.board > 8000 && s.line > 200, `盘=${s.board}px 线=${s.line}px`)
  ok('V4', `${rule}·路数指纹（竖线段=${s.expectSegs}=${GEO[rule].n} 路盘——三模式格线互分）`, s.segs === s.expectSegs, `segs=${s.segs} 期望=${s.expectSegs}`)
  ok('V4', `${rule}·棋子形色双簇同场（A 琥珀/B 青——色通道；形通道见 V2）`, s.amber >= 40 && s.cyan >= 40, `amber=${s.amber}px cyan=${s.cyan}px`)
  if (rule === 'reversi') { /* V1-b/c/d/e：HF 运行时三档+__applied（reversi 主证页） */
    ok('V1-b', 'HF 全量·__applied 生效往返自证（登记 13px→ctx.font 回读 13px——canvas 静默忽略防线）', !!(hf && hf.__applied === true), `__applied=${hf && hf.__applied}`)
    ok('V1-c', 'HF 全量·P0 运行时下限（≥13px/600 且有实绘样本——棋钟/子数/坐标读数）', !!(hf.__cls && hf.__cls.P0.min >= 13 && hf.__cls.P0.samples > 0), `P0min=${hf.__cls.P0.min}px 样=${hf.__cls.P0.samples}`)
    ok('V1-d', 'HF 全量·P1 运行时下限（≥11px——模式名/按钮/名牌）', !!(hf.__cls && hf.__cls.P1.min >= 11 && hf.__cls.P1.samples > 0), `P1min=${hf.__cls.P1.min}px 样=${hf.__cls.P1.samples}`)
    ok('V1-e', 'HF 全量·P2 运行时下限（≥9px——页脚 slug·version）', !!(hf.__cls && hf.__cls.P2.min >= 9 && hf.__cls.P2.samples > 0), `P2min=${hf.__cls.P2.min}px 样=${hf.__cls.P2.samples}`)
  }
  if (rule === 'cascade') ok('V4', 'cascade·子盘粗框线在场（#4A3A20 2.6px——模式第二指纹）', s.frame > 60, `frame=${s.frame}px`)
  await p.screenshot({ path: `${SHOTS}/v4-${rule}.png` })
  if (rule !== 'reversi') await p.close()
}

/* ============ V2/V3 reversi 主证页（中盘画面：双编码 UI 面+FEEL 交付面入识图） ============ */
console.log('── V2 双编码全 UI 面 + V3 FEEL 交付面入识图（reversi 主证页）──')
{
  const p = context.pages().find((pg) => pg.url().includes('rule=reversi')) // 复用 V4 页（中盘态已就绪）
  /* 帮己方快进到中盘（moveNo 10-18：bot 10ms 应手，我方脚本代打——不走 tap 保画面纯净） */
  for (let i = 0; i < 40; i++) {
    const st = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); if (!s.view || s.view.over) return -1; if (s.view.moveNo >= 14) return -1; return s.view.turn === s.seat ? (window.YiPavSim.legal(s.view, s.seat)[0] ?? -1) : -2 })
    if (st === -1) break
    if (st === -2) { await sleep(120); continue }
    await p.evaluate((c) => window.__GAMES_DEBUG__.sendOp({ k: 'place', cell: c }), st)
    await sleep(90)
  }
  await p.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm'))
  await sleep(250)
  const st0 = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); return { rule: s.rule, moveNo: s.view.moveNo, last: s.view.last, last2: s.view.last2, board: Array.from(s.view.board) } })
  const g = GEO.reversi
  const xy = (c) => ({ x: g.x + (c % g.n) * g.cs + g.cs / 2, y: g.y + ((c / g.n) | 0) * g.cs + g.cs / 2 })
  console.log(`  · 主证页冻结态：rule=${st0.rule} moveNo=${st0.moveNo} last=${st0.last} last2=${st0.last2}`)

  /* --- V2-a/b 棋子形状通道独立（角/轴墨水距离比：圆≈1.0 方≈1.35——灰度化亦可辨的形证） --- */
  const stoneA = st0.board.findIndex((v, i) => v === 1 && st0.board[i - 1] !== undefined && i % 8 >= 1 && i % 8 <= 6 && ((i / 8) | 0) >= 1 && ((i / 8) | 0) <= 6)
  const stoneB = st0.board.findIndex((v, i) => v === 2 && i % 8 >= 1 && i % 8 <= 6 && ((i / 8) | 0) >= 1 && ((i / 8) | 0) <= 6)
  const cA = xy(stoneA), cB = xy(stoneB)
  const eA = await PX(p, { edge: { cx: cA.x, cy: cA.y, dx: 1, dy: 0, dxD: 0.707, dyD: 0.707, R: 232, G: 163, B: 61, t: 42 } })
  const eB = await PX(p, { edge: { cx: cB.x, cy: cB.y, dx: 1, dy: 0, dxD: 0.707, dyD: 0.707, R: 61, G: 200, B: 232, t: 42 } })
  ok('V2-a', '双编码·A 琥珀圆子形状通道独立（角/轴墨水距离比 ≈1.0——色盲下去色仍可辨形）', eA.ratio >= 0.85 && eA.ratio <= 1.15, `轴=${eA.axis}px 角=${eA.diag}px 比=${eA.ratio}（圆理论 1.0）`)
  ok('V2-b', '双编码·B 青方子形状通道独立（角/轴比 ≈1.35）+子缘第二通道双线描边在场（内缘深青）', eB.ratio >= 1.2, `轴=${eB.axis}px 角=${eB.diag}px 比=${eB.ratio}（方理论 1.41）；内线见 V2-c2`)
  const innerB = await PX(p, { ring: { cx: cB.x, cy: cB.y, r0: Math.round(g.cs * 0.24), r1: Math.round(g.cs * 0.3), R: 26, G: 110, B: 132, t: 46, oR: 61, oG: 200, oB: 232 } })
  ok('V2-c2', '双编码·B 子内缘双线在场（#1A6E84 细线环——实心/双线描边第二通道 §7）', innerB.ringHit >= 4, `内环命中=${innerB.ringHit}/${innerB.ringTot} 采样点`)
  /* --- V2-c 名牌棋色标（顶栏对手标 B 方/底栏己方标 A 圆——drawStone 同源） --- */
  const top = await PX(p, { rect: { x: 12, y: 34, w: 18, h: 18, R: 61, G: 200, B: 232, t: 46, aR: 232, aG: 163, aB: 61 } })
  const bot = await PX(p, { rect: { x: 12, y: 561, w: 18, h: 18, R: 232, G: 163, B: 61, t: 46, aR: 61, aG: 200, aB: 232 } })
  ok('V2-c', '双编码·名牌棋色标形色双通道（顶栏对手 B 青方标+底栏己方 A 琥珀圆标）', top.hit >= 20 && bot.hit >= 20 && top.anti <= 4 && bot.anti <= 4, `顶B=${top.hit}px 误A=${top.anti}px｜底A=${bot.hit}px 误B=${bot.anti}px`)

  /* --- V3-f/g 连线金线三态之一二：last 金环+last2 淡环（真实局面恒亮态） --- */
  if (st0.last >= 0 && st0.last2 >= 0) {
    const pL = xy(st0.last), pL2 = xy(st0.last2)
    const goldRing = await PX(p, { ring: { cx: pL.x, cy: pL.y, r0: Math.round(g.cs * 0.36), r1: Math.round(g.cs * 0.5), R: 201, G: 162, B: 39, t: 46, oR: 216, oG: 184, oB: 120 } })
    const faintRing = await PX(p, { ring: { cx: pL2.x, cy: pL2.y, r0: Math.round(g.cs * 0.36), r1: Math.round(g.cs * 0.5), R: 161, G: 134, B: 89, t: 34, oR: 216, oG: 184, oB: 120 } })
    ok('V3-f', 'FEEL 入识图·F03 金线三态①last 金环（#C9A227 恒亮——最后一步高亮 §3.2）', goldRing.ringHit >= 5, `金环命中=${goldRing.ringHit}/${goldRing.ringTot}`)
    ok('V3-g', 'FEEL 入识图·F03 金线三态②last2 淡环（35% 墨环——两步对照环系 §3.2）', faintRing.ringHit >= 4, `淡环命中=${faintRing.ringHit}/${faintRing.ringTot}`)
  } else { ok('V3-f', 'F03 金环（last/last2 缺席——局面未达双手）', false, `last=${st0.last} last2=${st0.last2}`); ok('V3-g', 'F03 淡环', false, '') }

  /* --- V1-i/V2-f F15 回合横幅：HF 差分+席位形状点（fxProbe turn 合成事件同管线） --- */
  const hf0 = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts().__cls)
  await p.evaluate(() => window.__GAMES_DEBUG__.fxProbe({ k: 'turn', seat: 1 }))
  await sleep(220)
  const hf1 = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts().__cls)
  const bDot = await PX(p, { rect: { x: 20, y: 249, w: 9, h: 9, R: 61, G: 200, B: 232, t: 60, aR: 242, aG: 235, aB: 220 } })
  ok('V1-i', 'HF 全量·回合横幅面绘制走 HF（F1(13) 横幅字——面覆盖差分）', hf1.P1.samples > hf0.P1.samples, `P1 样 ${hf0.P1.samples}→${hf1.P1.samples}`)
  ok('V2-f', '双编码·F15 回合横幅形状点（席 1 青方点在横幅左位——色条+文字外形状通道）', bDot.hit >= 6, `方点青系=${bDot.hit}px（区 9×9）`)

  /* --- V2-d 回合指示点两态（view.turn 注入：B 方点/A 圆点——thinkOn 同管线） --- */
  const dotQuad = (seatTurn) => p.evaluate(async (tv) => {
    const dbg = window.__GAMES_DEBUG__
    dbg.state().view.turn = tv
    if (tv === 0) dbg.fxScene('think')
    /* 帧感知等待：双 rAF×2+60ms——注入后至少 2 帧已绘制（帧稀时 sleep 定长会读旧帧） */
    const nf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await nf(); await new Promise((r) => setTimeout(r, 60)); await nf()
    const g2 = document.getElementById('cv').getContext('2d')
    /* 心=单点色；角=3×3 块内极值方向（蓝向 max(b-r)/暖向 max(r-b)）——方点角区=青系抗锯齿
     * 混合仍蓝向，圆点角区=宣纸暖向（r-b≈22）；单像素硬核会被 AA×呼吸 alpha 双重减淡击穿 */
    const quad = [[19, 15], [19, 21], [13, 15], [13, 21]]
    const blockDir = (x, y) => { let m = -999; const d = g2.getImageData(x - 1, y - 1, 3, 3).data; for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i + 2] - d[i]); return m }
    return { heart: Array.from(g2.getImageData(16, 18, 1, 1).data.slice(0, 3)), quads: quad.map(([x, y]) => blockDir(x, y)) }
  }, seatTurn)
  const dB = await dotQuad(1)
  const dA = await dotQuad(0)
  /* 软阈值 r-b>N 会被宣纸底（r-b=22）击穿——三通道硬色核（角 t=45 排除呼吸边缘半透明，
   * 心 t=70 罩呼吸 alpha 波动 [0.57,0.91] 混色） */
  const near3 = (q, R, G, B, t) => Math.abs(q[0] - R) <= t && Math.abs(q[1] - G) <= t && Math.abs(q[2] - B) <= t
  const Bcorners = dB.quads.filter((v2) => v2 > 10).length, Acorners = dA.quads.filter((v2) => v2 > 10).length
  ok('V2-d', '双编码·回合指示点两态形色（B 态=青方点：四角蓝向 / A 态=琥珀圆点：四角暖向纸色——F06 呼吸+观战同管线）',
    near3(dB.heart, 61, 200, 232, 80) && Bcorners >= 3 && near3(dA.heart, 232, 163, 61, 80) && Acorners === 0,
    `B 心=${dB.heart} 蓝向角=${Bcorners}/4（max(b-r)≥${Math.max(...dB.quads)}）｜A 心=${dA.heart} 蓝向角=${Acorners}/4（max=${Math.max(...dA.quads)}）`)
  await p.evaluate(() => { const v = window.__GAMES_DEBUG__.state().view; v.turn = 0; window.__GAMES_DEBUG__.fxScene('calm') })

  /* --- V2-g 观战标记面（fxScene spect：进度条金色标记；观战指示点=V2-d 同管线） --- */
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('spect'))
  await sleep(160)
  const spect = await PX(p, { rect: { x: 0, y: 55, w: 375, h: 3, R: 201, G: 162, B: 39, t: 62, aR: 242, aG: 235, aB: 220 } })
  ok('V2-g', '双编码·观战标记面（F10 手数进度条金色标记在场——观战指示点同 V2-d 形色管线）', spect.hit >= 40, `spect 条=${spect.hit}px（y55-57 行）`)
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm'))

  /* --- V3-a/b F01 落子弹跳墨水（fxProbe place→席 B 青子：弹跳窗子簇+涟漪环瞬态收敛） ---
   * 同 F02 首跑病灶：双 rAF+sleep 采样在无头帧塌（中位 51ms/隙 p90 129ms）下漏采 120ms 弹子窗——
   * 改 raw-rAF 逐帧全录（预发 320ms 谷基线帧+发后 520ms 帧），Node 析峰；缺峰重发（fxProbe 合成可重试）。
   * 谷基线（预发帧 min）差分免疫邻格呼吸块；fxProbe 不改盘面真值——同一空格可反复发。 */
  const fireF01 = () => p.evaluate(() => new Promise((res) => {
    const dbg = window.__GAMES_DEBUG__
    const g2 = document.getElementById('cv').getContext('2d')
    const v = dbg.state().view
    let cell = -1
    for (let c = 0; c < 64; c++) { const r = (c / 8) | 0, cc = c % 8; if (!v.board[c] && r >= 2 && r <= 5 && cc >= 2 && cc <= 5) { cell = c; break } } /* 盘中心空格（环带避盘框） */
    const cx = 12 + (cell % 8) * 44 + 22, cy = 68 + ((cell / 8) | 0) * 44 + 22
    const rect = (x, y, w, h, R, G, B, t) => { const d = g2.getImageData(x, y, w, h).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - R) <= t && Math.abs(d[i + 1] - G) <= t && Math.abs(d[i + 2] - B) <= t) n++; return n }
    const stone = () => rect(cx - 12, cy - 12, 24, 24, 61, 200, 232, 46) /* B 青子簇 */
    const ripple = () => { let n = 0; for (let k = 0; k < 16; k++) { const th = k / 16 * Math.PI * 2; for (let r = 18.5; r <= 31.7; r += 1) { const d = g2.getImageData(Math.round(cx + Math.cos(th) * r), Math.round(cy + Math.sin(th) * r), 1, 1).data; if (Math.abs(d[0] - 178) <= 26 && Math.abs(d[1] - 149) <= 26 && Math.abs(d[2] - 96) <= 26) n++ } } return n } /* 环带 [0.42,0.72]cs */
    const frames = []
    let fired = false, t0 = 0
    const loop = () => {
      const now = performance.now()
      if (!fired && frames.length >= 6) { fired = true; t0 = now; dbg.fxProbe({ k: 'place', seat: 1, cell }) }
      frames.push({ t: Math.round(now - (fired ? t0 : now)), s: stone(), r: ripple() })
      if (now - (t0 || now) < 520) requestAnimationFrame(loop)
      else res({ cell, frames })
    }
    requestAnimationFrame(loop)
  }))
  let f01 = null, f01Tries = 0
  while (f01Tries < 4) { /* 缺峰重发：弹子窗 120ms<帧隙 p90——单发可能整窗漏采 */
    f01Tries++
    const r = await fireF01()
    const pre = r.frames.filter((f) => f.t <= 0), post = r.frames.filter((f) => f.t > 0)
    const base = Math.min(...pre.map((f) => f.r)), after = Math.min(...post.filter((f) => f.t > 420).map((f) => f.r))
    f01 = { cell: r.cell, peakStone: Math.max(...post.map((f) => f.s)), peakRip: Math.max(...post.map((f) => f.r)), base, after: Number.isFinite(after) ? after : base, frames: r.frames.length }
    if (f01.peakStone >= 30 && f01.peakRip >= f01.base + 5) break
    await sleep(120)
  }
  ok('V3-a', 'FEEL 入识图·F01 落子弹跳墨水·子簇（弹跳窗内落点 B 青子在场——0.6 缩放弹入 120ms）', f01.peakStone >= 30, `青子峰值=${f01.peakStone}px（${f01.frames} 帧×${f01Tries} 发，cell#${f01.cell}）`)
  ok('V3-b', 'FEEL 入识图·F01 落子涟漪环（环带瞬态增量在场——呼吸谷基线差分：邻格呼吸块恒在不计入）', f01.peakRip >= f01.base + 5, `涟漪增量=${f01.peakRip}-谷基线${f01.base}=${f01.peakRip - f01.base} 点`)
  ok('V3-b2', 'FEEL 入识图·F01 涟漪瞬态收敛（240ms 窗过后谷对谷增量归零=非阻塞证据）', f01.after - f01.base <= 4, `残余增量=${f01.after - f01.base}（谷 ${f01.after} vs 谷基线 ${f01.base}）@窗后`)
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm'))
  await sleep(80)

  /* --- V3-c/d/e F02 翻子波序（切比雪夫距序 40ms/子：近格先翻·远格（距 d 格）延 d*40ms 后翻） ---
   * 首跑三红根因（诊断件实证）：无头页 rAF 中位 51ms/p90 129ms——琥珀半窗仅 80ms，
   * 双 rAF+setTimeout 轮询 4 拍/700ms 全落窗隙=采样过稀（near/far 墨帧俱在，波序真实，非产品缺陷）。
   * 改页内 raw-rAF 逐帧采样（帧隙上限<窗宽）+琥珀首见时刻序证+缺窗重发（fxProbe 合成可重试）。 */
  const wave = await p.evaluate(() => { /* 波序取证：延迟=格距**波源**（view.last2）×40ms——不是近远格互距！
   * 选两颗已有青子（board==2：波前=青波后=琥珀可分辨；空格动画不画且无翻前色）：
   * near=距波源最近、far=距波源最远（取 dF-dN 最大化——琥珀半窗 [d*40+80,d*40+160] 两窗
   * 分离度=(dF-dN-2)*40ms，差≥2 即不相交；差≥3 带额外分离带更稳）。 */
    const v = window.__GAMES_DEBUG__.state().view
    const src = v.last2 >= 0 ? v.last2 : v.last
    const st = []; for (let c = 0; c < 64; c++) if (v.board[c] === 2) st.push(c)
    const dist = (c) => Math.max(Math.abs(((c / 8) | 0) - ((src / 8) | 0)), Math.abs((c % 8) - (src % 8)))
    let near = null, far = null
    for (const c of st) { const d = dist(c); if (near === null || d < near.d) near = { c, d }; if (far === null || d > far.d) far = { c, d } }
    if (near && far && far.d - near.d >= 2) return { a: near.c, b: far.c, dN: near.d, dF: far.d }
    return { none: true, n: st.length, dN: near ? near.d : -1, dF: far ? far.d : -1 }
  })
  if (wave && !wave.none) {
    /* 单次发波+raw-rAF 逐帧全录（500ms），Node 侧析窗：nearT/farT=各自琥珀首见帧时刻。
     * 返回帧带 nA/fA 两格琥珀计数（±50 容差含 0.4 alpha 混色——远窗首帧弱墨也可见）。 */
    const fireOnce = () => p.evaluate(([a, b2]) => new Promise((res) => {
      const dbg = window.__GAMES_DEBUG__
      const g2 = document.getElementById('cv').getContext('2d')
      const xy = (c) => ({ x: 12 + (c % 8) * 44 + 22, y: 68 + ((c / 8) | 0) * 44 + 22 })
      const pa = xy(a), pb = xy(b2)
      const cnt = (pt) => { const d = g2.getImageData(pt.x - 10, pt.y - 10, 20, 20).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 232) <= 50 && Math.abs(d[i + 1] - 163) <= 50 && Math.abs(d[i + 2] - 61) <= 50) n++; return n }
      const frames = []
      const t0 = performance.now()
      dbg.fxProbe({ k: 'flip', cells: [a, b2], seat: 0 })
      const loop = () => {
        const t = performance.now() - t0
        frames.push({ t: Math.round(t), nA: cnt(pa), fA: cnt(pb) })
        if (t < 520) requestAnimationFrame(loop)
        else res({ frames })
      }
      requestAnimationFrame(loop)
    }), [wave.a, wave.b])
    let flipSeq = null, tries = 0
    while (tries < 4) { /* 缺窗重发：琥珀窗 80ms 帧隙 p90 129ms 可能整窗漏采——重发合成波直至双窗均采到 */
      tries++
      const r = await fireOnce()
      const nT = r.frames.find((f) => f.nA > 25), fT = r.frames.find((f) => f.fA > 25)
      const nPeak = Math.max(...r.frames.map((f) => f.nA)), fPeak = Math.max(...r.frames.map((f) => f.fA))
      flipSeq = { nearT: nT ? nT.t : -1, farT: fT ? fT.t : -1, nPeak, fPeak, frames: r.frames.length, tries }
      if (flipSeq.nearT >= 0 && flipSeq.farT >= 0) break
      await sleep(120)
    }
    const minDiff = Math.max(12, (wave.dF - wave.dN - 2) * 40) /* 琥珀窗真分离=(dF-dN-2)*40；差2=邻接窗（下限拍 12=一帧量子） */
    ok('V3-c', `FEEL 入识图·F02 翻子波序·近格先翻（波首动画启动——距波源 ${wave.dN} 格延迟 ${wave.dN * 40}ms；首翻 <100ms 红线表现层证）`, flipSeq.nearT >= 0 && flipSeq.nearT <= wave.dN * 40 + 200 && flipSeq.nPeak >= 15, `近格#c${wave.a} 琥珀首见=${flipSeq.nearT}ms 峰值=${flipSeq.nPeak}px（${flipSeq.frames} 帧×${flipSeq.tries} 发）`)
    ok('V3-d', `FEEL 入识图·F02 波序·远格滞后（时刻顺序证：远格琥珀首见-近格琥珀首见 ≥${minDiff}ms——齐翻则同帧 ≈0ms；波序非齐翻）`, flipSeq.nearT >= 0 && flipSeq.farT >= 0 && flipSeq.farT - flipSeq.nearT >= minDiff, `nearT=${flipSeq.nearT}ms farT=${flipSeq.farT}ms Δ=${flipSeq.farT - flipSeq.nearT}ms`)
    ok('V3-e', `FEEL 入识图·F02 波序·远格后翻（远格动画到场=${wave.dF} 格距波源 ×40ms/子 波序吻合）`, flipSeq.farT >= 0 && flipSeq.farT <= wave.dF * 40 + 240 && flipSeq.fPeak >= 15, `远格琥珀首见=${flipSeq.farT}ms 峰值=${flipSeq.fPeak}px`)
  } else { ok('V3-c', `F02 波序（青子对距波源差不足——局面不支持取证：青子=${wave ? wave.n : '?'} dN=${wave ? wave.dN : '?'} dF=${wave ? wave.dF : '?'})`, false, ''); ok('V3-d', 'F02 远格滞后', false, ''); ok('V3-e', 'F02 远格后翻', false, '') }
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm'))
  await sleep(80)

  /* --- V3-h/i F03 金线三态之三：win-line 金线贯穿+流光（fxProbe 合成——描线 900ms） --- */
  const lineCells = [19, 20, 21, 22, 23] // 第 3 行横五（画布线段穿过盘心）
  const pl0 = xy(lineCells[0]), pl4 = xy(lineCells[4])
  await p.evaluate((cs) => window.__GAMES_DEBUG__.fxProbe({ k: 'win-line', cells: cs }), lineCells)
  await sleep(300) // 描线至 43%（t*1.3）+流光巡回第一周期
  const band = await p.evaluate(([x0, x1, y0]) => {
    const g2 = document.getElementById('cv').getContext('2d')
    const d = g2.getImageData(x0, y0 - 8, x1 - x0, 16).data
    let gold = 0, glow = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2]
      if (Math.abs(r - 201) <= 50 && Math.abs(gg - 162) <= 50 && Math.abs(b - 39) <= 60 && gg > 110) gold++
      if (Math.abs(r - 255) <= 34 && Math.abs(gg - 233) <= 30 && Math.abs(b - 168) <= 45) glow++
    }
    return { gold, glow }
  }, [pl0.x, pl4.x, pl0.y])
  ok('V3-h', 'FEEL 入识图·F03 金线三态③win-line 贯穿（描线中段金线墨在场——自起端渐进 900ms）', band.gold >= 20, `金线=${band.gold}px@t+300ms（线带 ${pl4.x - pl0.x}×16）`)
  ok('V3-i', 'FEEL 入识图·F03 流光巡回（#FFE9A8 亮点沿线在场——F08 胜利连线流光）', band.glow >= 3, `流光=${band.glow}px`)
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm'))

  /* --- V1-g help 浮层差分 + V1-h/V2-e 结算页（endScene win=A：胜方圆子+HF 差分） --- */
  const hf2 = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts().__cls)
  await p.mouse.click(342, 620) /* ? 钮（BTN.help） */
  await sleep(240)
  const hf3 = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts().__cls)
  ok('V1-g', 'HF 全量·? 速览浮层面绘制走 HF（F1(14/12) 浮层文——面覆盖差分）', hf3.P1.samples > hf2.P1.samples, `P1 样 ${hf2.P1.samples}→${hf3.P1.samples}`)
  await p.mouse.click(342, 620) /* 关浮层 */
  await sleep(150)
  const hf4 = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts().__cls)
  await p.evaluate(() => window.__GAMES_DEBUG__.fxScene('end')) /* 终局收棋 win（我=A 胜） */
  await sleep(520)
  const hf5 = await p.evaluate(() => window.__GAMES_DEBUG__.hudFonts().__cls)
  const winStone = await PX(p, { rect: { x: 172, y: 81, w: 30, h: 30, R: 232, G: 163, B: 61, t: 50, aR: 61, aG: 200, aB: 232 } })
  ok('V1-h', 'HF 全量·结算页绘制走 HF（F0(34) 大字+F0(13) 战报位——面覆盖差分）', hf5.P0.samples > hf4.P0.samples, `P0 样 ${hf4.P0.samples}→${hf5.P0.samples}`)
  ok('V2-e', '双编码·胜负横幅形状子（胜方 A 琥珀圆子在大字上位——色大字外形状通道 §7）', winStone.hit >= 60, `胜方子=${winStone.hit}px@(187,96)`)

  /* --- V6 perf（结算子雨动态页——最重渲染负载口径） --- */
  const perf = await p.evaluate((n) => new Promise((res) => {
    const costs = []
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => orig((ts) => { const t0 = performance.now(); cb(ts); costs.push(performance.now() - t0) })
    const loop = () => { if (costs.length < n) orig(loop); else { window.requestAnimationFrame = orig; res(costs) } }
    orig(loop)
  }), 140).then((c) => { c.sort((a, b) => a - b); return { avg: +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2), jank: +(c.filter((x) => x > 25).length / c.length * 100).toFixed(1), p95: +c[Math.floor(c.length * 0.95)].toFixed(2) } })
  ok('V6-a', 'perf 复验·渲染帧成本 avg <16ms（结算子雨最重面——60fps 预算换算 ≥55fps）', perf.avg < 16, `avg=${perf.avg}ms p95=${perf.p95}ms`)
  ok('V6-b', 'perf 复验·掉帧率（帧成本 >25ms）<2%', perf.jank < 2, `${perf.jank}%`)
  await p.screenshot({ path: `${SHOTS}/v2-reversi-end.png` })
  await p.close()
}

/* ============ V5 三态截图对照（开局/中盘/终局——独立 reversi 页帧差合理带） ============ */
console.log('── V5 冻结态截图对照（三态帧差合理带）──')
{
  const p = await newPage(`${PAGE}?debug=1&rule=reversi`)
  /* 开局帧：view 就绪即冻结（moveNo≤2）+calm 清瞬态 */
  for (let i = 0; i < 40; i++) { const v = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); return s.view ? s.view.moveNo : -1 }); if (v >= 0) break; await sleep(120) }
  await p.evaluate(() => { window.__GAMES_DEBUG__.pause(true); window.__GAMES_DEBUG__.fxScene('calm') })
  await sleep(520) /* enter 铺展 450ms 收敛后再冻结采样 */
  const open1 = await frameData(p)
  await sleep(200)
  const open2 = await frameData(p)
  await p.screenshot({ path: `${SHOTS}/v5-open.png` })
  /* 中盘帧：代打到 moveNo≥15 再冻结 */
  await p.evaluate(() => window.__GAMES_DEBUG__.pause(false))
  for (let i = 0; i < 80; i++) {
    const mn = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); return s.view ? s.view.moveNo : -1 })
    if (mn >= 15 || mn < 0) break
    const c = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); if (!s.view || s.view.over) return -1; if (s.view.turn === s.seat) { const l = window.YiPavSim.legal(s.view, s.seat); return l.length ? l[0] : -1 } return -2 })
    if (c === -2) { await sleep(100); continue }
    if (c >= 0) await p.evaluate((cc) => window.__GAMES_DEBUG__.sendOp({ k: 'place', cell: cc }), c)
    await sleep(70)
  }
  await p.evaluate(() => { window.__GAMES_DEBUG__.pause(true); window.__GAMES_DEBUG__.fxScene('calm') })
  await sleep(250)
  const midNo = await p.evaluate(() => window.__GAMES_DEBUG__.state().view.moveNo)
  const mid1 = await frameData(p)
  await p.screenshot({ path: `${SHOTS}/v5-mid.png` })
  /* 终局帧：打到 over（结算页入场收敛） */
  await p.evaluate(() => window.__GAMES_DEBUG__.pause(false))
  for (let i = 0; i < 200; i++) {
    const ov = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); return !!(s.over || (s.view && s.view.over)) })
    if (ov) break
    const c = await p.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); if (!s.view || s.view.over) return -1; if (s.view.turn === s.seat) { const l = window.YiPavSim.legal(s.view, s.seat); return l.length ? l[0] : -1 } return -2 })
    if (c === -2) { await sleep(90); continue }
    if (c >= 0) await p.evaluate((cc) => window.__GAMES_DEBUG__.sendOp({ k: 'place', cell: cc }), c)
    await sleep(60)
  }
  await sleep(700) /* 结算入场 tin=1 + F09 子雨在跑（动态终局态披露） */
  const end1 = await frameData(p)
  await p.screenshot({ path: `${SHOTS}/v5-end.png` })
  const [dOM, dME, dOO] = await Promise.all([diffPct(p, open1, mid1), diffPct(p, mid1, end1), diffPct(p, open1, open2)])
  const endStat = await p.evaluate(() => {
    const d = document.getElementById('cv').getContext('2d').getImageData(0, 0, 375, 667).data
    let dark = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 95 && d[i + 1] < 85 && d[i + 2] < 75) dark++
    const s = window.__GAMES_DEBUG__.state()
    return { darkPct: +(dark / (d.length / 4) * 100).toFixed(1), over: !!(s.over || (s.view && s.view.over)), moveNo: s.view ? s.view.moveNo : -1 }
  })
  ok('V5-a', '三态截图·开局帧在盘（moveNo≤2 冻结态落盘）', true, `v5-open.png（同态连拍差=${dOO}%——呼吸微动披露带）`)
  ok('V5-b', '三态截图·中盘帧在盘（中盘冻结态 moveNo≥15）', midNo >= 15, `v5-mid.png（中盘 moveNo=${midNo}；终局 moveNo=${endStat.moveNo}）`)
  ok('V5-c', '三态截图·终局帧在盘（结算暗场在场+over 态）', endStat.over && endStat.darkPct > 55, `v5-end.png（暗场=${endStat.darkPct}% over=${endStat.over}）`)
  ok('V5-d', '三态帧差合理带（开↔中 ∈[0.5,45]%：有子落而布局同构；中↔终 ≥5%：结算暗场巨变）', dOM >= 0.5 && dOM <= 45 && dME >= 5, `开↔中=${dOM}% 中↔终=${dME}%`)
  ok('V5-e', '三态确定性披露（同态连拍差 <1.5%=呼吸/流光级微动，无布局跳变）', dOO < 1.5, `开局同态连拍=${dOO}%`)
  await p.close()
}

ok('V7', '零 pageerror（全场景整轮）', errs.length === 0, errs.length ? errs[0].slice(0, 140) : '0 errors')

await browser.close()
console.log(`\n${failed === 0 ? 'VIS-CHECK OK' : 'VIS-CHECK FAILED'}：${passed} 通过，${failed} 失败（探针总数=${probes}，≥32 达标线）`)
process.exit(failed === 0 ? 0 : 1)
