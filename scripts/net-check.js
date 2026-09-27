/* =====================================================================
 * 联机基座 E2E 自检（GAMES-40 · 三支柱之 play + 联机红线）——node scripts/net-check.js
 * 前置：网关(:4400) 与平台(:4399) 均在运行。
 * 断言组：
 *   N1 大厅：加载/feed 卡片≥1/21 槽/网关状态/几何净（375 宽无横向溢出）
 *   N2 点击加入→可操作 <2s（红线）
 *   N3 bot 让位：真人入座 4 bot 房 → 3 bot + feed humans=1
 *   N4 帧推进 + 键盘输入生效（本地镜像模拟）
 *   N5 断线重连：刷新页面凭 token 复席（同 seat，帧继续）
 *   N6 play 四断言（离线脚本局）：A1 事件闭环 boot→start→levelEnd/end；
 *      A2 可赢（队友竞技 bot 带躺，真人同队）；A3 可输（三竞技 bot 猎杀挂机）；
 *      A4 输入→呈现 <100ms（perf().inputMaxMs）
 *   N7 feed 5s 新鲜度：真人入房 5s 内可见；离线 abandoned 房 5s 内消失
 *   N8 满员旁观：4 真人占满后第 5 连接 role=spectator
 * 截图：kernel/workers/GAMES-40-shots/{lobby,play,result}.png（375×667，DPR=1）
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GW = 'http://127.0.0.1:4400'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-40-shots'

let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const feed = async () => (await (await fetch(`${GW}/api/matches`)).json()).matches

/* ---------- WS 小客户端（N7/N8 直接打网关） ---------- */
function wsOpen() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:4400/ws`)
    const h = { ws, msgs: [], next(pred, timeout = 8000) {
      const hit = h.msgs.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('ws timeout')), timeout)
        h.waiters.push({ pred, res, t })
      })
    }, waiters: [] }
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      const i = h.waiters.findIndex((w) => w.pred(m))
      if (i >= 0) { clearTimeout(h.waiters[i].t); h.waiters.splice(i, 1)[0].res(m) }
      else h.msgs.push(m)
    })
    ws.addEventListener('open', () => resolve(h))
    ws.addEventListener('error', reject)
  })
}

await mkdir(SHOTS, { recursive: true })
let browser
try { browser = await chromium.launch({ headless: true }) }
catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }) }
const page = await (await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1 })).newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

/* ---------- N1 大厅 ---------- */
console.log('[N1] 联机大厅')
await page.goto(`${WEB}/multiplayer.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('.mp-card', { timeout: 8000 })
ok(true, '大厅加载且 feed 渲染出对局卡')
const slots = await page.locator('.mp-slot').count()
ok(slots === 21, '联机目录 21 槽位', `实测 ${slots}`)
const netState = await page.locator('#mp-net').textContent()
ok(/网关在线/.test(netState), '网关状态在线', netState.trim())
const geo = await page.evaluate(() => {
  const de = document.documentElement
  const overflow = de.scrollWidth - de.clientWidth
  let out = 0
  for (const el of document.querySelectorAll('#mp *')) {
    // 横滑容器（.mp-feed）内的卡片按设计截断，不计出界；只查页面级溢出
    if (el.closest('.mp-feed')) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.right > de.clientWidth + 0.5 || r.left < -0.5)) out++
  }
  return { overflow, out }
})
ok(geo.overflow <= 0 && geo.out === 0, '几何净（375 宽无横向溢出/无出界元素）', `overflow=${geo.overflow}px out=${geo.out}`)
await page.screenshot({ path: `${SHOTS}/lobby.png` })

/* ---------- N2/N3 点击加入 <2s + bot 让位 ---------- */
console.log('[N2/N3] 点击加入与 bot 让位')
const t0 = Date.now()
// 选 net-tank 卡（后续 N3-N8 断言绑 net-tank 房形状；多游戏注册后首卡不保证是它——GAMES-52）
await page.locator('.mp-card[href*="net-tank"]').first().click()
await page.waitForFunction(() => {
  const d = window.__GAMES_DEBUG__
  return d && d.state() && d.events.some((e) => e.event === 'start')
}, null, { timeout: 15000 })
const joinMs = Date.now() - t0
ok(joinMs < 2000, '点击对局卡 → 可操作 <2s（红线）', `${joinMs}ms`)
await page.waitForFunction(() => window.__GAMES_DEBUG__.seat() >= 0, null, { timeout: 5000 })
const mySeat = await page.evaluate(() => window.__GAMES_DEBUG__.seat())
const mode = await page.evaluate(() => window.__GAMES_DEBUG__.mode())
ok(mode === 'online', '在线模式（未降级离线）')
const st1 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
ok(st1.tanks.length === 4, '4 席房初态')
const roomId = new URLSearchParams(new URL(page.url()).search).get('room')
const m1 = (await feed()).find((m) => m.roomId === roomId)
ok(m1 && m1.humans === 1 && m1.bots === 3, 'bot 让位：feed 反映 1 真人 3 bot', m1 ? `humans=${m1.humans} bots=${m1.bots}` : 'room 不在 feed')

