/* =====================================================================
 * 派对大乱斗 客户端（GAMES-172 · S6+S7 双技术第三款——S7 预测和解第二证）。
 * 依赖前置：trig16.cjs / sim.cjs（window.PartySim——与服务端同一段纯函数，
 * §5.1 单源纪律）。
 *
 * GAMES-176 手感层（FEEL）：FXLIST 动效登记表（fb 反馈类 ≤80ms 首绘红线+
 * fxLedger 双时戳台账）+ SND 音效位（makeSound 平台范式：总闸门默认静音只
 * 记账）+ 四面交付——①战斗反馈 juice（受击闪白/微击退+kill feed+糖粒雨+箱
 * 弹出+拾取浮标+毒圈边缘警示 §3.4）②ping 徽标观战同步（F-4 账本消费面）
 * ③淘汰观战视图（镜头平滑跟领先者+tap 切换+信息卡——§4.3/§5.7 承接）
 * ④观战 AOI 体验（边缘席位指示——O-1 后续）。
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
    /* GAMES-178 FIX2 域统一（卡丁范式搬运）：simTick=本地服务器拍估计（重放域统一
     * 基座——anchor@snapshot.frame 与 push/advanceTo 同为 sim tick 域；输入 seq 只作
     * 环账本 q）；flight=飞行窗 EMA（ack 回执自校准）；sentLog={q,tick} 供回执对账 */
    simTick: 0, lastFrame: null, flight: 3, sentLog: [], lastPushAt: 0, blend: null,
    predLog: [], // 和解逐快照账本（帧级偏差带取证：d=同拍预测偏差 mpx，lead=超前权威 px——§5.3 激活态证据）
    ents: new Map(), // 远人插值缓冲（100ms）
    me: null, storm: null, alive: 20, lb: [], mm: [],
    projs: new Map(), nades: new Map(), // 二类重演域（弹体/手雷——事件全参本地推进）
    fx: [], kills: 0, dmg: 0,
    predictor: P.makePredictor(),
    rec: { soft: 0, hard: 0, maxPx: 0, sum: 0, n: 0, pings: [] }, // 和解修正账本（§3.1/结算战报源）
    cam: { x: 1200000, y: 1200000 }, endInfo: null, koBanner: null, deadAt: 0,
    startFrame: 0, deadFrame: 0, killedBy: -1,   // 淘汰信息卡原料（O-2 承接：在场时长/击杀者）
    camMode: 'lead', feed: [],                    // 观战镜头模式（lead=跟领先者/free=圈心全景）+ kill feed 行
    hurt: { at: -1e9, ang: 0 }, shake: { at: -1e9, amp: 0, dur: 1 }, // 受击/震屏渲染层状态（不入判定 §3.2）
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
      S.seed = m.seed; S.frame = m.frame; S.startFrame = m.frame // 淘汰信息卡在场时长锚（接管中局=入房拍起算）
      /* GAMES-178：新房=预测域重置（旧房 seq/tick 域残留会污染新锚）+全量态即锚
       * （welcome.state 自席记录含 x/y/vx/vy/boost——中局接管首帧影子即有效，不等首张快照） */
      S.predictor = P.makePredictor()
      S.simTick = m.frame; S.lastFrame = null; S.flight = 3
      S.sentLog = []; S.lastPushAt = 0; S.blend = null; S.clockAt = 0; S.clockAcc = 0
      haveVis = false; S.predLog = []
      const st = m.state
      if (st && st.players) for (const p of st.players) if (p.seat !== S.seat) S.ents.set(p.seat, { cur: { ...p }, buf: [{ t: m.frame, p: { ...p } }], a: p.a })
      if (st && st.storm) { S.storm = mkStormView(st.storm, st.tick || 0); S.storm.ph = st.storm.ph }
      if (st && st.projs) for (const pr of st.projs) S.projs.set(pr.pid, { ...pr, born: S.frame }) // 重连补列（§5.7）
      if (st && st.nades) for (const n of st.nades) S.nades.set(n.id, { ...n })
      const own0 = st && st.players ? st.players.find((p) => p.seat === S.seat) : null
      if (own0) S.predictor.anchor({ x: own0.x, y: own0.y, vx: own0.vx, vy: own0.vy, w: own0.w, nades: own0.nades, boost: own0.boost, aim: 0 }, m.frame)
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
    S.lastFrame = m.frame // GAMES-178：本地时钟护栏上界（快照断流防开环跑飞，卡丁同式）
    if (m.ext) {
      if (m.ext.storm) { S.storm = mkStormView(m.ext.storm) }
      if (m.ext.alive !== undefined) S.alive = m.ext.alive
      if (m.ext.lb) S.lb = m.ext.lb
      if (m.ext.mm) S.mm = m.ext.mm
      if (m.ext.me) {
        const wasMe = S.me
        S.me = m.ext.me
        if (wasMe && wasMe.al && !m.ext.me.al && S.phase === 'live') onDead()
        /* 一类·预测和解（§5.1）：ack 裁剪→权威锚→重放未确认→软/硬收敛。
         * GAMES-176 死码激活：DEV 期 reconcile 未接线 → predictor 无 anchor →
         * advanceTo 恒 null → haveVis 恒 false——己席渲染/相机跟随/拾取钮/拾取
         * 浮标/和解账本全链挂（smoke rec.n 0→0 即此症状） */
        if (m.ext.ack !== undefined) S.ack = m.ext.ack
        reconcile(m)
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
        if (!bx && e.x !== undefined) { bx = { id: e.id, x: e.x, y: e.y, k: e.k, w: e.w, it: e.it, on: 1, pop: performance.now() }; S.boxMap.set(e.id, bx) } // F09 弹出动画锚=首见拍（drop/airdrop 零推断 §5.2）
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
    else if (ev.k === 'hit') {
      if (ev.by === S.seat) addFx('hitmark', null, null)
      addFx('dmgnum', ev)
      if (ev.seat === S.seat) { // F03 受击闪白+微击退感（渲染层 §3.2——攻击者方位入射向推 3px 回弹）
        const atk = S.ents.get(ev.by)
        const ang = atk && atk.cur ? Math.atan2((S.me.y || 0) - atk.cur.y, (S.me.x || 0) - atk.cur.x) : 0
        S.hurt = { at: performance.now(), ang }
        S.shake = { at: performance.now(), amp: 2, dur: 120 }
        addFx('hurtflash', ev)
        sfx('hurtHit')
      }
    }
    else if (ev.k === 'elim') {
      if (ev.seat === S.seat) { S.killedBy = ev.by; onDead() }
      /* F04 kill feed：「Px 淘汰 Py · 剩 N」（royale 播报面）；毒杀 by=-1 显示「毒圈」 */
      const nm = (s2) => s2 >= 0 ? 'P' + (s2 + 1) : '毒圈'
      S.feed.unshift({ txt: nm(ev.by) + ' 淘汰 ' + nm(ev.seat), at: performance.now(), mine: ev.by === S.seat || ev.seat === S.seat })
      if (S.feed.length > 3) S.feed.pop()
      addFx('killfeed', ev)
      if (ev.by === S.seat) { S.kills++; S.koBanner = { txt: '淘汰 ' + nm(ev.seat), at: performance.now() } }
      addFx('confetti', ev) // F08 糖粒雨（被淘汰者皮肤色）
      addFx('koshake', ev) // F05 KO 震屏（§3.4 signature——绘制在镜头 shake 段）
      S.shake = { at: performance.now(), amp: 4, dur: 240 }
      sfx('koBoom')
    }
    else if (ev.k === 'pick') {
      if (ev.seat === S.seat) { addFx('pickbadge', null, null); sfx('pickUp') }
      else { const bx = S.boxMap.get(ev.id); if (bx) bx.on = 0 }
    }
    else if (ev.k === 'drop') { sfx('boxDrop') } // F09 弹出动画锚在快照首见拍（三类生成=零推断，§5.2）
    else if (ev.k === 'airdrop') { addFx('airdropMark', ev); sfx('airdropCue') } // F10 空投标落点（事件自带坐标）
    else if (ev.k === 'storm') { S.storm = mkStormView(ev); addFx('stormToast', null, null); sfx('stormCue') }
    else if (ev.k === 'heal') { addFx('healfx', ev); if (ev.seat === S.seat) sfx('healChime') }
    else if (ev.k === 'boost') if (ev.seat === S.seat) { addFx('boostfx', null, null); sfx('boostWhoosh') }
  }
  function onDead() { if (S.phase === 'live') { S.phase = 'dead'; S.deadAt = performance.now(); S.deadFrame = S.frame; S.camMode = 'lead' /* 镜头从死亡位 lerp 平滑切向领先者（§3.4 signature），不断崖跳切 */ } }
  /* F13 观战镜头目标：lead=排行榜首（kills 最高存活者，1Hz lb）渲染插值位；
   * free=圈心全景（闭式外推零带宽）。spectator AOI 圆心服务端同源跟随（GAMES-176） */
  function specTargetPos() {
    if (S.camMode === 'free' || !S.lb || !S.lb.length) { const c = stormAt(S.frame); return { x: c.cx, y: c.cy, seat: -1 } }
    const lead = S.lb[0][0]
    const rec = lead !== S.seat ? S.ents.get(lead) : null
    if (!rec) { const c = stormAt(S.frame); return { x: c.cx, y: c.cy, seat: -1 } }
    const ip = interp(rec, S.frame)
    return { x: ip.x, y: ip.y, seat: lead }
  }

  /* ---------- GAMES-176 FXLIST：[id, 名称, fb|state]——fb=反馈类（事件→首绘 ≤80ms
   * 红线，台账断言），state=状态类（持续态，只报数）。fxT 打触发时戳、fxD 打首绘
   * 时延（fxLedger 供 feel-check 复跑；设计 §3.4 juice 清单落地）。 ---------- */
  const FXLIST = [
    ['F01', 'hitmark', 'fb'],      // 命中标记（hit by=me → 准星 X 闪 160ms，§3.4 命中三连）
    ['F02', 'dmgnum', 'fb'],       // 伤害飘字（hit → P0 数字上飘 700ms，§3.4）
    ['F03', 'hurtflash', 'fb'],    // 受击闪白+微击退感（hit me → 己席白闪 200ms+震屏 2px/120ms+渲染层外推 3px 回弹——纯渲染不入判定，§3.2 同律）
    ['F04', 'killfeed', 'fb'],     // 击杀淘汰播报（elim → feed 行「Px 淘汰 Py·剩 N」4s 滚动+我杀=KO 大字 1.2s，§3.4 signature）
    ['F05', 'koshake', 'fb'],      // KO 震屏（elim 可见 → 240ms 4px，§3.4 signature）
    ['F06', 'stormedge', 'fb'],    // 毒圈逼近边缘警示（圈边距 <120px → 屏缘红紫渐晕脉冲，§3.4 缩圈行）
    ['F07', 'pickbadge', 'fb'],    // 拾取确认环（pick me → 绿环扩散 200ms+吸入，§3.3）
    ['F08', 'confetti', 'state'],  // 糖豆爆糖粒雨（elim → 14 粒皮肤色抛散 700ms，粒数∝signature，§3.4）
    ['F09', 'boxpop', 'state'],    // 掉落箱弹出（新箱首见 → scale 弹跳 300ms+落地尘环，§3.4 空投行）
    ['F10', 'airdropMark', 'state'], // 空投落点标记（airdrop → toast+金圈脉冲 2s+小地图金点，§3.4）
    ['F11', 'pickupBob', 'state'], // 拾取浮标（吸附圈内有箱 → 28px 吸附圈虚线+最近箱高亮脉冲+箱顶 chevron 浮动，§3.3）
    ['F12', 'pingBadge', 'state'], // ping 徽标常驻（末值+均值双读——F-4 账本展示面，玩家/观战同款 §5.7）
    ['F13', 'specCam', 'state'],   // 观战镜头平滑跟随（淘汰/观战 → lerp 0.12 跟领先者，tap 切圈心全景——§4.3 承接）
    ['F14', 'specCard', 'state'],  // 淘汰信息卡（rank/kills/在场时长/ping/击杀者——O-2 承接）
    ['F15', 'edgePip', 'state'],   // 边缘席位指示（观战 → 屏外存活席位边缘三角+距离，O-1 后续）
    ['F16', 'boom', 'state'],      // 爆炸冲击环（boom → 橙环扩散 400ms）
    ['F17', 'healfx', 'state'],    // 医疗回复飘字（heal → 绿 +N 600ms）
    ['F18', 'stormToast', 'state'], // 缩圈横幅（storm → 「圈开始收缩」1.6s，§3.4）
    ['F19', 'boostfx', 'state'],   // 加速残影（boost → 我席拖尾淡影 500ms）
  ]
  const fxLedger = []
  function fxT(id) { fxLedger.push({ id, trig: performance.now(), lat: null }); if (fxLedger.length > 240) fxLedger.shift(); return fxLedger[fxLedger.length - 1] }
  const fxLatMin = {} // 持久最小首绘时延表（20 席热房事件洪水会冲掉 240 条环形台账——feel-check 断言锚）
  function fxD(rec) { if (rec && rec.lat == null) { rec.lat = Math.max(0, Math.round(performance.now() - rec.trig)); if (fxLatMin[rec.id] == null || rec.lat < fxLatMin[rec.id]) fxLatMin[rec.id] = rec.lat } }

  /* ---------- 音效位（makeSound 平台范式：总闸门默认静音只记账；开启后 WebAudio
   * 简音色占位——多人客户端本地化口径，GAMES-131/141/150 同式） ---------- */
  const SND = { on: false, slots: ['hurtHit', 'koBoom', 'pickUp', 'boxDrop', 'airdropCue', 'stormCue', 'finalBeat', 'healChime', 'boostWhoosh', 'endWhistle'], calls: [], fired: {}, ac: null }
  function sfx(slot) {
    SND.calls.push({ g: slot, at: Math.round(performance.now()) })
    SND.fired[slot] = true // 持久触达集（calls 滚动窗会被高频命中音刷掉）
    if (SND.calls.length > 300) SND.calls.shift()
    if (!SND.on) return
    try {
      if (!SND.ac) SND.ac = new (window.AudioContext || window.webkitAudioContext)()
      const a = SND.ac, o = a.createOscillator(), g = a.createGain(), t = a.currentTime
      const big = { koBoom: 1, endWhistle: 1, airdropCue: 1 }
      const tick = { pickUp: 1, healChime: 1, finalBeat: 1 }
      o.type = big[slot] || tick[slot] ? 'square' : 'sine'
      const f0 = big[slot] ? 150 : tick[slot] ? 880 : slot === 'hurtHit' ? 300 : slot === 'stormCue' ? 220 : 480
      o.frequency.setValueAtTime(f0, t)
      o.frequency.exponentialRampToValueAtTime(Math.max(60, f0 * 0.6), t + 0.12)
      g.gain.setValueAtTime(0.08, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.16)
    } catch { /* 音色失败不阻断 */ }
  }

  /* ---------- fx（事件驱动零 diff 触发；台账见 fxLedger） ---------- */
  const fxLedgerArr = []
  function addFx(kind, a, b) {
    const fx = { kind, a, b, at: performance.now(), led: null }
    const item = FXLIST.find((x) => x[1] === kind)
    if (item) fx.led = fxT(item[0])
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
    /* 观战镜头切换（F13：tap 任意处 lead⇄free——淘汰后/旁观席同款，§4.3 承接） */
    if (S.phase === 'dead' || (S.seat < 0 && S.phase === 'live')) {
      S.camMode = S.camMode === 'lead' ? 'free' : 'lead'
      e.preventDefault()
      return
    }
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
    /* 一类·预测：采样即本地预测 tick 输入（零等待 §3.1）。GAMES-178 域统一：
     * 推送拍=simTick+flight（sim tick 域——与 anchor/advanceTo 同域，卡丁范式）；
     * 输入 seq 只作上行 q（ack 回执对账源→flight EMA）；simTick 步进在渲染循环
     * wall-clock 累计器（50ms interval 抖动会慢于服务器拍） */
    S.sentLog.push({ q: S.seq, tick: S.simTick })
    if (S.sentLog.length > 96) S.sentLog.shift()
    if (!S.degraded) {
      /* 推送拍单调不回退（flight EMA 单步可降≥2 时估算拍倒序，强制 ≥前推+1 保
       * 到达序——GAMES-111 F4 卡丁同坑） */
      const pushAt = Math.max(S.simTick + S.flight, (S.lastPushAt || 0) + 1)
      S.lastPushAt = pushAt
      S.predictor.push(pushAt, { mx, my, aim, fire })
    }
    S.conn.send(JSON.stringify({ t: 'input', frame: S.seq, keys }))
    S.seq++
    lastUp = keys
  }, 50)
  function stickX0() { return stick.on ? stick.ox : W / 2 }
  function stickY0() { return stick.on ? stick.oy : H / 2 }

  /* ---------- 和解（§5.1 ①-③；§3.1 撕裂预算） ---------- */
  let vis = { x: 0, y: 0 }, haveVis = false
  const visLedger = [] // 逐帧视觉步长台账 {s:vis步长px, b:混合带, m:影子步长px}（§5.3 撕裂预算取证：修正位移 vs 运动位移分离计量）
  function syncFlightAck(ack, srvTick) {
    /* 飞行窗自校准（卡丁范式）：ack 回执（服务器已消费 seq）→ 观测发送 tick→消费 tick 差 EMA */
    if (ack < 0 || !S.sentLog.length) return
    while (S.sentLog.length && S.sentLog[0].q <= ack) {
      const obs = srvTick - S.sentLog[0].tick
      if (obs >= 0 && obs < 64) S.flight = (S.flight * 3 + obs + 1) >> 2
      S.sentLog.shift()
    }
  }
  function reconcile(m) {
    const me = S.me
    if (!me || me.al === 0 || S.degraded || me.x === undefined) return // x/y=权威锚原料（GAMES-176 适配器配套；缺坐标=旧网关兼容跳过）
    syncFlightAck(S.ack, m.frame)
    /* 抬钟=快照到达即已陈旧下行半程（ping RTT/2 折算拍——TCP 垫臂/真网同义）：只按
     * m.frame 抬钟会把本地钟锁相在快照到达沿（st≡f，预测超前塌 0——GAMES-178 次验实测）；
     * 修正前后同拍对照不变（抬钟先行） */
    const rttNow = S.rec.pings.length ? S.rec.pings[S.rec.pings.length - 1] : 0
    const downTicks = Math.min(4, Math.ceil(rttNow / 2 / S.tickMs))
    if (S.simTick < m.frame + downTicks) S.simTick = m.frame + downTicks
    /* 修正前预测态先捕获再 anchor 覆盖（卡丁 F1 教训：先 anchor 后取 pre=锚点重放终态，
     * d 结构性 ≡0——台账/软硬分流/撕裂预算全死码） */
    const pre = S.predictor.advanceTo(S.simTick)
    const preX = pre ? pre.x : me.x, preY = pre ? pre.y : me.y
    /* 权威锚点：ack 裁剪由 predictor.anchor 内部（at≤tick 出环；GAMES-178 域统一后
     * tick=snapshot.frame 与推送拍同域）+ vx/vy/bt 锚定速度与加速剩余拍（缺速度=满速
     * 回放系统性滞后 ~1.75 tick≈13px>p95 预算，适配器配套） */
    S.predictor.anchor({ x: me.x, y: me.y, vx: me.vx || 0, vy: me.vy || 0, w: me.w, nades: me.na, boost: me.bt || 0, aim: 0 }, m.frame)
    const sh = S.predictor.advanceTo(S.simTick) // 重放未确认（simTick-frame ≈ flight+1 tick）
    if (!sh) return
    if (!haveVis) { vis.x = sh.x; vis.y = sh.y; haveVis = true; S.blend = null; return }
    const d = Math.hypot(sh.x - preX, sh.y - preY) // 同拍预测偏差（mpx）=§5.3 修正量
    const lead = Math.hypot(sh.x - me.x, sh.y - me.y) // 超前权威锚距离（预测激活观测：≈v×(simTick-frame)）
    if (d > 500) S.rec.n++ // 修正事件（>0.5px 才入账——事件率口径，卡丁同阈值；亚像素抖动不计）
    S.rec.sum += d
    if (d > S.rec.maxPx) S.rec.maxPx = d
    S.predLog.push({ f: m.frame, st: S.simTick, fl: S.flight, d: Math.round(d), lead: Math.round(lead) })
    if (S.predLog.length > 240) S.predLog.shift()
    if (d > 6000) { // 硬回滚：120ms 混合带（视觉 ≤2.5px/帧，渲染循环封顶）
      S.rec.hard++
      S.blend = { t0: performance.now() }
    } else if (d > 600) S.rec.soft++
  }

  /* ---------- 渲染主循环（60fps：本地 sim 态间渲染+毒圈闭式外推+弹体重演） ---------- */
  let lastT = performance.now(), rafN = 0, paused = false
  const perfLog = { costs: [], gaps: [], lastAt: 0 } // FE-5 口径：帧成本注入法（vsync 免疫 games-167）
  function frame(now) {
    const t0 = performance.now()
    if (perfLog.lastAt) perfLog.gaps.push(t0 - perfLog.lastAt) // 首帧播种（GAMES-141 恒 0 死码教训）
    perfLog.lastAt = t0
    if (paused) { requestAnimationFrame(frame); return } // QA 冻结采样（GAMES-103 范式：保留末帧供识图）
    const dt = Math.min(50, now - lastT); lastT = now
    rafN++
    /* 本地 sim 时钟（wall-clock 累计器，rAF 驱动）：simTick 按真实 20Hz 步进——
     * 50ms setInterval 抖动会慢于服务器拍 → 每张快照抬钟钉平 → 预测超前塌 0
     * （GAMES-178 首验实测 st≡f）；护栏：不超前权威帧 flight+10（快照断流防开环跑飞） */
    if (!S.degraded && S.phase === 'live' && S.me && S.me.al) {
      const lastClk = S.clockAt || now
      S.clockAt = now
      S.clockAcc = (S.clockAcc || 0) + Math.min(100, now - lastClk)
      while (S.clockAcc >= 50) {
        S.clockAcc -= 50
        S.simTick++
        if (S.lastFrame != null && S.simTick - S.lastFrame > S.flight + 10) S.simTick = S.lastFrame + S.flight + 10
      }
      S.predictor.advanceTo(S.simTick)
    }
    /* 视觉自席：影子已由本地 sim 时钟步进（sim tick 域），渲染层只做收敛——
     * 软收敛 0.35/帧（~100ms 抹平）/硬回滚 120ms 混合带（每帧位移封顶 2.5px，
     * §5.1 ③+§5.3 撕裂预算——卡丁同式） */
    if (!S.degraded && S.phase === 'live' && S.me && S.me.al && haveVis) {
      const sh = S.predictor.me()
      const wasBlend = !!S.blend
      if (S.blend) {
        const p = Math.min(1, (now - S.blend.t0) / 120)
        const k = 0.18 + p * 0.5
        let mx = (sh.x - vis.x) * k, my = (sh.y - vis.y) * k
        const mv = Math.hypot(mx, my) / 1000
        if (mv > 2.5) { const c = 2.5 / mv; mx *= c; my *= c }
        vis.x += mx; vis.y += my
        if (p >= 1 || Math.abs(sh.x - vis.x) < 500) S.blend = null
      } else {
        vis.x += (sh.x - vis.x) * 0.35
        vis.y += (sh.y - vis.y) * 0.35
      }
      const step = visLedger._prev ? Math.hypot(vis.x - visLedger._prev.x, vis.y - visLedger._prev.y) / 1000 : 0
      const mstep = visLedger._prevSh ? Math.hypot(sh.x - visLedger._prevSh.x, sh.y - visLedger._prevSh.y) / 1000 : 0
      visLedger._prev = { x: vis.x, y: vis.y }; visLedger._prevSh = { x: sh.x, y: sh.y }
      visLedger.push({ s: Math.round(step * 100) / 100, b: wasBlend ? 1 : 0, m: Math.round(mstep * 100) / 100 })
      if (visLedger.length > 1800) visLedger.shift()
    } else { visLedger._prev = null; visLedger._prevSh = null }
    /* 二类重演推进（弹体按 tick 步进——事件帧起算的确定性积分） */
    stepProjs()
    draw(now)
    perfLog.costs.push(performance.now() - t0)
    if (perfLog.costs.length > 240) { perfLog.costs.shift(); perfLog.gaps.shift() }
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
    /* 镜头：己席（预测位）跟随；观战（淘汰后/旁观席）=F13 平滑 lerp 0.12 跟领先者
     * （tap 切圈心全景——§4.3 承接/§5.7；领先者坐标=AOI 跟随面服务端同源） */
    let camX = S.cam.x, camY = S.cam.y
    if (S.phase === 'live' && haveVis && S.me && S.me.al) { camX = vis.x; camY = vis.y }
    else if (S.phase === 'dead' || (S.seat < 0 && S.phase === 'live')) {
      const t = specTargetPos()
      camX = S.cam.x + (t.x - S.cam.x) * 0.12
      camY = S.cam.y + (t.y - S.cam.y) * 0.12
      if (!S.led13) S.led13 = fxT('F13')
      fxD(S.led13) // F13 首绘打点（lerp 每帧走——打点窗内即回）
    } else { const c = stormAt(S.frame); camX = c.cx; camY = c.cy }
    S.cam.x = camX; S.cam.y = camY
    /* F05/F03 震屏（KO 4px/240ms+受击 2px/120ms）：世界层 sin 微抖，HUD 不入——纯渲染层 §3.2 */
    const shAge = now - S.shake.at
    const sk = shAge < S.shake.dur ? (1 - shAge / S.shake.dur) * S.shake.amp : 0
    const shx = sk ? Math.sin(now * 0.09) * sk * 1000 : 0, shy = sk ? Math.cos(now * 0.11) * sk * 1000 : 0
    const sc = 0.55 // 世界 milli→屏幕 px（2400px 岛/375 视口≈6.4×下采样）
    const w2s = (x, y) => [W / 2 + (x - camX - shx) * sc / 1000, H / 2 + (y - camY - shy) * sc / 1000]

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

    /* 三类·箱（武器箱方+武器色描边/道具箱圆+白描边——§7 双编码表）+F09 弹出动画
     * （首见拍 300ms ease-out 回弹+落地尘环——§3.4 空投/掉落行） */
    for (const [id, bx] of S.boxMap) {
      if (!bx.on) continue
      const [sx, sy] = w2s(bx.x, bx.y)
      if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue
      const isWpn = bx.k === 'wpn' || bx.k === 'nade' || bx.k === 'drop'
      const popAge = bx.pop ? now - bx.pop : 1e9
      const k2 = popAge < 300 ? 0.25 + 0.75 * (1 - Math.pow(1 - popAge / 300, 2)) * (1 + Math.sin(popAge / 300 * Math.PI) * 0.3) : 1
      ctx.strokeStyle = isWpn ? (WCOL[bx.k === 'drop' ? bx.w : (bx.w !== undefined ? bx.w : 5)] || WHITE) : WHITE
      ctx.lineWidth = 2
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      if (isWpn) { ctx.beginPath(); ctx.rect(sx - 7 * k2, sy - 7 * k2, 14 * k2, 14 * k2); ctx.fill(); ctx.stroke() }
      else { ctx.beginPath(); ctx.arc(sx, sy, 8 * k2, 0, 7); ctx.fill(); ctx.stroke() }
      if (popAge < 300) { // 落地尘环
        ctx.strokeStyle = 'rgba(245,222,156,' + (0.7 * (1 - popAge / 300)) + ')'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(sx, sy, 10 + popAge / 300 * 14, 0, 7); ctx.stroke()
        if (bx.led9 == null) bx.led9 = fxT('F09')
        fxD(bx.led9)
      }
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
    /* 己席（预测位；白圈描边=阵营双编码形状通道 §7）+F03 受击微击退渲染偏移（3px 外推
     * 回弹 200ms——纯渲染层不入判定/预测域，§3.2 同律） */
    if (S.me && S.me.al && haveVis) {
      const hAge = now - S.hurt.at
      const hK = hAge < 200 ? (1 - hAge / 200) : 0
      const hDx = hK ? Math.cos(S.hurt.ang) * hK * 3 : 0, hDy = hK ? Math.sin(S.hurt.ang) * hK * 3 : 0
      const [sx, sy] = w2s(vis.x, vis.y)
      drawBean(sx + hDx, sy + hDy, 12 + Math.floor((S.me.sh || 0) / 30), '#FFF3D6', IN.aim || 0, true, S.me)
      if (S.me.hp === undefined) { /* noop */ }
      ctx.strokeStyle = WHITE; ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(sx + hDx, sy + hDy, 12 + Math.floor((S.me.sh || 0) / 30) + 4, 0, 7); ctx.stroke()
      if (hK > 0) { // F03 受击闪白（200ms 白罩+屏缘红晕由 drawFx vignette 承担）
        ctx.fillStyle = 'rgba(255,255,255,' + (0.75 * hK) + ')'
        ctx.beginPath(); ctx.arc(sx + hDx, sy + hDy, 12 + Math.floor((S.me.sh || 0) / 30), 0, 7); ctx.fill()
      }
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
    hudDraw(now, w2s)
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
        fxD(fx.led)
      } else if (fx.kind === 'hitmark' && age < 160) {
        ctx.strokeStyle = 'rgba(255,255,255,' + (1 - age / 160) + ')'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(W / 2 - 8, H / 2 - 8); ctx.lineTo(W / 2 + 8, H / 2 + 8); ctx.moveTo(W / 2 + 8, H / 2 - 8); ctx.lineTo(W / 2 - 8, H / 2 + 8); ctx.stroke()
        fxD(fx.led)
      } else if (fx.kind === 'dmgnum' && age < 700) {
        const me = S.me
        const [sx, sy] = w2s((S.ents.get(fx.a.seat) || { cur: {} }).cur.x || 0, (S.ents.get(fx.a.seat) || { cur: {} }).cur.y || 0)
        ctx.fillStyle = '#B3392E'
        ctx.font = HF('P0', 'dmg', 13, '700')
        ctx.textAlign = 'center'
        ctx.fillText('-' + fx.a.dmg, sx, sy - 16 - age / 700 * 14)
        fxD(fx.led)
      } else if (fx.kind === 'healfx' && age < 600) {
        ctx.fillStyle = 'rgba(61,220,132,' + (1 - age / 600) + ')'
        ctx.font = HF('P0', 'heal', 13, '600')
        ctx.textAlign = 'center'
        ctx.fillText('+' + fx.a.v, W / 2, H / 2 - 30 - age / 600 * 10)
        fxD(fx.led)
      } else if (fx.kind === 'stormToast' && age < 1600) {
        bannerDraw('圈开始收缩', age / 1600)
        fxD(fx.led)
      } else if (fx.kind === 'pickbadge' && age < 200) {
        ctx.strokeStyle = 'rgba(61,220,132,' + (1 - age / 200) + ')'
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.arc(W / 2, H / 2, 20 + age / 2, 0, 7); ctx.stroke()
        fxD(fx.led)
      } else if (fx.kind === 'killfeed' && age < 80) { // F04 播报（feed 列表本体在 hudDraw 常画——此为触发首绘打点窗）
        fxD(fx.led)
      } else if (fx.kind === 'hurtflash' && age < 300) { // F03 绘制本体=己席白闪+屏缘红晕（主路径）；此分支承载台账双时戳
        fxD(fx.led)
      } else if (fx.kind === 'koshake' && age < 240) { // F05 绘制本体=镜头 shake 段（世界层微抖）
        fxD(fx.led)
      } else if (fx.kind === 'confetti' && age < 700) { // F08 糖粒雨（§3.4 signature：糖豆爆成彩色糖粒）
        if (!fx.parts) {
          const vic = fx.a.seat === S.seat ? (haveVis ? { x: vis.x, y: vis.y } : (S.me || {})) : ((S.ents.get(fx.a.seat) || {}).cur || {})
          fx.parts = []
          for (let i = 0; i < 14; i++) fx.parts.push({ dx: (Math.random() - 0.5) * 44, dy: -6 - Math.random() * 26, g: 0.12 + Math.random() * 0.1, c: SKINS[fx.a.seat % 8] })
          fx.px = vic.x || 1200000; fx.py = vic.y || 1200000
        }
        const [sx, sy] = w2s(fx.px, fx.py)
        const k2 = age / 700
        for (const p2 of fx.parts) {
          ctx.globalAlpha = 1 - k2
          ctx.fillStyle = p2.c
          ctx.fillRect(sx + p2.dx * k2 - 2, sy + p2.dy * k2 + p2.g * k2 * k2 * 160 - 2, 4, 4)
        }
        ctx.globalAlpha = 1
        fxD(fx.led)
      } else if (fx.kind === 'airdropMark' && age < 2000) { // F10 空投标落点（金圈脉冲+toast）
        const [sx, sy] = w2s(fx.a.x, fx.a.y)
        ctx.strokeStyle = 'rgba(255,224,102,' + (0.9 * (1 - age / 2000)) + ')'
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.arc(sx, sy, 34 - age / 2000 * 18, 0, 7); ctx.stroke()
        if (age < 1400) bannerDraw('空投标落点', age / 1400)
        fxD(fx.led)
      } else if (fx.kind === 'boostfx' && age < 500) {
        ctx.strokeStyle = 'rgba(111,200,255,' + (1 - age / 500) + ')'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(W / 2, H / 2, 16 + age / 500 * 26, 0, 7); ctx.stroke()
        fxD(fx.led)
      }
    }
    /* F03 受击屏缘红晕 + F06 毒圈逼近边缘警示（径向渐晕脉冲——渲染层零判定；
     * warnForce=QA 驱动窗（真实态由圈边距判定，驱动面同路径）） */
    let vign = 0, vcol = '208,90,122'
    const hAge = now - S.hurt.at
    if (hAge < 300 && S.me && S.me.al) vign = Math.max(vign, 0.55 * (1 - hAge / 300))
    let edgeOn = false
    if (S.phase === 'live' && S.me && S.me.al && haveVis) {
      const c = stormAt(S.frame)
      const dEdge = c.r - Math.hypot((vis.x || 0) - c.cx, (vis.y || 0) - c.cy) // 圈边距（正=圈内余量）
      if (dEdge < 120000) edgeOn = true
    }
    if (S.warnForce && now - S.warnForce < 2000) edgeOn = true
    if (edgeOn) {
      vign = Math.max(vign, (0.35 + 0.25 * Math.sin(now / 140)) * 0.9)
      if (!S.led06) S.led06 = fxT('F06')
      fxD(S.led06) // F06 首绘打点（警示渐晕在场）
    }
    if (vign > 0.01) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.62)
      g.addColorStop(0, 'rgba(' + vcol + ',0)')
      g.addColorStop(1, 'rgba(' + vcol + ',' + vign.toFixed(3) + ')')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
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

  /* ---------- HUD（顶栏+小地图+武器栏；HF __applied 自证；FEEL 面：feed/浮标/边缘指示） ---------- */
  function hudDraw(now, w2s) {
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
    /* ping 徽标（P0 13px/600，T7-A 升档；F-4 账本展示面 F12：末值+滚动窗均值双读
     * ——「低延迟竞技」卖点的可信口径；观战/淘汰态同款常驻（hudDraw 全相位跑）） */
    const ping = S.rec.pings.length ? S.rec.pings[S.rec.pings.length - 1] : 0
    const pingAvg = S.rec.pings.length ? Math.round(S.rec.pings.reduce((a, b) => a + b, 0) / S.rec.pings.length) : 0
    ctx.fillStyle = ping > 250 ? '#FF8A7A' : ping > 120 ? '#FFE066' : '#7DE8A8'
    ctx.textAlign = 'right'
    ctx.font = HF('P0', 'ping', 13, '600')
    ctx.fillText(ping ? ping + 'ms' : '—', W - 76, 20)
    if (S.rec.pings.length) { if (!S.led12) S.led12 = fxT('F12'); fxD(S.led12) } // F12 常驻态首绘打点
    if (S.rec.pings.length >= 2) { // 均值小字（P2 9px——滚动窗 20 条≈100s 履历）
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.font = HF('P2', 'pingavg', 9, '400')
      ctx.fillText('均 ' + pingAvg, W - 76, 32)
    }
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
    /* 拾取钮浮现条件：28px 吸附圈内有箱（§3.3 ≤1 帧）；F11 浮标锚=最近箱对象 */
    S.pickTarget = -1; S.pickBox = null
    if (S.phase === 'live' && haveVis) {
      let bd = 28000 * 28000, tgt = -1, tbx = null
      for (const [id, bx] of S.boxMap) {
        if (!bx.on) continue
        const dx = bx.x - vis.x, dy = bx.y - vis.y
        const d2 = dx * dx + dy * dy
        if (d2 < bd) { bd = d2; tgt = Number(id.slice(1)); tbx = bx }
      }
      S.pickTarget = tgt; S.pickBox = tbx
    }
    /* F04 kill feed（击杀淘汰播报：顶栏下右侧 3 行 4s 淡出；我参与行金色——§3.4） */
    S.feed = S.feed.filter((f) => now - f.at < 4000)
    for (let i = 0; i < S.feed.length; i++) {
      const f = S.feed[i]
      const k2 = Math.min(1, (now - f.at) / 200) * (1 - Math.max(0, (now - f.at - 3200) / 800))
      ctx.fillStyle = f.mine ? 'rgba(255,224,102,' + (0.9 * k2) + ')' : 'rgba(23,83,122,' + (0.72 * k2) + ')'
      ctx.fillRect(W - 158, TOP_H + 6 + i * 22, 150, 18)
      ctx.fillStyle = f.mine ? INK : WHITE
      ctx.font = HF('P1', 'feed', 11, '600')
      ctx.textAlign = 'left'
      ctx.fillText(f.txt, W - 152, TOP_H + 19 + i * 22)
    }
    /* F11 拾取浮标（28px 吸附圈虚线+最近箱高亮脉冲+箱顶 chevron 浮动——§3.3 可读面） */
    if (S.pickTarget >= 0 && S.pickBox && S.phase === 'live' && haveVis) {
      const [px2, py2] = [W / 2, H / 2]
      const bob = Math.sin(now / 180) * 3
      const [bxs, bys] = w2s(S.pickBox.x, S.pickBox.y)
      const d2me = Math.hypot(S.pickBox.x - vis.x, S.pickBox.y - vis.y)
      if (d2me < 60000) { // 箱在屏内才画 chevron（浮标=拾取对象指示）
        ctx.strokeStyle = 'rgba(125,232,168,' + (0.7 + 0.3 * Math.sin(now / 150)) + ')'
        ctx.lineWidth = 2.5
        ctx.setLineDash([])
        ctx.beginPath(); ctx.moveTo(bxs - 5, bys - 16 + bob); ctx.lineTo(bxs, bys - 22 + bob); ctx.lineTo(bxs + 5, bys - 16 + bob); ctx.stroke()
        if (!S.led11) S.led11 = fxT('F11')
        fxD(S.led11)
      }
      /* 吸附圈（世界 28px→屏幕；仅半透明提示，不抢钮面） */
      ctx.strokeStyle = 'rgba(125,232,168,0.4)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.arc(px2, py2, 28000 * 0.55 / 30, 0, 7); ctx.stroke()
      ctx.setLineDash([])
    }
    /* F15 边缘席位指示（观战态：屏外存活席位→屏缘三角+距离 m——O-1 后续；mm 1Hz） */
    if (S.phase === 'dead' || (S.seat < 0 && S.phase === 'live')) {
      const cx2 = S.cam.x, cy2 = S.cam.y
      let drew = false
      for (const d of S.mm || []) {
        if (d[0] === S.seat) continue
        const [mx, my] = w2s(d[1] * 1000, d[2] * 1000)
        if (mx > 20 && mx < W - 20 && my > TOP_H + 20 && my < H - 20) continue // 屏内不标
        const ang = Math.atan2(my - H / 2, mx - W / 2)
        const ex = Math.max(24, Math.min(W - 24, W / 2 + Math.cos(ang) * (W / 2 - 30)))
        const ey = Math.max(TOP_H + 30, Math.min(H - 30, H / 2 + Math.sin(ang) * (H / 2 - 44)))
        ctx.fillStyle = SKINS[d[0] % 8]
        ctx.beginPath(); ctx.moveTo(ex + Math.cos(ang) * 7, ey + Math.sin(ang) * 7)
        ctx.lineTo(ex + Math.cos(ang + 2.5) * 6, ey + Math.sin(ang + 2.5) * 6)
        ctx.lineTo(ex + Math.cos(ang - 2.5) * 6, ey + Math.sin(ang - 2.5) * 6); ctx.fill()
        const distM = Math.round(Math.hypot(d[1] * 1000 - cx2, d[2] * 1000 - cy2) / 1000)
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.font = HF('P2', 'pip', 9, '400')
        ctx.textAlign = 'center'
        ctx.fillText(distM + 'm', ex, ey + 18)
        drew = true
      }
      if (drew) { if (!S.led15) S.led15 = fxT('F15'); fxD(S.led15) }
    }
    /* 决赛圈心跳（alive≤3 低鼓点 1Hz——§3.4 终局张力；静音记账只留 fired 证据） */
    if (S.phase === 'live' && S.alive <= 3 && S.alive > 1) {
      if (now - (S.lastBeat || 0) > 700) { S.lastBeat = now; sfx('finalBeat') }
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
    /* F14 淘汰信息卡（O-2 承接 §4.3）：rank/击杀/在场时长/ping 双读/击杀者——半卡不遮
     * 观战场（下移 H/3 带+世界层照常渲染，观战内容=KO 横幅/feed/边缘指示） */
    const secs = Math.max(0, Math.round((S.deadFrame - S.startFrame) * 50 / 1000))
    const killer = S.killedBy >= 0 ? 'P' + (S.killedBy + 1) : '毒圈'
    const ping = S.rec.pings.length ? S.rec.pings[S.rec.pings.length - 1] : 0
    const pingAvg = S.rec.pings.length ? Math.round(S.rec.pings.reduce((a, b) => a + b, 0) / S.rec.pings.length) : 0
    ctx.fillStyle = 'rgba(23,83,122,0.72)'
    ctx.fillRect(0, H / 3, W, H / 3)
    ctx.fillStyle = WHITE
    ctx.textAlign = 'center'
    ctx.font = HF('P0', 'dead', 15, '700')
    ctx.fillText('被淘汰 · 排名 ' + ((S.me && S.me.rank) || '—'), W / 2, H / 3 + 26)
    ctx.font = HF('P1', 'deadsub', 11, '400')
    ctx.fillText('击杀 ' + S.kills + ' · 在场 ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + ' · 被 ' + killer + ' 淘汰', W / 2, H / 3 + 48)
    ctx.fillText('延迟 ' + (ping || '—') + 'ms（均 ' + (pingAvg || '—') + '）—— 链路没吃掉你的走位', W / 2, H / 3 + 68)
    ctx.fillStyle = '#7DE8A8'
    ctx.font = HF('P1', 'deadcta', 11, '600')
    ctx.fillText(S.camMode === 'lead' ? '观战：跟随领先者（tap 切圈心全景）' : '观战：圈心全景（tap 切回领先者）', W / 2, H / 3 + 92)
    if (!S.led14) S.led14 = fxT('F14')
    fxD(S.led14)
  }
  function endDraw() {
    const r = S.endInfo || {}
    if (!S.endWhistled) { S.endWhistled = 1; sfx('endWhistle') }
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
      'ping 末值 ' + (rec.pings.length ? rec.pings[rec.pings.length - 1] : '—') + 'ms · 均值 ' + (rec.pings.length ? Math.round(rec.pings.reduce((a, b) => a + b, 0) / rec.pings.length) : '—') + 'ms',
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

  /* ---------- debug 面（perf-smoke/识图/feel-check 契约） ---------- */
  const pingAvgOf = () => S.rec.pings.length ? Math.round(S.rec.pings.reduce((a, b) => a + b, 0) / S.rec.pings.length) : 0
  function fxScene(name) { // 手感场景驱动（QA 取证入口：合成事件走同一 onEvent 管线）
    const other = (S.seat + 1) % 20
    const vis0 = haveVis ? vis : { x: 1200000, y: 1200000 }
    if (name === 'hitmark') onEvent({ k: 'hit', seat: other, by: S.seat, dmg: 12, hp: 88, sh: 0 }, S.frame) // F01/F02
    else if (name === 'hurt') onEvent({ k: 'hit', seat: S.seat, by: other, dmg: 15, hp: 85, sh: 0 }, S.frame) // F02/F03
    else if (name === 'kill') onEvent({ k: 'elim', seat: other, by: S.seat, rank: 5 }, S.frame) // F04/F05/F08（KO 大字+糖粒雨+震屏）
    else if (name === 'killme') { // F13/F14 观战视图全链（真切换 dead；QA 注入领先者——合成淘汰不驱动服务端 AOI，ents 无 lead 则镜头退圈心，注入使跟随面可断）
      if (S.phase === 'live') {
        if (!S.lb.length) S.lb = [[other, 1, 0]]
        const lead = S.lb[0][0]
        if (lead !== S.seat && !S.ents.get(lead)) {
          S.leadInjected = { x: (haveVis ? vis.x : 1200000) + 90000, y: (haveVis ? vis.y : 1200000) - 70000 }
          S.ents.set(lead, { cur: { ...S.leadInjected }, buf: [] })
        } else if (lead !== S.seat) { const c2 = (S.ents.get(lead) || {}).cur || {}; S.leadInjected = { x: c2.x || 1290000, y: c2.y || 1200000 } }
        onEvent({ k: 'elim', seat: S.seat, by: other, rank: 5 }, S.frame)
      }
    }
    else if (name === 'pick') onEvent({ k: 'pick', seat: S.seat, id: 'b0', k2: 'wpn', w: 2, it: 1 }, S.frame) // F07
    else if (name === 'airdrop') onEvent({ k: 'airdrop', x: vis0.x + 60000, y: vis0.y - 40000, box: 'b' + Math.floor(Math.random() * 1e6) }, S.frame) // F10
    else if (name === 'boom') addFx('boom', vis0.x + 40000, vis0.y - 30000) // F16（冲击环）
    else if (name === 'edge') { S.warnForce = performance.now() } // F06（警示渐晕驱动窗——真实态=圈边距判定同路径）
    else if (name === 'box') { // F09（drop 事件驱动音效+箱首见弹出锚）
      const bid = 'b' + Math.floor(Math.random() * 1e6)
      S.boxMap.set(bid, { id: bid, k: 'wpn', w: 3, x: vis0.x + 30000, y: vis0.y + 22000, on: 1, pop: performance.now() })
      onEvent({ k: 'drop', seat: other, box: bid }, S.frame)
    }
    else if (name === 'bob') { // F11（吸附圈内箱——28px 吸附判定按 boxMap 就近）
      const bid = 'b' + Math.floor(Math.random() * 1e6)
      S.boxMap.set(bid, { id: bid, k: 'med', x: haveVis ? vis.x + 20000 : 1200000, y: haveVis ? vis.y + 8000 : 1200000, on: 1, pop: performance.now() })
    }
    else if (name === 'storm') { const v = S.storm || { p: 0, t0: 0, t1: 100, r0: 1200000, r1: 700000, x0: 1200000, y0: 1200000, x1: 1200000, y1: 1200000 }; onEvent(Object.assign({ k: 'storm' }, v), S.frame) } // F17（当前参数回放=零态变）
    else if (name === 'heal') onEvent({ k: 'heal', seat: S.seat, v: 25 }, S.frame) // F16
    else if (name === 'boost') onEvent({ k: 'boost', seat: S.seat }, S.frame) // F19
    else if (name === 'specfree') { S.camMode = S.camMode === 'lead' ? 'free' : 'lead' } // F13 镜头模式切换（不切 phase 的轻量驱动）
    return true
  }
  window.__GAMES_DEBUG__ = {
    hudFonts,
    state: () => ({
      phase: S.phase, seat: S.seat, role: S.role, frame: S.frame, ack: S.ack, seq: S.seq, alive: S.alive, rec: S.rec,
      fxLedger: fxLedgerArr, camMode: S.camMode, specSeat: S.phase === 'dead' || S.seat < 0 ? specTargetPos().seat : -1,
      cam: { x: Math.round(S.cam.x), y: Math.round(S.cam.y) }, ping: S.rec.pings.length ? S.rec.pings[S.rec.pings.length - 1] : 0, pingAvg: pingAvgOf(),
      feedN: S.feed.length, killedBy: S.killedBy, deadFrame: S.deadFrame, startFrame: S.startFrame, kills: S.kills, rank: S.me && S.me.rank,
    }),
    stormNow: () => stormAt(S.frame),
    predProbe: () => ({ // GAMES-178 预测域取证面：flight/simTick/偏差带逐快照账本+视觉步长台账（§5.3 激活态证据）
      flight: S.flight, simTick: S.simTick, lastFrame: S.lastFrame, seq: S.seq, ack: S.ack,
      rec: { n: S.rec.n, soft: S.rec.soft, hard: S.rec.hard, maxPx: S.rec.maxPx, sum: S.rec.sum },
      predLog: S.predLog.slice(), visSteps: visLedger.slice(),
    }),
    projsN: () => S.projs.size,
    entsN: () => S.ents.size,
    pause: (v) => { paused = !!v },
    perf: () => {
      const cs = perfLog.costs.slice(-180), gs = perfLog.gaps.slice(-180)
      const avg = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0
      const sorted = cs.slice().sort((a, b) => a - b)
      const gAvg = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0
      return { n: cs.length, costAvgMs: +avg.toFixed(2), costP95Ms: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2), costJankPct: +(cs.filter((c) => c > 25).length / Math.max(1, cs.length) * 100).toFixed(2), rafGapMs: +gAvg.toFixed(1) }
    },
    fxProbe: (ev) => { onEvent(ev, S.frame); return true }, // 合成事件走同一 onEvent 管线
    __leadPos: () => S.leadInjected || null, // killme 注入领先者位（feel-check 贴合断言锚——QA 面）
    fxScene,
    fxList: () => FXLIST.map((f) => ({ id: f[0], name: f[1], cls: f[2] })),
    fxLedger: () => fxLedger.map((l) => ({ id: l.id, trig: Math.round(l.trig), lat: l.lat })),
    fxLatMin: () => ({ ...fxLatMin }), // 持久最小首绘表（热房洪水不冲——feel-check FE-2 断言锚）
    sfxGroups: () => ({ on: SND.on, slots: SND.slots.slice(), fired: Object.keys(SND.fired), calls: SND.calls.slice() }),
    sndOn: (v) => { SND.on = !!v },
  }
  connect()
})()
