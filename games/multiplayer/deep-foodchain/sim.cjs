/* =====================================================================
 * 深海食物链 deep-foodchain 服务端 sim（GAMES-164 · E6/W2/T6 单链 2/10）——
 * S6 海量实体第二证：实体吞噬成长链 + 体型分级 AOI。
 * 设计事实源：docs/designs/deep-foodchain.md（GAMES-163 评审合并版）。
 *
 * 与蛇王（S6 首证）同管线、形态换代（附决策 9）：鱼=点实体无 path——
 * 服务端权威 tick 制大房模拟 + per-connection 个性化 AOI（"档即视野"：
 * r_AOI=体型四档表 {380,440,500,560}+15px 滞回，机制/带宽/Bot 三面同表）+
 * 脏实体稀疏增量（鱼增量恒带 x,y,a，M/skin/sc/k2/b/d/t 变才带）+
 * 吞噬裁决 ruling 化一裁三账（§5.3：{k:'devour',seat,by,mv,gain,drops} 单事件
 * 携带击杀/转移/掉落三本账，判定与入账同 tick 原子完成——客户端与剧本零推断）。
 *
 * 质量账本（附决策 4，A8 断言面）：累计六计数 {ate,gained,dashed,endow,dropped,expired}，
 * 任意 tick 恒等式 ΣM(活鱼)+Σ粒值+expired−endow−ate−gained−dropped+dashed==0。
 * 记账语义（本 sim 落地口径，恒等式逐流可验）：
 *   endow  += 20/次破卵（质量注入）；ate += v/次吃资源位（位回填=免费再注入）；
 *   gained += gain/次吞噬（猎手入账全额）；dropped += dropT/次吞噬 + 1/次 dash 掉粒；
 *   dashed += 1/次 dash 燃烧（−1 质量化 value-1 光点）；expired += Mv/次吞噬
 *   （被吞实体质量离场——gain 流入猎手、dropT 流入粒池，账内自消）+ 封顶溢出
 *   + 光点 TTL/硬顶蒸发 + 席位撤鱼离场。
 *
 * 常驻渔场语义（§1.1/附决策 1）：房=常驻（META.persistent），轮（round=3600 tick）
 * 在 state 内推进——轮末加冕（海王=榜首）→ kills 清零、score 重锚 floor(M/4) →
 * round++ 继续，世界不清空、鱼不死光、房间不 ended；测试房 maxTicks=3600
 * 投影终局（winner A=API 席 score≥320 且 M≥500 成对绑定——§6 A2 双锚，snake goal 双条件先例）。
 * Bot 三档=生态位（§4）：casual 饲料鱼/ balanced 觅食者/ competitive 猎手
 * （拦截闭式解+dash 收口+晶簇带埋伏）——体型键控四问树（tier 改阈值不改结构）。
 * GAMES-166 Bot 深化：三档真分化（casual 失误率 blunder 可调参/balanced 密度场局部
 * 采样窗+方向 ρ 移动均值/competitive 捕食预判=目标成长曲线外推+体型压制规避带 Q1b）
 * +放水链 io 启用（决策树降问 四问→三问/失误注入/生态位让位让食）——全部只在
 * brainImpl 决策层，判定/物理/账本路径零改动（A8 复验口径）。
 * 确定性：无 Date/random 入判定路径（seed 纪律同 mmo/snake）。
 * ===================================================================== */
'use strict'
const P = require('./shared.cjs')

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
const REGEN = { alg: 150, kri: 250, cry: 400 }             // 回填 15s/25s/40s（§2.2）
const BLOOM_REGEN = 80                                      // 鱼汛潮窗内磷虾 8s（§2.2）
const BLOOM_EVERY = 900, BLOOM_TICKS = 200                  // 每 90s 一潮、窗 20s（§2.2）
const SITE_V = { alg: 1, kri: 2, cry: 4 }                   // +质量（§2.2）
const SITES = { alg: 120, kri: 40, cry: 20 }                // 位数量 = 180（§1.4）
const MILESTONES = { 80: '成鱼', 300: '猎鲨', 1000: '沧鲸', 4000: '海王之姿' } // §2.4（破卵=出生位）
const SKINS = 8                                             // §2.6 皮肤表
const GOAL = 320                                            // 轮末达标线（§6 endState）
const MASS_GOAL = 500                                       // A2 成长锚成对绑定（§6 A2「score≥320 且 M≥500」；snake goal 双条件先例）
const SPAWN_GAP = 260_000, SPAWN_GAP_RELAX = 180_000        // 出生安全位（§5.1）
const AFK_TICKS = 600                                       // 60s 无输入 → casual 托管（§4.3）
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const RAD = Math.PI / 180
const dist2 = (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay)
const SCORE_OF = (f) => ((f.M / 4) | 0) + f.kills * 40      // §1.3

/* =====================================================================
 * create(seed, opts) —— 世界布局（资源位 seed 派生，§2.2 纵向光带分区）
 * ===================================================================== */
function create(seed, opts = {}) {
  const rng = mulberry32(seed >>> 0)
  const jit = (span) => Math.trunc((rng() * 2 - 1) * span)
  const ents = {}
  const addSite = (id, k, x, y) => { ents[id] = { id, k, x, y, v: SITE_V[k], on: 1, rt: 0 } }
  // 荧藻：光照带（y<900）网格抖动 120 位（12×10，§2.2）
  for (let i = 0; i < SITES.alg; i++)
    addSite('a' + i, 'alg', 90000 + (i % 12) * 147000 + jit(45000), 100000 + ((i / 12) | 0) * 84000 + jit(28000))
  // 磷虾：暮光带（900≤y≤1350）8×5 网格 40 位（§2.2）
  for (let i = 0; i < SITES.kri; i++)
    addSite('k' + i, 'kri', 120000 + (i % 8) * 230000 + jit(60000), 980000 + ((i / 8) | 0) * 88000 + jit(28000))
  // 晶簇：深渊带（y>1350）散布 20 位（§2.2 淘金带）
  for (let i = 0; i < SITES.cry; i++)
    addSite('c' + i, 'cry', 300000 + Math.trunc(rng() * 1200000), 1420000 + Math.trunc(rng() * 300000))
  return {
    v: 1, gameId: 'deep-foodchain', seed: seed >>> 0, tick: 0,
    testRoom: !!opts.test, maxTicks: opts.test ? (opts.maxTicks ?? null) : null,
    map: { w: P.W, h: P.H },
    round: { n: 1, tick: 0, king: -1 },
    ents, leaderboard: [], dropSeq: 0,
    bloom: { next: BLOOM_EVERY, band: -1, until: 0 },        // 鱼汛潮相位（§2.2）
    afk: {},
    stats: { fish: 0, deaths: 0, kills: 0, drops: 0, devours: 0 },
    /* 质量守恒账本（§5.3/A8：任意 tick 恒等式抽样断言；语义见文件头） */
    ledger: { ate: 0, gained: 0, dashed: 0, endow: 0, dropped: 0, expired: 0 },
  }
}

