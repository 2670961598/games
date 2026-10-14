/* 街头足球 client（GAMES-138 · S3+S4）——虚拟摇杆+射门/传球/冲刺三钮；
 * 自身球员本地预测（input ring+ack 和解，kart 子集）；他人 100ms 插值；
 * 球=速度外推+围板反射本地预演（确定性段重演 v1 降级口径，REPORT 披露）；
 * 持球权/比分/相位以快照 state 为准（events 只作 juice，§7 入房红线）。
 * HUD 字号走 HF 登记表（hud-font-standard §1；运行时 __GAMES_DEBUG__.hudFonts 自证）。 */
(function () {
  'use strict';
  var W = 375, H = 667;
  var K = 1000;                      // milli-px → px
  var CX0 = 12, CY0 = 56;            // 球场内域左上（350×500 1:1 居中，§2.1）
  var CW = 350, CH = 500;
  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var hintEl = document.getElementById('hint');
  var S = window.StreetSim, C = S.consts;
  var now = function () { return performance.now() };
  var pnow = now;

  /* ---------- HUD 字号登记表（HF 体系） ---------- */
  var HF_REG = {}, dbgEvents = [];
  function HF(tag, px, weight, cls) {
    var f = px + 'px ' + weight + '00';
    HF_REG[tag] = { px: px, weight: weight, cls: cls, at: now() };
    return f;
  }
  function fmtTime(ticks) { // play tick → mm:ss
    var s = Math.max(0, Math.ceil(ticks / 20));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function emitDbg(ev, payload) { dbgEvents.push({ event: ev, payload: payload, at: now() }); if (dbgEvents.length > 120) dbgEvents.shift(); }

  /* ---------- 连接态 ---------- */
  var ws = null, mySeat = -1, ended = false, endResult = null, roomState = null;
  var players = {}, ball = { x: 175 * K, y: 250 * K, vx: 0, vy: 0, owner: -1, lastT: -1, w: 0 };
  var snapState = { phase: 'kick', clock: 3600, score: { A: 0, B: 0 }, poss: -1, kickTeam: 0, ot: 0 };
  var fx = { rings: [], parts: [], floats: [], shake: 0, trail: [], flash: 0 };
  var seq = 0, inRing = [];           // 预测输入环（ack 和解）
  var snaps = [];                      // 他人插值缓冲

  function hint(t) { hintEl.textContent = t; hintEl.style.display = t ? 'block' : 'none' }
  function fatal(t) { document.getElementById('fatal-msg').textContent = t; document.getElementById('fatal').style.display = 'flex' }
  function connect() {
    var q = new URLSearchParams(location.search);
    var gw = q.get('gw') || (location.protocol + '//' + location.hostname + ':4400');
    var rid = q.get('room');
    try { var ss = sessionStorage.getItem('ss-rid'); if (!rid && ss) rid = ss } catch (e) { /* 隐私模式 */ }
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
    if (rid) { send({ t: 'join', roomId: rid }); try { sessionStorage.setItem('ss-rid', rid) } catch (e) {} }
    else send({ t: 'quick', gameId: 'street-soccer' });
  }
  function onWelcome(msg, rid) {
    mySeat = msg.role === 'player' ? msg.seat : -1;
    if (msg.room && msg.room.physics && msg.room.physics.engine !== S.ENGINE) hint('引擎版本不符，回退插值模式');
    if (!rid && msg.roomId) { try { sessionStorage.setItem('ss-rid', msg.roomId) } catch (e) {} }
    if (msg.state) applyState(msg.state);
    hint(mySeat < 0 ? '观战中 · 围笼球场' : '');
    emitDbg('welcome', { seat: mySeat, engine: msg.room && msg.room.physics && msg.room.physics.engine });
  }
  function applyState(st) {
    if (st.players) for (var i = 0; i < st.players.length; i++) {
      var p = st.players[i];
      if (!p) { delete players[i]; continue }
      players[i] = players[i] || {};
      Object.assign(players[i], p);
      players[i].rx = p.x; players[i].ry = p.y; players[i].lpos = [{ x: p.x, y: p.y, at: now() }];
    }
    if (st.ball) { Object.assign(ball, st.ball); ball.rx = st.ball.x; ball.ry = st.ball.y }
    if (st.score) snapState.score = st.score;
    if (st.phase) snapState.phase = st.phase;
  }

  /* ---------- 快照（二式）+ 预测和解 ---------- */
  function touchEnt(e) {
    if (e.id === 'ball') { ball.rx = e.x; ball.ry = e.y; if (e.vx !== undefined) { ball.vx = e.vx; ball.vy = e.vy; ball.w = e.w || 0 } if (e.owner !== undefined) ball.owner = e.owner; if (e.lastT !== undefined) ball.lastT = e.lastT; return }
    var i = parseInt(e.id.slice(1), 10);
    if (isNaN(i)) return;
    players[i] = players[i] || { lpos: [] };
    if (e.x !== undefined) { e.rx = e.x; e.ry = e.y }
    var prev = { x: e.x !== undefined ? e.x : players[i].x, y: e.y !== undefined ? e.y : players[i].y };
    for (var k in e) players[i][k] = e[k];
    players[i].x = prev.x; players[i].y = prev.y;
    players[i].lpos = (players[i].lpos || []).concat([{ x: prev.x, y: prev.y, at: now() }]).slice(-10);
  }
  function onSnapshot(msg) {
    var ack = msg.ext && msg.ext.ack;
    snaps.push({ at: now(), msg: msg });
    if (snaps.length > 30) snaps.shift();
    if (msg.full) { players = {}; for (var k in players) delete players[k] }
    for (var i = 0; i < (msg.ents || []).length; i++) touchEnt(msg.ents[i]);
    if (msg.state) {
      snapState.phase = msg.state.phase; snapState.clock = msg.state.clock;
      snapState.score = msg.state.score; snapState.poss = msg.state.poss;
      snapState.kickTeam = msg.state.kickTeam; snapState.ot = msg.state.ot;
    }
    /* 自身和解：回滚至权威态@frame → 重放未确认输入（RTT 窗 4-8 条） */
    if (mySeat >= 0 && players[mySeat] && typeof ack === 'number' && ack >= 0) {
      var me = players[mySeat];
      me.x = me.rx; me.y = me.ry;
      for (var j = 0; j < inRing.length; j++) if (inRing[j].q > ack) applyMove(me, inRing[j], 1);
      var dx = me.x - me.rx, dy = me.y - me.ry, d = Math.hypot(dx, dy);
      if (d > 6 * K) { me.x = me.rx; me.y = me.ry } else if (d > 0) { me.x = me.rx + dx * 0.35; me.y = me.ry + dy * 0.35 }
      while (inRing.length && inRing[0].q <= ack) inRing.shift();
    }
    for (var ev = 0; ev < (msg.events || []).length; ev++) onEvent(msg.events[ev]);
  }
  function applyMove(p, inp, mul) {
    var spd = (C.CLS[p.cls] || C.CLS.all).spd;
    if (inp.sp) spd = (C.CLS[p.cls] || C.CLS.all).sprint;
    if (ball.owner === p.seat) spd = spd * 241 >> 8;
    p.x += spd * inp.mx / 100 * mul;
    p.y += spd * inp.my / 100 * mul;
  }

  /* ---------- 事件 juice（events 只作表现，权威态在快照 §7 红线） ---------- */
  function burst(x, y, col, n, spd) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = spd * (0.4 + Math.random() * 0.6);
      fx.parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, at: now(), col: col });
    }
    if (fx.parts.length > 160) fx.parts.splice(0, fx.parts.length - 160);
  }
  function onEvent(e) {
    var k = e.k;
    if (k === 'touch') { burst(ball.rx || ball.x, ball.ry || ball.y, '#cfd6e4', 6, 40); emitDbg('touch', e) }
    else if (k === 'steal') { fx.flash = 1; burst(ball.x, ball.y, '#ffffff', 12, 70); emitDbg('steal', e) }
    else if (k === 'goal') {
      fx.shake = 1; fx.flash = 1;
      fx.floats.push({ txt: (e.team === 'A' ? '琥珀' : '青蓝') + ' 进球！', at: now(), col: e.team === 'A' ? '#E8A33D' : '#3DC8E8' });
      emitDbg('goal', e);
    }
    else if (k === 'ot') fx.floats.push({ txt: '金球加时 · 下一球定生死', at: now(), col: '#FFD86B' });
    else if (k === 'wall') { fx.rings.push({ x: e.x, y: e.y, at: now(), col: '#5a6472' }); if (fx.rings.length > 24) fx.rings.shift() }
    else if (k === 'post') fx.rings.push({ x: e.x, y: e.y, at: now(), col: '#9fe8ff' });
    else if (k === 'tackle') { if (e.res === 'win') fx.flash = 1; emitDbg('tackle', e) }
    else if (k === 'reject') emitDbg('reject', e);
    else if (k === 'end') { /* end 消息另行处理 */ }
  }

  /* ---------- 输入面（左浮动摇杆+右下三钮弧排，§1.5） ---------- */
  var joy = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
  var charge = { on: false, t0: 0 };
  var sprint = false, mDown = false;
  var BTNS = [
    { id: 'shot', x: 316, y: 596, r: 32, label: '射门' },
    { id: 'pass', x: 262, y: 626, r: 28, label: '传球' },
    { id: 'sprint', x: 228, y: 578, r: 22, label: '冲刺' },
  ];
  function joyVec() {
    var dx = joy.dx, dy = joy.dy, len = Math.hypot(dx, dy);
    if (len < 8) return { mx: 0, my: 0, ax: 0, ay: -1 }; // 死区 8px（§3.1）
    var m = Math.min(1, (len - 8) / 46);
    return { mx: Math.round(dx / len * 100 * m), my: Math.round(dy / len * 100 * m), ax: dx / len, ay: dy / len };
  }
  function powAt(ms) { // 两段蓄力曲线（§3.2 整数表）
    var t = Math.floor(ms / 50);
    var pow = t <= 6 ? t * 100 : Math.min(1000, 600 + (t - 6) * 20);
    return Math.max(0, pow);
  }
  function fireShot(vec) {
    var me = players[mySeat]; if (!me) return;
    var G = mySeat % 2 === 0 ? { x: 175 * K, y: 0 } : { x: 175 * K, y: 500 * K };
    var ax = vec.mx || vec.ax, ay = vec.my || vec.ay;
    if (!vec.mx && !vec.my) { ax = G.x - ball.x; ay = G.y - ball.y } // 无摇杆=朝门（§1.5）
    var ang = Math.round(Math.atan2(ay, ax) / (Math.PI * 2) * 65536) & 0xFFFF;
    pendingCmd = { k: 'shot', ang: ang, pow: powAt(charge.on ? now() - charge.t0 : 0) };
    emitDbg('cmd-shot', { ang: ang, pow: powAt(now() - charge.t0) });
  }
  var pendingCmd = null;
  function onBtn(id, vec) {
    if (id === 'shot') { /* 蓄力在 down 起、up 结（见 press 语义） */ }
    else if (id === 'pass') {
      if (ball.owner === mySeat) pendingCmd = { k: 'pass' };
      else pendingCmd = { k: 'tackle' }; // 无球语境切换（§1.5）
    }
  }
  function pos(t) { var r = cv.getBoundingClientRect(); return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) } }
  function hitBtn(p) { for (var i = 0; i < BTNS.length; i++) { var b = BTNS[i]; if (Math.hypot(p.x - b.x, p.y - b.y) < b.r + 8) return b } return null }
  function press(p) {
    if (mySeat < 0) return;
    var b = hitBtn(p);
    if (b) {
      if (b.id === 'shot') { charge.on = true; charge.t0 = now() }
      else if (b.id === 'sprint') sprint = true;
      else onBtn('pass', joyVec());
      return;
    }
    if (p.x < W / 2) { joy.active = true; joy.ox = p.x; joy.oy = p.y; joy.dx = 0; joy.dy = 0; joy.id = 't' }
  }
  function move(p) {
    if (joy.active) { joy.dx = p.x - joy.ox; joy.dy = p.y - joy.oy }
  }
  function release(p) {
    var b = p && hitBtn(p);
    if (charge.on && (!b || b.id !== 'shot')) { charge.on = false }
    if (b && b.id === 'shot' && charge.on) { charge.on = false; fireShot(joyVec()) }
    if (b && b.id === 'sprint') sprint = false;
    if (!b) { joy.active = false; joy.dx = 0; joy.dy = 0 }
  }
  cv.addEventListener('touchstart', function (e) { e.preventDefault(); for (var i = 0; i < e.changedTouches.length; i++) press(pos(e.changedTouches[i])) }, { passive: false });
  cv.addEventListener('touchmove', function (e) { e.preventDefault(); for (var i = 0; i < e.changedTouches.length; i++) move(pos(e.changedTouches[i])) }, { passive: false });
  cv.addEventListener('touchend', function (e) { e.preventDefault(); for (var i = 0; i < e.changedTouches.length; i++) release(pos(e.changedTouches[i])) }, { passive: false });
  cv.addEventListener('mousedown', function (e) { mDown = true; press(pos(e)) });
  cv.addEventListener('mousemove', function (e) { if (mDown) move(pos(e)) });
  window.addEventListener('mouseup', function (e) { mDown = false; release(pos(e)) });

  /* 20Hz 输入环（静止保活） */
  setInterval(function () {
    if (!ws || ws.readyState !== 1 || mySeat < 0 || ended) return;
    var v = joyVec();
    var keys = { mx: v.mx, my: v.my, sp: sprint ? 1 : 0 };
    if (pendingCmd) { keys.cmd = pendingCmd; pendingCmd = null }
    inRing.push({ q: seq, mx: keys.mx, my: keys.my, sp: keys.sp });
    if (inRing.length > 64) inRing.shift();
    send({ t: 'input', frame: seq, keys: keys });
    seq++;
  }, 50);
  /* 本地预测：两帧间步进自身（§5.4 自身 0ms 红线） */
  function predictSelf(dtMs) {
    if (mySeat < 0 || !players[mySeat] || ended) return;
    var me = players[mySeat];
    var v = joyVec();
    var steps = Math.min(3, Math.round(dtMs / 50));
    for (var i = 0; i < steps; i++) {
      var spd = (C.CLS[me.cls] || C.CLS.all).spd;
      if (charge.on) spd = spd * 179 >> 8; // 蓄力期 ×0.7（§3.2）
      if (sprint) spd = (C.CLS[me.cls] || C.CLS.all).sprint;
      if (ball.owner === mySeat) spd = spd * 241 >> 8;
      me.x += spd * v.mx / 100; me.y += spd * v.my / 100;
      me.x = Math.max(11 * K, Math.min(339 * K, me.x)); me.y = Math.max(11 * K, Math.min(489 * K, me.y));
      if (v.mx || v.my) me.dir = Math.round(Math.atan2(v.my, v.mx) / (Math.PI * 2) * 8192) & 8191;
    }
  }

  /* ---------- 球渲染态：速度外推+围板反射预演（静态墙表本地可算，§5.2） ---------- */
  var ballR = { x: 175 * K, y: 250 * K, rot: 0 };
  function ballStep(dtMs) {
    var sub = dtMs / 10; // 子步 10ms
    if (ball.owner >= 0 && players[ball.owner]) { // 持球态：软栓跟随（渲染近似）
      var p = players[ball.owner];
      var c = Math.cos(p.dir / 8192 * Math.PI * 2), s = Math.sin(p.dir / 8192 * Math.PI * 2);
      var tx = p.x + c * 14000, ty = p.y + s * 14000;
      ballR.x += (tx - ballR.x) * 0.3; ballR.y += (ty - ballR.y) * 0.3;
      ballR.rot += (p.vx || 0) * dtMs / 50000;
      return;
    }
    for (var i = 0; i < sub; i++) {
      ballR.x += ball.vx / 5; ballR.y += ball.vy / 5;
      var mx0 = ball.x > 130 * K - 6 * K && ball.x < 220 * K + 6 * K;
      if (ballR.x < 6 * K) { ballR.x = 6 * K; ball.vx = -ball.vx * 0.72; ball.vy = ball.vy * 0.92 }
      else if (ballR.x > 344 * K) { ballR.x = 344 * K; ball.vx = -ball.vx * 0.72; ball.vy = ball.vy * 0.92 }
      if (ballR.y < (mx0 ? -8 * K : 6 * K) && ball.vy < 0) { if (!mx0) { ballR.y = 6 * K; ball.vy = -ball.vy * 0.72; ball.vx = ball.vx * 0.92 } }
      else if (ballR.y > (mx0 ? 508 * K : 494 * K) && ball.vy > 0) { if (!mx0) { ballR.y = 494 * K; ball.vy = -ball.vy * 0.72; ball.vx = ball.vx * 0.92 } }
      ball.vx *= 0.994; ball.vy *= 0.994;
    }
    ballR.rot += ball.vx * dtMs / 50000;
    /* 权威锚渐进收敛（快照 10Hz 校正外推漂移） */
    ballR.x += (ball.rx - ballR.x) * 0.12; ballR.y += (ball.ry - ballR.y) * 0.12;
  }

  /* ---------- 绘制 ---------- */
  var TEAM_COL = { 0: '#E8A33D', 1: '#3DC8E8' };
  var sx = function (mx) { return CX0 + mx / K };
  var sy = function (my) { return CY0 + my / K };
  function drawCourt() {
    ctx.fillStyle = '#20242B'; ctx.fillRect(CX0, CY0, CW, CH);
    // 涂鸦点缀（低饱和喷绘斑）
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#c26aa8'; ctx.beginPath(); ctx.ellipse(sx(70 * K), sy(90 * K), 30, 16, 0.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#d9a441'; ctx.beginPath(); ctx.ellipse(sx(290 * K), sy(400 * K), 26, 14, -0.4, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    // 粉笔白线
    ctx.strokeStyle = '#E8E4D8'; ctx.lineWidth = 2;
    ctx.strokeRect(CX0 + 1, CY0 + 1, CW - 2, CH - 2);
    ctx.beginPath(); ctx.moveTo(CX0 + 1, CY0 + CH / 2); ctx.lineTo(CX0 + CW - 1, CY0 + CH / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(CX0 + CW / 2, CY0 + CH / 2, 45, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(CX0 + CW / 2, CY0 + CH / 2, 3, 0, 7); ctx.fillStyle = '#E8E4D8'; ctx.fill();
    // 围板警示斜纹（上下边外沿）
    ctx.save(); ctx.strokeStyle = '#3A414D'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(CX0, CY0 - 2); ctx.lineTo(CX0 + CW, CY0 - 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CX0, CY0 + CH + 2); ctx.lineTo(CX0 + CW, CY0 + CH + 2); ctx.stroke();
    ctx.restore();
    // 霓虹双门（队伍色描边：上=B 防守门/A 进攻门——按 kickTeam 无关恒上门蓝下门琥珀的阵营归属渲染）
    neonGoal(130, 220, 6, '#3DC8E8', true);
    neonGoal(130, 220, 494, '#E8A33D', false);
  }
  function neonGoal(x0px, x1px, ypx, col, top) {
    var y = CY0 + ypx;
    ctx.save();
    ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = fx.flash > 0 ? 14 : 6; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(CX0 + x0px, y); ctx.lineTo(CX0 + x0px, top ? y - 14 : y + 14); ctx.lineTo(CX0 + x1px, top ? y - 14 : y + 14); ctx.lineTo(CX0 + x1px, y);
    ctx.stroke();
    ctx.restore();
  }
  function drawPlayer(p, isMe) {
    var x = sx(p.x), y = sy(p.y);
    var col = TEAM_COL[p.team];
    // 阵营形状底盘（色盲双编码 §7：A 椭圆/B 方形）
    ctx.fillStyle = col;
    if (p.team === 0) { ctx.beginPath(); ctx.ellipse(x, y + 6, 14, 9, 0, 0, 7); ctx.fill() }
    else { ctx.fillRect(x - 12, y - 3, 24, 9) }
    if (isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, y + 6, 16, 11, 0, 0, 7); ctx.stroke() }
    // 身体（朝向三角）
    var a = (p.dir || 0) / 8192 * Math.PI * 2;
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
    // 类徽记（P2 形状键：快马双箭羽/均衡圆环/炮手准星/坦克盾）
    ctx.strokeStyle = '#E8E4D8'; ctx.lineWidth = 1.4;
    var cls = p.cls || 'all';
    if (cls === 'fast') { ctx.beginPath(); ctx.moveTo(x - 3, y - 12); ctx.lineTo(x, y - 16); ctx.lineTo(x + 3, y - 12); ctx.moveTo(x - 3, y - 8); ctx.lineTo(x, y - 12); ctx.lineTo(x + 3, y - 8); ctx.stroke() }
    else if (cls === 'striker') { ctx.beginPath(); ctx.arc(x, y - 12, 4, 0, 7); ctx.moveTo(x, y - 18); ctx.lineTo(x, y - 6); ctx.moveTo(x - 6, y - 12); ctx.lineTo(x + 6, y - 12); ctx.stroke() }
    else if (cls === 'tank') { ctx.beginPath(); ctx.moveTo(x - 4, y - 16); ctx.lineTo(x + 4, y - 16); ctx.lineTo(x + 4, y - 11); ctx.lineTo(x, y - 7); ctx.lineTo(x - 4, y - 11); ctx.closePath(); ctx.stroke() }
    else { ctx.beginPath(); ctx.arc(x, y - 12, 4, 0, 7); ctx.stroke() }
    // 持球权可视锚：脚下加亮环
    if (ball.owner === p.seat) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(x, y + 6, 18, 12, 0, 0, 7); ctx.stroke() }
    // 扑抢残影/自绊
    if (p.lunge) { ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.stroke(); ctx.globalAlpha = 1 }
    if (p.stum) { ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = HF('p2', 9, 5, 'P2'); ctx.fillText('!', x - 2, y - 18) }
  }
  function drawBall() {
    var x = sx(ballR.x), y = sy(ballR.y);
    // 轨迹双编码（末触者队伍色：A 圆点链/B 短横杠链，§7）
    var tc = ball.lastT >= 0 ? TEAM_COL[ball.lastT % 2] : '#8a93a6';
    for (var i = 0; i < fx.trail.length; i++) {
      var t = fx.trail[i], a = i / fx.trail.length * 0.5;
      ctx.globalAlpha = a; ctx.fillStyle = tc;
      if (ball.lastT % 2 === 0) { ctx.beginPath(); ctx.arc(sx(t.x), sy(t.y), 2, 0, 7); ctx.fill() }
      else ctx.fillRect(sx(t.x) - 3, sy(t.y) - 1, 6, 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#f4f4f0'; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill();
    ctx.strokeStyle = '#b9beca'; ctx.lineWidth = 1; ctx.stroke();
    // 黑色五边形滚动纹理（旋转可视化）
    ctx.save(); ctx.translate(x, y); ctx.rotate(ballR.rot);
    ctx.fillStyle = '#20242B';
    for (var k = 0; k < 3; k++) {
      var a2 = k / 3 * Math.PI * 2;
      ctx.beginPath(); ctx.arc(Math.cos(a2) * 3.2, Math.sin(a2) * 3.2, 1.6, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
  function drawTopbar() {
    ctx.fillStyle = '#171a20'; ctx.fillRect(0, 0, W, 52);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#E8A33D'; ctx.font = HF('p0', 15, 7, 'P0'); ctx.fillText(String(snapState.score.A), 74, 33);
    ctx.fillStyle = '#E8E4D8'; ctx.font = HF('p0n', 13, 6, 'P0'); ctx.fillText(':', 104, 32);
    ctx.fillStyle = '#3DC8E8'; ctx.font = HF('p0', 15, 7, 'P0'); ctx.fillText(String(snapState.score.B), 134, 33);
    ctx.fillStyle = '#E8E4D8'; ctx.font = HF('p0n', 13, 6, 'P0'); ctx.fillText(fmtTime(snapState.clock), W / 2 + 8, 33);
    ctx.fillStyle = '#7b8698'; ctx.font = HF('p2', 9, 5, 'P2'); ctx.fillText('街头足球 · 围笼 2v2', W - 62, 32);
    // 相位横幅位
    ctx.textAlign = 'center';
    if (snapState.phase === 'kick') {
      ctx.fillStyle = '#FFD86B'; ctx.font = HF('p0', 13, 7, 'P0');
      ctx.fillText('开球 ' + Math.ceil((30 - phaseT()) / 20 * 10) / 10 + 's', W / 2, 50);
    } else if (snapState.phase === 'goal') {
      ctx.fillStyle = '#ffffff'; ctx.font = HF('p0', 13, 7, 'P0'); ctx.fillText('进球！', W / 2, 50);
    } else if (snapState.ot) {
      ctx.fillStyle = '#FFD86B'; ctx.font = HF('p0', 13, 7, 'P0'); ctx.fillText('金球加时', W / 2, 50);
    }
    ctx.textAlign = 'left';
  }
  var phaseT0 = 0;
  function phaseT() { return Math.min(30, Math.floor((now() - phaseT0) / 50)) }
  function drawControls() {
    // 左浮动摇杆
    if (joy.active) {
      ctx.strokeStyle = 'rgba(232,228,216,.4)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(joy.ox, joy.oy, 44, 0, 7); ctx.stroke();
      var len = Math.min(40, Math.hypot(joy.dx, joy.dy));
      var nl = Math.hypot(joy.dx, joy.dy) || 1;
      ctx.fillStyle = 'rgba(232,228,216,.65)';
      ctx.beginPath(); ctx.arc(joy.ox + joy.dx / nl * len, joy.oy + joy.dy / nl * len, 18, 0, 7); ctx.fill();
    }
    var me = players[mySeat];
    for (var i = 0; i < BTNS.length; i++) {
      var b = BTNS[i];
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7);
      ctx.fillStyle = b.id === 'shot' ? 'rgba(232,163,61,.28)' : b.id === 'pass' ? 'rgba(61,200,232,.22)' : 'rgba(232,228,216,.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(232,228,216,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#E8E4D8'; ctx.textAlign = 'center';
      ctx.font = HF(b.id === 'sprint' ? 'p2' : 'p1', b.id === 'sprint' ? 9 : 11, 6, b.id === 'sprint' ? 'P2' : 'P1');
      ctx.fillText(b.label, b.x, b.y + 4);
      if (b.id === 'shot' && charge.on) { // 蓄力环
        var pow = powAt(now() - charge.t0);
        ctx.strokeStyle = '#FFD86B'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 3, -Math.PI / 2, -Math.PI / 2 + pow / 1000 * Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#FFD86B'; ctx.font = HF('p1b', 11, 7, 'P1'); ctx.fillText(String(Math.round(pow / 10)) + '%', b.x, b.y + b.r + 14);
      }
      if (b.id === 'sprint' && me) { // 体力弧（P1）
        var st = (me.stam != null ? me.stam : 100000) / 100000;
        ctx.strokeStyle = st < 0.2 ? '#e06c5a' : '#7ed08a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 2, -Math.PI / 2, -Math.PI / 2 + st * Math.PI * 2); ctx.stroke();
        if (st < 0.4) { ctx.fillStyle = '#E8E4D8'; ctx.font = HF('p1', 11, 6, 'P1'); ctx.fillText(String(Math.round(st * 100)), b.x, b.y + b.r + 12) }
      }
    }
    ctx.textAlign = 'left';
  }
  function drawFx(t) {
    fx.parts = fx.parts.filter(function (p) { return t - p.at < 380 });
    for (var i = 0; i < fx.parts.length; i++) {
      var p = fx.parts[i], a = 1 - (t - p.at) / 380;
      ctx.globalAlpha = a; ctx.fillStyle = p.col;
      ctx.fillRect(sx(p.x) + p.vx * (t - p.at) / 60, sy(p.y) + p.vy * (t - p.at) / 60, 2.5, 2.5);
    }
    ctx.globalAlpha = 1;
    fx.rings = fx.rings.filter(function (r) { return t - r.at < 340 });
    for (var j = 0; j < fx.rings.length; j++) {
      var r = fx.rings[j], a2 = 1 - (t - r.at) / 340;
      ctx.globalAlpha = a2 * 0.7; ctx.strokeStyle = r.col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(r.x), sy(r.y), 4 + (t - r.at) / 24, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    fx.floats = fx.floats.filter(function (f) { return t - f.at < 2400 });
    for (var k = 0; k < fx.floats.length; k++) {
      var f = fx.floats[k], a3 = 1 - (t - f.at) / 2400;
      ctx.globalAlpha = Math.min(1, a3 * 2); ctx.fillStyle = f.col; ctx.textAlign = 'center';
      ctx.font = HF('p0', 16, 7, 'P0');
      ctx.fillText(f.txt, W / 2, 180 - (t - f.at) / 40);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
    if (fx.shake > 0) fx.shake = Math.max(0, fx.shake - 0.04);
    if (fx.flash > 0) fx.flash = Math.max(0, fx.flash - 0.05);
  }
  function drawEnd() {
    ctx.fillStyle = 'rgba(13,16,22,.9)'; ctx.fillRect(0, 0, W, H);
    var win = endResult && (mySeat % 2 === 0 ? endResult.winner === 'A' : endResult.winner === 'B');
    ctx.textAlign = 'center';
    ctx.fillStyle = mySeat < 0 ? '#E8E4D8' : win ? '#7ed08a' : '#e06c5a';
    ctx.font = HF('p0', 26, 7, 'P0');
    ctx.fillText(mySeat < 0 ? '比赛结束' : win ? '胜利' : '失败', W / 2, 170);
    if (endResult) {
      ctx.fillStyle = '#E8A33D'; ctx.font = HF('p0', 20, 7, 'P0'); ctx.fillText(String(snapState.score.A), W / 2 - 30, 220);
      ctx.fillStyle = '#E8E4D8'; ctx.font = HF('p0n', 16, 6, 'P0'); ctx.fillText(':', W / 2, 218);
      ctx.fillStyle = '#3DC8E8'; ctx.font = HF('p0', 20, 7, 'P0'); ctx.fillText(String(snapState.score.B), W / 2 + 30, 220);
      ctx.fillStyle = '#9aa5b5'; ctx.font = HF('p1', 11, 6, 'P1');
      ctx.fillText('终局：' + (endResult.reason || ''), W / 2, 250);
      var sc = endResult.scores || {};
      ctx.fillText('进球账 席0 ' + (sc[0] || 0) + ' · 席1 ' + (sc[1] || 0) + ' · 席2 ' + (sc[2] || 0) + ' · 席3 ' + (sc[3] || 0), W / 2, 274);
    }
    ctx.fillStyle = '#2E6E8C'; ctx.font = HF('p1b', 12, 7, 'P1');
    ctx.fillText('点击 再来一局', W / 2, 330);
    ctx.textAlign = 'left';
  }
  cv.addEventListener('mousedown', function () { if (ended) location.href = location.pathname + '?quick=1' + (location.search.includes('gw=') ? '&' + location.search.split('gw=')[1].split('&')[0].replace(/^/, 'gw=') : '') });
  cv.addEventListener('touchstart', function () { if (ended) location.href = location.pathname + '?quick=1' + (location.search.includes('gw=') ? '&' + location.search.split('gw=')[1].split('&')[0].replace(/^/, 'gw=') : '') }, { passive: true });

  /* ---------- 主循环 ---------- */
  var lastT = now();
  var perfLog = { costs: [], gaps: [] };
  function frame(t) {
    var t0 = now();
    var dt = Math.min(100, t - lastT); lastT = t;
    if (perfLog.gaps.length) perfLog.gaps.push(t0 - perfLog.lastAt);
    perfLog.lastAt = t0;
    if (perfLog.gaps.length > 240) perfLog.gaps.shift();
    if (snapState.phase === 'kick' && (snapState.phase !== frame._p || 0)) phaseT0 = t;
    frame._p = snapState.phase;
    predictSelf(dt);
    ballStep(dt);
    fx.trail.push({ x: ballR.x, y: ballR.y });
    if (fx.trail.length > 14) fx.trail.shift();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (fx.shake > 0) ctx.translate((Math.random() - 0.5) * 8 * fx.shake, (Math.random() - 0.5) * 8 * fx.shake);
    ctx.fillStyle = '#14171D'; ctx.fillRect(-10, -10, W + 20, H + 20);
    drawCourt();
    // 他人插值（100ms 渲染延迟）
    var list = [];
    for (var i = 0; i < 4; i++) {
      var p = players[i];
      if (!p) continue;
      if (i === mySeat) { list.push({ p: p, y: p.y }) ; continue }
      if (p.lpos && p.lpos.length >= 2) {
        var t1 = t - 100, a = p.lpos[p.lpos.length - 2], b = p.lpos[p.lpos.length - 1];
        var f = Math.max(0, Math.min(1, (t1 - a.at) / Math.max(1, b.at - a.at)));
        p.ix = a.x + (b.x - a.x) * f; p.iy = a.y + (b.y - a.y) * f;
      } else { p.ix = p.rx; p.iy = p.ry }
      list.push({ p: p, y: p.iy });
    }
    list.sort(function (u, v) { return u.y - v.y });
    for (var j = 0; j < list.length; j++) {
      var q = list[j].p;
      var keep = q.x, keepY = q.y;
      if (q.seat !== mySeat && q.ix !== undefined) { q.x = q.ix; q.y = q.iy }
      drawPlayer(q, q.seat === mySeat);
      q.x = keep; q.y = keepY;
    }
    drawBall();
    drawFx(t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawTopbar();
    if (mySeat >= 0 && !ended) drawControls();
    if (ended && endResult) drawEnd();
    var cost = now() - t0;
    perfLog.costs.push(cost);
    if (perfLog.costs.length > 240) perfLog.costs.shift();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  connect();

  /* ---------- 调试面（识图/QA 钩子） ---------- */
  window.__GAMES_DEBUG__ = {
    hudFonts: function () { return JSON.parse(JSON.stringify(HF_REG)) },
    events: function () { return dbgEvents.slice(-30) },
    state: function () { return { seat: mySeat, phase: snapState.phase, clock: snapState.clock, score: snapState.score, poss: ball.owner, ball: { x: Math.round(ballR.x), y: Math.round(ballR.y) }, players: Object.keys(players).length } },
    perf: function () {
      var cs = perfLog.costs.slice(-180), gs = perfLog.gaps.slice(-180);
      var avg = cs.length ? cs.reduce(function (a, b) { return a + b }, 0) / cs.length : 0;
      var sorted = cs.slice().sort(function (a, b) { return a - b });
      var gAvg = gs.length ? gs.reduce(function (a, b) { return a + b }, 0) / gs.length : 0;
      return { n: cs.length, costAvgMs: +avg.toFixed(2), costP95Ms: +(sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2), costJankPct: +(cs.filter(function (c) { return c > 25 }).length / Math.max(1, cs.length) * 100).toFixed(2), rafGapMs: +gAvg.toFixed(1) };
    },
  };
})();
