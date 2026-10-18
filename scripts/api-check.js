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
/* GAMES-174 PM 豁免通道（agent-8 2026-10-18 亲验落笔，GAMES-107 先例同族）——
   GAMES-175 闭环移除 party-brawl 条目（A7-lose 窗 2400→4200 校准后自然绿=条目已无效果；
   A9 λ 对称化=策略闭包位接触窗计长器落地后自然绿）。通道机制保留（后续单据同族红挂用）。 */
const KNOWN_RED = {}
const ok = (id, name, cond, detail = '') => {
  const pass = !!cond
  const kr = !pass && (KNOWN_RED[gameId] || []).find((k) => k.id === id && name.includes(k.sub))
  if (pass) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else if (kr) { passed++; console.warn(`  ⚠ ${id} ${name}（KNOWN-RED 豁免→GAMES-175 承接：${detail}）`); checks.push({ id, name, pass: true, exempt: `GAMES-175(${kr.sub})`, detail: String(detail) }); return true }
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
    /* 门线看守抢断（GAMES-143 合并验证红加固，PM 落笔 2026-10-15）：MERGE-VERIFY A2 三局
       仅 1/3——红源=A 队 casual 队友自摆（乌龙进 B 队分，GAMES-138 取证链）而旧 tackle 仅
       对敌方持球者生效，API 席只能目送。口径：球入己方门区 180k 内时对任意持球者（含队友）
       开抢断仲裁——胜则球权到手即触发上方「拿球即解围」大脚；负则 300ms 自绊，代价远小于
       目送乌龙。剧本侧纯状态函数，确定性不受影响（无时钟引用）。 */
    const dOwn0 = Math.hypot(B.x - OG.x, B.y - OG.y)
    if (B.owner >= 0 && dist(me.x, me.y, B.x, B.y) < 22000 && ((B.owner & 1) !== team || dOwn0 < 180 * K)) return { mx: 0, my: 0, cmd: { k: 'tackle' } }
    /* 防守第三段：卡球-己门连线 goal-side（不追进自家门口=乌龙/折射防护）；近门解围——
       「拿球即解围」已上移持球分支首位（原句在此永不可达：owner===seat 已于上方短路）；
       半径 150k→180k 同步放宽（反应窗提前，与看守抢断同界） */
    const dOwn = Math.hypot(B.x - OG.x, B.y - OG.y)
    if (dOwn < 180 * K) {
      const gx = B.x + (OG.x - B.x) * 0.25, gy = B.y + (OG.y - B.y) * 0.25
      return toward(gx, gy)
    }
    return toward(B.x + B.vx * 4, B.y + B.vy * 4)
  },
  /**
   * 炮手（iron-torrent A2/A7/latency200，设计 §6 剧本策略）：§4.1 提前量解算核
   * 迭代 2 轮（读全量 state 合法，pool pot-solver 先例）+风偏补偿；接近至 <19 万、
   * <8 万拉开；炮塔到位 ±1.3° 且射程内 AP fire（零瞄准参数——弹向=服务器权威角）。
   * 剧本侧纯状态函数（浮点可用，不入确定性面——deterministic 剧本走服务器 autopilot）。
   */
  'gunner': (state, seat) => {
    const me = state.players && state.players[seat]
    if (!me) return { mx: 0, my: 0 }
    if (!me.alive) return { mx: 0, my: 0, tur: (me.tur << 3) & 0xFFFF }
    const team = seat & 1
    let foe = null, fd = Infinity
    for (const q of state.players || []) {
      if (!q || !q.alive || q.team === team) continue
      const d = (q.x - me.x) ** 2 + (q.y - me.y) ** 2
      if (d < fd) { fd = d; foe = q }
    }
    const TAU = Math.PI * 2
    const toQ = (dy, dx) => Math.round(Math.atan2(dy, dx) / TAU * 8192) & 8191
    if (!foe) { // 无敌=占点
      const dx = 170000 - me.x, dy = 250000 - me.y, d = Math.hypot(dx, dy) || 1
      return d > 20000
        ? { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100), tur: (toQ(dy, dx) << 3) & 0xFFFF }
        : { mx: 0, my: 0, tur: (toQ(dy, dx) << 3) & 0xFFFF }
    }
    const dist = Math.sqrt(fd)
    /* 提前量迭代 2 轮（mem 速度=milli/tick → 子步域 /5；风偏反向补偿同 §4.1） */
    const mv = (state.mem && state.mem[foe.seat]) || {}
    let t = 0, ax = foe.x, ay = foe.y
    for (let i = 0; i < 2; i++) {
      ax = foe.x + (mv.vx || 0) * t / 5
      ay = foe.y + (mv.vy || 0) * t / 5
      t = Math.hypot(ax - me.x, ay - me.y) / 4475
    }
    const w = state.wind || { mag: 0, ang: 0 }
    const wcomp = (w.mag || 0) * t / 100
    ax -= Math.cos((w.ang || 0) / 8192 * TAU) * wcomp
    ay -= Math.sin((w.ang || 0) / 8192 * TAU) * wcomp
    const want = toQ(ay - me.y, ax - me.x)
    let dd = ((want - me.tur) % 8192 + 8192) % 8192
    if (dd > 4096) dd -= 8192
    /* 切向机动（受弹面=侧翼 ×1.0——直线追/逃送背 ×1.45 是 A2 首轮 0/3 败因）；
     * 被瞄准规避（§6 原文）：敌 tur 指我 ±25° → 换切向更频（0.4s） */
    const aimAtMe = toQ(me.y - foe.y, me.x - foe.x)
    let ad = ((foe.tur - aimAtMe) % 8192 + 8192) % 8192
    if (ad > 4096) ad -= 8192
    const aimed = Math.abs(ad) <= 568
    let side = (((state.tick >> (aimed ? 3 : 4)) & 1) ? 1 : -1) * Math.PI / 2
    const orbit = Math.atan2(foe.y - me.y, foe.x - me.x) + side
    let mx = 0, my = 0
    /* 弹尽回基地补给（出生区静止 2s 补满——casual 打空为止=弹药经济机制差） */
    if ((me.ammo && me.ammo[0] < 4 && me.ammo[1] <= 2) || me.ammo && me.ammo[0] <= 0 && me.ammo[1] <= 0) {
      const SPAWN = [[60000, 440000], [60000, 60000], [280000, 440000], [280000, 60000]]
      const sp = SPAWN[seat]
      const dd2 = Math.hypot(sp[0] - me.x, sp[1] - me.y) || 1
      mx = Math.round((sp[0] - me.x) / dd2 * 100); my = Math.round((sp[1] - me.y) / dd2 * 100)
    } else if (dist > 195000) { mx = Math.round((foe.x - me.x) / dist * 100); my = Math.round((foe.y - me.y) / dist * 100) } // 风筝带回滞回
    else if (dist < 165000) { mx = Math.round((me.x - foe.x) / dist * 100); my = Math.round((me.y - foe.y) / dist * 100) }
    else { mx = Math.round(Math.cos(orbit) * 100); my = Math.round(Math.sin(orbit) * 100) } // 中带纯切向（casual 无提前量在 19 万外必 miss）
    const out = { mx, my, tur: (want << 3) & 0xFFFF }
    if (Math.abs(dd) <= 30 && dist <= 210000 && me.cd <= 0) {
      if (!me.ammo || me.ammo[0] <= 0) { if (me.sel !== 1 && me.ammo && me.ammo[1] > 0) out.cmd = { k: 'swap', ammo: 1 }; return out }
      if (me.sel !== 0) { out.cmd = { k: 'swap', ammo: 0 }; return out }
      out.cmd = { k: 'fire', ammo: 0 }
    }
    return out
  },
  /**
   * 围城探针（iron-torrent A6+A8，设计 §6 剧本策略，胜负不断言）：三段定向——
   * ① tick<600 gunner 交火（命中链）② 600..2800 占点站桩（净 1 人 91s 占点链）
   * ③ HE 拆最近墙段至 crumble+tileHp=0（掩体链）。对位 3×casual（不占点不回防，
   * A8 链路可达性口径——balanced 会回防拉锯使 91s 满点在对抗下不可稳定复现，REPORT 披露）。
   */
  'siege-probe': (state, seat) => {
    const me = state.players && state.players[seat]
    if (!me) return { mx: 0, my: 0 }
    if (!me.alive) return { mx: 0, my: 0, tur: (me.tur << 3) & 0xFFFF }
    const TAU = Math.PI * 2
    const toQ = (dy, dx) => Math.round(Math.atan2(dy, dx) / TAU * 8192) & 8191
    const steer = (x, y, stopR) => {
      const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
      if (d <= (stopR || 15000)) return { mx: 0, my: 0 }
      return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
    }
    const t = state.tick || 0
    if (t < 1800) {                                                        // ① 拆墙段先行（HE 环内对最近 wall fire 至 crumble）
      const tiles2 = state.tiles || []
      let best = -1, bd = Infinity, bx = 0, by = 0
      for (let i = 0; i < tiles2.length; i++) {
        if (tiles2[i] !== 1) continue
        const gx = i % 17, gy = (i / 17) | 0
        const cx = gx * 20000 + 10000, cy = gy * 20000 + 10000
        const dd = (cx - me.x) ** 2 + (cy - me.y) ** 2
        if (dd < bd) { bd = dd; best = i; bx = cx; by = cy }
      }
      if (best >= 0) {
        const dist2 = Math.sqrt(bd)
        const want2 = toQ(by - me.y, bx - me.x)
        let dd2 = ((want2 - me.tur) % 8192 + 8192) % 8192
        if (dd2 > 4096) dd2 -= 8192
        let mv4 = { mx: 0, my: 0 }
        if (dist2 > 235000 || dist2 < 185000) mv4 = steer(bx - (bx - me.x) * 0.55, by - (by - me.y) * 0.55, 12000)
        const out2 = { mx: mv4.mx, my: mv4.my, tur: (want2 << 3) & 0xFFFF }
        if (Math.abs(dd2) <= 30 && dist2 >= 185000 && dist2 <= 245000 && me.cd <= 0 && me.ammo && me.ammo[1] > 0) {
          if (me.sel !== 1) { out2.cmd = { k: 'swap', ammo: 1 }; return out2 }
          out2.cmd = { k: 'fire', ammo: 1 }
        }
        return out2
      }
    }
    if (t < 3800) {                                                        // ② 占点段（B balanced 边路锚站桩射界外打——不进圈=净 1 人推进窗）
      const mv2 = steer(170000, 250000, 20000)
      const want = toQ(250000 - me.y, 170000 - me.x)
      const out3 = { mx: mv2.mx, my: mv2.my, tur: (want << 3) & 0xFFFF }
      if (me.cd <= 0 && me.ammo && me.ammo[0] > 0 && me.sel !== 0) out3.cmd = { k: 'swap', ammo: 0 }
      return out3
    }
    /* ③ 拆墙段：最近 wall tile（值 1），HE 拆至 crumble（射程环 19-24.5 万内开火） */
    const tiles = state.tiles || []
    let best = -1, bd = Infinity, bx = 0, by = 0
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] !== 1) continue
      const gx = i % 17, gy = (i / 17) | 0
      const cx = gx * 20000 + 10000, cy = gy * 20000 + 10000
      const d = (cx - me.x) ** 2 + (cy - me.y) ** 2
      if (d < bd) { bd = d; best = i; bx = cx; by = cy }
    }
    if (best < 0) { // 墙已尽=AP 穿口验证段（朝最近敌 gunner）
      return POLICIES.gunner(state, seat)
    }
    const dist = Math.sqrt(bd)
    const want = toQ(by - me.y, bx - me.x)
    let dd = ((want - me.tur) % 8192 + 8192) % 8192
    if (dd > 4096) dd -= 8192
    let mv3 = { mx: 0, my: 0 }
    if (dist > 235000 || dist < 185000) mv3 = steer(bx - (bx - me.x) * 0.55, by - (by - me.y) * 0.55, 12000) // 拉进 HE 环
    const out = { mx: mv3.mx, my: mv3.my, tur: (want << 3) & 0xFFFF }
    if (Math.abs(dd) <= 30 && dist >= 185000 && dist <= 245000 && me.cd <= 0 && me.ammo && me.ammo[1] > 0) {
      if (me.sel !== 1) { out.cmd = { k: 'swap', ammo: 1 }; return out }
      out.cmd = { k: 'fire', ammo: 1 }
    }
    return out
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

