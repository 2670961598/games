#!/usr/bin/env node
/* =====================================================================
 * GAMES-21 量产D QA harness（§31 DoD 第 3/9 项的机器证据）：
 *  1) 30 款 index.html 内联脚本在浏览器桩沙箱中完整 boot（语法+运行冒烟）；
 *  2) 确定性：同 slug#level 两次生成 → 状态一致（hash 对比）；
 *  3) 类型规则不变量：match3 无现成连/有可消步；water-sort 反向生成可解（BFS 实解）；
 *     rhythm-tap 谱面约束与判定窗/计分公式；slide-merge 生成块+通关路径；
 *     chain-shot 珠数守恒；mini-td 曲线复算与 normal L1 可通关。
 * node games/_shared/test.mjs  → 全绿 exit 0。
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

/* ---------- 浏览器桩 ---------- */
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
for (const f of await readdir(join(SHARED, 'engines'))) engineSrc[f.replace('.js', '')] = await readFile(join(SHARED, 'engines', f), 'utf8')
const ENGINE_VAR = { 'match3': 'Match3Engine', 'slide-merge': 'SlideMergeEngine', 'water-sort': 'WaterSortEngine', 'chain-shot': 'ChainShotEngine', 'mini-td': 'MiniTDEngine', 'rhythm-tap': 'RhythmTapEngine' }

/** 构造裸引擎（带事件捕获）。out.result/out.huds 由 game 回调捕获。 */
function makeEngine(cfg, level, type) {
  const ctx = makeSandbox()
  vm.runInContext(commonSrc + '\n' + engineSrc[type], ctx)
  const out = { result: null, huds: [] }
  const game = {
    W: 375, H: 667, cfg, level,
    area: { x: 0, y: 48, w: 375, h: 619 },
    setHud(p) { out.huds.push(p) }, toast() { },
    win(score, opt) { if (!out.result) out.result = { win: true, score, ...opt } },
    lose(score) { if (!out.result) out.result = { win: false, score } },
  }
  const GG = vm.runInContext('G', ctx)
  game.rng = GG.mulberry32(GG.fnv1a32(`${cfg.slug}#${level}`))
  ctx.__game = game
  const engine = vm.runInContext(`${ENGINE_VAR[type]}(__game)`, ctx)
  out.engine = engine
  out.replay = () => { ctx.__game = game; return vm.runInContext(`${ENGINE_VAR[type]}(__game)`, ctx) }
  return out
}

