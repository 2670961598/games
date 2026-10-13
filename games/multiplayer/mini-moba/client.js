/* =====================================================================
 * 迷你MOBA mini-moba 客户端（GAMES-127 · E6/W2/T2）——S2 状态同步第二款。
 * 服务端权威 10Hz 快照；本地=移动预测（同式积分+指数收敛和解）、敌人 120ms
 * 插值、弹道/前摇乐观表现（伤害数字只等权威 hit 事件，设计 §5.5）。
 * HUD 字号 HF 登记（hud-font-standard §1 分级，__GAMES_DEBUG__.hudFonts() 自证）；
 * 阵营双色+形状第二通道（§7）；技能类型×形状双编码。
 * ===================================================================== */
(function () {
  'use strict'
  /* ---------- 基础 ---------- */
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d')
  var W = 375, H = 667, VW = W, VH = H
  var qs = new URLSearchParams(location.search)
  var GW = qs.get('gw') || location.origin
  var ROOM = qs.get('room') || sessionStorage.getItem('moba.room') || null
  var K = 1000 // mpx → px
  var WORLD = { w: 1000, h: 1700 }
  var TEAM_COL = { A: '#E8A33D', B: '#3DC8E8' }
  var TEAM_DIM = { A: '#8a6425', B: '#1e6f83' }
  var MAP = {
    lane: { x0: 400, x1: 600 },
    river: { y0: 770, y1: 930 },
    grass: [[640, 580], [160, 620], [200, 850], [800, 850], [360, 1120], [840, 1080]],
    fountains: { A: [500, 1620, 140], B: [500, 80, 140] },
    towers: { 'tw-A1': [500, 1150, 'A', 1], 'tw-A2': [500, 1420, 'A', 2], 'tw-B1': [500, 550, 'B', 1], 'tw-B2': [500, 280, 'B', 2] },
    cores: { 'core-A': [500, 1620, 'A'], 'core-B': [500, 80, 'B'] },
  }
  var HERO_SHAPE = { guard: 8, ranger: 3, mage: 4, shadow: 6 }
  var HERO_NAME = { guard: '铁卫', ranger: '游侠', mage: '星法师', shadow: '影刃' }
  /* 技能钮：类型×颜色（§7 双编码：位移青绿/伤害橙红/控制紫/增益金）+ 前摇 ms（§3.3 乐观弧） */
  var SKILL_UI = {
    guard: [{ c: '#9D6FE8', t: '盾击', w: 150 }, { c: '#3DE8B0', t: '突进', w: 100 }, { c: '#E8C46A', t: '壁垒', w: 200 }],
    ranger: [{ c: '#E8C46A', t: '疾风', w: 0 }, { c: '#E8633D', t: '贯穿', w: 180 }, { c: '#E8633D', t: '箭雨', w: 250 }],
    mage: [{ c: '#E8633D', t: '星陨', w: 200 }, { c: '#9D6FE8', t: '冰锁', w: 150 }, { c: '#9D6FE8', t: '静滞', w: 250 }],
    shadow: [{ c: '#3DE8B0', t: '影袭', w: 0 }, { c: '#E8633D', t: '毒刃', w: 100 }, { c: '#E8633D', t: '绝戮', w: 150 }],
  }
  var ITEM_NAME = { boots: '疾风靴', blade: '破军刃', plate: '玄武甲', frenzy: '狂战徽', leech: '噬血珠', tome: '贤者典' }
  var ITEMS_ORDER = ['boots', 'blade', 'plate', 'frenzy', 'leech', 'tome']
  var HF_REGISTRY = {}
  function HF(tag, px, weight) { var f = px + 'px ' + (weight || 600) + 'px -apple-system,"PingFang SC",sans-serif'; HF_REGISTRY[tag] = px; return f }
  var F = {
    p0: function () { return HF('p0', 13, 700) }, p0n: function () { return HF('p0n', 13, 600) },
    p1: function () { return HF('p1', 11, 600) }, p2: function () { return HF('p2', 9, 500) },
    p1b: function () { return HF('p1b', 11, 700) },
  }
  var dbgEvents = []
  function emitDbg(ev, payload) { dbgEvents.push({ event: ev, payload: payload, at: Date.now() }) }

  /* ---------- 状态 ---------- */
  var ws = null, mySeat = -1, myTeam = 'A', snapSeq = 0
  var ents = {}            // id → {ent, tl:[{t,x,y}], flash}
  var me = null            // 自己的实体（预测位 px/py + 服务器位 sx/sy）
  var pred = { x: 0, y: 0, mx: 0, my: 0, seq: 0 }
  var ext = { t: null, me: null }
  var welcome = null, ended = null, roomInfo = null
  var fx = { shots: [], hits: [], zones: [], floats: [], feed: [], shakes: 0, recall: 0, rejectAt: 0, buyToast: null }
  var cam = { x: 500, y: 850 }
  var inputTimer = null, lastSent = 0
  var windup = null        // {idx, until} 前摇乐观弧
  var deadOverlay = null
  var kol = { graves: [] }

  function fmtTime(tick) { var s = Math.floor(tick / 10); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) }

  /* ---------- WS 连接 ---------- */
  function connect() {
    var url = GW.replace(/^http/, 'ws') + '/ws'
    try { ws = new WebSocket(url) } catch (e) { fatal('网关不可达：' + GW); return }
    ws.onopen = function () { send({ t: 'hello', v: 1 }); join() }
    ws.onerror = function () { hint('网关连接失败（?gw=http://host:4400）') }
    ws.onclose = function () { if (!ended) hint('连接断开，刷新重试') }
    ws.onmessage = function (m) {
      var msg
      try { msg = JSON.parse(m.data) } catch (e) { return }
      emitDbg('msg-' + msg.t, msg.t)
      if (msg.t === 'welcome') onWelcome(msg)
      else if (msg.t === 'snapshot') onSnapshot(msg)
      else if (msg.t === 'seat') roomInfo = msg
      else if (msg.t === 'started') hint('')
      else if (msg.t === 'end') { ended = msg; emitDbg('end', msg.result) }
      else if (msg.t === 'error') hint('错误：' + msg.code)
    }
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)) }
  function join() {
    if (ROOM) { sessionStorage.setItem('moba.room', ROOM); send({ t: 'join', roomId: ROOM, mode: 'play', name: '玩家' }) }
    else send({ t: 'quick', gameId: 'mini-moba' })
  }
  function onWelcome(msg) {
    welcome = msg
    mySeat = msg.seat != null ? msg.seat : -1
    myTeam = mySeat % 2 === 0 ? 'A' : 'B'
    if (msg.roomId) { ROOM = msg.roomId; sessionStorage.setItem('moba.room', ROOM) }
    roomInfo = msg.room
    if (msg.state) { // 全量 state：塔/水晶/英雄就位
      for (var id in msg.state.ents) touchEnt(msg.state.ents[id])
      ext.t = { kills: msg.state.stats && msg.state.stats.kills, towers: msg.state.stats && msg.state.stats.towers, shrineAt: msg.state.shrine && msg.state.shrine.nextAt }
    }
    hint(msg.room && msg.room.countdownMs > 0 ? '集结中…' : '')
  }

  /* ---------- 快照 ---------- */
  function touchEnt(e) {
    if (!e || !e.id) return
    var r = ents[e.id]
    if (!r) r = ents[e.id] = { ent: e, tl: [], flash: 0 }
    r.ent = e
    r.tl.push({ t: Date.now(), x: e.x / K, y: e.y / K })
    if (r.tl.length > 4) r.tl.shift()
    if (e.id === 'h' + mySeat) {
      if (!me) { me = r; pred.x = e.x / K; pred.y = e.y / K }
      r.sx = e.x / K; r.sy = e.y / K
      if (e.cc && e.cc.kind) { pred.mx = 0; pred.my = 0 } // 控制/定身：预测冻结（§3.2）
    }
    return r
  }
  function onSnapshot(msg) {
    snapSeq = msg.snapSeq
    if (msg.frame) snapTick = msg.frame
    if (msg.full) { var keep = {}; for (var i = 0; i < msg.ents.length; i++) keep[msg.ents[i].id] = 1; for (var id in ents) if (!keep[id] && id !== (me && me.ent.id)) delete ents[id] }
    for (var j = 0; j < msg.ents.length; j++) touchEnt(msg.ents[j])
    if (msg.leave) for (var l = 0; l < msg.leave.length; l++) delete ents[msg.leave[l]]
    if (msg.ext) {
      ext = msg.ext
      if (msg.ext.ack != null && msg.ext.ack >= 0) { /* ack：已处理输入序号（预测历史可弃，§5.5） */ }
    }
    if (msg.events) for (var e = 0; e < msg.events.length; e++) onEvent(msg.events[e])
  }

  /* ---------- 事件 → 表现（ruling 账本=juice 零 diff 触发，§5.3） ---------- */
  function onEvent(ev) {
    if (ev.k === 'hit') {
      var r = ents[ev.vic]
      if (r) r.flash = 80
      fx.floats.push({ x: r ? r.ent.x / K : cam.x, y: r ? r.ent.y / K : cam.y, txt: (ev.m ? '✦' : '⚔') + ev.dmg, magic: !!ev.m, at: Date.now() })
    } else if (ev.k === 'shot') {
      var f = ev.from ? [ev.from[0] / K, ev.from[1] / K] : [cam.x, cam.y]
      var to = ev.to ? [ev.to[0] / K, ev.to[1] / K]
        : (ev.dir ? [f[0] + ev.dir[0] * (ev.maxDist || 300) / K, f[1] + ev.dir[1] * (ev.maxDist || 300) / K] : [f[0], f[1] - 3])
      fx.shots.push({ x: f[0], y: f[1], tx: to[0], ty: to[1], at: Date.now(), dur: 320, magic: ev.skill ? true : false })
    } else if (ev.k === 'zone') {
      fx.zones.push({ x: ev.x / K, y: ev.y / K, r: ev.r / K, at: Date.now(), warn: ev.at * 100, skill: ev.skill, dur: ev.skill === 'star' ? 400 : (ev.dur || 30) * 100 })
    } else if (ev.k === 'kill') {
      var kn = (ev.killer >= 0 ? '席' + ev.killer : '防御塔') + ' ⚔ 席' + ev.victim
      fx.feed.push({ txt: kn, streak: ev.streak, at: Date.now(), team: ev.killer >= 0 ? (ev.killer % 2 === 0 ? 'A' : 'B') : 'W' })
      if (fx.feed.length > 3) fx.feed.shift()
      fx.shakes = Math.max(fx.shakes, ev.streak >= 2 ? 6 : 2)
      if (ev.victim === mySeat) deadOverlay = { respAt: ev.respAt }
    } else if (ev.k === 'tower') {
      fx.feed.push({ txt: (ev.team === 'A' ? 'A' : 'B') + ' 方 ' + (ev.tier === 1 ? '外塔' : '高地塔') + ' 告破', at: Date.now(), team: ev.team === 'A' ? 'B' : 'A' })
      fx.shakes = 8
    } else if (ev.k === 'core') { fx.shakes = 10 }
    else if (ev.k === 'shrine') fx.feed.push({ txt: ev.team + ' 队夺得圣所祝祷！', at: Date.now(), team: ev.team })
    else if (ev.k === 'recall') {
      if (ev.seat === mySeat) fx.recall = ev.phase === 'start' ? 40 : 0
    } else if (ev.k === 'buy') { if (ev.seat === mySeat) fx.buyToast = { item: ev.item, at: Date.now() } }
    else if (ev.k === 'reject') { if (ev.seat === mySeat) fx.rejectAt = Date.now() } // HUD 红闪断言源（§5.1）
    emitDbg('ev-' + ev.k, ev)
  }

  /* ---------- 输入（10Hz 上报：摇杆连续量 + 离散 cmd） ---------- */
  var joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 }
  function joyStart(x, y, id) { joy.active = true; joy.id = id; joy.ox = x; joy.oy = y; joy.dx = 0; joy.dy = 0 }
  function joyMove(x, y) {
    var dx = x - joy.ox, dy = y - joy.oy, len = Math.hypot(dx, dy)
    if (len < 8) { joy.dx = 0; joy.dy = 0; return } // 死区 8px（§3.2）
    var m = Math.min(len, 64) / 64 * 100
    joy.dx = Math.round(dx / len * m); joy.dy = Math.round(dy / len * m)
  }
  function inputLoop() {
    if (!ws || ws.readyState !== 1 || mySeat < 0) return
    pred.mx = joy.dx; pred.my = joy.dy
    var o = { t: 'input', frame: pred.seq++, keys: { mx: pred.mx, my: pred.my } }
    if (pendingCmd) { o.keys.cmd = pendingCmd; pendingCmd = null }
    send(o)
  }
  var pendingCmd = null
  function sendCmd(cmd) { pendingCmd = cmd; emitDbg('cmd', cmd) }

  /* ---------- 触控 ---------- */
  var btnZones = [] // 每帧重建（HUD 绘制时登记）
  cv.addEventListener('touchstart', function (e) {
    e.preventDefault()
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], p = pos(t)
      var hitBtn = null
      for (var b = 0; b < btnZones.length; b++) if (Math.hypot(p.x - btnZones[b].x, p.y - btnZones[b].y) < btnZones[b].r) hitBtn = btnZones[b]
      if (hitBtn) { onBtn(hitBtn.id); continue }
      if (p.x < W / 2) joyStart(p.x, p.y, t.identifier)
    }
  }, { passive: false })
  cv.addEventListener('touchmove', function (e) {
    e.preventDefault()
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i]
      if (joy.active && t.identifier === joy.id) joyMove(pos(t).x, pos(t).y)
    }
  }, { passive: false })
  function tEnd(e) {
    for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === joy.id) { joy.active = false; joy.dx = 0; joy.dy = 0 }
  }
  cv.addEventListener('touchend', tEnd); cv.addEventListener('touchcancel', tEnd)
  // 桌面调试：鼠标拖拽=摇杆
  var mDown = false
  cv.addEventListener('mousedown', function (e) { var p = pos(e); if (p.x < W / 2) { mDown = true; joyStart(p.x, p.y, 'm') } else { var h = null; for (var b = 0; b < btnZones.length; b++) if (Math.hypot(p.x - btnZones[b].x, p.y - btnZones[b].y) < btnZones[b].r) h = btnZones[b]; if (h) onBtn(h.id) } })
  cv.addEventListener('mousemove', function (e) { if (mDown) joyMove(pos(e).x, pos(e).y) })
  window.addEventListener('mouseup', function () { mDown = false; joy.dx = 0; joy.dy = 0 })
  function pos(t) { var r = cv.getBoundingClientRect(); return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) } }
  function onBtn(id) {
    emitDbg('btn', id)
    if (id === 'atk') sendCmd({ k: 'atk' })
    else if (id === 's0' || id === 's1' || id === 's2') {
      var idx = +id[1]
      sendCmd({ k: 'skill', idx: idx })
      var hero = me && me.ent.hero
      if (hero && SKILL_UI[hero][idx].w > 0) windup = { idx: idx, until: Date.now() + SKILL_UI[hero][idx].w }
    } else if (id === 'recall') sendCmd({ k: 'recall' })
    else if (id === 'buy') sendCmd({ k: 'buy' })
    else if (id === 'again') location.href = location.pathname
  }

  /* ---------- 渲染 ---------- */
  var R = { w2s: function (wx, wy) { return { x: wx - cam.x + W / 2, y: wy - cam.y + H / 2 } } }
  function lerpEnt(r, delay) { // 敌人插值（120ms 渲染延迟，§5.5）
    var now = Date.now() - delay
    var tl = r.tl
    if (!tl.length) return { x: r.ent.x / K, y: r.ent.y / K }
    if (tl.length === 1 || now <= tl[0].t) return tl[0]
    for (var i = tl.length - 1; i >= 0; i--) {
      if (tl[i].t <= now) {
        var a = tl[i], b = tl[Math.min(i + 1, tl.length - 1)]
        var span = b.t - a.t || 1
        var al = Math.min(1.5, (now - a.t) / span)
        return { x: a.x + (b.x - a.x) * al, y: a.y + (b.y - a.y) * al }
      }
    }
    return tl[0]
  }
  function shapePath(cx, cy, r, n, rot) {
    ctx.beginPath()
    for (var i = 0; i < n; i++) {
      var a = rot + i / n * Math.PI * 2
      var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }
  function drawHpBar(x, y, w, pct, team, seg) {
    ctx.fillStyle = 'rgba(6,10,12,.8)'
    ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 5)
    ctx.fillStyle = TEAM_COL[team]
    if (seg) { // B=分段血条（§7 形状第二通道）
      var n = 4, sw = w / n
      for (var i = 0; i < n; i++) { var segPct = Math.max(0, Math.min(1, pct * n - i)); if (segPct > 0) ctx.fillRect(x - w / 2 + i * sw + 0.5, y, sw * segPct - 1, 3) }
    } else ctx.fillRect(x - w / 2, y, w * Math.max(0, pct), 3)
  }
  function drawMap(now) {
    ctx.fillStyle = '#0D1B22'; ctx.fillRect(0, 0, W, H)
    // 野区苔原暗绿（左右纵带）
    ctx.fillStyle = '#1A2E24'
    ctx.fillRect(sx(0), sy(0), sx(400) - sx(0), sy(1700) - sy(0))
    ctx.fillRect(sx(600), sy(0), sx(1000) - sx(600), sy(1700) - sy(0))
    // 主道暖石径
    ctx.fillStyle = '#6E6046'
    ctx.fillRect(sx(400), sy(0), sx(600) - sx(400), sy(1700) - sy(0))
    // 河道流光
    ctx.fillStyle = '#2E6E8C'
    ctx.fillRect(sx(0), sy(770), sx(1000) - sx(0), sy(930) - sy(770))
    ctx.strokeStyle = 'rgba(180,230,255,.18)'; ctx.lineWidth = 1
    for (var i = 0; i < 3; i++) {
      var wy = 790 + i * 45 + Math.sin(now / 700 + i) * 3
      ctx.beginPath(); ctx.moveTo(sx(0), sy(wy)); ctx.lineTo(sx(1000), sy(wy)); ctx.stroke()
    }
    // 草丛
    for (var g = 0; g < MAP.grass.length; g++) {
      var gx = MAP.grass[g]
      ctx.fillStyle = 'rgba(46,110,80,.55)'
      ctx.beginPath(); ctx.arc(sx(gx[0]), sy(gx[1]), 55, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'rgba(120,200,150,.35)'; ctx.stroke()
    }
    // 泉水
    for (var tm in MAP.fountains) {
      var f = MAP.fountains[tm]
      ctx.fillStyle = tm === 'A' ? 'rgba(232,163,61,.10)' : 'rgba(61,200,232,.10)'
      ctx.beginPath(); ctx.arc(sx(f[0]), sy(f[1]), f[2], 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = TEAM_DIM[tm]; ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([])
    }
  }
  function sx(wx) { return wx - cam.x + W / 2 }
  function sy(wy) { return wy - cam.y + H / 2 }
  function drawBuilds(now) {
    for (var id in MAP.towers) {
      var t = MAP.towers[id], e = ents[id]
      if (e && e.ent.hp <= 0) continue // 已破：不画（碎石表现由 feed/震动承担）
      var hp = e ? e.ent.hp / e.ent.maxhp : 1, inv = e && e.ent.inv
      var x = sx(t[0]), y = sy(t[1])
      ctx.save(); ctx.translate(x, y)
      // 基座
      ctx.fillStyle = '#24333B'; ctx.fillRect(-24, -20, 48, 44)
      // A=三角旗 / B=燕尾旗（§7 形状第二通道）
      ctx.fillStyle = TEAM_COL[t[2]]
      ctx.beginPath()
      if (t[2] === 'A') { ctx.moveTo(0, -22); ctx.lineTo(16, 16); ctx.lineTo(-16, 16) }
      else { ctx.moveTo(-16, -20); ctx.lineTo(16, -20); ctx.lineTo(16, 8); ctx.lineTo(0, 0); ctx.lineTo(-16, 8) }
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = '#0D1B22'; ctx.lineWidth = 1.5; ctx.stroke()
      if (inv) { ctx.strokeStyle = 'rgba(220,230,240,.75)'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(0, 0, 27, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]) }
      ctx.restore()
      drawHpBar(x, y + 20, 44, hp, t[2], t[2] === 'B')
      ctx.fillStyle = '#F2F2F2'; ctx.font = F.p2(); ctx.textAlign = 'center'
      ctx.fillText(t[3] === 1 ? '外塔' : '高地', x, y + 32)
    }
    for (var cid in MAP.cores) {
      var c = MAP.cores[cid], ce = ents[cid]
      if (ce && ce.ent.hp <= 0) continue
      var chp = ce ? ce.ent.hp / ce.ent.maxhp : 1, cinv = ce && ce.ent.inv
      var cx = sx(c[0]), cy = sy(c[1])
      ctx.save(); ctx.translate(cx, cy)
      var pulse = 1 + Math.sin(now / 300) * 0.04
      ctx.scale(pulse, pulse)
      ctx.fillStyle = TEAM_DIM[c[2]]
      shapePath(0, 0, 26, c[2] === 'A' ? 3 : 4, -Math.PI / 2); ctx.fill()
      ctx.fillStyle = TEAM_COL[c[2]]
      shapePath(0, 0, 16, c[2] === 'A' ? 3 : 4, -Math.PI / 2); ctx.fill()
      if (cinv) { ctx.strokeStyle = 'rgba(220,230,240,.8)'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]) }
      ctx.restore()
      drawHpBar(cx, cy + 32, 52, chp, c[2], c[2] === 'B')
    }
  }
  function drawEnts(now) {
    var list = []
    for (var id in ents) {
      var r = ents[id], e = r.ent
      if (e.hp <= 0 && e.k !== 'hero') continue
      if (e.k === 'tw' || e.k === 'core') continue
      list.push(r)
    }
    list.sort(function (a, b) { return a.ent.y - b.ent.y })
    for (var i = 0; i < list.length; i++) {
      var r2 = list[i], e2 = r2.ent
      var own = e2.id === 'h' + mySeat
      var p = own ? { x: pred.x, y: pred.y } : lerpEnt(r2, 120)
      var x = sx(p.x), y = sy(p.y)
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue
      if (e2.k === 'hero') {
        if (e2.dead) { // 墓碑标记（§3.5）
          ctx.fillStyle = 'rgba(120,130,140,.5)'; ctx.fillRect(x - 7, y - 10, 14, 16)
          continue
        }
        var col = TEAM_COL[e2.team]
        var sh = HERO_SHAPE[e2.hero] || 6
        if (own) { ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke() }
        if (r2.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,.6)'; shapePath(x, y, 15, sh, e2.dir ? -e2.dir * Math.PI / 180 : 0); ctx.fill(); r2.flash -= 16 }
        ctx.fillStyle = col
        shapePath(x, y, 12, sh, e2.dir ? -e2.dir * Math.PI / 180 : 0); ctx.fill()
        ctx.strokeStyle = '#0D1B22'; ctx.lineWidth = 1.5; ctx.stroke()
        if (e2.sh > 0) { ctx.strokeStyle = '#E8C46A'; ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2 * Math.min(1, e2.sh / 300)); ctx.stroke() }
        drawHpBar(x, y - 22, 40, e2.hp / e2.maxhp, e2.team, e2.team === 'B')
        ctx.fillStyle = '#F2F2F2'; ctx.font = F.p1b(); ctx.textAlign = 'center'
        ctx.fillText('L' + e2.lv + ' ' + HERO_NAME[e2.hero], x, y - 26)
        if (e2.cc && e2.cc.kind) { ctx.fillStyle = '#9D6FE8'; ctx.font = F.p2(); ctx.fillText(e2.cc.kind === 'stun' ? '眩晕' : e2.cc.kind === 'root' ? '定身' : '减速', x, y + 26) }
      } else if (e2.k === 'creep') {
        ctx.fillStyle = TEAM_DIM[e2.team]
        shapePath(x, y, 6, e2.rng ? 4 : 6, 0); ctx.fill()
        ctx.fillStyle = TEAM_COL[e2.team]
        shapePath(x, y, 3.5, e2.rng ? 4 : 6, 0); ctx.fill()
        drawHpBar(x, y - 10, 14, e2.hp / e2.maxhp, e2.team, e2.team === 'B')
      } else if (e2.k === 'mon') {
        var shrine = e2.camp === 'shrine'
        ctx.fillStyle = shrine ? '#7FE8D0' : '#8a7d5c'
        shapePath(x, y, shrine ? 20 : 11, shrine ? 5 : 7, now / 900); ctx.fill()
        ctx.strokeStyle = '#0D1B22'; ctx.lineWidth = 1.5; ctx.stroke()
        drawHpBar(x, y - (shrine ? 28 : 14), shrine ? 40 : 18, e2.hp / e2.maxhp, shrine ? 'A' : 'B', false)
        if (!shrine) { ctx.fillStyle = '#F2F2F2'; ctx.font = F.p2(); ctx.textAlign = 'center'; ctx.fillText(e2.camp === 'rune' ? '灵藤' : '岩蜥', x, y + 20) }
        else { ctx.fillStyle = '#7FE8D0'; ctx.font = F.p1b(); ctx.textAlign = 'center'; ctx.fillText('圣所巨灵龟', x, y + 32) }
      }
    }
  }
  function drawFx(now) {
    // 弹道（轨迹事件驱动的纯装饰外推，§5.3 规则 4）
    fx.shots = fx.shots.filter(function (s) {
      var t = (now - s.at) / s.dur
      if (t >= 1) return false
      var x = s.x + (s.tx - s.x) * t, y = s.y + (s.ty - s.y) * t
      ctx.strokeStyle = s.magic ? 'rgba(180,140,232,.9)' : 'rgba(242,242,242,.9)'
      ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.moveTo(sx(x), sy(y)); ctx.lineTo(sx(x - (s.tx - s.x) * 0.08), sy(y - (s.ty - s.y) * 0.08)); ctx.stroke()
      return true
    })
    // 区域（星陨预警圈/箭雨/静滞）
    fx.zones = fx.zones.filter(function (z) {
      var age = now - z.at
      if (age > z.dur + 300) return false
      ctx.strokeStyle = z.skill === 'star' ? 'rgba(232,99,61,.85)' : z.skill === 'stasis' ? 'rgba(157,111,232,.8)' : 'rgba(232,163,61,.8)'
      ctx.setLineDash([5, 4]); ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(sx(z.x), sy(z.y), z.r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
      ctx.font = F.p2(); ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'center'
      ctx.fillText(z.skill === 'star' ? '星陨' : z.skill === 'stasis' ? '静滞' : '箭雨', sx(z.x), sy(z.y) - z.r - 4)
      return true
    })
    // 伤害飘字（物理白⚔前缀/法术青紫✦前缀，§7）
    fx.floats = fx.floats.filter(function (f) {
      var age = now - f.at
      if (age > 700) return false
      var y = sy(f.y) - 18 - age / 700 * 26
      ctx.font = F.p1b(); ctx.textAlign = 'center'
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,10,12,.85)'
      ctx.strokeText(f.txt, sx(f.x), y)
      ctx.fillStyle = f.magic ? '#B48CE8' : '#F2F2F2'
      ctx.fillText(f.txt, sx(f.x), y)
      return true
    })
    // 击杀播报条（顶部下滑，§7）
    for (var i = 0; i < fx.feed.length; i++) {
      var fd = fx.feed[i], age = now - fd.at
      if (age > 3200) continue
      var y0 = 58 + i * 22 + Math.min(1, age / 180) * 8
      ctx.fillStyle = 'rgba(13,27,34,.82)'
      var txt = fd.txt + (fd.streak >= 2 ? ' ·' + (fd.streak >= 5 ? '超神' : fd.streak >= 3 ? '三杀' : '双杀') : '')
      ctx.font = F.p1()
      var w = ctx.measureText(txt).width + 20
      ctx.fillRect(W / 2 - w / 2, y0, w, 18)
      ctx.fillStyle = fd.team === 'W' ? '#9FB8C4' : TEAM_COL[fd.team]
      ctx.textAlign = 'center'; ctx.fillText(txt, W / 2, y0 + 13)
    }
    fx.feed = fx.feed.filter(function (f) { return now - f.at < 3400 })
  }
  function drawMinimap() {
    var R0 = 92, x0 = 8, y0 = 62, sc = R0 / 1000 * (1700 / 1000) / 1.7 * 2.6
    var mx = function (wx) { return x0 + wx / 1000 * (R0 * 0.92) }, my = function (wy) { return y0 + wy / 1700 * (R0 * 1.52) }
    ctx.fillStyle = 'rgba(10,20,26,.88)'
    ctx.beginPath(); ctx.arc(x0 + R0 / 2, y0 + R0 * 0.76, R0 * 0.72, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#6E6046'; ctx.fillRect(mx(440), my(0), mx(560) - mx(440), my(1700) - my(0))
    ctx.fillStyle = '#2E6E8C'; ctx.fillRect(mx(0), my(790), mx(1000) - mx(0), my(910) - my(790))
    // 视野圈（AOI 即战争迷雾，§5.2）
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(mx(pred.x), my(pred.y), R0 * 0.72 / 1000 * 640 * (1000 / 1700) * 1.7, 0, Math.PI * 2); ctx.stroke()
    for (var id in ents) {
      var e = ents[id].ent
      if (e.hp <= 0) continue
      if (e.k === 'hero') { ctx.fillStyle = TEAM_COL[e.team]; ctx.beginPath(); ctx.arc(mx(e.x / K), my(e.y / K), 2.5, 0, Math.PI * 2); ctx.fill() }
      else if (e.k === 'tw') { ctx.fillStyle = TEAM_COL[e.team]; ctx.fillRect(mx(e.x / K) - 2, my(e.y / K) - 2, 4, 4) }
    }
    var t = ext.t || {}
    if (t.shrineAt > 0) { // 圣所倒计时（团战节拍器，§7 HUD）
      ctx.fillStyle = '#7FE8D0'; ctx.font = F.p2(); ctx.textAlign = 'center'
      var secs = Math.max(0, Math.ceil((t.shrineAt - (welcome && welcome.frame || 0)) / 10))
      ctx.fillText('圣所 ' + (secs > 90 ? Math.ceil(secs / 60) + 'm' : secs + 's'), x0 + R0 / 2, y0 + R0 * 1.52 + 10)
    }
  }
  function drawTopbar(now, tick) {
    ctx.fillStyle = 'rgba(10,20,26,.9)'; ctx.fillRect(0, 0, W, 34)
    var t = ext.t || {}, kills = t.kills || { A: 0, B: 0 }, tw = t.towers || { A: 0, B: 0 }
    ctx.textAlign = 'center'; ctx.font = F.p0()
    ctx.fillStyle = TEAM_COL.A; ctx.fillText('' + (kills.A || 0), 96, 22)
    ctx.fillStyle = '#9FB8C4'; ctx.fillText(fmtTime(tick) + '  塔 ' + (tw.A || 0) + '-' + (tw.B || 0), W / 2 + 10, 22)
    ctx.fillStyle = TEAM_COL.B; ctx.fillText('' + (kills.B || 0), W - 96, 22)
    ctx.font = F.p2(); ctx.fillStyle = '#9FB8C4'
    ctx.fillText('A 击杀', 96, 32); ctx.fillText('B 击杀', W - 96, 32)
    var m = ext.me
    if (m) {
      ctx.textAlign = 'left'; ctx.font = F.p0n(); ctx.fillStyle = '#E8C46A'
      ctx.fillText('金 ' + m.g, 8, 50)
      ctx.fillStyle = '#F2F2F2'; ctx.font = F.p1()
      ctx.fillText(m.k + '/' + m.d + '/' + m.a, 8, 64)
      if (m.rune) { ctx.fillStyle = '#7FE8D0'; ctx.fillText('灵纹', 70, 50) }
      var bl = t.bless
      if (bl && bl.team === myTeam) { ctx.fillStyle = '#E8A33D'; ctx.fillText('祝祷', 70, 64) }
      // 装备格（P1 名）
      var ix = W - 8
      for (var i = ITEMS_ORDER.length - 1; i >= 0; i--) {
        var code = ITEMS_ORDER[i]
        if (m.items && m.items.indexOf(code) < 0) continue
        ctx.fillStyle = 'rgba(46,110,140,.6)'; ctx.fillRect(ix - 14, 40, 14, 14)
        ctx.strokeStyle = '#7FE8D0'; ctx.strokeRect(ix - 14, 40, 14, 14)
        ix -= 17
      }
    }
    if (t.bless) { ctx.fillStyle = TEAM_COL[t.bless.team]; ctx.font = F.p2(); ctx.textAlign = 'center'; ctx.fillText(t.bless.team + ' 方祝祷中（对建筑 +25%）', W / 2, 46) }
    // reject 红闪（非法 cmd 回流，§5.1）
    if (now - fx.rejectAt < 400) { ctx.fillStyle = 'rgba(232,63,61,' + (0.5 * (1 - (now - fx.rejectAt) / 400)) + ')'; ctx.fillRect(0, 0, W, H) }
  }
  function drawControls(now) {
    btnZones = []
    // 浮动摇杆
    if (joy.active) {
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(joy.ox, joy.oy, 64, 0, Math.PI * 2); ctx.stroke()
      var jx = joy.ox + joy.dx / 100 * 64, jy = joy.oy + joy.dy / 100 * 64
      ctx.fillStyle = 'rgba(255,255,255,.5)'
      ctx.beginPath(); ctx.arc(jx, jy, 26, 0, Math.PI * 2); ctx.fill()
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.12)'
      ctx.beginPath(); ctx.arc(78, H - 70, 52, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.font = F.p2(); ctx.textAlign = 'center'
      ctx.fillText('摇杆', 78, H - 66)
    }
    var hero = me && me.ent && me.ent.hero
    var sui = hero ? SKILL_UI[hero] : null
    // 普攻大钮 Ø64
    var ax = W - 52, ay = H - 66
    ctx.fillStyle = '#B8472B'; ctx.beginPath(); ctx.arc(ax, ay, 32, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = '#0D1B22'; ctx.lineWidth = 2; ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.font = F.p0(); ctx.textAlign = 'center'; ctx.fillText('攻击', ax, ay + 4)
    btnZones.push({ x: ax, y: ay, r: 34, id: 'atk' })
    // 技能钮 ×3（Ø56 弧排）+ 冷却径向环（§7）
    for (var i = 0; i < 3; i++) {
      var ang = Math.PI * (0.72 + i * 0.28), r = 78
      var bx = ax - 12 + Math.cos(ang) * r * 1.15, by = ay - 66 + Math.sin(ang) * r * 0.72
      bx = Math.max(30, Math.min(W - 30, bx)); by = Math.max(H - 260, Math.min(H - 110, by))
      var ui = sui ? sui[i] : { c: '#888', t: '?', w: 0 }
      var e = me && me.ent, cd = e && e.cd ? e.cd[i] : 0, locked = i === 2 && e && e.lv < 6
      ctx.fillStyle = locked ? '#3A4A50' : ui.c
      ctx.beginPath(); ctx.arc(bx, by, 28, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#0D1B22'; ctx.lineWidth = 2; ctx.stroke()
      ctx.fillStyle = locked ? '#7A8A90' : '#fff'; ctx.font = F.p1(); ctx.textAlign = 'center'
      ctx.fillText(locked ? '6级' : ui.t, bx, by + 4)
      if (cd > 0) { // 冷却径向环+剩余秒数（P0）
        ctx.fillStyle = 'rgba(6,10,12,.55)'
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.arc(bx, by, 28, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, cd / 90)); ctx.closePath(); ctx.fill()
        ctx.fillStyle = '#F2F2F2'; ctx.font = F.p0n(); ctx.fillText(Math.ceil(cd / 10) + 's', bx, by + 3)
      }
      if (windup && windup.idx === i && now < windup.until) { // 前摇乐观进度弧（§3.3）
        var w0 = sui ? sui[i].w : 0
        var pr = 1 - (windup.until - now) / Math.max(1, w0)
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3
        ctx.beginPath(); ctx.arc(bx, by, 31, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr); ctx.stroke()
      } else if (windup && windup.idx === i) windup = null
      btnZones.push({ x: bx, y: by, r: 30, id: 's' + i })
    }
    // 回城/商店小钮
    var ry = H - 28, rx = W - 24
    ctx.fillStyle = '#2E6E8C'; ctx.beginPath(); ctx.arc(rx - 96, ry - 8, 17, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = F.p1(); ctx.textAlign = 'center'; ctx.fillText('回城', rx - 96, ry - 4)
    btnZones.push({ x: rx - 96, y: ry - 8, r: 19, id: 'recall' })
    var inFount = me && Math.hypot(me.ent.x / K - MAP.fountains[myTeam][0], me.ent.y / K - MAP.fountains[myTeam][1]) < 140
    var canBuy = me && (me.ent.dead || inFount)
    ctx.fillStyle = canBuy ? '#7A5C2E' : '#3A4A50'
    ctx.beginPath(); ctx.arc(rx - 50, ry - 8, 17, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.fillText('买装', rx - 50, ry - 4)
    btnZones.push({ x: rx - 50, y: ry - 8, r: 19, id: 'buy' })
    // 回城引导条
    if (fx.recall > 0 && me) {
      fx.recall--
      ctx.fillStyle = 'rgba(6,10,12,.7)'; ctx.fillRect(W / 2 - 70, H / 2 - 90, 140, 14)
      ctx.fillStyle = '#7FE8D0'; ctx.fillRect(W / 2 - 68, H / 2 - 88, 136 * (1 - fx.recall / 40), 10)
      ctx.fillStyle = '#F2F2F2'; ctx.font = F.p1(); ctx.textAlign = 'center'; ctx.fillText('回城引导中…', W / 2, H / 2 - 96)
    }
    if (fx.buyToast && now - fx.buyToast.at < 1500) {
      ctx.fillStyle = '#E8C46A'; ctx.font = F.p1b(); ctx.textAlign = 'center'
      ctx.fillText('已购 ' + (ITEM_NAME[fx.buyToast.item] || fx.buyToast.item), W / 2, H / 2 - 120)
    }
  }
  function drawDead(now, tick) {
    if (!me || !me.ent.dead) { deadOverlay = null; return }
    var e = me.ent
    var left = Math.max(0, Math.ceil((e.respAt - snapTick) / 10))
    ctx.fillStyle = 'rgba(6,10,12,.55)'; ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#F2F2F2'; ctx.font = HF('dead', 34, 700); ctx.textAlign = 'center'
    ctx.fillText('' + (left > 0 ? left : '…'), W / 2, H / 2 - 10)
    ctx.font = F.p1(); ctx.fillStyle = '#9FB8C4'
    ctx.fillText('复活倒计时（5+2×等级 秒）', W / 2, H / 2 + 18)
  }
  function drawEnd() {
    if (!ended) return
    var r = ended.result || {}
    ctx.fillStyle = 'rgba(6,10,12,.88)'; ctx.fillRect(0, 0, W, H)
    var win = r.winner === myTeam
    ctx.fillStyle = win ? TEAM_COL[myTeam] : '#9FB8C4'
    ctx.font = HF('end', 30, 700); ctx.textAlign = 'center'
    ctx.fillText(r.winner === 'draw' ? '平局' : win ? '胜利' : '败北', W / 2, 150)
    ctx.font = F.p1(); ctx.fillStyle = '#9FB8C4'
    ctx.fillText('终局：' + (r.reason || ''), W / 2, 178)
    var m = ext.me
    if (m) {
      ctx.font = F.p0n(); ctx.fillStyle = '#F2F2F2'
      ctx.fillText('KDA ' + m.k + '/' + m.d + '/' + m.a + ' · 等级 L' + m.lv, W / 2, 240)
      ctx.fillText('装备 ' + (m.items || []).map(function (i) { return ITEM_NAME[i] || i }).join(' '), W / 2, 268)
    }
    ctx.fillStyle = '#2E6E8C'
    ctx.fillRect(W / 2 - 70, 320, 140, 40)
    ctx.fillStyle = '#fff'; ctx.font = F.p0()
    ctx.fillText('再来一局', W / 2, 346)
    btnZones.push({ x: W / 2, y: 340, r: 80, id: 'again' })
  }

  /* ---------- 主循环 ---------- */
  var lastFrame = 0
  function frame(now) {
    requestAnimationFrame(frame)
    var dt = Math.min(50, now - lastFrame || 16); lastFrame = now
    var e = me && me.ent
    // 本地移动预测（同式积分；速度=英雄基准×摇杆，§3.2 即时映射）
    if (e && !e.dead && !(e.cc && e.cc.kind)) {
      var spd = { guard: 150, ranger: 150, mage: 150, shadow: 155 }[e.hero] || 150
      if (e.buffs) for (var bi = 0; bi < e.buffs.length; bi++) {
        if (e.buffs[bi].k === 'haste') spd *= e.buffs[bi].v / 256
        if (e.buffs[bi].k === 'slow') spd *= e.buffs[bi].v / 256
      }
      pred.x += spd * pred.mx / 100 * dt / 1000
      pred.y += spd * pred.my / 100 * dt / 1000
      pred.x = Math.max(0, Math.min(1000, pred.x)); pred.y = Math.max(0, Math.min(1700, pred.y))
    }
    // 和解（指数收敛：≤32px 每帧 20%；>32px 快滑不闪跳，§5.5）
    if (me && me.sx != null) {
      var errx = me.sx - pred.x, erry = me.sy - pred.y
      var err = Math.hypot(errx, erry)
      var k0 = err > 32 ? 0.35 : 0.2
      pred.x += errx * k0; pred.y += erry * k0
    }
    if (me && !me.ent.dead) { cam.x += (pred.x - cam.x) * 0.25; cam.y += (pred.y - cam.y) * 0.25 }
    else if (me) { cam.x += (me.ent.x / K - cam.x) * 0.1; cam.y += (me.ent.y / K - cam.y) * 0.1 }
    cam.x = Math.max(W / 2, Math.min(WORLD.w - W / 2, cam.x)); cam.y = Math.max(H / 2, Math.min(WORLD.h - H / 2, cam.y))
    ctx.save()
    if (fx.shakes > 0) { ctx.translate((Math.random() - 0.5) * fx.shakes, (Math.random() - 0.5) * fx.shakes); fx.shakes *= 0.9; if (fx.shakes < 0.3) fx.shakes = 0 }
    var tick = welcome && welcome.frame || 0
    if (snapTick) tick = snapTick
    drawMap(now)
    drawBuilds(now)
    drawEnts(now)
    drawFx(now)
    ctx.restore()
    drawMinimap()
    drawTopbar(now, tick)
    drawControls(now)
    drawDead(now, tick)
    drawEnd()
  }
  var snapTick = 0

  function hint(t) { var h = document.getElementById('hint'); if (h) h.textContent = t }
  function fatal(t) { var f = document.getElementById('fatal'); document.getElementById('fatal-msg').textContent = t; if (f) f.style.display = 'flex' }

  /* ---------- 启动 ---------- */
  connect()
  inputTimer = setInterval(inputLoop, 100) // 10Hz（静止报 0,0 心跳，§5.1）
  requestAnimationFrame(frame)
  window.__GAMES_DEBUG__ = {
    hudFonts: function () { return JSON.parse(JSON.stringify(HF_REGISTRY)) },
    events: dbgEvents,
    state: function () { return { seat: mySeat, team: myTeam, room: ROOM, ents: Object.keys(ents).length, ended: ended } },
    ext: function () { return ext },
  }
})()
