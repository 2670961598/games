/* =====================================================================
 * 房间管理器（GAMES-40）——生命周期 waiting→live→ended、席位 human/bot、
 * 真人加入 bot 让位、满员旁观、断线重连（10s 凭 roomId+seat+token 恢复）、
 * 托管转 bot、abandon 终局、feed 快照。协议见 docs/net-protocol.md。
 * 模拟不内嵌：经 sims 注册表按 gameId 注入（每游戏一个 server 端 sim 适配器），
 * 房间只做编排——帧推进/输入收集/宽限沿用/广播，游戏规则全在 sim。
 * ===================================================================== */
import { randomBytes } from 'node:crypto'

const RECONNECT_MS = 10_000   // 断线席位保留窗（重连红线）
const ENDED_LINGER_MS = 8_000 // 终局结算展示后回收
const WAITING_EMPTY_MS = 120_000 // 空置 waiting 房回收
const ABANDON_MS = 15_000     // 曾有真人的 live 房全员离线 → abandon 终局
const INPUT_GRACE_NOTE = 0    // （宽限语义在 doFrame：缺输入沿用 lastInput，见协议 §5）

let roomSeq = 0

const LEVEL_CN = { casual: '休闲', balanced: '均衡', competitive: '竞技' }

const nowMs = () => Date.now()
const genId = (prefix) => `${prefix}-${(nowMs() % 0x100000).toString(36)}${(++roomSeq).toString(36)}${randomBytes(2).toString('hex')}`
const sanitizeKeys = (k) => {
  const n = (v) => (Number.isFinite(v) ? Math.max(-100, Math.min(100, Math.trunc(v))) : 0)
  // 离散指令游戏（sim.META.cmdInput，协议 §8.3 游戏级键集）的 cmd 原样透传：
  // 形状校验在 sim（execCmd 白名单，畸形=静默 noop）——网关保持游戏规则无关。
  // S3 双键壳（GAMES-68 empire-sprout 先例，设计 §5.3）：o=建设 op（服务器权威、
  // 下一建设 tick 应用）、c=战斗 cmd（入 F+1 帧输入日志）——同 cmd 透传口径。
  const shell = (x) => (k && k[x] && typeof k[x] === 'object' && !Array.isArray(k[x]) ? k[x] : null)
  const cmd = shell('cmd'), o = shell('o'), c = shell('c')
  const out = { mx: n(k && k.mx), my: n(k && k.my), fire: k && k.fire ? 1 : 0 }
  if (cmd) out.cmd = cmd
  if (o) out.o = o
  if (c) out.c = c
  // S6 连续模拟量键（GAMES-99 snake-king 先例，协议 §6 input 面扩展）：
  // a=目标朝向整数度 [0,359]（10Hz 持续态心跳兼保活）、boost=疾跑开关 0|1——
  // 与 mx/my/fire 同为持续态键（lastInput 宽限沿用）；不带该键的游戏零感知
  if (k && Number.isFinite(k.a)) out.a = ((Math.trunc(k.a) % 360) + 360) % 360
  if (k && k.boost !== undefined) out.boost = k.boost ? 1 : 0
  // S7 连续驾驶键（GAMES-109 speed-kart 先例，协议 §6 input 面扩展）：
  // st=转向量 [-100,100]/th=油门档 {-1,0,1}/dr=漂移开关——持续态键（lastInput 宽限沿用）；
  // 输入序号 q 不在此处（由 input() 按 msg.frame 注入给 seqInput 游戏，§5.1 ack 锚点）
  if (k && Number.isFinite(k.st)) out.st = n(k.st)
  if (k && Number.isFinite(k.th)) out.th = Math.max(-1, Math.min(1, Math.trunc(k.th)))
  if (k && k.dr !== undefined) out.dr = k.dr ? 1 : 0
  // S3+S4 连续冲刺键（GAMES-138 street-soccer 先例，协议 §6 input 面扩展）：
  // sp=冲刺开关 0|1——持续态键（lastInput 宽限沿用）
  if (k && k.sp !== undefined) out.sp = k.sp ? 1 : 0
  return out
}