/* ---------- 收集 30 款配置 ---------- */
const cfgs = {}
for (const type of Object.keys(ENGINE_VAR)) {
  for (const slugDir of (await readdir(join(GAMES, type), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const meta = JSON.parse(await readFile(join(GAMES, type, slugDir, 'game.json'), 'utf8'))
    cfgs[meta.slug] = meta
  }
}
ok(Object.keys(cfgs).length === 30, '游戏目录共 30 款', Object.keys(cfgs).length)

/* =====================================================================
 * 1) 30 款 index.html 完整 boot 冒烟（提取 <script> 段落逐段执行）
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
}

/* =====================================================================
 * 2) 确定性：同 slug#level 两次实例 → __state 一致
 * ===================================================================== */
console.log('\n— 确定性（每类抽 3 关 × 双跑）—')
for (const type of Object.keys(ENGINE_VAR)) {
  const slugs = Object.values(cfgs).filter(c => c.type === type).map(c => c.slug)
  const slug = slugs[0]
  const levels = [1, Math.floor(cfgs[slug].levels / 2), cfgs[slug].levels]
  let allSame = true
  for (const L of levels) {
    const a = makeEngine(cfgs[slug], L, type); a.engine.startLevel()
    const b = makeEngine(cfgs[slug], L, type); b.engine.startLevel()
    if (hash(a.engine.__state()) !== hash(b.engine.__state())) allSame = false
  }
  ok(allSame, `${slug} 同 seed 双跑状态一致（L=${levels.join(',')}）`)
}

/* =====================================================================
 * 3) match3：无现成 ≥3 连 / 存在可消步 / 公式复算 / 一步实玩
 * ===================================================================== */
console.log('\n— match3 规则 —')
{
  const type = 'match3'
  for (const cfg of Object.values(cfgs).filter(c => c.type === type)) {
    const t = cfg.typeExtra, n = cfg.levels
    let noMatch = true, hasSwap = false, formulaOk = true
    for (const L of [1, 10, 25, 50]) {
      const e = makeEngine(cfg, L, type); e.engine.startLevel()
      const st = e.engine.__state()
      const g = st.grid, N = st.N
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (c + 2 < N && g[r * N + c] === g[r * N + c + 1] && g[r * N + c] === g[r * N + c + 2] && !st.ice[r * N + c] && !st.ice[r * N + c + 1] && !st.ice[r * N + c + 2]) noMatch = false
        if (r + 2 < N && g[r * N + c] === g[(r + 1) * N + c] && g[r * N + c] === g[(r + 2) * N + c] && !st.ice[r * N + c] && !st.ice[(r + 1) * N + c] && !st.ice[(r + 2) * N + c]) noMatch = false
      }
      const expTarget = Math.ceil(t.targetScore * (1 + 0.15 * (L - 1) / (n - 1)))
      const expMoves = Math.max(12, Math.round(t.movesBase * (1 - 0.10 * (L - 1) / (n - 1))))
      if (st.target !== expTarget || st.movesLeft !== expMoves) formulaOk = false
    }
    ok(noMatch, `${cfg.slug} 初始盘无现成 ≥3 连`)
    ok(formulaOk, `${cfg.slug} target/moves 曲线复算一致`)
    /* 找一步可消换位并实滑：步数 −1、无崩溃 */
    const e = makeEngine(cfg, 1, type); e.engine.startLevel()
    const st = e.engine.__state()
    const N = st.N, g = st.grid
    const cx = 11, cy = 100, cell = Math.floor(375 * 0.94 / N)
    outer: for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        const r2 = r + dr, c2 = c + dc
        if (r2 >= N || c2 >= N) continue
        const i = r * N + c, j = r2 * N + c2
        if (st.ice[i] || st.ice[j]) continue
        const tmp = g[i]; g[i] = g[j]; g[j] = tmp
        const m = (rr, cc) => {
          const v = g[rr * N + cc]; if (st.ice[rr * N + cc]) return false
          let h = 1; for (let k = cc - 1; k >= 0 && g[rr * N + k] === v && !st.ice[rr * N + k]; k--) h++
          for (let k = cc + 1; k < N && g[rr * N + k] === v && !st.ice[rr * N + k]; k++) h++
          if (h >= 3) return true
          let s2 = 1; for (let k = rr - 1; k >= 0 && g[k * N + cc] === v && !st.ice[k * N + cc]; k--) s2++
          for (let k = rr + 1; k < N && g[k * N + cc] === v && !st.ice[k * N + cc]; k++) s2++
          return s2 >= 3
        }
        const good = m(r, c) || m(r2, c2)
        g[j] = g[i]; g[i] = tmp
        if (good) {
          hasSwap = true
          e.engine.onDown(cx + c * cell + 2, cy + r * cell + 2)
          e.engine.onUp(cx + c * cell + 2 + dc * 30, cy + r * cell + 2 + dr * 30)
          for (let k = 0; k < 200 && !e.result; k++) e.engine.update(0.05)
          const after = e.engine.__state()
          if (after.movesLeft !== st.movesLeft - 1) hasSwap = false
          break outer
        }
      }
    }
    ok(hasSwap, `${cfg.slug} 存在可消换位且实滑消耗 1 步`)
  }
}

/* =====================================================================
 * 4) slide-merge：初始 2 块 / 有效滑动补 1 块 / 公式 / 旋转脚本可通关（relaxed L1）
 * ===================================================================== */
console.log('\n— slide-merge 规则 —')
{
  const type = 'slide-merge'
  for (const cfg of Object.values(cfgs).filter(c => c.type === type)) {
    const e = makeEngine(cfg, 1, type); e.engine.startLevel()
    let st = e.engine.__state()
    ok(st.grid.filter(v => v).length === 2, `${cfg.slug} 初始两块`)
    const expTarget = Math.min(cfg.typeExtra.targetCap, 64 * Math.pow(2, Math.floor(0 / 5)))
    ok(st.target === expTarget, `${cfg.slug} target(1)=64×2^0`, st.target)
    /* 四方向滑一遍：至少一次有效滑动改变盘面（补块/合并），无效滑动不改变 */
    const before = hash(st.grid)
    const dirs = [[40, 0], [-40, 0], [0, 40], [0, -40]]
    let moved = false
    for (const [dx, dy] of dirs) {
      e.engine.onDown(180, 350); e.engine.onUp(180 + dx, 350 + dy)
      e.engine.update(0.3)
      const st2 = e.engine.__state()
      if (hash(st2.grid) !== before) { moved = true; break }
    }
    ok(moved, `${cfg.slug} 有效滑动改变盘面`)
  }
  /* 通关路径：relaxed L1 target=64，旋转四方向最多 600 滑 */
  const cfg = cfgs['slide-merge-tile-02']
  const e = makeEngine(cfg, 1, 'slide-merge'); e.engine.startLevel()
  const seq = [[40, 0], [0, 40], [-40, 0], [0, -40]]
  let i = 0
  for (; i < 600 && !e.result; i++) {
    const [dx, dy] = seq[i % 4]
    e.engine.onDown(180, 350); e.engine.onUp(180 + dx, 350 + dy)
    e.engine.update(0.3)
  }
  ok(e.result && e.result.win, `slide-merge-tile-02 L1 旋转脚本通关（${i} 滑）`, e.result)
}

