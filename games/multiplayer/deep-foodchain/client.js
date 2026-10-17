/* =====================================================================
 * 深海食物链 客户端（GAMES-164 · S6 海量实体第二证）——客户端零判定，服务端权威快照流。
 * 依赖前置：<script src="shared.cjs">（window.DeepF，与服务端 sim 同一段纯函数：
 * r/v/w 曲线 + tierOf 档位表 + stepTurn 转向积分）。
 *
 * 三类延迟敏感操作三种策略（§3.1/§5.4，snake 范式）：
 *   自身鱼=本地转向预测 0ms 起步（drag 即转向）+ 快照 ack 和解（角度差 ≤30°
 *   每帧 20% 平滑、>30° 300ms 快滑；位置 >34px 硬贴齐）；
 *   他人鱼=120ms 插值缓冲（两样本 lerp，迟到外推 1 张仅呈现）；
 *   吞噬零预测（§5.4：判定含对手运动，本地无信息可预测——纯服务器事件驱动）。
 * 渲染（§7）：深海军绿底+三光带分层（光照/暮光/深渊）+ 缓流墙呼吸光 + 尘埃氛围层；
 * 体型四档形色双编码（T0 圆卵淡青/T1 梭形银蓝/T2 三角鳍灰蓝/T3 宽巨深蓝金描边——
 * 形状+颜色双通道，hud-font-standard §3 色盲纪律）；可吞目标绿细描边环、威胁红边缘光晕
 * （与 Bot 决策树 Q1/Q2 同一套 K=1.25 判据的渲染镜像，§7 敌我一屏可读）；
 * LOD 三档 + 视口裁剪 + 光点预烘焙两批合批 + 粒子对象池零 GC。
 * HUD 字号走 HF 登记表+__applied 生效往返自证（Q-013 教训首日清偿，票面指定：
 * 登记值≠ctx.font 回读值即 __applied:false 计红线——weight 用前置合法简写 700 13px）。
 * debug 模式（?debug=1）：本地幽灵渔场（20 幽灵鱼+180 资源位+瞬态，同渲染路径，
 * perf-smoke 契约：boot → start(1) → rAF 采样）。
 * ===================================================================== */
