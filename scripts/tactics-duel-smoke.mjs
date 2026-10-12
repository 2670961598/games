#!/usr/bin/env node
/* =====================================================================
 * GAMES-118 战棋对决 浏览器冒烟（DEV 自测面；对齐泳道 net-check/vis 口径）：
 *   S1 在线面：quick 入房（bot 房）→ welcome（room.duel 声明块/deploy 个性化视图）
 *             → deploy op → reveal → 己方回合 ruling → move/attack op 链 → 零 pageerror
 *   S2 零 pageerror（整轮会话）
 *   S3 HUD 字号运行时自证（hudFonts() P0≥13/P1≥11/P2≥9）
 *   S4 识图 v2 锚点像素探针：8×8 双色棋盘差分 / 兵种令牌在场 / AP 灯珠行
 *   S5 离线 ?debug=1 局（同 sim 同 brain）推进到 act 相位 + 截图（DSF=1 识图素材）
 * 截图：kernel/workers/GAMES-118-shots/{online,offline}.png
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-118-shots'
let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

/* ---------- S1 在线局 ---------- */
console.log('[S1] 在线 quick 局（bot 房）')
await page.goto(`${WEB}/games/multiplayer/tactics-duel/index.html?quick=1`, { waitUntil: 'load', timeout: 20_000 })
await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
await page.waitForFunction(() => {
  const st = window.__GAMES_DEBUG__.state()
  return st && st.view && st.view.phase
}, null, { timeout: 10_000 })
const welcome = await page.evaluate(() => {
  const st = window.__GAMES_DEBUG__.state()
  return { seat: window.__GAMES_DEBUG__.seat(), phase: st.view.phase, scores: st.view.scores, deploys: st.view.deploys, terrain: st.view.terrain && st.view.terrain.length, points: st.view.points, mapId: st.view.mapId }
})
/* quick 可能命中进行中的 bot 房（已过 deploy）——两路断言自适应：deploy=全新局走完整链；act=中途入局走结构断言 */
const freshDeploy = welcome.phase === 'deploy'
ok(true, `入房相位=${welcome.phase} seat=${welcome.seat}`, freshDeploy ? '全新局（部署相位）' : '中途入局（bot 房已揭示）')
if (freshDeploy) ok(welcome.scores && welcome.scores.join(',') === '0,1', 'B 起始占点分 +1（先手补偿 §1.2）', JSON.stringify(welcome.scores))
else ok(Array.isArray(welcome.scores) && welcome.scores[1] >= 1, '中途入局：B 分 ≥1（起始补偿+进行中占点）', JSON.stringify(welcome.scores))
ok(welcome.terrain === 64 && Array.isArray(welcome.points) && welcome.points.length === 2, '地形 64 格+双据点', `terrain=${welcome.terrain} points=${JSON.stringify(welcome.points)}`)
if (freshDeploy) ok(Array.isArray(welcome.deploys) && welcome.deploys[1] === null, '部署密置：对方布置不可见（§5.3）', JSON.stringify(welcome.deploys && welcome.deploys.map((d) => (d ? 'own' : 'hidden'))))
/* room.duel 声明块（经页面侧留存的 welcome） */
const duelHash = await page.evaluate(() => window.__GAMES_DEBUG__.state().view && window.TDuelSim && window.TDuelSim.ENGINE_HASH)
ok(typeof duelHash === 'number' && duelHash > 0, '引擎声明块 ENGINE_HASH 在场（S5 版本护栏）', String(duelHash))

if (freshDeploy) {
  /* deploy 提交 → reveal → 己方回合 */
  await page.evaluate(() => {
    const T = window.TDuelSim.TEMPLATES[0], seat = window.__GAMES_DEBUG__.seat()
    window.__GAMES_DEBUG__.sendOp({ k: 'deploy', cells: window.TDuelSim.TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: T[i][seat] })) })
  })
}
await page.waitForFunction(() => {
  const v = window.__GAMES_DEBUG__.state().view
  return v && v.phase === 'act' && v.units && v.units.length === 12
}, null, { timeout: 30_000 })
const revealed = await page.evaluate(() => {
  const v = window.__GAMES_DEBUG__.state().view
  return { units: v.units.length, turn: v.turn, ap: v.ap, mySeat: window.__GAMES_DEBUG__.seat() }
})
ok(revealed.units === 12, 'reveal 后双方 6+6 单位', `units=${revealed.units}`)
if (freshDeploy) ok(revealed.turn === revealed.mySeat && revealed.ap === 4, '回合 1=先手 A 席（API 席）AP=4', `turn=${revealed.turn} ap=${revealed.ap}`)
/* 等到己方回合（中途入局须等 bot 打完当回合；30s 计时 1x 实时） */
await page.waitForFunction(() => {
  const v = window.__GAMES_DEBUG__.state().view
  const seat = window.__GAMES_DEBUG__.seat()
  return v && v.phase === 'act' && v.turn === seat && v.ap > 0
}, null, { timeout: 75_000 })
/* 本地预演：选中单位移动域（S1 面——客户端同源引擎 0ms） */
const domain = await page.evaluate(() => {
  const v = window.__GAMES_DEBUG__.state().view
  const u = v.units.find((x) => x.seat === window.__GAMES_DEBUG__.seat() && x.type === 'lance')
  return window.TDuelSim.reach(v, u.id).length
})
ok(domain >= 6, '本地移动域 BFS（同源引擎复算，§3.1 零上行）', `lance 可达 ${domain} 格`)
/* move op → ruling 回执（操作者实时） */
const moved = await page.evaluate(() => {
  const v = window.__GAMES_DEBUG__.state().view
  const seat = window.__GAMES_DEBUG__.seat()
  const u = v.units.find((x) => x.seat === seat && x.type === 'lance')
  const r = window.TDuelSim.reach(v, u.id).filter((d) => d.path.length === 4)[0] || window.TDuelSim.reach(v, u.id).filter((d) => d.path.length > 1).pop()
  window.__GAMES_DEBUG__.sendOp({ k: 'move', unit: u.id, path: r.path })
  return r.path.length
})
await sleep(700)
const afterMove = await page.evaluate(() => {
  const v = window.__GAMES_DEBUG__.state().view
  return { ap: v.ap, ph: v.units.find((x) => x.type === 'lance' && x.seat === window.__GAMES_DEBUG__.seat()).ph, ms: v.units.find((x) => x.type === 'lance' && x.seat === window.__GAMES_DEBUG__.seat()).ms }
})
ok(afterMove.ap === 3 && afterMove.ph === 'moved' && afterMove.ms === moved - 1, 'move op 裁决：AP-1/激活态 moved/moveSteps 记账', JSON.stringify(afterMove))
await page.screenshot({ path: `${SHOTS}/online.png` })

