/* =====================================================================
 * api-check —— 每款联机游戏通用的 API 可玩性断言（GAMES-41 · M1）
 * 用法：node scripts/api-check.js <gameId>       （例：net-tank）
 * 前置：网关(:4400) 运行中；游戏 game.json 已声明 net.api（规范：docs/net-protocol.md §8）。
 *
 * 纯 API 驱动整局（零浏览器）：经 /api/test/* 建隔离测试房 → 注入操作 →
 * 读状态快照断言。剧本（seed/bot 档位/假时钟倍速/胜负期望）全部来自 game.json net.api，
 * 本工具不含任何游戏私有规则；玩家策略走 net.api.script.scenarios[].policy 注册表。
 *
 * 断言组（roadmap §4.2 / 联机红线「API 可玩」）：
 *   L1 仅本机：测试面经非回环地址访问 → 403
 *   A1 能开始：boot(waiting)→live 状态迁移（+ 测试房不进 feed 隔离）
 *   A2 能赢：剧本胜方达成终态（result.winner === expectWinner）
 *   A3 能输：剧本败方终态（对称局）
 *   A4 操作注入→帧反映 <100ms（服务端同钟计时：receivedAt → 帧广播 ts）
 *   A5 断线重连：$disconnect → 席位保留 → $reconnect 凭 token 复席，<10s 状态恢复续玩
 * 报告：JSON 落盘 kernel 证据路径（默认 /Volumes/BigDisk/Studio/kernel/workers/GAMES-41）。
 * 退出码：0=全绿，1=有失败（可挂闸门）；2=用法/环境错误。
 * 与 net-check 分工：本工具管 API 面（逻辑可玩性），net-check 管浏览器面
 * （大厅/入房/让位/feed/旁观/识图截图）——见 docs/net-protocol.md §8.4。
 * ===================================================================== */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4400'
const EVIDENCE_DIR = process.env.GAMES_EVIDENCE || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-41'
const POLL_MS = 120 // 剧本驱动轮询节拍（注入更新频率；帧间输入由 lastInput 宽限沿用）

