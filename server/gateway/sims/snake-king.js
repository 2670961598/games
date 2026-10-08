/* =====================================================================
 * 蛇王争霸 snake-king 服务端 sim（GAMES-99 · E6/W1/T6）——S6 海量实体首证。
 * 设计事实源：docs/designs/snake-king.md（GAMES-98 评审合并版）。
 *
 * 与 S2（mmo-township）同管线、规模换代：服务端权威 tick 制大房模拟 +
 * per-connection 个性化 AOI（r(n)=420/zoom(n)∈[420,600]，长大视野补偿）+
 * 脏实体稀疏增量（蛇增量恒带 x,y/a，n/skin/sc 变才带）+ 蛇身=path 回放
 * （节位置不入网络，两端同式 games/multiplayer/snake-king/shared.cjs 派生）。
 * 与 mmo 的差异=预算口径（附决策 5）：实体三顶（蛇 24/位 180/瞬态 240）+
 * 长度封顶 140 硬约束，无实体数裁剪；退化阈值改字节数（>180 脏或 >1.2KB 全量）。
 *
 * 常驻竞技场语义（§1.1/附决策 1）：房=常驻（META.persistent），轮（round=3600 tick）
 * 在 state 内推进——轮末加冕（king=榜首）→ kills 清零、score 重锚 n → round++ 继续，
 * 世界不清空、蛇不死光、房间不 ended（feed 恒 live、joinable 恒真）；
 * 测试房 maxTicks=3600 投影终局（winner A=API 席 score≥120）。
 * Bot 三档=生态位（§4/附决策 9）：casual 饲料蛇（供给）/balanced 觅食者/
 * competitive 猎手（矿区蹲守+拦截预判+危险断尾）——首版均衡完整、其余基础实现，
 * 深化归 #5 BOT 单。确定性：无 Date/random 入判定路径（seed 纪律同 mmo）。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const P = require('../../../games/multiplayer/snake-king/shared.cjs')

/* ---------- 随机源（协议 §5 纪律：seed=fnv1a32(roomId) 经 mulberry32） ---------- */
function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- 数值表（设计 §2 可直接对书核验） ---------- */
const TICK_MS = 100
const REGEN = { grass: 150, berry: 250, ore: 400 }        // 回填 15s/25s/40s（§2.2）
const SITE_V = { grass: 1, berry: 2, ore: 4 }             // +节
const SITES = { grass: 120, berry: 40, ore: 20 }          // 位数量（§1.4）
const MILESTONES = { 25: '幼蛇', 60: '长蛇', 100: '巨蟒', 140: '蛇王之姿' } // §2.6
const SKINS = 8                                            // §2.5 皮肤表
const GOAL = 120                                           // 轮末达标线（§6 endState）
const SPAWN_HEAD_GAP = 320_000, SPAWN_SEG_GAP = 80_000     // 出生安全位（§5.1）
const AFK_TICKS = 600                                      // 60s 无输入 → casual 托管（§4.1）
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const RAD = Math.PI / 180
const dist2 = (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay)

/* =====================================================================
 * create(seed, opts) —— 世界布局（资源位 seed 派生，§2.2）
 * ===================================================================== */
function create(seed, opts = {}) {
  const rng = mulberry32(seed >>> 0)
  const jit = (span) => Math.trunc((rng() * 2 - 1) * span)
  const ents = {}
  const addSite = (id, k, x, y) => { ents[id] = { id, k, x, y, v: SITE_V[k], on: 1, rt: 0 } }
  // 草：全区网格抖动 120 位（12×10）
  for (let i = 0; i < SITES.grass; i++)
    addSite('g' + i, 'grass', 90000 + (i % 12) * 147000 + jit(45000), 90000 + ((i / 12) | 0) * 175000 + jit(45000))
  // 果：四象限角果园带 ×10=40（§2.2）
  for (let i = 0; i < SITES.berry; i++) {
    const q = i % 4, j = (i / 4) | 0
    const cx = q % 2 === 0 ? 300000 : 1500000, cy = q < 2 ? 300000 : 1500000
    addSite('b' + i, 'berry', cx + (j % 5) * 60000 + jit(30000), cy + ((j / 5) | 0) * 60000 + jit(30000))
  }
  // 矿：中央王座环 r≤300px 20 位（§2.2）
  for (let i = 0; i < SITES.ore; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 300000
    addSite('o' + i, 'ore', 900000 + Math.trunc(Math.cos(a) * r), 900000 + Math.trunc(Math.sin(a) * r))
  }
  return {
    v: 1, gameId: 'snake-king', seed: seed >>> 0, tick: 0,
    testRoom: !!opts.test, maxTicks: opts.test ? (opts.maxTicks ?? null) : null,
    map: { w: P.W, h: P.H },
    round: { n: 1, tick: 0, king: -1 },
    ents, leaderboard: [], dropSeq: 0,
    afk: {},          // seat → 上一拍输入签名（AFK 托管判定）
    stats: { snakes: 0, deaths: 0, kills: 0, drops: 0 },
  }
}