export class RoomManager {
  constructor({ log = () => {} } = {}) {
    this.sims = new Map()   // gameId → sim 适配器（META/step/brain/url…）
    this.rooms = new Map()  // roomId → room
    this.sessions = new Set()
    this.log = log
    this.onEnded = null     // BotHost 补房钩子（roomId, gameId）
    // 真人胜负 pulse 台账（GAMES-81 陪玩放水信号源）：connCtx → {lose,win}——
    // 同一连接跨房累计连败/连胜；WeakMap 随连接回收，无泄漏
    this.pulse = new WeakMap()
  }

  register(sim) { this.sims.set(sim.META.gameId, sim) }

  /* ---------- 建房 ---------- */
  // opts.seed：确定性 seed 覆盖（测试 API 钉死地图用；缺省仍按 roomId 派生）；
  // opts.test：隔离测试房标记——不进 feed（matches）、不被 quick 命中、不计 BotHost 配额；
  // opts.timeScale：测试房假时钟倍速（仅影响 live 帧推进节奏，帧内容与真人房逐字节同构）。
  create({ gameId, name, bots = [], startDelayMs = 3000, maxTicks, hp, seed, test = false, timeScale = 1, delayMs = 0, autopilot = false, track = null, laps = null }) {
    const sim = this.sims.get(gameId)
    if (!sim) throw new Error(`game-unknown: ${gameId}`)
    // 房间 ID 前缀：缺省 gameId 首段；sim 可经 META.roomPrefix 指定（empire-sprout→emp：
    // 设计 §7 前缀纪律——feed 字典序 mmo-<net-<slg- 之后，存量房序断言不受扰）
    const roomId = genId(sim.META.roomPrefix || gameId.split('-')[0])
    const seedVal = Number.isInteger(seed) ? (seed >>> 0) : sim.fnv1a32(roomId + ':' + randomBytes(2).toString('hex'))
    // opts.test 透传 sim（S2 常驻世界游戏据此隔离存档/终局投影，GAMES-52；S1 sim 忽略）；
    // S7 扩展（GAMES-109 speed-kart）：delayMs=测试房延迟注入（§5.6 api 臂，双向各垫一半）、
    // autopilot=服务器节拍自动驾驶席（A6 确定性双跑——HTTP 注入有墙钟抖动，tick 锁定才可逐字节断言）、
    // track/laps=房参覆写（§5.8）
    const state = sim.create(seedVal, { maxTicks, hp, test, autopilot, track, laps })
    const seats = []
    for (let i = 0; i < sim.META.seats; i++) {
      const botCfg = bots[i] || null // {level} | null → 空位等人
      seats.push({
        seat: i, kind: botCfg ? 'bot' : 'empty', level: botCfg ? botCfg.level : null,
        name: botCfg ? `Bot·${LEVEL_CN[botCfg.level] || '均衡'}` : null,
        conn: null, token: null, lastInput: { mx: 0, my: 0, fire: 0 },
        pending: new Map(), goneAt: 0, botRng: botCfg ? sim.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0) : null,
      })
    }
    const room = {
      id: roomId, gameId, sim, phase: 'waiting',
      createdAt: nowMs(), liveAt: nowMs() + startDelayMs, endedAt: 0,
      frame: 0, lastFrameAt: 0, state, seats,
      spectators: new Set(),
      hadHuman: false, lastHumanAt: 0,
      name: name || `${sim.META.title}房`,
      disposeAt: 0,
      test: !!test, timeScale: test ? (Number(timeScale) > 0 ? Number(timeScale) : 1) : 1,
      delayMs: Number(delayMs) > 0 ? Number(delayMs) : 0, // S7 延迟注入（仅测试房语义，§5.6）
      result: null,
    }
    /* S7 延迟投递（GAMES-109 §5.6 api 臂）：该房全部下行按 delayMs/2 延迟发送——
     * 发送队列 setTimeout 投递，不占 tick 预算；无 delayMs 时直发（零行为变化）。
     * sim.emit 经 room.send 走同一通道（speed-kart 适配器约定）。 */
    room.send = (ctx, text) => {
      const half = room.delayMs >> 1
      if (!half) { if (ctx.conn && ctx.conn.writable) ctx.conn.send(text); return }
      setTimeout(() => { if (ctx.conn && ctx.conn.writable) ctx.conn.send(text) }, half)
    }
    this.rooms.set(roomId, room)
    this.log({ k: 'room-create', roomId, gameId, name: room.name, bots: bots.length, test: room.test })
    return room
  }

  /* ---------- 入房（join / quick 的公共落点） ---------- */
  join(connCtx, { roomId, mode = 'play', resume = null, name } = {}) {
    const room = this.rooms.get(roomId)
    if (!room || room.phase === 'ended') return { error: 'room-gone' }
    // 测试房只对测试会话开放（WS 面按不存在处理，roomId 不泄露）
    if (room.test && !connCtx.isTest) return { error: 'room-gone' }

    // 重连：席位在保留窗内且 token 匹配 → 直接复席
    if (resume && Number.isInteger(resume.seat)) {
      const s = room.seats[resume.seat]
      if (s && s.kind === 'human' && s.token && s.token === resume.token) {
        s.conn = connCtx; s.goneAt = 0
        room.lastHumanAt = nowMs()
        connCtx.room = room; connCtx.seat = s.seat; connCtx.role = 'player'
        this.sendWelcome(connCtx)
        this.broadcastSeat(room)
        this.log({ k: 'reconnect', roomId, seat: s.seat })
        return { ok: true }
      }
      // token 不符/席位已托管 → 按新加入走（让位逻辑接管）
    }

    if (mode === 'spectate') {
      connCtx.room = room; connCtx.seat = -1; connCtx.role = 'spectator'
      room.spectators.add(connCtx)
      this.sendWelcome(connCtx)
      return { ok: true }
    }

    // play：优先空位，其次 bot 让位（协议 §2：优先 seat 最大的 bot 席）
    let target = null
    for (const s of room.seats) if (s.kind === 'empty' && !s.conn) { target = s; break }
    if (!target) {
      for (let i = room.seats.length - 1; i >= 0; i--) {
        const s = room.seats[i]
        if (s.kind === 'bot') { target = s; break }
      }
    }
    if (!target) {
      // 满员：转旁观
      connCtx.room = room; connCtx.seat = -1; connCtx.role = 'spectator'
      room.spectators.add(connCtx)
      this.sendWelcome(connCtx)
      return { ok: true, spectator: true }
    }

    const wasBot = target.kind === 'bot'
    target.kind = 'human'
    target.level = null
    target.name = name || '玩家'
    target.conn = connCtx
    target.token = randomBytes(8).toString('hex')
    target.goneAt = 0
    room.hadHuman = true
    room.lastHumanAt = nowMs()
    connCtx.room = room; connCtx.seat = target.seat; connCtx.role = 'player'
    this.sendWelcome(connCtx)
    this.broadcastSeat(room)
    this.log({ k: 'join', roomId, seat: target.seat, takeover: wasBot })
    return { ok: true, seat: target.seat, takeover: wasBot }
  }

  /** 快速匹配：挑最新可入的 live/waiting 房，无则建房（bot 补位） */
  quick(connCtx, { gameId, level, maxTicks } = {}) {
    const sim = this.sims.get(gameId)
    if (!sim) return { error: 'game-unknown' }
    const joinable = [...this.rooms.values()]
      .filter((r) => r.gameId === gameId && !r.test && r.phase !== 'ended' && this.humanCount(r) < r.seats.length)
      .sort((a, b) => (b.phase === 'live' ? 1 : 0) - (a.phase === 'live' ? 1 : 0) || b.createdAt - a.createdAt)
    if (joinable.length > 0) return this.join(connCtx, { roomId: joinable[0].id, mode: 'play' })
    const bots = []
    for (let i = 0; i < sim.META.seats; i++) bots.push({ level: 'balanced' })
    const room = this.create({ gameId, bots, startDelayMs: 3000, maxTicks })
    return this.join(connCtx, { roomId: room.id, mode: 'play' })
  }

  humanCount(room) {
    let n = 0
    for (const s of room.seats) if (s.kind === 'human') n++
    return n
  }

  /* ---------- 连接生命周期 ---------- */
  attach(connCtx) { this.sessions.add(connCtx) }

  detach(connCtx) {
    this.sessions.delete(connCtx)
    const room = connCtx.room
    if (!room) return
    if (connCtx.role === 'spectator') {
      room.spectators.delete(connCtx)
    } else if (connCtx.role === 'player') {
      const s = room.seats[connCtx.seat]
      if (s && s.conn === connCtx) {
        s.conn = null
        s.goneAt = nowMs() // 席位保留 10s（断线重连窗），逾时 doFrame 托管转 bot
      }
    }
    connCtx.room = null
  }

  leave(connCtx) { this.detach(connCtx) }

  /** 玩家输入上行（S1）：记录到目标帧；滞后帧直接落 lastInput */
  input(connCtx, msg) {
    const room = connCtx.room
    if (!room || connCtx.role !== 'player') return
    const s = room.seats[connCtx.seat]
    if (!s || s.conn !== connCtx) return
    const apply = () => {
      const s2 = room.seats[connCtx.seat]
      if (!s2 || s2.conn !== connCtx) return // 延迟投递窗内掉线/易主：丢弃（迟到输入不作数）
      const keys = sanitizeKeys(msg.keys)
      const f = Number(msg.frame)
      // S7 seqInput（GAMES-109）：input.frame=客户端输入序号 → keys.q（sim seatInput 的
      // q 推进/单调守卫入口，§5.1）；无 frame 的注入维持旧语义（宽限沿用通道）。
      if (room.sim.META.seqInput && Number.isInteger(f)) keys.q = f
    // S2 语义：input.frame=客户端输入序号 seq（预测和解 ack 锚点，GAMES-52）；
    // S1 语义不变（目标帧预约）。lastSeq 对 S1 游戏无用、零开销。
    if (Number.isInteger(f)) s.lastSeq = f
    if (Number.isInteger(f) && f > room.frame && f <= room.frame + 8) {
      s.pending.set(f, keys)
      if (s.pending.size > 16) { // 上限防漏删（正常路径 doFrame 每帧清理）
        const min = Math.min(...s.pending.keys())
        s.pending.delete(min)
      }
      // 离散 cmd 严格一次（GAMES-51 F1）：带预约帧的 cmd 不落 lastInput——否则同一注入
      // 经宽限通道提前执行＋预约帧二次执行（QA二号 echo-sem 实测 spawned×2）。真客户端
      // input delay=1 恒带 frame，此后 cmd 的唯一执行通道就是 pending。
      // 连续键（mx/my/fire）仍写 lastInput：宽限"沿用最近输入"语义不变（net-tank 零感知）。
      // S3 o/c 双键壳同口径（GAMES-68）：离散建设 op/战斗 cmd 均一次性语义。
      if (!keys.cmd && !keys.o && !keys.c) s.lastInput = keys
    } else {
      s.lastInput = keys
    }
    }
    // S7 延迟注入（§5.6 api 臂）：上行输入按 delayMs/2 延迟投递（收发双向对称）；无延迟直入。
    const half = room.delayMs >> 1
    if (half) setTimeout(apply, half)
    else apply()
  }

  /* ---------- op 通道（S4+，协议 §6 S5 预留位：一次性指令，服务器权威校验在 sim） ---------- */
  op(connCtx, msg) {
    const room = connCtx.room
    if (!room || connCtx.role !== 'player' || room.phase !== 'live') return
    const s = room.seats[connCtx.seat]
    if (!s || s.conn !== connCtx) return
    if (!room.sim.op) return
    try {
      room.sim.op(room, connCtx.seat, msg)
    } catch (err) {
      this.log({ k: 'op-error', roomId: room.id, error: String(err && err.message || err) })
    }
  }

  /* ---------- 帧 advance（由网关全局定时器驱动） ---------- */
  tickAll(now) {
    for (const room of [...this.rooms.values()]) {
      try {
        this.tickRoom(room, now)
      } catch (err) {
        this.log({ k: 'room-error', roomId: room.id, error: String(err && err.message) })
        this.dispose(room, 'error')
      }
    }
  }

  tickRoom(room, now) {
    if (room.phase === 'waiting') {
      if (now >= room.liveAt) {
        room.phase = 'live'
        room.lastFrameAt = now
        this.broadcast(room, { t: 'started', frame: 0, state: room.state })
        this.log({ k: 'room-live', roomId: room.id })
      } else if (!room.test && this.humanCount(room) === 0 && room.spectators.size === 0 && now - room.createdAt > WAITING_EMPTY_MS) {
        this.dispose(room, 'empty')
      }
      return
    }
    if (room.phase === 'live') {
      // abandon：曾有真人、现在无人（无玩家连接也无旁观）
      const anyConn = room.seats.some((s) => s.conn) || room.spectators.size > 0
      // F1（GAMES-84）：lastHumanAt 锚=最后在场时刻——在场即刷新（含旁观）。
      // 此前刷新只在 persistent 分支，非 persistent 房被 join/resume 时刻锚死：
      // 在场>15s 独真人房掉线首个扫描拍即 abandon，10s 重连窗+托管双双短路（QA二号 F1）。
      if (anyConn) room.lastHumanAt = now
      if (room.sim.META.persistent) {
        // 常驻世界（GAMES-52 §1.1）：真人 0 也 alive（bot 居民撑镇，feed 恒 live），
        // 不走 abandon 终局；真人离镇空置 120s 回收（镇存档续镇，BotHost 即时重建）。
        if (room.hadHuman && !anyConn && now - room.lastHumanAt > WAITING_EMPTY_MS) {
          if (room.sim.persist) { try { room.sim.persist(room) } catch { /* 存档失败不阻断回收 */ } }
          this.dispose(room, 'idle-recycle')
        }
        return this.tickLive(room, now)
      }
      if (room.hadHuman && !anyConn && now - room.lastHumanAt > ABANDON_MS) {
        // scores 语义=积分（协议 §4.2；GAMES-51 F2：此前误传 kills 冒充）。有积分通道的
        // 游戏传 state.score；kills 即积分的游戏（net-tank 无 score 字段）回退 kills。
        this.finish(room, { winner: 'draw', scores: { ...(room.state.score || room.state.kills) }, reason: 'abandon' })
        return
      }
      return this.tickLive(room, now)
    }
    if (room.phase === 'ended' && now >= room.disposeAt) this.dispose(room, 'ended')
  }

  /** live 帧推进（S1/S2/S4 共用；帧距/追帧上限随 timeScale 缩放，timeScale=1 与原语义逐字节一致） */
  tickLive(room, now) {
    const dueMs = room.sim.META.tickMs / (room.timeScale || 1)
    // 追帧上限按 tickMs 归一（GAMES-78）：tickMs=100 时与旧式 ceil(2×timeScale) 逐字节一致；
    // 快钟游戏（pool tickMs=10）在 8x 假时钟下需 800 步/s，50ms 驱动拍须放开步帽。
    const stepCap = Math.max(2, Math.ceil((2 * (room.timeScale || 1) * 100) / (room.sim.META.tickMs || 100)))
    let steps = 0
    while (now - room.lastFrameAt >= dueMs && steps < stepCap) {
      room.lastFrameAt += dueMs
      steps++
      const over = this.doFrame(room, now)
      if (over) break
    }
    if (steps === stepCap) room.lastFrameAt = now // 欠帧过多（调试器暂停等）：跳齐，不追账
  }

  doFrame(room, now) {
    // 托管：真人断线逾 10s → 席位转 bot（默认均衡档；游戏可经 META.takeOver 定档），名册广播
    // F2'（GAMES-63）重连窗边界粒度收口：托管判定加 1 拍宽限（本游戏 tickMs）——此前
    // goneAt 落点与帧栅格相位任意，边界拍 (10s, 10s+1拍] 内复席成败靠相位运气（QA二号
    // F2' 实测 gap 10004ms 复席成功仅因帧未到）；加宽限后口径确定：gap ≤ RECONNECT_MS+1拍
    // 的复席必先于托管转换落地（协议 §5.4 重连窗=10s+1 拍宽限），超窗复席走 bot 让位路径
    const graceMs = room.sim.META.tickMs || 0
    for (const s of room.seats) {
      if (s.kind === 'human' && !s.conn && s.goneAt && now - s.goneAt > RECONNECT_MS + graceMs) {
        s.kind = 'bot'
        s.level = room.sim.META.takeOver || 'balanced'
        s.name = 'Bot·托管'
        s.botRng = room.sim.mulberry32((room.state.seed ^ (s.seat * 0x85ebca6b)) >>> 0)
        s.pending.clear()
        this.broadcastSeat(room)
        this.log({ k: 'seat-bot', roomId: room.id, seat: s.seat })
      }
    }

    const inputs = {}
    // Bot 名册 env（GAMES-46）：把席位 kind 透传给 brain（陪玩模式判定"同队是否有真人"；
    // 游戏 sim 可忽略第 5 参——net-tank 即如此，接口向后兼容）。
    // foeLose（GAMES-81 陪玩放水）：foeLose[seat]=该 bot 对席真人的连败局数
    // （1v1 语义；团队作对席多人取最大）——sim 自行决定降档阈值（pool ≥2）
    const foeLose = room.seats.map(() => 0)
    for (let i = 0; i < room.seats.length; i++) {
      if (room.seats[i].kind !== 'bot') continue
      for (let j = 0; j < room.seats.length; j++) {
        if (j === i) continue
        const f = room.seats[j]
        if (f.kind !== 'human' || !f.conn) continue
        const rec = this.pulse.get(f.conn)
        if (rec && rec.lose > foeLose[i]) foeLose[i] = rec.lose
      }
    }
    const botEnv = { kinds: room.seats.map((s) => s.kind), foeLose }
    for (const s of room.seats) {
      if (s.kind === 'bot') {
        inputs[s.seat] = room.sim.brain(room.state, s.seat, s.level || 'balanced', s.botRng, botEnv)
      } else {
        const pend = s.pending.get(room.frame)
        inputs[s.seat] = pend || s.lastInput
        // 离散指令一次性语义（slg 设计 §5.1：缺输入沿用=静默）：宽限沿用的 cmd
        // 只在本帧执行一次，之后回落 noop——防同一条 spawn 被逐帧重放。
        // 移动分量保留（S2 连续移动量不受 cmd 一次性语义影响，GAMES-52；S1 离散游戏 mx/my 恒 0 等价）
        // S3 o/c 双键壳同口径（GAMES-68）：无预约帧的注入经 lastInput 只执行一次。
        if (!pend && (s.lastInput.cmd || s.lastInput.o || s.lastInput.c)) s.lastInput = { mx: s.lastInput.mx, my: s.lastInput.my, fire: 0 }
      }
      s.pending.delete(room.frame)
      if (s.pending.size > 0) for (const k of [...s.pending.keys()]) if (k <= room.frame) s.pending.delete(k)
    }
    const r = room.sim.step(room.state, inputs, room)
    room.frame++
    if (room.sim.emit) {
      // S2 状态同步（GAMES-52）：sim 自组二式快照按连接下发（AOI 过滤），无全房 frame 广播
      room.sim.emit(room, r)
    } else {
      const msg = { t: 'frame', frame: room.frame, inputs, events: r.events }
      if (r.over) msg.over = true
      this.broadcast(room, msg)
    }
    if (r.over) { this.finish(room, r.result); return true }
    return false
  }

  finish(room, result) {
    room.phase = 'ended'
    room.endedAt = nowMs()
    room.disposeAt = room.endedAt + ENDED_LINGER_MS
    room.result = result // 终局留档（测试 API 快照/断言读取；协议 §4.2 end 同形）
    this.broadcast(room, { t: 'end', frame: room.frame, result })
    this.log({ k: 'room-end', roomId: room.id, result })
    // 真人胜负 pulse 更新（GAMES-81）：1v1 终局记对席真人连败/连胜（放水信号源）；
    // 团队作（>2 席）不适用——empire 走同队 carry（GAMES-71），不按对手放水。
    // GAMES-112 多席竞速（sim 声明 META.pulsePos）：按完赛名次记真人 pulse——
    // pos≤pulsePos=胜（断连败），否则连败++（bot 放水链 foeLose 信号源；speed-kart=2）
    if (room.sim.META.seats === 2 && result && (result.winner === 'A' || result.winner === 'B')) {
      const winSeat = result.winner === 'A' ? 0 : 1
      for (const s of room.seats) {
        if (s.kind !== 'human' || !s.conn) continue
        const rec = this.pulse.get(s.conn) || { lose: 0, win: 0 }
        if (s.seat === winSeat) { rec.win++; rec.lose = 0 } else { rec.lose++; rec.win = 0 }
        this.pulse.set(s.conn, rec)
      }
    } else if (room.sim.META.pulsePos && result && result.scores) {
      for (const s of room.seats) {
        if (s.kind !== 'human' || !s.conn) continue
        const pos = result.scores[s.seat] && result.scores[s.seat].pos
        if (!Number.isInteger(pos)) continue
        const rec = this.pulse.get(s.conn) || { lose: 0, win: 0 }
        if (pos <= room.sim.META.pulsePos) { rec.win++; rec.lose = 0 } else { rec.lose++; rec.win = 0 }
        this.pulse.set(s.conn, rec)
      }
    } else if (room.sim.META.pulseTeam && result && (result.winner === 'A' || result.winner === 'B')) {
      // GAMES-130 团队作 pulse（MOBA 放水链信号源）：真人所在队胜=断连败，负=连败++
      // （队属判定由 sim META.pulseTeam(seat,winner) 声明；1v1/pulsePos 之外的口径）
      for (const s of room.seats) {
        if (s.kind !== 'human' || !s.conn) continue
        const rec = this.pulse.get(s.conn) || { lose: 0, win: 0 }
        if (room.sim.META.pulseTeam(s.seat, result.winner)) { rec.win++; rec.lose = 0 } else { rec.lose++; rec.win = 0 }
        this.pulse.set(s.conn, rec)
      }
    }
    if (this.onEnded) { try { this.onEnded(room, result) } catch { /* 钩子异常不拖垮房间 */ } }
  }

  dispose(room, reason) {
    if (room.sim.persist) { try { room.sim.persist(room) } catch { /* 存档失败不阻断回收 */ } }
    this.broadcast(room, { t: 'closed', reason })
    for (const s of room.seats) if (s.conn) { s.conn.room = null; s.conn.role = null; s.conn.seat = -1 }
    for (const c of room.spectators) { c.room = null; c.role = null }
    this.rooms.delete(room.id)
    this.log({ k: 'room-dispose', roomId: room.id, reason })
  }

  /* ---------- 下行 ---------- */
  broadcast(room, msg) {
    // S5 迷雾下发（GAMES-88 element-duel 先例，设计 §5.3）：sim 声明 personalize 时
    // 按连接个性化（started/welcome 类带 state 的消息逐席换视图；无 sim 分叉零感知）
    if (room.sim && room.sim.personalize) {
      for (const s of room.seats) if (s.conn && s.conn.conn.writable) room.send(s.conn, JSON.stringify(room.sim.personalize(room, s.conn, msg)))
      for (const c of room.spectators) if (c.conn.writable) room.send(c, JSON.stringify(room.sim.personalize(room, c, msg)))
      return
    }
    const text = JSON.stringify(msg)
    for (const s of room.seats) if (s.conn && s.conn.conn.writable) room.send(s.conn, text)
    for (const c of room.spectators) if (c.conn.writable) room.send(c, text)
  }

  broadcastSeat(room) {
    this.broadcast(room, { t: 'seat', seats: this.roster(room) })
  }

  roster(room) {
    return room.seats.map((s) => ({ seat: s.seat, kind: s.kind, level: s.level, name: s.name }))
  }

  sendWelcome(ctx) {
    const room = ctx.room
    const s = ctx.role === 'player' ? room.seats[ctx.seat] : null
    const extra = room.sim.welcomeExtra ? room.sim.welcomeExtra() : null // S4 物理/S5 牌局声明块（协议 §6）
    let msg = {
      t: 'welcome', roomId: room.id, gameId: room.gameId,
      role: ctx.role, seat: ctx.role === 'player' ? ctx.seat : undefined,
      token: s ? s.token : undefined,
      frame: room.frame, tickMs: room.sim.META.tickMs, seed: room.state.seed,
      room: {
        name: room.name, mode: room.sim.META.mode, state: room.phase,
        countdownMs: Math.max(0, room.liveAt - nowMs()),
        seats: this.roster(room),
        ...(extra || {}),
      },
      state: room.state,
    }
    // S5 个性化（GAMES-88）：welcome.state=按角色裁剪视图（重连全量恢复=个性化全量，设计 §5.4）
    if (room.sim.personalize) msg = room.sim.personalize(room, ctx, msg)
    room.send(ctx, JSON.stringify(msg))
  }

  /* ---------- feed（GET /api/matches 数据源） ---------- */
  matches() {
    const now = nowMs()
    const out = []
    for (const room of this.rooms.values()) {
      if (room.phase === 'ended' || room.test) continue // ended 不见客；测试房隔离（GAMES-41）
      let humans = 0, bots = 0
      for (const s of room.seats) { if (s.kind === 'human') humans++; else if (s.kind === 'bot') bots++ }
      out.push({
        roomId: room.id, gameId: room.gameId, name: room.name, mode: room.sim.META.mode,
        humans, bots, spectators: room.spectators.size,
        elapsedMs: now - (room.phase === 'live' ? room.liveAt : room.createdAt),
        joinable: humans < room.seats.length,
        url: room.sim.url,
      })
    }
    return out.sort((a, b) => (a.roomId < b.roomId ? -1 : 1)) // 稳定序（roomId 已含时序）
  }

  roomsFor(gameId) {
    const out = []
    for (const r of this.rooms.values()) if (r.gameId === gameId) out.push(r)
    return out
  }
}