let passed = 0, failed = 0
const checks = []
const ok = (id, name, cond, detail = '') => {
  const pass = !!cond
  if (pass) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  checks.push({ id, name, pass, detail: String(detail) })
  return pass
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 网关 HTTP 小客户端 ---------- */
async function gw(method, path, body, origin = GW) {
  const res = await fetch(origin + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  let json = null
  try { json = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, json }
}
const gwState = async (roomId, since = 0) => gw('GET', `/api/test/state?roomId=${roomId}&since=${since}`)
const gwInput = (roomId, seat, op, payload) => gw('POST', '/api/test/input', { roomId, seat, op, payload })

/* ---------- 玩家策略注册表（net.api.scenarios[].policy 按名引用；新游戏在此登记） ---------- */
const POLICIES = {
  /** 挂机：零输入（可输性剧本——被猎杀方） */
  idle: () => ({ mx: 0, my: 0, fire: 0 }),
  /** 猎杀最近敌：模拟量向量压向最近敌人 + 持续开火；复用 sim 的 sx 卡死账本脱困（net-tank 状态形状） */
  'hunt-nearest': (state, seat) => {
    const me = state.tanks && state.tanks[seat]
    if (!me || !me.alive) return { mx: 0, my: 0, fire: 0 }
    let best = null, bd = Infinity
    for (const t of state.tanks) {
      if (!t.alive || t.team === me.team) continue
      const d = (t.x - me.x) ** 2 + (t.y - me.y) ** 2
      if (d < bd) { bd = d; best = t }
    }
    if (!best) return { mx: 0, my: 0, fire: 0 }
    let dx = best.x - me.x, dy = best.y - me.y
    if ((me.sx || 0) >= 3) { const t0 = dx; dx = -dy; dy = t0 } // 卡死账本 ≥3：方向旋转 90° 蹭出
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    return { mx: Math.round(dx / len * 100), my: Math.round(dy / len * 100), fire: 1 }
  },
  /**
   * 宏观推进（slg-battlefield A2 能赢，设计书 §6 时间轴 + 经济适配）：
   * 开局 2×inf 车道1 → 双信号塔常驻集结线+驻塔 inf（占塔拿 +2 CP/s 与积分通道兜底）→
   * razor/inf 交替车道1 → tick 300 起 heavy 推进；敌集群 ≥4 barrage、基地 <70% repair。
   * 每次轮询至多回 1 条 cmd（离散指令，S1 帧通道一次一条）。
   */
  'macro-push': (state, seat) => {
    const NOOP = { cmd: { k: 'noop' } }
    const s = state.seats && state.seats[seat]
    if (!s) return NOOP
    const t = state.tick
    const foe = s.team === 'A' ? 'B' : 'A'
    const myBase = (state.bld || []).find((b) => b.kind === 'base' && b.team === s.team)
    const cp = s.cp, tier = s.tier
    const cost = (u) => ({ inf: [20, 30, 40], razor: [45, 65, 85], heavy: [110, 155, 210] })[u][tier - 1] * 1000
    const units = state.units || []
    const pop = units.filter((u) => u.seat === seat).length
    const towers = state.towers || []
    const castable = (id) => s.energy >= [60, 40, 70, 50][id] && (!s.cd || s.cd[id] <= 0)
    /* 技能：repair（基地 <70%）> barrage（敌集群 ≥4，45px 同车道窗口口径同 sim） */
    if (myBase && myBase.hp < 1050 && castable(1)) return { cmd: { k: 'skill', id: 1 } }
    let cl = null
    for (const e of units) {
      if (e.team !== foe) continue
      let c = 0
      for (const o of units) if (o.team === foe && o.lane === e.lane && Math.abs(o.y - e.y) <= 45000) c++
      if (!cl || c > cl.c) cl = { lane: e.lane, row: Math.max(0, Math.min(19, (e.y / 25000) | 0)), c }
    }
    if (cl && cl.c >= 4 && castable(0)) return { cmd: { k: 'skill', id: 0, lane: cl.lane, row: cl.row } }
    /* 集结：双塔车道常驻塔位（占塔/反夺回；车道 1 不设集结 → 直推敌基地） */
    for (const tw of towers) {
      if (s.rally[tw.lane] !== tw.row) return { cmd: { k: 'rally', lane: tw.lane, row: tw.row } }
    }
    /* 驻塔：塔无己方单位驻守（40px 口径同 sim 占点）→ 补 1 inf */
    if (pop < 12 && s.spawnCd <= 0) {
      for (const tw of towers) {
        const holder = units.some((u) => u.seat === seat && u.lane === tw.lane && Math.abs(u.y - tw.y) <= 40000)
        if (!holder && cp >= cost('inf')) return { cmd: { k: 'spawn', unit: 'inf', lane: tw.lane } }
      }
      /* 研究：T2 凑够即升（设计 tick 150 起的 opportunist 版——经济允许时才花） */
      if (tier === 1 && !s.research && t >= 150 && cp >= 150000) return { cmd: { k: 'research', tier: 2 } }
      if (tier === 2 && !s.research && t >= 900 && cp >= 300000) return { cmd: { k: 'research', tier: 3 } }
      /* 主攻车道 1：开场 2×inf → razor/inf 交替（留 CP 缓冲）→ tick 300 起 heavy */
      if (t < 40) { if (cp >= cost('inf')) return { cmd: { k: 'spawn', unit: 'inf', lane: 1 } } }
      else if (t >= 300 && cp >= cost('heavy') + 30000) return { cmd: { k: 'spawn', unit: 'heavy', lane: 1 } }
      else if (cp >= cost('razor') + 25000 && s.spawned % 2 === 0) return { cmd: { k: 'spawn', unit: 'razor', lane: 1 } }
      else if (cp >= cost('inf') + 25000) return { cmd: { k: 'spawn', unit: 'inf', lane: 1 } }
    }
    return NOOP
  },
  /**
   * 采集推进（mmo-township A2 能赢，设计书 §6 剧本策略）：满包回贡献台自动倾倒；
   * 否则价值/距离贪心择最近非空资源位直奔，到位持握（服务端 hold 连采、幂等 start）。
   * S2 语义：move 连续量每拍重发；gather start 幂等（同 entId 续进度），无需跨拍记忆。
   */
  'gather-push': (state, seat) => {
    const NOOP = { mx: 0, my: 0 }
    const me = state.ents && state.ents['p' + seat]
    const sess = state.sessions && state.sessions[seat]
    if (!me || !sess) return NOOP
    const dist = (x, y) => Math.hypot(x - me.x, y - me.y)
    const toward = (x, y) => {
      const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
      return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
    }
    if (sess.bagN >= 6) { // 满包回城：贡献台 60px 内站定自动倾倒
      const dp = state.map.deposit
      return dist(dp.x, dp.y) > 50000 ? toward(dp.x, dp.y) : NOOP
    }
    if (sess.g && sess.g.hold) return NOOP // 持握中：站桩续采（进度服务器权威）
    let best = null, bs = -1
    for (const id in state.ents) {
      const e = state.ents[id]
      if (!e || e.stock <= 0) continue
      const v = { herb: 2, berry: 3, ore: 5, star: 8 }[e.k]
      if (!v) continue
      const s = v / (dist(e.x, e.y) + 200000)
      if (s > bs) { bs = s; best = e }
    }
    if (!best) return NOOP
    return dist(best.x, best.y) > 52000
      ? toward(best.x, best.y)
      : { mx: 0, my: 0, cmd: { k: 'gather', entId: best.id, phase: 'start' } }
  },
  /**
   * 几何解算（pool-physics A2/A6，设计 §6：脚本侧 ghost ball 反射几何核——
   * api-check 经 /api/test/state 读全量 state 合法，逐杆注入 shot；
   * ball-in-hand 时 place 在目标球-袋连线上直接摆位。零 rng——确定性双跑前提）。
   */
  'pot-solver': (() => {
    const POCKETS = [[0, 0], [170000, -6000], [340000, 0], [0, 170000], [170000, 176000], [340000, 170000]]
    const R = 7500, W_M = 340000, H_M = 170000
    const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l] }
    const clear = (st, x1, y1, x2, y2, ignore) => {
      const d = Math.hypot(x2 - x1, y2 - y1), steps = Math.max(1, Math.floor(d / 7500))
      for (let s = 1; s <= steps; s++) {
        const px = x1 + (x2 - x1) * s / steps, py = y1 + (y2 - y1) * s / steps
        for (const b of st.balls) { if (b.pot) continue; if (b === st.balls[0] || b.id === ignore) continue; const bi = st.balls.indexOf(b); if (bi === ignore || bi === 0) continue; if (Math.hypot(b.x - px, b.y - py) < 15000) return false }
      }
      return true
    }
    const targets = (st, seat) => {
      const g = st.groups[seat]
      let pool = []
      if (st.openTable) pool = st.balls.filter((b, i) => i >= 1 && i <= 15 && i !== 8 && !b.pot).map((b) => st.balls.indexOf(b))
      else {
        const own = st.balls.filter((b, i) => g === 1 ? i >= 1 && i <= 7 : i >= 9 && i <= 15).filter((b) => !b.pot)
        pool = own.map((b) => st.balls.indexOf(b))
        if (pool.length === 0 && !st.balls[8].pot) pool = [8]
      }
      return pool
    }
    return (state, seat) => {
      if (!state || state.phase !== 'aim' || state.turn !== seat) return {}
      const st = state
      /* 破球（shot 1）：正瞄尖球全力 */
      if (st.shotN === 0) {
        const apex = st.balls[1]
        const a = Math.atan2(apex.y - st.balls[0].y, apex.x - st.balls[0].x) / (2 * Math.PI)
        return { op: { k: 'shot', ang: Math.round((a < 0 ? a + 1 : a) * 65536) & 0xFFFF, pow: 1000, spinV: 0, spinS: 0 } }
      }
      const cue = st.balls[0], pool = targets(st, seat)
      /* ball-in-hand：目标球-袋连线后方 70px 摆位（直线杆） */
      if (st.ballInHand || cue.pot) {
        let best = null
        for (const id of pool.length ? pool : []) for (const [px, py] of POCKETS) {
          const b = st.balls[id]
          const [ux, uy] = norm(px - b.x, py - b.y)
          for (const D of [80000, 60000, 100000]) {
            const x = Math.round(b.x - ux * D), y = Math.round(b.y - uy * D)
            if (x < R + 100 || x > W_M - R - 100 || y < R + 100 || y > H_M - R - 100) continue
            if (POCKETS.some(([qx, qy]) => Math.hypot(x - qx, y - qy) < 14000)) continue
            if (st.balls.some((o, i) => i !== 0 && !o.pot && Math.hypot(o.x - x, o.y - y) < 16000)) continue
            const cut = 1 // 连线摆位=直线杆
            const score = cut - Math.hypot(px - b.x, py - b.y) / 400000
            if (!best || score > best.score) best = { x, y, score }
          }
        }
        if (best) return { op: { k: 'place', x: best.x, y: best.y } }
        return { op: { k: 'place', x: 85000, y: 85000 } }
      }
      /* 常规杆：ghost ball 候选评分（cut 主导、路程次之） */
      let best = null
      for (const id of pool) for (let pi = 0; pi < 6; pi++) {
        const b = st.balls[id], [px, py] = POCKETS[pi]
        const [ux, uy] = norm(px - b.x, py - b.y)
        const gx = b.x - ux * 15000, gy = b.y - uy * 15000
        if (gx < R || gx > W_M - R || gy < R || gy > H_M - R) continue
        const [ax, ay] = norm(gx - cue.x, gy - cue.y)
        const cut = ax * ux + ay * uy
        if (cut < 0.35) continue
        if (!clear(st, cue.x, cue.y, gx, gy, id)) continue
        if (!clear(st, b.x, b.y, px, py, id)) continue
        const dcg = Math.hypot(gx - cue.x, gy - cue.y), dbp = Math.hypot(px - b.x, py - b.y)
        const score = cut * cut - dcg / 400000 - dbp / 300000 - (id === 8 ? 0 : 0.02)
        if (!best || score > best.score) best = { score, ang: Math.atan2(gy - cue.y, gx - cue.x), cut, dcg, dbp }
      }
      if (best) {
        const a = best.ang / (2 * Math.PI)
        const pow = Math.round(Math.min(1000, Math.max(200, 250 + (best.dcg + best.dbp / Math.max(best.cut, 0.35)) * 3 / 4096)))
        return { op: { k: 'shot', ang: Math.round((a < 0 ? a + 1 : a) * 65536) & 0xFFFF, pow, spinV: 0, spinS: 0 } }
      }
      /* 无候选：朝最近合法球中力（防 F2 空杆） */
      let near = null
      for (const id of pool) { const b = st.balls[id]; if (b.pot) continue; const d = Math.hypot(b.x - cue.x, b.y - cue.y); if (!near || d < near.d) near = { id, d } }
      if (!near) return {}
      const nb = st.balls[near.id]
      const a = Math.atan2(nb.y - cue.y, nb.x - cue.x) / (2 * Math.PI)
      return { op: { k: 'shot', ang: Math.round((a < 0 ? a + 1 : a) * 65536) & 0xFFFF, pow: 500, spinV: 0, spinS: 0 } }
    }
  })(),
  /**
   * 燃脸速攻（element-duel A2/A6，设计 §6 剧本策略）：脚本侧选炎阳（H0）；换牌保留 ≤2 费；
   * 每回合：可付费随从优先部署近敌行/邻接己方异系、法术直伤全部指英雄、技能火弹指英雄、
   * 攻击全部打脸（嘲讽强制时解场）→ endTurn。零 rng——确定性双跑前提（§5.5）。
   * 每次轮询至多回 1 条 op（S5 op 通道）。
   */
  'burn-face': (() => {
    const nearFoeRow = (seat) => (seat === 0 ? 0 : 2)
    return (state, seat) => {
      if (!state || state.over) return {}
      const S = (k) => state[k]
      const CARDS = { F1:{mi:1},F2:{mi:1},F3:{mi:1},F4:{mi:1},W1:{mi:1},W2:{mi:1},W3:{mi:1,tgt:'freeze'},W4:{mi:1},N1:{mi:1},N2:{mi:1},N3:{mi:1},N4:{mi:1},T1:{mi:1},T2:{mi:1},T3:{mi:1},T4:{mi:1},
        FS1:{sp:'face'},FS2:{sp:'row'},WS1:{sp:'own'},WS2:{sp:'freeze'},NS1:{sp:'none'},NS2:{sp:'move'},TS1:{sp:'tgt'},TS2:{sp:'none'},X0:{sp:'none'} }
      const COST = { F1:1,F2:2,F3:5,F4:6,W1:1,W2:3,W3:4,W4:6,N1:1,N2:2,N3:3,N4:5,T1:1,T2:2,T3:4,T4:6,FS1:3,FS2:4,WS1:1,WS2:2,NS1:3,NS2:1,TS1:2,TS2:5,X0:0 }
      const phase = state.phase
      if (phase === 'pick') return state.heroes[seat].hero < 0 ? { op: { k: 'pick', hero: 0 } } : {}
      if (phase === 'mulligan') {
        const hand = state.hands[seat]
        if (state.mullDone && state.mullDone[seat]) return {}
        return { op: { k: 'mulligan', keep: hand.map((id) => COST[id] <= 2) } }
      }
      if (phase !== 'play' || state.turnSeat !== seat) return {}
      const hand = state.hands[seat], me = state.heroes[seat]
      const board = state.board, foeSeat = seat === 0 ? 1 : 0
      const foeTaunts = []
      for (let c = 0; c < 9; c++) if (board[c] && board[c].seat === foeSeat && board[c].taunt) foeTaunts.push(c)
      /* 1. 直伤法术指英雄（FS1；FS2 选含敌随从最多行） */
      for (let i = 0; i < hand.length; i++) {
        const id = hand[i]
        if (id === 'FS1' && me.manaCur >= 3) return { op: { k: 'play', card: i, tgt: { s: foeSeat, c: -1 } } }
      }
      /* 2. 部署随从：近敌行优先、邻接己方异系次之（反应伙伴） */
      let ownN = 0
      for (let c = 0; c < 9; c++) if (board[c] && board[c].seat === seat) ownN++
      const sch = (id) => ({ F: 'F', W: 'W', N: 'N', T: 'T' })[id ? id[0] === 'F' ? 'F' : id[0] === 'W' ? 'W' : id[0] === 'N' ? 'N' : 'T' : '?']
      const minions = []
      for (let i = 0; i < hand.length; i++) { const d = CARDS[hand[i]]; if (d && d.mi && me.manaCur >= COST[hand[i]]) minions.push(i) }
      if (minions.length && ownN < 4) {
        const i = minions[0]
        const id = hand[i]
        let cell = -1
        for (let c = 0; c < 9 && cell < 0; c++) { // ① 己方异系邻接空格（反应伙伴）
          if (board[c]) continue
          const row = (c / 3) | 0, col = c % 3
          const nbr = [row > 0 ? c - 3 : -1, col < 2 ? c + 1 : -1, row < 2 ? c + 3 : -1, col > 0 ? c - 1 : -1]
          for (const n of nbr) if (n >= 0 && board[n] && board[n].seat === seat && sch(board[n].c) !== sch(id)) { cell = c; break }
        }
        if (cell < 0) { for (let c = 0; c < 9; c++) { if (!board[c] && ((c / 3) | 0) === nearFoeRow(seat)) { cell = c; break } } } // ② 近敌行
        if (cell < 0) { for (let c = 0; c < 9; c++) if (!board[c]) { cell = c; break } }                                           // ③ 任意空格
        if (cell >= 0) {
          if (CARDS[id].tgt === 'freeze') { const t = foeTaunts[0] != null ? foeTaunts[0] : board.findIndex((m) => m && m.seat === foeSeat); if (t >= 0) return { op: { k: 'play', card: i, cell, tgt: { s: foeSeat, c: t } } } }
          else return { op: { k: 'play', card: i, cell } }
        }
      }
      /* 3. 技能火弹指英雄 */
      if (!me.powerUsed && me.manaCur >= 2 && me.hero === 0) return { op: { k: 'heroPower', tgt: { s: foeSeat, c: -1 } } }
      /* 4. 攻击：嘲讽强制解场，否则打脸 */
      for (let f = 0; f < 9; f++) {
        const m = board[f]
        if (!m || m.seat !== seat || !m.ready || m.frozen > 0) continue
        const ranged = m.ranged, row = (f / 3) | 0
        if (foeTaunts.length) {
          const ADJ = []
          if (row > 0) ADJ.push(f - 3); if ((f % 3) < 2) ADJ.push(f + 1); if (row < 2) ADJ.push(f + 3); if ((f % 3) > 0) ADJ.push(f - 1)
          for (const t of foeTaunts) if (ranged || ADJ.includes(t)) return { op: { k: 'attack', from: f, tgt: { s: foeSeat, c: t } } }
        } else if (!m.newly && (ranged || row === nearFoeRow(seat))) return { op: { k: 'attack', from: f, tgt: { s: foeSeat, c: -1 } } }
      }
      return { op: { k: 'endTurn' } }
    }
  })(),
  /**
   * 帝国速攻（empire-sprout A2 能赢，设计书 §6 剧本策略全貌）：
   * 查表 build order（t≈150 lumber → ≈350 farm → ≈550 camp，资源就绪门控）
   * → 循环 train camp inf n=5（队列空位即补）→ tick≥1800 且 CD 好：attack lane1 全池
   * → rally lane1 row10 起动态前导（集结线随战线前压 2 行）→ 池回 ≥8 再征。
   * S3 语义：建设 op 走 o 壳、战斗 cmd 走 c 壳（每次轮询至多一条）。
   */
  'empire-rush': (() => {
    const mem = { rally: -9 }   // 策略记忆（跨轮询持久；剧本单房单席无污染）
    return (state, seat) => {
      const NOOP = {}
      const s = state.build && state.build.seats[seat]
      if (!s) return NOOP
      const t = state.tick
      const res = { g: Math.floor(s.res.g / 1000), w: Math.floor(s.res.w / 1000), i: Math.floor(s.res.i / 1000) }
      const qn = s.queues.reduce((a, q) => a + q.n, 0)
      const pool = Object.values(s.pools).reduce((a, x) => a + x.length, 0)
      const plotOf = (kind) => s.plots.findIndex((p) => p && p.kind === kind)
      const freePlot = () => s.plots.findIndex((p) => !p)
      if (t >= 1800) {          // rally 动态前导（c 优先——爆发期集结线先于攒兵）
        let front = -1
        for (const u of state.battle.units) {
          if (u.seat !== seat || u.hp <= 0 || u.lane !== 1) continue
          const rr = (u.y / 25000) | 0
          if (front < 0 || rr < front) front = rr
        }
        const target = front < 0 ? 10 : Math.max(0, front - 2)
        if (Math.abs(target - mem.rally) >= 2) { mem.rally = target; return { c: { k: 'rally', lane: 1, row: target } } }
      }
      const COST = { lumber: { w: 30 }, farm: { w: 40 }, camp: { w: 60, i: 40 }, works: { w: 80, i: 60 } }
      for (const kind of ['lumber', 'farm', 'camp', 'works']) {   // 4 槽 6 选 4：军备线（§2.5a works→razor）
        if (plotOf(kind) >= 0) continue
        if (Object.entries(COST[kind]).every(([r, n]) => res[r] >= n) && freePlot() >= 0) {
          return { o: { k: 'build', plot: freePlot(), kind } }
        }
        break   // 严格顺序：当前目标建不起就攒资源等（防后位抢跑占槽）
      }
      if (t >= 1800 && s.marchCd <= 0 && pool >= 8) {
        const units = {}
        for (const c in s.pools) if (s.pools[c].length) units[c] = s.pools[c].length
        if (Object.keys(units).length) return { o: { k: 'attack', lane: 1, units } }
      }
      if (plotOf('camp') >= 0 && qn + pool < 12 && res.g >= 100) {
        // 军备线（§2.5a）：razor ×1.5 克制步海——inf:razor 2:1 混编（works 建成且铁够时）
        const nInf = s.pools.inf.length, nRaz = s.pools.razor.length
        if (plotOf('works') >= 0 && nRaz * 2 < nInf + qn && res.g >= 225 && res.i >= 90) {
          return { o: { k: 'train', kind: 'works', unit: 'razor', n: Math.min(5, 12 - pool - qn) } }
        }
        return { o: { k: 'train', kind: 'camp', unit: 'inf', n: Math.min(5, 12 - pool - qn) } }
      }
      return NOOP
    }
  })(),
}