/* ---------- 蛇生成 ---------- */
function safeSpawn(st, seat) {
  const rng = mulberry32((st.seed ^ Math.imul(seat + 1, 0x9e3779b9) ^ Math.imul(st.tick + 1, 2654435761)) >>> 0)
  const heads = [], segsAll = []
  for (const id in st.ents) {
    const e = st.ents[id]
    if (e.k !== 'snake' || e.dead) continue
    heads.push(e)
    const sg = P.segsFromPath(e.path, e.n)
    for (let i = 2; i + 1 < sg.length; i += 2) segsAll.push([sg[i], sg[i + 1]])
  }
  let best = null, bestScore = -1
  for (let tries = 0; tries < 24; tries++) {
    const relax = tries >= 12, relax2 = tries >= 20
    const hg = relax2 ? 0 : relax ? 240_000 : SPAWN_HEAD_GAP
    const sg2 = relax2 ? 0 : relax ? 60_000 : SPAWN_SEG_GAP
    const x = 120000 + Math.trunc(rng() * (P.W - 240000)), y = 120000 + Math.trunc(rng() * (P.H - 240000))
    let ok = true, minD = Infinity
    for (const h of heads) {
      const d = dist2(x, y, h.x, h.y); if (d < minD) minD = d
      if (d < hg * hg) { ok = false; break }
    }
    if (ok && sg2) for (const s of segsAll) {
      const d = dist2(x, y, s[0], s[1]); if (d < minD) minD = d
      if (d < sg2 * sg2) { ok = false; break }
    }
    if (ok) return { x, y }
    if (minD > bestScore) { bestScore = minD; best = { x, y } }
  }
  return best || { x: (P.W / 2) | 0, y: (P.H / 2) | 0 } // 20 次失败取最远点（§5.1）
}
function assignSkin(st, seat) {
  const rng = mulberry32((st.seed ^ Math.imul(seat + 1, 0x9e3779b9)) >>> 0)
  const used = new Set()
  for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'snake') used.add(e.skin) }
  for (let t = 0; t < 8; t++) { const s = (rng() * SKINS) | 0; if (!used.has(s)) return s } // 同房去重（§2.5）
  return (rng() * SKINS) | 0
}
function spawnSnake(st, seat, name, dead) {
  const pos = safeSpawn(st, seat)
  const a = (((seat * 47) % 24) * 15 + 5) % 360 // 席位错角落生（确定性，无 rng）
  const path = [pos.x, pos.y]
  const ca = Math.cos(a * RAD), sa = Math.sin(a * RAD)
  for (let i = 1; i <= P.N0; i++) path.push(Math.round(pos.x - ca * 12000 * i), Math.round(pos.y - sa * 12000 * i))
  const old = st.ents['s' + seat]
  const sn = {
    id: 's' + seat, k: 'snake', seat, name: name || ('蛇' + seat),
    x: pos.x, y: pos.y, a, ta: null, n: P.N0, skin: old ? old.skin : assignSkin(st, seat),
    score: P.N0 + (old ? old.kills * 15 : 0), kills: old ? old.kills : 0, deaths: old ? old.deaths : 0,
    maxLen: old ? Math.max(old.maxLen, old.n) : P.N0,
    boosting: false, dead: 0, respawnAt: 0, prot: P.SPAWN_PROT, ms: 0,
    path, mem: { dt: 0, wp: null, tg: null, hunt: null, boost: 0, ta: a, wall: 0, huntCd: 200 },
  }
  st.ents['s' + seat] = sn
  return sn
}
/* 死亡掉落（§2.4：ceil(n/2) 个 value-2 沿身体每隔 1 节；瞬态 ≤240 硬顶最旧蒸发） */
function dropCorpse(st, sn, by, events) {
  const drops = Math.ceil(sn.n / 2)
  const sg = P.segsFromPath(sn.path, sn.n)
  const step = Math.max(2, Math.floor(sg.length / 2 / drops) * 2)
  for (let d = 0; d < drops; d++) {
    const i = Math.min(sg.length - 2, d * step)
    addDrop(st, sg[i], sg[i + 1], 2, 'body')
  }
  sn.dead = 1; sn.respawnAt = st.tick + P.RESPAWN_TICKS; sn.deaths++
  sn.boosting = false; sn.ta = null
  sn.score = P.N0 + sn.kills * 15            // 长度分蒸发、击杀荣誉留存（§1.3）
  sn.maxLen = Math.max(sn.maxLen, sn.n)
  st.stats.deaths++
  events.push({ k: 'die', seat: sn.seat, by, len: sn.n, drops })
  if (by >= 0) {
    const killer = st.ents['s' + by]
    if (killer && !killer.dead) { killer.kills++; killer.score += 15; st.stats.kills++; events.push({ k: 'kill', seat: sn.seat, by, victimLen: sn.n }) }
  }
  sn.n = P.N0
}
function addDrop(st, x, y, v, src) {
  // 硬顶 240：超限最旧蒸发（护栏，§2.4）
  if (st.dropSeq >= P.DROPS_CAP) {
    let oldest = null
    for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'drop' && (!oldest || e.born < oldest.born)) oldest = e }
    if (oldest) delete st.ents[oldest.id]
  }
  const id = 'd' + (st.dropSeq++)
  st.ents[id] = { id, k: 'drop', x: clamp(x, 8000, P.W - 8000), y: clamp(y, 8000, P.H - 8000), v, src, born: st.tick, ttl: P.DROP_TTL }
  st.stats.drops++
  return id
}

/* =====================================================================
 * step —— tick 结算序（§5.1：inputs→转向→移动→boost 掉节→吃→碰撞（扫掠）→
 * 死亡/复活→资源回填→里程碑/王座分→排行榜（10 tick 节流）→AOI/组包在 emit）
 * ===================================================================== */
