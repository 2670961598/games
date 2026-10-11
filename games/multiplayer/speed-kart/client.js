/* =====================================================================
 * 极速卡丁 客户端（GAMES-109 · S7 预测与和解首证）。
 * 依赖前置：trig16.cjs / tracks.cjs / shared.cjs（window.KartSim——与服务端 sim
 * 同一段纯函数：integrate/progress/makePredictor，§5.1 单源纪律）。
 *
 * S7 三策略（设计 §5.1/附决策 7）：
 *   自车=本地预测 0ms 起步（drag 即转向，20Hz 采样+输入环形缓冲+上行 seq）+
 *   快照 ack 和解（权威锚点回滚重放未确认输入；Δpos≤6px 软收敛 20%/帧、
 *   >6px 硬回滚 120ms 混合带，撕裂预算 ≤2.5px/帧 §5.3）；
 *   他人车=100ms 插值缓冲（迟到外推 1 张 100ms，mmo §5.3 同式）——只回滚自己；
 *   本地圈账=预测器 progress 同跑（T7-A 结算对照条的"本地感知圈时"源，§3.4）。
 *
 * 渲染（§3.2/§7）：镜头旋进（车恒朝上）+速度缩放 1.00→0.84+motion 线+路缘石
 * 红白识图锚；HUD 字号对齐 hud-font-standard §1（HF 登记表+ping 徽标 P0 升档
 * ——T7-A 首个触发者，§3.3）。debug（?debug=1）：本地 6 车竞技场（同渲染路径，
 * perf-smoke 契约）。
 * ===================================================================== */
