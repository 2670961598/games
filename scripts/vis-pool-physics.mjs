#!/usr/bin/env node
/* =====================================================================
 * GAMES-80 八球台球识图 v2 + perf 复检（F3 补位，适配自 vis-empire-sprout.mjs，
 * 断言集移植自 GAMES-79 QA1 挂具 /tmp/games79/vis-bench.mjs 的 13 断言）；
 * GAMES-85 视觉统一扩容 13→25：
 *   A) perf 三跑中位（?debug=1 离线 Bot 对打，5s rAF 页面内采样；
 *      红线 avgFps ≥55 且 jank <2%，GAMES-30 口径）；
 *   B) 识图 v2（几何/墨水带/HF 字号双审计/worldProbe/aim-motion 双态截图）：
 *      带位 顶栏 0-90 / 桌面 250-420（台呢绿 #1F7A4D）/ 底栏 545-667（操作条）；
 *      + GAMES-85 像素取证（?debug=1 固定 seed 确定性局·静态 aim 期采样）：
 *      台呢暗角/袋口阴影晕/球体高光一致性/花色环带与号码盘（色盲双编码）/
 *      回合指示白框/剩余球彩点阵；
 *   C) online 冒烟（同源 quick 匹配：mode=online + physicsHashOk=true，
 *      F1 修复的 online 路径回归证）；
 *   D) 瞄准层级分档对照（normal vs master vs relaxed 同 seed 墨水差分）；
 *   E) 大厅卡槽一致（/multiplayer.html 静态目录：pool 槽位在册+卡/槽同圆角）。
 * 用法：node scripts/vis-pool-physics.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/Volumes/BigDisk/Studio/kernel/workers/GAMES-85-shots'

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

const PORT = 49800 + Math.floor(Math.random() * 3000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-pool-'))
const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
await new Promise((res) => {
  const t = setTimeout(res, 8000)
  server.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t), res() } })
  fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
})
await mkdir(OUT, { recursive: true })
const URL = `http://127.0.0.1:${PORT}/games/multiplayer/pool-physics/index.html`
const report = { perf: [], vis: [], onlineSmoke: null, polish: null, tier: null, lobby: null }

const browser = await chromium.launch({ headless: true })

/* ---------- A. perf 三跑（rAF 采样算式同 perf-smoke） ---------- */
console.log('== A. perf 三跑（?debug=1 离线 Bot 对打，5s rAF 采样）==')
for (let run = 1; run <= 3; run++) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message)))
  await page.goto(`${URL}?debug=1`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.worldProbe() && window.__GAMES_DEBUG__.worldProbe().phase, null, { timeout: 15000 })
  await page.waitForTimeout(1200)
  const stat = await page.evaluate((ms) => new Promise((resolve) => {
    const gaps = []; const t0 = performance.now(); let last = t0
    function tick(t) {
      gaps.push(t - last); last = t
      if (t - t0 < ms) requestAnimationFrame(tick)
      else {
        const sorted = [...gaps].sort((a, b) => a - b)
        const p = (q) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(1)
        resolve({ frames: gaps.length, avgFps: +(gaps.length / ((last - t0) / 1000)).toFixed(1), jankRatio: +(gaps.filter(x => x > 25).length / gaps.length).toFixed(4), long17R: +(gaps.filter(x => x > 17.5).length / gaps.length).toFixed(4), p50Ms: p(0.5), p95Ms: p(0.95), worstMs: p(1) })
      }
    }
    requestAnimationFrame(tick)
  }), 5000)
  stat.pageErrors = errs
  report.perf.push(stat)
  console.log(`  run${run}: avgFps=${stat.avgFps} jank=${(stat.jankRatio * 100).toFixed(2)}% worst=${stat.worstMs}ms pageErrors=${errs.length}`)
  await ctx.close()
}
const med = (a) => [...a].sort((x, y) => x - y)[1]
const fpsMed = med(report.perf.map(r => r.avgFps)), jankMed = med(report.perf.map(r => r.jankRatio))
ok('PERF', 'perf 三跑中位：avgFps ≥55 且掉帧 <2%（GAMES-30 红线）', fpsMed >= 55 && jankMed < 0.02, `中位 avgFps=${fpsMed} jank=${(jankMed * 100).toFixed(2)}%（三跑 ${report.perf.map(r => r.avgFps).join('/')}）`)