function step(st, inputs, room) {
  const events = []
  const dirty = new Set()
  const kinds = room ? room.seats.map((s) => s.kind) : null

  /* 0. 席位自愈：激活席补蛇/续名；空位蛇清场（出视野 leave 由各连接 known 自动下发） */
  if (room) {
    for (let i = 0; i < room.seats.length; i++) {
      const kind = room.seats[i].kind
      const active = kind === 'human' || kind === 'bot'
      const sn = st.ents['s' + i]
      if (active && !sn) { spawnSnake(st, i, room.seats[i].name); events.push({ k: 'spawn', seat: i, n: P.N0 }) }
      if (active && sn) sn.name = room.seats[i].name || sn.name
      if (!active && sn) delete st.ents['s' + i]
    }
  }
  const live = []
  for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'snake' && !e.dead) live.push(e) }
  st.stats.snakes = live.length

  /* 0b. AFK 托管（§4.1）：human 席连续 60s 输入签名不变 → casual 代打（kind 不变，输入即夺回） */
  for (const sn of live) {
    if (!kinds || kinds[sn.seat] !== 'human') { st.afk[sn.seat] = null; continue }
    const inp = inputs[sn.seat] || {}
    const sig = inp.a + ':' + (inp.boost ? 1 : 0)
    if (st.afk[sn.seat] && st.afk[sn.seat].sig === sig) st.afk[sn.seat].t++
    else st.afk[sn.seat] = { sig, t: 0 }
    if (st.afk[sn.seat].t >= AFK_TICKS) {
      const bot = brainImpl(st, sn.seat, 'casual', mulberry32((st.seed ^ Math.imul(sn.seat + 7, 0x85ebca6b)) >>> 0), null)
      inputs[sn.seat] = bot
    }
  }

  /* 1. 转向积分（ω(n)，boost ×0.85）→ 移动积分（v(n)，boost ×1.6）→ path push */
  for (const sn of live) {
    const inp = inputs[sn.seat] || {}
    if (Number.isFinite(inp.a)) sn.ta = ((Math.trunc(inp.a) % 360) + 360) % 360
    const wantBoost = inp.boost === 1
    if (wantBoost && sn.n >= 16) sn.boosting = true           // 仅 n≥16 可用（§2.3）
    if (!wantBoost || sn.n <= 10) sn.boosting = false         // 掉至 n=10 自动熄灭
    const w = Math.max(1, Math.round(P.wOf(sn.n) * (sn.boosting ? 0.85 : 1)))
    sn.a = P.stepTurn(sn.a, sn.ta == null ? sn.a : sn.ta, w)
    const v = Math.round(P.vOf(sn.n) * (sn.boosting ? 1.6 : 1))
    const px = sn.x, py = sn.y
    sn.x = clamp(sn.x + Math.round(Math.cos(sn.a * RAD) * v), -20000, P.W + 20000)
    sn.y = clamp(sn.y + Math.round(Math.sin(sn.a * RAD) * v), -20000, P.H + 20000)
    sn.px = px; sn.py = py
    sn.path.unshift(Math.round(sn.x), Math.round(sn.y))
    if (sn.path.length > P.PATH_CAP * 2) sn.path.length = P.PATH_CAP * 2
    if (sn.prot > 0) sn.prot--
    dirty.add(sn.id)
    /* 2. boost 掉节（每 5 tick 掉 1 节成 value-1 光点，§2.3 可控断尾） */
    if (sn.boosting && st.tick % 5 === 0 && sn.n > P.N0) {
      sn.n--
      const sg = P.segsFromPath(sn.path, sn.n + 1)
      const i = sg.length - 2
      addDrop(st, sg[i], sg[i + 1], 1, 'tail')
    }
  }

  /* 3. 吃光点判定（头圆 r7 vs 光点圆 r7 距离 <14px，服务器逐 tick，§2.2） */
  for (const sn of live) {
    for (const id in st.ents) {
      const e = st.ents[id]
      if (e.k === 'grass' || e.k === 'berry' || e.k === 'ore') {
        if (!e.on || dist2(sn.x, sn.y, e.x, e.y) > 196_000_000) continue // 14000²
        e.on = 0; e.rt = REGEN[e.k]; dirty.add(id)
        growSnake(st, sn, e.v, id, events)
      } else if (e.k === 'drop') {
        if (dist2(sn.x, sn.y, e.x, e.y) > 196_000_000) continue
        delete st.ents[id]
        growSnake(st, sn, e.v, id, events)
      }
    }
  }

  /* 4. 碰撞判定（扫掠：头位移线段 vs 体节圆，§5.1/附决策 7）——空间哈希 cell 60px */
  const CELL = 60000
  const hash = new Map()
  const segsCache = new Map()
  const key = (x, y) => ((x / CELL) | 0) + ',' + ((y / CELL) | 0)
  for (const sn of live) {
    const sg = P.segsFromPath(sn.path, sn.n)
    segsCache.set(sn.id, sg)
    for (let i = 2; i + 1 < sg.length; i += 2) { // 跳过头节（自撞不存在，io 惯例）
      const k = key(sg[i], sg[i + 1])
      const arr = hash.get(k)
      if (arr) arr.push(sg[i], sg[i + 1], sn.seat)
      else hash.set(k, [sg[i], sg[i + 1], sn.seat])
    }
  }
  const dead = (sn, by) => { dropCorpse(st, sn, by, events); sn.died = 1 }
  for (const sn of live) {
    if (sn.died || sn.prot > 0) continue // 出生保护双向穿透（§2.4）
    /* 撞墙（边距 <8px） */
    if (sn.x < P.WALL_MARGIN || sn.y < P.WALL_MARGIN || sn.x > P.W - P.WALL_MARGIN || sn.y > P.H - P.WALL_MARGIN) { dead(sn, -1); continue }
    /* 头位移线段 vs 他蛇体节（扫掠防隧穿） */
    let hit = -2
    const x0 = Math.min(sn.px, sn.x) - P.HIT_R, x1 = Math.max(sn.px, sn.x) + P.HIT_R
    const y0 = Math.min(sn.py, sn.y) - P.HIT_R, y1 = Math.max(sn.py, sn.y) + P.HIT_R
    for (let cx = (x0 / CELL) | 0; cx <= (x1 / CELL) | 0; cx++) {
      for (let cy = (y0 / CELL) | 0; cy <= (y1 / CELL) | 0; cy++) {
        const arr = hash.get(cx + ',' + cy)
        if (!arr) continue
        for (let i = 0; i + 2 < arr.length; i += 3) {
          if (arr[i + 2] === sn.seat) continue
          const other = st.ents['s' + arr[i + 2]]
          if (!other || other.dead || other.prot > 0) continue
          if (P.segDist2(arr[i], arr[i + 1], sn.px, sn.py, sn.x, sn.y) < P.HIT_R * P.HIT_R) { hit = arr[i + 2]; break }
        }
        if (hit !== -2) break
      }
      if (hit !== -2) break
    }
    if (hit >= 0) { dead(sn, hit); continue }
    /* 头对头（双头距 <14px：|Δn|>2 短者死，≤2 双死互不计，§2.4） */
    for (const o of live) {
      if (o === sn || o.died || o.prot > 0) continue
      if (dist2(sn.x, sn.y, o.x, o.y) >= 196_000_000) continue
      const dn = sn.n - o.n
      if (dn > 2) dead(sn, o.seat)
      else if (dn < -2) dead(o, sn.seat)
      else { dead(sn, -1); dead(o, -1) }
      break
    }
  }

  /* 5. 复活（死亡 tick+30 安全位重生 n=10，§1.2） */
  for (const id in st.ents) {
    const sn = st.ents[id]
    if (sn.k !== 'snake' || !sn.dead || st.tick < sn.respawnAt) continue
    const keep = { skin: sn.skin, kills: sn.kills, deaths: sn.deaths, maxLen: sn.maxLen, name: sn.name }
    delete st.ents[id]
    const fresh = spawnSnake(st, sn.seat, keep.name)
    fresh.skin = keep.skin; fresh.kills = keep.kills; fresh.deaths = keep.deaths
    fresh.maxLen = keep.maxLen; fresh.score = P.N0 + keep.kills * 15
    events.push({ k: 'spawn', seat: sn.seat, n: P.N0 })
  }

  /* 6. 资源回填（吃后计时回填，§2.2）+ 瞬态光点 TTL */
  for (const id in st.ents) {
    const e = st.ents[id]
    if (REGEN[e.k] && !e.on) {
      if (--e.rt <= 0) { e.on = 1; e.rt = 0; dirty.add(id) }
    } else if (e.k === 'drop' && --e.ttl <= 0) delete st.ents[id]
  }

  /* 7. 里程碑（§2.6）+ 王座分（score 已在吃/击杀时累计） */
  for (const sn of live) {
    if (sn.died) continue
    for (const t in MILESTONES) {
      const th = +t
      if (sn.n >= th && sn.ms < th) {
        sn.ms = th
        events.push({ k: 'milestone', seat: sn.seat, n: th, t: MILESTONES[t], world: th >= 100 })
      }
    }
  }

  /* 8. 测试房投影终局（§6 endState：生产常驻房不终局）。
   * goal 双条件=score≥120 且 n≥100（§6 A2 实测锚成对绑定：击杀流单独到分不出果——
   * 成长曲线锚与达标线同刻成立才算 goal；轮末投影仍按 score 单判，§6 endState 原文）。
   * 排序红线：投影必须先于轮末 rollover（kills 清零/score 重锚）——maxTicks==ROUND_TICKS
   * 同拍时后投影会读到重锚后的 score=n，轮末分数被抹、终局失真 */
  let over = null
  if (st.testRoom && st.maxTicks != null && room) {
    const humans = room.seats.filter((s) => s.kind === 'human').map((s) => s.seat)
    const scores = {}
    for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'snake') scores[e.seat] = e.score }
    const me0 = humans.length ? st.ents['s' + humans[0]] : null
    const apiScore = Math.max(0, ...humans.map((s) => scores[s] || 0))
    if (apiScore >= GOAL && me0 && me0.n >= 100) over = { winner: 'A', reason: 'goal', scores }
    else if (st.tick >= st.maxTicks) over = { winner: 'B', reason: 'round-end', scores }
  }

  /* 9. 轮赛推进（§1.1：轮末加冕→kills 清零、score 重锚 n→round++；房不清） */
  st.round.tick++
  if (st.round.tick >= P.ROUND_TICKS) {
    let top = null
    for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'snake' && (!top || e.score > top.score)) top = e }
    if (top) {
      st.round.king = top.seat
      events.push({ k: 'crown', round: st.round.n, seat: top.seat, name: top.name, score: top.score })
    }
    st.round.n++; st.round.tick = 0
    for (const id in st.ents) {
      const e = st.ents[id]
      if (e.k !== 'snake') continue
      e.kills = 0; e.score = e.n // 排行清零：击杀清零、score 重锚长度（§1.3）
    }
  }

  /* 10. 排行榜（逐 tick 重算保证任意 tick 抽样 A6 不变量成立；下发节流在 emit ext.lb 1Hz，§5.3）
   * top10：HUD 紧凑面板 top5 + tap 展开 top10（§7）；A6 断言口径=top5 非增不变量不受影响 */
  st.leaderboard = Object.values(st.ents)
    .filter((e) => e.k === 'snake')
    .sort((a, b) => b.score - a.score || a.seat - b.seat)
    .slice(0, 10)
    .map((e) => ({ seat: e.seat, name: e.name, n: e.n, kills: e.kills, score: e.score }))
  if (st.tick % 10 === 0) { // 小地图密度点（1Hz，§7「20 蛇实时小点」HUD 数据源；ext 自由键）
    st.mm = Object.values(st.ents).filter((e) => e.k === 'snake' && !e.dead).map((e) => [e.seat, Math.round(e.x / 1000), Math.round(e.y / 1000), e.n])
  }

  st.tick++
  return { events, dirty, over: !!over, result: over || null }
}
function growSnake(st, sn, v, id, events) {
  if (sn.n < P.N_CAP) sn.n = Math.min(P.N_CAP, sn.n + v) // value=+节数（草1/果2/矿4，§2.2）
  sn.score += v // 封顶后只加 score 不加节（§2.3/附决策 11；未封顶时恒 score=n+kills×15）
  events.push({ k: 'eat', seat: sn.seat, id, v })
}

