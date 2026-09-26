/* =====================================================================
 * slg-battlefield 服务端 sim 适配器（GAMES-43）——把
 * games/multiplayer/slg-battlefield/sim.cjs（与客户端内联的同一份确定性
 * 模拟，单一事实源）适配进网关 sims 注册表。
 * 接入口径同 net-tank：复制适配器改 require 路径与 url，并在 index.js register。
 *
 * GAMES-46：启动时读 game.json net.botTuning（猎杀让力阈值/收力档、陪玩
 * 接管时延）注入 sim——game.json 是可调事实源，sim.cjs 内置同值默认兜底
 * （离线端无读取链路时行为一致）。仅影响 Bot 决策（服务端侧），判定路径
 * 与确定性红线不受影响。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SLG = require('../../../games/multiplayer/slg-battlefield/sim.cjs')

try {
  const gameJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../../games/multiplayer/slg-battlefield/game.json', import.meta.url)), 'utf8'))
  const tuning = gameJson.net && gameJson.net.botTuning
  if (tuning) SLG.setBotTuning(tuning)
} catch (err) {
  // game.json 缺失/畸形：维持 sim 内置默认（不阻断网关启动）
  console.error(JSON.stringify({ k: 'slg-tuning-load-failed', error: String(err && err.message || err) }))
}

export const slgBattlefieldSim = {
  META: SLG.META,
  LEVELS: SLG.LEVELS,
  url: '/games/multiplayer/slg-battlefield/index.html',
  create: (seed, opts) => SLG.create(seed, opts),
  step: (state, inputs) => SLG.step(state, inputs),
  serialize: SLG.serialize,
  deserialize: SLG.deserialize,
  brain: (state, seat, level, rng, env) => SLG.brain(state, seat, level, rng, env),
  fnv1a32: SLG.fnv1a32,
  mulberry32: SLG.mulberry32,
}