/* ---------- B. 识图 v2 ---------- */
console.log('== B. 识图 v2（DSF=1 真实视口）==')
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e.message)))
  await page.goto(`${URL}?debug=1`, { waitUntil: 'load', timeout: 20000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.worldProbe() && window.__GAMES_DEBUG__.worldProbe().phase, null, { timeout: 15000 })
  ok('V-PAGE', '页面零未捕获异常（F1 修复后）', pageErrors.length === 0, pageErrors.join(';') || '干净')

  const geo = await page.evaluate(() => {
    const d = document.scrollingElement || document.documentElement
    const r = document.getElementById('cv').getBoundingClientRect()
    return { scrollW: d.scrollWidth, clientW: d.clientWidth, scrollH: d.scrollHeight, clientH: d.clientHeight, cv: { x: r.x, y: r.y, w: r.width, h: r.height }, vw: innerWidth, vh: innerHeight }
  })
  ok('V-GEO-1', '无横向溢出（scrollWidth ≤ clientWidth）', geo.scrollW <= geo.clientW, `${geo.scrollW}≤${geo.clientW}`)
  ok('V-GEO-2', '画布完整落于 375×667 视口', geo.cv.x >= 0 && geo.cv.y >= 0 && geo.cv.x + geo.cv.w <= geo.vw + 0.5 && geo.cv.y + geo.cv.h <= geo.vh + 0.5, `cv=${geo.cv.w}×${geo.cv.h}@(${geo.cv.x},${geo.cv.y})`)

  const ink = await page.evaluate(() => {
    const cv = document.getElementById('cv'), ctx = cv.getContext('2d')
    const band = (y0, y1) => {
      let ink = 0, n = 0, green = 0
      for (let y = y0; y < y1; y += 3) for (let x = 4; x < 371; x += 6) {
        const d = ctx.getImageData(x, y, 1, 1).data; n++
        const [r, g, b] = [d[0], d[1], d[2]]
        if (r > 40 || g > 40 || b > 60) ink++
        if (Math.abs(r - 31) < 26 && Math.abs(g - 122) < 30 && Math.abs(b - 77) < 30) green++
      }
      return { inkR: +(ink / n).toFixed(3), greenR: +(green / n).toFixed(3) }
    }
    return { top: band(2, 88), feltMid: band(260, 410), bot: band(549, 663) }
  })
  ok('V-INK-1', '顶栏带（0-90）有 HUD 墨水', ink.top.inkR > 0.05, `墨水占比 ${(ink.top.inkR * 100).toFixed(1)}%`)
  ok('V-INK-2', '桌面带（250-420）为台呢绿主导（#1F7A4D）', ink.feltMid.greenR > 0.5, `绿占比 ${(ink.feltMid.greenR * 100).toFixed(1)}%`)
  ok('V-INK-3', '底栏带（545-667）有操作条墨水', ink.bot.inkR > 0.05, `墨水占比 ${(ink.bot.inkR * 100).toFixed(1)}%`)

  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const src = await readFile(join(ROOT, 'games/multiplayer/pool-physics/client.js'), 'utf8')
  const staticCalls = {}
  for (const m of src.matchAll(/HF\('([^']+)',\s*'([^']+)',\s*(\d+)(?:,\s*(\d+))?[,)]/g)) staticCalls[`${m[1]}/${m[2]}`] = { px: +m[3], w: +(m[4] || 400) }
  const TIER = { 'top/name': 0, 'top/cnt': 0, 'top/timer': 0, 'ctl/pow': 0, 'top/shotN': 0, 'banner/txt': 0, 'top/spec': 1, 'ctl/spin': 1, 'ctl/spinv': 1, 'ctl/replayBtn': 1, 'hint/bih': 1, 'ball/no': 2, 'foot/slug': 2, 'ctl/shoot': 1 }
  const LIM = [[13, 600], [11, 0], [9, 0]]
  let bad = []
  for (const [k, t] of Object.entries(TIER)) {
    const s = staticCalls[k]
    if (!s) {   // 三元/表达式字号（如 timer ≤5s 放大档）→ 运行时登记表补审
      const rtv = Object.values(hf).some(g => g[k.split('/')[1]] >= LIM[t][0])
      if (!rtv) bad.push(`${k} 静态与运行时均缺失`)
      continue
    }
    if (s.px < LIM[t][0]) bad.push(`${k}=${s.px}px<${LIM[t][0]}`)
  }
  const runtimeKeys = Object.values(hf).reduce((a, g) => a.concat(Object.keys(g)), [])
  ok('V-HF-1', 'HF 静态全量过线（P0≥13/600·P1≥11·P2≥9）', bad.length === 0, bad.join(';') || Object.keys(staticCalls).length + ' 键全过')
  ok('V-HF-2', '零裸字号（ctx.font 仅经 HF 登记口）', (src.match(/ctx\.font\s*=/g) || []).length === 1, 'ctx.font= 赋值 1 处（HF 内部）')
  ok('V-HF-3', '运行时登记表活跃（常显键渲染中）', runtimeKeys.length >= 8, `运行时 ${runtimeKeys.length} 键：${runtimeKeys.join(',')}`)

  const probe1 = await page.evaluate(() => window.__GAMES_DEBUG__.worldProbe())
  ok('V-PROBE', 'worldProbe 钩子（mode/tier/assist/phase/turn/shotN）', (probe1.mode === 'offline' || probe1.mode === 'online') && probe1.tier === 'normal' && probe1.assist === 1 && probe1.phase !== undefined, JSON.stringify(probe1))

  /* ---- GAMES-85 像素取证（?debug=1 固定 seed 确定性局，静态 aim 期零位移采样） ---- */
  const polish = await page.evaluate(() => {
    const c = document.getElementById('cv').getContext('2d')
    const px = (x, y) => { const d = c.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]] }
    const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
    const st = window.__GAMES_DEBUG__.state()
    const TX = (375 - 340) / 2, TY = 250
    const feltC = lum(px(187.5, 320)), feltE = lum(px(29.5, 320))            // 台呢暗角（y=320 避开瞄准线 335）
    let pkHit = 0                                                            // 袋口阴影晕（向心向 r15 晕内 vs r22 晕外）
    for (const [mx, my] of [[0, 0], [170000, -6000], [340000, 0], [0, 170000], [170000, 176000], [340000, 170000]]) {
      const kx = 17.5 + mx * 0.001, ky = 250 + my * 0.001                    // sim 真袋位（GAMES-85 修后渲染同源）
      const dxc = 187.5 - kx, dyc = 335 - ky, dl = Math.hypot(dxc, dyc) || 1
      if (lum(px(kx + dxc / dl * 15, ky + dyc / dl * 15)) + 5 < lum(px(kx + dxc / dl * 22, ky + dyc / dl * 22))) pkHit++
    }
    let hlOk = 0, hlN = 0, ringOk = 0, ringN = 0, numOk = 0, numN = 0        // 高光/环带/号码三通道
    for (let i = 0; i < 16; i++) {
      const b = st.balls[i]; if (!b || b.pot) continue
      const bx = TX + b.x * 0.001, by = TY + b.y * 0.001
      if (i <= 8) {   // 可度量组：纯色/黑八高光落本色（Δ≥25）；白球白上白只证存在（≥235）；花色高光落白环不度量
        hlN++
        if (i === 0) { if (lum(px(bx - 2.6, by - 2.9)) >= 235) hlOk++ }
        else if (lum(px(bx - 2.6, by - 2.9)) - lum(px(bx + 2.6, by + 2.9)) >= 25) hlOk++
      }
      if (i === 0 || i === 8) continue
      numN++
      if (i > 8) { ringN++; if (lum(px(bx + 5.2, by)) >= 215) ringOk++ }             // 花色：白环带在位
      else { ringN++; if (lum(px(bx + 5.2, by)) < 215) ringOk++ }                    // 纯色：同半径仍为本色
      let dark = 0
      for (let dx = -2; dx <= 2; dx++) for (let dy2 = -2; dy2 <= 2; dy2++) if (lum(px(bx + dx, by + dy2)) < 110) dark++
      if (dark >= 2) numOk++                                                          // 号码字迹（白盘 #222）
    }
    let dotOk = 0                                                             // 剩余球彩点阵（y=70 左排前 5）
    for (const dx3 of [26, 38, 50, 62, 74]) { const p = px(dx3, 70); if (Math.max(...p) - Math.min(...p) >= 30) dotOk++ }
    return { feltC: +feltC.toFixed(1), feltE: +feltE.toFixed(1), pkHit, hlOk, hlN, ringOk, ringN, numOk, numN, dotOk,
      turnFrame: +lum(px(60, 10)).toFixed(0) }                                // 我方回合白框（seat A）
  })
  ok('V-POLISH-1', '台呢径向暗角（中心亮于边带 ≥2）', polish.feltC - polish.feltE >= 2, `中心 ${polish.feltC} vs 边带 ${polish.feltE}`)
  ok('V-POLISH-2', '袋口阴影晕（晕内比晕外暗 ≥5，≥4/6 袋）', polish.pkHit >= 4, `${polish.pkHit}/6 袋`)
  ok('V-POLISH-3', '球体高光一致性（纯色/黑八 Δ≥25 + 白球在位，度量组全过）', polish.hlOk === polish.hlN, `${polish.hlOk}/${polish.hlN}（花色白环组不度量）`)
  ok('V-CB-1', '色盲双编码·花色白环带（灰度 ≥215）vs 纯色无环（<215）', polish.ringOk === polish.ringN, `${polish.ringOk}/${polish.ringN} 球全对`)
  ok('V-CB-2', '色盲双编码·号码白盘字迹（中心 5×5 暗 px ≥2，≥80%）', polish.numOk >= Math.ceil(polish.numN * 0.8), `${polish.numOk}/${polish.numN}`)
  ok('V-HUD-1', '台面 HUD 四要素 HF 达标（name/cnt/timer/shotN ≥13）', ['name', 'cnt', 'timer', 'shotN'].every(k => hf.top && hf.top[k] >= 13) && !!(hf.ctl && hf.ctl.pow >= 13 && hf.ctl.shoot >= 13), `top/${JSON.stringify(hf.top || {})} ctl/${JSON.stringify(hf.ctl || {})}`)
  ok('V-HUD-2', '回合指示（我方白框在位，灰度 ≥180）', polish.turnFrame >= 180, `框线 ${polish.turnFrame}`)
  ok('V-HUD-3', '分色剩余计数彩点阵（饱和度 ≥30，≥3/5）', polish.dotOk >= 3, `${polish.dotOk}/5 采样点`)
  report.polish = polish
  await page.waitForFunction(() => { const p = window.__GAMES_DEBUG__.worldProbe(); return p && p.phase === 'aim' }, null, { timeout: 30000 }).catch(() => { /* 兜底见下 */ })
  const probe0 = await page.evaluate(() => window.__GAMES_DEBUG__.worldProbe())
  await page.screenshot({ path: join(OUT, 'pool-aim.png') })
  /* 离线练习局玩家先手：tap 出杆钮（W-60, H-64，R32）真开一杆触发 motion（真实操作路径） */
  if (probe0.phase === 'aim') await page.mouse.click(375 - 60, 667 - 64)
  await page.waitForFunction(() => { const p = window.__GAMES_DEBUG__.worldProbe(); return p && p.phase === 'motion' }, null, { timeout: 30000 }).catch(() => {})
  const probe2 = await page.evaluate(() => window.__GAMES_DEBUG__.worldProbe())
  await page.screenshot({ path: join(OUT, 'pool-motion.png') })
  ok('V-PHASES', 'aim/motion 双态取证', probe0.phase === 'aim' && probe2.phase === 'motion', `aim→motion（shotN ${probe0.shotN}→${probe2.shotN}）`)
  await ctx.close()
}

