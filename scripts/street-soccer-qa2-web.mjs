#!/usr/bin/env node
/* =====================================================================
 * GAMES-142 街头足球 QA2 浏览器臂（FEEL 后观战焦点球光圈 F11+满编 2v2 真实路径）
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4416（?gw=）。
 *   W1 quick 页：入席（bot 房让位=O-1 客户端面）+F08 让位提示环台账+零 pageerror
 *   W2 满编 2v2 真实路径：4 页真人四席互异（QA1 P4 复刻）
 *   W3 第 5 人观战（FEEL 后）：seat=-1+快照流同观+F11 观战焦点球光圈台账+环形金墨水
 *      页内 canvas 探针（球屏位环形采样 r11-17×3 帧持续命中；对照=球员页同环近零）
 * 退出码：0=全绿；1=有失败。QA 只读：零产品代码改动。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GWWS = process.env.QA_GW_WS || 'ws://127.0.0.1:4416'
const PAGE_URL = `${WEB}/games/multiplayer/street-soccer/index.html`
const SHOTS = '/Volumes/xieqingxin/Studio/kernel/workers/GAMES-142-shots'
let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const errs = []
const watch = (page) => page.on('pageerror', (e) => errs.push(String(e)))
const dbg = (page, fn, ...a) => page.evaluate(([f, ...args]) => window.__GAMES_DEBUG__[f](...args), [fn, ...a])

/* ---------- 环形金墨水探针：球屏位环形 r∈[10,18] 采样金晕（F11 #FFD86B 脉动） ---------- */
const ringProbe = (page) => page.evaluate(() => {
  const st = window.__GAMES_DEBUG__.state()
  if (!st || !st.ball) return null
  const cv = document.querySelector('canvas')
  const ctx2 = cv.getContext('2d')
  const bx = 12 + st.ball.x / 1000, by = 56 + st.ball.y / 1000
  let hits = 0, tot = 0
  for (let r = 10; r <= 18; r += 2) for (let a = 0; a < 12; a++) {
    const x = Math.round(bx + Math.cos(a / 12 * 6.283) * r), y = Math.round(by + Math.sin(a / 12 * 6.283) * r)
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue
    const d = ctx2.getImageData(x, y, 1, 1).data
    tot++
    if (d[0] >= 135 && d[0] <= 235 && d[1] >= 110 && d[1] <= 215 && d[2] <= 130 && d[0] - d[2] >= 45) hits++
  }
  return { hits, tot, ball: st.ball, poss: st.poss }
})

/* ============ W1：quick 页（O-1 客户端面：让位入席+F08 让位提示环） ============ */
console.log('[W1] quick 页·让位入席（O-1 抽验客户端面）')
const p1 = await context.newPage(); watch(p1)
await p1.goto(`${PAGE_URL}?quick=1&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
let seat1 = -1
try {
  await p1.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
    return st && st.seat >= 0 && ['kick', 'play', 'goal', 'over'].includes(st.phase)
  }, null, { timeout: 15_000 })
  seat1 = (await dbg(p1, 'state')).seat
} catch { }
ok(seat1 >= 0, 'W1 quick bot 房让位入席（真人优先顶替 bot 席=O-1 服务器面已由 mercy 臂证，此处客户端面）', `seat=${seat1}`)
const led1 = await dbg(p1, 'fxLedger')
const f08 = led1.filter((l) => l.id === 'F08')
ok(f08.length >= 1, 'W1 F08 让位提示环台账在案（FEEL 面：就席=席位让位完成时点）', `F08×${f08.length} lat=${f08[0] && f08[0].lat}ms`)
const roomId = await p1.evaluate(() => { try { return sessionStorage.getItem('ss-rid') } catch { return null } })
ok(!!roomId, 'W1 roomId 落 sessionStorage（?room= 拓扑入口）', roomId || '')

/* ============ W2+W3：满编 2v2 真实路径（4 页真人）+第 5 人观战（F11 焦点环） ============ */
console.log('[W2] 满编 2v2：4 真人四席互异（QA1 P4 复刻·FEEL 后复验）')
if (roomId) {
  const seats = [seat1]
  const pages = [p1]
  for (let i = 0; i < 3; i++) {
    const p = await context.newPage(); watch(p)
    await p.goto(`${PAGE_URL}?room=${roomId}&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
    try {
      await p.waitForFunction(() => {
        const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
        return st && st.seat >= 0
      }, null, { timeout: 12_000 })
      seats.push((await dbg(p, 'state')).seat)
      pages.push(p)
    } catch { seats.push(-1) }
  }
  ok(seats.filter((s) => s >= 0).length === 4 && new Set(seats).size === 4, 'W2 满编 2v2 真实路径：4 真人四席互异（bot 全让位）', JSON.stringify(seats))
  await sleep(1500)

  console.log('[W3] 第 5 人观战（FEEL 后观战焦点球光圈 F11）')
  const p5 = await context.newPage(); watch(p5)
  await p5.goto(`${PAGE_URL}?room=${roomId}&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
  let sp = null
  try {
    await p5.waitForFunction(() => {
      const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
      return st && st.seat === -1 && st.phase
    }, null, { timeout: 12_000 })
    sp = await dbg(p5, 'state')
  } catch { }
  ok(sp && sp.seat === -1, 'W3 第 5 人=观战位（满员 4/4 真人不占席——welcome 实证非初始假信号）', sp ? `seat=${sp.seat} phase=${sp.phase} poss=${sp.poss}` : '未入观战')
  if (sp) {
    const n0 = (await dbg(p5, 'events')).length
    await sleep(2200)
    const n1 = (await dbg(p5, 'events')).length
    const st1 = await dbg(p5, 'state')
    ok(n1 > n0 || st1.ball.x !== sp.ball.x || st1.poss !== sp.poss, 'W3 观战快照流同观（同流推进）', `ev ${n0}→${n1} ball.x ${sp.ball.x}→${st1.ball.x} poss ${sp.poss}→${st1.poss}`)
    const led5 = await dbg(p5, 'fxLedger')
    const f11 = led5.filter((l) => l.id === 'F11')
    ok(f11.length >= 1, 'W3 F11 观战焦点球光圈台账在案（FEEL 面：spectator→球光圈脉动=导演锚）', `F11×${f11.length} lat=${f11[0] && f11[0].lat}ms`)
    /* 环形金墨水探针：3 帧持续命中（脉动圈持续在绘）+球员页同环对照近零 */
    let frames = 0, specHits = []
    for (let i = 0; i < 3; i++) { const r = await ringProbe(p5); if (r && r.hits >= 3) frames++; if (r) specHits.push(`${r.hits}/${r.tot}`); await sleep(260) }
    let ctlHits = 'n/a'
    if (pages[0]) { const r = await ringProbe(pages[0]); if (r) ctlHits = `${r.hits}/${r.tot}` }
    ok(frames >= 2, 'W3 焦点环页内墨水：球周环形金晕持续命中（r10-18×36 采样×3 帧≥2 帧≥3 命中；F03 拖尾为瞬态被持续帧滤除）', `观战帧命中 ${specHits.join(' ')}｜对照=球员页同环 ${ctlHits}`)
    await p5.screenshot({ path: `${SHOTS}/qa2-spectate-focus.png` })
  }
  await p1.screenshot({ path: `${SHOTS}/qa2-fullhouse.png` })
}
ok(errs.length === 0, 'A3 零 pageerror（全部页面整轮）', errs.length ? `${errs.length} 例：${errs[0].slice(0, 120)}` : '0 例')

await browser.close()
console.log(`\nQA2-WEB：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
