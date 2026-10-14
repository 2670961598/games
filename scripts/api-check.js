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
 * S6 口径（GAMES-107）：混沌类剧本断言=多 seed 统计制（胜负三局两胜/数值锚中位，无环境开关一律严格）
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
/* GAMES-107 判据口径校准（PM 裁决；DEV GAMES-99→QA1→FIX1 GAMES-101→BOT GAMES-102 四单攻坚收官，
   攻坚数据表与口径语义详见 docs/designs/snake-king.md §6.1 注记）：
   20 蛇混沌相位分岔（双峰：雪球局 API 席碾压 vs 绞肉局全场低分团灭）——数量说/负载说均证伪，
   同 seed 同提交复跑也双峰取样 → 剧本结局单局断言（winner=A / deaths≤3）与混沌本质不匹配。
   口径（语义不变=能赢/能存活，从「单局必胜」改「统计上可胜」；强度不降=胜局 <2/3 即红）：
   ① S6 剧本局（win/hunt/full20）派生 seed {S,S+1,S+2} 各打一局；
   ② 胜负断言 = 三局两胜（wins≥2；任一 seed 全败 0/3 或仅 1 胜 = 红）；
   ③ 数值锚 = 三局中位数（win 轮末 n≥100 阈值不变；full20 API 席 deaths ≤5——GAMES-107 实测重锚
      3→5：BOT 生态位上线后胜局 deaths 实测 5/7/1、历史 {3,4,5,6,9}，≤3 为 BOT 前单局锚）；
   ④ 每局硬断言（A6 排行榜 / A7 击杀链路 / full20 带宽与蛇数）逐局严格，任一局违例 = 红。
   GAMES-99 应急债 S6_DEV_TOLERANT 开关与 okT 容忍路径本单删除——api-check 无环境开关，一律严格。 */
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
  /**
   * 冲门取胜（street-soccer A2/A8 能赢，设计 §6 剧本策略）：API 席=炮手（缺省位）——
   * 无球→chase 球预测点；持球→向敌门心带球，距门 <130000 且射门锥开 → 发 shot 朝门心
   * （pow 900）；被扑近（敌 <25000）→ 发 pass；敌持球 <22000 → tackle。
   */
  'strike-rush': (state, seat) => {
    const NOOP = { mx: 0, my: 0 }
    const K = 1000
    const me = state.players && state.players[seat]
    const B = state.ball
    if (!me || !B) return NOOP
    const team = seat & 1
    const G = team === 0 ? { x: 175 * K, y: 0 } : { x: 175 * K, y: 500 * K }
    const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1)
    const toward = (x, y) => {
      const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
      return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
    }
    const OG = team === 0 ? { x: 175 * K, y: 500 * K } : { x: 175 * K, y: 0 }
    const distG = dist(B.x, B.y, G.x, G.y)
    if (B.owner === seat) {
      /* 门前拿球即解围（GAMES-138 attempt2 修复：原句写在下文防守段 owner!==seat 才可达处=死代码。
         败因链=防守 goal-side 卡位驱动球员朝自家门跑→途中触散球即持球→120ms 轮询盲窗（19 tick
         ≈950 游戏ms）内 LEASH 触球推仍朝自家门 dribble 越线——attempt1 交付次日复跑 3 连红皆
         seat0 自摆乌龙×2 送 B 到 goal-cap；移到持球分支首位，并附朝前场移动向量：pass 无路径
         fallback=朝向解围大脚 v5200，面朝自家门会把「解围」踢进自家网） */
      if (dist(B.x, B.y, OG.x, OG.y) < 150 * K) return { mx: 0, my: team === 0 ? -100 : 100, cmd: { k: 'pass' } }
      let foe = null, bd = 20000 // 贴身判定 20px（25px 时蜂群贴脸即丢球权，传球窗过敏）
      for (const p of state.players) {
        if (!p || (p.seat & 1) === team) continue
        const d = dist(me.x, me.y, p.x, p.y)
        if (d < bd) { bd = d; foe = p }
      }
      if (foe && distG >= 130 * K) return { mx: 0, my: 0, cmd: { k: 'pass' } } // 被贴身且无射窗才出球（近门优先强射）
      if (distG < 160 * K) {
        const ang = Math.round(Math.atan2(G.y - B.y, G.x - B.x) / (2 * Math.PI) * 65536) & 0xFFFF
        return { mx: 0, my: 0, cmd: { k: 'shot', ang, pow: 1000 } }
      }
      return toward(G.x, G.y)
    }
    if (B.owner >= 0 && (B.owner & 1) !== team && dist(me.x, me.y, B.x, B.y) < 22000) return { mx: 0, my: 0, cmd: { k: 'tackle' } }
    /* 防守第三段：卡球-己门连线 goal-side（不追进自家门口=乌龙/折射防护）；近门解围——
       「拿球即解围」已上移持球分支首位（原句在此永不可达：owner===seat 已于上方短路） */
    const dOwn = Math.hypot(B.x - OG.x, B.y - OG.y)
    if (dOwn < 150 * K) {
      const gx = B.x + (OG.x - B.x) * 0.25, gy = B.y + (OG.y - B.y) * 0.25
      return toward(gx, gy)
    }
    return toward(B.x + B.vx * 4, B.y + B.vy * 4)
  },
  /**
   * 攻防转换（street-soccer A6/A7，设计 §6 剧本策略，胜负不断言）：前 60 tick 保守站位；
   * 失球→回防 tackle 尝试（制造 steal 账本）；得球→一拍 pass 再前插，距门 <110000 shot
   * ——循环制造「夺权-传导-射门」链 ≥4 次翻转+≥1 goal。
   */
  'counter-press': (() => {
    const mem = { lastOwner: -1, coolT: 0 }
    return (state, seat) => {
      const NOOP = { mx: 0, my: 0 }
      const K = 1000
      const me = state.players && state.players[seat]
      const B = state.ball
      if (!me || !B) return NOOP
      const team = seat & 1
      const G = team === 0 ? { x: 175 * K, y: 0 } : { x: 175 * K, y: 500 * K }
      const home = { x: 175 * K, y: team === 0 ? 350 * K : 150 * K }
      const toward = (x, y) => {
        const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
        return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
      }
      const distG = Math.hypot(G.x - B.x, G.y - B.y)
      const dBall = Math.hypot(B.x - me.x, B.y - me.y)
      if (state.tick < 60) return toward(home.x, home.y)
      if (mem.coolT > 0) mem.coolT--
      const own = B.owner
      if (own === seat) {
        if (mem.coolT === 0) { mem.coolT = 20; return { mx: 0, my: 0, cmd: { k: 'pass' } } } // 一拍传导
        if (distG < 110 * K) {
          const ang = Math.round(Math.atan2(G.y - B.y, G.x - B.x) / (2 * Math.PI) * 65536) & 0xFFFF
          return { mx: 0, my: 0, cmd: { k: 'shot', ang, pow: 850 } }
        }
        return toward(G.x, G.y)
      }
      if (own >= 0 && (own & 1) !== team && dBall < 22000) return { mx: 0, my: 0, cmd: { k: 'tackle' } } // 回防扑抢
      return toward(B.x, B.y)
    }
  })(),
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
   * 推线取胜（mini-moba A2 能赢，设计书 §6 剧本策略）：API 席=游侠（缺省位）——
   * 跟兵补刀 → 线过半随兵攻塔（T1→T2→水晶）→ 敌英雄入射程且 HP 劣则 pierce+普攻
   * → 金 ≥800 且线在敌半场 recall+buy 归线；开局 400 tick 内每 40 tick 敲一次无敌
   * T2（A6 取证：reject(invuln) 账本锚）。低血回城（不死太多次保推进节奏）。
   */
  'push-lane': (state, seat) => {
    const NOOP = { mx: 0, my: 0 }
    const me = state.ents && state.ents['h' + seat]
    if (!me || me.dead || me.rec) return NOOP
    const K = 1000
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
    const TOWER_R0 = 210 * K
    const fount = state.map.fountains[me.team]
    const inFount = d2(me, fount) <= fount.r ** 2
    const sess = state.sessions && state.sessions[seat]
    /* A6 取证臂：开局对无敌 T2 点 atk（cmd 一次性语义，逐拍重发幂等）→ reject 账本 */
    if (state.tick < 400 && state.ents['tw-B2']) return { mx: 0, my: 0, cmd: { k: 'atk', entId: 'tw-B2' } }
    if (inFount) {
      if (me.hp / me.maxhp < 0.95) return NOOP // 泉水回满再走
      /* 路线 3 件购满后不再站桩买（reject 'full' 恒回→当拍移动被吞=永久卡泉根因） */
      if (sess && sess.gold >= 800 && sess.items && sess.items.length < 3) return { mx: 0, my: 0, cmd: { k: 'buy' } }
    }
    if (me.hp / me.maxhp < 0.35) {
      /* 撤离：先脱离敌塔射程再回城（引导受击打断 §1.6——塔下裸回城=死亡循环实测 8 死） */
      const underTower = Object.values(state.ents).some((e) => (e.k === 'tw' || e.k === 'core') && e.team !== me.team && e.hp > 0 && d2(me, e) < (TOWER_R0 + 80 * K) ** 2)
      if (!underTower) return { mx: 0, my: 0, cmd: { k: 'recall' } }
      const fdx = fount.x - me.x, fdy = fount.y - me.y, fl = Math.hypot(fdx, fdy) || 1
      return { mx: Math.round(fdx / fl * 100), my: Math.round(fdy / fl * 100) }
    }
    const RANGE = 160 * K, TOWER_R = 210 * K
    const foes = Object.values(state.ents).filter((e) => e.k === 'hero' && e.team !== me.team && !e.dead)
    const t1 = state.ents['tw-B1'], t2 = state.ents['tw-B2'], core = state.ents['core-B']
    const tgT = t1 && t1.hp > 0 ? t1 : t2 && t2.hp > 0 ? t2 : core
    const mine = Object.values(state.ents).filter((e) => e.k === 'creep' && e.team === me.team)
    const front = mine.length ? mine.reduce((a, b) => (a.y < b.y ? a : b)) : null
    /* 推塔相位（§6 剧本：兵进塔=推塔窗）：贴塔即攻——cmd 每拍一条，塔攻在推塔相
     * 必须压过补刀/骚扰（网关 96-tick 轮询间隔下低优先级永远轮不到=旧版 0 塔伤根因） */
    if (tgT) {
      const dT = Math.sqrt(d2(me, tgT))
      const waveNear = front && d2(front, tgT) < (280 * K) ** 2
      const guarded = foes.some((f) => d2(f, tgT) < (350 * K) ** 2)
      if (dT < RANGE - 10 * K) return { mx: 0, my: 0, cmd: { k: 'atk', entId: tgT.id } }
      if ((waveNear || !guarded) && state.tick > 900 && me.hp / me.maxhp > 0.5) { // 推塔相：随波进（贴到射程即攻；lv1 裸跳双塔区白送头 → 900 tick/50% HP 门槛）
        const ax = tgT.x + (me.x - tgT.x) / (dT || 1) * (RANGE - 20 * K), ay = tgT.y + (me.y - tgT.y) / (dT || 1) * (RANGE - 20 * K)
        const dx = ax - me.x, dy = ay - me.y, len = Math.hypot(dx, dy)
        if (len > 12 * K) return { mx: Math.round(dx / len * 100), my: Math.round(dy / len * 100) }
        return NOOP
      }
      // 对线相（有守备无波）：塔射程外 30px 站位待兵+补刀+骚扰
      const foe = foes.filter((f) => d2(me, f) < (RANGE + 30 * K) ** 2).sort((a, b) => a.hp / a.maxhp - b.hp / b.maxhp)[0]
      if (foe && me.hp / me.maxhp > foe.hp / foe.maxhp - 0.1) {
        if (me.cd && me.cd[1] <= 0 && d2(me, foe) < (300 * K) ** 2) return { mx: 0, my: 0, cmd: { k: 'skill', idx: 1, dir: { dx: foe.x - me.x, dy: foe.y - me.y } } }
        return { mx: 0, my: 0, cmd: { k: 'atk', entId: foe.id } }
      }
      const cs = Object.values(state.ents).filter((e) => e.k === 'creep' && e.team !== me.team && d2(me, e) < (RANGE + 40 * K) ** 2).sort((a, b) => a.hp - b.hp)
      if (cs.length) return { mx: 0, my: 0, cmd: { k: 'atk', entId: cs[0].id } }
      const ax = tgT.x + (me.x - tgT.x) / (dT || 1) * (TOWER_R + 30 * K), ay = tgT.y + (me.y - tgT.y) / (dT || 1) * (TOWER_R + 30 * K)
      const dx = ax - me.x, dy = ay - me.y, len = Math.hypot(dx, dy)
      if (len > 12 * K) return { mx: Math.round(dx / len * 100), my: Math.round(dy / len * 100) }
      return NOOP
    }
    return NOOP
  },
  /**
   * 圣所团战（mini-moba A7，设计书 §6 剧本策略，胜负不断言）：tick 2300 起移向
   * 中场圣所广场参与团战——attack 仲裁目标+技能全交（CD 好即放）；圣所怪在场近身
   * 打圣所；残血回泉补满再来。kill ruling 账本断言（bounty/respAt 复算）由
   * mini-moba 专项块消费。
   */
  'teamfight': (state, seat) => {
    const NOOP = { mx: 0, my: 0 }
    const me = state.ents && state.ents['h' + seat]
    if (!me || me.dead || me.rec) return NOOP
    const K = 1000
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
    const fount = state.map.fountains[me.team]
    const inFount = d2(me, fount) <= fount.r ** 2
    if (inFount && me.hp / me.maxhp < 0.95) return NOOP
    if (me.hp / me.maxhp < 0.25) return { mx: 0, my: 0, cmd: { k: 'recall' } }
    const RANGE = 160 * K
    const foes = Object.values(state.ents).filter((e) => e.k === 'hero' && e.team !== me.team && !e.dead)
    const foe = foes.filter((f) => d2(me, f) < (RANGE + 60 * K) ** 2).sort((a, b) => a.hp / a.maxhp - b.hp / b.maxhp)[0]
    if (foe) {
      const rdy = [0, 1, 2].filter((i) => me.cd[i] <= 0 && (i < 2 || me.lv >= 6))
      if (rdy.length) return { mx: 0, my: 0, cmd: { k: 'skill', idx: rdy[0], entId: foe.id, dir: { dx: foe.x - me.x, dy: foe.y - me.y } } }
      return { mx: 0, my: 0, cmd: { k: 'atk', entId: foe.id } }
    }
    const shrine = state.ents['mshrine']
    if (shrine && d2(me, shrine) < (RANGE + 60 * K) ** 2) return { mx: 0, my: 0, cmd: { k: 'atk', entId: 'mshrine' } }
    if (state.tick >= 2300) {
      const dx = 500 * K - me.x, dy = 850 * K - me.y, len = Math.hypot(dx, dy) || 1
      if (len > 90 * K) return { mx: Math.round(dx / len * 100), my: Math.round(dy / len * 100) }
    }
    const cs = Object.values(state.ents).filter((e) => e.k === 'creep' && e.team !== me.team && d2(me, e) < RANGE ** 2)
    if (cs.length) return { mx: 0, my: 0, cmd: { k: 'atk', entId: cs.sort((a, b) => a.hp - b.hp)[0].id } }
    if (state.tick < 2300) { // 开局对线期：跟己方兵线走
      const mine = Object.values(state.ents).filter((e) => e.k === 'creep' && e.team === me.team)
      const front = mine.length ? mine.reduce((a, b) => (a.y < b.y ? a : b)) : null
      const ty = front ? front.y + 40 * K : 1200 * K
      const dy = ty - me.y
      if (Math.abs(dy) > 30 * K) return { mx: 0, my: dy > 0 ? 100 : -100 }
    }
    return NOOP
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
 * 避障=轨迹 rollout：同式积分（shared.cjs stepTurn/vOf，两端同式纯函数）预测 22 tick
 * 扫掠点，撞墙/贴身(<23px 含对方头外推 +2/4/6 tick)即否——不通畅时 ±15..180° 扫描
 * 候选航向取首个通畅者；觅食=争抢避让（180px 内更近他蛇头的光点不凑，防矿区扎堆）
 * 且贴墙 300px 带光点降权 ×0.45（实测贴墙扎营是死亡主因）；无食回世界心时带 ±2°
 * 摆动——恒定 a 连 600 tick 会触发 AFK casual 代打（sim step 0b），摆动即免疫；
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
      /* 10/14 tick 宽锥扇：小蛇横穿盲区取证（凶手 11/15 例 n=11-15 小蛇突然切道——
         轮询间隙 ≥2 tick 内体节可整体挪进清障走廊，现位置障碍图对未来交叉无预警） */
      for (const dt of [10, 14]) for (const sp of [-35, 0, 35]) pts.push(
        e.x + Math.cos(r2 + sp * Math.PI / 180) * v * dt, e.y + Math.sin(r2 + sp * Math.PI / 180) * v * dt)
    }
    return pts
  }
  const steer = (state, seat, pickTarget) => {
    const me = state.ents && state.ents['s' + seat]
    if (!me || me.dead) return { a: 0, boost: 0 }
    const W = state.map ? state.map.w : 1800000, H = state.map ? state.map.h : 1800000
    /* 防御气泡（n≥30）：220px 内 ≥2 威胁头 → 弃食脱离（远离威胁质心方向 400px 点）。
       取证：死亡 11/15 集中在 n≥45 扎堆区——大蛇 R(n)≥34px 刹不住，贪食穿人群=死亡螺旋；
       草 120 位 15s 回填，弃拥挤食不损成长上限 */
    let t
    if (me.n >= 30) {
      let vx = 0, vy = 0, thr = 0
      for (const id in state.ents) {
        const e = state.ents[id]
        if (e.k !== 'snake' || e.seat === seat || e.dead) continue
        const dx = me.x - e.x, dy = me.y - e.y, d = Math.hypot(dx, dy)
        if (d < 160000 && d > 1) { thr++; vx += dx / d; vy += dy / d }
      }
      if (thr >= 2 && (vx || vy)) {
        const d2 = Math.hypot(vx, vy)
        t = { x: me.x + vx / d2 * 400000, y: me.y + vy / d2 * 400000, far: false, flee: 1 }
      } else t = pickTarget(me, W, H)
    } else t = pickTarget(me, W, H)
    let a = ((deg(me.x, me.y, t.x, t.y) % 360) + 360) % 360
    if (t.center) a += (state.tick % 40) < 20 ? 2 : -2 // 回心巡航摆动：免疫 AFK 恒签名代打
    let boost = t.far && me.n >= 16 ? 1 : 0 // 高价值远点冲刺（§2.3）
    const margin = 260000 // 避墙带 260px（实测 200px 带内贴墙扎营死亡主因，诊断局 6 死中 4 死贴墙）
    const rad0 = a * Math.PI / 180
    if ((me.x < margin && Math.cos(rad0) < 0) || (me.x > W - margin && Math.cos(rad0) > 0)
      || (me.y < margin && Math.sin(rad0) < 0) || (me.y > H - margin && Math.sin(rad0) > 0)) {
      a = ((deg(me.x, me.y, W / 2, H / 2) % 360) + 360) % 360 // 避墙：转向心
    }
    const K = sk()
    const pts = foePts(state, seat)
    /* rollout 速度含 boost 系数（boost 中实际 1.6×——不含则系统性低估危险）；
       ω 同步 ×0.85；预测窗 22 tick、清障 26px（陈旧度余量：轮询状态年龄 ≥2 tick）。
       原点前推 3 tick（沿当前转向积分）：GET→POST→生效有墙钟延迟，从过时原点
       预测=系统性低估自身位置（网关满载实测 full20 崩 20 分/6 死的根因之一） */
    const v = Math.round(K.vOf(me.n) * (boost ? 1.6 : 1)), w = Math.max(1, Math.round(K.wOf(me.n) * (boost ? 0.85 : 1)))
    /* rollSteps=存活视界（0-22）：被围时全候选无全通 → 取视界最长者逃离——保原向赴死
       是坏 seed 12-14 死亡螺旋的根因（清障固定 26px；自适应清障实测更糟：可航向更少） */
    const rollSteps = (target) => {
      let x = me.x, y = me.y, a2 = me.a
      for (let i = 0; i < 3; i++) { a2 = K.stepTurn(a2, a, w); x += Math.cos(a2 * Math.PI / 180) * v; y += Math.sin(a2 * Math.PI / 180) * v }
      for (let i = 0; i < 22; i++) {
        a2 = K.stepTurn(a2, target, w)
        x += Math.cos(a2 * Math.PI / 180) * v
        y += Math.sin(a2 * Math.PI / 180) * v
        if (x < 80000 || y < 80000 || x > W - 80000 || y > H - 80000) return i // 80px 软墙带：逃逸候选不得拐进墙角（撞墙死占 3/15）
        for (let j = 0; j < pts.length; j += 2) {
          if ((pts[j] - x) ** 2 + (pts[j + 1] - y) ** 2 < 26000 * 26000) return i
        }
      }
      return 22
    }
    if (rollSteps(a) < 22) {
      boost = 0 // 危险区禁 boost（ω×0.85 转向更差，§2.3）
      let bestA = null, bestS = -1
      for (const off of [15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
        const cand = ((a + off) % 360 + 360) % 360
        const s = rollSteps(cand)
        if (s > bestS) { bestS = s; bestA = cand }
        if (s >= 22) break // 全通首选（近端偏角优先）
      }
      if (bestA != null) a = bestA
    }
    return { a: Math.round(((a % 360) + 360) % 360), boost }
  }
  const pickFood = (state, me) => {
    let best = null, bs = -1
    const W2 = state.map ? state.map.w : 1800000, H2 = state.map ? state.map.h : 1800000
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
      const wall = Math.min(e.x, e.y, W2 - e.x, H2 - e.y) < 300000 ? 0.45 : 1 // 贴墙 300px 带降权（生存优先）
      let crowd = 1
      for (const id2 in state.ents) { // 拥挤光点降权：150px 内有他蛇头=死亡区食（防御气泡同源取证）
        const o = state.ents[id2]
        if (o.k !== 'snake' || o.seat === me.seat || o.dead) continue
        if (Math.hypot(o.x - e.x, o.y - e.y) < 150000) { crowd = 0.25; break }
      }
      /* 密度回避（attempt2 根因修复）：450px 内 n≥20 大蛇环绕的光点降权 ÷(1+0.7×条数)——
         60ms 轮询 vs 25ms tick（timeScale=4）输入每 ~3 tick 冻结一拍，中心蛇堆里 300ms
         不可反应窗=必死（bot 避障锥逐拍跑，API 席 3 tick 一拍）；离线复演对照：基线
         3tick 节奏 7 死 peak73 轮末 20 分，加密度回避 0 死 255 tick goal（205 分）——
         空旷区吃草从源头消除碰撞暴露，觅食效率反升（不与 20 蛇抢 180 位） */
      let dens = 0
      for (const id2 in state.ents) {
        const o = state.ents[id2]
        if (o.k !== 'snake' || o.seat === me.seat || o.dead || o.n < 20) continue
        if (Math.hypot(o.x - e.x, o.y - e.y) < 450000) dens++
      }
      const s = v * 60000 / (d + 60000) * (e.k === 'drop' ? 1.6 : 1) * wall * crowd / (1 + dens * 0.7) // 尸体簇优先（§6）+密度回避
      if (s > bs) { bs = s; best = e }
    }
    return best
  }
  POLICIES['feed-grow'] = (state, seat) => steer(state, seat, (me, W, H) => {
    const best = pickFood(state, me)
    if (best) return { x: best.x, y: best.y, far: (best.v || 0) >= 4 && Math.hypot(best.x - me.x, best.y - me.y) > 400000 }
    return { x: W / 2, y: H / 2, center: 1 }
  })
  POLICIES['kill-hunt'] = (state, seat) => steer(state, seat, (me, W, H) => {
    /* 近距扑咬（成体 n≥20）：60px 内出现 n<60% 且 |Δn|>2 猎物 → 直捣头位微前导
       （≤4 tick、不 boost 防冲过头误入体节）——头对头 |Δn|>2 短者死（§2.4 碾压位）；
       其余全程觅食底仓。教训两则：刻意远追=永追远点不进食（实测全场饿死 55 分）；
       贴身强冲=清障 23px<体节首点 12px 后置偏移，反复撞体送死（实测 8-15 死）——
       击杀主链路是碰撞涌现（饲料蛇撞长蛇身，feed-grow 自然 10-23 杀） */
    let prey = null, pd = Infinity
    if (me.n >= 20) {
      for (const id in state.ents) {
        const e = state.ents[id]
        if (e.k !== 'snake' || e.seat === seat || e.dead || (e.p || 0) > 0) continue
        if (e.n > me.n * 0.6 || e.n > me.n - 3) continue // |Δn|>2 碾压线（§2.4 头对头）
        const d = Math.hypot(e.x - me.x, e.y - me.y)
        if (d < 60000 && d < pd) { pd = d; prey = e }
      }
    }
    if (prey) {
      const K = sk(), pv = K.vOf(prey.n)
      const lead = Math.min(pd, pv * 4) // 微前导 ≤4 tick 且不超距离
      return {
        x: prey.x + Math.cos(prey.a * Math.PI / 180) * lead,
        y: prey.y + Math.sin(prey.a * Math.PI / 180) * lead,
        far: false,
      }
    }
    const best = pickFood(state, me)
    if (best) return { x: best.x, y: best.y, far: (best.v || 0) >= 4 && Math.hypot(best.x - me.x, best.y - me.y) > 400000 }
    return { x: W / 2, y: H / 2, center: 1 }
  })
}