/* =====================================================================
 * Bot brain（§4 三档生态位；决策间隔 30/12/8 tick，决策拍内闭式解 <2ms）
 * casual=随机巡游+航向漂移+弱避障（饲料蛇·尸体供给主力=自然死亡源）；
 * balanced=AOI 光点价值评估（v/(d+60px)、尸体簇×1.6、避蛇锥）+机会击杀（嘴边咬）；
 * competitive=三技完整（拦截预判闭式解/围杀弧线走位/危险断尾，GAMES-102 深化）。
 * 人格参数表（可观测梯度断言源，scripts/snake-king-bot2-check.mjs N1）：
 *   drift=决策拍航向随机漂移度数（casual 漫游观感）；eatR=觅食半径（顺路→AOI→全图）；
 *   hunt=猎物搜索半径（0=不猎）；avoid=避障强度（危险半径缩放——casual 0.55=贴脸才避，
 *   碰撞死亡=自然死亡源；墙逃逸不缩放：供给是碰撞流不是撞墙流）；wallM/probeD 同前。
 * ===================================================================== */
const BOT_EVERY = { casual: 30, balanced: 12, competitive: 8 }
const PERSONA = {
  casual:      { drift: 7, eatR: 150_000, hunt: 0,       avoid: 0.55, wallM: 100_000, probeD: 100_000 },
  balanced:    { drift: 0, eatR: 420_000, hunt: 60_000,  avoid: 0.85, wallM: 120_000, probeD: 100_000 },
  competitive: { drift: 0, eatR: 460_000, hunt: 400_000, avoid: 1.0,  wallM: 160_000, probeD: 110_000 },
}
/* 陪玩放水（GAMES-102，参照 GAMES-81 pool/GAMES-91 element 先例）：snake-king 常驻房
 * 无终局 → rooms pulse.lose 恒 0，连败代理改用房内可观测面：真人蛇 state.deaths/kills
 * （dropCorpse 逐 tick 累计）。梯度（env.kinds 标 human 席才适用，bot 对 bot 全力）：
 *   L1 连败（deaths≥minFoeLose 且 kills==0）→ 免猎 + 头对头礼让（近碾压位侧偏）；
 *   L2 重败（deaths≥hardFoeLose 且 kills==0）→ 再让食（真人 eatR*0.3 内光点不凑）。
 * 生态位让位（swarm 房真人立足期）：human 席 n<majorN 成长保护窗不列猎物。
 * 阈值入 game.json bot.mercy 可调；适配器出口包装注入 env.mercy（离线确定性不读文件，
 * brain 缺省兜底 minFoeLose=2/hardFoeLose=4/majorN=40，element-duel 同式）。 */
