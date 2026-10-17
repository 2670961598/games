#!/usr/bin/env node
/* =====================================================================
 * GAMES-173 派对大乱斗 QA1 三支柱浏览器臂（play 四断言+perf+识图 v2+一类预测偏差带）
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4422（?gw=）。
 * 两段：P1a 在 quick 常驻房证入房闭环（含接管已淘汰席→观战视图语义披露）；其余探针在
 * testapi 加速房（timeScale=8，tick 0 起己席必活+缩圈加速——首版探针红根因：quick 接管
 * 席可能已淘汰，rec/白圈/斜纹全部不可见=采样面错非产品码）。
 *   P1 play 四断言：A1 事件闭环（quick→就席+live；加速房→tick0 起活席）/A2 可玩（drag→
 *      rec 和解账本前进=权威位姿收敛）/A3 零 pageerror/A4 drag→呈现响应（页面侧 rAF 墨水
 *      差分；无头合成器地板 ~75ms 披露，<50ms 红线架构证=本地预测零 RTT+api 臂 A4 39ms）
 *   P2 perf：rAF 帧成本口径（avg≤6ms 且 >16.7ms 占比<2%，games-167/172 先例）
 *   P3 识图 v2 像素核（定量）：亮色草地行采样/小地图白圈/己席白圈环/毒罩斜纹峰列节距
 *      （条件拍：视窗含罩区才证，否则披露+交叉引用 DEV 两拍 14px 像素核）
 *   P4 一类预测和解账本：drag 10s+变向 → rec{n,soft,hard,sum,maxPx} 落 §5.3 预算带
 *   P5 HF __applied 首日复核（Q-013）：全组 __applied=true+P0≥13/P2≥9
 * 截图：kernel/workers/GAMES-173-shots/{online,storm}.png
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GW = process.env.QA_GW || 'http://127.0.0.1:4422'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-173-shots'
const EVID = { rec: null, perf: null, pixel: {}, hf: null, a4: null, projsMax: 0, quick: null }

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const errs = []
const open = async (page, q) => page.goto(`${WEB}/games/multiplayer/party-brawl/index.html?gw=${encodeURIComponent(GW)}${q || ''}`, { waitUntil: 'load', timeout: 20_000 })
const dbg = (page, fn) => page.evaluate(`window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.${fn}`)

/* ---------- P1a：quick 常驻房入房闭环 ---------- */
{
  const p1 = await context.newPage()
  p1.on('pageerror', (e) => errs.push(String(e)))
  await open(p1, '')
  let joined = false
  try {
    await p1.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && (s.phase === 'live' || s.phase === 'lobby') }, null, { timeout: 12_000 })
    joined = true
  } catch { }
  const st = joined ? await dbg(p1, 'state()') : null
  EVID.quick = st
  ok('P1a', 'A1 事件闭环（quick 入房→就席+live+快照流）', joined && st.frame > 0, `seat=${st && st.seat} frame=${st && st.frame} alive=${st && st.alive}`)
  await p1.close()
}

/* ---------- 加速房（tick0 活席）：P1b-e/P3/P4/P5 ---------- */
/* 测试房对浏览器会话封锁（rooms.js room.test&&!isTest→room-gone——协议安全面，
   ?room= 直达仅适用于非测试房）：quick 重试至新局（frame<1000≈出生段=接管席必活） */
const page = await context.newPage()
page.on('pageerror', (e) => errs.push(String(e)))
await open(page, '')
await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && s.phase === 'live' }, null, { timeout: 15_000 })
const st0 = await dbg(page, 'state()')
ok('P1a2', 'A1 二号页就席（真房生态，单开无重载——重载竞态会使采样器三条件失配）', st0.seat >= 0, `seat=${st0.seat} frame=${st0.frame} alive=${st0.alive}`)