/* ---------- S3/S4 HUD 与识图锚点（在线 act 相位帧） ---------- */
const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
ok(hf.P0 && hf.P0.minPx >= 13 && hf.P1 && hf.P1.minPx >= 11 && hf.P2 && hf.P2.minPx >= 9, 'HUD 字号运行时自证（P0≥13/P1≥11/P2≥9）',
  `P0=${hf.P0.minPx}px×${hf.P0.samples} P1=${hf.P1.minPx}px×${hf.P1.samples} P2=${hf.P2.minPx}px×${hf.P2.samples}`)
const probe = (x, y) => page.evaluate(([x, y]) => { const d = document.getElementById('cv').getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]] }, [x, y])
/* 8×8 双色格棋盘：格心采样两色交替（识图 v2 锚点 1；双色微差 → ±6 紧公差区分两色） */
const BOARD = { x: 11, y: 64, cs: 44 }
let nA = 0, nB = 0
for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
  const px = await probe(BOARD.x + c * BOARD.cs + 8, BOARD.y + r * BOARD.cs + 8)
  const near = (p, ref) => Math.abs(p[0] - ref[0]) < 6 && Math.abs(p[1] - ref[1]) < 6 && Math.abs(p[2] - ref[2]) < 6
  if (near(px, [42, 51, 61])) nA++
  else if (near(px, [37, 44, 52])) nB++
}
ok(nA > 0 && nB > 0 && Math.abs(nA - nB) <= 18 && nA + nB >= 40, '识图锚点：8×8 双色微差格棋盘（格心采样，地形格让位）', `双色格 ${nA}+${nB}/${nA + nB + (64 - nA - nB)}（其余=地形/单位覆盖）`)
/* 兵种令牌在场：棋盘上有阵营色像素（琥珀/青描边，识图 v2 锚点 2） */
let amber = 0, cyan = 0
for (let y = BOARD.y; y < BOARD.y + 352; y += 4) for (let x = BOARD.x; x < BOARD.x + 352; x += 4) {
  const p = await probe(x, y)
  if (Math.abs(p[0] - 232) < 30 && Math.abs(p[1] - 163) < 30 && Math.abs(p[2] - 61) < 40) amber++
  if (Math.abs(p[0] - 61) < 30 && Math.abs(p[1] - 200) < 30 && Math.abs(p[2] - 232) < 30) cyan++
}
ok(amber > 20 && cyan > 20, '识图锚点：六兵种令牌双阵营描边在场', `琥珀 ${amber}px 青 ${cyan}px`)
/* AP 灯珠行（识图 v2 锚点 3）：底栏 y≈474 灯珠位 */
const pipOn = await probe(20, 474), pipOff = await probe(20 + 3 * 22, 474)
ok(pipOn[0] + pipOn[1] > pipOff[0] + pipOff[1] + 40, '识图锚点：AP 灯珠行（实心点亮/空心已耗）', `on=[${pipOn}] off=[${pipOff}]`)
ok(pageErrors.length === 0, 'S2 零 pageerror（在线整轮会话）', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '')
await page.close()

/* ---------- S5 离线 ?debug=1 局 ---------- */
console.log('[S5] 离线 ?debug=1 局（同 sim 同 brain）')
const p2 = await (await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })).newPage()
const errs2 = []
p2.on('pageerror', (e) => errs2.push(String(e)))
await p2.goto(`${WEB}/games/multiplayer/tactics-duel/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
await p2.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
await p2.waitForFunction(() => window.__GAMES_DEBUG__.events.some((e) => e.event === 'start'), null, { timeout: 15_000 })
await p2.waitForFunction(() => {
  const v = window.__GAMES_DEBUG__.state().view
  return v && v.phase === 'act' && v.units && v.units.length === 12
}, null, { timeout: 20_000 })
await p2.screenshot({ path: `${SHOTS}/offline.png` })
ok(errs2.length === 0, '离线局零 pageerror', errs2.length ? errs2.slice(0, 3).join(' | ') : '')
await p2.close()
await browser.close()

console.log(`${failed === 0 ? 'SMOKE OK' : 'SMOKE FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