'use strict'
;(function () {
  const K = window.DeepF
  const W = 375, H = 667, TOP_H = 56
  const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif"
  const WORLD = K.W / 1000 // 世界 px（1800）
  /* §7 调色板：深海军绿底+三光带（§2.1 纵向分区同源） */
  const BG_TOP = '#061410', BG_MID = '#0C2B1E'
  const BAND_LIT = 'rgba(16,54,42,.55)', BAND_DARK = 'rgba(5,13,10,.6)' // 光照带/深渊带叠层
  const WALL_COL = 'rgba(127,232,216,.32)'
  const RES_COL = { alg: '#7FE8D8', kri: '#C98FE8', cry: '#FFD700', drop: '#FFB65C', dash: '#FFE9B8' }
  const TIER_COL = ['#8FD8C8', '#6FA8FF', '#5C7A99', '#3D5A80']      // §7 形色双编码颜色通道
  const TIER_NAME = ['浮游', '小鱼', '猎鲨', '沧鲸']
  const SKIN = [
    { c: '#3DDC84', pat: 'ring', hat: null }, { c: '#FFB65C', pat: 'dia', hat: 'horn' },
    { c: '#A78BFA', pat: 'stripe', hat: 'fin' }, { c: '#6FA8FF', pat: 'grad', hat: null },
    { c: '#FF6B5C', pat: 'dia', hat: 'horn' }, { c: '#E8E8F0', pat: 'ring', hat: 'crown' },
    { c: '#5C6B7A', pat: 'stripe', hat: 'fin' }, { c: '#FFD166', pat: 'grad', hat: 'crown' },
  ]
  const MS_TITLE = { 80: '成鱼', 300: '猎鲨', 1000: '沧鲸', 4000: '海王之姿' }
  const INK = '#E8ECF3', DIM = '#8B93A7'

  /* ---------- HUD 字号登记表（HF 体系+__applied 自证，Q-013 首日） ---------- */
  var HF_REG = {}, dbgEvents = []
  function HF(grp, key, px, w) {
    ;(HF_REG[grp] || (HF_REG[grp] = {}))[key] = { px, w: w || 400 }
    return (w ? w + ' ' : '') + px + 'px ' + FONT
  }
  /* __applied 生效往返自证（GAMES-135/143 两作实锤坑前置清偿）：赋 ctx.font 后回读
   * 解析含目标字号与字重才 true——非法简写被 canvas 静默忽略=10px 缺省字，第一断言位 */
  function appliedSelfCheck(ctx) {
    ctx.save()
    ctx.font = '700 13px ' + FONT
    const m = /(\d+)px/.exec(ctx.font)
    const ok = !!(m && +m[1] === 13 && (/700/.test(ctx.font) || /bold/i.test(ctx.font)))
    ctx.restore()
    return ok
  }

  /* ---------- 音效位（≥14 槽，common.js makeSound 程序合成范式；总闸门默认静音只记账；
   * fired=持久触达集——calls 滚动窗被游戏音洪水冲掉的 GAMES-141 教训） ---------- */
  const sfx = {
    slots: ['eat1', 'eat2', 'eat4', 'devour', 'die', 'dashOn', 'dashOff', 'bubble', 'tier', 'crown', 'spawn', 'bloom', 'streak', 'danger', 'round', 'curve'],
    calls: [], fired: {}, on: false, ac: null,
    tone(f0, f1, dur, type, vol) {
      if (!this.ac) { try { this.ac = new (window.AudioContext || window.webkitAudioContext)() } catch { this.ac = null } }
      const a = this.ac; if (!a) return
      const o = a.createOscillator(), gn = a.createGain(), t = a.currentTime
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
      gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.connect(gn).connect(a.destination); o.start(t); o.stop(t + dur + 0.02)
    },
    play(slot, t) {
      this.calls.push({ g: slot, t: t || '', at: performance.now() })
      this.fired[slot] = 1
      if (!this.on) return
      if (slot === 'eat1') this.tone(660, 880, 0.06, 'triangle', 0.05)
      else if (slot === 'eat2') this.tone(740, 1050, 0.08, 'triangle', 0.06)
      else if (slot === 'eat4') { this.tone(880, 1320, 0.09, 'triangle', 0.07); setTimeout(() => this.tone(1320, 1760, 0.07, 'sine', 0.05), 70) }
      else if (slot === 'devour') { // 咂嘴体型分级音高：越大嘴越低沉（t 参数=体型档）
        const tp = parseInt(t) || 0
        this.tone(320 - tp * 55, 95 - tp * 10, 0.22, 'sawtooth', 0.07)
        setTimeout(() => this.tone(900 - tp * 60, 1400 - tp * 90, 0.12, 'square', 0.04), 60)
      }
      else if (slot === 'die') this.tone(220, 55, 0.4, 'sawtooth', 0.08)
      else if (slot === 'dashOn') this.tone(440, 880, 0.12, 'square', 0.045)
      else if (slot === 'dashOff') this.tone(880, 440, 0.1, 'square', 0.035)
      else if (slot === 'bubble') this.tone(520, 760, 0.05, 'sine', 0.03) // dash 水泡串（尾迹粒点化）
      else if (slot === 'tier') { this.tone(523, 523, 0.1, 'sine', 0.07); setTimeout(() => this.tone(784, 784, 0.14, 'sine', 0.07), 95) }
      else if (slot === 'crown') { this.tone(784, 784, 0.12, 'sine', 0.08); setTimeout(() => this.tone(1046, 1568, 0.22, 'sine', 0.08), 110) }
      else if (slot === 'spawn') this.tone(330, 660, 0.14, 'sine', 0.05)
      else if (slot === 'bloom') { this.tone(392, 784, 0.18, 'triangle', 0.06); setTimeout(() => this.tone(523, 1046, 0.22, 'triangle', 0.06), 130) }
      else if (slot === 'streak') this.tone(1046, 1568, 0.16, 'square', 0.05)
      else if (slot === 'danger') this.tone(160, 120, 0.18, 'sawtooth', 0.05)
      else if (slot === 'round') { this.tone(392, 392, 0.12, 'sine', 0.06); setTimeout(() => this.tone(523, 523, 0.16, 'sine', 0.06), 120) }
      else if (slot === 'curve') this.tone(523, 392, 0.3, 'sine', 0.05) // 成长曲线展开（下行收束）
    },
  }

  /* =====================================================================
   * 动效台账（GAMES-167 手感层）：FXLIST 登记表 + fxTrig→fxDraw 双时戳。
   * fb=反馈类（事件驱动，≤80ms 红线）/state=状态类（常驻呈现，只报数）；
   * fx 层只读消费状态+裁决事件（sim/brain 零改动）。
   * ===================================================================== */
  const FXLIST = [
    ['F01', 'devourGulp', 'fb'],      // 吞噬张嘴+吸入拉丝动画（signature，§3.3 240ms）
    ['F02', 'tierBurst', 'fb'],       // 体型升档爆发光圈+squash 弹性缩放（§3.3）
    ['F03', 'tierHold', 'state'],     // 定档滞回提示（升档进度条+降档 −5% 带红脉冲，§2.4）
    ['F04', 'dashTrail', 'fb'],       // dash 加速尾迹+质量流失气泡串（§3.3）
    ['F05', 'preyPanic', 'fb'],       // 被捕惊红闪（天敌逼近/被吞红边脉冲）
    ['F06', 'deathScatter', 'fb'],    // 死亡掉落散布（粒数=drops 坠流扇面）
    ['F07', 'foodFloat', 'state'],    // 食物闪烁浮游感（bob 起伏+晶簇闪烁）
    ['F08', 'aoiBreath', 'state'],    // AOI 视野圈呼吸（档即视野 §2.4，±2%）
    ['F09', 'lbDelta', 'state'],      // 排行榜变动差值标（▲/▼ 900ms 淡出）
    ['F10', 'preyMark', 'state'],     // 猎物高亮描边（可吞提示=绿细环）
    ['F11', 'predAlert', 'state'],    // 天敌红名警示（不可吞规避=红环+红名）
    ['F12', 'comboBounce', 'fb'],     // 连吃 combo 计数弹跳（+N×n 三段弹跳）
    ['F13', 'whaleEntrance', 'fb'],   // 鲸级登场震屏波纹（T3 沧鲸降世双环）
    ['F14', 'growthCurve', 'state'],  // 终局成长曲线回放图（mHist 折线）
    ['F15', 'specBars', 'state'],     // 观战体型对比条（top5 rOf 相对条）
    ['F16', 'sinkEntrance', 'fb'],    // 开场下沉入场（世界沉落 420ms）
  ]
  const FXLED = []
  function fxTrig(id) { FXLED.push({ id, trig: Math.round(now), draw: null, lat: null }); if (FXLED.length > 600) FXLED.splice(0, 200) }
  function fxDraw(id) { // 首绘落章：最近一条未绘条目盖 draw 戳（fb=draw-trig 可复跑）
    for (let i = FXLED.length - 1; i >= 0; i--) {
      const e = FXLED[i]
      if (e.id !== id) continue
      if (e.draw == null) { e.draw = Math.round(now); e.lat = e.draw - e.trig }
      return
    }
  }

  /* ---------- perf 钩子（rafGap 首帧不播种——GAMES-141 恒 0fps 死码教训） ---------- */
  const PERF = { gaps: [], costs: [], lastRaf: 0, seeded: false }
  function perfTick(t, cost) {
    if (PERF.seeded) { PERF.gaps.push(t - PERF.lastRaf); PERF.costs.push(cost) }
    else PERF.seeded = true
    PERF.lastRaf = t
    if (PERF.gaps.length > 360) { PERF.gaps.splice(0, 120); PERF.costs.splice(0, 120) }
  }
  function perfStat() {
    const cs = PERF.costs.slice().sort((a, b) => a - b)
    const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0)
    return {
      rafGapMs: avg(PERF.gaps),
      fps: PERF.gaps.length ? Math.round(1000 / Math.max(0.01, avg(PERF.gaps))) : 0,
      costP95Ms: cs.length ? +cs[Math.floor(cs.length * 0.95)].toFixed(2) : 0,
      costJankPct: cs.length ? +(cs.filter((c) => c > 25).length / cs.length * 100).toFixed(2) : 0,
      n: PERF.gaps.length,
    }
  }

  /* ---------- 全局状态 ---------- */
  const S = {
    mode: 'connecting', conn: null, roomId: null, seat: -1, token: null, roster: [],
    ents: new Map(), me: null, round: { n: 1, t: 0, k: -1, rem: K.ROUND_TICKS }, lb: [], mm: [],
    ping: 0, seq: 0,
    target: null, dashOn: false, sentDash: false,
    dead: false, respawnIn: 0, killerName: '', dropN: 0, crown: null, crownUntil: 0,
    connLost: false, err: '', pauseViz: false,
    toasts: [], parts: [], shakes: 0, shakeT: 0, eatStreak: 0, eatT: 0,
    rings: [], flash: 0, flashC: '#FFD700', slowUntil: 0, zoomPulse: 0, enterT0: 0, deathT0: 0,
    settle: null, streakN: 0, streakT: 0, bloom: -1, sawSnap: false,
    /* 手感层（GAMES-167）：动效态只读消费快照/事件，不入模拟 */
    gulp: null, scatters: [], combo: null, tierBurst: null, whale: null,
    panicUntil: 0, threatNear: false, lbDeltas: {}, lbPrev: null, mHist: [],
    specDemo: 0, curveUntil: 0, lastBubble: 0,
  }
  const cam = { x: K.W / 2, y: K.H / 2, zoom: 1, zTarget: 1, vx: 0, vy: 0 }
  let now = performance.now()
  const cv = document.getElementById('cv')
  const g = cv.getContext('2d')

  /* ---------- 光点 sprite 预烘焙（径向渐变离屏，两批合批，§5.4）
   * VIS 双编码：形通道——藻=素圆/虾=菱形轮廓/晶=十字芒/尸粒=暖橙圆核（§7） */
  const SPRITES = {}
  for (const k in RES_COL) {
    const c = document.createElement('canvas')
    c.width = c.height = 28
    const cg = c.getContext('2d')
    const grd = cg.createRadialGradient(14, 14, 1, 14, 14, 13)
    grd.addColorStop(0, '#fff')
    grd.addColorStop(0.35, RES_COL[k])
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    cg.fillStyle = grd
    cg.beginPath(); cg.arc(14, 14, 13, 0, Math.PI * 2); cg.fill()
    if (k === 'kri') {
      cg.strokeStyle = '#fff'; cg.lineWidth = 2
      cg.beginPath(); cg.moveTo(14, 3); cg.lineTo(25, 14); cg.lineTo(14, 25); cg.lineTo(3, 14); cg.closePath(); cg.stroke()
    } else if (k === 'cry') {
      cg.strokeStyle = '#fff'; cg.lineWidth = 2
      cg.beginPath(); cg.moveTo(14, 6); cg.lineTo(14, 22); cg.moveTo(6, 14); cg.lineTo(22, 14); cg.stroke()
    }
    SPRITES[k] = c
  }
  const SPR_SIG = {}
  for (const k in SPRITES) {
    const d = SPRITES[k].getContext('2d').getImageData(0, 0, 28, 28).data
    const L = (x, y) => { const i = (y * 28 + x) * 4; return Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) }
    SPR_SIG[k] = { a5: L(19, 14), a7: L(21, 14), dg: L(20, 19) }
  }
  /* 尘埃氛围层（§7：10-15 粒慢速漂浮） */
  const DUST = Array.from({ length: 14 }, (_, i) => ({ x: Math.random() * K.W, y: Math.random() * K.H, v: 4000 + Math.random() * 8000, ph: i }))

  function report(event, payload) {
    if (window.__GAMES_DEBUG__) window.__GAMES_DEBUG__.events.push({ event, payload, at: Date.now() })
  }
  function emitDbg(ev, payload) { dbgEvents.push({ event: ev, payload, at: Date.now() }); if (dbgEvents.length > 120) dbgEvents.shift() }

  /* =====================================================================
   * 连接层（net 协议 v1.1：join/quick → welcome/snapshot 流；snake 先例）
   * ===================================================================== */
  function gwOrigin() {
    const q = new URLSearchParams(location.search).get('gw')
    if (q) return q.replace(/\/+$/, '')
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    return scheme + '://' + location.hostname + ':4400'
  }
  function connect() {
    const ws = new WebSocket(gwOrigin())
    S.conn = ws
    ws.onopen = () => {
      const q = new URLSearchParams(location.search)
      const rid = q.get('room')
      let resume = null
      try { resume = JSON.parse(sessionStorage.getItem('df-' + rid) || 'null') } catch { resume = null }
      ws.send(JSON.stringify({ t: 'join', roomId: rid || undefined, mode: q.get('mode') === 'spectate' ? 'spectate' : 'play', resume: resume ? { seat: resume.seat, token: resume.token } : undefined, name: '玩家' }))
      if (!rid) ws.send(JSON.stringify({ t: 'quick', gameId: 'deep-foodchain' }))
    }
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data) } catch { return } onMsg(m) }
    ws.onclose = () => { S.connLost = true }
    ws.onerror = () => { S.connLost = true }
  }
  function onMsg(m) {
    if (m.t === 'error') { S.err = m.code || m.message; setTimeout(() => { S.err = '' }, 2500); return }
    if (m.t === 'welcome') {
      S.roomId = m.roomId; S.seat = m.role === 'player' ? m.seat : -1
      S.token = m.token; S.roster = (m.room && m.room.seats) || []
      if (m.token != null) { try { sessionStorage.setItem('df-' + S.roomId, JSON.stringify({ seat: S.seat, token: S.token })) } catch {} }
      S.mode = S.seat >= 0 ? 'playing' : 'spectate'
      S.ents.clear()
      if (m.state) applyWelcomeState(m.state)
      document.getElementById('boot').style.display = 'none'
      return
    }
    if (m.t === 'seat') { S.roster = m.seats; return }
    if (m.t === 'started') { if (m.state) applyWelcomeState(m.state); return }
    if (m.t === 'snapshot') { applySnapshot(m); return }
    if (m.t === 'end') { S.crown = { over: true, result: m.result }; S.curveUntil = now + 6000; fxTrig('F14'); sfx.play('curve', ''); return }
    if (m.t === 'closed') { S.connLost = true }
  }
  function applyWelcomeState(st) {
    S.round = { n: st.round.n, t: st.round.tick, k: st.round.king, rem: K.ROUND_TICKS - st.round.tick }
    if (st.leaderboard) { S.lb = st.leaderboard.slice(0, 5) }
    for (const id in st.ents) addEnt(st.ents[id])
    const me = S.seat >= 0 ? st.ents['s' + S.seat] : null
    if (me) { cam.x = me.x; cam.y = me.y; cam.zoom = cam.zTarget = K.zoomOf(me.t || 0) }
    S.enterT0 = now
    S.mHist = []
    fxTrig('F16') // 开场下沉入场（§3.3）
    sfx.play('spawn', '')
    emitDbg('welcome', { seat: S.seat, round: st.round.n })
  }

  /* =====================================================================
   * 快照管线（二式：全量/增量+稀疏脏字段，§5.2）
   * ===================================================================== */
  function addEnt(e) {
    if (e.k === 'fish') {
      const rec = S.ents.get(e.id) || {}
      Object.assign(rec, {
        id: e.id, k: 'fish', seat: e.seat, name: e.name, M: e.M || 20, t: e.t || 0, skin: e.skin || 0,
        x: e.x, y: e.y, a: e.a, sc: e.sc || 0, k2: e.k2 || 0, b: e.b || 0, d: e.d || 0, p: e.p || 0,
        smp: [{ t: e.frameTs || 0, x: e.x, y: e.y, a: e.a }],
        fade: 1,
      })
      S.ents.set(e.id, rec)
    } else {
      S.ents.set(e.id, { id: e.id, k: e.k || 'drop', x: e.x, y: e.y, v: e.v || 0, on: e.on === undefined ? 1 : e.on, fade: 1 })
    }
  }
  function applySnapshot(m) {
    if (S.sawSnap && m.ext.rd.n !== S.round.n) { // 轮末结算（轮次翻页，首快照不算）
      S.settle = { n: S.round.n, t0: now }
      S.curveUntil = now + 1800; fxTrig('F14')
      sfx.play('round', String(S.round.n)); sfx.play('curve', '')
    }
    S.round = { n: m.ext.rd.n, t: m.ext.rd.t, k: m.ext.rd.k, rem: m.ext.rd.rem }
    const tAuth = m.frame * 100
    if (m.ext.lb) {
      const next = m.ext.lb.map((r) => Array.isArray(r) ? { seat: r[0], score: r[1], M: r[2] } : r)
      for (const r of next) { // 排行榜变动差值标（F09）：score 逐席对账
        const prev = S.lbPrev && S.lbPrev[r.seat]
        if (prev != null && r.score !== prev) S.lbDeltas[r.seat] = { d: r.score - prev, t0: now }
      }
      S.lbPrev = {}
      for (const r of next) S.lbPrev[r.seat] = r.score
      S.lb = next
    }
    if (m.ext.mm) S.mm = m.ext.mm
    if (m.ext.me && m.ext.me.seat === S.seat) {
      const wasDead = S.dead
      S.dead = !!m.ext.me.d
      S.respawnIn = m.ext.me.rs || 0
      if (!wasDead && S.dead) onMyDeath()
      if (wasDead && !S.dead) { S.killerName = ''; sfx.play('spawn', '') }
    }
    if (m.full) {
      const keep = new Set()
      for (const e of m.ents) { addEnt(e); keep.add(e.id) }
      for (const [id, rec] of S.ents) if (!keep.has(id)) rec.gone = 1
    } else {
      for (const e of m.ents) {
        const rec = S.ents.get(e.id)
        if (!rec) { addEnt(e); continue }
        if (rec.k === 'fish') {
          rec.x = e.x; rec.y = e.y; rec.a = e.a
          if (e.M !== undefined) rec.M = e.M
          if (e.t !== undefined) rec.t = e.t
          if (e.skin !== undefined) rec.skin = e.skin
          if (e.sc !== undefined) rec.sc = e.sc
          if (e.k2 !== undefined) rec.k2 = e.k2
          if (e.b !== undefined) rec.b = e.b
          if (e.d !== undefined) rec.d = e.d
          if (e.p !== undefined) rec.p = e.p
          rec.smp.push({ t: tAuth, x: rec.x, y: rec.y, a: rec.a })
          if (rec.smp.length > 4) rec.smp.shift()
        } else if (e.on !== undefined) {
          rec.on = e.on
          if (e.x !== undefined) { rec.x = e.x; rec.y = e.y }
        }
      }
      for (const id of m.leave || []) { const rec = S.ents.get(id); if (rec) rec.gone = 1 }
    }
    for (const ev of m.events || []) onEvent(ev)
    S.sawSnap = true
  }
  function onMyDeath() { S.shakes = 8; S.shakeT = 400; S.deathT0 = now; S.panicUntil = Math.max(S.panicUntil, now + 900); fxTrig('F05'); sfx.play('die', '') }
  function onEvent(ev) {
    const isMe = ev.seat === S.seat
    if (ev.k === 'eat' && isMe) {
      S.eatStreak = (now - S.eatT < 2000) ? S.eatStreak + 1 : 1
      S.eatT = now
      sfx.play('eat' + (ev.v >= 4 ? 4 : ev.v >= 2 ? 2 : 1), String(ev.v || 1))
      const me = S.ents.get('s' + S.seat)
      if (me) {
        const col = RES_COL[(ev.id || '')[0] === 'd' ? 'drop' : (ev.id || '')[0] === 'c' ? 'cry' : (ev.id || '')[0] === 'k' ? 'kri' : 'alg']
        spawnParts(me.x, me.y, col, 3 + (ev.v || 1) * 2)
        S.rings.push({ x: me.x, y: me.y, t0: now, dur: 260, col })
        me.pop = 1
      }
      S.combo = { v: ev.v || 1, n: S.eatStreak, t0: now }; fxTrig('F12') // 连吃 combo 计数弹跳
      if (S.eatStreak >= 5) { S.toasts.push({ txt: '连食×' + S.eatStreak, c: '#7FE8D8', t0: now, dur: 900 }); sfx.play('streak', '') }
    } else if (ev.k === 'devour') {
      const vr = S.ents.get('s' + ev.seat)
      const me = S.ents.get('s' + S.seat)
      if (ev.by === S.seat) {
        const victim = S.roster.find((r) => r.seat === ev.seat)
        S.toasts.push({ txt: '吞噬 ' + ((victim && victim.name) || '猎物') + ' +' + ev.gain, c: '#FFD700', t0: now, dur: 1200, big: true })
        S.shakes = 4; S.shakeT = 240
        S.slowUntil = now + 220; S.zoomPulse = 1
        if (vr) {
          S.gulp = { id: 's' + ev.seat, x: vr.x, y: vr.y, t0: now, dur: 240 }; fxTrig('F01') // 张嘴+吸入拉丝（signature）
          S.rings.push({ x: vr.x, y: vr.y, t0: now, dur: 340, col: '#FFD700', big: 1 }); spawnParts(vr.x, vr.y, '#FFD700', 14)
        }
        S.streakN = now - S.streakT < 8000 ? S.streakN + 1 : 1; S.streakT = now
        if (S.streakN >= 2) S.toasts.push({ txt: '连吞×' + S.streakN, c: '#FF6B5C', t0: now, dur: 1100, big: true })
        sfx.play('devour', String(me ? (me.t || 0) : 0)) // 咂嘴体型分级音高
      }
      if (vr) { // 被吞者死亡掉落散布（F06：粒数=drops 扇面坠流）+碎裂粒雨（§3.3）
        S.scatters.push({ x: vr.x, y: vr.y, t0: now, n: Math.min(30, ev.drops || 8) }); fxTrig('F06')
        spawnParts(vr.x, vr.y, RES_COL.drop, Math.min(24, ev.drops || 8))
      }
      if (isMe) {
        const killer = ev.by >= 0 ? S.roster.find((r) => r.seat === ev.by) : null
        S.killerName = ev.by >= 0 ? ((killer && killer.name) || '大鱼') : '深海'
        S.dropN = ev.drops || 0
      }
    } else if (ev.k === 'tier') {
      if (isMe) {
        S.flash = Math.max(S.flash, 0.9); S.flashC = '#FFD700'
        S.toasts.push({ txt: '升档 · ' + TIER_NAME[ev.t] + '！', c: '#7FE8D8', t0: now, dur: 1400, big: ev.t >= 2 })
        S.tierBurst = { t0: now, t: ev.t }; if (S.ents.get('s' + S.seat)) S.ents.get('s' + S.seat).pop = 1
        fxTrig('F02') // 升档爆发光圈+squash
        sfx.play('tier', String(ev.t))
      }
      if (ev.t === 2) S.toasts.push({ txt: '猎鲨出没', c: '#5C7A99', t0: now, dur: 1500 })
      if (ev.t === 3) { // 沧鲸降世：登场震屏波纹（F13）
        const w = S.ents.get('s' + ev.seat)
        S.whale = { x: w ? w.x : cam.x, y: w ? w.y : cam.y, t0: now }
        S.shakes = Math.max(S.shakes, 6); S.shakeT = Math.max(S.shakeT, 500)
        fxTrig('F13')
        S.toasts.push({ txt: '沧鲸降世', c: '#FFD700', t0: now, dur: 1800, big: true })
      }
    } else if (ev.k === 'milestone') {
      if (isMe) {
        S.flash = Math.max(S.flash, 0.9); S.flashC = '#FFD700'
        S.toasts.push({ txt: MS_TITLE[ev.M] + '！', c: '#7FE8D8', t0: now, dur: 1400, big: ev.M >= 1000 })
        sfx.play('tier', String(ev.M))
      }
    } else if (ev.k === 'bloom') {
      S.bloom = ev.band
      const qn = ['东北', '西北', '东南', '西南'][ev.band] || ''
      S.toasts.push({ txt: '鱼汛潮起 · ' + qn + '象限', c: '#C98FE8', t0: now, dur: 2000, big: true })
      sfx.play('bloom', String(ev.band))
    } else if (ev.k === 'crown') {
      S.crown = { seat: ev.seat, name: ev.name, score: ev.score, t0: now }
      S.crownUntil = now + 5000
      S.flash = Math.max(S.flash, 0.7); S.flashC = '#FFD700'
      sfx.play('crown', '')
    }
  }

  /* ---------- 粒子池（零 GC，§5.4 对象池） ---------- */
  const PPOOL = Array.from({ length: 240 }, () => ({ live: false }))
  function spawnParts(x, y, col, n) {
    let spawned = 0
    for (const p of PPOOL) {
      if (p.live) continue
      p.live = true; p.x = x; p.y = y; p.c = col
      const a = Math.random() * Math.PI * 2, v = 20000 + Math.random() * 60000
      p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v; p.t0 = now; p.dur = 400 + Math.random() * 300
      if (++spawned >= n) break
    }
  }

  /* =====================================================================
   * 输入（§1.5 单拇指：任意处拖=浮动摇杆转向；右下 Ø64 dash 钮=开关）
   * ===================================================================== */
  const joy = { on: false, ox: 0, oy: 0, x: 0, y: 0 }
  const DASH_BTN = { x: W - 58, y: H - 78, r: 32 }
  function setTargetFromJoy() {
    const dx = joy.x - joy.ox, dy = joy.y - joy.oy
    if (dx * dx + dy * dy < 8 * 8) return // 死区 8px（§1.5）
    S.target = ((Math.atan2(dy, dx) * 180 / Math.PI) % 360 + 360) % 360
  }
  function pd(e) {
    const r = cv.getBoundingClientRect()
    const t = e.touches ? e.touches[0] : e
    return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) }
  }
  let lastTap = 0
  cv.addEventListener('touchstart', (e) => {
    e.preventDefault()
    const p = pd(e)
    const db = (p.x - DASH_BTN.x) ** 2 + (p.y - DASH_BTN.y) ** 2
    if (db < DASH_BTN.r * DASH_BTN.r) { toggleDash(); return }
    joy.on = true; joy.ox = joy.x = p.x; joy.oy = joy.y = p.y
  }, { passive: false })
  cv.addEventListener('touchmove', (e) => { e.preventDefault(); if (!joy.on) return; const p = pd(e); joy.x = p.x; joy.y = p.y; setTargetFromJoy() }, { passive: false })
  cv.addEventListener('touchend', (e) => { e.preventDefault(); joy.on = false; const t = Date.now(); if (t - lastTap < 280) toggleDash(); lastTap = t }, { passive: false })
  cv.addEventListener('mousedown', (e) => { const p = pd(e); if ((p.x - DASH_BTN.x) ** 2 + (p.y - DASH_BTN.y) ** 2 < DASH_BTN.r * DASH_BTN.r) { toggleDash(); return } joy.on = true; joy.ox = joy.x = p.x; joy.oy = joy.y = p.y })
  cv.addEventListener('mousemove', (e) => { if (!joy.on) return; const p = pd(e); joy.x = p.x; joy.y = p.y; setTargetFromJoy() })
  cv.addEventListener('mouseup', () => { joy.on = false })
  function toggleDash() { S.dashOn = !S.dashOn; sfx.play(S.dashOn ? 'dashOn' : 'dashOff', '') }
  /** 输入上行 10Hz（a 恒带=持续态心跳兼保活；dash 变才带，§3.1） */
  function sendInput() {
    if (!S.conn || S.conn.readyState !== 1 || S.seat < 0) return
    const me = S.ents.get('s' + S.seat)
    const a = S.target == null ? (me ? me.a : 0) : Math.round(S.target)
    const msg = { t: 'input', frame: S.seq++, keys: { a } }
    if (S.dashOn !== S.sentDash) { msg.keys.dash = S.dashOn ? 1 : 0; S.sentDash = S.dashOn }
    else if (me && me.b) msg.keys.dash = 1
    S.conn.send(JSON.stringify(msg))
  }
  setInterval(() => sendInput(), 100)

  /* =====================================================================
   * 本地预测 + 插值（§3.1/§5.4）
   * ===================================================================== */
  let simAcc = 0
  function stepLocal(dtMs) {
    const meRec = S.ents.get('s' + S.seat)
    if (S.mode === 'playing' && meRec && !S.dead) {
      /* 自身：本地转向预测（两端同式积分；不等服务器） */
      const w = Math.max(1, Math.round(K.wOf(meRec.M) * (meRec.b ? 0.8 : 1)))
      const v = K.vOf(meRec.M) * (meRec.b ? 1.6 : 1)
      const ta = S.target == null ? meRec.a : S.target
      meRec.a = K.stepTurn(meRec.a, ta, w)
      meRec.x += Math.cos(meRec.a * Math.PI / 180) * v * dtMs / 100
      meRec.y += Math.sin(meRec.a * Math.PI / 180) * v * dtMs / 100
      meRec.x = Math.max(8000, Math.min(K.W - 8000, meRec.x))
      meRec.y = Math.max(8000, Math.min(K.H - 8000, meRec.y))
    }
    for (const rec of S.ents.values()) {
      if (rec.k !== 'fish' || rec.gone || rec === meRec) continue
      /* 他人：120ms 插值（两样本 lerp）+ 迟到外推 1 张仅呈现 */
      const smp = rec.smp || []
      if (smp.length >= 2) {
        const tR = smp[smp.length - 1].t - 120
        let a0 = smp[0], a1 = smp[1]
        for (let i = 1; i < smp.length; i++) if (smp[i].t >= tR) { a0 = smp[i - 1]; a1 = smp[i]; break }
        const span = Math.max(1, a1.t - a0.t)
        let f = (tR - a0.t) / span
        f = Math.max(-1, Math.min(1, f))
        rec.x = a0.x + (a1.x - a0.x) * f
        rec.y = a0.y + (a1.y - a0.y) * f
        const da = ((a1.a - a0.a % 360 + 540) % 360) - 180
        rec.a = (a0.a + da * f + 360) % 360
      }
    }
    /* 和解：自身预测 vs 权威（角度 ≤30° 平滑 20%/帧） */
    if (meRec && meRec.smp && meRec.smp.length && !S.dead) {
      const auth = meRec.smp[meRec.smp.length - 1]
      const dx = auth.x - meRec.x, dy = auth.y - meRec.y
      const d = Math.hypot(dx, dy)
      if (d > 34000) { meRec.x = auth.x; meRec.y = auth.y }
      else if (d > 1000) { meRec.x += dx * 0.2; meRec.y += dy * 0.2 }
      const da = Math.abs(K.angDiff(meRec.a, auth.a))
      if (da > 30) meRec.a += K.angDiff(meRec.a, auth.a) * 0.1
      else meRec.a += K.angDiff(meRec.a, auth.a) * 0.2
    }
  }

  /* =====================================================================
   * 渲染（§5.6 预算：8-16 变形 sprite ≈2.2-3.4ms + 光点合批 ≈0.5ms）
   * ===================================================================== */
  function w2s(x, y) { return { x: (x / 1000 - cam.x / 1000) * cam.zoom + W / 2, y: (y / 1000 - cam.y / 1000) * cam.zoom + H / 2 } }
  function crowdFadeOf(d) { return d < 600000 ? 1 : d < 900000 ? 0.78 : 0.6 }
  function render(dt) {
    const meRec = S.ents.get('s' + S.seat)
    let sinkY = 0
    /* 镜头锁自身平滑（§3.2：临界阻尼 + 档位 zoom 阶梯 lerp 0.04；死亡拉远 0.15） */
    const anchor = S.mode === 'debug' ? S.ents.get('s0') : (meRec || null)
    if (anchor) {
      const w = 2 / 130, dms = Math.min(dt, 50)
      cam.vx += (-(w * w) * (cam.x - anchor.x) - 2 * w * cam.vx) * dms
      cam.vy += (-(w * w) * (cam.y - anchor.y) - 2 * w * cam.vy) * dms
      cam.x += cam.vx * dms; cam.y += cam.vy * dms
      const zt = K.zoomOf(anchor.t || 0) * (S.dead ? 0.85 : 1)
      cam.zTarget += (zt - cam.zTarget) * 0.04
    }
    cam.zoom = cam.zTarget * (1 + 0.05 * S.zoomPulse)
    if (S.zoomPulse > 0.01) S.zoomPulse *= 0.86; else S.zoomPulse = 0
    if (S.enterT0 && now - S.enterT0 < 420) {
      const e = (now - S.enterT0) / 420
      const eo = 1 - Math.pow(1 - e, 3)
      cam.zoom *= 0.8 + 0.2 * eo
      sinkY = -70 * (1 - eo) // 开场下沉入场（F16：世界自上而下沉落 420ms）
      fxDraw('F16')
    }
    /* 震动（渲染期偏移，§3.2） */
    let shx = 0, shy = 0
    if (S.shakeT > 0) {
      S.shakeT -= 16
      const amp = S.shakes * (S.shakeT / 400)
      shx = (Math.random() * 2 - 1) * amp; shy = (Math.random() * 2 - 1) * amp
    }
    /* 天敌逼近侦测（F05 惊红闪+danger 低频警示——fx 层只读消费实体态；
     * 判据与敌我环同源：orR×4 ≥ myR×5 即可吞我者） */
    let threat = false
    if (meRec && !S.dead) {
      const myR = K.rOf(meRec.M)
      for (const rec of S.ents.values()) {
        if (rec.k !== 'fish' || rec === meRec || rec.gone || rec.d) continue
        if (K.rOf(rec.M) * 4 >= myR * 5 && Math.hypot(rec.x - meRec.x, rec.y - meRec.y) < 650000) { threat = true; break }
      }
    }
    if (threat && !S.threatNear) { S.panicUntil = Math.max(S.panicUntil, now + 600); fxTrig('F05'); sfx.play('danger', '') }
    S.threatNear = threat
    /* 背景：军绿纵向渐变 + 三光带分层（§2.1/§7 同源） */
    const grd = g.createLinearGradient(0, 0, 0, H)
    grd.addColorStop(0, BG_TOP); grd.addColorStop(1, BG_MID)
    g.fillStyle = grd
    g.fillRect(0, 0, W, H)
    g.save()
    g.translate(shx, shy + sinkY)
    const band = (yW, hW, col) => { // 世界带映射到屏幕（镜头相关）
      const p0 = w2s(0, yW), p1 = w2s(0, yW + hW)
      const y0 = Math.max(-4, p0.y), y1 = Math.min(H + 4, p1.y)
      if (y1 > y0) { g.fillStyle = col; g.fillRect(0, y0, W, y1 - y0) }
    }
    band(0, 900000, BAND_LIT)            // 光照带（荧藻富集）
    band(1350000, 450000, BAND_DARK)     // 深渊带（晶簇+暗）
    /* 尘埃氛围层（§7） */
    g.fillStyle = 'rgba(127,232,216,.10)'
    for (const d of DUST) {
      d.y += d.v * dt / 1000; if (d.y > K.H) { d.y = 0; d.x = Math.random() * K.W }
      const s = w2s(d.x, d.y)
      if (s.x > -4 && s.x < W + 4 && s.y > -4 && s.y < H + 4) g.fillRect(s.x, s.y, 2, 2)
    }
    /* 缓流墙：四边呼吸光（§2.1 边界带 24px 发光渲染） */
    const tl = w2s(0, 0), br = w2s(K.W, K.H)
    g.strokeStyle = WALL_COL.replace('.32', '.' + (22 + Math.round(14 * Math.sin(now / 600))) + ')')
    g.lineWidth = 3
    g.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
    /* AOI 视野圈呼吸（F08：档即视野 §2.4——±2% 呼吸+透明度脉动，机制面外显） */
    if (meRec && !S.dead) {
      const ms0 = w2s(meRec.x, meRec.y)
      const breathe = 1 + 0.02 * Math.sin(now / 700)
      g.globalAlpha = 0.12 + 0.05 * Math.sin(now / 700)
      g.strokeStyle = '#7FE8D8'; g.lineWidth = 1.5
      g.beginPath(); g.arc(ms0.x, ms0.y, K.aoiR(meRec.t || 0) / 1000 * breathe * cam.zoom, 0, Math.PI * 2); g.stroke()
      g.globalAlpha = 1
      fxDraw('F08')
    }

    const lod = cam.zoom >= 0.9 ? 2 : cam.zoom >= 0.8 ? 1 : 0 // LOD：2=全细节/1=去尾迹/0=远端淡化
    /* 光点 sprite 两批合批（静态位/瞬态），视口 AABB 裁剪（§5.4） */
    const pulse = 1 + 0.18 * Math.sin(now / 240)
    for (const rec of S.ents.values()) {
      if (rec.k === 'fish' || rec.gone) continue
      if (!rec.on && rec.k !== 'drop') continue
      /* 食物浮游感（F07）：bob 起伏（位相按坐标散列）+晶簇闪烁（pulse 共存） */
      const bob = Math.sin(now / 520 + ((rec.x / 97000 + rec.y / 88000) % 6.28)) * 1400
      const s = w2s(rec.x, rec.y + bob)
      const r = (rec.k === 'cry' ? 8 * pulse : rec.v >= 2 ? 7 : 6) * cam.zoom
      if (s.x < -16 || s.y < -16 || s.x > W + 16 || s.y > H + 16) continue
      const spr = rec.k === 'drop' ? SPRITES[rec.v >= 2 ? 'drop' : 'dash'] : SPRITES[rec.k]
      g.drawImage(spr, s.x - r, s.y - r, r * 2, r * 2)
      fxDraw('F07')
    }
    /* 鱼：四档形色双编码（§7 形状通道）+ 皮肤纹样 + 敌我环（§7 一屏可读） */
    for (const rec of S.ents.values()) {
      if (rec.k !== 'fish') continue
      if (rec.gone) { rec.fade -= 0.08; if (rec.fade <= 0) { S.ents.delete(rec.id); continue } }
      if (rec.d) continue
      const s = w2s(rec.x, rec.y)
      const rPx = K.rOf(rec.M) * cam.zoom
      if (s.x < -rPx - 60 || s.y < -rPx - 60 || s.x > W + rPx + 60 || s.y > H + rPx + 60) continue
      const tier = rec.t || 0
      const isKing = S.round.k === rec.seat
      const crowdFade = (meRec && rec !== meRec && !isKing) ? crowdFadeOf(Math.hypot(rec.x - meRec.x, rec.y - meRec.y)) : 1
      const flicker = rec.p > 0 && Math.floor(now / 100) % 2 === 0
      g.globalAlpha = (rec.fade === undefined ? 1 : rec.fade) * (flicker ? 0.45 : 1) * crowdFade
      drawFish(s.x, s.y, rPx, rec.a, tier, SKIN[rec.skin] || SKIN[0], rec, isKing, lod, crowdFade)
      /* 敌我关系环（§7：可吞=绿细描边环、威胁=红边缘光晕——K=1.25 判据渲染镜像） */
      if (meRec && rec !== meRec && lod >= 1) {
        const myR = K.rOf(meRec.M), orR = K.rOf(rec.M)
        if (myR * 4 >= orR * 5 && rec.p === 0) { // 可吞目标（F10 猎物高亮描边）
          g.strokeStyle = 'rgba(61,220,132,.55)'; g.lineWidth = 1.5 * cam.zoom
          g.beginPath(); g.arc(s.x, s.y, rPx + 4 * cam.zoom, 0, Math.PI * 2); g.stroke()
          fxDraw('F10')
        } else if (orR * 4 >= myR * 5) { // 威胁（可吞我者，F11 天敌红名警示）
          g.strokeStyle = 'rgba(255,60,40,' + (0.30 + 0.15 * Math.sin(now / 160)).toFixed(3) + ')'
          g.lineWidth = 3 * cam.zoom
          g.beginPath(); g.arc(s.x, s.y, rPx + 5 * cam.zoom, 0, Math.PI * 2); g.stroke()
          g.font = HF('P2', 'pred-name', 9)
          g.fillStyle = 'rgba(255,80,60,.9)'
          g.textAlign = 'center'
          g.fillText('天敌', s.x, s.y - rPx - 8)
          g.textAlign = 'left'
          fxDraw('F11')
        }
      }
      if (rec === meRec && lod >= 1) { // 自身腹鳍标（§7 个体层）
        g.fillStyle = '#FFFFFF'
        const pa = rec.a * Math.PI / 180
        g.beginPath(); g.arc(s.x - Math.cos(pa) * rPx * 0.2, s.y - Math.sin(pa) * rPx * 0.2, 2.2 * cam.zoom, 0, Math.PI * 2); g.fill()
      }
      g.globalAlpha = 1
      if (rec.b && lod >= 1 && Math.random() < 0.5) { // dash 尾迹气泡串（F04：加速尾迹+质量流失气泡，§3.3）
        const pa = rec.a * Math.PI / 180
        spawnParts(rec.x - Math.cos(pa) * rPx * 1200, rec.y - Math.sin(pa) * rPx * 1200, '#FFE9B8', 1)
        fxDraw('F04')
        if (rec === meRec && now - S.lastBubble > 280) { S.lastBubble = now; sfx.play('bubble', '') } // 水泡串音（节流）
      }
    }
    /* 吞噬张嘴+吸入拉丝（F01，signature 240ms：受害者残影向嘴点收缩拉丝+我口扩张环） */
    if (S.gulp) {
      const gt = (now - S.gulp.t0) / S.gulp.dur
      if (gt >= 1) S.gulp = null
      else if (meRec) {
        const mAng = meRec.a * Math.PI / 180, mr = K.rOf(meRec.M) * 1000
        const mouthX = meRec.x + Math.cos(mAng) * mr * 0.8, mouthY = meRec.y + Math.sin(mAng) * mr * 0.8
        const ang = Math.atan2(mouthY - S.gulp.y, mouthX - S.gulp.x)
        for (let i = 0; i < 3; i++) { // 三段残影椭圆：越近嘴越扁长（拉丝）
          const ft = Math.max(0, Math.min(1, gt - i * 0.14))
          const x = S.gulp.x + (mouthX - S.gulp.x) * ft, y = S.gulp.y + (mouthY - S.gulp.y) * ft
          const s = w2s(x, y)
          g.globalAlpha = (1 - ft) * 0.75
          g.fillStyle = '#FFB65C'
          g.beginPath(); g.ellipse(s.x, s.y, (11 - i * 3) * (1 + ft) * cam.zoom, (7 - i * 2) * (1 - ft * 0.6) * cam.zoom, ang, 0, Math.PI * 2); g.fill()
        }
        const ms = w2s(mouthX, mouthY) // 张嘴：嘴点扩张金环
        g.globalAlpha = 0.9 - gt * 0.5
        g.strokeStyle = '#FFD700'; g.lineWidth = 2
        g.beginPath(); g.arc(ms.x, ms.y, (4 + 8 * gt) * cam.zoom, 0, Math.PI * 2); g.stroke()
        g.globalAlpha = 1
        fxDraw('F01')
      }
    }
    /* 死亡掉落散布（F06：n=drops 扇面+重力坠流 420ms——「化作 N 光点」物证） */
    if (S.scatters.length) {
      S.scatters = S.scatters.filter((sc) => now - sc.t0 < 420)
      for (const sc of S.scatters) {
        const st = (now - sc.t0) / 420
        for (let i = 0; i < sc.n; i++) {
          const a2 = (i * 137.5) * Math.PI / 180
          const dist = (16 + (i % 5) * 13) * st * 1000
          const s = w2s(sc.x + Math.cos(a2) * dist, sc.y + Math.sin(a2) * dist + 32 * st * st * 1000)
          g.globalAlpha = 1 - st
          g.fillStyle = RES_COL.drop
          g.fillRect(s.x - 2, s.y - 2, 4, 4)
        }
        g.globalAlpha = 1
        fxDraw('F06')
      }
    }
    /* 升档爆发光圈（F02：双环爆发 480ms） */
    if (S.tierBurst) {
      const tt = (now - S.tierBurst.t0) / 480
      if (tt >= 1) S.tierBurst = null
      else if (meRec) {
        const s = w2s(meRec.x, meRec.y)
        const baseR = K.rOf(meRec.M) * cam.zoom
        for (let i = 0; i < 2; i++) {
          const rt = Math.max(0, tt - i * 0.22)
          g.globalAlpha = (1 - rt) * 0.8
          g.strokeStyle = i ? '#7FE8D8' : '#FFD700'; g.lineWidth = (4 - 3 * rt) * cam.zoom
          g.beginPath(); g.arc(s.x, s.y, baseR + rt * 60 * cam.zoom + i * 10, 0, Math.PI * 2); g.stroke()
        }
        g.globalAlpha = 1
        fxDraw('F02')
      }
    }
    /* 鲸级登场震屏波纹（F13：沧鲸降世双环涟漪 900ms，震屏在事件位） */
    if (S.whale) {
      const wt = (now - S.whale.t0) / 900
      if (wt >= 1) S.whale = null
      else {
        const s = w2s(S.whale.x, S.whale.y)
        for (let i = 0; i < 2; i++) {
          const rt = wt - i * 0.25
          if (rt <= 0) continue
          g.globalAlpha = (1 - rt) * 0.5
          g.strokeStyle = '#3D5A80'; g.lineWidth = 3
          g.beginPath(); g.arc(s.x, s.y, (20 + rt * 150) * cam.zoom + i * 14, 0, Math.PI * 2); g.stroke()
        }
        g.globalAlpha = 1
        fxDraw('F13')
      }
    }
    /* 连吃 combo 计数弹跳（F12：+N×n 三段弹跳上飘 800ms） */
    if (S.combo && meRec && now - S.combo.t0 < 800) {
      const ct = (now - S.combo.t0) / 800
      const s = w2s(meRec.x, meRec.y - K.rOf(meRec.M) * 1300 - 2000)
      const bounce = Math.abs(Math.sin(ct * Math.PI * 3)) * (1 - ct) * 6
      g.globalAlpha = 1 - ct * ct
      g.fillStyle = '#7FE8D8'
      g.font = HF('P0', 'combo', 14, 700)
      g.textAlign = 'center'
      g.fillText('+' + S.combo.v + (S.combo.n >= 2 ? ' ×' + S.combo.n : ''), s.x, s.y - ct * 22 - bounce)
      g.textAlign = 'left'
      g.globalAlpha = 1
      fxDraw('F12')
    }
    /* 粒子 */
    for (const p of PPOOL) {
      if (!p.live) continue
      const t = (now - p.t0) / p.dur
      if (t >= 1) { p.live = false; continue }
      const s = w2s(p.x + p.vx * t, p.y + p.vy * t)
      g.globalAlpha = 1 - t
      g.fillStyle = p.c
      g.fillRect(s.x - 2, s.y - 2, 4, 4)
      g.globalAlpha = 1
    }
    /* 光波冲击圈（吃食/吞噬） */
    S.rings = S.rings.filter((r) => now - r.t0 < r.dur)
    for (const r of S.rings) {
      const t = (now - r.t0) / r.dur
      const s = w2s(r.x, r.y)
      g.globalAlpha = (1 - t) * 0.55
      g.strokeStyle = r.col; g.lineWidth = 2
      g.beginPath(); g.arc(s.x, s.y, ((r.big ? 10 : 6) + t * (r.big ? 46 : 24)) * cam.zoom, 0, Math.PI * 2); g.stroke()
      g.globalAlpha = 1
    }
    /* 里程碑/加冕闪光 */
    if (S.flash > 0.02) {
      g.globalAlpha = S.flash * 0.22
      g.fillStyle = S.flashC
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
      S.flash *= 0.88
    }
    /* 入场揭幕 */
    if (S.enterT0 && now - S.enterT0 < 420) {
      const e = (now - S.enterT0) / 420
      g.fillStyle = 'rgba(4,9,6,' + (0.85 * (1 - e)).toFixed(3) + ')'
      g.fillRect(0, 0, W, H)
    }
    g.restore()
    /* 被捕惊红闪（F05：天敌逼近/被吞——四边红脉冲 vignette，纯呈现层） */
    if (S.panicUntil > now) {
      const p = 0.35 + 0.25 * Math.sin(now / 90)
      g.fillStyle = 'rgba(255,60,40,' + (p * 0.3).toFixed(3) + ')'
      g.fillRect(0, 0, W, 10); g.fillRect(0, H - 10, W, 10)
      g.fillRect(0, 0, 10, H); g.fillRect(W - 10, 0, 10, H)
      fxDraw('F05')
    }
    drawHUD(meRec)
  }
  /* 鱼体绘制：四档轮廓形（形状通道，§7）——T0 圆卵/T1 梭形/T2 三角鳍/T3 宽巨 */
  function drawFish(x, y, r, a, tier, skin, rec, isKing, lod, crowdFade) {
    const rad = a * Math.PI / 180
    const wag = Math.sin(now / 120 + (rec.x % 100) / 8) * 0.35 // 尾摆相位（游速驱动近似）
    g.save()
    g.translate(x, y)
    g.rotate(rad)
    const body = TIER_COL[tier]
    const outline = 'rgba(4,10,8,.85)'
    const paint = (path, col, stroke, lw) => {
      path()
      if (col) { g.fillStyle = col; g.fill() }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1.5 * cam.zoom; g.stroke() }
    }
    if (tier === 0) { // 圆卵形（无尾鳍分化）
      g.beginPath(); g.ellipse(0, 0, r * 1.15, r * 0.95, 0, 0, Math.PI * 2)
      g.fillStyle = outline; g.fill()
      g.beginPath(); g.ellipse(0, 0, r * 1.0, r * 0.82, 0, 0, Math.PI * 2)
      g.fillStyle = body; g.fill()
    } else if (tier === 1) { // 梭形（纺锤+小尾鳍）
      if (lod >= 1) { // 尾鳍
        g.save(); g.rotate(Math.PI + wag)
        g.beginPath(); g.moveTo(-r * 0.8, 0); g.lineTo(-r * 1.5, -r * 0.45); g.lineTo(-r * 1.5, r * 0.45); g.closePath()
        g.fillStyle = body; g.globalAlpha *= 0.85; g.fill(); g.restore()
      }
      g.beginPath()
      g.moveTo(r * 1.2, 0)
      g.quadraticCurveTo(r * 0.3, -r * 0.8, -r * 1.0, -r * 0.28)
      g.quadraticCurveTo(-r * 1.25, 0, -r * 1.0, r * 0.28)
      g.quadraticCurveTo(r * 0.3, r * 0.8, r * 1.2, 0)
      g.fillStyle = outline; g.fill()
      g.beginPath()
      g.moveTo(r * 1.05, 0)
      g.quadraticCurveTo(r * 0.25, -r * 0.62, -r * 0.85, -r * 0.2)
      g.quadraticCurveTo(-r * 1.05, 0, -r * 0.85, r * 0.2)
      g.quadraticCurveTo(r * 0.25, r * 0.62, r * 1.05, 0)
      g.fillStyle = body; g.fill()
    } else if (tier === 2) { // 三角鳍形（背鳍+长体）
      if (lod >= 1) { // 背鳍
        g.beginPath(); g.moveTo(-r * 0.1, -r * 0.55); g.lineTo(r * 0.35, -r * 1.35); g.lineTo(r * 0.55, -r * 0.5); g.closePath()
        g.fillStyle = body; g.globalAlpha *= 0.9; g.fill(); g.globalAlpha /= 0.9
      }
      g.save(); g.rotate(Math.PI + wag)
      g.beginPath(); g.moveTo(-r * 0.9, 0); g.lineTo(-r * 1.8, -r * 0.5); g.lineTo(-r * 1.65, r * 0.1); g.lineTo(-r * 1.8, r * 0.5); g.closePath()
      g.fillStyle = body; g.globalAlpha *= 0.85; g.fill(); g.restore()
      g.beginPath()
      g.moveTo(r * 1.35, 0)
      g.quadraticCurveTo(r * 0.2, -r * 0.72, -r * 1.1, -r * 0.3)
      g.quadraticCurveTo(-r * 1.35, 0, -r * 1.1, r * 0.3)
      g.quadraticCurveTo(r * 0.2, r * 0.72, r * 1.35, 0)
      g.fillStyle = outline; g.fill()
      g.beginPath()
      g.moveTo(r * 1.2, 0)
      g.quadraticCurveTo(r * 0.15, -r * 0.55, -r * 0.95, -r * 0.22)
      g.quadraticCurveTo(-r * 1.15, 0, -r * 0.95, r * 0.22)
      g.quadraticCurveTo(r * 0.15, r * 0.55, r * 1.2, 0)
      g.fillStyle = body; g.fill()
    } else { // T3 宽巨形（巨口+宽尾）+金描边（§7）
      g.save(); g.rotate(Math.PI + wag * 0.6)
      g.beginPath(); g.moveTo(-r * 0.85, 0); g.lineTo(-r * 1.7, -r * 0.75); g.lineTo(-r * 1.45, 0); g.lineTo(-r * 1.7, r * 0.75); g.closePath()
      g.fillStyle = body; g.globalAlpha *= 0.85; g.fill(); g.restore()
      g.beginPath()
      g.moveTo(r * 1.3, 0)
      g.quadraticCurveTo(r * 0.1, -r * 0.95, -r * 0.95, -r * 0.42)
      g.quadraticCurveTo(-r * 1.25, 0, -r * 0.95, r * 0.42)
      g.quadraticCurveTo(r * 0.1, r * 0.95, r * 1.3, 0)
      g.fillStyle = outline; g.fill()
      g.beginPath()
      g.moveTo(r * 1.15, 0)
      g.quadraticCurveTo(r * 0.05, -r * 0.75, -r * 0.8, -r * 0.32)
      g.quadraticCurveTo(-r * 1.02, 0, -r * 0.8, r * 0.32)
      g.quadraticCurveTo(r * 0.05, r * 0.75, r * 1.15, 0)
      g.fillStyle = body; g.fill()
      g.strokeStyle = '#FFD700'; g.lineWidth = 1.8 * cam.zoom // 金描边（apex 外显）
      g.beginPath()
      g.moveTo(r * 1.15, 0)
      g.quadraticCurveTo(r * 0.05, -r * 0.75, -r * 0.8, -r * 0.32)
      g.quadraticCurveTo(-r * 1.02, 0, -r * 0.8, r * 0.32)
      g.quadraticCurveTo(r * 0.05, r * 0.75, r * 1.15, 0)
      g.stroke()
      g.strokeStyle = 'rgba(4,10,8,.9)'; g.lineWidth = 1.2 * cam.zoom // 巨口线
      g.beginPath(); g.moveTo(r * 1.1, -r * 0.3); g.quadraticCurveTo(r * 0.7, 0, r * 1.1, r * 0.3); g.stroke()
    }
    /* 皮肤纹样（个体层，§2.6——档内识别；远场淡化档跳过） */
    if (crowdFade === 1 && lod >= 1 && r > 7) {
      g.fillStyle = 'rgba(255,255,255,.20)'
      if (skin.pat === 'ring') {
        for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(i * r * 0.5, 0, r * 0.16, 0, Math.PI * 2); g.fill() }
      } else if (skin.pat === 'dia') {
        for (let i = -1; i <= 1; i++) { g.beginPath(); g.moveTo(i * r * 0.55, -r * 0.22); g.lineTo(i * r * 0.55 + r * 0.18, 0); g.lineTo(i * r * 0.55, r * 0.22); g.lineTo(i * r * 0.55 - r * 0.18, 0); g.closePath(); g.fill() }
      } else if (skin.pat === 'stripe') {
        for (let i = -1; i <= 1; i++) g.fillRect(i * r * 0.55 - r * 0.08, -r * 0.45, r * 0.16, r * 0.9)
      } else {
        const gg = g.createLinearGradient(r, 0, -r, 0)
        gg.addColorStop(0, 'rgba(255,255,255,.3)'); gg.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = gg
        g.beginPath(); g.ellipse(0, 0, r * 0.9, r * 0.5, 0, 0, Math.PI * 2); g.fill()
      }
    }
    /* 头饰（§2.6）+ 海王金冠 */
    if (isKing || skin.hat === 'crown') drawCrownLocal(0, -r * 1.05, 5 * Math.max(0.8, cam.zoom))
    else if (skin.hat === 'horn' && lod >= 1) {
      g.strokeStyle = '#FFD98E'; g.lineWidth = 1.4 * cam.zoom
      g.beginPath(); g.moveTo(r * 0.3, -r * 0.5); g.lineTo(r * 0.5, -r * 0.95); g.moveTo(r * 0.55, -r * 0.35); g.lineTo(r * 0.8, -r * 0.7); g.stroke()
    } else if (skin.hat === 'fin' && lod >= 1) {
      g.fillStyle = 'rgba(255,255,255,.35)'
      g.beginPath(); g.moveTo(r * 0.4, -r * 0.4); g.lineTo(r * 0.55, -r * 0.85); g.lineTo(r * 0.7, -r * 0.35); g.closePath(); g.fill()
    }
    /* 眼（朝向） */
    if (r > 5) {
      for (const side of [-1, 1]) {
        g.beginPath(); g.arc(r * 0.55, side * r * 0.3, r * 0.14, 0, Math.PI * 2)
        g.fillStyle = '#061410'; g.fill()
      }
    }
    /* 吃食弹跳（F14 同款：140ms 缩放 1→1.3→1） */
    if (rec.pop > 0.02) { rec.pop *= 0.86 } else rec.pop = 0
    g.restore()
    if (rec.pop > 0.02) {
      g.save(); g.translate(x, y); g.scale(1 + 0.3 * rec.pop, 1 + 0.3 * rec.pop); g.restore()
    }
  }
  function drawCrownLocal(x, y, r) {
    g.save(); g.translate(x, y)
    g.beginPath()
    g.moveTo(-r, r * 0.6); g.lineTo(-r, -r * 0.4); g.lineTo(-r * 0.45, r * 0.1)
    g.lineTo(0, -r); g.lineTo(r * 0.45, r * 0.1); g.lineTo(r, -r * 0.4); g.lineTo(r, r * 0.6)
    g.closePath()
    g.fillStyle = '#FFD700'; g.fill()
    g.strokeStyle = '#B8860B'; g.lineWidth = 1; g.stroke()
    g.restore()
  }

  /* ---------- HUD（§7：顶栏/小地图/排行榜/dash 钮/页脚；HF 登记表+__applied） ---------- */
  let lbOpen = false
  function drawHUD(meRec) {
    g.fillStyle = 'rgba(5,12,9,.72)'
    g.fillRect(0, 0, W, TOP_H)
    /* 定档滞回提示（F03：距下一档进度条——>85% 金色呼吸；M 贴近降档滞回带
     * （lo×1.05 内，§2.4 −5% 防抖带）左端红脉冲警示） */
    if (meRec) {
      const tT = meRec.t || 0, tier = K.TIERS[tT]
      const hi = tT < 3 ? K.TIERS[tT + 1].lo : K.M_CAP
      const prog = Math.max(0, Math.min(1, (meRec.M - tier.lo) / (hi - tier.lo)))
      const yq = TOP_H - 5
      g.fillStyle = 'rgba(127,232,216,.14)'; g.fillRect(12, yq, W - 24, 3)
      g.fillStyle = prog > 0.85 ? '#FFD166' : 'rgba(127,232,216,.6)'
      g.fillRect(12, yq, (W - 24) * prog, 3)
      if (meRec.M < tier.lo * 1.05) {
        g.fillStyle = 'rgba(255,60,40,' + (0.4 + 0.3 * Math.sin(now / 120)).toFixed(3) + ')'
        g.fillRect(12, yq, 10, 3)
      }
      fxDraw('F03')
    }
    const M = meRec ? meRec.M : 0, k2 = meRec ? meRec.k2 : 0
    g.fillStyle = INK
    g.font = HF('P0', 'mass', 15, 600)
    g.fillText('质 ' + M, 12, 24)
    g.font = HF('P0', 'kills', 13, 600)
    g.fillText('吞 ' + k2, 76, 24)
    const remS = Math.ceil(S.round.rem * 100 / 1000)
    g.fillStyle = remS <= 10 ? '#FF6B5C' : INK
    g.font = HF('P0', 'round', 13, 600)
    g.fillText('第' + S.round.n + '轮 ' + String(Math.floor(remS / 60)).padStart(1, '0') + ':' + String(remS % 60).padStart(2, '0'), 132, 24)
    g.fillStyle = DIM
    g.font = HF('P2', 'ping', 11)
    g.fillText(S.ping ? S.ping + 'ms' : '—', W - 44, 24)
    g.font = HF('P0', 'score', 13, 600)
    g.fillStyle = '#FFD98E'
    g.fillText('分 ' + (meRec ? meRec.sc : 0), 12, 46)
    g.font = HF('P1', 'tier', 11, 600)
    g.fillStyle = TIER_COL[meRec ? (meRec.t || 0) : 0]
    g.fillText((meRec ? TIER_NAME[meRec.t || 0] : '—') + ' · ' + (meRec ? K.rOf(meRec.M) : 8) + 'px', 76, 46)
    if (S.eatStreak >= 5 && now - S.eatT < 2000) {
      g.fillStyle = '#7FE8D8'
      g.font = HF('P1', 'streak', 11, 600)
      g.fillText('连食×' + S.eatStreak, 176, 46)
    }
    /* 右上小地图 Ø96：全房密度点（§7 巨房卖点 HUD 内显——T6-A 双落点之二） */
    const mm = { x: W - 56, y: TOP_H + 56, r: 46 }
    g.save()
    g.beginPath(); g.arc(mm.x, mm.y, mm.r, 0, Math.PI * 2)
    g.fillStyle = 'rgba(6,14,10,.8)'; g.fill()
    g.strokeStyle = 'rgba(127,232,216,.3)'; g.lineWidth = 1.5; g.stroke()
    g.clip()
    g.fillStyle = 'rgba(255,215,0,.18)' // 晶簇带标（深渊带）
    g.fillRect(mm.x - mm.r, mm.y + mm.r * 0.25, mm.r * 2, mm.r * 0.75)
    if (S.bloom >= 0) { // 鱼汛潮象限脉冲（§2.2/§7）
      const bx = S.bloom % 2 === 0 ? mm.x - mm.r : mm.x
      const by = S.bloom < 2 ? mm.y - mm.r : mm.y
      const a = 0.16 + 0.12 * Math.sin(now / 160)
      g.fillStyle = 'rgba(201,143,232,' + a.toFixed(3) + ')'
      g.fillRect(bx, by, mm.r, mm.r)
    }
    for (const d of S.mm) {
      const mx = mm.x + (d[1] - WORLD / 2) * (mm.r * 2 / WORLD) * 0.92
      const my = mm.y + (d[2] - WORLD / 2) * (mm.r * 2 / WORLD) * 0.92
      g.beginPath(); g.arc(mx, my, d[0] === S.seat ? 3 : Math.max(1.4, Math.min(2.8, K.rOf(d[3]) / 8)), 0, Math.PI * 2)
      g.fillStyle = d[0] === S.seat ? '#FFD700' : 'rgba(143,232,216,.75)'; g.fill()
    }
    g.restore()
    /* 左侧排行榜 top5（tap 展开 top10，§7） */
    const rows = (S.lb || []).slice(0, lbOpen ? 10 : 5)
    g.font = HF('P1', 'lb-title', 11, 600)
    g.fillStyle = DIM
    g.fillText('海王榜', 12, TOP_H + 18)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const y = TOP_H + 34 + i * 17
      const seatRec = S.roster.find((x) => x.seat === r.seat)
      g.font = HF('P0', 'lb-score', 13, 600)
      g.fillStyle = r.seat === S.seat ? '#FFD98E' : INK
      g.fillText(String(i + 1) + '.', 12, y)
      g.font = HF('P1', 'lb-name', 11)
      g.fillStyle = r.seat === S.seat ? '#FFD98E' : DIM
      g.fillText((((seatRec && seatRec.name) || '鱼' + r.seat) + ' ·' + r.M).slice(0, 9), 30, y)
      g.font = HF('P0', 'lb-score', 13, 600)
      g.fillStyle = r.seat === S.seat ? '#FFD98E' : INK
      g.fillText(String(r.score), 104, y)
      /* 变动差值标（F09：▲/▼ 900ms 淡出——快照 score 逐席对账驱动） */
      const dlt = S.lbDeltas && S.lbDeltas[r.seat]
      if (dlt && now - dlt.t0 < 900) {
        const up = dlt.d > 0
        g.globalAlpha = Math.max(0, 1 - (now - dlt.t0) / 900)
        g.fillStyle = up ? '#7FE8D8' : '#FF6B5C'
        g.font = HF('P1', 'lb-delta', 11, 600)
        g.fillText((up ? '▲' + dlt.d : '▼' + (-dlt.d)), 160, y)
        g.globalAlpha = 1
        fxDraw('F09')
      }
    }
    /* 右下 dash 钮 Ø64（M≥30 点亮，§1.5） */
    const lit = (meRec && meRec.M >= 30 && S.dashOn) || (meRec && meRec.b)
    g.beginPath(); g.arc(DASH_BTN.x, DASH_BTN.y, DASH_BTN.r, 0, Math.PI * 2)
    g.fillStyle = lit ? 'rgba(255,182,92,.85)' : 'rgba(20,40,30,.72)'
    g.fill()
    g.strokeStyle = meRec && meRec.M >= 30 ? '#FFB65C' : 'rgba(139,147,167,.4)'
    g.lineWidth = 2; g.stroke()
    g.fillStyle = lit ? '#1A0E04' : DIM
    g.font = HF('P1', 'dash', 12, 600)
    g.textAlign = 'center'
    g.fillText('冲刺', DASH_BTN.x, DASH_BTN.y + 4)
    g.textAlign = 'left'
    /* 浮动摇杆（§1.5） */
    if (joy.on) {
      g.beginPath(); g.arc(joy.ox, joy.oy, 34, 0, Math.PI * 2)
      g.strokeStyle = 'rgba(127,232,216,.3)'; g.lineWidth = 2; g.stroke()
      g.beginPath(); g.arc(joy.ox, joy.oy, 8, 0, Math.PI * 2); g.fillStyle = 'rgba(127,232,216,.25)'; g.fill()
      const dx = joy.x - joy.ox, dy = joy.y - joy.oy
      const d = Math.hypot(dx, dy) || 1
      const cl = Math.min(d, 34)
      g.beginPath(); g.arc(joy.ox + dx / d * cl, joy.oy + dy / d * cl, 14, 0, Math.PI * 2)
      g.fillStyle = 'rgba(232,236,243,.55)'; g.fill()
    }
    /* 页脚 slug·version（P2，§7） */
    g.fillStyle = 'rgba(139,147,167,.55)'
    g.font = HF('P2', 'foot', 9)
    g.fillText('deep-foodchain · v1.0.0 · S6', 12, H - 8)
    /* 观战体型对比条（F15：top5 按视觉体型 rOf 相对条，档色着色——观战/demo 态） */
    if (S.mode === 'spectate' || S.specDemo) {
      const rows5 = (S.lb || []).slice(0, 5)
      if (rows5.length) {
        let maxR = 1
        for (const r of rows5) maxR = Math.max(maxR, K.rOf(r.M || 20))
        const y0 = H - 132
        g.fillStyle = 'rgba(5,12,9,.66)'; g.fillRect(0, y0, W, rows5.length * 12 + 10)
        for (let i = 0; i < rows5.length; i++) {
          const r = rows5[i], rr = K.rOf(r.M || 20)
          const yy = y0 + 8 + i * 12
          const seatRec = S.roster.find((x) => x.seat === r.seat)
          g.font = HF('P2', 'spec-name', 9)
          g.fillStyle = r.seat === S.seat ? '#FFD98E' : DIM
          g.fillText((((seatRec && seatRec.name) || '鱼' + r.seat) + '').slice(0, 4), 12, yy + 8)
          g.fillStyle = 'rgba(127,232,216,.12)'; g.fillRect(56, yy + 1, W - 70, 7)
          g.fillStyle = TIER_COL[K.tierOf(r.M || 20, 0)]
          g.fillRect(56, yy + 1, (W - 70) * (rr / maxR), 7)
        }
        fxDraw('F15')
      }
    }
    /* 终局成长曲线回放图（F14：mHist 折线——轮末结算/终局 1.8s·6s 窗） */
    if ((S.curveUntil > now || (S.crown && S.crown.over)) && S.mHist.length >= 2) {
      const x0 = W / 2 - 80, y0 = H / 2 + 6, cw = 160, ch = 40
      let maxM = 1
      for (const m of S.mHist) maxM = Math.max(maxM, m)
      g.fillStyle = 'rgba(4,10,8,.6)'; g.fillRect(x0 - 6, y0 - 4, cw + 12, ch + 14)
      g.strokeStyle = 'rgba(127,232,216,.25)'; g.lineWidth = 1
      g.strokeRect(x0 - 6, y0 - 4, cw + 12, ch + 14)
      g.beginPath()
      for (let i = 0; i < S.mHist.length; i++) {
        const px = x0 + (i / (S.mHist.length - 1)) * cw
        const py = y0 + ch - (S.mHist[i] / maxM) * ch
        if (i) g.lineTo(px, py); else g.moveTo(px, py)
      }
      g.strokeStyle = '#7FE8D8'; g.lineWidth = 1.5; g.stroke()
      g.font = HF('P2', 'curve-cap', 9)
      g.fillStyle = DIM
      g.fillText('成长回放 · ' + S.mHist[S.mHist.length - 1] + 'g', x0, y0 + ch + 20)
      fxDraw('F14')
    }
    /* toast（升档/吞噬/鱼汛潮/连吞，§3.3） */
    S.toasts = S.toasts.filter((t) => now - t.t0 < t.dur)
    let ty = TOP_H + 96
    for (const t of S.toasts) {
      const age = (now - t.t0) / t.dur
      const pop = t.big ? Math.max(0, 1 - age * 6) : 0
      g.globalAlpha = 1 - age * age
      g.fillStyle = t.c
      g.font = HF(t.big ? 'P0' : 'P1', 'toast', Math.round((t.big ? 15 : 12) * (1 + 0.35 * pop)), 600)
      g.textAlign = 'center'
      g.fillText(t.txt, W / 2, ty)
      g.textAlign = 'left'
      g.globalAlpha = 1
      ty += 22
    }
    /* 轮末结算横幅（1.8s） */
    if (S.settle) {
      const age = now - S.settle.t0
      if (age > 1800) S.settle = null
      else {
        const y0 = H / 2 - 34
        g.globalAlpha = Math.min(1, age / 200) * (age > 1500 ? (1800 - age) / 300 : 1)
        g.fillStyle = 'rgba(4,12,8,.8)'
        g.fillRect(0, y0, W, 68)
        g.fillStyle = '#FFD700'
        g.fillRect(0, y0, W, 2); g.fillRect(0, y0 + 66, W, 2)
        g.textAlign = 'center'
        g.font = HF('P0', 'settle', 16, 700)
        g.fillStyle = INK
        g.fillText('第' + S.settle.n + '轮 终 · 结算', W / 2, y0 + 30)
        g.font = HF('P1', 'settle-k', 11)
        g.fillStyle = DIM
        g.fillText('海王加冕 · 光点散场 · 新轮开启', W / 2, y0 + 50)
        g.textAlign = 'left'
        g.globalAlpha = 1
      }
    }
    /* 死亡覆层（§3.3：吞噬者+化作 N 光点+重生倒计时 3s 圆环） */
    if (S.dead && S.respawnIn > 0) {
      const da = Math.min(1, (now - (S.deathT0 || now)) / 300)
      const eo = 1 - Math.pow(1 - da, 3)
      g.fillStyle = 'rgba(4,9,6,' + (0.6 * da).toFixed(3) + ')'
      g.fillRect(0, 0, W, H)
      g.strokeStyle = 'rgba(255,60,40,' + (0.3 * da * (0.7 + 0.3 * Math.sin(now / 200))).toFixed(3) + ')'
      g.lineWidth = 8
      g.strokeRect(4, 4, W - 8, H - 8)
      g.textAlign = 'center'
      g.fillStyle = '#FF6B5C'
      g.font = HF('P0', 'death-by', 15, 600)
      g.fillText(S.killerName ? '被 ' + S.killerName + ' 吞噬' : '消失在深海', W / 2, H / 2 - 46 + (1 - eo) * 14)
      g.fillStyle = '#FFB65C'
      g.font = HF('P1', 'death-drop', 13)
      g.fillText('化作 ' + S.dropN + ' 光点——幸存者正在开宴', W / 2, H / 2 - 20 + (1 - eo) * 14)
      const prog = 1 - S.respawnIn / 30
      g.beginPath(); g.arc(W / 2, H / 2 + 42, 26, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2)
      g.strokeStyle = '#7FE8D8'; g.lineWidth = 4; g.stroke()
      g.fillStyle = INK
      g.font = HF('P0', 'death-cd', 14, 600)
      g.fillText(Math.ceil(S.respawnIn / 10) + '', W / 2, H / 2 + 48)
      g.textAlign = 'left'
    }
    /* 海王加冕覆层 5s（§3.3） */
    if (S.crown && now < S.crownUntil && !S.crown.over) {
      g.fillStyle = 'rgba(4,9,6,.72)'
      g.fillRect(0, 0, W, H)
      g.textAlign = 'center'
      drawCrownLocal(W / 2, H / 2 - 92, 30)
      g.fillStyle = '#FFD700'
      g.font = HF('P0', 'crown', 17, 700)
      g.fillText('海王加冕', W / 2, H / 2 - 34)
      g.fillStyle = INK
      g.font = HF('P0', 'crown-name', 14, 600)
      g.fillText(S.crown.name + ' · ' + S.crown.score + ' 分', W / 2, H / 2 - 8)
      if (Math.random() < 0.3) spawnParts((Math.random() * K.W) | 0, (Math.random() * K.H) | 0, '#FFD700', 2)
      g.textAlign = 'left'
    }
    /* 错误/断连提示 */
    if (S.err || S.connLost) {
      g.fillStyle = 'rgba(255,107,92,.9)'
      g.font = HF('P1', 'err', 12, 600)
      g.textAlign = 'center'
      g.fillText(S.connLost ? '与渔场断开连接…' : S.err, W / 2, H - 30)
      g.textAlign = 'left'
    }
  }
  /* 排行榜 tap 展开（§1.5） */
  cv.addEventListener('touchstart', (e) => {
    const p = pd(e)
    if (p.x < 130 && p.y > TOP_H && p.y < TOP_H + 34 + 6 * 17) lbOpen = !lbOpen
  }, { passive: true })

  /* =====================================================================
   * debug 幽灵渔场（?debug=1，perf-smoke 契约：boot → start(1) → rAF 采样）
   * 20 幽灵鱼（同式曲线巡游）+180 资源位+瞬态光点——渲染/插值与在线同径
   * ===================================================================== */
  function startDebugArena() {
    if (S.mode === 'debug') return true // 幂等：?debug=1 自启动与 perf-smoke start(1) 双入口防重（双份幽灵节拍=双倍渲染负载假红）
    S.mode = 'debug'
    S.seat = 0
    document.getElementById('boot').style.display = 'none'
    S.enterT0 = now
    let dseq = 0
    const kinds = ['alg', 'alg', 'alg', 'kri', 'cry']
    for (let i = 0; i < 180; i++) {
      const k = kinds[i % 5]
      S.ents.set(k[0] + i, {
        id: k[0] + i, k,
        x: (60000 + Math.random() * (K.W - 120000)) | 0, y: (60000 + Math.random() * (K.H - 120000)) | 0,
        v: { alg: 1, kri: 2, cry: 4 }[k], on: 1,
      })
    }
    for (let i = 0; i < 30; i++) { // 瞬态光点（渲染负载面）
      S.ents.set('d' + (dseq++), { id: 'd' + i, k: 'drop', x: (60000 + Math.random() * (K.W - 120000)) | 0, y: (60000 + Math.random() * (K.H - 120000)) | 0, v: 2 })
    }
    S.mm = []
    const M0S = [20, 35, 60, 90, 140, 220, 350, 520, 800, 1200, 2000, 4000] // 四档形色同屏（VIS 锚点）
    for (let i = 0; i < 20; i++) {
      const M = i === 0 ? 20 : M0S[i % M0S.length]
      const a = (i * 47) % 360
      const rec = {
        id: 's' + i, k: 'fish', seat: i === 0 ? 0 : i, name: i === 0 ? '你' : '幽灵' + i,
        M, t: K.tierOf(M, 0), skin: i % 8,
        x: (120000 + Math.random() * (K.W - 240000)) | 0, y: (120000 + Math.random() * (K.H - 240000)) | 0,
        a, sc: ((M / 4) | 0), k2: 0, b: 0, d: 0, p: 0, smp: [], fade: 1, pop: 0,
        wp: { x: (200000 + Math.random() * (K.W - 400000)) | 0, y: (200000 + Math.random() * (K.H - 400000)) | 0 },
      }
      S.ents.set(rec.id, rec)
      S.mm.push([rec.seat, Math.round(rec.x / 1000), Math.round(rec.y / 1000), rec.M])
    }
    S.lb = Array.from({ length: 5 }, (_, i) => ({ seat: i, name: '幽灵' + (i + 1), M: 200 + i * 300, kills: i, score: 60 + i * 40 }))
    S.round = { n: 1, t: 1800, k: 3, rem: 1800 }
    /* 幽灵节拍：100ms 推一次权威样本（走同一条插值管线） */
    setInterval(() => {
      let mi = 0
      for (const rec of S.ents.values()) {
        if (rec.k !== 'fish') continue
        if (rec.seat !== -1) {
          const d = Math.hypot(rec.wp.x - rec.x, rec.wp.y - rec.y)
          if (d < 160000) rec.wp = { x: (200000 + Math.random() * (K.W - 400000)) | 0, y: (200000 + Math.random() * (K.H - 400000)) | 0 }
          const ta = Math.atan2(rec.wp.y - rec.y, rec.wp.x - rec.x) * 180 / Math.PI
          rec.a = K.stepTurn(rec.a, ta, K.wOf(rec.M))
          const v = K.vOf(rec.M)
          rec.x += Math.cos(rec.a * Math.PI / 180) * v * 10
          rec.y += Math.sin(rec.a * Math.PI / 180) * v * 10
        }
        rec.smp.push({ t: (S.dbgT = (S.dbgT || 0) + 100), x: rec.x, y: rec.y, a: rec.a })
        if (rec.smp.length > 4) rec.smp.shift()
        S.mm[mi] && (S.mm[mi] = [rec.seat, Math.round(rec.x / 1000), Math.round(rec.y / 1000), rec.M])
        mi++
      }
    }, 100)
  }

  /* =====================================================================
   * 主循环（rAF 60fps；本地步进按真实 dt）
   * ===================================================================== */
  let lastT = performance.now()
  let fpsAcc = 0, fpsN = 0, fpsShown = 0
  function frame(t) {
    now = t
    if (S.pauseViz) { lastT = t; PERF.seeded = false; requestAnimationFrame(frame); return } // 识图/墨水带采样冻结帧（perf 重播种防跨暂停巨隙）
    const c0 = performance.now()
    const dt = Math.min(100, t - lastT)
    lastT = t
    simAcc += dt
    while (simAcc >= 100) {
      simAcc -= 100; S.round.t++; S.round.rem = Math.max(0, S.round.rem - 1); if (S.respawnIn > 0) S.respawnIn--
      if (S.round.t % 10 === 0) { // 成长曲线采样（1 点/s，整轮 360 点封顶）
        const meH = S.ents.get('s' + S.seat)
        if (meH && S.mHist.length < 360) S.mHist.push(meH.M)
      }
    }
    if (!S.mHist.length) { const meH = S.ents.get('s' + S.seat); if (meH) S.mHist.push(meH.M) }
    stepLocal(now < S.slowUntil ? dt * 0.35 : dt) // 吞噬轻度慢镜 220ms（纯呈现层）
    render(dt)
    fpsAcc += dt; fpsN++
    if (fpsAcc >= 500) { fpsShown = Math.round(1000 / (fpsAcc / fpsN)); fpsAcc = 0; fpsN = 0 }
    perfTick(t, performance.now() - c0)
    requestAnimationFrame(frame)
  }

  /* ---------- 调试钩子（识图 v2/取证，snake/mmo 先例） ---------- */
  function fxScene(name) {
    if (name === 'calm') { // 冻结帧采样前清场（动效层零残留——识图锚点稳定口径）
      S.toasts = []; S.settle = null; S.bloom = -1; S.gulp = null; S.panicUntil = 0
      S.whale = null; S.scatters = []; S.combo = null; S.specDemo = 0; S.curveUntil = 0
      S.lbDeltas = {}; S.tierBurst = null; S.flash = 0; S.shakeT = 0; S.slowUntil = 0
      S.zoomPulse = 0; S.enterT0 = 0; S.crown = null
      S.dead = false; S.respawnIn = 0; S.killerName = '' // 探针死亡态复位（debug 无快照驱动）
      const meC = S.ents.get('s' + S.seat)
      if (meC) { meC.b = 0; meC.p = 0 }
      return true
    }
    if (name === 'enter') { S.enterT0 = now; fxTrig('F16'); sfx.play('spawn', ''); return true }
    if (name === 'round') { S.settle = { n: S.round.n, t0: now }; S.curveUntil = now + 1800; fxTrig('F14'); sfx.play('round', String(S.round.n)); sfx.play('curve', ''); return true }
    if (name === 'bloom') { S.bloom = 2; onEvent({ k: 'bloom', band: 2 }); return true }
    if (name === 'dash') {
      const me = S.ents.get('s' + S.seat); if (!me) return false
      me.b = 1; fxTrig('F04'); sfx.play('dashOn', ''); sfx.play('bubble', '')
      setTimeout(() => { me.b = 0; sfx.play('dashOff', '') }, 600)
      return true
    }
    if (name === 'shield') { const me = S.ents.get('s' + S.seat); if (!me) return false; me.p = 20; setTimeout(() => { me.p = 0 }, 1500); return true }
    if (name === 'tier') { onEvent({ k: 'tier', seat: S.seat, t: 2 }); return true }
    if (name === 'panic') { S.panicUntil = Math.max(S.panicUntil, now + 900); fxTrig('F05'); sfx.play('danger', ''); return true }
    if (name === 'whale') { const me = S.ents.get('s' + S.seat); const w = me || { x: cam.x, y: cam.y }; S.whale = { x: w.x, y: w.y, t0: now }; S.shakes = Math.max(S.shakes, 6); S.shakeT = Math.max(S.shakeT, 500); fxTrig('F13'); return true }
    if (name === 'stateAll') { // 状态项打包驱动：近旁布猎物/天敌/资源演示位（seat=-1 不入幽灵巡游），draw-site 落真实绘制分支
      fxTrig('F03'); fxTrig('F07'); fxTrig('F08'); fxTrig('F09'); fxTrig('F10'); fxTrig('F11'); fxTrig('F15')
      S.specDemo = 1
      const me = S.ents.get('s' + S.seat)
      if (me) {
        const near = (id, M, dx, dy) => {
          const rec = { id, k: 'fish', seat: -1, name: id, M, t: K.tierOf(M, 0), skin: 0, x: me.x + dx, y: me.y + dy, a: 90, sc: 0, k2: 0, b: 0, d: 0, p: 0, smp: [{ t: 0, x: me.x + dx, y: me.y + dy, a: 90 }], fade: 1, pop: 0 }
          S.ents.set(id, rec)
        }
        near('zPrey', 2, 70000, 30000)      // 猎物演示位（r=6 ≤ myR×0.8 → 绿描边）
        near('zPred', 600, -80000, -40000)  // 天敌演示位（T2 r=20 ≥ myR×1.25 → 红警示）
        for (let i = 0; i < 3; i++) S.ents.set('zf' + i, { id: 'zf' + i, k: 'alg', x: me.x + 30000 + i * 16000, y: me.y - 50000 + i * 9000, v: 1, on: 1 })
      }
      S.lbDeltas = {}
      S.lbDeltas[(S.lb[0] && S.lb[0].seat) || 0] = { d: 40, t0: now }
      return true
    }
    return false
  }
  window.__GAMES_DEBUG__ = {
    events: [],
    start(level) { startDebugArena(); report('start', { level }); return true },
    pause(v) { S.pauseViz = !!v; return true }, // visual-check 识图契约：冻结帧采样墨水带
    hudFonts: () => {
      const cls = {}
      for (const grp in HF_REG) {
        let min = Infinity
        for (const k in HF_REG[grp]) min = Math.min(min, HF_REG[grp][k].px)
        cls[grp] = { min }
      }
      return { reg: HF_REG, __applied: appliedSelfCheck(g), __cls: cls, note: '__applied=true 表示 ctx.font 赋值回读生效（700 13px 合法简写路径在场，Q-013）' }
    },
    fps: () => fpsShown,
    perf: () => perfStat(),
    fxList: () => FXLIST.map((f) => ({ id: f[0], name: f[1], cls: f[2] })),
    fxLedger: () => FXLED.slice(-400),
    state: () => ({ mode: S.mode, seat: S.seat, ents: S.ents.size, dead: S.dead, round: S.round, lb: S.lb.slice(0, 5), mm: S.mm.length, dash: S.dashOn, target: S.target }),
    sfxCalls: () => sfx.calls.slice(-40),
    sfxGroups: () => ({ slots: sfx.slots.slice(), calls: sfx.calls.slice(-64), fired: sfx.fired, on: sfx.on }),
    sound(v) { sfx.on = !!v; return sfx.on },
    dbgEvents: () => dbgEvents.slice(-40),
    fxProbe(ev) { // 反馈类取证：合成事件走同一条 onEvent 管线
      if (ev.k === 'devour' && ev.seat === S.seat) { S.dead = true; S.respawnIn = 25; onMyDeath() }
      onEvent(ev)
      return true
    },
    fxScene,
    cam: () => ({ x: cam.x, y: cam.y, zoom: +cam.zoom.toFixed(3) }),
    visInfo() { // VIS 断言源：四档形色双编码表 + 光点签名 + 巨房在场分布
      const me = S.ents.get('s' + S.seat)
      let near = 0, mid = 0, far = 0
      if (me) for (const rec of S.ents.values()) {
        if (rec.k !== 'fish' || rec.gone || rec.d) continue
        const d = Math.hypot(rec.x - me.x, rec.y - me.y)
        if (d < 600000) near++; else if (d < 900000) mid++; else far++
      }
      return {
        tiers: K.TIERS.map((t) => ({ t: t.t, name: t.name, col: TIER_COL[t.t], aoi: t.aoi, zoom: t.zoom })),
        skins: SKIN.map((s) => ({ c: s.c, pat: s.pat, hat: s.hat })),
        sprSig: SPR_SIG,
        fadeTable: [crowdFadeOf(0), crowdFadeOf(650000), crowdFadeOf(950000)],
        crowd: { near, mid, far },
        mePos: me ? { x: me.x, y: me.y } : null,
        version: '1.0.0',
      }
    },
  }

  /* ---------- 启动 ---------- */
  report('boot', { slug: 'deep-foodchain', version: '1.0.0', mode: 'net' })
  const q = new URLSearchParams(location.search)
  requestAnimationFrame(frame)
  if (q.get('debug') === '1') { window.__GAMES_DEBUG__.start(1) }
  else connect()
})()
