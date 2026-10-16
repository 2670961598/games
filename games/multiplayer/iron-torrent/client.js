/* 钢铁洪流 client（GAMES-146 · S4 预测弹道）——左摇杆驾驶+右瞄准盘+fire+弹种钮；
 * 自身坦克本地预测（input ring+ack 和解软收敛，kart 范式）+他人快照外推；
 * 弹道=fire 事件起段本地确定性重演（离散段重演，pool 范式）+快照 projs 兜底；
 * 弹道预览线=本地同 sim 前瞻（previewTrace 三面同源，§5.5）——「预测」与「权威」
 * 的分界只在输入时点不在算法。
 * GAMES-150 手感层：FXLIST 动效登记表（fb 反馈类 ≤80ms 首绘红线）+ fxLedger 双时戳
 * 台账 + SND 音效位（makeSound 平台范式：总闸门默认静音只记账）——fx 层只读消费
 * 快照/事件（sim/brain 零改动）；动效全部渲染期偏移/粒子，不入任何游戏态。
 * HUD 字号走 HF 登记表+__applied 生效往返自证（hud-font-standard §1，Q-013 教训
 * 前置：weight 前置合法简写，禁后置带单位错写）。
 * 阵营色+形状双编码（§7）：A 琥珀圆炮塔盖/B 青六角；弹丸 A 圆点实线/B 菱形虚线；
 * AP 细长/HE 圆钝（弹种第二键）。 */
