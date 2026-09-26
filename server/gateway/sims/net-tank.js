/* =====================================================================
 * net-tank 服务端 sim 适配器（GAMES-40）——把 games/multiplayer/net-tank/sim.cjs
 * （与客户端内联的同一份确定性模拟，单一事实源）适配进网关 sims 注册表。
 * 新联机游戏接入：复制本文件改 require 路径与 url，并在 index.js register。
 * ===================================================================== */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const NTSim = require('../../../games/multiplayer/net-tank/sim.cjs')

export const netTankSim = {
  META: NTSim.META,
  LEVELS: NTSim.LEVELS,
  url: '/games/multiplayer/net-tank/index.html',
  create: (seed, opts) => NTSim.create(seed, opts),
  step: (state, inputs) => NTSim.step(state, inputs),
  serialize: NTSim.serialize,
  deserialize: NTSim.deserialize,
  brain: (state, seat, level, rng) => NTSim.brain(state, seat, level, rng),
  fnv1a32: NTSim.fnv1a32,
  mulberry32: NTSim.mulberry32,
}
