/* =====================================================================
 * 蛇王争霸 客户端（GAMES-99 · S6 海量实体）——客户端零判定，服务端权威快照流。
 * 依赖前置：<script src="shared.cjs">（window.SnakeK，与服务端 sim 同一段纯函数：
 * v/w/zoom 曲线 + stepTurn 转向积分 + segsFromPath 蛇身派生）。
 *
 * 三类延迟敏感操作三种策略（§3.1/§5.3）：
 *   自身蛇=本地转向预测 0ms 起步（drag 即转向）+ 快照 ack 和解（角度差 ≤30°
 *   每帧 20% 平滑 ~100ms 抹平、>30° 300ms 快滑；位置 >34px 硬贴齐）；
 *   他人蛇=120ms 插值缓冲（两样本 lerp，迟到外推 1 tick 仅呈现）；
 *   蛇身=本地 path 缓冲回放（每帧 push 渲染头点，节位按 12px 间距沿 path 派生，
 *   两端同式——海量节零网络成本，附决策 2）。
 * 渲染：霓虹蛇窟（§7）+ LOD 三档（zoom ≥0.9 每节 / 0.8-0.9 隔 1 节 / <0.8 隔 2 节）
 * + 光点预烘焙径向渐变 sprite 两批合批 + 视口 AABB 裁剪 + 粒子对象池零 GC。
 * HUD 字号对齐 hud-font-standard §1（HF 登记表，__GAMES_DEBUG__.hudFonts() 断言源）。
 * debug 模式（?debug=1）：本地幽灵竞技场（20 幽灵蛇+180 光点，同渲染路径，perf-smoke 契约）。
 * ===================================================================== */
