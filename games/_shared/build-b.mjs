#!/usr/bin/env node
/* =====================================================================
 * GAMES-19 量产B 生成器：6 类型（lane-runner/stacker/snake/fruit-slice/
 * block-drop/maze-dash，滑动街机系）× 5 档 = 30 款。
 * 每类一套引擎源码（engines/<type>.js）+ 公共框架（common.js，与量产C/D同源字节一致，
 * blob 72d9a77a），本脚本把引擎与该款 game.json 数值内联进自包含 index.html
 * （§5.1：零外部请求、离线可玩）。
 * 档位落值 = spec v1.1.0 各类型节档位表（优先于 §3.1 乘子）；
 * 序号映射（§31 投放顺序）：01=normal（基准）→ 02=relaxed → 03=simple → 04=hard → 05=master。
 * 重跑幂等：只覆盖本清单 30 目录。node games/_shared/build-b.mjs
 * ===================================================================== */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

/* 序号 → 档位（§31：normal 先定基准手感，再投两端） */
const TIER_ORDER = ['normal', 'relaxed', 'simple', 'hard', 'master']

/* 类型清单：公共字段 + typeExtra 五档落值（spec §9/§10/§13/§23/§25/§28 档位表逐值） */
const TYPES = {
  'lane-runner': {
    title: '三轨狂飙', root: 'dash', levels: 40, avg: 240,
    controls: { primary: 'swipe-lr', secondary: 'swipe-any' },
    desc: '三车道向前狂飙，左右滑换道、上滑跳越障碍吃金币，跑到终点即胜',
    scoring: { win: '抵达终点 distance(L)', lose: 'hearts 耗尽', s2: 'coinTarget(L)×24', s3: 'coinTarget(L)×30' },
    extra: {
      relaxed: { speed: 210, obsRate: 0.21, hearts: 5, coinRate: 0.10, distanceBase: 1800 },
      simple: { speed: 255, obsRate: 0.26, hearts: 4, coinRate: 0.10, distanceBase: 1900 },
      normal: { speed: 300, obsRate: 0.30, hearts: 3, coinRate: 0.10, distanceBase: 2000 },
      hard: { speed: 375, obsRate: 0.38, hearts: 2, coinRate: 0.10, distanceBase: 2500 },
      master: { speed: 450, obsRate: 0.45, hearts: 1, coinRate: 0.10, distanceBase: 2900 },
    },
  },
  'stacker': {
    title: '静心叠塔', root: 'calm', levels: 30, avg: 180,
    controls: { primary: 'tap' },
    desc: '方块左右摆动，点按落块逐层上叠，完美对齐回涨宽度，塔高达标即胜',
    scoring: { win: '塔高 ≥ target(L)', lose: 'missMax 耗尽或裁后块宽 < trimMin', s2: 'target(L)×12', s3: 'target(L)×15' },
    extra: {
      relaxed: { blockW0: 300, swingBase: 112, swingK: 0.80, trimMin: 12, missMax: 7, targetBase: 14 },
      simple: { blockW0: 260, swingBase: 136, swingK: 0.80, trimMin: 12, missMax: 6, targetBase: 16 },
      normal: { blockW0: 220, swingBase: 160, swingK: 0.80, trimMin: 12, missMax: 5, targetBase: 18 },
      hard: { blockW0: 187, swingBase: 200, swingK: 0.80, trimMin: 12, missMax: 4, targetBase: 23 },
      master: { blockW0: 154, swingBase: 240, swingK: 0.80, trimMin: 12, missMax: 3, targetBase: 26 },
    },
  },
  'snake': {
    title: '贪吃灵蛇', root: 'meander', levels: 30, avg: 180,
    controls: { primary: 'swipe-any' },
    desc: '滑动转向的网格贪吃蛇，吃食物长身体，避开石块撞界，长度达标即胜',
    scoring: { win: '长度 ≥ targetLen(L)', lose: '撞身/撞石/撞墙(solid)', s2: '24×targetLen(L)', s3: '30×targetLen(L)' },
    extra: {
      relaxed: { speed: 4.2, targetLenBase: 11, obstacleBase: 4, wall: 'wrap' },
      simple: { speed: 5.1, targetLenBase: 13, obstacleBase: 6, wall: 'wrap' },
      normal: { speed: 6.0, targetLenBase: 15, obstacleBase: 8, wall: 'wrap' },
      hard: { speed: 7.5, targetLenBase: 19, obstacleBase: 10, wall: 'solid' },
      master: { speed: 9.0, targetLenBase: 22, obstacleBase: 12, wall: 'solid' },
    },
  },
  'fruit-slice': {
    title: '快刀切果', root: 'blade', levels: 40, avg: 300,
    controls: { primary: 'swipe-any' },
    desc: '水果抛物线飞出，单指划线切割，60 秒内切够目标数，小心炸弹与漏果',
    scoring: { win: '60s 内切果 ≥ target(L)', lose: 'missMax 或 lives 耗尽/超时', s2: 'target(L)×12', s3: 'target(L)×15' },
    extra: {
      relaxed: { targetBase: 19, spawnRate: 1.00, flySpeed: 364, bombRate: 0.08, missMax: 7, lives: 5 },
      simple: { targetBase: 23, spawnRate: 1.20, flySpeed: 442, bombRate: 0.10, missMax: 6, lives: 4 },
      normal: { targetBase: 25, spawnRate: 1.40, flySpeed: 520, bombRate: 0.12, missMax: 5, lives: 3 },
      hard: { targetBase: 31, spawnRate: 1.75, flySpeed: 650, bombRate: 0.15, missMax: 4, lives: 2 },
      master: { targetBase: 36, spawnRate: 2.10, flySpeed: 780, bombRate: 0.18, missMax: 3, lives: 2 },
    },
  },
  'block-drop': {
    title: '落块消行', root: 'cascade', levels: 30, avg: 300,
    controls: { primary: 'swipe-any', secondary: 'tap' },
    desc: '滑动操作的方块下落：左右移、上滑/点按旋转、下滑软降、快滑硬降，消行达标即胜',
    scoring: { win: '消行 ≥ lines(L)', lose: '堆顶（新块无处生成）', s2: '150×lines(L)', s3: '220×lines(L)' },
    extra: {
      relaxed: { dropMs: 1120, wellW: 10, garbageBase: 2, nextN: 3, linesFactor: 0.75 },
      simple: { dropMs: 960, wellW: 10, garbageBase: 3, nextN: 3, linesFactor: 0.90 },
      normal: { dropMs: 800, wellW: 10, garbageBase: 4, nextN: 3, linesFactor: 1.00 },
      hard: { dropMs: 640, wellW: 10, garbageBase: 5, nextN: 2, linesFactor: 1.20 },
      master: { dropMs: 480, wellW: 10, garbageBase: 6, nextN: 1, linesFactor: 1.45 },
    },
  },
  'maze-dash': {
    title: '迷宫冲刺', root: 'hedge', levels: 30, avg: 150,
    controls: { primary: 'swipe-any' },
    desc: '程序生成完美迷宫，滑动定向冲刺到岔口，限时集齐钥匙抵达出口，后段带迷雾',
    scoring: { win: '集齐钥匙到达出口', lose: '超时', s2: '12×time(L)', s3: '15×time(L)' },
    extra: {
      relaxed: { sizeN: 9, timeFactor: 2.4, speed: 4.0, keysCap: 1, fogR: 0 },
      simple: { sizeN: 11, timeFactor: 2.0, speed: 4.0, keysCap: 2, fogR: 0 },
      normal: { sizeN: 11, timeFactor: 1.7, speed: 4.0, keysCap: 2, fogR: 0 },
      hard: { sizeN: 13, timeFactor: 1.4, speed: 4.0, keysCap: 3, fogR: 5 },
      master: { sizeN: 15, timeFactor: 1.2, speed: 4.0, keysCap: 3, fogR: 4 },
    },
  },
}

