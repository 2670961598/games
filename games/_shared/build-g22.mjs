#!/usr/bin/env node
/* =====================================================================
 * GAMES-22 试点重构生成器：tap-burst(§7) + lane-runner(§9) 各 5 档共 10 款，
 * 从手搓 canvas 引擎迁移到 Phaser 3.90（games/_shared/phaser.min.js 本地副本）。
 * 产物形态（§5.1 自包含铁律不变——server 对 /games/_* 404，无相对引用可能，
 * 故 phaser.min.js 构建期内联进单文件 index.html；体积软上限 200KB 由本单豁免，
 * 见 GAMES-22 REPORT"体积取舍"）：
 *   <script> ① CONFIG（本款 game.json 数值同源内联）
 *   <script> ② phaser.min.js（Phaser 3.90.0，sha256 e92ddef1… 唯一本地副本）
 *   <script> ③ engine.js（GE 基座）+ engines/<type>.js（逻辑，纯 JS）+ engines/<type>.scene.js（Phaser 表现层）
 *   <script> ④ GE.boot(CONFIG, <Type>Scene)
 * game.json 数值/档位冻结不动，仅 version 1.0.0 → 2.0.0（引擎重写标记，幂等）。
 * 重跑幂等：只覆盖本清单 10 目录。node games/_shared/build-g22.mjs
 * ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

/* 试点清单（slug → 场景类；数值一律读各目录现有 game.json，不在本脚本复写） */
const TYPES = {
  'tap-burst': { sceneVar: 'TapBurstScene', title: 'tap-burst' },
  'lane-runner': { sceneVar: 'LaneRunnerScene', title: 'lane-runner' },
}

const phaserSrc = await readFile(join(SHARED, 'phaser.min.js'), 'utf8')
const engineSrc = await readFile(join(SHARED, 'engine.js'), 'utf8')

function pageHtml(meta, logicSrc, sceneSrc, sceneVar) {
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
  #game { position: fixed; inset: 0; }
  canvas { display: block; touch-action: none; }
</style>
</head>
<body>
<div id="game"></div>
<script>
/* 本款数值（与同目录 game.json 同源——GAMES-22 build-g22.mjs；引擎零网络请求，离线可玩） */
const CONFIG = ${JSON.stringify(meta, null, 2)};
</script>
<script>
/* Phaser 3.90.0（本地副本 games/_shared/phaser.min.js，构建期内联；上游 npm phaser@3.90.0） */
${phaserSrc}
</script>
<script>
${engineSrc}
${logicSrc}
${sceneSrc}
</script>
<script>
GE.boot(CONFIG, { play: ${sceneVar} });
</script>
</body>
</html>
`
}

let count = 0
for (const [type, def] of Object.entries(TYPES)) {
  const logicSrc = await readFile(join(SHARED, 'engines', `${type}.js`), 'utf8')
  const sceneSrc = await readFile(join(SHARED, 'engines', `${type}.scene.js`), 'utf8')
  for (let i = 1; i <= 5; i++) {
    const slugDir = join(GAMES, type)
    const dirs = []
    const { readdir } = await import('node:fs/promises')
    for (const d of await readdir(slugDir, { withFileTypes: true })) if (d.isDirectory()) dirs.push(d.name)
    const slug = dirs.sort().find((d) => d.endsWith(String(i).padStart(2, '0')))
    const dir = join(slugDir, slug)
    const meta = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
    /* version 升 2.0.0（引擎重写标记，幂等）——其余字段全部冻结不动 */
    if (meta.version !== '2.0.0') {
      meta.version = '2.0.0'
      await writeFile(join(dir, 'game.json'), JSON.stringify(meta, null, 2) + '\n')
    }
    await writeFile(join(dir, 'index.html'), pageHtml(meta, logicSrc, sceneSrc, def.sceneVar))
    count++
    console.log(`  ${slug} → Phaser index.html (${(phaserSrc.length / 1024).toFixed(0)}KB engine inline)`)
  }
}
console.log(`GAMES-22 build done: ${count} games`)