/* ---------- snake-king S6 策略工厂（设计 §6 剧本策略：feed-grow/kill-hunt） ----------
 * S6 语义：a 连续模拟量每拍重发（心跳兼保活）、boost 高价值远点才带。
 * 避障=轨迹 rollout：同式积分（shared.cjs stepTurn/vOf，两端同式纯函数）预测 16 tick
 * 扫掠点，撞墙/贴身(<20px 含对方头外推 +2/4/6 tick)即否——不通畅时 ±30..180° 扫描
 * 候选航向取首个通畅者；觅食=争抢避让（180px 内更近他蛇头的光点不凑，防矿区扎堆）；
 * kill-hunt=近距伏击（250px 内出现 n<60% 己方猎物才切换，闭式拦截点；其余全程觅食）。 */
{
  let SK = null
  const sk = () => (SK || (SK = createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/snake-king/shared.cjs'))))
  const deg = (x1, y1, x2, y2) => Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
  const foePts = (state, seat) => {
    const pts = []
    for (const id in state.ents) {
      const e = state.ents[id]
      if (e.k !== 'snake' || e.seat === seat || e.dead) continue
      pts.push(e.x, e.y)
      const p = e.path || []
      for (let i = 0; i + 1 < p.length; i += 2) pts.push(p[i], p[i + 1])
      const K = sk(), v = K.vOf(e.n), r2 = e.a * Math.PI / 180 // 对方头外推（随机转向预警位）
      for (const dt of [2, 4, 6]) pts.push(e.x + Math.cos(r2) * v * dt, e.y + Math.sin(r2) * v * dt)
    }
    return pts
  }
  const steer = (state, seat, pickTarget) => {
    const me = state.ents && state.ents['s' + seat]
    if (!me || me.dead) return { a: 0, boost: 0 }
    const W = state.map ? state.map.w : 1800000, H = state.map ? state.map.h : 1800000
    const t = pickTarget(me, W, H)
    let a = ((deg(me.x, me.y, t.x, t.y) % 360) + 360) % 360
    let boost = t.far && me.n >= 16 ? 1 : 0 // 高价值远点冲刺（§2.3）
    const margin = 200000
    const rad0 = a * Math.PI / 180
    if ((me.x < margin && Math.cos(rad0) < 0) || (me.x > W - margin && Math.cos(rad0) > 0)
      || (me.y < margin && Math.sin(rad0) < 0) || (me.y > H - margin && Math.sin(rad0) > 0)) {
      a = ((deg(me.x, me.y, W / 2, H / 2) % 360) + 360) % 360 // 避墙：转向心
    }
    const K = sk()
    const pts = foePts(state, seat)
    const v = K.vOf(me.n), w = K.wOf(me.n)
    const rollOK = (target) => {
      let x = me.x, y = me.y, a2 = me.a
      for (let i = 0; i < 16; i++) {
        a2 = K.stepTurn(a2, target, w)
        x += Math.cos(a2 * Math.PI / 180) * v
        y += Math.sin(a2 * Math.PI / 180) * v
        if (x < 40000 || y < 40000 || x > W - 40000 || y > H - 40000) return false
        for (let j = 0; j < pts.length; j += 2) {
          if ((pts[j] - x) ** 2 + (pts[j + 1] - y) ** 2 < 20000 * 20000) return false
        }
      }
      return true
    }
    if (!rollOK(a)) {
      boost = 0 // 危险区禁 boost（ω×0.85 转向更差，§2.3）
      for (const off of [30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
        const cand = ((a + off) % 360 + 360) % 360
        if (rollOK(cand)) { a = cand; break }
      }
    }
    return { a: Math.round(((a % 360) + 360) % 360), boost }
  }
  const pickFood = (state, me) => {
    let best = null, bs = -1
    for (const id in state.ents) {
      const e = state.ents[id]
      let v = 0
      if ((e.k === 'grass' || e.k === 'berry' || e.k === 'ore') && e.on) v = { grass: 1, berry: 2, ore: 4 }[e.k]
      else if (e.k === 'drop') v = e.v || 2
      if (!v) continue
      const d = Math.hypot(e.x - me.x, e.y - me.y)
      if (e.k !== 'drop') { // 争抢避让：180px 内更近他蛇头的光点不凑（防扎堆对撞）
        let crowded = false
        for (const id2 in state.ents) {
          const o = state.ents[id2]
          if (o.k !== 'snake' || o.seat === me.seat || o.dead) continue
          if (Math.hypot(o.x - e.x, o.y - e.y) < Math.min(d, 180000)) { crowded = true; break }
        }
        if (crowded) continue
      }
      const s = v * 60000 / (d + 60000) * (e.k === 'drop' ? 1.6 : 1) // 尸体簇优先（§6）
      if (s > bs) { bs = s; best = e }
    }
    return best
  }
  POLICIES['feed-grow'] = (state, seat) => steer(state, seat, (me, W, H) => {
    const best = pickFood(state, me)
    if (best) return { x: best.x, y: best.y, far: (best.v || 0) >= 4 && Math.hypot(best.x - me.x, best.y - me.y) > 400000 }
    return { x: W / 2, y: H / 2 }
  })
  POLICIES['kill-hunt'] = (state, seat) => steer(state, seat, (me, W, H) => {
    /* 近距伏击（成体 n≥20）：250px 内出现 n<60% 己方猎物 → 闭式拦截点收口（§4 同式）；
       猎物游走使远距拦截扑空率高（实测 k=0），伏击+全程觅食底仓才是稳定击杀链路 */
    let prey = null, pd = Infinity
    if (me.n >= 20) {
      for (const id in state.ents) {
        const e = state.ents[id]
        if (e.k !== 'snake' || e.seat === seat || e.dead || (e.p || 0) > 0) continue
        if (e.n > me.n * 0.6) continue
        const d = Math.hypot(e.x - me.x, e.y - me.y)
        if (d < 250000 && d < pd) { pd = d; prey = e }
      }
    }
    if (prey) {
      const K = sk(), pv = K.vOf(prey.n)
      const t = Math.min(60, Math.max(5, pd / Math.max(2000, K.vOf(me.n) * 1.6 - pv)))
      return {
        x: Math.max(60000, Math.min(W - 60000, prey.x + Math.cos(prey.a * Math.PI / 180) * pv * t)),
        y: Math.max(60000, Math.min(H - 60000, prey.y + Math.sin(prey.a * Math.PI / 180) * pv * t)),
        far: false,
      }
    }
    const best = pickFood(state, me)
    if (best) return { x: best.x, y: best.y, far: (best.v || 0) >= 4 && Math.hypot(best.x - me.x, best.y - me.y) > 400000 }
    return { x: W / 2, y: H / 2 }
  })
}

/* ---------- 剧本局驱动：policy 注入直至终态 ---------- */
async function playScript(roomId, policy, deadlineMs, isS2 = false) {
  let cursor = 0, seq = 0 // S2：input.frame=客户端输入序号 seq（单调自 0，协议 §6 S2 声明）
  /* S6 取证账本（GAMES-99 §6 A6/A7/full20 断言源）：事件流水 + 快照带宽画像 + 排行榜抽样 */
  const ledger = []
  const snaps = { n: 0, full: 0, incrBytes: [], fullBytes: [] }
  let a6samples = 0, a6bad = 0, minSnakes = Infinity
  const collect = (st) => {
    const lb = st && st.leaderboard
    if (lb && lb.length) { // A6：top5 非增 && 榜首=全场 argmax（任意 tick 抽样）
      a6samples++
      let mono = true
      for (let i = 1; i < lb.length; i++) if (lb[i].score > lb[i - 1].score) mono = false
      let amax = -Infinity
      let snakes = 0
      for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'snake') { snakes++; if (e.score > amax) amax = e.score } }
      if (snakes < minSnakes) minSnakes = snakes
      if (!mono || lb[0].score < amax) a6bad++
    }
  }
  for (;;) {
    const r = await gwState(roomId, cursor)
    if (!r.json || !r.json.ok) return { error: r.json && r.json.error || `HTTP ${r.status}` }
    cursor = r.json.cursor
    for (const e of r.json.events || []) {
      const m = e.msg
      if (m && m.t === 'snapshot') {
        snaps.n++
        if (m.full) { snaps.full++; snaps.fullBytes.push(JSON.stringify(m).length) }
        else snaps.incrBytes.push(JSON.stringify(m).length)
        if (m.events) ledger.push(...m.events)
      }
    }
    if (r.json.phase === 'ended') {
      collect(r.json.state)
      return { result: r.json.result, tick: r.json.tick, state: r.json.state, stateHash: r.json.stateHash, ledger, snaps, a6samples, a6bad, minSnakes }
    }
    if (Date.now() > deadlineMs) return { error: '剧本超时未终局' }
    if (r.json.phase === 'live') {
      collect(r.json.state)
      const inp = policy(r.json.state, r.json.playerSeat)
      if (isS2) inp.frame = seq++
      const i = await gwInput(roomId, r.json.playerSeat, 'ctrl', inp)
      if (!i.json || !i.json.ok) return { error: i.json && i.json.error || `注入失败 HTTP ${i.status}` }
    }
    await sleep(POLL_MS)
  }
}

/* ---------- 主流程 ---------- */
const gameId = process.argv[2]
if (!gameId) {
  console.error('用法：node scripts/api-check.js <gameId>   （例：net-tank；剧本声明见 game.json net.api）')
  process.exit(2)
}
const tsStart = Date.now()

/* 游戏 game.json 定位与 net.api 校验 */
let meta = null, gameDir = null
for (const type of await readdir(join(ROOT, 'games'))) {
  if (type.startsWith('_') || type.startsWith('.')) continue
  try {
    const p = join(ROOT, 'games', type, gameId, 'game.json')
    meta = JSON.parse(await readFile(p, 'utf8'))
    gameDir = join(ROOT, 'games', type, gameId)
    break
  } catch { /* 换下一个类型目录 */ }
}
if (!meta) { console.error(`✗ 未找到 games/*/${gameId}/game.json`); process.exit(2) }
const api = meta.net && meta.net.api
if (!api || !api.script || !api.script.scenarios) {
  console.error(`✗ ${gameId} 缺 net.api 声明（ops/胜负终态/测试剧本，规范 docs/net-protocol.md §8）——不可 API 验证`)
  process.exit(2)
}
const script = api.script
const OPS = Object.keys(api.ops || {})
console.log(`api-check ${gameId}（${meta.title} · ${meta.net.tech} · ${meta.net.mode}）`)
console.log(`剧本：seed=${script.seed} timeScale=${script.timeScale}x ops=[${OPS.join(',')}] ctl=[${(api.ctlOps || []).join(',')}]`)

/* 网关验活 */
const health = await gw('GET', '/healthz').catch(() => null)
if (!health || !health.json || health.json.ok !== true) {
  console.error(`✗ 网关未运行或验活失败：${GW}/healthz（启动口径 docs/net-protocol.md §9）`)
  process.exit(2)
}
ok('P0', '网关在线', true, `${GW} rooms=${health.json.rooms}`)

/* ---------- L1 仅本机（测试面非回环 403） ---------- */
console.log('[L1] 测试面仅本机可用')
{
  const lan = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)[0]
  if (!lan) {
    ok('L1', '非回环访问拒绝', true, '无外网口，跳过（isLoopback 单测另证于 server/gateway/test.mjs [5]）')
  } else {
    const gwPort = new URL(GW).port || '80'
    const r = await gw('POST', '/api/test/room', { gameId, botLevels: [null] }, `http://${lan}:${gwPort}`)
      .catch((e) => ({ status: 0, err: String(e.message || e) }))
    ok('L1', '非回环访问 → 403 local-only', r.status === 403, r.status === 403 ? `经 ${lan}:${gwPort} 实测 403` : `status=${r.status}${r.err ? ' ' + r.err : ''}`)
  }
}