const MERCY_DFT = { minFoeLose: 2, hardFoeLose: 4, majorN: 40 }
/** 争抢避让：光点 90px 内有更近的他蛇头 → 不凑（防扎堆对撞；生态击杀流锚设计口径） */
function crowded(st, sn, dot) {
  const dme = dist2(sn.x, sn.y, dot.x, dot.y)
  for (const id in st.ents) {
    const e = st.ents[id]
    if (e.k !== 'snake' || e.seat === sn.seat || e.dead) continue
    if (dist2(e.x, e.y, dot.x, dot.y) < dme) return true
  }
  return false
}
/** 放水 L2 让食：重败真人（mercyOf 档 2）r 内的光点不凑 */
function mercyFoeNear(foes, mercyOf, dot, r) {
  for (const f of foes) {
    if ((mercyOf.get(f.seat) || 0) < 2) continue
    if (dist2(f.x, f.y, dot.x, dot.y) < r * r) return true
  }
  return false
}
function brainImpl(st, seat, level, rng, env) {
  const sn = st.ents['s' + seat]
  if (!sn || sn.dead) return { a: 0, boost: 0 }
  const mem = sn.mem
  const per = PERSONA[level] || PERSONA.balanced
  const mercy = (env && env.mercy) || MERCY_DFT
  const deg = (x, y) => ((Math.atan2(y - sn.y, x - sn.x) / Math.PI * 180) % 360 + 360) % 360
  const near = (x, y) => dist2(sn.x, sn.y, x, y)
  const dots = []
  for (const id in st.ents) {
    const e = st.ents[id]
    if ((e.k === 'grass' || e.k === 'berry' || e.k === 'ore') && e.on) dots.push(e)
    else if (e.k === 'drop') dots.push(e)
  }
  const foes = []
  const mercyOf = new Map() // 席位 → 放水档（1=免猎+头对头礼让 / 2=再让食；仅 human 席）
  const isHuman = env && env.kinds ? (s) => env.kinds[s] === 'human' : () => false
  for (const id in st.ents) {
    const e = st.ents[id]
    if (e.k !== 'snake' || e.seat === seat || e.dead) continue
    foes.push(e)
    if (isHuman(e.seat) && e.kills === 0) {
      if (e.deaths >= mercy.hardFoeLose) mercyOf.set(e.seat, 2)
      else if (e.deaths >= mercy.minFoeLose) mercyOf.set(e.seat, 1)
    }
  }
  const v = P.vOf(sn.n)
  const toCenter = () => deg(P.W / 2, P.H / 2)

  if (mem.dt <= 0) {
    mem.dt = BOT_EVERY[level] || 12
    mem.boost = 0
    /* 猎物过滤（放水链+生态位让位）：连败真人（L1）免猎；human 席 majorN 成长保护
       窗内不猎——真人进 swarm 房立足期 bot 生态位让位（击杀压力全档豁免） */
    const huntable = (f) => !mercyOf.has(f.seat) && !(isHuman(f.seat) && f.n < mercy.majorN)
    if (level === 'casual') {
      // 漫游者：分区随机 waypoint 慢逛+航向随机漂移（drift），路过光点顺路吃（不追，§4）
      if (!mem.wp || near(mem.wp.x, mem.wp.y) < 160_000) {
        mem.wp = { x: 150000 + ((rng() * (P.W - 300000)) | 0), y: 150000 + ((rng() * (P.H - 300000)) | 0) }
      }
      let pass = null, pd = per.eatR * per.eatR
      for (const d of dots) { const d2 = near(d.x, d.y); if (d2 < pd) { pd = d2; pass = d } }
      let ta = pass ? deg(pass.x, pass.y) : deg(mem.wp.x, mem.wp.y)
      ta += (rng() * 2 - 1) * per.drift * 10 // 漂移 ±drift×10°（巡游观感+蛇形路径）
      mem.ta = ((ta % 360) + 360) % 360
    } else if (level === 'balanced') {
      // 觅食者：AOI 内 v/(dist+60px) 贪心；尸体簇×1.6；避蛇锥 100px（§4）
      // +机会击杀（hunt 半径内嘴边碾压位直捣头位微前导 ≤4 tick 不 boost——
      //   剧本 kill-hunt 招式移植：不刻意远追、击杀是碰撞涌现）
      let snap = null, sd = Infinity
      if (per.hunt > 0 && sn.n >= 20) {
        for (const f of foes) {
          if (!huntable(f) || f.n > sn.n * 0.6 || f.prot > 0 || sn.n - f.n <= 2) continue
          const d2 = near(f.x, f.y)
          if (d2 < per.hunt * per.hunt && d2 < sd) { sd = d2; snap = f }
        }
      }
      if (snap) {
        const pv = P.vOf(snap.n), d = Math.sqrt(sd)
        const lead = Math.min(d, pv * 4)
        mem.ta = deg(snap.x + Math.cos(snap.a * RAD) * lead, snap.y + Math.sin(snap.a * RAD) * lead)
        mem.wp = null
      } else {
        let best = null, bs = -1
        for (const d of dots) {
          const dd2 = near(d.x, d.y)
          if (dd2 > per.eatR * per.eatR) continue            // AOI 半径截断（PERSONA.eatR）
          if (d.k !== 'drop' && crowded(st, sn, d)) continue // 争抢避让（尸体簇=公共宴席不避）
          if (mercyFoeNear(foes, mercyOf, d, 120_000)) continue // 放水 L2：重败真人 120px 内光点不凑
          const dd = Math.sqrt(dd2)
          let s = (d.v || SITE_V[d.k] || 1) * 60000 / (dd + 60000) * (0.7 + rng() * 0.6) // 抖动散伙（mmo pickSite 同式）
          if (d.k === 'drop') s *= 1.6
          if (s > bs) { bs = s; best = d }
        }
        mem.ta = best ? deg(best.x, best.y) : mem.ta
        if (best && (best.v || 0) >= 4 && near(best.x, best.y) > 360_000 * 360_000 && sn.n >= 16) mem.boost = 1 // 偶尔冲刺
      }
    } else {
      // 猎手：矿区巡逻偏好 + 拦截预判闭式解 + 围杀弧线走位 + 危险断尾（§4 三技完整）。
      // 成体门槛：己方 n≥25 才开猎（幼蛇先吃成体——房内击杀流锚回 §1.4 设计口径）
      let prey = null, pd = Infinity
      if (sn.n >= 25 && !(mem.huntCd > 0)) {
        for (const f of foes) {
          if (!huntable(f) || f.n > sn.n * 0.6 || f.prot > 0) continue
          const d2 = near(f.x, f.y)
          if (d2 < per.hunt * per.hunt && d2 < pd) { pd = d2; prey = f }
        }
      }
      if (mem.huntCd > 0) mem.huntCd--
      if (prey) {
        const pv = P.vOf(prey.n)
        const d = Math.sqrt(pd)
        const t = clamp(d / Math.max(20000, v * 1.6 - pv), 5, 60) // 追击几何闭式近似（§4 拦截）
        const ix = prey.x + Math.cos(prey.a * RAD) * pv * t, iy = prey.y + Math.sin(prey.a * RAD) * pv * t
        /* 围杀弧线走位（三技之二，GAMES-102）：拦截点沿 prey 航向法向偏 min(80px, d×35%)
           到远离己方的一侧——逼近轨迹先横切前缘再收口成弧线：猎物直逃撞拦截点、
           回转撞己身（闭式无随机）；侧向叉积定远离侧 */
        const nx = -Math.sin(prey.a * RAD), ny = Math.cos(prey.a * RAD)
        const side = (prey.x - sn.x) * ny - (prey.y - sn.y) * nx > 0 ? -1 : 1
        const off = Math.min(80_000, d * 0.35)
        mem.ta = deg(clamp(ix + nx * side * off, 60000, P.W - 60000), clamp(iy + ny * side * off, 60000, P.H - 60000))
        if (d > 200_000 && sn.n >= 16) mem.boost = 1
        mem.wp = null
      } else {
        /* 觅食（每拍重选，GAMES-102：原 waypoint 到达才重选——饲料生态里吃速垫底、
           成体开猎窗（n≥25）推迟，猎手也要吃饭；矿区引力=王座环 300px 内光点 ×1.5
           （蹲守偏好），无可选光点回落巡逻点） */
        let best = null, bs = -1
        for (const d of dots) {
          if (near(d.x, d.y) > per.eatR * per.eatR) continue
          if (crowded(st, sn, d)) continue // 争抢避让：更近他蛇头的光点不凑（防扎堆对撞）
          if (mercyFoeNear(foes, mercyOf, d, 120_000)) continue // 放水 L2 让食
          let s = (d.v || SITE_V[d.k] || 1) * 60000 / (Math.sqrt(near(d.x, d.y)) + 60000) * (0.8 + rng() * 0.4)
          if (dist2(d.x, d.y, 900000, 900000) < 300_000 * 300_000) s *= 1.5
          if (s > bs) { bs = s; best = d }
        }
        if (best) { mem.wp = { x: best.x, y: best.y }; mem.ta = deg(best.x, best.y) }
        else if (!mem.wp || near(mem.wp.x, mem.wp.y) < 200_000) {
          const a2 = rng() * Math.PI * 2, r = rng() * 300000 // 中央王座环巡逻（引力井蹲守）
          mem.wp = { x: 900000 + Math.trunc(Math.cos(a2) * r), y: 900000 + Math.trunc(Math.sin(a2) * r) }
          mem.ta = deg(mem.wp.x, mem.wp.y)
        } else mem.ta = deg(mem.wp.x, mem.wp.y)
      }
    }
    /* 放水 L1 头对头礼让：连败真人进入碾压位（<90px 且 |Δn|>2）→ 航向侧偏 25° 让头
       （追击/觅食向保留，仅避开正面撞杀线——避障护栏兜底不会冲墙） */
    for (const f of foes) {
      if ((mercyOf.get(f.seat) || 0) < 1) continue
      if (near(f.x, f.y) < 90_000 * 90_000 && Math.abs(sn.n - f.n) > 2) {
        const away = deg(f.x, f.y) + 90 // 垂直于指向真人的方向侧偏
        mem.ta = (((mem.ta + 25 * (P.angDiff(mem.ta, away) >= 0 ? 1 : -1)) % 360) + 360) % 360
        break
      }
    }
  }
  mem.dt--
  let ta = mem.ta == null ? sn.a : mem.ta
  let boost = mem.boost ? 1 : 0

  /* 逐拍避障（决策间隔外的连续护栏，§4 前瞻避障；PERSONA.avoid=危险半径缩放：
   * casual 0.55 贴脸才避=碰撞流自然死亡源；墙逃逸不缩放（供给是碰撞流不是撞墙流） */
  const wallM = per.wallM
  /* 墙：头进入 wallBand+60px 位置带 → 连续 12 拍向心逃逸（防出带即回摆振荡撞墙）；
   * 带内墙逃逸优先于避蛇（被"逼撞"进墙是围杀博弈，bot 不主动赴死——§2.4 撞墙死） */
  const inWallBand = sn.x < wallM + 60000 || sn.y < wallM + 60000 || sn.x > P.W - wallM - 60000 || sn.y > P.H - wallM - 60000
  if (inWallBand) mem.wall = 12
  if (mem.wall > 0) {
    mem.wall--
    ta = toCenter()
  } else {
    /* 蛇：头前锥探测（含对方头=头对头预警）+ 贴身半径（×avoid），危险点反向逃逸；
       反向若指墙（wallM 带）折向世界心 */
    const probeD = per.probeD
    const hr = Math.round(20000 * per.avoid), br = Math.round(18000 * per.avoid) // 贴身头/体半径×avoid
    const ax = sn.x + Math.cos(sn.a * RAD) * probeD, ay = sn.y + Math.sin(sn.a * RAD) * probeD
    let danger = null, dd = (26000 * per.avoid) * (26000 * per.avoid)
    for (const f of foes) {
      let d = dist2(f.x, f.y, ax, ay); if (d < dd) { dd = d; danger = f } // 对方头（头对头预警）
      d = dist2(f.x, f.y, sn.x, sn.y); if (d < hr * hr && d < dd) { dd = d; danger = f }
      const sg = P.segsFromPath(f.path, f.n)
      for (let i = 2; i + 1 < sg.length; i += 2) {
        d = dist2(sg[i], sg[i + 1], ax, ay); if (d < dd) { dd = d; danger = { x: sg[i], y: sg[i + 1] } }
        d = dist2(sg[i], sg[i + 1], sn.x, sn.y); if (d < br * br && d < dd) { dd = d; danger = { x: sg[i], y: sg[i + 1] } }
      }
    }
    if (danger) {
      const dx = danger.x, dy = danger.y
      ta = ((Math.atan2(sn.y - dy, sn.x - dx) / Math.PI * 180) % 360 + 360) % 360 // 危险点反向
      const t2 = ta * RAD, px2 = sn.x + Math.cos(t2) * wallM, py2 = sn.y + Math.sin(t2) * wallM
      if (px2 < 40000 || py2 < 40000 || px2 > P.W - 40000 || py2 > P.H - 40000) ta = toCenter()
      if (level === 'competitive' && sn.n >= 16 && dd < 20000 * 20000) boost = 1 // 危险断尾（§4 三技之三）
    }
  }
  return { a: Math.round(ta), boost }
}