(function () {
  'use strict';
  var W = 375, H = 667;
  var K = 1000;
  var CX0 = 17, CY0 = 56;          // 战场内域左上（340×500 1:1 居中，§2.1）
  var CW = 340, CH = 500;
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var hintEl = document.getElementById('hint');
  var S = window.IronSim, C = S.consts;
  var now = function () { return performance.now() };
  var TEAM_COL = ['#E8A33D', '#3DC8E8']; // A 琥珀 / B 青（§7 平台标准）
  var TAU = Math.PI * 2;

  /* ---------- HUD 字号登记表（HF 体系+__applied 自证） ---------- */
  var HF_REG = {}, dbgEvents = [];
  var HF_CLS = { P0: { min: 99, n: 0 }, P1: { min: 99, n: 0 }, P2: { min: 99, n: 0 } };
  function HF(tag, px, weight, cls) {
    var f = (weight || 6) + '00 ' + px + 'px -apple-system,"PingFang SC","Helvetica Neue",sans-serif';
    HF_REG[tag] = { px: px, weight: weight, cls: cls, at: now() };
    var c = HF_CLS[cls] || (px >= 13 ? HF_CLS.P0 : px >= 11 ? HF_CLS.P1 : HF_CLS.P2);
    if (px < c.min) c.min = px;
    c.n++;
    return f;
  }
  /* __applied 生效往返自证（GAMES-135/143 教训）：赋 ctx.font 后回读解析含目标字号
   * 与字重才记 true——非法简写被 canvas 静默忽略=10px 缺省字，此处第一断言位 */
  function appliedSelfCheck() {
    ctx.save();
    ctx.font = HF('hfProbe', 13, 7, 'P0'); // 探针也走 HF（零裸字号口径；登记键不破坏 FE-4c 共同键比对）
    var m = /^(\d+)\s*px/.exec(ctx.font) || /(\d+)px/.exec(ctx.font);
    /* Chromium 把 700 规范化回读为 bold——按语义比对（字重在场：700|bold），
     * 字号生效=回读 13px（10px=赋值被静默忽略的缺省字特征，GAMES-135/143） */
    var ok = !!(m && +m[1] === 13 && (/700/.test(ctx.font) || /bold/i.test(ctx.font)));
    ctx.restore();
    return ok;
  }
  function emitDbg(ev, payload) { dbgEvents.push({ event: ev, payload: payload, at: now() }); if (dbgEvents.length > 120) dbgEvents.shift(); }
  window.__GAMES_DEBUG__ = window.__GAMES_DEBUG__ || {};
  window.__GAMES_DEBUG__.hudFonts = function () {
    return { reg: HF_REG, cls: HF_CLS, __applied: appliedSelfCheck(),
      note: '__applied=true 表示 ctx.font 赋值回读生效（700 13px 简写合法路径在场）' };
  };
  window.__GAMES_DEBUG__.dbgEvents = function () { return dbgEvents.slice(-40) };

  /* ---------- GAMES-150 FXLIST：[id, 名称, fb|state]——fb=反馈类（事件→首绘 ≤80ms
   * 红线，台账断言），state=状态类（持续态，只报数）。fxT 打触发时戳、fxD 打首绘
   * 时延（fxLedger 供 feel-check 复跑；设计 §3.2/§3.4 juice 清单落地）。 ---------- */
  var FXLIST = [
    ['F01', 'recoilBody', 'fb'],     // 车体后坐（fire → 车体反向 2px+炮管后缩 6px 200ms 回弹；重坦 ×0.7/坦歼 ×1.3——§3.2 重量感三件套）
    ['F02', 'muzzleBlast', 'fb'],    // 炮口焰（fire → 焰锥+硝烟+弹壳抛出，§3.4）
    ['F03', 'turretJolt', 'fb'],     // 炮塔震颤（fire → 炮塔角微摆衰减 150ms）
    ['F04', 'reloadGlow', 'fb'],     // 满装辉光（cd>0→0 → 装填环辉光脉冲 300ms+机括声）
    ['F05', 'hitSpark', 'fb'],       // 命中火花（hit → 正/侧/背三色火花放射——部位差异化）
    ['F06', 'crumbleDust', 'fb'],    // 掩体碎裂（crumble → 碎块抛物飞溅+尘雾）
    ['F07', 'treadTrail', 'fb'],     // 履带印拖尾（行进每 ≥14px 落一枚双轨印，§3.2）
    ['F08', 'previewBreath', 'fb'],  // 弹道预览线呼吸（fire → 200ms 余晖+基线呼吸，§3.4）
    ['F09', 'hurtEdge', 'fb'],       // 受伤红屏边缘（我席被命中 → 战场缘红晕 300ms，§3.2）
    ['F10', 'hitArc', 'fb'],         // 受击方向弧（入射向红弧 300ms——被绕侧方位知觉，§3.2）
    ['F11', 'swapPulse', 'fb'],      // 弹种切换动效（swap → 弹种钮缩放脉冲+环闪）
    ['F12', 'killBanner', 'fb'],     // 观战击杀特写横幅（kill → 名签横幅冲入，观战/玩家同款）
    ['F13', 'treadFade', 'fb'],      // 击毁履带印渐隐（kill → 被毁者履带印 1.5s 淡出）
    ['F14', 'killChain', 'fb'],      // 击杀爆炸+殉爆链（kill → 主爆+70/150ms 次级爆串）
    ['F15', 'endAnim', 'fb'],        // 结算动画（end → 胜=彩雨/败=压暗滑入，胜负分歧）
    ['F16', 'capPulse', 'fb'],       // 占点圈脉冲（capTick 进度变更 → 圈脉冲+滴答；满点前警报音）
    ['F17', 'respawnBeam', 'fb'],    // 重生光柱（respawn → 基地光柱 500ms+补满满格音）
    ['F18', 'windFlagWave', 'state'] // 风向旗飘动（顶栏旗面 sin 涟漪常摆，§2.3 HUD 常显）
  ];
  var fxLedger = [];
  function fxT(id) { fxLedger.push({ id: id, trig: now(), lat: null }); if (fxLedger.length > 240) fxLedger.shift(); return fxLedger[fxLedger.length - 1] }
  function fxD(rec) { if (rec && rec.lat == null) rec.lat = Math.max(0, Math.round(now() - rec.trig)) }

  /* ---------- 音效位（makeSound 平台范式：总闸门默认静音只记账；开启后 WebAudio
   * 简音色占位——多人客户端本地化口径，GAMES-131/141 同式） ---------- */
  var SND = { on: false, slots: ['cannonNear', 'cannonFar', 'hitMetal', 'hitThud', 'reloadClick', 'engineHum', 'killBoom', 'chainBlast', 'crumble', 'capTick', 'capAlert', 'swap', 'reject', 'respawnFull', 'hurtAlarm', 'endWhistle', 'banner'], calls: [], fired: {}, ac: null };
  function sfx(slot) {
    SND.calls.push({ g: slot, at: Math.round(now()) });
    SND.fired[slot] = true; // 持久触达集（calls 滚动窗会被巡航期高频履带/命中音刷掉）
    if (SND.calls.length > 300) SND.calls.shift();
    if (!SND.on) return;
    try {
      if (!SND.ac) SND.ac = new (window.AudioContext || window.webkitAudioContext)();
      var a = SND.ac, o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
      var big = { killBoom: 1, chainBlast: 1, endWhistle: 1 };
      var cl = { reloadClick: 1, swap: 1, capTick: 1, reject: 1, hitMetal: 1 };
      o.type = big[slot] || cl[slot] ? 'square' : slot === 'cannonNear' || slot === 'cannonFar' ? 'triangle' : 'sine';
      var f0 = big[slot] ? 140 : cl[slot] ? 840 : slot === 'cannonFar' ? 190 : slot === 'cannonNear' ? 330 : 520;
      var f1 = big[slot] ? 46 : cl[slot] ? 1180 : slot === 'cannonFar' ? 90 : slot === 'cannonNear' ? 130 : 240;
      var dur = big[slot] ? 0.34 : slot === 'cannonNear' || slot === 'cannonFar' ? 0.24 : 0.12;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* 无音频环境静默 */ }
  }

  /* ---------- 连接态 ---------- */
  var ws = null, mySeat = -1, ended = false, endResult = null;
  var tanks = {};                          // 席位→权威态（快照）
  var projsLocal = [];                     // 本地重演弹道段（fire 事件起段）
  var snapState = { phase: 'play', clock: C.MAX_TICKS, capBar: 0, capTeam: -1, lives: [5, 5], map: 'm-cross', wind: { mag: 0, ang: 0 } };
  var tiles = null;                        // 掩体耐久档（全量快照/增量脏 tile）
  var tileTypes = null;                    // 掩体类型（全量）
  var srvFrame = -1, srvAt = 0, lastQ = -1, inRing = [];   // 快照锚（F1 修复，GAMES-148）：frame 推算基准
  var fx = { muzzle: [], booms: [], crumbs: [], floats: [], shake: 0, recols: {}, deadBanner: null,
    sparks: [], treads: [], recoil: {}, jolt: {}, beams: [], chain: [],
    swapAt: -1e9, glowAt: -1e9, breathAt: -1e9, capPulseAt: -1e9, hurtAt: -1e9, hurtArc: null,
    breathRec: null, hurtRec: null, capRec: null, glowRec: null, swapRec: null, capPrevTeam: -1,
    endAt: -1e9, endFxOn: false, prevCd: -1, prevCap: 0, wasMoving: false, treadLast: {}, windRec: null };

  function hint(t) { hintEl.textContent = t; hintEl.style.display = t ? 'block' : 'none' }
  function fatal(t) { document.getElementById('fatal-msg').textContent = t; document.getElementById('fatal').style.display = 'flex' }
  function connect() {
    var q = new URLSearchParams(location.search);
    var gw = q.get('gw') || (location.protocol + '//' + location.hostname + ':4400');
    var rid = q.get('room');
    try { var ss = sessionStorage.getItem('iron-rid'); if (!rid && ss) rid = ss } catch (e) {}
    ws = new WebSocket(gw.replace(/\/+$/, '') + '/ws');
    ws.onopen = function () { send({ t: 'hello', v: 1 }); join(rid) };
    ws.onerror = function () { hint('网关连接失败（?gw=http://host:4400）') };
    ws.onclose = function () { if (!ended) hint('连接断开，刷新重试') };
    ws.onmessage = function (m) {
      var msg; try { msg = JSON.parse(m.data) } catch (e) { return }
      if (msg.t === 'welcome') onWelcome(msg, rid);
      else if (msg.t === 'snapshot') onSnapshot(msg);
      else if (msg.t === 'end') { ended = true; endResult = msg.result; endFx() }
      else if (msg.t === 'closed') { if (!ended) fatal('房间已回收——刷新重进') }
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)) }
  function join(rid) {
    if (rid) { send({ t: 'join', roomId: rid }); try { sessionStorage.setItem('iron-rid', rid) } catch (e) {} }
    else send({ t: 'quick', gameId: 'iron-torrent' });
  }
  function onWelcome(msg, rid) {
    mySeat = msg.role === 'player' ? msg.seat : -1;
    if (msg.room && msg.room.physics && msg.room.physics.engine !== S.ENGINE) hint('引擎版本不符，回退插值模式');
    if (!rid && msg.roomId) { try { sessionStorage.setItem('iron-rid', msg.roomId) } catch (e) {} }
    if (msg.state) applyState(msg.state);
    hint(mySeat < 0 ? '观战中 · 全览战场' : '');
    emitDbg('welcome', { seat: mySeat, engine: msg.room && msg.room.physics && msg.room.physics.engine, physicsHash: msg.room && msg.room.physics && msg.room.physics.hash });
  }
  function applyState(st) {
    if (st.players) for (var i = 0; i < st.players.length; i++) {
      var p = st.players[i];
      if (!p) { delete tanks[i]; continue }
      tanks[i] = Object.assign(tanks[i] || {}, p);
    }
    if (st.tiles) { tileTypes = st.tiles.slice(); tiles = st.tileHp ? st.tileHp.slice() : tiles }
    if (st.tileHp && !tiles) tiles = st.tileHp.slice();
    for (var k in st) if (k !== 'players' && k !== 'tiles' && k !== 'tileHp' && k !== 'mem' && k !== 'inLog') snapState[k] = st[k];
  }

  /* ---------- 快照（二式）+ 预测和解 ---------- */
  function onSnapshot(msg) {
    var ack = msg.ext && msg.ext.ack;
    if (typeof msg.frame === 'number') { srvFrame = msg.frame; srvAt = now() } // F1 锚点：每快照重校准（对定时器节流/时钟漂移免疫）
    if (msg.full) { tanks = {}; projsLocal = [] }
    for (var i = 0; i < (msg.ents || []).length; i++) {
      var e = msg.ents[i], si = parseInt(e.id.slice(1), 10);
      if (isNaN(si)) continue;
      tanks[si] = Object.assign(tanks[si] || {}, e);
    }
    if (msg.projs) { /* 弹道列表兜底对齐（§5.3 恒带）：以快照为准重建本地段基线 */
      var seen = {};
      for (var j = 0; j < msg.projs.length; j++) {
        var pr = msg.projs[j], pid = parseInt(pr.id.slice(1), 10);
        seen[pid] = 1;
        if (!projsLocal.some(function (l) { return l.id === pid })) {
          projsLocal.push({ id: pid, seat: pr.seat, ammo: pr.ammo, x: pr.x, y: pr.y, z: pr.z, vx: pr.vx, vy: pr.vy, vz: pr.vz });
        }
      }
      projsLocal = projsLocal.filter(function (l) { return seen[l.id] });
    }
    if (msg.tiles) {
      if (msg.full) tiles = msg.tiles.slice();
      else for (var ti = 0; ti < msg.tiles.length; ti++) tiles[msg.tiles[ti].i] = msg.tiles[ti].hp;
    }
    if (msg.state) {
      snapState.phase = msg.state.phase; snapState.clock = msg.state.clock;
      snapState.capBar = msg.state.capBar; snapState.capTeam = msg.state.capTeam;
      snapState.lives = msg.state.lives; snapState.map = msg.state.map; snapState.wind = msg.state.wind;
    }
    /* 自身和解（§5.4）：回滚至权威态@frame → 重放未确认输入 → 软收敛（撕裂预算内） */
    if (mySeat >= 0 && tanks[mySeat] && typeof ack === 'number' && ack >= 0) {
      var me = tanks[mySeat];
      var ax = me.x, ay = me.y;
      for (var q2 = 0; q2 < inRing.length; q2++) if (inRing[q2].q > ack) applyMove(me, inRing[q2]);
      var dx = me.x - ax, dy = me.y - ay, d = Math.hypot(dx, dy);
      if (d > 6 * K) { me.x = ax; me.y = ay } // 硬回滚带（>6px 一次性回正）
      else if (d > 0) { me.x = ax + dx * 0.35; me.y = ay + dy * 0.35 } // 软收敛
      while (inRing.length && inRing[0].q <= ack) inRing.shift();
    }
    for (var ev = 0; ev < (msg.events || []).length; ev++) onEvent(msg.events[ev]);
  }
  function applyMove(p, inp) {
    var c = C.CLS[p.cls] || C.CLS.all;
    p.x += c.spd * inp.mx / 100;
    p.y += c.spd * inp.my / 100;
  }
  /* ---------- 事件（表现层；权威态在快照，§7 红线）——GAMES-150：每事件打
   * fxT 触发时戳+音效位（首绘 fxD 在渲染侧落，fb ≤80ms 红线由此可证）。 ---------- */
  function onEvent(e) {
    if (e.k === 'fire') { // 确定性重演起点：事件携参直读（含散布出射角——零推导）
      var tF = now();
      projsLocal.push({ id: e.seat * 100000 + projsLocal.length + Math.floor(tF % 100000), seat: e.seat, ammo: e.ammo, x: e.x, y: e.y, z: e.z || 14000, vx: e.vx, vy: e.vy, vz: e.vz });
      fx.muzzle.push({ x: e.x, y: e.y, at: tF, seat: e.seat, rec: fxT('F02') });                    // F02 炮口焰
      fx.recoil[e.seat] = { at: tF, rec: fxT('F01'), tur: e.ang };                                   // F01 后坐三件套·车体/炮管
      fx.jolt[e.seat] = { at: tF, rec: fxT('F03') };                                                 // F03 炮塔震颤
      if (e.seat === mySeat) { fx.breathAt = tF; fx.breathRec = fxT('F08') }                         // F08 预览线余晖（首绘=下一帧线强度抬升）
      fx.shake = Math.min(8, fx.shake + (e.seat === mySeat ? 4 : 1));
      sfx(e.seat === mySeat ? 'cannonNear' : 'cannonFar');                                           // 炮声分层：远近
      emitDbg('fire', e);
    } else if (e.k === 'hit') {
      var tH = now(), vct = tanks[e.victim] || {};
      fx.floats.push({ x: vct.x || 0, y: (vct.y || 0) - 20000, v: '-' + e.dmg, at: tH, col: TEAM_COL[(tanks[e.seat] || {}).team || 0] });
      fx.sparks.push({ x: vct.x || 170000, y: vct.y || 250000, part: e.part || 'side', at: tH, rec: fxT('F05') }); // F05 三色火花（渲染侧按 part 取色）
      if (e.victim === mySeat) {
        fx.shake = Math.min(10, fx.shake + 5);
        fx.hurtAt = tH; fx.hurtRec = fxT('F09');                                                     // F09 红屏边缘（首绘=下一帧边缘红晕）
        fx.hurtArc = { ang: e.angIn || 0, at: tH, rec: fxT('F10') };                                 // F10 受击方向弧
        sfx('hurtAlarm');
      }
      sfx('hitMetal');                                                                               // 命中金属声（部位差异化在音高外的视觉三色）
      emitDbg('hit', e);
    } else if (e.k === 'splash') {
      fx.booms.push({ x: e.x, y: e.y, at: now(), r: 30000 });
      sfx('hitThud');                                                                                // HE 落地闷响
    } else if (e.k === 'crumble') {
      fx.crumbs.push({ tile: e.tile, at: now(), rec: fxT('F06') });
      if (tiles) tiles[e.tile] = 0;
      if (tileTypes) tileTypes[e.tile] = 0;
      sfx('crumble');
      emitDbg('crumble', e);
    } else if (e.k === 'kill') {
      var tK = now(), vx0 = (tanks[e.victim] || {}).x || 170000, vy0 = (tanks[e.victim] || {}).y || 250000;
      fx.booms.push({ x: vx0, y: vy0, at: tK, r: 26000, big: true, rec: fxT('F14') });               // F14 主爆（殉爆链首=主爆即绘，次级 70/150ms 后续）
      fx.chain.push({ x: vx0 + 9000, y: vy0 - 7000, at: tK + 70, r: 15000, sfxd: false },
                    { x: vx0 - 8000, y: vy0 + 6000, at: tK + 150, r: 11000, sfxd: false });         // 殉爆链（次级爆到点起播+殉爆音）
      fx.deadBanner = { by: e.seat, victim: e.victim, at: tK, rec: fxT('F12') };                     // F12 击杀特写横幅
      for (var tk = 0; tk < fx.treads.length; tk++) if (fx.treads[tk].seat === e.victim && !fx.treads[tk].fadeAt) fx.treads[tk].fadeAt = tK; // F13 履带印渐隐
      fx.treads.push({ x: vx0, y: vy0, dir: (tanks[e.victim] || {}).dir || 0, seat: e.victim, at: tK, wreck: true, fadeAt: tK, rec: fxT('F13') }); // 被毁原地焦印（渐隐首绘锚）
      fx.recoil[e.victim] = null;
      sfx('killBoom'); sfx('banner');
      emitDbg('kill', e);
    } else if (e.k === 'respawn') {
      fx.beams.push({ x: e.x, y: e.y, at: now(), rec: fxT('F17') });                                 // F17 重生光柱
      sfx('respawnFull');                                                                            // 弹药补满满格音
    } else if (e.k === 'capTick') {
      var bar = e.bar || 0;
      if (bar > fx.prevCap) { fx.capPulseAt = now(); fx.capRec = fxT('F16') }                        // F16 占点圈脉冲（首绘=下一帧圈亮脉冲）
      if (fx.prevCap < 90000 && bar >= 90000) sfx('capAlert');                                       // 满点前 10s 警报音（§3.4）
      else if (bar > fx.prevCap) sfx('capTick');                                                     // 占点滴答
      fx.prevCap = bar;
    } else if (e.k === 'swapFx') {                                                                   // 本地 swap 动效（fxScene/uiTap 同管线）
      fx.swapAt = now(); fx.swapRec = fxT('F11'); sfx('swap');
    } else if (e.k === 'reject') { sfx('reject'); emitDbg('reject', e) }
    else if (e.k === 'end') { ended = true; endResult = e; endFx() }
  }
  /* F08/F09/F16 的 rec 在渲染侧首帧落（线/圈/边缘常驻，事件只点亮强度）；F15 终局
   * 动效同 street 两段式口径（世界层停绘前照常）。 */
  function endFx() {
    fx.endAt = now(); fx.endFxOn = true; fx.endRec = fxT('F15'); sfx('endWhistle');
  }

  /* ---------- 输入面（§1.6：摇杆+瞄准盘+fire+弹种四件） ---------- */
  var input = { mx: 0, my: 0, tur: 0 };
  var stick = null, aimPad = null;
  var selAmmo = 0;
  var el = cv;
  function pt(t) { var r = el.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top } }
  el.addEventListener('touchstart', function (ev) {
    for (var i = 0; i < ev.changedTouches.length; i++) {
      var p = pt(ev.changedTouches[i]);
      /* UI 命中区（fire/弹种钮）由绘制位判定（底栏右手区） */
      if (p.y > H - 120) { uiTap(p, ev.changedTouches[i].identifier); continue }
      if (p.x < W / 2 && !stick) stick = { id: ev.changedTouches[i].identifier, ox: p.x, oy: p.y, x: p.x, y: p.y };
      else if (p.x >= W / 2 && !aimPad) aimPad = { id: ev.changedTouches[i].identifier, ox: p.x, oy: p.y, x: p.x, y: p.y };
    }
    ev.preventDefault();
  }, { passive: false });
  el.addEventListener('touchmove', function (ev) {
    for (var i = 0; i < ev.changedTouches.length; i++) {
      var p = pt(ev.changedTouches[i]);
      if (stick && ev.changedTouches[i].identifier === stick.id) { stick.x = p.x; stick.y = p.y; stickMove() }
      if (aimPad && ev.changedTouches[i].identifier === aimPad.id) { aimPad.x = p.x; aimPad.y = p.y; aimMove() }
    }
    ev.preventDefault();
  }, { passive: false });
  function endTouch(ev) {
    for (var i = 0; i < ev.changedTouches.length; i++) {
      if (stick && ev.changedTouches[i].identifier === stick.id) { stick = null; input.mx = 0; input.my = 0 }
      if (aimPad && ev.changedTouches[i].identifier === aimPad.id) aimPad = null;
      uiEnd(ev.changedTouches[i].identifier);
    }
  }
  el.addEventListener('touchend', endTouch); el.addEventListener('touchcancel', endTouch);
  function stickMove() {
    var dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.hypot(dx, dy);
    if (d < 6) { input.mx = 0; input.my = 0; return } // 死区 6px（kart 同款）
    var m = Math.min(1, d / 56);
    input.mx = Math.round(dx / d * 100 * m); input.my = Math.round(dy / d * 100 * m);
  }
  function aimMove() {
    var dx = aimPad.x - aimPad.ox, dy = aimPad.y - aimPad.oy;
    if (Math.hypot(dx, dy) < 10) return;
    var q = Math.atan2(dy, dx) / TAU * 8192;
    input.tur = (Math.round(q) << 3) & 0xFFFF;
  }
  /* fire/弹种钮（右手区固定绘制位命中） */
  var FIRE_C = { x: W - 66, y: H - 62 }, FIRE_R = 32;
  var AMMO_C = { x: W - 138, y: H - 52 }, AMMO_R = 22;
  var held = {};
  function uiTap(p, id) {
    if (Math.hypot(p.x - FIRE_C.x, p.y - FIRE_C.y) <= FIRE_R) {
      held[id] = 'fire';
      /* 乐观开炮（§5.4）：fire tap 即本地起段（权威 fire 事件 ≤100ms 校准） */
      var me = tanks[mySeat];
      if (me && me.alive && me.cd <= 0) {
        var A = C.AMMO[selAmmo];
        var ang = me.tur;
        var ox = me.x + Math.cos(ang / 8192 * TAU) * 14000, oy = me.y + Math.sin(ang / 8192 * TAU) * 14000;
        projsLocal.push({ id: -1 - projsLocal.length, seat: mySeat, ammo: selAmmo, x: ox, y: oy, z: 14000,
          vx: Math.cos(ang / 8192 * TAU) * A.vh | 0, vy: Math.sin(ang / 8192 * TAU) * A.vh | 0, vz: A.vz, opt: true });
        fx.muzzle.push({ x: ox, y: oy, at: now(), seat: mySeat });
        fx.shake = Math.min(8, fx.shake + 4);
        sendCmd({ k: 'fire', ammo: selAmmo });
      }
    } else if (Math.hypot(p.x - AMMO_C.x, p.y - AMMO_C.y) <= AMMO_R) {
      held[id] = 'ammo'; selAmmo = selAmmo === 0 ? 1 : 0; sendCmd({ k: 'swap', ammo: selAmmo });
      onEvent({ k: 'swapFx' }); // F11 弹种切换动效（本地即时；权威 sel 快照回读对齐）
    }
  }
  function uiEnd(id) { delete held[id] }
  function sendCmd(cmd) { pendingCmd = cmd }
  var pendingCmd = null;
  /* 20Hz 输入上报（静止保活）。F1 修复（GAMES-148，修法①客户端锚定）：
   * frame 不再自计数（seq++ 自由钟在浏览器定时器节流/起始偏移下漂移 room.frame——
   * 名义同 20Hz、实钟不同源，接房 ~0.8s 后恒越网关预约窗 (room.frame, room.frame+8]，
   * 离散 cmd 落宽限通道被后续心跳覆写=静默丢，QA1 F1）。改锚定快照推算：
   * estFrame=srvFrame+Δ/TICK_MS（每快照重校准，S7 kart ack 锚同族），预约 estFrame+1
   * ——input delay=1 语义不变、对任意节流/漂移免疫；ack 序号天然单调（随墙钟推进）。
   * cmd 必须塞 keys 内（网关只解析 msg.keys.cmd，顶层字段不透传=F1 第二层根因）且
   * 只随锚定帧走：预约帧是 cmd 唯一执行通道（GAMES-51 一次性语义），首快照前/锚过期
   * (>1s) 持有不上送。inRing 每帧值一条（同帧去重——预测重放节奏=tick 节拍）。 */
  setInterval(function () {
    if (!ws || ws.readyState !== 1 || mySeat < 0 || ended) return;
    var keys = { mx: input.mx, my: input.my, tur: input.tur };
    var o = { t: 'input', keys: keys };
    if (srvFrame >= 0) {
      var f = srvFrame + Math.round((now() - srvAt) / C.TICK_MS) + 1;
      if (f <= lastQ) f = lastQ + 1; // 发送序严格单调（浏览器定时器只迟不早，双保险钳）
      lastQ = f; o.frame = f;
      inRing.push({ q: f, mx: input.mx, my: input.my });
      if (pendingCmd && now() - srvAt < 1000) { keys.cmd = pendingCmd; pendingCmd = null }
    }
    if (inRing.length > 64) inRing.shift();
    send(o);
  }, 50);

  /* ---------- 渲染 ---------- */
  var lastT = now();
  var perfLog = { costs: [], gaps: [], lastAt: 0 };
  var paused = false;
  function loop(ts) {
    requestAnimationFrame(loop);
    if (paused) return; // QA 冻结采样（GAMES-103 范式：保留最后帧供识图探针）
    var t0 = now(), t = t0, dt = Math.min(50, t - lastT); lastT = t;
    if (perfLog.lastAt) perfLog.gaps.push(t0 - perfLog.lastAt); // 首帧播种（GAMES-141：旧 if(gaps.length) 恒空死码→rafGap 恒 0）
    perfLog.lastAt = t0;
    if (perfLog.gaps.length > 240) perfLog.gaps.shift();
    if (fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt * 0.04);
    stepProjs(dt);
    updateFeel(t, dt);
    draw(t);
    var cost = now() - t0;
    perfLog.costs.push(cost);
    if (perfLog.costs.length > 240) perfLog.costs.shift();
  }
  /* GAMES-150 感受层帧更新：履带印落点/满装辉光检测/引擎嗡鸣/殉爆链到点（全部
   * 渲染期状态，只读消费快照——不入 sim）。 */
  function updateFeel(t, dt) {
    for (var seat in tanks) {
      var p = tanks[seat];
      if (!p || !p.alive) continue;
      var last = fx.treadLast[seat];
      if (!last) { fx.treadLast[seat] = { x: p.x, y: p.y }; continue }
      var dx = p.x - last.x, dy = p.y - last.y, d2 = dx * dx + dy * dy;
      if (d2 >= 14000 * 14000) { // 每 ≥14px 落一枚双轨印（§3.2 履带印）
        fx.treads.push({ x: p.x, y: p.y, dir: p.dir || 0, seat: +seat, at: t, rec: +seat === mySeat ? fxT('F07') : null });
        fx.treadLast[seat] = { x: p.x, y: p.y };
        if (fx.treads.length > 72) fx.treads.shift(); // 帧成本帽（72 枚=1.0m 轨迹足够拖尾感）
      }
    }
    var me = tanks[mySeat];
    if (me && me.alive && typeof me.cd === 'number') {
      if (fx.prevCd > 0 && me.cd <= 0) { // 满装：cd>0→0 跳变 → 辉光+机括声（F04）
        fx.glowAt = t; fx.glowRec = fxT('F04'); sfx('reloadClick');
      }
      fx.prevCd = me.cd;
    }
    var moving = Math.abs(input.mx) + Math.abs(input.my) > 0;
    if (moving && !fx.wasMoving && me && me.alive) sfx('engineHum'); // 履带引擎嗡鸣（起步）
    fx.wasMoving = moving;
    for (var ci = fx.chain.length - 1; ci >= 0; ci--) if (t >= fx.chain[ci].at && !fx.chain[ci].sfxd) { fx.chain[ci].sfxd = true; sfx('chainBlast') }
  }
  /* 本地弹道段重演（§5.1 离散事件确定性重演：同 sim 同参数逐字节一致） */
  function stepProjs(dt) {
    var subs = Math.max(1, Math.round(dt / 10)); // 子步=10ms
    var w = snapState.wind || { mag: 0, ang: 0 };
    var wx = Math.cos(w.ang / 8192 * TAU) * (w.mag / 100) | 0;
    var wy = Math.sin(w.ang / 8192 * TAU) * (w.mag / 100) | 0;
    for (var i = 0; i < projsLocal.length; i++) {
      var p = projsLocal[i];
      for (var s = 0; s < subs; s++) {
        p.x += p.vx + wx; p.y += p.vy + wy; p.z += p.vz; p.vz -= 30;
        if (p.z <= 0) { if (p.ammo === 1) fx.booms.push({ x: p.x, y: p.y, at: now(), r: 30000 }); p.dead = true; break }
      }
    }
    projsLocal = projsLocal.filter(function (p) { return !p.dead && p.x > -50000 && p.x < 390000 && p.y > -50000 && p.y < 550000 });
  }
  function sx(x) { return CX0 + x / K }
  function sy(y) { return CY0 + y / K }

  function draw(t) {
    ctx.save();
    var sh = fx.shake;
    if (sh > 0.3) ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
    /* 战场底（§7 铁灰） */
    ctx.fillStyle = '#2B2E33';
    ctx.fillRect(CX0, CY0, CW, CH);
    ctx.fillStyle = '#232629';
    ctx.fillRect(CX0, CY0, CW, 2); ctx.fillRect(CX0, CY0 + CH - 2, CW, 2);
    /* 占点圈（§2.5 中心 r=45px 渐染） */
    ctx.beginPath(); ctx.arc(sx(170000), sy(250000), 45, 0, TAU);
    ctx.strokeStyle = 'rgba(160,170,180,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    if (snapState.capBar > 0) {
      var capCol = snapState.capTeam === 0 ? TEAM_COL[0] : snapState.capTeam === 1 ? TEAM_COL[1] : '#888';
      ctx.beginPath(); ctx.arc(sx(170000), sy(250000), 45, -Math.PI / 2, -Math.PI / 2 + TAU * snapState.capBar / 100000);
      ctx.strokeStyle = capCol; ctx.lineWidth = 3.5; ctx.stroke();
    }
    /* F16 占点圈脉冲（capTick 进度变更 → 扩散圈 600ms；满点前呼吸加密） */
    if (t - fx.capPulseAt < 600) {
      var acp = t - fx.capPulseAt;
      fxD(fx.capRec);
      ctx.beginPath(); ctx.arc(sx(170000), sy(250000), 45 + acp * 0.05, 0, TAU);
      ctx.strokeStyle = 'rgba(232,163,61,' + (0.55 * (1 - acp / 600)).toFixed(2) + ')';
      ctx.lineWidth = 2; ctx.stroke();
    }
    /* F07/F13 履带印（双轨暗印+车向旋转；击毁者渐隐 1.5s，被毁原地焦印同链） */
    for (var tdi = fx.treads.length - 1; tdi >= 0; tdi--) {
      var tr = fx.treads[tdi], aT = 1;
      if (tr.fadeAt) {
        aT = 1 - (t - tr.fadeAt) / 1500;
        fxD(tr.rec); // F13 渐隐首绘（fadeAt 置位后的第一帧）
        if (aT <= 0) { fx.treads.splice(tdi, 1); continue }
      } else if (tr.rec) fxD(tr.rec); // F07 首绘
      ctx.save(); ctx.translate(sx(tr.x), sy(tr.y)); ctx.rotate((tr.dir || 0) / 8192 * TAU);
      /* 常轨印=沙土色（§7 视觉基调：履带印区域 #8A7A5C——铁灰底上高可读）；
       * 被毁焦印=炭黑（§3.4 焦黑残骸语言） */
      ctx.fillStyle = tr.wreck ? 'rgba(16,14,12,' + (0.72 * aT).toFixed(2) + ')' : 'rgba(138,122,92,' + (0.5 * aT).toFixed(2) + ')';
      if (tr.wreck) { ctx.fillRect(-9, -7, 18, 14) } else { ctx.fillRect(-1.8, -7.5, 3.6, 5.6); ctx.fillRect(-1.8, 1.9, 3.6, 5.6) }
      ctx.restore();
    }
    /* 掩体（tile：wall 混凝土/crate 木箱/rock 骨架） */
    if (tileTypes) for (var i = 0; i < tileTypes.length; i++) {
      var tv = tileTypes[i];
      if (!tv || (tiles && tiles[i] === 0 && tv !== 9)) continue;
      var gx = (i % 17) * 20 + CX0, gy = ((i / 17) | 0) * 20 + CY0;
      if (tv === 9) { ctx.fillStyle = '#1A1D21'; ctx.fillRect(gx, gy, 20, 20); continue }
      var hp = tiles ? tiles[i] : 255;
      var full = tv === 1 ? 255 : 69;
      var alpha = 0.45 + 0.55 * hp / full;
      if (tv === 1) { ctx.fillStyle = 'rgba(90,95,102,' + alpha.toFixed(2) + ')'; ctx.fillRect(gx + .5, gy + .5, 19, 19); ctx.fillStyle = 'rgba(200,205,212,' + (alpha * .5).toFixed(2) + ')'; ctx.fillRect(gx + .5, gy + .5, 19, 1.5) }
      else { ctx.fillStyle = 'rgba(139,107,74,' + alpha.toFixed(2) + ')'; ctx.fillRect(gx + 2, gy + 2, 16, 16); ctx.strokeStyle = 'rgba(90,70,48,.8)'; ctx.strokeRect(gx + 2.5, gy + 2.5, 15, 15) }
    }
    /* 弹道预览线（§3.3：本地同 sim 前瞻——tier normal 前半程+落点标记，v1 全程线） */
    var me = tanks[mySeat];
    if (me && me.alive && !ended) {
      var trace = S.previewTrace(me.x, me.y, me.tur, selAmmo, snapState.wind || { mag: 0, ang: 0 }, function (x, y) {
        var gx2 = (x / 20000) | 0, gy2 = (y / 20000) | 0;
        if (gx2 < 0 || gx2 >= 17 || gy2 < 0 || gy2 >= 25) return 9;
        var idx = gy2 * 17 + gx2;
        return tiles && tiles[idx] === 0 ? 0 : (tileTypes ? tileTypes[idx] : 0);
      }, 24);
      var pcol = TEAM_COL[0];
      /* F08 弹道预览线呼吸（基线 0.40-0.60 sin 摆动；fire 后 200ms 余晖抬升 §3.4） */
      var brA = 0.4 + 0.2 * (0.5 + 0.5 * Math.sin(t / 450));
      var afGlow = t - fx.breathAt;
      if (afGlow < 200) { brA = Math.min(0.95, brA + 0.35 * (1 - afGlow / 200)); fxD(fx.breathRec) }
      ctx.beginPath();
      ctx.setLineDash(selAmmo === 1 ? [4, 3] : []);
      ctx.moveTo(sx(trace[0].x), sy(trace[0].y) - trace[0].z / K);
      for (var ti = 1; ti < trace.length; ti++) ctx.lineTo(sx(trace[ti].x), sy(trace[ti].y) - trace[ti].z / K);
      ctx.strokeStyle = 'rgba(232,163,61,' + brA.toFixed(2) + ')'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([]);
      var lastPt = trace[trace.length - 1];
      ctx.beginPath(); ctx.arc(sx(lastPt.x), sy(lastPt.y), selAmmo === 1 ? 30 : 4, 0, TAU); // 落点标记（HE 附 AOE 圈）
      ctx.strokeStyle = 'rgba(232,163,61,.4)'; ctx.lineWidth = 1; ctx.stroke();
      void pcol;
    }
    /* 弹道（弹丸+影子——z 高度=分离可视；A 圆点实线/B 菱形虚线双编码 §7） */
    for (var pi = 0; pi < projsLocal.length; pi++) {
      var pr = projsLocal[pi];
      var px = sx(pr.x), pyS = sy(pr.y);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.arc(px, pyS, 2.5, 0, TAU); ctx.fill(); // 地面影子
      var py = sy(pr.y) - pr.z / K;
      var tc = TEAM_COL[((tanks[pr.seat] || {}).team) || 0];
      if (pr.ammo === 0) { ctx.fillStyle = tc; ctx.fillRect(px - 3, py - 1.5, 6, 3) } // AP 细长
      else { ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4); ctx.fillStyle = tc; ctx.fillRect(-2.6, -2.6, 5.2, 5.2); ctx.restore() } // HE 圆钝菱
    }
    /* 坦克（车体+履带+炮塔；A 圆盖/B 六角双编码）——GAMES-150 后坐三件套渲染期偏移：
     * F01 车体反向 2px+炮管后缩 6px→200ms 回弹（重坦 ×0.7/坦歼 ×1.3）、F03 炮塔
     * 震颤 ±1.2° 衰减 150ms（§3.2；全部不入 sim，纯绘制态）。 */
    for (var seat in tanks) {
      var p = tanks[seat];
      if (!p || !p.alive) continue;
      var x = sx(p.x), y = sy(p.y);
      var dir = (p.dir || 0) / 8192 * TAU, tur = (p.tur || 0) / 8192 * TAU;
      var rc = fx.recoil[seat], rcK = 0, jt = fx.jolt[seat], jtK = 0;
      if (rc && t - rc.at < 200) { rcK = (1 - (t - rc.at) / 200); fxD(rc.rec) } else fx.recoil[seat] = null;
      if (jt && t - jt.at < 150) { jtK = 1 - (t - jt.at) / 150; fxD(jt.rec) } else fx.jolt[seat] = null;
      var clsF = p.cls === 'heavy' ? 0.7 : p.cls === 'td' ? 1.3 : 1.0;
      var back = rcK * 2 * clsF; // 车体沿炮向反向位移（px）
      ctx.save(); ctx.translate(x - Math.cos(tur) * back, y - Math.sin(tur) * back); ctx.rotate(dir);
      ctx.fillStyle = '#3A3E44'; ctx.fillRect(-11, -9, 22, 18); // 车体
      ctx.fillStyle = '#2E3237'; ctx.fillRect(-11, -11, 22, 3.2); ctx.fillRect(-11, 7.8, 22, 3.2); // 履带
      ctx.restore();
      ctx.save(); ctx.translate(x - Math.cos(tur) * back, y - Math.sin(tur) * back);
      ctx.rotate(tur + Math.sin((t - (jt ? jt.at : 0)) / 24) * 0.021 * jtK); // F03 震颤（余弦衰减微摆）
      ctx.fillStyle = '#464B52'; ctx.fillRect(-rcK * 6 * clsF, -2.2, 16, 4.4); // 炮管后缩→回弹
      ctx.beginPath();
      if ((p.team || 0) === 0) ctx.arc(0, 0, 6.4, 0, TAU); // A 圆形炮塔盖
      else { ctx.moveTo(0, -7); for (var hx = 1; hx <= 6; hx++) { var a6 = hx / 6 * TAU; ctx.lineTo(Math.cos(a6) * 7, Math.sin(a6) * 7) } } // B 六角
      ctx.closePath();
      ctx.fillStyle = TEAM_COL[p.team || 0]; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = seat == mySeat ? 2 : 0.8; ctx.stroke(); // 己方白圈
      ctx.restore();
      /* HP 环（A 实心/B 分段——v1 简并弧长比例） */
      var hpr = (p.hp || 0) / (C.CLS[p.cls] || C.CLS.all).hp;
      if (hpr < 1) {
        ctx.beginPath(); ctx.arc(x, y, 13.5, -Math.PI / 2, -Math.PI / 2 + TAU * hpr);
        ctx.strokeStyle = hpr > .5 ? '#7DC87D' : hpr > .25 ? '#E8C23D' : '#E85D3D'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    /* fx：炮口焰（F02 焰锥+硝烟+弹壳）/火花/殉爆链/爆尘/碎块/飘字/光柱/受击弧 */
    fx.muzzle = fx.muzzle.filter(function (m2) { return t - m2.at < 140 });
    for (var mi = 0; mi < fx.muzzle.length; mi++) {
      var mz = fx.muzzle[mi], ag = t - mz.at;
      var mag = (tanks[mz.seat] || {}).tur;
      if (mag == null) mag = 0;
      var ma = mag / 8192 * TAU;
      if (mz.rec) fxD(mz.rec);
      if (mz.reborn) { ctx.beginPath(); ctx.arc(sx(mz.x), sy(mz.y), 4 + ag * 0.1, 0, TAU); ctx.fillStyle = 'rgba(120,220,255,' + (1 - ag / 140).toFixed(2) + ')'; ctx.fill(); continue }
      var fl = (mz.seat === mySeat ? 1 : 0.7) * (1 - ag / 140);
      ctx.save(); ctx.translate(sx(mz.x), sy(mz.y)); ctx.rotate(ma);
      ctx.fillStyle = 'rgba(255,210,110,' + fl.toFixed(2) + ')';               // 焰锥
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9 + ag * 0.1, -2.6); ctx.lineTo(9 + ag * 0.1, 2.6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,150,60,' + (fl * 0.8).toFixed(2) + ')';        // 外焰
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(5, -4); ctx.lineTo(7, 0); ctx.lineTo(5, 4); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.arc(sx(mz.x), sy(mz.y), 2 + ag * 0.18, 0, TAU);     // 硝烟晕
      ctx.fillStyle = 'rgba(200,190,170,' + (0.4 * (1 - ag / 140)).toFixed(2) + ')'; ctx.fill();
      var shAng = ma + Math.PI / 2 * (mz.seat % 2 ? 1 : -1);                   // 弹壳抛出（垂直炮向侧抛，§3.4）
      var shD = ag * 0.09;
      ctx.save(); ctx.translate(sx(mz.x) + Math.cos(shAng) * shD, sy(mz.y) + Math.sin(shAng) * shD - ag * 0.02); ctx.rotate(shAng + ag * 0.02);
      ctx.fillStyle = 'rgba(212,180,96,' + (1 - ag / 140).toFixed(2) + ')'; ctx.fillRect(-1.5, -1, 3, 2);
      ctx.restore();
    }
    /* F05 命中火花：正/侧/背三色（front 金黄/side 橙/rear 深红——部位差异化） */
    fx.sparks = fx.sparks.filter(function (sp) { return t - sp.at < 260 });
    var PART_COL = { front: [255, 211, 77], side: [255, 154, 61], rear: [255, 77, 77] };
    for (var si2 = 0; si2 < fx.sparks.length; si2++) {
      var sp2 = fx.sparks[si2], as = t - sp2.at, pc = PART_COL[sp2.part] || PART_COL.side;
      if (sp2.rec) fxD(sp2.rec);
      var nS = 7;
      for (var sk = 0; sk < nS; sk++) {
        var aS = sk / nS * TAU + (sp2.at % 97) * 0.02, dS = 3 + as * 0.085;
        ctx.fillStyle = 'rgba(' + pc[0] + ',' + pc[1] + ',' + pc[2] + ',' + (1 - as / 260).toFixed(2) + ')';
        ctx.fillRect(sx(sp2.x) + Math.cos(aS) * dS - 1, sy(sp2.y) + Math.sin(aS) * dS - 1, 2, 2);
      }
    }
    /* F06 掩体碎裂：tile 碎块抛物飞溅+尘雾（每堵墙的死去都是可见的战局变化，§3.4） */
    fx.crumbs = fx.crumbs.filter(function (cb) { return t - cb.at < 450 });
    for (var cbi = 0; cbi < fx.crumbs.length; cbi++) {
      var cb = fx.crumbs[cbi], ac = t - cb.at;
      if (cb.rec) fxD(cb.rec);
      var cxT = CX0 + (cb.tile % 17) * 20 + 10, cyT = CY0 + ((cb.tile / 17) | 0) * 20 + 10;
      ctx.beginPath(); ctx.arc(cxT, cyT, 6 + ac * 0.12, 0, TAU); // 尘雾
      ctx.fillStyle = 'rgba(150,140,120,' + (0.35 * (1 - ac / 450)).toFixed(2) + ')'; ctx.fill();
      for (var dk = 0; dk < 5; dk++) { // 碎块 3-5 块抛物
        var aD = dk / 5 * TAU + cb.tile * 0.3, dD = ac * 0.075 * (0.6 + (dk % 3) * 0.3);
        var fy = cyT + Math.sin(aD) * dD - Math.max(0, ac * 0.05 - ac * ac * 0.00018);
        ctx.fillStyle = 'rgba(110,105,98,' + (1 - ac / 450).toFixed(2) + ')';
        ctx.fillRect(cxT + Math.cos(aD) * dD - 1.6, fy - 1.6, 3.2, 3.2);
      }
    }
    /* F14 殉爆链：主爆后的 70/150ms 次级爆（到点起播——sfx 在 updateFeel 落） */
    fx.chain = fx.chain.filter(function (ch) { return t - ch.at < 380 });
    for (var chi = 0; chi < fx.chain.length; chi++) {
      var chn = fx.chain[chi], ach = t - chn.at;
      if (ach < 0) continue;
      ctx.beginPath(); ctx.arc(sx(chn.x), sy(chn.y), (chn.r / K) * (0.3 + ach / 380 * 0.7), 0, TAU);
      ctx.strokeStyle = 'rgba(255,140,70,' + (1 - ach / 380).toFixed(2) + ')'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx(chn.x), sy(chn.y), 2.5, 0, TAU);
      ctx.fillStyle = 'rgba(255,220,150,' + (1 - ach / 380).toFixed(2) + ')'; ctx.fill();
    }
    /* F17 重生光柱（基地光柱落下 500ms） */
    fx.beams = fx.beams.filter(function (bm) { return t - bm.at < 500 });
    for (var bmi = 0; bmi < fx.beams.length; bmi++) {
      var bm = fx.beams[bmi], abm = t - bm.at;
      if (bm.rec) fxD(bm.rec);
      var gr = ctx.createLinearGradient(0, sy(bm.y) - 46, 0, sy(bm.y));
      gr.addColorStop(0, 'rgba(140,225,255,0)');
      gr.addColorStop(1, 'rgba(140,225,255,' + (0.5 * (1 - abm / 500)).toFixed(2) + ')');
      ctx.fillStyle = gr; ctx.fillRect(sx(bm.x) - 7, sy(bm.y) - 46, 14, 46);
    }
    fx.booms = fx.booms.filter(function (b) { return t - b.at < 400 });
    for (var bi = 0; bi < fx.booms.length; bi++) {
      var bo = fx.booms[bi], ab = t - bo.at, rr2 = (bo.r / K) * (0.3 + ab / 400 * 0.7);
      if (bo.rec) fxD(bo.rec);
      ctx.beginPath(); ctx.arc(sx(bo.x), sy(bo.y), rr2, 0, TAU);
      ctx.strokeStyle = 'rgba(232,120,60,' + (1 - ab / 400).toFixed(2) + ')'; ctx.lineWidth = 2; ctx.stroke();
      if (bo.big) { ctx.beginPath(); ctx.arc(sx(bo.x), sy(bo.y), 3, 0, TAU); ctx.fillStyle = 'rgba(255,230,170,' + (1 - ab / 400).toFixed(2) + ')'; ctx.fill() }
    }
    /* F10 受击方向弧（入射向红弧 300ms——被绕侧时的方位知觉，§3.2） */
    if (fx.hurtArc && t - fx.hurtArc.at < 300) {
      var hA = fx.hurtArc, ahA = (hA.ang || 0) / 8192 * TAU, meH = tanks[mySeat] || { x: 170000, y: 250000 };
      fxD(hA.rec);
      ctx.beginPath(); ctx.arc(sx(meH.x), sy(meH.y), 19, ahA - 0.55, ahA + 0.55);
      ctx.strokeStyle = 'rgba(255,70,60,' + (1 - (t - hA.at) / 300).toFixed(2) + ')'; ctx.lineWidth = 3; ctx.stroke();
    }
    fx.floats = fx.floats.filter(function (f2) { return t - f2.at < 700 });
    for (var fi = 0; fi < fx.floats.length; fi++) {
      var fl = fx.floats[fi], af = t - fl.at;
      ctx.font = HF('dmg', 13, 7, 'P0');
      ctx.fillStyle = 'rgba(255,120,100,' + (1 - af / 700).toFixed(2) + ')';
      ctx.fillText(fl.v, sx(fl.x) - 8, sy(fl.y) - af * 0.02);
    }
    ctx.restore();
    drawHud(t);
  }
  /* ---------- HUD（顶栏 52px+底栏 111px，§7） ---------- */
  function drawHud(t) {
    /* 顶栏 */
    ctx.fillStyle = '#20242A'; ctx.fillRect(0, 0, W, 52);
    ctx.font = HF('lives', 15, 7, 'P0');
    ctx.textAlign = 'center';
    ctx.fillStyle = TEAM_COL[0];
    ctx.fillText('A ' + (snapState.lives ? snapState.lives[0] : 5), 46, 22);
    ctx.fillStyle = TEAM_COL[1];
    ctx.fillText((snapState.lives ? snapState.lives[1] : 5) + ' B', W - 46, 22);
    ctx.fillStyle = '#C8D2D8';
    var sec = Math.max(0, Math.ceil((snapState.clock || 0) / 20));
    ctx.fillText(Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2), W / 2, 22);
    /* 占点条 */
    var bw = 190;
    ctx.fillStyle = '#33383F'; ctx.fillRect((W - bw) / 2, 30, bw, 7);
    if (snapState.capBar > 0) {
      ctx.fillStyle = snapState.capTeam === 0 ? TEAM_COL[0] : TEAM_COL[1];
      ctx.fillRect((W - bw) / 2, 30, bw * snapState.capBar / 100000, 7);
    }
    ctx.font = HF('cap', 11, 6, 'P1');
    ctx.fillStyle = '#8A969E';
    ctx.fillText('占点 ' + Math.round((snapState.capBar || 0) / 1000) + '%', W / 2, 48);
    /* 风向旗（P1 读数+F18 旗面 sin 涟漪常摆，§2.3 HUD 常显——旗杆指向=风来向） */
    var w = snapState.wind || { mag: 0, ang: 0 };
    var wDir = ['→', '↓', '←', '↑'][Math.round((w.ang || 0) / 2048) % 4];
    ctx.textAlign = 'left';
    ctx.fillText('风 ' + wDir + ' ' + ((w.mag || 0) / 1000).toFixed(1), 8, 48);
    ctx.textAlign = 'center';
    var fxX = 62, fxY = 36, wA = ((w.ang || 0) + 4096) / 8192 * TAU; // 旗朝风吹去向（ang 来向+180°）
    ctx.save(); ctx.translate(fxX, fxY); ctx.rotate(wA);
    ctx.strokeStyle = 'rgba(200,210,220,.9)'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, 8); ctx.stroke();  // 旗杆
    var rip = 1 + (w.mag || 0) / 12000;                                  // 风强=涟漪幅度/频率
    ctx.beginPath(); ctx.moveTo(0, -8);
    for (var wseg = 1; wseg <= 3; wseg++) {
      var wx = wseg * 4, wy = -8 + Math.sin(t / (300 / rip) + wseg * 1.3) * 1.6 * rip;
      ctx.lineTo(wx, wy);
    }
    ctx.lineTo(12, 8); ctx.lineTo(0, 8); ctx.closePath();
    ctx.fillStyle = 'rgba(232,163,61,.65)'; ctx.fill();
    ctx.restore();
    if (!fx.windRec) fx.windRec = fxT('F18');
    fxD(fx.windRec); // F18 状态类首绘（旗常摆，报数不断言）
    /* 底栏（操作区） */
    ctx.fillStyle = '#181B1F'; ctx.fillRect(0, H - 111, W, 111);
    /* 摇杆底盘+帽 */
    var jx = stick ? stick.ox : 78, jy = stick ? stick.oy : H - 58;
    ctx.beginPath(); ctx.arc(jx, jy, 40, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.stroke();
    var hx2 = stick ? stick.x : jx, hy2 = stick ? stick.y : jy;
    var jd = Math.hypot(hx2 - jx, hy2 - jy);
    if (jd > 40) { hx2 = jx + (hx2 - jx) / jd * 40; hy2 = jy + (hy2 - jy) / jd * 40 }
    ctx.beginPath(); ctx.arc(hx2, hy2, 17, 0, TAU); ctx.fillStyle = 'rgba(200,210,220,.28)'; ctx.fill();
    /* 瞄准盘（右半浮动态+v1 静态底盘提示） */
    var ax2 = aimPad ? aimPad.ox : W - 200, ay2 = aimPad ? aimPad.oy : H - 58;
    ctx.beginPath(); ctx.arc(ax2, ay2, 34, 0, TAU); ctx.strokeStyle = 'rgba(61,200,232,.25)'; ctx.stroke();
    /* fire 钮 Ø64+装填环+弹药（P0）——F04 满装辉光（cd>0→0 → 300ms 金辉脉冲） */
    var me = tanks[mySeat] || {};
    var cdFrac = Math.max(0, Math.min(1, (me.cd || 0) / 50));
    var afGlow2 = t - fx.glowAt;
    ctx.beginPath(); ctx.arc(FIRE_C.x, FIRE_C.y, FIRE_R, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - cdFrac));
    ctx.strokeStyle = cdFrac > 0 ? '#8A4A3D' : TEAM_COL[0]; ctx.lineWidth = 4; ctx.stroke();
    if (afGlow2 >= 0 && afGlow2 < 300) {
      fxD(fx.glowRec);
      ctx.beginPath(); ctx.arc(FIRE_C.x, FIRE_C.y, FIRE_R + 3 + afGlow2 * 0.03, 0, TAU);
      ctx.strokeStyle = 'rgba(255,215,120,' + (0.8 * (1 - afGlow2 / 300)).toFixed(2) + ')'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(FIRE_C.x, FIRE_C.y, FIRE_R - 5, 0, TAU); ctx.fillStyle = 'rgba(60,64,70,.9)'; ctx.fill();
    ctx.font = HF('ammo', 13, 7, 'P0');
    ctx.fillStyle = cdFrac > 0 ? '#7A5A50' : '#F0D8A8';
    ctx.fillText('FIRE', FIRE_C.x, FIRE_C.y + 1);
    /* 弹种钮 Ø44（当前弹+余弹 P0）——F11 切换脉冲（250ms 缩放+环闪） */
    var afSwap = t - fx.swapAt, swK = afSwap >= 0 && afSwap < 250 ? 1 + 0.16 * (1 - afSwap / 250) : 1;
    if (afSwap >= 0 && afSwap < 250) fxD(fx.swapRec);
    ctx.save(); ctx.translate(AMMO_C.x, AMMO_C.y); ctx.scale(swK, swK);
    ctx.beginPath(); ctx.arc(0, 0, AMMO_R, 0, TAU);
    ctx.fillStyle = selAmmo === 0 ? 'rgba(90,110,130,.85)' : 'rgba(150,90,60,.85)'; ctx.fill();
    ctx.strokeStyle = afSwap >= 0 && afSwap < 250 ? 'rgba(255,225,150,' + (1 - afSwap / 250).toFixed(2) + ')' : 'rgba(255,255,255,.3)';
    ctx.lineWidth = afSwap >= 0 && afSwap < 250 ? 2.5 : 1; ctx.stroke();
    ctx.font = HF('ammoSel', 13, 7, 'P0');
    ctx.fillStyle = '#fff';
    var ammoArr = [me.a0 != null ? me.a0 : 15, me.a1 != null ? me.a1 : 8]; // 快照 a0/a1（增量账本字段）
    ctx.fillText((selAmmo === 0 ? 'AP' : 'HE'), 0, -3);
    ctx.fillText('' + ammoArr[selAmmo], 0, 12);
    ctx.restore();
    /* F09 受伤红屏边缘（我席被命中 → 战场缘红晕 300ms；clip 战场域=顶/底栏锚点零污染） */
    if (fx.hurtAt > 0 && t - fx.hurtAt < 300) {
      fxD(fx.hurtRec);
      var hA2 = 0.5 * (1 - (t - fx.hurtAt) / 300);
      ctx.save(); ctx.beginPath(); ctx.rect(CX0, CY0, CW, CH); ctx.clip();
      var hvG = ctx.createLinearGradient(0, CY0, 0, CY0 + 60);
      hvG.addColorStop(0, 'rgba(232,60,50,' + hA2.toFixed(2) + ')'); hvG.addColorStop(1, 'rgba(232,60,50,0)');
      ctx.fillStyle = hvG; ctx.fillRect(CX0, CY0, CW, 60);
      var hvG2 = ctx.createLinearGradient(0, CY0 + CH - 60, 0, CY0 + CH);
      hvG2.addColorStop(0, 'rgba(232,60,50,0)'); hvG2.addColorStop(1, 'rgba(232,60,50,' + hA2.toFixed(2) + ')');
      ctx.fillStyle = hvG2; ctx.fillRect(CX0, CY0 + CH - 60, CW, 60);
      ctx.restore();
    }
    /* F12 击杀特写横幅（名签 P1；冲入=前 240ms 缩放+位移滑入） */
    if (fx.deadBanner && t - fx.deadBanner.at < 1500) {
      var bA = t - fx.deadBanner.at, bK = bA < 240 ? bA / 240 : 1;
      fxD(fx.deadBanner.rec);
      ctx.save(); ctx.translate(W / 2, 76 - (1 - bK) * 14); ctx.scale(0.7 + 0.3 * bK, 0.7 + 0.3 * bK);
      ctx.font = HF('killBanner', 12, 6, 'P1');
      ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * (bA < 1200 ? 1 : (1500 - bA) / 300)).toFixed(2) + ')';
      ctx.fillText('seat' + fx.deadBanner.by + ' 击毁 seat' + fx.deadBanner.victim, 0, 0);
      ctx.restore();
    }
    /* 结算页（§7：胜负大字+战报条+再来一局）——F15 胜负分歧动效（胜=阵营色彩雨
     * 60 粒/败=压暗+大字自下渐入+按钮迟现 400ms；平局随败臂无彩雨） */
    if (ended && endResult) {
      var eA = fx.endAt > 0 ? t - fx.endAt : 999;
      fxD(fx.endRec);
      var win = endResult.winner === 'A' ? 0 : endResult.winner === 'B' ? 1 : -1;
      var iWin = win >= 0 && mySeat >= 0 && win === (mySeat & 1);
      ctx.fillStyle = 'rgba(10,12,15,' + (iWin ? 0.82 : Math.min(0.9, 0.7 + eA * 0.0004)).toFixed(2) + ')';
      ctx.fillRect(0, 0, W, H);
      if (iWin && eA < 4000) { // 彩雨：阵营双色+白，三频三角相位（无 rng——idx 三角函数派生；36 粒=帧成本帽）
        for (var cf = 0; cf < 36; cf++) {
          var cfX = (cf * 61 + ((eA * 0.06 + cf * 17) % 41)) % W, cfY = ((eA * 0.22 + cf * 83) % (H + 60)) - 30;
          var cfC = cf % 3 === 0 ? TEAM_COL[win] : cf % 3 === 1 ? '#FFFFFF' : (win === 0 ? TEAM_COL[1] : TEAM_COL[0]);
          ctx.save(); ctx.translate(cfX, cfY); ctx.rotate(cf + eA * 0.004);
          ctx.fillStyle = cfC; ctx.globalAlpha = 0.85; ctx.fillRect(-2, -3.5, 4, 7); ctx.restore();
        }
        ctx.globalAlpha = 1;
      }
      var eIn = Math.max(0, Math.min(1, (eA - 120) / 380)); // 大字渐入（自下 12px）
      ctx.font = HF('endBig', 26, 7, 'P0');
      ctx.fillStyle = win < 0 ? '#C8D2D8' : TEAM_COL[win];
      ctx.fillText(win < 0 ? '平局' : (iWin ? '胜利' : '败北'), W / 2, H / 2 - 60 + (1 - eIn) * 12);
      if (eA > 400) {
        ctx.font = HF('endSub', 12, 6, 'P1');
        ctx.fillStyle = '#8A969E';
        ctx.fillText('终局 · ' + (endResult.reason || '') + ' · winner=' + endResult.winner, W / 2, H / 2 - 34);
        ctx.font = HF('endBtn', 14, 6, 'P1');
        ctx.fillStyle = '#E8A33D';
        ctx.fillText('点击再来一局', W / 2, H / 2 + 40);
        ctx.fillText('返回大厅', W / 2, H / 2 + 66);
      }
    }
    ctx.textAlign = 'left';
    /* 页脚 slug·version（P2） */
    ctx.font = HF('slug', 9, 4, 'P2');
    ctx.fillStyle = 'rgba(140,150,158,.5)';
    ctx.fillText('iron-torrent · S4 ' + S.ENGINE, 6, H - 4);
  }
  el.addEventListener('touchstart', function (ev) { // 结算页触控
    if (ended && endResult) {
      var p = pt(ev.changedTouches[0]);
      if (p.y > H / 2 + 24 && p.y < H / 2 + 52) location.href = '/multiplayer.html';
      else if (ended) location.reload();
      ev.preventDefault();
    }
  }, { passive: false });
  /* ---------- 调试面（识图/QA 钩子；GAMES-150 增 fx 台账/音效位/场景驱动器/perf） ---------- */
  function fxScene(name) { // 手感场景驱动（QA 取证入口：事件类走 fxProbe，本地/状态类在此）
    var t = now(), me = tanks[mySeat] || {};
    if (name === 'calm') { // 清瞬态（采样/锚点用；履带印为持续设计态保留）
      fx.muzzle.length = 0; fx.sparks.length = 0; fx.crumbs.length = 0; fx.floats.length = 0;
      fx.booms.length = 0; fx.chain.length = 0; fx.beams.length = 0; fx.hurtArc = null;
      fx.shake = 0; fx.swapAt = -1e9; fx.glowAt = -1e9; fx.breathAt = -1e9; fx.capPulseAt = -1e9;
      fx.hurtAt = -1e9; fx.deadBanner = null;
      return true;
    }
    if (name === 'fire') { // 后坐三件套+炮口焰+预览余晖（走同一 onEvent 管线；参数取当前炮塔角）
      var fs2 = me.alive ? mySeat : -1;                 // QA 驱动容错：我席阵亡窗回退任一存活席（F08 余晖仍只挂我席）
      if (fs2 < 0) for (var sk2 in tanks) if (tanks[sk2] && tanks[sk2].alive) { fs2 = +sk2; break }
      if (fs2 < 0) return false;
      var sh = tanks[fs2] || {}, ang = sh.tur || 0, A0 = C.AMMO[0];
      onEvent({ k: 'fire', seat: fs2, ammo: 0, ang: ang, x: sh.x || 170000, y: sh.y || 250000,
        vx: Math.cos(ang / 8192 * TAU) * A0.vh | 0, vy: Math.sin(ang / 8192 * TAU) * A0.vh | 0, vz: A0.vz });
      return true;
    }
    if (name === 'reload') { fx.glowAt = t; fx.glowRec = fxT('F04'); sfx('reloadClick'); return true } // F04 QA 驱动（真时点=cd 跳变检测）
    if (name === 'hit') { onEvent({ k: 'hit', seat: (mySeat + 1) % 4, victim: mySeat, dmg: 30, angIn: 2048, part: 'side' }); return true } // F05/F09/F10（我席被命中）
    if (name === 'hitFoe') { var f2 = tanks[(mySeat + 1) % 4] || {}; onEvent({ k: 'hit', seat: mySeat, victim: (mySeat + 1) % 4, dmg: 30, angIn: 0, part: 'rear' }); return true } // F05 背面三色（victim=他席）
    if (name === 'crumble') { // F06：任选一块在场掩体 tile
      var pick = 200;
      if (tileTypes) for (var pt2 = 0; pt2 < tileTypes.length; pt2++) if (tileTypes[pt2] === 1) { pick = pt2; break }
      onEvent({ k: 'crumble', tile: pick });
      return true;
    }
    if (name === 'kill') { onEvent({ k: 'kill', seat: mySeat, victim: (mySeat + 1) % 4 }); return true } // F12/F13/F14
    if (name === 'cap') { onEvent({ k: 'capTick', team: 0, bar: Math.max(1, fx.prevCap + 550) }); return true } // F16 推进脉冲
    if (name === 'capAlert') { onEvent({ k: 'capTick', team: 0, bar: 91000 }); return true } // 满点前警报
    if (name === 'swap') { onEvent({ k: 'swapFx' }); return true } // F11
    if (name === 'respawn') { onEvent({ k: 'respawn', seat: mySeat, x: me.x || 170000, y: me.y || 450000 }); return true } // F17
    if (name === 'engine') { // F07+engineHum：原地落一枚我席履带印+嗡鸣（真时点=行进 14px 步进）
      fx.treads.push({ x: me.x || 170000, y: me.y || 250000, dir: me.dir || 0, seat: mySeat, at: t, rec: fxT('F07') });
      sfx('engineHum');
      return true;
    }
    if (name === 'reject') { onEvent({ k: 'reject', op: 'fire', why: 'cd' }); return true }
    if (name === 'end') { // F15 终局批（两段式后置——世界层探针批先走，street GAMES-141 口径）
      if (!endResult) endResult = { winner: mySeat % 2 === 0 ? 'A' : 'B', reason: 'qa-feel' };
      ended = true; endFx();
      return true;
    }
    return false;
  }
  window.__GAMES_DEBUG__.state = function () {
    var me = tanks[mySeat] || {};
    return { seat: mySeat, phase: snapState.phase, ended: ended, alive: me.alive ? 1 : 0,
      cd: me.cd || 0, capBar: snapState.capBar, wind: snapState.wind, frame: srvFrame,
      players: Object.keys(tanks).length, selAmmo: selAmmo };
  };
  window.__GAMES_DEBUG__.pause = function (v) { paused = !!v };
  window.__GAMES_DEBUG__.perf = function () {
    var cs = perfLog.costs.slice(-180), gs = perfLog.gaps.slice(-180);
    var avg = cs.length ? cs.reduce(function (a, b) { return a + b }, 0) / cs.length : 0;
    var sorted = cs.slice().sort(function (a, b) { return a - b });
    var gAvg = gs.length ? gs.reduce(function (a, b) { return a + b }, 0) / gs.length : 0;
    return { n: cs.length, costAvgMs: +avg.toFixed(2), costP95Ms: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2),
      costJankPct: +(cs.filter(function (c) { return c > 25 }).length / Math.max(1, cs.length) * 100).toFixed(2), rafGapMs: +gAvg.toFixed(1) };
  };
  window.__GAMES_DEBUG__.fxProbe = function (ev) { onEvent(ev); return true }; // 合成事件走同一 onEvent 管线
  window.__GAMES_DEBUG__.fxScene = fxScene;
  window.__GAMES_DEBUG__.fxList = function () { return FXLIST.map(function (f) { return { id: f[0], name: f[1], cls: f[2] } }) };
  window.__GAMES_DEBUG__.fxLedger = function () { return fxLedger.map(function (l) { return { id: l.id, trig: Math.round(l.trig), lat: l.lat } }) };
  window.__GAMES_DEBUG__.sfxGroups = function () { return { on: SND.on, slots: SND.slots.slice(), fired: Object.keys(SND.fired), calls: SND.calls.slice() } };
  window.__GAMES_DEBUG__.sndOn = function (v) { SND.on = !!v };
  /* 页脚版本行自证（P2 在场） */
  emitDbg('boot', { engine: S.ENGINE, hash: S.ENGINE_HASH, appliedCheck: appliedSelfCheck() });
  connect();
  requestAnimationFrame(loop);
})();