/* ---------- A1+A4+A5 冒烟局（win 配置的隔离房，一房三断言） ---------- */
console.log('[A1/A4/A5] 开始迁移 / 注入延迟 / 断线重连')
const isS2 = meta.net.tech === 'S2' || meta.net.tech === 'S3' || meta.net.tech === 'S6'   // S3（GAMES-68）/S6（GAMES-99）：注入带 seq、A4 走快照 ack 口径
const smokeCfg = { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: script.maxTicks, botLevels: script.scenarios.win.botLevels }
const tSmoke = Date.now()
let smoke = null, smokeEnd = { phase: null, tick: 0, seatKept: false, resumeMs: -1, reflMs: -1, startedSeen: false, welcome2Seen: false, feedLeak: false, tickAfter: 0 }
try {
  const created = await gw('POST', '/api/test/room', smokeCfg)
  smoke = created.json && created.json.ok ? created.json : null
  ok('A1', '建房（API 席自动入座）', !!smoke, smoke ? `roomId=${smoke.roomId.slice(0, 10)}… seat=${smoke.playerSeat} seed=${smoke.state.seed}` : `HTTP ${created.status} ${created.json && created.json.error}`)
  if (smoke) {
    ok('A1', 'boot 态 waiting + 席位就绪', smoke.phase === 'waiting' && smoke.seats.length === (meta.net.seats || smoke.seats.length)
      && smoke.seats[smoke.playerSeat].kind === 'human', `phase=${smoke.phase} seats=${smoke.seats.length}`)
    /* 隔离红线：测试房不得进大厅 feed */
    const feed = await gw('GET', '/api/matches')
    const leak = feed.json && feed.json.matches && feed.json.matches.some((m) => m.roomId === smoke.roomId)
    smokeEnd.feedLeak = !!leak
    ok('A1', '测试房不进大厅 feed（隔离）', !leak)
    /* boot → live */
    let s = smoke, cursor = smoke.cursor
    const liveDeadline = Date.now() + (smokeCfg.startDelayMs || 0) + 5000
    while (s.phase !== 'live' && Date.now() < liveDeadline) {
      await sleep(80)
      const r = await gwState(smoke.roomId, cursor)
      s = r.json; cursor = r.json.cursor
    }
    smokeEnd.startedSeen = (s.events || []).some((e) => e.msg.t === 'started')
    ok('A1', 'boot→live 状态迁移（开赛）', s.phase === 'live' && smokeEnd.startedSeen, `phase=${s.phase} started=${smokeEnd.startedSeen}`)
    if (meta.net.tech === 'S2') {
      /* S2 状态同步：welcome.state 全量世界（实体/碰撞表）+ 首张全量快照（设计 §6 A1） */
      const entN = smoke.state && smoke.state.ents ? Object.keys(smoke.state.ents).length : 0
      ok('A1', 'S2 welcome.state 含实体/碰撞表', entN > 0 && Array.isArray(smoke.state.collide) && smoke.state.collide.length > 0,
        `ents=${entN} collide=${smoke.state.collide && smoke.state.collide.length}`)
      const firstFull = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
        || await (async () => { // live 检测响应可能落在 started 与首张快照之间（1 tick 窗）——短暂轮询补看
          let r = s, c = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            r = q.json; c = q.json.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
          }
          return hit
        })()
      ok('A1', 'S2 首张全量快照（full=1）', !!firstFull,
        firstFull ? `snapSeq=${firstFull.msg.snapSeq} ents=${firstFull.msg.ents.length} aoi.r=${firstFull.msg.ext && firstFull.msg.ext.aoi && firstFull.msg.ext.aoi.r}` : '未见快照')
    } else if (meta.net.tech === 'S4') {
      /* S4 服务端权威物理（GAMES-78）：welcome.state 16 球固定阵型 + room.physics
         声明块（引擎版本护栏，设计 §5.1）——静止期无快照流是正常态（事件驱动） */
      const ballsN = smoke.state && Array.isArray(smoke.state.balls) ? smoke.state.balls.length : 0
      ok('A1', 'S4 welcome.state 含 16 球固定阵型', ballsN === 16 && !smoke.state.balls[8].pot && smoke.state.openTable === true,
        `balls=${ballsN} openTable=${smoke.state && smoke.state.openTable} turn=${smoke.state && smoke.state.turn}`)
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.physics)
      ok('A1', 'S4 room.physics 声明块（engine+hash）', !!wel && !!wel.msg.room.physics.engine && Number.isInteger(wel.msg.room.physics.hash),
        wel ? `${wel.msg.room.physics.engine}#${wel.msg.room.physics.hash}` : '未见声明块')
    } else if (meta.net.tech === 'S5') {
      /* S5 回合权威（GAMES-88）：welcome.state 牌局骨架（双英雄 24HP/9 格棋盘/牌组 20）
         + room.duel 声明块（引擎版本护栏，设计 §5.1）——手牌迷雾：己方牌面/对方张数（§5.3） */
      const hs = smoke.state && smoke.state.heroes
      ok('A1', 'S5 welcome.state 牌局骨架（双英雄 24HP）', !!(hs && hs.length === 2 && hs[0].hp === 24 && hs[1].hp === 24),
        `heroes=${hs && hs.length} hp=${hs && hs.map((h) => h.hp).join('/')}`)
      const bd = smoke.state && smoke.state.board, dk = smoke.state && smoke.state.decks
      ok('A1', 'S5 9 格棋盘 + 双牌组骨架（welcome 期未定型=防泄密，§5.3）',
        !!(Array.isArray(bd) && bd.length === 9 && Array.isArray(dk) && dk.length === 2 && dk[0].length === 0),
        `board=${bd && bd.length} decks(welcome)=${dk && dk.map((d) => d.length).join('/')}`)
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.duel)
      ok('A1', 'S5 room.duel 声明块（engine+hash）', !!wel && !!wel.msg.room.duel.engine && Number.isInteger(wel.msg.room.duel.hash),
        wel ? `${wel.msg.room.duel.engine}#${wel.msg.room.duel.hash}` : '未见声明块')
      /* 迷雾下发（§5.3 目录首款）：pick 期起手未发，viewFor(state, -1) 手牌双隐藏——
         live 后由 pick/mulligan 裁决流验证（A4 ruling.state.hand 视图） */
      /* GAMES-90 F1 修复回归：①反应表键=排序序（常量表逐键断言，QA 取证法固化）；
         ②迷雾 N+W/感电 T+W 两对死键行为触发实证（修复前永 miss）——离线直驱 sim，
         布邻接异系对→play W 系随从，断言 reaction 事件回流 */
      try {
        const rsim = createRequire(pathToFileURL(join(gameDir, 'sim.cjs')).href)
        const D = rsim(join(gameDir, 'sim.cjs'))
        const rk = Object.keys(D.REACTIONS)
        ok('A1', 'S5 REACTIONS 表键=系对字典序（F1 修复：W+N/W+T 死键清零）', rk.length === 6 && rk.every((k) => k === k.split('+').sort().join('+')), rk.join(','))
        const pairFire = (seed, baseId) => {
          const st = D.create(seed)
          D.applyOp(st, 0, { k: 'pick', hero: 2 }); D.applyOp(st, 1, { k: 'pick', hero: 3 })
          D.applyOp(st, 0, { k: 'mulligan', keep: [true, true, true] }); D.applyOp(st, 1, { k: 'mulligan', keep: [true, true, true, true, true] })
          st.heroes[0].manaCur = 3
          st.board[3] = { c: baseId, school: baseId[0], atk: 1, hp: 3, mhp: 3, seat: 0, ready: 0, newly: 1, frozen: 0, taunt: 0, ranged: 0, melee: 1 }
          st.hands[0] = ['W1']; st.outbox.length = 0
          D.applyOp(st, 0, { k: 'play', card: 0, cell: 4 }) // cell4 与 cell3 邻接 → W+{N|T} 触发
          return st.outbox.flat().find((e) => e && e.k === 'reaction') || null
        }
        const mist = pairFire(11, 'N1'), surge = pairFire(23, 'T1')
        ok('A1', 'S5 迷雾反应（N+W）部署触发（F1 修复前全目录死代码）', !!(mist && mist.rt === 'mist' && mist.pair === 'N+W'),
          mist ? `rt=${mist.rt} pair=${mist.pair}` : '未见反应事件')
        ok('A1', 'S5 感电反应（T+W）部署触发（F1 修复前全目录死代码）', !!(surge && surge.rt === 'surge' && surge.pair === 'T+W'),
          surge ? `rt=${surge.rt} pair=${surge.pair}` : '未见反应事件')
      } catch (e) { ok('A1', 'S5 反应表/触发断言', false, '挂具异常：' + e.message) }
    } else if (meta.net.tech === 'S3') {
      /* S3 混合同步（GAMES-68）：welcome.state 双层（build 资源/建筑位 + battle 空态墙/心）
         + 首张建设快照（ext.layer='build'，设计 §6 A1）——静默期无战斗帧是正常态（附决策 1） */
      const bs = smoke.state && smoke.state.build, bt = smoke.state && smoke.state.battle
      ok('A1', 'S3 welcome.state 双层（build+battle）',
        !!(bs && Array.isArray(bs.seats) && bs.seats.length && bs.seats[0].res && bs.seats[0].plots
          && bt && Array.isArray(bt.bld) && bt.bld.length === 4 && bt.bld[0].hp > 0),
        `build.seats=${bs && bs.seats.length} battle.bld=${bt && bt.bld.length} 墙HP=${bt && bt.bld[0] && bt.bld[0].hp}`)
      const firstBuild = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1 && e.msg.ext && e.msg.ext.layer === 'build')
        || await (async () => { // 25ms 窗竞态先例：live 检测响应可能落在 started 与首张快照之间——短轮询补看
          let r = s, c = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            r = q.json; c = q.json.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1 && e.msg.ext && e.msg.ext.layer === 'build')
          }
          return hit
        })()
      ok('A1', 'S3 首张建设快照（layer=build, full=1）', !!firstBuild,
        firstBuild ? `snapSeq=${firstBuild.msg.snapSeq} frame=${firstBuild.msg.frame} ents=${firstBuild.msg.ents.length}` : '未见建设快照')
    } else if (meta.net.tech === 'S6') {
      /* S6 海量实体（GAMES-99）：welcome.state 竞技场骨架（round 相位/排行榜/资源位）
         + room.snake 声明块（碰撞口径护栏，S4 physics/S5 duel 同范式）；
         live 后秒配 20 实体（bot 19+API 1）——「快照 ents ≥20 蛇」按全量 state 口径
         断言（AOI 快照按 r(n) 过滤，同屏本就 <20，§5.2），首张全量快照另证。 */
      const rd = smoke.state && smoke.state.round, lb = smoke.state && smoke.state.leaderboard
      let siteN = 0
      for (const id in (smoke.state && smoke.state.ents || {})) { const k = smoke.state.ents[id].k; if (k === 'grass' || k === 'berry' || k === 'ore') siteN++ }
      ok('A1', 'S6 welcome.state 竞技场骨架（round 相位/排行榜/180 资源位）',
        !!(rd && rd.n >= 1 && Array.isArray(lb) && siteN === 180),
        `round=${rd && rd.n}-${rd && rd.tick} lb=${lb && lb.length} sites=${siteN}`)
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.snake)
      ok('A1', 'S6 room.snake 声明块（engine+碰撞口径+实体三顶）',
        !!wel && !!wel.msg.room.snake.engine && wel.msg.room.snake.hitR === 14 && wel.msg.room.snake.cap.snake === 24,
        wel ? `${wel.msg.room.snake.engine}#${wel.msg.room.snake.v} hitR=${wel.msg.room.snake.hitR} cap=${JSON.stringify(wel.msg.room.snake.cap)}` : '未见声明块')
      let snakeN = 0, s6 = s, c6 = cursor
      const t6 = Date.now()
      while (snakeN < 20 && Date.now() - t6 < 2000) { // live→首 tick 席位自愈有 1 tick 竞态：短轮询补看
        for (const id in (s6.state && s6.state.ents || {})) if (s6.state.ents[id].k === 'snake') snakeN++
        if (snakeN >= 20) break
        await sleep(50)
        const q = await gwState(smoke.roomId, c6)
        if (!q.json) break
        s6 = q.json; c6 = q.json.cursor
      }
      ok('A1', 'S6 秒配 20 实体（live 后全场蛇数 ≥20）', snakeN >= 20, `snakes=${snakeN}`)
      const firstFull6 = (s6.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
        || await (async () => {
          let r = s6, c = c6, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            if (!q.json) break
            r = q.json; c = r.json.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
          }
          return hit
        })()
      ok('A1', 'S6 首张全量快照（full=1，AOI 过滤）', !!firstFull6,
        firstFull6 ? `snapSeq=${firstFull6.msg.snapSeq} ents=${firstFull6.msg.ents.length} aoi.r=${firstFull6.msg.ext && firstFull6.msg.ext.aoi && firstFull6.msg.ext.aoi.r}` : '未见快照')
    }
    /* A4 注入 → 帧反映（服务端同钟：receivedAt → 帧广播 ts）。
       S2：注入带 seq（input.frame=输入序号），快照 ext.ack ≥ seq 即证明已处理（§6 A4）。
       S4：注入 shot op → 首张球动期 snapshot（ext.physics，≤10 tick/100ms，§6 A4）。 */
    const injPayload = isS2 && meta.net.tech !== 'S6' ? { mx: 63, my: 0, fire: 0, frame: 1 }
      : meta.net.tech === 'S6' ? { a: 90, boost: 0, frame: 1 }
      : meta.net.tech === 'S4' ? { op: { k: 'shot', ang: 0, pow: 700, spinV: 0, spinS: 0 } }
      : meta.net.tech === 'S5' ? { op: { k: 'pick', hero: 0 } }
      : { mx: 63, my: 0, fire: 0 }
    const inj = await gwInput(smoke.roomId, smoke.playerSeat, 'ctrl', injPayload)
    const receivedAt = inj.json && inj.json.receivedAt
    let refl = null, r4 = s, c4 = cursor
    const t4 = Date.now()
    while (!refl && Date.now() - t4 < 3000) {
      const r = await gwState(smoke.roomId, c4)
      r4 = r.json; c4 = r.json.cursor
      refl = isS2
        ? (r4.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.ext && Number(e.msg.ext.ack) >= 1)
        : meta.net.tech === 'S4'
          ? (r4.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.ext && e.msg.ext.physics)
          : meta.net.tech === 'S5'
            ? (r4.events || []).find((e) => e.msg.t === 'ruling' && e.ts >= receivedAt
                && (e.msg.events || []).some((v) => (v.k === 'pick' && v.s === smoke.playerSeat) || (v.k === 'reject' && v.seat === smoke.playerSeat)))
            : (r4.events || []).find((e) => e.msg.t === 'frame' && e.msg.inputs && e.msg.inputs[smoke.playerSeat] && e.msg.inputs[smoke.playerSeat].mx === 63)
      if (!refl) await sleep(30)
    }
    smokeEnd.reflMs = refl ? refl.ts - receivedAt : -1
    ok('A4', `操作注入→${isS2 ? '快照 ack 反映' : meta.net.tech === 'S5' ? 'ruling 回执' : '帧反映'} <100ms`, !!refl && smokeEnd.reflMs < 100, smokeEnd.reflMs >= 0 ? `实测 ${smokeEnd.reflMs}ms（timeScale=${smokeCfg.timeScale}x）` : '3s 内未见反映')
    if (meta.net.tech === 'S5') {
      /* S5 双席 pick 齐 → mulligan 起手发放：deckSeed 双流派生（§5.5 单据指定断言）；
         发牌后 deck=20−3/20−4 张、起手 3/5（后手含微粒）——牌序由 deckSeed 派生 */
      let st5 = r4.json, c5 = c4, dealt = null
      const t5 = Date.now()
      while (!dealt && Date.now() - t5 < 4000) {
        const q = await gwState(smoke.roomId, c5)
        st5 = q.json; c5 = q.json.cursor
        const s5 = st5 && st5.state
        if (s5 && s5.phase === 'mulligan' && s5.hands[0].length === 3) dealt = s5
        else await sleep(60)
      }
      ok('A1', 'S5 pick 齐→mulligan 起手发放（先手 3/后手 4+微粒，deckSeed 派生）',
        !!(dealt && dealt.phase === 'mulligan' && dealt.hands[0].length === 3 && dealt.hands[1].length === 5 && dealt.decks[0].length === 17 && dealt.decks[1].length === 16),
        dealt ? `phase=${dealt.phase} hands=${dealt.hands.map((h) => h.length).join('/')} decks=${dealt.decks.map((d) => d.length).join('/')}` : '4s 内未见发牌')
    }
    const tGet0 = Date.now()
    await gwState(smoke.roomId, 0)
    ok('A4', '状态快照 GET 往返 <100ms', Date.now() - tGet0 < 100, `${Date.now() - tGet0}ms`)
    /* A5 断开重连（10s 窗内凭 token 复席续玩） */
    const dis = await gwInput(smoke.roomId, smoke.playerSeat, '$disconnect')
    const disAt = dis.json && dis.json.disconnectedAt
    await sleep(1200)
    const mid = await gwState(smoke.roomId)
    smokeEnd.seatKept = mid.json && mid.json.seats && mid.json.seats[smoke.playerSeat].kind === 'human'
    ok('A5', '断线期席位保留（10s 窗，未转 bot）', smokeEnd.seatKept, `seat kind=${mid.json && mid.json.seats[smoke.playerSeat].kind}`)
    const tickBefore = mid.json ? mid.json.tick : 0
    const rec = await gwInput(smoke.roomId, smoke.playerSeat, '$reconnect', { token: smoke.token })
    const resumedAt = rec.json && rec.json.resumedAt
    smokeEnd.resumeMs = resumedAt && disAt ? resumedAt - disAt : -1
    const rAfter = await gwState(smoke.roomId)
    smokeEnd.welcome2Seen = (rAfter.json.events || []).some((e) => e.msg.t === 'welcome' && e.msg.role === 'player' && e.msg.seat === smoke.playerSeat)
    ok('A5', '凭 token 复席 + 全量 state 重同步', rec.json && rec.json.ok && rec.json.seat === smoke.playerSeat && smokeEnd.welcome2Seen,
      `resume=${smokeEnd.resumeMs}ms welcome=重同步下发`)
    await sleep(1000)
    const fin = await gwState(smoke.roomId)
    smokeEnd.tickAfter = fin.json ? fin.json.tick : 0
    ok('A5', '重连后状态恢复续玩（帧继续推进）', smokeEnd.tickAfter > tickBefore || (fin.json && fin.json.phase === 'ended'),
      `tick ${tickBefore}→${smokeEnd.tickAfter}${fin.json && fin.json.phase === 'ended' ? '（恰逢终局）' : ''}`)
    ok('A5', '断线→复席全程 <10s（红线窗）', smokeEnd.resumeMs >= 0 && smokeEnd.resumeMs < 10_000, `${smokeEnd.resumeMs}ms`)
    smokeEnd.phase = fin.json ? fin.json.phase : null
    smokeEnd.tick = smokeEnd.tickAfter
  }
} finally {
  if (smoke) await gw('DELETE', '/api/test/room', { roomId: smoke.roomId }).catch(() => {})
}

