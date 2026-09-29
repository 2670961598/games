/* =====================================================================
 * 元素对决 客户端（GAMES-88 · S5 回合权威）——零本地 sim：渲染=ruling 全量
 * state 直染（设计 §5.2 附决策 5）。紫曜夜棋盘 + 四元素双色编码（§7）。
 * HUD 字号对齐 hud-font-standard §1：P0 ≥13px/600、P1 ≥11px、P2 ≥9px；
 * __GAMES_DEBUG__.hudFonts() 当帧登记表（识图断言源，slg/mmo 先例）。
 * ===================================================================== */
'use strict'
;(function () {
  /* ---------- 常量（与服务端 sim.cjs 同源的表现侧拷贝） ---------- */
  const CARDS = {
    F1: { n: '火花精灵', s: 'F', c: 1, a: 2, h: 1, kw: '近战' }, F2: { n: '焰刃武士', s: 'F', c: 2, a: 3, h: 2, kw: '近战' },
    F3: { n: '熔岩巨兽', s: 'F', c: 5, a: 4, h: 6, kw: '近战·嘲讽' }, F4: { n: '烬灭龙', s: 'F', c: 6, a: 6, h: 4, kw: '远程', d: '入场：对敌方英雄 2 伤害' },
    W1: { n: '露珠水灵', s: 'W', c: 1, a: 1, h: 3, kw: '近战·嘲讽' }, W2: { n: '涌泉守卫', s: 'W', c: 3, a: 2, h: 5, kw: '近战·嘲讽' },
    W3: { n: '深渊触手', s: 'W', c: 4, a: 3, h: 4, kw: '远程', d: '入场：冻结一个敌方随从' }, W4: { n: '潮汐巨人', s: 'W', c: 6, a: 5, h: 7, kw: '近战', d: '入场：恢复英雄 4 血' },
    N1: { n: '微风精灵', s: 'N', c: 1, a: 1, h: 2, kw: '远程' }, N2: { n: '疾风刺客', s: 'N', c: 2, a: 3, h: 2, kw: '近战' },
    N3: { n: '云端歌者', s: 'N', c: 3, a: 2, h: 3, kw: '远程', d: '入场：抽 1 张' }, N4: { n: '风暴领主', s: 'N', c: 5, a: 4, h: 5, kw: '远程', d: '入场：其他己方随从 +1 攻' },
    T1: { n: '静电飞鸟', s: 'T', c: 1, a: 1, h: 1, kw: '远程', d: '入场：对敌方英雄 1 伤害' }, T2: { n: '雷纹武者', s: 'T', c: 2, a: 2, h: 3, kw: '近战', d: '入场：本回合已施法术 +1/+1' },
    T3: { n: '磁暴炮手', s: 'T', c: 4, a: 3, h: 4, kw: '远程', d: '攻击时：溅射邻接最低敌 1' }, T4: { n: '雷霆泰君', s: 'T', c: 6, a: 4, h: 5, kw: '远程', d: '入场：全体敌方随从 2 伤害' },
    FS1: { n: '火球术', s: 'F', c: 3, sp: 1, d: '造成 4 伤害' }, FS2: { n: '烈焰行刑', s: 'F', c: 4, sp: 1, d: '一行随从各 3 伤害' },
    WS1: { n: '治愈之潮', s: 'W', c: 1, sp: 1, d: '英雄回 4 / 随从 +0/+2' }, WS2: { n: '凛冬封印', s: 'W', c: 2, sp: 1, d: '冻结并造成 1 伤害' },
    NS1: { n: '顺风祈愿', s: 'N', c: 3, sp: 1, d: '抽 2 张' }, NS2: { n: '迷踪步', s: 'N', c: 1, sp: 1, d: '传送随从到空格' },
    TS1: { n: '连锁闪电', s: 'T', c: 2, sp: 1, d: '2 伤害+邻接各 1' }, TS2: { n: '天罚雷暴', s: 'T', c: 5, sp: 1, d: '全体敌方随从 3 伤害' },
    X0: { n: '元素微粒', s: 'N', c: 0, sp: 1, d: '本回合 +1 费' },
  }
  const HEROES = [
    { n: '炎阳', s: 'F', p: '火弹：单体 2 伤害', b: '燃魂：火系攻击 +1' },
    { n: '潮汐', s: 'W', p: '涌泉：回 3 或 +0/+2', b: '润泽：回合开始回 1' },
    { n: '疾风', s: 'N', p: '疾影：抽 1 张', b: '顺风：风系部署即可攻随从' },
    { n: '雷鸣', s: 'T', p: '电弧：单体+邻接各 1', b: '电容：每法术磨 1' },
  ]
  const RT = { steam: ['蒸气', '#3DA8E8', '#E85D3D'], chain: ['连锁', '#7CE8B8', '#E8C93D'], blast: ['引爆', '#E85D3D', '#E8C93D'], mist: ['迷雾', '#3DA8E8', '#7CE8B8'], wildfire: ['燎原', '#E85D3D', '#7CE8B8'], surge: ['感电', '#3DA8E8', '#E8C93D'] }
  const SC = { F: '#E85D3D', W: '#3DA8E8', N: '#7CE8B8', T: '#E8C93D' } // 元素色（§7 双通道之色相）
  const SG = { F: '▲', W: '●', N: '➤', T: '⚡' }                        // 字形通道（canvas 矢量绘制，见 glyph()）
  const COL_A = '#E8A33D', COL_B = '#3DC8E8' // 玩家双色（平台标准）
  const W = 375, H = 667
  const BOARD = { x: 22, y: 118, cellW: 105, cellH: 54, gap: 8 } // 行 0 顶=近对方侧（§1.3）
  const HAND_Y = H - 66 - 132 + 8

  /* ---------- HUD 字号登记表（P0 ≥13px/600 · P1 ≥11px · P2 ≥9px） ---------- */
  const HUDF = {}
  const font = (px, weight, cls) => { const f = `${weight} ${px}px system-ui, -apple-system, sans-serif`; HUDF[cls] = HUDF[cls] || { minPx: 99, n: 0 }; HUDF[cls].minPx = Math.min(HUDF[cls].minPx, px); HUDF[cls].n++; return f }
  const F0 = (px) => font(Math.max(13, px), 600, 'P0') // 数值/HP/攻血/计时
  const F1 = (px) => font(Math.max(11, px), 600, 'P1') // 卡名/按钮/评语
  const F2 = (px) => font(Math.max(9, px), 500, 'P2')  // 页脚

  /* ---------- 网关连接（?gw= 覆盖，resume 凭 sessionStorage token） ---------- */
  const q = new URLSearchParams(location.search)
  const GW = (() => { const g = q.get('gw'); if (g) return `ws://${g}`; if (location.protocol === 'https:') return `wss://${location.host}`; return `ws://${location.hostname || '127.0.0.1'}:4400` })()
  const cv = document.getElementById('cv'), ctx = cv.getContext('2d')
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'
  ctx.scale(dpr, dpr)
  document.getElementById('stage').style.background = '#1E1030'
  document.getElementById('boot').style.display = 'none' // 藏 DOM 引导字（canvas 全宽；几何断言防 flex 溢出）

  /* ---------- QA 证据：__GAMES_DEBUG__.events（GAMES-90 F3，对齐 pool/slg/mmo/emp 泳道契约） ---------- */
  const dbgEvents = []
  const report = (event, payload) => { dbgEvents.push({ event, payload: payload || null, at: Date.now() }) }

  const S = { // 客户端态
    conn: null, seat: 0, token: null, roomId: null, roster: [],
    spectator: false, // F2：满员转旁观（seat=-1）——渲染走 rs() 观战视角、输入全禁
    offline: false, offlineLevel: 'balanced', // F3：?debug=1 本地对打（同 sim 同 brain，零网关）
    view: null, // 最新个性化 state（§5.3 视图）
    lastRulingAt: 0, deadlineAt: 0, timerMs0: 0,
    sel: null, // {mode:'card'|'atk'|'power', card?, from?}
    drag: null, // {card, x, y}
    hoverCell: -1,
    fx: [], banners: [], result: null, over: false,
    mullKeep: null, err: '', connLost: false,
  }
  const rs = () => (S.spectator ? 0 : S.seat) // 渲染席（F2：观战以席 A 视角看全场；真人席=自身）
  const myViewHand = () => (S.view && S.view.hand && Array.isArray(S.view.hand[rs()]) ? S.view.hand[rs()] : []) // 观战=双隐藏→空扇
  const oppSeat = () => 1 - rs()
  const flip = (c) => (rs() === 1 ? (2 - ((c / 3) | 0)) * 3 + (c % 3) : c) // 席 B 翻转渲染（服务器行号绝对，§1.3；观战不翻）
  const cellXY = (c) => { const d = flip(c), row = (d / 3) | 0, col = d % 3; return { x: BOARD.x + col * (BOARD.cellW + BOARD.gap), y: BOARD.y + row * (BOARD.cellH + BOARD.gap) } }
  const cellAt = (x, y) => { for (let c = 0; c < 9; c++) { const p = cellXY(c); if (x >= p.x && x <= p.x + BOARD.cellW && y >= p.y && y <= p.y + BOARD.cellH) return c } return -1 }

  function connect() {
    document.getElementById('boot').textContent = '连接网关 ' + GW.replace('ws://', '') + ' …'
    const ws = new WebSocket(GW)
    S.conn = ws
    ws.onopen = () => {
      const rid = q.get('room')
      const saved = (() => { try { return JSON.parse(sessionStorage.getItem('ed-' + rid) || 'null') } catch { return null } })()
      ws.send(JSON.stringify({ t: 'join', roomId: rid || undefined, mode: 'play', resume: saved ? { seat: saved.seat, token: saved.token } : undefined, name: '玩家' }))
      if (!rid) ws.send(JSON.stringify({ t: 'quick', gameId: 'element-duel' }))
    }
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data) } catch { return } onMsg(m) }
    ws.onclose = () => { S.connLost = true }
    ws.onerror = () => { S.connLost = true }
  }
  const sendOp = (op) => {
    if (S.offline) { offlineApply(op); return } // F3 离线对打：同一 applyOp 权威入口
    if (S.conn && S.conn.readyState === 1) S.conn.send(JSON.stringify(Object.assign({ t: 'op' }, op)))
  }

  function onMsg(m) {
    if (m.t === 'error') { S.err = m.code || m.message; setTimeout(() => { S.err = '' }, 2500); return }
    if (m.t === 'welcome') {
      S.roomId = m.roomId; S.spectator = m.role !== 'player'; S.seat = S.spectator ? -1 : m.seat; S.token = m.token
      if (m.token != null) { try { sessionStorage.setItem('ed-' + S.roomId, JSON.stringify({ seat: S.seat, token: S.token })) } catch {} }
      S.view = m.state
      if (m.room && m.room.duel && m.room.duel.hash !== undefined) S.duelHash = m.room.duel.hash
      if (m.room && m.room.seats) S.roster = m.room.seats
      startTimer(m.state)
      return
    }
    if (m.t === 'seat') { S.roster = m.seats; return }
    if (m.t === 'started') { S.view = m.state; startTimer(m.state); return }
    if (m.t === 'ruling') {
      S.view = m.state; startTimer(m.state)
      for (const ev of m.events || []) onEvent(ev, m)
      return
    }
    if (m.t === 'end') { S.over = true; S.result = m.result; S.view = S.view || {}; if (m.result && m.result.reveal) S.reveal = m.result.reveal.hands; return }
    if (m.t === 'closed') { S.connLost = true }
  }
  function startTimer(view) { S.timerMs0 = view && view.timerMs || 0; S.deadlineAt = performance.now() + S.timerMs0 }
  function onEvent(ev, m) {
    const posOf = (tgt) => { if (!tgt) return null; if (tgt.c === -1) return tgt.s === rs() ? { x: W / 2, y: H - 158 } : { x: W / 2, y: 56 }; const p = cellXY(tgt.c); return { x: p.x + BOARD.cellW / 2, y: p.y + BOARD.cellH / 2 } }
    if (ev.k === 'damage' || ev.k === 'heal') { const p = posOf(ev.tgt); if (p) S.fx.push({ k: ev.k, n: ev.n, x: p.x, y: p.y, t0: performance.now() }) }
    if (ev.k === 'reaction') { const r = RT[ev.rt]; S.banners.push({ txt: r[0] + '反应！', c1: r[1], c2: r[2], t0: performance.now() }) }
    if (ev.k === 'turn') { S.banners.push({ txt: S.spectator ? '玩家' + (ev.s === 0 ? 'A' : 'B') + ' 的回合' : (ev.s === S.seat ? '你的回合' : '对方回合'), c1: ev.s === 0 ? COL_A : COL_B, c2: '#B9A8E8', t0: performance.now(), sys: 1 }) }
    if (ev.k === 'reject') { S.fx.push({ k: 'reject', x: W / 2, y: 330, t0: performance.now() }); S.sel = null; S.drag = null }
    if (ev.k === 'burn') { S.banners.push({ txt: '手牌溢出·烧毁', c1: '#E85D3D', c2: '#1E1030', t0: performance.now(), sys: 1 }) }
    if (ev.k === 'fatigue') { S.banners.push({ txt: '疲劳 ' + ev.n, c1: '#9D6BE8', c2: '#1E1030', t0: performance.now(), sys: 1 }) }
    if (ev.k === 'timeout-turn') { S.banners.push({ txt: '托管代打', c1: '#9D6BE8', c2: '#1E1030', t0: performance.now(), sys: 1 }) }
    if (ev.k === 'host') { S.banners.push({ txt: ev.on ? '托管中·随时夺回' : '已夺回', c1: '#9D6BE8', c2: '#1E1030', t0: performance.now(), sys: 1 }) }
  }

  /* ---------- 客户端合法目标预判（仅引导；权威在服务器，reject 回弹） ---------- */
  function affordable(i) { const h = myViewHand(); const d = CARDS[h[i]]; return d && S.view.heroes[rs()].mana >= d.c }
  function ownCount() { let n = 0; for (let c = 0; c < 9; c++) if (S.view.board[c] && S.view.board[c].seat === rs()) n++; return n }
  function legalCells(i) {
    const h = myViewHand(), d = CARDS[h[i]]
    if (!d || d.sp || !affordable(i) || ownCount() >= 4) return []
    const out = []
    for (let c = 0; c < 9; c++) if (!S.view.board[c]) out.push(c)
    return out
  }
  function spellTargets(i) {
    const h = myViewHand(), id = h[i]
    const out = []
    for (let c = 0; c < 9; c++) { const m = S.view.board[c]; if (!m) continue
      if (id === 'FS1' || id === 'TS1' || id === 'WS2') { if (m.seat !== rs()) out.push({ tgt: { s: m.seat, c } }) }
      else if (id === 'WS1') { if (m.seat === rs()) out.push({ tgt: { s: rs(), c } }) }
      else if (id === 'NS2') { if (m.seat === rs()) for (let t = 0; t < 9; t++) if (!S.view.board[t]) out.push({ tgt: { from: c, to: t } }) }
    }
    if (id === 'FS1') out.push({ tgt: { s: oppSeat(), c: -1 } })
    if (id === 'WS1') out.push({ tgt: { s: rs(), c: -1 } })
    if (id === 'FS2') for (let r = 0; r < 3; r++) out.push({ tgt: { row: r } })
    if (id === 'NS1' || id === 'TS2' || id === 'X0') out.push({})
    return out
  }
  function atkTargets(from) {
    const m = S.view.board[from], e = oppSeat(), out = []
    if (!m || m.seat !== rs() || !m.ready || m.frozen > 0) return out
    let taunt = false
    for (let c = 0; c < 9; c++) { const t = S.view.board[c]; if (t && t.seat === e && t.taunt) taunt = true }
    const adj = new Set([from - 3, from + 1, from + 3, from - 1])
    for (let c = 0; c < 9; c++) { const t = S.view.board[c]; if (!t || t.seat !== e) continue; if (taunt && !t.taunt) continue; if (m.melee && !adj.has(c)) continue; out.push(c) }
    const nearFoeRow = rs() === 0 ? 0 : 2
    if (!taunt && !m.newly && (m.ranged || ((from / 3) | 0) === nearFoeRow)) out.push(-1)
    return out
  }
  function powerTargets() {
    const hero = S.view.heroes[rs()].hero, out = []
    if (hero === 0) { out.push({ tgt: { s: oppSeat(), c: -1 } }); for (let c = 0; c < 9; c++) if (S.view.board[c]) out.push({ tgt: { s: S.view.board[c].seat, c } }) }
    else if (hero === 1) { out.push({ tgt: { s: rs(), c: -1 } }); for (let c = 0; c < 9; c++) if (S.view.board[c] && S.view.board[c].seat === rs()) out.push({ tgt: { s: rs(), c } }) }
    else if (hero === 2) out.push({})
    else if (hero === 3) for (let c = 0; c < 9; c++) if (S.view.board[c]) out.push({ tgt: { s: S.view.board[c].seat, c } })
    return out
  }
  function faceDamage() { // 斩杀线客户端复算（§3.2，只用己方可见信息）
    const e = oppSeat(); let d = 0
    for (let c = 0; c < 9; c++) { const m = S.view.board[c]; if (!m || m.seat === e || m.taunt) { if (m && m.seat === e && m.taunt) return 0 } }
    for (let c = 0; c < 9; c++) { const m = S.view.board[c]; if (!m || m.seat !== rs() || !m.ready || m.frozen > 0 || m.newly) continue; const nearFoeRow = rs() === 0 ? 0 : 2; if (m.ranged || ((c / 3) | 0) === nearFoeRow) d += m.atk }
    const me = S.view.heroes[rs()]
    if (!me.powerUsed && me.mana >= 2 && me.hero === 0) d += 2
    const h = myViewHand()
    for (let i = 0; i < h.length; i++) if (h[i] === 'FS1' && me.mana >= 3) d += 4
    return d
  }
  /* 拖牌反应预览（§3.2）：hover 格与将触发反应的邻接对色环 */
  function previewReactions(cell, cardId) {
    const out = []
    const m = CARDS[cardId]
    if (!m || m.sp) return out
    const row = (cell / 3) | 0, col = cell % 3
    const nbr = [row > 0 ? cell - 3 : -1, col < 2 ? cell + 1 : -1, row < 2 ? cell + 3 : -1, col > 0 ? cell - 1 : -1]
    for (const n of nbr) { const b = n >= 0 ? S.view.board[n] : null; if (b && b.seat === rs() && b.school !== m.s) out.push(n) }
    return out
  }

  /* ---------- 输入（单拇指三动作：拖/点/大钮） ---------- */
  let ptr = { down: false, x: 0, y: 0, moved: false }
  function pos(e) { const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) } }
  cv.addEventListener('pointerdown', (e) => { const p = pos(e); ptr = { down: true, moved: false, x: p.x, y: p.y, t0: performance.now(), card: hitHand(p.x, p.y) } }, { passive: false })
  cv.addEventListener('pointermove', (e) => {
    const p = pos(e)
    if (!ptr.down) { S.hoverCell = cellAt(p.x, p.y); return }
    if (Math.hypot(p.x - ptr.x, p.y - ptr.y) > 8) ptr.moved = true
    if (ptr.moved && ptr.card != null) S.drag = { card: ptr.card, x: p.x, y: p.y }
    S.hoverCell = cellAt(p.x, p.y)
  }, { passive: false })
  cv.addEventListener('pointerup', (e) => {
    const p = pos(e)
    const wasDrag = ptr.moved && ptr.card != null
    const draggedCard = S.drag
    S.drag = null
    ptr.down = false
    if (!S.view || S.over) return
    if (wasDrag && draggedCard != null) { tapCell(cellAt(p.x, p.y), draggedCard); return } // 拖牌松手=部署
    tap(p.x, p.y)
  }, { passive: false })

  function hitHand(x, y) { // 手牌扇命中（3.5 张可见；卡 78×108）
    const h = myViewHand()
    for (let i = 0; i < h.length; i++) { const r = handRect(i); if (x >= r.x && x <= r.x + 78 && y >= r.y && y <= r.y + 108) return i }
    return null
  }
  function handRect(i) { const n = myViewHand().length; const spread = Math.min(78, 300 / Math.max(1, n)); const x0 = W / 2 - (spread * (n - 1) + 78) / 2; return { x: x0 + i * spread, y: H - 66 - 132 + 24 } }

  function tapCell(c, cardIdx) {
    if (c < 0 || S.view.phase !== 'play' || S.view.turn !== S.seat) return
    if (cardIdx != null && legalCells(cardIdx).includes(c)) sendOp({ k: 'play', card: cardIdx, cell: c })
    S.sel = null
  }
  function tap(x, y) {
    const v = S.view
    if (S.connLost) { connect(); return }
    if (S.over) { // 结算页：再来一局 / 回大厅
      if (y > H - 130 && y < H - 74) { if (x > W / 2) { try { sessionStorage.removeItem('ed-' + S.roomId) } catch {} location.href = '/multiplayer' } else { try { sessionStorage.removeItem('ed-' + S.roomId) } catch {} location.reload() } }
      return
    }
    if (!v) return
    if (S.spectator) return // F2：观战零输入（托管/技能/结束钮全禁——底栏仅作态势显示）
    if (v.phase === 'pick' && v.heroes[rs()].hero < 0) { // 选英雄浮层
      for (let hI = 0; hI < 4; hI++) { const r = { x: 18 + (hI % 2) * 176, y: 150 + ((hI / 2) | 0) * 190, w: 162, h: 176 }; if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) sendOp({ k: 'pick', hero: hI }) }
      return
    }
    if (v.phase === 'mulligan' && !v.mullDoneByMe) { // 换牌浮层（tap 切换保留态）
      const h = myViewHand()
      if (S.mullKeep == null) S.mullKeep = h.map(() => true)
      if (y > H - 92 && y < H - 40 && x > W / 2 - 80 && x < W / 2 + 80) { sendOp({ k: 'mulligan', keep: S.mullKeep }); v.mullDoneByMe = true; return }
      for (let i = 0; i < h.length; i++) { const r = handRect(i); if (x >= r.x && x <= r.x + 78 && y >= r.y && y <= r.y + 108) { S.mullKeep[i] = !S.mullKeep[i]; return } }
      return
    }
    if (v.phase !== 'play') return
    /* 底栏：托管 40×48 ｜ 技能 56×48 ｜ 结束回合 108×48（§1.6 区位） */
    const barY = H - 58
    if (y > barY && y < barY + 48) {
      if (x > 14 && x < 54) { sendOp({ k: 'host', on: !v.host[S.seat] }); return }
      if (x > 66 && x < 122 && v.turn === S.seat) { S.sel = S.sel && S.sel.mode === 'power' ? null : { mode: 'power' }; return }
      if (x > 252 && x < 360 && v.turn === S.seat) { sendOp({ k: 'endTurn' }); S.sel = null; return }
    }
    if (v.turn !== S.seat) return
    /* 两段式点选：源→目标 */
    if (S.sel && S.sel.mode === 'card') {
      const i = S.sel.card, id = myViewHand()[i]
      for (const t of spellTargets(i)) {
        if (t.tgt && t.tgt.c === -1 && x > 60 && x < W - 60 && ((t.tgt.s === S.seat && y > H - 200) || (t.tgt.s !== S.seat && y < 92))) { sendOp({ k: 'play', card: i, tgt: t.tgt }); S.sel = null; return }
        if (t.tgt && t.tgt.row !== undefined && Math.abs(y - (BOARD.y + t.tgt.row * (BOARD.cellH + BOARD.gap) + BOARD.cellH / 2)) < 24) { sendOp({ k: 'play', card: i, tgt: t.tgt }); S.sel = null; return }
        if (t.tgt && t.tgt.c >= 0) { const c = cellAt(x, y); if (c >= 0 && t.tgt.c === c) { sendOp({ k: 'play', card: i, tgt: t.tgt }); S.sel = null; return } }
        if (!t.tgt && x > 100 && x < W - 100 && y > 300 && y < 360) { sendOp({ k: 'play', card: i }); S.sel = null; return }
      }
      const c = cellAt(x, y)
      if (c >= 0 && legalCells(i).includes(c)) { sendOp({ k: 'play', card: i, cell: c }); S.sel = null; return }
    }
    if (S.sel && S.sel.mode === 'atk') {
      for (const c of atkTargets(S.sel.from)) {
        if (c === -1 && x > 60 && x < W - 60 && y < 92) { sendOp({ k: 'attack', from: S.sel.from, tgt: { s: oppSeat(), c: -1 } }); S.sel = null; return }
        if (c >= 0 && cellAt(x, y) === c) { sendOp({ k: 'attack', from: S.sel.from, tgt: { s: oppSeat(), c } }); S.sel = null; return }
      }
    }
    if (S.sel && S.sel.mode === 'power') {
      for (const t of powerTargets()) {
        if (t.tgt && t.tgt.c === -1 && x > 60 && x < W - 60 && ((t.tgt.s === S.seat && y > H - 200) || (t.tgt.s !== S.seat && y < 92))) { sendOp({ k: 'heroPower', tgt: t.tgt }); S.sel = null; return }
        if (t.tgt && t.tgt.c >= 0 && cellAt(x, y) === t.tgt.c) { sendOp({ k: 'heroPower', tgt: t.tgt }); S.sel = null; return }
        if (!t.tgt && x > 100 && x < W - 100 && y > 300 && y < 360) { sendOp({ k: 'heroPower' }); S.sel = null; return }
      }
    }
    const hc = hitHand(x, y) // 点手牌：随从进入拖/格选，法术进入目标选
    if (hc != null && affordable(hc)) { S.sel = { mode: 'card', card: hc }; return }
    const c = cellAt(x, y) // 点己方 ready 随从=攻击源
    if (c >= 0) { const m = v.board[c]; if (m && m.seat === S.seat && m.ready && m.frozen === 0 && atkTargets(c).length) { S.sel = { mode: 'atk', from: c }; return } }
    S.sel = null
  }

  /* ---------- 绘制 ---------- */
  function glyph(g, x, y, size, color) { // 元素矢量字形（非 emoji，DSF=1 可截图识读，§7）
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = color; ctx.strokeStyle = color
    const s = size / 2
    if (g === '▲') { ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, s * 0.7); ctx.lineTo(-s * 0.9, s * 0.7); ctx.closePath(); ctx.fill() }
    else if (g === '●') { ctx.beginPath(); ctx.arc(0, 0, s * 0.8, 0, Math.PI * 2); ctx.fill() }
    else if (g === '➤') { ctx.beginPath(); ctx.moveTo(-s * 0.7, -s); ctx.lineTo(s * 0.8, 0); ctx.lineTo(-s * 0.7, s); ctx.lineTo(-s * 0.2, 0); ctx.closePath(); ctx.fill() }
    else if (g === '⚡') { ctx.beginPath(); ctx.moveTo(s * 0.35, -s); ctx.lineTo(-s * 0.55, s * 0.15); ctx.lineTo(0, s * 0.15); ctx.lineTo(-s * 0.35, s); ctx.lineTo(s * 0.55, -s * 0.15); ctx.lineTo(0, -s * 0.15); ctx.closePath(); ctx.fill() }
    ctx.restore()
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath() }
  function heroBar(y, seat, isFoe) {
    const v = S.view, h = v.heroes[seat], hero = HEROES[h.hero] || { n: '?', s: 'F' }
    const col = seat === 0 ? COL_A : COL_B
    const myTurn = v.turn === seat && v.phase === 'play'
    /* 英雄像 44×44 + 当前回合白描边呼吸 */
    ctx.save()
    if (myTurn) { ctx.strokeStyle = `rgba(255,255,255,${0.5 + 0.4 * Math.sin(performance.now() / 260)})`; ctx.lineWidth = 2.5; roundRect(16, y + 9, 46, 46, 8); ctx.stroke() }
    ctx.fillStyle = '#2A1B4A'; roundRect(16, y + 9, 46, 46, 8); ctx.fill()
    ctx.strokeStyle = col; ctx.lineWidth = 2; roundRect(16, y + 9, 46, 46, 8); ctx.stroke()
    glyph(SG[hero.s] || '▲', 39, y + 32, 22, SC[hero.s] || col)
    ctx.fillStyle = '#F2ECFF'; ctx.font = F1(12); ctx.textAlign = 'left'; ctx.fillText(hero.n, 70, y + 22)
    /* HP 条（P0 数值） */
    ctx.fillStyle = '#0D0618'; roundRect(70, y + 28, 96, 10, 5); ctx.fill()
    ctx.fillStyle = h.hp > 8 ? '#6FE87C' : '#E85D3D'; roundRect(70, y + 28, Math.max(0, 96 * h.hp / 24), 10, 5); ctx.fill()
    ctx.fillStyle = '#F2ECFF'; ctx.font = F0(13); ctx.fillText(h.hp + '/24', 172, y + 38)
    /* 法力晶体（点亮=manaCur） */
    for (let i = 0; i < 8; i++) { ctx.fillStyle = i < h.mana ? '#6B8CF5' : '#2A1B4A'; ctx.beginPath(); ctx.arc(214 + i * 13, y + 33, 4.5, 0, Math.PI * 2); ctx.fill() }
    ctx.fillStyle = '#B9A8E8'; ctx.font = F0(13); ctx.textAlign = 'right'; ctx.fillText(h.mana + '/' + h.manaMax, W - 14, y + 38)
    /* 牌库/手牌数/疲劳/托管徽标 */
    ctx.font = F1(11); ctx.fillStyle = '#9C8CC8'
    ctx.fillText(`牌库 ${h.deckN}  手牌 ${typeof v.hand[seat] === 'object' && !Array.isArray(v.hand[seat]) ? v.hand[seat].n : v.hand[seat].length}  坟场 ${h.grave.length}${h.fatigue ? '  疲劳' + h.fatigue : ''}`, W - 14, y + 18)
    if (v.host[seat]) { ctx.fillStyle = '#9D6BE8'; ctx.font = F1(11); ctx.fillText('托管', 70, y + 50) }
    if (isFoe && v.phase === 'play' && faceDamage() >= h.hp) { /* 可斩杀角标（§3.2） */
      ctx.strokeStyle = `rgba(232,93,61,${0.55 + 0.35 * Math.sin(performance.now() / 200)})`; ctx.lineWidth = 3; roundRect(14, y + 7, 50, 50, 8); ctx.stroke()
      ctx.fillStyle = '#E85D3D'; ctx.font = F1(11); ctx.textAlign = 'left'; ctx.fillText('可斩杀', 70, y + 60)
    }
    ctx.restore()
  }
  function drawMinion(m, x, y, w, h, mine) {
    const col = m.seat === 0 ? COL_A : COL_B
    ctx.save()
    ctx.fillStyle = '#2A1B4A'; roundRect(x, y, w, h, 7); ctx.fill()
    ctx.lineWidth = mine ? 2.5 : 1.2 // 己方实心粗描边/对方双线细描边（§7 形状第二通道）
    ctx.strokeStyle = col; roundRect(x, y, w, h, 7); ctx.stroke()
    if (!mine) { ctx.lineWidth = 0.8; roundRect(x + 3, y + 3, w - 6, h - 6, 5); ctx.stroke() }
    ctx.fillStyle = SC[m.school] || '#888'; ctx.fillRect(x, y, w, 5) // 系色顶带
    glyph(SG[m.school] || '▲', x + 13, y + h / 2 + 3, 15, SC[m.school] || '#888')
    const card = CARDS[m.c] || { n: m.c }
    ctx.fillStyle = '#EDE6FF'; ctx.font = F1(11); ctx.textAlign = 'left'; ctx.fillText(card.n, x + 24, y + 21)
    if (m.taunt) { ctx.fillStyle = '#9D6BE8'; ctx.font = F1(11); ctx.fillText('嘲', x + w - 14, y + 21) }
    if (m.frozen > 0) { ctx.fillStyle = 'rgba(61,168,232,0.35)'; roundRect(x, y, w, h, 7); ctx.fill(); ctx.fillStyle = '#BFE6FF'; ctx.font = F1(11); ctx.fillText('冻', x + w - 26, y + 21) }
    ctx.fillStyle = '#F2ECFF'; ctx.font = F0(14)
    ctx.fillText(String(m.atk), x + 12, y + h - 8)
    ctx.fillText(String(m.hp), x + w - 18, y + h - 8)
    ctx.strokeStyle = '#7CE8B8'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x + 6, y + h - 6); ctx.lineTo(x + 20, y + h - 6); ctx.stroke()
    if (mine && m.ready && !m.frozen && S.view.turn === rs() && S.view.phase === 'play') { ctx.strokeStyle = `rgba(124,232,184,${0.4 + 0.3 * Math.sin(performance.now() / 220)})`; ctx.lineWidth = 1.5; roundRect(x + 1.5, y + 1.5, w - 3, h - 3, 6); ctx.stroke() }
    ctx.restore()
  }
  function drawCard(id, x, y, sel) {
    const d = CARDS[id]
    ctx.save()
    ctx.fillStyle = '#231543'; roundRect(x, y, 78, 108, 8); ctx.fill()
    ctx.strokeStyle = sel ? '#F2ECFF' : (d.s ? SC[d.s] : '#55447A'); ctx.lineWidth = sel ? 2.5 : 1.5; roundRect(x, y, 78, 108, 8); ctx.stroke()
    ctx.fillStyle = SC[d.s]; ctx.beginPath(); ctx.arc(x + 14, y + 14, 10, 0, Math.PI * 2); ctx.fill() // 费用宝石
    ctx.fillStyle = '#170D2E'; ctx.font = F0(14); ctx.textAlign = 'center'; ctx.fillText(String(d.c), x + 14, y + 19)
    glyph(SG[d.s], x + 39, y + 48, 34, SC[d.s]) // 元素字形大图标
    ctx.fillStyle = '#EDE6FF'; ctx.font = F1(11); ctx.fillText(d.n, x + 39, y + 78)
    if (d.sp) { ctx.fillStyle = '#B9A8E8'; ctx.font = F1(11) } else ctx.font = F0(14)
    ctx.fillStyle = d.sp ? '#B9A8E8' : '#F2ECFF'
    if (d.sp) { /* 法术关键词两行封顶（§7） */ const words = (d.d || '').split(''); ctx.fillText(words.slice(0, 8).join(''), x + 39, y + 92); ctx.fillText(words.slice(8, 16).join(''), x + 39, y + 104) }
    else { ctx.fillText(d.a + '/' + d.h, x + 39, y + 98); ctx.fillStyle = '#9C8CC8'; ctx.font = F1(11); ctx.fillText(d.kw || '', x + 39, y + 79) }
    ctx.restore()
  }
  function render() {
    const now = performance.now()
    ctx.fillStyle = '#1E1030'; ctx.fillRect(0, 0, W, H)
    if (!S.view) { ctx.fillStyle = '#B9A8E8'; ctx.font = F1(12); ctx.textAlign = 'center'; ctx.fillText(S.connLost ? '连接断开·点击重连' : '连接网关…', W / 2, H / 2); requestAnimationFrame(render); return }
    const v = S.view
    /* 顶栏（对方英雄）/ 己方英雄栏（§7 布局：62+196+62+132+66） */
    heroBar(6, oppSeat(), true)
    ctx.fillStyle = '#9C8CC8'; ctx.font = F2(9); ctx.textAlign = 'center'
    const turnSec = Math.max(0, Math.ceil((S.deadlineAt - now) / 1000))
    ctx.fillText(`${S.spectator ? '观战 · ' : ''}${v.phase === 'play' ? (S.spectator ? '玩家' + (v.turn === 0 ? 'A' : 'B') + ' 行动 · ' : v.turn === S.seat ? '你的回合 · ' : '对方回合 · ') + turnSec + 's' : v.phase === 'pick' ? '选择英雄 · ' + turnSec + 's' : v.phase === 'mulligan' ? '换牌 · ' + turnSec + 's' : '对局结束'}  ·  第 ${Math.max(1, Math.ceil((v.turnNo + 1) / 2))} 回合`, W / 2, 108)
    /* 棋盘 3×3（发光格） */
    for (let c = 0; c < 9; c++) {
      const p = cellXY(c)
      const glow = S.sel && S.sel.mode === 'card' && legalCells(S.sel.card).includes(c)
      const dragGlow = S.drag != null && legalCells(S.drag.card).includes(c) && c === S.hoverCell
      ctx.fillStyle = glow || dragGlow ? '#3A2A6A' : '#2A1B4A'
      roundRect(p.x, p.y, BOARD.cellW, BOARD.cellH, 7); ctx.fill()
      ctx.strokeStyle = dragGlow ? `rgba(242,236,255,${0.5 + 0.4 * Math.sin(now / 160)})` : '#453178'; ctx.lineWidth = dragGlow ? 2 : 1
      roundRect(p.x, p.y, BOARD.cellW, BOARD.cellH, 7); ctx.stroke()
      if (dragGlow && S.drag != null) { /* 反应预览色环（§3.2）：悬停格+将触发反应邻格 */
        const id = myViewHand()[S.drag.card]
        for (const n of previewReactions(c, id)) { const q = cellXY(n); ctx.strokeStyle = SC[CARDS[id].s]; ctx.lineWidth = 3; roundRect(q.x + 2, q.y + 2, BOARD.cellW - 4, BOARD.cellH - 4, 6); ctx.stroke() }
      }
      const m = v.board[c]
      if (m) drawMinion(m, p.x, p.y, BOARD.cellW, BOARD.cellH, m.seat === rs())
    }
    /* 攻击指示线（§3.2）+ 合法目标高亮 */
    if (S.sel && S.sel.mode === 'atk') {
      const p = cellXY(S.sel.from)
      for (const c of atkTargets(S.sel.from)) {
        ctx.setLineDash([4, 4]); ctx.strokeStyle = '#E8A33D'; ctx.lineWidth = 1.5
        const q = c === -1 ? { x: W / 2, y: 52 } : (() => { const z = cellXY(c); return { x: z.x + BOARD.cellW / 2, y: z.y + BOARD.cellH / 2 } })()
        ctx.beginPath(); ctx.moveTo(p.x + BOARD.cellW / 2, p.y + BOARD.cellH / 2); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([])
        if (c === -1) { ctx.strokeStyle = '#E85D3D'; ctx.lineWidth = 2; roundRect(60, 8, W - 120, 54, 10); ctx.stroke() }
      }
    }
    if (S.sel && S.sel.mode === 'card' && !CARDS[myViewHand()[S.sel.card]].sp) for (const c of legalCells(S.sel.card)) { const p = cellXY(c); ctx.fillStyle = 'rgba(124,232,184,0.10)'; roundRect(p.x, p.y, BOARD.cellW, BOARD.cellH, 7); ctx.fill() }
    if (S.sel && (S.sel.mode === 'card' ? CARDS[myViewHand()[S.sel.card]].sp : S.sel.mode === 'power')) {
      const ts = S.sel.mode === 'power' ? powerTargets() : spellTargets(S.sel.card)
      for (const t of ts) {
        if (t.tgt && t.tgt.c >= 0) { const p = cellXY(t.tgt.c); ctx.fillStyle = 'rgba(232,163,61,0.12)'; roundRect(p.x, p.y, BOARD.cellW, BOARD.cellH, 7); ctx.fill() }
        if (t.tgt && t.tgt.row !== undefined) { ctx.fillStyle = 'rgba(232,163,61,0.10)'; ctx.fillRect(BOARD.x, BOARD.y + t.tgt.row * (BOARD.cellH + BOARD.gap), BOARD.cellW * 3 + BOARD.gap * 2, BOARD.cellH) }
        if (!t.tgt) { ctx.fillStyle = 'rgba(232,163,61,0.16)'; roundRect(100, 300, W - 200, 60, 10); ctx.fill(); ctx.fillStyle = '#F2ECFF'; ctx.font = F1(13); ctx.textAlign = 'center'; ctx.fillText('点击施放', W / 2, 335) }
      }
    }
    heroBar(H - 66 - 132 - 66, rs(), false)
    /* 手牌扇（迷雾：对方视角只见张数——此处恒为本人视图牌面） */
    const hand = myViewHand()
    for (let i = 0; i < hand.length; i++) { const r = handRect(i); if (S.drag && S.drag.card === i) continue; drawCard(hand[i], r.x, r.y, S.sel && S.sel.mode === 'card' && S.sel.card === i) }
    /* 对方手牌（背面张数，顶栏下缘） */
    const oh = v.hand[oppSeat()]
    const on = Array.isArray(oh) ? oh.length : oh.n
    for (let i = 0; i < on; i++) { const bx = W / 2 - (on * 20) / 2 + i * 20 + 2; ctx.fillStyle = '#2A1B4A'; roundRect(bx, 76, 16, 22, 3); ctx.fill(); ctx.strokeStyle = COL_B; ctx.lineWidth = 0.8; roundRect(bx, 76, 16, 22, 3); ctx.stroke() }
    /* 拖牌幽灵（本地 0ms 待裁决，§3.1） */
    if (S.drag != null) { ctx.globalAlpha = 0.72; drawCard(myViewHand()[S.drag.card], S.drag.x - 39, S.drag.y - 54, true); ctx.globalAlpha = 1 }
    /* 底栏：托管 40×48 ｜ 技能 56×48 ｜ 结束回合 108×48 */
    const barY = H - 58
    const myTurn = !S.spectator && v.turn === S.seat && v.phase === 'play'
    const secLeft = (S.deadlineAt - now) / 1000
    const btn = (x, w2, label, active, danger) => {
      ctx.fillStyle = active ? '#4A3380' : '#2A1B4A'; roundRect(x, barY, w2, 48, 8); ctx.fill()
      ctx.strokeStyle = danger ? `rgba(232,93,61,${0.5 + 0.5 * Math.sin(now / 120)})` : active ? '#B9A8E8' : '#55447A'; ctx.lineWidth = danger ? 2.5 : 1.5
      roundRect(x, barY, w2, 48, 8); ctx.stroke()
      ctx.fillStyle = danger ? '#FF9D85' : '#EDE6FF'; ctx.font = F1(12); ctx.textAlign = 'center'; ctx.fillText(label, x + w2 / 2, barY + 28)
    }
    btn(14, 40, v.host[rs()] ? '夺回' : '托管', v.host[rs()], false)
    const hero = v.heroes[rs()]
    const canPower = myTurn && !hero.powerUsed && hero.mana >= 2
    btn(66, 56, canPower ? '技能' : '技能·' + (hero.powerUsed ? '已用' : '2费'), canPower && !(S.sel && S.sel.mode === 'power'), false)
    btn(252, 108, '结束回合', myTurn, myTurn && secLeft < 5)
    if (S.sel && S.sel.mode === 'power') { ctx.fillStyle = '#F2ECFF'; ctx.font = F1(11); ctx.textAlign = 'center'; ctx.fillText(HEROES[hero.hero] ? HEROES[hero.hero].p : '', 130, barY + 28) }
    /* 浮层：选英雄 */
    if (v.phase === 'pick' && v.heroes[rs()].hero < 0) {
      ctx.fillStyle = 'rgba(13,6,24,0.92)'; ctx.fillRect(0, 120, W, H - 120)
      ctx.fillStyle = '#F2ECFF'; ctx.font = F1(14); ctx.textAlign = 'center'; ctx.fillText('选择英雄（10s 超时随机）', W / 2, 142)
      for (let hI = 0; hI < 4; hI++) {
        const r = { x: 18 + (hI % 2) * 176, y: 150 + ((hI / 2) | 0) * 190, w: 162, h: 176 }
        const hh = HEROES[hI]
        ctx.fillStyle = '#231543'; roundRect(r.x, r.y, r.w, r.h, 10); ctx.fill()
        ctx.strokeStyle = SC[hh.s]; ctx.lineWidth = 2; roundRect(r.x, r.y, r.w, r.h, 10); ctx.stroke()
        glyph(SG[hh.s], r.x + r.w / 2, r.y + 46, 44, SC[hh.s])
        ctx.fillStyle = '#F2ECFF'; ctx.font = F1(14); ctx.fillText(hh.n, r.x + r.w / 2, r.y + 92)
        ctx.fillStyle = '#B9A8E8'; ctx.font = F1(11); ctx.fillText('技能：' + hh.p, r.x + r.w / 2, r.y + 118)
        ctx.fillText('被动：' + hh.b, r.x + r.w / 2, r.y + 136)
        const deck = ['炎阳烬火·打脸抢血', '潮汐深涌·墙回复运营', '疾风掠地·满铺速攻', '雷鸣苍穹·法术链清场'][hI]
        ctx.fillStyle = '#9C8CC8'; ctx.fillText(deck, r.x + r.w / 2, r.y + 158)
      }
    }
    /* 浮层：换牌（观战双隐藏——显示观战条，无 keep 交互） */
    if (v.phase === 'mulligan' && S.spectator) {
      ctx.fillStyle = 'rgba(13,6,24,0.88)'; ctx.fillRect(0, 118, W, 96)
      ctx.fillStyle = '#B9A8E8'; ctx.font = F1(14); ctx.textAlign = 'center'
      ctx.fillText('观战中 · 双方换牌（手牌隐藏）', W / 2, 170)
    }
    if (v.phase === 'mulligan' && !v.mullDoneByMe && !S.spectator) {
      const keep = S.mullKeep || (S.mullKeep = hand.map(() => true))
      ctx.fillStyle = 'rgba(13,6,24,0.88)'; ctx.fillRect(0, 118, W, H - 118)
      ctx.fillStyle = '#F2ECFF'; ctx.font = F1(14); ctx.textAlign = 'center'; ctx.fillText('换牌：点选保留（30s 全保留）', W / 2, 144)
      for (let i = 0; i < hand.length; i++) { const r = handRect(i); drawCard(hand[i], r.x, r.y - 10, keep[i]); if (keep[i]) { ctx.strokeStyle = '#7CE8B8'; ctx.lineWidth = 2.5; roundRect(r.x, r.y - 10, 78, 108, 8); ctx.stroke(); ctx.fillStyle = '#7CE8B8'; ctx.font = F1(11); ctx.fillText('保留', r.x + 39, r.y + 108) } }
      ctx.fillStyle = '#4A3380'; roundRect(W / 2 - 80, H - 92, 160, 52, 10); ctx.fill()
      ctx.strokeStyle = '#B9A8E8'; ctx.lineWidth = 2; roundRect(W / 2 - 80, H - 92, 160, 52, 10); ctx.stroke()
      ctx.fillStyle = '#F2ECFF'; ctx.font = F1(14); ctx.fillText(`确认（保留 ${keep.filter(Boolean).length} 张）`, W / 2, H - 60)
    }
    /* fx：伤害/治疗飘字（400ms 非阻塞，§3.1） */
    S.fx = S.fx.filter((f) => now - f.t0 < 700)
    for (const f of S.fx) {
      const t = (now - f.t0) / 700
      ctx.globalAlpha = 1 - t
      ctx.fillStyle = f.k === 'damage' ? '#FF6B4A' : f.k === 'heal' ? '#6FE87C' : '#FFD37A'
      ctx.font = f.k === 'reject' ? F1(13) : F0(20); ctx.textAlign = 'center'
      ctx.fillText(f.k === 'damage' ? '-' + f.n : f.k === 'heal' ? '+' + f.n : '非法操作', f.x, f.y - 28 * t)
      ctx.globalAlpha = 1
    }
    /* 横幅（反应/回合切换，500ms 非阻塞） */
    S.banners = S.banners.filter((b) => now - b.t0 < 900)
    S.banners.forEach((b, i) => {
      const t = (now - b.t0) / 900
      ctx.globalAlpha = t < 0.8 ? 1 : (1 - t) / 0.2
      ctx.fillStyle = b.sys ? 'rgba(30,16,48,0.92)' : 'rgba(13,6,24,0.85)'
      ctx.fillRect(0, 210 + i * 44, W, 40)
      const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, b.c1); g.addColorStop(1, b.c2 || b.c1)
      ctx.fillStyle = g; ctx.fillRect(0, 210 + i * 44, W, 3)
      ctx.fillStyle = '#F2ECFF'; ctx.font = F1(14); ctx.textAlign = 'center'; ctx.fillText(b.txt, W / 2, 236 + i * 44)
      ctx.globalAlpha = 1
    })
    if (S.err) { ctx.fillStyle = '#FF6B4A'; ctx.font = F1(11); ctx.textAlign = 'center'; ctx.fillText('✕ ' + S.err, W / 2, 116) }
    /* 结算页（§7）：胜负大字+战报条+评语+再来一局 */
    if (S.over && S.result) {
      const r = S.result
      const meWin = r.winner === (rs() === 0 ? 'A' : 'B')
      const verdict = r.winner === 'draw' ? '平局' : S.spectator ? '玩家' + r.winner + ' 胜利' : meWin ? '胜利' : '败北'
      ctx.fillStyle = 'rgba(13,6,24,0.95)'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = r.winner === 'draw' ? '#B9A8E8' : r.winner === 'A' ? COL_A : COL_B
      ctx.font = F0(34); ctx.textAlign = 'center'; ctx.fillText(verdict, W / 2, 150)
      ctx.font = F1(12); ctx.fillStyle = '#9C8CC8'; ctx.fillText('reason: ' + r.reason, W / 2, 176)
      const sc = r.scores || {}
      ctx.fillStyle = '#EDE6FF'; ctx.font = F1(12)
      const row = (y, k, f) => { const a = (sc.A || {})[k], b = (sc.B || {})[k]; ctx.fillText(f(a) + '  ·  ' + k, W / 2, y); void b }
      row(230, 'hp', (x) => 'HP ' + (x == null ? '-' : x)); row(254, 'reactions', (x) => '反应 ' + (x == null ? '-' : x)); row(278, 'fatigue', (x) => '疲劳 ' + (x == null ? '-' : x))
      if (r.quip) { ctx.fillStyle = '#B9A8E8'; ctx.font = F1(13); ctx.fillText('「' + r.quip + '」', W / 2, 340) }
      /* reveal 战报回看（§5.3 终局全披露） */
      if (S.reveal) { ctx.fillStyle = '#9C8CC8'; ctx.font = F1(11); ctx.fillText('双方手牌已披露（战报审阅）', W / 2, 376); const h0 = S.reveal[0] || [], h1 = S.reveal[1] || []; ctx.fillText('A 手牌: ' + (h0.join(' ') || '—'), W / 2, 398); ctx.fillText('B 手牌: ' + (h1.join(' ') || '—'), W / 2, 418) }
      ctx.fillStyle = '#4A3380'; roundRect(40, H - 130, 130, 56, 10); ctx.fill()
      ctx.strokeStyle = COL_A; ctx.lineWidth = 2; roundRect(40, H - 130, 130, 56, 10); ctx.stroke()
      ctx.fillStyle = '#F2ECFF'; ctx.font = F1(14); ctx.fillText('再来一局', 105, H - 96)
      ctx.fillStyle = '#2A1B4A'; roundRect(205, H - 130, 130, 56, 10); ctx.fill()
      ctx.strokeStyle = COL_B; ctx.lineWidth = 2; roundRect(205, H - 130, 130, 56, 10); ctx.stroke()
      ctx.fillStyle = '#F2ECFF'; ctx.fillText('回大厅', 270, H - 96)
    }
    /* 页脚 P2 */
    ctx.fillStyle = '#6A5A9C'; ctx.font = F2(9); ctx.textAlign = 'left'; ctx.fillText('element-duel · v1.0.0 · S5', 10, H - 6)
    requestAnimationFrame(render)
  }

  /* ---------- 离线对打（F3：?debug=1 / 门禁契约；同 sim 同 brain——零网关本地 1v1） ---------- */
  let ost = null, otimer = null, opaused = false, osalt = 0
  const SIM = window.EDuelSim
  function offlineDrain() { // 引擎裁决队列 → ruling 形消息（走同一 onMsg 渲染路径）
    if (!ost) return
    const payloads = ost.outbox.splice(0, ost.outbox.length)
    for (const p of payloads) onMsg({ t: 'ruling', state: SIM.viewFor(ost, 0), events: p })
    if (ost.over) { onMsg({ t: 'end', result: ost.result }); clearInterval(otimer); otimer = null }
  }
  function offlineApply(op) { // 真人席 0：同一 applyOp 权威入口
    if (!ost || ost.over) return
    const res = SIM.applyOp(ost, 0, op)
    if (res && res.reject) { onMsg({ t: 'ruling', state: SIM.viewFor(ost, 0), events: [{ k: 'reject', why: res.reject, seat: 0 }] }) }
    offlineDrain()
  }
  function offlineStart(level, opts) {
    if (!SIM) return
    if (S.conn) { try { S.conn.onclose = null; S.conn.onerror = null; S.conn.close() } catch {} S.conn = null }
    if (otimer) { clearInterval(otimer); otimer = null }
    S.offline = true; S.spectator = false; S.seat = 0; S.over = false; S.result = null; S.reveal = null
    S.sel = null; S.drag = null; S.mullKeep = null; S.fx = []; S.banners = []; S.err = ''; S.connLost = false
    S.offlineLevel = ['casual', 'balanced', 'competitive'][Math.max(0, Math.min(2, (Number(level) || 1) - 1))] || 'balanced'
    osalt++
    ost = SIM.create(SIM.fnv1a32('offline-' + (((opts && opts.seedSalt) || '') + osalt)))
    onMsg({ t: 'welcome', roomId: 'offline', role: 'player', seat: 0, room: { seats: [{ kind: 'human', name: '你' }, { kind: 'bot', level: S.offlineLevel }] }, state: SIM.viewFor(ost, 0) })
    report('start', { mode: 'offline', level: S.offlineLevel, seed: ost.seed })
    otimer = setInterval(() => { // 20ms×2 tick ≈ 实时（tickMs=10）；bot=brain 席 1，真人 op 走 sendOp→offlineApply
      if (opaused || !ost || ost.over) return
      for (let i = 0; i < 2 && ost && !ost.over; i++) {
        const inputs = {}
        const b = SIM.brain(ost, 1, S.offlineLevel)
        if (b && b.op) inputs[1] = b
        SIM.step(ost, inputs)
        offlineDrain()
      }
    }, 20)
  }

  /* ---------- HUD 自证 + 暴露 ---------- */
  window.__GAMES_DEBUG__ = window.__GAMES_DEBUG__ || {}
  window.__GAMES_DEBUG__.hudFonts = function () { const out = {}; for (const k in HUDF) out[k] = { minPx: HUDF[k].minPx, samples: HUDF[k].n }; return out }
  window.__GAMES_DEBUG__.state = () => ({ view: S.view, seat: S.seat, roster: S.roster, result: S.result, offline: S.offline, over: ost ? ost.over : S.over })
  window.__GAMES_DEBUG__.sendOp = sendOp
  window.__GAMES_DEBUG__.events = dbgEvents                                   // F3：perf-smoke/visual-check 消费（boot/start）
  window.__GAMES_DEBUG__.start = function (level, opts) { offlineStart(level || 1, opts) } // 离线重开一局
  window.__GAMES_DEBUG__.pause = function (on) { opaused = !!on }             // visual-check 截图冻结演化（rAF 照跑）
  window.__GAMES_DEBUG__.roomId = function () { return S.roomId }
  window.__GAMES_DEBUG__.seat = function () { return S.seat }
  window.__GAMES_DEBUG__.mode = function () { return S.offline ? 'offline' : 'net' }

  report('boot', { slug: 'element-duel', version: '1.0.0', mode: q.get('debug') === '1' ? 'offline' : 'net' })
  if (q.get('debug') === '1' && SIM) offlineStart(1) // 门禁口径：零网关本地对打（同 pool/emp 先例）
  else connect()
  requestAnimationFrame(render)
})()