/* =====================================================================
 * 5) water-sort：反向生成可解（BFS 实解）+ 步数公式
 * ===================================================================== */
console.log('\n— water-sort 可解性 —')
{
  const type = 'water-sort'
  /* 逆序回放法（比黑盒搜索更强）：测试侧独立复刻 spec §5.6 PRNG 与 §24 反向生成 rng 消费序，
   * ① 复刻终局与引擎 __state 逐字节一致（交叉验证 PRNG/生成器）；
   * ② 记录 (A,B) 反向移动，按逆序用引擎同款正向倒水规则回放 → 必达已解（可解性构造性证明）。 */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function replayGen(cfg, L) {
    const t = cfg.typeExtra, n = cfg.levels
    const rng = mulberry32(fnv1a32(`${cfg.slug}#${L}`))
    const colors = Math.min(t.colorsCap, t.colorsBase + Math.floor((L - 1) / Math.max(1, Math.floor(n / 5))))
    const movesLimit = Math.ceil(colors * t.tubeCap * t.moveFactor * 0.5)
    const CAP = t.tubeCap
    const topRun = (tb) => { const k2 = tb.length; if (!k2) return { c: -1, k: 0 }; let k = 1; while (k < k2 && tb[k2 - 1 - k] === tb[k2 - 1]) k++; return { c: tb[k2 - 1], k }; }
    const isSolved = (st) => st.every(tb => tb.length === 0 || (tb.length === CAP && tb.every(v => v === tb[0])))
    let tubes = null, moves = null
    for (let attempt = 0; attempt < 32; attempt++) {
      tubes = []
      for (let c = 0; c < colors; c++) tubes.push(new Array(CAP).fill(c))
      for (let e2 = 0; e2 < t.emptyTubes; e2++) tubes.push([])
      moves = []
      const nn = Math.ceil(movesLimit * 0.6)
      let moved = 0
      for (let s = 0; s < nn; s++) {
        const srcs = []
        for (let i = 0; i < tubes.length; i++) if (tubes[i].length) srcs.push(i)
        if (!srcs.length) break
        const B = srcs[(rng() * srcs.length) | 0]
        const run = topRun(tubes[B])
        const dsts = []
        for (let i = 0; i < tubes.length; i++) {
          if (i === B || tubes[i].length >= CAP) continue
          const tr = topRun(tubes[i])
          if (tr.k === 0 || tr.c !== run.c) dsts.push(i)
        }
        if (!dsts.length) continue
        const A = dsts[(rng() * dsts.length) | 0]
        const room = Math.min(run.k, CAP - tubes[A].length)
        const j = room - ((rng() * room) | 0)
        for (let m = 0; m < j; m++) tubes[A].push(tubes[B].pop())
        moves.push({ A, B })
        moved += j
      }
      if (moved > 0 && !isSolved(tubes)) break
    }
    return { tubes, moves, colors, movesLimit, CAP }
  }
  function forwardPour(tubes, a, b, CAP) {   // 引擎同款正向规则
    const run = (tb) => { const k2 = tb.length; let k = 1; while (k < k2 && tb[k2 - 1 - k] === tb[k2 - 1]) k++; return k; }
    const k = Math.min(run(tubes[a]), CAP - tubes[b].length)
    for (let m = 0; m < k; m++) tubes[b].push(tubes[a].pop())
  }
  const key = (tubes) => tubes.map(t => t.join(',')).join('|')
  /** DFS 求解（同色目标优先排序 + state→剩余深度记忆）；反向生成解深 ≤ ⌈moves×0.6⌉，限深 60 足够 */
  function solve(tubes, CAP, maxStates) {
    const isSolved = (st) => st.every(tb => tb.length === 0 || (tb.length === CAP && tb.every(v => v === tb[0])))
    const best = new Map()
    function dfs(st, depth) {
      if (isSolved(st)) return true
      if (depth <= 0 || best.size >= maxStates) return false
      const k = key(st)
      const prev = best.get(k)
      if (prev !== undefined && prev >= depth) return false
      best.set(k, depth)
      const moves = []
      for (let a = 0; a < st.length; a++) {
        if (!st[a].length) continue
        const top = st[a][st[a].length - 1]
        let run = 1; while (run < st[a].length && st[a][st[a].length - 1 - run] === top) run++
        const pure = run === st[a].length                    // 源管整管纯色
        for (let b = 0; b < st.length; b++) {
          if (a === b || st[b].length >= CAP) continue
          if (st[b].length && st[b][st[b].length - 1] !== top) continue
          if (st[b].length === 0 && pure) continue           // 纯色管倒空管=纯换位，剪枝
          const kk = Math.min(run, CAP - st[b].length)
          const nt = st.map(tb => tb.slice())
          for (let m = 0; m < kk; m++) nt[b].push(nt[a].pop())
          moves.push({ nt, order: st[b].length ? 0 : 1 })   // 同色目标优先
        }
      }
      moves.sort((x, y) => x.order - y.order)
      for (const m of moves) if (dfs(m.nt, depth - 1)) return true
      return false
    }
    return dfs(tubes, 60) ? best.size : -1
  }
  for (const cfg of Object.values(cfgs).filter(c => c.type === type)) {
    const t = cfg.typeExtra, n = cfg.levels
    let allOk = true, details = []
    for (const L of [1, 5, 9, 13, 20]) {
      const e = makeEngine(cfg, L, type); e.engine.startLevel()
      const st = e.engine.__state()
      const colors = Math.min(t.colorsCap, t.colorsBase + Math.floor((L - 1) / Math.max(1, Math.floor(n / 5))))
      const expMoves = Math.ceil(colors * t.tubeCap * t.moveFactor * 0.5)
      if (st.colors !== colors || st.movesLimit !== expMoves) { allOk = false; details.push(`L${L} 曲线 colors=${st.colors}/${colors} moves=${st.movesLimit}/${expMoves}`) }
      if (st.solved) { allOk = false; details.push(`L${L} 生成退化（已解）`) }
      /* ① 独立复刻（同 seed 同流）→ 与引擎状态逐字节一致 */
      const rep = replayGen(cfg, L)
      if (key(rep.tubes) !== key(st.tubes)) { allOk = false; details.push(`L${L} 复刻状态与引擎不一致`); continue }
      /* ② 逆序回放正向倒水 → 已解（可解性构造性证明） */
      const back = rep.tubes.map(tb => tb.slice())
      for (let i = rep.moves.length - 1; i >= 0; i--) forwardPour(back, rep.moves[i].A, rep.moves[i].B, t.tubeCap)
      const solvedStr = key(back)
      const isSolvedStr = back.every(tb => tb.length === 0 || (tb.length === t.tubeCap && tb.every(v => v === tb[0])))
      if (!isSolvedStr) { allOk = false; details.push(`L${L} 逆序回放未达已解`) }
      /* ③ 黑盒 DFS 实解（双保险，仅低档位：hard/master 单空管搜索空间大，由②覆盖） */
      if (['relaxed', 'simple', 'normal'].includes(cfg.tier) && L <= 9) {
        const d = solve(st.tubes, t.tubeCap, 1500000)
        if (d < 0) { allOk = false; details.push(`L${L} DFS 未解（cap 150 万状态）`) }
      }
    }
    ok(allOk, `${cfg.slug} 反向生成可解（复刻一致+逆序回放达已解${['relaxed', 'simple', 'normal'].includes(cfg.tier) ? '+DFS' : ''}）`, details.join('; '))
  }
}