/* ---------- 鱼生成 ---------- */
function safeSpawn(st, seat) {
  const rng = mulberry32((st.seed ^ Math.imul(seat + 1, 0x9e3779b9) ^ Math.imul(st.tick + 1, 2654435761)) >>> 0)
  const heads = []
  for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'fish' && !e.dead) heads.push(e) }
  let best = null, bestScore = -1
  for (let tries = 0; tries < 20; tries++) {
    const gap = tries >= 12 ? SPAWN_GAP_RELAX : SPAWN_GAP    // 12 次失败放宽至 180px（§5.1）
    const x = 120000 + Math.trunc(rng() * (P.W - 240000)), y = 120000 + Math.trunc(rng() * (P.H - 240000))
    let ok = true, minD = Infinity
    for (const h of heads) {
      const hr = P.rOfM(h.M)
      if (hr * P.K_DEN < P.rOfM(P.M0) * P.K_NUM) continue    // 吃不动我的鱼不构成威胁（§5.1）
      const d = dist2(x, y, h.x, h.y); if (d < minD) minD = d
      if (d < gap * gap) { ok = false; break }
    }
    if (ok) return { x, y }
    if (minD > bestScore) { bestScore = minD; best = { x, y } }
  }
  return best || { x: (P.W / 2) | 0, y: (P.H / 2) | 0 }      // 20 次失败取最远点（§5.1）
}
function assignSkin(st, seat) {
  const rng = mulberry32((st.seed ^ Math.imul(seat + 1, 0x9e3779b9)) >>> 0)
  const used = new Set()
  for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'fish') used.add(e.skin) }
  for (let t = 0; t < 8; t++) { const s = (rng() * SKINS) | 0; if (!used.has(s)) return s } // 同房去重（§2.6）
  return (rng() * SKINS) | 0
}
function spawnFish(st, seat, name, keep) {
  const pos = safeSpawn(st, seat)
  const a = (((seat * 47) % 24) * 15 + 5) % 360             // 席位错角落生（确定性，无 rng）
  const old = keep || st.ents['s' + seat]
  const f = {
    id: 's' + seat, k: 'fish', seat, name: name || ('鱼' + seat),
    x: pos.x, y: pos.y, px: pos.x, py: pos.y, a, ta: a,
    M: P.M0, tier: 0, skin: old ? old.skin : assignSkin(st, seat),
    score: 0, kills: old ? old.kills : 0, deaths: old ? old.deaths : 0,
    maxM: old ? old.maxM : P.M0,                            // 玩家档案：历史最大质量（§1.1 localStorage 侧）
    boost: false, dead: 0, respawnAt: 0, prot: P.SPAWN_PROT,
    mem: { dt: 0, wp: null, ta: a, dash: 0, wall: 0, flee: 0, bloom: 0 },
  }
  f.score = SCORE_OF(f)
  st.ledger.endow += P.M0                                   // 破卵注入 20（A8）
  st.ents['s' + seat] = f
  return f
}

/* ---------- 瞬态光点（尸粒/冲刺掉落；TTL 90s、全房 ≤240 硬顶最旧蒸发，§2.2） ---------- */
function addDrop(st, x, y, v, src, events) {
  if (st.dropSeq >= P.DROPS_CAP) {
    let oldest = null
    for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'drop' && (!oldest || e.born < oldest.born)) oldest = e }
    if (oldest) { st.ledger.expired += oldest.v; delete st.ents[oldest.id] } // 硬顶蒸发入账（A8）
  }
  const id = 'd' + (st.dropSeq++)
  st.ents[id] = { id, k: 'drop', x: clamp(x, 8000, P.W - 8000), y: clamp(y, 8000, P.H - 8000), v, src, born: st.tick, ttl: P.DROP_TTL }
  st.stats.drops++
  return id
}

/* ---------- 吞噬裁决 ruling 化：一裁三账（§5.3 核心新面——判定与入账同 tick 原子完成）
 * gain=55% 入猎手（floor(Mv×11/20)）+ dropT=45% 化粒（clamp(ceil/2,3,30) 粒 value 2、
 * 残差并末粒——大鱼尸=末粒巨点"移动矿"）+ score+kills——{k:'devour'} 单事件零推断对账（A7）。 */
function devour(st, hunter, victim, events) {
  const d = P.devourOf(victim.M)
  const mv = victim.M
  const before = hunter.M
  hunter.M = Math.min(hunter.M + d.gain, P.M_CAP)           // 封顶溢出只入 expired（§2.3）
  const overflow = d.gain - (hunter.M - before)
  hunter.kills++
  hunter.score = SCORE_OF(hunter)
  /* 尸粒散布：沿被吞位置环形均匀散落（点实体无 path，§2.5 近路径近似=死亡位环布） */
  const rng = mulberry32((st.seed ^ Math.imul(victim.seat + 3, 0x85ebca6b) ^ st.tick) >>> 0)
  let dotSum = 0
  for (let i = 0; i < d.drops; i++) {
    const ang = (i / d.drops) * Math.PI * 2 + rng() * 0.5
    const rad = 12000 + i * 9000 + Math.trunc(rng() * 6000)
    const v = i === d.drops - 1 ? d.dropT - 2 * (d.drops - 1) : 2 // 残差并末粒（§2.5）
    addDrop(st, victim.x + Math.cos(ang) * rad, victim.y + Math.sin(ang) * rad, v, 'corpse')
    dotSum += v
  }
  /* 被吞侧：死亡+3s 重生计时；kills 留档（§1.3 猎手荣誉留存）、质量清零重来 */
  victim.dead = 1; victim.respawnAt = st.tick + P.RESPAWN_TICKS; victim.deaths++
  victim.M = 0; victim.tier = 0; victim.boost = false; victim.ta = null
  victim.score = SCORE_OF(victim)
  victim.maxM = Math.max(victim.maxM, 0)                    // maxM 已在吃/成长路径维护
  st.stats.deaths++; st.stats.kills++; st.stats.devours++
  /* 质量账本（A8）：gained/dropped 记转移两账；expired 记被吞实体质量离场+封顶溢出
   * （gain 流入猎手、dropT 流入粒池——恒等式内自消，文件头逐流可验） */
  st.ledger.gained += d.gain
  st.ledger.dropped += d.dropT
  st.ledger.expired += mv + overflow
  events.push({ k: 'devour', seat: victim.seat, by: hunter.seat, mv, gain: d.gain, drops: d.drops })
}
function growFish(st, f, v, id, events) {
  const before = f.M
  f.M = Math.min(f.M + v, P.M_CAP)                          // 封顶后只加 score 不加 M（§2.3）
  const overflow = v - (f.M - before)
  if (overflow > 0) st.ledger.expired += overflow           // 封顶溢出离场（A8）
  f.score = SCORE_OF(f)
  if (f.M > f.maxM) f.maxM = f.M
  events.push({ k: 'eat', seat: f.seat, id, v })
}

/* =====================================================================
 * step —— tick 结算序（§5.1：inputs→转向→移动→dash 掉粒→进食→吞噬裁决（扫掠，
 * 固定对序）→死亡/重生→资源回填（含鱼汛潮）→里程碑/score→排行榜→AOI/组包在 emit）
 * ===================================================================== */
