/* =====================================================================
 * slg-battlefield 服务端 sim 适配器（GAMES-43）——把
 * games/multiplayer/slg-battlefield/sim.cjs（与客户端内联的同一份确定性
 * 模拟，单一事实源）适配进网关 sims 注册表。
 * 接入口径同 net-tank：复制适配器改 require 路径与 url，并在 index.js register。
 * ===================================================================== */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SLG = require('../../../games/multiplayer/slg-battlefield/sim.cjs')

export const slgBattlefieldSim = {
  META: SLG.META,
  LEVELS: SLG.LEVELS,
  url: '/games/multiplayer/slg-battlefield/index.html',
  create: (seed, opts) => SLG.create(seed, opts),
  step: (state, inputs) => SLG.step(state, inputs),
  serialize: SLG.serialize,
  deserialize: SLG.deserialize,
  brain: (state, seat, level, rng) => SLG.brain(state, seat, level, rng),
  fnv1a32: SLG.fnv1a32,
  mulberry32: SLG.mulberry32,
}
