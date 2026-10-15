/* 钢铁洪流 client（GAMES-146 · S4 预测弹道）——左摇杆驾驶+右瞄准盘+fire+弹种钮；
 * 自身坦克本地预测（input ring+ack 和解软收敛，kart 范式）+他人快照外推；
 * 弹道=fire 事件起段本地确定性重演（离散段重演，pool 范式）+快照 projs 兜底；
 * 弹道预览线=本地同 sim 前瞻（previewTrace 三面同源，§5.5）——「预测」与「权威」
 * 的分界只在输入时点不在算法。
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
    ctx.font = '700 13px sans-serif';
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

  /* ---------- 连接态 ---------- */
  var ws = null, mySeat = -1, ended = false, endResult = null;
  var tanks = {};                          // 席位→权威态（快照）
  var projsLocal = [];                     // 本地重演弹道段（fire 事件起段）
  var snapState = { phase: 'play', clock: C.MAX_TICKS, capBar: 0, capTeam: -1, lives: [5, 5], map: 'm-cross', wind: { mag: 0, ang: 0 } };
  var tiles = null;                        // 掩体耐久档（全量快照/增量脏 tile）
  var tileTypes = null;                    // 掩体类型（全量）
  var srvFrame = -1, srvAt = 0, lastQ = -1, inRing = [];   // 快照锚（F1 修复，GAMES-148）：frame 推算基准
  var fx = { muzzle: [], booms: [], crumbs: [], floats: [], shake: 0, recols: {}, deadBanner: null };

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
      else if (msg.t === 'end') { ended = true; endResult = msg.result }
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
  /* ---------- 事件（表现层；权威态在快照，§7 红线） ---------- */
  function onEvent(e) {
    if (e.k === 'fire') { // 确定性重演起点：事件携参直读（含散布出射角——零推导）
      projsLocal.push({ id: e.seat * 100000 + projsLocal.length + Math.floor(now() % 100000), seat: e.seat, ammo: e.ammo, x: e.x, y: e.y, z: e.z || 14000, vx: e.vx, vy: e.vy, vz: e.vz });
      fx.muzzle.push({ x: e.x, y: e.y, at: now(), seat: e.seat });
      fx.shake = Math.min(8, fx.shake + (e.seat === mySeat ? 4 : 1));
      emitDbg('fire', e);
    } else if (e.k === 'hit') {
      fx.floats.push({ x: (tanks[e.victim] || {}).x || 0, y: ((tanks[e.victim] || {}).y || 0) - 20000, v: '-' + e.dmg, at: now(), col: TEAM_COL[(tanks[e.seat] || {}).team || 0] });
      if (e.victim === mySeat) { fx.shake = Math.min(10, fx.shake + 5); fx.recols[e.part] = { at: now() } }
      emitDbg('hit', e);
    } else if (e.k === 'splash') {
      fx.booms.push({ x: e.x, y: e.y, at: now(), r: 30000 });
    } else if (e.k === 'crumble') {
      fx.crumbs.push({ tile: e.tile, at: now() });
      if (tiles) tiles[e.tile] = 0;
      if (tileTypes) tileTypes[e.tile] = 0;
      emitDbg('crumble', e);
    } else if (e.k === 'kill') {
      fx.booms.push({ x: (tanks[e.victim] || {}).x || 0, y: (tanks[e.victim] || {}).y || 0, at: now(), r: 26000, big: true });
      fx.deadBanner = { by: e.seat, victim: e.victim, at: now() };
      emitDbg('kill', e);
    } else if (e.k === 'respawn') {
      fx.muzzle.push({ x: e.x, y: e.y, at: now(), reborn: true });
    } else if (e.k === 'reject') { emitDbg('reject', e) }
    else if (e.k === 'end') { ended = true; endResult = e }
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
  function loop() {
    var t = now(), dt = Math.min(50, t - lastT); lastT = t;
    if (fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt * 0.04);
    stepProjs(dt);
    draw(t);
    requestAnimationFrame(loop);
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
      ctx.beginPath();
      ctx.setLineDash(selAmmo === 1 ? [4, 3] : []);
      ctx.moveTo(sx(trace[0].x), sy(trace[0].y) - trace[0].z / K);
      for (var ti = 1; ti < trace.length; ti++) ctx.lineTo(sx(trace[ti].x), sy(trace[ti].y) - trace[ti].z / K);
      ctx.strokeStyle = 'rgba(232,163,61,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
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
    /* 坦克（车体+履带印+炮塔；A 圆盖/B 六角双编码） */
    for (var seat in tanks) {
      var p = tanks[seat];
      if (!p || !p.alive) continue;
      var x = sx(p.x), y = sy(p.y);
      var dir = (p.dir || 0) / 8192 * TAU, tur = (p.tur || 0) / 8192 * TAU;
      ctx.save(); ctx.translate(x, y); ctx.rotate(dir);
      ctx.fillStyle = '#3A3E44'; ctx.fillRect(-11, -9, 22, 18); // 车体
      ctx.fillStyle = '#2E3237'; ctx.fillRect(-11, -11, 22, 3.2); ctx.fillRect(-11, 7.8, 22, 3.2); // 履带
      ctx.restore();
      ctx.save(); ctx.translate(x, y); ctx.rotate(tur);
      ctx.fillStyle = '#464B52'; ctx.fillRect(0, -2.2, 16, 4.4); // 炮管
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
    /* fx：炮口焰/爆尘/碎块/飘字 */
    fx.muzzle = fx.muzzle.filter(function (m2) { return t - m2.at < 140 });
    for (var mi = 0; mi < fx.muzzle.length; mi++) {
      var mz = fx.muzzle[mi], ag = t - mz.at;
      ctx.beginPath(); ctx.arc(sx(mz.x), sy(mz.y), 3 + ag * 0.12, 0, TAU);
      ctx.fillStyle = 'rgba(255,190,90,' + (1 - ag / 140).toFixed(2) + ')'; ctx.fill();
    }
    fx.booms = fx.booms.filter(function (b) { return t - b.at < 400 });
    for (var bi = 0; bi < fx.booms.length; bi++) {
      var bo = fx.booms[bi], ab = t - bo.at, rr2 = (bo.r / K) * (0.3 + ab / 400 * 0.7);
      ctx.beginPath(); ctx.arc(sx(bo.x), sy(bo.y), rr2, 0, TAU);
      ctx.strokeStyle = 'rgba(232,120,60,' + (1 - ab / 400).toFixed(2) + ')'; ctx.lineWidth = 2; ctx.stroke();
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
    /* 风向旗（P1 读数，§2.3 HUD 常显） */
    var w = snapState.wind || { mag: 0, ang: 0 };
    var wDir = ['→', '↓', '←', '↑'][Math.round((w.ang || 0) / 2048) % 4];
    ctx.textAlign = 'left';
    ctx.fillText('风 ' + wDir + ' ' + ((w.mag || 0) / 1000).toFixed(1), 8, 48);
    ctx.textAlign = 'center';
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
    /* fire 钮 Ø64+装填环+弹药（P0） */
    var me = tanks[mySeat] || {};
    var cdFrac = Math.max(0, Math.min(1, (me.cd || 0) / 50));
    ctx.beginPath(); ctx.arc(FIRE_C.x, FIRE_C.y, FIRE_R, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - cdFrac));
    ctx.strokeStyle = cdFrac > 0 ? '#8A4A3D' : TEAM_COL[0]; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.arc(FIRE_C.x, FIRE_C.y, FIRE_R - 5, 0, TAU); ctx.fillStyle = 'rgba(60,64,70,.9)'; ctx.fill();
    ctx.font = HF('ammo', 13, 7, 'P0');
    ctx.fillStyle = cdFrac > 0 ? '#7A5A50' : '#F0D8A8';
    ctx.fillText('FIRE', FIRE_C.x, FIRE_C.y + 1);
    /* 弹种钮 Ø44（当前弹+余弹 P0） */
    ctx.beginPath(); ctx.arc(AMMO_C.x, AMMO_C.y, AMMO_R, 0, TAU);
    ctx.fillStyle = selAmmo === 0 ? 'rgba(90,110,130,.85)' : 'rgba(150,90,60,.85)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.stroke();
    ctx.font = HF('ammoSel', 13, 7, 'P0');
    ctx.fillStyle = '#fff';
    var ammoArr = me.ammo || [15, 8];
    ctx.fillText((selAmmo === 0 ? 'AP' : 'HE'), AMMO_C.x, AMMO_C.y - 3);
    ctx.fillText('' + ammoArr[selAmmo], AMMO_C.x, AMMO_C.y + 12);
    /* 击毁横幅（名签 P1） */
    if (fx.deadBanner && t - fx.deadBanner.at < 1500) {
      ctx.font = HF('killBanner', 12, 6, 'P1');
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillText('seat' + fx.deadBanner.by + ' 击毁 seat' + fx.deadBanner.victim, W / 2, 76);
    }
    /* 结算页（§7：胜负大字+战报条+再来一局） */
    if (ended && endResult) {
      ctx.fillStyle = 'rgba(10,12,15,.88)'; ctx.fillRect(0, 0, W, H);
      var win = endResult.winner === 'A' ? 0 : endResult.winner === 'B' ? 1 : -1;
      ctx.font = HF('endBig', 26, 7, 'P0');
      ctx.fillStyle = win < 0 ? '#C8D2D8' : TEAM_COL[win];
      ctx.fillText(win < 0 ? '平局' : (win === (mySeat & 1) ? '胜利' : '败北'), W / 2, H / 2 - 60);
      ctx.font = HF('endSub', 12, 6, 'P1');
      ctx.fillStyle = '#8A969E';
      ctx.fillText('终局 · ' + (endResult.reason || '') + ' · winner=' + endResult.winner, W / 2, H / 2 - 34);
      ctx.font = HF('endBtn', 14, 6, 'P1');
      ctx.fillStyle = '#E8A33D';
      ctx.fillText('点击再来一局', W / 2, H / 2 + 40);
      ctx.fillText('返回大厅', W / 2, H / 2 + 66);
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
  /* 页脚版本行自证（P2 在场） */
  emitDbg('boot', { engine: S.ENGINE, hash: S.ENGINE_HASH, appliedCheck: appliedSelfCheck() });
  connect();
  requestAnimationFrame(loop);
})();