function step(st, inputs, room) {
  const events = []
  const dirty = new Set()
  const kinds = room ? room.seats.map((s) => s.kind) : null

  /* 0. 席位自愈：激活席补鱼/续名；空位鱼清场（离场质量入 expired 账，A8） */
  if (room) {
    for (let i = 0; i < room.seats.length; i++) {
      const kind = room.seats[i].kind
      const active = kind === 'human' || kind === 'bot'
      const f = st.ents['s' + i]
      if (active && !f) { spawnFish(st, i, room.seats[i].name); events.push({ k: 'spawn', seat: i, M: P.M0 }) }
      if (active && f) f.name = room.seats[i].name || f.name
      if (!active && f) { st.ledger.expired += f.M; delete st.ents['s' + i] }
    }
  }
  const live = []
  for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'fish' && !e.dead) { live.push(e); e.died = 0 } }
  live.sort((a, b) => a.seat - b.seat)                      // 固定结算序：id（席位）升序（§5.3）
  st.stats.fish = live.length

  /* 0b. AFK 托管（§4.3）：human 席连续 60s 输入签名不变 → casual 代打（输入即夺回） */
  for (const f of live) {
    if (!kinds || kinds[f.seat] !== 'human') { st.afk[f.seat] = null; continue }
    const inp = inputs[f.seat] || {}
    const sig = inp.a + ':' + (inp.dash ? 1 : 0)
    if (st.afk[f.seat] && st.afk[f.seat].sig === sig) st.afk[f.seat].t++
    else st.afk[f.seat] = { sig, t: 0 }
    if (st.afk[f.seat].t >= AFK_TICKS) {
      const bot = brainImpl(st, f.seat, 'casual', mulberry32((st.seed ^ Math.imul(f.seat + 7, 0x85ebca6b)) >>> 0), null)
      inputs[f.seat] = bot
    }
  }

  /* 1. 转向积分（ω(M)，dash ×0.8）→ 移动积分（v(M)，dash ×1.6）→ 缓流墙 clamp（§2.1） */
  for (const f of live) {
    const inp = inputs[f.seat] || {}
    if (Number.isFinite(inp.a)) f.ta = ((Math.trunc(inp.a) % 360) + 360) % 360
    const wantDash = inp.dash === 1
    if (wantDash && f.M >= P.DASH_MIN) f.boost = true       // 仅 M≥30 可用（§2.3）
    if (!wantDash || f.M < P.DASH_OFF) f.boost = false      // 掉至 M<26 自动熄灭（§2.3）
    const w = Math.max(1, Math.round(P.wOf(f.M) * (f.boost ? 0.8 : 1)))
    f.a = P.stepTurn(f.a, f.ta == null ? f.a : f.ta, w)
    const v = Math.round(P.vOf(f.M) * (f.boost ? 1.6 : 1))
    f.px = f.x; f.py = f.y
    f.x = clamp(f.x + Math.round(Math.cos(f.a * RAD) * v), 8000, P.W - 8000)   // 缓流墙：clamp 不死（§2.5）
    f.y = clamp(f.y + Math.round(Math.sin(f.a * RAD) * v), 8000, P.H - 8000)
    if (f.prot > 0) f.prot--
    dirty.add(f.id)
    /* 2. dash 掉质量（每 5 tick −1 质量 → 该处 value-1 光点，§2.3 活体矿脉） */
    if (f.boost && st.tick % 5 === 0 && f.M > P.DASH_OFF) {
      f.M -= 1
      f.score = SCORE_OF(f)
      addDrop(st, f.x, f.y, 1, 'dash')
      st.ledger.dashed += 1                                  // dash 燃烧入账（A8；粒值已入 dropped 侧）
      st.ledger.dropped += 1
    }
  }

  /* 3. 进食判定（嘴点=头心+r×0.8 前向，吸附半径 r+10px，服务器逐 tick，§2.2） */
  for (const f of live) {
    const rM = P.rOfM(f.M)
    const er = rM + P.EAT_PAD
    const mx = f.x + Math.round(Math.cos(f.a * RAD) * ((rM * P.MOUTH_K) / 10)),
          my = f.y + Math.round(Math.sin(f.a * RAD) * ((rM * P.MOUTH_K) / 10))
    for (const id in st.ents) {
      const e = st.ents[id]
      if (e.k === 'alg' || e.k === 'kri' || e.k === 'cry') {
        if (!e.on || dist2(mx, my, e.x, e.y) > er * er) continue
        e.on = 0
        e.rt = inBloomBand(st, e.x, e.y) ? BLOOM_REGEN : REGEN[e.k]   // 鱼汛潮窗内磷虾 8s（§2.2）
        dirty.add(id)
        st.ledger.ate += e.v                                 // 资源位注入入账（A8）
        growFish(st, f, e.v, id, events)
      } else if (e.k === 'drop') {
        if (dist2(mx, my, e.x, e.y) > er * er) continue
        delete st.ents[id]                                   // 粒值 Σ粒→ΣM 纯转移（A8 无账）
        growFish(st, f, e.v, id, events)
      }
    }
  }

  /* 4. 吞噬裁决（扫掠：头位移线段 vs 对方圆 r_mine+r_victim×0.5，§5.3 防隧穿——
   * dash 23.8px/tick > 最小接触径 12px 侧擦窄角逐点判定会漏）；r 用 tick 首快照值
   * （吞后 r 增大不连锁，§2.5）；固定对序 id 升序单轮裁决；出生保护双向豁免（§2.5）。 */
  const r0 = new Map()
  for (const f of live) r0.set(f.id, P.rOfM(f.M))
  for (const sn of live) {
    if (sn.died || sn.prot > 0) continue
    const rM = r0.get(sn.id)
    for (const o of live) {
      if (o === sn || o.died || o.prot > 0) continue
      const rV = r0.get(o.id)
      if (!P.canSwallow(rM, rV)) continue                   // K=1.25 连续体型比（§2.5）
      const rr = rM + (rV >> 1)
      if (P.segDist2(o.x, o.y, sn.px, sn.py, sn.x, sn.y) < rr * rr) {
        devour(st, sn, o, events)
        sn.died = 0; o.died = 1
        break
      }
    }
  }

  /* 5. 重生（被吞 tick+30 安全位破卵 M=20，§1.2——重生不限次无惩罚面） */
  for (const id in st.ents) {
    const f = st.ents[id]
    if (f.k !== 'fish' || !f.dead || st.tick < f.respawnAt) continue
    const keep = { skin: f.skin, kills: f.kills, deaths: f.deaths, maxM: f.maxM, name: f.name }
    delete st.ents[id]
    const fresh = spawnFish(st, f.seat, keep.name)
    fresh.skin = keep.skin; fresh.kills = keep.kills; fresh.deaths = keep.deaths
    fresh.maxM = keep.maxM; fresh.score = SCORE_OF(fresh)
    events.push({ k: 'spawn', seat: f.seat, M: P.M0 })
  }

  /* 6. 资源回填（吃后计时回填，§2.2 mmo 纪律）+ 瞬态光点 TTL + 鱼汛潮相位 */
  for (const id in st.ents) {
    const e = st.ents[id]
    if (REGEN[e.k] && !e.on) {
      if (--e.rt <= 0) { e.on = 1; e.rt = 0; dirty.add(id) }
    } else if (e.k === 'drop' && --e.ttl <= 0) {
      st.ledger.expired += e.v                               // TTL 蒸发入账（A8）
      delete st.ents[id]
    }
  }
  if (st.tick === st.bloom.next) {                           // 鱼汛潮起（§2.2：每 90s 一象限 20s 窗）
    const rng = mulberry32((st.seed ^ Math.imul(st.tick + 11, 0x27d4eb2f)) >>> 0)
    st.bloom.band = (rng() * 4) | 0
    st.bloom.until = st.tick + BLOOM_TICKS
    st.bloom.next += BLOOM_EVERY
    for (const id in st.ents) {                              // 窗内该象限已空磷虾位回填加速（存量位直改参数）
      const e = st.ents[id]
      if (e.k === 'kri' && !e.on && inBloomBand(st, e.x, e.y) && e.rt > BLOOM_REGEN) e.rt = BLOOM_REGEN
    }
    events.push({ k: 'bloom', band: st.bloom.band })
  } else if (st.bloom.band >= 0 && st.tick >= st.bloom.until) st.bloom.band = -1

  /* 7. 体型档位（§2.4 滞回）+ 里程碑称号（§1.3 五段位） */
  for (const f of live) {
    if (f.died) continue
    const t = P.tierOf(f.M, f.tier)
    if (t !== f.tier) { f.tier = t; events.push({ k: 'tier', seat: f.seat, t }) }
    for (const th in MILESTONES) {
      const m = +th
      if (f.M >= m && (f.mem.ms || 0) < m) {
        f.mem.ms = m
        events.push({ k: 'milestone', seat: f.seat, M: m, t: MILESTONES[th], world: m >= 1000 })
      }
    }
  }

  /* 8. 测试房投影终局（§6 endState：生产常驻房不终局——maxTicks=null 恒不投影）。
   * goal 双条件=score≥320 且 M≥500 成对绑定（snake 先例 §6 A2「击杀流单独到分不出果——
   * 成长曲线锚与达标线同刻成立才算 goal」：本作 A2 文本「score ≥320 且 M≥500」同式；
   * 只绑 score 时 kills×40 出分快于 M 成长，goal 在 M~300 提前点火=A2 数值锚结构性红）。
   * 排序红线：投影必须先于轮末 rollover（kills 清零/score 重锚）——maxTicks==ROUND_TICKS
   * 同拍时后投影会读到重锚后的 score，轮末分数被抹、终局失真（snake 先例同坑） */
  let over = null
  if (st.testRoom && st.maxTicks != null && room) {
    const humans = room.seats.filter((s) => s.kind === 'human').map((s) => s.seat)
    const scores = {}, masses = {}
    for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'fish') { scores[e.seat] = e.score; masses[e.seat] = e.M } }
    const apiScore = Math.max(0, ...humans.map((s) => scores[s] || 0))
    const apiM = Math.max(0, ...humans.map((s) => masses[s] || 0))
    if (apiScore >= GOAL && apiM >= MASS_GOAL) over = { winner: 'A', reason: 'goal', scores }
    else if (st.tick >= st.maxTicks) over = { winner: 'B', reason: 'round-end', scores }
  }

  /* 9. 轮赛推进（§1.1：轮末加冕海王→kills 清零、score 重锚 floor(M/4)→round++；房不清） */
  st.round.tick++
  if (st.round.tick >= P.ROUND_TICKS) {
    let top = null
    for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'fish' && (!top || e.score > top.score)) top = e }
    if (top) {
      st.round.king = top.seat
      events.push({ k: 'crown', round: st.round.n, seat: top.seat, name: top.name, score: top.score })
    }
    st.round.n++; st.round.tick = 0
    for (const id in st.ents) {
      const e = st.ents[id]
      if (e.k !== 'fish') continue
      e.kills = 0; e.mem.ms = 0                              // 排行清零：击杀清零、score 重锚（§1.3）
      e.score = SCORE_OF(e)
    }
  }

  /* 10. 排行榜（逐 tick 重算保证任意 tick 抽样 A6 不变量成立；下发节流在 emit ext.lb 1Hz）
   * top10：HUD 紧凑面板 top5 + tap 展开 top10（§7） */
  st.leaderboard = Object.values(st.ents)
    .filter((e) => e.k === 'fish')
    .sort((a, b) => b.score - a.score || a.seat - b.seat)
    .slice(0, 10)
    .map((e) => ({ seat: e.seat, name: e.name, M: e.M, kills: e.kills, score: e.score }))
  if (st.tick % 10 === 0) { // 小地图密度点（1Hz，§7「20 鱼实时小点」HUD 数据源）
    st.mm = Object.values(st.ents).filter((e) => e.k === 'fish' && !e.dead).map((e) => [e.seat, Math.round(e.x / 1000), Math.round(e.y / 1000), e.M])
  }

  st.tick++
  return { events, dirty, over: !!over, result: over || null }
}
/* 鱼汛潮带判定（§2.2：象限 × 窗口——仅磷虾位受影响） */
function inBloomBand(st, x, y) {
  if (st.bloom.band < 0 || st.tick >= st.bloom.until) return false
  const q = (x < P.W / 2 ? 0 : 1) + (y < P.H / 2 ? 0 : 2)
  return q === st.bloom.band
}

