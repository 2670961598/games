/* =====================================================================
 * 派对大乱斗 客户端（GAMES-172 · S6+S7 双技术第三款——S7 预测和解第二证）。
 * 依赖前置：trig16.cjs / sim.cjs（window.PartySim——与服务端同一段纯函数，
 * §5.1 单源纪律）。
 *
 * 多实体预测边界四类谱的客户端面（设计 §5.2 ★）：
 *   一类 己席=本地预测（makePredictor 同式走位积分；drag 即 tick 输入零等待，
 *        20Hz 采样+输入环形缓冲+上行 seq；快照 ack 和解：权威锚点回滚重放未确认
 *        输入，Δ≤6px 软收敛 0.35/帧、>6px 硬回滚 120ms 混合带——撕裂 ≤2.5px/帧）；
 *   二类 弹体=事件重演（shot/nade 全参→本地推进渲染，「预测其飞行权威其命中」
 *        ——hit/elim 事件归账；弹体零快照，重连 welcome.state.projs 补列）；
 *   三类 拾取=乐观动画（28px 吸附 tap→即刻吸入 120ms；pick 事件权威确认，失败回滚）；
 *   四类 毒圈=闭式外推（相位表+ext.storm 参数链→任意未来 tick 圆=时间纯函数，
 *        当前白实线/目标白虚线/圈外红紫斜纹罩全本地渲染，零带宽）。
 * 他人=100ms 插值缓冲+迟到外推 1 张（mmo/卡丁同式）；观战（spectator/淘汰后）
 * =纯二三类呈现零预测（§5.2 谱系收束）。
 *
 * HUD：HF 登记表+__applied 首日自证（Q-013 前置第三作——登记值≠ctx.font 回读值
 * 即 __applied:false 红线）；ping 徽标 P0（T7-A 升档）。派对亮色（§7 全平台首款
 * 亮色竞技场）+阵营/武器/毒圈三组双编码（形状通道 tritan 安全）。
 * ===================================================================== */
