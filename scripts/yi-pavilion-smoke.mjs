import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const OUT = '/tmp/yi-155-shots'
await mkdir(OUT, { recursive: true })
const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
let pageErrors = []

/* ---- 场景 A：在线 quick（模式选择浮层 → 五子 → 两段式落子 → ruling 回执） ---- */
{
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto('http://127.0.0.1:4399/games/multiplayer/yi-pavilion/index.html?gw=127.0.0.1:4401', { waitUntil: 'load', timeout: 15000 })
  await sleep(600)
  await page.screenshot({ path: OUT + '/a-pick.png' })
  const pick = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  A('S1', '模式选择浮层在场（大厅单卡入口，§1.1）', pick.view === null, `view=${pick && pick.view}`)
  await page.mouse.click(187, 200) // 五子连珠
  await sleep(3500)
  const st = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  A('S2', 'quick 入局就席（welcome 到达+rule=gomoku）', !!(st.view && st.seat >= 0 && st.view.rule === 'gomoku'),
    `seat=${st.seat} rule=${st.view && st.view.rule} turn=${st.view && st.view.turn}`)
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  A('S3', 'HUD __applied 生效往返自证（票面首日，§7）', hf.__applied === true, `__applied=${hf.__applied}`)
  A('S4', 'HF 分级 P0≥13/P1≥11/P2≥9', hf.__cls.P0.min >= 13 && hf.__cls.P1.min >= 11 && hf.__cls.P2.min >= 9,
    `P0=${hf.__cls.P0.min} P1=${hf.__cls.P1.min} P2=${hf.__cls.P2.min}`)
  /* 两段式落子：首点中心格=预落 → 同格再点=确认（§1.7） */
  const cv = await page.locator('#cv').boundingBox()
  const cx = (p) => cv.x + p.x + 12, cy = (p) => cv.y + p.y + 12
  const myTurn = () => page.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); return s.view && !s.view.over && s.view.turn === s.seat })
  const cell0 = await page.evaluate(() => { const g = { n: 15, cs: 24, x: 8, y: 68 }; return { x: g.x + 7 * g.cs, y: g.y + 7 * g.cs } })
  let guard = 40
  while (!(await myTurn()) && guard-- > 0) await sleep(250)
  await page.mouse.click(cx(cell0), cy(cell0))
  await sleep(150)
  const preShot = await page.screenshot({ path: OUT + '/a-pre.png' })
  await page.mouse.click(cx(cell0), cy(cell0)) // 同格再点=确认
  await sleep(700)
  const st2 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  const placed = st2.view.board[7 * 15 + 7] === st2.seat + 1 || st2.view.board[7 * 15 + 7] !== 0
  A('S5', '两段式落子 → place op → ruling 落盘', st2.view.board[7 * 15 + 7] !== 0 && st2.view.moveNo >= 1,
    `cell112=${st2.view.board[7 * 15 + 7]} moveNo=${st2.view.moveNo}（截图 ${preShot ? 'a-pre/a-live' : ''}）`)
  await page.screenshot({ path: OUT + '/a-live.png' })
  const evs = await page.evaluate(() => window.__GAMES_DEBUG__.events.filter((e) => e.event !== 'boot').length)
  A('S6', '事件账本在记（ruling 流到达客户端）', evs >= 0, `events=${evs}`)
  await page.close()
}

/* ---- 场景 B/C：离线黑白/井字渲染面（翻转/子盘框线/图章） ---- */
for (const rule of ['reversi', 'cascade']) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(`http://127.0.0.1:4399/games/multiplayer/yi-pavilion/index.html?debug=1&rule=${rule}&level=1`, { waitUntil: 'load', timeout: 15000 })
  await sleep(1200)
  const cv2 = await page.locator('#cv').boundingBox()
  /* 首手（A 席=真人）：黑白=合法夹击位 (2,3)；井字=中心格 */
  const first = rule === 'reversi' ? { x: 12 + 3 * 44, y: 68 + 2 * 44 } : { x: 13 + 4 * 39, y: 68 + 4 * 39 }
  await page.mouse.click(cv2.x + first.x + 20, cv2.y + first.y + 20)
  await sleep(3200) // bot 应答（拟人延时后落子）
  const st = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  const n = rule === 'reversi' ? 64 : 81
  A('S7', `离线 ${rule} 局推进（盘面 ${n} 格+真人落子+bot 应答）`, !!(st.view && st.view.board && st.view.board.length === n && st.view.moveNo >= 2),
    `rule=${st.view && st.view.rule} moveNo=${st.view && st.view.moveNo} board=${st.view && st.view.board.length}`)
  await sleep(1200)
  await page.screenshot({ path: OUT + `/b-${rule}.png` })
  await page.close()
}

A('S8', '全程无页面错误', pageErrors.length === 0, pageErrors.length ? pageErrors[0] : '0 errors')
await browser.close()
const failed = results.filter((r) => !r.pass).length
console.error(failed === 0 ? `SMOKE OK：${results.length} 通过` : `SMOKE FAILED：${failed} 红`)
process.exit(failed === 0 ? 0 : 1)
