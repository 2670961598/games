/* =====================================================================
 * mmo-township 单文件构建器（GAMES-52）——内联 predict.cjs + _shared/net.js + client.js
 * 进自包含 index.html（§5.1 铁律：server 对 /games/_* 一律 404，无相对引用可能）。
 * 与 S1 构建器的关键差异：**无 sim 段**——S2 状态同步 sim 仅服务端（客户端零判定），
 * 内联的三段=两端共享的移动预测纯函数 + 联机 SDK + 呈现层。
 * 重跑幂等：node games/_shared/build-mmo-township.mjs
 * ===================================================================== */
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const DIR = join(SHARED, '..', 'multiplayer', 'mmo-township')

const [predict, net, client] = await Promise.all([
  readFile(join(DIR, 'predict.cjs'), 'utf8'),
  readFile(join(SHARED, 'net.js'), 'utf8'),
  readFile(join(DIR, 'client.js'), 'utf8'),
])

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">
<title>星海小镇</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #0b1026; touch-action: none;
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { display: block; touch-action: none; }
  #wrap { position: relative; }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    flex-direction: column; gap: 12px; z-index: 10; }
  #joining { color: #e8ecf3; font: 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  #banner { display: none; position: absolute; top: 64px; left: 0; right: 0; text-align: center;
    color: #ffd700; font: 600 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; z-index: 9; }
  #settle { background: rgba(11,16,38,.78); }
  .sbox { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 280px;
    padding: 18px 16px; background: rgba(26,27,58,.92); border: 1px solid rgba(255,182,92,.35); border-radius: 14px; }
  .stitle { color: #ffd98e; font: 700 16px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
  .srank { width: 100%; display: flex; flex-direction: column; gap: 4px; }
  .srow { display: flex; justify-content: space-between; color: #8b93a7;
    font: 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; padding: 0 8px; }
  .srow b { color: #e8ecf3; font-weight: 600; }
  .srow.me { color: #ffd98e; }
  .sme { color: #e8ecf3; font: 13px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="cv"></canvas>
  <div id="banner"></div>
  <div id="joining" class="overlay">正在加入小镇…</div>
  <div id="settle" class="overlay"></div>
</div>
<script>
${predict}
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
console.log(`mmo-township index.html built: ${kb}KB (predict ${predict.length / 1024 | 0}K + net ${net.length / 1024 | 0}K + client ${client.length / 1024 | 0}K)`)
