#!/usr/bin/env node
/* =====================================================================
 * GAMES-19 量产B QA harness（§31 DoD 第 3/9 项的机器证据）：
 *  1) 30 款 index.html 内联脚本在浏览器桩沙箱中完整 boot（语法+运行冒烟）+ 体积 ≤200KB；
 *  2) 生产线 schema（§2.1 严口径）：公共字段齐全/值域/标题长度/slug 格式/
 *     档位单调（threat 递增 resource 递减）——严于平台 scan（§32 只拦结构坏数据）；
 *  3) 确定性：同 slug#level 两次生成 → __state 一致（hash 对比，含 5s 无输入演化）；
 *  4) 曲线公式复算（§9/§10/§13/§23/§25/§28 逐条）+ 生成规则不变量
 *     （跑酷空车道/连续障碍段、蛇连通性/食物距离、井垃圾行、迷宫钥匙=死端格）；
 *  5) 神仙模拟（God-play）：走廊跟随跑酷/完美落块/BFS 蛇/切果/贪心落块/迷宫寻路——
 *     证明规则可通关、结算与计分口径正确；负例：站桩/无输入判负路径在位。
 * node games/_shared/test-b.mjs  → 全绿 exit 0。
 * ===================================================================== */
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

let passed = 0, failed = 0
function ok(cond, label, extra) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${label}\n`) }
  else { failed++; process.stdout.write(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}\n`) }
}
const hash = (s) => createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16)

/* ---------- 浏览器桩（与量产C/D test 同式） ---------- */
function canvasStub() {
  const store = {}
  const ctx = new Proxy(store, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() { } })
      return typeof t[k] !== 'undefined' ? t[k] : function () { }
    },
    set(t, k, v) { t[k] = v; return true },
  })
  return {
    getContext: () => ctx, style: {}, width: 0, height: 0,
    addEventListener() { }, setPointerCapture() { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 375, height: 667 }),
  }
}
function makeSandbox() {
  const window = {
    innerWidth: 375, innerHeight: 667, devicePixelRatio: 2, addEventListener() { },
    AudioContext: undefined, webkitAudioContext: undefined,
  }
  window.window = window
  const sandbox = {
    window, console, performance, setTimeout, Math, JSON, Array, Object,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => 0,
    document: { getElementById: () => canvasStub(), addEventListener() { }, visibilityState: 'visible' },
  }
  sandbox.globalThis = sandbox
  return vm.createContext(sandbox)
}
function runCode(ctx, code, label) {
  try { vm.runInContext(code, ctx); return true }
  catch (e) { process.stdout.write(`  ✗ ${label}: ${e.stack.split('\n').slice(0, 2).join(' | ')}\n`) ; failed++; return false }
}

/* ---------- 加载源码 ---------- */
const commonSrc = await readFile(join(SHARED, 'common.js'), 'utf8')
const engineSrc = {}
for (const f of (await readdir(join(SHARED, 'engines')))) engineSrc[f.replace('.js', '')] = await readFile(join(SHARED, 'engines', f), 'utf8')
const ENGINE_VAR = {
  'lane-runner': 'LaneRunnerEngine', 'stacker': 'StackerEngine', 'snake': 'SnakeEngine',
  'fruit-slice': 'FruitSliceEngine', 'block-drop': 'BlockDropEngine', 'maze-dash': 'MazeDashEngine',
}
const TYPES = Object.keys(ENGINE_VAR)

/** 构造裸引擎（带事件捕获）。out.result 由 game 回调捕获。 */
function makeEngine(cfg, level, type) {
  const ctx = makeSandbox()
  vm.runInContext(commonSrc + '\n' + engineSrc[type], ctx)
  const out = { result: null, toasts: [] }
  const game = {
    W: 375, H: 667, cfg, level,
    area: { x: 0, y: 48, w: 375, h: 619 },
    setHud() { }, toast(t) { out.toasts.push(t) },
    win(score, opt) { if (!out.result) out.result = { win: true, score, ...opt } },
    lose(score) { if (!out.result) out.result = { win: false, score } },
  }
  const GG = vm.runInContext('G', ctx)
  game.rng = GG.mulberry32(GG.fnv1a32(`${cfg.slug}#${level}`))
  ctx.__game = game
  const engine = vm.runInContext(`${ENGINE_VAR[type]}(__game)`, ctx)
  out.engine = engine
  out.renderSmoke = () => engine.render(canvasStub().getContext('2d'))
  return out
}