/* =====================================================================
 * emit —— S6 二式快照组包（per-connection 个性化 AOI + 稀疏脏字段，§5.2）
 * 蛇增量恒带 id,x,y,a，n/skin/sc/k 变才带；光点位只 {id,on}；
 * 全量阈值：脏>180 或 增量>1.2KB；每 300 张强制全量（mmo 同式）。
 * ===================================================================== */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { known: new Set(), seq: 0, sinceFull: 0, sent: new Map(), cx: P.W / 2, cy: P.H / 2, force: true }; connState.set(ctx, b) }
  return b
}
function snakeFull(rec) {
  const path = []
  for (let i = 0; i + 1 < rec.path.length; i += 4) path.push(rec.path[i], rec.path[i + 1]) // 隔点传输（§5.2）
  return { id: rec.id, k: 'snake', seat: rec.seat, name: rec.name, x: rec.x, y: rec.y, a: rec.a, n: rec.n, skin: rec.skin, sc: rec.score, k2: rec.kills, b: rec.boosting ? 1 : 0, d: rec.dead, p: rec.prot, path }
}
function snakeIncr(rec, b) {
  const out = { id: rec.id, x: rec.x, y: rec.y, a: rec.a }
  const last = b.sent.get(rec.id) || {}
  if (rec.n !== last.n) out.n = rec.n
  if (rec.skin !== last.skin) out.skin = rec.skin
  if (rec.score !== last.sc) out.sc = rec.score
  if (rec.kills !== last.k2) out.k2 = rec.kills
  if ((rec.boosting ? 1 : 0) !== last.b) out.b = rec.boosting ? 1 : 0
  if ((rec.dead ? 1 : 0) !== last.d) out.d = rec.dead
  b.sent.set(rec.id, { n: rec.n, skin: rec.skin, sc: rec.score, k2: rec.kills, b: rec.boosting ? 1 : 0, d: rec.dead })
  return out
}
function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seat = ctxRec.seat
  const own = seat >= 0 ? st.ents['s' + seat] : null
  let cx = b.cx, cy = b.cy, rr = 460_000 // spectator：镜头点 r 固定 460（§5.2）
  if (own && !own.dead) { cx = own.x; cy = own.y; rr = P.aoiR(own.n) }
  else if (own && own.dead) { cx = own.x; cy = own.y; rr = P.aoiR(Math.max(own.n, 25)) } // 死亡视角保持
  b.cx = cx; b.cy = cy
  const rOut = rr + 15000 // 15px 滞回带（§5.2）

  /* 视野候选：蛇 AABB 预筛+5 点精判（长实体横穿 AOI 头在外也入视野，§5.2）；光点圆判定 */
  const cand = []
  for (const id in st.ents) {
    const e = st.ents[id]
    if (e.k === 'snake') {
      if (e === own) { cand.push(e); continue }
      let mnx = e.x, mxx = e.x, mny = e.y, mxy = e.y
      const p = e.path
      for (let i = 0; i + 1 < p.length; i += 2) {
        if (p[i] < mnx) mnx = p[i]; else if (p[i] > mxx) mxx = p[i]
        if (p[i + 1] < mny) mny = p[i + 1]; else if (p[i + 1] > mxy) mxy = p[i + 1]
      }
      if (mxx < cx - rOut || mnx > cx + rOut || mxy < cy - rOut || mny > cy + rOut) {
        if (b.known.has(id) && (mxx < cx - rOut - 15000 || mnx > cx + rOut + 15000 || mxy < cy - rOut - 15000 || mny > cy + rOut + 15000)) continue
        if (!b.known.has(id)) continue
      }
      const p5 = [e.x, e.y, p[p.length - 2], p[p.length - 1], p[(p.length >> 2) & ~1], p[((p.length >> 2) & ~1) + 1], p[(p.length >> 1) & ~1], p[((p.length >> 1) & ~1) + 1]]
      let inside = false
      for (let i = 0; i + 1 < p5.length; i += 2) {
        const d = dist2(cx, cy, p5[i], p5[i + 1])
        if (d <= rr * rr || (b.known.has(id) && d <= rOut * rOut)) { inside = true; break }
      }
      if (inside) cand.push(e)
    } else {
      const d = dist2(cx, cy, e.x, e.y)
      const margin = e.k === 'drop' ? 14000 : 7000
      if (d <= (rr + margin) * (rr + margin) || (b.known.has(id) && d <= (rOut + margin) * (rOut + margin))) cand.push(e)
    }
  }
  const keep = new Set(cand.map((e) => e.id))
  const leave = []
  for (const id of b.known) if (!keep.has(id)) leave.push(id)

  /* 脏集 ∩ 视野（蛇恒脏=全时移动；光点位 on 翻转/瞬态生灭才脏，§5.2 稀疏编码） */
  const dirtySet = r ? r.dirty : null
  const sendIds = []
  const seen = new Set()
  for (const e of cand) {
    if (e.k === 'snake') { sendIds.push(e.id); seen.add(e.id) } // 蛇恒脏
    else if (!b.known.has(e.id)) { sendIds.push(e.id); seen.add(e.id) } // 入视野=完整记录
    else if (dirtySet && dirtySet.has(e.id) && e.k !== 'drop') { sendIds.push(e.id); seen.add(e.id) } // on 翻转
  }
  let full = opt.force || b.force || b.sinceFull >= 300 || sendIds.length > 180
  b.force = false

  let entsArr
  if (full) entsArr = cand.map((e) => (e.k === 'snake' ? snakeFull(e) : e.k === 'drop' ? { id: e.id, k: 'drop', x: e.x, y: e.y, v: e.v } : { id: e.id, k: e.k, x: e.x, y: e.y, v: e.v, on: e.on }))
  else entsArr = sendIds.map((id) => { const e = st.ents[id]; return e.k === 'snake' ? snakeIncr(e, b) : { id, on: e.on } })

  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base,
    full: full ? 1 : 0, snapSeq: b.seq + 1,
    ext: {
      aoi: { x: cx, y: cy, r: rr },
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
      me: own ? { seat, n: own.n, sc: own.score, k2: own.kills, d: own.dead, rs: own.dead ? Math.max(0, own.respawnAt - st.tick) : 0, max: own.maxLen } : undefined,
      rd: { n: st.round.n, t: st.round.tick, k: st.round.king, rem: Math.max(0, P.ROUND_TICKS - st.round.tick) },
      lb: st.tick % 10 === 0 ? st.leaderboard.slice(0, 5).map((r) => [r.seat, r.score, r.n]) : undefined, // 1Hz 紧凑 [seat,score,n]≈75B（§5.5 预算 ~120B/s；名字客户端 roster 映射）
      mm: st.tick % 10 === 0 ? (st.mm || []) : undefined,  // 全房密度点 1Hz（§7 小地图）
    },
    ents: entsArr, leave: full ? [] : leave,
  }
  if (r && r.events && r.events.length) msg.events = r.events
  const text = JSON.stringify(msg)
  /* 增量 >1.2KB → 退全量（团战极端情形，§5.2 退化阈值） */
  if (!full && text.length > 1200) return emitOne(room, ctxRec, r, { force: true })
  b.seq++
  if (full) { b.sent.clear(); for (const e of cand) if (e.k === 'snake') b.sent.set(e.id, { n: e.n, skin: e.skin, sc: e.score, k2: e.kills, b: e.boosting ? 1 : 0, d: e.dead }); b.base = st.tick; b.sinceFull = 0 } else b.sinceFull++
  b.known = keep
  if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}