/* ---------- A2 能赢 / A3 能输（剧本局；额外剧本名以 A+ 标注；S4 deterministic 双跑） ---------- */
for (const [name, sc] of Object.entries(script.scenarios)) {
  const aid = name === 'win' ? 'A2' : name === 'lose' ? 'A3' : `A+(${name})`
  console.log(`[${aid}] 剧本局 ${name}（policy=${sc.policy}，期望胜方 ${sc.expectWinner}${sc.runs ? ` ×${sc.runs} runs` : ''}）`)
  const t0 = Date.now()
  let room = null
  try {
    /* S4 确定性双跑（GAMES-78 A6，设计 §6）：同 seed 同策略两房——
       ① 两 run 终态 stateHash 相等；② 输入日志（shot 序列，剥 frame 墙钟字段）逐字节相等；
       ③ 在线终态 == 回放器重放（本地引 sim.cjs 跑 replayShots，S4 红线首证）。 */
    if (sc.runs && sc.runs > 1) {
      const runs = []
      for (let ri = 0; ri < sc.runs; ri++) {
        const created = await gw('POST', '/api/test/room', { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: script.maxTicks, botLevels: sc.botLevels })
        const rr = created.json && created.json.ok ? created.json : null
        if (!rr) { ok(aid, `${name} 建房 run${ri + 1}`, false, `HTTP ${created.status}`); break }
        const tickMs = (rr.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
        const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
        const played = await playScript(rr.roomId, POLICIES[sc.policy || 'idle'] || POLICIES.idle, Date.now() + budgetMs, isS2)
        await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
        if (!played.result) { ok(aid, `${name} run${ri + 1} 达成终态`, false, played.error || '未终局'); break }
        runs.push(played)
      }
      if (runs.length === sc.runs) {
        /* S5 输入日志（§5.6）：{s,k,payload}（剥 tick/tn 墙钟字段）——picks+ops 逐字节断言 */
        const stripFrame = meta.net.tech === 'S5'
          ? (st) => JSON.stringify((st.opsLog || []).map((o) => { const { s, k, tn, ...rest } = o; return [s, k, rest] }))
          : (st) => JSON.stringify((st.shots || []).map((x) => [x.no, x.seat, x.ang, x.pow, x.spinV, x.spinS, x.cue.x, x.cue.y]))
        const hash0 = runs[0].stateHash, log0 = stripFrame(runs[0].state)
        const hashesEq = runs.every((x) => x.stateHash === hash0)
        const logsEq = runs.every((x) => stripFrame(x.state) === log0)
        ok(aid, `${name}：同 seed 同策略两房终态 stateHash 相等`, hashesEq, `hash=${hash0}${hashesEq ? '' : ' 各房不一：' + runs.map((x) => x.stateHash).join('/')}`)
        ok(aid, `${name}：输入日志（${meta.net.tech === 'S5' ? 'picks+ops' : 'shot 序列'}）逐字节相等`, logsEq, `${JSON.parse(log0).length} 条${logsEq ? '' : '（序列不一致）'}`)
        let replayOk = false, replayDetail = '未找到可回放 sim'
        try {
          const req = createRequire(pathToFileURL(join(gameDir, 'sim.cjs')).href)
          const sim = req(join(gameDir, 'sim.cjs'))
          if (meta.net.tech === 'S5' && sim && sim.replayOps && sim.hashState) {
            const ops = runs[0].state.opsLog.map((o) => { const { s, k, tn, ...rest } = o; void tn; return Object.assign({ s, k }, rest) })
            const rp = sim.replayOps(script.seed, ops, script.maxTicks)
            replayOk = sim.hashState(rp) === runs[0].stateHash
            replayDetail = replayOk ? `replay==在线 stateHash（${sim.hashState(rp)}）` : `replay ${sim.hashState(rp)} ≠ 在线 ${runs[0].stateHash}`
          } else if (sim && sim.replayShots && sim.hashRules) {
            const rp = sim.replayShots(script.seed, runs[0].state.shots, script.maxTicks)
            replayOk = sim.hashRules(rp) === runs[0].state.restHash
            replayDetail = replayOk ? `replay==在线 restHash（${sim.hashRules(rp)}）` : `replay ${sim.hashRules(rp)} ≠ 在线 ${runs[0].state.restHash}`
          }
        } catch (e) { replayDetail = `回放器加载失败：${e.message}` }
        ok(aid, `${name}：在线终态 == 回放器重放（${meta.net.tech} 确定性首证）`, replayOk, replayDetail)
      }
      continue
    }
    const created = await gw('POST', '/api/test/room', { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: script.maxTicks, botLevels: sc.botLevels })
    room = created.json && created.json.ok ? created.json : null
    if (!room) { ok(aid, `${name} 建房`, false, `HTTP ${created.status} ${created.json && created.json.error}`); continue }
    const tickMs = (room.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
    const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
    const policy = POLICIES[sc.policy || 'idle'] || POLICIES.idle
    const r = await playScript(room.roomId, policy, Date.now() + budgetMs, isS2)
    const durMs = Date.now() - t0
    if (!r.result) {
      ok(aid, `${name} 达成终态`, false, r.error || '未终局')
    } else {
      const winnerOk = r.result.winner === sc.expectWinner
      const teams = (api.endState && api.endState.teams) || meta.net.teams
      const myTeam = teams && Object.entries(teams).find(([, seats]) => seats.includes(room.playerSeat))
      const detail = `winner=${r.result.winner}（期望 ${sc.expectWinner}） reason=${r.result.reason} scores=${JSON.stringify(r.result.scores)} tick=${r.tick}${myTeam ? ` API 席属 ${myTeam[0]} 队` : ''} ${durMs}ms`
      if (aid === 'A2') ok('A2', '能赢：剧本胜方达成终态（' + r.result.reason + '）', winnerOk, detail)
      else if (aid === 'A3') ok('A3', '能输：剧本败方终态达成（' + r.result.reason + '）', winnerOk, detail)
      else ok(aid, `${name}：期望胜方达成终态`, winnerOk, detail)
      /* S6 专项断言（GAMES-99 §6）：A2 n≥100 实测锚 / A6 排行榜 / A7 击杀链路 / full20 四断言 */
      if (meta.net.tech === 'S6') {
        const meEnd = r.state && r.state.ents && r.state.ents['s' + room.playerSeat]
        if (name === 'win') ok('A2', 'S6 成长曲线实测锚（轮末 n≥100）', !!(meEnd && meEnd.n >= 100), meEnd ? `n=${meEnd.n} score=${meEnd.score} kills=${meEnd.kills}` : '未见 API 蛇')
        ok(aid, 'S6 A6 排行榜一致（top5 非增+榜首=argmax，全程抽样）', r.a6bad === 0 && r.a6samples > 50, `${r.a6samples} 次抽样 ${r.a6bad} 违例`)
        if (name === 'hunt') {
          const kills = r.ledger.filter((e) => e.k === 'kill')
          const dies = r.ledger.filter((e) => e.k === 'die')
          ok('A7', 'S6 击杀链路：事件账本 {k:kill} ≥1', kills.length >= 1, `kill×${kills.length} die×${dies.length}`)
          const bad = dies.filter((e) => e.drops !== Math.ceil(e.len / 2))
          ok('A7', 'S6 die.drops==ceil(victimLen/2)（T6-B 掉落公式）', dies.length > 0 && bad.length === 0,
            `${dies.length} 例全对（首例 len=${dies[0] && dies[0].len} drops=${dies[0] && dies[0].drops}）`)
        }
        if (name === 'full20') {
          const avgIncr = r.snaps.incrBytes.length ? Math.round(r.snaps.incrBytes.reduce((a, x) => a + x, 0) / r.snaps.incrBytes.length) : 0
          const fullRatio = r.snaps.n ? +(r.snaps.full / r.snaps.n * 100).toFixed(1) : 100
          const myDies = r.ledger.filter((e) => e.k === 'die' && e.seat === room.playerSeat).length
          ok(aid, 'S6 full20：全场任意 tick 蛇数 ≥20', r.minSnakes >= 20, `min=${r.minSnakes}`)
          ok(aid, 'S6 full20：快照账本增量均 ≤850B/全量占比 ≤8%', avgIncr <= 850 && fullRatio <= 8, `增量均 ${avgIncr}B（n=${r.snaps.incrBytes.length}）/全量 ${fullRatio}%`)
          ok(aid, 'S6 full20：存活到轮末（API 席 death ≤3）', myDies <= 3, `deaths=${myDies}`)
        }
      }
    }
  } finally {
    if (room) await gw('DELETE', '/api/test/room', { roomId: room.roomId }).catch(() => {})
  }
}

/* ---------- 报告落盘 + 汇总 ---------- */
const report = {
  tool: 'api-check', spec: 1, gameId, title: meta.title,
  tech: meta.net.tech, gw, ts: tsStart, durationMs: Date.now() - tsStart,
  script, ops: OPS,
  smoke: smokeEnd,
  checks,
  summary: { passed, failed, exitCode: failed === 0 ? 0 : 1 },
}
try {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  const stamp = new Date(tsStart).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  await writeFile(join(EVIDENCE_DIR, `api-check-${gameId}-${stamp}.json`), JSON.stringify(report, null, 2))
  await writeFile(join(EVIDENCE_DIR, `api-check-${gameId}-latest.json`), JSON.stringify(report, null, 2))
  console.log(`\n报告：${EVIDENCE_DIR}/api-check-${gameId}-${stamp}.json`)
} catch (e) {
  console.error(`\n报告落盘失败：${e.message}`)
  failed++
}
console.log(`${failed === 0 ? 'API-CHECK OK' : 'API-CHECK FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
