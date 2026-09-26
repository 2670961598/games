#!/usr/bin/env node
/* =====================================================================
 * GAMES-30 可玩性工具（自 GAMES-22 E2E 口径移植，引擎无关；四断言 + 三时刻截图）。
 * 四断言（单据红线"三态可玩/输入<100ms"的机器证据）：
 *   A1 事件闭环：boot → start → levelEnd（win）序列完整（§5.3 词表）；
 *   A2 可赢性：CDP 受信输入（playwright mouse）神仙模拟真实通关——
 *      tap-burst 逐目标点击（避陷阱）、lane-runner 跟随安全走廊换道+矮障跳；
 *   A3 零 pageerror（整轮会话）；
 *   A4 输入→呈现延迟 <100ms（__GAMES_DEBUG__.perf().inputMaxMs，事件 timeStamp→下一呈现帧）。
 * 三时刻截图（PM 识图核验素材）：home（首页三件套）/ play（玩法中 HUD+实体）/
 *   result（结算浮层）→ <OUT_DIR>/<slug>-{home,play,result}.png（默认 kernel/workers/GAMES-30-shots）。
 * 用法：
 *   node scripts/play-check.js                     # 试点 10 款
 *   node scripts/play-check.js --slug tap-burst-pop-01
 *   node scripts/play-check.js --out /tmp/shots
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const SLUG = argOf('--slug')
const TYPE = argOf('--type')
const TRACE = !!process.env.G30_TRACE                      // 调试轨迹（G30_TRACE=1）
const SHOTS = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-30-shots'
const INPUT_LINE = 100                       // 红线：输入→呈现 <100ms
const PILOT_TYPES = ['tap-burst', 'lane-runner']

async function collectGames() {
  const list = []
  for (const type of PILOT_TYPES) {
    if (TYPE && type !== TYPE) continue
    const dirs = (await readdir(join(ROOT, 'games', type), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    for (const slug of dirs) list.push({ type, slug })
  }
  return SLUG ? list.filter((g) => g.slug === SLUG) : list
}

const ev = (page, name) => page.waitForFunction(
  (n) => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === n),
  name, { timeout: 45_000 },
)

/* ---------- 神仙模拟（受信输入；状态读取走 debug 钩子，决策与 GAMES-24 bench 机器人同源思路） ---------- */
async function godPlay(page, type, rect, slug) {
  if (type === 'lane-runner') return runnerTimeline(page, rect, slug)

  const toCss = (x, y) => ({ cx: rect.left + x / 375 * rect.width, cy: rect.top + y / 667 * rect.height })
  const deadline = Date.now() + 42_000
  let playShotDone = false, taps = 0
  while (Date.now() < deadline) {
    /* 单次往返取 {levelEnd, state}（减半 IPC 往返） */
    const snap = await page.evaluate(() => {
      const d = window.__GAMES_DEBUG__
      const le = d.events.find((e) => e.event === 'levelEnd')
      return { le: le ? le.payload : null, st: d.state() }
    })
    if (snap.le) return snap.le
    const st = snap.st
    if (st && st.screen === 'play' && st.engine) {
      /* tap-burst：逐目标点击（避陷阱；items=[x,y,r,decoy,hue]，目标静止无竞速压力） */
      for (const it of st.engine.items) {
        if (it[3]) continue
        const { cx, cy } = toCss(it[0], it[1])
        await page.mouse.click(cx, cy); taps++
      }
      if (!playShotDone && taps >= 6) {
        await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))    // 冻结引擎时序再拍（CDP 停顿不丢监督窗）
        await page.screenshot({ path: join(SHOTS, slug + '-play.png') })
        await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
        playShotDone = true
      }
    }
    await page.waitForTimeout(90)
  }
  return null
}

/* ---------- lane-runner：时间线开环回放 ----------
 * 逐拍 IPC 轮询（60ms 睡 + 往返延迟）在 450px/s 单命档是致死竞速（dash-05 调试沉淀：
 * 起跑 0.44s 与终点前 6px 两度翻车，窗口感知/早拍预切只把死点后移）。改为一次 evaluate
 * 从 safePlan 不变量（该段此道必空、相邻差 ≤1）解出全部换道时刻，墙钟调度受信 swipe：
 * 每段提前 60px（≈0.13s @450px/s）切入，余量 4× 于 CDP 延迟；中程自校验纠漂移。 */
