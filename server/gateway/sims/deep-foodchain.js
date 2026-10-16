/* =====================================================================
 * deep-foodchain 服务端 sim 适配器（GAMES-164 · S6 海量实体第二证）——把
 * games/multiplayer/deep-foodchain/sim.cjs（吞噬成长链+体型分级 AOI，单一事实源：
 * 两端同式纯函数在 games/multiplayer/deep-foodchain/shared.cjs）适配进网关 sims
 * 注册表。
 *
 * S6 面（设计 §5，snake-king 首证范式整链搬运）：
 *   - 10Hz 二式快照（全量/增量+稀疏脏字段）/snapSeq/300 张强制全量/退化阈值；
 *   - per-connection 个性化 AOI"档即视野"（r_AOI=体型四档 {380,440,500,560}+15px 滞回）；
 *   - 吞噬裁决 ruling 化一裁三账：{k:'devour'} 单事件原子携带击杀/转移/掉落（§5.3）；
 *   - 质量守恒账本（A8 断言面，massIdentity 探针）；
 *   - 断线重连=welcome 全量+AOI 快照（点实体无 path，恢复比蛇更轻）；
 *   - welcome 声明块 room.fish（engine+K+aoiR+实体三顶——S6 第二证护栏位）。
 *
 * 放水链（GAMES-102 范式）：game.json bot.mercy 阈值读出经 env.mercy 注入 brain
 * （sim 侧零配置——离线确定性/回放不读 game.json，env 缺省全链不可达）。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const DF = require('../../../games/multiplayer/deep-foodchain/sim.cjs')

/* 放水阈值配置（game.json bot.mercy 可调；读失败/缺省 → MERCY_DFT 兜底，启动读一次缓存） */
let _mercyCfg = null
function mercyCfg() {
  if (_mercyCfg) return _mercyCfg
  try {
    const cfg = JSON.parse(readFileSync(new URL('../../../games/multiplayer/deep-foodchain/game.json', import.meta.url), 'utf8'))
    _mercyCfg = Object.assign({}, DF.MERCY_DFT, (cfg.bot && cfg.bot.mercy) || {})
  } catch { _mercyCfg = DF.MERCY_DFT }
  return _mercyCfg
}

export const deepFoodchainSim = Object.assign({}, DF, {
  /* brain 出口包装：env.mercy 注入（无 env（AFK 托管/离线直调）→ brainImpl 缺省兜底） */
  brain: (st, seat, level, rng, env) =>
    DF.brain(st, seat, level, rng, env ? Object.assign({}, env, { mercy: mercyCfg() }) : env),
})
