#!/usr/bin/env node
/* =====================================================================
 * GAMES-18 量产A 生成器：6 类型（tap-burst/tap-jump/mole-whack/memory-flip/
 * simon-sequence/color-reaction，点击反应系）× 5 档 = 30 款。
 * 每类一套引擎源码（engines/<type>.js）+ 公共框架（common.js，与量产B/C/D同源字节一致，
 * blob 72d9a77a），本脚本把引擎与该款 game.json 数值内联进自包含 index.html
 * （§5.1：零外部请求、离线可玩）。
 * 档位落值 = spec v1.1.0 各类型节档位表（优先于 §3.1 乘子）；
 * 序号映射（§31 投放顺序）：01=normal（基准）→ 02=relaxed → 03=simple → 04=hard → 05=master。
 * 重跑幂等：只覆盖本清单 30 目录。node games/_shared/build-a.mjs
 * ===================================================================== */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHARED = dirname(fileURLToPath(import.meta.url))
const GAMES = join(SHARED, '..')

/* 序号 → 档位（§31：normal 先定基准手感，再投两端） */
const TIER_ORDER = ['normal', 'relaxed', 'simple', 'hard', 'master']

/* 类型清单：公共字段 + typeExtra 五档落值（spec §7/§8/§19/§20/§21/§22 档位表逐值） */
const TYPES = {
  'tap-burst': {
    title: '狂点爆发', root: 'pop', levels: 30, avg: 240,
    controls: { primary: 'tap' },
    desc: '限时点够冒出的目标圆点，连击加分，小心红色陷阱叉点',
    scoring: { win: '时限内有效点击 ≥ target(L)', lose: '时限到未达标', s2: 'target(L)×12', s3: 'target(L)×15' },
    extra: {
      relaxed: { targetBase: 15, timeSec: 28, sizePx: 100, spawnPerSec: 1.10, decoyRate: 0.06 },
      simple: { targetBase: 17, timeSec: 24, sizePx: 86, spawnPerSec: 1.40, decoyRate: 0.07 },
      normal: { targetBase: 20, timeSec: 20, sizePx: 72, spawnPerSec: 1.60, decoyRate: 0.08 },
      hard: { targetBase: 25, timeSec: 17, sizePx: 61, spawnPerSec: 2.00, decoyRate: 0.10 },
      master: { targetBase: 30, timeSec: 14, sizePx: 50, spawnPerSec: 2.40, decoyRate: 0.12 },
    },
  },
  'tap-jump': {
    title: '飞翔跳跃', root: 'flap', levels: 40, avg: 300,
    controls: { primary: 'tap' },
    desc: '点按让小鸟上浮穿过管道，过障数达标即胜，触管触地即败、瞬时重开',
    scoring: { win: '过障数达到 target(L)', lose: '触管/触地（lives=1）', s2: 'target(L)×12', s3: 'target(L)×15' },
    extra: {
      relaxed: { gravity: 1260, tapImpulse: -364, pipeSpeed: 112, gapPx: 245, pipeInterval: 300 },
      simple: { gravity: 1530, tapImpulse: -442, pipeSpeed: 136, gapPx: 210, pipeInterval: 280 },
      normal: { gravity: 1800, tapImpulse: -520, pipeSpeed: 160, gapPx: 175, pipeInterval: 260 },
      hard: { gravity: 2250, tapImpulse: -650, pipeSpeed: 200, gapPx: 149, pipeInterval: 240 },
      master: { gravity: 2700, tapImpulse: -780, pipeSpeed: 240, gapPx: 123, pipeInterval: 220 },
    },
  },
  'mole-whack': {
    title: '地鼠快打', root: 'garden', levels: 30, avg: 270,
    controls: { primary: 'tap' },
    desc: '九窝地鼠冒头窗内点中得分，炸弹点了扣分耗命，30 秒内打够目标数',
    scoring: { win: '时限内命中 ≥ hitTarget(L)', lose: '时限到未达标或 lives 耗尽', s2: 'hitTarget(L)×12', s3: 'hitTarget(L)×15' },
    extra: {
      relaxed: { hitTarget: 15, timeSec: 30, popupMs: 1260, concurrent: 1, bombRate: 0.10, lives: 5 },
      simple: { hitTarget: 18, timeSec: 30, popupMs: 1080, concurrent: 2, bombRate: 0.13, lives: 4 },
      normal: { hitTarget: 20, timeSec: 30, popupMs: 900, concurrent: 2, bombRate: 0.15, lives: 3 },
      hard: { hitTarget: 25, timeSec: 30, popupMs: 770, concurrent: 3, bombRate: 0.19, lives: 2 },
      master: { hitTarget: 29, timeSec: 30, popupMs: 630, concurrent: 4, bombRate: 0.22, lives: 2 },
    },
  },
  'memory-flip': {
    title: '翻牌配对', root: 'pair', levels: 24, avg: 210,
    controls: { primary: 'tap' },
    desc: '入场预览后扣牌，两两翻开配对，误试步数上限内配平全部',
    scoring: { win: '步数内配平全部对', lose: '步数耗尽', s2: 'pairs(L)×36', s3: 'pairs(L)×45' },
    extra: {
      relaxed: { pairsBase: 6, pairsCap: 10, gridW: 4, peekMs: 2000, moveFactor: 3.2 },
      simple: { pairsBase: 8, pairsCap: 12, gridW: 4, peekMs: 1750, moveFactor: 2.8 },
      normal: { pairsBase: 8, pairsCap: 12, gridW: 4, peekMs: 1500, moveFactor: 2.5 },
      hard: { pairsBase: 10, pairsCap: 14, gridW: 5, peekMs: 1200, moveFactor: 2.0 },
      master: { pairsBase: 12, pairsCap: 16, gridW: 6, peekMs: 950, moveFactor: 1.6 },
    },
  },
  'simon-sequence': {
    title: '序列记忆', root: 'echo', levels: 20, avg: 180,
    controls: { primary: 'tap' },
    desc: '色块面板按序点亮，依序复述；序列答对逐级加长，答错耗尽重试即败',
    scoring: { win: '复述长度达到 targetLen(L)', lose: '答错且 retries 耗尽', s2: 'targetLen(L)×12', s3: 'targetLen(L)×15' },
    extra: {
      relaxed: { pads: 4, flashMs: 770, gapMs: 250, startLen: 3, targetLenCap: 12, retries: 2 },
      simple: { pads: 4, flashMs: 660, gapMs: 250, startLen: 3, targetLenCap: 13, retries: 1 },
      normal: { pads: 4, flashMs: 550, gapMs: 250, startLen: 3, targetLenCap: 15, retries: 1 },
      hard: { pads: 6, flashMs: 460, gapMs: 250, startLen: 3, targetLenCap: 18, retries: 0 },
      master: { pads: 9, flashMs: 380, gapMs: 250, startLen: 3, targetLenCap: 21, retries: 0 },
    },
  },
  'color-reaction': {
    title: '色词反应', root: 'stroop', levels: 30, avg: 240,
    controls: { primary: 'tap-zone' },
    desc: '大号颜色词配随机墨色，判断墨色与词义是否一致，点左（一致）或右（不一致）限时作答',
    scoring: { win: '完成 rounds(L) 且 maxMiss 未耗尽', lose: 'miss 耗尽', s2: 'rounds(L)×12', s3: 'rounds(L)×15' },
    extra: {
      relaxed: { roundsBase: 15, perRoundMs: 2100, agreeRate: 0.50, maxMiss: 5, trapSwitch: false },
      simple: { roundsBase: 18, perRoundMs: 1800, agreeRate: 0.50, maxMiss: 4, trapSwitch: false },
      normal: { roundsBase: 20, perRoundMs: 1500, agreeRate: 0.50, maxMiss: 3, trapSwitch: true },
      hard: { roundsBase: 24, perRoundMs: 1280, agreeRate: 0.50, maxMiss: 2, trapSwitch: true },
      master: { roundsBase: 29, perRoundMs: 1050, agreeRate: 0.50, maxMiss: 2, trapSwitch: true },
    },
  },
}

const TIER_CN = { relaxed: '轻松', simple: '简单', normal: '标准', hard: '困难', master: '大师' }
const ENGINE_VAR = {
  'tap-burst': 'TapBurstEngine', 'tap-jump': 'TapJumpEngine', 'mole-whack': 'MoleWhackEngine',
  'memory-flip': 'MemoryFlipEngine', 'simon-sequence': 'SimonSequenceEngine', 'color-reaction': 'ColorReactionEngine',
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
/* 本款数值（与同目录 game.json 同源生成——GAMES-18 build-a.mjs；引擎零网络请求，离线可玩） */
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
