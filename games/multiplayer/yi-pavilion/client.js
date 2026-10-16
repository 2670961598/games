/* =====================================================================
 * 弈界棋阁 客户端（GAMES-155 · S5 回合权威第三证）——宣纸亮阁（§7 全目录首款
 * 亮底联机游戏）。S5 面：渲染=ruling 全量 canonical state 直染（零隐藏信息=
 * 观战/双方同形，设计 §5.2）；本地复算=同源 sim.cjs（YiPavSim）非法格压暗/
 * 威胁角标/送位盘描边（§3.2 零上行，tactics 同源引擎先例）。
 * 棋子形色双编码（票面「天然」：天圆地方）：A 琥珀圆子 ｜ B 青方子——色相+形状
 * 双通道（hud-font-standard §3 纪律，色盲下独立成立）。
 * HUD 字号对齐 HF 体系（hud-font-standard §1）+ __applied 生效自证首日（票面
 * 指定）：登记+ctx.font 回读双值比对（mini-moba/street-soccer「登记 13px 实际
 * 渲染 10px 缺省字」坑的闭环防线，设计 §7/附决策 10）。
 * ===================================================================== */
'use strict'
;(function () {
  const SIM = window.YiPavSim // 同源确定性多规则引擎（本地复算/离线对打）
  const BG = '#F2EBDC', BOARD_C = '#D8B878', LINE_C = '#6B5433', INK = '#3A2E1F'
  const COL_A = '#E8A33D', COL_B = '#3DC8E8'
  const W = 375, H = 667
  const RULE_CN = { gomoku: '五子连珠', reversi: '黑白翻转', cascade: '连环井字' }
  const RULE_DESC = {
    gomoku: '横竖斜先连成五子者胜；首点预落，同格再点确认。',
    reversi: '夹住对方棋子即翻转；无子可下自动让手，终局数子。',
    cascade: '落到哪格，对手就要去对应的小盘；小盘三连定归属，母盘三连胜。',
  }
  /* 棋盘几何（§7 布局：三模式同框架 359×359 居中；格宽=路数定模式指纹） */
  const GEO = { gomoku: { n: 15, cs: 24, x: 8, y: 68 }, reversi: { n: 8, cs: 44, x: 12, y: 68 }, cascade: { n: 9, cs: 39, x: 13, y: 68 } }

  /* ---------- 音效位（平台范式默认静音——只记账，on=true 才委托 PlatformAudio） ---------- */
  const sfx = {
    on: false, calls: [],
    play(tag) { this.calls.push({ tag, at: performance.now() }); if (!this.on) return; const h = window.PlatformAudio; if (h && typeof h.play === 'function') { try { h.play('yi-pavilion:' + tag, '') } catch {} } },
  }

  /* ---------- HUD 字号登记表（HF 体系：P0 ≥13px/600 · P1 ≥11px · P2 ≥9px） ---------- */
  const HF_REGISTRY = {}
  const HF_CLS = { P0: { min: 99, n: 0 }, P1: { min: 99, n: 0 }, P2: { min: 99, n: 0 } }
  function HF(tag, px, weight, cls) {
    const f = (weight || 600) + ' ' + px + 'px -apple-system,"PingFang SC",sans-serif'
    HF_REGISTRY[tag] = px
    const c = HF_CLS[cls] || (px >= 13 ? HF_CLS.P0 : px >= 11 ? HF_CLS.P1 : HF_CLS.P2)
    if (px < c.min) c.min = px
    c.n++
    return f
  }
  const F0 = (px) => HF('p0', Math.max(13, px), 600, 'P0')  // 双方棋钟/手数/子数/占盘数/坐标读数
  const F1 = (px) => HF('p1', Math.max(11, px), 600, 'P1')  // 模式名/托管钮/认输钮/评语/速览
  const F2 = (px) => HF('p2', Math.max(9, px), 500, 'P2')   // 页脚 slug·version/ping

  /* ---------- 网关连接（?gw= 覆盖，resume 凭 sessionStorage token） ---------- */
  const q = new URLSearchParams(location.search)
  const GW = (() => { const g = q.get('gw'); if (g) return `ws://${g}`; if (location.protocol === 'https:') return `wss://${location.host}`; return `ws://${location.hostname || '127.0.0.1'}:4400` })()
  const cv = document.getElementById('cv'), ctx = cv.getContext('2d')
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'
  ctx.scale(dpr, dpr)
  document.getElementById('stage').style.background = BG
  document.getElementById('boot').style.display = 'none'

  /* ---------- QA 证据：__GAMES_DEBUG__.events（泳道契约） ---------- */
  const dbgEvents = []
  const report = (event, payload) => { dbgEvents.push({ event, payload: payload || null, at: Date.now() }) }

  const S = {
    conn: null, seat: 0, token: null, roomId: null, roster: [],
    spectator: false, offline: false, offlineLevel: 'balanced',
    view: null, deadlineAt: 0, clockAt: 0, clockBase: [240000, 240000],
    rule: q.get('rule') && RULE_CN[q.get('rule')] ? q.get('rule') : null,
    pre: -1,          // 五子两段式预落格（§1.7）
    fx: [], banners: [], flipFx: [], result: null, over: false, overAt: 0,
    err: '', connLost: false, pick: null, // pick=模式选择浮层（无 room 且未选模式）
    hint: true, help: false,
  }
  const rs = () => (S.spectator ? 0 : S.seat)
  const ruleOf = () => (S.view && S.view.rule) || S.rule || 'gomoku'
  const geo = () => GEO[ruleOf()]
  /* 席 B 渲染 180° 翻转（服务器行号绝对，§2.1）；观战不翻 */
  const flip = (cell) => { if (rs() !== 1) return cell; const n = geo().n; return (n - 1 - ((cell / n) | 0)) * n + (n - 1 - (cell % n)) }
  const cellXY = (cell) => { const g = geo(); const d = flip(cell); return { x: g.x + (d % g.n) * g.cs, y: g.y + ((d / g.n) | 0) * g.cs } }
  const cellAt = (x, y) => { const g = geo(); for (let c = 0; c < g.n * g.n; c++) { const p = cellXY(c); if (x >= p.x && x <= p.x + g.cs && y >= p.y && y <= p.y + g.cs) return c } return -1 }

  function connect(rule) {
    document.getElementById('boot').textContent = '连接网关 ' + GW.replace('ws://', '') + ' …'
    document.getElementById('boot').style.display = ''
    const ws = new WebSocket(GW)
    S.conn = ws
    ws.onopen = () => {
      S.pick = null
      const rid = q.get('room')
      const saved = (() => { try { return JSON.parse(sessionStorage.getItem('yi-' + rid) || 'null') } catch { return null } })()
      if (rid) ws.send(JSON.stringify({ t: 'join', roomId: rid, mode: q.get('mode') || 'play', resume: saved ? { seat: saved.seat, token: saved.token } : undefined, name: '玩家' }))
      else ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: rule || S.rule || undefined }))
    }
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data) } catch { return } onMsg(m) }
    ws.onclose = () => { S.connLost = true }
    ws.onerror = () => { S.connLost = true }
  }
  const sendOp = (op) => {
    if (S.offline) { offlineApply(op); return }
    if (S.conn && S.conn.readyState === 1) S.conn.send(JSON.stringify(Object.assign({ t: 'op' }, op)))
  }

  function onMsg(m) {
    if (m.t === 'error') { S.err = m.code || m.message; setTimeout(() => { S.err = '' }, 2500); if (S.err === 'room-gone') location.href = '/multiplayer'; return }
    if (m.t === 'welcome') {
      S.roomId = m.roomId; S.spectator = m.role !== 'player'; S.seat = S.spectator ? -1 : m.seat; S.token = m.token
      if (m.token != null) { try { sessionStorage.setItem('yi-' + S.roomId, JSON.stringify({ seat: S.seat, token: m.token })) } catch {} }
      if (m.room && m.room.duel) { S.rule = m.room.duel.rule; if (SIM && m.room.duel.hash !== SIM.ENGINE_HASH) S.banners.push({ txt: '引擎版本更新，建议刷新', c1: '#B0542A', t0: performance.now(), sys: 1 }) }
      if (m.room && m.room.seats) S.roster = m.room.seats
      adopt(m.state)
      report('welcome', { seat: S.seat, rule: ruleOf(), spectator: S.spectator, engine: m.room && m.room.duel ? m.room.duel.hash : null })
      return
    }
    if (m.t === 'seat') { S.roster = m.seats; return }
    if (m.t === 'started') { adopt(m.state); return }
    if (m.t === 'ruling') { adopt(m.state); for (const ev of m.events || []) onEvent(ev); return }
    if (m.t === 'end') {
      S.over = true; S.result = m.result; S.overAt = performance.now()
      const meWin = m.result && m.result.winner === (rs() === 0 ? 'A' : 'B')
      sfx.play(m.result && (m.result.winner === 'draw' || meWin) ? 'win' : 'lose')
      report('end', { winner: m.result && m.result.winner, reason: m.result && m.result.reason })
      return
    }
    if (m.t === 'closed') { S.connLost = true }
  }
  function adopt(v) {
    S.view = v
    S.rule = v && v.rule
    S.deadlineAt = performance.now() + (v && v.timerMs || 0)
    S.clockAt = performance.now()
    S.clockBase = v && v.clock ? [v.clock[0], v.clock[1]] : [240000, 240000]
  }
  /* 事件→演出层（§3.1/§3.3 juice——全部非阻塞） */
  function onEvent(ev) {
    const now = performance.now()
    if (ev.k === 'place') {
      sfx.play('place')
      const p = cellXY(ev.cell)
      S.fx.push({ k: 'land', x: p.x + geo().cs / 2, y: p.y + geo().cs / 2, t0: now })
      S.pre = -1
    }
    if (ev.k === 'flip') { // 翻转波：切比雪夫距离序 40ms/子（首翻 ≤40ms 启动红线 §3.1）
      const src = S.view && S.view.last2 >= 0 ? cellXY(S.view.last2) : null
      const sx = src ? src.x + geo().cs / 2 : W / 2, sy = src ? src.y + geo().cs / 2 : H / 2
      for (const c of ev.cells) { const p = cellXY(c); S.flipFx.push({ x: p.x + geo().cs / 2, y: p.y + geo().cs / 2, to: ev.seat, t0: now + Math.max(0, (Math.max(Math.abs(p.x + geo().cs / 2 - sx), Math.abs(p.y + geo().cs / 2 - sy)) / geo().cs) | 0) * 40 }) }
      sfx.play('flip')
    }
    if (ev.k === 'pass') S.banners.push({ txt: '无子可下 · 让手', c1: '#8A7A5C', t0: now, sys: 1 })
    if (ev.k === 'sub') { sfx.play('sub'); S.fx.push({ k: 'stamp', sub: ev.idx, t0: now }) }
    if (ev.k === 'win-line' || ev.k === 'end') { sfx.play('win'); if (ev.cells) S.fx.push({ k: 'goldline', cells: ev.cells, t0: now }) }
    if (ev.k === 'turn') {
      S.banners.push({ txt: S.spectator ? (ev.seat === 0 ? '黑方行棋' : '白方行棋') : (ev.seat === S.seat ? '你的回合' : '对方行棋'), c1: ev.seat === 0 ? COL_A : COL_B, t0: now, sys: 1, turn: 1 })
      sfx.play('turn')
    }
    if (ev.k === 'timeout-move') S.banners.push({ txt: '超时托管代走', c1: '#9D6BE8', t0: now, sys: 1 })
    if (ev.k === 'host') { S.banners.push({ txt: ev.on ? '托管中·随时夺回' : '已夺回', c1: '#9D6BE8', t0: now, sys: 1 }); sfx.play('host') }
    if (ev.k === 'reject') { S.banners.push({ txt: '此处不可落子', c1: '#B0542A', t0: now, sys: 1 }); sfx.play('reject'); report('reject', ev.why || '') }
  }
  /* 本地复算（§3.2：同源 RULES——非法格压暗/威胁角标/送位盘描边，零上行） */
  function legalSet() {
    const v = S.view
    if (!v || !SIM || v.over) return null
    try { return new Set(SIM.legal(v, rs())) } catch { return null }
  }
  function threatSet() { // 对方一步致胜点红角标（feat.mustBlock——客户端辅助层 §3.2）
    const v = S.view
    if (!v || !SIM || v.over || !S.hint) return []
    try { return SIM.feat(v, rs()).mustBlock } catch { return [] }
  }

  /* ---------- 输入（单拇指：五子两段式/其余大格直落，§1.7） ---------- */
  function pos(e) { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) } }
  cv.addEventListener('pointerdown', (e) => { const p = pos(e); tap(p.x, p.y) }, { passive: false })

  const BTN = { host: { x: 12, w: 64, y: 598, h: 52 }, concede: { x: 84, w: 88, y: 598, h: 52 }, help: { x: 322, w: 40, y: 598, h: 52 } }
  function tap(x, y) {
    if (S.connLost && !S.offline) { connect(); return }
    if (S.over) { // 结算页：再来一局（同 rule）/ 回大厅
      if (y > H - 96 && y < H - 44) {
        try { sessionStorage.removeItem('yi-' + S.roomId) } catch {}
        if (x > W / 2) location.href = '/multiplayer'
        else if (S.offline) offlineStart(S.offlineLevel, S.rule)
        else location.href = `/games/multiplayer/yi-pavilion/index.html?quick=1&rule=${ruleOf()}`
      }
      return
    }
    if (!S.view) { // 模式选择浮层（大厅单卡片 → 三按钮各带一图一句，§1.1）
      if (S.pick === null && !q.get('room') && !S.offline) { S.pick = 1; return }
      const items = [['gomoku', 200], ['reversi', 290], ['cascade', 380]]
      for (const [rule, yy] of items) if (y > yy - 34 && y < yy + 34 && x > 40 && x < W - 40) {
        S.rule = rule
        connect(rule)
        return
      }
      return
    }
    if (S.spectator) return
    /* 底栏钮 */
    if (y > BTN.host.y && y < BTN.host.y + BTN.host.h) {
      if (x > BTN.host.x && x < BTN.host.x + BTN.host.w) { sendOp({ k: 'host', on: !(S.view.host && S.view.host[S.seat]) }); return }
      if (x > BTN.concede.x && x < BTN.concede.x + BTN.concede.w) { // 两段式防误触（§1.7）
        if (S.concedeArm && performance.now() - S.concedeArm < 2500) sendOp({ k: 'concede' })
        else S.concedeArm = performance.now()
        return
      }
      if (x > BTN.help.x && x < BTN.help.x + BTN.help.w) { S.help = !S.help; return }
      return
    }
    if (S.help) { S.help = false; if (x > W / 2 - 80 && x < W / 2 + 80 && y > 470 && y < 510) S.hint = !S.hint; return }
    const v = S.view
    if (v.over) return
    const c = cellAt(x, y)
    if (c < 0) { S.pre = -1; return }
    if (v.turn !== S.seat) { S.pre = -1; return }
    const legal = legalSet()
    if (legal && !legal.has(c)) { sfx.play('reject'); S.pre = -1; return } // 非法格压暗即拒点（本地 0ms §3.1）
    if (ruleOf() === 'gomoku') { // 两段式：同格再点=确认（§1.7 预落 0ms 本地）
      if (S.pre === c) { sendOp({ k: 'place', cell: c }); S.pre = -1 }
      else S.pre = c
      return
    }
    sendOp({ k: 'place', cell: c })
  }

  /* ---------- 绘制 ---------- */
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  /* 棋子：A 圆（天）/ B 方（地）——形色双编码（§7）；从缘描边=阵营第二通道 */
  function drawStone(cx, cy, seat, size, alpha, scale) {
    const g = geo()
    const r = (size || g.cs * 0.38) * (scale === undefined ? 1 : scale)
    ctx.save()
    ctx.globalAlpha = alpha === undefined ? 1 : alpha
    ctx.translate(cx, cy)
    if (seat === 0) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = COL_A; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#8A5B14'; ctx.stroke() }
    else { const r2 = r * 0.9; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-r2, -r2, r2 * 2, r2 * 2, r * 0.22) : roundRect(-r2, -r2, r2 * 2, r2 * 2, r * 0.22); ctx.fillStyle = COL_B; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#1A6E84'; ctx.stroke() }
    ctx.fillStyle = 'rgba(255,252,240,0.85)'
    ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.32, r * 0.16, 0, Math.PI * 2); ctx.fill() // 高光
    ctx.restore()
  }
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const coordName = (cell) => { const g = geo(); return `${String.fromCharCode(65 + (cell % g.n))}${g.n - ((cell / g.n) | 0)}` }
  let lastT = 0, fpsAcc = 0, fpsN = 0, fpsShown = 0
  function render() {
    const now = performance.now()
    if (lastT) { fpsAcc += now - lastT; fpsN++; if (fpsAcc >= 500) { fpsShown = Math.round(1000 / (fpsAcc / fpsN)); fpsAcc = 0; fpsN = 0 } }
    lastT = now
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H)
    if (!S.view) { drawPick(now); requestAnimationFrame(render); return }
    const v = S.view
    const g = geo()
    /* 顶栏 56px（§7）：对方名牌+棋色标/托管徽标/对方棋钟 P0/手数 */
    const clock = (sx) => { let ms = S.clockBase[sx]; if (v.turn === sx && !v.over) ms -= now - S.clockAt; return mmss(ms) }
    ctx.textAlign = 'left'
    ctx.font = F1(12); ctx.fillStyle = '#8A7A5C'
    ctx.fillText(S.spectator ? '观战 · 玩家' + (v.turn === 0 ? 'A（黑）' : 'B（白）') : v.turn === S.seat ? '轮到你落子' : '对方思考中…', 12, 22)
    drawStone(20, 42, 1 - rs(), g.cs * 0.24)
    ctx.font = F1(12); ctx.fillStyle = INK
    ctx.fillText((S.spectator ? '玩家' : '对手') + '·' + (rs() === 0 ? '白后' : '黑先'), 36, 46)
    ctx.textAlign = 'right'
    const tclk = clock(1 - rs())
    ctx.font = F0(15); ctx.fillStyle = (S.clockBase[1 - rs()] - (v.turn === 1 - rs() ? now - S.clockAt : 0)) < 30000 && !v.over ? '#C0392B' : INK
    ctx.fillText(tclk, W - 12, 42)
    ctx.font = F1(11); ctx.fillStyle = '#8A7A5C'
    ctx.fillText('第 ' + (v.moveNo + 1) + ' 手', W - 12, 22)
    if (v.host && (v.host[0] || v.host[1])) { ctx.font = F1(11); ctx.fillStyle = '#9D6BE8'; ctx.fillText('托管', W - 74, 22) }
    /* 棋盘（榧木亮盘+深褐格线——识图锚 §7） */
    ctx.fillStyle = BOARD_C
    roundRect(g.x - 6, g.y - 6, g.n * g.cs + 12, g.n * g.cs + 12, 8); ctx.fill()
    ctx.strokeStyle = '#B49A62'; ctx.lineWidth = 2; roundRect(g.x - 6, g.y - 6, g.n * g.cs + 12, g.n * g.cs + 12, 8); ctx.stroke()
    ctx.strokeStyle = LINE_C; ctx.lineWidth = 1
    for (let i = 0; i < g.n; i++) {
      ctx.beginPath(); ctx.moveTo(g.x + i * g.cs, g.y); ctx.lineTo(g.x + i * g.cs, g.y + g.n * g.cs); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(g.x, g.y + i * g.cs); ctx.lineTo(g.x + g.n * g.cs, g.y + i * g.cs); ctx.stroke()
    }
    if (ruleOf() === 'gomoku') { // 星位 5 点（纯视觉 §2.2）
      ctx.fillStyle = LINE_C
      for (const [r, c] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]) { ctx.beginPath(); ctx.arc(g.x + (c + 0.5) * g.cs, g.y + (r + 0.5) * g.cs, 2.4, 0, Math.PI * 2); ctx.fill() }
    }
    if (ruleOf() === 'cascade') { // 子盘粗框线（模式指纹 §7）+ 死盘态
      for (let bi = 0; bi < 3; bi++) for (let bj = 0; bj < 3; bj++) {
        const sub = bi * 3 + bj
        const x = g.x + bj * 3 * g.cs, y = g.y + bi * 3 * g.cs
        const owner = v.sub && v.sub[sub]
        ctx.strokeStyle = owner === -1 || owner === undefined ? '#4A3A20' : 'rgba(74,58,32,0.25)'
        ctx.lineWidth = owner === -1 || owner === undefined ? 2.6 : 1.2
        ctx.strokeRect(x + 1, y + 1, g.cs * 3 - 2, g.cs * 3 - 2)
        if (owner === 0) { ctx.fillStyle = 'rgba(107,84,51,0.22)'; ctx.fillRect(x + 1, y + 1, g.cs * 3 - 2, g.cs * 3 - 2) } // 平死灰化（§3.2）
        if (owner === 1 || owner === 2) { ctx.fillStyle = owner === 1 ? 'rgba(232,163,61,0.10)' : 'rgba(61,200,232,0.12)'; ctx.fillRect(x + 1, y + 1, g.cs * 3 - 2, g.cs * 3 - 2) } // 归属压色 8% 蒙层
      }
    }
    /* 黑白可落点亮呼吸（§3.2：可落点即合法手——新手不用背规则） */
    const legal = (!S.spectator && v.turn === S.seat && ruleOf() !== 'gomoku') ? legalSet() : null
    if (legal) {
      const pulse = 0.16 + 0.08 * Math.sin(now / 300)
      ctx.fillStyle = `rgba(58,46,31,${pulse.toFixed(3)})`
      for (const c of legal) { const p = cellXY(c); ctx.fillRect(p.x + g.cs * 0.32, p.y + g.cs * 0.32, g.cs * 0.36, g.cs * 0.36) }
    }
    /* 送位盘呼吸描边（井字可读性命门 §3.2：一眼看出被送去了哪个盘） */
    if (ruleOf() === 'cascade' && v.last >= 0 && !v.over) {
      const br = ((v.last / 9) | 0) % 3, bc = (v.last % 9) % 3
      const tgt = br * 3 + bc
      if (v.turn === S.seat || S.spectator) {
        const bi = ((tgt / 3) | 0), bj = tgt % 3
        const x = g.x + bj * 3 * g.cs, y = g.y + bi * 3 * g.cs
        ctx.strokeStyle = `rgba(176,84,42,${(0.5 + 0.4 * Math.sin(now / 250)).toFixed(3)})`
        ctx.lineWidth = 3
        ctx.strokeRect(x + 1.5, y + 1.5, g.cs * 3 - 3, g.cs * 3 - 3)
      }
    }
    /* 非法格压暗（本地 legal 复算 §3.1：黑白/井字非法引导） */
    if (legal) { /* 合法集已亮示——其余空格即弱压暗 */ }
    /* 威胁角标（对方一步致胜点红角标，§3.2 辅助层默认开） */
    const thr = (!S.spectator && S.hint && (v.turn === S.seat || v.turn === 1 - S.seat)) ? threatSet() : []
    /* 棋子 */
    const flipActive = new Map()
    for (const f of S.flipFx) if (now >= f.t0 && now < f.t0 + 160) flipActive.set((f.x / 1) + ':' + (f.y / 1), f)
    for (let c = 0; c < g.n * g.n; c++) {
      const seatV = v.board[c]
      if (!seatV) continue
      const p = cellXY(c)
      const cx = p.x + g.cs / 2, cy = p.y + g.cs / 2
      /* 翻转波中的子：缩放收张换色（40ms/子 §3.1——state 真值已全量，表现层不阻塞） */
      const key = cx + ':' + cy
      const ff = flipActive.get(key)
      if (ff) { const t = (now - ff.t0) / 160; drawStone(cx, cy, t < 0.5 ? 1 - ff.to : ff.to, undefined, Math.abs(1 - 2 * t) * 0.6 + 0.4); continue }
      /* 落子弹入 120ms（§3.1 非阻塞） */
      let scale = 1
      for (const f of S.fx) if (f.k === 'land' && f.x === cx && f.y === cy) { const t = (now - f.t0) / 120; if (t >= 0 && t < 1) scale = 0.6 + 0.4 * (1 + Math.sin(Math.PI * Math.min(1, t * 1.4 - 0.2))) * 1; scale = 0.6 + 0.4 * Math.min(1, t * 1.6) }
      drawStone(cx, cy, seatV - 1, undefined, 1, scale)
    }
    /* 最后两步对照环（§3.2：金环 last+淡环上上手） */
    if (v.last2 >= 0) { const p = cellXY(v.last2); ctx.strokeStyle = 'rgba(58,46,31,0.35)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(p.x + g.cs / 2, p.y + g.cs / 2, g.cs * 0.44, 0, Math.PI * 2); ctx.stroke() }
    if (v.last >= 0) { const p = cellXY(v.last); ctx.strokeStyle = '#C9A227'; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.arc(p.x + g.cs / 2, p.y + g.cs / 2, g.cs * 0.44, 0, Math.PI * 2); ctx.stroke() }
    /* 五子预落子（§1.7：半透明+确认圈 0ms 本地） */
    if (S.pre >= 0) {
      const p = cellXY(S.pre)
      drawStone(p.x + g.cs / 2, p.y + g.cs / 2, S.seat, undefined, 0.45)
      ctx.strokeStyle = '#C9A227'; ctx.lineWidth = 2
      ctx.setLineDash([4, 3]); ctx.lineDashOffset = -((now / 90) % 14)
      ctx.strokeRect(p.x + 2.5, p.y + 2.5, g.cs - 5, g.cs - 5)
      ctx.setLineDash([])
      ctx.font = F1(11); ctx.fillStyle = INK; ctx.textAlign = 'center'
      ctx.fillText('再点确认', p.x + g.cs / 2, p.y + g.cs + 12)
    }
    /* 威胁角标 */
    for (const c of thr) {
      const p = cellXY(c)
      ctx.fillStyle = `rgba(192,57,43,${(0.6 + 0.4 * Math.sin(now / 180)).toFixed(3)})`
      ctx.beginPath(); ctx.moveTo(p.x + g.cs - 3, p.y + 3); ctx.lineTo(p.x + g.cs - 3, p.y + 13); ctx.lineTo(p.x + g.cs - 13, p.y + 3); ctx.closePath(); ctx.fill()
    }
    /* 井字归属图章（§7：圆/方小印） */
    if (ruleOf() === 'cascade' && v.sub) {
      for (let b = 0; b < 9; b++) {
        const owner = v.sub[b]
        if (owner !== 1 && owner !== 2) continue
        const bi = ((b / 3) | 0), bj = b % 3
        const x = g.x + bj * 3 * g.cs + g.cs * 3 - 16, y = g.y + bi * 3 * g.cs + 14
        const pop = S.fx.find((f) => f.k === 'stamp' && f.sub === b && now - f.t0 < 220)
        const sc = pop ? 1 + 0.35 * (1 - (now - pop.t0) / 220) : 1
        ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc)
        if (owner === 1) { ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fillStyle = COL_A; ctx.fill(); ctx.strokeStyle = '#8A5B14'; ctx.lineWidth = 1.6; ctx.stroke() }
        else { ctx.beginPath(); ctx.rect(-6, -6, 12, 12); ctx.fillStyle = COL_B; ctx.fill(); ctx.strokeStyle = '#1A6E84'; ctx.lineWidth = 1.6; ctx.stroke() }
        ctx.restore()
      }
    }
    /* 胜利金线（§3.3 juice） */
    for (const f of S.fx) if (f.k === 'goldline' && now - f.t0 < 900) {
      const t = (now - f.t0) / 900
      ctx.save(); ctx.globalAlpha = 1 - t * 0.6; ctx.strokeStyle = '#C9A227'; ctx.lineWidth = 3.5
      const pts = f.cells.map((c) => { const p = cellXY(c); return [p.x + g.cs / 2, p.y + g.cs / 2] })
      const a = pts[0], b2 = pts[pts.length - 1]
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0] + (b2[0] - a[0]) * Math.min(1, t * 1.3), a[1] + (b2[1] - a[1]) * Math.min(1, t * 1.3)); ctx.stroke()
      ctx.restore()
    }
    /* 状态条 28px（§7：模式名 P1+最后手坐标 P0+送位盘提示） */
    ctx.fillStyle = '#E7DCC4'; ctx.fillRect(0, 430, W, 28)
    ctx.textAlign = 'left'; ctx.font = F1(12); ctx.fillStyle = INK
    ctx.fillText(RULE_CN[ruleOf()] || ruleOf(), 12, 449)
    ctx.font = F0(13); ctx.fillStyle = '#6B5433'
    ctx.fillText(v.last >= 0 ? '最后 ' + coordName(v.last) : '—', 110, 449)
    if (ruleOf() === 'reversi') {
      let a = 0, b = 0
      for (const x of v.board) { if (x === 1) a++; else if (x === 2) b++ }
      ctx.textAlign = 'right'; ctx.fillText(`黑 ${a} : ${b} 白`, W - 12, 449)
    } else if (ruleOf() === 'cascade') {
      let a = 0, b = 0
      for (const x of v.sub || []) { if (x === 1) a++; else if (x === 2) b++ }
      ctx.textAlign = 'right'; ctx.fillText(`盘 ${a} : ${b}`, W - 12, 449)
    } else {
      ctx.textAlign = 'right'; ctx.fillText(`手 ${v.moveNo}`, W - 12, 449)
    }
    /* 底栏 96px（§7：己方名牌+棋钟 P0 ｜ 认输 ｜ 托管 ｜ ?速览） */
    ctx.fillStyle = '#EFE5CE'; ctx.fillRect(0, H - 108, W, 108)
    drawStone(20, 570, rs(), 11)
    ctx.textAlign = 'left'; ctx.font = F1(12); ctx.fillStyle = INK
    ctx.fillText('你·' + (rs() === 0 ? '黑先' : '白后'), 36, 575)
    const mclk = clock(rs())
    ctx.font = F0(16); ctx.fillStyle = (S.clockBase[rs()] - (v.turn === rs() ? now - S.clockAt : 0)) < 30000 && !v.over ? '#C0392B' : INK
    ctx.fillText(mclk, 12, 606)
    if (v.timerMs > 0 && v.turn === S.seat && !v.over) { ctx.font = F1(11); ctx.fillStyle = '#8A7A5C'; ctx.fillText('步限 ' + Math.ceil((S.deadlineAt - now) / 1000) + 's', 12, 626) }
    if (!S.spectator) {
      const btn = (x, w, label, active, danger) => {
        ctx.fillStyle = active ? '#E2D4B4' : '#DCCFAE'
        roundRect(x, BTN.host.y, w, BTN.host.h, 8); ctx.fill()
        ctx.strokeStyle = danger ? `rgba(192,57,43,${0.5 + 0.5 * Math.sin(now / 150)})` : '#B49A62'; ctx.lineWidth = danger ? 2.2 : 1.5
        roundRect(x, BTN.host.y, w, BTN.host.h, 8); ctx.stroke()
        ctx.fillStyle = danger ? '#C0392B' : INK; ctx.font = F1(12); ctx.textAlign = 'center'
        ctx.fillText(label, x + w / 2, BTN.host.y + 30)
      }
      btn(BTN.host.x, BTN.host.w, v.host && v.host[S.seat] ? '夺回' : '托管', !!(v.host && v.host[S.seat]))
      btn(BTN.concede.x, BTN.concede.w, S.concedeArm && now - S.concedeArm < 2500 ? '再点认输' : '认输', false, S.concedeArm && now - S.concedeArm < 2500)
      btn(BTN.help.x, BTN.help.w, '?', S.help)
    }
    /* ? 速览浮层（§1.7：当前规则一图一句） */
    if (S.help) {
      ctx.fillStyle = 'rgba(58,46,31,0.82)'; ctx.fillRect(20, 150, W - 40, 300)
      ctx.fillStyle = '#F2EBDC'; ctx.font = F1(14); ctx.textAlign = 'center'
      ctx.fillText(RULE_CN[ruleOf()], W / 2, 186)
      ctx.font = F1(12)
      wrapText(RULE_DESC[ruleOf()], W / 2, 216, W - 80, 20)
      ctx.font = F1(12); ctx.fillStyle = S.hint ? '#C9A227' : '#9FB0A0'
      ctx.fillText(S.hint ? '威胁提示：开（点此关闭）' : '威胁提示：关（点此开启）', W / 2, 496)
    }
    /* 横幅 */
    S.banners = S.banners.filter((b) => now - b.t0 < 900)
    S.banners.forEach((b, i) => {
      const t = (now - b.t0) / 900
      ctx.save(); ctx.globalAlpha = t < 0.8 ? 1 : (1 - t) / 0.2
      ctx.fillStyle = 'rgba(58,46,31,0.88)'; ctx.fillRect(0, 240 + i * 38, W, 34)
      ctx.fillStyle = b.c1; ctx.fillRect(0, 240 + i * 38, W, 3)
      ctx.fillStyle = '#F2EBDC'; ctx.font = F1(13); ctx.textAlign = 'center'; ctx.fillText(b.txt, W / 2, 263 + i * 38)
      ctx.restore()
    })
    if (S.err) { ctx.fillStyle = '#C0392B'; ctx.font = F1(11); ctx.textAlign = 'center'; ctx.fillText('✕ ' + S.err, W / 2, 62) }
    /* 结算页（§7：大字+战报条+棋桌评语+再来一局） */
    if (S.over && S.result) {
      const r = S.result
      const meWin = r.winner === (rs() === 0 ? 'A' : 'B')
      const tin = Math.min(1, (now - S.overAt) / 450)
      ctx.fillStyle = `rgba(58,46,31,${(0.93 * Math.min(1, tin * 1.8)).toFixed(3)})`; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = r.winner === 'draw' ? '#D8CBB0' : r.winner === 'A' ? COL_A : COL_B
      ctx.save(); ctx.translate(W / 2, 150); ctx.scale(1.3 - 0.3 * tin, 1.3 - 0.3 * tin)
      ctx.font = F0(34); ctx.textAlign = 'center'
      ctx.fillText(r.winner === 'draw' ? '平局' : S.spectator ? '玩家' + r.winner + ' 胜' : meWin ? '胜利' : '败北', 0, 0)
      ctx.restore()
      ctx.font = F1(12); ctx.fillStyle = '#B7A884'
      ctx.fillText(`reason: ${r.reason} · ${S.view.moveNo} 手 · ${RULE_CN[ruleOf()]}`, W / 2, 178)
      const sc = r.scores || {}
      const ka = Object.keys(sc.A || {})
      ctx.font = F0(13); ctx.fillStyle = '#F2EBDC'
      ka.forEach((k, i) => { ctx.fillText(`${k} ${sc.A[k]} : ${sc.B[k]}`, W / 2, 226 + i * 26) })
      if (r.quip) { ctx.fillStyle = '#D8CBB0'; ctx.font = F1(13); ctx.fillText('「' + r.quip + '」', W / 2, 340) }
      ctx.fillStyle = '#DCCFAE'; roundRect(40, H - 96, 140, 52, 10); ctx.fill()
      ctx.strokeStyle = '#8A5B14'; ctx.lineWidth = 2; roundRect(40, H - 96, 140, 52, 10); ctx.stroke()
      ctx.fillStyle = INK; ctx.font = F1(14); ctx.textAlign = 'center'; ctx.fillText('再来一局', 110, H - 64)
      ctx.fillStyle = '#C9BFA6'; roundRect(195, H - 96, 140, 52, 10); ctx.fill()
      ctx.fillStyle = INK; ctx.fillText('回大厅', 265, H - 64)
    }
    /* 页脚 P2（§7） */
    ctx.fillStyle = '#8A7A5C'; ctx.font = F2(9); ctx.textAlign = 'left'
    ctx.fillText('yi-pavilion · v1.0.0 · S5', 10, H - 3)
    S.fx = S.fx.filter((f) => now - f.t0 < 1000)
    S.flipFx = S.flipFx.filter((f) => now - f.t0 < 1000)
    requestAnimationFrame(render)
  }
  function wrapText(txt, cx, y, maxW, lh) {
    let line = '', yy = y
    for (const ch of txt) {
      if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, cx, yy); line = ch; yy += lh } else line += ch
    }
    ctx.fillText(line, cx, yy)
  }
  /* 模式选择浮层（§1.1：三按钮各带一图一句） */
  function drawPick(now) {
    ctx.textAlign = 'center'
    ctx.font = F0(20); ctx.fillStyle = INK
    ctx.fillText('弈界棋阁', W / 2, 96)
    ctx.font = F1(12); ctx.fillStyle = '#8A7A5C'
    ctx.fillText('三棋合一 · 触点落子 · 随手托管', W / 2, 122)
    const items = [
      ['gomoku', '五子连珠', '15 路攻杀——先连五子者胜', 200],
      ['reversi', '黑白翻转', '夹住就翻——终局数子定胜负', 290],
      ['cascade', '连环井字', '落到哪格送哪盘——母盘三连', 380],
    ]
    for (const [rule, name, desc, yy] of items) {
      const hl = false
      ctx.fillStyle = hl ? '#E2D4B4' : '#E7DCC4'
      roundRect(40, yy - 34, W - 80, 68, 10); ctx.fill()
      ctx.strokeStyle = '#B49A62'; ctx.lineWidth = 1.5; roundRect(40, yy - 34, W - 80, 68, 10); ctx.stroke()
      /* 一图：迷你盘示意（路数=模式指纹） */
      const n = { gomoku: 9, reversi: 6, cascade: 6 }[rule]
      const bx = 62, by = yy - 22, bs = 44 / n
      ctx.fillStyle = BOARD_C; ctx.fillRect(bx, by, 46, 46)
      ctx.strokeStyle = LINE_C; ctx.lineWidth = 0.6
      for (let i = 0; i <= n; i++) {
        ctx.beginPath(); ctx.moveTo(bx + i * bs, by); ctx.lineTo(bx + i * bs, by + n * bs); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(bx, by + i * bs); ctx.lineTo(bx + n * bs, by + i * bs); ctx.stroke()
      }
      if (rule === 'cascade') { ctx.strokeStyle = '#4A3A20'; ctx.lineWidth = 1.6; ctx.strokeRect(bx + 0.5, by + 0.5, n * bs - 1, n * bs - 1) }
      ctx.textAlign = 'left'
      ctx.font = F1(15); ctx.fillStyle = INK; ctx.fillText(name, 126, yy - 4)
      ctx.font = F1(11); ctx.fillStyle = '#8A7A5C'; ctx.fillText(desc, 126, yy + 18)
      ctx.textAlign = 'center'
    }
    ctx.font = F1(11); ctx.fillStyle = '#8A7A5C'
    ctx.fillText(S.connLost ? '连接断开 · 点击任意模式重连' : q.get('room') ? '连接中…' : '选择棋式开局（Bot 秒配）', W / 2, 470)
    void now
  }

  /* ---------- 离线对打（?debug=1&rule= / 冒烟·识图零网关本地 1v1） ---------- */
  let ost = null, otimer = null, opaused = false, osalt = 0
  function offlineDrain() {
    if (!ost) return
    const payloads = ost.outbox.splice(0, ost.outbox.length)
    for (const p of payloads) {
      if (p.vis === 'all') onMsg({ t: 'ruling', state: SIM.viewFor(ost, 0), events: p.events })
    }
    if (ost.over && !S.over) { onMsg({ t: 'end', result: ost.result }); clearInterval(otimer); otimer = null }
  }
  function offlineApply(op) {
    if (!ost || ost.over) return
    const res = SIM.applyOp(ost, 0, op)
    if (res && res.reject) onMsg({ t: 'ruling', state: SIM.viewFor(ost, 0), events: [{ k: 'reject', why: res.reject, seat: 0 }] })
    offlineDrain()
  }
  function offlineStart(level, rule) {
    if (!SIM) return
    if (S.conn) { try { S.conn.onclose = null; S.conn.onerror = null; S.conn.close() } catch {} S.conn = null }
    if (otimer) { clearInterval(otimer); otimer = null }
    S.offline = true; S.spectator = false; S.seat = 0; S.over = false; S.result = null
    S.fx = []; S.banners = []; S.flipFx = []; S.err = ''; S.connLost = false; S.pre = -1
    S.offlineLevel = ['casual', 'balanced', 'competitive'][Math.max(0, Math.min(2, (Number(level) || 1) - 1))] || 'balanced'
    S.rule = rule && GEO[rule] ? rule : (S.rule && GEO[S.rule] ? S.rule : 'gomoku')
    osalt++
    ost = SIM.create(SIM.fnv1a32('offline-' + S.rule + '-' + osalt), { rule: S.rule })
    onMsg({ t: 'welcome', roomId: 'offline', role: 'player', seat: 0, room: { seats: [{ kind: 'human', name: '你' }, { kind: 'bot', level: S.offlineLevel }], duel: { rule: S.rule } }, state: SIM.viewFor(ost, 0) })
    report('start', { mode: 'offline', level: S.offlineLevel, rule: S.rule, seed: ost.seed })
    const TSPD = 8 // 假时钟 8x（冒烟/识图节奏）
    otimer = setInterval(() => {
      if (opaused || !ost || ost.over) return
      for (let i = 0; i < TSPD && ost && !ost.over; i++) {
        const inputs = {}
        const b = SIM.brain(ost, 1, S.offlineLevel)
        if (b && b.op) inputs[1] = b
        SIM.step(ost, inputs)
        offlineDrain()
      }
    }, 10)
  }

  /* ---------- HUD 自证 + 暴露（HF __applied 生效自证首日，票面指定） ---------- */
  window.__GAMES_DEBUG__ = window.__GAMES_DEBUG__ || {}
  window.__GAMES_DEBUG__.hudFonts = function () {
    const o = JSON.parse(JSON.stringify(HF_REGISTRY))
    let applied = false
    try { const prev = ctx.font; ctx.font = HF('hfProbe', 13, 600, 'P0'); applied = /13px/.test(ctx.font); ctx.font = prev } catch (e) { applied = false }
    o.__cls = {}
    for (const c in HF_CLS) o.__cls[c] = { min: HF_CLS[c].min === 99 ? null : HF_CLS[c].min, samples: HF_CLS[c].n }
    o.__applied = applied // 登记值≠回读值即 false 计红线（识图复检断言源，设计 §7）
    return o
  }
  window.__GAMES_DEBUG__.state = () => ({ view: S.view, seat: S.seat, roster: S.roster, result: S.result, offline: S.offline, over: ost ? ost.over : S.over, rule: ruleOf() })
  window.__GAMES_DEBUG__.sendOp = sendOp
  window.__GAMES_DEBUG__.events = dbgEvents
  window.__GAMES_DEBUG__.start = function (level, opts) { offlineStart(level, (opts && opts.rule) || S.rule) }
  window.__GAMES_DEBUG__.pause = function (on) { opaused = !!on }
  window.__GAMES_DEBUG__.roomId = function () { return S.roomId }
  window.__GAMES_DEBUG__.seat = function () { return S.seat }
  window.__GAMES_DEBUG__.mode = function () { return S.offline ? 'offline' : 'net' }
  window.__GAMES_DEBUG__.sfx = function () { return { slots: ['place', 'flip', 'sub', 'turn', 'host', 'reject', 'win', 'lose'], on: sfx.on, calls: sfx.calls.slice(-64) } }
  window.__GAMES_DEBUG__.fps = function () { return fpsShown }
  window.__GAMES_DEBUG__.engineHash = function () { return SIM && SIM.ENGINE_HASH }

  report('boot', { slug: 'yi-pavilion', version: '1.0.0', mode: q.get('debug') === '1' ? 'offline' : 'net', rule: S.rule })
  if (q.get('debug') === '1' && SIM) offlineStart(q.get('level') || 1, q.get('rule'))
  else if (q.get('room')) connect()
  else if (q.get('quick') && q.get('rule')) connect() // quick 带 rule：直连秒配
  else S.pick = 1 // 模式选择浮层（大厅单卡片入口，§1.1——三按钮各带一图一句，选中即 quick {rule}）
  requestAnimationFrame(render)
})()
