#!/usr/bin/env node
/* =====================================================================
 * GAMES-95 元素对决 VIS 断言工具（对齐 vis-pool-physics.mjs / hud-font-standard §4 口径）：
 *   V-HUD-1  运行时 hudFonts() 自证（P0≥13/600 · P1≥11 · P2≥9）
 *            + 源码静态双审计（零裸 ctx.font；F[012](px) 字面量按类归位——
 *            兜条件态键：结算页/托管徽标等仅特定 UI 态绘制，运行时表抓不全）
 *   V-HUD-2  倒计时秒/回合数已升 P0（静态正则锚 status 行 F0(13) 混排段）
 *   V-CB-1   选英雄浮层四系色卡：边框描边像素 ≈ SC[school]（3 偏移取优，细描边采样范式）
 *            + 字形通道活性：四卡 glyph 中心 11×11 采样命中系色 ≥6（▲●➤⚡ 全系覆盖）
 *   V-CB-2   系色 luma 表（BT.601）：N/T Δ<15 同化 → 字形为强制第二通道（结论断言，非缺陷）
 *   V-POLISH-1 三区视觉分区标记：场面/手牌区名标签 + 坟场票根（墨水计数探针）+ 场面背板描边
 *   截图落 <OUT_DIR>/g95-{pick,mulligan,play}.png（DSF=1，识图 v2 素材）
 * 用法：node scripts/vis-element-duel.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '/Volumes/BigDisk/Studio/kernel/workers/GAMES-95-shots'

/* ---------- 事实源常量（与 client.js 同源拷贝；改动须双改） ---------- */
const SC = { F: [232, 93, 61], W: [61, 168, 232], N: [124, 232, 184], T: [232, 201, 61] } // #E85D3D #3DA8E8 #7CE8B8 #E8C93D
const HERO_SCHOOL = ['F', 'W', 'N', 'T'] // HEROES 炎阳/潮汐/疾风/雷鸣
const pickRect = (i) => ({ x: 18 + (i % 2) * 176, y: 150 + ((i / 2) | 0) * 190, w: 162, h: 176 })
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b
const dist2 = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-eduel-'))
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
  /* ---------- 静态审计（先跑：零依赖） ---------- */
  const src = await readFile(join(ROOT, 'games/multiplayer/element-duel/client.js'), 'utf8')
  /* s[1] 间接赋值=状态行混排段表（其字体元素全部为 F0/F1/F2 字面量构造，由 V-HUD-1b 覆盖）；
   * 「px system-ui」构造点唯一（=HF 登记表 font()）是更强不变量：全文件无处另造字体字串。 */
  const bareFonts = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /ctx\.font\s*=/.test(l) && !/F[012]\(/.test(l) && !/ctx\.font\s*=\s*s\[1\]/.test(l))
  const registrarN = (src.match(/px system-ui/g) || []).length
  A('V-HUD-1a', '零裸字号（ctx.font 全走 F0/F1/F2 登记表；字体构造点唯一）', bareFonts.length === 0 && registrarN === 1,
    bareFonts.length ? `裸字号 L${bareFonts.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${registrarN}（唯一=HF 登记表）`)
  const cls = { 0: [], 1: [], 2: [] }
  for (const m of src.matchAll(/F([012])\((\d+)[,)]/g)) cls[m[1]].push(Number(m[2]))
  const bound = { 0: [13, 600], 1: [11, 600], 2: [9, 500] }
  const clsOk = [0, 1, 2].every((k) => cls[k].length && Math.min(...cls[k]) >= bound[k][0])
  A('V-HUD-1b', 'F0/F1/F2 字面量归位（P0≥13/P1≥11/P2≥9）', clsOk,
    `P0[${Math.min(...cls[0])}..${Math.max(...cls[0])}]×${cls[0].length} P1[${Math.min(...cls[1])}..${Math.max(...cls[1])}]×${cls[1].length} P2[${Math.min(...cls[2])}..${Math.max(...cls[2])}]×${cls[2].length}`)
  const cd = /' · ' \+ turnSec \+ 's', F0\(14\)/.test(src), tn = /String\(turnNo\), F0\(14\)/.test(src)
  A('V-HUD-2', '倒计时秒/回合数 = F0(14) 混排段（状态行 P0 升档+层级感）', cd && tn, `countdown=${cd ? 'F0(14)' : 'MISS'} turnNo=${tn ? 'F0(14)' : 'MISS'}`)
  const lumas = {}; for (const k in SC) lumas[k] = +luma(SC[k]).toFixed(1)
  const nt = Math.abs(lumas.N - lumas.T)
  A('V-CB-2', 'N/T 系色 luma 同化（Δ<15）→ 字形通道强制', nt < 15, `luma F${lumas.F}/W${lumas.W}/N${lumas.N}/T${lumas.T}，N-T Δ${nt.toFixed(1)}`)

  /* ---------- 运行时（?debug=1 离线确定性局，同 visual-check 驱动口径） ---------- */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/element-duel/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
  await page.waitForTimeout(500) // pick 浮层就绪

  const probe = (x, y) => page.evaluate(([x, y]) => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(x, y, 1, 1).data
    return [d[0], d[1], d[2]]
  }, [x, y])

  /* V-HUD-1c 运行时登记表自证 */
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  A('V-HUD-1c', 'hudFonts() 运行时自证', hf.P0 && hf.P0.minPx >= 13 && hf.P1 && hf.P1.minPx >= 11 && hf.P2 && hf.P2.minPx >= 9 && hf.P0.samples > 0 && hf.P1.samples > 0 && hf.P2.samples > 0,
    `P0=${hf.P0.minPx}px×${hf.P0.samples} P1=${hf.P1.minPx}px×${hf.P1.samples} P2=${hf.P2.minPx}px×${hf.P2.samples}`)

  /* V-CB-1 pick 浮层：四系色边框 + 字形通道 */
  await page.screenshot({ path: join(OUT, 'g95-pick.png') })
  let cbAll = true, cbDetail = []
  for (let i = 0; i < 4; i++) {
    const r = pickRect(i), sc = SC[HERO_SCHOOL[i]]
    let borderHit = false
    for (const dx of [-1, 0, 1]) { const p = await probe(Math.round(r.x) + dx, Math.round(r.y + r.h / 2)); if (dist2(p, sc) <= 40) borderHit = true }
    const gc = { x: r.x + r.w / 2, y: r.y + 46 }
    let glyphHits = 0
    for (let a = -5; a <= 5; a++) for (let b = -5; b <= 5; b++) { const p = await probe(Math.round(gc.x + a * 2), Math.round(gc.y + b * 2)); if (dist2(p, sc) <= 45) glyphHits++ }
    const ok = borderHit && glyphHits >= 6
    cbAll = cbAll && ok
    cbDetail.push(`${HERO_SCHOOL[i]}:边框${borderHit ? '✓' : '✗'}/字形${glyphHits}`)
  }
  A('V-CB-1', '四系色双通道（边框色相 + 字形墨迹）', cbAll, cbDetail.join(' '))

  /* 驱动到 mulligan → play（真人席 op 走 sendOp 同权威入口） */
  await page.evaluate(() => window.__GAMES_DEBUG__.sendOp({ k: 'pick', hero: 0 }))
  await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'mulligan' && Array.isArray(v.hand[0]) && v.hand[0].length }, null, { timeout: 20_000 })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, 'g95-mulligan.png') })
  await page.evaluate(() => { const v = window.__GAMES_DEBUG__.state().view; window.__GAMES_DEBUG__.sendOp({ k: 'mulligan', keep: v.hand[0].map(() => true) }) })
  await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'play' }, null, { timeout: 20_000 })
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await page.screenshot({ path: join(OUT, 'g95-play.png') })

  /* V-POLISH-1 三区标记：区名标签墨水计数 + 背板描边 + 坟场票根 */
  const inkCount = (x, y, w, h, bg) => page.evaluate(([x, y, w, h, bg]) => {
    const g = document.getElementById('cv').getContext('2d')
    const d = g.getImageData(x, y, w, h).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if (Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > 40) n++
    }
    return n
  }, [x, y, w, h, bg])
  const tagBoard = await inkCount(18, 297, 34, 11, [34, 22, 67])   // 「场面」on 背板 #221643
  const tagHand = await inkCount(14, 481, 26, 11, [34, 22, 67])    // 「手牌」on 手牌带
  const graveN = await inkCount(332, 480, 22, 12, [34, 22, 67])    // 坟场计数 F0(13)
  let panelStroke = false
  for (const dx of [-1, 0, 1]) { const p = await probe(12 + dx, 200); if (dist2(p, [59, 43, 110]) <= 35) panelStroke = true }
  A('V-POLISH-1', '三区视觉分区（场面/手牌标签 + 坟场票根 + 背板描边）', tagBoard >= 6 && tagHand >= 6 && graveN >= 4 && panelStroke,
    `场面标${tagBoard} 手牌标${tagHand} 坟场计${graveN} 描边${panelStroke ? '✓' : '✗'}`)
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))

  /* 部署一枚随从 → 棋盘帧（攻/血 16px 与场上字形通道的目击/像素素材；t1 空盘识图帧不可证） */
  const COST = { F1: 1, F2: 2, F3: 5, F4: 6, W1: 1, W2: 3, W3: 4, W4: 6, N1: 1, N2: 2, N3: 3, N4: 5, T1: 1, T2: 2, T3: 4, T4: 6, FS1: 3, FS2: 4, WS1: 1, WS2: 2, NS1: 3, NS2: 1, TS1: 2, TS2: 5, X0: 0 }
  const SPELL = new Set(['FS1', 'FS2', 'WS1', 'WS2', 'NS1', 'NS2', 'TS1', 'TS2', 'X0'])
  let deployed = false, deployTurns = 0
  for (let t = 0; t < 90 && !deployed; t++) {
    const v = await page.evaluate(() => window.__GAMES_DEBUG__.state().view)
    if (!v || v.phase !== 'play') break
    if (v.turn === 0 && v.board.some((c) => c)) deployed = true
    else if (v.turn === 0) {
      const i = (v.hand[0] || []).findIndex((id) => !SPELL.has(id) && (COST[id] || 9) <= v.heroes[0].mana)
      if (i >= 0) { await page.evaluate((i) => window.__GAMES_DEBUG__.sendOp({ k: 'play', card: i, cell: 4 }), i); await page.waitForTimeout(500) }
      else { await page.evaluate(() => window.__GAMES_DEBUG__.sendOp({ k: 'endTurn' })); deployTurns++; await page.waitForTimeout(600) }
    } else await page.waitForTimeout(600)
  }
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await page.screenshot({ path: join(OUT, 'g95-board.png') })
  const vb = await page.evaluate(() => window.__GAMES_DEBUG__.state().view)
  const m4 = vb && vb.board[4]
  if (m4) { /* 中心格随从：攻血墨水 + 系色顶带 + 字形（cell4 x=135 y=180 w=105 h=54） */
    const statInk = await inkCount(140, 208, 62, 20, [42, 27, 74])
    let bandHit = false
    for (const dx of [0, 2, 52]) { const p = await probe(135 + 2 + dx, 182); if (Object.values(SC).some((c) => dist2(p, c) <= 40)) bandHit = true }
    const statsOk = statInk >= 8 && bandHit
    A('V-POLISH-2', '场上随从卡面（攻/血 16px 墨迹 + 系色顶带）', statsOk, `攻血墨${statInk} 顶带${bandHit ? '✓' : '✗'}（cell4=${m4.c}）${deployTurns ? ` 部署耗 ${deployTurns} 轮换牌等待` : ''}`)
  } else A('V-POLISH-2', '场上随从卡面（攻/血 16px 墨迹 + 系色顶带）', false, '90 拍内未部署到中心格（手牌无随从）')
  await context.close()
} catch (e) {
  results.push({ id: 'E-drive', name: '驱动/断言异常', pass: false, detail: String(e && e.message || e).slice(0, 300) })
} finally {
  await browser.close()
  await rm(dataDir, { recursive: true, force: true })
  try { server.kill('SIGTERM') } catch { /* best effort */ }
}
const report = { tool: 'scripts/vis-element-duel.mjs (GAMES-95)', generatedAt: new Date().toISOString(), results, pageErrors }
console.log(JSON.stringify(report, null, 2))
const bad = results.filter((r) => !r.pass)
console.error(`\n[vis-element-duel] ${results.length - bad.length}/${results.length} 断言过；截图落 ${OUT}`)
if (bad.length || pageErrors.length) { console.error('[vis-element-duel] FAIL: ' + bad.map((b) => b.id).join(',') + (pageErrors.length ? ' pageError:' + pageErrors[0] : '')); process.exit(1) }
