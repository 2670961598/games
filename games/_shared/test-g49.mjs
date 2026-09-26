#!/usr/bin/env node
/* =====================================================================
 * GAMES-49 迁移波 QA harness（E1=P2 首波：block-drop + block-fit 各 5 档）：
 *  1) 结构：10 款 index.html 4 段脚本/GE 基座段与 engine.js 字节一致/引擎段与
 *     _shared/engines/<type>.js 字节一致（构建器漂移门）/GE.boot 尾段/零外链/体积；
 *  2) 数值档位冻结：version=2.0.0 且 typeExtra 与 spec §25/§26 档位表逐字一致；
 *  3) seed 确定性纪律（代码级）：引擎源与 GE 基座源零 Math.random、
 *     零 Date.now（判定路径只许 rng=mulberry32(fnv1a32(slug#level))）；
 *  4) 判定/确定性/可赢性本体由 test-b/test-c 全量覆盖（本单重跑双绿 138/0 + 128/0）。
 * node games/_shared/test-g49.mjs  → 全绿 exit 0。
 * ===================================================================== */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

let passed = 0, failed = 0
function ok(cond, label, extra) {
  if (cond) { passed++; process.stdout.write(`  ✓ ${label}\n`) }
  else { failed++; process.stdout.write(`  ✗ ${label}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}\n`) }
}

/* spec §25/§26 数值档位表（冻结；与 game.json 逐字对照） */
const TIER_ORDER = ['normal', 'relaxed', 'simple', 'hard', 'master']
const TABLE = {
  'block-drop': {
    root: 'cascade', engineVar: 'BlockDropEngine',
    extra: [
      { dropMs: 800, wellW: 10, garbageBase: 4, nextN: 3, linesFactor: 1 },
      { dropMs: 1120, wellW: 10, garbageBase: 2, nextN: 3, linesFactor: 0.75 },
      { dropMs: 960, wellW: 10, garbageBase: 3, nextN: 3, linesFactor: 0.9 },
      { dropMs: 640, wellW: 10, garbageBase: 5, nextN: 2, linesFactor: 1.2 },
      { dropMs: 480, wellW: 10, garbageBase: 6, nextN: 1, linesFactor: 1.45 },
    ],
  },
  'block-fit': {
    root: 'mosaic', engineVar: 'BlockFitEngine',
    extra: [
      { targetScore: 2000, pentRate: 0.12, obstacleStart: 0, piecesPerRound: 3, refresh: 0 },
      { targetScore: 1500, pentRate: 0.05, obstacleStart: 0, piecesPerRound: 3, refresh: 1 },
      { targetScore: 1800, pentRate: 0.08, obstacleStart: 0, piecesPerRound: 3, refresh: 1 },
      { targetScore: 2400, pentRate: 0.16, obstacleStart: 2, piecesPerRound: 3, refresh: 0 },
      { targetScore: 2900, pentRate: 0.2, obstacleStart: 4, piecesPerRound: 3, refresh: 0 },
    ],
  },
}

const engineBaseSrc = await readFile(join(SHARED, 'engine.js'), 'utf8')
const engineSrc = {}
for (const type of Object.keys(TABLE)) engineSrc[type] = await readFile(join(SHARED, 'engines', `${type}.js`), 'utf8')

/* ---------- 3) seed 确定性纪律（代码级 grep 门；剥注释后查代码路径） ---------- */
console.log('— seed 确定性纪律（代码级）—')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
for (const type of Object.keys(TABLE)) {
  ok(!/Math\.random/.test(stripComments(engineSrc[type])), `${type} 引擎零 Math.random`)
  ok(!/Date\.now|new Date/.test(stripComments(engineSrc[type])), `${type} 引擎零 Date.now/new Date`)
}
ok(!/Math\.random/.test(stripComments(engineBaseSrc)), 'GE 基座零 Math.random')

for (const [type, def] of Object.entries(TABLE)) {
  for (let i = 0; i < 5; i++) {
    const slug = `${type}-${def.root}-${String(i + 1).padStart(2, '0')}`
    const dir = join(GAMES, type, slug)
    const html = await readFile(join(dir, 'index.html'), 'utf8')
    const meta = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])

    /* ---------- 1) 结构 ---------- */
    /* 内联段 = 构建器头注释行 + 源文件字节（与 build-g49.mjs 模板逐字对照） */
    const geSeg = (src) => `\n/* games/_shared/engine.js —— GAMES-30 原生基座 GE（bench 结构化基线产品化，零外部引擎依赖） */\n${src}\n`
    const engSeg = (src) => `\n/* games/_shared/engines/${type}.js —— 逻辑引擎（判定确定性：每关 rng=mulberry32(fnv1a32(slug#level))） */\n${src}\n`
    ok(scripts.length === 4, `${slug} 4 段脚本`, scripts.length)
    ok(scripts[1] === geSeg(engineBaseSrc), `${slug} GE 基座段与 engine.js 字节一致`)
    ok(scripts[2] === engSeg(engineSrc[type]), `${slug} 引擎段与 _shared/engines/${type}.js 字节一致`)
    ok((scripts[3] || '').trim() === `GE.boot(CONFIG, ${def.engineVar});`, `${slug} 尾段 GE.boot 调用`)
    ok(!/<script[^>]+src=|<link[^>]+href=|<img[^>]+src=/.test(html), `${slug} 零外部引用`)
    ok(html.length / 1024 <= 200, `${slug} 体积 ≤200KB`, +(html.length / 1024).toFixed(0))

    /* ---------- 2) 数值档位冻结 ---------- */
    ok(meta.version === '2.0.0', `${slug} version=2.0.0（基座换代标记）`, meta.version)
    ok(meta.tier === TIER_ORDER[i], `${slug} tier=${TIER_ORDER[i]}`, meta.tier)
    ok(JSON.stringify(meta.typeExtra) === JSON.stringify(def.extra[i]), `${slug} typeExtra 与 §${type === 'block-drop' ? 25 : 26} 档位表逐字一致`, meta.typeExtra)
  }
}

console.log(`\n===== ${passed} passed, ${failed} failed =====`)
process.exit(failed ? 1 : 0)
