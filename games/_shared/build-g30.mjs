#!/usr/bin/env node
/* =====================================================================
 * GAMES-30 试点构建器：tap-burst + lane-runner 各 5 档 = 10 款，迁原生基座 GE。
 * 结构（4 段脚本内联，与量产 A 批同形——QA harness test-a.mjs 断言原样可跑）：
 *   ① CONFIG（与同目录 game.json 同源；数值档位冻结，仅 version→2.0.0 标记基座换代）
 *   ② games/_shared/engine.js（GE 原生基座：PRNG/tier 注入/安全区词表/上报协议）
 *   ③ games/_shared/engines/<type>.js（逻辑引擎，零 DOM 依赖判定）
 *   ④ GE.boot(CONFIG, <Type>Engine)
 * §5.1 自包含铁律：零外部请求、离线可玩；server 对 /games/_* 一律 404，故内联是唯一通路。
 * 重跑幂等：只覆盖本清单 10 目录（数值取自 game.json 不重生成）。
 * 注意：量产构建器 build-a.mjs 重跑会把这 10 款写回 common.js 壳——基座换代期间勿重跑
 *      A 批量产脚本（后续波次全量迁移后统一收口，见 REPORT）。
 * node games/_shared/build-g30.mjs
 * ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

/* 试点类型清单（type → 目录序 root + 引擎全局名） */
const TYPES = {
  'tap-burst': { root: 'pop', engineVar: 'TapBurstEngine' },
  'lane-runner': { root: 'dash', engineVar: 'LaneRunnerEngine' },
}
const TIER_ORDER = ['normal', 'relaxed', 'simple', 'hard', 'master']   // 序号 01..05（§31）

const engineBaseSrc = await readFile(join(SHARED, 'engine.js'), 'utf8')

function pageHtml(meta, engineSrc, engineVar) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">
<title>${meta.title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #0b0e14; touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { display: block; touch-action: none; }
</style>
</head>
<body>
<canvas id="cv"></canvas>
<script>
/* 本款数值（与同目录 game.json 同源——GAMES-30 build-g30.mjs；引擎零网络请求，离线可玩） */
const CONFIG = ${JSON.stringify(meta, null, 2)};
</script>
<script>
/* games/_shared/engine.js —— GAMES-30 原生基座 GE（bench 结构化基线产品化，零外部引擎依赖） */
${engineBaseSrc}
</script>
<script>
/* games/_shared/engines/${meta.type}.js —— 逻辑引擎（判定确定性：每关 rng=mulberry32(fnv1a32(slug#level))） */
${engineSrc}
</script>
<script>
GE.boot(CONFIG, ${engineVar});
</script>
</body>
</html>
`
}

let count = 0
for (const [type, def] of Object.entries(TYPES)) {
  const engineSrc = await readFile(join(SHARED, 'engines', `${type}.js`), 'utf8')
  for (let i = 0; i < TIER_ORDER.length; i++) {
    const slug = `${type}-${def.root}-${String(i + 1).padStart(2, '0')}`
    const dir = join(GAMES, type, slug)
    const meta = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
    if (meta.type !== type) throw new Error(`${slug}: game.json type=${meta.type} 与目录不符`)
    /* 数值档位冻结：仅 version 标记基座换代（GAMES-22 同口径） */
    meta.version = '2.0.0'
    await writeFile(join(dir, 'game.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
    await writeFile(join(dir, 'index.html'), pageHtml(meta, engineSrc, def.engineVar), 'utf8')
    console.log(`${type}/${slug}  tier=${meta.tier}  v2.0.0(GE)`)
    count++
  }
}
console.log(`\n共 ${count} 款生成完毕（重跑幂等，仅覆盖本清单目录）`)
