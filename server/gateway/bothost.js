/* =====================================================================
 * Bot 宿主（GAMES-40）——「正在对战」由真 Bot 房撑起（非假数据）。
 * 统一接口 spawnBot(gameId, level) → Bot 输入生成器；对每个已上线联机游戏
 * 常驻 minLive 个纯 bot 对局房（网关启动即起、终局后 3s 内补齐），总量帽
 * maxRooms/游戏。真人进房后该房不再是纯 bot 房，宿主按缺口补新房。
 * Bot 输入经房间管理器走与真人完全相同的帧通道（协议 §5）。
 * ===================================================================== */

const LEVEL_CN = { casual: '休闲', balanced: '均衡', competitive: '竞技' }
const RULE_CN = { gomoku: '五子', reversi: '黑白', cascade: '井字' } // 多规则常驻房名（GAMES-155）

export class BotHost {
  constructor({ rooms, log = () => {} } = {}) {
    this.rooms = rooms
    this.log = log
    this.games = new Map() // gameId → { minLive, levels, maxRooms, botSeats }
    this.timer = null
  }

  /** 上线一款联机游戏：常驻配置 + Bot 工厂（residents: 常驻镇模式 GAMES-52；swarm: 群房
   * 巨房模式 GAMES-99——解构白名单漏收该字段时 cfg.swarm 恒 undefined，ensureSwarm 成死码，
   * snake-king 静默落回通用补房路径（bots=seats 满填+名不带巨房），浏览器面才可目击；
   * rules: 多规则常驻房 GAMES-155——每模式各一 casual 房（设计 §1.1「三模式各自常驻
   * Bot 房，秒进秒换」），房数帽按游戏总量计） */
  register({ gameId, minLive = 2, levels = ['casual', 'balanced'], maxRooms = 4, seats, residents = false, swarm = 0, rules = null }) {
    this.games.set(gameId, { minLive, levels, maxRooms, seats, residents, swarm, rules })
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
      if (cfg.residents) { this.ensureResidents(gameId, cfg, all); continue }
      if (cfg.swarm) { this.ensureSwarm(gameId, cfg, all); continue }
      if (cfg.rules) { this.ensureRules(gameId, cfg, all); continue }
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

  /* ---------- 多规则常驻房（GAMES-155 yi-pavilion §7）：每模式（rule）各一 casual 房
   * ——设计 §1.1「三模式各自常驻 Bot 房，秒进秒换」；房数帽按该游戏总房数计（上限 6）。
   * 真人进房后该房非纯 bot，按该 rule 缺口补新房；终局 3s 补房（rooms.onEnded → ensure）。 */
  ensureRules(gameId, cfg, all) {
    const sim = this.rooms.sims.get(gameId)
    for (const rule of cfg.rules) {
      const pureBot = all.filter((r) => this.rooms.humanCount(r) === 0 && r.spectators.size === 0 && r.state && r.state.rule === rule)
      if (pureBot.length >= 1 || all.length >= cfg.maxRooms) continue
      const bots = []
      for (let i = 0; i < sim.META.seats; i++) bots.push({ level: 'casual' })
      this.rooms.create({
        gameId, rule,
        name: `${sim.META.title} · ${RULE_CN[rule] || rule}房`,
        bots,
        startDelayMs: 1000, // bot 房快速入 live，feed 尽快可见
      })
      this.log({ k: 'bothost-spawn', gameId, rule })
    }
  }

  /* ---------- 群房模式（GAMES-99 snake-king §4.1/§5.7）：常驻巨房 2（casual 房+混编房），
   * 实体目标 20 蛇（bots=clamp(20−humans,0,23)）——真人加入 bot 让位（座位被顶替或空位
   * 占用后超员 bot 退场）、真人离镇 45s 防抖后补员；feed 恒 live、joinable 恒真。 */
  ensureSwarm(gameId, cfg, all) {
    const sim = this.rooms.sims.get(gameId)
    const target = cfg.swarm || 20
    const pureBot = all.filter((r) => this.rooms.humanCount(r) === 0 && r.spectators.size === 0)
    if (pureBot.length < cfg.minLive && all.length < cfg.maxRooms) {
      const mix = pureBot.length === 0 ? 'casual' : 'mixed' // 第 1 间休闲巨房、第 2 间混编巨房（§5.7）
      const bots = []
      for (let i = 0; i < sim.META.seats; i++) {
        if (i >= target) break // 只占前 20 席（seats=24 硬顶留观战/拥挤余量，§2.1）
        bots.push(mix === 'casual' ? { level: 'casual' } : { level: i < 3 ? 'competitive' : i < 9 ? 'balanced' : 'casual' }) // 混编 3/6/11（full20 同型，§6）
      }
      const room = this.rooms.create({ gameId, name: `${sim.META.title} · ${mix === 'casual' ? '休闲' : '混编'}巨房`, bots, startDelayMs: 1000 })
      room.__swarmMix = mix
      this.log({ k: 'bothost-swarm-spawn', gameId, mix, bots: bots.length })
    }
    for (const room of all) if (room.__swarmMix || room.gameId === gameId) this.calibrateSwarm(room, sim, target)
  }

  calibrateSwarm(room, sim, target) {
    const humans = this.rooms.humanCount(room)
    if (humans > 0) room.__lastHumanSeen = Date.now()
    const want = Math.max(0, Math.min(room.seats.length - 1, target - humans)) // bots=clamp(20−humans,0,23)
    let bots = 0
    for (const s of room.seats) if (s.kind === 'bot') bots++
    let changed = false
    while (bots > want) { // 超员退场（真人占空位后）：高席先走
      const s = [...room.seats].reverse().find((x) => x.kind === 'bot')
      if (!s) break
      s.kind = 'empty'; s.level = null; s.name = null; s.botRng = null; s.pending.clear()
      bots--; changed = true
      this.log({ k: 'swarm-bot-leave', roomId: room.id, seat: s.seat })
    }
    if (bots < want && (humans > 0 || !room.hadHuman || Date.now() - (room.__lastHumanSeen || 0) > 45_000)) {
      const mix = room.__swarmMix || 'mixed'
      while (bots < want) {
        const s = room.seats.find((x) => x.kind === 'empty' && !x.conn)
        if (!s) break
        s.kind = 'bot'
        s.level = mix === 'casual' ? 'casual' : bots % 19 < 3 ? 'competitive' : bots % 19 < 9 ? 'balanced' : 'casual'
        s.name = `Bot·${LEVEL_CN[s.level]}`
        s.botRng = sim.mulberry32(((room.state.seed ^ (s.seat * 0x9e3779b9)) >>> 0))
        bots++; changed = true
        this.log({ k: 'swarm-bot-join', roomId: room.id, seat: s.seat, level: s.level })
      }
    }
    if (changed) this.rooms.broadcastSeat(room)
  }

  /* ---------- 常驻镇模式（GAMES-52 §4.1/§8）：镇=长生命周期房间，居民 bot 动态调节 ----------
   * 镇人口目标 pop = 8+(townLevel−1)；每 ensure 拍校准 bot 活跃数 = clamp(pop−humans,0,seats)：
   * 真人进镇 → 超员 bot 走屋退场；真人离镇 → 45s 防抖后补位渐入（重连窗 10s 内席位保留不补）；
   * balanced 主力 + casual 混编，镇等级升 → casual 占比升。 */
  ensureResidents(gameId, cfg, all) {
    const sim = this.rooms.sims.get(gameId)
    if (all.length === 0) {
      if ((cfg.maxRooms || 1) < 1) return
      const bots = []
      for (let i = 0; i < sim.META.seats; i++) {
        // 开镇 8 居民：勤恳主力 + 游手混编 + 1 商人（§8「8 人开局」；GAMES-55
        // 三档人格同镇可见——商人蹲集市/黄昏守摊是镇的烟火气一角，坐席 3）
        bots.push(i < 8 ? { level: i === 3 ? 'competitive' : i % 3 === 1 ? 'casual' : 'balanced' } : null)
      }
      this.rooms.create({ gameId, name: `${sim.META.title} · 常驻镇`, bots, startDelayMs: 1000 })
      this.log({ k: 'bothost-town-spawn', gameId })
      return
    }
    for (const room of all) this.calibrateTown(room, sim)
  }

  calibrateTown(room, sim) {
    const humans = this.rooms.humanCount(room)
    if (humans > 0) room.__lastHumanSeen = Date.now()
    const pop = sim.population ? sim.population(room.state) : 8
    const target = Math.max(0, Math.min(room.seats.length, pop - humans))
    let bots = 0
    for (const s of room.seats) if (s.kind === 'bot') bots++
    let changed = false
    while (bots > target) { // 超员退场：高席先走（step 下一 tick 清化身，客户端走屋渐隐）
      const s = [...room.seats].reverse().find((x) => x.kind === 'bot')
      if (!s) break
      s.kind = 'empty'; s.level = null; s.name = null; s.botRng = null; s.pending.clear()
      bots--; changed = true
      this.log({ k: 'town-bot-leave', roomId: room.id, seat: s.seat })
    }
    if (bots < target && (humans > 0 || !room.hadHuman || Date.now() - (room.__lastHumanSeen || 0) > 45_000)) {
      const level = room.state.town ? room.state.town.level : 1
      const casualWanted = Math.ceil(target * (0.25 + (level - 1) * 0.1)) // 等级升 → 烟火气渐浓
      const merchWanted = level >= 3 ? 2 : 1 // 商人驻镇（GAMES-55）：Lv1 一摊、Lv3 起两摊
      let casualNow = 0, merchNow = 0
      for (const s of room.seats) if (s.kind === 'bot') {
        if (s.level === 'casual') casualNow++
        else if (s.level === 'competitive') merchNow++
      }
      while (bots < target) {
        const s = room.seats.find((x) => x.kind === 'empty' && !x.conn)
        if (!s) break
        s.kind = 'bot'
        s.level = merchNow < merchWanted ? 'competitive' : casualNow < casualWanted ? 'casual' : 'balanced'
        s.name = `Bot·${LEVEL_CN[s.level]}`
        s.botRng = sim.mulberry32(((room.state.seed ^ (s.seat * 0x9e3779b9)) >>> 0))
        if (s.level === 'casual') casualNow++
        else if (s.level === 'competitive') merchNow++
        bots++; changed = true
        this.log({ k: 'town-bot-join', roomId: room.id, seat: s.seat, level: s.level })
      }
    }
    if (changed) this.rooms.broadcastSeat(room)
  }
}
