/* =====================================================================
 * 战棋对决 客户端（GAMES-118 · S1+S5）——石板战情室（§7）。
 * S1 面：本地跑同源 sim.cjs（TDuelSim）做选中/移动域 BFS/伤害预演（§3.1
 * <100ms 全本地、零上行——「客户端预测=决策辅助」的战棋形态）；
 * S5 面：渲染=ruling 全量个性化 state 直染（操作者实时/对手边界态批量披露）。
 * HUD 字号对齐 hud-font-standard §1：P0 ≥13px/600、P1 ≥11px、P2 ≥9px；
 * __GAMES_DEBUG__.hudFonts() 当帧登记表（识图断言源）。
 * 色盲双编码（§7 强制双通道）：阵营=琥珀/青 + 实心粗描边/双细线；兵种=六字形
 * 矢量+令牌底盘形状；地形=色相+纹样；据点=阵营色+旗形（三角/燕尾）。
 * ===================================================================== */
'use strict'
;(function () {
  /* ---------- 常量（与服务端 sim.cjs 同源的表现侧拷贝 + §7 视觉基调） ---------- */
  const UT = {
    sword:  { n: '剑士', hp: 28, atk: 9,  def: 3, mv: 3, rg: '1',   skill: '坚韧：HP≤50% 防+2' },
    axe:    { n: '斧兵', hp: 32, atk: 12, def: 2, mv: 2, rg: '1',   skill: '破甲：攻击无视 2 防' },
    lance:  { n: '枪骑', hp: 26, atk: 8,  def: 4, mv: 5, rg: '1',   skill: '冲锋：移动≥3 格攻击+3' },
    bow:    { n: '弓手', hp: 20, atk: 10, def: 1, mv: 3, rg: '2-3', skill: '隔离射击：不可攻/反击邻接' },
    mage:   { n: '法师', hp: 18, atk: 11, def: 1, mv: 3, rg: '1-2', skill: '火球：≤3 格十字 AOE 6 伤' },
    healer: { n: '医者', hp: 22, atk: 4,  def: 2, mv: 3, rg: '1-2', skill: '治疗：窗内己方 +8 HP' },
  }
  const SIM = window.TDuelSim // 同源确定性引擎（本地预演/离线对打）
  const COL_A = '#E8A33D', COL_B = '#3DC8E8'       // 阵营双色（A 琥珀 / B 青，§7）
  const CELL_A = '#2A333D', CELL_B = '#252C34'     // 棋盘双色微差格（识图锚）
  const GRID_C = 'rgba(122,106,79,0.6)'            // 铜金格线 60% α
  const BG = '#20262E'
  const FOREST = '#1E3A2A', ROCK = '#4A5058', RIVER = '#22405A'
  const W = 375, H = 667
  const BOARD = { x: 11, y: 64, cs: 44 }           // 棋盘 352×352（8×44 格，§7 布局）

  /* ---------- 音效位预留（平台协议静音占位，element 先例） ---------- */
  const sfx = { calls: [], play(group, tag) { this.calls.push({ group, tag: tag || '', at: performance.now() }); const h = window.PlatformAudio; if (h && typeof h.play === 'function') { try { h.play('tactics-duel:' + group, tag || '') } catch {} } } }

  /* ---------- HUD 字号登记表（P0 ≥13px/600 · P1 ≥11px · P2 ≥9px） ---------- */
  const HUDF = {}
  const font = (px, weight, cls) => { const f = `${weight} ${px}px system-ui, -apple-system, sans-serif`; HUDF[cls] = HUDF[cls] || { minPx: 99, n: 0 }; HUDF[cls].minPx = Math.min(HUDF[cls].minPx, px); HUDF[cls].n++; return f }
  const F0 = (px) => font(Math.max(13, px), 600, 'P0') // HP/攻防读数/AP/回合/倒计时/双方占点分
  const F1 = (px) => font(Math.max(11, px), 600, 'P1') // 兵种名/技能名/按钮/评语
  const F2 = (px) => font(Math.max(9, px), 500, 'P2')  // 地形角标/页脚

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
    view: null, deadlineAt: 0, timerMs0: 0,
    sel: null,        // {unit} 选中己方单位 / {skill:unit} 技能目标态
    deploySel: null,  // deploy 浮层：待放置兵种
    deployMap: null,  // 本地布置 {type: cell}
    fx: [], banners: [], result: null, over: false, reveal: null,
    err: '', connLost: false,
  }
  const rs = () => (S.spectator ? 0 : S.seat)
  const oppSeat = () => 1 - rs()
  /* 席 B 渲染 180° 翻转（服务器行号绝对，§1.3）；观战不翻 */
  const flip = (cell) => (rs() === 1 ? (7 - ((cell / 8) | 0)) * 8 + (7 - (cell % 8)) : cell)
  const cellXY = (cell) => { const d = flip(cell); return { x: BOARD.x + (d % 8) * BOARD.cs, y: BOARD.y + ((d / 8) | 0) * BOARD.cs } }
  const cellAt = (x, y) => { for (let c = 0; c < 64; c++) { const p = cellXY(c); if (x >= p.x && x <= p.x + BOARD.cs && y >= p.y && y <= p.y + BOARD.cs) return c } return -1 }

  function connect() {
    document.getElementById('boot').textContent = '连接网关 ' + GW.replace('ws://', '') + ' …'
    document.getElementById('boot').style.display = ''
    const ws = new WebSocket(GW)
    S.conn = ws
    ws.onopen = () => {
      const rid = q.get('room')
      const saved = (() => { try { return JSON.parse(sessionStorage.getItem('td-' + rid) || 'null') } catch { return null } })()
      if (rid) ws.send(JSON.stringify({ t: 'join', roomId: rid, mode: q.get('mode') || 'play', resume: saved ? { seat: saved.seat, token: saved.token } : undefined, name: '玩家' }))
      else ws.send(JSON.stringify({ t: 'quick', gameId: 'tactics-duel' })) // 无 room 径直 quick：join 无 roomId 会被网关 bad-msg 拒（element 同款闪现，此处修掉）
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
    if (m.t === 'error') { S.err = m.code || m.message; setTimeout(() => { S.err = '' }, 2500); return }
    if (m.t === 'welcome') {
      S.roomId = m.roomId; S.spectator = m.role !== 'player'; S.seat = S.spectator ? -1 : m.seat; S.token = m.token
      if (m.token != null) { try { sessionStorage.setItem('td-' + S.roomId, JSON.stringify({ seat: S.seat, token: S.token })) } catch {} }
      if (m.room && m.room.duel && m.room.duel.hash !== undefined) S.duelHash = m.room.duel.hash
      if (m.room && m.room.seats) S.roster = m.room.seats
      S.view = m.state; startTimer(m.state)
      return
    }
    if (m.t === 'seat') { S.roster = m.seats; return }
    if (m.t === 'started') { S.view = m.state; startTimer(m.state); return }
    if (m.t === 'ruling') {
      S.view = m.state; startTimer(m.state)
      for (const ev of m.events || []) onEvent(ev, m)
      return
    }
    if (m.t === 'end') { S.over = true; S.result = m.result; S.view = S.view || {}; if (m.result && m.result.reveal) S.reveal = m.result.reveal; sfx.play('win', m.result ? String(m.result.winner) : '?'); return }
    if (m.t === 'closed') { S.connLost = true }
  }
  function startTimer(view) { S.timerMs0 = view && view.timerMs || 0; S.deadlineAt = performance.now() + S.timerMs0 }
  /* 事件→演出层（§3.2 juice：非阻塞；对手回合批量披露按到达序逐步演出） */
  function onEvent(ev) {
    const posOf = (id) => { const u = S.view && S.view.units && S.view.units.find((x) => x.id === id); if (!u) return null; const p = cellXY(u.cell); return { x: p.x + BOARD.cs / 2, y: p.y + BOARD.cs / 2 } }
    if (ev.k === 'attack' || ev.k === 'counter' || ev.k === 'dmg') { const p = posOf(ev.tgt); if (p) S.fx.push({ k: 'dmg', n: ev.dmg || ev.n, x: p.x, y: p.y, t0: performance.now() }); if (ev.k !== 'dmg') sfx.play('attack', ev.k) }
    if (ev.k === 'heal') { const p = posOf(ev.tgt); if (p) S.fx.push({ k: 'healFx', n: ev.n, x: p.x, y: p.y, t0: performance.now() }) }
    if (ev.k === 'die') { const u = S.view && S.view.units.find((x) => x.id === ev.unit); const cell = u ? u.cell : null; const p = cell != null ? cellXY(cell) : null; if (p) S.fx.push({ k: 'die', x: p.x + BOARD.cs / 2, y: p.y + BOARD.cs / 2, t0: performance.now(), seat: (ev.unit / 6) | 0 }) }
    if (ev.k === 'move') { sfx.play('move'); const p = cellXY(ev.path[ev.path.length - 1]); S.fx.push({ k: 'land', x: p.x + BOARD.cs / 2, y: p.y + BOARD.cs / 2, t0: performance.now() }) }
    if (ev.k === 'skill') { sfx.play('skill'); const p = cellXY(ev.cell); S.fx.push({ k: 'boom', x: p.x + BOARD.cs / 2, y: p.y + BOARD.cs / 2, t0: performance.now() }) }
    if (ev.k === 'point') S.banners.push({ txt: (ev.owner === rs() ? '我方' : '敌方') + '占据据点', c1: ev.owner === 0 ? COL_A : COL_B, t0: performance.now(), sys: 1 })
    if (ev.k === 'turn') S.banners.push({ txt: S.spectator ? '玩家' + (ev.seat === 0 ? 'A' : 'B') + ' 的回合' : (ev.seat === S.seat ? '你的回合' : '对方回合'), c1: ev.seat === 0 ? COL_A : COL_B, t0: performance.now(), sys: 1 })
    if (ev.k === 'reveal') S.banners.push({ txt: '部署揭示 · 开战', c1: COL_A, t0: performance.now(), sys: 1 })
    if (ev.k === 'endTurn') { if (!S.spectator && ev.seat === S.seat) S.banners.push({ txt: '回合已提交', c1: '#9FB0C0', t0: performance.now(), sys: 1 }) }
    if (ev.k === 'timeout-turn') S.banners.push({ txt: '托管代打', c1: '#9D6BE8', t0: performance.now(), sys: 1 })
    if (ev.k === 'host') S.banners.push({ txt: ev.on ? '托管中·随时夺回' : '已夺回', c1: '#9D6BE8', t0: performance.now(), sys: 1 })
    if (ev.k === 'undo') S.banners.push({ txt: '已撤回本回合', c1: '#9FB0C0', t0: performance.now(), sys: 1 })
    if (ev.k === 'reject') { S.fx.push({ k: 'reject', x: W / 2, y: 430, t0: performance.now() }); S.sel = null; report('reject', ev.why || '') }
  }

  /* ---------- 本地预演（§3.1：同源 sim 复算，零上行） ---------- */
  const asSimState = () => S.view // view.units 结构与 sim 单位兼容（id/seat/type/cell/hp/ph/ms）
  function myUnits() { return (S.view && S.view.units || []).filter((u) => u.seat === S.seat) }
  function moveDomain(id) { try { return SIM ? SIM.reach(asSimState(), id) : [] } catch { return [] } }
  function targetList(id) { try { return SIM ? SIM.atkTargets(asSimState(), id) : [] } catch { return [] } }
  function dmgPreview(aId, dId) { try { return SIM ? SIM.predictDmg(asSimState(), aId, dId) : 0 } catch { return 0 } }
  function fireballPreview(id) { try { return SIM ? SIM.fireballCells(asSimState(), id) : [] } catch { return [] } }
  function healPreview(id) { try { return SIM ? SIM.healTargets(asSimState(), id) : [] } catch { return [] } }

  /* ---------- 输入（单拇指两段式：选源→选目标，§1.6） ---------- */
  let ptr = { down: false, x: 0, y: 0 }
  function pos(e) { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) } }
  cv.addEventListener('pointerdown', (e) => { const p = pos(e); ptr = { down: true, x: p.x, y: p.y } }, { passive: false })
  cv.addEventListener('pointerup', (e) => { const p = pos(e); ptr.down = false; tap(p.x, p.y) }, { passive: false })

  const BTN = { host: { x: 12, w: 52 }, undo: { x: 70, w: 52 }, skill: { x: 128, w: 74 }, end: { x: 252, w: 110 } } // 底栏钮（§1.6：托管左/结束右 108×48）
  function tap(x, y) {
    const v = S.view
    if (S.connLost && !S.offline) { connect(); return }
    if (S.over) { // 结算页：再来一局 / 回大厅
      if (y > H - 130 && y < H - 74) {
        try { sessionStorage.removeItem('td-' + S.roomId) } catch {}
        if (x > W / 2) location.href = '/multiplayer'
        else if (S.offline) offlineStart(S.offlineLevel)
        else location.reload()
      }
      return
    }
    if (!v || S.spectator) return
    /* 底栏 */
    const barY = H - 116
    if (y > barY && y < barY + 48) {
      if (x > BTN.host.x && x < BTN.host.x + BTN.host.w) { sendOp({ k: 'host', on: !v.host[S.seat] }); return }
      if (v.turn !== S.seat || v.phase !== 'act') return
      if (x > BTN.undo.x && x < BTN.undo.x + BTN.undo.w) { if (!v.undoUsed) sendOp({ k: 'undo' }); S.sel = null; return }
      if (x > BTN.skill.x && x < BTN.skill.x + BTN.skill.w && S.sel && !S.sel.skill) {
        const u = v.units.find((z) => z.id === S.sel.unit)
        if (u && (u.type === 'mage' || u.type === 'healer')) { S.sel = { unit: u.id, skill: u.type }; return }
      }
      if (x > BTN.end.x && x < BTN.end.x + BTN.end.w) { sendOp({ k: 'endTurn' }); S.sel = null; return }
      return
    }
    /* 部署浮层 */
    if (v.phase === 'deploy') { tapDeploy(x, y); return }
    if (v.phase !== 'act' || v.turn !== S.seat) { S.sel = null; return }
    const c = cellAt(x, y)
    /* 技能目标态 */
    if (S.sel && S.sel.skill) {
      const u = v.units.find((z) => z.id === S.sel.unit)
      if (!u) { S.sel = null; return }
      if (S.sel.skill === 'mage') { sendOp({ k: 'skill', unit: u.id, cell: c }); S.sel = null; return }
      const t = c >= 0 ? v.units.find((z) => z.cell === c) : null
      if (t) { sendOp({ k: 'skill', unit: u.id, cell: c }); S.sel = null; return }
      S.sel = null
      return
    }
    /* 移动：点亮域内格 */
    if (S.sel && c >= 0) {
      const dom = moveDomain(S.sel.unit)
      const hit = dom.find((d) => d.cell === c)
      if (hit && hit.path.length > 1) { sendOp({ k: 'move', unit: S.sel.unit, path: hit.path }); return }
      const tl = targetList(S.sel.unit)
      if (tl.includes(v.units.find((z) => z.cell === c) && v.units.find((z) => z.cell === c).id)) {
        sendOp({ k: 'attack', unit: S.sel.unit, tgt: v.units.find((z) => z.cell === c).id })
        S.sel = null
        return
      }
    }
    if (c >= 0) { // 选己方可动单位
      const u = v.units.find((z) => z.cell === c)
      if (u && u.seat === S.seat && u.ph !== 'done') { S.sel = { unit: u.id }; return }
    }
    S.sel = null
  }
  /* 部署浮层交互：底排兵种条 + 点格放置 + 出战 */
  function tapDeploy(x, y) {
    const v = S.view
    if (!S.deployMap) {
      S.deployMap = {}
      const mine = (v.deploys && v.deploys[0]) || null // 己方已交布置（重连恢复）
      if (mine) for (const d of mine) S.deployMap[d.unit] = d.cell
      else { SIM.TYPE_ORDER.forEach((tp, i) => { S.deployMap[tp] = SIM.TEMPLATES[0][i][S.seat] }) }
    }
    if (y > H - 118 && y < H - 66 && x > W / 2 - 90 && x < W / 2 + 90) { // 出战
      sendOp({ k: 'deploy', cells: SIM.TYPE_ORDER.map((tp) => ({ unit: tp, cell: S.deployMap[tp] })) })
      return
    }
    if (y > H - 64 && y < H - 8) { // 兵种条（6 枚 56×52）
      for (let i = 0; i < 6; i++) { const r = { x: 8 + i * 61, w: 56 }; if (x >= r.x && x <= r.x + r.w) { S.deploySel = SIM.TYPE_ORDER[i]; return } }
      return
    }
    const c = cellAt(x, y)
    if (c >= 0 && S.deploySel) {
      const zr = S.seat === 0 ? c >= 48 : c <= 15
      if (zr && SIM.PASSABLE[v.terrain[c]] && !Object.values(S.deployMap).includes(c)) { S.deployMap[S.deploySel] = c; S.deploySel = null }
      return
    }
    if (c >= 0) { const tp = Object.keys(S.deployMap).find((t) => S.deployMap[t] === c); if (tp) S.deploySel = tp } // 点已布置单位=拿起
  }

  /* ---------- 绘制 ---------- */
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  /* 六字形矢量（§7：canvas 矢量路径非 emoji，DSF=1 可截图识读） */
  function glyph(type, x, y, s, color) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.4, s / 7); ctx.lineCap = 'round'
    const h2 = s / 2
    if (type === 'sword') { ctx.beginPath(); ctx.moveTo(0, -h2); ctx.lineTo(0, h2 * 0.7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-h2 * 0.45, -h2 * 0.15); ctx.lineTo(h2 * 0.45, -h2 * 0.15); ctx.stroke() }
    else if (type === 'axe') { ctx.beginPath(); ctx.moveTo(0, -h2); ctx.lineTo(0, h2 * 0.8); ctx.stroke(); ctx.beginPath(); ctx.arc(h2 * 0.15, -h2 * 0.55, h2 * 0.5, -Math.PI * 0.8, Math.PI * 0.25); ctx.stroke() }
    else if (type === 'lance') { ctx.beginPath(); ctx.moveTo(-h2 * 0.7, h2 * 0.7); ctx.lineTo(h2 * 0.75, -h2 * 0.75); ctx.stroke(); ctx.beginPath(); ctx.moveTo(h2 * 0.75, -h2 * 0.75); ctx.lineTo(h2 * 0.25, -h2 * 0.72); ctx.stroke() }
    else if (type === 'bow') { ctx.beginPath(); ctx.arc(-h2 * 0.25, 0, h2 * 0.8, -Math.PI * 0.45, Math.PI * 0.45); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-h2 * 0.25 + h2 * 0.8 * Math.cos(-Math.PI * 0.45), h2 * 0.8 * Math.sin(-Math.PI * 0.45)); ctx.lineTo(-h2 * 0.25 + h2 * 0.8 * Math.cos(Math.PI * 0.45), h2 * 0.8 * Math.sin(Math.PI * 0.45)); ctx.stroke() }
    else if (type === 'mage') { ctx.beginPath(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * Math.PI * 2 / 5; const px = Math.cos(a) * h2 * 0.9, py = Math.sin(a) * h2 * 0.9; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) } ctx.closePath(); ctx.fill() }
    else { ctx.beginPath(); ctx.moveTo(0, -h2 * 0.85); ctx.lineTo(0, h2 * 0.85); ctx.moveTo(-h2 * 0.6, 0); ctx.lineTo(h2 * 0.6, 0); ctx.lineWidth = Math.max(2, s / 4.4); ctx.stroke() }
    ctx.restore()
  }
  /* 令牌底盘形状（第二形状通道：圆/八方/菱/半圆弧/六角/圆角方） */
  function baseShape(type, x, y, r) {
    ctx.beginPath()
    if (type === 'sword') ctx.arc(x, y, r, 0, Math.PI * 2)
    else if (type === 'axe') { for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + Math.PI / 8; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) } ctx.closePath() }
    else if (type === 'lance') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath() }
    else if (type === 'bow') ctx.arc(x, y, r, Math.PI, Math.PI * 2)
    else if (type === 'mage') { for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 - Math.PI / 2; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) } ctx.closePath() }
    else roundRect(x - r, y - r, r * 2, r * 2, r * 0.45)
  }
  function drawUnit(u, p, mine) {
    const d = UT[u.type], col = u.seat === 0 ? COL_A : COL_B
    const cx = p.x + BOARD.cs / 2, cy = p.y + BOARD.cs / 2
    ctx.save()
    baseShape(u.type, cx, cy, 17)
    ctx.fillStyle = u.seat === 0 ? 'rgba(42,44,52,0.95)' : 'rgba(36,44,50,0.95)'
    ctx.fill()
    ctx.lineWidth = mine ? 2.6 : 1.6                       // A 实心粗描边 / B 双细线（§7 形状通道）
    ctx.strokeStyle = col
    ctx.stroke()
    if (!mine) { baseShape(u.type, cx, cy, 14); ctx.lineWidth = 0.8; ctx.stroke() }
    glyph(u.type, cx, cy - 3, 15, col)
    /* 血条：A 实心 / B 分段（hud-standard §3 先例） */
    const bw = 34, frac = Math.max(0, u.hp / d.hp)
    ctx.fillStyle = '#10151B'; ctx.fillRect(cx - bw / 2, p.y + BOARD.cs - 9, bw, 4)
    ctx.fillStyle = u.hp * 2 <= d.hp ? '#E85D3D' : '#6FE87C'
    if (mine) ctx.fillRect(cx - bw / 2, p.y + BOARD.cs - 9, bw * frac, 4)
    else for (let i = 0; i < 7; i++) if (i / 7 < frac) ctx.fillRect(cx - bw / 2 + i * (bw / 7) + 0.5, p.y + BOARD.cs - 9, bw / 7 - 1, 4)
    ctx.fillStyle = '#DCE6F0'; ctx.font = F0(13); ctx.textAlign = 'center'
    ctx.fillText(String(u.hp), cx, p.y + BOARD.cs - 12.5)
    /* 激活态角标：moved=待行动小点 / 濒死血条闪烁 */
    if (mine && u.ph === 'moved' && S.view.turn === S.seat) { ctx.fillStyle = '#FFD37A'; ctx.beginPath(); ctx.arc(p.x + BOARD.cs - 7, p.y + 7, 3, 0, Math.PI * 2); ctx.fill() }
    if (u.hp * 2 <= d.hp) { ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 200); ctx.strokeStyle = '#E85D3D'; ctx.lineWidth = 1.5; baseShape(u.type, cx, cy, 19); ctx.stroke(); ctx.globalAlpha = 1 }
    ctx.restore()
  }
  function drawTerrain(cell, p) {
    const t = S.view.terrain[cell]
    if (t === 1) { ctx.fillStyle = FOREST; ctx.fillRect(p.x, p.y, BOARD.cs, BOARD.cs); ctx.fillStyle = '#2E5B40'; for (const [dx, dy] of [[12, 14], [28, 18], [20, 32]]) { ctx.beginPath(); ctx.moveTo(p.x + dx, p.y + dy - 9); ctx.lineTo(p.x + dx + 6, p.y + dy + 4); ctx.lineTo(p.x + dx - 6, p.y + dy + 4); ctx.closePath(); ctx.fill() } }
    else if (t === 2) { ctx.fillStyle = ROCK; ctx.fillRect(p.x, p.y, BOARD.cs, BOARD.cs); ctx.fillStyle = '#5C636C'; ctx.beginPath(); ctx.moveTo(p.x + 10, p.y + 32); ctx.lineTo(p.x + 18, p.y + 12); ctx.lineTo(p.x + 30, p.y + 20); ctx.lineTo(p.x + 34, p.y + 34); ctx.closePath(); ctx.fill() }
    else if (t === 3) { ctx.fillStyle = RIVER; ctx.fillRect(p.x, p.y, BOARD.cs, BOARD.cs); ctx.strokeStyle = 'rgba(120,180,220,0.5)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p.x + 8, p.y + 22); ctx.quadraticCurveTo(p.x + 16, p.y + 16, p.x + 22, p.y + 22); ctx.quadraticCurveTo(p.x + 30, p.y + 28, p.x + 37, p.y + 22); ctx.stroke() }
    else if (t === 4) { /* 据点旗帜（§7：持有方阵营色 + A 三角旗/B 燕尾旗） */ const owner = S.view.own[S.view.points.indexOf(cell)]; const col = owner === 0 ? COL_A : owner === 1 ? COL_B : '#9FB0C0'; const cx = p.x + BOARD.cs / 2, cy = p.y + BOARD.cs / 2
      ctx.strokeStyle = '#8B95A2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy + 12); ctx.lineTo(cx, cy - 12); ctx.stroke()
      ctx.fillStyle = col
      if (owner === 1) { ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 14, cy - 8); ctx.lineTo(cx + 8, cy - 4); ctx.lineTo(cx + 14, cy); ctx.lineTo(cx, cy + 4); ctx.closePath(); ctx.fill() }
      else { ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 15, cy - 6); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill() }
    }
  }
  function render() {
    const now = performance.now()
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H)
    if (!S.view) { ctx.fillStyle = '#9FB0C0'; ctx.font = F1(12); ctx.textAlign = 'center'; ctx.fillText(S.connLost ? '连接断开·点击重连' : '连接网关…', W / 2, H / 2); requestAnimationFrame(render); return }
    const v = S.view
    /* 顶栏 56px：对方占点分/回合数/倒计时/托管徽标（§7） */
    const turnSec = Math.max(0, Math.ceil((S.deadlineAt - now) / 1000))
    const lbl = (txt, x, align, fnt, col) => { ctx.font = fnt; ctx.fillStyle = col; ctx.textAlign = align; ctx.fillText(txt, x, 24) }
    lbl('B', 16, 'left', F0(15), COL_B); lbl(String(v.scores[1]), 32, 'left', F0(16), '#DCE6F0')
    lbl('A', W - 34, 'right', F0(15), COL_A); lbl(String(v.scores[0]), W - 18, 'right', F0(16), '#DCE6F0')
    const phaseTxt = v.phase === 'deploy' ? '部署' : S.spectator ? '玩家' + (v.turn === 0 ? 'A' : 'B') + ' 行动' : v.turn === S.seat ? '你的回合' : '对方回合'
    ctx.textAlign = 'center'
    ctx.font = F1(12); ctx.fillStyle = '#9FB0C0'; ctx.fillText(phaseTxt + (v.phase !== 'deploy' ? ' · 第 ' + Math.ceil(v.turnNo / 2) + ' 回合' : ''), W / 2, 20)
    ctx.font = F0(14); ctx.fillStyle = turnSec <= 5 && v.phase !== 'over' ? '#FF9D85' : '#DCE6F0'
    ctx.fillText(turnSec + 's', W / 2, 42)
    if (v.host && (v.host[0] || v.host[1])) { ctx.font = F1(11); ctx.fillStyle = '#9D6BE8'; ctx.fillText((v.host[0] ? 'A托管 ' : '') + (v.host[1] ? 'B托管' : ''), W / 2 + 62, 20) }
    if (!S.spectator && v.host && v.host[S.seat]) { ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 400); ctx.font = F1(11); ctx.fillStyle = '#9D6BE8'; ctx.fillText('托管中', 64, 42); ctx.globalAlpha = 1 }
    /* 棋盘（双色微差格=识图锚） */
    for (let c = 0; c < 64; c++) {
      const p = cellXY(c)
      const r = (flip(c) / 8) | 0, col = flip(c) % 8
      ctx.fillStyle = (r + col) % 2 === 0 ? CELL_A : CELL_B
      ctx.fillRect(p.x, p.y, BOARD.cs, BOARD.cs)
      ctx.strokeStyle = GRID_C; ctx.lineWidth = 0.7
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, BOARD.cs - 1, BOARD.cs - 1)
      drawTerrain(c, p)
    }
    /* 部署区高亮（deploy 期己方 16 格） */
    if (v.phase === 'deploy' && !S.spectator) {
      for (let c = 0; c < 64; c++) { if (S.seat === 0 ? c >= 48 : c <= 15) { const p = cellXY(c); ctx.fillStyle = 'rgba(232,163,61,0.07)'; ctx.fillRect(p.x, p.y, BOARD.cs, BOARD.cs) } }
    }
    /* 选中态：移动域 + 射程目标角框 + 伤害预演（§3.1/§3.3 辅助层） */
    const myTurn = !S.spectator && v.phase === 'act' && v.turn === S.seat
    if (myTurn && S.sel && !S.sel.skill) {
      for (const d of moveDomain(S.sel.unit)) {
        const p = cellXY(d.cell)
        ctx.fillStyle = d.path.length > 1 ? 'rgba(61,200,232,0.16)' : 'rgba(61,200,232,0.07)'
        ctx.fillRect(p.x + 2, p.y + 2, BOARD.cs - 4, BOARD.cs - 4)
        if (d.path.length > 1) { ctx.strokeStyle = 'rgba(61,200,232,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(p.x + 2.5, p.y + 2.5, BOARD.cs - 5, BOARD.cs - 5) }
      }
      for (const tid of targetList(S.sel.unit)) {
        const t = v.units.find((z) => z.id === tid); if (!t) continue
        const p = cellXY(t.cell), m = 7
        ctx.strokeStyle = '#E85D3D'; ctx.lineWidth = 2.2
        ctx.beginPath()
        ctx.moveTo(p.x + m, p.y + 1); ctx.lineTo(p.x + 1, p.y + 1); ctx.lineTo(p.x + 1, p.y + m)
        ctx.moveTo(p.x + BOARD.cs - m, p.y + BOARD.cs - 1); ctx.lineTo(p.x + BOARD.cs - 1, p.y + BOARD.cs - 1); ctx.lineTo(p.x + BOARD.cs - 1, p.y + BOARD.cs - m)
        ctx.moveTo(p.x + m, p.y + BOARD.cs - 1); ctx.lineTo(p.x + 1, p.y + BOARD.cs - 1); ctx.lineTo(p.x + 1, p.y + BOARD.cs - m)
        ctx.moveTo(p.x + BOARD.cs - m, p.y + 1); ctx.lineTo(p.x + BOARD.cs - 1, p.y + 1); ctx.lineTo(p.x + BOARD.cs - 1, p.y + m)
        ctx.stroke()
        ctx.fillStyle = '#FF6B4A'; ctx.font = F0(13); ctx.textAlign = 'center'
        ctx.fillText('-' + dmgPreview(S.sel.unit, tid), p.x + BOARD.cs / 2, p.y - 3)
      }
    }
    if (myTurn && S.sel && S.sel.skill === 'mage') {
      for (const f of fireballPreview(S.sel.unit)) {
        if (f.foes + f.own === 0) continue
        const p = cellXY(f.cell)
        ctx.fillStyle = f.foes >= 2 ? 'rgba(232,93,61,0.22)' : 'rgba(232,93,61,0.10)'
        ctx.fillRect(p.x + 2, p.y + 2, BOARD.cs - 4, BOARD.cs - 4)
      }
    }
    if (myTurn && S.sel && S.sel.skill === 'healer') {
      for (const tid of healPreview(S.sel.unit)) {
        const t = v.units.find((z) => z.id === tid); if (!t) continue
        const p = cellXY(t.cell)
        ctx.fillStyle = 'rgba(111,232,124,0.18)'; ctx.fillRect(p.x + 2, p.y + 2, BOARD.cs - 4, BOARD.cs - 4)
      }
    }
    /* 单位（含 deploy 期本地布置预览） */
    if (v.phase === 'deploy') {
      if (S.deployMap && !S.spectator) for (const tp of Object.keys(S.deployMap)) {
        const p = cellXY(S.deployMap[tp])
        drawUnit({ seat: S.seat, type: tp, hp: UT[tp].hp, ph: 'idle' }, p, true)
        if (S.deploySel === tp) { ctx.strokeStyle = '#FFD37A'; ctx.lineWidth = 2.5; ctx.strokeRect(p.x + 1.5, p.y + 1.5, BOARD.cs - 3, BOARD.cs - 3) }
      }
    } else for (const u of v.units) drawUnit(u, cellXY(u.cell), u.seat === rs())
    /* 选中信息条 26px（§7：兵种名+HP/攻/防+技能简述） */
    const infoU = myTurn && S.sel ? v.units.find((z) => z.id === (S.sel.skill || S.sel.unit)) : null
    ctx.fillStyle = '#1A2027'; ctx.fillRect(11, 424, 353, 26)
    if (infoU) {
      const d = UT[infoU.type]
      ctx.font = F1(11); ctx.fillStyle = '#9FB0C0'; ctx.textAlign = 'left'
      ctx.fillText(d.n, 18, 441)
      ctx.font = F0(13); ctx.fillStyle = '#DCE6F0'
      ctx.fillText(`${infoU.hp}/${d.hp}`, 62, 441); ctx.fillText(`攻${d.atk} 防${d.def} 移${d.mv}`, 122, 441)
      ctx.font = F1(11); ctx.fillStyle = '#7C8B98'
      const short = S.sel.skill === 'mage' ? '选一格施放火球' : S.sel.skill === 'healer' ? '选受伤友军治疗' : d.skill
      ctx.fillText(short, 220, 441)
    } else { ctx.font = F1(11); ctx.fillStyle = '#7C8B98'; ctx.textAlign = 'left'; ctx.fillText(v.phase === 'deploy' ? '部署：点兵种→点己方区格放置，出战提交' : '点选单位查看', 18, 441) }
    /* AP 灯珠行（§7：4 颗；剩余=实心点亮/已耗=空心） */
    const apTxt = v.phase === 'act' && v.turn === rs() ? v.ap : -1
    for (let i = 0; i < 4; i++) {
      const x = 20 + i * 22, y = 468
      ctx.beginPath(); ctx.arc(x, y + 6, 7, 0, Math.PI * 2)
      if (i < apTxt) { ctx.fillStyle = rs() === 0 ? COL_A : COL_B; ctx.fill() }
      else { ctx.strokeStyle = '#5A6672'; ctx.lineWidth = 1.5; ctx.stroke() }
    }
    ctx.font = F0(13); ctx.fillStyle = '#DCE6F0'; ctx.textAlign = 'left'
    ctx.fillText('AP', 110, 477)
    /* 底栏钮（托管/撤销/技能/结束回合） */
    const barY = H - 116
    const btn = (x, w2, label, active, danger) => {
      ctx.fillStyle = active ? '#33404C' : '#262E37'; roundRect(x, barY, w2, 48, 8); ctx.fill()
      ctx.strokeStyle = danger ? `rgba(232,93,61,${0.5 + 0.5 * Math.sin(now / 120)})` : active ? '#9FB0C0' : '#4A5560'; ctx.lineWidth = danger ? 2.5 : 1.5
      roundRect(x, barY, w2, 48, 8); ctx.stroke()
      ctx.fillStyle = danger ? '#FF9D85' : active ? '#DCE6F0' : '#7C8B98'; ctx.font = F1(12); ctx.textAlign = 'center'; ctx.fillText(label, x + w2 / 2, barY + 28)
    }
    if (!S.spectator) {
      const selU = myTurn && S.sel ? v.units.find((z) => z.id === (S.sel.skill || S.sel.unit)) : null
      btn(BTN.host.x, BTN.host.w, v.host && v.host[S.seat] ? '夺回' : '托管', !!(v.host && v.host[S.seat]))
      btn(BTN.undo.x, BTN.undo.w, v.undoUsed ? '已撤' : '撤销', myTurn && !v.undoUsed)
      btn(BTN.skill.x, BTN.skill.w, selU && selU.type === 'mage' ? '火球' : selU && selU.type === 'healer' ? '治疗' : '技能', !!(selU && (selU.type === 'mage' || selU.type === 'healer') && !S.sel.skill))
      btn(BTN.end.x, BTN.end.w, '结束回合', myTurn, myTurn && turnSec < 5)
    }
    /* fx 引擎（非阻塞 §3.2） */
    S.fx = S.fx.filter((f) => now - f.t0 < 700)
    for (const f of S.fx) {
      const t = (now - f.t0) / 700
      if (f.k === 'dmg' || f.k === 'healFx' || f.k === 'reject') {
        ctx.save(); ctx.globalAlpha = 1 - t
        ctx.fillStyle = f.k === 'healFx' ? '#6FE87C' : f.k === 'reject' ? '#FFD37A' : '#FF6B4A'
        ctx.font = f.k === 'reject' ? F1(13) : F0(Math.round(19 * (t < 0.15 ? 1 + 0.25 * (1 - t / 0.15) : 1)))
        ctx.textAlign = 'center'
        ctx.fillText(f.k === 'reject' ? '非法操作' : f.k === 'healFx' ? '+' + f.n : '-' + f.n, f.x, f.y - 26 * t)
        ctx.restore()
      } else if (f.k === 'die') { ctx.save(); ctx.globalAlpha = 1 - t; ctx.fillStyle = f.seat === 0 ? COL_A : COL_B; for (let i = 0; i < 6; i++) { const a = i * 1.05, d = 26 * t; ctx.fillRect(f.x + Math.cos(a) * d - 2, f.y + Math.sin(a) * d - 2 + 12 * t * t, 4, 4) } ctx.restore() }
      else if (f.k === 'boom') { ctx.save(); ctx.globalAlpha = 1 - t; ctx.strokeStyle = '#E85D3D'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(f.x, f.y, 5 + 30 * t, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = '#E8C93D'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(f.x, f.y, 3 + 18 * t, 0, Math.PI * 2); ctx.stroke(); ctx.restore() }
      else if (f.k === 'land') { ctx.save(); ctx.globalAlpha = 1 - t; ctx.strokeStyle = '#DCE6F0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(f.x, f.y, 6 + 16 * t, 0, Math.PI * 2); ctx.stroke(); ctx.restore() }
    }
    /* 横幅（回合/据点/托管，900ms 非阻塞） */
    S.banners = S.banners.filter((b) => now - b.t0 < 900)
    S.banners.forEach((b, i) => {
      const t = (now - b.t0) / 900
      ctx.save(); ctx.globalAlpha = t < 0.8 ? 1 : (1 - t) / 0.2
      ctx.fillStyle = 'rgba(26,32,39,0.92)'; ctx.fillRect(0, 210 + i * 40, W, 36)
      ctx.fillStyle = b.c1; ctx.fillRect(0, 210 + i * 40, W, 3)
      ctx.fillStyle = '#DCE6F0'; ctx.font = F1(13); ctx.textAlign = 'center'; ctx.fillText(b.txt, W / 2, 234 + i * 40)
      ctx.restore()
    })
    /* 部署浮层底排：兵种条 + 出战钮 */
    if (v.phase === 'deploy' && !S.spectator) {
      const done = v.deployDone && v.deployDone[S.seat]
      ctx.fillStyle = 'rgba(26,32,39,0.97)'; ctx.fillRect(0, H - 124, W, 124)
      for (let i = 0; i < 6; i++) {
        const tp = SIM.TYPE_ORDER[i], r = { x: 8 + i * 61, y: H - 64, w: 56, h: 52 }
        ctx.fillStyle = '#262E37'; roundRect(r.x, r.y, r.w, r.h, 7); ctx.fill()
        ctx.strokeStyle = S.deploySel === tp ? '#FFD37A' : '#4A5560'; ctx.lineWidth = S.deploySel === tp ? 2.5 : 1.2
        roundRect(r.x, r.y, r.w, r.h, 7); ctx.stroke()
        glyph(tp, r.x + r.w / 2, r.y + 20, 17, rs() === 0 ? COL_A : COL_B)
        ctx.fillStyle = '#9FB0C0'; ctx.font = F1(11); ctx.textAlign = 'center'; ctx.fillText(UT[tp].n, r.x + r.w / 2, r.y + 44)
      }
      ctx.fillStyle = done ? '#33404C' : '#3A4A30'; roundRect(W / 2 - 90, H - 118, 180, 48, 8); ctx.fill()
      ctx.strokeStyle = done ? '#9FB0C0' : '#6FE87C'; ctx.lineWidth = 2; roundRect(W / 2 - 90, H - 118, 180, 48, 8); ctx.stroke()
      ctx.fillStyle = '#DCE6F0'; ctx.font = F1(13); ctx.textAlign = 'center'
      ctx.fillText(done ? '已提交·等待对方' : '出战', W / 2, H - 88)
    }
    if (S.err) { ctx.fillStyle = '#FF6B4A'; ctx.font = F1(11); ctx.textAlign = 'center'; ctx.fillText('✕ ' + S.err, W / 2, 60) }
    /* 结算页（§7：胜负大字+战报条+棋桌评语+再来一局） */
    if (S.over && S.result) {
      const r = S.result
      const meWin = r.winner === (rs() === 0 ? 'A' : 'B')
      const verdict = r.winner === 'draw' ? '平局' : S.spectator ? '玩家' + r.winner + ' 胜利' : meWin ? '胜利' : '败北'
      ctx.fillStyle = 'rgba(16,21,27,0.95)'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = r.winner === 'draw' ? '#9FB0C0' : r.winner === 'A' ? COL_A : COL_B
      ctx.font = F0(34); ctx.textAlign = 'center'; ctx.fillText(verdict, W / 2, 150)
      ctx.font = F1(12); ctx.fillStyle = '#7C8B98'; ctx.fillText('reason: ' + r.reason + ' · ' + Math.ceil(S.view.turnNo / 2) + ' 回合', W / 2, 176)
      const sc = r.scores || {}
      ctx.font = F0(13); ctx.fillStyle = '#DCE6F0'
      ctx.fillText(`占点 ${sc.A && sc.A.pts} : ${sc.B && sc.B.pts}`, W / 2, 226)
      ctx.fillText(`歼灭 ${sc.A && sc.A.kills} : ${sc.B && sc.B.kills}`, W / 2, 250)
      ctx.fillText(`存活价值 ${sc.A && sc.A.value} : ${sc.B && sc.B.value}`, W / 2, 274)
      if (r.quip) { ctx.fillStyle = '#9FB0C0'; ctx.font = F1(13); ctx.fillText('「' + r.quip + '」', W / 2, 330) }
      ctx.fillStyle = '#4A5560'; roundRect(40, H - 130, 130, 56, 10); ctx.fill(); ctx.strokeStyle = COL_A; ctx.lineWidth = 2; roundRect(40, H - 130, 130, 56, 10); ctx.stroke()
      ctx.fillStyle = '#DCE6F0'; ctx.font = F1(14); ctx.fillText(S.offline ? '再来一局' : '再来一局', 105, H - 96)
      ctx.fillStyle = '#262E37'; roundRect(205, H - 130, 130, 56, 10); ctx.fill(); ctx.strokeStyle = COL_B; ctx.lineWidth = 2; roundRect(205, H - 130, 130, 56, 10); ctx.stroke()
      ctx.fillStyle = '#DCE6F0'; ctx.fillText('回大厅', 270, H - 96)
    }
    /* 页脚 P2 */
    ctx.fillStyle = '#5A6672'; ctx.font = F2(9); ctx.textAlign = 'left'; ctx.fillText('tactics-duel · v1.0.0 · S1+S5', 10, H - 4)
    requestAnimationFrame(render)
  }

  /* ---------- 离线对打（?debug=1 / 门禁契约；同 sim 同 brain——零网关本地 1v1） ---------- */
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
  function offlineStart(level, opts) {
    if (!SIM) return
    if (S.conn) { try { S.conn.onclose = null; S.conn.onerror = null; S.conn.close() } catch {} S.conn = null }
    if (otimer) { clearInterval(otimer); otimer = null }
    S.offline = true; S.spectator = false; S.seat = 0; S.over = false; S.result = null; S.reveal = null
    S.sel = null; S.deploySel = null; S.deployMap = null; S.fx = []; S.banners = []; S.err = ''; S.connLost = false
    S.offlineLevel = ['casual', 'balanced', 'competitive'][Math.max(0, Math.min(2, (Number(level) || 1) - 1))] || 'balanced'
    osalt++
    ost = SIM.create(SIM.fnv1a32('offline-' + (((opts && opts.seedSalt) || '') + osalt)))
    onMsg({ t: 'welcome', roomId: 'offline', role: 'player', seat: 0, room: { seats: [{ kind: 'human', name: '你' }, { kind: 'bot', level: S.offlineLevel }] }, state: SIM.viewFor(ost, 0) })
    report('start', { mode: 'offline', level: S.offlineLevel, seed: ost.seed })
    const TSPD = (opts && opts.timeScale) || 8 // 假时钟 8x：deploy 2.5s/回合 3.75s（识图/冒烟节奏）
    let autoDeployed = false
    otimer = setInterval(() => {
      if (opaused || !ost || ost.over) return
      for (let i = 0; i < TSPD && ost && !ost.over; i++) { // 每 10ms 一 tick
        const inputs = {}
        const b = SIM.brain(ost, 1, S.offlineLevel)
        if (b && b.op) inputs[1] = b
        if (!autoDeployed && ost.tick > 400) { autoDeployed = true; offlineApply({ k: 'deploy', cells: SIM.TYPE_ORDER.map((tp, j) => ({ unit: tp, cell: SIM.TEMPLATES[0][j][0] })) }) }
        SIM.step(ost, inputs)
        offlineDrain()
      }
    }, 10)
  }

  /* ---------- HUD 自证 + 暴露 ---------- */
  window.__GAMES_DEBUG__ = window.__GAMES_DEBUG__ || {}
  window.__GAMES_DEBUG__.hudFonts = function () { const out = {}; for (const k in HUDF) out[k] = { minPx: HUDF[k].minPx, samples: HUDF[k].n }; return out }
  window.__GAMES_DEBUG__.state = () => ({ view: S.view, seat: S.seat, roster: S.roster, result: S.result, offline: S.offline, over: ost ? ost.over : S.over })
  window.__GAMES_DEBUG__.sendOp = sendOp
  window.__GAMES_DEBUG__.events = dbgEvents
  window.__GAMES_DEBUG__.start = function (level, opts) { offlineStart(level || 1, opts) }
  window.__GAMES_DEBUG__.pause = function (on) { opaused = !!on }
  window.__GAMES_DEBUG__.roomId = function () { return S.roomId }
  window.__GAMES_DEBUG__.seat = function () { return S.seat }
  window.__GAMES_DEBUG__.mode = function () { return S.offline ? 'offline' : 'net' }
  window.__GAMES_DEBUG__.sfx = function () { return { groups: ['move', 'attack', 'skill', 'win'], calls: sfx.calls.slice(-64) } }

  report('boot', { slug: 'tactics-duel', version: '1.0.0', mode: q.get('debug') === '1' ? 'offline' : 'net' })
  if (q.get('debug') === '1' && SIM) offlineStart(1)
  else connect()
  requestAnimationFrame(render)
})()
