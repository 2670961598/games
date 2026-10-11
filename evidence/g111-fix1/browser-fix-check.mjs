/* GAMES-111 FIX1 浏览器臂验证（真 Chromium，私口 :4398 静态 + 共享网关 :4400 + TCP 双向
 * 各 100ms 代理垫 :4441——QA1 browser-qa.mjs 同法）：
 *   [F9-a] quick 入房 → URL 回写 ?room= → 断线 5s → 裸 reload（不带手动 room=，QA1 v1 探针
 *          4 红的原路径）→ resume 复席保号 + tick 单调；
 *   [F9-b] ?room=<不存在> → room-gone 错误帧 → 自动摘参 quick 重开（入座成功）；
 *   [F1/F2 运行时] 200ms 代理臂驾驶 30s → netProbe：recon10s>0（修正台账激活——QA1 态恒 0）、
 *          hashBad=0 且 hashWarn=false（QA1 态 hashWarn 闩锁 true）。
 * 依赖 netProbe.reconPx/hashWarn 常驻暴露（GAMES-111 起常驻，非临时探针）。 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { chromium } from 'playwright'

const ROOT = '/Volumes/BigDisk/Studio/projects/GAMES/repo'
const SPORT = 4398, PPORT = 4441, DELAY_MS = 100
const results = []
const REC = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`  ${pass ? '✓' : '✗'} ${name} — ${detail}`) }

const srv = spawn(process.execPath, [ROOT + '/server/index.js'], {
  env: { ...process.env, PORT: String(SPORT), GAMES_DIR: ROOT + '/games' },
  stdio: ['ignore', 'ignore', 'pipe'],
})
await new Promise((res) => { setTimeout(res, 1500); fetch(`http://127.0.0.1:${SPORT}/api/health`).then(() => res()).catch(() => {}) })
const proxy = net.createServer((cli) => {
  const up = net.connect(4400, '127.0.0.1')
  cli.on('data', (d) => setTimeout(() => { try { up.write(d) } catch {} }, DELAY_MS))
  up.on('data', (d) => setTimeout(() => { try { cli.write(d) } catch {} }, DELAY_MS))
  cli.on('error', () => {}); up.on('error', () => {})
  cli.on('close', () => up.destroy()); up.on('close', () => cli.destroy())
})
proxy.listen(PPORT, '127.0.0.1')
const browser = await chromium.launch({ headless: true })

async function joinRoom(page, gw, room, timeoutMs = 20000) {
  await page.goto(`http://127.0.0.1:${SPORT}/games/multiplayer/speed-kart/index.html?gw=${gw}${room ? '&room=' + room : ''}`, { waitUntil: 'load' })
  await page.waitForFunction(() => {
    const el = document.getElementById('boot')
    return el && el.style.display === 'none' && window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().seat >= 0
  }, null, { timeout: timeoutMs })
  await page.waitForTimeout(600)
}
async function drive(page, ms) {
  await page.mouse.move(160, 400); await page.mouse.down()
  const t0 = Date.now(); let flip = true
  while (Date.now() - t0 < ms) { await page.mouse.move(flip ? 245 : 95, 400, { steps: 6 }); flip = !flip; await page.waitForTimeout(900) }
  await page.mouse.up()
}
const stateOf = (page) => page.evaluate(() => window.__GAMES_DEBUG__.state())

/* ---------- [F9-a] quick → 回写 → 裸 reload 复席 ---------- */
console.log('--- [F9-a] quick 入房 → URL 回写 → 断线 5s → 裸 reload（QA1 v1 4 红原路径） ---')
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  await joinRoom(page, 'ws://127.0.0.1:4400', null)
  const urlAfter = await page.evaluate(() => location.search)
  REC('F9-a quick 入房后 URL 回写 ?room=', /[?&]room=speed-/.test(urlAfter), `search=${urlAfter}`)
  await drive(page, 5000)
  const pre = await stateOf(page)
  await ctx.setOffline(true)
  await page.waitForTimeout(5000)
  await ctx.setOffline(false)
  await page.reload({ waitUntil: 'load' })          // 裸 reload：不带手动 room=（原缺陷路径）——URL 已被回写携带 ?room=
  await page.waitForFunction(() => {                // 原页原地复席（不得 goto 覆盖 URL）
    const el = document.getElementById('boot')
    return el && el.style.display === 'none' && window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().seat >= 0
  }, null, { timeout: 20000 })
  await page.waitForTimeout(800)
  await drive(page, 4000)
  const post = await stateOf(page)
  const probe = await page.evaluate(() => window.__GAMES_DEBUG__.netProbe())
  REC('F9-a 裸 reload 复席保号（10s 窗内）', post.seat === pre.seat && post.seat >= 0, `seat ${pre.seat}→${post.seat}`)
  REC('F9-a reload 后 tick 单调推进', post.tick > pre.tick, `tick ${pre.tick}→${post.tick}`)
  REC('F9-a reload 后预测对齐（hashWarn 未闩）', probe.hashWarn === false, `hashBad=${probe.hashBad} hashWarn=${probe.hashWarn}`)
  REC('F9-a 零 pageerror', errors.length === 0, errors.join('; ') || '无')
  await ctx.close()
}