/* =====================================================================
 * Bot brain（§4 三档生态位；决策间隔 30/12/8 tick，决策拍内闭式解 <2ms）
 * 体型键控四问树（§4.1，结构全档共用——tier 改阈值 θ(T) 不改结构）：
 *   Q1 威胁评估（可吞我者 + 航向锥 ±35°）→ FLEE（competitive 加判 t_catch≤1.2s dash 逃逸）；
 *   Q2 猎物评估（Δr 合格 + 拦截闭式解 t≤3s + gain≥θ(T)）→ HUNT（收口段 dash）；
 *   Q3 密度场觅食（8 方向 × 2 档距 ρ=Σv/(d+60px)）→ FEED 梯度最陡向；
 *   Q4 巡游（casual 分区随机 / balanced 全图 / competitive T≥2 晶簇带边缘埋伏）。
 * 档位键控表：T0 Q2 恒空（θ=∞）/T1 θ=8 /T2 θ=40（+埋伏解锁）/T3 θ=150（晶簇带偏好）。
 * 三档人格（§4.2 可执行表）：drift/eatR/hunt/avoid/wallM/dash 预算——
 *   casual=饲料鱼（Q2 恒空+弱避障=自然死亡源·尸粒供给主力）、balanced=机会吞、
 *   competitive=全开猎手（拦截/埋伏/dash 收口，预算 M 的 8% 质量池）。
 * ===================================================================== */
const BOT_EVERY = { casual: 30, balanced: 12, competitive: 8 }
/* PERSONA（GAMES-166 三档真分化深化；表=调参事实源，game.json bot.persona 可覆盖经
 * 适配器 env.persona 注入——离线/回放无 env 走本表缺省，全链确定性不受配置面影响）：
 *   blunder  casual 失误率（决策拍注入 ±90° 航向错误概率——饲料位的可调失误面）；
 *   rhoWin/rhoEwma  balanced 密度场局部采样窗（2 档距）与方向 ρ 移动均值平滑系数；
 *   suppBand  competitive 体型压制规避带开关（对可吞我者保持 standoff，带宽容 avoid）；
 *   growExt  捕食预判：目标成长曲线外推（拦截点投影 M 越 K 线 → 弃猎）。 */