/* =====================================================================
 * 6) chain-shot：珠数守恒 + 瞄准首珠脚本实玩 + 确定性重放
 * ===================================================================== */
console.log('\n— chain-shot 规则 —')
{
  const type = 'chain-shot'
  for (const cfg of Object.values(cfgs).filter(c => c.type === type)) {
    const e = makeEngine(cfg, 1, type); e.engine.startLevel()
    let guard = 0, invariantOk = true, shots = 0
    const st0 = e.engine.__state()
    const total = st0.totalBalls
    while (!e.result && guard++ < 24000) {   // 最多 400s 模拟
      e.engine.update(1 / 60)
      /* 每 0.8s 瞄准首珠射一珠（从 __state 取实时位置，确定性成立） */
      if (guard % 48 === 0) {
        const st = e.engine.__state()
        const p = st.trackPos(st.head_s)
        if (p.y < 620) { e.engine.onDown(p.x, p.y); e.engine.onUp(p.x, p.y); shots++ }
      }
      const st = e.engine.__state()
      /* 守恒：场上珠数 ≤ 初始总数 + 已射入珠数（射珠入链是增项；消除是减项） */
      if (st.colors.length + st.queue.length > total + shots) { invariantOk = false; break }
    }
    const st = e.engine.__state()
    ok(invariantOk, `${cfg.slug} 珠数守恒（active ≤ total${total}+已射）`)
    ok(e.result !== null || guard >= 24000, `${cfg.slug} 脚本实玩无崩溃（${(guard / 60).toFixed(0)}s, ${shots} 珠, 剩 ${st.colors.length + st.queue.length}）`)
    /* 公式复算 */
    const t = cfg.typeExtra, n = cfg.levels
    ok(total === Math.ceil(t.totalBalls * (1 + 0.30 * 0 / (n - 1))), `${cfg.slug} balls(1) 复算`, total)
  }
  /* 瞄准脚本双跑一致（确定性含输入路径） */
  const cfg = cfgs['chain-shot-orbit-01']
  function play() {
    const e = makeEngine(cfg, 3, type); e.engine.startLevel()
    let guard = 0, trace = []
    while (!e.result && guard++ < 6000) {
      e.engine.update(1 / 60)
      if (guard % 48 === 0) {
        const st = e.engine.__state()
        const p = st.trackPos(st.head_s)
        e.engine.onDown(p.x, p.y); e.engine.onUp(p.x, p.y)
      }
      if (guard % 120 === 0) trace.push(hash(e.engine.__state()))
    }
    return { trace, result: e.result }
  }
  const a = play(), b = play()
  ok(hash(a.trace) === hash(b.trace) && a.result?.win === b.result?.win, 'chain-shot L3 同输入双跑轨迹一致')
}