/* ---------- [F9-b] ?room=<不存在> → room-gone → 自动 quick ---------- */
console.log('--- [F9-b] ?room= 不存在房 → room-gone 自动摘参 quick 重开 ---')
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  await joinRoom(page, 'ws://127.0.0.1:4400', 'speed-ZZZZGONE')
  const post = await stateOf(page)
  const url = await page.evaluate(() => location.search)
  REC('F9-b room-gone 自动 quick 入座', post.seat >= 0, `seat=${post.seat}`)
  REC('F9-b 摘参后 URL 无死房号', !url.includes('ZZZZGONE'), `search=${url}`)
  REC('F9-b 零 pageerror', errors.length === 0, errors.join('; ') || '无')
  await ctx.close()
}

/* ---------- [F1/F2 运行时] 200ms 代理臂 ---------- */
console.log('--- [F1/F2 运行时] 200ms 代理臂（双向各 100ms，驾驶 30s） ---')
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  await joinRoom(page, `ws://127.0.0.1:${PPORT}`, null)
  await drive(page, 30000)
  const probe = await page.evaluate(() => window.__GAMES_DEBUG__.netProbe())
  const px = probe.reconPx.map((r) => r.px).sort((a, b) => a - b)
  const med = px.length ? px[Math.floor(px.length / 2)] : 0
  const p95 = px.length ? px[Math.floor(px.length * 0.95)] : 0
  const hard = px.filter((v) => v > 6).length
  console.log(`  200ms 臂：ping=${probe.ping}ms recon事件=${px.length}/10s窗 中位=${med.toFixed(2)}px p95=${p95.toFixed(2)}px 硬回滚(>6px)=${hard} hashBad=${probe.hashBad} hashWarn=${probe.hashWarn}`)
  REC('F2 运行时 hash 哨兵零分歧（QA1 态=假分歧闩锁）', probe.hashBad === 0 && probe.hashWarn === false, `hashBad=${probe.hashBad} hashWarn=${probe.hashWarn}`)
  REC('F1 运行时和解台账激活（QA1 态恒 0）', px.length > 0, `recon 事件=${px.length}（10s 滚动窗口径=${probe.recon10s}）`)
  REC('F1 运行时修正量级落 §5.3 预算带（中位 ≤4px）', med <= 4, `中位=${med.toFixed(2)}px p95=${p95.toFixed(2)}px`)
  REC('F1/F2 零 pageerror', errors.length === 0, errors.join('; ') || '无')
  await ctx.close()
}

const bad = results.filter((r) => !r.pass).length
console.log(`\nGAMES-111 浏览器臂 ${bad === 0 ? 'OK' : `FAILED (${bad})`}`)
await browser.close(); srv.kill('SIGTERM'); proxy.close()
process.exit(bad === 0 ? 0 : 1)
