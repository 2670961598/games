/* =====================================================================
 * 极速卡丁 客户端（GAMES-109 · S7 预测与和解首证）。
 * 依赖前置：trig16.cjs / tracks.cjs / shared.cjs（window.KartSim——与服务端 sim
 * 同一段纯函数：integrate/progress/makePredictor，§5.1 单源纪律）。
 *
 * S7 三策略（设计 §5.1/附决策 7）：
 *   自车=本地预测 0ms 起步（drag 即转向，20Hz 采样+输入环形缓冲+上行 seq）+
 *   快照 ack 和解（权威锚点回滚重放未确认输入；Δpos≤6px 软收敛 35%/帧、
 *   >6px 硬回滚 120ms 混合带，撕裂预算 ≤2.5px/帧 §5.3——O-6 口径对齐：软收敛
 *   实值 0.35/帧，混合带帧位移封顶 F1 激活后落地）；
 *   他人车=100ms 插值缓冲（迟到外推 1 张 100ms，mmo §5.3 同式）——只回滚自己；
 *   本地圈账=预测器 progress 同跑（T7-A 结算对照条的"本地感知圈时"源，§3.4）。
 *
 * 渲染（§3.2/§7）：镜头旋进（车恒朝上）+速度缩放 1.00→0.84+motion 线+路缘石
 * 红白识图锚；HUD 字号对齐 hud-font-standard §1（HF 登记表+ping 徽标 P0 升档
 * ——T7-A 首个触发者，§3.3）。debug（?debug=1）：本地 6 车竞技场（同渲染路径，
 * perf-smoke 契约）。
 *
 * GAMES-113 手感层：动效 16 项（FXLIST 登记；fb 反馈类 ≤80ms 首绘红线——
 * fxTrig=事件侧落笔/fxDraw=首绘侧落笔双时戳台账）+胎痕/横摆倾斜/超车名次 juice
 * +相机前视速度带外扩+motion 线横摆跟随+音效位 13 槽（含引擎声部）。
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
    slots: ['green', 'engine', 'lap', 'pb', 'drift', 'boost', 'wall', 'bump', 'draft', 'count', 'fin', 'pass', 'pen'],
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
      else if (slot === 'engine') this.tone(90, 190, 0.5, 'sawtooth', 0.04)   // 引擎声部：绿灯起跑rev-up
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

  /* ---------- 动效登记表（GAMES-113 §3.5 juice 清单；fb=反馈类 ≤80ms 首绘红线，state=状态类）
   * 台账 fxTrig=事件侧落笔、fxDraw=首绘侧落笔，两时戳差=实测起效时延。 ---------- */
  const FXLIST = [
    ['F01', 'driftTire', 'fb'], ['F02', 'boostTrail', 'fb'], ['F03', 'lapBanner', 'fb'], ['F04', 'overtake', 'fb'],
    ['F05', 'rankPop', 'fb'], ['F06', 'wallSpark', 'fb'], ['F07', 'bumpFlash', 'fb'], ['F08', 'bodyRoll', 'fb'],
    ['F09', 'chargeBar', 'state'], ['F10', 'motionTilt', 'state'], ['F11', 'finishTape', 'fb'], ['F12', 'countPulse', 'state'],
    ['F13', 'camCurve', 'state'], ['F14', 'draftHint', 'fb'], ['F15', 'penFlash', 'fb'], ['F16', 'greenFlash', 'fb'],
  ]
  const fxLedgerArr = []
  function fxTrig(id) {
    /* t0=即时 performance.now（事件侧真实落笔时刻）——不用模块级 now：取证注入
     *（evaluate/截图间隙）下后者可滞后数百 ms，时延表会虚胖（GAMES-113 实测教训） */
    const ts = performance.now()
    const e = fxLedgerArr.find((x) => x.id === id)
    if (e) { e.t0 = ts; e.drawn = 0; e.n = (e.n || 0) + 1 } else fxLedgerArr.push({ id, t0: ts, drawn: 0, n: 1 })
  }
  function fxDraw(id) {
    const e = fxLedgerArr.find((x) => x.id === id)
    if (e && !e.drawn) e.drawn = performance.now()   /* 即时时戳：同帧首绘≈0ms（模块级 now 是帧起点戳，会得负值） */
  }
  /* 有符号角差（int16 域，渲染层专用——不扰 sim） */
  function angD(a, b) { let d = (a - b) & 0xffff; if (d > 32767) d -= 65536; return d }

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
    /* GAMES-113 juice 扩展：胎痕/名次/超车/闪白/彩带/尾流/漂移窗（fx 台账配套态） */
    marks: [], rankPop: 0, rankDir: 0, lastRank: 0, rankCur: 0, rankHold: null,
    passFlash: null, bumpFlash: null, draftT: 0, boostFx: 0, confettiT: 0, driftFx: 0,
    motionOn: 0, countTrig: 0, lastDr: 0,
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
  /* ?room= 参数维护（F9）：null=摘除（room-gone 兜底）；值=写入（quick 入房回写）。
   * replaceState 不留历史记录——回退/刷新拿到的是当前局，不经中间态 */
  function setRoomParam(rid) {
    try {
      const q = new URLSearchParams(location.search)
      if (rid == null) { if (!q.get('room')) return; q.delete('room') }
      else { if (q.get('room') === rid) return; q.set('room', rid) }
      const s = q.toString()
      history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash)
    } catch { /* file:// 等无 replaceState 环境不阻塞对局 */ }
  }
  function connect() {
    const ws = new WebSocket(gwOrigin())
    S.conn = ws
    ws.onopen = () => {
      const q = new URLSearchParams(location.search)
      const rid = q.get('room')
      if (rid) {
        let resume = null
        try { resume = JSON.parse(sessionStorage.getItem('spk-' + rid) || 'null') } catch { resume = null }
        ws.send(JSON.stringify({ t: 'join', roomId: rid, mode: q.get('mode') === 'spectate' ? 'spectate' : 'play', resume: resume ? { seat: resume.seat, token: resume.token } : undefined, name: '玩家' }))
      } else {
        /* F9（GAMES-111 同批）：join 恒带 roomId（WS 面契约）——原式无 rid 也发 join 必吃
           bad-msg 错误帧；quick 路径单独发 */
        ws.send(JSON.stringify({ t: 'quick', gameId: 'speed-kart' }))
      }
    }
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data) } catch { return } onMsg(m) }
    ws.onclose = () => { if (S.mode === 'playing' || S.mode === 'spectate') S.connLost = true }
    ws.onerror = () => { if (S.mode === 'playing' || S.mode === 'spectate') S.connLost = true }
  }
  function onMsg(m) {
    if (m.t === 'error') {
      /* F9（GAMES-111）：?room= 指向的房已终局/回收（再来一局、断线后刷新的常态路径）→
         摘参自动 quick 重开——reload 兜底闭环，横幅承诺可兑现 */
      if (m.code === 'room-gone' && S.mode === 'connecting' && !S.roomId) {
        setRoomParam(null)
        if (S.conn && S.conn.readyState === 1) S.conn.send(JSON.stringify({ t: 'quick', gameId: 'speed-kart' }))
        return
      }
      S.err = m.code || m.message; setTimeout(() => { S.err = '' }, 2500); return
    }
    if (m.t === 'welcome') {
      S.roomId = m.roomId; S.seat = m.role === 'player' ? m.seat : -1
      S.token = m.token; S.roster = (m.room && m.room.seats) || []
      S.tickMs = m.tickMs || 50
      if (m.token != null) { try { sessionStorage.setItem('spk-' + S.roomId, JSON.stringify({ seat: S.seat, token: S.token })) } catch {} }
      /* F9（GAMES-111）：quick 入房回写 ?room= —— reload 后 resume 凭真实 roomId 可达
         （原式读 spk-null 落空必进新房，断线横幅「10s 内重连可夺回席位」不可兑现） */
      if (m.token != null && S.seat >= 0) setRoomParam(S.roomId)
      /* O-5（GAMES-111）：welcome.prediction 声明块版本护栏（原零消费）——引擎指纹不符
         即常驻提示（CDN/缓存旧 shared.cjs 只能靠 hash 哨兵事后撞出，此处入房即拦） */
      const pd = m.room && m.room.prediction
      if (pd && pd.hash != null && pd.hash !== K.ENGINE_HASH) S.err = '引擎版本不一致，请刷新重试'
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
      S.ping = Math.max(1, Math.round(s[Math.floor(s.length / 2)]))   // LAN 亚毫秒也显示 1ms（徽标语义）
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
    const mExt = m.ext || {}
    const sh = S.pred.kart() || {}
    const auth = {
      seat: S.seat, car: k.car !== undefined ? k.car : (sh.car || 0),
      x: k.x, y: k.y, a: k.a,
      d: k.d !== undefined ? k.d : (mExt.pd && mExt.pd.d !== undefined ? mExt.pd.d : (sh.d !== undefined ? sh.d : k.a)), v: k.v,
      s: k.s !== undefined ? k.s : (mExt.pd && mExt.pd.s !== undefined ? mExt.pd.s : (sh.s || 0)),
      lat: k.lat !== undefined ? k.lat : (sh.lat || 0),
      idx: sh.idx || 0, cross: sh.cross || 0, laps: k.laps !== undefined ? k.laps : (sh.laps || 0),
      cp: (mExt.pd && mExt.pd.cp !== undefined ? mExt.pd.cp : (sh.cp || 1)), pOff: sh.pOff || 0, lapT0: sh.lapT0 || 0, lastLapTick: sh.lastLapTick || 0,
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
      if (S.simTick < m.frame) S.simTick = m.frame   // 本地时钟不得落后权威帧（先抬钟：修正前后同拍对照）
      /* F1（GAMES-111）：修正前预测态必须在 anchor 覆盖影子之前捕获——原式 before/after
         同为「锚点+重放」终态（第二次 advanceTo 空转），dPx 结构性 ≡0，recon 台账/软硬
         分流/混合带/撕裂预算全死码（QA1 §2.2）。pre 段事件弃置：重放段确定性同式再生
         （m.frame<simTick 时覆盖同拍），防圈点双记 */
      const pre = S.pred.advanceTo(S.simTick)
      S.pred.drainEvents()
      const preX = pre ? pre.x : auth.x, preY = pre ? pre.y : auth.y
      S.pred.anchor(auth, m.frame)
      const after = S.pred.advanceTo(S.simTick) || auth
      const dx = Math.abs(after.x - preX), dy = Math.abs(after.y - preY)
      const dPx = Math.max(dx, dy) / 1000
      if (dPx > 0.5) { S.recon.push({ t: performance.now(), px: dPx }); if (S.recon.length > 200) S.recon.shift() }
      /* ③ 软收敛/硬回滚（撕裂预算 §5.3） */
      if (dPx > 6) { S.blend = { x0: S.vis ? S.vis.x : after.x, y0: S.vis ? S.vis.y : after.y, t0: performance.now() } }
      /* ④ hash 哨兵（每 10 张）：分歧→sync 全量；连续 3 次上报告警 */
      if (m.ext && m.ext.hash) {
        /* F2（GAMES-111）：对合并权威态@F 取 hash（服务器同式 hashKart(karts[seat], F)）——
           原式哈影子@本地 simTick 配 F 帧前缀，simTick>F 即必分歧（健康领先态假告警：
           200ms 臂 hashWarn 闩锁=常驻降级横幅+sync 洪泛，QA1 §2.4）。增量快照 x/y/a/v+
           ext.pd 的 d/s/cp 凑齐 hashKart 八字段，合并完整性校验成立 */
        const mine = K.hashKart(auth, m.frame)
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
          sfx.play('lap', String(ev.lap)); fxTrig('F03')
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
    if (ev.k === 'green') {
      S.greenAt = performance.now(); S.flash = 1; S.flashC = '#7FE8D8'
      sfx.play('green', ''); sfx.play('engine', '')
      fxTrig('F16'); fxTrig('F09'); fxTrig('F13')   // 状态类（蓄力条/相机曲线）随绿灯激活
    }
    else if (ev.k === 'lap') {
      if (ev.seat === S.seat) {
        S.lapSrv.push(ev.ms); if (!S.best || ev.ms < S.best) S.best = ev.ms
        /* 在线局横幅归预测圈（本地先至，§3.4）；debug 局预测圈事件不经 drain，走事件侧同一位点 */
        if (S.mode === 'debug') {
          S.lapBanner = { lap: S.lapSrv.length, ms: ev.ms, t0: performance.now() }
          sfx.play('lap', String(S.lapSrv.length)); fxTrig('F03')
          if (S.best === ev.ms) sfx.play('pb', '')
        }
      }
      else if (ev.seat >= 0) { const r = S.remote.get(ev.seat); if (r) r.lastLap = ev.ms }
    }
    else if (ev.k === 'bump') {
      if (ev.a === S.seat || ev.b === S.seat) {
        S.shake = 4; S.shakeT = performance.now(); sfx.play('bump', String(ev.a))
        S.bumpFlash = { t0: performance.now(), seats: [ev.a, ev.b] }; fxTrig('F07')
      }
    }
    else if (ev.k === 'wall') {
      if (ev.seat === S.seat) { S.shake = 2; S.shakeT = performance.now(); S.sparks = 10; sfx.play('wall', ''); fxTrig('F06') }
    }
    else if (ev.k === 'boost') {
      if (ev.seat === S.seat) { S.zoomP = 1; sfx.play('boost', String(ev.tier)); S.boostFx = performance.now(); spawnJet(); fxTrig('F02') }
    }
    else if (ev.k === 'draft') { if (ev.seat === S.seat) { sfx.play('draft', ''); S.draftT = performance.now(); fxTrig('F14') } }
    else if (ev.k === 'finish') {
      if (ev.seat === S.seat) { sfx.play('fin', String(ev.pos)); S.flash = 1; S.flashC = '#FFD166'; S.confettiT = performance.now(); fxTrig('F11') }
    }
    else if (ev.k === 'jump') { if (ev.seat === S.seat) { S.penUntil = performance.now() + 1000; sfx.play('pen', ''); fxTrig('F15') } }
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
    if (S.pauseViz) { lastT = t; requestAnimationFrame(frame); return } // 识图/墨水带采样冻结帧（仅 debug 钩子可置位，net 局不触碰）
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
    /* 本地预测：push 于预计生效拍（simTick+flight），影子和服务器同序消费。
     * F4（GAMES-111 低危同批）：at 单调不回退——flight EMA 单步可降 ≥2 或快照断流恢复
     * 下钳 simTick 时，估算拍会倒序；环消费按 at 升序 shift（makePredictor §5.1），
     * 倒序条目迟消费且污染粘性 lastInp，强制 ≥ 前推+1 保到达序（服务器本就按到达序消费） */
    S.pred.setPhase(S.phase)
    const pushAt = Math.max(S.simTick + S.flight, (S.lastPushAt || 0) + 1)
    S.lastPushAt = pushAt
    S.pred.push(pushAt, up)
    S.pred.advanceTo(S.simTick)
    for (const ev of S.pred.drainEvents()) {
      if (ev.k === 'lap') {
        S.lapLocal.push(ev.ms)
        S.lapBanner = { lap: ev.lap, ms: ev.ms, t0: now }
        sfx.play('lap', String(ev.lap)); fxTrig('F03')
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
  let edgeCache = null   // {trackId, mid/inner/outer:[]} 折线（px 坐标，法向偏移，一次性派生）
  function buildEdges() {
    if (edgeCache && edgeCache.trackId === S.track.id) return
    const tr = S.tr, n = tr.n, half = tr.W / 2000   // tr.W 毫米 → px 半宽（/1000 再 /2）
    const mid = [], inner = [], outer = []
    for (let i = 0; i < n; i++) {
      const tx = tr.tan[i * 2] / 65536, ty = tr.tan[i * 2 + 1] / 65536
      const nx = -ty, ny = tx
      const px = tr.pts[i * 2] / 1000, py = tr.pts[i * 2 + 1] / 1000
      mid.push(px, py)
      inner.push(px + nx * half, py + ny * half)
      outer.push(px - nx * half, py - ny * half)
    }
    edgeCache = { trackId: S.track.id, mid, inner, outer }
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
    /* F01/F08 漂移边缘（渲染层检测：dr 0→1 落笔+音效位；胎痕随滑移持续落墨） */
    if (sh && S.seat >= 0 && S.phase === 'race') {
      const dr = sh.dr ? 1 : 0
      if (dr !== S.lastDr) { S.lastDr = dr; if (dr) { sfx.play('drift', ''); fxTrig('F01'); fxTrig('F08') } }
      if (dr && sh.v > 6000) pushMarks(sh)   /* v=milli-px/tick：6000≈120px/s（胎痕成形速度门） */
    }
    /* F04/F05 名次检测置于世界渲染前：被超者名签绿环同帧即可首绘（时延表口径） */
    checkRank()
    /* 视觉自车：混合带/软收敛（§5.1 ③——状态采重放值，视觉 35%/帧 逼近） */
    if (S.seat >= 0 && sh) {
      if (!S.vis) S.vis = { x: sh.x, y: sh.y, a: sh.a }
      if (S.blend) {
        /* 硬回滚混合带：120ms 从当前视觉位向重放态收敛，每帧位移封顶 2.5px
         * （O-6/GAMES-111：原式只写注释无封顶——F1 激活前 dPx≡0 恒不触发故无意义，
         *   修正台账恢复实测后按 §5.3 撕裂预算落地） */
        const p = Math.min(1, (now - S.blend.t0) / 120)
        const k = 0.18 + p * 0.5
        let mx = (sh.x - S.vis.x) * k, my = (sh.y - S.vis.y) * k
        const mv = Math.max(Math.abs(mx), Math.abs(my)) / 1000
        if (mv > 2.5) { const c = 2.5 / mv; mx *= c; my *= c }
        S.vis.x += mx; S.vis.y += my
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
    /* F13 相机跟随曲线（§3.2 优化落值，GAMES-113）：前视随速度带外扩 56→100px
     * （原固定 90px）——高速弯道预视窗更长，低速贴弯收紧；lerp 12%/帧与速度缩放带不变 */
    const look = (56 + 44 * vK) * 1000
    const fwdX = Math.cos(vis.a * Math.PI / 32768), fwdY = Math.sin(vis.a * Math.PI / 32768)
    const tx = vis.x + fwdX * look, ty = vis.y + fwdY * look
    cam.x += (tx - cam.x) * 0.12; cam.y += (ty - cam.y) * 0.12
    fxDraw('F13')
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
    strokeWindow(edgeCache.mid, win, () => { g.lineWidth = tr.W / 1000; g.strokeStyle = ASPH; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke() })
    g.setLineDash([14, 14])
    strokeWindow(edgeCache.inner, win, () => { g.lineWidth = 7; g.strokeStyle = S.track.id === 't-neon' ? NEON.cyan : CURB_A; g.stroke() })
    strokeWindow(edgeCache.outer, win, () => { g.lineWidth = 7; g.strokeStyle = S.track.id === 't-neon' ? NEON.mag : CURB_B; g.stroke() })
    g.setLineDash([])
    /* 胎痕（F01）+刮墙火花（F06）：世界系、车底图层 */
    drawTireMarks()
    if (vis) drawSparks(vis)
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
    drawMotion(v, sh)
    if (S.flash > 0) { g.globalAlpha = S.flash * 0.35; g.fillStyle = S.flashC; g.fillRect(0, 0, W, H); g.globalAlpha = 1; S.flash *= 0.9; if (S.flash < 0.03) S.flash = 0; fxDraw('F16') }
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
    /* F08 横摆倾斜（§3.2，GAMES-113）：车身按滑角侧旋 ±14° 封顶（渲染期偏移不扰判定）；
     * 漂移位保底 ±2.3°——滑角未成形的漂移按下也有可见姿态反馈 */
    if (isMe && sh) {
      let roll = (angD(sh.a, sh.d) / 32768) * Math.PI * 0.35
      if (roll > 0.244) roll = 0.244; else if (roll < -0.244) roll = -0.244
      if (drift) { if (roll > -0.04 && roll < 0.04) roll = roll < 0 ? -0.04 : 0.04; fxDraw('F08') }
      g.rotate(roll)
    }
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
    /* F07 碰撞轻反馈：双车白闪 150ms（渲染层，§3.5） */
    if (S.bumpFlash && now - S.bumpFlash.t0 < 150 && S.bumpFlash.seats.indexOf(seat) >= 0) {
      g.fillStyle = 'rgba(255,255,255,0.45)'
      roundRect(-11, -18, 22, 36, 6); g.fill()
      fxDraw('F07')
    }
    /* F02 氮气拖尾：尾喷火花锥（bo 激活/probe 窗同一位点；本地 -x=车尾） */
    if (isMe && ((sh && sh.bo > 0) || (S.boostFx && now - S.boostFx < 500))) {
      const fl = 14 + Math.random() * 8
      g.fillStyle = '#FFD166'
      g.beginPath(); g.moveTo(-11, -7); g.lineTo(-11 - fl, 0); g.lineTo(-11, 7); g.closePath(); g.fill()
      g.fillStyle = '#5CD9E8'
      g.beginPath(); g.moveTo(-11, -3); g.lineTo(-11 - fl * 0.55, 0); g.lineTo(-11, 3); g.closePath(); g.fill()
      fxDraw('F02')
    }
    /* 漂移烟/尾流 */
    if (drift && Math.random() < 0.6) S.parts.push({ x: x * 1000, y: y * 1000, vx: (Math.random() - 0.5) * 400, vy: (Math.random() - 0.5) * 400, life: 0.7, c: 'rgba(200,200,210,0.5)', sz: 5, world: 1 })
    if (sh && sh.bo > 0) S.parts.push({ x: x * 1000, y: y * 1000, vx: -Math.cos(a * Math.PI / 32768) * 1200, vy: -Math.sin(a * Math.PI / 32768) * 1200, life: 0.4, c: '#FFD166', sz: 3, world: 1 })
    if (isMe) { /* 名签不画自己 */ }
    else {
      g.rotate(-a * Math.PI / 32768)
      g.font = HF('P2', 'name', 9)
      g.fillStyle = DIM; g.textAlign = 'center'
      g.fillText(nameOf(seat), 0, -24)
      /* F04 超车提示：被超者名签绿环闪边 600ms（不遮挡，§3.5） */
      if (S.passFlash && S.passFlash.seat === seat && now - S.passFlash.t0 < 600) {
        const al = 1 - (now - S.passFlash.t0) / 600
        g.strokeStyle = 'rgba(61,220,132,' + (al * 0.9).toFixed(2) + ')'; g.lineWidth = 2
        g.beginPath(); g.arc(0, 0, 24, 0, 7); g.stroke()
        fxDraw('F04')
      }
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
  /* F01 胎痕：漂移中后轮双痕落笔（世界系 milli，持久带帽 480 点≈2s 双轮轨迹） */
  function pushMarks(sh) {
    const a = sh.a * Math.PI / 32768
    const bx = sh.x - Math.cos(a) * 14000, by = sh.y - Math.sin(a) * 14000   // 后轴 -14px
    const nx2 = -Math.sin(a) * 8000, ny2 = Math.cos(a) * 8000                // 轮距 ±8px
    S.marks.push({ x: bx + nx2, y: by + ny2 }, { x: bx - nx2, y: by - ny2 })
    if (S.marks.length > 480) S.marks.splice(0, S.marks.length - 480)
  }
  function drawTireMarks() {
    if (!S.marks.length) return
    g.fillStyle = 'rgba(16,14,24,0.5)'
    for (const m of S.marks) g.fillRect(m.x / 1000 - 2, m.y / 1000 - 2, 4, 4)
    fxDraw('F01')
  }
  /* F06 刮墙火花流：车头环带随机溅射，帧衰减 */
  function drawSparks(vis) {
    if (S.sparks <= 0.5) { S.sparks = 0; return }
    g.fillStyle = '#FFD166'
    const fx2 = vis.x / 1000, fy2 = vis.y / 1000
    for (let i = 0; i < S.sparks; i++) {
      const ang = Math.random() * 6.28, r = 14 + Math.random() * 14
      g.fillRect(fx2 + Math.cos(ang) * r, fy2 + Math.sin(ang) * r - 12, 3, 3)
    }
    S.sparks *= 0.85
    fxDraw('F06')
  }
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
  function drawMotion(v, sh) {
    /* vPx=px/s（v 为 milli-px/tick ×20tick/s → v/50；GAMES-113 修正原 /1000/20
     * 量纲错位——阈值 120px/s 永不达，速度线自 DEV 起即死码，本次激活） */
    const vPx = v / 50
    if (vPx < 120) { S.motionOn = 0; return }
    if (!S.motionOn) { S.motionOn = 1; fxTrig('F10') }
    /* F10 强化（GAMES-113）：boost 爆密 +3 条；线条倾斜 ∝ 滑角（§3.2 出弯横摆跟随） */
    let n = Math.min(7, Math.floor(vPx / 45))
    if ((sh && sh.bo > 0) || (S.boostFx && now - S.boostFx < 500)) n = Math.min(10, n + 3)
    const tilt = sh ? (angD(sh.a, sh.d) / 32768) * 14 : 0
    g.strokeStyle = 'rgba(232,236,243,0.16)'
    g.lineWidth = 2
    for (let i = 0; i < n; i++) {
      const x = i % 2 ? W - 8 - (i >> 1) * 12 : 8 + (i >> 1) * 12
      const len = 30 + (vPx % 80) + i * 8
      /* 纵向带裁剪到 y<560：不压页脚/漂移钮/蓄力条识图锚区（§7 识图 v2 字形锚点口径） */
      const y = ((now / 4 + i * 97) % (560 + len)) - len
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + tilt, y + len); g.stroke()
    }
    fxDraw('F10')
  }
  /* ---------- HUD（§7：顶栏 56+迷你图 Ø96+蓄力条+漂移钮；HF 登记） ---------- */
  /* F04/F05 名次变动检测（渲染层边缘触发：改善=超车提示+音效位；rankHold=取证注入同一位点） */
  function checkRank() {
    if (S.seat < 0 || !S.ranks.length) return
    const held = S.rankHold && now < S.rankHold.until
    const r = (held ? S.rankHold.ranks : S.ranks).indexOf(S.seat) + 1
    S.rankCur = r
    if (!r) return
    if (S.lastRank && r !== S.lastRank) {
      S.rankDir = r < S.lastRank ? 1 : -1
      S.rankPop = 1; fxTrig('F05')
      if (S.rankDir > 0) {
        fxTrig('F04'); sfx.play('pass', '')
        const prev = (held ? S.rankHold.prev : S.ranks)[S.lastRank - 1]
        if (prev != null && prev !== S.seat) S.passFlash = { seat: prev, t0: now }
      }
    }
    S.lastRank = r
  }
  function drawHUD(t, v) {
    const me = S.pred ? S.pred.kart() : null
    /* 顶栏底 */
    g.fillStyle = 'rgba(20,16,32,0.82)'
    g.fillRect(0, 0, W, TOP_H)
    g.strokeStyle = 'rgba(201,168,232,0.25)'; g.lineWidth = 1
    g.beginPath(); g.moveTo(0, TOP_H - 0.5); g.lineTo(W, TOP_H - 0.5); g.stroke()
    const rank = me ? S.rankCur : 0
    /* P 位次（P0；F05 变动跳动=1+0.4·pop 缩放+方向色） */
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'
    if (S.rankPop > 0.03) {
      const sc = 1 + 0.4 * S.rankPop
      g.save(); g.translate(10, 22); g.scale(sc, sc)
      g.font = HF('P0', 'pos', 13, '600')
      g.fillStyle = S.rankPop > 0.5 ? (S.rankDir > 0 ? '#3DDC84' : '#FF8A65') : INK
      g.fillText('P' + (rank || '—'), 0, 0)
      g.restore()
      S.rankPop *= 0.92
      fxDraw('F05')
    } else {
      g.font = HF('P0', 'pos', 13, '600'); g.fillStyle = INK
      g.fillText('P' + (rank || '—'), 10, 22)
    }
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
    /* T7-A ping 徽标（P0 13/600 升档，§3.3）：三档色+信号条形码+「预测中」副行。
     * GAMES-115 色弱双编码：绿档 #3DDC84 与红档 #FF8A65 灰度 luma 162/169 同带
     * （Δ7 不可辨），档位改以信号条 3/2/1 实条计数为形通道（灰度下可数） */
    const pcol = S.ping <= 80 ? '#3DDC84' : S.ping <= 160 ? '#FFD166' : '#FF8A65'
    const pTier = S.ping <= 80 ? 3 : S.ping <= 160 ? 2 : 1
    g.textAlign = 'right'
    g.font = HF('P0', 'ping', 13, '600'); g.fillStyle = S.seat >= 0 ? pcol : DIM
    g.fillText('PING ' + (S.ping || '—') + 'ms', W - 10, 22)
    if (S.seat >= 0) {
      const tw = g.measureText('PING ' + (S.ping || '—') + 'ms').width
      const bx = Math.round(W - 10 - tw - 24)
      S.pingBars = { x: bx, y: 22 }   // 落笔位登记（识图探针地面真值）
      for (let i = 0; i < 3; i++) {
        const bh = 4 + i * 3
        g.globalAlpha = i < pTier ? 1 : 0.22
        g.fillStyle = pcol
        g.fillRect(bx + i * 6, 22 - bh, 4, bh)
      }
      g.globalAlpha = 1
    }
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
    /* 倒计时（P0 大字脉冲；F12 首见落笔） */
    if (S.phase === 'countdown') {
      if (!S.countTrig) { S.countTrig = 1; fxTrig('F12') }
      const left = Math.max(0, Math.ceil((60 - S.simTick) * S.tickMs / 1000))
      const ph = 1 - ((60 - S.simTick) * S.tickMs % 1000) / 1000
      /* 字号登记表取恒 44px（动态 px 会把不同值写进注册表——hudFonts 逐键比对必红），
       * 脉冲改走 scale 变换（视觉同式：秒内 0.78→1.0 张合） */
      g.font = HF('P0', 'count', 44, '700')
      g.textAlign = 'center'; g.fillStyle = '#FFD166'
      g.globalAlpha = 0.4 + ph * 0.6
      g.save(); g.translate(W / 2, H / 2 - 40); g.scale(0.78 + ph * 0.22, 0.78 + ph * 0.22)
      g.fillText(String(left || 'GO'), 0, 0)
      g.restore()
      g.globalAlpha = 1; g.textAlign = 'left'
      fxDraw('F12')
      if (left !== S.lastCount) { S.lastCount = left; sfx.play('count', String(left)) }
    }
    if (S.phase !== 'countdown' && S.greenAt && now - S.greenAt < 600) {
      g.font = HF('P0', 'go', 40, '700'); g.textAlign = 'center'; g.fillStyle = '#7FE8D8'
      g.fillText('GO!', W / 2, H / 2 - 40); g.textAlign = 'left'
    }
    /* 抢跑罚红字（F15） */
    if (now < S.penUntil) { g.font = HF('P1', 'pen', 11, '600'); g.fillStyle = '#FF6B5C'; g.textAlign = 'center'; g.fillText('抢跑罚：禁油门 1s', W / 2, H / 2 - 70); g.textAlign = 'left'; fxDraw('F15') }
    /* 圈速横幅（1.2s，§3.5；F03 圈速完成闪现） */
    if (S.lapBanner && now - S.lapBanner.t0 < 1200) {
      const a = 1 - (now - S.lapBanner.t0) / 1200
      g.globalAlpha = a
      g.fillStyle = 'rgba(20,16,32,0.85)'; roundRect(W / 2 - 110, H / 2 - 26, 220, 44, 10); g.fill()
      g.font = HF('P0', 'lapBan', 15, '600'); g.fillStyle = '#FFD166'; g.textAlign = 'center'
      g.fillText('圈 ' + S.lapBanner.lap + ' · ' + fmt(S.lapBanner.ms) + (S.best === S.lapBanner.ms ? ' ★PB' : ''), W / 2, H / 2 + 2)
      g.globalAlpha = 1; g.textAlign = 'left'
      fxDraw('F03')
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
      fxDraw('F09')
    }
    /* F14 尾流提示（HUD 小字 1.2s，§3.5） */
    if (S.draftT && now - S.draftT < 1200) {
      g.font = HF('P1', 'draftHint', 11); g.fillStyle = '#5CD9E8'
      g.fillText('尾流 +12%', 12, H - 130)
      fxDraw('F14')
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
    /* F11 终点冲线：彩带 400ms（屏系下落带，§3.5 冲线彩带） */
    if (S.confettiT && now - S.confettiT < 400) {
      const p = (now - S.confettiT) / 400
      g.globalAlpha = 1 - p
      for (let i = 0; i < 36; i++) {
        g.fillStyle = SEAT_COL[i % 6]
        g.fillRect((i * 53 + 7) % (W - 8), -16 + p * (120 + (i % 5) * 36) + (i * 31) % 40, 4, 7)
      }
      g.globalAlpha = 1
      fxDraw('F11')
    } else if (S.confettiT) S.confettiT = 0
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
    /* 起跑线标记（GAMES-115 精化）：黑白格旗标 7×7 顶层绘制（通用起跑符号、色盲
     * 通用；原 4×4 金方与车位点同族且常被点阵遮挡——识图不可证） */
    const sx = Math.round(mx + (tr.pts[0] / 1000 - tr.world / 2000) * sc) - 3
    const sy = Math.round(my + (tr.pts[1] / 1000 - tr.world / 2000) * sc) - 3
    S.mmMark = { x: sx, y: sy }   // 落笔位登记（识图探针地面真值）
    for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
      g.fillStyle = (cx + cy) % 2 ? '#2A2438' : '#E8ECF3'
      g.fillRect(sx + cx * 3.5, sy + cy * 3.5, 3.5, 3.5)
    }
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
      /* 双条（GAMES-115 VIS 精化）：逐圈行内归一——当圈较慢者为满条（原固定 60s 归一
       * 在 ~45s 圈速下条长不足 75% 且 <1s 链路差压成 <1.5px 不可辨）；零基线柱+
       * 条尾亮端标（差值端点可数，色弱下条尾位置即读数，不依赖红绿） */
      const bw = 90, bx = 180
      const mx2 = Math.max(loc || 0, sv || 0, 1)
      const lw2 = (loc ? loc / mx2 : 0) * (bw - 2)
      const sw2 = (sv ? sv / mx2 : 0) * (bw - 2)
      g.strokeStyle = 'rgba(139,147,167,0.55)'; g.lineWidth = 1
      g.beginPath(); g.moveTo(bx + 0.5, y - 11); g.lineTo(bx + 0.5, y + 7); g.stroke()
      g.fillStyle = '#5CD9E8'; g.fillRect(bx + 2, y - 9, lw2, 5)
      if (lw2 > 3) { g.fillStyle = '#7FE8D8'; g.fillRect(bx + 2 + lw2 - 1.5, y - 10, 1.5, 7) }
      g.fillStyle = DIM; g.fillRect(bx + 2, y - 2, sw2, 5)
      if (sw2 > 3) { g.fillStyle = INK; g.fillRect(bx + 2 + sw2 - 1.5, y - 3, 1.5, 7) }
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
    /* boot 覆盖层退场（online 走 welcome 路径隐藏；debug 竞技场在此隐藏——
       留显会以 flex 兄弟节点挤偏 canvas 几何，识图 v2 几何断言红） */
    document.getElementById('boot').style.display = 'none'
  }
  function debugKart() { return DBG ? DBG.st.karts[0] : null }
  function debugStep() {
    const st = DBG.st
    const inputs = {}
    for (let i = 1; i < 6; i++) inputs[i] = K.brain(st, i, ['casual', 'balanced', 'competitive', 'balanced', 'casual'][i - 1], DBG.rngs[i])
    /* 我席=赛车线 autopilot（手感样本：真输入走预测器路径）；fxScene('drift')
     * 覆盖窗=真输入漂移取证（GAMES-113：dr 事件链/胎痕/横摆全真态） */
    const my = K.policyInput({ track: { id: S.track.id }, karts: st.karts }, 0)
    inputs[0] = { q: st.tick, st: my.st, th: my.th, dr: my.dr }
    if (S.driftFx && performance.now() - S.driftFx < 1400) inputs[0].dr = 1
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
    /* GAMES-113 手感层取证钩子（台账/场景注入；蛇王 FEEL 同范式） */
    fxLedger: () => fxLedgerArr.map((e) => ({ id: e.id, n: e.n, lat: e.drawn ? Math.round(e.drawn - e.t0) : null })),
    fxScene(name) {
      if (name === 'calm') { S.lapBanner = null; S.flash = 0; S.shake = 0; S.sparks = 0; S.confettiT = 0; S.draftT = 0; S.rankPop = 0; S.passFlash = null; S.bumpFlash = null; S.boostFx = 0; S.zoomP = 0; S.penUntil = 0; return true }
      if (name === 'rank') { S.rankHold = { ranks: [S.seat].concat(S.ranks.filter((s) => s !== S.seat)), prev: S.ranks.slice(), until: performance.now() + 250 }; return true }
      if (name === 'drift') { S.driftFx = performance.now(); return true }
      /* GAMES-115 VIS 结算帧取证：合成完赛态（名次=当前 ranks；对照样本 3 圈，第 2 圈
       * 放大链路差 670ms 显差行）——仅显示态注入，不触网不写圈账本 */
      if (name === 'settle') {
        S.end = { seats: S.ranks.slice() }
        S.best = S.best || 44120
        S.lapLocal = [44120, 45230, 43980]
        S.lapSrv = [44145, 45900, 44002]
        return true
      }
      return false
    },
    /* GAMES-115 VIS 取证钩子（蛇王 visInfo 同范式：只读暴露+显示态注入） */
    visInfo() {
      const neon = S.track && S.track.id === 't-neon'
      return {
        version: '1.0.0',
        seats: SEAT_COL.map((c, i) => ({ seat: i, c, shape: SEAT_SHAPE[i] })),
        curb: { inner: neon ? NEON.cyan : CURB_A, outer: neon ? NEON.mag : CURB_B, dash: [14, 14] },
        pingTiers: [{ max: 80, c: '#3DDC84', bars: 3 }, { max: 160, c: '#FFD166', bars: 2 }, { max: Infinity, c: '#FF8A65', bars: 1 }],
        ping: S.ping, pingBars: S.pingBars || null,
        motion: { on: S.motionOn ? 1 : 0 },
        cam: { zoom: +cam.zoom.toFixed(3), zT: +cam.zT.toFixed(3) },
        mm: { x: 375 - 48 - 10, y: 56 + 48 + 10, r: 48, mark: S.mmMark || null },
      }
    },
    visSet(o) {   // 显示态注入（仅 VIS 取证：ping 档位/详情卡开合；net 局不触碰）
      if ('ping' in o) S.ping = o.ping
      if ('pingOpen' in o) S.pingOpen = !!o.pingOpen
      return true
    },
    fxProbe: (ev) => onEvent(ev),
    netProbe() { return { ping: S.ping, flight: S.flight, recon10s: S.recon.filter((r) => performance.now() - r.t < 10000).length, reconPx: S.recon.slice(-200), hashBad: S.hashBad, hashWarn: S.hashWarn, lapLocal: S.lapLocal.slice(), lapSrv: S.lapSrv.slice() } },
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
