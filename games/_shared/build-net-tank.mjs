/* =====================================================================
 * net-tank 单文件构建器（GAMES-40）——内联 sim.cjs + _shared/net.js + client.js
 * 进自包含 index.html（§5.1 铁律：server 对 /games/_* 一律 404，无相对引用可能；
 * 联机 SDK 同样内联，游戏页零外链、离线可玩（网关不可达时自动降级离线练习））。
 * 重跑幂等：node games/_shared/build-net-tank.mjs
 * ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const DIR = join(SHARED, '..', 'multiplayer', 'net-tank')

const [sim, net, client] = await Promise.all([
  readFile(join(DIR, 'sim.cjs'), 'utf8'),
  readFile(join(SHARED, 'net.js'), 'utf8'),
  readFile(join(DIR, 'client.js'), 'utf8'),
])

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">
<title>净斗坦克</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #0b0e14; touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { display: block; touch-action: none; }
  #wrap { position: relative; }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    flex-direction: column; gap: 14px; background: rgba(11,14,20,.72); z-index: 10; }
  #joining { color: #e8ecf3; font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  #banner { display: none; position: absolute; top: 46px; left: 0; right: 0; text-align: center;
    color: #fbbf24; font: 12px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; z-index: 9; }
  .rbox { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .rtitle { color: #e8ecf3; font: 700 30px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rsub { color: #8b93a7; font: 14px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rbox button { padding: 10px 34px; border-radius: 999px; border: 0; background: #2563eb; color: #fff;
    font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rbox button.ghost { background: transparent; border: 1px solid rgba(255,255,255,.2); color: #8b93a7; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="cv"></canvas>
  <div id="banner"></div>
  <div id="joining" class="overlay">正在加入对局…</div>
  <div id="result" class="overlay"></div>
</div>
<script>
${sim}
</script>
<script>
${net}
</script>
<script>
${client}
</script>
</body>
</html>
`

await writeFile(join(DIR, 'index.html'), html)
const { statSync } = await import('node:fs')
const kb = (statSync(join(DIR, 'index.html')).size / 1024).toFixed(1)
console.log(`net-tank index.html built: ${kb}KB (sim ${sim.length / 1024 | 0}K + net ${net.length / 1024 | 0}K + client ${client.length / 1024 | 0}K)`)