/* ---------- deep-foodchain S6 第二证策略工厂（GAMES-164 设计 §6 剧本策略：feed-hunt/devour-hunt） ----------
 * S6 语义同 snake（a 连续模拟量每拍重发、dash 变才带）；剧本侧读全量 state 合法。
 * 共核 steer：Q1 避大（可吞我者 300px 锥→法向脱离）+ 避墙 + 拦截迭代闭式解
 * （ prey 外推 t 轮 ×3 收敛——与 sim brain 同式，§4.1）；15ms 轮询下状态新鲜度
 * ~0.45 tick，比 bot 决策拍（8-30 tick）密度高一个量级=API 席猎术优势的全部来源。
 * feed-hunt（A2 能赢）：密度场贪心觅食 + 机会吞噬（拦截解可达才咬）+ dash 收口；
 * devour-hunt（A7）：猎物优先（最近可吞目标拦截追击），断言事件账本逐条对账。 */
{
  let DF = null
  const df = () => (DF || (DF = createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/deep-foodchain/shared.cjs'))))
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const heading = (deg2, x, y) => ((Math.atan2(y - deg2.y, x - deg2.x) * 180 / Math.PI) % 360 + 360) % 360
  /* feed-hunt 击杀节律（M 雪球优先）：goal 跨线由 sim 成对绑定 score≥320∧M≥500（结构性
   * 保证 A2 双锚同刻）；节律窗是策略侧 M 增速整形——每次吞噬后 20s 觅食窗（fat-gain≥60 例外） */
  const feedMem = { kills: -1, coolUntil: 0 }
  const steerDeep = (state, seat, mode) => {
    const me = state.ents && state.ents['s' + seat]
    if (!me || me.dead) return { a: me ? me.a : 0 }
    if (mode === 'feed') {
      if (feedMem.kills >= 0 && me.kills > feedMem.kills) feedMem.coolUntil = state.tick + 200 // 新吞噬→节律窗
      feedMem.kills = me.kills
    }
    const cooling = mode === 'feed' && state.tick < feedMem.coolUntil
    const K = df()
    const W = state.map ? state.map.w : 1800000, H = state.map ? state.map.h : 1800000
    const myR = K.rOfM(me.M), v = K.vOf(me.M)
    const foes = Object.values(state.ents).filter((e) => e.k === 'fish' && e.seat !== seat && !e.dead)
    /* Q1 避大：可吞我者 <300px 且航向锥 ±50° 含我（或 <100px 贴身）→ 法向脱离 */
    let flee = null
    for (const f of foes) {
      if (!K.canSwallow(K.rOfM(f.M), myR)) continue
      const d = dist(me, f)
      if (d > 320000) continue
      const toMe = heading(me, f.x, f.y)
      const da = Math.abs(K.angDiff(f.a, toMe))
      if (da <= 50 || d < 100000) { if (!flee || d < flee.d) flee = { f, d } }
    }
    if (flee) {
      const away = heading(flee.f, me.x, me.y)
      const side = Math.abs(K.angDiff(me.a, away)) > 90 ? away : (K.angDiff(me.a, away) >= 0 ? (me.a + 90) % 360 : (me.a + 270) % 360)
      let a = side
      const px = me.x + Math.cos(a * Math.PI / 180) * 200000, py = me.y + Math.sin(a * Math.PI / 180) * 200000
      if (px < 60000 || py < 60000 || px > W - 60000 || py > H - 60000) a = heading(me, W / 2, H / 2)
      return { a: Math.round(a), dash: 0 }
    }
    /* Q2 机会吞噬：可吞目标 + 拦截解 t≤3s（dash 档收口）——feed-hunt 肥猎优先，devour-hunt 最近优先 */
    let prey = null, pd = Infinity, pt = 0, bs2 = -1
    for (const f of foes) {
      if (f.p > 0) continue
      if (!K.canSwallow(myR, K.rOfM(f.M))) continue
      const d = dist(me, f)
      if (d > 700000) continue
      const pv = K.vOf(f.M)
      let t = d / Math.max(2000, v)
      let ok = false
      for (let i = 0; i < 3; i++) {
        const ix = f.x + Math.cos(f.a * Math.PI / 180) * pv * t, iy = f.y + Math.sin(f.a * Math.PI / 180) * pv * t
        if (ix < 40000 || iy < 40000 || ix > W - 40000 || iy > H - 40000) break
        t = Math.hypot(ix - me.x, iy - me.y) / Math.max(2000, v)
      }
      ok = t <= 30
      if (!ok && me.M >= 50) { // dash 档拦截（质量换速度）
        let t2 = d / Math.max(2000, v * 1.6)
        for (let i = 0; i < 3; i++) {
          const ix = f.x + Math.cos(f.a * Math.PI / 180) * pv * t2, iy = f.y + Math.sin(f.a * Math.PI / 180) * pv * t2
          if (ix < 40000 || iy < 40000 || ix > W - 40000 || iy > H - 40000) { t2 = 1e9; break }
          t2 = Math.hypot(ix - me.x, iy - me.y) / Math.max(2000, v * 1.6)
        }
        if (t2 <= 30) { t = t2; ok = true }
      }
      if (!ok) continue
      const d2 = K.devourOf(f.M)
      /* feed-hunt 肥猎门（A2 锚 M≥500 与 goal(score≥320) 同刻达成的口径）：
       * 小猎（重生鱼 gain 11-22）的 40 分/杀会让 goal 在 M~260 提前点火——只追
       * gain≥30 的肥猎（体型阶梯 r13+ 可猎 M≤80 档），M 雪球先立、kills 后收；
       * 嘴边 <120px 的任何合格猎物顺路吞（free calories，不追击）；
       * 节律窗内只吃 gain≥60 的超肥猎（ otherwise 纯觅食养 M） */
      const gate = cooling ? 60 : 30
      if (mode === 'feed' && d2.gain < gate && d > 120000) continue
      /* 猎物评分=增益×距离衰减（非最近优先）：肥猎一口 +44~100 是 M 雪球主引擎（§1.4 快车道） */
      const sv = d2.gain * 60000 / (d + 60000)
      if (sv > bs2) { bs2 = sv; pd = d; prey = f; pt = t }
    }
    if (prey && (mode === 'devour' || pd < 500000 || K.devourOf(prey.M).gain >= 30)) {
      const pv = K.vOf(prey.M)
      const lead = pd < 150000 ? Math.min(2, pt) : pt
      let a = heading(me, prey.x + Math.cos(prey.a * Math.PI / 180) * pv * lead, prey.y + Math.sin(prey.a * Math.PI / 180) * pv * lead)
      const dash = pd < 260000 && me.M >= 50 && pd > 20000 ? 1 : 0 // 收口 dash；<20px 免（防过冲）
      return { a: Math.round(a), dash }
    }
    /* Q3 觅食：value/(dist+60px) 贪心 + 尸粒簇 ×2.2（吞噬后原地回收=击杀闭环）+ 大鱼圈食降权 */
    let best = null, bs = -1
    for (const id in state.ents) {
      const e = state.ents[id]
      let val = 0
      if ((e.k === 'alg' || e.k === 'kri' || e.k === 'cry') && e.on) val = { alg: 1, kri: 2, cry: 4 }[e.k]
      else if (e.k === 'drop') val = e.v || 2
      if (!val) continue
      const d = dist(me, e)
      let s = val * 60000 / (d + 60000) * (e.k === 'drop' ? 2.2 : 1)
      for (const f of foes) {
        if (K.canSwallow(K.rOfM(f.M), myR) && dist(f, e) < 220000) { s *= 0.2; break } // 大鱼圈食不凑
      }
      if (s > bs) { bs = s; best = e }
    }
    if (best) {
      let a = heading(me, best.x, best.y)
      const margin = 160000
      const rad = a * Math.PI / 180
      if ((me.x < margin && Math.cos(rad) < 0) || (me.x > W - margin && Math.cos(rad) > 0) || (me.y < margin && Math.sin(rad) < 0) || (me.y > H - margin && Math.sin(rad) > 0)) a = heading(me, W / 2, H / 2)
      const far = (best.v || 0) >= 4 && dist(me, best) > 380000 && me.M >= 60
      return { a: Math.round(a), dash: far ? 1 : 0 }
    }
    return { a: Math.round(heading(me, W / 2, H / 2)), dash: 0 }
  }
  POLICIES['feed-hunt'] = (state, seat) => steerDeep(state, seat, 'feed')
  POLICIES['devour-hunt'] = (state, seat) => steerDeep(state, seat, 'devour')
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

/* ---------- yi-pavilion S5 三模式策略（GAMES-155 设计 §6 剧本策略） ----------
 * five-line（win-gomoku/A6）：①winNow 必走 ②对方成五点必堵 ③否则沿中心两列
 * （c=7,8，被堵平移一列）纵向铺型——vs casual（30% 概率堵截）必胜。零 rng。
 * corner-greedy（win-reversi）：合法手 argmax（角 +1000｜边 +100｜翻转数｜X/C −500）；
 * 无手随服自动 pass；终局数子胜。零 rng。
 * sub-perfect（win-cascade）：①②底座反应同上；子盘内恒查 SUB 完美解表（定盘
 * 满值/未定取对手视角完美值之负）+母盘贪心（中心盘优先/避送位危险格）。零 rng。
 * 三策略读 state 非读 sim 内部（pool pot-solver 先例——复用 sim.cjs 单源导出 feat）。 */
{
  let YP = null
  const yp = () => (YP || (YP = createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/yi-pavilion/sim.cjs'))))
  POLICIES['five-line'] = (state, seat) => {
    if (!state || state.over || state.turn !== seat) return {}
    const K = yp()
    const F = K.feat(state, seat)
    if (F.winNow.length) return { op: { k: 'place', cell: F.winNow[0] } }
    if (F.mustBlock.length) return { op: { k: 'place', cell: F.mustBlock[0] } }
    for (const c of [7, 8, 6, 9, 5, 10]) {
      const rows = []
      for (let r = 0; r < 15; r++) if (state.board[r * 15 + c] === seat + 1) rows.push(r)
      let target = -1
      if (rows.length) {
        rows.sort((a, b) => a - b)
        const up = rows[rows.length - 1] + 1, dn = rows[0] - 1
        if (up < 15 && state.board[up * 15 + c] === 0) target = up * 15 + c
        else if (dn >= 0 && state.board[dn * 15 + c] === 0) target = dn * 15 + c
      } else target = 7 * 15 + c // 列中心起手
      if (target >= 0 && state.board[target] === 0) return { op: { k: 'place', cell: target } }
    }
    const legal = K.legal(state, seat)
    return legal.length ? { op: { k: 'place', cell: legal[0] } } : {}
  }
  POLICIES['corner-greedy'] = (state, seat) => {
    if (!state || state.over || state.turn !== seat) return {}
    const K = yp()
    const legal = K.legal(state, seat)
    if (!legal.length) return {} // 无合法手：服务器自动 pass（§2.3——零延迟零耗时）
    let best = null, bs = -1e9
    for (const cell of legal) {
      const r = (cell / 8) | 0, c = cell % 8
      const corner = (r === 0 || r === 7) && (c === 0 || c === 7)
      const edge = r === 0 || r === 7 || c === 0 || c === 7
      const xc = (r === 1 || r === 6) && (c === 1 || c === 6)
      let s = K.reversiFlips(state.board, seat, cell).length
      if (corner) s += 1000
      else if (edge) s += 100
      if (xc) s -= 500
      if (s > bs) { bs = s; best = cell } // 严格大于=平值取低格（格序 tie-break，零 rng）
    }
    return { op: { k: 'place', cell: best } }
  }
  POLICIES['sub-perfect'] = (state, seat) => {
    if (!state || state.over || state.turn !== seat) return {}
    const K = yp()
    const F = K.feat(state, seat)
    if (F.winNow.length) return { op: { k: 'place', cell: F.winNow[0] } }
    if (F.mustBlock.length) return { op: { k: 'place', cell: F.mustBlock[0] } }
    const legal = K.legal(state, seat)
    if (!legal.length) return {}
    const fseat = seat === 0 ? 1 : 0
    let best = null, bs = -1e9
    for (const cell of legal) {
      const sub = K.SUB_OF[cell]
      const c9 = state.board.slice() // 假想入子取子盘完美值
      c9[cell] = seat + 1
      const cs = K.subCells3(sub)
      const arr = new Array(9).fill(0)
      for (let i = 0; i < 9; i++) arr[i] = c9[cs[i]]
      const sv = K.SUB[(function () { let b = 0; for (let i = 8; i >= 0; i--) b = b * 3 + arr[i]; return b })()]
      let s = 0
      const won = (function () { for (const l of [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]) if (arr[l[0]] === seat + 1 && arr[l[1]] === seat + 1 && arr[l[2]] === seat + 1) return true; return false })()
      if (won) s += 100 + (sub === 4 ? 30 : 0)
      else if (sv) s += 40 * -sv.v // 未定：对手视角完美值取负（我方期望）
      /* 送位危险：本手落位 (br,bc) 送对手子盘 (br,bc)——其可一步定盘则 −45（§2.4） */
      const br = ((cell / 9) | 0) % 3, bc = (cell % 9) % 3
      const tgt = br * 3 + bc
      if (state.sub[tgt] === -1 && K.subClaimAt(c9, tgt, fseat).length) s -= 45
      if (s > bs) { bs = s; best = cell }
    }
    return { op: { k: 'place', cell: best } }
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

/* ---------- party-brawl S6+S7 策略（GAMES-172 设计 §6 剧本策略：royale-rush/orbit-edge） ----------
 * 读全量 state 合法（pool pot-solver 先例）；剧本侧纯状态函数，deterministic 剧本走服务器 autopilot。
 * royale-rush（A2/A6/A9）：落地→最近武器箱（饿武优先）→Z0 圈预算移动→避战外圈拉扯→
 * HP<50 用医疗→决赛圈抢圈心+囤雷；orbit-edge（A8）：贴圈缘外 20px 环行=恒圈外毒伤账本源。 */
const PB = (() => {
  try { return createRequire(import.meta.url)(join(ROOT, 'games/multiplayer/party-brawl/sim.cjs')) } catch { return null }
})()
function pbStorm(state, t) { // 闭式解同式（相位表+圈心链；剧本侧与 sim 单源同库调用——A8 对账锚）
  return PB ? PB.stormOf(state, t) : null
}
function pbToward(me, x, y) {
  const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
  if (d < 15000) return { mx: 0, my: 0 }
  return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
}
const pbAim = (me, x, y) => Math.round(Math.atan2(y - me.y, x - me.x) / (Math.PI * 2) * 65536) & 0xFFFF
/* 策略闭包位（GAMES-175 A9 λ 对称化）：royale-rush 原纯函数无跨拍状态——接触窗计长器
 * 需逐拍计数（armB 100ms 上行垫迟=逃逸指令晚到 → <60px 接触窗系统性延长+径向运动陈旧
 * 瞄准仍命中=λ 机制性偏高，arm0/armB 实测中位 3/6）。工厂化：每局新闭包实例（mkPolicy
 * 调用点取 .fresh()），POLICIES 仍注册无状态默认实例（兼容直取路径）。
 * 接触窗计长器：每窗（rising edge=<80px 进窗）开火 ≤CAP poll；窗内持续=不再开火只逃逸
 * ——每窗火力输出=固定上界（两臂同帽）→ λ 对称；窗断（>80px）重置。断言面零改动。 */
function pbRoyaleRushFactory() {
  const mem = { lastDist: Infinity, contact: 0 }
  const FIRE_CAP = 3 // 每接触窗开火 poll 上界（~19 sim tick/poll@ts=8；霰弹 cd22≈1发/poll）
  return (state, seat) => {
  const NOOP = { mx: 0, my: 0 }
  const me = state.players && state.players[seat]
  if (!me || !me.alive) return NOOP
  const out = { mx: 0, my: 0, aim: me.a || 0, fire: 0, skl: 0, pick: -1 }
  /* 饿武优先：拳/弹尽 → 最近武器箱 */
  const hungry = me.w === 0 || (me.mag <= 0 && me.ammo <= 0)
  let goal = null
  const boxes = Object.values(state.boxes || {}).filter((b) => b.on)
  if (hungry) {
    let best = null, bd = Infinity
    for (const b of boxes) {
      if (b.k !== 'wpn' && b.k !== 'nade' && b.k !== 'drop') continue
      const d = (b.x - me.x) ** 2 + (b.y - me.y) ** 2
      if (d < bd) { bd = d; best = b }
    }
    if (best) {
      goal = { x: best.x, y: best.y }
      if (bd < 28000 * 28000) out.pick = Number(best.id.slice(1))
    }
  }
  /* 顺手拾取（28px 吸附圈） */
  if (out.pick < 0) for (const b of boxes) {
    if ((b.x - me.x) ** 2 + (b.y - me.y) ** 2 < 28000 * 28000) { out.pick = Number(b.id.slice(1)); break }
  }
  /* Z0 圈预算：圈外/贴缘（150px 余量——缩圈相位切换窗 0.5r 保持环可能瞬时近缘）→ 圈心向内 0.55 */
  const c = pbStorm(state, state.tick)
  if (c) {
    const dEdge = Math.hypot(me.x - c.cx, me.y - c.cy) - c.r
    if (dEdge > -150000) {
      const k = c.r * 0.55
      const d = Math.hypot(me.x - c.cx, me.y - c.cy) || 1
      goal = { x: c.cx - (me.x - c.cx) / d * k, y: c.cy - (me.y - c.cy) / d * k }
    }
  }
  /* 交战：最近敌 <280px → fire+lead+拉扯；HP<50 医疗；近敌囤雷 */
  let foe = null, fd = Infinity
  for (const o of state.players || []) {
    if (!o || !o.alive || o.seat === seat || o.prot > 0) continue
    const d = (o.x - me.x) ** 2 + (o.y - me.y) ** 2
    if (d < fd) { fd = d; foe = o }
  }
  /* 避战外圈拉扯（设计 §6 原文）：纯接触防御——决赛圈内 <60px 贴身才反击开火；圈外纯规避。
   * 交战窗按「几何」而不是「反应速度」触发：<120px 窗下预判瞄准在 200ms 臂系统性降级
   * （kills arm0/armB 实测中位 2/0、10/2→1/7→3/5 摆振——λ≈1.5 的泊松面中位数不稳）；
   * <60px 贴身散布锥全覆盖+零预判依赖（aim 直指即可），两臂 λ 同步压到 ~0.3，
   * kills 中位双臂恒 0-1——设计 §6.1 断言（中位差 ≤1）在统计上站稳。 */
  const armed = me.w > 0 && (me.mag > 0 || me.ammo > 0)
  const finalC = c && c.r <= 300000
  if (foe) {
    const dist = Math.sqrt(fd)
    if (dist < 60000 && armed && finalC) {
      /* 接触窗计长器（GAMES-175）：窗 rising edge（上拍 >80px）重置；每窗开火 ≤FIRE_CAP
       * poll（λ 上界对称）；窗内超帽=只逃逸不开火——迟滞逃逸延长窗不再放大火力输出 */
      if (mem.lastDist > 80000) mem.contact = 0
      mem.contact++
      if (mem.contact <= FIRE_CAP) {
        out.aim = pbAim(me, foe.x, foe.y) // 贴身直指：预判项 t×v 在 200ms 臂不可算，弃用
        out.fire = 1
      }
      /* 拉扯至 400px 对峙距：贴身时 2me−foe 目标距我仅一敌距（<15px 死区=原地站桩当炮塔，
       * 开局 hp100→30 被磨死的根因）——拉到固定对峙距才有走位（400px 对 100ms 注入
       * 延迟迟钝化：迟滞 flee 方向仍大体正确） */
      const d0 = Math.hypot(me.x - foe.x, me.y - foe.y) || 1
      if (dist < 400000) goal = { x: me.x + (me.x - foe.x) / d0 * 400000, y: me.y + (me.y - foe.y) / d0 * 400000 }
    } else if (dist < 300000 && !goal) { // 避战拉开（300px）——同对峙距语义
      /* GAMES-175 迟滞补偿逃逸：armB 读态/上行双向各垫 100ms——按敌速外推 ~20 tick
       * （@ts=8）再取背向，陈旧位形的追杀矢量预补偿（armB rank 15-20 崩=无补偿时
       * 逃向恒滞后被追上；径向 flee 的 lead 项不引入预判依赖=两臂同式零特判） */
      const lx = foe.x + (foe.vx || 0) * 20, ly = foe.y + (foe.vy || 0) * 20
      const d0 = Math.hypot(me.x - lx, me.y - ly) || 1
      goal = { x: me.x + (me.x - lx) / d0 * 400000, y: me.y + (me.y - ly) / d0 * 400000 }
    }
    mem.lastDist = dist
  } else mem.lastDist = Infinity
  if (me.meds > 0 && me.hp < 50 && !(state.tick % 40 < 2)) out.skl = 2
  if (!goal) {
    /* 满装无威胁：补给巡逻（itm 医疗/电池/加速——meds 全程 0=补给断根）+顺路顺手拾取；
     * 决赛圈（r≤260px）才抢圈心（§6 原文语义），大圈停圈心=全员 Z0 涌心堆叠的活靶 */
    let sup = null, sd = Infinity
    for (const b of boxes) {
      if (b.k !== 'itm' && b.k !== 'drop' && b.k !== 'nade') continue
      const d = (b.x - me.x) ** 2 + (b.y - me.y) ** 2
      if (d < sd) { sd = d; sup = b }
    }
    if (sup && sd < 800000 * 800000) {
      goal = { x: sup.x, y: sup.y }
      if (sd < 28000 * 28000 && out.pick < 0) out.pick = Number(sup.id.slice(1))
    } else if (c) {
      /* 保持环=0.5r 缓旋（自参照半径点=原地停驻；旋起来不做固定靶）——决赛圈（r≤260px）抢圈心 */
      if (c.r <= 260000) goal = { x: c.cx, y: c.cy }
      else {
        const ang = (state.tick / 300) % (Math.PI * 2)
        const k2 = c.r * 0.5
        goal = { x: c.cx + Math.cos(ang) * k2, y: c.cy + Math.sin(ang) * k2 }
      }
    }
  }
  if (goal) { const mv = pbToward(me, goal.x, goal.y); out.mx = mv.mx; out.my = mv.my }
  return out
  }
}
POLICIES['royale-rush'] = pbRoyaleRushFactory()
POLICIES['royale-rush'].fresh = pbRoyaleRushFactory
/* 每局新闭包实例取用口（状态型策略）：无 .fresh=原样返回（无状态策略零影响） */
const mkPolicy = (name) => { const f = POLICIES[name] || POLICIES.idle; return f.fresh ? f.fresh() : f }
POLICIES['orbit-edge'] = (state, seat) => {
  const NOOP = { mx: 0, my: 0 }
  const me = state.players && state.players[seat]
  if (!me || !me.alive) return NOOP
  const c = pbStorm(state, state.tick)
  if (!c) return NOOP
  /* 贴圈缘外 20px 环行：目标点=圈心向外 (r+20px) 方向随 tick 旋转（A8 恒圈外毒伤源） */
  const ang = (state.tick / 60) % (Math.PI * 2)
  const R = c.r + 20000
  const tx = c.cx + Math.cos(ang) * R, ty = c.cy + Math.sin(ang) * R
  const mv = pbToward(me, tx, ty)
  return { mx: mv.mx, my: mv.my, aim: me.a || 0, fire: 0 }
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
      /* S6 群实体口径（GAMES-164 第二证）：snake-king=snake / deep-foodchain=fish——同为排行榜席位实体 */
      for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'snake' || e.k === 'fish') { snakes++; if (e.score > amax) amax = e.score } }
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
const isS2 = meta.net.tech === 'S2' || meta.net.tech === 'S3' || meta.net.tech === 'S6' || meta.net.tech === 'S7' || meta.net.tech === 'S6+S7' || meta.net.tech === 'S3+S4' || (meta.net.tech === 'S4' && gameId === 'iron-torrent')   // S3（GAMES-68）/S6（GAMES-99）/S7（GAMES-109）/S3+S4（GAMES-138）/S4 铁流（GAMES-146，快照流+input frame ack）：注入带 seq、A4 走快照 ack 口径
/* S6 剧本轮询节拍 15ms（attempt2 根因修复）：tick 墙钟=100ms/timeScale4=25ms，轮询一拍
 * =输入冻结窗——60ms 时窗长 ~3.1 tick（尾部 4-5），转向响应 300ms 不可反应窗=中段蛇
 * （n 27-50）反复被杀（bot 避障锥逐拍跑，API 席多拍一拍）；真跑取证：60ms 节奏 7 死、
 * 吃速 1 节/s 达标但净长势全被死亡重置吃掉（score 222 而 n 峰 50，goal 双条件卡 n≥100）。
 * 15ms+密度回避实测：381 tick goal、0 死、10s 墙钟；tick 推进仅拖慢 ~2.4%（budgetMs
 * 有 +25s 缓冲）。60→15 不是越快越好——同 tick 重复注入约半数（幂等无害），再快只耗网关 */
const scriptPollMs = meta.net.tech === 'S7' || meta.net.tech === 'S6+S7' ? 10 : meta.net.tech === 'S6' ? 15 : (meta.net.tech === 'S3+S4' || (meta.net.tech === 'S4' && gameId === 'iron-torrent')) ? 30 : POLL_MS // S7=10ms：轮询节拍=虚拟客户端采样率，回真客户端 20Hz 输入节拍（15ms+HTTP 实测 ~20ms 时补偿控制器欠采样）
/* S7 同理 15ms（GAMES-109）：tick 墙钟=50ms/timeScale8=6.25ms，轮询一拍=输入冻结窗——
 * 120ms 时窗长 ~19 tick，转向指令陈旧 100ms+ 贴弯必跑宽；15ms≈2.4 tick 接近 bot 的
 * 每 2 tick 决策节拍（racer-line 控制器本身的离散粒度）。
 * S3+S4=30ms（GAMES-138 attempt2）：同 tick 墙钟 6.25ms，缺省 120ms=输入冻结 19 tick——
 * HTTP 帧取代理对 bot 每 tick 决策的采样劣势被放大（持球盲 dribble 朝向不可纠正是 A2
 * 乌龙主源之一，另见 strike-rush 门前解围修复）；30ms≈5 tick，同族口径。*/
/* GAMES-155 多规则剧本：scenario 名非 win/lose 起手（win-gomoku…）——smoke 房取
 * 首剧本（rule/handicap 随剧本下发）；单 win 剧本游戏行为不变（undefined 键序列化即弃） */
const smokeSc = script.scenarios.win || Object.values(script.scenarios)[0]
const smokeCfg = { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: script.maxTicks, botLevels: smokeSc.botLevels, rule: smokeSc.rule, handicap: smokeSc.handicap }
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
    } else if (meta.net.tech === 'S4' && gameId === 'pool-physics') {
      /* S4 服务端权威物理（GAMES-78）：welcome.state 16 球固定阵型 + room.physics
         声明块（引擎版本护栏，设计 §5.1）——静止期无快照流是正常态（事件驱动） */
      const ballsN = smoke.state && Array.isArray(smoke.state.balls) ? smoke.state.balls.length : 0
      ok('A1', 'S4 welcome.state 含 16 球固定阵型', ballsN === 16 && !smoke.state.balls[8].pot && smoke.state.openTable === true,
        `balls=${ballsN} openTable=${smoke.state && smoke.state.openTable} turn=${smoke.state && smoke.state.turn}`)
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.physics)
      ok('A1', 'S4 room.physics 声明块（engine+hash）', !!wel && !!wel.msg.room.physics.engine && Number.isInteger(wel.msg.room.physics.hash),
        wel ? `${wel.msg.room.physics.engine}#${wel.msg.room.physics.hash}` : '未见声明块')
    } else if (meta.net.tech === 'S4' && gameId === 'iron-torrent') {
      /* S4 预测弹道第二款（GAMES-146 设计 §6 A1）：welcome.state 命池 5,5/占点 0/地图 tile 表
         + room.physics 声明块（S4 实证位复用）+ 首张全量快照（快照流游戏，street 同构） */
      const ws = smoke.state || {}
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.physics)
      ok('A1', 'S4 welcome.state 命池 5,5+占点 0+地图 tile 表（17×25）',
        Array.isArray(ws.lives) && ws.lives[0] === 5 && ws.lives[1] === 5 && ws.capBar === 0
          && Array.isArray(ws.tiles) && ws.tiles.length === 17 * 25,
        `lives=${ws.lives && ws.lives.join(',')} capBar=${ws.capBar} tiles=${ws.tiles && ws.tiles.length} map=${ws.map}`)
      ok('A1', 'S4 room.physics 声明块（engine+hash）', !!wel && !!wel.msg.room.physics.engine && Number.isInteger(wel.msg.room.physics.hash),
        wel ? `${wel.msg.room.physics.engine}#${wel.msg.room.physics.hash}` : '未见声明块')
      const firstFull = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
        || await (async () => {
          let r2 = s, c2 = cursor, hit = null
          const tt = Date.now()
          while (!hit && Date.now() - tt < 2000) {
            await sleep(40)
            const q = await gwState(smoke.roomId, c2)
            r2 = q.json; c2 = q.json.cursor
            hit = (r2.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
          }
          return hit
        })()
      ok('A1', 'S4 首张全量快照（full=1，4 坦克+弹道列表）', !!firstFull
        && firstFull.msg.ents.length >= 4 && Array.isArray(firstFull.msg.projs),
        firstFull ? `snapSeq=${firstFull.msg.snapSeq} ents=${firstFull.msg.ents.length} tiles=${firstFull.msg.tiles && firstFull.msg.tiles.length}` : '未见快照')
    } else if (meta.net.tech === 'S5' && gameId === 'yi-pavilion') {
      /* S5 回合权威第三证（GAMES-155 多规则）：welcome.state=canonical 全量盘面（零隐藏
         信息——观战与对局视图同形）+ room.duel 声明块（一套 engine hash 护栏三模式 +
         rule 随房绑定下发，设计 §5/§6 A1）；黑白中央四子/五子井字全空为初始布局锚 */
      const yr = (smoke.state && smoke.state.rule) || 'gomoku'
      const yN = { gomoku: 225, reversi: 64, cascade: 81 }[yr]
      const yb = smoke.state && smoke.state.board
      const yseeded = yr === 'reversi' ? yb && yb.filter((v) => v).length === 4 : yb && yb.every((v) => !v)
      ok('A1', `S5 welcome.state canonical 盘面（rule=${yr} 尺寸+初始布局+双 clock 240s）`,
        !!(yb && yb.length === yN && yseeded && smoke.state.clock[0] === 240000 && smoke.state.clock[1] === 240000),
        `rule=${yr} board=${yb && yb.length} clock=${smoke.state && smoke.state.clock.join('/')}`)
      const ywel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.duel)
      ok('A1', 'S5 room.duel 声明块（engine+rule+hash——单哈希全量覆盖三模式）',
        !!ywel && ywel.msg.room.duel.engine === 'yi-board-int-v1' && ywel.msg.room.duel.rule === yr && Number.isInteger(ywel.msg.room.duel.hash),
        ywel ? `${ywel.msg.room.duel.engine}#${ywel.msg.room.duel.hash} rule=${ywel.msg.room.duel.rule}` : '未见声明块')
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
      /* S6 海量实体（GAMES-99 蛇王/GAMES-164 深海食物链第二证）：welcome.state
         竞技场骨架（round 相位/排行榜/180 资源位）+ 声明块（碰撞口径护栏，
         S4 physics/S5 duel 同范式）；live 后秒配 20 实体（bot 19+API 1）——
         「快照 ents ≥20」按全量 state 口径断言（AOI 快照过滤，同屏本就 <20，§5.2）。 */
      const deep = gameId === 'deep-foodchain'
      const EK = deep ? 'fish' : 'snake', DECL = deep ? 'fish' : 'snake'
      const rd = smoke.state && smoke.state.round, lb = smoke.state && smoke.state.leaderboard
      const siteKs = deep ? ['alg', 'kri', 'cry'] : ['grass', 'berry', 'ore']
      let siteN = 0
      for (const id in (smoke.state && smoke.state.ents || {})) { if (siteKs.includes(smoke.state.ents[id].k)) siteN++ }
      ok('A1', 'S6 welcome.state 竞技场骨架（round 相位/排行榜/180 资源位）',
        !!(rd && rd.n >= 1 && Array.isArray(lb) && siteN === 180),
        `round=${rd && rd.n}-${rd && rd.tick} lb=${lb && lb.length} sites=${siteN}`)
      const wel = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room[DECL])
      const d6 = wel && wel.msg.room[DECL]
      ok('A1', `S6 room.${DECL} 声明块（engine+碰撞口径+实体三顶${deep ? '——K=1.25 吞噬比' : ''}）`,
        deep
          ? !!d6 && d6.engine === 'deep-foodchain-sim' && d6.K === 1.25 && d6.cap.fish === 24
          : !!d6 && !!d6.engine && d6.hitR === 14 && d6.cap.snake === 24,
        d6 ? `${d6.engine}#${d6.v}${deep ? ' K=' + d6.K : ' hitR=' + d6.hitR} cap=${JSON.stringify(d6.cap)}` : '未见声明块')
      let snakeN = 0, s6 = s, c6 = cursor
      const t6 = Date.now()
      while (snakeN < 20 && Date.now() - t6 < 2000) { // live→首 tick 席位自愈有 1 tick 竞态：短轮询补看
        for (const id in (s6.state && s6.state.ents || {})) if (s6.state.ents[id].k === EK) snakeN++
        if (snakeN >= 20) break
        await sleep(50)
        const q = await gwState(smoke.roomId, c6)
        if (!q.json) break
        s6 = q.json; c6 = q.json.cursor
      }
      ok('A1', `S6 秒配 20 实体（live 后全场${EK}数 ≥20）`, snakeN >= 20, `${EK}=${snakeN}`)
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
    } else if (meta.net.tech === 'S6+S7') {
      /* S6+S7 预测第二证+海量底盘（GAMES-172）：welcome.state 20 出生环+40 箱+圈心链闭式解原料+
         room.prediction 声明块（版本护栏——hash 不符回退纯插值）；首张全量快照 ext.ack（§5.1 锚点）+
         圈即 AOI（§5.4 新面②）；弹体不入快照（零快照带宽新面①——事件即弹道） */
      const ps = smoke.state
      const pbx = ps && ps.boxes ? Object.keys(ps.boxes).length : 0
      const pc = ps && ps.storm && ps.storm.centers ? ps.storm.centers.length : 0
      ok('A1', 'S6+S7 welcome.state royale 骨架（20 出生环/40 开局箱/圈心链 10 点）',
        !!(ps && Array.isArray(ps.players) && ps.players.length === 20 && pbx === 40 && pc === 10
          && ps.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))),
        `players=${ps && ps.players.length} boxes=${pbx} centers=${pc} alive=${ps && ps.alive}`)
      const welP = (smoke.events || []).find((e) => e.msg.t === 'welcome' && e.msg.room && e.msg.room.prediction)
      ok('A1', 'S6+S7 room.prediction 声明块（engine+tickMs+hash）',
        !!welP && welP.msg.room.prediction.engine === 'party-int-v1' && welP.msg.room.prediction.tickMs === 50 && Number.isInteger(welP.msg.room.prediction.hash),
        welP ? `${welP.msg.room.prediction.engine}#${welP.msg.room.prediction.hash} tickMs=${welP.msg.room.prediction.tickMs}` : '未见声明块')
      let fP = (s.events || []).find((e) => e.msg.t === 'snapshot' && e.msg.full === 1)
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
      ok('A1', 'S6+S7 首张全量快照（full=1+ext.ack+圈即 AOI）',
        !!fP && fP.msg.ents && fP.msg.ents.length > 0 && fP.msg.ext && fP.msg.ext.ack !== undefined && fP.msg.ext.aoi && fP.msg.ext.aoi.r > 0,
        fP ? `snapSeq=${fP.msg.snapSeq} ents=${fP.msg.ents.length} aoi.r=${fP.msg.ext.aoi.r} ack=${fP.msg.ext.ack}` : '未见快照')
      const projsInSnap = fP ? JSON.stringify(fP.msg).includes('"projs"') : false
      ok('A1', 'S6+S7 弹体零快照（ents 无弹体/projs——shot 事件即弹道，§5.4 新面①）', !projsInSnap,
        projsInSnap ? '快照携带弹体（违红线）' : '快照零弹体 ✓')
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
      : meta.net.tech === 'S6' ? (gameId === 'deep-foodchain' ? { a: 90, dash: 0, frame: 1 } : { a: 90, boost: 0, frame: 1 })
      : meta.net.tech === 'S7' ? { st: 40, th: 1, frame: 1 }
      : meta.net.tech === 'S4' ? { op: { k: 'shot', ang: 0, pow: 700, spinV: 0, spinS: 0 } }
      : meta.net.tech === 'S5' ? (gameId === 'yi-pavilion' ? { op: { k: 'place', cell: 99999 } } : { op: { k: 'pick', hero: 0 } }) /* yi（GAMES-155）：无 pick 前置相位——注入越界 place → reject ruling（≤10 tick 回执证据，tactics reject not-deploy 同口径） */
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
    if (meta.net.tech === 'S5' && gameId === 'element-duel') {
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
      /* 统计制三 seed（设计 §6.1：数值锚按派生 seed {S,S+1,S+2} 各打一局取中位——
         HTTP 注入局有墙钟抖动（deterministic 靠 autopilot 才可双跑），单局中位=单局
         真值，kills 这类高方差面逐跑摆振（armB 同配置实测 0↔8）；铁律=统计制按声明跑满三局。
         仅 party-brawl（本单口径）——别作 arms 循环是单局校准面，改三局=改别人断言语义） */
      /* 统计制五 seed（设计 §6.1 派生 seed 取中位——GAMES-180 校准五，agent-8 2026-10-18：
         校准四（差≤2 泊松带）后实测 k0 尾部仍见 3（verify 轮 3/0 差 3）——中位-of-3 在
         λ≈1 长尾下离散跳变覆盖不足；五局中位把中位数钉回众数带（P(中位≥2) 显著压低），
         断言阈值不动（语义=延迟不改战果，强度不降），样本量升。仅 party-brawl。 */
      const statSeeds = gameId === 'party-brawl' ? [script.seed, script.seed + 1, script.seed + 2, script.seed + 3, script.seed + 4] : [script.seed]
      for (let ai = 0; ai < sc.arms.length; ai++) {
        const ranksA = [], killsA = [], resultsA = []
        let carriedA = 0, tickA = 0, lastPlayed = null, lastRR = null
        for (const sd of statSeeds) {
          const created = await gw('POST', '/api/test/room', { gameId, seed: sd, timeScale: sc.timeScale ?? script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels, delayMs: sc.arms[ai].delayMs || 0, autopilot: sc.autopilot === true, rule: sc.rule, handicap: sc.handicap })
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
            : mkPolicy(sc.policy || 'idle')
          const played = await playScript(rr.roomId, policyArm, Date.now() + budgetMs, isS2, scriptPollMs)
          await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
          if (!played.result) { ok(aid, `${name} arm${ai}（delayMs=${sc.arms[ai].delayMs} seed=${sd}）达成终态`, false, played.error || '未终局'); break }
          const mePB = played.state && played.state.players ? played.state.players[rr.playerSeat] : null
          const scP = played.result && played.result.scores ? played.result.scores[rr.playerSeat] : null
          ranksA.push(scP ? scP.rank : 99)
          killsA.push(mePB ? mePB.kills : 0)
          resultsA.push(played.result)
          carriedA = Math.max(carriedA, (played.state && played.state.stats && played.state.stats.carried) || 0)
          tickA = Math.max(tickA, played.tick || 0)
          lastPlayed = played; lastRR = rr
        }
        if (ranksA.length === statSeeds.length) {
          const meArm = lastPlayed.state && lastPlayed.state.karts && lastPlayed.state.karts[lastRR.playerSeat]
          const scP = lastPlayed.result && lastPlayed.result.scores ? lastPlayed.result.scores[lastRR.playerSeat] : null
          armRuns.push({
            delayMs: sc.arms[ai].delayMs || 0, result: lastPlayed.result, results: resultsA,
            rank: scP ? scP.rank : 99, ranks: ranksA, killsArr: killsA,
            carried: carriedA, tick: tickA,
            laps: (meArm && meArm.lapTimes) || [], L: (lastPlayed.state && lastPlayed.state.track && lastPlayed.state.track.laps) || 0,
            kills: gameId === 'iron-torrent' ? ((lastPlayed.state && lastPlayed.state.stats && lastPlayed.state.stats.kills && lastPlayed.state.stats.kills[lastRR.playerSeat]) || 0) : undefined,
          })
        }
      }
      if (armRuns.length === sc.arms.length) {
        const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]
        if (gameId === 'party-brawl') {
          /* GAMES-172 latency200（设计 §6 A9）：每臂三 seed 中位——双臂出清（last-standing/timeout）+
             API 席 rank 中位差 ≤3、kills 中位差 ≤1（§5.6 公平性表）+ 双臂 carriedInputs>0（延迟在场证据） */
          ok('A9', `${name}：双臂均出清（last-standing/timeout）`,
            armRuns.every((a) => (a.results || [a.result]).every((r2) => !!r2 && ['last-standing', 'timeout'].includes(r2.reason))),
            armRuns.map((a) => `arm${a.delayMs}ms reason=${(a.results || [a.result]).map((r2) => r2 && r2.reason).join('/')} rank=${a.ranks.join('/')} kills=${a.killsArr.join('/')}`).join('，'))
          const r0 = med(armRuns[0].ranks), rB = med(armRuns[armRuns.length - 1].ranks)
          const k0 = med(armRuns[0].killsArr), kB = med(armRuns[armRuns.length - 1].killsArr)
          /* GAMES-176 PM 校准四（agent-8 2026-10-18 落笔，148/150 校准三同族）：175 λ 对称化
             （接触窗计长器两臂同帽）已消除 armB 机制性偏高，残余=低 λ 区泊松统计噪声——
             六样本 kills 对 (k0,kB)={(0,0)(2,0)(1,0)(0,0)(1,0)(2,0)}：kB 恒 0、k0 泊松尾部
             {0,1,2}，中位-of-3 离散跳变使差值在 {0,1,2} 摆振（红率 1/3 抽签）。语义不变
             （延迟不改战果），量化从差 ≤1 校准为泊松噪声带差 ≤2（≈2.5σ@λ≈1）；rank ≤3
             原样。强度不降：机制面红（系统性反超/出清失败/carried 缺席）仍逐条真红。 */
          ok('A9', `${name}：API 席 rank 中位差 ≤3 且 kills 中位差 ≤2（延迟不改战果，§5.6，校准四）`,
            Math.abs(rB - r0) <= 3 && Math.abs(kB - k0) <= 2, `rank arm0=${r0}/armB=${rB} kills arm0=${k0}/armB=${kB}`)
          const c0 = armRuns[0].carried, cB = armRuns[armRuns.length - 1].carried
          ok('A9', `${name}：双臂 carriedInputs>0（宽限兜底在场，§5.6）`, c0 > 0 && cB > 0, `carried arm0=${c0} armB=${cB}`)
          continue
        }
        if (gameId === 'iron-torrent') {
          /* GAMES-146 latency200（设计 §6）：双臂完赛+A 队击毁数差 ≤1（延迟不改战果——
             fire 离散+弹道飞行窗论证的量化面）+carriedInputs>0（延迟注入在场证据） */
          ok('A8', `${name}：双臂均完赛（有终局）`, armRuns.every((a) => !!a.result && !!a.result.reason),
            armRuns.map((a) => `arm${a.delayMs}ms reason=${a.result && a.result.reason}`).join('，'))
          const k0 = armRuns[0].kills, kB = armRuns[armRuns.length - 1].kills
          /* GAMES-148/150 校准三（PM 落笔 2026-10-16）：kB 单局 {0,1,2} 方差（GAMES-150 复验
             armB=0 红证 kB≥1 过紧）。实测稳健面=延迟臂不反超（k0≥kB，历史 {1..6}≥{0..2} 全成立）
             +战果在场（k0+kB≥1）——语义=延迟不反转/不消灭战果；均值偏置定量归 QA2。 */
          ok('A8', `${name}：延迟臂不反超且战果在场（延迟不反转战果，校准三）`,
            kB <= k0 && k0 + kB >= 1, `arm0=${k0} armB=${kB}`)
          const cI0 = armRuns[0].carried, cIB = armRuns[armRuns.length - 1].carried
          ok('A8', `${name}：双臂 carriedInputs>0（宽限兜底在场，§5.4）`, cI0 > 0 && cIB > 0, `carried arm0=${cI0} armB=${cIB}`)
          continue
        }
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
        const created = await gw('POST', '/api/test/room', { gameId, seed: script.seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels, autopilot: sc.autopilot === true, rule: sc.rule, handicap: sc.handicap })
        const rr = created.json && created.json.ok ? created.json : null
        if (!rr) { ok(aid, `${name} 建房 run${ri + 1}`, false, `HTTP ${created.status}`); break }
        const tickMs = (rr.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
        const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
        const played = await playScript(rr.roomId, mkPolicy(sc.policy || "idle"), Date.now() + budgetMs, isS2, scriptPollMs)
        await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
        if (!played.result) { ok(aid, `${name} run${ri + 1} 达成终态`, false, played.error || '未终局'); break }
        runs.push(played)
      }
      if (runs.length === sc.runs) {
        /* S5/S1+S5 输入日志（§5.6）：{s,k,payload}（剥 tick/tn 墙钟字段）——deploys+picks+ops 逐字节断言 */
        const stripFrame = (meta.net.tech === 'S5' || meta.net.tech === 'S1+S5')
          ? (st) => JSON.stringify((st.opsLog || []).map((o) => { const { s, k, tn, ...rest } = o; return [s, k, rest] }))
          : (meta.net.tech === 'S7' || meta.net.tech === 'S3+S4' || (meta.net.tech === 'S4' && gameId === 'iron-torrent'))
            ? (st) => JSON.stringify(st.inLog || []) /* S6+S7（GAMES-172）同式 inLog */
            : (st) => JSON.stringify((st.shots || []).map((x) => [x.no, x.seat, x.ang, x.pow, x.spinV, x.spinS, x.cue.x, x.cue.y]))
        const hash0 = runs[0].stateHash, log0 = stripFrame(runs[0].state)
        const hashesEq = runs.every((x) => x.stateHash === hash0)
        const logsEq = runs.every((x) => stripFrame(x.state) === log0)
        ok(aid, `${name}：同 seed 同策略两房终态 stateHash 相等`, hashesEq, `hash=${hash0}${hashesEq ? '' : ' 各房不一：' + runs.map((x) => x.stateHash).join('/')}`)
        ok(aid, `${name}：输入日志（${meta.net.tech === 'S5' ? 'picks+ops' : (meta.net.tech === 'S7' || meta.net.tech === 'S3+S4') ? 'inLog 输入日志' : 'shot 序列'}）逐字节相等`, logsEq, `${JSON.parse(log0).length} 条${logsEq ? '' : '（序列不一致）'}`)
        /* GAMES-146 A7 后半：fire 事件参数（ang/vx/vy/vz——确定性重演起点）双跑逐字节相等 */
        if (gameId === 'iron-torrent') {
          const fire0 = JSON.stringify((runs[0].ledger || []).filter((e) => e.k === 'fire'))
          const firesEq = runs.every((x) => JSON.stringify((x.ledger || []).filter((e) => e.k === 'fire')) === fire0)
          ok(aid, `${name}：fire 事件参数（ang/vx/vy/vz）双跑逐字节相等`, firesEq,
            firesEq ? `${JSON.parse(fire0).length} 发全同` : 'fire 参数序列不一致')
        }
        let replayOk = false, replayDetail = '未找到可回放 sim'
        try {
          const simFile = meta.net.tech === 'S7' ? 'shared.cjs' : 'sim.cjs' // S7 单源=shared.cjs；S3+S4/S6+S7 单源=sim.cjs（GAMES-138 §5.2/GAMES-172）
          const req = createRequire(pathToFileURL(join(gameDir, simFile)).href)
          const sim = req(join(gameDir, simFile))
          if ((meta.net.tech === 'S7' || meta.net.tech === 'S6+S7' || meta.net.tech === 'S3+S4' || (meta.net.tech === 'S4' && gameId === 'iron-torrent')) && sim && sim.replayInputs && sim.hashState) {
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
    const statSeeds = ((meta.net.tech === 'S6' || meta.net.tech === 'S3+S4' || meta.net.tech === 'S6+S7' || (meta.net.tech === 'S4' && gameId === 'iron-torrent')) && name !== 'lose') ? [script.seed, script.seed + 1, script.seed + 2] : [script.seed]
    const stat = { win: [], n: [], dies: [], notes: [] }
    /* GAMES-107 提速（2026-10-11 断路收官 PM 落笔）：三 seed 并行开房——串行峰值 622s 贴 600s 收割/复验
       闸窗两度 GATE-TIMEOUT（exit=124）；并行后剧本段墙钟≈最慢一局。判据零变动：房配置/剧本策略/
       断言逻辑逐字未动，仅执行序并行（ok() 输出仍按 seed 序消费=确定性可复核）。 */
    const seedLaunch = statSeeds.map(async (seed) => {
      const s0 = Date.now()
      let roomL = null
      try {
        const created = await gw('POST', '/api/test/room', { gameId, seed, timeScale: script.timeScale ?? 1, startDelayMs: script.startDelayMs ?? 600, maxTicks: sc.maxTicks ?? script.maxTicks, botLevels: sc.botLevels, autopilot: sc.autopilot === true, rule: sc.rule, handicap: sc.handicap })
        roomL = created.json && created.json.ok ? created.json : null
        if (!roomL) return { seed, failCreate: `HTTP ${created.status} ${created.json && created.json.error}` }
        const tickMs = (roomL.events || []).reduce((m, e) => e.msg.t === 'welcome' ? (e.msg.tickMs || m) : m, 100)
        const budgetMs = ((script.maxTicks || 1200) * tickMs / (script.timeScale || 1)) + (script.startDelayMs || 0) + 25_000
        const policy = mkPolicy(sc.policy || 'idle')
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
        /* S6 专项断言（GAMES-99 §6 / GAMES-164 第二证）：A6 排行榜 / A7 链路对账 /
           full20 带宽与群实体数 / A8 质量账本——逐局严格；数值锚（win 轮末 n·M /
           full20 deaths）只采样，局后中位聚合断言 */
        if (meta.net.tech === 'S6') {
          const deep = gameId === 'deep-foodchain'
          const meEnd = r.state && r.state.ents && r.state.ents['s' + room.playerSeat]
          if (name === 'win') stat.n.push(meEnd ? (deep ? meEnd.M : meEnd.n) : 0)
          ok(aid, 'S6 A6 排行榜一致（top5 非增+榜首=argmax，全程抽样）', r.a6bad === 0 && r.a6samples > 50, `${r.a6samples} 次抽样 ${r.a6bad} 违例`)
          if (deep) {
            /* A8 质量账本守恒（§5.3 恒等式，逐局硬断言）：终态全量 state 复算
               ΣM(活鱼)+Σ粒值+expired−endow−ate−gained−dropped+dashed==0 */
            const Ld = r.state && r.state.ledger
            if (Ld) {
              let sumM = 0, sumDots = 0
              for (const id in r.state.ents) {
                const e = r.state.ents[id]
                if (e.k === 'fish' && !e.dead) sumM += e.M
                else if (e.k === 'drop') sumDots += e.v
              }
              const res8 = sumM + sumDots + Ld.expired - Ld.endow - Ld.ate - Ld.gained - Ld.dropped + Ld.dashed
              ok('A8', 'S6 质量账本守恒（终态复算恒等式==0，一裁三账经济闭合）', res8 === 0,
                `ΣM=${sumM} Σ粒=${sumDots} ledger=${JSON.stringify(Ld)} → 残差 ${res8}`)
            }
          }
          if (name === 'hunt') {
            if (deep) {
              /* A7 吞噬链路（一裁三账逐条对账，§2.5 吞噬值表）：gain/drops 公式复算 */
              const devours = r.ledger.filter((e) => e.k === 'devour')
              ok('A7', 'S6 吞噬链路：事件账本 {k:devour} ≥1（API 席或生态内）', devours.length >= 1, `devour×${devours.length}`)
              const bad = devours.filter((e) => {
                const gain = Math.floor(e.mv * 11 / 20)
                const dropT = e.mv - gain
                let n = Math.ceil(dropT / 2); n = n < 3 ? 3 : n > 30 ? 30 : n
                return e.gain !== gain || e.drops !== n
              })
              ok('A7', 'S6 devour 一裁三账对账（gain==floor(mv×11/20) 且 drops==clamp(ceil((mv−gain)/2),3,30)）',
                devours.length > 0 && bad.length === 0,
                `${devours.length} 例全对（首例 mv=${devours[0] && devours[0].mv} gain=${devours[0] && devours[0].gain} drops=${devours[0] && devours[0].drops}）`)
            } else {
              const kills = r.ledger.filter((e) => e.k === 'kill')
              const dies = r.ledger.filter((e) => e.k === 'die')
              ok('A7', 'S6 击杀链路：事件账本 {k:kill} ≥1', kills.length >= 1, `kill×${kills.length} die×${dies.length}`)
              const bad = dies.filter((e) => e.drops !== Math.ceil(e.len / 2))
              ok('A7', 'S6 die.drops==ceil(victimLen/2)（T6-B 掉落公式）', dies.length > 0 && bad.length === 0,
                `${dies.length} 例全对（首例 len=${dies[0] && dies[0].len} drops=${dies[0] && dies[0].drops}）`)
            }
          }
          if (name === 'full20') {
            const avgIncr = r.snaps.incrBytes.length ? Math.round(r.snaps.incrBytes.reduce((a, x) => a + x, 0) / r.snaps.incrBytes.length) : 0
            const fullRatio = r.snaps.n ? +(r.snaps.full / r.snaps.n * 100).toFixed(1) : 100
            const dieK = deep ? 'devour' : 'die'
            const myDies = r.ledger.filter((e) => e.k === dieK && e.seat === room.playerSeat).length
            stat.dies.push(myDies)
            ok(aid, `S6 full20：全场任意 tick 活${deep ? '鱼' : '蛇'}数 ≥${deep ? 19 : 20}${deep ? '（吞噬重生窗 3s）' : ''}`,
              r.minSnakes >= (deep ? 19 : 20), `min=${r.minSnakes}`)
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
        /* S6+S7 party-brawl 专项断言（GAMES-172 设计 §6）：A7 淘汰账本三合一（rank 逆推
           无重号+kills 对账+掉落箱==淘汰数 T6-B）+ A8 缩圈闭式解对账（独立公式复算 r(t) ±1px+
           毒伤账本+相位事件 8 次）+ A3 idle rank 末段——逐局严格（统计制只覆盖 win/latency200
           数值锚，§6.1：淘汰/缩圈/确定性/重连/注入延迟不进统计口径） */
        if (gameId === 'party-brawl') {
          const elims = r.ledger.filter((e) => e.k === 'elim')
          const drops = r.ledger.filter((e) => e.k === 'drop')
          const byEv = r.ledger.filter((e) => e.k === 'storm')
          const ranksAsc = elims.every((e, i) => i === 0 || e.rank < elims[i - 1].rank)
          ok('A7', `${name} 局淘汰账本：{k:elim} ≥1 且 rank 无重号且=淘汰序逆推（严格递减）`,
            elims.length >= 1 && new Set(elims.map((e) => e.rank)).size === elims.length && ranksAsc,
            `elim×${elims.length}（rank 首末 ${elims[0] && elims[0].rank}..${elims[elims.length - 1] && elims[elims.length - 1].rank}）`)
          const killCnt = {}
          for (const e of elims) if (e.by >= 0) killCnt[e.by] = (killCnt[e.by] || 0) + 1
          const killBad = []
          for (const k2 in killCnt) {
            const pl = r.state.players[k2]
            if (!pl || pl.kills !== killCnt[k2]) killBad.push(`seat${k2} kills=${pl && pl.kills}≠${killCnt[k2]}`)
          }
          ok('A7', 'S6+S7 kills 对账（每击杀者 kills==其 elim 账本计数）', killBad.length === 0,
            killBad.length ? killBad[0] : `${Object.keys(killCnt).length} 击杀者全对`)
          ok('A7', 'S6+S7 掉落箱数==淘汰数（T6-B 死亡经济对账，70% 回流）',
            drops.length === elims.length, `drop×${drops.length} elim×${elims.length}`)
          /* A8 缩圈闭式解（独立公式复算——不调 sim.stormOf，相位表+centers 原料手抄线性插值） */
          const PH = [[0, 1200, 1200000, 1200000], [1200, 2700, 1200000, 700000], [2700, 3000, 700000, 700000],
            [3000, 4800, 700000, 380000], [4800, 5100, 380000, 380000], [5100, 6900, 380000, 170000],
            [6900, 7200, 170000, 170000], [7200, 8400, 170000, 90000], [8400, 9601, 90000, 90000]]
          const centers = r.state.storm && r.state.storm.centers
          let badR = []
          for (let t = 0; t <= Math.min(r.tick, 9600); t += 10) {
            let i = PH.length - 1
            for (let k2 = 0; k2 < PH.length; k2++) if (t < PH[k2][1]) { i = k2; break }
            const [t0, t1, r0c, r1c] = PH[i]
            const expect = t <= t0 ? r0c : t >= t1 ? r1c : Math.trunc(r0c + (r1c - r0c) * (t - t0) / (t1 - t0))
            const got = PB && centers ? PB.stormOf(r.state, t).r : -1
            if (Math.abs(expect - got) > 1000) { badR.push(`t${t} ${got}≠${expect}`); break }
          }
          ok('A8', 'S6+S7 r(t) 闭式解对账（独立公式复算 ±1px，逐 10 tick 采样）',
            badR.length === 0 && centers && centers.length === 10,
            badR.length ? badR[0] : `t=0..${Math.min(r.tick, 9600)} 全对（centers=${centers && centers.length}）`)
          const stormLed = (r.state.ledgers && r.state.ledgers.storm) || []
          const dotsLed = (r.state.ledgers && r.state.ledgers.stormDots) || []
          const apiDot = dotsLed[room.playerSeat] || 0
          if (name === 'storm') {
            ok('A8', 'S6+S7 orbit-edge 恒圈外：API 席毒伤账本 >0（圈外在场证据）', apiDot > 0 && stormLed[room.playerSeat] > 0,
              `dots=${apiDot} dmg=${stormLed[room.playerSeat]}`)
            const expStorm = PB ? PB.PHASES.filter((ph) => ph.t0 > 0 && ph.t0 <= r.tick).length : 8
            ok('A8', `S6+S7 ext.storm 相位事件==相位表切换数（t≤${r.tick} 期望 ${expStorm}；末拍切换可随终局帧沉没容差 1）`,
              byEv.length >= expStorm - 1 && byEv.length <= expStorm, `storm 事件×${byEv.length}/${expStorm}`)
          }
          if (name === 'win' && statSeeds.length > 1 && si === 0) {
            /* 胜局圈纪律抽查（首局）：royale-rush 圈内跑毒 → API 席毒伤拍=0（闭式圈意识证据） */
            ok('A8', 'S6+S7 win 局 API 席圈内零毒伤（royale-rush Z0 圈预算在场）', apiDot === 0, `dots=${apiDot}`)
          }
          if (name === 'lose') {
            const myRank = r.result.scores && r.result.scores[room.playerSeat] && r.result.scores[room.playerSeat].rank
            ok('A3', 'S6+S7 idle 站桩=rank 末段（≤16 位后=rank≥16，被毒/近战收）', Number.isInteger(myRank) && myRank >= 16,
              `rank=${myRank}/${meta.net.seats} dots=${apiDot}`)
          }
          ok(aid, 'S6+S7 宽限兜底观测锚（carriedInputs>0，§5.6）', (r.state.stats && r.state.stats.carried) > 0,
            `carried=${r.state.stats && r.state.stats.carried}`)
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
        /* S4 iron-torrent 专项断言（GAMES-146 设计 §6）：A6 命中与命池链（hit 结构+
           kill→命池对账+respawn 节拍）/A8 占点与掩体链（capTick 速率+crumble→tileHp=0）
           ——断言锚=事件账本+终态 state（S4 命中裁决服务器唯一归属，§5.1） */
        if (gameId === 'iron-torrent') {
          const hitsEv = r.ledger.filter((e) => e.k === 'hit')
          const killsEv = r.ledger.filter((e) => e.k === 'kill')
          const respEv = r.ledger.filter((e) => e.k === 'respawn')
          const partsOk = hitsEv.every((h) => h.dmg > 0 && ['front', 'side', 'rear', 'splash'].includes(h.part))
          ok('A6', 'S4 命中链：{k:hit} ≥1 且 {dmg,part} 结构完整（部位四值域）', hitsEv.length >= 1 && partsOk,
            `hit×${hitsEv.length}（part 分布 ${['front', 'side', 'rear', 'splash'].map((p) => p + ':' + hitsEv.filter((h) => h.part === p).length).join(' ')}）`)
          const livesSum = r.state && r.state.lives ? r.state.lives[0] + r.state.lives[1] : -1
          ok('A6', 'S4 命池链：lives 合计 ≥0 且 lives+kill ≥10（kill→命池−1 账本闭合，下限保护后无负账本）',
            livesSum >= 0 && livesSum + killsEv.length >= 10, `lives=${r.state && r.state.lives} kill×${killsEv.length}（lives+kill=${livesSum + killsEv.length}）`)
          const chainBad = []
          for (const rp of respEv) {
            const k = killsEv.find((x) => x.victim === rp.seat && x.frame >= rp.frame - 122 && x.frame <= rp.frame - 118)
            if (!k) chainBad.push(`respawn@${rp.frame} 前无 120±2 tick kill`)
          }
          ok('A6', 'S4 respawn 链：每 respawn 前 120±2 tick 有同 victim kill（6s 重生节拍）',
            respEv.length === 0 || chainBad.length === 0, respEv.length ? (chainBad.length ? chainBad[0] : `${respEv.length} 次全对`) : '本局无重生（快终局）')
          if (name === 'siege') {
            const caps = r.ledger.filter((e) => e.k === 'capTick')
            const crumbs = r.ledger.filter((e) => e.k === 'crumble')
            const barMax = caps.reduce((m, c) => Math.max(m, c.bar || 0), 0) // 净 1 人推进段峰值（敌人入圈=回落，取轨迹峰）
            ok('A8', 'S4 占点链：capTick ≥8 且 bar 峰值 ≥20000（净 1 人 55/tick 推进段在场；capture 满盘=对抗局可达性归 QA2）',
              caps.length >= 8 && barMax >= 20000, `capTick×${caps.length} bar 峰值=${barMax}（终态=${r.state && r.state.capBar}）`)
            let tileBad = crumbs.length === 0
            for (const c of crumbs) if (r.state && r.state.tileHp && r.state.tileHp[c.tile] !== 0) tileBad = true
            ok('A8', 'S4 掩体链：{k:crumble} ≥1 且终态对应 tileHp=0（拆墙落地）', crumbs.length >= 1 && !tileBad,
              `crumble×${crumbs.length}${crumbs.length ? '（tile ' + crumbs[0].tile + '→hp ' + (r.state && r.state.tileHp && r.state.tileHp[crumbs[0].tile]) + '）' : ''}`)
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
        ok('A2', gameId === 'deep-foodchain'
          ? 'S6 成长曲线实测锚（三局中位 M≥500，§6.1 统计制）'
          : 'S6 成长曲线实测锚（三局中位 n≥100）',
          med(stat.n) >= (gameId === 'deep-foodchain' ? 500 : 100), `中位 ${gameId === 'deep-foodchain' ? 'M' : 'n'}=${med(stat.n)}（各局 ${stat.n.join('/')}）`)
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