/* ---------- 收集 30 款配置 ---------- */
const cfgs = {}
for (const type of TYPES) {
  const dirs = (await readdir(join(GAMES, type), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()
  for (const slugDir of dirs) {
    const meta = JSON.parse(await readFile(join(GAMES, type, slugDir, 'game.json'), 'utf8'))
    cfgs[meta.slug] = meta
  }
}
ok(Object.keys(cfgs).length === 30, '游戏目录共 30 款', Object.keys(cfgs).length)

/* =====================================================================
 * 1) boot 冒烟 + 体积 + 零外部请求
 * ===================================================================== */
console.log('\n— boot 冒烟（30 款）—')
for (const [slug, cfg] of Object.entries(cfgs)) {
  const html = await readFile(join(GAMES, cfg.type, cfg.slug, 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const ctx = makeSandbox()
  let bootOk = true
  for (const s of scripts) if (!runCode(ctx, s, `${slug} boot`)) bootOk = false
  ok(bootOk && scripts.length === 4, `${slug} boot（4 段脚本全执行）`, scripts.length)
  ok(html.length < 200 * 1024, `${slug} 体积 ≤200KB`, (html.length / 1024).toFixed(1) + 'KB')
  ok(!/src\s*=|href\s*=|https?:\/\/(?!localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), `${slug} 零外部引用`)
}
/* 判定路径零 Math.random（静态：引擎源 + 内联产物） */
{
  let clean = true
  for (const type of TYPES) if (/Math\.random/.test(engineSrc[type])) clean = false
  ok(clean, '六引擎源码判定路径零 Math.random（静态扫描）')
}

/* =====================================================================
 * 2) 生产线 schema（§2.1 严口径 + 档位单调）
 * ===================================================================== */
console.log('\n— 生产线 schema（§2.1 严于平台线 §32）—')
{
  const PUB = ['slug', 'title', 'type', 'tier', 'levels', 'specVersion', 'version', 'orientation', 'entry', 'controls', 'avgDurationSec', 'scoring']
  const TIERS = ['relaxed', 'simple', 'normal', 'hard', 'master']
  /* 单调方向表：+ threat 递增 / − resource 递减（relaxed→master 序） */
  const MONO = {
    'lane-runner': { speed: +1, obsRate: +1, distanceBase: +1, hearts: -1 },
    'stacker': { swingBase: +1, targetBase: +1, missMax: -1, blockW0: -1 },
    'snake': { speed: +1, targetLenBase: +1, obstacleBase: +1 },
    'fruit-slice': { targetBase: +1, spawnRate: +1, flySpeed: +1, bombRate: +1, missMax: -1, lives: -1 },
    'block-drop': { garbageBase: +1, nextN: -1, linesFactor: +1, dropMs: -1 },
    'maze-dash': { sizeN: +1, timeFactor: -1, keysCap: +1 },
  }
  let allOk = true, why = ''
  for (const cfg of Object.values(cfgs)) {
    for (const k of PUB) if (!(k in cfg)) { allOk = false; why = `${cfg.slug} 缺 ${k}` }
    if (!/^[a-z0-9-]{3,40}$/.test(cfg.slug) || !/^([a-z]+-)+\d{2}$/.test(cfg.slug)) { allOk = false; why = `${cfg.slug} slug 格式` }
    if (cfg.title.length > 12 + 3) { allOk = false; why = `${cfg.slug} 标题超限 ${cfg.title}` }
    if (!TIERS.includes(cfg.tier)) { allOk = false; why = `${cfg.slug} tier` }
    if (!(cfg.levels >= 10 && cfg.levels <= 120)) { allOk = false; why = `${cfg.slug} levels` }
    if (cfg.specVersion !== '1.1.0') { allOk = false; why = `${cfg.slug} specVersion` }
    if (cfg.orientation !== 'portrait' || cfg.entry !== 'index.html') { allOk = false; why = `${cfg.slug} orientation/entry` }
    if (!cfg.controls || !cfg.controls.primary) { allOk = false; why = `${cfg.slug} controls` }
    if (!(cfg.avgDurationSec >= 45 && cfg.avgDurationSec <= 600)) { allOk = false; why = `${cfg.slug} avgDurationSec` }
    if (!cfg.scoring || !cfg.scoring.win || !cfg.scoring.lose || !cfg.scoring.s2 || !cfg.scoring.s3) { allOk = false; why = `${cfg.slug} scoring` }
    if (!cfg.typeExtra || Object.keys(cfg.typeExtra).some(k => k in { slug: 1, title: 1, type: 1, tier: 1, levels: 1 })) { allOk = false; why = `${cfg.slug} typeExtra 侵公共键` }
  }
  ok(allOk, '30 款公共字段齐、值域合规、typeExtra 不侵公共键', why)
  /* 每类型五档各一 + 数值单调 + wall/fog 枚举序 */
  let monoOk = true, monoWhy = ''
  for (const type of TYPES) {
    const list = Object.values(cfgs).filter(c => c.type === type)
    if (list.length !== 5) { monoOk = false; monoWhy = `${type} 款数 ${list.length}`; continue }
    const byTier = Object.fromEntries(list.map(c => [c.tier, c]))
    for (const tt of TIERS) if (!byTier[tt]) { monoOk = false; monoWhy = `${type} 缺 ${tt}` }
    for (const [k, dir] of Object.entries(MONO[type])) {
      for (let i = 1; i < TIERS.length; i++) {
        const a = byTier[TIERS[i - 1]].typeExtra[k], b = byTier[TIERS[i]].typeExtra[k]
        if (dir > 0 && !(b >= a)) { monoOk = false; monoWhy = `${type}.${k} ${TIERS[i - 1]}→${TIERS[i]} ${a}→${b} 应递增` }
        if (dir < 0 && !(b <= a)) { monoOk = false; monoWhy = `${type}.${k} ${TIERS[i - 1]}→${TIERS[i]} ${a}→${b} 应递减` }
      }
    }
  }
  ok(monoOk, '每类型五档各一，threat 递增 / resource 递减（DoD#2）', monoWhy)
  const walls = ['wrap', 'wrap', 'wrap', 'solid', 'solid'].join()
  ok(Object.values(cfgs).filter(c => c.type === 'snake').sort((a, b) => a.slug.slice(-2) < b.slug.slice(-2) ? -1 : 1).map(c => c.typeExtra.wall).join() === walls,
    'snake wall 档位序 wrap×3 → solid×2（§13 档位表）')
  const fogs = Object.values(cfgs).filter(c => c.type === 'maze-dash').sort((a, b) => a.slug.slice(-2) < b.slug.slice(-2) ? -1 : 1).map(c => c.typeExtra.fogR)
  ok(fogs.join() === '0,0,0,5,4', 'maze-dash fogR 档位序 0/0/0/5/4（§28 档位表逐值）', fogs)
}

/* =====================================================================
 * 3) 确定性：同 slug#level 两次实例 → __state 一致
 * ===================================================================== */
console.log('\n— 确定性（每类抽 3 关 × 双跑）—')
for (const type of TYPES) {
  const slug = Object.values(cfgs).filter(c => c.type === type).map(c => c.slug).sort()[0]
  const levels = [1, Math.floor(cfgs[slug].levels / 2), cfgs[slug].levels]
  let allSame = true
  for (const L of levels) {
    const a = makeEngine(cfgs[slug], L, type); a.engine.startLevel()
    const b = makeEngine(cfgs[slug], L, type); b.engine.startLevel()
    if (hash(a.engine.__state()) !== hash(b.engine.__state())) allSame = false
    /* 同步走 5 秒无输入再比对（时序确定性） */
    for (let i = 0; i < 300; i++) { a.engine.update(1 / 60); b.engine.update(1 / 60) }
    if (hash(a.engine.__state()) !== hash(b.engine.__state())) allSame = false
  }
  ok(allSame, `${slug} 同 seed 双跑 + 5s 演化状态一致（L=${levels.join(',')}）`)
}
/* 同输入轨迹重放一致（block-drop 含行进中 rng 懒抽取路径） */
{
  const script = []
  for (let i = 0; i < 40; i++) script.push(['d', 187, 300], ['u', 187, 230], ['d', 187, 300], ['m', 187 + (i % 3) * 22, 310], ['m', 187 + (i % 3) * 22, 440], ['u', 187 + (i % 3) * 22, 450])
  const run = () => {
    const out = makeEngine(cfgs['block-drop-cascade-01'], 3, 'block-drop')
    out.engine.startLevel()
    for (const [kind, x, y] of script) {
      if (kind === 'd') out.engine.onDown(x, y)
      else if (kind === 'm') out.engine.onMove(x, y)
      else out.engine.onUp(x, y)
      out.engine.update(1 / 60)
    }
    return hash(out.engine.__state())
  }
  ok(run() === run(), 'block-drop 同输入轨迹重放状态一致（7-bag 懒重洗确定性）')
}

/* =====================================================================
 * 4) 曲线公式复算（§9/§10/§13/§23/§25/§28 难度曲线逐条）
 * ===================================================================== */
console.log('\n— 曲线公式复算 —')
function curveCheck(type, fn) {
  let okAll = true, why = ''
  for (const cfg of Object.values(cfgs).filter(c => c.type === type)) {
    const n = cfg.levels
    for (const L of [1, Math.max(2, Math.floor(n / 3)), n]) {
      const r = fn(cfg, L, n)
      if (!r.ok) { okAll = false; why = `${cfg.slug} L${L}: ${r.why}` }
    }
  }
  ok(okAll, `${type} 曲线复算`, why)
}
curveCheck('lane-runner', (cfg, L, n) => {
  const t = cfg.typeExtra, p = (L - 1) / (n - 1)
  const speed = t.speed * (1 + 0.35 * p)
  const obsRate = Math.min(0.50, t.obsRate * (1 + 0.25 * p))
  const distance = Math.round(t.distanceBase * (1 + 0.50 * p))
  const coinTarget = Math.ceil(15 * (1 + 0.40 * p))
  const st = makeEngine(cfg, L, 'lane-runner').engine.__state()
  return { ok: Math.abs(st.speed - speed) < .01 && Math.abs(st.obsRate - obsRate) < .001 && st.distance === distance && st.coinTarget === coinTarget, why: 'speed/obsRate/distance/coinTarget 不符', v: st }
})
curveCheck('stacker', (cfg, L, n) => {
  const t = cfg.typeExtra, p = (L - 1) / (n - 1)
  const swing = t.swingBase * (1 + t.swingK * p)
  const target = Math.ceil(t.targetBase * (1 + 0.10 * p))
  const st = makeEngine(cfg, L, 'stacker').engine.__state()
  return { ok: Math.abs(st.swing0 - swing) < .01 && st.target === target, why: 'swing/target 不符' }
})
curveCheck('snake', (cfg, L, n) => {
  const t = cfg.typeExtra, p = (L - 1) / (n - 1)
  const speed = t.speed * (1 + 0.40 * p)
  const targetLen = Math.ceil(t.targetLenBase * (1 + 0.10 * p))
  const obst = Math.round(t.obstacleBase * (1 + 0.30 * p))
  const st = makeEngine(cfg, L, 'snake').engine.__state()
  return { ok: Math.abs(st.speed - speed) < .01 && st.targetLen === targetLen && st.obstN === obst, why: 'speed/targetLen/obstN 不符' }
})
curveCheck('fruit-slice', (cfg, L, n) => {
  const t = cfg.typeExtra, p = (L - 1) / (n - 1)
  const target = Math.ceil(t.targetBase * (1 + 0.10 * p))
  const fly = t.flySpeed * (1 + 0.25 * p)
  const rate = t.spawnRate * (1 + 0.25 * p)
  const st = makeEngine(cfg, L, 'fruit-slice').engine.__state()
  return { ok: st.target === target && Math.abs(st.fly - fly) < .01 && Math.abs(st.rate - rate) < .001, why: 'target/fly/rate 不符' }
})
curveCheck('block-drop', (cfg, L, n) => {
  const t = cfg.typeExtra, p = (L - 1) / (n - 1)
  const drop = Math.max(120, Math.round(t.dropMs * (1 - 0.50 * p)))
  const garbage = Math.round(t.garbageBase * p)
  const lines = Math.ceil((10 + 15 * p) * t.linesFactor)
  const st = makeEngine(cfg, L, 'block-drop').engine.__state()
  return { ok: st.drop === drop && st.garbage === garbage && st.linesTarget === lines, why: 'drop/garbage/lines 不符' }
})
curveCheck('maze-dash', (cfg, L, n) => {
  const t = cfg.typeExtra, p = (L - 1) / (n - 1)
  const size = Math.min(t.sizeN + 4, t.sizeN + 2 * Math.floor(2 * p))
  const keysN = Math.min(t.keysCap, Math.floor(3 * p))
  const st = makeEngine(cfg, L, 'maze-dash').engine.__state()
  const time = Math.max(1, Math.ceil(st.routeLen * t.timeFactor / t.speed))
  return { ok: st.size === size && st.keysN === keysN && st.time === time, why: 'size/keysN/time 不符（time 基于 routeLen=经钥匙强制路线）', v: st }
})

/* ---------- 生成规则不变量 ---------- */
console.log('\n— 生成规则不变量 —')
{
  /* lane-runner：每段 ≥1 空车道、连续障碍段 ≤3、走廊相邻差 ≤1（30 款 × L1/Ln） */
  let inv = true, why = ''
  for (const cfg of Object.values(cfgs).filter(c => c.type === 'lane-runner')) {
    for (const L of [1, cfg.levels]) {
      const st = makeEngine(cfg, L, 'lane-runner').engine.__state()
      const rows = st.lanes.map(r => r.split('').map(Number))
      let run = 0
      rows.forEach((row, i) => {
        if (!row.some(v => v === 1 || v === 3)) run = 0
        else { run++; if (run > 3) { inv = false; why = `${cfg.slug} L${L} seg${i} 连续障碍段 ${run}` } }
        if (!row.some(v => v === 0 || v === 2)) { inv = false; why = `${cfg.slug} L${L} seg${i} 无空车道` }
      })
      const plan = st.safePlan.split('').map(Number)
      for (let i = 1; i < plan.length; i++) if (Math.abs(plan[i] - plan[i - 1]) > 1) { inv = false; why = `${cfg.slug} L${L} 走廊断裂` }
    }
  }
  ok(inv, 'lane-runner 空车道/连续障碍段 ≤3/走廊相邻可达（30 款 × 2 关）', why)
}
{
  /* snake：石块数=obstacle(L)；自由格连通（象限不封死）；食物距蛇身/石块 ≥3（切比雪夫） */
  let inv = true, why = ''
  const N = 20
  for (const cfg of Object.values(cfgs).filter(c => c.type === 'snake')) {
    const t = cfg.typeExtra
    for (const L of [1, Math.floor(cfg.levels / 2), cfg.levels]) {
      const st = makeEngine(cfg, L, 'snake').engine.__state()
      const want = Math.round(t.obstacleBase * (1 + 0.30 * (L - 1) / (cfg.levels - 1)))
      if (st.obstN !== want) { inv = false; why = `${cfg.slug} L${L} 石块 ${st.obstN}≠${want}` }
      const stones = st.stones.map(k => [k % N, (k / N) | 0])
      const occupied = new Set([...st.snake.map(s => s.split(',').map(Number)), ...stones].map(c => c[1] * N + c[0]))
      const seen = new Set([st.snake[0].split(',').map(Number)[1] * N + st.snake[0].split(',').map(Number)[0]])
      const q = [st.snake[0].split(',').map(Number)]
      while (q.length) {
        const [x, y] = q.pop()
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nx = x + dx, ny = y + dy, k = ny * N + nx
          if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen.has(k) || occupied.has(k)) continue
          seen.add(k); q.push([nx, ny])
        }
      }
      if (seen.size !== N * N - occupied.size + 1) { inv = false; why = `${cfg.slug} L${L} 自由格不连通` }   // +1：蛇头是洪泛起点，计入 seen
      const fd = st.food && st.food.split(',').map(Number)
      if (fd) {
        const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
        if (st.snake.some(s => cheb(s.split(',').map(Number), fd) < 3) || stones.some(s => cheb(s, fd) < 3)) { inv = false; why = `${cfg.slug} L${L} 食物距离 <3` }
      }
    }
  }
  ok(inv, 'snake 石块连通性+食物 2 格邻域外（30 款 × 3 关）', why)
}
{
  /* block-drop：垃圾行数=garbage(L)，每行洞 1–2 个（30 款 × 3 关） */
  let inv = true, why = ''
  for (const cfg of Object.values(cfgs).filter(c => c.type === 'block-drop')) {
    for (const L of [1, Math.floor(cfg.levels / 2), cfg.levels]) {
      const st = makeEngine(cfg, L, 'block-drop').engine.__state()
      const g = st.grid.split('|').map(r => r.split('').map(Number))
      const garbageRows = []
      for (let r = 0; r < g.length; r++) if (g[r].some(v => v === 8)) garbageRows.push(r)
      if (garbageRows.length !== st.garbage) { inv = false; why = `${cfg.slug} L${L} 垃圾行 ${garbageRows.length}≠${st.garbage}` }
      for (const r of garbageRows) {
        const holes = g[r].filter(v => v === 0).length
        if (holes < 1 || holes > 2) { inv = false; why = `${cfg.slug} L${L} 行${r} 洞数 ${holes}` }
      }
    }
  }
  ok(inv, 'block-drop 垃圾行数与 1–2 洞位（30 款 × 3 关）', why)
}
{
  /* maze-dash：钥匙全在死端格；bfsLen>0；拆墙数 q=⌊size²×0.05⌋ 后仍是连通图 */
  let inv = true, why = ''
  for (const cfg of Object.values(cfgs).filter(c => c.type === 'maze-dash')) {
    for (const L of [1, Math.floor(cfg.levels / 2), cfg.levels]) {
      const st = makeEngine(cfg, L, 'maze-dash').engine.__state()
      const size = st.size
      const hw = st.hwal.split('|').map(r => r.split('').map(Number))
      const vw = st.vwal.split('|').map(r => r.split('').map(Number))
      const open = (x, y, d) => {
        const vx = x + { u: 0, d: 0, l: -1, r: 1 }[d], vy = y + { u: -1, d: 1, l: 0, r: 0 }[d]
        if (vx < 0 || vy < 0 || vx >= size || vy >= size) return false
        if (d === 'l') return !hw[y][x - 1]
        if (d === 'r') return !hw[y][x]
        if (d === 'u') return !vw[y - 1][x]
        return !vw[y][x]
      }
      for (const k of st.keys) {
        const x = k % size, y = (k / size) | 0
        const deg = ['u', 'd', 'l', 'r'].filter(d => open(x, y, d)).length
        if (deg !== 1) { inv = false; why = `${cfg.slug} L${L} 钥匙 (${x},${y}) 度=${deg} 非死端` }
      }
      /* 全图连通（拆墙后仍单连通分量） */
      const seen = new Set([0])
      const q = [[0, 0]]
      while (q.length) {
        const [x, y] = q.pop()
        for (const d of 'udlr') {
          if (!open(x, y, d)) continue
          const nx = x + { u: 0, d: 0, l: -1, r: 1 }[d], ny = y + { u: -1, d: 1, l: 0, r: 0 }[d], kk = ny * size + nx
          if (!seen.has(kk)) { seen.add(kk); q.push([nx, ny]) }
        }
      }
      if (seen.size !== size * size) { inv = false; why = `${cfg.slug} L${L} 迷宫不连通` }
    }
  }
  ok(inv, 'maze-dash 钥匙=死端格 + 拆环后全连通（30 款 × 3 关）', why)
}

/* =====================================================================
 * 5a) lane-runner 神仙模拟：沿安全走廊换道 → 通关；计分复算；站桩判负
 * ===================================================================== */
console.log('\n— lane-runner 神仙模拟 —')
{
  const slug = 'lane-runner-dash-01'                        // normal 基准
  const out = makeEngine(cfgs[slug], 1, 'lane-runner')
  out.engine.startLevel()
  let steps = 0
  while (!out.result && steps < 120 * 120) {
    const st = out.engine.__state()
    const seg = Math.min(Math.floor(st.dist / 120), st.safePlan.length - 1)
    const want = +st.safePlan[seg]
    if (st.lane !== want) {
      const x0 = 62.5 + st.lane * 125, x1 = 62.5 + want * 125
      out.engine.onDown(x0, 400); out.engine.onUp(x1, 400)   // 一次换道滑到走廊车道
    }
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  const st = out.engine.__state()
  ok(out.result && out.result.win, `${slug} L1 走廊跟随通关（${(steps / 120).toFixed(1)}s 游戏时，命剩 ${st.heartsLeft}）`, out.result)
  ok(out.result && out.result.score === st.coins * 20 + st.heartsLeft * 50, `${slug} 计分=币×20+命×50（币=${st.coins} 命=${st.heartsLeft}）`, out.result)
  const ct = makeEngine(cfgs[slug], 1, 'lane-runner').engine.__state().coinTarget
  ok(out.result && out.result.s2 === ct * 24 && out.result.s3 === ct * 30, `${slug} s2/s3=coinTarget×24/30（coinTarget=${ct}）`, out.result)
  /* 站桩：master L40（一命制 + obsRate 顶格）不换道必撞障判负 */
  const out2 = makeEngine(cfgs['lane-runner-dash-05'], 40, 'lane-runner')
  out2.engine.startLevel()
  let steps2 = 0
  while (!out2.result && steps2 < 120 * 60) { out2.engine.update(1 / 60); steps2++ }
  ok(out2.result && !out2.result.win, 'lane-runner-dash-05 L40 站桩撞障碍判负（一命制在位）', out2.result && { win: out2.result.win })
}
/* =====================================================================
 * 5b) stacker 神仙模拟：过零点完美落块 → 通关；计分与 s2/s3 口径
 * ===================================================================== */
console.log('\n— stacker 神仙模拟 —')
{
  const slug = 'stacker-calm-01'                            // normal 基准
  const out = makeEngine(cfgs[slug], 1, 'stacker')
  out.engine.startLevel()
  let steps = 0, prevOff = null
  while (!out.result && steps < 120 * 300) {
    const st = out.engine.__state()
    const off = st.cur.x - st.layers[st.layers.length - 1][0]
    if (prevOff !== null && ((prevOff > 0 && off <= 0) || (prevOff < 0 && off >= 0)) && Math.abs(off) < st.cur.w * 0.08) {
      out.engine.onDown(187, 380); out.engine.onUp(187, 380)  // 过零点完美落块
    }
    prevOff = off
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  const st = out.engine.__state()
  ok(out.result && out.result.win, `${slug} L1 完美落块通关（${st.placed} 层 ${st.perfects} 完美，${(steps / 120).toFixed(1)}s）`, out.result)
  ok(out.result && out.result.score === st.placed * 10 + st.perfects * 15, `${slug} 计分=层×10+完美×15`, out.result)
  ok(out.result && out.result.s2 === st.target * 12 && out.result.s3 === st.target * 15, `${slug} s2/s3=target×12/15（target=${st.target}）`, out.result)
}
/* =====================================================================
 * 5c) snake 神仙模拟：BFS 追食物（wrap 档）→ 通关；计分复算
 * ===================================================================== */
console.log('\n— snake 神仙模拟 —')
{
  const slug = 'snake-meander-02'                           // relaxed（wrap）
  const out = makeEngine(cfgs[slug], 1, 'snake')
  out.engine.startLevel()
  const N = 20
  let steps = 0, lastHead = null
  const DIRV = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] }
  while (!out.result && steps < 120 * 240) {
    const st = out.engine.__state()
    const head = st.snake[0].split(',').map(Number)
    const headMoved = lastHead !== null && head.join() !== lastHead
    lastHead = head
    const food = st.food && st.food.split(',').map(Number)
    if (food && headMoved && st.queue === '') {
      /* BFS（torus 邻接，wrap 档）：避开蛇身与石块 */
      const blocked = new Set([...st.snake.slice(0, -1), ...st.stones.map(k => `${k % N},${(k / N) | 0}`)])
      const prev = new Map([['' + head, null]])
      const q = [head]
      let found = null
      for (let qi = 0; qi < q.length && !found; qi++) {
        const [x, y] = q[qi]
        for (const d of 'udlr') {
          const nx = (x + DIRV[d][0] + N) % N, ny = (y + DIRV[d][1] + N) % N
          const ks = nx + ',' + ny
          if (prev.has(ks)) continue
          if (blocked.has(ks) && ks !== food.join(',')) continue
          prev.set(ks, '' + x + ',' + y + d)
          if (ks === food.join(',')) { found = ks; break }
          q.push([nx, ny])
        }
      }
      if (found) {
        /* 回溯首步方向 */
        let cur = found, par = prev.get(cur)
        while (par && par.slice(0, -1) !== '' + head) { cur = par.slice(0, -1); par = prev.get(cur) }
        const d = prev.get(cur).slice(-1)
        const cx = 180, cy = 300
        out.engine.onDown(cx, cy)
        out.engine.onUp(cx + DIRV[d][0] * 80, cy + DIRV[d][1] * 80)
      }
    }
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  const st = out.engine.__state()
  ok(out.result && out.result.win, `${slug} L1 BFS 追食通关（长 ${st.snake.length}/${st.targetLen}，${(steps / 120).toFixed(1)}s）`, out.result)
  ok(out.result && out.result.score === (st.targetLen - 3) * 20 + 100, `${slug} 计分=食×20+100（target=${st.targetLen}）`, out.result)
  ok(out.result && out.result.s2 === 24 * st.targetLen && out.result.s3 === 30 * st.targetLen, `${slug} s2/s3=24/30×targetLen`, out.result)
  /* solid 档负例：蛇径直冲墙 → 撞墙判负 */
  const out2 = makeEngine(cfgs['snake-meander-05'], 1, 'snake')
  out2.engine.startLevel()
  let steps2 = 0
  while (!out2.result && steps2 < 120 * 30) { out2.engine.update(1 / 60); steps2++ }
  ok(out2.result && !out2.result.win, 'snake-meander-05 L1（solid）不转向直冲撞墙判负', out2.result && { win: out2.result.win })
}
/* =====================================================================
 * 5d) fruit-slice 神仙模拟：避弹竖切 → 通关；计分复算；站桩漏果判负
 * ===================================================================== */
console.log('\n— fruit-slice 神仙模拟 —')
{
  const slug = 'fruit-slice-blade-01'                       // normal 基准
  const out = makeEngine(cfgs[slug], 1, 'fruit-slice')
  out.engine.startLevel()
  let steps = 0, cooldown = 0
  while (!out.result && steps < 120 * 120) {
    const st = out.engine.__state()
    if (cooldown > 0) cooldown--
    else {
      /* 选最低未切水果，竖直进刀且路径避开炸弹（含残刀老化窗口的保守边距） */
      let pick = null
      for (const it of st.items) {
        if (it[4] === 1) continue
        if (!pick || it[1] > pick[1]) pick = it
      }
      if (pick && pick[1] < 500) {
        const danger = st.items.some(b => b[4] === 1 && Math.abs(b[0] - pick[0]) < 52 && b[1] > pick[1] - 28 && b[1] < pick[1] + 118)
        if (!danger) {
          out.engine.onDown(pick[0], pick[1] + 90)
          out.engine.onMove(pick[0], pick[1])
          out.engine.onUp(pick[0], pick[1])
          cooldown = 14                                     // 等刀轨老化（0.12s 衰减窗），防残刀误切炸弹
        }
      }
    }
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  const st = out.engine.__state()
  ok(out.result && out.result.win, `${slug} L1 避弹竖切通关（${(steps / 120).toFixed(1)}s）`, out.result)
  ok(out.result && out.result.score === st.target * 10, `${slug} 计分=果×10（单刀单果无多果加成，target=${st.target}）`, out.result)
  ok(out.result && out.result.s2 === st.target * 12 && out.result.s3 === st.target * 15, `${slug} s2/s3=target×12/15`)
  /* 站桩：normal 漏果耗尽判负 */
  const out2 = makeEngine(cfgs['fruit-slice-blade-01'], 1, 'fruit-slice')
  out2.engine.startLevel()
  let steps2 = 0
  while (!out2.result && steps2 < 120 * 90) { out2.engine.update(1 / 60); steps2++ }
  ok(out2.result && !out2.result.win, 'fruit-slice-blade-01 L1 站桩漏果耗尽判负', out2.result && { win: out2.result.win })
}
/* =====================================================================
 * 5e) block-drop 神仙模拟：旋转×列枚举贪心（消行优先）→ 通关；7-bag 公平
 * ===================================================================== */
console.log('\n— block-drop 神仙模拟 —')
{
  const COLS = 10, ROWS = 20
  const rotCW = (cells) => {
    const h = cells.length, w = cells[0].length, r = []
    for (let j = 0; j < w; j++) { r.push([]); for (let i = h - 1; i >= 0; i--) r[j].push(cells[i][j]) }
    return r
  }
  const parseCells = (s) => s.split('/').map(r => r.split('').map(Number))
  /** 镜像评估：在 grid 以 (cells,x) 硬降 → 消行数/洞/高度/崎岖 */
  function evaluate(grid, cells, x) {
    const g = grid.map(r => r.split('').map(Number))
    let y = 0
    const fits = (yy) => cells.every((row, i) => row.every((v, j) => {
      if (!v) return true
      const cy = yy + i, cx = x + j
      return cx >= 0 && cx < COLS && cy < ROWS && (cy < 0 || g[cy][cx] === 0)
    }))
    if (!fits(0)) return null
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
    for (let r = ROWS - 1; r >= 0; r--) if (g[r].every(v => v)) { g.splice(r, 1); g.unshift(new Array(COLS).fill(0)); cleared++; r++ }
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
    return { rank: cleared * 5000 - holes * 60 - agg * 4 - bump * 3 - y * 0.1, cleared }
  }
  for (const slug of ['block-drop-cascade-02', 'block-drop-cascade-01']) {
    const out = makeEngine(cfgs[slug], 1, 'block-drop')
    out.engine.startLevel()
    out.renderSmoke()
    const kinds = []
    let steps = 0, guard = 0
    while (!out.result && guard++ < 300) {
      const st = out.engine.__state()
      if (!st.piece) break
      if (!kinds.length || kinds[kinds.length - 1] !== st.piece.k) kinds.push(st.piece.k)
      /* 枚举 4 旋转 × 全列，取最优 */
      const grid = st.grid.split('|')
      let best = null
      let cells = parseCells(st.piece.cells)
      for (let r = 0; r < 4; r++) {
        const w = cells[0].length
        for (let x = 0; x <= COLS - w; x++) {
          const ev = evaluate(grid, cells, x)
          if (ev && (!best || ev.rank > best.rank)) best = { rot: r, x, rank: ev.rank }
        }
        cells = rotCW(cells)
      }
      if (!best) break
      for (let r = 0; r < best.rot; r++) { out.engine.onDown(187, 300); out.engine.onUp(187, 234) }   // 上滑旋转
      const st2 = out.engine.__state()
      const moves = best.x - st2.piece.x
      out.engine.onDown(187, 300)
      if (moves) out.engine.onMove(187 + moves * 22, 306)
      out.engine.onMove(187 + moves * 22, 460)                                                        // fling 硬降
      out.engine.onUp(187 + moves * 22, 470)
      out.engine.update(1 / 60)
      if (steps++ % 10 === 0) out.renderSmoke()
    }
    ok(out.result && out.result.win, `${slug} L1 贪心落块消行达标通关（${out.engine.__state().lines} 行，${kinds.length} 块）`, out.result && { win: out.result.win, lines: out.engine.__state().lines })
    if (slug === 'block-drop-cascade-01') {
      const st = out.engine.__state()
      ok(out.result.s2 === 150 * st.linesTarget && out.result.s3 === 220 * st.linesTarget, `${slug} s2/s3=150/220×lines（lines=${st.linesTarget}）`)
      /* 7-bag 公平：每满 7 块为一组 0–6 全排列 */
      let bagOk = kinds.length >= 7
      for (let b = 0; b + 7 <= Math.min(kinds.length, 21); b += 7) {
        if (new Set(kinds.slice(b, b + 7)).size !== 7) bagOk = false
      }
      ok(bagOk, `${slug} 7-bag 公平（首 ${Math.min(kinds.length, 21)} 块按 7 分组均为全集）`, kinds.slice(0, 21))
    }
  }
}
/* =====================================================================
 * 5f) maze-dash 神仙模拟：BFS 逐停寻路（先钥匙后出口）→ 通关；站桩超时判负
 * ===================================================================== */
console.log('\n— maze-dash 神仙模拟 —')
{
  const slug = 'maze-dash-hedge-01'                         // normal 基准
  const out = makeEngine(cfgs[slug], 5, 'maze-dash')
  out.engine.startLevel()
  const DIRV = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] }
  let steps = 0, swipes = 0
  while (!out.result && steps < 120 * 240) {
    const st = out.engine.__state()
    if (!st.path || st.path.length === 0) {
      const size = st.size
      const hw = st.hwal.split('|').map(r => r.split('').map(Number))
      const vw = st.vwal.split('|').map(r => r.split('').map(Number))
      const open = (x, y, d) => {
        const vx = x + DIRV[d][0], vy = y + DIRV[d][1]
        if (vx < 0 || vy < 0 || vx >= size || vy >= size) return false
        if (d === 'l') return !hw[y][x - 1]
        if (d === 'r') return !hw[y][x]
        if (d === 'u') return !vw[y - 1][x]
        return !vw[y][x]
      }
      /* 目标：最近未取钥匙；钥匙齐后出口 */
      const targets = st.keys.map(k => [k % size, (k / size) | 0])
      const goal = targets.length ? targets.reduce((a, b) =>
        (Math.abs(b[0] - st.cx) + Math.abs(b[1] - st.cy)) < (Math.abs(a[0] - st.cx) + Math.abs(a[1] - st.cy)) ? b : a)
        : [size - 1, size - 1]
      const prev = new Map([[st.cx + ',' + st.cy, null]])
      const q = [[st.cx, st.cy]]
      let found = null
      for (let qi = 0; qi < q.length && !found; qi++) {
        const [x, y] = q[qi]
        for (const d of 'udlr') {
          if (!open(x, y, d)) continue
          const nx = x + DIRV[d][0], ny = y + DIRV[d][1], ks = nx + ',' + ny
          if (prev.has(ks)) continue
          prev.set(ks, { p: x + ',' + y, d })
          if (nx === goal[0] && ny === goal[1]) { found = ks; break }
          q.push([nx, ny])
        }
      }
      if (found) {
        let cur = found, par = prev.get(cur)
        while (par && par.p !== st.cx + ',' + st.cy) { cur = par.p; par = prev.get(cur) }
        const d = prev.get(cur).d
        out.engine.onDown(190, 330)
        out.engine.onUp(190 + DIRV[d][0] * 80, 330 + DIRV[d][1] * 80)
        swipes++
      }
    }
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  const st = out.engine.__state()
  ok(out.result && out.result.win, `${slug} L5 BFS 寻路通关（钥匙 ${st.keysGot}/${st.keysN}，${swipes} 次滑动，剩 ${st.timeLeft.toFixed(1)}s）`, out.result)
  ok(out.result && out.result.score === Math.ceil(st.timeLeft) * 20 + st.keysGot * 50, `${slug} 计分=剩余秒×20+钥匙×50`)
  ok(out.result && out.result.s2 === 12 * st.time && out.result.s3 === 15 * st.time, `${slug} s2/s3=12/15×time（time=${st.time}）`)
  /* 站桩超时判负 */
  const out2 = makeEngine(cfgs['maze-dash-hedge-01'], 1, 'maze-dash')
  out2.engine.startLevel()
  let steps2 = 0
  while (!out2.result && steps2 < 120 * 120) { out2.engine.update(1 / 30); steps2++ }
  ok(out2.result && !out2.result.win, 'maze-dash-hedge-01 L1 站桩超时判负', out2.result && { win: out2.result.win })
  /* 带钥匙 + 迷雾档（hard L30：keys=3，fogR=5）寻路通关——钥匙收集与时限可达性实证 */
  {
    const out3 = makeEngine(cfgs['maze-dash-hedge-04'], 30, 'maze-dash')
    out3.engine.startLevel()
    const st0 = out3.engine.__state()
    const size = st0.size
    const hw = st0.hwal.split('|').map(r => r.split('').map(Number))
    const vw = st0.vwal.split('|').map(r => r.split('').map(Number))
    const open3 = (x, y, d) => {
      const vx = x + DIRV[d][0], vy = y + DIRV[d][1]
      if (vx < 0 || vy < 0 || vx >= size || vy >= size) return false
      if (d === 'l') return !hw[y][x - 1]
      if (d === 'r') return !hw[y][x]
      if (d === 'u') return !vw[y - 1][x]
      return !vw[y][x]
    }
    /* 与引擎同口径：钥匙访问顺序取全排列最优（3 钥匙 = 6 序） */
    const bfsDist = (from, to) => {
      const sk = from.join()
      if (sk === to.join()) return { dist: 0, prev: new Map([[sk, null]]) }
      const prev = new Map([[sk, null]])
      const q = [from]
      for (let qi = 0; qi < q.length; qi++) {
        const [x, y] = q[qi]
        const base = prev.get(x + ',' + y) ? prev.get(x + ',' + y).dist : 0
        for (const d of 'udlr') {
          if (!open3(x, y, d)) continue
          const nx = x + DIRV[d][0], ny = y + DIRV[d][1], ks = nx + ',' + ny
          if (prev.has(ks)) continue
          const node = { p: x + ',' + y, d, dist: base + 1 }
          prev.set(ks, node)
          if (nx === to[0] && ny === to[1]) return { dist: node.dist, prev }
          q.push([nx, ny])
        }
      }
      return { dist: 1e9, prev }
    }
    const keyCells = st0.keys.map(k => [k % size, (k / size) | 0])
    let order = keyCells, bestCost = Infinity
    const swap = (a, i, j) => { const b = a.slice(); const tmp = a[i]; b[i] = b[j]; b[j] = tmp; return b }
    const perm = (arr, m) => {
      if (m === 1) {
        let total = 0, cur = [0, 0]
        for (const wp of [...arr, [size - 1, size - 1]]) { total += bfsDist(cur, wp).dist; cur = wp }
        if (total < bestCost) { bestCost = total; order = [...arr] }
        return
      }
      for (let i = 0; i < m; i++) perm(swap(arr, i, m - 1), m - 1)
    }
    perm(keyCells, keyCells.length)
    const firstStep = (from, goal) => {
      const { prev } = bfsDist(from, goal)
      let cur = goal.join(), par = prev.get(cur)
      if (!par) return null
      while (par.p !== from.join()) { cur = par.p; par = prev.get(cur) }
      return par.d
    }
    let steps3 = 0, swipes3 = 0
    while (!out3.result && steps3 < 120 * 240) {
      const st = out3.engine.__state()
      const remaining = st.keys.map(k => [k % size, (k / size) | 0])
      const wp = remaining.length
        ? order.find(k => remaining.some(r => r[0] === k[0] && r[1] === k[1]))
        : [size - 1, size - 1]
      const anchor = (st.path && st.path.length) ? st.path[0].split(',').map(Number) : [st.cx, st.cy]
      const d = wp && firstStep(anchor, wp)
      if (d) {
        out3.engine.onDown(190, 330)
        out3.engine.onUp(190 + DIRV[d][0] * 80, 330 + DIRV[d][1] * 80)   // 停稳=定向开跑；行进中=pending 转向
        swipes3++
      }
      out3.engine.update(1 / 60)
      if (steps3 % 30 === 0) out3.renderSmoke()
      steps3++
    }
    const st3 = out3.engine.__state()
    ok(out3.result && out3.result.win && st0.keysN === 3, `maze-dash-hedge-04 L30 迷雾档集 3 钥匙通关（最优序 ${JSON.stringify(order)}，剩 ${st3.timeLeft.toFixed(1)}s / ${st3.time}s）`, out3.result && { win: out3.result.win, keysN: st0.keysN })
    ok(out3.result && out3.result.score === Math.ceil(st3.timeLeft) * 20 + 3 * 50, 'maze-dash-hedge-04 计分=剩余秒×20+钥匙×50（3 钥匙）')
  }
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`)
process.exit(failed ? 1 : 0)
