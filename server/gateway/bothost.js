/* =====================================================================
 * Bot 宿主（GAMES-40）——「正在对战」由真 Bot 房撑起（非假数据）。
 * 统一接口 spawnBot(gameId, level) → Bot 输入生成器；对每个已上线联机游戏
 * 常驻 minLive 个纯 bot 对局房（网关启动即起、终局后 3s 内补齐），总量帽
 * maxRooms/游戏。真人进房后该房不再是纯 bot 房，宿主按缺口补新房。
 * Bot 输入经房间管理器走与真人完全相同的帧通道（协议 §5）。
 * ===================================================================== */

const LEVEL_CN = { casual: '休闲', balanced: '均衡', competitive: '竞技' }

export class BotHost {
  constructor({ rooms, log = () => {} } = {}) {
    this.rooms = rooms
    this.log = log
    this.games = new Map() // gameId → { minLive, levels, maxRooms, botSeats }
    this.timer = null
  }

  /** 上线一款联机游戏：常驻配置 + Bot 工厂 */
  register({ gameId, minLive = 2, levels = ['casual', 'balanced'], maxRooms = 4, seats }) {
    this.games.set(gameId, { minLive, levels, maxRooms, seats })
  }

  /** 统一接口：spawnBot(gameId, level) → Bot（输入生成闭包，由房间按帧调用） */
  spawnBot(gameId, level = 'balanced') {
    const sim = this.rooms.sims.get(gameId)
    if (!sim) throw new Error(`game-unknown: ${gameId}`)
    const lvl = sim.LEVELS ? (sim.LEVELS.includes(level) ? level : 'balanced') : level
    const bot = {
      gameId, level: lvl,
      input: (state, seat, rng) => sim.brain(state, seat, lvl, rng),
    }
    return bot
  }

  start(intervalMs = 3000) {
    this.ensure()
    this.timer = setInterval(() => this.ensure(), intervalMs)
    this.timer.unref?.()
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** 补房：纯 bot 的 live/waiting 房 < minLive 且总房数 < maxRooms 时建一间（测试房不计入，GAMES-41） */
  ensure() {
    for (const [gameId, cfg] of this.games) {
      const all = this.rooms.roomsFor(gameId).filter((r) => r.phase !== 'ended' && !r.test)
      const pureBot = all.filter((r) => this.rooms.humanCount(r) === 0 && r.spectators.size === 0)
      if (pureBot.length >= cfg.minLive || all.length >= cfg.maxRooms) continue
      const level = cfg.levels[pureBot.length % cfg.levels.length]
      const sim = this.rooms.sims.get(gameId)
      const bots = []
      for (let i = 0; i < sim.META.seats; i++) {
        bots.push({ level: i % 2 === 0 ? level : cfg.levels[(pureBot.length + 1) % cfg.levels.length] })
      }
      this.rooms.create({
        gameId,
        name: `${sim.META.title} · ${LEVEL_CN[level]}房`,
        bots,
        startDelayMs: 1000, // bot 房快速入 live，feed 尽快可见
      })
      this.log({ k: 'bothost-spawn', gameId, level })
    }
  }
}