/* ---------- C. online 冒烟（独立网关 quick 匹配，证 F1 修复恢复 online 路径） ---------- */
console.log('== C. online 冒烟（独立网关 quick 匹配）==')
{
  /* 网关与静态面是两个进程（gwOrigin 默认指 4400 常驻网关）：起隔离网关，log/pid 改道防覆写（QA 范式） */
  const GWPORT = 49200 + Math.floor(Math.random() * 600)
  const gw = spawn(process.execPath, [join(ROOT, 'server/gateway/index.js')], {
    env: { ...process.env, PORT: String(GWPORT), DATA_DIR: dataDir, GATEWAY_LOG: join(dataDir, 'gw.log'), GATEWAY_PID: join(dataDir, 'gw.pid') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await new Promise((res) => {
    const t = setTimeout(res, 8000)
    fetch(`http://127.0.0.1:${GWPORT}/healthz`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
    setTimeout(res, 6000)
  })
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message)))
  try {
    await page.goto(`${URL}?gw=ws://127.0.0.1:${GWPORT}`, { waitUntil: 'load', timeout: 20000 })
    await page.waitForFunction(() => { const p = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.worldProbe(); return p && p.mode === 'online' && p.physicsHashOk === true }, null, { timeout: 20000 })
    const probe = await page.evaluate(() => window.__GAMES_DEBUG__.worldProbe())
    await page.screenshot({ path: join(OUT, 'pool-online.png') })
    report.onlineSmoke = { ok: true, probe }
    ok('V-ONLINE', 'online 模式：入房+physicsHash 校验通过', probe.mode === 'online' && probe.physicsHashOk === true, `mode=${probe.mode} hashOk=${probe.physicsHashOk}（快照重演 verify=${probe.verify}）`)
  } catch (e) {
    report.onlineSmoke = { ok: false, err: String(e.message).slice(0, 200), errs }
    ok('V-ONLINE', 'online 模式冒烟', false, String(e.message).slice(0, 120))
  }
  await ctx.close()
  try { gw.kill('SIGTERM') } catch { /* best effort */ }
}

/* ---------- D. 瞄准层级分档对照（normal/master/relaxed 同 seed 墨水差分） ---------- */
console.log('== D. 瞄准辅助视觉层级（同 seed 三档对照）==')
{
  const inkOf = async (tierQ) => {
    const ctx3 = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
    const pg = await ctx3.newPage()
    await pg.goto(`${URL}?debug=1&tier=${tierQ}`, { waitUntil: 'load', timeout: 20000 })
    await pg.waitForFunction(() => { const p = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.worldProbe(); return p && p.phase === 'aim' }, null, { timeout: 15000 })
    const r = await pg.evaluate(() => {
      const c = document.getElementById('cv').getContext('2d')
      let bright = 0, orange = 0, blue = 0
      for (let y = 252; y < 418; y++) for (let x = 20; x < 356; x += 2) {
        const d = c.getImageData(x, y, 1, 1).data
        if (0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2] > 185) bright++
        if (x >= 250 && d[0] > 170 && d[1] >= 120 && d[1] <= 210 && d[2] < 100) orange++   // 目标线橙（含叠白环混色）
        if (x >= 250 && d[0] < 95 && d[1] > 140 && d[2] > 150) blue++                      // 白球分离线青蓝
      }
      /* Ghost 环圆周采样：默认瞄准角 0（+x）首触=框顶球，接触点=cue.x+首球距-球径——确定性几何 */
      const st = window.__GAMES_DEBUG__.state()
      let gd = null, gy2 = 85000
      for (let i = 1; i < 16; i++) { const b = st.balls[i]; if (!b || b.pot) continue; const d = b.x - 15000 - st.balls[0].x; if (d > 0 && (!gd || d < gd)) { gd = d; gy2 = b.y } }
      const gx = 17.5 + (st.balls[0].x + gd) * 0.001, gyy = 250 + gy2 * 0.001
      let ghost = 0
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2
        let hit2 = false
        for (const rr of [6.9, 7.5, 8.1]) {   // 三半径取优（1.4-2px 描边圆周的整像素采样需抗 AA）
          const p = c.getImageData(Math.round(gx + Math.cos(a) * rr), Math.round(gyy + Math.sin(a) * rr), 1, 1).data
          if (p[0] > 165 && p[1] >= 105 && p[1] <= 175 && p[2] < 115) { hit2 = true; break }
        }
        if (hit2) ghost++
      }
      return { bright, orange, blue, ghost }
    })
    await pg.screenshot({ path: join(OUT, `pool-aim-${tierQ}.png`) })
    await ctx3.close()
    return r
  }
  const nI = await inkOf('normal'), mI = await inkOf('master'), rI = await inkOf('relaxed')
  report.tier = { normal: nI, master: mI, relaxed: rI }
  ok('V-AIM-1', '瞄准层级：normal 主线墨水 > master 裸打（差 ≥20 采样点）', nI.bright - mI.bright >= 20, `normal ${nI.bright} vs master ${mI.bright}`)
  ok('V-AIM-2', '全辅助 Ghost 球在位（relaxed 圆周橙 ≥6/12 且 normal 为 0）', rI.ghost >= 6 && nI.ghost === 0, `relaxed ${rI.ghost}/12 vs normal ${nI.ghost}/12`)
}