async function runnerTimeline(page, rect, slug) {
  const toCss = (x, y) => ({ cx: rect.left + x / 375 * rect.width, cy: rect.top + y / 667 * rect.height })
  const swipeX = (() => {
    let primed = false, curX = 187                        // 跟踪鼠标 x：位移必须相对（连续同向时绝对目标 delta=0 滑不动）
    return async (dir) => {                               // 漂移有界 [67,307] ⊂ 画布内（连续同向最多 2 次）
      const { cy } = toCss(0, 350)
      const sx = rect.left + curX / 375 * rect.width
      if (!primed) { await page.mouse.move(sx, cy); primed = true }   // 首拍归位（起点(0,0)在返回键上）
      await page.mouse.down()
      await page.mouse.move(rect.left + (curX + dir * 60) / 375 * rect.width, cy, { steps: 1 })
      await page.mouse.up()
      curX += dir * 60
    }
  })()
  const leOf = () => page.evaluate(() => window.__GAMES_DEBUG__.events.find(e => e.event === 'levelEnd')?.payload ?? null)
  const buildPlan = () => page.evaluate(() => {
    const s = window.__GAMES_DEBUG__.state().engine
    if (!s) return null
    const t0 = performance.now(), d0 = s.dist
    const sched = []
    let lane = s.lane
    /* 换道相位定在段间无判定缝：碰撞只在段中心 ±28px 判，缝 dist∈[i×120−32, i×120+32]
     * 内不触发任何判定。发起点取缝中偏前（i×120−8）：swipe 落点（+7~+18px @450px/s）
     * 距前窗关闭 ≥31px、距下窗开启 ≥14px——双向都有余量（起点相位曾倒扣进前窗 5px 致死）。 */
    for (let i = Math.floor(d0 / 120); i < s.segN; i++) {
      const want = +s.safePlan[i]
      if (want !== lane) { sched.push({ at: (i * 120 - 8 - d0) / s.speed * 1000, dir: want > lane ? 1 : -1 }); lane = want }
    }
    return { t0, d0, speed: s.speed, distance: s.distance, sched }
  })
  /* 先拍 play 截图（pause 冻结时序）：CDP 停顿不再污染后续时间线 */
  await page.waitForTimeout(150)
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await page.screenshot({ path: join(SHOTS, slug + '-play.png') })
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))

  const deadline = Date.now() + 42_000
  let plan = await buildPlan()
  while (plan && plan.sched.length && Date.now() < deadline) {
    let lastAt = 0
    for (const step of plan.sched) {
      if (step.at === lastAt) continue                      // 仅去重同刻步；负时刻步（起步欠账）立即执行
      const now = await page.evaluate((t0) => performance.now() - t0, plan.t0)
      const wait = step.at - now                            // 发起即到点（相位余量已含 swipe 延迟）
      if (wait > 0) await page.waitForTimeout(Math.min(wait, 5000))
      await swipeX(step.dir)
      lastAt = step.at
      if (TRACE) {
        const st = await page.evaluate(() => window.__GAMES_DEBUG__.state().engine)
        console.error(`[trace] step@${Math.round(step.at)}ms dir=${step.dir} → dist=${Math.round(st.dist)} lane=${st.lane} want@seg=${st.safePlan[Math.floor(st.dist / 120)]} h=${st.heartsLeft}`)
      }
      const le = await leOf()
      if (le) return le
    }
    /* 一轮回放完：在走廊上则等结算；漂移（pause/停顿冻结引擎时序）则重建剩余时间线 */
    if (TRACE) console.error('[trace] 时间线回放完，进入结算等待')
    for (let i = 0; i < 20; i++) {
      const le = await page.evaluate(() => new Promise(r => {       // 直接 await evaluate 链（勿包 new Promise(res=>thenable)——executor 不调 res 永挂，dash-05 调试沉淀）
        const d = window.__GAMES_DEBUG__
        const le = d.events.find(e => e.event === 'levelEnd')
        if (le) return r(le.payload)
        setTimeout(() => r(d.events.find(e => e.event === 'levelEnd')?.payload ?? false), 300)
      })).then(r => r || null).catch(() => null)
      if (le) return le
      await page.waitForTimeout(300)
    }
    plan = await buildPlan()
  }
  return leOf()
}

