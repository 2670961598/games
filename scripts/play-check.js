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
const SHOTS = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-49-shots'
const INPUT_LINE = 100                       // 红线：输入→呈现 <100ms
const WAVE_TYPES = ['tap-burst', 'lane-runner', 'block-drop', 'block-fit']   // 已迁移波次（GAMES-30 + GAMES-49）

async function collectGames() {
  let types = WAVE_TYPES
  if (TYPE) types = [TYPE]
  else if (SLUG) {                                         // --slug 可指向任意类型：全目录扫描（防清单外空集假绿——冻结命令 --slug block-* 须真实命中）
    types = (await readdir(join(ROOT, 'games'), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && d.name !== 'demo').map((d) => d.name)
  }
  const list = []
  for (const type of types) {
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
  if (type === 'block-drop') return dropBot(page, rect, slug)
  if (type === 'block-fit') return fitBot(page, rect, slug)

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

/* ---------- block-drop：旋转×列枚举贪心（test-b 5e 同源评估器）----------
 * 逐块决策：evaluate 镜像（消行×5000 − 洞×60 − 聚高×4 − 崎岖×3）枚举 4 旋转×全列；
 * 执行=受信手势序列（§25 手势映射逐字一致）：点按=旋转，横拖每 22px 移一格，
 * 单事件下移 >44px = fling 硬降；旋转踢墙的 x 漂移在读态后按目标列补拖。 */
async function dropBot(page, rect, slug) {
  const toCss = (x, y) => ({ cx: rect.left + x / 375 * rect.width, cy: rect.top + y / 667 * rect.height })
  const deadline = Date.now() + 42_000
  let playShotDone = false, guard = 0
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const d = window.__GAMES_DEBUG__
      const le = d.events.find((e) => e.event === 'levelEnd')
      return { le: le ? le.payload : null, st: d.state() }
    })
    if (snap.le) return snap.le
    const st = snap.st
    guard++
    if (st && st.screen === 'play' && st.engine && st.engine.piece) {
      if (!playShotDone && (st.engine.lines >= 1 || guard > 24)) {
        await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
        await page.screenshot({ path: join(SHOTS, slug + '-play.png') })
        await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
        playShotDone = true
      }
      /* 单次 evaluate 枚举 4 旋转 × 全列（页面内计算，无逐格 IPC） */
      const plan = await page.evaluate(() => {
        const COLS = 10, ROWS = 20
        const s = window.__GAMES_DEBUG__.state().engine
        if (!s || !s.piece) return null
        const rotCW = (cells) => {
          const h = cells.length, w = cells[0].length, r = []
          for (let j = 0; j < w; j++) { r.push([]); for (let i = h - 1; i >= 0; i--) r[j].push(cells[i][j]) }
          return r
        }
        const parseCells = (str) => str.split('/').map((row) => row.split('').map(Number))
        function evaluate(grid, cells, x) {
          const g = grid.map((r) => r.split('').map(Number))
          const fits = (yy) => cells.every((row, i) => row.every((v, j) => {
            if (!v) return true
            const cy = yy + i, cx = x + j
            return cx >= 0 && cx < COLS && cy < ROWS && (cy < 0 || g[cy][cx] === 0)
          }))
          if (!fits(0)) return null
          let y = 0
          while (fits(y + 1)) y++
          let top = false
          cells.forEach((row, i) => row.forEach((v, j) => {
            if (!v) return
            const cy = y + i
            if (cy < 0) { top = true; return }
            g[cy][x + j] = 1
          }))
          if (top) return null
          let cleared = 0
          for (let r = ROWS - 1; r >= 0; r--) if (g[r].every((v) => v)) { g.splice(r, 1); g.unshift(new Array(COLS).fill(0)); cleared++; r++ }
          let holes = 0, bump = 0, prevH = null, agg = 0
          for (let c = 0; c < COLS; c++) {
            let h = 0, seen = false
            for (let r = 0; r < ROWS; r++) {
              if (g[r][c]) { if (!seen) { h = ROWS - r; seen = true } }
              else if (seen) holes++
            }
            agg += h
            if (prevH !== null) bump += Math.abs(h - prevH)
            prevH = h
          }
          return { rank: cleared * 5000 - holes * 60 - agg * 4 - bump * 3 - y * 0.1 }
        }
        let cells = parseCells(s.piece.cells), best = null
        for (let r = 0; r < 4; r++) {
          const w = cells[0].length
          for (let x = 0; x <= COLS - w; x++) {
            const ev = evaluate(s.grid.split('|'), cells, x)
            if (ev && (!best || ev.rank > best.rank)) best = { rot: r, x, rank: ev.rank }
          }
          cells = rotCW(cells)
        }
        return best
      })
      if (!plan) { await page.waitForTimeout(60); continue }
      const tap = toCss(187, 350)
      for (let r = 0; r < plan.rot; r++) await page.mouse.click(tap.cx, tap.cy)
      const px = await page.evaluate(() => {
        const s = window.__GAMES_DEBUG__.state().engine
        return s && s.piece ? s.piece.x : null
      })
      if (px == null) { await page.waitForTimeout(60); continue }
      const moves = plan.x - px
      if (TRACE) {
        const st3 = await page.evaluate(() => window.__GAMES_DEBUG__.state().engine)
        console.error(`[trace] plan rot=${plan.rot} x=${plan.x} px=${px} → piece k=${st3.piece && st3.piece.k} x=${st3.piece && st3.piece.x} y=${st3.piece && st3.piece.y} lines=${st3.lines} grid0=${st3.grid.split('|')[0]} grid1=${st3.grid.split('|')[1]}`)
      }
      const a = toCss(187, 350), b = toCss(187 + moves * 22, 350), c = toCss(187 + moves * 22, 440)
      await page.mouse.move(a.cx, a.cy)                   // 先归位再按下（mouse.down 不收坐标，按在当前位）
      await page.mouse.down()
      if (moves) await page.mouse.move(b.cx, b.cy, { steps: Math.min(12, Math.abs(moves)) })
      await page.mouse.move(c.cx, c.cy, { steps: 1 })     // 单事件下移 >44px：fling 硬降
      await page.mouse.up()
      await page.waitForTimeout(40)
    } else {
      await page.waitForTimeout(60)
    }
  }
  return null
}