const PERSONA = {
  casual:      { drift: 18, eatR: 120_000, hunt: 0, avoid: 0.6, wallM: 80_000, blunder: 0.12 },
  balanced:    { drift: 0, eatR: 440_000, hunt: 1, avoid: 0.85, wallM: 120_000, rhoWin: 260_000, rhoEwma: 0.55 },
  competitive: { drift: 0, eatR: 560_000, hunt: 2, avoid: 0.95, wallM: 160_000, suppBand: 1, growExt: 1 },
}
const THETA = [Infinity, 8, 40, 150]                        // θ(T) 档位键控（§4.1）
const TIER_BOUND = [80, 300, 1000]                          // 下一档界（hungry 判据用）
/* 陪玩放水（§4.3，GAMES-102 三层范式搬运；GAMES-166 io 化启用）：常驻房无终局 →
 * 连败代理用房内可观测面 state.deaths/kills。L1 连败（deaths≥minFoeLose 且 kills==0）
 * → 免猎+让食 120px；L2 重败（deaths≥hardFoeLose）→ 让食半径 200px；真人 M<majorM
 * （成长保护窗·直至长成）不主动猎。io 连败让力三件（GAMES-166）：
 *   ① 决策树降问：连败席进入 360px 压制圈 → Q2 猎物评估整问停用（树四问→三问）；
 *   ② 失误注入：该席近旁决策拍 w.p. p 注入 ±70° 航向错误+dash 熄灭（追得上=让力体感）；
 *   ③ 生态位让位：Q3 让食（连败席食圈不抢，L1 120px/L2 200px）。
 * 阈值入 game.json bot.mercy 可调；适配器出口包装注入 env.mercy（离线确定性不读文件）；
 * env 缺省（无 kinds）全链不可达——放水只作用于 bot 对真人的决策面（GAMES-140/149/158）。 */