/* ---------- 主流程 ---------- */
const games = await collectGames()
await mkdir(SHOTS, { recursive: true })
const report = {
  tool: 'scripts/play-check.js (GAMES-30, 原生 GE)',
  generatedAt: new Date().toISOString(),
  redLine: { inputMaxMs: INPUT_LINE },
  server: null, games: [], errors: [],
}
let cleanup = []

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error(JSON.stringify(report)); console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

const browser = await chromium.launch({ headless: true })
const PORT = 46000 + Math.floor(Math.random() * 8000)
const dataDir = await mkdtemp(join(tmpdir(), 'play-check-'))
const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
cleanup.push(() => server.kill('SIGTERM'))
await new Promise((res) => {
  const t = setTimeout(res, 8000)
  server.stderr.on('data', (d) => { if (String(d).includes('listening') || String(d).includes(String(PORT))) { clearTimeout(t); res() } })
  fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
})
report.server = `http://127.0.0.1:${PORT}`

const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, hasTouch: true })
const page = await context.newPage()
page.on('pageerror', (e) => report.errors.push(`[${report.games.length ? report.games[report.games.length - 1].slug : '?'}] ${e.message}`))

for (const g of games) {
  const entry = { slug: g.slug, type: g.type }
  report.games.push(entry)
  try {
    const url = `http://127.0.0.1:${PORT}/games/${g.type}/${g.slug}/index.html?debug=1`
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 })
    /* A1-a：boot 事件 */
    await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
    entry.a1Boot = true
    /* 截图①：home（首页三件套：标题/副题/开始+选关/音效开关） */
    await page.screenshot({ path: join(SHOTS, `${g.slug}-home.png`) })
    const rect = await page.evaluate(() => { const r = document.getElementById('cv').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })
    await page.evaluate(() => window.__GAMES_DEBUG__.start(1))
    await ev(page, 'start')
    entry.a1Start = true
    if (TRACE) console.error(`[trace] ${g.slug} start ✓ → godPlay`)
    /* A2：神仙模拟（内含截图② play） */
    const levelEnd = await godPlay(page, g.type, rect, g.slug)
    if (TRACE) console.error(`[trace] ${g.slug} godPlay 返回: ${JSON.stringify(levelEnd)}`)
    entry.a2Win = !!(levelEnd && levelEnd.win === true)
    entry.levelEnd = levelEnd
    if (entry.a2Win) {
      /* 截图③：result（结算浮层：星/分/按钮） */
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `${g.slug}-result.png`) })
    }
    /* A1-c：事件闭环全序列 */
    entry.eventSeq = await page.evaluate(() => window.__GAMES_DEBUG__.events.map((e) => e.event))
    entry.a1Loop = ['boot', 'start', 'levelEnd'].every((n) => entry.eventSeq.includes(n))
    /* A4：输入→呈现延迟 */
    const perf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    entry.perf = perf
    entry.a4InputMs = perf.inputMaxMs != null ? perf.inputMaxMs : null
    entry.pass = entry.a1Boot && entry.a1Start && entry.a1Loop && entry.a2Win
      && entry.a4InputMs != null && entry.a4InputMs < INPUT_LINE
      && !report.errors.some((e) => e.includes(`[${g.slug}]`))
  } catch (e) {
    entry.error = String(e && e.message ? e.message : e).slice(0, 300)
    entry.pass = false
  }
}

await browser.close()
await rm(dataDir, { recursive: true, force: true })
for (const fn of cleanup) { try { fn() } catch { /* best effort */ } }

/* ---------- 输出 ---------- */
console.log(JSON.stringify(report, null, 2))
console.error('\n[play-check] 摘要（A1 闭环 / A2 受信输入通关 / A3 零 pageerror / A4 输入<' + INPUT_LINE + 'ms）：')
for (const g of report.games) {
  console.error(`  ${g.slug.padEnd(22)} ${g.pass ? 'PASS' : 'FAIL'}  闭环=${g.a1Loop ? '✓' : '✗'} 通关=${g.a2Win ? '✓' : '✗'} 输入max=${g.a4InputMs ?? '?'}ms 三图=${['home', 'play', 'result'].map((m) => m).join('/')} ${g.error ? 'ERR: ' + g.error : ''}`)
}
const bad = report.games.filter((g) => !g.pass)
if (report.errors.length) console.error(`[play-check] pageerror ${report.errors.length} 条（A3 违例）`)
if (bad.length) console.error(`[play-check] 未过 ${bad.length} 款：${bad.map((g) => g.slug).join(', ')}`)
process.exitCode = bad.length || report.errors.length ? 1 : 0
