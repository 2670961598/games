/* =====================================================================
 * 迷你MOBA mini-moba 客户端（GAMES-127 · E6/W2/T2）——S2 状态同步第二款。
 * 服务端权威 10Hz 快照；本地=移动预测（同式积分+指数收敛和解）、敌人 120ms
 * 插值、弹道/前摇乐观表现（伤害数字只等权威 hit 事件，设计 §5.5）。
 * HUD 字号 HF 登记（hud-font-standard §1 分级，__GAMES_DEBUG__.hudFonts() 自证）；
 * 阵营双色+形状第二通道（§7）；技能类型×形状双编码。
 * GAMES-131 手感层：FXLIST 动效登记表（fb 反馈类 ≤80ms 首绘红线）+ fxLedger
 * 双时戳台账 + SND 音效位（makeSound 平台范式：总闸门默认静音只记账）+
 * HUD 反馈强化（CD 环既有/血条受击闪/小地图敌消失警示/金币跳动/KDA 闪）。
 * 时基修正：fx 时戳统一 performance.now()（与 rAF now 同域）——旧实现
 * Date.now() 与 rAF 混用致飘字/播报条/购买提示/拒绝红闪 age 恒负（飘字画在
 * 屏外坐标、播报条永不过期），本单一并修正。
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
  var SKILL_DASH = { charge: 1, blink: 1 } // 位移系（音效位分槽用）
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
  var fx = { shots: [], zones: [], floats: [], feed: [], shakes: 0, recall: 0, rejectAt: 0, buyToast: null,
    parts: [], rings: [], vign: null, miss: [], badge: null, bless: null, revive: null, lvPop: null,
    grassIn: false, grassT: 0, grassRec: null, grassA: 0, goldAt: -1e9, goldRec: null, kdaAt: -1e9, kdaRec: null,
    slowUntil: 0, slowAcc: 0, recallFx: null, recallBreakAt: -1e9 }
  var cam = { x: 500, y: 850 }
  var inputTimer = null, lastSent = 0
  var windup = null        // {idx, until} 前摇乐观弧
  var deadOverlay = null
  var kol = { graves: [] }
  var lastFoes = {}        // 敌方英雄上次可见位（F15 消失警示锚）
  var prevMe = null        // ext.me 上拍（金币/KDA 变动检测）

  /* ---------- 手感层登记表（GAMES-131） ----------
   * FXLIST：[id, 名称, fb|state]——fb=反馈类（事件→首绘 ≤80ms 红线，台账断言），
   * state=演出类（长驻/编排，只报数不断言）。fxT=事件侧时戳、fxD=渲染侧首绘
   * 打点，lat=首绘时延（fxLedger 供 QA 复跑）。 */
  var pnow = performance.now.bind(performance)
  var FXLIST = [
    ['F01', 'castRing', 'fb'],    // 技能施法光环（shot/zone 事件 → from 位扩散环）
    ['F02', 'hitBurst', 'fb'],    // 命中爆点（hit 事件 → 受击者粒子+飘字首绘）
    ['F03', 'killBurst', 'fb'],   // 击杀特效（阵营色碎裂粒子+全屏暗角+播报条）
    ['F04', 'goldCoin', 'fb'],    // 补刀金币（kill.bounty 赏金币飘字）
    ['F05', 'towerRubble', 'fb'], // 推塔震屏碎石雨（tower 事件）
    ['F06', 'lvAura', 'fb'],      // 升级光环（快照 lv 抬升 → 金环+升 L 提示）
    ['F07', 'recallBeam', 'state'], // 回城引导光束（recall start → 环绕环+引导条）
    ['F08', 'revivePillar', 'state'], // 复活泉水光柱（dead→alive 转换，§3.5）
    ['F09', 'streakBadge', 'state'],  // 连杀播报徽章（kill.streak≥2 强化条幅）
    ['F10', 'buyPop', 'fb'],      // 装备购买反馈（buy 事件 → 购买提示弹跳+装备格金闪）
    ['F11', 'grassFade', 'state'], // 草丛进出过渡（本地位置检测 → 叶片+遮蔽渐变）
    ['F12', 'shrineBless', 'state'], // 圣所祝祷特效（shrine 事件 → 金辉横幅+己方光罩）
    ['F13', 'kdaFlash', 'fb'],    // KDA 变动闪（ext.me 三元组变化 → 顶栏高亮）
    ['F14', 'hpFlash', 'fb'],     // 血条受击闪（hp 下降 → 白闪覆盖；回升 → 绿闪）
    ['F15', 'missMark', 'fb'],    // 小地图敌消失警示（AOI/草丛失去目标 → ? 标记）
    ['F16', 'goldBounce', 'fb'],  // 金币跳动（收入即弹跳：被动/补刀/赏金）
  ]
  var fxLedger = []
  function fxT(id) { fxLedger.push({ id: id, trig: pnow(), lat: null }); if (fxLedger.length > 200) fxLedger.shift(); return fxLedger[fxLedger.length - 1] }
  function fxD(rec) { if (rec && rec.lat == null) rec.lat = Math.max(0, Math.round(pnow() - rec.trig)) }

  /* 音效位（makeSound 平台范式：总闸门默认静音只记账；开启后 WebAudio 简音色占位） */
  var SND = { on: false, slots: ['atk', 'skillCast', 'skillDash', 'skillAoe', 'hit', 'kill', 'streak', 'tower', 'core', 'lvup', 'buy', 'recall', 'revive', 'death', 'shrine', 'reject', 'miss'], calls: [], ac: null }
  function sfx(slot) {
    SND.calls.push({ g: slot, at: Math.round(pnow()) })
    if (SND.calls.length > 300) SND.calls.shift()
    if (!SND.on) return
    try {
      if (!SND.ac) SND.ac = new (window.AudioContext || window.webkitAudioContext)()
      var a = SND.ac, o = a.createOscillator(), g = a.createGain(), t = a.currentTime
      var hi = { skillCast: 1, skillAoe: 1, skillDash: 1, lvup: 1, revive: 1, shrine: 1, streak: 1, kill: 1 }
      o.type = (slot === 'hit' || slot === 'atk') ? 'square' : 'sine'
      var f0 = hi[slot] ? 720 : 340, f1 = hi[slot] ? 1240 : 180
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + 0.12)
      g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.14)
    } catch (e) { /* 无音频环境静默 */ }
  }

  /* ---------- 粒子/扩散环（表现层外推，闭式位置=帧率无关） ---------- */
  function burst(x, y, col, n, spd, grav) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = spd * (0.5 + Math.random() * 0.7)
      fx.parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - spd * 0.35, at: pnow(), dur: 460 + Math.random() * 240, col: col, sz: 1.6 + Math.random() * 1.8, g: grav == null ? 0.06 : grav })
    }
    if (fx.parts.length > 220) fx.parts.splice(0, fx.parts.length - 220)
  }
  function ring(x, y, r1, col, w, rec) { fx.rings.push({ x: x, y: y, at: pnow(), dur: 380, r1: r1, col: col, w: w || 2.5, rec: rec || null }); if (fx.rings.length > 40) fx.rings.shift() }

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
      var pe = r.prev
      if (pe) {
        if (e.lv > pe.lv) { // F06 升级光环（快照 lv 抬升）
          ring(pred.x, pred.y, 46, '#E8C46A', 3)
          fx.lvPop = { lv: e.lv, at: pnow(), rec: fxT('F06') }
          sfx('lvup')
        }
        if (e.hp < pe.hp) { r.hpFlash = 220; r.hpRec = fxT('F14') } // F14 血条受击闪（白）
        else if (e.hp > pe.hp) { r.healFlash = 260; r.hpRec = fxT('F14') }
        if (pe.dead && !e.dead) { // F08 复活泉水光柱（§3.5）
          var fo = MAP.fountains[myTeam]
          ring(fo[0], fo[1], 60, TEAM_COL[myTeam], 3)
          fx.revive = { at: pnow(), rec: fxT('F08') }
          sfx('revive')
        }
      }
      r.prev = { lv: e.lv, hp: e.hp, dead: !!e.dead }
    } else if (e.k === 'hero') {
      var p2 = r.prev
      if (p2 && e.hp < p2.hp) { r.hpFlash = 200; r.hpRec = fxT('F14') } // 敌我英雄血条同制
      r.prev = { hp: e.hp }
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
    /* F15 敌人消失警示：上拍可见的敌方英雄本拍不在 ents（AOI 收离/草丛隐身）
     * → 小地图留 ? 标记 3s（末次可见位） */
    var foesNow = {}
    for (var fid in ents) {
      var fe = ents[fid].ent
      if (fe.k === 'hero' && fe.hp > 0 && fe.team !== myTeam) foesNow[fid] = { x: fe.x / K, y: fe.y / K }
    }
    for (var pf in lastFoes) if (!foesNow[pf]) {
      var lr = lastFoes[pf]
      fx.miss.push({ x: lr.x, y: lr.y, at: pnow(), rec: fxT('F15') })
      if (fx.miss.length > 6) fx.miss.shift()
      sfx('miss')
    }
    lastFoes = foesNow
    if (msg.events) for (var e = 0; e < msg.events.length; e++) onEvent(msg.events[e])
  }

  /* ---------- 事件 → 表现（ruling 账本=juice 零 diff 触发，§5.3） ---------- */
  function onEvent(ev) {
    if (ev.k === 'hit') {
      var r = ents[ev.vic]
      if (r) { r.flash = 80; if (r.hpFlash == null) r.hpFlash = 0; r.hpFlash = Math.max(r.hpFlash, 220) }
      var hx = r ? r.ent.x / K : cam.x, hy = r ? r.ent.y / K : cam.y
      fx.floats.push({ x: hx, y: hy, txt: (ev.m ? '✦' : '⚔') + ev.dmg, magic: !!ev.m, at: pnow(), rec: fxT('F02') })
      burst(hx, hy, ev.m ? '#B48CE8' : '#F2F2F2', 5, 60, 0.04) // F02 命中爆点
      sfx('hit')
    } else if (ev.k === 'shot') {
      var f = ev.from ? [ev.from[0] / K, ev.from[1] / K] : [cam.x, cam.y]
      var to = ev.to ? [ev.to[0] / K, ev.to[1] / K]
        : (ev.dir ? [f[0] + ev.dir[0] * (ev.maxDist || 300) / K, f[1] + ev.dir[1] * (ev.maxDist || 300) / K] : [f[0], f[1] - 3])
      var srec = ev.skill ? fxT('F01') : null
      fx.shots.push({ x: f[0], y: f[1], tx: to[0], ty: to[1], at: pnow(), dur: 320, magic: ev.skill ? true : false, rec: srec })
      if (ev.skill) { // F01 施法光环（法系弹道起点扩散环）+ 三系音效位
        ring(f[0], f[1], 30, '#9D6FE8', 2, srec)
        sfx(SKILL_DASH[ev.skill] ? 'skillDash' : 'skillCast')
      } else sfx('atk')
    } else if (ev.k === 'zone') {
      var zrec = fxT('F01') // F01 区域技施法（预警圈=施法表现）
      fx.zones.push({ x: ev.x / K, y: ev.y / K, r: ev.r / K, at: pnow(), warn: ev.at * 100, skill: ev.skill, dur: ev.skill === 'star' ? 400 : (ev.dur || 30) * 100, rec: zrec })
      ring(ev.x / K, ev.y / K, (ev.r / K) + 14, 'rgba(232,196,106,.9)', 2, zrec)
      sfx('skillAoe')
    } else if (ev.k === 'kill') {
      var kn = (ev.killer >= 0 ? '席' + ev.killer : '防御塔') + ' ⚔ 席' + ev.victim
      var kTeam = ev.killer >= 0 ? (ev.killer % 2 === 0 ? 'A' : 'B') : 'W'
      var vr = ents['h' + ev.victim], kx = vr ? vr.ent.x / K : cam.x, ky = vr ? vr.ent.y / K : cam.y
      fx.feed.push({ txt: kn, streak: ev.streak, at: pnow(), team: kTeam, rec: fxT('F03') })
      if (fx.feed.length > 3) fx.feed.shift()
      burst(kx, ky, TEAM_COL[ev.victim % 2 === 0 ? 'A' : 'B'], 14, 120, 0.06) // F03 阵营色碎裂（§3.5）
      fx.vign = { at: pnow(), dur: 220 } // F03 全屏暗角（§3.4）
      if (ev.killer === mySeat) fx.slowUntil = pnow() + 300 // 击杀者慢放（渲染层 fx 时钟 0.35×）
      fx.shakes = Math.max(fx.shakes, ev.streak >= 2 ? 6 : 2)
      if (ev.bounty > 0) { // F04 补刀金币（击杀赏金）
        fx.floats.push({ x: kx, y: ky - 26, txt: '◎+' + ev.bounty, gold: true, at: pnow(), rec: fxT('F04') })
        if (ev.killer === mySeat) { fx.goldAt = pnow(); fx.goldRec = fxT('F16') }
      }
      if (ev.streak >= 2) { // F09 连杀播报徽章（强化条幅，§3.4）
        fx.badge = { n: ev.streak, at: pnow(), team: kTeam, rec: fxT('F09') }
        sfx('streak')
      }
      sfx('kill')
      if (ev.victim === mySeat) { deadOverlay = { respAt: ev.respAt }; sfx('death') }
    } else if (ev.k === 'tower') {
      fx.feed.push({ txt: (ev.team === 'A' ? 'A' : 'B') + ' 方 ' + (ev.tier === 1 ? '外塔' : '高地塔') + ' 告破', at: pnow(), team: ev.team === 'A' ? 'B' : 'A', rec: fxT('F05') })
      var tw = MAP.towers[ev.tid], tx = tw ? tw[0] : cam.x, ty = tw ? tw[1] : cam.y
      for (var ri = 0; ri < 16; ri++) fx.parts.push({ x: tx + (Math.random() - 0.5) * 30, y: ty - 10 - Math.random() * 26, vx: (Math.random() - 0.5) * 90, vy: -40 - Math.random() * 90, at: pnow(), dur: 620, col: '#8a94a0', sz: 2 + Math.random() * 2, g: 0.55 }) // F05 碎石雨
      fx.shakes = 8
      sfx('tower')
    } else if (ev.k === 'core') {
      fx.shakes = 10
      var co = MAP.cores['core-' + ev.team]
      if (co) { burst(co[0], co[1], TEAM_COL[ev.team], 26, 190, 0.05); ring(co[0], co[1], 90, TEAM_COL[ev.team], 4) }
      fx.vign = { at: pnow(), dur: 600 }
      sfx('core')
    }
    else if (ev.k === 'shrine') { // F12 圣所祝祷特效
      fx.feed.push({ txt: ev.team + ' 队夺得圣所祝祷！', at: pnow(), team: ev.team, rec: fxT('F12') })
      fx.bless = { at: pnow(), team: ev.team, rec: fxT('F12') }
      sfx('shrine')
    }
    else if (ev.k === 'camp') { // 营地：灵纹拾取轻特效（副产物）
      if (ev.buff && ev.by === mySeat) { fx.goldAt = pnow(); fx.goldRec = fxT('F16') }
    }
    else if (ev.k === 'recall') {
      if (ev.seat === mySeat) {
        if (ev.phase === 'start') { // F07 回城引导光束
          fx.recall = 40
          fx.recallFx = { at: pnow(), rec: fxT('F07') }
          sfx('recall')
        } else if (ev.phase === 'break') {
          fx.recall = 0; fx.recallBreakAt = pnow() // 引导条红闪中断（§3.3）
        } else if (ev.phase === 'done') {
          fx.recall = 0
          var rf = MAP.fountains[myTeam]
          ring(rf[0], rf[1], 52, '#7FE8D0', 3)
        }
      }
    } else if (ev.k === 'buy') {
      if (ev.seat === mySeat) { fx.buyToast = { item: ev.item, at: pnow(), rec: fxT('F10') }; sfx('buy') } // F10 购买反馈
    }
    else if (ev.k === 'reject') { if (ev.seat === mySeat) { fx.rejectAt = pnow(); sfx('reject') } } // HUD 红闪断言源（§5.1）
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
      if (hero && SKILL_UI[hero][idx].w > 0) windup = { idx: idx, until: pnow() + SKILL_UI[hero][idx].w }
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
  function drawHpBar(x, y, w, pct, team, seg, r) {
    ctx.fillStyle = 'rgba(6,10,12,.8)'
    ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 5)
    ctx.fillStyle = TEAM_COL[team]
    if (seg) { // B=分段血条（§7 形状第二通道）
      var n = 4, sw = w / n
      for (var i = 0; i < n; i++) { var segPct = Math.max(0, Math.min(1, pct * n - i)); if (segPct > 0) ctx.fillRect(x - w / 2 + i * sw + 0.5, y, sw * segPct - 1, 3) }
    } else ctx.fillRect(x - w / 2, y, w * Math.max(0, pct), 3)
    if (r) { // F14 血条受击闪：白闪（掉血）/绿闪（回升）覆盖层
      if (r.hpFlash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + (0.75 * r.hpFlash / 220).toFixed(3) + ')'; ctx.fillRect(x - w / 2, y, w * Math.max(0, pct), 3); fxD(r.hpRec); r.hpFlash -= 16 }
      else if (r.healFlash > 0) { ctx.fillStyle = 'rgba(93,232,140,' + (0.7 * r.healFlash / 260).toFixed(3) + ')'; ctx.fillRect(x - w / 2, y, w * Math.max(0, pct), 3); fxD(r.hpRec); r.healFlash -= 16 }
    }
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
        if (own && fx.grassIn) ctx.globalAlpha = 0.6 // F11 草丛内己方半透（遮蔽提示）
        if (r2.flash > 0) { ctx.fillStyle = 'rgba(255,255,255,.6)'; shapePath(x, y, 15, sh, e2.dir ? -e2.dir * Math.PI / 180 : 0); ctx.fill(); r2.flash -= 16 }
        ctx.fillStyle = col
        shapePath(x, y, 12, sh, e2.dir ? -e2.dir * Math.PI / 180 : 0); ctx.fill()
        ctx.strokeStyle = '#0D1B22'; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.globalAlpha = 1
        if (e2.sh > 0) { ctx.strokeStyle = '#E8C46A'; ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2 * Math.min(1, e2.sh / 300)); ctx.stroke() }
        drawHpBar(x, y - 22, 40, e2.hp / e2.maxhp, e2.team, e2.team === 'B', r2)
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
      var t = Math.max(0, (now - s.at) / s.dur)
      if (t >= 1) return false
      var x = s.x + (s.tx - s.x) * t, y = s.y + (s.ty - s.y) * t
      ctx.strokeStyle = s.magic ? 'rgba(180,140,232,.9)' : 'rgba(242,242,242,.9)'
      ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.moveTo(sx(x), sy(y)); ctx.lineTo(sx(x - (s.tx - s.x) * 0.08), sy(y - (s.ty - s.y) * 0.08)); ctx.stroke()
      fxD(s.rec)
      return true
    })
    // 区域（星陨预警圈/箭雨/静滞）
    fx.zones = fx.zones.filter(function (z) {
      var age = Math.max(0, now - z.at)
      if (age > z.dur + 300) return false
      ctx.strokeStyle = z.skill === 'star' ? 'rgba(232,99,61,.85)' : z.skill === 'stasis' ? 'rgba(157,111,232,.8)' : 'rgba(232,163,61,.8)'
      ctx.setLineDash([5, 4]); ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(sx(z.x), sy(z.y), z.r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
      ctx.font = F.p2(); ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'center'
      ctx.fillText(z.skill === 'star' ? '星陨' : z.skill === 'stasis' ? '静滞' : '箭雨', sx(z.x), sy(z.y) - z.r - 4)
      fxD(z.rec)
      return true
    })
    // 扩散环（施法/升级/回城完成/复活）
    fx.rings = fx.rings.filter(function (g) {
      var t = Math.max(0, (now - g.at) / g.dur)
      if (t >= 1) return false
      var r = Math.max(1, 4 + (g.r1 - 4) * (1 - (1 - t) * (1 - t)))
      ctx.strokeStyle = g.col; ctx.lineWidth = g.w
      ctx.globalAlpha = 1 - t
      ctx.beginPath(); ctx.arc(sx(g.x), sy(g.y), r, 0, Math.PI * 2); ctx.stroke()
      ctx.globalAlpha = 1
      fxD(g.rec)
      return true
    })
    // 粒子（碎裂/碎石/叶片，闭式位置）
    fx.parts = fx.parts.filter(function (p) {
      var ts = Math.max(0, (now - p.at) / 1000)
      var t = ts / (p.dur / 1000)
      if (t >= 1) return false
      var px = p.x + p.vx * ts, py = p.y + p.vy * ts + 550 * p.g * ts * ts
      ctx.fillStyle = p.col; ctx.globalAlpha = Math.max(0, 1 - t)
      ctx.fillRect(sx(px) - p.sz / 2, sy(py) - p.sz / 2, p.sz, p.sz)
      ctx.globalAlpha = 1
      return true
    })
    // 伤害飘字（物理白⚔前缀/法术青紫✦前缀/金币◎金，§7）
    fx.floats = fx.floats.filter(function (f) {
      var age = Math.max(0, now - f.at)
      if (age > 700) return false
      var y = sy(f.y) - 18 - age / 700 * 26
      ctx.font = f.gold ? HF('goldF', 12, 700) : F.p1b(); ctx.textAlign = 'center'
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,10,12,.85)'
      ctx.strokeText(f.txt, sx(f.x), y)
      ctx.fillStyle = f.gold ? '#E8C46A' : f.magic ? '#B48CE8' : '#F2F2F2'
      ctx.fillText(f.txt, sx(f.x), y)
      fxD(f.rec)
      return true
    })
    // F08 复活泉水光柱（300ms，§3.5）
    if (fx.revive && Math.max(0, now - fx.revive.at) < 300) {
      var fo = MAP.fountains[myTeam], ft = (now - fx.revive.at) / 300
      var fa = (1 - ft) * 0.5
      ctx.fillStyle = TEAM_COL[myTeam]; ctx.globalAlpha = fa
      ctx.fillRect(sx(fo[0]) - 14, sy(fo[1]) - 90 * (1 + ft * 0.3), 28, 90 * (1 + ft * 0.3))
      ctx.globalAlpha = 1
      fxD(fx.revive.rec)
    }
    // F07 回城引导光束（环绕双环，引导条在 HUD）
    if (fx.recall > 0 && fx.recallFx && me && !me.ent.dead) {
      var ra = (now - fx.recallFx.at) / 100
      ctx.strokeStyle = '#7FE8D0'; ctx.lineWidth = 2
      var rr = 18 + Math.sin(ra * 6) * 3
      ctx.beginPath(); ctx.arc(sx(pred.x), sy(pred.y), rr, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.arc(sx(pred.x), sy(pred.y), rr * 0.6, 0, Math.PI * 2); ctx.stroke()
      fxD(fx.recallFx.rec)
    }
    // F06 升级光环提示（金环由 rings 承担，此处 900ms 升 L 文案）
    if (fx.lvPop && now - fx.lvPop.at < 900) {
      ctx.font = HF('lvP', 13, 700); ctx.textAlign = 'center'
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,10,12,.85)'
      ctx.strokeText('升 L' + fx.lvPop.lv + '！', sx(pred.x), sy(pred.y) - 38)
      ctx.fillStyle = '#E8C46A'
      ctx.fillText('升 L' + fx.lvPop.lv + '！', sx(pred.x), sy(pred.y) - 38)
      fxD(fx.lvPop.rec)
    }
    // F12 圣所祝祷特效（2.2s 金辉横幅+己方光罩）
    if (fx.bless && Math.max(0, now - fx.bless.at) < 2200) {
      var bt = (now - fx.bless.at) / 2200
      var ba = bt < 0.1 ? bt / 0.1 : 1 - Math.max(0, (bt - 0.75) / 0.25)
      ctx.fillStyle = 'rgba(127,232,208,' + (0.16 * ba).toFixed(3) + ')'
      ctx.fillRect(0, 96, W, 20)
      ctx.font = HF('bless', 13, 700); ctx.textAlign = 'center'
      ctx.fillStyle = '#7FE8D0'; ctx.globalAlpha = ba
      ctx.fillText('◆ 圣所祝祷 · ' + fx.bless.team + ' 队 ◆', W / 2, 110)
      ctx.globalAlpha = 1
      if (fx.bless.team === myTeam) { // 己方光罩（祝祷期增益提示）
        ctx.strokeStyle = '#7FE8D0'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.5 * ba
        ctx.beginPath(); ctx.arc(sx(pred.x), sy(pred.y), 22 + Math.sin(now / 160) * 2, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }
      fxD(fx.bless.rec)
    }
    // F09 连杀播报徽章（强化条幅，§3.4）
    if (fx.badge && Math.max(0, now - fx.badge.at) < 1600) {
      var gt = (now - fx.badge.at) / 1600
      var pop = gt < 0.12 ? 0.6 + gt / 0.12 * 0.5 : Math.min(1.1, 1.1 - (gt - 0.12) * 0.08)
      var btxt = (fx.badge.n >= 5 ? '超神' : fx.badge.n >= 3 ? '三杀' : '双杀') + ' ×' + fx.badge.n
      ctx.save(); ctx.translate(W / 2, 132); ctx.scale(pop, pop)
      ctx.font = HF('badge', 15, 700); ctx.textAlign = 'center'
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(6,10,12,.9)'
      ctx.strokeText(btxt, 0, 0)
      ctx.fillStyle = fx.badge.team === 'W' ? '#9FB8C4' : TEAM_COL[fx.badge.team]
      ctx.fillText(btxt, 0, 0)
      ctx.restore()
      fxD(fx.badge.rec)
    }
    // 击杀播报条（顶部下滑，§7）
    for (var i = 0; i < fx.feed.length; i++) {
      var fd = fx.feed[i], age = Math.max(0, now - fd.at)
      if (age > 3200) continue
      var y0 = 58 + i * 22 + Math.min(1, age / 180) * 8
      ctx.fillStyle = 'rgba(13,27,34,.82)'
      var txt = fd.txt + (fd.streak >= 2 ? ' ·' + (fd.streak >= 5 ? '超神' : fd.streak >= 3 ? '三杀' : '双杀') : '')
      ctx.font = F.p1()
      var w = ctx.measureText(txt).width + 20
      ctx.fillRect(W / 2 - w / 2, y0, w, 18)
      ctx.fillStyle = fd.team === 'W' ? '#9FB8C4' : TEAM_COL[fd.team]
      ctx.textAlign = 'center'; ctx.fillText(txt, W / 2, y0 + 13)
      fxD(fd.rec)
    }
    fx.feed = fx.feed.filter(function (f) { return now - f.at < 3400 })
  }
  function drawScreenFx(now) { // 屏幕空间（不受震屏影响，先于 HUD 绘制）
    // F03 击杀/水晶全屏暗角（§3.4）
    if (fx.vign) {
      var va = 0.45 * (1 - Math.max(0, now - fx.vign.at) / fx.vign.dur)
      if (va > 0) {
        ctx.fillStyle = 'rgba(6,10,12,' + va.toFixed(3) + ')'
        ctx.fillRect(0, 0, W, 30); ctx.fillRect(0, H - 30, W, 30)
        ctx.fillRect(0, 0, 22, H); ctx.fillRect(W - 22, 0, 22, H)
      } else fx.vign = null
    }
    // F11 草丛进出过渡（遮蔽渐变，200ms 淡入淡出）
    var target = fx.grassIn ? 0.16 : 0
    fx.grassA += (target - fx.grassA) * 0.12
    if (fx.grassA > 0.005) {
      ctx.fillStyle = 'rgba(30,80,58,' + fx.grassA.toFixed(3) + ')'
      ctx.fillRect(0, 0, W, H)
      if (fx.grassRec && Math.abs(fx.grassA - target) < 0.1) { fxD(fx.grassRec) }
    } else if (fx.grassRec && !fx.grassIn) fxD(fx.grassRec)
  }
  function drawMinimap(now) {
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
    // F15 敌人消失警示（末次可见位 ? 标记，3s 衰减脉冲）
    fx.miss = fx.miss.filter(function (mk) {
      var age = Math.max(0, now - mk.at)
      if (age > 3000) return false
      var al = 1 - age / 3000, pl = 4 + Math.sin(age / 140) * 1.5
      ctx.strokeStyle = 'rgba(232,63,61,' + (0.9 * al).toFixed(3) + ')'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(mx(mk.x), my(mk.y), pl, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = 'rgba(255,120,110,' + al.toFixed(3) + ')'; ctx.font = F.p1b(); ctx.textAlign = 'center'
      ctx.fillText('?', mx(mk.x), my(mk.y) + 3)
      fxD(mk.rec)
      return true
    })
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
      ctx.textAlign = 'left'
      // F16 金币跳动（收入即弹跳：字号脉冲 350ms）
      var gAge = now - fx.goldAt
      if (gAge < 350) {
        var bounce = Math.sin(Math.min(1, gAge / 350) * Math.PI) * 2
        ctx.font = HF('goldB', 13 + Math.round(bounce), 700)
        ctx.fillStyle = '#FFD97A'
        fxD(fx.goldRec)
      } else { ctx.font = F.p0n(); ctx.fillStyle = '#E8C46A' }
      ctx.fillText('金 ' + m.g, 8, 50)
      // F13 KDA 变动闪（500ms 金色高亮+下划线）
      var kAge = now - fx.kdaAt
      if (kAge < 500) {
        ctx.fillStyle = '#FFD97A'; ctx.font = F.p1b()
        ctx.fillRect(8, 66, 46, 2)
        fxD(fx.kdaRec)
      } else { ctx.fillStyle = '#F2F2F2'; ctx.font = F.p1() }
      ctx.fillText(m.k + '/' + m.d + '/' + m.a, 8, 64)
      if (m.rune) { ctx.fillStyle = '#7FE8D0'; ctx.fillText('灵纹', 70, 50) }
      var bl = t.bless
      if (bl && bl.team === myTeam) { ctx.fillStyle = '#E8A33D'; ctx.fillText('祝祷', 70, 64) }
      // 装备格（P1 名）+ F10 购买格金闪（300ms）
      var ix = W - 8, pop = fx.buyToast && now - fx.buyToast.at < 300
      for (var i = ITEMS_ORDER.length - 1; i >= 0; i--) {
        var code = ITEMS_ORDER[i]
        if (m.items && m.items.indexOf(code) < 0) continue
        ctx.fillStyle = pop ? 'rgba(232,196,106,.85)' : 'rgba(46,110,140,.6)'
        ctx.fillRect(ix - 14, 40, 14, 14)
        ctx.strokeStyle = pop ? '#FFD97A' : '#7FE8D0'; ctx.lineWidth = pop ? 2 : 1
        ctx.strokeRect(ix - 14, 40, 14, 14)
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
      if (cd > 0) { // 冷却径向环+剩余秒数（P0；HUD 反馈强化既有项）
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
    // 回城引导条（F07；中断红闪 §3.3）
    if (fx.recall > 0 && me) {
      fx.recall--
      var brk = now - fx.recallBreakAt < 350
      ctx.fillStyle = 'rgba(6,10,12,.7)'; ctx.fillRect(W / 2 - 70, H / 2 - 90, 140, 14)
      ctx.fillStyle = brk ? 'rgba(232,63,61,.9)' : '#7FE8D0'; ctx.fillRect(W / 2 - 68, H / 2 - 88, 136 * (1 - fx.recall / 40), 10)
      ctx.fillStyle = brk ? '#FF9B8E' : '#F2F2F2'; ctx.font = F.p1(); ctx.textAlign = 'center'
      ctx.fillText(brk ? '回城被打断！' : '回城引导中…', W / 2, H / 2 - 96)
    }
    // F10 购买反馈（弹跳文案 300ms 后回落）
    if (fx.buyToast && now - fx.buyToast.at < 1500) {
      var bAge = now - fx.buyToast.at
      var bPop = bAge < 300 ? 12 + Math.round(Math.sin(bAge / 300 * Math.PI) * 2) : 12
      ctx.fillStyle = '#E8C46A'; ctx.font = HF('buyP', bPop, 700); ctx.textAlign = 'center'
      ctx.fillText('已购 ' + (ITEM_NAME[fx.buyToast.item] || fx.buyToast.item), W / 2, H / 2 - 120)
      fxD(fx.buyToast.rec)
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

  /* ---------- 手感场景驱动（QA 取证入口：fxScene 状态类/fxProbe 事件类） ---------- */
  function fxScene(name) {
    if (name === 'calm') { // 清瞬态（采样/锚点用）
      fx.parts.length = 0; fx.rings.length = 0; fx.shots.length = 0; fx.zones.length = 0; fx.floats.length = 0
      fx.miss.length = 0; fx.feed.length = 0; fx.badge = null; fx.bless = null; fx.vign = null; fx.lvPop = null
      fx.slowUntil = 0; fx.goldAt = -1e9; fx.kdaAt = -1e9; fx.rejectAt = -1e9; fx.buyToast = null; fx.revive = null
      return true
    }
    if (name === 'lvup') { ring(pred.x, pred.y, 46, '#E8C46A', 3); fx.lvPop = { lv: (me && me.ent ? me.ent.lv : 1) + 1, at: pnow(), rec: fxT('F06') }; sfx('lvup'); return true }
    if (name === 'revive') { var fo = MAP.fountains[myTeam]; ring(fo[0], fo[1], 60, TEAM_COL[myTeam], 3); fx.revive = { at: pnow(), rec: fxT('F08') }; sfx('revive'); return true }
    if (name === 'grass') { fx.grassIn = true; fx.grassRec = fxT('F11'); burst(pred.x, pred.y, '#7FC99F', 8, 55, 0.05); return true }
    if (name === 'grassOut') { fx.grassIn = false; fx.grassRec = fxT('F11'); return true }
    if (name === 'recall') { fx.recall = 40; fx.recallFx = { at: pnow(), rec: fxT('F07') }; sfx('recall'); return true }
    if (name === 'gold') { fx.goldAt = pnow(); fx.goldRec = fxT('F16'); return true }
    if (name === 'kda') { fx.kdaAt = pnow(); fx.kdaRec = fxT('F13'); return true }
    if (name === 'hpflash') { var r = ents['h' + mySeat]; if (r) { r.hpFlash = 220; r.hpRec = fxT('F14') } return !!r }
    if (name === 'miss') { fx.miss.push({ x: pred.x + 120, y: pred.y - 60, at: pnow(), rec: fxT('F15') }); sfx('miss'); return true }
    return false
  }

  /* ---------- 主循环 ---------- */
  var lastFrame = 0, perfCost = { n: 0, sum: 0, max: 0 }
  var paused = false
  function frame(now) {
    requestAnimationFrame(frame)
    if (paused) return
    var t0 = performance.now()
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
    // F11 草丛进出检测（本地位置 vs 草丛圈；服务器视野规则不变）
    var gi = false
    for (var gI = 0; gI < MAP.grass.length; gI++) { var gg = MAP.grass[gI]; if (Math.hypot(pred.x - gg[0], pred.y - gg[1]) < 55) { gi = true; break } }
    if (gi !== fx.grassIn) {
      fx.grassIn = gi
      fx.grassRec = fxT('F11')
      if (gi) burst(pred.x, pred.y, '#7FC99F', 8, 55, 0.05) // 进草叶片
    }
    // F16/F13 金币与 KDA 变动（ext.me 逐拍比对）
    var mm = ext.me
    if (mm) {
      if (prevMe) {
        if (mm.g != null && prevMe.g != null && mm.g > prevMe.g) { fx.goldAt = pnow(); fx.goldRec = fxT('F16') }
        if (mm.k !== prevMe.k || mm.d !== prevMe.d || mm.a !== prevMe.a) { fx.kdaAt = pnow(); fx.kdaRec = fxT('F13') }
      }
      prevMe = { g: mm.g, k: mm.k, d: mm.d, a: mm.a }
    }
    // 击杀慢放：fx 时钟 0.35×（世界/预测不受影响，§3.4 渲染层慢放）
    if (pnow() < fx.slowUntil) fx.slowAcc += dt * 0.65
    var fnow = now - fx.slowAcc
    ctx.save()
    if (fx.shakes > 0) { ctx.translate((Math.random() - 0.5) * fx.shakes, (Math.random() - 0.5) * fx.shakes); fx.shakes *= 0.9; if (fx.shakes < 0.3) fx.shakes = 0 }
    var tick = welcome && welcome.frame || 0
    if (snapTick) tick = snapTick
    drawMap(now)
    drawBuilds(now)
    drawEnts(now)
    drawFx(fnow)
    ctx.restore()
    drawScreenFx(fnow) // 暗角/草丛遮蔽（屏幕空间，先于 HUD——不污染字形锚点）
    drawMinimap(fnow)
    drawTopbar(now, tick) // HUD 反馈类用真实时钟（输入应答不受慢放）
    drawControls(now)
    drawDead(now, tick)
    drawEnd()
    /* 帧成本探针（games-118 范式：无头环境 rAF 被环境封顶时，perf 口径=帧成本） */
    var c = performance.now() - t0
    perfCost.n++; perfCost.sum += c; if (c > perfCost.max) perfCost.max = c
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
    perf: function () { return { n: perfCost.n, avgMs: +(perfCost.sum / Math.max(1, perfCost.n)).toFixed(2), maxMs: +perfCost.max.toFixed(2) } },
    pause: function (v) { paused = !!v },
    fxList: function () { return FXLIST.map(function (f) { return { id: f[0], name: f[1], cls: f[2] } }) },
    fxLedger: function () { return fxLedger.map(function (l) { return { id: l.id, trig: Math.round(l.trig), lat: l.lat } }) },
    fxProbe: function (ev) { onEvent(ev); return true }, // 合成事件走同一 onEvent 管线
    fxScene: fxScene,
    sfxGroups: function () { return { on: SND.on, slots: SND.slots.slice(), calls: SND.calls.slice() } },
    sndOn: function (v) { SND.on = !!v },
  }
})()