/* ---------- block-fit：二阶前瞻拖放（test-c 5f placeSmart 扩展版）----------
 * 逐块决策：枚举 3 块 × 全格位 × 次块最优跟放，rank=消行×1e5 + 他块可落×3e4
 *   − 孤立空穴×40 + 格数×50 + 低行×5 − 左列 + 0.9×次步值——hard/master（refresh=0）
 *   实测死局主因是盘面碎片化，一阶贪心权重在种子间不稳（见 GAMES-49 REPORT 对照实验），
 *   二阶前瞻 + 碎片惩罚五档全胜；
 * 执行=受信拖放：块槽按下 → 棋盘目标锚点（块 bbox 中心 = 指上 24px，ghostAnchor 逆推）→ 抬起确认。 */
async function fitBot(page, rect, slug) {
  const toCss = (x, y) => ({ cx: rect.left + x / 375 * rect.width, cy: rect.top + y / 667 * rect.height })
  const deadline = Date.now() + 42_000
  let playShotDone = false, placed = 0
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const d = window.__GAMES_DEBUG__
      const le = d.events.find((e) => e.event === 'levelEnd')
      return { le: le ? le.payload : null, st: d.state() }
    })
    if (snap.le) return snap.le
    const st = snap.st
    if (st && st.screen === 'play' && st.engine) {
      if (!playShotDone && (st.engine.score > 300 || placed > 8)) {
        await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
        await page.screenshot({ path: join(SHOTS, slug + '-play.png') })
        await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
        playShotDone = true
      }
      const best = await page.evaluate(() => {
        const N = 10
        const s = window.__GAMES_DEBUG__.state().engine
        if (!s) return null
        const parseCells = (p) => p.split('|').map((c) => c.split(',').map(Number))
        const fits = (cells, r, c, g) => cells.every(([dx, dy]) => {
          const x = c + dx, y = r + dy
          return x >= 0 && x < N && y >= 0 && y < N && g[y * N + x] === 0
        })
        const anyPlacement = (cells, g) => {
          for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (fits(cells, r, c, g)) return true
          return false
        }
        const clears = (cells, r, c, g) => {
          const after = g.slice()
          for (const [dx, dy] of cells) after[(r + dy) * N + (c + dx)] = 1
          let lines = 0
          for (let rr = 0; rr < N; rr++) { let f = true; for (let cc = 0; cc < N; cc++) if (after[rr * N + cc] === 0) { f = false; break } if (f) lines++ }
          for (let cc = 0; cc < N; cc++) { let f = true; for (let rr = 0; rr < N; rr++) if (after[rr * N + cc] === 0) { f = false; break } if (f) lines++ }
          return { lines, after }
        }
        const placementList = (cells, g) => {
          const list = []
          for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (fits(cells, r, c, g)) list.push({ r, c })
          return list
        }
        /* 碎片度：连续空邻 <3 的空穴数（hard/master refresh=0 死局主因） */
        const fragOf = (g) => {
          let frag = 0
          for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++) {
            if (g[rr * N + cc] !== 0) continue
            let n = 1
            if (rr > 0 && g[(rr - 1) * N + cc] === 0) n++
            if (rr < N - 1 && g[(rr + 1) * N + cc] === 0) n++
            if (cc > 0 && g[rr * N + cc - 1] === 0) n++
            if (cc < N - 1 && g[rr * N + cc + 1] === 0) n++
            if (n < 3) frag++
          }
          return frag
        }
        /* 二阶前瞻：本块放置 × 次块最优跟放的组合评估（滚动重规划，只执行第一步）；
         * vm 层对照（GAMES-49）：一阶贪心权重在种子间不稳（无 frag 项 04/05 双败，
         * 有 frag 项 01 反败），二阶前瞻五档全胜（66/47/56/72/81 步） */
        let best = null
        for (let i = 0; i < s.pieces.length; i++) {
          const p = s.pieces[i]
          if (!p) continue
          const cells = parseCells(p)
          let w = 0, h = 0
          for (const [dx, dy] of cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1) }
          for (const pos of placementList(cells, s.grid)) {
            const { lines, after } = clears(cells, pos.r, pos.c, s.grid)
            let othersOk = true
            for (let j = 0; j < s.pieces.length; j++) {
              if (j === i || !s.pieces[j]) continue
              if (!anyPlacement(parseCells(s.pieces[j]), after)) { othersOk = false; break }
            }
            let best2 = null
            for (let j = 0; j < s.pieces.length; j++) {
              if (j === i || !s.pieces[j]) continue
              const cells2 = parseCells(s.pieces[j])
              for (const pos2 of placementList(cells2, after)) {
                const cl2 = clears(cells2, pos2.r, pos2.c, after)
                let thirdOk = true
                for (let k = 0; k < s.pieces.length; k++) {
                  if (k === i || k === j || !s.pieces[k]) continue
                  if (!anyPlacement(parseCells(s.pieces[k]), cl2.after)) { thirdOk = false; break }
                }
                const v2 = cl2.lines * 100000 + (thirdOk ? 30000 : 0) - fragOf(cl2.after) * 40 + cells2.length * 50
                if (best2 == null || v2 > best2) best2 = v2
              }
            }
            const rank = lines * 100000 + (othersOk ? 30000 : 0) - fragOf(after) * 40 + cells.length * 50 + (N - 1 - pos.r) * 5 - pos.c
              + 0.9 * (best2 == null ? -50000 : best2)
            if (!best || rank > best.rank) best = { i, r: pos.r, c: pos.c, w, h, rank }
          }
        }
        return best
      })
      if (!best) { await page.waitForTimeout(80); continue }
      /* 引擎锚点换算：块 bbox 中心 = 手指上方 24px（ghostAnchor 逆推；test-c 同式） */
      const fx = 37.5 + (best.c + best.w / 2) * 30
      const fy = 62 + 24 + (best.r + best.h / 2) * 30
      const slotX = 12 + best.i * ((375 - 24) / 3) + 20
      const a = toCss(slotX, 590), b = toCss(fx, fy)
      await page.mouse.move(a.cx, a.cy)                   // 先归位再按下（mouse.down 不收坐标，按在当前位）
      await page.mouse.down()
      await page.mouse.move(b.cx, b.cy, { steps: 6 })
      await page.mouse.up()
      placed++
    } else {
      await page.waitForTimeout(80)
    }
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
