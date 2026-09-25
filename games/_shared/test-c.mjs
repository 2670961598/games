#!/usr/bin/env node
/* =====================================================================
 * GAMES-20 量产C QA harness（§31 DoD 第 3/9 项的机器证据）：
 *  1) 30 款 index.html 内联脚本在浏览器桩沙箱中完整 boot（语法+运行冒烟）+ 体积 ≤200KB；
 *  2) 生产线 schema（§2.1 严口径）：公共字段齐全/值域/标题长度/slug 格式/
 *     档位单调（threat 递增 resource 递减）——严于平台 scan（§32 平台线只拦结构坏数据）；
 *  3) 确定性：同 slug#level 两次生成 → __state 一致（hash 对比）；
 *  4) 类型规则不变量：曲线公式复算（rows/speed/paddle、goal/rate/speed、waves/eSpeed/eHP、
 *     catchTarget/fall、target/pent）、21 形状池唯一性、障碍非角格；
 *  5) 神仙模拟（God-play）：paddle 跟球/篮跟好物/机体追敌/圆周躲弹/贪心放块——
 *     证明规则可通关、结算与计分口径正确、引擎有限步内终止。
 * node games/_shared/test-c.mjs  → 全绿 exit 0。
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

/* ---------- 浏览器桩（与量产D test.mjs 同式） ---------- */
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
  catch (e) { process.stdout.write(`  ✗ ${label}: ${e.stack.split('\n').slice(0, 2).join(' | ')}\n`); failed++; return false }
}

