#!/usr/bin/env node
/* GAMES-24 基准构建：把 src/ 的规则层/度量层/各引擎接线层组装成 bench/out/*.html。
 * 零依赖（node:http 之外的运行时依赖为零），产物页面引用 ../vendor/*.min.js（不内联，
 * 冷启动测量仍含 vendor 的抓取+解析；跨页面共享缓存，与"平台共享 vendor"的部署口径一致）。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src'), OUT = join(ROOT, 'out')
mkdirSync(OUT, { recursive: true })

const read = (f) => readFileSync(join(SRC, f), 'utf8')
const SHELL_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#05070b;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,"PingFang SC","Noto Sans SC",sans-serif;overflow:hidden}
#stage{position:relative;width:375px;height:667px;background:#10141d;overflow:hidden}
#cv{position:absolute;inset:0;display:block;touch-action:none}
#hud{position:absolute;top:0;left:0;right:0;height:48px;display:flex;align-items:center;justify-content:center;
  color:#cfd8e3;font-size:13px;letter-spacing:.02em;background:linear-gradient(#141926,#10141d);
  border-bottom:1px solid #1f2735;user-select:none;pointer-events:none;z-index:2;white-space:nowrap}
`

const TARGETS = [
  { name: 'native-tap',     engine: 'native',  game: 'tap',    vendor: null },
  { name: 'native-runner',  engine: 'native',  game: 'runner', vendor: null },
  { name: 'phaser3-tap',    engine: 'phaser3', game: 'tap',    vendor: '../vendor/phaser3.min.js', glue: 'glue-phaser.js' },
  { name: 'phaser3-runner', engine: 'phaser3', game: 'runner', vendor: '../vendor/phaser3.min.js', glue: 'glue-phaser.js' },
  { name: 'phaser4-tap',    engine: 'phaser4', game: 'tap',    vendor: '../vendor/phaser4.min.js', glue: 'glue-phaser.js' },
  { name: 'phaser4-runner', engine: 'phaser4', game: 'runner', vendor: '../vendor/phaser4.min.js', glue: 'glue-phaser.js' },
  { name: 'pixi8-tap',      engine: 'pixi8',   game: 'tap',    vendor: '../vendor/pixi8.min.js', glue: 'glue-pixi.js' },
  { name: 'pixi8-runner',   engine: 'pixi8',   game: 'runner', vendor: '../vendor/pixi8.min.js', glue: 'glue-pixi.js' },
]

const METRICS = read('metrics.js'), RULES = read('rules.js')
const GLUE = { native: read('glue-native.js'), phaser: read('glue-phaser.js'), pixi: read('glue-pixi.js') }

const sizeTable = []
for (const t of TARGETS) {
  const glueKey = t.engine === 'native' ? 'native' : (t.engine === 'pixi8' ? 'pixi' : 'phaser')
  const glue = GLUE[glueKey]
  const vendorTag = t.vendor ? `<script src="${t.vendor}"></script>\n` : ''
  const html = `<!doctype html>
<html lang="zh" data-engine="${t.engine}" data-game="${t.game}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bench:${t.name}</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div id="stage"><canvas id="cv"></canvas><div id="hud">loading…</div></div>
${vendorTag}<script>
${METRICS}
</script>
<script>
${RULES}
</script>
<script>
${glue}
</script>
</body>
</html>
`
  writeFileSync(join(OUT, `${t.name}.html`), html)
  /* 自有代码体积（不含 vendor）：三次内联去重后口径 = metrics+rules+glue+css+骨架 */
  const own = Buffer.byteLength(html) - (t.vendor ? Buffer.byteLength(vendorTag) : 0)
  const glueLines = glue.split('\n').length, rulesLines = RULES.split('\n').length
  sizeTable.push({
    name: t.name, engine: t.engine, game: t.game,
    vendor: t.vendor ? t.vendor.split('/').pop() : '—',
    ownBytes: own, ownGzip: gzipSync(Buffer.from(html)).length,
    glueLines, sharedLines: rulesLines,
  })
}

console.log('built → bench/out/')
const pad = (s, n) => String(s).padEnd(n)
console.log(`${pad('page', 16)}${pad('engine', 9)}${pad('vendor', 16)}${pad('own KB', 8)}${pad('own gzip', 10)}${pad('glue LOC', 10)}shared LOC`)
for (const r of sizeTable) {
  console.log(`${pad(r.name, 16)}${pad(r.engine, 9)}${pad(r.vendor, 16)}${pad((r.ownBytes / 1024).toFixed(1), 8)}${pad((r.ownGzip / 1024).toFixed(1), 10)}${pad(r.glueLines, 10)}${r.sharedLines}`)
}
writeFileSync(join(ROOT, 'sizes.json'), JSON.stringify(sizeTable, null, 2))