'use strict'
;(function () {
  const K = window.SnakeK
  const W = 375, H = 667, TOP_H = 56
  const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif"
  const WORLD = K.W / 1000 // 世界 px（1800）
  /* §7 调色板：霓虹蛇窟 */
  const BG1 = '#08120C', BG2 = '#0F2418', GRID = '#123322'
  const RES_COL = { grass: '#7FE8D8', berry: '#C98FE8', ore: '#FFD700', drop: '#FFB65C', tail: '#FFE9B8' }
  const SKIN = [
    { c: '#3DDC84', pat: 'ring', hat: null }, { c: '#FFB65C', pat: 'dia', hat: 'horn' },
    { c: '#A78BFA', pat: 'stripe', hat: 'fin' }, { c: '#6FA8FF', pat: 'grad', hat: null },
    { c: '#FF6B5C', pat: 'dia', hat: 'horn' }, { c: '#E8E8F0', pat: 'ring', hat: 'crown' },
    { c: '#5C6B7A', pat: 'stripe', hat: 'fin' }, { c: '#FFD166', pat: 'grad', hat: 'crown' },
  ]
  const MS_TITLE = { 25: '幼蛇', 60: '长蛇', 100: '巨蟒', 140: '蛇王之姿' }
  const INK = '#E8ECF3', DIM = '#8B93A7'

  /* HUD 字号登记表（识图 v2 断言源）：P0 数字 ≥13/600、P1 交互 ≥11、P2 辅助 ≥9 */
  const hudFontReg = {}
  function HF(grp, key, px, w) {
    ;(hudFontReg[grp] || (hudFontReg[grp] = {}))[key] = px
    return (w ? w + ' ' : '') + px + 'px ' + FONT
  }

  /* ---------- 音效位预留（平台协议静音占位，mmo/element 先例） ---------- */
  const sfx = {
    calls: [],
    play(g, t) { this.calls.push({ g, t: t || '', at: performance.now() }) },
  }

  /* ---------- 全局状态 ---------- */
  const S = {
    mode: 'connecting', // connecting|playing|spectate|debug
    conn: null, roomId: null, seat: -1, token: null, roster: [],
    ents: new Map(),   // id → rec（蛇/光点位/瞬态）
    me: null, round: { n: 1, t: 0, k: -1, rem: K.ROUND_TICKS }, lb: [], mm: [],
    ping: 0, seq: 0, lastSend: 0,
    target: null, boostOn: false, // 本地输入态（a 目标角/boost 锁存）
    dead: false, respawnIn: 0, killerName: '', dropN: 0, crown: null, crownUntil: 0,
    connLost: false, err: '', pauseViz: false,
    toasts: [], parts: [], shakes: 0, shakeT: 0, eatStreak: 0, eatT: 0,
  }
  const cam = { x: K.W / 2, y: K.H / 2, zoom: 1, zTarget: 1 }
  let now = performance.now()
  const cv = document.getElementById('cv')
  const g = cv.getContext('2d')

  /* ---------- 光点 sprite 预烘焙（径向渐变离屏，两批合批，§5.3） ---------- */
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
    SPRITES[k] = c
  }

  /* ---------- 事件上报（boot/start 等，perf-smoke 契约） ---------- */
  function report(event, payload) {
    if (window.__GAMES_DEBUG__) window.__GAMES_DEBUG__.events.push({ event, payload, at: Date.now() })
  }

  /* =====================================================================
   * 连接层（net 协议 v1.1：join/quick → welcome/snapshot 流；element 先例）
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
      try { resume = JSON.parse(sessionStorage.getItem('sk-' + rid) || 'null') } catch { resume = null }
      ws.send(JSON.stringify({ t: 'join', roomId: rid || undefined, mode: q.get('mode') === 'spectate' ? 'spectate' : 'play', resume: resume ? { seat: resume.seat, token: resume.token } : undefined, name: '玩家' }))
      if (!rid) ws.send(JSON.stringify({ t: 'quick', gameId: 'snake-king' }))
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
      if (m.token != null) { try { sessionStorage.setItem('sk-' + S.roomId, JSON.stringify({ seat: S.seat, token: S.token })) } catch {} }
      S.mode = S.seat >= 0 ? 'playing' : 'spectate'
      S.ents.clear()
      if (m.state) applyWelcomeState(m.state)
      document.getElementById('boot').style.display = 'none'
      return
    }
    if (m.t === 'seat') { S.roster = m.seats; return }
    if (m.t === 'started') { if (m.state) applyWelcomeState(m.state); return }
    if (m.t === 'snapshot') { applySnapshot(m); return }
    if (m.t === 'end') { S.crown = { over: true, result: m.result }; return }
    if (m.t === 'closed') { S.connLost = true }
  }
  function applyWelcomeState(st) {
    S.round = { n: st.round.n, t: st.round.tick, k: st.round.king, rem: K.ROUND_TICKS - st.round.tick }
    if (st.leaderboard) { S.lb = st.leaderboard.slice(0, 5); S.lbFull = st.leaderboard }
    for (const id in st.ents) addEnt(st.ents[id])
    const me = S.seat >= 0 ? st.ents['s' + S.seat] : null
    if (me) {
      const rec = S.ents.get('s' + S.seat)
      if (rec) { cam.x = me.x; cam.y = me.y; cam.zoom = cam.zTarget = K.zoomOf(me.n) }
    }
  }

  /* =====================================================================
   * 快照管线（二式：全量/增量+稀疏脏字段；§5.2）
   * ===================================================================== */
  function rebuildPath(px) { // 服务端隔点传输 → 客户端线性重建（§5.2）
    const out = []
    for (let i = 0; i + 1 < px.length; i += 2) {
      out.push(px[i], px[i + 1])
      if (i + 3 < px.length) out.push(Math.round((px[i] + px[i + 2]) / 2), Math.round((px[i + 1] + px[i + 3]) / 2))
    }
    return out
  }
  function addEnt(e) {
    if (e.k === 'snake') {
      const rec = S.ents.get(e.id) || {}
      Object.assign(rec, {
        id: e.id, k: 'snake', seat: e.seat, name: e.name, n: e.n || 10, skin: e.skin || 0,
        x: e.x, y: e.y, a: e.a, sc: e.sc || 0, k2: e.k2 || 0, b: e.b || 0, d: e.d || 0, p: e.p || 0,
        path: e.path ? rebuildPath(e.path) : (rec.path || [e.x, e.y]),
        smp: [{ t: e.frameTs || 0, x: e.x, y: e.y, a: e.a }],
        fade: 1,
      })
      S.ents.set(e.id, rec)
    } else {
      S.ents.set(e.id, { id: e.id, k: e.k || 'drop', x: e.x, y: e.y, v: e.v || 0, on: e.on === undefined ? 1 : e.on, fade: 1 })
    }
  }
  function applySnapshot(m) {
    S.round = { n: m.ext.rd.n, t: m.ext.rd.t, k: m.ext.rd.k, rem: m.ext.rd.rem }
    const tAuth = m.frame * 100 // 服务器 tick 时基（ms）
    if (m.ext.lb) S.lb = m.ext.lb.map((r) => Array.isArray(r) ? { seat: r[0], score: r[1], n: r[2] } : r) // 紧凑编码归一（名字走 roster）
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
      for (const [id, rec] of S.ents) if (!keep.has(id)) rec.gone = 1 // 淡出后删
    } else {
      for (const e of m.ents) {
        const rec = S.ents.get(e.id)
        if (!rec) { addEnt(e); continue }
        if (rec.k === 'snake') {
          rec.x = e.x; rec.y = e.y; rec.a = e.a
          if (e.n !== undefined) rec.n = e.n
          if (e.skin !== undefined) rec.skin = e.skin
          if (e.sc !== undefined) rec.sc = e.sc
          if (e.k2 !== undefined) rec.k2 = e.k2
          if (e.b !== undefined) rec.b = e.b
          if (e.d !== undefined) rec.d = e.d
          rec.smp.push({ t: tAuth, x: rec.x, y: rec.y, a: rec.a })
          if (rec.smp.length > 4) rec.smp.shift()
        } else if (e.on !== undefined) {
          rec.on = e.on
          if (e.x !== undefined) { rec.x = e.x; rec.y = e.y }
        }
      }
      for (const id of m.leave || []) { const rec = S.ents.get(id); if (rec) rec.gone = 1 }
    }
    if (m.full) S.lbFull = null // 全量后 top10 榜以 ext.lb 紧凑流续供（展开态回退 top5）
    for (const ev of m.events || []) onEvent(ev)
  }
  function onMyDeath() {
    S.shakes = 8; S.shakeT = 400
    sfx.play('die', '')
  }
  function onEvent(ev) {
    const isMe = ev.seat === S.seat
    if (ev.k === 'eat' && isMe) {
      S.eatStreak = (now - S.eatT < 2000) ? S.eatStreak + 1 : 1
      S.eatT = now
      sfx.play('eat', String(ev.v))
      const me = S.ents.get('s' + S.seat)
      if (me) spawnParts(me.x, me.y, RES_COL[ev.id && ev.id[0] === 'd' ? 'drop' : ev.id && ev.id[0] === 'o' ? 'ore' : 'grass'], 3)
    } else if (ev.k === 'kill') {
      if (ev.by === S.seat) { // 击杀：横幅+震动+粒子雨（§3.3）
        const victim = S.roster.find((r) => r.seat === ev.seat)
        S.toasts.push({ txt: '击杀 ' + ((victim && victim.name) || '对手'), c: '#FFD700', t0: now, dur: 1200, big: true })
        S.shakes = 4; S.shakeT = 240
        sfx.play('kill', '')
      }
    } else if (ev.k === 'die') {
      const rec = S.ents.get('s' + ev.seat)
      if (rec) spawnParts(rec.x, rec.y, RES_COL.drop, Math.min(24, ev.drops || 8))
      if (isMe) {
        const killer = ev.by >= 0 ? S.roster.find((r) => r.seat === ev.by) : null
        S.killerName = ev.by >= 0 ? ((killer && killer.name) || '对手') : '蛇窟的墙'
        S.dropN = ev.drops || 0
      }
    } else if (ev.k === 'milestone') {
      if (isMe) { S.toasts.push({ txt: MS_TITLE[ev.n] + '！', c: '#7FE8D8', t0: now, dur: 1400, big: ev.n >= 100 }); sfx.play('ms', String(ev.n)) }
      if (ev.world) S.toasts.push({ txt: '巨蟒降世', c: '#FFD700', t0: now, dur: 1800, big: true })
    } else if (ev.k === 'crown') {
      S.crown = { seat: ev.seat, name: ev.name, score: ev.score, t0: now }
      S.crownUntil = now + 5000
      sfx.play('crown', '')
    }
  }

  /* ---------- 粒子池（零 GC，§5.3 对象池纪律） ---------- */
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
   * 输入（§1.5 单拇指：任意处拖=浮动摇杆转向；右下 Ø64 boost 钮=开关）
   * ===================================================================== */
  const joy = { on: false, ox: 0, oy: 0, x: 0, y: 0 }
  const BOOST_BTN = { x: W - 58, y: H - 78, r: 32 }
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
    const db = (p.x - BOOST_BTN.x) ** 2 + (p.y - BOOST_BTN.y) ** 2
    if (db < BOOST_BTN.r * BOOST_BTN.r) { toggleBoost(); return }
    joy.on = true; joy.ox = joy.x = p.x; joy.oy = joy.y = p.y
  }, { passive: false })
  cv.addEventListener('touchmove', (e) => { e.preventDefault(); if (!joy.on) return; const p = pd(e); joy.x = p.x; joy.y = p.y; setTargetFromJoy() }, { passive: false })
  cv.addEventListener('touchend', (e) => { e.preventDefault(); joy.on = false; const t = Date.now(); if (t - lastTap < 280) toggleBoost(); lastTap = t }, { passive: false })
  cv.addEventListener('mousedown', (e) => { const p = pd(e); if ((p.x - BOOST_BTN.x) ** 2 + (p.y - BOOST_BTN.y) ** 2 < BOOST_BTN.r * BOOST_BTN.r) { toggleBoost(); return } joy.on = true; joy.ox = joy.x = p.x; joy.oy = joy.y = p.y })
  cv.addEventListener('mousemove', (e) => { if (!joy.on) return; const p = pd(e); joy.x = p.x; joy.y = p.y; setTargetFromJoy() })
  cv.addEventListener('mouseup', () => { joy.on = false })
  function toggleBoost() { S.boostOn = !S.boostOn; sfx.play('boost', S.boostOn ? 'on' : 'off') }
  /** 输入上行 10Hz（a 恒带=持续态心跳兼保活；boost 变才带，§3.1） */
  function sendInput() {
    if (!S.conn || S.conn.readyState !== 1 || S.seat < 0) return
    const me = S.ents.get('s' + S.seat)
    const a = S.target == null ? (me ? me.a : 0) : Math.round(S.target)
    const msg = { t: 'input', frame: S.seq++, keys: { a } }
    if (S.boostOn !== S.sentBoost) { msg.keys.boost = S.boostOn ? 1 : 0; S.sentBoost = S.boostOn }
    else if (me && me.b) msg.keys.boost = 1 // 服务器侧已亮（未收熄灭键前保态）
    S.conn.send(JSON.stringify(msg))
  }
  S.sentBoost = false
  setInterval(() => sendInput(), 100)

  /* =====================================================================
   * 本地预测 + 插值（§3.1/§5.3）
   * ===================================================================== */
  let simAcc = 0
  function stepLocal(dtMs) {
    const meRec = S.ents.get('s' + S.seat)
    if (S.mode === 'playing' && meRec && !S.dead) {
      /* 自身：本地转向预测（两端同式积分；不等服务器） */
      const w = Math.max(1, Math.round(K.wOf(meRec.n) * (meRec.b ? 0.85 : 1)))
      const v = K.vOf(meRec.n) * (meRec.b ? 1.6 : 1)
      const ta = S.target == null ? meRec.a : S.target
      meRec.a = K.stepTurn(meRec.a, ta, w)
      meRec.px = meRec.x; meRec.py = meRec.y
      meRec.x += Math.cos(meRec.a * Math.PI / 180) * v * dtMs / 100
      meRec.y += Math.sin(meRec.a * Math.PI / 180) * v * dtMs / 100
    }
    for (const rec of S.ents.values()) {
      if (rec.k !== 'snake' || rec.gone) continue
      if (rec !== meRec) {
        /* 他人：120ms 插值（两样本 lerp）+ 迟到外推 1 tick 仅呈现 */
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
      /* path 缓冲回放：每帧 push 渲染头点（≥6px 才 push 防抖），两端同式派生节位 */
      const p = rec.path
      const lastX = p[0], lastY = p[1]
      if (lastX === undefined || (rec.x - lastX) ** 2 + (rec.y - lastY) ** 2 > 36000000) {
        p.unshift(Math.round(rec.x), Math.round(rec.y))
        const cap = Math.min(K.PATH_CAP * 2, (rec.n + 20) * 2)
        if (p.length > cap) p.length = cap
      }
    }
    /* 和解：自身预测 vs 权威（ack 样本即最新 smp；角度 ≤30° 平滑 20%/帧） */
    if (meRec && meRec.smp && meRec.smp.length && !S.dead) {
      const auth = meRec.smp[meRec.smp.length - 1]
      const dx = auth.x - meRec.x, dy = auth.y - meRec.y
      const d = Math.hypot(dx, dy)
      if (d > 34000) { meRec.x = auth.x; meRec.y = auth.y } // >34px 硬贴齐
      else if (d > 1000) { meRec.x += dx * 0.2; meRec.y += dy * 0.2 }
      const da = Math.abs(K.angDiff(meRec.a, auth.a))
      if (da > 30) meRec.a += K.angDiff(meRec.a, auth.a) * 0.1 // 300ms 快滑
      else meRec.a += K.angDiff(meRec.a, auth.a) * 0.2 // ~100ms 抹平
    }
  }

  /* =====================================================================
   * 渲染（§5.6 预算：8-16 蛇 LOD 后 ~300-400 圆 + ~31-40 sprite ≈2.8-4.2ms/帧）
   * ===================================================================== */
  function w2s(x, y) { return { x: (x / 1000 - cam.x / 1000) * cam.zoom + W / 2, y: (y / 1000 - cam.y / 1000) * cam.zoom + H / 2 } }
  function render() {
    const meRec = S.ents.get('s' + S.seat)
    /* 镜头：锁蛇头 lerp 12%/帧；zoom 阶梯 lerp 0.04/帧；死亡拉远 0.15（§3.2） */
    const anchor = S.mode === 'debug' ? S.ents.get('s0') : (meRec || null)
    if (anchor) {
      cam.x += (anchor.x - cam.x) * 0.12
      cam.y += (anchor.y - cam.y) * 0.12
      const zt = K.zoomOf(anchor.n || 10) * (S.dead ? 0.85 : 1)
      cam.zTarget += (zt - cam.zTarget) * 0.04
    }
    cam.zoom = cam.zTarget
    /* 震动（渲染期偏移，§3.2） */
    let shx = 0, shy = 0
    if (S.shakeT > 0) {
      S.shakeT -= 16
      const amp = S.shakes * (S.shakeT / 400)
      shx = (Math.random() * 2 - 1) * amp; shy = (Math.random() * 2 - 1) * amp
    }
    /* 背景：纵向渐变 + 200px 网格微光 + 暗角（§7） */
    const grd = g.createLinearGradient(0, 0, 0, H)
    grd.addColorStop(0, BG1); grd.addColorStop(1, BG2)
    g.fillStyle = grd
    g.fillRect(0, 0, W, H)
    g.save()
    g.translate(shx, shy)
    const gs = 200 * cam.zoom
    const ox = ((-cam.x / 1000 * cam.zoom + W / 2) % gs + gs) % gs
    const oy = ((-cam.y / 1000 * cam.zoom + H / 2) % gs + gs) % gs
    g.strokeStyle = GRID; g.lineWidth = 1
    g.beginPath()
    for (let x = ox; x < W; x += gs) { g.moveTo(x, 0); g.lineTo(x, H) }
    for (let y = oy; y < H; y += gs) { g.moveTo(0, y); g.lineTo(W, y) }
    g.stroke()
    /* 边界带 24px（撞墙死警示，§2.1） */
    const tl = w2s(0, 0), br = w2s(K.W, K.H)
    g.strokeStyle = 'rgba(255,107,92,.35)'; g.lineWidth = 3
    g.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y)
    g.restore()

    const lodSkip = cam.zoom >= 0.9 ? 1 : cam.zoom >= 0.8 ? 2 : 3 // LOD 三档（§5.3）
    /* 光点 sprite 两批合批（静态位/瞬态），视口 AABB 裁剪 */
    const pulse = 1 + 0.18 * Math.sin(now / 240)
    for (const rec of S.ents.values()) {
      if (rec.k === 'snake' || rec.gone) continue
      if (!rec.on && rec.k !== 'drop') continue
      const s = w2s(rec.x, rec.y)
      const r = (rec.k === 'ore' ? 8 * pulse : rec.v >= 2 ? 7 : 6) * cam.zoom
      if (s.x < -16 || s.y < -16 || s.x > W + 16 || s.y > H + 16) continue
      const spr = rec.k === 'drop' || rec.k === 'tail' ? SPRITES[rec.v >= 2 ? 'drop' : 'tail'] : SPRITES[rec.k]
      g.drawImage(spr, s.x - r, s.y - r, r * 2, r * 2)
    }
    /* 蛇：复合描边 + 节圆 LOD + 头（眼/头饰/金冠/出生闪烁/boost 尾迹） */
    for (const rec of S.ents.values()) {
      if (rec.k !== 'snake') continue
      if (rec.gone) { rec.fade -= 0.08; if (rec.fade <= 0) { S.ents.delete(rec.id); continue } }
      if (rec.d) continue // 死亡蛇不绘（尸体已成光点）
      const sg = K.segsFromPath(rec.path, rec.n)
      let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9
      for (let i = 0; i + 1 < sg.length; i += 2) {
        if (sg[i] < mnx) mnx = sg[i]; if (sg[i] > mxx) mxx = sg[i]
        if (sg[i + 1] < mny) mny = sg[i + 1]; if (sg[i + 1] > mxy) mxy = sg[i + 1]
      }
      const a1 = w2s(mnx, mny), a2 = w2s(mxx, mxy)
      if (a2.x < -40 || a1.x > W + 40 || a2.y < -40 || a1.y > H + 40) continue // 视口 AABB 裁剪
      const skin = SKIN[rec.skin] || SKIN[0]
      const isKing = S.round.k === rec.seat
      const flicker = rec.p > 0 && Math.floor(now / 100) % 2 === 0
      g.globalAlpha = (rec.fade === undefined ? 1 : rec.fade) * (flicker ? 0.45 : 1)
      /* 身体复合描边：暗底粗描 + 皮肤色芯 */
      g.lineCap = 'round'; g.lineJoin = 'round'
      g.beginPath()
      for (let i = 0; i + 1 < sg.length; i += 2) {
        const s = w2s(sg[i], sg[i + 1])
        if (i === 0) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y)
      }
      g.strokeStyle = 'rgba(4,10,7,.9)'
      g.lineWidth = 15 * cam.zoom
      g.stroke()
      g.strokeStyle = skin.c
      g.lineWidth = 11 * cam.zoom
      g.stroke()
      if (rec.n >= 60) { // 长蛇终身亮描边（§2.6）
        g.strokeStyle = 'rgba(255,255,255,.35)'
        g.lineWidth = 12.5 * cam.zoom
        g.stroke()
      }
      /* 节圆明暗环纹（LOD 隔节） */
      const nodeR = 4.6 * cam.zoom
      g.fillStyle = 'rgba(255,255,255,.16)'
      for (let i = 2 * lodSkip; i + 1 < sg.length; i += 2 * lodSkip) {
        const s = w2s(sg[i], sg[i + 1])
        g.beginPath(); g.arc(s.x, s.y, nodeR, 0, Math.PI * 2); g.fill()
      }
      /* 头 Ø18 + 朝向眼 + 头饰/金冠 */
      const hd = w2s(sg[0], sg[1])
      const hr = 9 * cam.zoom
      g.beginPath(); g.arc(hd.x, hd.y, hr, 0, Math.PI * 2)
      g.fillStyle = skin.c; g.fill()
      g.lineWidth = 2 * cam.zoom; g.strokeStyle = 'rgba(255,255,255,.5)'; g.stroke()
      const ea = rec.a * Math.PI / 180
      for (const side of [-1, 1]) {
        const ex = hd.x + Math.cos(ea + side * 0.5) * hr * 0.55, ey = hd.y + Math.sin(ea + side * 0.5) * hr * 0.55
        g.beginPath(); g.arc(ex, ey, hr * 0.22, 0, Math.PI * 2); g.fillStyle = '#0A1410'; g.fill()
      }
      if (isKing || skin.hat === 'crown') drawCrown(hd.x, hd.y - hr - 3 * cam.zoom, 6 * cam.zoom)
      else if (skin.hat === 'horn') { g.beginPath(); g.moveTo(hd.x - 4 * cam.zoom, hd.y - hr); g.lineTo(hd.x - 6 * cam.zoom, hd.y - hr - 5 * cam.zoom); g.lineTo(hd.x - 1 * cam.zoom, hd.y - hr - 1); g.moveTo(hd.x + 4 * cam.zoom, hd.y - hr); g.lineTo(hd.x + 6 * cam.zoom, hd.y - hr - 5 * cam.zoom); g.lineTo(hd.x + 1 * cam.zoom, hd.y - hr - 1); g.strokeStyle = '#FFD98E'; g.lineWidth = 1.5 * cam.zoom; g.stroke() }
      if (rec.b && Math.random() < 0.5) spawnParts(sg[sg.length - 2] || sg[0], sg[sg.length - 1] || sg[1], skin.c, 1) // boost 尾迹拖光
      g.globalAlpha = 1
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
    drawHUD(meRec, anchor)
  }
  function drawCrown(x, y, r) {
    g.beginPath()
    g.moveTo(x - r, y + r * 0.6); g.lineTo(x - r, y - r * 0.4); g.lineTo(x - r * 0.45, y + r * 0.1)
    g.lineTo(x, y - r); g.lineTo(x + r * 0.45, y + r * 0.1); g.lineTo(x + r, y - r * 0.4); g.lineTo(x + r, y + r * 0.6)
    g.closePath()
    g.fillStyle = '#FFD700'; g.fill()
    g.strokeStyle = '#B8860B'; g.lineWidth = 1; g.stroke()
  }

  /* ---------- HUD（§7：顶栏/小地图/排行榜/boost 钮/页脚；HF 登记表） ---------- */
  let lbOpen = false
  function drawHUD(meRec, anchor) {
    /* 顶栏 56px：长度 P0｜击杀 P0｜轮倒计时 P0｜ping P2 */
    g.fillStyle = 'rgba(5,12,9,.72)'
    g.fillRect(0, 0, W, TOP_H)
    const n = meRec ? meRec.n : 0, k2 = meRec ? meRec.k2 : 0
    g.fillStyle = INK
    g.font = HF('P0', 'len', 15, 600)
    g.fillText('长 ' + n, 12, 24)
    g.font = HF('P0', 'kills', 13, 600)
    g.fillText('杀 ' + k2, 78, 24)
    const remS = Math.ceil(S.round.rem * 100 / 1000)
    g.fillStyle = remS <= 10 ? '#FF6B5C' : INK
    g.font = HF('P0', 'round', 13, 600)
    g.fillText('第' + S.round.n + '轮 ' + String(Math.floor(remS / 60)).padStart(1, '0') + ':' + String(remS % 60).padStart(2, '0'), 140, 24)
    g.fillStyle = DIM
    g.font = HF('P2', 'ping', 11)
    g.fillText(S.ping ? S.ping + 'ms' : '—', W - 44, 24)
    g.font = HF('P0', 'score', 13, 600)
    g.fillStyle = '#FFD98E'
    g.fillText('王座 ' + (meRec ? meRec.sc : 0), 12, 46)
    /* 连食火花（§3.3） */
    if (S.eatStreak >= 5 && now - S.eatT < 2000) {
      g.fillStyle = '#7FE8D8'
      g.font = HF('P1', 'streak', 11, 600)
      g.fillText('连食×' + S.eatStreak, 140, 46)
    }
    /* 右上小地图 Ø96：全房密度点（§7 巨房卖点 HUD 内显） */
    const mm = { x: W - 56, y: TOP_H + 56, r: 46 }
    g.save()
    g.beginPath(); g.arc(mm.x, mm.y, mm.r, 0, Math.PI * 2)
    g.fillStyle = 'rgba(6,14,10,.8)'; g.fill()
    g.strokeStyle = 'rgba(127,232,216,.3)'; g.lineWidth = 1.5; g.stroke()
    g.clip()
    g.beginPath(); g.arc(mm.x + (0 - WORLD / 2) * (mm.r * 2 / WORLD) * 0.92, mm.y, 30 * (mm.r * 2 / WORLD), 0, Math.PI * 2) // 矿区环标
    g.strokeStyle = 'rgba(255,215,0,.35)'; g.stroke()
    for (const d of S.mm) {
      const mx = mm.x + (d[1] - WORLD / 2) * (mm.r * 2 / WORLD) * 0.92
      const my = mm.y + (d[2] - WORLD / 2) * (mm.r * 2 / WORLD) * 0.92
      g.beginPath(); g.arc(mx, my, d[0] === S.seat ? 3 : Math.max(1.4, Math.min(2.6, d[3] / 40)), 0, Math.PI * 2)
      g.fillStyle = d[0] === S.seat ? '#FFD700' : 'rgba(143,232,216,.75)'; g.fill()
    }
    g.restore()
    /* 左侧排行榜 top5（tap 展开 top10，§7） */
    const rows = lbOpen ? ((S.lbFull && S.lbFull.length > 5 ? S.lbFull : S.lb) || []).slice(0, 10) : (S.lb || []).slice(0, 5)
    g.font = HF('P1', 'lb-title', 11, 600)
    g.fillStyle = DIM
    g.fillText('蛇王榜', 12, TOP_H + 18)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const y = TOP_H + 34 + i * 17
      const seatRec = S.roster.find((x) => x.seat === r.seat)
      g.font = HF('P0', 'lb-score', 13, 600)
      g.fillStyle = r.seat === S.seat ? '#FFD98E' : INK
      const nm = ((seatRec && seatRec.name) || '蛇' + r.seat) + ' ·' + r.n
      g.fillText(String(i + 1) + '.', 12, y)
      g.font = HF('P1', 'lb-name', 11)
      g.fillStyle = r.seat === S.seat ? '#FFD98E' : DIM
      g.fillText(nm.slice(0, 9), 30, y)
      g.font = HF('P0', 'lb-score', 13, 600)
      g.fillStyle = r.seat === S.seat ? '#FFD98E' : INK
      g.fillText(String(r.score), 100, y)
    }
    /* 右下 boost 钮 Ø64（n≥16 点亮，§1.5） */
    const lit = (meRec && meRec.n >= 16 && S.boostOn) || (meRec && meRec.b)
    g.beginPath(); g.arc(BOOST_BTN.x, BOOST_BTN.y, BOOST_BTN.r, 0, Math.PI * 2)
    g.fillStyle = lit ? 'rgba(255,182,92,.85)' : 'rgba(20,40,30,.72)'
    g.fill()
    g.strokeStyle = meRec && meRec.n >= 16 ? '#FFB65C' : 'rgba(139,147,167,.4)'
    g.lineWidth = 2; g.stroke()
    g.fillStyle = lit ? '#1A0E04' : DIM
    g.font = HF('P1', 'boost', 12, 600)
    g.textAlign = 'center'
    g.fillText('加速', BOOST_BTN.x, BOOST_BTN.y + 4)
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
    g.fillText('snake-king · v1.0.0 · S6', 12, H - 8)
    /* toast（里程碑/击杀，§2.6/§3.3） */
    S.toasts = S.toasts.filter((t) => now - t.t0 < t.dur)
    let ty = TOP_H + 96
    for (const t of S.toasts) {
      const age = (now - t.t0) / t.dur
      g.globalAlpha = 1 - age * age
      g.fillStyle = t.c
      g.font = HF(t.big ? 'P0' : 'P1', 'toast', t.big ? 15 : 12, 600)
      g.textAlign = 'center'
      g.fillText(t.txt, W / 2, ty)
      g.textAlign = 'left'
      g.globalAlpha = 1
      ty += 22
    }
    /* 死亡覆层（§1.2：击杀者+化作 N 光点+复活倒计时 3s） */
    if (S.dead && S.respawnIn > 0) {
      g.fillStyle = 'rgba(4,9,6,.6)'
      g.fillRect(0, 0, W, H)
      g.textAlign = 'center'
      g.fillStyle = '#FF6B5C'
      g.font = HF('P0', 'death-by', 15, 600)
      g.fillText(S.killerName ? '被 ' + S.killerName + ' 猎杀' : '撞上了蛇窟的墙', W / 2, H / 2 - 46)
      g.fillStyle = '#FFB65C'
      g.font = HF('P1', 'death-drop', 13)
      g.fillText('化作 ' + S.dropN + ' 光点——猎你的蛇正在开宴', W / 2, H / 2 - 20)
      const prog = 1 - S.respawnIn / 30
      g.beginPath(); g.arc(W / 2, H / 2 + 42, 26, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2)
      g.strokeStyle = '#7FE8D8'; g.lineWidth = 4; g.stroke()
      g.fillStyle = INK
      g.font = HF('P0', 'death-cd', 14, 600)
      g.fillText(Math.ceil(S.respawnIn / 10) + '', W / 2, H / 2 + 48)
      g.textAlign = 'left'
    }
    /* 加冕覆层 5s（§1.3/§3.3） */
    if (S.crown && now < S.crownUntil && !S.crown.over) {
      g.fillStyle = 'rgba(4,9,6,.72)'
      g.fillRect(0, 0, W, H)
      g.textAlign = 'center'
      drawCrown(W / 2, H / 2 - 92, 30)
      g.fillStyle = '#FFD700'
      g.font = HF('P0', 'crown', 17, 700)
      g.fillText('蛇王加冕', W / 2, H / 2 - 34)
      g.fillStyle = INK
      g.font = HF('P0', 'crown-name', 14, 600)
      g.fillText(S.crown.name + ' · 王座 ' + S.crown.score, W / 2, H / 2 - 8)
      if (Math.random() < 0.3) spawnParts((Math.random() * K.W) | 0, (Math.random() * K.H) | 0, '#FFD700', 2)
      g.textAlign = 'left'
    }
    /* 错误/断连提示 */
    if (S.err || S.connLost) {
      g.fillStyle = 'rgba(255,107,92,.9)'
      g.font = HF('P1', 'err', 12, 600)
      g.textAlign = 'center'
      g.fillText(S.connLost ? '与蛇窟断开连接…' : S.err, W / 2, H - 30)
      g.textAlign = 'left'
    }
  }
  /* 排行榜 tap 展开（§1.5） */
  cv.addEventListener('touchstart', (e) => {
    const p = pd(e)
    if (p.x < 130 && p.y > TOP_H && p.y < TOP_H + 34 + 6 * 17) lbOpen = !lbOpen
  }, { passive: true })

  /* =====================================================================
   * debug 幽灵竞技场（?debug=1，perf-smoke 契约：boot → start(1) → rAF 采样）
   * 20 幽灵蛇（同式曲线巡游+互撞简化为穿越）+180 光点——渲染/插值/path 与在线同径
   * ===================================================================== */
  function startDebugArena() {
    S.mode = 'debug'
    document.getElementById('boot').style.display = 'none'
    let dseq = 0
    for (let i = 0; i < 180; i++) {
      const kinds = ['grass', 'grass', 'grass', 'berry', 'ore']
      const k = kinds[i % 5]
      S.ents.set((k[0] === 'g' ? 'g' : k[0] === 'b' ? 'b' : 'o') + i, {
        id: (k[0] === 'g' ? 'g' : k[0] === 'b' ? 'b' : 'o') + i, k,
        x: (60000 + Math.random() * (K.W - 120000)) | 0, y: (60000 + Math.random() * (K.H - 120000)) | 0,
        v: { grass: 1, berry: 2, ore: 4 }[k], on: 1,
      })
    }
    S.mm = []
    for (let i = 0; i < 20; i++) {
      const a = (i * 47) % 360
      const rec = {
        id: 's' + i, k: 'snake', seat: i - 1, name: i === 0 ? '你' : '幽灵' + i, n: i === 0 ? 10 : 14 + ((i * 13) % 110),
        skin: i % 8, x: (120000 + Math.random() * (K.W - 240000)) | 0, y: (120000 + Math.random() * (K.H - 240000)) | 0,
        a, sc: 0, k2: 0, b: 0, d: 0, p: 0, path: [], smp: [], fade: 1,
        wp: { x: (200000 + Math.random() * (K.W - 400000)) | 0, y: (200000 + Math.random() * (K.H - 400000)) | 0 },
      }
      for (let j = 0; j <= rec.n; j++) rec.path.push(Math.round(rec.x - Math.cos(a * Math.PI / 180) * 12000 * j), Math.round(rec.y - Math.sin(a * Math.PI / 180) * 12000 * j))
      S.ents.set(rec.id, rec)
      S.mm.push([i - 1, Math.round(rec.x / 1000), Math.round(rec.y / 1000), rec.n])
    }
    S.lb = Array.from({ length: 5 }, (_, i) => ({ seat: i, name: '幽灵' + (i + 1), n: 30 + i * 20, kills: i, score: 60 + i * 40 }))
    S.round = { n: 1, t: 1800, k: 3, rem: 1800 }
    /* 幽灵节拍：100ms 推一次权威样本（走同一条插值管线） */
    setInterval(() => {
      let mi = 0
      for (const rec of S.ents.values()) {
        if (rec.k !== 'snake') continue
        if (rec.seat !== -1) { // 幽灵：waypoint 巡游
          const d = Math.hypot(rec.wp.x - rec.x, rec.wp.y - rec.y)
          if (d < 160000) rec.wp = { x: (200000 + Math.random() * (K.W - 400000)) | 0, y: (200000 + Math.random() * (K.H - 400000)) | 0 }
          const ta = Math.atan2(rec.wp.y - rec.y, rec.wp.x - rec.x) * 180 / Math.PI
          rec.a = K.stepTurn(rec.a, ta, K.wOf(rec.n))
          const v = K.vOf(rec.n)
          rec.x += Math.cos(rec.a * Math.PI / 180) * v * 10
          rec.y += Math.sin(rec.a * Math.PI / 180) * v * 10
        }
        rec.smp.push({ t: (S.dbgT = (S.dbgT || 0) + 100), x: rec.x, y: rec.y, a: rec.a })
        if (rec.smp.length > 4) rec.smp.shift()
        if (rec.n < 140 && Math.random() < 0.06) rec.n++ // 慢慢长大（渲染负载梯度）
        S.mm[mi] && (S.mm[mi] = [rec.seat, Math.round(rec.x / 1000), Math.round(rec.y / 1000), rec.n])
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
    if (S.pauseViz) { lastT = t; requestAnimationFrame(frame); return } // 识图/墨水带采样冻结帧（仅 debug 钩子可置位，net 局不触碰）
    const dt = Math.min(100, t - lastT)
    lastT = t
    simAcc += dt
    while (simAcc >= 100) { simAcc -= 100; S.round.t++; S.round.rem = Math.max(0, S.round.rem - 1); if (S.respawnIn > 0) S.respawnIn-- }
    stepLocal(dt)
    render()
    fpsAcc += dt; fpsN++
    if (fpsAcc >= 500) { fpsShown = Math.round(1000 / (fpsAcc / fpsN)); fpsAcc = 0; fpsN = 0 }
    requestAnimationFrame(frame)
  }

  /* ---------- 调试钩子（识图 v2/取证，mmo/element 先例） ---------- */
  window.__GAMES_DEBUG__ = {
    events: [],
    start(level) { S.debugLevel = level; startDebugArena(); report('start', { level }); return true },
    pause(v) { S.pauseViz = !!v; return true }, // visual-check 识图契约（GAMES-49）：冻结帧采样墨水带
    hudFonts: () => hudFontReg,
    fps: () => fpsShown,
    state: () => ({ mode: S.mode, seat: S.seat, ents: S.ents.size, dead: S.dead, round: S.round, lb: S.lb.slice(0, 5), mm: S.mm.length, boost: S.boostOn, target: S.target }),
    sfxCalls: () => sfx.calls.slice(-40),
    cam: () => ({ x: cam.x, y: cam.y, zoom: +cam.zoom.toFixed(3) }),
  }

  /* ---------- 启动 ---------- */
  report('boot', { slug: 'snake-king', version: '1.0.0', mode: 'net' })
  const q = new URLSearchParams(location.search)
  requestAnimationFrame(frame)
  if (q.get('debug') === '1') { window.__GAMES_DEBUG__.start(1) }
  else connect()
})()