const MERCY_DFT = { minFoeLose: 2, hardFoeLose: 4, majorM: 800 }
const MERCY_NEAR = 360_000                                        // 降问/失误注入作用圈（px）
const MERCY_BLUNDER = [0, 0.3, 0.5]                               // 失误注入概率（L0 关/L1/L2）
function brainImpl(st, seat, level, rng, env) {
  const me = st.ents['s' + seat]
  if (!me || me.dead) return { a: 0, dash: 0 }
  const mem = me.mem
  /* persona 覆盖链（GAMES-166 失误率可调参化）：env.persona（适配器读 game.json
   * bot.persona）> PERSONA 缺省表——离线/回放无 env 走缺省（口径同 env.mercy） */
  const per = env && env.persona && env.persona[level]
    ? Object.assign({}, PERSONA[level] || PERSONA.balanced, env.persona[level])
    : (PERSONA[level] || PERSONA.balanced)
  const mercy = (env && env.mercy) || MERCY_DFT
  if (!mem.ch) mem.ch = { q1: 0, q1s: 0, q2: 0, q3: 0, q4: 0, md: 0, bl: 0 } // 决策通道使用率台账（开局树指标面；纯簿记不入判定路径）
  const deg = (x, y) => ((Math.atan2(y - me.y, x - me.x) / Math.PI * 180) % 360 + 360) % 360
  const near = (x, y) => dist2(me.x, me.y, x, y)
  const toCenter = () => deg(P.W / 2, P.H / 2)
  const myR = P.rOfM(me.M)
  const foes = []
  const mercyOf = new Map()                                  // 席位 → 放水档（1=免猎+让食120px / 2=再让食200px；仅 human 席）
  const isHuman = env && env.kinds ? (s) => env.kinds[s] === 'human' : () => false
  for (const id in st.ents) {
    const e = st.ents[id]
    if (e.k !== 'fish' || e.seat === seat || e.dead) continue
    foes.push(e)
    /* 放水靶收窄（GAMES-166）：AFK 托管席（原始输入签名 60s 未变，§4.3）不放水——
     * 挂机席的连败不是「 struggling 真人」；否则常驻房一个挂机席=永久放水源，
     * 降问作用圈扫过全场把猎压制死（QA1 B 面重采 devour×1 实证） */
    if (isHuman(e.seat) && e.kills === 0 && !(st.afk[e.seat] && st.afk[e.seat].t >= AFK_TICKS)) {
      if (e.deaths >= mercy.hardFoeLose) mercyOf.set(e.seat, 2)
      else if (e.deaths >= mercy.minFoeLose) mercyOf.set(e.seat, 1)
    }
  }
  /* 猎物过滤（放水链+生态位让位）：连败真人免猎；human 席 majorM 成长保护窗不猎（§4.3） */
  const huntable = (f) => !mercyOf.has(f.seat) && !(isHuman(f.seat) && f.M < mercy.majorM)
  const mercyFoodR = (f) => (mercyOf.get(f.seat) || 0) >= 2 ? 200_000 : 120_000 // L2=200px / L1=120px
  const dots = []
  for (const id in st.ents) {
    const e = st.ents[id]
    if ((e.k === 'alg' || e.k === 'kri' || e.k === 'cry') && e.on) dots.push(e)
    else if (e.k === 'drop') dots.push(e)
  }
  /* 连败让力作用圈：最近连败真人距离+档位（决策树降问/失误注入的作用半径 MERCY_NEAR） */
  let mNear = Infinity, mLvl = 0
  for (const [ms, lv] of mercyOf) {
    const f = st.ents['s' + ms]
    if (!f || f.dead) continue
    const d2 = near(f.x, f.y)
    if (d2 < mNear) { mNear = d2; mLvl = lv }
  }
  const mercyNear = mNear <= MERCY_NEAR * MERCY_NEAR ? mLvl : 0

  if (mem.dt <= 0) {
    mem.dt = BOT_EVERY[level] || 12
    mem.dash = 0
    const v = P.vOf(me.M)
    /* Q1 威胁评估：可吞我（r_f≥1.25×myR）+ 距离 <220px+myR + 航向锥 ±35° 含我（§4.1）
     * 决策树降问（GAMES-166 放水）：连败席不入威胁集——Q1 对该席停用（免逃逸=让追得上） */
    let threat = null, td = Infinity
    for (const f of foes) {
      if (mercyOf.has(f.seat)) continue
      const rF = P.rOfM(f.M)
      if (!P.canSwallow(rF, myR)) continue
      const d2 = near(f.x, f.y)
      const rng2 = (220_000 + myR) * (220_000 + myR) * (me.tier === 0 ? 1.2 : 1) // T0 威胁半径 ×1.2（胆小，§4.1）
      if (d2 > rng2 || d2 > td) continue
      const dd = Math.sqrt(d2)
      const da = Math.abs(P.angDiff(f.a, deg(me.x - f.x, me.y - f.y))) // 威胁航向 vs 指向我的角
      const cone = 35 + (dd > 1 ? Math.atan2(myR * 2, dd) * 180 / Math.PI : 0) // 锥角含体径容差
      if (da <= cone || dd < 90_000) { td = d2; threat = f }
    }
    /* Q1b 体型压制规避带（GAMES-166 competitive 深化）：per.suppBand 档对可吞我者保持
     * standoff（带宽容 avoid×160px+myR）——不在压制圈内开猎；casual avoid=0.6 饲料位
     * 盲区不带（弱避险=自然死亡源，§4.2 预期生存差的结构保障） */
    let supp = null, sd = Infinity
    if (per.suppBand && per.avoid >= 0.8) {
      const band = 160_000 * per.avoid + myR
      for (const f of foes) {
        if (mercyOf.has(f.seat)) continue
        if (!P.canSwallow(P.rOfM(f.M), myR)) continue
        const d2 = near(f.x, f.y)
        if (d2 < band * band && d2 < sd) { sd = d2; supp = f }
      }
    }
    if (threat) {
      mem.ch.q1++
      /* FLEE：逃向=威胁航向法向侧（左/右取远离缓流墙者）+ 最近非威胁方向插值（§4.1） */
      const ta = threat.a * RAD
      const nx = -Math.sin(ta), ny = Math.cos(ta)
      const side = (me.x * nx + me.y * ny) > ((P.W - me.x) * nx + (P.H - me.y) * ny) ? -1 : 1
      let fx = me.x + nx * side * 300_000, fy = me.y + ny * side * 300_000
      for (const f of foes) {                                // 最近非威胁方向插值（远离威胁质心）
        if (f === threat || P.canSwallow(P.rOfM(f.M), myR)) continue
        const d = Math.sqrt(near(f.x, f.y))
        if (d < 400_000) { fx = fx * 0.5 + (2 * me.x - f.x) * 0.5; fy = fy * 0.5 + (2 * me.y - f.y) * 0.5 }
      }
      mem.ta = deg(clamp(fx, 60000, P.W - 60000), clamp(fy, 60000, P.H - 60000))
      mem.flee = 8
      mem.wp = null
      /* competitive 加判：闭式解追上时间 t_catch≤1.2s（逃不掉）→ dash 逃逸（质量换速度） */
      if (level === 'competitive') {
        const tv = P.vOf(threat.M) * 1.6
        const gap = Math.sqrt(td) - myR - P.rOfM(threat.M)
        if (tv > v && gap / (tv - v) <= 12 && me.M > P.DASH_MIN) mem.dash = 1
      }
    } else if (mem.flee > 0) mem.flee--
    else if (supp) {
      /* Q1b 命中：撤离压制带（朝远离压制者向）——带内不开猎（GAMES-166 捕食预判深化） */
      mem.ch.q1s++
      mem.ta = deg(2 * me.x - supp.x, 2 * me.y - supp.y)
      mem.wp = null
    } else {
      /* Q2 猎物评估：Δr 合格 + 拦截闭式解 t≤3s + gain≥θ(T)（体型键控，§4.1）
       * 拦截解=相遇点迭代（猎物直线外推 t 后我方 v·t 可达——v_mine ≤ v_prey 的纯追
       * 无解（附决策 6 直线追永不成立），横切/迎头路径才可猎；dash 档收口另计）
       * 决策树降问（GAMES-166 放水）：连败席入作用圈 → Q2 整问停用（树四问→三问） */
      const theta = THETA[me.tier]
      const hungry = level === 'competitive' || me.M < (TIER_BOUND[Math.min(2, me.tier)] || 4000) * 0.6
      let prey = null, pd = Infinity, pT = 0
      const intercept = (f, vCap) => {
        const pv = P.vOf(f.M)
        const d0 = Math.sqrt(near(f.x, f.y))
        let t = d0 / Math.max(2000, vCap)
        for (let i = 0; i < 3; i++) {
          const ix = f.x + Math.cos(f.a * RAD) * pv * t, iy = f.y + Math.sin(f.a * RAD) * pv * t
          if (ix < 40000 || iy < 40000 || ix > P.W - 40000 || iy > P.H - 40000) return null // 外推出界=无解
          t = Math.sqrt(dist2(me.x, me.y, ix, iy)) / Math.max(2000, vCap)
        }
        return t <= 30 ? t : null                            // 拦截闭式解 t≤3s（§4.1）
      }
      const q2open = per.hunt > 0 && theta !== Infinity && hungry
      if (mercyNear && q2open) mem.ch.md++                   // 降问台账（本拍 Q2 被放水停用）
      if (q2open) {
        for (const f of foes) {
          if (!huntable(f) || f.prot > 0 || near(f.x, f.y) > per.eatR * per.eatR) continue
          const rF = P.rOfM(f.M)
          if (!P.canSwallow(myR, rF)) continue
          if (((f.M * 11) / 20 | 0) < theta) continue        // gain ≥ θ(T)（机会吞 balanced 只吃嘴边）
          const d = Math.sqrt(near(f.x, f.y))
          if (level === 'balanced' && d > 160_000) continue  // balanced=机会吞不追击（§4.2）
          let t = intercept(f, v)                            // 巡航速拦截解
          if (t == null && level === 'competitive' && d < 400_000 && me.M > P.DASH_MIN + 40) {
            t = intercept(f, v * 1.6)                        // dash 档拦截（质量换速度收口，附决策 6）
          }
          if (t == null) continue
          /* 目标成长曲线外推（GAMES-166 competitive 捕食预判深化）：mem.tg 跟踪上拍选中
           * 猎物的 M 增速 g，拦截点投影 M_p=M+g·(t+8) 越 K 线（投影后吞不动）→ 弃猎——
           * 不追注定失效的拦截点（追击质量成本止损） */
          if (per.growExt && mem.tg === f.id && st.tick > mem.tgT) {
            const g = (f.M - mem.tgM) / (st.tick - mem.tgT)
            if (g > 0 && !P.canSwallow(myR, P.rOfM(f.M + g * (t + 8)))) continue
          }
          if (d < pd) { pd = d; prey = f; pT = t }
        }
      }
      if (prey) {
        mem.ch.q2++
        mem.tg = prey.id; mem.tgM = prey.M; mem.tgT = st.tick // 成长曲线跟踪锚（下拍外推用）
        /* HUNT：远段奔拦截点（闭式解 lead pT）；近段（<150px）短前导直捣猎物心——
         * dash 转向半径 ~70px 下拦截点重瞄会绕圈过冲，收口段改为纯追踪（§4.1 收口） */
        const pv = P.vOf(prey.M)
        const lead = pd < 150_000 ? Math.min(2, pT) : pT
        mem.ta = deg(clamp(prey.x + Math.cos(prey.a * RAD) * pv * lead, 60000, P.W - 60000),
                     clamp(prey.y + Math.sin(prey.a * RAD) * pv * lead, 60000, P.H - 60000))
        if (level === 'competitive' && pd < 300_000 && me.M > P.DASH_MIN + Math.min(320, me.M * 0.08)) mem.dash = 1 // 收口 dash（8% 质量池预算）
        mem.wp = null
      } else {
        /* Q3 密度场觅食：8 方向 × 2 档距（120/260px）ρ=Σ v/(d+60px) → 梯度最陡向（§4.1）。
         * casual=饲料位（§4.2 预期生存 ~40s/命·尸粒供给主力）：不做密度场主动觅食——
         * Q4 waypoint 漫游 + 顺路吃（嘴径扫过即得），体型滞留 T0 低段=常驻食物带
         * （§1.4 重生注入 ~3.0 质量/s 的供给前提=被吞流在场，设计经济第三列） */
        let bestA = null, bs = -1
        if (level !== 'casual') {
        /* GAMES-166 balanced 深化：局部密度采样窗（rhoWin=2 档距 260px 内）+ 方向 ρ 移动
         * 均值（EWMA rhoEwma——瞬时场抖动平滑防逐拍翻转）+ sticky（平滑后并列偏沿袭向）；
         * competitive 无 rhoWin=全档 eatR 直采（广域猎手位不变） */
        const win = per.rhoWin || per.eatR
        const rhoNow = new Array(8).fill(0)
        const crowdedK = new Array(8).fill(false)
        for (let k = 0; k < 8; k++) {
          const ang = k * 45 * RAD
          let rho = 0
          for (const d of dots) {
            const dd = Math.sqrt(near(d.x, d.y))
            if (dd > win) continue                           // 采样窗（balanced=局部 2 档距）
            const proj = (d.x - me.x) * Math.cos(ang) + (d.y - me.y) * Math.sin(ang)
            if (proj <= 0) continue                          // 只统计该方向半平面内的食
            const cw = proj > 260_000 ? 1 : 0.6              // 近档权重（锥内密度近似）
            let s = (d.v || SITE_V[d.k] || 1) * 60000 / (dd + 60000) * cw
            if (d.k === 'drop') s *= 1.6                     // 尸粒簇优先（§4.1 同 snake）
            rho += s
          }
          rhoNow[k] = rho
          for (const f of foes) {                            // 让食（放水 L1/L2）：真人食圈不抢（§4.3）
            if (!mercyOf.has(f.seat)) continue
            const px2 = me.x + Math.cos(ang) * 140_000, py2 = me.y + Math.sin(ang) * 140_000
            if (dist2(px2, py2, f.x, f.y) < mercyFoodR(f) * mercyFoodR(f)) { crowdedK[k] = true; break }
          }
        }
        if (per.rhoEwma) {                                   // EWMA 平滑（balanced 深化）
          if (!mem.rho8) mem.rho8 = rhoNow.slice()
          else for (let k = 0; k < 8; k++) mem.rho8[k] = mem.rho8[k] * per.rhoEwma + rhoNow[k] * (1 - per.rhoEwma)
        }
        for (let k = 0; k < 8; k++) {
          if (crowdedK[k]) continue
          let s = per.rhoEwma ? mem.rho8[k] : rhoNow[k]
          if (per.rhoEwma && mem.fd === k) s *= 1.05         // sticky：平滑后近并列偏沿袭向
          if (s > bs) { bs = s; bestA = k * 45 }
        }
        }
        if (bestA != null && bs > 0) {
          mem.ch.q3++
          mem.fd = bestA / 45                                // 沿袭向簿记（sticky 用）
          mem.ta = ((bestA + (rng() * 2 - 1) * per.drift) % 360 + 360) % 360   // drift=巡游观感（§4.2）
          mem.wp = null
        } else {
          mem.ch.q4++
          /* Q4 巡游：casual 分区随机 / balanced 全图 / competitive T≥2 晶簇带边缘埋伏（§4.1） */
          if (!mem.wp || near(mem.wp.x, mem.wp.y) < 200_000) {
            let wx, wy
            if (level === 'competitive' && me.tier >= 2) {   // 晶簇带边缘埋伏悬停（深渊带边 1350-1500px）
              wx = 300000 + ((rng() * 1200000) | 0); wy = 1350000 + ((rng() * 120000) | 0)
            } else if (level === 'casual') {                 // 分区随机（浅层育婴生态位，§2.1）
              const qx = (rng() * 2 | 0) * 900000 + 200000, qy = (rng() * 2 | 0) * 900000 + 200000
              wx = qx + ((rng() * 400000) | 0); wy = qy + ((rng() * 400000) | 0)
            } else {
              wx = 200000 + ((rng() * (P.W - 400000)) | 0); wy = 200000 + ((rng() * (P.H - 400000)) | 0)
            }
            mem.wp = { x: wx, y: wy }
          }
          mem.ta = deg(mem.wp.x, mem.wp.y)
        }
        /* balanced 偶尔 dash：鱼汛潮窗内冲刺赶潮（§4.2） */
        if (level === 'balanced' && st.bloom.band >= 0 && me.M > 120) mem.dash = 1
      }
    }
    /* 失误注入（GAMES-166）：① casual blunder=可调失误率（±60..120° 错航向——饲料位
     * 观感漂移的结构化来源，PERSONA/game.json bot.persona 可调）；② 放水让力失误
     * （连败席近旁 ±70°+dash 熄灭——「追得上」的体感来源）。均决策拍内 rng 确定性 */
    const bl = mercyNear ? MERCY_BLUNDER[mercyNear] : (per.blunder || 0)
    if (bl > 0 && rng() < bl) {
      const mag = mercyNear ? 70 : 60 + rng() * 60
      mem.ta = ((mem.ta + (rng() < 0.5 ? -1 : 1) * mag) % 360 + 360) % 360
      if (mercyNear) mem.dash = 0                            // 让力：不逃逸冲刺
      mem.ch.bl++
    }
  }
  mem.dt--
  let ta = mem.ta == null ? me.a : mem.ta
  let dash = mem.dash ? 1 : 0

  /* 逐拍避障（决策间隔外的连续护栏，§4）：缓流墙向心逃逸（无墙死——护栏防呆滞贴边） */
  const wallM = per.wallM
  const inWallBand = me.x < wallM || me.y < wallM || me.x > P.W - wallM || me.y > P.H - wallM
  if (inWallBand) mem.wall = 10
  if (mem.wall > 0) { mem.wall--; ta = toCenter(); dash = 0 }
  return { a: Math.round(ta), dash }
}