/* =====================================================================
 * 7) mini-td：曲线复算 + 建塔脚本通关（normal L1）
 * ===================================================================== */
console.log('\n— mini-td 规则 —')
{
  const type = 'mini-td'
  const cfg0 = cfgs['mini-td-guard-01']
  {
    const t = cfg0.typeExtra, n = cfg0.levels
    const e = makeEngine(cfg0, 1, type); e.engine.startLevel()
    const st = e.engine.__state()
    ok(st.wavesN === Math.min(t.wavesCap, 5 + Math.floor(5 * 0 / (n - 1))), 'mini-td waves(1)=5', st.wavesN)
    ok(st.sizeN === Math.round(t.waveSize * 1), 'mini-td waveSize(1)=8', st.sizeN)
    ok(st.hp === Math.ceil(t.enemyHP * 1 * (1 + 0.08 * 1)), 'mini-td hp(1,1)=11', st.hp)
    ok(st.enemiesTotal === 40, 'mini-td enemiesTotal=5×8', st.enemiesTotal)
  }
  /* 建塔脚本：slots 循环建箭塔（gold 允许即建），跑完判局。注意：卡片按钮命中区在 render 中计算，须逐帧渲染 */
  const gctx = canvasStub().getContext()
  function play(cfg, level) {
    const e = makeEngine(cfg, level, type); e.engine.startLevel()
    let t = 0, built = 0
    const tick = () => { e.engine.update(1 / 30); e.engine.render(gctx) }
    while (!e.result && t < 900) {
      tick(); t += 1 / 30
      const st = e.engine.__state()
      if (t % 2 < 0.04) {
        for (const s of st.slots) {
          if (!s.tower && st.gold >= 50) { e.engine.onUp(s.x, s.y); tick(); e.engine.onUp(72, 625); tick(); built++; break }
          if (s.tower && s.tower.level < 2 && st.gold >= 75) { e.engine.onUp(s.x, s.y); tick(); e.engine.onUp(72, 625); tick(); break }
        }
      }
    }
    return { result: e.result, state: e.engine.__state(), t, built, kills: e.engine.__state().kills }
  }
  const r = play(cfg0, 1)
  ok(r.result && r.result.win, `mini-td normal L1 建塔脚本通关（${r.t.toFixed(0)}s, ${r.built} 塔, score=${r.result?.score}）`, r.result)
  ok(r.result && r.result.s2 === 12 * 40 && r.result.s3 === 15 * 40, 'mini-td s2/s3 = 12/15×enemies')
  const r2 = play(cfgs['mini-td-guard-02'], 1)
  ok(r2.result && r2.result.win, `mini-td relaxed L1 通关（sanity）`, r2.result)
}