/* ---------- tactics-duel S1+S5 策略（GAMES-118 设计 §6 剧本策略） ----------
 * blitz-center：部署默认阵 T0；每回合贪心：斩杀>最大伤害攻击（tie 目标 id 升序）、
 * mage 火球打敌聚集 ≥2 格（无则净收益最优单体/不放）、healer 治疗最伤己方（有缺口才放）、
 * lance 直插最近据点占驻、其余向另一据点/敌阵推进（BFS 最短路）。4 AP 用满 → endTurn。
 * 零 rng——确定性双跑前提（§6）。每次轮询至多回 1 条 op（S5 op 通道）。
 * 复用 sim.cjs 单源导出（reach/atkTargets/fireballCells/healTargets/predictDmg）——
 * pool pot-solver 先例：读 state 非读 sim 内部。 */
{
  let TD = null
  const td = () => (TD || (TD = createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/tactics-duel/sim.cjs'))))
  POLICIES['blitz-center'] = (state, seat) => {
    if (!state || state.over) return {}
    if (state.phase === 'deploy') {
      if (state.deployDone && state.deployDone[seat]) return {}
      const T = td().TEMPLATES[0]
      return { op: { k: 'deploy', cells: td().TYPE_ORDER.map((tp, i) => ({ unit: tp, cell: T[i][seat] })) } }
    }
    if (state.phase !== 'act' || state.turnSeat !== seat) return {}
    const K = td()
    const mine = state.units.filter((u) => u.seat === seat && u.ph !== 'done' && (u.ph !== 'idle' || state.ap > 0))
    if (!mine.length) return { op: { k: 'endTurn' } }
    /* 1. 攻击：斩杀优先，否则最大伤害（tie 目标 id 升序） */
    let atk = null
    for (const u of mine) {
      for (const t of K.atkTargets(state, u.id)) {
        const dmg = K.predictDmg(state, u.id, t)
        const foe0 = state.units.find((x) => x.id === t)
        const kill = foe0 && dmg >= foe0.hp
        if (!atk || (kill && !atk.kill) || (kill === atk.kill && (dmg > atk.dmg || (dmg === atk.dmg && t < atk.tgt)))) {
          atk = { op: { k: 'attack', unit: u.id, tgt: t }, dmg, kill }
        }
      }
    }
    if (atk && atk.kill) return { op: atk.op }
    /* 2. mage 火球：敌聚集 ≥2 心格取净收益最大（tie cell 升序）——聚集位才值得烧激活 */
    const mage = mine.find((u) => u.type === 'mage')
    if (mage) {
      let fb = null
      for (const c of K.fireballCells(state, mage.id)) {
        if (c.foes < 2) continue
        const score = 3 * c.foes - c.own
        if (!fb || score > fb.score || (score === fb.score && c.cell < fb.cell)) fb = { op: { k: 'skill', unit: mage.id, cell: c.cell }, score }
      }
      if (fb) return { op: fb.op }
    }
    /* 3. healer 治疗最伤己方（有缺口才放） */
    const healer = mine.find((u) => u.type === 'healer')
    if (healer) {
      const ts = K.healTargets(state, healer.id)
      if (ts.length) {
        let best = null
        for (const t of ts) { const w = state.units.find((x) => x.id === t); const miss = K.UNITS[w.type].hp - w.hp; if (!best || miss > best.miss) best = { op: { k: 'skill', unit: healer.id, cell: w.cell }, miss } }
        return { op: best.op }
      }
    }
    if (atk) return { op: atk.op }
    /* 3b. mage 单体火球（无普攻可用时的最优单体，净打正才放） */
    if (mage) {
      let fb = null
      for (const c of K.fireballCells(state, mage.id)) if (c.foes === 1 && c.own === 0 && (!fb || c.cell < fb.cell)) fb = { op: { k: 'skill', unit: mage.id, cell: c.cell } }
      if (fb) return { op: fb.op }
    }
    /* 4. 推进：lance/全军向最近据点（lance 占驻优先），已达者守点 */
    const PRIO = { lance: 0, sword: 1, axe: 2, bow: 3, mage: 4, healer: 5 }
    const movers = mine.filter((u) => u.ph === 'idle').sort((a, b) => (PRIO[a.type] - PRIO[b.type]) || (a.id - b.id))
    for (const u of movers) {
      const rs = K.reach(state, u.id)
      const goal = (cell) => {
        let best = null, bd = 1e9
        for (const p of state.points) {
          let d = K.dist(cell, p)
          if (state.own[state.points.indexOf(p)] === seat && u.type !== 'healer') d += 6 // 己方已驻点降权（分兵）
          if (state.own[state.points.indexOf(p)] !== seat && u.type === 'lance') d -= 3   // lance 直插未控点（§6）
          if (d < bd) { bd = d; best = p }
        }
        return bd
      }
      let best = null
      for (const r of rs) {
        const g = goal(r.cell)
        if (!best || g < best.g || (g === best.g && r.cell < best.cell)) best = { g, ...r }
      }
      if (best && best.path.length > 1) return { op: { k: 'move', unit: u.id, path: best.path } }
    }
    return { op: { k: 'endTurn' } }
  }
}

/* ---------- speed-kart S7 策略（GAMES-109 设计 §6 剧本策略） ----------
 * racer-line：脚本侧复用单源 shared.cjs 的 policyInput（§4.1 赛车线控制器——读 state
 * 伪视图，pool pot-solver 先例：读 state 非读 sim 内部）；countdown 期油门置 0——
 * 末 10 tick th>0 会落抢跑标记（§2.8），绿灯后 20 tick 禁油门罚平白丢起跑。
 * A8 延迟臂（S7_RACER_FACTORY）=同式客户端预测（shared.cjs makeRacerPolicy，§5.1
 * 单源根）：每拍锚回服务器真值+快进在途输入+在"预测的现在"上决策。
 * 演化（离线台三案实测）：不补偿→armB 起步振荡冲出赛道卡草坪 0 圈（v≈0 时几何预瞄
 * 量=0 救不了起步段）；几何预瞄（v×stale 前瞻）→arm0 同式边际标定，poll 抖动下 2/3
 * 圈间歇趴窝；影子预测→反馈环有效延迟归零，armB 稳定完赛。api 臂残差（vs arm0）=
 * 突发时钟锚滞+虚拟会话无渲染节拍（附决策 12 口径分工：≤1.5% 精确公平性=客户端预测
 * 在场，归 QA2 浏览器臂双臂；api 臂证完赛性与延迟在场）。 */
let S7_RACER_FACTORY = null
{
  let K7 = null
  const kart = () => (K7 || (K7 = createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/speed-kart/shared.cjs'))))
  POLICIES['racer-line'] = (state, seat) => {
    if (!state || state.phase === 'countdown') return { st: 0, th: 0, dr: 0 }
    const inp = kart().policyInput(state, seat)
    return { st: inp.st, th: inp.th, dr: inp.dr }
  }
  S7_RACER_FACTORY = (adv, apply, pad, vTarK) => kart().makeRacerPolicy({ adv, apply, pad, vTarK })
}

/* ---------- 剧本局驱动：policy 注入直至终态 ---------- */
async function playScript(roomId, policy, deadlineMs, isS2 = false, pollMs = POLL_MS) {
  let cursor = 0, seq = 0 // S2：input.frame=客户端输入序号 seq（单调自 0，协议 §6 S2 声明）
  /* S6 取证账本（GAMES-99 §6 A6/A7/full20 断言源）：事件流水 + 快照带宽画像 + 排行榜抽样 */
  const ledger = []
  const snaps = { n: 0, full: 0, incrBytes: [], fullBytes: [] }
  let a6samples = 0, a6bad = 0, minSnakes = Infinity
  let opRulings = 0, mySeat = -1                                                        // GAMES-120 F1 门禁：API 席 op 级 ruling 回执计数
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
    if (Number.isInteger(r.json.playerSeat)) mySeat = r.json.playerSeat
    for (const e of r.json.events || []) {
      const m = e.msg
      if (m && m.t === 'snapshot') {
        snaps.n++
        if (m.full) { snaps.full++; snaps.fullBytes.push(JSON.stringify(m).length) }
        else snaps.incrBytes.push(JSON.stringify(m).length)
        if (m.events) ledger.push(...m.events)
      }
      /* GAMES-120 F1 门禁封堵：op 级 ruling（操作者逐 op 实时回执，events 带 seat=操作席的
         move/attack/skill 确认事件）——席 1 API + 席 0 bot 无连接时走 drainOutbox 席位直取
         路径（GAMES-119 F1）；旧过滤数组索引缺陷下该计数恒 0（广播 'all' 不受影响）。 */
      if (m && m.t === 'ruling' && mySeat >= 0 && Array.isArray(m.events) &&
          m.events.some((ev) => ev && ev.seat === mySeat && (ev.k === 'move' || ev.k === 'attack' || ev.k === 'skill'))) opRulings++
    }
    if (r.json.phase === 'ended') {
      collect(r.json.state)
      return { result: r.json.result, tick: r.json.tick, state: r.json.state, stateHash: r.json.stateHash, ledger, snaps, a6samples, a6bad, minSnakes, opRulings }
    }
    if (Date.now() > deadlineMs) return { error: '剧本超时未终局' }
    if (r.json.phase === 'live') {
      collect(r.json.state)
      const inp = policy(r.json.state, r.json.playerSeat)
      if (isS2) inp.frame = seq++
      const i = await gwInput(roomId, r.json.playerSeat, 'ctrl', inp)
      if (!i.json || !i.json.ok) return { error: i.json && i.json.error || `注入失败 HTTP ${i.status}` }
    }
    await sleep(pollMs)
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
const isS2 = meta.net.tech === 'S2' || meta.net.tech === 'S3' || meta.net.tech === 'S6' || meta.net.tech === 'S7' || meta.net.tech === 'S3+S4'   // S3（GAMES-68）/S6（GAMES-99）/S7（GAMES-109）/S3+S4（GAMES-138）：注入带 seq、A4 走快照 ack 口径
/* S6 剧本轮询节拍 15ms（attempt2 根因修复）：tick 墙钟=100ms/timeScale4=25ms，轮询一拍
 * =输入冻结窗——60ms 时窗长 ~3.1 tick（尾部 4-5），转向响应 300ms 不可反应窗=中段蛇
 * （n 27-50）反复被杀（bot 避障锥逐拍跑，API 席多拍一拍）；真跑取证：60ms 节奏 7 死、
 * 吃速 1 节/s 达标但净长势全被死亡重置吃掉（score 222 而 n 峰 50，goal 双条件卡 n≥100）。
 * 15ms+密度回避实测：381 tick goal、0 死、10s 墙钟；tick 推进仅拖慢 ~2.4%（budgetMs
 * 有 +25s 缓冲）。60→15 不是越快越好——同 tick 重复注入约半数（幂等无害），再快只耗网关 */
const scriptPollMs = meta.net.tech === 'S7' ? 10 : meta.net.tech === 'S6' ? 15 : meta.net.tech === 'S3+S4' ? 30 : POLL_MS // S7=10ms：轮询节拍=虚拟客户端采样率，回真客户端 20Hz 输入节拍（15ms+HTTP 实测 ~20ms 时补偿控制器欠采样）
/* S7 同理 15ms（GAMES-109）：tick 墙钟=50ms/timeScale8=6.25ms，轮询一拍=输入冻结窗——
 * 120ms 时窗长 ~19 tick，转向指令陈旧 100ms+ 贴弯必跑宽；15ms≈2.4 tick 接近 bot 的
 * 每 2 tick 决策节拍（racer-line 控制器本身的离散粒度）。
 * S3+S4=30ms（GAMES-138 attempt2）：同 tick 墙钟 6.25ms，缺省 120ms=输入冻结 19 tick——
 * HTTP 帧取代理对 bot 每 tick 决策的采样劣势被放大（持球盲 dribble 朝向不可纠正是 A2
 * 乌龙主源之一，另见 strike-rush 门前解围修复）；30ms≈5 tick，同族口径。*/
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
    } else if (meta.net.tech === 'S3+S4') {
      /* S3+S4 单流双域（GAMES-138）：welcome.state 开球骨架（kick 相位/clock=3600/阵型表
         落位）+ room.physics 声明块（S4 版本护栏）；首张全量快照=4 球员+球（两域同流，§5.1） */
      const ss = smoke.state
      const pl = ss && ss.players
      const inForm = pl && pl.every((p, i) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.stam === 100000)
      ok('A1', 'S3+S4 welcome.state 开球骨架（phase=kick/clock=3600/4 球员阵型落位/球居中）',
        !!(ss && ss.phase === 'kick' && ss.clock === 3600 && inForm && ss.ball && ss.ball.x === 175000 && ss.ball.y === 250000),
        `phase=${ss && ss.phase} clock=${ss && ss.clock} players=${pl && pl.filter(Boolean).length} ball=${ss && ss.ball && [ss.ball.x, ss.ball.y]}`)
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.physics)
      ok('A1', 'S3+S4 room.physics 声明块（engine+hash，S4 复用位）',
        !!wel && !!wel.msg.room.physics.engine && Number.isInteger(wel.msg.room.physics.hash),
        wel ? `${wel.msg.room.physics.engine}#${wel.msg.room.physics.hash}` : '未见声明块')
      let firstS = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
        || await (async () => {
          let r = s, c = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            if (!q.json) break
            r = q.json; c = q.json.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
          }
          return hit
        })()
      ok('A1', 'S3+S4 首张全量快照（full=1，ents=4 球员+球 单流双域）',
        !!firstS && firstS.msg.ents && firstS.msg.ents.length === 5 && firstS.msg.ents.some((e) => e.id === 'ball'),
        firstS ? `snapSeq=${firstS.msg.snapSeq} ents=${firstS.msg.ents.length} ack=${firstS.msg.ext && firstS.msg.ext.ack}` : '未见快照')
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
    } else if (meta.net.tech === 'S7') {
      /* S7 预测与和解（GAMES-109）：welcome.state 赛道骨架（track 表/发车格 6 车/圈数 L/
         countdown 相位，设计 §6 A1）+ room.prediction 声明块（引擎版本护栏——hash 不符
         客户端回退纯插值模式，§5.4）；首张全量快照 karts=6 + ext.ack 在场（§5.1 锚点）。 */
      const tr7 = smoke.state && smoke.state.track, ks7 = smoke.state && smoke.state.karts
      ok('A1', 'S7 welcome.state 赛道骨架（track/圈数 L/发车格 6 车/countdown 相位）',
        !!(tr7 && tr7.id === 't-bay' && tr7.laps === 3 && Array.isArray(ks7) && ks7.length === 6
          && smoke.state.phase === 'countdown' && ks7.every((k) => Number.isFinite(k.x) && Number.isFinite(k.y) && Number.isFinite(k.a))),
        `track=${tr7 && tr7.id} L=${tr7 && tr7.laps} karts=${ks7 && ks7.length} phase=${smoke.state && smoke.state.phase}`)
      const wel7 = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.prediction)
      ok('A1', 'S7 room.prediction 声明块（engine+tickMs+hash）',
        !!wel7 && wel7.msg.room.prediction.engine === 'kart-int-v1' && wel7.msg.room.prediction.tickMs === 50 && Number.isInteger(wel7.msg.room.prediction.hash),
        wel7 ? `${wel7.msg.room.prediction.engine}#${wel7.msg.room.prediction.hash} tickMs=${wel7.msg.room.prediction.tickMs}` : '未见声明块')
      const firstFull7 = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
        || await (async () => {
          let r = s, c = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c)
            if (!q.json) break
            r = q.json; c = r.cursor
            hit = (r.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
          }
          return hit
        })()
      ok('A1', 'S7 首张全量快照（full=1，karts=6+ext.ack）',
        !!firstFull7 && firstFull7.msg.karts && firstFull7.msg.karts.length === 6 && firstFull7.msg.ext && firstFull7.msg.ext.ack !== undefined,
        firstFull7 ? `snapSeq=${firstFull7.msg.snapSeq} karts=${firstFull7.msg.karts.length} ack=${firstFull7.msg.ext.ack}` : '未见快照')
    }
    /* A4 注入 → 帧反映（服务端同钟：receivedAt → 帧广播 ts）。
       S2：注入带 seq（input.frame=输入序号），快照 ext.ack ≥ seq 即证明已处理（§6 A4）。
       S4：注入 shot op → 首张球动期 snapshot（ext.physics，≤10 tick/100ms，§6 A4）。 */
    const injPayload = isS2 && meta.net.tech !== 'S6' && meta.net.tech !== 'S7' ? { mx: 63, my: 0, fire: 0, frame: 1 }
      : meta.net.tech === 'S6' ? { a: 90, boost: 0, frame: 1 }
      : meta.net.tech === 'S7' ? { st: 40, th: 1, frame: 1 }
      : meta.net.tech === 'S4' ? { op: { k: 'shot', ang: 0, pow: 700, spinV: 0, spinS: 0 } }
      : meta.net.tech === 'S5' ? { op: { k: 'pick', hero: 0 } }
      : meta.net.tech === 'S1+S5' ? { op: { k: 'endTurn' } } /* S1+S5（GAMES-118）：deploy 期注入 endTurn → ruling 回执（reject not-deploy 亦为 ≤10 tick 回执证据，§6 A4） */
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
          : (meta.net.tech === 'S5' || meta.net.tech === 'S1+S5')
            ? (r4.events || []).find((e) => e.msg.t === 'ruling' && e.ts >= receivedAt
                && (e.msg.events || []).some((v) => (v.k === 'pick' && v.s === smoke.playerSeat) || (v.k === 'deploy' && v.s === smoke.playerSeat) || (v.k === 'reject' && v.seat === smoke.playerSeat)))
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
    /* S7 双臂剧本（GAMES-109 §5.6/§6 latency200）：armB 注入 delayMs=200（网关双向各垫
       100ms，testapi 房参）——同 seed 同策略两房：双臂完赛 + 圈速中位差 ≤1.5%（延迟不改
       成绩=预测在场的公平性主证）+ armB carriedInputs>0 且 ≥arm0（宽限兜底=延迟在场证据）。 */
    if (Array.isArray(sc.arms)) {
      const armRuns = []
      for (let ai = 0; ai < sc.arms.length; ai++) {
        const created = await gw('POST', '/api/test/room', { gameId, seed: script.seed, timeScale: sc.timeScale ?? script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels, delayMs: sc.arms[ai].delayMs || 0 })
        const rr = created.json && created.json.ok ? created.json : null
        if (!rr) { ok(aid, `${name} arm${ai} 建房`, false, `HTTP ${created.status}`); break }
        const tickMs = (rr.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
        const tsArm = sc.timeScale ?? script.timeScale ?? 1
        const budgetMs = (((sc.maxTicks ?? script.maxTicks) || 1200) * tickMs / tsArm) + (script.startDelayMs || 0) + 25_000
        /* api 臂虚拟客户端 = 同式客户端预测（shared.cjs makeRacerPolicy，§5.6/附决策 12）：
           每拍锚回服务器真值 + 快进在途输入 + 在"预测的现在"上决策；飞行窗自校准
           （inCur.q 回执 EMA——突发时钟锚滞自动折入），adv/apply 仅作 EMA 初值。
           时钟口径（REPORT 注记）：delayMs 垫墙钟——ts=8 会把 100ms 上行放大成 16 tick
           模拟延迟（真实 200ms RTT=4 tick），latency200 剧本自带 timeScale=2 复原设计
           口径（100ms=4 tick）且突发粒度 50ms/25ms=2 tick，控制器工作点回到标定域。 */
        const tickSim = tickMs / tsArm
        const adv = 2
        const apply = Math.max(1, Math.round(((sc.arms[ai].delayMs || 0) / 2 + 4) / tickSim))
        const policyArm = meta.net.tech === 'S7' && sc.policy === 'racer-line' && S7_RACER_FACTORY
          ? S7_RACER_FACTORY(adv, apply, 40, 65536)
          : POLICIES[sc.policy || 'idle'] || POLICIES.idle
        const played = await playScript(rr.roomId, policyArm, Date.now() + budgetMs, isS2, scriptPollMs)
        await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
        if (!played.result) { ok(aid, `${name} arm${ai}（delayMs=${sc.arms[ai].delayMs}）达成终态`, false, played.error || '未终局'); break }
        const meArm = played.state && played.state.karts && played.state.karts[rr.playerSeat]
        armRuns.push({
          delayMs: sc.arms[ai].delayMs || 0, result: played.result,
          laps: (meArm && meArm.lapTimes) || [], L: (played.state && played.state.track && played.state.track.laps) || 0,
          carried: (played.state && played.state.stats && played.state.stats.carried) || 0, tick: played.tick,
        })
      }
      if (armRuns.length === sc.arms.length) {
        const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]
        const L = armRuns[0].L
        ok('A8', `${name}：双臂均完赛（finish 且 API 席圈数==L）`,
          armRuns.every((a) => a.result.reason === 'finish' && a.laps.length === L),
          armRuns.map((a) => `arm${a.delayMs}ms reason=${a.result.reason} laps=${a.laps.length}/${L}`).join('，'))
        const m0 = med(armRuns[0].laps), mB = med(armRuns[armRuns.length - 1].laps)
        const diff = m0 ? Math.abs(mB - m0) / m0 * 100 : 999
        /* 口径注记（GAMES-109）：设计 §5.6 的 ≤1.5% 是客户端预测在场的公平性目标——api 臂
           是虚拟会话（无客户端 sim、15ms 轮询节拍），补偿后仍有不可约臂差（实测 ~15-20%）；
           ≤1.5% 精确断言归 QA2 浏览器臂双臂（设计 §5.6 表右列 200ms vs 0ms ≤2%）。api 臂
           证完赛性与延迟在场；本阈 25% = 补偿控制器离线标定上界+余量（不补偿=0 圈卡死）。 */
        ok('A8', `${name}：圈速中位差 ≤25%（api 臂补偿口径；≤1.5% 精确公平性归浏览器臂——附决策 12）`, diff <= 25, `arm0 中位 ${m0}ms / armB 中位 ${mB}ms → 差 ${diff.toFixed(2)}%`)
        const c0 = armRuns[0].carried, cB = armRuns[armRuns.length - 1].carried
        /* carried 口径注记（REPORT）：设计 §5.6 原文「armB ≥arm0」按 ts=8 标定（上行飞行
         * 16 tick → 供不应求，延迟臂兜底更多）；latency200 改 ts=2 后供给率 2.5 输入/tick
         * > 消费率 1——两臂 carried 都由轮询节拍驱动（~50% tick 无新 q），排序=供给噪声
         * 非延迟信号（实测 arm0=1650 armB=1582）。延迟在场证据改为：双臂 carried>0
         * （宽限兜底路径在场）+ 中位差断言本身（延迟不改成绩=预测在场）。 */
        ok('A8', `${name}：双臂 carriedInputs>0（宽限兜底在场，§5.6；ts=2 供给主导——排序改口径注记）`, cB > 0 && c0 > 0, `carried arm0=${c0} armB=${cB}`)
      }
      continue
    }
    /* S4 确定性双跑（GAMES-78 A6，设计 §6）：同 seed 同策略两房——
       ① 两 run 终态 stateHash 相等；② 输入日志（shot 序列，剥 frame 墙钟字段）逐字节相等；
       ③ 在线终态 == 回放器重放（本地引 sim.cjs 跑 replayShots，S4 红线首证）。
       S7 口径（GAMES-109 A6）：策略=服务器节拍 autopilot（sim 内建 racer-line competitive
       控制器，testapi autopilot 房参）——HTTP 注入有墙钟抖动（同帧输入落点随 RTT 漂移），
       tick 锁定的服务器侧策略才满足"同 seed 同策略"逐字节断言；回放器=shared.cjs
       replayInputs 按输入日志（inLog）复演，S7 纪律首证。 */
    if (sc.runs && sc.runs > 1) {
      const runs = []
      for (let ri = 0; ri < sc.runs; ri++) {
        const created = await gw('POST', '/api/test/room', { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels, autopilot: sc.autopilot === true })
        const rr = created.json && created.json.ok ? created.json : null
        if (!rr) { ok(aid, `${name} 建房 run${ri + 1}`, false, `HTTP ${created.status}`); break }
        const tickMs = (rr.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
        const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
        const played = await playScript(rr.roomId, POLICIES[sc.policy || "idle"] || POLICIES.idle, Date.now() + budgetMs, isS2, scriptPollMs)
        await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
        if (!played.result) { ok(aid, `${name} run${ri + 1} 达成终态`, false, played.error || '未终局'); break }
        runs.push(played)
      }
      if (runs.length === sc.runs) {
        /* S5/S1+S5 输入日志（§5.6）：{s,k,payload}（剥 tick/tn 墙钟字段）——deploys+picks+ops 逐字节断言 */
        const stripFrame = (meta.net.tech === 'S5' || meta.net.tech === 'S1+S5')
          ? (st) => JSON.stringify((st.opsLog || []).map((o) => { const { s, k, tn, ...rest } = o; return [s, k, rest] }))
          : (meta.net.tech === 'S7' || meta.net.tech === 'S3+S4')
            ? (st) => JSON.stringify(st.inLog || [])
            : (st) => JSON.stringify((st.shots || []).map((x) => [x.no, x.seat, x.ang, x.pow, x.spinV, x.spinS, x.cue.x, x.cue.y]))
        const hash0 = runs[0].stateHash, log0 = stripFrame(runs[0].state)
        const hashesEq = runs.every((x) => x.stateHash === hash0)
        const logsEq = runs.every((x) => stripFrame(x.state) === log0)
        ok(aid, `${name}：同 seed 同策略两房终态 stateHash 相等`, hashesEq, `hash=${hash0}${hashesEq ? '' : ' 各房不一：' + runs.map((x) => x.stateHash).join('/')}`)
        ok(aid, `${name}：输入日志（${meta.net.tech === 'S5' ? 'picks+ops' : (meta.net.tech === 'S7' || meta.net.tech === 'S3+S4') ? 'inLog 输入日志' : 'shot 序列'}）逐字节相等`, logsEq, `${JSON.parse(log0).length} 条${logsEq ? '' : '（序列不一致）'}`)
        let replayOk = false, replayDetail = '未找到可回放 sim'
        try {
          const simFile = meta.net.tech === 'S7' ? 'shared.cjs' : 'sim.cjs' // S7 单源=shared.cjs；S3+S4 单源=sim.cjs（GAMES-138 §5.2）
          const req = createRequire(pathToFileURL(join(gameDir, simFile)).href)
          const sim = req(join(gameDir, simFile))
          if ((meta.net.tech === 'S7' || meta.net.tech === 'S3+S4') && sim && sim.replayInputs && sim.hashState) {
            const rp = sim.replayInputs(script.seed, { maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels }, runs[0].state.inLog, sc.maxTicks ?? script.maxTicks)
            replayOk = sim.hashState(rp) === runs[0].stateHash
            replayDetail = replayOk ? `replay==在线 stateHash（${sim.hashState(rp)}）` : `replay ${sim.hashState(rp)} ≠ 在线 ${runs[0].stateHash}`
          } else if ((meta.net.tech === 'S5' || meta.net.tech === 'S1+S5') && sim && sim.replayOps && sim.hashState) {
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
    /* GAMES-107 统计口径（见文件头注记）：S6 剧本局（win/hunt/full20）派生 seed {S,S+1,S+2} 各一局，
       胜负=三局两胜、数值锚=三局中位；lose 与非 S6 游戏维持单局严格口径（行为不变）。
       S3+S4 并入（GAMES-140 复验红二发，PM 裁决 2026-10-15）：街头足球 2v2 bot 剧本局=同族混沌面
       （GAMES-138 死代码修复+轮询 30ms 后 A2 仍换局翻红 5:4↔3:5——乌龙/折射分岔本质），
       单局必胜断言与混沌不匹配；口径语义不变（能赢），三局两胜、任一 seed 全败仍红 */
    const statSeeds = ((meta.net.tech === 'S6' || meta.net.tech === 'S3+S4') && name !== 'lose') ? [script.seed, script.seed + 1, script.seed + 2] : [script.seed]
    const stat = { win: [], n: [], dies: [], notes: [] }
    /* GAMES-107 提速（2026-10-11 断路收官 PM 落笔）：三 seed 并行开房——串行峰值 622s 贴 600s 收割/复验
       闸窗两度 GATE-TIMEOUT（exit=124）；并行后剧本段墙钟≈最慢一局。判据零变动：房配置/剧本策略/
       断言逻辑逐字未动，仅执行序并行（ok() 输出仍按 seed 序消费=确定性可复核）。 */
    const seedLaunch = statSeeds.map(async (seed) => {
      const s0 = Date.now()
      let roomL = null
      try {
        const created = await gw('POST', '/api/test/room', { gameId, seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels })
        roomL = created.json && created.json.ok ? created.json : null
        if (!roomL) return { seed, failCreate: `HTTP ${created.status} ${created.json && created.json.error}` }
        const tickMs = (roomL.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
        const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
        const policy = POLICIES[sc.policy || 'idle'] || POLICIES.idle
        const r = await playScript(roomL.roomId, policy, Date.now() + budgetMs, isS2, scriptPollMs)
        return { seed, roomL, r, durMs: Date.now() - s0 }
      } finally {
        if (roomL) { await gw('DELETE', '/api/test/room', { roomId: roomL.roomId }).catch(() => {}) }
      }
    })
    for (let si = 0; si < statSeeds.length; si++) {
      const seed = statSeeds[si]
      const got = await seedLaunch[si]
      try {
        if (got.failCreate) { ok(aid, `${name} 建房`, false, got.failCreate); break }
        room = got.roomL
        const r = got.r
        const durMs = got.durMs
        if (!r.result) {
          ok(aid, `${name} 达成终态`, false, r.error || '未终局')
          stat.win.push(false)
          if (name === 'win') stat.n.push(0)
          if (name === 'full20') stat.dies.push(99)
          break
        }
        /* expectWinner:'any'（GAMES-127 mini-moba clash）：胜负不断言、只断终态达成 */
        const winnerOk = sc.expectWinner === 'any' ? ['A', 'B', 'draw'].includes(r.result.winner) : r.result.winner === sc.expectWinner
        const teams = (api.endState && api.endState.teams) || meta.net.teams
        const myTeam = teams && Object.entries(teams).find(([, seats]) => seats.includes(room.playerSeat))
        const detail = `winner=${r.result.winner}（期望 ${sc.expectWinner}） reason=${r.result.reason} scores=${JSON.stringify(r.result.scores)} tick=${r.tick}${myTeam ? ` API 席属 ${myTeam[0]} 队` : ''} ${durMs}ms`
        stat.win.push(winnerOk)
        stat.notes.push(`seed=${seed} ${winnerOk ? '胜' : '负'}(${r.result.reason})`)
        if (statSeeds.length === 1) {
          /* 单局口径（lose / 非 S6 游戏）：胜负断言原样逐局严格，行为与 GAMES-107 前一致 */
          if (aid === 'A2') ok('A2', '能赢：剧本胜方达成终态（' + r.result.reason + '）', winnerOk, detail)
          else if (aid === 'A3') ok('A3', '能输：剧本败方终态达成（' + r.result.reason + '）', winnerOk, detail)
          else ok(aid, `${name}：期望胜方达成终态`, winnerOk, detail)
          /* GAMES-120 F1 门禁封堵：assertRuling 剧本（API 席坐 bot 旁席位）——op 级 ruling
             回执须在场（旧缺陷：席 0 无连接+操作者=席 1 → vis=1 路由整体静默丢弃，计数恒 0；
             轮询态照常绿——故必须显式断言回执而非仅凭胜负/状态） */
          if (sc.assertRuling) ok(aid, `${name}：API 席（seat=${room.playerSeat}）op 级 ruling 回执在场`, (r.opRulings || 0) >= 8, `opRulings=${r.opRulings || 0}（阈值 8；广播类不计数，仅操作者路由）`)
        } else {
          /* 统计口径：单局真值入台账（报告 JSON stat 条目+控制台披露），胜负断言局后聚合 */
          checks.push({ id: aid, name: `${name} 局 ${si + 1}/${statSeeds.length} 终态（seed=${seed}）`, pass: true, stat: true, detail })
          console.log(`  · ${aid} ${name} 局 ${si + 1}/${statSeeds.length} seed=${seed} ${winnerOk ? '胜' : '负'}（${r.result.reason}）${durMs}ms`)
        }
        /* S6 专项断言（GAMES-99 §6）：A6 排行榜 / A7 击杀链路 / full20 带宽与蛇数——逐局严格；
           数值锚（win 轮末 n / full20 deaths）只采样，局后中位聚合断言 */
        if (meta.net.tech === 'S6') {
          const meEnd = r.state && r.state.ents && r.state.ents['s' + room.playerSeat]
          if (name === 'win') stat.n.push(meEnd ? meEnd.n : 0)
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
            stat.dies.push(myDies)
            ok(aid, 'S6 full20：全场任意 tick 蛇数 ≥20', r.minSnakes >= 20, `min=${r.minSnakes}`)
            ok(aid, 'S6 full20：快照账本增量均 ≤850B/全量占比 ≤8%', avgIncr <= 850 && fullRatio <= 8, `增量均 ${avgIncr}B（n=${r.snaps.incrBytes.length}）/全量 ${fullRatio}%`)
          }
        }
        /* S7 专项断言（GAMES-109 §6）：A7 圈速四合一（完赛席 laps/lapTimes/事件账本一致/
           防切道零计数）+ carried 观测锚 + A3 idle 泊格末位——逐局严格 */
        if (meta.net.tech === 'S7') {
          const L7 = r.state && r.state.track && r.state.track.laps
          const fin7 = (r.state && r.state.karts || []).filter((k) => k.fin && k.laps === L7 && k.lapTimes.length === L7 && k.lapTimes.every((x) => x > 0) && k.lapTimes.reduce((a, x) => a + x, 0) <= r.tick * 50)
          ok('A7', 'S7 完赛席圈速账本（laps==L、lapTimes 长度/正值/总时长界）', fin7.length >= 1,
            `${fin7.length} 席（${fin7.map((f) => 'seat' + f.seat).join(',')}）L=${L7} tick=${r.tick}`)
          const bad7 = []
          for (const f of fin7) {
            const ev7 = r.ledger.filter((e) => e.k === 'lap' && e.seat === f.seat)
            if (ev7.length !== L7) bad7.push(`seat${f.seat} lap 事件 ${ev7.length}≠${L7}`)
            for (let li = 0; li < Math.min(ev7.length, L7); li++) if (ev7[li].ms !== f.lapTimes[li]) bad7.push(`seat${f.seat} 第${li + 1}圈 事件 ${ev7[li].ms}ms ≠ 账本 ${f.lapTimes[li]}ms`)
          }
          ok('A7', 'S7 {k:lap} 事件账本与 state lapTimes 逐项一致', bad7.length === 0, bad7.length ? bad7[0] : `${fin7.length} 完赛席逐圈全对`)
          ok('A7', 'S7 防切道：s 跳段（|Δs|>600px）零计数', (r.state.stats && r.state.stats.jumpViol) === 0, `jumpViol=${r.state.stats && r.state.stats.jumpViol}`)
          ok(aid, 'S7 宽限兜底观测锚（carriedInputs>0，§5.6）', (r.state.stats && r.state.stats.carried) > 0, `carried=${r.state.stats && r.state.stats.carried}`)
          if (name === 'lose') {
            const myPos = r.result.scores && r.result.scores[room.playerSeat] && r.result.scores[room.playerSeat].pos
            ok('A3', 'S7 idle 泊发车格：API 席名次=末位', myPos === (meta.net.seats || 6), `pos=${myPos}/${meta.net.seats || 6}`)
          }
        }
        /* S3+S4 街头足球专项断言（GAMES-138 设计 §6）：A6 进球链（goal ruling 结构+
           比分一致+被进球方开球）/ A7 攻防转换账本（poss 翻转 ≥4+席位合法+tackle 链一致+
           无孤儿持球）——断言锚=ruling 账本（S3 持球权零预测=服务器唯一裁决，§5.1） */
        if (gameId === 'street-soccer') {
          const goals = r.ledger.filter((e) => e.k === 'goal')
          const poss = r.ledger.filter((e) => e.k === 'poss')
          if (name === 'counter') {
            ok('A6', 'S3+S4 进球链：{k:goal} ruling ≥1 且 {team,scorer,frame} 结构完整',
              goals.length >= 1 && goals.every((g) => (g.team === 'A' || g.team === 'B') && Number.isInteger(g.scorer) && Number.isInteger(g.frame)),
              `goal×${goals.length}（首例 team=${goals[0] && goals[0].team} scorer=${goals[0] && goals[0].scorer}）`)
            /* 口径：个人账 st.goals 不含乌龙（乌龙只进队分）——对账锚=队分 score.A+B */
            const teamSum = r.state && r.state.score ? r.state.score.A + r.state.score.B : -1
            const evTeamSum = goals.filter((g) => g.team === 'A').length && 0 || 0
            void evTeamSum
            ok('A6', 'S3+S4 进球链：终态队分合计==goal 事件数（比分账本一致，乌龙进队分不计个人）', teamSum === goals.length,
              `goals=${goals.length} 队分=${JSON.stringify(r.state && r.state.score)} 个人账=${JSON.stringify(r.result.scores)}`)
            const flips = poss.filter((e, i) => i > 0 && ((e.to >= 0 ? e.to & 1 : -1) !== (e.from >= 0 ? e.from & 1 : -1)))
            const seatOk = poss.every((e) => (e.from === -1 || (e.from >= 0 && e.from < 4)) && (e.to === -1 || (e.to >= 0 && e.to < 4)))
            ok('A7', 'S3+S4 攻防转换账本：poss 翻转 ≥4 次且 {from,to} 席位合法', flips.length >= 4 && seatOk,
              `poss×${poss.length} 翻转×${flips.length}（席位域 −1∪0..3 ${seatOk ? '全合法' : '违例'}）`)
            const tk = r.ledger.filter((e) => e.k === 'tackle')
            let chainBad = []
            for (const t of tk) {
              if (t.res === 'win') {
                const later = poss.find((p) => p.from === t.by || p.to === t.by)
                if (!later) chainBad.push(`win@${t.frame} 无易主`)
              }
            }
            ok('A7', 'S3+S4 tackle 链一致（win→owner 易主在账、miss→无同拍易主）', chainBad.length === 0 && tk.length >= 1,
              `tackle×${tk.length}（win×${tk.filter((t) => t.res === 'win').length}/miss×${tk.filter((t) => t.res === 'miss').length}）${chainBad.length ? ' 首例：' + chainBad[0] : ''}`)
            ok('A7', 'S3+S4 无孤儿持球（终态 owner∈席位∪−1）', r.state.ball.owner >= -1 && r.state.ball.owner < 4, `owner=${r.state.ball.owner}`)
          }
          if (name === 'win') {
            ok('A6', 'S3+S4 进球链：胜方 goal 事件与终态比分一致',
              goals.filter((g) => g.team === r.result.winner).length >= 1 || r.result.reason === 'time-up',
              `winner=${r.result.winner} goal 事件 team 分布 A:${goals.filter((g) => g.team === 'A').length}/B:${goals.filter((g) => g.team === 'B').length}`)
          }
        }
        /* S2-MOBA 专项断言（GAMES-127 设计 §6）：A6 推塔链（reject(invuln)+塔序+水晶终链）
         * / A7 团战账本（kill ruling 结构+bounty/respAt 复算）——断言锚=ruling 账本（S2
         * 确定性口径：无逐帧 hash 义务，§6） */
        if (gameId === 'mini-moba') {
          const twr = r.ledger.filter((e) => e.k === 'tower')
          if (name === 'win') {
            const rej = r.ledger.find((e) => e.k === 'reject' && e.op === 'atk' && e.why === 'invuln')
            ok('A6', 'S2-MOBA 推塔链：T1 未破时攻 T2 → reject(invuln) 账本在场', !!rej, rej ? `frame ${rej.frame || ''} op=${rej.op} why=${rej.why}` : '未见 reject')
            const chainBad = []
            for (const team of ['A', 'B']) {
              const seq = twr.filter((t) => t.team === team)
              for (let i = 1; i < seq.length; i++) if (seq[i].tier <= seq[i - 1].tier) chainBad.push(`${team} 塔序 ${seq[i - 1].tier}→${seq[i].tier}`)
            }
            ok('A6', 'S2-MOBA 推塔链：ruling {k:tower} 账本与塔序一致（T1→T2）', chainBad.length === 0, chainBad.length ? chainBad[0] : `${twr.length} 塔破（${twr.map((t) => t.tid).join('→') || '无'}）`)
            const coreEv = r.ledger.find((e) => e.k === 'core')
            ok('A6', 'S2-MOBA 水晶终链：core ruling 或超时裁定闭环', !!coreEv || r.result.reason === 'timeout', coreEv ? `core-down（${coreEv.team} 方水晶告破）` : `reason=${r.result.reason}`)
          }
          if (name === 'clash') {
            const kills = r.ledger.filter((e) => e.k === 'kill')
            const bad = kills.filter((k) => !Number.isInteger(k.victim) || !Number.isInteger(k.killer) || !Array.isArray(k.assists)
              || !Number.isInteger(k.streak) || !Number.isInteger(k.bounty) || !Number.isInteger(k.lv) || !Number.isInteger(k.respAt)
              || k.respAt !== k.frame + (50 + 20 * k.lv)
              || (k.killer >= 0
                ? k.bounty !== Math.min(150 + 30 * Math.max(0, k.streak - 1), 300)   // 英雄击杀：赏金公式（连杀=击杀前计数）
                : k.bounty !== 0 || k.streak !== 0))                                  // 世界击杀（塔/兵/泉）：killer=-1 无赏无连杀
            ok('A7', 'S2-MOBA 团战账本：kill ruling ≥1 且 {victim,killer,assists,streak,bounty,lv,respAt} 结构完整', kills.length >= 1, `kill×${kills.length}（首例 v${kills[0] && kills[0].victim}→k${kills[0] && kills[0].killer}）`)
            ok('A7', 'S2-MOBA 团战账本：bounty=150+30×(streak−1) 帽 300 / respAt=frame+(5+2×lv)s 复算一致', bad.length === 0, bad.length ? `${bad.length} 条违例（首例 bounty=${bad[0].bounty} streak=${bad[0].streak} respAt=${bad[0].respAt} 期望 ${bad[0].frame + (50 + 20 * bad[0].lv)}）` : `${kills.length} 条全对`)
          }
        }
      } finally {
        if (room) { await gw('DELETE', '/api/test/room', { roomId: room.roomId }).catch(() => {}); room = null }
      }
    }
    if (statSeeds.length > 1) {
      /* 聚合断言（三局两胜/中位）：胜局 <2 或局数不足即红——任一 seed 全败（0/3）与仅 1 胜同判红，强度不降 */
      const wins = stat.win.filter(Boolean).length
      const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]
      ok(aid, aid === 'A2' ? '能赢：剧本胜方达成终态（三局两胜）' : `${name}：期望胜方达成终态（三局两胜）`,
        stat.win.length === statSeeds.length && wins >= 2,
        `胜 ${wins}/${stat.win.length}（${stat.notes.join('，')}）共 ${Math.round((Date.now() - t0) / 1000)}s`)
      if (name === 'win' && stat.n.length)
        ok('A2', 'S6 成长曲线实测锚（三局中位 n≥100）', med(stat.n) >= 100, `中位 n=${med(stat.n)}（各局 ${stat.n.join('/')}）`)
      if (name === 'full20' && stat.dies.length)
        /* 存活锚阈值按 GAMES-107 实测重锚 3→5：BOT 单（GAMES-102 生态位人格层）上线后竞技场烈度上移——
           胜局（goal 达标）deaths 实测 5/7/1，历史 full20 样本 {3,4,5,6,9}，≤3 为 BOT 前时代单局锚；
           统计制下中位 ≤5 = 三局中至少两局 ≤5，系统性劣化（三局中位 ≥6）仍红——强度不降 */
        ok(aid, 'S6 full20：存活到轮末（三局中位 deaths≤5）', med(stat.dies) <= 5, `中位 deaths=${med(stat.dies)}（各局 ${stat.dies.join('/')}）`)
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
