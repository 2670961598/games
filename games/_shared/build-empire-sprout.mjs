/* =====================================================================
 * empire-sprout 单文件构建器（GAMES-68）——内联 sim.cjs + _shared/net.js + client.js
 * 进自包含 index.html（§5.1 铁律：server 对 /games/_* 一律 404，无相对引用可能；
 * 联机 SDK 同样内联，游戏页零外链、离线可玩（网关不可达时自动降级离线练习））。
 * 重跑幂等：node games/_shared/build-empire-sprout.mjs
 * ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const DIR = join(SHARED, '..', 'multiplayer', 'empire-sprout')

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
<title>帝国萌芽</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #171009; touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { display: block; touch-action: none; }
  #wrap { position: relative; }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    flex-direction: column; gap: 12px; background: rgba(23,16,9,.86); z-index: 10; }
  #joining { color: #e8ecf3; font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  #joining button { margin-top: 10px; padding: 9px 30px; border-radius: 999px; border: 0; background: #b3801f;
    color: #fff; font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  #banner { display: none; position: absolute; top: 66px; left: 0; right: 0; text-align: center;
    color: #fbbf24; font: 600 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; z-index: 9; }
  .rbox { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 300px; }
  .rtitle { font: 700 30px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rsub { color: #8b93a7; font: 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .rtable { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 8px 4px;
    background: rgba(255,255,255,.04); border-radius: 8px; }
  .rrow { display: flex; justify-content: space-between; font: 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; color: #8b93a7; padding: 0 8px; }
  .rrow b { font-weight: 600; }
  .rbox button { padding: 9px 30px; border-radius: 999px; border: 0; background: #b3801f; color: #fff;
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
console.log(`empire-sprout index.html built: ${kb}KB (sim ${sim.length / 1024 | 0}K + net ${net.length / 1024 | 0}K + client ${client.length / 1024 | 0}K)`)