/* ---------- E. 大厅卡槽一致（/multiplayer.html 静态目录） ---------- */
console.log('== E. 大厅卡槽一致 ==')
{
  const ctx4 = await browser.newContext({ viewport: { width: 375, height: 667 } })
  const lp = await ctx4.newPage()
  await lp.goto(`http://127.0.0.1:${PORT}/multiplayer.html`, { waitUntil: 'load', timeout: 15000 })
  const lob = await lp.evaluate(() => {
    const slots = [...document.querySelectorAll('.mp-slot')]
    const pool = slots.find(s => s.textContent.includes('八球台球'))
    const radii = [...new Set(slots.map(s => getComputedStyle(s).borderRadius))]
    let cardRule = ''
    for (const sh of document.styleSheets) {
      try { for (const r of sh.cssRules) if (r.selectorText && r.selectorText.split(',').map(s => s.trim()).includes('.mp-card') && r.style.borderRadius) cardRule = r.style.borderRadius } catch { /* 跨域样式表跳过 */ }
    }
    return { n: slots.length, poolOk: !!pool && pool.textContent.includes('S4') && !!pool.getAttribute('href'),
      href: pool ? pool.getAttribute('href') : '', radii, cardRule }
  })
  report.lobby = lob
  ok('V-LOBBY-1', '大厅 pool 槽位在册（八球台球 · S4 · 直入对局）', lob.poolOk && /pool-physics/.test(lob.href || ''), `${lob.n} 槽，href=${(lob.href || '').slice(0, 40)}`)
  ok('V-LOBBY-2', '卡/槽一致（.mp-card 与 .mp-slot 同 14px 圆角）', lob.radii.length === 1 && lob.cardRule === lob.radii[0], `slot=${lob.radii.join('|')} card=${lob.cardRule}`)
  await ctx4.close()
}

await browser.close()
await rm(dataDir, { recursive: true, force: true })
try { server.kill('SIGTERM') } catch { /* best effort */ }
report.passed = passed; report.failed = failed
await writeFile(join(OUT, 'vis-pool-physics-report.json'), JSON.stringify(report, null, 2))
console.log(`\n[vis-pool] ${passed} passed, ${failed} failed；截图与报告 → ${OUT}`)
process.exitCode = failed ? 1 : 0
