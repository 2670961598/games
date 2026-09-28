/* =====================================================================
 * 八球台球 pool-physics 客户端逻辑（GAMES-78）——构建期内联进 index.html。
 * 依赖前置内联：trig16.cjs（window.PoolTrig）+ sim.cjs（window.PoolSim）+ _shared/net.js（window.GNet）。
 * 模式：
 *   online —— ?room=<id> 或快速匹配；S4 通道（设计 §5）：
 *     op 上行（shot/place/concede）一次性 commit；ruling/snapshot 下行；
 *     球动期本地确定性重演（同一份 PoolSim 60fps 重跑，快照=逐字节校验锚，§5.4），
 *     hash 不符回退插值模式（版本护栏）。
 *   offline —— 网关不可达/?debug=1 离线练习（本地 sim + balanced Bot 对打）。
 * 单拇指三段操作（设计 §1.4）：①桌面 drag 瞄准 ②右缘竖槽 drag 力度 ③旋转盘 tap。
 * 辅助分档（§3.1，tier 正交）：relaxed/simple 全辅助 / normal 长线 / hard/master 裸打。
 * ===================================================================== */
(function () {
  'use strict';

  var S = window.PoolSim, G = window.GNet;
  var W = 375, H = 667;
  var TABLE_W = 340, TABLE_H = 170;                 // 桌面 340×170（逻辑 px），milli×0.001
  var TX = (W - TABLE_W) / 2, TY = 250;             // 桌面绘制原点（§7 布局：y≈250-420）
  var TOP_H = 90, BOT_Y = 545;
  var M2P = 0.001;                                   // milli → px
  var TEAM_COLOR = { A: '#E8A33D', B: '#3DC8E8' };
  var GREEN = '#1F7A4D', WOOD = '#6B4A2B', POCKET = '#101010';
  var FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif";
  var FOUL_CN = { F1: '白球落袋（洗袋）', F2: '空杆未触球', F3: '首触错组', F4: '无库边无进球' };
  var POWER_X = 346, POWER_W = 12, POWER_Y = 300, POWER_H = 220;  // 右缘力度槽（§3.3）
  var SPIN_X = 14, SPIN_Y = H - 96, SPIN_S = 44;                   // 旋转盘（§1.4③）
  var SHOOT_R = 32, SHOOT_CX = W - 60, SHOOT_CY = H - 64;          // 出杆大钮

  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var mode = 'offline', session = null, mySeat = 0;
  var st = null;                    // 规则态视图（welcome/ruling/snapshot 合并；offline=本地 sim 全态）
  var replay = null;                // 球动期本地确定性重演 {st, verify, snapSeen}
  var started = false, matchOver = false, physicsHashOk = true;
  var rosterMap = {};
  var aimAng = 8192 << 3, pow = 500, spinV = 0, spinS = 0;          // 三段本地参数（零上行，§1.2）
  var banner = { txt: '', ttl: 0 };
  var fx = [];                      // 落袋缩入/库边微粒 juice（§3.3）
  var lastAimSeat = -1, replayPrev = null, replayT = 0;
  var dbgEvents = [];               // QA 证据：__GAMES_DEBUG__.events（GAMES-80 F3，对齐 slg/mmo/emp 泳道契约）
  function logEv(name, payload) { dbgEvents.push({ event: name, payload: payload, at: Date.now() }); }
  var HUDF = {};                    // HF 字号登记表（识图复检断言源，GAMES-75 范式）
  function HF(grp, key, px, w) {
    ctx.font = (w || 400) + ' ' + px + 'px ' + FONT;
    (HUDF[grp] || (HUDF[grp] = {}))[key] = px;
    return ctx.font;
  }
  var tier = (function () { try { return new URLSearchParams(location.search).get('tier') || 'normal'; } catch (e) { return 'normal'; } })();
  var assist = tier === 'relaxed' || tier === 'simple' ? 2 : tier === 'normal' ? 1 : 0;  // §3.1 分档

  /* ================= 视图合并（ruling.state / snapshot / started） ================= */
  function syncState(s) {
    if (!s) return;
    if (!st) st = { balls: [] };
    st.phase = s.phase; st.turn = s.turn; st.openTable = s.openTable;
    st.groups = s.groups || [-1, -1]; st.ballInHand = !!s.ballInHand;
    st.shotN = s.shotN; st.potOrder = s.potOrder || []; st.pottedBy = s.pottedBy || [0, 0];
    if (s.balls) for (var i = 0; i < 16 && i < s.balls.length; i++) {
      var q = s.balls[i];
      st.balls[i] = st.balls[i] || { x: 0, y: 0, vx: 0, vy: 0, pot: 0 };
      if (Array.isArray(q)) {
        if (q.length >= 4) { st.balls[i].x = q[1]; st.balls[i].y = q[2]; st.balls[i].pot = q[3]; }
        else { st.balls[i].x = q[1]; st.balls[i].y = q[2]; }
      } else if (q && typeof q === 'object') { st.balls[i].x = q.x; st.balls[i].y = q.y; st.balls[i].pot = q.pot; }
    }
    if (Number.isInteger(s.timerMs)) st.aimTicks = s.timerMs / 10;
    announce(s);
  }
  function announce(s) {
    if (!s.events) return;
    for (var i = 0; i < s.events.length; i++) {
      var e = s.events[i];
      if (e.k === 'foul') flash(FOUL_CN[e.why] || '犯规', e.seat);
      else if (e.k === 'assign') flash((e.seat === mySeat ? '你执' : '对方执') + (e.group === 1 ? '全色' : '花色'), e.seat);
      else if (e.k === 'ballinhand') flash(e.seat === mySeat ? '自由球：点桌面放白球' : '对方获自由球', e.seat);
      else if (e.k === 'turn') flash(e.seat === mySeat ? '轮到你' : '对方出杆', e.seat);
      else if (e.k === 'pot') fx.push({ k: 'pot', x: 0, y: 0, id: e.id, t: 150, pocket: e.pocket });
    }
  }
  function flash(txt, seat) { banner = { txt: txt, ttl: 1600, seat: seat }; }

  /* ================= 球动期本地确定性重演（§5.4：同 sim 60fps 重跑） ================= */
  function beginReplay(shot) {
    var local = S.create(1);
    local.balls = st.balls.map(function (b) { return { x: b.x, y: b.y, vx: 0, vy: 0, pot: b.pot }; });
    local.openTable = st.openTable; local.groups = st.groups.slice();
    local.turn = shot.seat; local.phase = 'aim';
    local.facts = { firstHit: -1, anyCushionAfter: false, potted: [], cuePotted: false, ownBefore: 0 };
    local.balls[0].x = shot.cue.x; local.balls[0].y = shot.cue.y; local.balls[0].pot = 0;
    S.strike(local, shot.seat, shot);
    replay = { st: local, verify: 0, mismatches: 0 };
    replayPrev = st.balls.map(function (b) { return b; });
  }
  function stepReplay() {
    if (!replay) return;
    var r = S.step(replay.st, null);
    for (var i = 0; i < (r.events || []).length; i++) {
      var e = r.events[i];
      if (e.k === 'pot') fx.push({ k: 'pot', x: 0, y: 0, id: e.id, t: 150, pocket: e.pocket });
    }
    if (replay.st.phase !== 'motion') {   // 本地重演先到全停：同步回视图，等服务端 ruling 终判
      st.balls = replay.st.balls;
      st.potOrder = replay.st.potOrder.slice();
      replay = null;
    }
  }
  function verifySnapshot(msg) {
    if (!replay) return;
    for (var i = 0; i < msg.balls.length; i++) {
      var q = msg.balls[i], b = replay.st.balls[q[0]];
      if (Math.abs(b.x - q[1]) > 2 || Math.abs(b.y - q[2]) > 2) replay.mismatches++;
    }
    replay.verify++;
  }

  /* ================= 绘制 ================= */
  function ballColor(id) {
    if (id === 0) return '#F4F0E6';
    var c = ['#000', '#F2C31D', '#2D5FA8', '#D0342C', '#7B3FA0', '#E8862D', '#1E7A3C', '#8B2942', '#101010',
      '#F2C31D', '#2D5FA8', '#D0342C', '#7B3FA0', '#E8862D', '#1E7A3C', '#8B2942'];
    return c[id];
  }
  function drawTable() {
    ctx.fillStyle = WOOD; ctx.fillRect(TX - 14, TY - 14, TABLE_W + 28, TABLE_H + 28);
    ctx.fillStyle = GREEN; ctx.fillRect(TX, TY, TABLE_W, TABLE_H);
    var pockets = S.consts.POCKETS;
    for (var p = 0; p < 6; p++) {
      var px = TX + pockets[p][0] * M2P, py = TY + pockets[p][1] * M2P;
      ctx.fillStyle = POCKET;
      ctx.beginPath(); ctx.arc(TX + Math.max(8, Math.min(TABLE_W - 8, px)), TY + Math.max(8, Math.min(TABLE_H - 8, py)), 10, 0, 7); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
    ctx.strokeRect(TX + 85, TY + 4, 1, TABLE_H - 8);   // 开球线（x=85000）
  }
  function ballPx(id, b) { return [TX + b.x * M2P, TY + b.y * M2P]; }
  function drawBalls() {
    var balls = (replay ? replay.st.balls : st.balls) || [];
    for (var i = 0; i < 16; i++) {
      var b = balls[i]; if (!b || b.pot) continue;
      var xy = ballPx(i, b), x = xy[0], y = xy[1];
      ctx.fillStyle = ballColor(i);
      ctx.beginPath(); ctx.arc(x, y, 7.5, 0, 7); ctx.fill();
      if (i === 0) { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.beginPath(); ctx.arc(x - 2, y - 2, 1.5, 0, 7); ctx.fill(); continue; }
      if (i > 8) {   // 花色白环带（形状第二通道，§7）
        ctx.strokeStyle = '#F4F0E6'; ctx.lineWidth = 3.2;
        ctx.beginPath(); ctx.arc(x, y, 5.2, 0, 7); ctx.stroke();
      }
      ctx.fillStyle = '#F4F0E6'; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, 7); ctx.fill();
      ctx.fillStyle = '#222'; HF('ball', 'no', 9, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i), x, y + 0.5);
    }
  }
  /* 瞄准辅助（§3.1 分档：全辅助=瞄准线+Ghost+分离线；normal=长线；裸打=40px 短杆） */
  function drawAim() {
    if (!st || matchOver || st.phase !== 'aim' || st.turn !== mySeat || st.ballInHand) return drawPlaceHint();
    var balls = st.balls;
    var q = (aimAng >> 3) & 8191;
    var dx = Math.cos(q / 8192 * Math.PI * 2), dy = Math.sin(q / 8192 * Math.PI * 2);
    var cue = balls[0], cx = TX + cue.x * M2P, cy = TY + cue.y * M2P;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 5]);
    var hit = rayBall(cue, dx, dy, balls);
    if (assist === 0) {
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * 40, cy + dy * 40); ctx.stroke();
    } else if (hit) {
      var hx = cx + dx * hit.d * M2P, hy = cy + dy * hit.d * M2P;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
      if (assist === 2) {
        var nb = balls[hit.id];
        var nx = (nb.x - (cue.x + dx * hit.d)) / 15000, ny = (nb.y - (cue.y + dy * hit.d)) / 15000;
        var nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        ctx.strokeStyle = 'rgba(232,163,61,.8)';
        ctx.beginPath(); ctx.arc(hx, hy, 7.5, 0, 7); ctx.stroke();          // Ghost 球
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + nx * 46, hy + ny * 46); ctx.stroke();  // 目标球分离线
        ctx.strokeStyle = 'rgba(61,200,232,.7)';
        var ox = dx - nx * (dx * nx + dy * ny), oy = dy - ny * (dx * nx + dy * ny);
        var ol = Math.hypot(ox, oy) || 1;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + ox / ol * 30, hy + oy / ol * 30); ctx.stroke(); // 白球分离线
      }
    } else {
      var far = rayCushion(cue, dx, dy);
      if (assist === 2) {   // 库边一次反射线
        var ex = TX + far.x * M2P, ey = TY + far.y * M2P;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.3)';
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + far.rx * 60, ey + far.ry * 60); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(TX + far.x * M2P, TY + far.y * M2P); ctx.stroke();
      }
    }
    ctx.restore();
    /* 杆尾拉杆镜像力度（§3.3） */
    var px = cx - dx * (14 + pow * 0.05), py = cy - dy * (14 + pow * 0.05);
    ctx.strokeStyle = '#C8A265'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx - dx * 10, cy - dy * 10); ctx.lineTo(px, py); ctx.stroke();
  }
  function drawPlaceHint() {
    if (!st || !st.ballInHand || st.turn !== mySeat) return;
    ctx.fillStyle = 'rgba(244,240,230,.9)'; HF('hint', 'bih', 11, 600); ctx.textAlign = 'center';
    ctx.fillText('点桌面任意合法位放白球', W / 2, TY - 22);
  }
  function rayBall(cue, dx, dy, balls) {
    var best = null;
    for (var i = 1; i < 16; i++) {
      var b = balls[i]; if (!b || b.pot) continue;
      var ox = b.x - cue.x, oy = b.y - cue.y;
      var t = ox * dx + oy * dy;
      if (t <= 0) continue;
      var px = cue.x + dx * t, py = cue.y + dy * t;
      var d2 = (b.x - px) * (b.x - px) + (b.y - py) * (b.y - py);
      if (d2 > 15000 * 15000) continue;
      var back = Math.sqrt(15000 * 15000 - d2);
      var dist = t - back;
      if (dist < 0) continue;
      if (!best || dist < best.d) best = { d: dist, id: i };
    }
    return best;
  }
  function rayCushion(cue, dx, dy) {
    var x = cue.x, y = cue.y, t;
    var ts = [];
    if (dx > 0) ts.push((340000 - 7500 - x) / dx); else if (dx < 0) ts.push((7500 - x) / dx);
    if (dy > 0) ts.push((170000 - 7500 - y) / dy); else if (dy < 0) ts.push((7500 - y) / dy);
    t = Math.min.apply(null, ts);
    var hx = x + dx * t, hy = y + dy * t;
    var rx = dx, ry = dy;
    if (hy <= 7500 || hy >= 162500) ry = -ry; else rx = -rx;
    return { x: hx, y: hy, rx: rx, ry: ry };
  }
  function drawHud() {
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, W, TOP_H);
    var info = st || { groups: [-1, -1], pottedBy: [0, 0] };
    for (var s = 0; s < 2; s++) {
      var team = s === 0 ? 'A' : 'B';
      var x0 = s === 0 ? 14 : W - 14;
      var mine = s === mySeat;
      ctx.textAlign = s === 0 ? 'left' : 'right';
      var nm = (rosterMap[s] && rosterMap[s].name) || (s === 0 ? '玩家A' : '玩家B');
      if (mine) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.strokeRect(s === 0 ? 8 : W - 128, 10, 120, 30); }
      ctx.fillStyle = TEAM_COLOR[team]; HF('top', 'name', 13, 600);
      ctx.fillText(nm + (info.turn === s && !matchOver ? ' ●' : ''), x0, 30);
      /* 剩球点阵（形状第二通道：A 实心圆 / B 环，§7；全色实心/花色环带双色组） */
      var g = info.groups ? info.groups[s] : -1;
      var remain = [];
      for (var i = 1; i <= 15; i++) {
        if (i === 8) continue;
        var bg = i <= 7 ? 1 : 2;
        if (g > 0 && bg !== g) continue;
        if (st && st.balls[i] && !st.balls[i].pot) remain.push(i);
      }
      var cnt = g > 0 ? remain.length : 0;
      ctx.fillStyle = '#c9d2dd'; HF('top', 'cnt', 13, 600);
      ctx.fillText((g === 1 ? '全色 ' : g === 2 ? '花色 ' : '开放 ') + (g > 0 ? cnt + ' 颗' : '—'), x0, 52);
      var bx = s === 0 ? 14 : W - 14;
      for (var k2 = 0; k2 < Math.min(remain.length, 7); k2++) {
        var idx = remain[k2];
        bx += s === 0 ? 12 : -12;
        ctx.beginPath(); ctx.arc(bx, 70, 4, 0, 7);
        ctx.fillStyle = ballColor(idx); ctx.fill();
        if (idx > 8) { ctx.strokeStyle = '#F4F0E6'; ctx.lineWidth = 1.6; ctx.stroke(); }
      }
    }
    /* 回合计时（P0）+ 杆数（P0） */
    ctx.textAlign = 'center'; ctx.fillStyle = '#e8ecf3';
    var tsec = st && st.phase === 'aim' ? Math.max(0, Math.ceil((st.aimTicks || 0) / 100)) : 0;
    HF('top', 'timer', tsec <= 5 && tsec > 0 ? 16 : 13, 600);
    ctx.fillText(matchOver ? '终局' : (st && st.phase === 'motion' ? '球动中' : tsec + 's'), W / 2, 34);
    ctx.fillStyle = '#8b93a7'; HF('top', 'shotN', 13, 400);
    ctx.fillText('第 ' + ((info.shotN || 0) + 1) + ' 杆', W / 2, 58);
    /* 观战徽标（P1） */
    if (session && session.role === 'spectator') { ctx.fillStyle = '#8b93a7'; HF('top', 'spec', 11, 600); ctx.fillText('观战 · 同帧重演', W / 2, 78); }
  }
  function drawControls() {
    ctx.fillStyle = '#10151c'; ctx.fillRect(0, BOT_Y, W, H - BOT_Y);
    /* 力度槽（右缘纵贯，§3.3；P0 % 数字） */
    ctx.fillStyle = '#1b2330'; ctx.fillRect(POWER_X - 4, POWER_Y - 6, POWER_W + 8, POWER_H + 12);
    var ph = Math.round(POWER_H * pow / 1000);
    var grd = ctx.createLinearGradient(0, POWER_Y + POWER_H - ph, 0, POWER_Y + POWER_H);
    grd.addColorStop(0, '#E8A33D'); grd.addColorStop(1, '#7a4a12');
    ctx.fillStyle = grd; ctx.fillRect(POWER_X, POWER_Y + POWER_H - ph, POWER_W, ph);
    ctx.fillStyle = '#e8ecf3'; HF('ctl', 'pow', 13, 600); ctx.textAlign = 'center';
    ctx.fillText(Math.round(pow / 10) + '%', POWER_X + 6, POWER_Y + POWER_H + 18);
    /* 旋转盘 3×3（§1.4③；当前点高亮；P1 标签） */
    var labels = ['左上塞', '高杆', '右上塞', '左塞', '中', '右塞', '左下塞', '低杆', '右下塞'];
    ctx.strokeStyle = '#2a3646'; ctx.lineWidth = 1;
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) {
      var cx = SPIN_X + c * (SPIN_S / 3), cy = SPIN_Y + r * (SPIN_S / 3);
      var sel = (1 - r - 1) === spinV * -1 && (c - 1) === spinS;
      var isSel = (1 - r) === spinV && (c - 1) === spinS;
      ctx.fillStyle = isSel ? '#E8A33D' : 'rgba(255,255,255,.06)';
      ctx.fillRect(SPIN_X + c * SPIN_S / 3 + 1, SPIN_Y + r * SPIN_S / 3 + 1, SPIN_S / 3 - 2, SPIN_S / 3 - 2);
    }
    ctx.strokeRect(SPIN_X, SPIN_Y, SPIN_S, SPIN_S);
    ctx.fillStyle = '#8b93a7'; HF('ctl', 'spin', 11, 600); ctx.textAlign = 'left';
    ctx.fillText('旋转', SPIN_X, SPIN_Y - 6);
    ctx.fillStyle = '#c9d2dd'; HF('ctl', 'spinv', 11, 600);
    ctx.fillText((spinV > 0 ? '高杆' : spinV < 0 ? '低杆' : '中') + (spinS > 0 ? '·右塞' : spinS < 0 ? '·左塞' : ''), SPIN_X + SPIN_S + 10, SPIN_Y + SPIN_S / 2);
    /* 出杆钮（P1） */
    var my = st && st.phase === 'aim' && st.turn === mySeat && !st.ballInHand && !matchOver;
    ctx.beginPath(); ctx.arc(SHOOT_CX, SHOOT_CY, SHOOT_R, 0, 7);
    ctx.fillStyle = my ? '#E8A33D' : '#3a4453'; ctx.fill();
    ctx.fillStyle = my ? '#fff' : '#8b93a7'; HF('ctl', 'shoot', 13, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('出杆', SHOOT_CX, SHOOT_CY);
    ctx.textBaseline = 'alphabetic';
    /* 上一杆回放入口（§3.3：确定性重演白送红利；P1） */
    ctx.fillStyle = '#8b93a7'; HF('ctl', 'replayBtn', 11, 600); ctx.textAlign = 'center';
    ctx.fillText('上一杆', SHOOT_CX, SHOOT_CY + SHOOT_R + 16);
    ctx.fillStyle = '#5a6675'; HF('foot', 'slug', 9, 400); ctx.textAlign = 'center';
    ctx.fillText('pool-physics · S4 服务端权威物理', W / 2, H - 6);
  }
  function drawBanner() {
    if (banner.ttl <= 0) return;
    ctx.globalAlpha = Math.min(1, banner.ttl / 400);
    ctx.fillStyle = banner.seat === mySeat ? TEAM_COLOR.A : TEAM_COLOR.B;
    HF('banner', 'txt', 13, 600); ctx.textAlign = 'center';
    ctx.fillText(banner.txt, W / 2, TY - 40);
    ctx.globalAlpha = 1;
  }
  function drawFx(dt) {
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i]; f.t -= dt;
      if (f.t <= 0) { fx.splice(i, 1); continue; }
      if (f.k === 'pot') {
        ctx.globalAlpha = f.t / 150;
        ctx.fillStyle = ballColor(f.id);
        ctx.beginPath(); ctx.arc(TX + 170, TY - 12, 6 * (f.t / 150), 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /* ================= 交互（三段单拇指，§1.4） ================= */
  var drag = null;
  function pos(ev) {
    var t = ev.touches ? ev.touches[0] || ev.changedTouches[0] : ev;
    var r = cv.getBoundingClientRect();
    return { x: (t.clientX - r.left) * (W / r.width), y: (t.clientY - r.top) * (H / r.height) };
  }
  function onDown(ev) {
    ev.preventDefault();
    var p = pos(ev);
    /* 旋转盘 */
    if (p.x >= SPIN_X && p.x <= SPIN_X + SPIN_S && p.y >= SPIN_Y && p.y <= SPIN_Y + SPIN_S) {
      var c = Math.min(2, Math.max(0, ((p.x - SPIN_X) / (SPIN_S / 3)) | 0));
      var r = Math.min(2, Math.max(0, ((p.y - SPIN_Y) / (SPIN_S / 3)) | 0));
      spinV = 1 - r; spinS = c - 1;
      return;
    }
    /* 出杆钮 */
    if ((p.x - SHOOT_CX) * (p.x - SHOOT_CX) + (p.y - SHOOT_CY) * (p.y - SHOOT_CY) < SHOOT_R * SHOOT_R) { fireShot(); return; }
    /* 力度槽 */
    if (p.x >= POWER_X - 10 && p.x <= POWER_X + POWER_W + 10 && p.y >= POWER_Y - 8 && p.y <= POWER_Y + POWER_H + 8) {
      drag = { k: 'power' }; setPow(p.y); return;
    }
    /* 桌面：aim 拖拽 / ball-in-hand 放置 */
    if (p.x >= TX && p.x <= TX + TABLE_W && p.y >= TY && p.y <= TY + TABLE_H) {
      if (st && st.phase === 'aim' && st.turn === mySeat && st.ballInHand) { tryPlace(p); return; }
      drag = { k: 'aim' }; setAim(p);
    }
  }
  function setAim(p) {
    var cue = st.balls[0];
    var ax = (p.x - TX) / M2P - cue.x, ay = (p.y - TY) / M2P - cue.y;
    if (ax * ax + ay * ay < 1000000) return;              // 手指贴白球太近：跳过（角分辨率惯技）
    var a = Math.atan2(ay, ax) / (Math.PI * 2);
    if (a < 0) a += 1;
    aimAng = Math.round(a * 65536 / 8) * 8 & 0xFFFF;      // 0.044° 栅格吸附（§2.2）
  }
  function setPow(y) {
    var f = 1 - (y - POWER_Y) / POWER_H;
    f = Math.max(0, Math.min(1, f));
    var np = drag && drag.pow0 !== undefined ? drag.pow0 + (f - drag.f0) * 1000 * 0.6 : f * 1000;   // 0.6 阻尼精调（§3.3）
    if (drag && drag.pow0 === undefined) { drag.pow0 = pow; drag.f0 = f; }
    pow = Math.round(Math.max(0, Math.min(1000, np)));
  }
  function onMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    var p = pos(ev);
    if (drag.k === 'power') setPow(p.y);
    else if (drag.k === 'aim') setAim(p);
  }
  function onUp() { drag = null; }
  function tryPlace(p) {
    var x = Math.round((p.x - TX) / M2P), y = Math.round((p.y - TY) / M2P);
    if (mode === 'online') session && session.sendOp && session.sendOp({ k: 'place', x: x, y: y });
    else { var r = S.applyOp(st, mySeat, { k: 'place', x: x, y: y }); if (!r.ok) flash('位置非法', mySeat); }
  }
  function fireShot() {
    if (matchOver || !st || st.phase !== 'aim' || st.turn !== mySeat || st.ballInHand) return;
    if (mode === 'online') session && session.sendOp && session.sendOp({ k: 'shot', ang: aimAng, pow: pow, spinV: spinV, spinS: spinS });
    else { var r = S.applyOp(st, mySeat, { k: 'shot', ang: aimAng, pow: pow, spinV: spinV, spinS: spinS }); if (r.ok) beginReplay({ seat: mySeat, ang: aimAng, pow: pow, spinV: spinV, spinS: spinS, cue: { x: st.balls[0].x, y: st.balls[0].y } }); }
  }

  /* ================= 主循环（60fps；重演推进 ~1.67 tick/帧） ================= */
  var lastT = 0, acc = 0;
  function frame(ts) {
    var dt = Math.min(50, ts - lastT || 16); lastT = ts;
    if (banner.ttl > 0) banner.ttl -= dt;
    if (replay) { acc += dt; while (acc >= 10 && replay) { stepReplay(); acc -= 10; } }
    else if (mode === 'offline' && st && !matchOver) { offlineTick(); }
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    drawTable(); drawBalls(); drawAim(); drawBanner(); drawFx(dt);
    drawHud(); drawControls();
    requestAnimationFrame(frame);
  }

  /* ================= offline：本地 sim + balanced Bot（网关不可达降级） ================= */
  var botRng = null, botMem = null;
  function offlineTick() {
    for (var i = 0; i < 3; i++) {
      if (st.phase === 'aim') {
        st.aimTicks--;
        if (st.turn !== mySeat) {
          var inp = S.brain(st, st.turn, 'balanced', botRng);
          if (inp && inp.op) { var r = S.applyOp(st, st.turn, inp.op); if (r.ok && r.shot) beginReplay(inp.op.k === 'shot' ? r.shot : { seat: st.turn, ang: inp.op.ang, pow: inp.op.pow, spinV: 0, spinS: 0, cue: { x: st.balls[0].x, y: st.balls[0].y } }); }
        }
        if (st.aimTicks <= 0 && st.phase === 'aim') { /* 本地离线也走代打 */ var rng = S.mulberry32((st.seed ^ (st.shotN << 16)) >>> 0); var auto = null; try { auto = S.brain(st, st.turn, 'casual', rng); } catch (e) { } if (auto && auto.op) S.applyOp(st, st.turn, auto.op); else { st.aimTicks = 3000; } }
      } else if (st.phase === 'motion') {
        var r2 = S.step(st, null);
        announce({ events: r2.events });
        if (r2.ruling && r2.resolve) { /* resolve 完成 */ }
        if (st.over) { matchOver = true; showResult(st.result); }
      }
      if (matchOver) break;
    }
  }

  /* ================= online 接线 ================= */
  function onRuling(msg) {
    started = true;
    syncState(msg);
    if (msg.phase === 'motion' && msg.shot) beginReplay(msg.shot);
    else if (msg.phase === 'aim' || msg.phase === 'ended') { replay = null; }
  }
  function onSnapshot(msg) {
    if (msg.ext && msg.ext.physics && Number.isInteger(msg.ext.physics.hash) && msg.ext.physics.hash !== S.ENGINE_HASH) {
      physicsHashOk = false;   // 版本护栏（§5.1）：回退插值模式（不重演，快照直染）
    }
    if (!physicsHashOk || !replay) {   // 降级端：快照插值直染
      var balls = [];
      for (var i = 0; i < 16; i++) balls.push(st.balls[i] || { x: 0, y: 0, pot: 1 });
      for (var k = 0; k < msg.balls.length; k++) {
        var q = msg.balls[k], b = balls[q[0]];
        b.x = q[1]; b.y = q[2]; if (q.length >= 4) b.pot = q[3];
      }
      for (var j = 0; j < 16; j++) if (!st.balls[j]) st.balls[j] = balls[j];
      st.balls = balls;
    } else verifySnapshot(msg);
  }
  function onEnd(msg) {
    matchOver = true; replay = null;
    showResult(msg.result);
  }
  function showResult(result) {
    var el = document.getElementById('result');
    if (!el) return;
    var win = result.winner === (mySeat === 0 ? 'A' : 'B');
    var info = st || { pottedBy: [0, 0] };
    el.style.display = 'flex';
    el.innerHTML = '<div class="rbox"><div class="rtitle" style="color:' + (result.winner === 'draw' ? '#c9d2dd' : TEAM_COLOR[result.winner]) + '">'
      + (result.winner === 'draw' ? '平局' : win ? '胜利' : '败北') + '</div>'
      + '<div class="rsub">' + ({ 'eight-ball': '合法打进黑八', 'early-eight': '提前落黑八', timeout: '超时剩球裁定', afk: '三次超时认负', resign: '认负', abandon: '全员离线' }[result.reason] || result.reason) + '</div>'
      + '<div class="rtable"><div class="rrow"><span>进球 A/B</span><b>' + (result.scores ? result.scores.A + ' / ' + result.scores.B : '-') + '</b></div></div>'
      + '<button id="rb">再来一局</button><button class="ghost" id="qb">回大厅</button></div>';
    var rb = document.getElementById('rb'); if (rb) rb.onclick = function () { location.reload(); };
    var qb = document.getElementById('qb'); if (qb) qb.onclick = function () { location.href = '/multiplayer.html'; };
  }

  /* ================= 启动 ================= */
  function startOffline(level, opts) {   // ?debug=1 / 网关不可达（同 sim 同 brain 本地对打；perf-smoke 契约）
    var o = opts || {};
    var seed = Number.isInteger(o.seed) ? o.seed : (((level || 1) * 2654435761) >>> 0);
    mode = 'offline'; matchOver = false; replay = null; started = true;
    st = S.create(seed);
    botRng = S.mulberry32(seed);
    aimAng = 8192 << 3; pow = 500; spinV = 0; spinS = 0;
    var r = document.getElementById('result'); if (r) r.style.display = 'none';
    var j = document.getElementById('joining'); if (j) j.style.display = 'none';
    logEv('start', { mode: 'offline', seed: seed, tier: tier });
  }
  function boot() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    st = S.create((Math.random() * 0xfffffff) | 0);       // 先摆一张本地桌（未连上也有画面）
    st.balls.forEach(function (b) { });
    botRng = S.mulberry32(st.seed);
    var params = new URLSearchParams(location.search);
    var roomId = params.get('room');
    logEv('boot', { mode: params.get('debug') === '1' ? 'offline' : 'online', tier: tier });
    if (params.get('debug') === '1') startOffline(1);   // perf-smoke 口径：零网关本地对打（同 slg/mmo/emp）
    else session = G.connect({
      quick: !roomId, roomId: roomId || undefined, gameId: 'pool-physics', name: '玩家',
      onWelcome: function (m) {
        logEv('welcome', { seat: m.seat, role: m.role });
        mySeat = m.role === 'player' ? m.seat : -1;
        if (mySeat < 0) mySeat = 0;
        mode = 'online';
        if (m.room && m.room.physics && Number.isInteger(m.room.physics.hash)) physicsHashOk = m.room.physics.hash === S.ENGINE_HASH;
        if (m.state) { st = m.state; syncState(m.state); }
        document.getElementById('joining').style.display = 'none';
      },
      onStarted: function (m) { logEv('started', {}); started = true; if (m.state) { st = m.state; syncState(m.state); } },
      onRuling: function (m) { logEv('ruling', { phase: m.phase, turn: m.turn }); onRuling(m); },
      onSnapshot: function (m) { if (dbgEvents.length < 1200) logEv('snapshot', { n: (m.balls || []).length }); onSnapshot(m); },
      onSeat: function (m) {
        rosterMap = {};
        for (var i = 0; i < m.seats.length; i++) rosterMap[m.seats[i].seat] = m.seats[i];
        logEv('seat', { seats: m.seats.length });
      },
      onEnd: function (m) { logEv('end', { winner: m.result && m.result.winner }); onEnd(m); },
      onStatus: function (s) {
        logEv('status', { s: s });
        var j = document.getElementById('joining');
        if (s === 'lost' || s === 'closed') { if (!matchOver) { mode = 'offline'; if (j) j.style.display = 'none'; } }
        else if (j && started) j.style.display = 'none';
      },
    });
    requestAnimationFrame(frame);
  }

  cv.addEventListener('mousedown', onDown); cv.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  cv.addEventListener('touchstart', onDown, { passive: false });
  cv.addEventListener('touchmove', onMove, { passive: false });
  cv.addEventListener('touchend', onUp);

  window.__GAMES_DEBUG__ = window.__GAMES_DEBUG__ || {};
  window.__GAMES_DEBUG__.events = dbgEvents;                                                    // F3：perf-smoke 消费（boot/start/…）
  window.__GAMES_DEBUG__.start = function (level, opts) { startOffline(level || 1, opts); };     // 离线重开一局
  window.__GAMES_DEBUG__.state = function () { return JSON.parse(JSON.stringify(st)); };
  window.__GAMES_DEBUG__.seat = function () { return mySeat; };
  window.__GAMES_DEBUG__.roomId = function () { return session ? session.roomId : null; };
  window.__GAMES_DEBUG__.mode = function () { return mode; };
  window.__GAMES_DEBUG__.hudFonts = function () { return HUDF; };
  window.__GAMES_DEBUG__.worldProbe = function () {
    return { mode: mode, tier: tier, assist: assist, phase: st && st.phase, turn: st && st.turn, physicsHashOk: physicsHashOk,
      shotN: st && st.shotN, replay: !!replay, verify: replay ? replay.verify : 0 };
  };

  boot();
})();