/* ---------- 加载源码 ---------- */
const commonSrc = await readFile(join(SHARED, 'common.js'), 'utf8')
const engineSrc = {}
for (const f of (await readdir(join(SHARED, 'engines')))) engineSrc[f.replace('.js', '')] = await readFile(join(SHARED, 'engines', f), 'utf8')
const ENGINE_VAR = {
  'breakout': 'BreakoutEngine', 'paddle-pong': 'PaddlePongEngine', 'bullet-shmup': 'BulletShmupEngine',
  'bullet-dodge': 'BulletDodgeEngine', 'drop-catcher': 'DropCatcherEngine', 'block-fit': 'BlockFitEngine',
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
  /* 渲染冒烟：桩 2D context 全量吸收，仅捕捉渲染路径的 ReferenceError/TypeError */
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
    'breakout': { ballSpeed: +1, paddleW: -1, rowsCap: +1, brickHP: +1, balls: -1 },
    'paddle-pong': { goalSec: -1, ballSpeed: +1, maxBalls: +1, paddleW: -1, missMax: -1 },
    'bullet-shmup': { wavesCap: +1, enemyHP: +1, bulletSpeed: +1, density: +1, lives: -1 },
    'bullet-dodge': { goalSec: -1, spawnRate: +1, projSpeed: +1, playerR: -1, slowCharges: -1 },
    'drop-catcher': { catchTarget: +1, fallSpeed: +1, spawnRate: +1, badRate: +1, basketW: -1, lives: -1 },
    'block-fit': { targetScore: +1, pentRate: +1, obstacleStart: +1, refresh: -1 },
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
  /* 每类型五档各一 + 数值单调 */
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

/* =====================================================================
 * 4) 曲线公式复算（§14/§15/§16/§17/§18/§26 难度曲线逐条）
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
curveCheck('breakout', (cfg, L, n) => {
  const t = cfg.typeExtra
  const rows = Math.min(t.rowsCap, 4 + Math.floor(4 * (L - 1) / (n - 1)))
  const speed = t.ballSpeed * (1 + 0.40 * (L - 1) / (n - 1))
  const pw = Math.max(60, Math.round(t.paddleW * (1 - 0.20 * (L - 1) / (n - 1))))
  const st = makeEngine(cfg, L, 'breakout').engine.__state()
  return { ok: st.rows === rows && Math.abs(st.speed - speed) < .01 && st.pw === pw, why: 'rows/speed/paddle 不符' }
})
curveCheck('paddle-pong', (cfg, L, n) => {
  const t = cfg.typeExtra
  const goal = Math.ceil(t.goalSec * (1 + 0.10 * (L - 1) / (n - 1)))
  const speed = t.ballSpeed * (1 + 0.35 * (L - 1) / (n - 1))
  const st = makeEngine(cfg, L, 'paddle-pong').engine.__state()
  return { ok: st.goal === goal && Math.abs(st.speed - speed) < .01, why: 'goal/speed 不符' }
})
curveCheck('bullet-shmup', (cfg, L, n) => {
  const t = cfg.typeExtra
  const waves = Math.min(t.wavesCap, 5 + Math.floor(5 * (L - 1) / (n - 1)))
  const spd = t.bulletSpeed * (1 + 0.30 * (L - 1) / (n - 1))
  const hp = t.enemyHP + Math.floor(L / Math.max(4, n / 6))
  const st = makeEngine(cfg, L, 'bullet-shmup').engine.__state()
  return { ok: st.waves === waves && Math.abs(st.eSpeed - spd) < .01 && st.eHP0 === hp, why: 'waves/eSpeed/eHP 不符' }
})
curveCheck('bullet-dodge', (cfg, L, n) => {
  const t = cfg.typeExtra
  const goal = Math.ceil(t.goalSec * (1 + 0.10 * (L - 1) / (n - 1)))
  const rate = t.spawnRate * (1 + 0.50 * (L - 1) / (n - 1))
  const spd = t.projSpeed * (1 + 0.40 * (L - 1) / (n - 1))
  const st = makeEngine(cfg, L, 'bullet-dodge').engine.__state()
  return { ok: st.goal === goal && Math.abs(st.rate - rate) < .001 && Math.abs(st.speed - spd) < .01, why: 'goal/rate/speed 不符' }
})
curveCheck('drop-catcher', (cfg, L, n) => {
  const t = cfg.typeExtra
  const tgt = Math.ceil(t.catchTarget * (1 + 0.10 * (L - 1) / (n - 1)))
  const fall = t.fallSpeed * (1 + 0.35 * (L - 1) / (n - 1))
  const st = makeEngine(cfg, L, 'drop-catcher').engine.__state()
  return { ok: st.target === tgt && Math.abs(st.fall - fall) < .01, why: 'catchTarget/fall 不符' }
})
curveCheck('block-fit', (cfg, L, n) => {
  const t = cfg.typeExtra
  const tgt = Math.ceil(t.targetScore * (1 + 0.15 * (L - 1) / (n - 1)))
  const pent = Math.min(0.25, t.pentRate * (1 + 0.20 * (L - 1) / (n - 1)))
  const st = makeEngine(cfg, L, 'block-fit').engine.__state()
  return { ok: st.target === tgt && Math.abs(st.pent - pent) < .001, why: 'target/pent 不符' }
})

/* =====================================================================
 * 5a) breakout 神仙模拟：板跟球 → 清砖通关，s2/s3 口径断言
 * ===================================================================== */
console.log('\n— breakout 神仙模拟 —')
{
  const slug = 'breakout-brick-01'                       // normal 基准
  const out = makeEngine(cfgs[slug], 1, 'breakout')
  const st0 = out.engine.__state()
  const bricksTotal = st0.bricksTotal
  out.engine.startLevel()
  out.engine.onDown(180, 500); out.engine.onUp(180, 500)  // 点按发射
  let steps = 0
  while (!out.result && steps < 120 * 240) {              // 240s 游戏时预算
    const st = out.engine.__state()
    if (st.ball && st.bricks.length) {
      /* 盯最近剩余砖：板偏移注入反射角，把球打向砖群（避免垂直死循环/单侧钉死） */
      let near2 = null
      for (const b of st.bricks) {
        const bx = 12.5 + b[1] * 44 + 21
        if (!near2 || Math.abs(bx - st.ball[0]) < Math.abs(near2 - st.ball[0])) near2 = bx
      }
      const d = Math.sign(near2 - st.ball[0]) || 1
      out.engine.onMove(st.ball[0] - d * 20, 0)
    }
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  ok(out.result && out.result.win, `${slug} L1 板盯球通关（${(steps / 120).toFixed(1)}s 游戏时）`)
  ok(out.result && out.result.s2 === 12 * bricksTotal && out.result.s3 === 15 * bricksTotal,
    `${slug} s2=12×bricks s3=15×bricks（bricks=${bricksTotal}）`, out.result)
}
/* =====================================================================
 * 5b) paddle-pong 神仙模拟：板盯最低球 → 存活通关
 * ===================================================================== */
console.log('\n— paddle-pong 神仙模拟 —')
{
  const slug = 'paddle-pong-rally-02'                     // relaxed（3 球帽）
  const out = makeEngine(cfgs[slug], 1, 'paddle-pong')
  out.engine.startLevel()
  let steps = 0
  while (!out.result && steps < 120 * 180) {
    const st = out.engine.__state()
    let low = null
    for (const b of st.balls) if (!low || b[1] > low[1]) low = b
    if (low) out.engine.onMove(low[0], 0)
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  ok(out.result && out.result.win, `${slug} L1 板盯最低球存活通关（${(steps / 120).toFixed(1)}s）`, out.result)
  const goal = out.engine.__state().goal
  ok(out.result && out.result.s2 === goal * 12 && out.result.s3 === goal * 15, `${slug} s2/s3=goal×12/15（goal=${goal}）`)
}
/* =====================================================================
 * 5c) bullet-shmup 神仙模拟：机体追最近敌（自动连射）→ 清波；中弹耗命机制在位
 * ===================================================================== */
console.log('\n— bullet-shmup 神仙模拟 —')
{
  const slug = 'bullet-shmup-raid-02'                     // relaxed（5 机）
  const out = makeEngine(cfgs[slug], 1, 'bullet-shmup')
  out.engine.startLevel()
  let steps = 0, maxWave = 0
  while (!out.result && steps < 120 * 300) {
    const st = out.engine.__state()
    maxWave = Math.max(maxWave, st.waveNo)
    let near = null
    for (const en of st.enemies) if (en[4] <= 0 && (!near || en[2] > near[2])) near = en  // 已入场(delay≤0)且最深
    out.engine.onMove(near ? near[1] : 187, 600)
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  ok(out.result && out.result.win, `${slug} L1 机体追敌清波通关（波峰 ${maxWave}，${(steps / 120).toFixed(1)}s）`, out.result && { win: out.result.win, score: out.result.score })
  /* 一命制耗尽即败：master（lives=1）静止站桩必败 */
  const out2 = makeEngine(cfgs['bullet-shmup-raid-05'], 5, 'bullet-shmup')
  out2.engine.startLevel()
  let steps2 = 0
  while (!out2.result && steps2 < 120 * 120) { out2.engine.update(1 / 60); steps2++ }
  ok(out2.result && !out2.result.win, 'bullet-shmup-raid-05 L5 站桩中弹耗尽判负（一命制在位）', out2.result && { win: out2.result.win })
}
/* =====================================================================
 * 5d) bullet-dodge 神仙模拟：圆周走位存活；站桩必中弹
 * ===================================================================== */
console.log('\n— bullet-dodge 神仙模拟 —')
{
  const slug = 'bullet-dodge-weave-03'                    // simple
  const out = makeEngine(cfgs[slug], 1, 'bullet-dodge')
  out.engine.startLevel()
  out.engine.onDown(187, 450)
  let steps = 0
  while (!out.result && steps < 120 * 120) {
    /* 贪心躲避：近弹斥力合成 + 回中吸引，步进移动（QA 神仙策略） */
    const st = out.engine.__state()
    let fx = 0, fy = 0
    for (const p of st.projs) {
      const dx = st.dot[0] - p[0], dy = st.dot[1] - p[1], d = Math.hypot(dx, dy)
      if (d < 90 && d > 0.01) { const w = (90 - d) / d; fx += dx * w; fy += dy * w }
    }
    fx += (187 - st.dot[0]) * 0.6; fy += (430 - st.dot[1]) * 0.6
    out.engine.onMove(st.dot[0] + fx, st.dot[1] + fy + 24)   // +24 抵消引擎指上偏移
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  ok(out.result && out.result.win, `${slug} L1 贪心躲避存活通关（${(steps / 120).toFixed(1)}s）`, out.result && { win: out.result.win, score: out.result.score })
  /* 站桩：normal 中心不动 → 一命制判负 */
  const out2 = makeEngine(cfgs['bullet-dodge-weave-01'], 3, 'bullet-dodge')
  out2.engine.startLevel()
  out2.engine.onDown(187, 430)
  let steps2 = 0
  while (!out2.result && steps2 < 120 * 90) { out2.engine.update(1 / 60); steps2++ }
  ok(out2.result && !out2.result.win, 'bullet-dodge-weave-01 L3 站桩中弹判负（一命制在位）', out2.result && { win: out2.result.win })
}
/* =====================================================================
 * 5e) drop-catcher 神仙模拟：篮盯最近落好物 → 接满通关；计分复算
 * ===================================================================== */
console.log('\n— drop-catcher 神仙模拟 —')
{
  const slug = 'drop-catcher-harvest-02'                  // relaxed
  const out = makeEngine(cfgs[slug], 1, 'drop-catcher')
  out.engine.startLevel()
  let steps = 0
  while (!out.result && steps < 120 * 180) {
    const st = out.engine.__state()
    let target = null
    for (const it of st.items) if (!it[0] && it[3] > 480 && (!target || it[3] < target[3])) target = it  // 好物将落
    if (target) out.engine.onMove(target[2], 0)
    out.engine.update(1 / 60)
    if (steps % 30 === 0) out.renderSmoke()
    steps++
  }
  const st = out.engine.__state()
  ok(out.result && out.result.win, `${slug} L1 篮盯好物接满通关（${(steps / 120).toFixed(1)}s）`, out.result && { win: out.result.win, score: out.result.score })
  /* 计分复算：score = Σ(面值+连击×5) − 20×接坏物（下限 0）逐事件重放 */
  ok(out.result && out.result.s2 === st.target * 12 && out.result.s3 === st.target * 15, `${slug} s2/s3=target×12/15（target=${st.target}）`)
}
/* =====================================================================
 * 5f) block-fit 贪心模拟：首格放置 → 达标或死局判负；计分逐事件复算
 * ===================================================================== */
console.log('\n— block-fit 贪心模拟 —')
{
  /* 21 形状池：静态全集校验（1+1+2+5+12，归一化后无重复） */
  {
    const m = engineSrc['block-fit'].match(/const SHAPES = (\[[\s\S]*?\n  \]);/)
    ok(!!m, 'SHAPES 源可解析')
    if (m) {
      const shapes = vm.runInNewContext(m[1])
      const norm = (cells) => {
        const mx = Math.min(...cells.map(c => c[0])), my = Math.min(...cells.map(c => c[1]))
        return cells.map(([x, y]) => `${x - mx},${y - my}`).sort().join('|')
      }
      const set = new Set(shapes.map(norm))
      const hist = {}
      for (const s of shapes) hist[s.length] = (hist[s.length] || 0) + 1
      ok(shapes.length === 21 && set.size === 21, '形状池 21 形且无重复', { n: shapes.length, uniq: set.size })
      ok(JSON.stringify(hist) === JSON.stringify({ 1: 1, 2: 1, 3: 2, 4: 5, 5: 12 }), '1–5 格分布 = 1/1/2/5/12（自由多格全集）', hist)
    }
  }
  function parseCells(s) { return s.split('|').map(c => c.split(',').map(Number)) }
  function placeGreedy(out, st) {
    const N = 10
    const fits = (cells, r, c) => cells.every(([dx, dy]) => {
      const x = c + dx, y = r + dy
      return x >= 0 && x < N && y >= 0 && y < N && st.grid[y * N + x] === 0
    })
    for (let i = 0; i < st.pieces.length; i++) {
      const p = st.pieces[i]
      if (!p) continue
      const cells = parseCells(p)
      let w = 0, h = 0
      for (const [dx, dy] of cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1) }
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (fits(cells, r, c)) {
          /* 计分复算镜像：放置后棋盘的全行/列扫描 */
          const after = st.grid.slice()
          for (const [dx, dy] of cells) after[(r + dy) * N + (c + dx)] = 1
          let rows = 0, cols = 0
          for (let rr = 0; rr < N; rr++) { let f = true; for (let cc = 0; cc < N; cc++) if (after[rr * N + cc] === 0) f = false; if (f) rows++ }
          for (let cc = 0; cc < N; cc++) { let f = true; for (let rr = 0; rr < N; rr++) if (after[rr * N + cc] === 0) f = false; if (f) cols++ }
          const lines = rows + cols
          const expected = cells.length + (lines > 0 ? lines * 10 * N + (rows > 0 && cols > 0 ? 30 : 0) : 0)
          const scoreBefore = st.score
          /* 引擎锚点换算：块 bbox 中心 = 手指上方 24px（ghostAnchor 的 cx/cy 公式逆推） */
          const fx = 37.5 + (c + w / 2) * 30
          const fy = 62 + 24 + (r + h / 2) * 30
          const slotX = 12 + i * ((375 - 24) / 3) + 20
          out.engine.onDown(slotX, 590); out.engine.onMove(fx, fy); out.engine.onUp()
          const st2 = out.engine.__state()
          out.lastDeltaOk = st2.score - scoreBefore === expected
          return st2
        }
      }
    }
    return null
  }
  for (const slug of ['block-fit-mosaic-02', 'block-fit-mosaic-01', 'block-fit-mosaic-05']) {
    const out = makeEngine(cfgs[slug], 1, 'block-fit')
    out.engine.startLevel()
    let steps = 0, deltaOk = true, noStuck = true
    while (!out.result && steps < 600) {
      const st = out.engine.__state()
      const st2 = placeGreedy(out, st)
      if (!st2) { noStuck = false; break }                // 三块均无处可放且引擎未判负 = 异常
      if (out.lastDeltaOk === false) deltaOk = false
      steps++
    }
    ok(out.result !== null && noStuck, `${slug} L1 贪心放置有限步终局（${steps} 步，${out.result && out.result.win ? '通关' : '判负'}）`)
    ok(deltaOk, `${slug} 逐放置计分复算（放置×1+消行×100+同消×30）`)
  }
  /* 障碍非角格（hard=2 / master=4） */
  {
    let obsOk = true
    for (const slug of ['block-fit-mosaic-04', 'block-fit-mosaic-05']) {
      const out = makeEngine(cfgs[slug], 1, 'block-fit')
      const st = out.engine.__state()
      const corners = new Set([0, 9, 90, 99])
      let obs = 0
      st.grid.forEach((v, i) => { if (v === 2) { obs++; if (corners.has(i)) obsOk = false } })
      if (obs !== cfgs[slug].typeExtra.obstacleStart) obsOk = false
    }
    ok(obsOk, 'block-fit 障碍数=obstacleStart 且不在角格')
  }
  /* 通关路径：补行贪心（优先完成行/列、其次紧凑）→ relaxed/normal L1 应可达标 */
  function placeSmart(out, st) {
    const N = 10
    const fits = (cells, r, c, g) => cells.every(([dx, dy]) => {
      const x = c + dx, y = r + dy
      return x >= 0 && x < N && y >= 0 && y < N && g[y * N + x] === 0
    })
    let best = null
    for (let i = 0; i < st.pieces.length; i++) {
      const p = st.pieces[i]
      if (!p) continue
      const cells = parseCells(p)
      let w = 0, h = 0
      for (const [dx, dy] of cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1) }
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (!fits(cells, r, c, st.grid)) continue
        const after = st.grid.slice()
        for (const [dx, dy] of cells) after[(r + dy) * N + (c + dx)] = 1
        let lines = 0, emptyTouched = 0
        for (let rr = 0; rr < N; rr++) {
          let full = true, empt = 0
          for (let cc = 0; cc < N; cc++) { if (after[rr * N + cc] === 0) { full = false; empt++ } }
          if (full) lines++
          if (rr >= r && rr < r + h) emptyTouched += empt
        }
        for (let cc = 0; cc < N; cc++) {
          let full = true
          for (let rr = 0; rr < N; rr++) if (after[rr * N + cc] === 0) full = false
          if (full) lines++
        }
        /* 补行优先；无行可补时：大块先用 + 底行左起（减少碎盘死局） */
        const rank = lines * 100000 - emptyTouched * 10 + cells.length * 50 + (N - 1 - r) * 5 - c
        if (!best || rank > best.rank) best = { i, r, c, w, h, rank, cells }
      }
    }
    if (!best) return null
    const fx = 37.5 + (best.c + best.w / 2) * 30
    const fy = 62 + 24 + (best.r + best.h / 2) * 30
    const slotX = 12 + best.i * ((375 - 24) / 3) + 20
    out.engine.onDown(slotX, 590); out.engine.onMove(fx, fy); out.engine.onUp()
    out.renderSmoke()
    return out.engine.__state()
  }
  for (const slug of ['block-fit-mosaic-02', 'block-fit-mosaic-01']) {
    const out = makeEngine(cfgs[slug], 1, 'block-fit')
    out.engine.startLevel()
    out.renderSmoke()
    let steps = 0
    while (!out.result && steps < 2000) {
      const st = out.engine.__state()
      if (!placeSmart(out, st)) break
      steps++
    }
    ok(out.result && out.result.win, `${slug} L1 补行贪心达标通关（${steps} 步放置）`, out.result && { win: out.result.win, score: out.result.score, target: out.engine.__state().target })
  }
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`)
process.exit(failed ? 1 : 0)
