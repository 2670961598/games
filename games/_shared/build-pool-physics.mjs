/* =====================================================================
 * pool-physics 单文件构建器（GAMES-78）——内联 trig16.cjs + sim.cjs +
 * _shared/net.js + client.js 进自包含 index.html（§5.1 铁律：server 对
 * /games/_* 一律 404；游戏页零外链、离线可玩降级练习）。
 * 重跑幂等：node games/_shared/build-pool-physics.mjs
 * ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const DIR = join(SHARED, '..', 'multiplayer', 'pool-physics')

const [trig, sim, net, client] = await Promise.all([
  readFile(join(DIR, 'trig16.cjs'), 'utf8'),
  readFile(join(DIR, 'sim.cjs'), 'utf8'),
  readFile(join(SHARED, 'net.js'), 'utf8'),
  readFile(join(DIR, 'client.js'), 'utf8'),
])

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">
<title>八球台球</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #0d1117; touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { display: block; touch-action: none; }
  #wrap { position: relative; }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    flex-direction: column; gap: 12px; background: rgba(13,17,23,.88); z-index: 10; }
  #joining { color: #e8ecf3; font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  #joining button { margin-top: 10px; padding: 9px 30px; border-radius: 999px; border: 0; background: #1F7A4D;
    color: #fff; font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rbox { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 300px; }
  .rtitle { font: 700 30px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rsub { color: #8b93a7; font: 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rtable { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 8px 4px;
    background: rgba(255,255,255,.04); border-radius: 8px; }
  .rrow { display: flex; justify-content: space-between; font: 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; color: #8b93a7; padding: 0 8px; }
  .rrow b { font-weight: 600; }
  .rbox button { padding: 9px 30px; border-radius: 999px; border: 0; background: #1F7A4D; color: #fff;
    font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rbox button.ghost { background: transparent; border: 1px solid rgba(255,255,255,.2); color: #8b93a7; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="cv"></canvas>
  <div id="joining" class="overlay">正在加入对局…<button onclick="location.reload()">重试</button></div>
  <div id="result" class="overlay"></div>
</div>
<script>
${trig}
</script>
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
console.log(`pool-physics index.html built: ${kb}KB (trig ${trig.length / 1024 | 0}K + sim ${sim.length / 1024 | 0}K + net ${net.length / 1024 | 0}K + client ${client.length / 1024 | 0}K)`)