'use strict'
;(function () {
  const K = window.KartSim
  const W = 375, H = 667, TOP_H = 56
  const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif"
  /* §7 调色板：暮色环道 */
  const BG1 = '#1A1626', BG2 = '#3A2B4A', ASPH = '#2E3140', GRASS = '#232A26'
  const CURB_A = '#D94848', CURB_B = '#E8E4DC', INK = '#E8ECF3', DIM = '#8B93A7'
  const NEON = { cyan: '#5CD9E8', mag: '#E86BC9' }
  const SEAT_COL = ['#FFB65C', '#5CD9E8', '#3DDC84', '#FFD166', '#FF6B5C', '#E8E8F0']
  const SEAT_SHAPE = ['circle', 'tri', 'square', 'dia', 'cross', 'star']

  /* HUD 字号登记表（识图 v2 断言源）：P0 数字 ≥13/600、P1 交互 ≥11、P2 辅助 ≥9 */
  const hudFontReg = {}
  function HF(grp, key, px, w) {
    ;(hudFontReg[grp] || (hudFontReg[grp] = {}))[key] = px
    return (w ? w + ' ' : '') + px + 'px ' + FONT
  }

  /* ---------- 音效位（≥12 槽；makeSound 包络，总闸门默认 false=静音只记账） ---------- */
  const sfx = {
    slots: ['green', 'lap', 'pb', 'drift', 'boost', 'wall', 'bump', 'draft', 'count', 'fin', 'pass', 'pen'],
    calls: [], on: false, ac: null,
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
      if (!this.on) return
      if (slot === 'green') this.tone(523, 1046, 0.2, 'square', 0.06)
      else if (slot === 'lap') this.tone(660, 990, 0.14, 'triangle', 0.05)
      else if (slot === 'pb') { this.tone(784, 784, 0.12, 'sine', 0.07); setTimeout(() => this.tone(1046, 1568, 0.22, 'sine', 0.07), 110) }
      else if (slot === 'drift') this.tone(220, 180, 0.1, 'sawtooth', 0.03)
      else if (slot === 'boost') this.tone(440, 1320, 0.24, 'square', 0.05)
      else if (slot === 'wall') this.tone(180, 90, 0.14, 'sawtooth', 0.05)
      else if (slot === 'bump') this.tone(260, 140, 0.08, 'square', 0.04)
      else if (slot === 'draft') this.tone(520, 700, 0.12, 'sine', 0.035)
      else if (slot === 'count') this.tone(392, 392, 0.1, 'sine', 0.05)
      else if (slot === 'fin') { this.tone(523, 784, 0.16, 'sine', 0.06); setTimeout(() => this.tone(784, 1046, 0.24, 'sine', 0.06), 140) }
      else if (slot === 'pass') this.tone(700, 980, 0.08, 'triangle', 0.04)
      else if (slot === 'pen') this.tone(200, 120, 0.2, 'square', 0.05)
    },
  }

  /* ---------- 全局状态 ---------- */
  const S = {
    mode: 'connecting',   // connecting|playing|spectate|debug
    conn: null, roomId: null, seat: -1, token: null, roster: [],
    track: null, tr: null, L: 0, tickMs: 50,
    phase: 'countdown', ranks: [], champion: -1,
    pred: null,          // makePredictor（自车预测）
    simTick: 0,          // 本地 sim 时钟（tick 计数）
    seq: 0, lastSend: 0, // 输入序号 / 上次上行时刻
    flight: 3,           // 飞行窗估（tick）——自校准
    sentLog: [],         // {q, tick} 飞行观测账本
    vis: null,           // 视觉自车（渲染插值位，毫 milli）
    blend: null,         // 硬回滚混合带 {x0,y0,t0}
    recon: [],           // 和解修正台账（px，10s 滚动窗，§3.3 详情卡）
    hashBad: 0, hashWarn: false, syncedAt: 0,
    remote: new Map(),   // seat → {buf:[{t,x,y,a,d?}], ...}
    lapLocal: [], lapSrv: [], best: 0, lapBanner: null, curLapT0: 0,
    ping: 0, pings: [], pingAt: 0, pingOpen: false,
    err: '', connLost: false, end: null, greenAt: 0, penUntil: 0,
    /* 本地输入态（§1.5） */
    drag: null, th: 1, dr: 0,
    /* juice */
    parts: [], shake: 0, shakeT: 0, flash: 0, flashC: '#7FE8D8', zoomP: 0, sparks: 0,
    fpsShown: 0,
  }
  const cam = { x: 0, y: 0, ang: 0, zoom: 1, zT: 1 }
  let now = performance.now()

  /* ---------- 事件上报（perf-smoke 契约） ---------- */
  function report(event, payload) {
    if (window.__GAMES_DEBUG__) window.__GAMES_DEBUG__.events.push({ event, payload, at: Date.now() })
  }

  /* =====================================================================
   * 连接层（net 协议 v1.1：join/quick → welcome/snapshot 流）
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
      try { resume = JSON.parse(sessionStorage.getItem('spk-' + rid) || 'null') } catch { resume = null }
      ws.send(JSON.stringify({ t: 'join', roomId: rid || undefined, mode: q.get('mode') === 'spectate' ? 'spectate' : 'play', resume: resume ? { seat: resume.seat, token: resume.token } : undefined, name: '玩家' }))
      if (!rid) ws.send(JSON.stringify({ t: 'quick', gameId: 'speed-kart' }))
    }
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data) } catch { return } onMsg(m) }
    ws.onclose = () => { if (S.mode === 'playing' || S.mode === 'spectate') S.connLost = true }
    ws.onerror = () => { if (S.mode === 'playing' || S.mode === 'spectate') S.connLost = true }
  }
  function onMsg(m) {
    if (m.t === 'error') { S.err = m.code || m.message; setTimeout(() => { S.err = '' }, 2500); return }
    if (m.t === 'welcome') {
      S.roomId = m.roomId; S.seat = m.role === 'player' ? m.seat : -1
      S.token = m.token; S.roster = (m.room && m.room.seats) || []
      S.tickMs = m.tickMs || 50
      if (m.token != null) { try { sessionStorage.setItem('spk-' + S.roomId, JSON.stringify({ seat: S.seat, token: S.token })) } catch {} }
      S.mode = S.seat >= 0 ? 'playing' : 'spectate'
      if (m.state) applyFullState(m.state, m.frame)
      document.getElementById('boot').style.display = 'none'
      return
    }
    if (m.t === 'seat') { S.roster = m.seats; return }
    if (m.t === 'started') { if (m.state) applyFullState(m.state, m.frame); return }
    if (m.t === 'snapshot') { applySnapshot(m); return }
    if (m.t === 'end') { S.end = m.result; return }
    if (m.t === 'closed') { S.connLost = true }
    if (m.t === 'pong') {
      const rtt = performance.now() - m.c
      S.pings.push(rtt); if (S.pings.length > 12) S.pings.shift()
      const s = S.pings.slice().sort((a, b) => a - b)
      S.ping = Math.round(s[Math.floor(s.length / 2)])
    }
  }
  /* welcome/started/sync 全量：预测基点重锚（断线重连=全量+预测续跑，§5.1） */
  function applyFullState(st, frame) {
    S.track = st.track; S.tr = K.TRACKS[st.track.id] || K.TRACKS['t-bay']
    S.L = st.track.laps; S.phase = st.phase; S.ranks = st.ranks || S.ranks
    S.champion = st.champion
    if (!S.pred) S.pred = K.makePredictor(S.track.id)
    const me = S.seat >= 0 ? st.karts[S.seat] : st.karts[0]
    if (me) {
      S.pred.setPhase(st.phase)
      S.pred.anchor(me, st.tick)
      S.simTick = st.tick
      S.best = me.best || 0
      S.lapSrv = (me.lapTimes || []).slice()
      S.sentLog = []
      S.vis = { x: me.x, y: me.y, a: me.a }
      cam.x = me.x; cam.y = me.y; cam.ang = me.a
    }
    for (const k of st.karts) if (k.seat !== S.seat) remotePut(k, st.tick)
    if (frame != null && S.seat >= 0 && st.inCur && st.inCur[S.seat]) syncFlightAck(st.inCur[S.seat].q | 0, st.tick)
    S.syncedAt = performance.now()
  }

  /* =====================================================================
   * 快照管线（10Hz 二式：全量/增量+稀疏脏字段，§5.4）+ 和解回路（§5.1 ①-④）
   * ===================================================================== */
  function remotePut(k, tick) {
    let r = S.remote.get(k.seat)
    if (!r) { r = { seat: k.seat, buf: [], car: 0, laps: 0, fin: 0, dr: 0, bo: 0, draft: 0, pen: 0, best: 0, name: '' }; S.remote.set(k.seat, r) }
    if (k.car !== undefined) r.car = k.car
    if (k.name !== undefined) r.name = k.name
    for (const f of ['laps', 'fin', 'dr', 'bo', 'draft', 'pen', 'best']) if (k[f] !== undefined) r[f] = k[f]
    if (k.lap !== undefined) r.lastLap = k.lap
    r.buf.push({ t: tick, x: k.x, y: k.y, a: k.a })
    if (r.buf.length > 6) r.buf.shift()
  }
  /* 增量并道成权威自车视图（x,y,a,v 恒带+脏字段；d/s/cp 走预测器影子保真——
   * 增量不带 d，权重低：本拍 d 用影子值，300 张全量校正） */
  function authMerge(m) {
    const k = m.karts.find((x) => x.seat === S.seat)
    if (!k) return null
    const sh = S.pred.kart() || {}
    const auth = {
      seat: S.seat, car: k.car !== undefined ? k.car : (sh.car || 0),
      x: k.x, y: k.y, a: k.a, d: k.d !== undefined ? k.d : (sh.d !== undefined ? sh.d : k.a), v: k.v,
      s: k.s !== undefined ? k.s : (sh.s || 0), lat: k.lat !== undefined ? k.lat : (sh.lat || 0),
      idx: sh.idx || 0, cross: sh.cross || 0, laps: k.laps !== undefined ? k.laps : (sh.laps || 0),
      cp: sh.cp || 1, pOff: sh.pOff || 0, lapT0: sh.lapT0 || 0, lastLapTick: sh.lastLapTick || 0,
      lapTimes: sh.lapTimes, best: k.best !== undefined ? k.best : (sh.best || 0), fin: k.fin !== undefined ? k.fin : (sh.fin || 0),
      dr: k.dr !== undefined ? k.dr : (sh.dr || 0), ch: k.ch !== undefined ? k.ch : (sh.ch || 0),
      tier: sh.tier || 0, bo: k.bo !== undefined ? k.bo : (sh.bo || 0), boMul: sh.boMul || 65536,
      draft: k.draft !== undefined ? k.draft : (sh.draft || 0), drT: sh.drT || 0,
      pen: k.pen !== undefined ? k.pen : (sh.pen || 0),
    }
    return auth
  }
  function applySnapshot(m) {
    if (!S.tr) return
    if (m.full && S.track) {
      /* 全量：karts=完整记录 → 预测基点重锚（welcome/sync/300 张同径，§5.4） */
      applyFullState({ track: S.track, phase: m.state.phase, ranks: m.state.ranks, champion: m.state.champion, karts: m.karts, tick: m.frame, inCur: null }, m.frame)
    }
    S.lastFrame = m.frame
    S.phase = (m.state && m.state.phase) || S.phase
    S.ranks = (m.state && m.state.ranks) || S.ranks
    S.champion = (m.state && m.state.champion) !== undefined ? m.state.champion : S.champion
    for (const k of m.karts) {
      if (k.seat === S.seat) continue
      remotePut(k, m.frame)
    }
    /* 事件流（§5.4：零 diff 触发 juice） */
    for (const ev of m.events || []) onEvent(ev)
    if (S.seat < 0) return
    /* ①-③ 和解（§5.1）：丢历史→权威锚→重放未确认 */
    const ack = m.ext && typeof m.ext.ack === 'number' ? m.ext.ack : -1
    const auth = authMerge(m)
    if (auth) {
      syncFlightAck(ack, m.frame)
      S.pred.setPhase(S.phase)
      S.pred.anchor(auth, m.frame)
      if (S.simTick < m.frame) S.simTick = m.frame   // 本地时钟不得落后权威帧
      const before = S.pred.advanceTo(S.simTick)
      const beforeX = before ? before.x : auth.x, beforeY = before ? before.y : auth.y
      const after = S.pred.advanceTo(S.simTick) || auth
      const dx = Math.abs(after.x - beforeX), dy = Math.abs(after.y - beforeY)
      const dPx = Math.max(dx, dy) / 1000
      if (dPx > 0.5) { S.recon.push({ t: performance.now(), px: dPx }); if (S.recon.length > 200) S.recon.shift() }
      /* ③ 软收敛/硬回滚（撕裂预算 §5.3） */
      if (dPx > 6) { S.blend = { x0: S.vis ? S.vis.x : after.x, y0: S.vis ? S.vis.y : after.y, t0: performance.now() } }
      /* ④ hash 哨兵（每 10 张）：分歧→sync 全量；连续 3 次上报告警 */
      if (m.ext && m.ext.hash) {
        const mine = K.hashKart(after, m.frame)
        if (mine !== m.ext.hash) {
          S.hashBad++
          if (S.conn && S.conn.readyState === 1) S.conn.send(JSON.stringify({ t: 'sync' }))
          if (S.hashBad >= 3) S.hashWarn = true
        } else S.hashBad = 0
      }
      /* 本地圈账（预测器 progress 事件=T7-A 本地感知圈时） */
      for (const ev of S.pred.drainEvents()) {
        if (ev.k === 'lap') {
          S.lapLocal.push(ev.ms)
          S.lapBanner = { lap: ev.lap, ms: ev.ms, t0: performance.now() }
          sfx.play('lap', String(ev.lap))
          if (!S.best || ev.ms < S.best) { S.best = ev.ms; sfx.play('pb', '') }
        }
      }
    }
  }
  /* 飞行窗自校准：ack 回执（服务器已消费 seq）→ 观测发送 tick→消费 tick 差 EMA */
  function syncFlightAck(ack, srvTick) {
    if (ack < 0 || !S.sentLog.length) return
    while (S.sentLog.length && S.sentLog[0].q <= ack) {
      const obs = srvTick - S.sentLog[0].tick
      if (obs >= 0 && obs < 64) S.flight = (S.flight * 3 + obs + 1) >> 2
      S.sentLog.shift()
    }
  }
  function onEvent(ev) {
    if (ev.k === 'green') { S.greenAt = performance.now(); S.flash = 1; S.flashC = '#7FE8D8'; sfx.play('green', '') }
    else if (ev.k === 'lap') {
      if (ev.seat === S.seat) { S.lapSrv.push(ev.ms); if (!S.best || ev.ms < S.best) S.best = ev.ms }
      else if (ev.seat >= 0) { const r = S.remote.get(ev.seat); if (r) r.lastLap = ev.ms }
    }
    else if (ev.k === 'bump') {
      if (ev.a === S.seat || ev.b === S.seat) { S.shake = 4; S.shakeT = performance.now(); sfx.play('bump', String(ev.a)) }
    }
    else if (ev.k === 'wall') {
      if (ev.seat === S.seat) { S.shake = 2; S.shakeT = performance.now(); S.sparks = 8; sfx.play('wall', '') }
    }
    else if (ev.k === 'boost') {
      if (ev.seat === S.seat) { S.zoomP = 1; sfx.play('boost', String(ev.tier)); spawnJet() }
    }
    else if (ev.k === 'draft') { if (ev.seat === S.seat) sfx.play('draft', '') }
    else if (ev.k === 'finish') {
      if (ev.seat === S.seat) { sfx.play('fin', String(ev.pos)); S.flash = 1; S.flashC = '#FFD166' }
    }
    else if (ev.k === 'jump') { if (ev.seat === S.seat) { S.penUntil = performance.now() + 1000; sfx.play('pen', '') } }
  }
  function spawnJet() { for (let i = 0; i < 10; i++) S.parts.push({ x: 0, y: 10, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, life: 1, c: '#FFD166', sz: 2 }) }

  /* =====================================================================
   * 输入面（§1.5：横拖转向带+纵拖油门+按区/双指漂移；本地预测即时起效）
   * ===================================================================== */
  const cv = document.getElementById('cv')
  const DRIFT_BTN = { x: W - 52, y: H - 66, r: 36 }   // Ø72 右下
  function localInput() {
    if (S.drag) {
      const dx = S.drag.x - S.drag.x0
      const dz = Math.abs(dx) < 6 ? 0 : Math.round(Math.max(-100, Math.min(100, (dx / 90) * 100)))
      S.drag.st = dz
    }
    return { st: S.drag ? S.drag.st : 0, th: S.th, dr: S.dr }
  }
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const x = e.offsetX, y = e.offsetY
    const db = Math.hypot(x - DRIFT_BTN.x, y - DRIFT_BTN.y)
    if (db <= DRIFT_BTN.r + 8) { S.dr = 1; S.driftTouch = e.pointerId; return }
    if (S.drag && S.drag.id !== e.pointerId) { S.dr = 1; S.driftTouch = e.pointerId; return } // 第二指=漂移
    if (!S.drag) S.drag = { id: e.pointerId, x0: x, y0: y, x, y, y0th: y, st: 0 }
  })
  cv.addEventListener('pointermove', (e) => {
    if (!S.drag || S.drag.id !== e.pointerId) return
    S.drag.x = e.offsetX
    const dy = e.offsetY - S.drag.y0
    if (dy < -40) S.th = 1
    else if (dy > 55) S.th = -1
    else if (Math.abs(dy) <= 30) S.th = 1
  })
  function upInput(e) {
    if (S.driftTouch === e.pointerId) { S.dr = 0; S.driftTouch = null }
    if (S.drag && S.drag.id === e.pointerId) { S.drag = null; S.th = 1 }
  }
  cv.addEventListener('pointerup', upInput)
  cv.addEventListener('pointercancel', upInput)

  /* =====================================================================
   * 主循环：20Hz 预测步进（rAF 累积器）+ 60fps 渲染插值
   * ===================================================================== */
  let lastT = performance.now(), acc = 0
  function frame(t) {
    const dt = Math.min(100, t - lastT); lastT = t; now = t
    acc += dt
    while (acc >= S.tickMs) {
      acc -= S.tickMs
      simStep()
    }
    draw(t)
    requestAnimationFrame(frame)
  }
  function simStep() {
    if (S.mode === 'debug') { debugStep(); return }
    if (!S.pred || S.seat < 0) return
    const inp = localInput()
    /* 20Hz 上行（心跳兼保活，§5.1）；countdown 期禁油门防抢跑罚（§2.8 末 10 tick） */
    const up = { st: inp.st, th: S.phase === 'countdown' ? 0 : inp.th, dr: inp.dr }
    if (S.conn && S.conn.readyState === 1 && now - S.lastSend >= S.tickMs - 2) {
      S.lastSend = now
      S.seq++
      S.conn.send(JSON.stringify({ t: 'input', frame: S.seq, keys: up }))
      S.sentLog.push({ q: S.seq, tick: S.simTick })
      if (S.sentLog.length > 96) S.sentLog.shift()
    }
    /* 本地预测：push 于预计生效拍（simTick+flight），影子和服务器同序消费 */
    S.pred.setPhase(S.phase)
    S.pred.push(S.simTick + S.flight, up)
    S.pred.advanceTo(S.simTick)
    for (const ev of S.pred.drainEvents()) {
      if (ev.k === 'lap') {
        S.lapLocal.push(ev.ms)
        S.lapBanner = { lap: ev.lap, ms: ev.ms, t0: now }
        sfx.play('lap', String(ev.lap))
        if (!S.best || ev.ms < S.best) { S.best = ev.ms; sfx.play('pb', '') }
      }
    }
    S.simTick++
    /* 本地时钟护栏：不超前权威帧 flight+10（快照断流时防开环跑飞） */
    if (S.lastFrame != null && S.simTick - S.lastFrame > S.flight + 10) S.simTick = S.lastFrame + S.flight + 10
  }

  /* =====================================================================
   * 渲染（§3.2/§7：镜头旋进+速度缩放+motion 线+路缘石识图锚）
   * ===================================================================== */
  const g = cv.getContext('2d')
  let edgeCache = null   // {trackId, inner:[], outer:[]} 边缘折线（法向偏移，一次性派生）
  function buildEdges() {
    if (edgeCache && edgeCache.trackId === S.track.id) return
    const tr = S.tr, n = tr.n, half = tr.W / 2
    const inner = [], outer = []
    for (let i = 0; i < n; i++) {
      const tx = tr.tan[i * 2] / 65536, ty = tr.tan[i * 2 + 1] / 65536
      const nx = -ty, ny = tx
      const px = tr.pts[i * 2] / 1000, py = tr.pts[i * 2 + 1] / 1000
      inner.push(px + nx * half, py + ny * half)
      outer.push(px - nx * half, py - ny * half)
    }
    edgeCache = { trackId: S.track.id, inner, outer }
  }
  /* 视口裁剪窗：以镜头为中心 ±R 的采样窗（idx 起止） */
  function viewWindow(cx, cy, R) {
    const tr = S.tr
    const idx0 = nearestIdxApprox(cx, cy)
    const span = Math.ceil(R / (tr.stepM / 1000)) + 2
    return { from: idx0 - span, to: idx0 + span }
  }
  function nearestIdxApprox(x, y) {
    const tr = S.tr
    // 粗网格桶（一次性派生）：镜头→最近中心线采样点 → 视口裁剪窗锚
    if (!buildEdges.grid) {
      const gr = new Map(), cell = Math.max(tr.world / 1000, 1) / 10
      for (let i = 0; i < tr.n; i++) {
        const key = ((tr.pts[i * 2] / 1000 / cell) | 0) + ',' + ((tr.pts[i * 2 + 1] / 1000 / cell) | 0)
        if (!gr.has(key)) gr.set(key, [])
        gr.get(key).push(i)
      }
      buildEdges.grid = { gr, cell }
    }
    const { gr, cell } = buildEdges.grid
    const key = ((x / cell) | 0) + ',' + ((y / cell) | 0)
    const arr = gr.get(key)
    if (arr) {
      let best = arr[0], bd = Infinity
      for (const i of arr) {
        const d = (tr.pts[i * 2] / 1000 - x) ** 2 + (tr.pts[i * 2 + 1] / 1000 - y) ** 2
        if (d < bd) { bd = d; best = i }
      }
      return best
    }
    // 邻桶
    let best = 0, bd = Infinity
    for (let i = 0; i < tr.n; i += 4) {
      const d = (tr.pts[i * 2] / 1000 - x) ** 2 + (tr.pts[i * 2 + 1] / 1000 - y) ** 2
      if (d < bd) { bd = d; best = i }
    }
    return best
  }
  function strokeWindow(pts, win, fn) {
    const tr = S.tr, n = tr.n
    g.beginPath()
    for (let i = win.from; i <= win.to; i++) {
      const j = ((i % n) + n) % n
      const x = pts[j * 2], y = pts[j * 2 + 1]
      if (i === win.from) g.moveTo(x, y); else g.lineTo(x, y)
    }
    fn()
  }
  function fmt(ms) {
    const s = Math.max(0, ms) / 1000
    return s >= 60 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : s.toFixed(2)
  }

  function draw(t) {
    g.setTransform(1, 0, 0, 1, 0, 0)
    /* 底：暮色渐变 */
    const bg = g.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, BG1); bg.addColorStop(1, BG2)
    g.fillStyle = bg
    g.fillRect(0, 0, W, H)
    if (!S.tr) { drawBoot(); return }
    buildEdges()
    const sh = S.pred ? S.pred.kart() : null
    const me = S.mode === 'debug' ? debugKart() : (S.seat >= 0 ? sh : remoteHead())
    /* 视觉自车：混合带/软收敛（§5.1 ③——状态采重放值，视觉 20%/帧 逼近） */
    if (S.seat >= 0 && sh) {
      if (!S.vis) S.vis = { x: sh.x, y: sh.y, a: sh.a }
      if (S.blend) {
        /* 硬回滚混合带：120ms 从当前视觉位向重放态收敛，每帧 ≤2.5px（§5.3 撕裂预算） */
        const p = Math.min(1, (now - S.blend.t0) / 120)
        const k = 0.18 + p * 0.5
        S.vis.x += (sh.x - S.vis.x) * k
        S.vis.y += (sh.y - S.vis.y) * k
        if (p >= 1 || Math.abs(sh.x - S.vis.x) < 500) S.blend = null
      } else {
        /* 软收敛：状态采重放值，视觉 35%/帧 逼近（~100ms 抹平） */
        S.vis.x += (sh.x - S.vis.x) * 0.35
        S.vis.y += (sh.y - S.vis.y) * 0.35
      }
      S.vis.a = sh.a
    }
    const vis = S.seat >= 0 && S.vis ? S.vis : (me ? { x: me.x, y: me.y, a: me.a } : null)
    if (!vis) { drawBoot(); return }
    /* 镜头（§3.2）：旋进+前视 90px+lerp 12%；zoom 速度带+boost punch */
    const v = (me && me.v) || 0
    const vK = Math.min(1, v / 16500)
    cam.zT = 1.00 - 0.16 * vK
    if (S.zoomP > 0) { cam.zT -= 0.04 * S.zoomP; S.zoomP *= 0.85; if (S.zoomP < 0.02) S.zoomP = 0 }
    cam.zoom += (cam.zT - cam.zoom) * 0.08
    const look = 90 * 1000
    const fwdX = Math.cos(vis.a * Math.PI / 32768), fwdY = Math.sin(vis.a * Math.PI / 32768)
    const tx = vis.x + fwdX * look, ty = vis.y + fwdY * look
    cam.x += (tx - cam.x) * 0.12; cam.y += (ty - cam.y) * 0.12
    /* 旋进角：车头朝上 → 世界旋转 -a-90° */
    const rot = (-(vis.a * Math.PI / 32768) - Math.PI / 2)
    let sx = 0, sy = 0
    if (S.shake > 0 && now - S.shakeT < 240) { sx = (Math.random() - 0.5) * S.shake; sy = (Math.random() - 0.5) * S.shake } else S.shake = 0
    g.save()
    g.translate(W / 2 + sx, H * 0.62 + sy)
    g.scale(cam.zoom, cam.zoom)
    g.rotate(rot)
    g.translate(-cam.x / 1000, -cam.y / 1000)
    /* 草坪底（开放护墙赛道） */
    g.fillStyle = S.track.id === 't-neon' ? '#141020' : GRASS
    const R = 1400
    g.fillRect(cam.x / 1000 - R, cam.y / 1000 - R, R * 2, R * 2)
    /* 赛道：沥青带宽+路缘石（红白虚线=识图主锚，§7） */
    const win = viewWindow(cam.x / 1000, cam.y / 1000, 900)
    const tr = S.tr
    strokeWindow(tr.pts, win, () => { g.lineWidth = tr.W; g.strokeStyle = ASPH; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke() })
    g.setLineDash([14, 14])
    strokeWindow(edgeCache.inner, win, () => { g.lineWidth = 7; g.strokeStyle = S.track.id === 't-neon' ? NEON.cyan : CURB_A; g.stroke() })
    strokeWindow(edgeCache.outer, win, () => { g.lineWidth = 7; g.strokeStyle = S.track.id === 't-neon' ? NEON.mag : CURB_B; g.stroke() })
    g.setLineDash([])
    /* 远车（100ms 插值缓冲+迟到外推 1 张） */
    const rdt = now - 100
    for (const [, r] of S.remote) {
      const p = remoteSample(r)
      if (p) drawKart(p.x, p.y, p.a, r.car, r.seat, r.dr, false)
    }
    /* 自车 */
    if (S.seat >= 0 && sh) drawKart(vis.x / 1000, vis.y / 1000, sh.a, sh.car, S.seat, sh.dr, true, sh)
    /* 粒子（世界系） */
    drawPartsWorld()
    g.restore()
    /* 屏系 juice：motion 线 + 闪光 + HUD */
    drawMotion(v)
    if (S.flash > 0) { g.globalAlpha = S.flash * 0.35; g.fillStyle = S.flashC; g.fillRect(0, 0, W, H); g.globalAlpha = 1; S.flash *= 0.9; if (S.flash < 0.03) S.flash = 0 }
    drawHUD(t, v)
    fpsTick(t)
  }
  function remoteHead() { const r = S.remote.get(S.ranks[0]); if (!r) return null; const p = remoteSample(r); return p ? { x: p.x * 1000, y: p.y * 1000, a: p.a, v: 12000 } : null }
  function remoteSample(r) {
    if (!r.buf.length) return null
    const t2 = S.simTick - 2   // 渲染延迟 100ms=2 tick
    let a = r.buf[0], b = r.buf[r.buf.length - 1]
    for (let i = 0; i + 1 < r.buf.length; i++) if (r.buf[i].t <= t2 && r.buf[i + 1].t > t2) { a = r.buf[i]; b = r.buf[i + 1]; break }
    if (t2 >= b.t) { a = b; b = { t: b.t + 2, x: b.x + (b.x - a.x), y: b.y + (b.y - a.y), a: b.a } } // 迟到外推 1 张
    const f = b.t === a.t ? 0 : Math.max(0, Math.min(1.5, (t2 - a.t) / (b.t - a.t)))
    return { x: (a.x + (b.x - a.x) * f) / 1000, y: (a.y + (b.y - a.y) * f) / 1000, a: a.a }
  }
  function drawKart(x, y, a, car, seat, drift, isMe, sh) {
    g.save()
    g.translate(x, y)
    g.rotate(a * Math.PI / 32768)
    /* 阴影 */
    g.fillStyle = 'rgba(0,0,0,0.3)'
    g.beginPath(); g.ellipse(0, 2, 20, 12, 0, 0, 7); g.fill()
    /* 车身 36×22（§2.1）+ 滑角侧画（sh.d 偏移尾ness 简化=漂移尾灯） */
    const col = SEAT_COL[seat % 6]
    g.fillStyle = col
    roundRect(-11, -18, 22, 36, 6); g.fill()
    g.fillStyle = 'rgba(0,0,0,0.35)'
    g.fillRect(-8, -4, 16, 10)
    /* 席位形状标（色盲二次编码，§7） */
    drawShape(0, 6, seat, isMe)
    /* 漂移烟/尾流 */
    if (drift && Math.random() < 0.6) S.parts.push({ x: x * 1000, y: y * 1000, vx: (Math.random() - 0.5) * 400, vy: (Math.random() - 0.5) * 400, life: 0.7, c: 'rgba(200,200,210,0.5)', sz: 5, world: 1 })
    if (sh && sh.bo > 0) S.parts.push({ x: x * 1000, y: y * 1000, vx: -Math.cos(a * Math.PI / 32768) * 1200, vy: -Math.sin(a * Math.PI / 32768) * 1200, life: 0.4, c: '#FFD166', sz: 3, world: 1 })
    if (isMe) { /* 名签不画自己 */ }
    else {
      g.rotate(-a * Math.PI / 32768)
      g.font = HF('P2', 'name', 9)
      g.fillStyle = DIM; g.textAlign = 'center'
      g.fillText(nameOf(seat), 0, -24)
      g.rotate(a * Math.PI / 32768)
    }
    g.restore()
  }
  function nameOf(seat) {
    const r = S.roster.find((x) => x.seat === seat)
    return r && r.name ? r.name : 'P' + (seat + 1)
  }
  function drawShape(x, y, seat, isMe) {
    const col = isMe ? '#FFFFFF' : SEAT_COL[(seat + 3) % 6]
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2
    const s = SEAT_SHAPE[seat % 6]
    g.beginPath()
    if (s === 'circle') g.arc(x, y, 4, 0, 7)
    else if (s === 'tri') { g.moveTo(x, y - 5); g.lineTo(x + 5, y + 4); g.lineTo(x - 5, y + 4); g.closePath() }
    else if (s === 'square') g.rect(x - 4, y - 4, 8, 8)
    else if (s === 'dia') { g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath() }
    else if (s === 'cross') { g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke(); return }
    else { for (let i = 0; i < 5; i++) { const A = -Math.PI / 2 + i * Math.PI * 2 / 5; const B = A + Math.PI / 5; g[i ? 'lineTo' : 'moveTo'](x + Math.cos(A) * 5, y + Math.sin(A) * 5); g.lineTo(x + Math.cos(B) * 2, y + Math.sin(B) * 2) } g.closePath() }
    if (s !== 'cross') g.fill()
  }
  function roundRect(x, y, w2, h2, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w2, y, x + w2, y + h2, r); g.arcTo(x + w2, y + h2, x, y + h2, r); g.arcTo(x, y + h2, x, y, r); g.arcTo(x, y, x + w2, y, r); g.closePath() }
  function drawPartsWorld() {
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i]
      if (!p.world) continue
      p.life -= 0.03
      if (p.life <= 0) { S.parts.splice(i, 1); continue }
      p.x += p.vx * 0.016 * 1000 / 60; p.y += p.vy * 0.016 * 1000 / 60
      g.globalAlpha = Math.max(0, p.life)
      g.fillStyle = p.c
      g.fillRect(p.x / 1000 - p.sz / 2, p.y / 1000 - p.sz / 2, p.sz, p.sz)
      g.globalAlpha = 1
    }
  }
  function drawMotion(v) {
    const vPx = v / 1000 / 20
    if (vPx < 120) return
    const n = Math.min(7, Math.floor(vPx / 45))
    g.strokeStyle = 'rgba(232,236,243,0.16)'
    g.lineWidth = 2
    for (let i = 0; i < n; i++) {
      const x = i % 2 ? W - 8 - (i >> 1) * 12 : 8 + (i >> 1) * 12
      const len = 30 + (vPx % 80) + i * 8
      const y = ((now / 4 + i * 97) % (H + len)) - len
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + len); g.stroke()
    }
  }
  /* ---------- HUD（§7：顶栏 56+迷你图 Ø96+蓄力条+漂移钮；HF 登记） ---------- */
  function drawHUD(t, v) {
    const me = S.pred ? S.pred.kart() : null
    /* 顶栏底 */
    g.fillStyle = 'rgba(20,16,32,0.82)'
    g.fillRect(0, 0, W, TOP_H)
    g.strokeStyle = 'rgba(201,168,232,0.25)'; g.lineWidth = 1
    g.beginPath(); g.moveTo(0, TOP_H - 0.5); g.lineTo(W, TOP_H - 0.5); g.stroke()
    const rank = me ? S.ranks.indexOf(S.seat) + 1 : 0
    /* P 位次（P0） */
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'
    g.font = HF('P0', 'pos', 13, '600'); g.fillStyle = INK
    g.fillText('P' + (rank || '—'), 10, 22)
    g.font = HF('P1', 'posOf', 11); g.fillStyle = DIM
    g.fillText('/6', g.measureText('P' + (rank || '—')).width + 16, 22)
    /* 圈数（P0） */
    const lapN = me ? Math.min(me.laps + 1, S.L) : 0
    g.font = HF('P0', 'lap', 13, '600'); g.fillStyle = INK
    const lapTxt = '圈 ' + (lapN || '—') + '/' + S.L
    g.fillText(lapTxt, 10, 44)
    /* 本圈计时（P0） */
    g.font = HF('P0', 'lapTime', 13, '600'); g.fillStyle = '#C9A8E8'
    const curMs = me && me.lapT0 && S.phase === 'race' ? (S.simTick - me.lapT0) * S.tickMs : 0
    g.fillText(fmt(curMs), 100, 44)
    /* 最佳圈（P1） */
    g.font = HF('P1', 'best', 11); g.fillStyle = DIM
    g.fillText('最佳 ' + (S.best ? fmt(S.best) : '—'), 100, 22)
    /* T7-A ping 徽标（P0 13/600 升档，§3.3）：三档色+「预测中」副行 */
    const pcol = S.ping <= 80 ? '#3DDC84' : S.ping <= 160 ? '#FFD166' : '#FF8A65'
    g.textAlign = 'right'
    g.font = HF('P0', 'ping', 13, '600'); g.fillStyle = S.seat >= 0 ? pcol : DIM
    g.fillText('PING ' + (S.ping || '—') + 'ms', W - 10, 22)
    g.font = HF('P1', 'predOn', 11); g.fillStyle = S.seat >= 0 ? pcol : DIM
    g.fillText(S.seat >= 0 ? '预测中' : '旁观', W - 10, 42)
    g.textAlign = 'left'
    /* 徽标详情卡（T7-A：点击展开——RTT/抖动/和解修正 10s 窗） */
    if (S.pingOpen) {
      const x0 = W - 178, y0 = TOP_H + 8
      g.fillStyle = 'rgba(20,16,32,0.94)'; roundRect(x0, y0, 168, 92, 8); g.fill()
      g.strokeStyle = 'rgba(201,168,232,0.4)'; g.stroke()
      g.font = HF('P1', 'pingCard', 11); g.fillStyle = INK
      const jr = jitter()
      const rec = S.recon.filter((r) => now - r.t < 10000)
      const recAvg = rec.length ? (rec.reduce((a, b) => a + b.px, 0) / rec.length).toFixed(1) : '0.0'
      g.fillText('RTT 中位 ' + (S.ping || '—') + 'ms', x0 + 10, y0 + 20)
      g.fillText('抖动 ±' + jr + 'ms', x0 + 10, y0 + 38)
      g.fillText('和解修正(10s) ' + rec.length + ' 次', x0 + 10, y0 + 56)
      g.fillText('单次均值 ' + recAvg + 'px', x0 + 10, y0 + 74)
    }
    /* 迷你图 Ø96（右上，整圈轮廓+6 色点） */
    drawMinimap()
    /* 倒计时（P0 大字脉冲） */
    if (S.phase === 'countdown') {
      const left = Math.max(0, Math.ceil((60 - S.simTick) * S.tickMs / 1000))
      const ph = 1 - ((60 - S.simTick) * S.tickMs % 1000) / 1000
      g.font = HF('P0', 'count', 44 - (1 - ph) * 10, '700')
      g.textAlign = 'center'; g.fillStyle = '#FFD166'
      g.globalAlpha = 0.4 + ph * 0.6
      g.fillText(String(left || 'GO'), W / 2, H / 2 - 40)
      g.globalAlpha = 1; g.textAlign = 'left'
      if (left !== S.lastCount) { S.lastCount = left; sfx.play('count', String(left)) }
    }
    if (S.phase !== 'countdown' && S.greenAt && now - S.greenAt < 600) {
      g.font = HF('P0', 'go', 40, '700'); g.textAlign = 'center'; g.fillStyle = '#7FE8D8'
      g.fillText('GO!', W / 2, H / 2 - 40); g.textAlign = 'left'
    }
    /* 抢跑罚红字 */
    if (now < S.penUntil) { g.font = HF('P1', 'pen', 11, '600'); g.fillStyle = '#FF6B5C'; g.textAlign = 'center'; g.fillText('抢跑罚：禁油门 1s', W / 2, H / 2 - 70); g.textAlign = 'left' }
    /* 圈速横幅（1.2s，§3.5） */
    if (S.lapBanner && now - S.lapBanner.t0 < 1200) {
      const a = 1 - (now - S.lapBanner.t0) / 1200
      g.globalAlpha = a
      g.fillStyle = 'rgba(20,16,32,0.85)'; roundRect(W / 2 - 110, H / 2 - 26, 220, 44, 10); g.fill()
      g.font = HF('P0', 'lapBan', 15, '600'); g.fillStyle = '#FFD166'; g.textAlign = 'center'
      g.fillText('圈 ' + S.lapBanner.lap + ' · ' + fmt(S.lapBanner.ms) + (S.best === S.lapBanner.ms ? ' ★PB' : ''), W / 2, H / 2 + 2)
      g.globalAlpha = 1; g.textAlign = 'left'
    }
    /* 左下：漂移蓄力条（两段刻度）+油门档（P1） */
    if (me && S.seat >= 0) {
      const bx = 12, by = H - 88, bw = 96, bh = 10
      g.fillStyle = 'rgba(20,16,32,0.8)'; roundRect(bx - 4, by - 4, bw + 8, bh + 8, 5); g.fill()
      const chMax = 45
      const chW = Math.min(1, me.ch / chMax) * bw
      g.fillStyle = me.tier >= 2 ? '#E86BC9' : me.tier === 1 ? '#FFD166' : '#5CD9E8'
      g.fillRect(bx, by, chW, bh)
      g.strokeStyle = 'rgba(232,236,243,0.5)'
      g.beginPath(); g.moveTo(bx + bw * 20 / 45, by); g.lineTo(bx + bw * 20 / 45, by + bh); g.stroke()
      g.font = HF('P1', 'charge', 11); g.fillStyle = DIM
      g.fillText('漂移' + (me.tier >= 2 ? 'Ⅱ' : me.tier === 1 ? 'Ⅰ' : ''), bx, by - 8)
      g.fillText('油门 ' + (S.th > 0 ? '▲' : S.th < 0 ? '▼' : '—'), bx, by + 26)
    }
    /* 右下漂移钮 Ø72（P1 ≥11） */
    g.globalAlpha = S.dr ? 1 : 0.72
    g.fillStyle = S.dr ? '#E86BC9' : 'rgba(232,107,201,0.35)'
    g.beginPath(); g.arc(DRIFT_BTN.x, DRIFT_BTN.y, DRIFT_BTN.r, 0, 7); g.fill()
    g.strokeStyle = '#E86BC9'; g.lineWidth = 2; g.stroke()
    g.font = HF('P1', 'driftBtn', 12, '600'); g.fillStyle = INK; g.textAlign = 'center'
    g.fillText('漂移', DRIFT_BTN.x, DRIFT_BTN.y + 4)
    g.globalAlpha = 1; g.textAlign = 'left'
    /* 页脚 slug·version（P2 ≥9） */
    g.font = HF('P2', 'foot', 9); g.fillStyle = 'rgba(139,147,167,0.6)'
    g.fillText('speed-kart · v1.0.0 · S7', 8, H - 8)
    /* hash 哨兵告警 */
    if (S.hashWarn) { g.font = HF('P1', 'hashWarn', 11, '600'); g.fillStyle = '#FF8A65'; g.fillText('⚠ 网络模式降级（校验分歧）', 10, TOP_H + 16) }
    if (S.connLost && !S.end) { g.fillStyle = 'rgba(20,16,32,0.7)'; g.fillRect(0, H / 2 - 30, W, 60); g.font = HF('P1', 'lost', 12, '600'); g.fillStyle = '#FF8A65'; g.textAlign = 'center'; g.fillText('连接已断开（10s 内重连可夺回席位）', W / 2, H / 2 + 4); g.textAlign = 'left' }
    if (S.err) { g.font = HF('P1', 'err', 11); g.fillStyle = '#FF6B5C'; g.textAlign = 'center'; g.fillText(S.err, W / 2, H / 2 + 30); g.textAlign = 'left' }
    /* 结算页（T7-A 下半：名次+每圈双条对照+再来一局） */
    if (S.end) drawSettle()
  }
  function jitter() { if (S.pings.length < 2) return 0; const mx = Math.max(...S.pings), mn = Math.min(...S.pings); return Math.round((mx - mn) / 2) }
  function drawMinimap() {
    const tr = S.tr, M = 96, mx = W - M / 2 - 10, my = TOP_H + M / 2 + 10
    const sc = (M - 14) / (tr.world / 1000)
    g.fillStyle = 'rgba(20,16,32,0.7)'
    g.beginPath(); g.arc(mx, my, M / 2, 0, 7); g.fill()
    g.strokeStyle = 'rgba(201,168,232,0.5)'; g.lineWidth = 1; g.stroke()
    g.strokeStyle = 'rgba(232,236,243,0.75)'; g.lineWidth = 2
    g.beginPath()
    for (let i = 0; i <= tr.n; i += 3) {
      const j = i % tr.n
      const x = mx + (tr.pts[j * 2] / 1000 - tr.world / 2000) * sc
      const y = my + (tr.pts[j * 2 + 1] / 1000 - tr.world / 2000) * sc
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
    }
    g.closePath(); g.stroke()
    /* 起跑线标记 */
    g.fillStyle = '#FFD166'
    g.fillRect(mx + (tr.pts[0] / 1000 - tr.world / 2000) * sc - 2, my + (tr.pts[1] / 1000 - tr.world / 2000) * sc - 2, 4, 4)
    /* 6 色点 */
    const put = (x, y, seat, me2) => {
      g.fillStyle = SEAT_COL[seat % 6]
      g.beginPath(); g.arc(mx + (x / 1000 - tr.world / 2000) * sc, my + (y / 1000 - tr.world / 2000) * sc, me2 ? 4 : 3, 0, 7); g.fill()
      if (me2) { g.strokeStyle = '#FFF'; g.lineWidth = 1.5; g.stroke() }
    }
    for (const [, r] of S.remote) { const p = remoteSample(r); if (p) put(p.x * 1000, p.y * 1000, r.seat, false) }
    const me = S.pred ? S.pred.kart() : null
    if (me && S.seat >= 0) put(me.x, me.y, S.seat, true)
    else if (S.mode === 'debug' && debugKart()) put(debugKart().x, debugKart().y, 0, true)
  }
  function drawSettle() {
    g.fillStyle = 'rgba(12,8,20,0.92)'
    g.fillRect(0, 0, W, H)
    g.textAlign = 'center'
    g.font = HF('P0', 'settleTitle', 20, '700'); g.fillStyle = '#FFD166'
    g.fillText('完赛', W / 2, 84)
    /* 名次列表（P0） */
    const fin = []
    const order = S.ranks.slice()
    for (const seat of order) {
      const isMe = seat === S.seat
      const laps = seat === S.seat ? S.lapSrv : (S.remote.get(seat) || {}).laps || 0
      const best = seat === S.seat ? S.best : (S.remote.get(seat) || {}).best || 0
      fin.push({ seat, isMe, laps, best })
    }
    g.font = HF('P0', 'settleRow', 14, '600')
    fin.slice(0, 6).forEach((f, i) => {
      const y = 130 + i * 30
      g.fillStyle = f.isMe ? '#FFD166' : INK
      g.textAlign = 'left'
      g.fillText('P' + (i + 1) + '  ' + nameOf(f.seat), 60, y)
      g.textAlign = 'right'
      g.fillText(f.laps + ' 圈 · ' + (f.best ? fmt(f.best) : '—'), W - 60, y)
    })
    /* T7-A 延迟补偿圈速对照（每圈：本地感知 vs 判定；差值=链路吃掉的圈时） */
    g.textAlign = 'center'
    g.font = HF('P1', 'dualT', 11, '600'); g.fillStyle = '#C9A8E8'
    g.fillText('延迟补偿圈速对照（本地 vs 判定）', W / 2, 330)
    g.font = HF('P1', 'dual', 11)
    const L2 = Math.max(S.lapLocal.length, S.lapSrv.length)
    for (let i = 0; i < Math.min(L2, 5); i++) {
      const y = 356 + i * 30
      const loc = S.lapLocal[i], sv = S.lapSrv[i]
      g.textAlign = 'left'; g.fillStyle = '#5CD9E8'
      g.fillText('圈' + (i + 1) + ' 本地 ' + (loc ? fmt(loc) : '—'), 46, y)
      g.fillStyle = DIM
      g.fillText('判定 ' + (sv ? fmt(sv) : '—'), 46, y + 13)
      if (loc && sv) {
        const d = (sv - loc) / sv
        g.textAlign = 'right'
        if (Math.abs(d) <= 0.005) { g.fillStyle = '#3DDC84'; g.fillText('补偿归零', W - 46, y + 6) }
        else { g.fillStyle = '#FF8A65'; g.fillText('链路 ' + ((sv - loc) / 1000).toFixed(3) + 's 已回填', W - 46, y + 6) }
      }
      /* 双条 */
      const bw = 90
      g.fillStyle = '#5CD9E8'; g.fillRect(180, y - 8, Math.min(1, loc ? loc / 60000 : 0) * bw, 5)
      g.fillStyle = DIM; g.fillRect(180, y - 1, Math.min(1, sv ? sv / 60000 : 0) * bw, 5)
    }
    /* 再来一局（tap 区） */
    g.fillStyle = 'rgba(255,209,102,0.2)'; roundRect(W / 2 - 90, H - 120, 180, 44, 10); g.fill()
    g.strokeStyle = '#FFD166'; g.stroke()
    g.font = HF('P1', 'again', 13, '600'); g.fillStyle = '#FFD166'; g.textAlign = 'center'
    g.fillText('再来一局', W / 2, H - 92)
    g.font = HF('P2', 'back', 10); g.fillStyle = DIM
    g.fillText('点上方按钮重开 · 关页回大厅', W / 2, H - 64)
    g.textAlign = 'left'
  }
  /* 结算页按钮命中 */
  cv.addEventListener('pointerup', (e) => {
    if (!S.end) return
    const x = e.offsetX, y = e.offsetY
    if (x > W / 2 - 90 && x < W / 2 + 90 && y > H - 120 && y < H - 76) location.reload()
  })
  /* ping 徽标点击展开详情卡 */
  cv.addEventListener('pointerup', (e) => {
    if (e.offsetX > W - 110 && e.offsetY < TOP_H) S.pingOpen = !S.pingOpen
  })

  function drawBoot() {
    g.font = HF('P2', 'boot', 11); g.fillStyle = DIM; g.textAlign = 'center'
    g.fillText(S.connLost ? '重连中…' : '连接赛道…', W / 2, H / 2)
    g.textAlign = 'left'
  }

  /* ---------- fps 表（perf-smoke 口径） ---------- */
  let fpsN = 0, fpsT0 = 0
  function fpsTick(t) {
    if (!fpsT0) fpsT0 = t
    fpsN++
    if (fpsN % 30 === 0) { S.fpsShown = Math.round(fpsN / ((t - fpsT0) / 1000)) ; fpsT0 = t; fpsN = 0 }
  }

  /* =====================================================================
   * debug 本地竞技场（?debug=1，perf-smoke 契约：boot → start(1) → rAF 采样）
   * 6 车+3 档 bot 本地 sim（K.create/brain/step），同渲染路径零分叉。
   * ===================================================================== */
  let DBG = null
  function startDebugArena() {
    const track = new URLSearchParams(location.search).get('track') || 't-canyon'
    DBG = {
      st: K.create(20261011, { track }),
      room: { seats: [{ seat: 0, kind: 'human' }, { seat: 1, kind: 'bot' }, { seat: 2, kind: 'bot' }, { seat: 3, kind: 'bot' }, { seat: 4, kind: 'bot' }, { seat: 5, kind: 'bot' }] },
      rngs: [],
      pred: K.makePredictor(track),
      acc: 0, last: performance.now(),
    }
    for (let i = 0; i < 6; i++) DBG.rngs[i] = K.mulberry32(77 + i)
    S.mode = 'debug'; S.seat = 0
    S.track = DBG.st.track; S.tr = K.TRACKS[S.track.id]; S.L = S.track.laps
    S.roster = DBG.room.seats.map((s) => ({ seat: s.seat, kind: s.kind, name: '车手' + (s.seat + 1) }))
    S.pred = DBG.pred
    S.phase = DBG.st.phase; S.ranks = DBG.st.ranks; S.tickMs = 50
    const me = DBG.st.karts[0]
    S.pred.setPhase(S.phase); S.pred.anchor(me, 0)
    S.vis = { x: me.x, y: me.y, a: me.a }
    cam.x = me.x; cam.y = me.y; cam.ang = me.a
    S.remote.clear()
    S.remoteTick = 0
  }
  function debugKart() { return DBG ? DBG.st.karts[0] : null }
  function debugStep() {
    const st = DBG.st
    const inputs = {}
    for (let i = 1; i < 6; i++) inputs[i] = K.brain(st, i, ['casual', 'balanced', 'competitive', 'balanced', 'casual'][i - 1], DBG.rngs[i])
    /* 我席=赛车线 autopilot（手感样本：真输入走预测器路径） */
    const my = K.policyInput({ track: { id: S.track.id }, karts: st.karts }, 0)
    inputs[0] = { q: st.tick, st: my.st, th: my.th, dr: my.dr }
    const r = K.step(st, inputs, DBG.room)
    for (const ev of r.events) onEvent(ev)
    /* 预测器同跑（渲染/进度路径与在线同径） */
    S.pred.setPhase(st.phase)
    S.pred.anchor(st.karts[0], st.tick)
    S.pred.advanceTo(st.tick)
    S.simTick = st.tick
    S.phase = st.phase; S.ranks = st.ranks
    /* 远车插值缓冲（同在线管线） */
    S.remoteTick++
    if (S.remoteTick % 2 === 0) for (const k of st.karts) if (k.seat !== 0) remotePut(k, st.tick)
    if (r.over && !S.end) S.end = r.result
  }

  /* =====================================================================
   * boot
   * ===================================================================== */
  window.__GAMES_DEBUG__ = {
    events: [],
    start(level) { startDebugArena(); report('start', { level }); return true },
    pause(v) { S.pauseViz = !!v; return true },   // visual-check 识图契约：冻结帧采样
    hudFonts: () => hudFontReg,
    fps: () => S.fpsShown,
    state: () => ({ mode: S.mode, seat: S.seat, phase: S.phase, tick: S.simTick, seq: S.seq, ping: S.ping, flight: S.flight, hashBad: S.hashBad, recon: S.recon.length, laps: S.lapLocal.length, remotes: S.remote.size }),
    sfxCalls: () => sfx.calls.slice(-40),
    sfxGroups: () => ({ slots: sfx.slots.slice(), calls: sfx.calls.slice(-64), on: sfx.on }),
    sound(v) { sfx.on = !!v; return sfx.on },
    netProbe() { return { ping: S.ping, flight: S.flight, recon10s: S.recon.filter((r) => performance.now() - r.t < 10000).length, hashBad: S.hashBad, lapLocal: S.lapLocal.slice(), lapSrv: S.lapSrv.slice() } },
  }
  const dbg = new URLSearchParams(location.search).get('debug')
  if (dbg === '1') {
    report('boot', { mode: 'debug' })
    startDebugArena()
  } else {
    report('boot', { mode: 'net' })
    connect()
    /* ping 环（1/s） */
    setInterval(() => {
      if (S.conn && S.conn.readyState === 1) S.conn.send(JSON.stringify({ t: 'ping', c: performance.now() }))
    }, 1000)
  }
  requestAnimationFrame(frame)
})()