/* ---------- N4 帧推进 + 输入生效 ---------- */
console.log('[N4] 帧推进与输入')
const tickA = (await page.evaluate(() => window.__GAMES_DEBUG__.state())).tick
await page.keyboard.down('d')
await sleep(1500)
await page.keyboard.up('d')
const s2 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
ok(s2.tick > tickA + 8, '帧持续推进（本地镜像模拟）', `tick ${tickA}→${s2.tick}`)
const me = s2.tanks[mySeat]
ok(me.alive, '我的坦克存活')
const moved = Math.abs(me.x - st1.tanks[mySeat].x) + Math.abs(me.y - st1.tanks[mySeat].y) > 0
ok(moved, '键盘输入生效（坦克位移）')
await page.screenshot({ path: `${SHOTS}/play.png` })

/* ---------- N5 断线重连（刷新页面复席；用最新房避免撞自然终局） ---------- */
console.log('[N5] 断线重连')
await page.goto(`${WEB}/games/multiplayer/net-tank/index.html?quick=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => {
  const d = window.__GAMES_DEBUG__
  return d && d.state() && d.events.some((e) => e.event === 'start')
}, null, { timeout: 12000 })
const seatQuick = await page.evaluate(() => window.__GAMES_DEBUG__.seat())
const quickRoom = await page.evaluate(() => window.__GAMES_DEBUG__.roomId())
const tickQuick = (await page.evaluate(() => window.__GAMES_DEBUG__.state())).tick
// 断线重连路径：携 ?room=<id> 重进（SDK 从 sessionStorage 取 token 复席；quick 重进会被视为新加入）
await page.goto(`${WEB}/games/multiplayer/net-tank/index.html?room=${quickRoom}`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => {
  const d = window.__GAMES_DEBUG__
  return d && d.state() && d.events.some((e) => e.event === 'start')
}, null, { timeout: 12000 })
const seat2 = await page.evaluate(() => window.__GAMES_DEBUG__.seat())
ok(seat2 === seatQuick, `刷新后凭 token 复席（seat ${seatQuick} 保持）`)
await sleep(1000)
const tickAfter = (await page.evaluate(() => window.__GAMES_DEBUG__.state())).tick
const endHit = await page.evaluate(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'end'))
ok(tickAfter > tickQuick || endHit, '重连后帧继续推进（10s 重连窗内；或恰逢自然终局）', `tick ${tickQuick}→${tickAfter}${endHit ? '（终局）' : ''}`)
await page.close()

/* ---------- N6 play 四断言（离线脚本局） ---------- */
console.log('[N6] play 四断言（离线）')
const p2 = await (await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1 })).newPage()
const errs2 = []
p2.on('pageerror', (e) => errs2.push(String(e)))
await p2.goto(`${WEB}/games/multiplayer/net-tank/index.html?debug=1`, { waitUntil: 'networkidle' })
await p2.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'))
// A1/A3 可输：敌方双竞技猎杀挂机真人，我方队友休闲（无带躺）
await p2.evaluate(() => window.__GAMES_DEBUG__.start(1, { bots: ['competitive', 'casual', 'competitive'] }))
await p2.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'end'), null, { timeout: 60000 })
const events1 = await p2.evaluate(() => window.__GAMES_DEBUG__.events.map((e) => e.event))
ok(events1.includes('start') && events1.includes('levelEnd') && events1.includes('end'), 'A1 事件闭环 boot→start→levelEnd→end', events1.join('→'))
const losePayload = await p2.evaluate(() => window.__GAMES_DEBUG__.events.find((e) => e.event === 'levelEnd').payload)
ok(losePayload.win === 0, 'A3 可输：挂机被竞技 bot 歼灭', JSON.stringify(losePayload))
// A2 可赢：真人同队配竞技队友（bots 映射 seat1..3；seat2 是我方队友）——seedSalt 钉死确定性地图
// 先清空事件账本：A3 的 end/levelEnd 残留会让本局断言读旧账
await p2.evaluate(() => { window.__GAMES_DEBUG__.events.length = 0 })
await p2.evaluate(() => window.__GAMES_DEBUG__.start(1, { bots: ['casual', 'competitive', 'casual'], seedSalt: '1', maxTicks: 1200 }))
await p2.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'start'))
const driveEnd = p2.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'end'), null, { timeout: 90000 }).catch(() => null)
for (let i = 0; i < 240; i++) {
  const over = await p2.evaluate(() => {
    const d = window.__GAMES_DEBUG__
    if (d.events.some((e) => e.event === 'end')) return true
    const st = d.state()
    if (!st) return false
    const me = st.tanks[0]
    if (!me || !me.alive) return false
    return null
  })
  if (over) break
  // 真键盘输入：朝最近敌人方向 8 向逼近 + 开火
  await p2.evaluate(() => {
    const st = window.__GAMES_DEBUG__.state()
    const me = st.tanks[0]
    let best = null, bd = Infinity
    for (const t of st.tanks) { if (t.alive && t.team !== me.team) { const d = (t.x - me.x) ** 2 + (t.y - me.y) ** 2; if (d < bd) { bd = d; best = t } } }
    if (!best) return
    const dx = best.x - me.x, dy = best.y - me.y
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w')
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    window.__lastKey = key
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  await sleep(250)
  await p2.evaluate(() => {
    if (window.__lastKey) window.dispatchEvent(new KeyboardEvent('keyup', { key: window.__lastKey, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
  })
}
await driveEnd
const winPayload = await p2.evaluate(() => window.__GAMES_DEBUG__.events.filter((e) => e.event === 'levelEnd').pop().payload)
ok(winPayload && winPayload.win === 1, 'A2 可赢：真人参战同队获胜', JSON.stringify(winPayload))
// A4 输入延迟
const perf = await p2.evaluate(async () => {
  const d = window.__GAMES_DEBUG__
  d.start(1, {})
  await new Promise((r) => setTimeout(r, 600))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', timeStamp: performance.now(), bubbles: true }))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }))
  return d.perf()
})
ok(perf.inputMaxMs < 100, 'A4 输入→呈现 <100ms', `inputMaxMs=${perf.inputMaxMs}ms`)
ok(errs2.length === 0, 'A3(零 pageerror)：整轮无页面错误', errs2.slice(0, 2).join('; '))
await p2.screenshot({ path: `${SHOTS}/offline.png` })
await p2.close()

/* ---------- N7 feed 5s 新鲜度 + N8 满员旁观 ---------- */
console.log('[N7/N8] feed 新鲜度与旁观（WS 直打）')
const m0 = await feed()
const target = m0.find((x) => x.gameId === 'net-tank' && x.joinable && x.bots >= 4) // 绑 net-tank：满员旁观/abandon 语义按对局房断言；常驻镇（GAMES-52）人口动态调节且不 abandon，不可作为该断言对象
ok(!!target, '存在可入 bot 房')
const players = []
for (let i = 0; i < 4; i++) {
  const h = await wsOpen()
  h.ws.send(JSON.stringify({ t: 'join', roomId: target.roomId, mode: 'play' }))
  const w = await h.next((m) => m.t === 'welcome')
  players.push({ h, w })
}
ok(players.every((p) => p.w.role === 'player'), '4 真人全部入座（bot 全让位）')
const spec = await wsOpen()
spec.ws.send(JSON.stringify({ t: 'join', roomId: target.roomId, mode: 'play' }))
const wspec = await spec.next((m) => m.t === 'welcome')
ok(wspec.role === 'spectator', 'N8 满员后第 5 人 → 旁观', `role=${wspec.role}`)
let seenChange = -1
for (let i = 0; i < 5; i++) {
  await sleep(1000)
  const mm = (await feed()).find((x) => x.roomId === target.roomId)
  if (mm && mm.humans === 4) { seenChange = i + 1; break }
}
ok(seenChange > 0, 'N7 feed 5s 内反映 humans=4', `${seenChange}s`)
// 全员离线 → abandon（15s）→ 5s 内从 feed 消失
for (const p of players) p.h.ws.close()
spec.ws.close()
let goneAt = 0
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  const still = (await feed()).some((x) => x.roomId === target.roomId)
  if (!still) { goneAt = i + 1; break }
}
ok(goneAt > 0, 'abandon 后房间从 feed 消失', `${goneAt}s（含 15s abandon 窗）`)
const finalFeed = await feed()
ok(finalFeed.filter((m) => m.gameId === 'net-tank').length >= 2, 'BotHost 常驻补房（feed 恢复 ≥2 间）', `${finalFeed.length} 间`)

await browser.close()

ok(pageErrors.length === 0, '浏览器会话零 pageerror', pageErrors.slice(0, 2).join(';'))
console.log(`\n${failed === 0 ? 'NET-CHECK OK' : 'NET-CHECK FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
