#!/usr/bin/env node
/* =====================================================================
 * GAMES-21 量产D 生成器：6 类型（match3/slide-merge/water-sort/chain-shot/mini-td/rhythm-tap）
 * × 5 档 = 30 款。每类一套引擎源码（engines/*.js）+ 公共框架（common.js），
 * 本脚本把引擎与该款 game.json 数值内联进自包含 index.html（§5.1：零外部请求、离线可玩）。
 * 档位落值 = spec v1.1.0 各类型节档位表（优先于 §3.1 乘子）；
 * 序号映射（§31 投放顺序）：01=normal（基准）→ 02=relaxed → 03=simple → 04=hard → 05=master。
 * 重跑幂等：只覆盖本清单 30 目录。node games/_shared/build.mjs
 * ===================================================================== */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

/* 序号 → 档位（§31：normal 先定基准手感，再投两端） */
const TIER_ORDER = ['normal', 'relaxed', 'simple', 'hard', 'master']

/* 类型清单：公共字段 + typeExtra 五档落值（spec §11/§12/§24/§27/§29/§30 档位表逐值） */
const TYPES = {
  'match3': {
    title: '甜趣三消', root: 'candy', levels: 50, avg: 150, controls: { primary: 'swipe-any' },
    desc: '8×8 棋盘滑动交换，同色三连消除，步数内冲目标分',
    scoring: { win: '步数耗尽前 score ≥ target(L)', lose: '步数耗尽未达标', s2: 'target(L)×1.2', s3: 'target(L)×1.5' },
    extra: {
      relaxed: { gridN: 8, colors: 4, movesBase: 35, targetScore: 1500, blockerRate: 0, cascadeCap: 5 },
      simple: { gridN: 8, colors: 5, movesBase: 30, targetScore: 1800, blockerRate: 0, cascadeCap: 5 },
      normal: { gridN: 8, colors: 5, movesBase: 25, targetScore: 2000, blockerRate: 0.05, cascadeCap: 5 },
      hard: { gridN: 8, colors: 6, movesBase: 21, targetScore: 2400, blockerRate: 0.10, cascadeCap: 5 },
      master: { gridN: 8, colors: 7, movesBase: 17, targetScore: 2900, blockerRate: 0.15, cascadeCap: 5 },
    },
  },
  'slide-merge': {
    title: '数字滑合', root: 'tile', levels: 25, avg: 150, controls: { primary: 'swipe-any' },
    desc: '2048 式四向滑动合并，合成当关目标数字块即胜',
    scoring: { win: '盘面出现 ≥ target(L) 的块', lose: '无可合并且 rescue 耗尽', s2: 'target(L)×2', s3: 'target(L)×3' },
    extra: {
      relaxed: { gridLen: 5, targetCap: 256, spawn4Rate: 0.05, rescue: 5 },
      simple: { gridLen: 5, targetCap: 512, spawn4Rate: 0.08, rescue: 4 },
      normal: { gridLen: 4, targetCap: 1024, spawn4Rate: 0.10, rescue: 3 },
      hard: { gridLen: 4, targetCap: 2048, spawn4Rate: 0.14, rescue: 2 },
      master: { gridLen: 4, targetCap: 4096, spawn4Rate: 0.18, rescue: 1 },
    },
  },
  'water-sort': {
    title: '清澄水序', root: 'aqua', levels: 40, avg: 210, controls: { primary: 'tap' },
    desc: '点源管再点目标管倾倒，把每色水归拢成整管',
    scoring: { win: '全部颜色各自归拢为整管', lose: '步数耗尽', s2: 'used ≤ 0.80×moves(L)', s3: 'used ≤ 0.65×moves(L)' },
    extra: {
      relaxed: { colorsBase: 3, colorsCap: 6, tubeCap: 4, emptyTubes: 3, moveFactor: 2.8 },
      simple: { colorsBase: 4, colorsCap: 8, tubeCap: 4, emptyTubes: 2, moveFactor: 2.5 },
      normal: { colorsBase: 5, colorsCap: 10, tubeCap: 4, emptyTubes: 2, moveFactor: 2.2 },
      hard: { colorsBase: 6, colorsCap: 12, tubeCap: 4, emptyTubes: 1, moveFactor: 1.9 },
      master: { colorsBase: 7, colorsCap: 14, tubeCap: 4, emptyTubes: 1, moveFactor: 1.6 },
    },
  },
  'chain-shot': {
    title: '珠链环消', root: 'orbit', levels: 30, avg: 165, controls: { primary: 'tap' },
    desc: '射珠入链同色三连消除，清空珠链；首珠入洞即败',
    scoring: { win: '清空珠链', lose: '珠链首珠到达洞口', s2: 'balls(L)×12', s3: 'balls(L)×15' },
    extra: {
      relaxed: { chainSpeed: 21, colors: 3, totalBalls: 30, swap: 999, trackLen: 1200 },
      simple: { chainSpeed: 26, colors: 4, totalBalls: 36, swap: 999, trackLen: 1200 },
      normal: { chainSpeed: 30, colors: 4, totalBalls: 40, swap: 5, trackLen: 1200 },
      hard: { chainSpeed: 38, colors: 5, totalBalls: 48, swap: 3, trackLen: 1200 },
      master: { chainSpeed: 45, colors: 6, totalBalls: 58, swap: 0, trackLen: 1200 },
    },
  },
  'mini-td': {
    title: '路口守卫', root: 'guard', levels: 30, avg: 300, controls: { primary: 'tap' },
    desc: '点空位建塔自动索敌，守住波次；漏怪耗基地命',
    scoring: { win: '撑过 waves(L) 波', lose: '基地命耗尽', s2: '12×enemies(L)', s3: '15×enemies(L)' },
    extra: {
      relaxed: { gold0: 168, livesBase: 14, enemyHP: 7, waveSize: 6, wavesCap: 8, enemySpeed: 28, slots: 12 },
      simple: { gold0: 144, livesBase: 12, enemyHP: 9, waveSize: 7, wavesCap: 9, enemySpeed: 34, slots: 12 },
      normal: { gold0: 120, livesBase: 10, enemyHP: 10, waveSize: 8, wavesCap: 10, enemySpeed: 40, slots: 12 },
      hard: { gold0: 102, livesBase: 8, enemyHP: 13, waveSize: 10, wavesCap: 12, enemySpeed: 50, slots: 12 },
      master: { gold0: 84, livesBase: 7, enemyHP: 15, waveSize: 12, wavesCap: 15, enemySpeed: 60, slots: 12 },
    },
  },
  'rhythm-tap': {
    title: '律动四轨', root: 'beat', levels: 30, avg: 120, controls: { primary: 'tap-zone' },
    desc: '四轨音符下落，到判定线点对应轨区，按精度计分',
    scoring: { win: '谱面走完且 life > 0', lose: 'life 耗尽', s2: '80×notes(L)', s3: '92×notes(L)' },
    extra: {
      relaxed: { bpm: 70, density: 0.84, notesBase: 45, perfectMs: 70, life: 10 },
      simple: { bpm: 85, density: 1.02, notesBase: 54, perfectMs: 60, life: 8 },
      normal: { bpm: 100, density: 1.20, notesBase: 60, perfectMs: 50, life: 6 },
      hard: { bpm: 125, density: 1.50, notesBase: 72, perfectMs: 40, life: 5 },
      master: { bpm: 150, density: 1.74, notesBase: 87, perfectMs: 35, life: 4 },
    },
  },
}

const TIER_CN = { relaxed: '轻松', simple: '简单', normal: '标准', hard: '困难', master: '大师' }
const ENGINE_VAR = {
  'match3': 'Match3Engine', 'slide-merge': 'SlideMergeEngine', 'water-sort': 'WaterSortEngine',
  'chain-shot': 'ChainShotEngine', 'mini-td': 'MiniTDEngine', 'rhythm-tap': 'RhythmTapEngine',
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
/* 本款数值（与同目录 game.json 同源生成——GAMES-21 build.mjs；引擎零网络请求，离线可玩） */
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