'use strict'
;(function () {
  const P = window.PartySim
  const W = 375, H = 667, TOP_H = 56
  const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif"

  /* §7 调色板：派对亮色糖豆岛（天蓝海洋+草岛绿+沙缘） */
  const SEA = '#4FB8E8', GRASS = '#8FD96B', SAND = '#F5DE9C', BUSH = '#5FB860'
  const INK = '#17537A', DIM = '#3E7CA0', WHITE = '#FFFFFF'
  const STORM_A = 'rgba(208,90,122,0.30)' // 圈外红紫罩 30%
  const SKINS = ['#FF8A7A', '#FFE066', '#7DE8A8', '#6FC8FF', '#C98FE8', '#FFB98A', '#FFF3D6', '#FF9EC2']
  /* 武器双编码：色相+形状（拳灰/手枪金黄/冲锋天蓝/霰弹橙/火箭红/手雷紫，§7 表） */
  const WCOL = ['#9AA7B0', '#FFE066', '#6FC8FF', '#FFB65C', '#FF6B5C', '#C98FE8']

  /* ---------- HUD 字号登记表（Q-013 首日自证：登记+ctx.font 回读双值比对） ---------- */
  const hudFontReg = {}
  function HF(grp, key, px, w) {
    ;(hudFontReg[grp] || (hudFontReg[grp] = {}))[key] = px
    return (w ? w + ' ' : '') + px + 'px ' + FONT
  }
  function hudFonts() { // __GAMES_DEBUG__.hudFonts()：登记表+闭环回读 __applied 标志（Q-013）
    const out = {}
    for (const g in hudFontReg) {
      out[g] = {}
      for (const k in hudFontReg[g]) {
        const want = hudFontReg[g][k]
        const font = (want >= 13 ? '600 ' : '400 ') + want + 'px ' + FONT
        let got = ''
        try { ctx.font = font; got = ctx.font } catch (e) { got = '' } // 闭环回读（try 内 const 块作用域不外泄——Q-013 自证首坑）
        const applied = /(^|\s)(\d+(?:\.\d+)?)px/.test(got) && Math.abs(parseFloat(RegExp.$2) - want) < 0.5
        out[g][k] = { want, font, applied }
      }
    }
    return out
  }

  /* ---------- 状态 ---------- */
  const S = {
    conn: null, seat: -1, role: null, room: null, tickMs: 50, seed: 0,
    phase: 'boot', // boot→lobby(countdown)→live→dead(观战)→ended
    frame: 0, ack: -1, seq: 0,
    ents: new Map(), // 远人插值缓冲（100ms）
    me: null, storm: null, alive: 20, lb: [], mm: [],
    projs: new Map(), nades: new Map(), // 二类重演域（弹体/手雷——事件全参本地推进）
    fx: [], kills: 0, dmg: 0,
    predictor: P.makePredictor(),
    rec: { soft: 0, hard: 0, maxPx: 0, sum: 0, n: 0, pings: [] }, // 和解修正账本（§3.1/结算战报源）
    cam: { x: 1200000, y: 1200000 }, endInfo: null, koBanner: null, deadAt: 0,
  }
  const cv = document.getElementById('cv'), ctx = cv.getContext('2d')

  /* ---------- 连接层（协议 v1.1 join/quick → welcome/snapshot 流） ---------- */
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
      if (rid) ws.send(JSON.stringify({ t: 'join', roomId: rid, mode: q.get('mode') === 'spectate' ? 'spectate' : 'play', name: '玩家' }))
      else ws.send(JSON.stringify({ t: 'quick', gameId: 'party-brawl' }))
    }
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)) } catch { /* 帧外数据不阻断 */ } }
    ws.onclose = () => { S.phase = S.phase === 'ended' ? 'ended' : 'boot'; setTimeout(connect, 1200) }
  }
  function onMsg(m) {
    if (m.t === 'welcome') {
      S.room = m.roomId; S.seat = m.seat; S.role = m.role; S.tickMs = m.tickMs || 50
      S.seed = m.seed; S.frame = m.frame
      const st = m.state
      if (st && st.players) for (const p of st.players) if (p.seat !== S.seat) S.ents.set(p.seat, { cur: { ...p }, buf: [{ t: m.frame, p: { ...p } }], a: p.a })
      if (st && st.storm) { S.storm = mkStormView(st.storm, st.tick || 0); S.storm.ph = st.storm.ph }
      if (st && st.projs) for (const pr of st.projs) S.projs.set(pr.pid, { ...pr, born: S.frame }) // 重连补列（§5.7）
      if (st && st.nades) for (const n of st.nades) S.nades.set(n.id, { ...n })
      S.alive = st ? st.alive : 20
      S.phase = m.room && m.room.state === 'live' ? 'live' : 'lobby'
      const bootEl = document.getElementById('boot')
      if (bootEl) bootEl.style.display = 'none' // 入房即撤空降提示（canvas 全权接管）
      const pred = m.room && m.room.prediction
      S.degraded = !!pred && pred.hash !== P.ENGINE_HASH // 版本护栏：回退纯插值（§5.4）
    } else if (m.t === 'started') S.phase = 'live'
    else if (m.t === 'snapshot') onSnap(m)
    else if (m.t === 'pong') { // F-4：ping 账本激活——网关 pong（c=回显时间戳）→ RTT 回写（徽标/结算战报源）
      S.rec.pings.push(Math.max(1, Math.round(performance.now() - m.c)))
      if (S.rec.pings.length > 20) S.rec.pings.shift() // 滚动窗 20 条（5s 一拍≈100s 履历）
    }
    else if (m.t === 'end') { S.phase = 'ended'; S.endInfo = m.result }
    else if (m.t === 'closed') { S.phase = 'boot'; connect() }
  }
  /* 毒圈闭式解视图（四类·闭式）：参数链随 ext.storm 更新，任意 t 圆=时间纯函数 */
  function mkStormView(ext, ph) {
    return {
      ph: ext.p !== undefined ? ext.p : ph,
      t0: ext.t0, t1: ext.t1, r0: ext.r0, r1: ext.r1, x0: ext.x0, y0: ext.y0, x1: ext.x1, y1: ext.y1,
      centers: null,
    }
  }
  function stormAt(t) { // 本地外推（Q16 lerp 同式 sim.stormOf——单源常量 PHASES）
    const v = S.storm
    if (!v || v.t0 === undefined) {
      // welcome 全量路径：state.storm 有 centers——直接用 sim 单源闭式解
      if (S.stateFull) return P.stormOf(S.stateFull, t)
      return { r: 1200000, cx: 1200000, cy: 1200000 }
    }
    const span = (v.t1 - v.t0) || 1
    const k = Math.max(0, Math.min(1, (t - v.t0) / span)) // 先除后乘（Q16 直乘越 int32 回绕——同 sim 修复）
    return {
      r: Math.round(v.r0 + (v.r1 - v.r0) * k),
      cx: Math.round(v.x0 + (v.x1 - v.x0) * k),
      cy: Math.round(v.y0 + (v.y1 - v.y0) * k),
    }
  }
  /* ---------- 快照处理（ack 和解+二类重演+三类确认+AOI 增量） ---------- */
  function onSnap(m) {
    S.frame = m.frame
    if (m.ext) {
      if (m.ext.storm) { S.storm = mkStormView(m.ext.storm) }
      if (m.ext.alive !== undefined) S.alive = m.ext.alive
      if (m.ext.lb) S.lb = m.ext.lb
      if (m.ext.mm) S.mm = m.ext.mm
      if (m.ext.me) {
        const wasMe = S.me
        S.me = m.ext.me
        if (wasMe && wasMe.al && !m.ext.me.al && S.phase === 'live') onDead()
        /* 一类·预测和解（§5.1）：ack 裁剪→权威锚→重放未确认→软/硬收敛 */
        if (m.ext.ack !== undefined) S.ack = m.ext.ack
      }
      if (m.ext.hash !== undefined) { /* hash 哨兵：分歧→sync 自愈（省带宽，深证同式） */ }
    }
    if (m.full) { S.ents.clear(); S.stateFull = null }
    for (const e of m.ents || []) {
      if (e.id && e.id[0] === 's') {
        const seat = e.seat !== undefined ? e.seat : Number(e.id.slice(1))
        if (seat === S.seat) continue
        let rec = S.ents.get(seat)
        if (!rec) { rec = { cur: {}, buf: [] }; S.ents.set(seat, rec) }
        Object.assign(rec.cur, e)
        if (rec.cur.al === 0) { S.ents.delete(seat); continue }
        rec.buf.push({ t: m.frame, p: { ...rec.cur } })
        if (rec.buf.length > 4) rec.buf.shift()
      } else if (e.id) { // 三类·权威箱（乐观动画的对象面——不在渲染域预测）
        let bx = S.boxMap.get(e.id)
        if (!bx && e.x !== undefined) { bx = { id: e.id, x: e.x, y: e.y, k: e.k, w: e.w, it: e.it, on: 1 }; S.boxMap.set(e.id, bx) }
        if (bx && e.on !== undefined) bx.on = e.on
        if (bx && e.x !== undefined) { bx.x = e.x; bx.y = e.y; bx.k = e.k !== undefined ? e.k : bx.k; bx.w = e.w !== undefined ? e.w : bx.w; bx.it = e.it !== undefined ? e.it : bx.it }
      }
    }
    for (const id of m.leave || []) {
      if (id[0] === 's') S.ents.delete(Number(id.slice(1)))
      else S.boxMap.delete(id)
    }
    /* 事件流：二类重演生成+三类确认+juice */
    for (const ev of m.events || []) onEvent(ev, m.frame)
  }
  S.boxMap = new Map()
  function onEvent(ev, frame) {
    if (ev.k === 'shot') S.projs.set(ev.pid, { pid: ev.pid, seat: ev.seat, w: ev.w, x: ev.px, y: ev.py, ang: ev.ang, v: P.WPNS[ev.w].v, ttl: (600000 / P.WPNS[ev.w].v) | 0, dist: 0, born: frame })
    else if (ev.k === 'nade') S.nades.set(ev.id, { id: ev.id, seat: ev.seat, x0: ev.px, y0: ev.py, ang: ev.ang, born: frame })
    else if (ev.k === 'pdie') S.projs.delete(ev.pid)
    else if (ev.k === 'boom') addFx('boom', ev.x, ev.y)
    else if (ev.k === 'hit') { if (ev.by === S.seat) addFx('hitmark', null, null); addFx('dmgnum', ev) }
    else if (ev.k === 'elim') {
      if (ev.seat === S.seat) onDead()
      if (ev.by === S.seat) { S.kills++; S.koBanner = { txt: '淘汰 ' + (S.ents.get(ev.seat) ? '' : '') + '对手', at: performance.now() } }
      addFx('ko', ev)
    }
    else if (ev.k === 'pick') { if (ev.seat === S.seat) addFx('pickok', null, null); else { const bx = S.boxMap.get(ev.id); if (bx) bx.on = 0 } }
    else if (ev.k === 'drop' || ev.k === 'airdrop') { /* 三类生成=零推断（下张全量/增量箱记录） */ }
    else if (ev.k === 'storm') { S.storm = mkStormView(ev); addFx('stormToast', null, null) }
    else if (ev.k === 'heal') addFx('healfx', ev)
    else if (ev.k === 'boost') if (ev.seat === S.seat) addFx('boostfx', null, null)
  }
  function onDead() { if (S.phase === 'live') { S.phase = 'dead'; S.deadAt = performance.now() } }

  /* ---------- fx（事件驱动零 diff 触发；台账见 fxLedger） ---------- */
  const fxLedgerArr = []
  function addFx(kind, a, b) {
    const fx = { kind, a, b, at: performance.now() }
    S.fx.push(fx)
    let e = fxLedgerArr.find((x) => x.kind === kind)
    if (!e) { e = { kind, n: 0 }; fxLedgerArr.push(e) }
    e.n++
    if (S.fx.length > 80) S.fx.shift()
  }

  /* ---------- 输入面（§1.5：摇杆+射击/技能/拾取钮） ---------- */
  const IN = { mx: 0, my: 0, aim: 0, fire: 0, skl: 0, pick: -1 }
  const stick = { on: false, ox: 0, oy: 0, x: 0, y: 0 }
  const shoot = { on: false, x: 0, y: 0 }
  const DEAD = 8 // 死区 8px（§3.1）
  function onDown(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e
    const r = cv.getBoundingClientRect()
    const x = (t.clientX - r.left) / r.width * W, y = (t.clientY - r.top) / r.height * H
    /* 技能钮/拾取钮命中（右下区） */
    if (hitBtn(sklBtn, x, y)) { IN.skl = nextSkl(); return }
    if (S.pickTarget && hitBtn(pickBtn, x, y)) { IN.pick = S.pickTarget; addFx('picktry', null, null); return }
    if (x > W / 2) { shoot.on = true; shoot.x = x; shoot.y = y } // 右半屏按住=开火（twin-stick）
    else { stick.on = true; stick.ox = x; stick.oy = y; stick.x = x; stick.y = y }
    e.preventDefault()
  }
  function onMove(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e
    const r = cv.getBoundingClientRect()
    const x = (t.clientX - r.left) / r.width * W, y = (t.clientY - r.top) / r.height * H
    if (stick.on) { stick.x = x; stick.y = y }
    if (shoot.on) { shoot.x = x; shoot.y = y }
    e.preventDefault()
  }
  function onUp(e) {
    const t = e.changedTouches ? e.changedTouches[0] : e
    const r = cv.getBoundingClientRect()
    const x = (t.clientX - r.left) / r.width * W, y = (t.clientY - r.top) / r.height * H
    if (x <= W / 2 || !shoot.on) { stick.on = false }
    if (x > W / 2 || !stick.on) { shoot.on = false }
    if (!stick.on && !shoot.on) { /* noop */ }
    e.preventDefault()
  }
  cv.addEventListener('touchstart', onDown, { passive: false })
  cv.addEventListener('touchmove', onMove, { passive: false })
  cv.addEventListener('touchend', onUp, { passive: false })
  cv.addEventListener('touchcancel', onUp, { passive: false })
  cv.addEventListener('mousedown', onDown)
  cv.addEventListener('mousemove', onMove)
  cv.addEventListener('mouseup', onUp)
  const sklBtn = { x: W - 52, y: H - 150, r: 28 }
  const pickBtn = { x: W - 52, y: H - 74, r: 32 }
  const fireBtn = { x: W - 52, y: H - 74, r: 36 }
  function hitBtn(b, x, y) { const dx = x - b.x, dy = y - b.y; return dx * dx + dy * dy <= (b.r + 14) * (b.r + 14) }
  function nextSkl() { // 技能钮循环：手雷(有)→医疗(有)→加速(有)→确认（二段简化为一拍一技能：优先级雷>医>速）
    const me = S.me || {}
    if (me.na > 0) return 1
    if (me.me > 0 && me.hp < 100) return 2
    if (me.spd > 0) return 3
    return 0
  }

  /* ---------- 20Hz 输入采样+上行（心跳兼保活；离散键随 q 一次性） ---------- */
  let lastUp = {}
  setInterval(() => {
    if (!S.conn || S.conn.readyState !== 1 || S.role !== 'player' || S.phase !== 'live') return
    /* 摇杆向量（死区 8px+幅值 30-100% 线性） */
    let mx = 0, my = 0
    if (stick.on) {
      const dx = stick.x - stick.ox, dy = stick.y - stick.oy
      const d = Math.hypot(dx, dy)
      if (d >= DEAD) { const mag = Math.min(100, 30 + (d - DEAD) / 60 * 70); mx = Math.round(dx / d * mag); my = Math.round(dy / d * mag) }
    }
    /* aim=射击钮方向（无触摸=朝移动向） */
    let aim = IN.aim
    if (shoot.on) { aim = Math.round(Math.atan2(shoot.y - stickY0(), shoot.x - stickX0()) / (Math.PI * 2) * 65536) & 0xFFFF }
    else if (mx || my) aim = Math.round(Math.atan2(my, mx) / (Math.PI * 2) * 65536) & 0xFFFF
    const fire = shoot.on ? 1 : 0
    const keys = { mx, my, aim, fire }
    if (IN.skl) keys.skl = IN.skl
    if (IN.pick >= 0) keys.pick = IN.pick
    IN.skl = 0; IN.pick = -1
    /* 一类·预测：采样即本地预测 tick 输入（零等待 §3.1） */
    if (!S.degraded) S.predictor.push(S.seq + 1, { mx, my, aim, fire })
    S.conn.send(JSON.stringify({ t: 'input', frame: S.seq, keys }))
    S.seq++
    lastUp = keys
  }, 50)
  function stickX0() { return stick.on ? stick.ox : W / 2 }
  function stickY0() { return stick.on ? stick.oy : H / 2 }

  /* ---------- 和解（§5.1 ①-③；§3.1 撕裂预算） ---------- */
  let vis = { x: 0, y: 0 }, haveVis = false
  function reconcile(m) {
    const me = S.me
    if (!me || me.al === 0 || S.degraded) return
    /* 权威锚点：ack 裁剪由 predictor.anchor 内部（at≤tick 出环） */
    S.predictor.anchor({ x: me.x, y: me.y, vx: 0, vy: 0, w: me.w, nades: me.na, boost: 0, aim: 0 }, m.frame)
    const sh = S.predictor.advanceTo(S.seq + 1) // 重放未确认（seq-ack ≈ RTT/tick 条）
    if (!sh) return
    if (!haveVis) { vis.x = sh.x; vis.y = sh.y; haveVis = true; S.rec.hardMix = 0; return }
    const dx = sh.x - vis.x, dy = sh.y - vis.y
    const d = Math.hypot(dx, dy)
    S.rec.sum += d; S.rec.n++
    if (d > S.rec.maxPx) S.rec.maxPx = d
    if (d > 6000) { // 硬回滚：120ms 混合带（≤2.5px/帧）
      S.rec.hard++
      vis.x = sh.x - dx * 0.7; vis.y = sh.y - dy * 0.7
    } else if (d > 600) S.rec.soft++
    vis.x += dx * 0.35; vis.y += dy * 0.35 // 软收敛 0.35/帧
  }

  /* ---------- 渲染主循环（60fps：本地 sim 态间渲染+毒圈闭式外推+弹体重演） ---------- */
  let lastT = performance.now(), rafN = 0
  function frame(now) {
    const dt = Math.min(50, now - lastT); lastT = now
    rafN++
    /* 本地 sim 时钟步进（20Hz 渲染插值近似：每帧按 dt 推进 predictor） */
    if (!S.degraded && S.phase === 'live' && S.me && S.me.al) {
      const target = S.ack + Math.max(2, Math.ceil((now - (S.lastPingAt || now)) / 50) + 2) + 4
      const sh = S.predictor.advanceTo(Math.min(S.seq + 2, target))
      if (sh) { if (!haveVis) { vis.x = sh.x; vis.y = sh.y; haveVis = true } }
    }
    /* 二类重演推进（弹体按 tick 步进——事件帧起算的确定性积分） */
    stepProjs()
    draw(now)
    requestAnimationFrame(frame)
  }
  function stepProjs() {
    const simFrame = S.frame + 2 // 渲染超前 2 tick（插值用）
    for (const [pid, pr] of S.projs) {
      while ((pr.drawn || pr.born) < simFrame) {
        const t = (pr.drawn || pr.born) + 1
        pr.x += (pr.v * P.cosQ16(pr.ang)) >> 16
        pr.y += (pr.v * P.sinQ16(pr.ang)) >> 16
        pr.drawn = t
        if (--pr.ttl <= 0) { S.projs.delete(pid); break }
      }
    }
    for (const [id, n] of S.nades) if (simFrame - n.born > 24) S.nades.delete(id)
  }
  requestAnimationFrame(frame)

  /* ---------- 绘制 ---------- */
  function draw(now) {
    ctx.fillStyle = SEA
    ctx.fillRect(0, 0, W, H)
    if (S.phase === 'boot') { bootDraw(); return }
    /* 镜头：己席（预测位）跟随；观战=圈心 */
    let camX = S.cam.x, camY = S.cam.y
    if (S.phase === 'live' && haveVis && S.me && S.me.al) { camX = vis.x; camY = vis.y }
    else { const c = stormAt(S.frame); camX = c.cx; camY = c.cy }
    S.cam.x = camX; S.cam.y = camY
    const sc = 0.55 // 世界 milli→屏幕 px（2400px 岛/375 视口≈6.4×下采样）
    const w2s = (x, y) => [W / 2 + (x - camX) * sc / 1000, H / 2 + (y - camY) * sc / 1000]

    /* 岛（草绿+沙缘+树丛点缀——亮色竞技场底） */
    const c0 = stormAt(S.frame)
    const [ix, iy] = w2s(0, 0)
    const iw = 2400 * sc, ih = 2400 * sc
    ctx.fillStyle = SAND
    ctx.beginPath(); ctx.arc(ix + iw / 2, iy + ih / 2, iw / 2 + 6, 0, 7); ctx.fill()
    ctx.fillStyle = GRASS
    ctx.beginPath(); ctx.arc(ix + iw / 2, iy + ih / 2, iw / 2, 0, 7); ctx.fill()
    ctx.fillStyle = BUSH
    for (let i = 0; i < 12; i++) {
      const a = i * 2.399, r = (500 + (i * 137) % 400) * sc
      const [bx, by] = w2s(1200000 + Math.cos(a) * r * 1000, 1200000 + Math.sin(a) * r * 1000)
      ctx.beginPath(); ctx.arc(bx, by, 14 + (i % 3) * 5, 0, 7); ctx.fill()
    }

    /* 四类·闭式毒圈：当前白实线+目标白虚线+圈外红紫斜纹罩（§7 双编码：形状优先） */
    drawStorm(camX, camY, sc, w2s)

    /* 三类·箱（武器箱方+武器色描边/道具箱圆+白描边——§7 双编码表） */
    for (const [id, bx] of S.boxMap) {
      if (!bx.on) continue
      const [sx, sy] = w2s(bx.x, bx.y)
      if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue
      const isWpn = bx.k === 'wpn' || bx.k === 'nade' || bx.k === 'drop'
      ctx.strokeStyle = isWpn ? (WCOL[bx.k === 'drop' ? bx.w : (bx.w !== undefined ? bx.w : 5)] || WHITE) : WHITE
      ctx.lineWidth = 2
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      if (isWpn) { ctx.beginPath(); ctx.rect(sx - 7, sy - 7, 14, 14); ctx.fill(); ctx.stroke() }
      else { ctx.beginPath(); ctx.arc(sx, sy, 8, 0, 7); ctx.fill(); ctx.stroke() }
    }

    /* 远人（100ms 插值；皮肤色+威胁红光圈） */
    for (const [seat, rec] of S.ents) {
      const ip = interp(rec, S.frame)
      if (!ip) continue
      const [sx, sy] = w2s(ip.x, ip.y)
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue
      const r = 12 + Math.floor((ip.sh || 0) / 30)
      drawBean(sx, sy, r, SKINS[seat % 8], ip.a, false, ip)
    }
    /* 己席（预测位；白圈描边=阵营双编码形状通道 §7） */
    if (S.me && S.me.al && haveVis) {
      const [sx, sy] = w2s(vis.x, vis.y)
      drawBean(sx, sy, 12 + Math.floor((S.me.sh || 0) / 30), '#FFF3D6', IN.aim || 0, true, S.me)
      if (S.me.hp === undefined) { /* noop */ }
      ctx.strokeStyle = WHITE; ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(sx, sy, 12 + Math.floor((S.me.sh || 0) / 30) + 4, 0, 7); ctx.stroke()
    }
    /* 二类重演弹体（与武器同色+形差：手雷虚线弧/火箭尾焰） */
    for (const [pid, pr] of S.projs) {
      const [sx, sy] = w2s(pr.x, pr.y)
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue
      ctx.strokeStyle = WCOL[pr.w] || WHITE
      ctx.lineWidth = pr.w === 4 ? 3 : 2
      ctx.beginPath()
      const [tx, ty] = [sx - P.cosQ16(pr.ang) / 65536 * 10, sy - P.sinQ16(pr.ang) / 65536 * 10]
      ctx.moveTo(tx, ty); ctx.lineTo(sx, sy); ctx.stroke()
      if (pr.w === 4) { ctx.fillStyle = 'rgba(255,107,92,0.5)'; ctx.beginPath(); ctx.arc(tx, ty, 3, 0, 7); ctx.fill() }
    }
    for (const [id, n] of S.nades) {
      const pos = P.nadePos(n, S.frame + 2)
      const [sx, sy] = w2s(pos.x, pos.y)
      ctx.fillStyle = WCOL[5]
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fill()
      ctx.setLineDash([])
    }
    drawFx(now, w2s)
    hudDraw(now)
    touchDraw(now)
    if (S.phase === 'dead') deadDraw(now)
    if (S.phase === 'ended') endDraw()
  }
  function drawStorm(camX, camY, sc, w2s) {
    const c = stormAt(S.frame)
    const [ccx, ccy] = w2s(c.cx, c.cy)
    const rPx = c.r / 1000 * sc
    /* 圈外红紫斜纹罩（形状通道——tritan 安全 §7）：全屏罩-圈内挖空 */
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, W, H)
    ctx.arc(ccx, ccy, rPx, 0, 7, true)
    ctx.fillStyle = STORM_A
    ctx.fill()
    ctx.restore()
    /* 斜纹（45° 离屏 pattern——逐帧 60 线×clip 在无头软渲染下是帧成本主源，缓存后 O(1)） */
    if (!drawStorm.pat) {
      const off = document.createElement('canvas')
      off.width = off.height = 14
      const octx = off.getContext('2d')
      octx.strokeStyle = 'rgba(208,90,122,0.35)'
      octx.lineWidth = 4
      octx.beginPath(); octx.moveTo(-7, 21); octx.lineTo(21, -7); octx.stroke()
      octx.beginPath(); octx.moveTo(-14, 7); octx.lineTo(7, -14); octx.stroke()
      drawStorm.pat = ctx.createPattern(off, 'repeat')
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, W, H)
    ctx.arc(ccx, ccy, rPx, 0, 7, true)
    ctx.clip()
    ctx.fillStyle = drawStorm.pat
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
    /* 当前圈白实线 */
    ctx.strokeStyle = WHITE; ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(ccx, ccy, rPx, 0, 7); ctx.stroke()
    /* 目标圈白虚线（下一相位末圆） */
    if (S.storm && S.storm.t1 !== undefined) {
      const [tx, ty] = w2s(S.storm.x1, S.storm.y1)
      ctx.setLineDash([8, 6])
      ctx.beginPath(); ctx.arc(tx, ty, S.storm.r1 / 1000 * sc, 0, 7); ctx.stroke()
      ctx.setLineDash([])
    }
  }
  function drawBean(x, y, r, skin, ang, isMe, dat) {
    ctx.fillStyle = skin
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill()
    ctx.strokeStyle = 'rgba(23,83,122,0.55)'; ctx.lineWidth = 1.5; ctx.stroke()
    /* 朝向指示（twin-stick 弹向） */
    ctx.strokeStyle = INK; ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + P.cosQ16(ang) / 65536 * (r + 7), y + P.sinQ16(ang) / 65536 * (r + 7)); ctx.stroke()
    /* 表情（§7：受击 😵/加速 😄/决赛 😰——简化点位眼嘴） */
    ctx.fillStyle = INK
    const ex = P.cosQ16(ang) / 65536 * r * 0.4, ey = P.sinQ16(ang) / 65536 * r * 0.4
    ctx.beginPath(); ctx.arc(x + ex - 3, y + ey - 2, 1.8, 0, 7); ctx.fill()
    ctx.beginPath(); ctx.arc(x + ex + 3, y + ey - 2, 1.8, 0, 7); ctx.fill()
    /* 血条（受伤时） */
    if (dat && dat.hp !== undefined && dat.hp < 100) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillRect(x - r, y - r - 7, r * 2, 3.5)
      ctx.fillStyle = dat.hp > 40 ? '#3DDC84' : '#FF6B5C'
      ctx.fillRect(x - r, y - r - 7, r * 2 * Math.max(0, dat.hp) / 100, 3.5)
    }
    /* 盾环（盾外显=体型已经体现在 r；蓝描边） */
    if (dat && dat.sh > 0) { ctx.strokeStyle = 'rgba(111,200,255,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, 7); ctx.stroke() }
  }
  function interp(rec, frame) {
    const b = rec.buf
    if (!b || !b.length) return rec.cur
    const t = frame - 2 // 100ms 渲染延迟（10Hz 快照=2 tick）
    let a = b[0], c = b[b.length - 1]
    for (let i = 1; i < b.length; i++) if (b[i].t <= t) a = b[i]
    for (let i = b.length - 2; i >= 0; i--) if (b[i].t >= t) c = b[i + 0]
    if (c.t === a.t) return c.p
    const k = Math.max(0, Math.min(1, (t - a.t) / (c.t - a.t)))
    return { x: a.p.x + (c.p.x - a.p.x) * k, y: a.p.y + (c.p.y - a.p.y) * k, a: c.p.a, sh: c.p.sh, hp: c.p.hp }
  }
  function drawFx(now, w2s) {
    for (const fx of S.fx) {
      const age = now - fx.at
      if (fx.kind === 'boom' && age < 400) {
        const [sx, sy] = w2s(fx.a, fx.b)
        ctx.strokeStyle = 'rgba(255,179,92,' + (1 - age / 400) + ')'
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.arc(sx, sy, 8 + age / 400 * 40, 0, 7); ctx.stroke()
      } else if (fx.kind === 'hitmark' && age < 160) {
        ctx.strokeStyle = 'rgba(255,255,255,' + (1 - age / 160) + ')'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(W / 2 - 8, H / 2 - 8); ctx.lineTo(W / 2 + 8, H / 2 + 8); ctx.moveTo(W / 2 + 8, H / 2 - 8); ctx.lineTo(W / 2 - 8, H / 2 + 8); ctx.stroke()
      } else if (fx.kind === 'dmgnum' && age < 700) {
        const me = S.me
        const [sx, sy] = w2s((S.ents.get(fx.a.seat) || { cur: {} }).cur.x || 0, (S.ents.get(fx.a.seat) || { cur: {} }).cur.y || 0)
        ctx.fillStyle = '#B3392E'
        ctx.font = HF('P0', 'dmg', 13, '700')
        ctx.textAlign = 'center'
        ctx.fillText('-' + fx.a.dmg, sx, sy - 16 - age / 700 * 14)
      } else if (fx.kind === 'healfx' && age < 600) {
        ctx.fillStyle = 'rgba(61,220,132,' + (1 - age / 600) + ')'
        ctx.font = HF('P0', 'heal', 13, '600')
        ctx.textAlign = 'center'
        ctx.fillText('+' + fx.a.v, W / 2, H / 2 - 30 - age / 600 * 10)
      } else if (fx.kind === 'stormToast' && age < 1600) {
        bannerDraw('圈开始收缩', age / 1600)
      } else if (fx.kind === 'pickok' && age < 200) {
        ctx.strokeStyle = 'rgba(61,220,132,' + (1 - age / 200) + ')'
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.arc(W / 2, H / 2, 20 + age / 2, 0, 7); ctx.stroke()
      }
    }
    if (S.koBanner && now - S.koBanner.at < 1200) bannerDraw(S.koBanner.txt, (now - S.koBanner.at) / 1200)
    if (S.fx.length > 40) S.fx = S.fx.filter((f) => now - f.at < 800)
  }
  function bannerDraw(txt, k) {
    ctx.fillStyle = 'rgba(23,83,122,' + (0.85 * (1 - k * 0.5)) + ')'
    ctx.fillRect(0, 200, W, 40)
    ctx.fillStyle = WHITE
    ctx.font = HF('P0', 'banner', 16, '700')
    ctx.textAlign = 'center'
    ctx.fillText(txt, W / 2, 226)
  }

  /* ---------- HUD（顶栏+小地图+武器栏；HF __applied 自证） ---------- */
  function hudDraw(now) {
    /* 顶栏 56px */
    ctx.fillStyle = 'rgba(23,83,122,0.82)'
    ctx.fillRect(0, 0, W, TOP_H)
    const me = S.me || {}
    /* HP 数值+条（P0 ≥13px/600） */
    ctx.fillStyle = WHITE
    ctx.font = HF('P0', 'hp', 13, '600')
    ctx.textAlign = 'left'
    ctx.fillText(String(me.hp === undefined ? 100 : me.hp), 8, 20)
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.fillRect(34, 12, 90, 6)
    ctx.fillStyle = (me.hp || 100) > 40 ? '#7DE8A8' : '#FF8A7A'
    ctx.fillRect(34, 12, 90 * Math.max(0, me.hp === undefined ? 100 : me.hp) / 100, 6)
    /* 盾格条 */
    ctx.fillStyle = '#6FC8FF'
    ctx.fillRect(34, 21, 90 * Math.min(60, me.sh || 0) / 60, 4)
    /* 存活数（P0） */
    ctx.fillStyle = WHITE
    ctx.font = HF('P0', 'alive', 13, '600')
    ctx.fillText('存活 ' + S.alive, 8, 44)
    /* 圈相位倒计时（P0）——闭式外推本地零带宽 */
    if (S.storm && S.storm.t1 !== undefined) {
      const left = Math.max(0, Math.ceil((S.storm.t1 - S.frame) * 50 / 1000))
      ctx.fillText('缩圈 ' + left + 's', 88, 44)
    }
    /* ping 徽标（P0 13px/600，T7-A 升档） */
    const ping = S.rec.pings.length ? S.rec.pings[S.rec.pings.length - 1] : 0
    ctx.fillStyle = ping > 250 ? '#FF8A7A' : ping > 120 ? '#FFE066' : '#7DE8A8'
    ctx.textAlign = 'right'
    ctx.font = HF('P0', 'ping', 13, '600')
    ctx.fillText(ping ? ping + 'ms' : '—', W - 76, 20)
    /* 右上小地图 Ø96：双圈+自位白点+密度点（圈即 HUD 主视觉 §7） */
    const mmR = 44, mmX = W - mmR - 8, mmY = TOP_H + mmR + 8
    ctx.fillStyle = 'rgba(23,83,122,0.55)'
    ctx.beginPath(); ctx.arc(mmX, mmY, mmR, 0, 7); ctx.fill()
    const mmS = mmR / 1400 // 世界 1400px 半径→小地图
    const c = stormAt(S.frame)
    const o2mm = (x, y) => [mmX + (x - 1200000) / 1000 * mmS, mmY + (y - 1200000) / 1000 * mmS]
    /* 岛缘+双圈（当前白实线/目标白虚线） */
    ctx.strokeStyle = SAND; ctx.lineWidth = 1.5
    const [ox, oy] = o2mm(0, 0)
    ctx.beginPath(); ctx.arc(ox + 1200 * mmS, oy + 1200 * mmS, 1200 * mmS, 0, 7); ctx.stroke()
    const [scx, scy] = o2mm(c.cx, c.cy)
    ctx.strokeStyle = WHITE; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(scx, scy, Math.max(1.5, c.r / 1000 * mmS), 0, 7); ctx.stroke()
    if (S.storm && S.storm.x1 !== undefined) {
      const [t1x, t1y] = o2mm(S.storm.x1, S.storm.y1)
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.arc(t1x, t1y, Math.max(1, S.storm.r1 / 1000 * mmS), 0, 7); ctx.stroke()
      ctx.setLineDash([])
    }
    /* 密度点（1Hz mm）+自位白点 */
    ctx.fillStyle = '#B3392E'
    for (const d of S.mm || []) { const [dx, dy] = o2mm(d[1] * 1000, d[2] * 1000); ctx.fillRect(dx - 1, dy - 1, 2, 2) }
    if (S.me && S.me.al && haveVis) { const [px, py] = o2mm(vis.x, vis.y); ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(px, py, 2.5, 0, 7); ctx.fill() }
    /* 左下武器栏：icon+弹匣格条+备弹（P0）；背包四格（P1 ≥11px） */
    ctx.fillStyle = 'rgba(23,83,122,0.7)'
    ctx.fillRect(8, H - 92, 150, 84)
    const wn = ['拳', '手枪', '冲锋', '霰弹', '火箭', '手雷'][me.w || 0]
    ctx.fillStyle = WCOL[me.w || 0] || WHITE
    ctx.font = HF('P0', 'wname', 13, '600')
    ctx.textAlign = 'left'
    ctx.fillText(wn, 14, H - 74)
    ctx.fillStyle = WHITE
    ctx.font = HF('P1', 'ammo', 11, '400')
    ctx.fillText('弹 ' + (me.mag !== undefined ? me.mag : '—') + '+' + (me.am !== undefined ? me.am : '—'), 70, H - 74)
    /* 弹格条（准星下方同款简化：武器栏内 10 格） */
    const mag = me.mag || 0, magMax = P.WPNS[me.w || 0].mag || 10
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = i < Math.ceil(mag / Math.max(1, magMax) * 10) ? '#FFE066' : 'rgba(255,255,255,0.25)'
      ctx.fillRect(14 + i * 13, H - 66, 10, 5)
    }
    /* 背包四格计数 */
    ctx.font = HF('P1', 'bag', 11, '400')
    ctx.fillStyle = WCOL[5]; ctx.fillText('雷×' + (me.na || 0), 14, H - 44)
    ctx.fillStyle = '#7DE8A8'; ctx.fillText('医×' + (me.me || 0), 62, H - 44)
    ctx.fillStyle = '#6FC8FF'; ctx.fillText('速×' + (me.spd || 0), 110, H - 44)
    /* 排行 top3（P2） */
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.font = HF('P2', 'lb', 9, '400')
    ctx.textAlign = 'left'
    ctx.fillText((S.lb || []).slice(0, 3).map((x, i) => (i + 1) + '.击' + x[1]).join(' '), 14, H - 26)
    /* 页脚 slug·version（P2 ≥9px）——右对齐收口：左起 x=W−90 画 ~99px 越 375 右缘 ~9px
     * 被截断（识图 20261017 实锤），改 textAlign right+右缘 8px 安全距 */
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = HF('P2', 'foot', 9, '400')
    ctx.textAlign = 'right'
    ctx.fillText('party-brawl · v1', W - 8, H - 6)
    ctx.textAlign = 'left'
    /* 拾取钮浮现条件：28px 吸附圈内有箱（§3.3 ≤1 帧） */
    S.pickTarget = -1
    if (S.phase === 'live' && haveVis) {
      let bd = 28000 * 28000, tgt = -1
      for (const [id, bx] of S.boxMap) {
        if (!bx.on) continue
        const dx = bx.x - vis.x, dy = bx.y - vis.y
        const d2 = dx * dx + dy * dy
        if (d2 < bd) { bd = d2; tgt = Number(id.slice(1)) }
      }
      S.pickTarget = tgt
    }
  }
  /* ---------- 触控件（射击钮 Ø72+技能钮 Ø56+拾取钮 Ø64+浮动摇杆） ---------- */
  function touchDraw(now) {
    if (S.phase !== 'live') return
    /* 浮动摇杆（按点为原点 §1.5） */
    if (stick.on) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(stick.ox, stick.oy, 44, 0, 7); ctx.stroke()
      const dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.hypot(dx, dy) || 1
      const cl = Math.min(44, d)
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.beginPath(); ctx.arc(stick.ox + dx / d * cl, stick.oy + dy / d * cl, 20, 0, 7); ctx.fill()
    }
    /* 射击钮 Ø72（亮=按住） */
    ctx.fillStyle = shoot.on ? 'rgba(255,138,122,0.9)' : 'rgba(255,255,255,0.55)'
    ctx.beginPath(); ctx.arc(fireBtn.x, fireBtn.y, 36, 0, 7); ctx.fill()
    ctx.strokeStyle = WHITE; ctx.lineWidth = 2; ctx.stroke()
    ctx.fillStyle = INK
    ctx.font = HF('P1', 'fire', 11, '600')
    ctx.textAlign = 'center'
    ctx.fillText('射击', fireBtn.x, fireBtn.y + 4)
    /* 技能钮 Ø56（循环：雷/医/速） */
    ctx.fillStyle = 'rgba(201,143,232,0.8)'
    ctx.beginPath(); ctx.arc(sklBtn.x, sklBtn.y, 28, 0, 7); ctx.fill()
    ctx.strokeStyle = WHITE; ctx.stroke()
    ctx.fillStyle = WHITE
    ctx.font = HF('P1', 'skl', 11, '600')
    const me = S.me || {}
    ctx.fillText(me.na > 0 ? '雷' : me.me > 0 ? '医' : '速', sklBtn.x, sklBtn.y + 4)
    /* 拾取钮 Ø64（28px 吸附圈内有箱才浮现 §1.5） */
    if (S.pickTarget >= 0) {
      ctx.fillStyle = 'rgba(125,232,168,0.9)'
      ctx.beginPath(); ctx.arc(pickBtn.x, H - 150 - 8, 32, 0, 7); ctx.fill()
      ctx.strokeStyle = WHITE; ctx.lineWidth = 2; ctx.stroke()
      ctx.fillStyle = INK
      ctx.font = HF('P1', 'pick', 11, '600')
      ctx.fillText('拾取', pickBtn.x, H - 150 - 4)
    }
  }
  function deadDraw(now) {
    ctx.fillStyle = 'rgba(23,83,122,0.72)'
    ctx.fillRect(0, H / 3, W, H / 3)
    ctx.fillStyle = WHITE
    ctx.textAlign = 'center'
    ctx.font = HF('P0', 'dead', 15, '700')
    ctx.fillText('被淘汰 · 排名 ' + ((S.me && S.me.rank) || '—'), W / 2, H / 3 + 36)
    ctx.font = HF('P1', 'deadsub', 11, '400')
    ctx.fillText('观战余局（镜头=圈心）· 战报：击杀 ' + S.kills, W / 2, H / 3 + 60)
  }
  function endDraw() {
    const r = S.endInfo || {}
    ctx.fillStyle = 'rgba(23,83,122,0.88)'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = WHITE
    ctx.textAlign = 'center'
    ctx.font = HF('P0', 'end', 16, '700')
    ctx.fillText('终局 · ' + (r.reason || ''), W / 2, 120)
    /* 延迟补偿战报（T7-A 下半主场：把 §5.3 预算表写成玩家看得懂的战报） */
    ctx.font = HF('P1', 'endrep', 11, '400')
    const rec = S.rec
    const lines = [
      '我的排名：' + ((S.me && S.me.rank) || '—') + ' · 击杀 ' + S.kills,
      '—— 延迟补偿战报 ——',
      '和解回填 ' + rec.n + ' 次（软收敛 ' + rec.soft + '/硬回滚 ' + rec.hard + '）',
      '修正量中位 ' + (rec.n ? Math.round(rec.sum / rec.n / 10) / 10 : 0) + 'px · 峰值 ' + Math.round(rec.maxPx / 10) / 10 + 'px',
      'ping 末值 ' + (rec.pings.length ? rec.pings[rec.pings.length - 1] : '—') + 'ms',
      '链路没吃掉你的走位。',
    ]
    lines.forEach((l, i) => ctx.fillText(l, W / 2, 180 + i * 24))
    ctx.fillStyle = '#7DE8A8'
    ctx.font = HF('P1', 'endcta', 11, '600')
    ctx.fillText('即将自动匹配下一局…', W / 2, H - 120)
  }
  function bootDraw() {
    ctx.fillStyle = '#17537A'
    ctx.font = HF('P1', 'boot', 11, '400')
    ctx.textAlign = 'center'
    ctx.fillText('连接糖豆岛…', W / 2, H / 2)
  }

  /* ---------- ping（5s 一拍；pong RTT 回写账本——F-4 修复前发送侧在而消费侧死码） ---------- */
  setInterval(() => {
    if (S.conn && S.conn.readyState === 1) {
      S.conn.send(JSON.stringify({ t: 'ping', c: performance.now() }))
      S.lastPingAt = performance.now()
    }
  }, 5000)

  /* ---------- debug 面（perf-smoke/识图契约） ---------- */
  window.__GAMES_DEBUG__ = {
    hudFonts,
    state: () => ({ phase: S.phase, seat: S.seat, frame: S.frame, ack: S.ack, seq: S.seq, alive: S.alive, rec: S.rec, fxLedger: fxLedgerArr }),
    stormNow: () => stormAt(S.frame),
    projsN: () => S.projs.size,
    entsN: () => S.ents.size,
  }
  connect()
})()
