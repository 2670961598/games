#!/usr/bin/env node
/* =====================================================================
 * GAMES-20 量产C 生成器：6 类型（breakout/paddle-pong/bullet-shmup/bullet-dodge/
 * drop-catcher/block-fit，拖动弹道系）× 5 档 = 30 款。
 * 每类一套引擎源码（engines/<type>.js）+ 公共框架（common.js，与量产D同源字节一致），
 * 本脚本把引擎与该款 game.json 数值内联进自包含 index.html（§5.1：零外部请求、离线可玩）。
 * 档位落值 = spec v1.1.0 各类型节档位表（优先于 §3.1 乘子）；
 * 序号映射（§31 投放顺序）：01=normal（基准）→ 02=relaxed → 03=simple → 04=hard → 05=master。
 * 重跑幂等：只覆盖本清单 30 目录。node games/_shared/build-c.mjs
 * ===================================================================== */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

/* 序号 → 档位（§31：normal 先定基准手感，再投两端） */
const TIER_ORDER = ['normal', 'relaxed', 'simple', 'hard', 'master']

/* 类型清单：公共字段 + typeExtra 五档落值（spec §14/§15/§16/§17/§18/§26 档位表逐值） */
const TYPES = {
  'breakout': {
    title: '弹珠清砖', root: 'brick', levels: 40, avg: 180, controls: { primary: 'drag' },
    desc: '拖板反弹弹珠清砖阵，清空即胜，弹珠落尽即败',
    scoring: { win: '砖阵清空', lose: 'balls 耗尽', s2: '12×bricks(L)', s3: '15×bricks(L)' },
    extra: {
      relaxed: { ballSpeed: 182, paddleW: 126, rowsCap: 6, brickHP: 1, balls: 5 },
      simple: { ballSpeed: 221, paddleW: 108, rowsCap: 7, brickHP: 1, balls: 4 },
      normal: { ballSpeed: 260, paddleW: 90, rowsCap: 8, brickHP: 1, balls: 3 },
      hard: { ballSpeed: 325, paddleW: 77, rowsCap: 9, brickHP: 2, balls: 3 },
      master: { ballSpeed: 390, paddleW: 63, rowsCap: 10, brickHP: 2, balls: 2 },
    },
  },
  'paddle-pong': {
    title: '挡板救球', root: 'rally', levels: 30, avg: 150, controls: { primary: 'drag' },
    desc: '底部挡板连续接住反弹下落球，坚持到目标时间',
    scoring: { win: '存活 goal(L) 秒', lose: 'missMax 耗尽', s2: 'goal(L)×12', s3: 'goal(L)×15' },
    extra: {
      relaxed: { goalSec: 63, ballSpeed: 154, maxBalls: 3, paddleW: 154, missMax: 5 },
      simple: { goalSec: 54, ballSpeed: 187, maxBalls: 3, paddleW: 132, missMax: 4 },
      normal: { goalSec: 45, ballSpeed: 220, maxBalls: 4, paddleW: 110, missMax: 3 },
      hard: { goalSec: 38, ballSpeed: 275, maxBalls: 5, paddleW: 94, missMax: 2 },
      master: { goalSec: 31, ballSpeed: 330, maxBalls: 6, paddleW: 77, missMax: 2 },
    },
  },
  'bullet-shmup': {
    title: '弹幕突围', root: 'raid', levels: 30, avg: 165, controls: { primary: 'drag' },
    desc: '竖版自动射击，拖动机体躲避弹幕清空敌波',
    scoring: { win: '清空 waves(L) 波', lose: 'lives 耗尽', s2: '12×enemies(L)', s3: '15×enemies(L)' },
    extra: {
      relaxed: { wavesCap: 8, enemyHP: 1, bulletSpeed: 140, density: 2, lives: 5, playerFireMs: 150 },
      simple: { wavesCap: 9, enemyHP: 2, bulletSpeed: 170, density: 2, lives: 4, playerFireMs: 150 },
      normal: { wavesCap: 10, enemyHP: 2, bulletSpeed: 200, density: 3, lives: 3, playerFireMs: 150 },
      hard: { wavesCap: 12, enemyHP: 3, bulletSpeed: 250, density: 4, lives: 2, playerFireMs: 150 },
      master: { wavesCap: 14, enemyHP: 4, bulletSpeed: 300, density: 5, lives: 1, playerFireMs: 150 },
    },
  },
  'bullet-dodge': {
    title: '弹雨穿行', root: 'weave', levels: 30, avg: 120, controls: { primary: 'drag', secondary: 'hold' },
    desc: '无攻击纯躲避，拖小点在弹雨中存活到目标时间，长按触发时缓',
    scoring: { win: '存活 goal(L) 秒', lose: '中弹（一命制）', s2: 'goal(L)×12', s3: 'goal(L)×15' },
    extra: {
      relaxed: { goalSec: 42, spawnRate: 1.26, projSpeed: 126, playerR: 20, slowCharges: 4 },
      simple: { goalSec: 36, spawnRate: 1.53, projSpeed: 153, playerR: 17, slowCharges: 3 },
      normal: { goalSec: 30, spawnRate: 1.80, projSpeed: 180, playerR: 14, slowCharges: 2 },
      hard: { goalSec: 24, spawnRate: 2.25, projSpeed: 225, playerR: 12, slowCharges: 1 },
      master: { goalSec: 18, spawnRate: 2.70, projSpeed: 270, playerR: 10, slowCharges: 1 },
    },
  },
  'drop-catcher': {
    title: '篮接天降', root: 'harvest', levels: 40, avg: 165, controls: { primary: 'drag' },
    desc: '顶部掉落好物与坏物，拖篮子接好物、躲坏物，接满目标数',
    scoring: { win: '接满 catchTarget(L)', lose: 'lives 耗尽', s2: 'catchTarget(L)×12', s3: 'catchTarget(L)×15' },
    extra: {
      relaxed: { catchTarget: 15, fallSpeed: 168, spawnRate: 1.10, badRate: 0.14, basketW: 154, lives: 5 },
      simple: { catchTarget: 18, fallSpeed: 204, spawnRate: 1.30, badRate: 0.17, basketW: 132, lives: 4 },
      normal: { catchTarget: 20, fallSpeed: 240, spawnRate: 1.50, badRate: 0.20, basketW: 110, lives: 3 },
      hard: { catchTarget: 25, fallSpeed: 300, spawnRate: 1.90, badRate: 0.25, basketW: 94, lives: 2 },
      master: { catchTarget: 29, fallSpeed: 360, spawnRate: 2.30, badRate: 0.29, basketW: 77, lives: 2 },
    },
  },
  'block-fit': {
    title: '方块拼填', root: 'mosaic', levels: 30, avg: 210, controls: { primary: 'drag' },
    desc: '10×10 无重力棋盘拖放形状块，放满整行整列即消除，达标分即胜',
    scoring: { win: 'score ≥ target(L)', lose: '三块均无处可放且 refresh 耗尽', s2: 'target(L)×1.2', s3: 'target(L)×1.5' },
    extra: {
      relaxed: { targetScore: 1500, pentRate: 0.05, obstacleStart: 0, piecesPerRound: 3, refresh: 1 },
      simple: { targetScore: 1800, pentRate: 0.08, obstacleStart: 0, piecesPerRound: 3, refresh: 1 },
      normal: { targetScore: 2000, pentRate: 0.12, obstacleStart: 0, piecesPerRound: 3, refresh: 0 },
      hard: { targetScore: 2400, pentRate: 0.16, obstacleStart: 2, piecesPerRound: 3, refresh: 0 },
      master: { targetScore: 2900, pentRate: 0.20, obstacleStart: 4, piecesPerRound: 3, refresh: 0 },
    },
  },
}

const TIER_CN = { relaxed: '轻松', simple: '简单', normal: '标准', hard: '困难', master: '大师' }
const ENGINE_VAR = {
  'breakout': 'BreakoutEngine', 'paddle-pong': 'PaddlePongEngine', 'bullet-shmup': 'BulletShmupEngine',
  'bullet-dodge': 'BulletDodgeEngine', 'drop-catcher': 'DropCatcherEngine', 'block-fit': 'BlockFitEngine',
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
/* 本款数值（与同目录 game.json 同源生成——GAMES-20 build-c.mjs；引擎零网络请求，离线可玩） */
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