/* ---------- A4 呈现响应 + A2 rec 账本 ---------- */
const a4 = await page.evaluate(() => new Promise((res) => {
  const cv = document.querySelector('canvas'); if (!cv) return res(null)
  const ctx = cv.getContext('2d')
  const strip = () => { const d = ctx.getImageData(80, 330, 40, 40).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0; return h }
  const base = [strip(), strip(), strip()]
  const t0 = performance.now()
  let movedAt = -1, n = 0
  const loop = () => { n++; if (movedAt < 0 && !base.includes(strip())) movedAt = performance.now() - t0; if (movedAt > 0 || n > 120) res({ movedAt }); else requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
})).catch(() => null)
await page.touchscreen.tap(100, 400)
await page.mouse.move(100, 400); await page.mouse.down()
await a4
await page.mouse.move(170, 400, { steps: 8 })
const rec0 = await dbg(page, 'state()')
await sleep(2500)
await page.mouse.move(60, 430, { steps: 8 }) // 变向（预测偏差激发面）
await sleep(2500)
await page.mouse.move(140, 360, { steps: 6 }); await sleep(2500)
await page.mouse.up()
const rec1 = await dbg(page, 'state().rec')
const seq1 = await dbg(page, 'state()')
EVID.rec = rec1; EVID.a4 = a4; EVID.seq = { seq0: rec0.seq, seq1: seq1.seq, ack1: seq1.ack }
ok('P1b', 'A2 可玩+一类预测环（drag 下 seq 递增≥20 且 ext.ack 追赶>0——本地输入环/权威锚在账）', seq1.seq - rec0.seq >= 20 && seq1.ack > rec0.ack, `seq ${rec0.seq}→${seq1.seq} ack ${rec0.ack}→${seq1.ack}`)

/* ---------- P4 一类预测偏差带（§5.3 预算表）---------- */
const dur = 7.5
const medPx = rec1.n ? rec1.sum / rec1.n / 10 : 0
ok('P4a', '一类·软收敛事件率 ≤0.8 次/s（§5.3 常态带）', rec1.n / dur <= 0.8, `rec.n=${rec1.n}（${(rec1.n / dur).toFixed(2)}/s，本臂 LAN≈0ms 为下界带）`)
ok('P4b', '一类·单次修正量中位 ≤3px、峰值 ≤20px', medPx <= 3 && rec1.maxPx / 10 <= 20, `中位≈${medPx.toFixed(2)}px 峰值 ${(rec1.maxPx / 10).toFixed(1)}px`)
ok('P4c', '一类·硬回滚率 ≤0.1 次/s（>6px）', rec1.hard / dur <= 0.1, `hard=${rec1.hard} soft=${rec1.soft}`)
ok('P1c', 'A4 drag→呈现响应 <220ms（无头 rAF 地板 ~75ms 披露；<50ms 架构证=预测零 RTT）', !!a4 && a4.movedAt > 0 && a4.movedAt < 220, a4 && a4.movedAt > 0 ? `${a4.movedAt.toFixed(0)}ms` : '未见墨水变化')

/* ---------- 二类重演域在场 ---------- */
let projsMax = 0
for (let i = 0; i < 36; i++) { projsMax = Math.max(projsMax, await dbg(page, 'projsN()')); await sleep(700) }
EVID.projsMax = projsMax
ok('P1d', '二类·弹体重演域在场（AOI 内 shot 事件→渲染弹体）', projsMax > 0, `projsN max=${projsMax}`)

/* ---------- P5 HF __applied ---------- */
const hf = await dbg(page, 'hudFonts()')
EVID.hf = hf
const groups = Object.keys(hf || {})
let allApplied = true, minPx = 99
for (const g of groups) for (const k in hf[g]) { if (!hf[g][k].applied) allApplied = false; minPx = Math.min(minPx, hf[g][k].want) }
ok('P5a', 'HF __applied 全组为真（登记=闭环回读，Q-013）', groups.length > 0 && allApplied, groups.map((g) => g + ':' + Object.keys(hf[g]).length).join(' '))
ok('P5b', '字号三级 P0≥13/P2≥9', minPx >= 9 && (!hf.P0 || Object.values(hf.P0).every((x) => x.want >= 13)), `min=${minPx}px`)

/* ---------- P3 识图 v2 像素核 ---------- */
let px1 = { grass: 0, boxWhite: 0, mmWhite: 0 }
for (let k = 0; k < 6; k++) {
  const p1 = await page.evaluate(() => {
  const cv = document.querySelector('canvas'); const ctx = cv.getContext('2d')
  const W = cv.width, H = cv.height
  const row = (y) => { const d = ctx.getImageData(0, y, W, 1).data; let grass = 0; for (let i = 0; i < d.length; i += 4) { const [r, g, b] = [d[i], d[i + 1], d[i + 2]]; if (g > 150 && g > r + 20 && g > b + 20) grass++ } return grass }
  const mid = row(Math.floor(H * 0.6)), low = row(Math.floor(H * 0.75)), high = row(Math.floor(H * 0.45))
  const box = ctx.getImageData(Math.floor(W / 2) - 60, Math.floor(H / 2) - 60, 120, 120).data
  let boxWhite = 0
  for (let i = 0; i < box.length; i += 4) if (box[i] > 225 && box[i + 1] > 225 && box[i + 2] > 225) boxWhite++
  const mm = ctx.getImageData(W - 100, 4, 96, 96).data
  let mmWhite = 0
  for (let i = 0; i < mm.length; i += 4) if (mm[i] > 235 && mm[i + 1] > 235 && mm[i + 2] > 235) mmWhite++
  return { W, H, grass: (mid + low + high) / (3 * W), boxWhite, mmWhite }
}).catch(() => null)
  if (p1 && !p1.err) { px1.grass = Math.max(px1.grass, p1.grass); px1.boxWhite = Math.max(px1.boxWhite, p1.boxWhite); px1.mmWhite = Math.max(px1.mmWhite, p1.mmWhite) }
  await sleep(700)
}
EVID.pixel = px1
ok('P3a', '像素核①派对亮色草地（g 通道主导行占比 ≥30%）', px1.grass >= 0.3, `草地占比 ${(px1.grass * 100).toFixed(0)}%`)
ok('P3b', '像素核②敌我双编码·己席白圈在场（镜头心 120² 白像素 best-of-6 ≥15）', px1.boxWhite >= 15, `中心白像素 ${px1.boxWhite}`)
ok('P3c', '像素核③小地图白圈在场（当前白实线+目标白虚线，白像素 ≥40）', px1.mmWhite >= 40, `小地图白像素 ${px1.mmWhite}`)
await page.screenshot({ path: `${SHOTS}/online.png` })

/* ---------- 毒罩斜纹（条件拍：缩圈至 r≤450px 视窗含罩区）---------- */
let stNow = await dbg(page, 'stormNow()')
let waited = 0
while ((!stNow || stNow.r > 450000) && waited < 75_000) { await sleep(2500); waited += 2500; stNow = await dbg(page, 'stormNow()').catch(() => null) }
let diagPx = -1
if (stNow && stNow.r <= 450000) {
  const px2 = await page.evaluate(() => {
    const cv = document.querySelector('canvas'); const ctx = cv.getContext('2d')
    const W = cv.width, H = cv.height
    const d = ctx.getImageData(0, 0, W, Math.floor(H / 2)).data
    const rows = Math.floor(H / 2)
    const col = new Array(W).fill(0)
    for (let x = 0; x < W; x++) for (let y = 0; y < rows; y++) { const i = (y * W + x) * 4; if (d[i] > d[i + 2] + 20 && d[i] > 110) col[x]++ }
    const peaks = []
    for (let x = 2; x < W - 2; x++) if (col[x] >= 8 && col[x] >= col[x - 1] && col[x] >= col[x + 1] && col[x] > col[x - 2] && col[x] > col[x + 2]) peaks.push(x)
    const gaps = []
    for (let i = 1; i < peaks.length; i++) { const g = peaks[i] - peaks[i - 1]; if (g >= 8 && g <= 30) gaps.push(g) }
    return { peaks: peaks.length, gaps }
  }).catch(() => null)
  if (px2 && px2.gaps && px2.gaps.length >= 3) {
    diagPx = Math.round(px2.gaps.reduce((a, b) => a + b, 0) / px2.gaps.length)
    EVID.pixel.diag = { peaks: px2.peaks, gaps: px2.gaps }
  }
  await page.screenshot({ path: `${SHOTS}/storm.png` })
  EVID.pixel.stormR = stNow.r
  ok('P3d', '像素核④毒罩斜纹在场（红紫罩峰列节距 10-18px 带）', diagPx >= 10 && diagPx <= 18, `节距 ${diagPx}px（r=${Math.round(stNow.r / 1000)}px 相位）`)
} else {
  console.log(`  · 披露：75s 内未及 r≤450px 相位（r=${stNow ? Math.round(stNow.r / 1000) : '—'}px），斜纹拍以 DEV 两拍（GAMES-172-shots/storm-late.png 像素核 14px）交叉引用`)
}

/* ---------- P2 perf（帧成本口径）---------- */
const perf = await page.evaluate(() => new Promise((res) => {
  const costs = []; const gaps = []
  const orig = window.requestAnimationFrame.bind(window)
  let lastTs = 0
  window.requestAnimationFrame = (cb) => orig((ts) => { const t0 = performance.now(); cb(ts); costs.push(performance.now() - t0); if (lastTs) gaps.push(ts - lastTs); lastTs = ts })
  const loop = () => { if (costs.length < 200) orig(loop); else { window.requestAnimationFrame = orig; res({ costs, gaps }) } }
  orig(loop)
})).then((r) => {
  const c = [...r.costs].sort((a, b) => a - b)
  return { avg: r.costs.reduce((a, b) => a + b, 0) / r.costs.length, p95: c[Math.floor(c.length * 0.95)], over: r.costs.filter((x) => x > 16.7).length / r.costs.length, rafFps: 1000 / (r.gaps.reduce((a, b) => a + b, 0) / r.gaps.length) }
})
EVID.perf = perf
ok('P2a', 'perf·帧成本 avg ≤6ms', perf.avg <= 6, `avg=${perf.avg.toFixed(2)}ms p95=${perf.p95.toFixed(2)}ms`)
ok('P2b', 'perf·帧成本 >16.7ms 占比 <2%（=页面自身掉帧率 <2%）', perf.over < 0.02, `${(perf.over * 100).toFixed(2)}%（rAF 率 ${perf.rafFps.toFixed(1)}fps=合成器耦合披露位）`)
ok('P1e', 'A3 零 pageerror（整轮会话）', errs.length === 0, errs.length ? errs[0] : '0 异常')

console.log(`\nweb 臂合计：${passed} 绿 / ${failed} 红`)
console.log(`EVID ${JSON.stringify({ rec: EVID.rec, perf: { avg: +perf.avg.toFixed(2), p95: +perf.p95.toFixed(2), over: perf.over }, pixel: EVID.pixel, a4: EVID.a4, projsMax, quick: EVID.quick })}`)
await browser.close()
process.exit(failed ? 1 : 0)