function emit(room, r) {
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, r)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, r)
}
function onSync(room, ctx) {
  let seat = -1
  const s = room.seats.find((x) => x.conn === ctx)
  if (s) seat = s.seat
  emitOne(room, { ctx, seat }, null, { force: true })
}

/* =====================================================================
 * 适配器出口（rooms.js 注册表形状 + S2 扩展 emit/onSync）
 * ===================================================================== */
/* 放水阈值配置（game.json bot.mercy 可调；读失败/缺省 → MERCY_DFT 兜底，启动读一次缓存） */
let _mercyCfg = null
function mercyCfg() {
  if (_mercyCfg) return _mercyCfg
  try {
    const cfg = JSON.parse(readFileSync(new URL('../../../games/multiplayer/snake-king/game.json', import.meta.url), 'utf8'))
    _mercyCfg = Object.assign({}, MERCY_DFT, (cfg.bot && cfg.bot.mercy) || {})
  } catch { _mercyCfg = MERCY_DFT }
  return _mercyCfg
}
export const snakeKingSim = {
  META: {
    gameId: 'snake-king', title: '蛇王争霸', mode: 'swarm-arena',
    seats: 24, tickMs: TICK_MS,
    persistent: true,    // 常驻竞技场：rooms 跳过 abandon/maxTicks（§1.1/附决策 1）
    takeOver: 'casual',  // 断线逾时 casual 托管继续游（§4.1）
    roomPrefix: 'snake', // feed 字典序 snake 排尾（§5.7）
  },
  LEVELS: ['casual', 'balanced', 'competitive'],
  url: '/games/multiplayer/snake-king/index.html',
  create, step, emit, onSync,
  /* brain 出口包装（GAMES-102 放水链）：game.json bot.mercy 阈值读出经 env.mercy 注入
   * （element-duel 适配器同式）；无 env（AFK 托管/离线直调）→ brainImpl 缺省兜底 */
  brain: (st, seat, level, rng, env) =>
    brainImpl(st, seat, level, rng, env ? Object.assign({}, env, { mercy: mercyCfg() }) : env),
  welcomeExtra: () => ({ // S6 声明块（协议 §6 向后兼容自由键；S4 physics/S5 duel 同范式）
    snake: { engine: 'snake-king-sim', v: 1, hitR: 14, eatR: 14, sweep: 1, aoiR: [420, 600], cap: { snake: 24, site: 180, drop: 240, len: 140 } },
  }),
  fnv1a32, mulberry32,
}