/* =====================================================================
 * 8) rhythm-tap：谱面约束 + 判定窗/计分公式 + Perfect 全打击 / 全 Miss 失败
 * ===================================================================== */
console.log('\n— rhythm-tap 规则 —')
{
  const type = 'rhythm-tap'
  for (const cfg of Object.values(cfgs).filter(c => c.type === type)) {
    const t = cfg.typeExtra, n = cfg.levels
    for (const L of [1, 15, 30]) {
      const e = makeEngine(cfg, L, type); e.engine.startLevel()
      const st = e.engine.__state()
      const expNotes = Math.ceil(t.notesBase * (1 + 0.50 * (L - 1) / (n - 1)))
      ok(st.notes.length === expNotes, `${cfg.slug} L${L} notes=${expNotes}`, st.notes.length)
      ok(st.bpm === Math.round(t.bpm * (1 + 0.30 * (L - 1) / (n - 1))), `${cfg.slug} L${L} bpm 复算`, st.bpm)
      /* 约束：同拍同轨不重；同轨相邻 ≥1 拍；双押仅相邻轨 */
      const byBeat = new Map()
      let consOk = true
      const lastLaneBeat = [-9, -9, -9, -9]
      for (const nt of st.notes) {
        const k = nt.beat + ':' + nt.lane
        if (byBeat.has(k)) consOk = false
        byBeat.set(k, 1)
        if (nt.beat - lastLaneBeat[nt.lane] < 1) consOk = false
        lastLaneBeat[nt.lane] = nt.beat
      }
      for (const [beat] of byBeat) { }
      const beatLanes = new Map()
      for (const nt of st.notes) {
        if (!beatLanes.has(nt.beat)) beatLanes.set(nt.beat, [])
        beatLanes.get(nt.beat).push(nt.lane)
      }
      for (const [beat, lanes] of beatLanes) {
        if (lanes.length > 2) consOk = false
        if (lanes.length === 2 && Math.abs(lanes[0] - lanes[1]) !== 1) consOk = false
      }
      ok(consOk, `${cfg.slug} L${L} 谱面约束（同轨≥1拍/双押邻轨）`)
    }
  }
  /* Perfect 全打击：score = Σ(100 + 2×min(combo,100))，win */
  {
    const cfg = cfgs['rhythm-tap-beat-01']
    const e = makeEngine(cfg, 1, type); e.engine.startLevel()
    let st = e.engine.__state()
    const notes = st.notes.slice().sort((a, b) => a.beat - b.beat)
    const beat = 60 / st.bpm
    const laneW = 375 / 4
    let idx = 0
    while (!e.result && idx < notes.length) {
      const target = notes[idx].beat * beat + 0.6
      while (st.tNow < target) { e.engine.update(1 / 240); st = e.engine.__state() }
      e.engine.onUp(laneW * (notes[idx].lane + 0.5), 660)
      idx++
    }
    e.engine.update(2)
    const exp = notes.reduce((s, _, i) => s + 100 + 2 * Math.min(i + 1, 100), 0)
    ok(e.result && e.result.win && e.result.score === exp, `Perfect 全打击：score=${exp}（判定窗+计分公式）`, { got: e.result?.score, exp })
  }
  /* 全 Miss：life 耗尽失败 */
  {
    const cfg = cfgs['rhythm-tap-beat-01']
    const e = makeEngine(cfg, 1, type); e.engine.startLevel()
    let guard = 0
    while (!e.result && guard++ < 60000) e.engine.update(1 / 60)
    ok(e.result && !e.result.win, `全 Miss 失败（life=${cfg.typeExtra.life} 耗尽）`, e.result)
  }
}

console.log(`\n========== ${passed} 通过 / ${failed} 失败 ==========`)
process.exit(failed ? 1 : 0)