/* =====================================================================
 * emit —— S6 二式快照组包（per-connection 个性化 AOI"档即视野"+ 稀疏脏字段，§5.2）
 * 鱼增量恒带 id,x,y,a，M/skin/sc/k2/b/d/t/p 变才带；资源位只 {id,on}；
 * 档位 AOI {380,440,500,560}+15px 滞回带；退化阈值（脏>180 或增量>1.2KB 全量）；
 * 每 300 张强制全量；spectator 镜头点 r 固定 460（§5.2）。
 * ===================================================================== */
const connState = new WeakMap()
function connBook(ctx) {
  let b = connState.get(ctx)
  if (!b) { b = { known: new Set(), seq: 0, sinceFull: 0, sent: new Map(), cx: P.W / 2, cy: P.H / 2, force: true }; connState.set(ctx, b) }
  return b
}
function fishFull(rec) {
  return { id: rec.id, k: 'fish', seat: rec.seat, name: rec.name, x: rec.x, y: rec.y, a: rec.a,
    M: rec.M, t: rec.tier, skin: rec.skin, sc: rec.score, k2: rec.kills, b: rec.boost ? 1 : 0, d: rec.dead, p: rec.prot }
}
function fishIncr(rec, b) {
  const out = { id: rec.id, x: rec.x, y: rec.y, a: rec.a }
  const last = b.sent.get(rec.id) || {}
  if (rec.M !== last.M) out.M = rec.M
  if (rec.tier !== last.t) out.t = rec.tier
  if (rec.skin !== last.skin) out.skin = rec.skin
  if (rec.score !== last.sc) out.sc = rec.score
  if (rec.kills !== last.k2) out.k2 = rec.kills
  if ((rec.boost ? 1 : 0) !== last.b) out.b = rec.boost ? 1 : 0
  if ((rec.dead ? 1 : 0) !== last.d) out.d = rec.dead
  if (rec.prot !== last.p) out.p = rec.prot
  b.sent.set(rec.id, { M: rec.M, t: rec.tier, skin: rec.skin, sc: rec.score, k2: rec.kills, b: rec.boost ? 1 : 0, d: rec.dead, p: rec.prot })
  return out
}
function emitOne(room, ctxRec, r, opt = {}) {
  const st = room.state
  const b = connBook(ctxRec.ctx)
  const seat = ctxRec.seat
  const own = seat >= 0 ? st.ents['s' + seat] : null
  let cx = b.cx, cy = b.cy, rr = 460_000                     // spectator：镜头点 r 固定 460（§5.2）
  if (own) { cx = own.x; cy = own.y; rr = P.aoiR(own.tier) } // 档即视野（死亡视角保持末档）
  b.cx = cx; b.cy = cy
  const rOut = rr + 15000                                    // 15px 滞回带（§5.2）

  /* 视野候选：鱼=点实体单点精判（比蛇 AABB+5 点预筛更廉，附决策 9）；粒/位圆判定 */
  const cand = []
  for (const id in st.ents) {
    const e = st.ents[id]
    const margin = e.k === 'fish' ? P.rOfM(e.M) : e.k === 'drop' ? 14000 : 7000
    const d = dist2(cx, cy, e.x, e.y)
    if (d <= (rr + margin) * (rr + margin) || (b.known.has(id) && d <= (rOut + margin) * (rOut + margin))) cand.push(e)
  }
  const keep = new Set(cand.map((e) => e.id))
  const leave = []
  for (const id of b.known) if (!keep.has(id)) leave.push(id)

  /* 脏集 ∩ 视野（鱼恒脏=全时移动；位 on 翻转/瞬态生灭才脏，§5.2 稀疏编码） */
  const dirtySet = r ? r.dirty : null
  const sendIds = []
  for (const e of cand) {
    if (e.k === 'fish') sendIds.push(e.id)                   // 鱼恒脏
    else if (!b.known.has(e.id)) sendIds.push(e.id)          // 入视野=完整记录
    else if (dirtySet && dirtySet.has(e.id) && e.k !== 'drop') sendIds.push(e.id) // on 翻转
  }
  let full = opt.force || b.force || b.sinceFull >= 300 || sendIds.length > 180
  b.force = false

  let entsArr
  if (full) entsArr = cand.map((e) => (e.k === 'fish' ? fishFull(e) : e.k === 'drop' ? { id: e.id, k: 'drop', x: e.x, y: e.y, v: e.v } : { id: e.id, k: e.k, x: e.x, y: e.y, v: e.v, on: e.on }))
  else entsArr = sendIds.map((id) => { const e = st.ents[id]; return e.k === 'fish' ? fishIncr(e, b) : { id, on: e.on } })

  const msg = {
    t: 'snapshot', frame: st.tick, base: full ? st.tick : b.base,
    full: full ? 1 : 0, snapSeq: b.seq + 1,
    ext: {
      aoi: { x: cx, y: cy, r: rr },
      ack: seat >= 0 && room.seats[seat] ? (room.seats[seat].lastSeq ?? -1) : -1,
      me: own ? { seat, M: own.M, t: own.tier, sc: own.score, k2: own.kills, d: own.dead, rs: own.dead ? Math.max(0, own.respawnAt - st.tick) : 0, max: own.maxM } : undefined,
      rd: { n: st.round.n, t: st.round.tick, k: st.round.king, rem: Math.max(0, P.ROUND_TICKS - st.round.tick) },
      lb: st.tick % 10 === 0 ? st.leaderboard.slice(0, 5).map((x) => [x.seat, x.score, x.M]) : undefined, // 1Hz 紧凑 [seat,score,M]（§5.2）
      mm: st.tick % 10 === 0 ? (st.mm || []) : undefined,    // 全房密度点 1Hz（§7 小地图）
    },
    ents: entsArr, leave: full ? [] : leave,
  }
  if (r && r.events && r.events.length) msg.events = r.events
  const text = JSON.stringify(msg)
  /* 增量 >1.2KB → 退全量（团猎极端情形，§5.2 退化阈值） */
  if (!full && text.length > 1200) return emitOne(room, ctxRec, r, { force: true })
  b.seq++
  if (full) {
    b.sent.clear()
    for (const e of cand) if (e.k === 'fish') b.sent.set(e.id, { M: e.M, t: e.tier, skin: e.skin, sc: e.score, k2: e.kills, b: e.boost ? 1 : 0, d: e.dead, p: e.prot })
    b.base = st.tick; b.sinceFull = 0
  } else b.sinceFull++
  b.known = keep
  if (ctxRec.ctx.conn && ctxRec.ctx.conn.writable) ctxRec.ctx.conn.send(text)
}
function emit(room, r) {
  for (const s of room.seats) if (s.conn) emitOne(room, { ctx: s.conn, seat: s.seat }, r)
  for (const c of room.spectators) emitOne(room, { ctx: c, seat: -1 }, r)
}
function onSync(room, ctx) {
  const s = room.seats.find((x) => x.conn === ctx)
  emitOne(room, { ctx, seat: s ? s.seat : -1 }, null, { force: true })
}