const TIER_CN = { relaxed: '轻松', simple: '简单', normal: '标准', hard: '困难', master: '大师' }
const ENGINE_VAR = {
  'lane-runner': 'LaneRunnerEngine', 'stacker': 'StackerEngine', 'snake': 'SnakeEngine',
  'fruit-slice': 'FruitSliceEngine', 'block-drop': 'BlockDropEngine', 'maze-dash': 'MazeDashEngine',
}

const commonSrc = await readFile(join(SHARED, 'common.js'), 'utf8')

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
/* 本款数值（与同目录 game.json 同源生成——GAMES-19 build-b.mjs；引擎零网络请求，离线可玩） */
const CONFIG = ${JSON.stringify(meta, null, 2)};
</script>
<script>
${commonSrc}
</script>
<script>
${engineSrc}
</script>
<script>
G.boot(CONFIG, ${engineVar});
</script>
</body>
</html>
`
}

let count = 0
for (const [type, def] of Object.entries(TYPES)) {
  const engineSrc = await readFile(join(SHARED, 'engines', `${type}.js`), 'utf8')
  for (let i = 0; i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i]
    const no = String(i + 1).padStart(2, '0')
    const slug = `${type}-${def.root}-${no}`
    const meta = {
      slug, title: `${def.title} ${no}`, type, tier,
      levels: def.levels, specVersion: '1.1.0', version: '1.0.0',
      orientation: 'portrait', entry: 'index.html', controls: def.controls,
      avgDurationSec: def.avg, scoring: def.scoring,
      description: `${def.desc}（${TIER_CN[tier]}档）`,
      typeExtra: def.extra[tier],
    }
    const dir = join(GAMES, type, slug)
    await mkdir(dir, { recursive: true })
    // 双写同源：game.json 供平台 scan，CONFIG 供引擎运行
    await writeFile(join(dir, 'game.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
    await writeFile(join(dir, 'index.html'), pageHtml(meta, engineSrc, ENGINE_VAR[type]), 'utf8')
    console.log(`${type}/${slug}  tier=${tier}`)
    count++
  }
}
console.log(`\n共 ${count} 款生成完毕（重跑幂等，仅覆盖本清单目录）`)