/* ---------- 适配器出口（rooms.js 注册表形状 + S6 扩展 emit/onSync） ---------- */
module.exports = {
  META: {
    gameId: 'deep-foodchain', title: '深海食物链', mode: 'swarm-arena',
    seats: 24, tickMs: TICK_MS,
    persistent: true,    // 常驻渔场：rooms 跳过 abandon/maxTicks（§1.1/附决策 1）
    takeOver: 'casual',  // 断线逾时 casual 托管继续游（§4.3）
    roomPrefix: 'deep',  // feed 字典序 deep 排首（§5.8：deep-<element-<emp-<…）
  },
  LEVELS: ['casual', 'balanced', 'competitive'],
  url: '/games/multiplayer/deep-foodchain/index.html',
  create, step, emit, onSync,
  brain: (st, seat, level, rng, env) => brainImpl(st, seat, level, rng, env), // 适配器包装注入 env.mercy（server/gateway/sims/deep-foodchain.js）
  welcomeExtra: () => ({ // S6 声明块（协议 §6 向后兼容自由键；snake/physics/duel 同范式）
    fish: { engine: 'deep-foodchain-sim', v: 1, K: 1.25, aoiR: [380, 560], cap: { fish: 24, site: 180, drop: 240, M: 4000 } },
  }),
  fnv1a32, mulberry32,
  /* 质量账本探针（§5.3/A8——testapi 读全量 state 即可对账，不占快照带宽） */
  massIdentity: (st) => {
    let sumM = 0, sumDots = 0
    for (const id in st.ents) {
      const e = st.ents[id]
      if (e.k === 'fish' && !e.dead) sumM += e.M
      else if (e.k === 'drop') sumDots += e.v
    }
    const L = st.ledger
    return sumM + sumDots + L.expired - L.endow - L.ate - L.gained - L.dropped + L.dashed
  },
  MERCY_DFT, PERSONA, THETA, BOT_EVERY, MERCY_NEAR, MERCY_BLUNDER,
}
