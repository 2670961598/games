/* =====================================================================
 * 净斗坦克 net-tank 客户端逻辑（GAMES-40）——构建期内联进 index.html。
 * 依赖前置内联：sim.cjs（window.NTSim）+ _shared/net.js（window.GNet）。
 * 模式：
 *   online —— ?room=<id> 指定房或快速匹配（GNet 唯一网络出口，S1 帧驱动本地镜像模拟）；
 *   offline —— 网关不可达/无房参数时的离线练习（同 sim 同 brain，本地 10Hz 推进）；
 *   debug —— ?debug=1 强制离线 + __GAMES_DEBUG__ 钩子（perf-smoke/play-check 口径同 GAMES-30）。
 * 单机规范沿用：375×667 安全区（DPR 夹 1..3）、上报协议（boot/start/levelEnd/end，
 * 宿主 __GAMES_HOOK__ 优先、本地 telemetry 兜底）、判定路径零 Math.random。
 * ===================================================================== */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var S = window.NTSim, G = window.GNet;
  var W = 375, H = 667, HUD_H = 42;
  var FIELD_H = S.META.H; // 625
  var TEAM_COLOR = { A: '#38bdf8', B: '#fb923c' };
  var BG = '#0d1117', WALL = '#2a3247', WALL_EDGE = '#39466a', PAGE_BG = '#0b0e14';
  var FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif";

  /* ---------- 上报（§5.3 契约：宿主钩子优先，本地兜底） ---------- */
  var telQueue = [];
  function report(event, payload) {
    try {
      if (window.__GAMES_HOOK__ && window.__GAMES_HOOK__.report) window.__GAMES_HOOK__.report(event, payload);
      else {
        telQueue.push({ t: Date.now(), event: event, payload: payload });
        if (telQueue.length > 50) telQueue.shift();
      }
    } catch (e) { /* 上报永不抛 */ }
    if (window.__GAMES_DEBUG__) window.__GAMES_DEBUG__.events.push({ event: event, payload: payload, at: Date.now() });
  }

  /* ---------- 画布（安全区 + DPR 夹 1..3） ---------- */
  var canvas = document.getElementById('cv'), ctx = canvas.getContext('2d');
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  function fit() {
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var scale = Math.min(vw / W, vh / H);
    var cw = Math.round(W * scale), ch = Math.round(H * scale);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', fit);

  /* ---------- 静态层离屏缓存（A1 纪律：墙一次成图，主循环只 blit） ---------- */
  var wallLayer = null;
  function buildWallLayer(state) {
    wallLayer = document.createElement('canvas');
    wallLayer.width = W * dpr; wallLayer.height = FIELD_H * dpr;
    var g = wallLayer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG; g.fillRect(0, 0, W, FIELD_H);
    g.fillStyle = WALL; g.strokeStyle = WALL_EDGE; g.lineWidth = 1;
    var cell = S.META.cell;
    for (var r = 0; r < state.walls.length; r++) {
      for (var c = 0; c < state.walls[r].length; c++) {
        if (state.walls[r].charCodeAt(c) === 49) {
          g.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
          g.strokeRect(c * cell + 1.5, r * cell + 1.5, cell - 3, cell - 3);
        }
      }
    }
  }

  /* ---------- 对局状态 ---------- */
  var mode = null;            // 'online' | 'offline'
  var simState = null;        // 本地镜像模拟（确定性，与服务端同码）
  var prevPos = null;         // 插值用：上一帧坦克位置 {seat:{x,y}}
  var lastTickAt = 0;         // 上次 sim 推进时刻（插值 alpha）
  var mySeat = -1, myTeam = null, session = null, rosterMap = {};
  var fx = [];                // 表现性特效 {k,x,y,seat,ttl}
  var matchOver = false, started = false;
  var bots = null;            // offline：{seat: rng}
  var offlineTimer = 0;
  var inputMaxMs = 0, lastInputTs = 0;

  function snapshotPrev() {
    prevPos = {};
    for (var i = 0; i < simState.tanks.length; i++) {
      var t = simState.tanks[i];
      prevPos[t.seat] = { x: t.x, y: t.y };
    }
  }

  /* ---------- 输入（触摸摇杆 + 右半开火 + 键盘） ---------- */
  var stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, id: -1 };
  var fireTouch = false, keys = {}, kbFire = false;

  function currentInput() {
    var mx = 0, my = 0;
    if (stick.active) {
      var dx = stick.x - stick.ox, dy = stick.y - stick.oy;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > 8) { var m = Math.min(100, (d - 8) * 1.6); mx = Math.round(dx / d * m); my = Math.round(dy / d * m); }
    }
    if (keys.ArrowLeft || keys.a) mx = -100;
    if (keys.ArrowRight || keys.d) mx = 100;
    if (keys.ArrowUp || keys.w) my = -100;
    if (keys.ArrowDown || keys.s) my = 100;
    var fire = (fireTouch || kbFire) ? 1 : 0;
    return { mx: mx, my: my, fire: fire };
  }

  function markInput(ts) { if (ts) lastInputTs = ts; }
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault(); markInput(e.timeStamp);
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var p = toCanvas(t);
      if (p.x < W / 2 && !stick.active) { stick.active = true; stick.id = t.identifier; stick.ox = p.x; stick.oy = p.y; stick.x = p.x; stick.y = p.y; }
      else fireTouch = true;
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (stick.active && t.identifier === stick.id) { var p = toCanvas(t); stick.x = p.x; stick.y = p.y; }
    }
  }, { passive: false });
  function endTouch(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (stick.active && t.identifier === stick.id) stick.active = false;
      else fireTouch = false;
    }
  }
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);
  window.addEventListener('keydown', function (e) {
    keys[e.key] = true;
    if (e.key === ' ') { kbFire = true; e.preventDefault(); }
    if ('wasdWASD'.indexOf(e.key) >= 0 || e.key.indexOf('Arrow') === 0 || e.key === ' ') markInput(e.timeStamp);
  });
  window.addEventListener('keyup', function (e) { keys[e.key] = false; if (e.key === ' ') kbFire = false; });

  function toCanvas(t) {
    var r = canvas.getBoundingClientRect();
    return { x: (t.clientX - r.left) / r.width * W, y: (t.clientY - r.top) / r.height * H };
  }

  /* ---------- 渲染 ---------- */
  var fpsN = 0, fpsAt = 0, fpsV = 0;
  function render(now) {
    requestAnimationFrame(render);
    fpsN++;
    if (now - fpsAt > 500) { fpsV = Math.round(fpsN * 1000 / (now - fpsAt)); fpsN = 0; fpsAt = now; }
    if (lastInputTs) { inputMaxMs = Math.max(inputMaxMs, now - lastInputTs); lastInputTs = 0; }
    if (!simState) { drawBoot(); return; }

    var alpha = started && !matchOver ? Math.min(1, (now - lastTickAt) / S.META.tickMs) : 1;
    var cur = started && !matchOver ? currentInput() : { mx: 0, my: 0, fire: 0 };
    ctx.fillStyle = PAGE_BG; ctx.fillRect(0, 0, W, H);
    if (wallLayer) ctx.drawImage(wallLayer, 0, HUD_H, W, FIELD_H);

    // 特效（表现层，非判定）
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i];
      f.ttl -= 16;
      if (f.ttl <= 0) { fx.splice(i, 1); continue; }
      if (f.k === 'hit') { ctx.fillStyle = 'rgba(251,146,60,' + (f.ttl / 300 * 0.8) + ')'; ctx.beginPath(); ctx.arc(f.x / 1000, HUD_H + f.y / 1000, 10 + (300 - f.ttl) / 20, 0, 7); ctx.fill(); }
      if (f.k === 'shot') { ctx.fillStyle = 'rgba(232,236,243,.5)'; ctx.fillRect(f.x / 1000 - 2, HUD_H + f.y / 1000 - 2, 4, 4); }
    }

    // 坦克（插值）
    for (var ti = 0; ti < simState.tanks.length; ti++) {
      var t = simState.tanks[ti];
      var px = t.x / 1000, py = t.y / 1000;
      if (prevPos && prevPos[t.seat] && t.alive && alpha < 1) {
        px = prevPos[t.seat].x / 1000 + (t.x / 1000 - prevPos[t.seat].x / 1000) * alpha;
        py = prevPos[t.seat].y / 1000 + (t.y / 1000 - prevPos[t.seat].y / 1000) * alpha;
      }
      var cx = px, cy = HUD_H + py;
      if (!t.alive) { // 残骸
        ctx.fillStyle = 'rgba(90,96,120,.55)';
        ctx.fillRect(cx - 9, cy - 9, 18, 18);
        continue;
      }
      var col = TEAM_COLOR[t.team];
      if (t.seat === mySeat) {
        ctx.strokeStyle = '#e8ecf3'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 13, 0, 7); ctx.stroke();
        // 本地输入预示（表现层，不动 sim 确定性）：10Hz lockstep 下让操纵反馈落在下一渲染帧（<100ms 红线）
        if (started && !matchOver) {
          cx += cur.mx / 100 * 11 * alpha;
          cy += cur.my / 100 * 11 * alpha;
        }
      }
      ctx.fillStyle = col;
      ctx.fillRect(cx - 9, cy - 9, 18, 18);
      ctx.fillStyle = 'rgba(11,14,20,.5)';
      ctx.fillRect(cx - 9, cy - 9, 18, 6);
      // 炮管（朝向 fx/fy）
      var fl = Math.sqrt(t.fx * t.fx + t.fy * t.fy) || 1;
      ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + t.fx / fl * 14, cy + t.fy / fl * 14);
      ctx.stroke();
      // 血量
      for (var hp = 0; hp < S.META.hpMax; hp++) {
        ctx.fillStyle = hp < t.hp ? '#e8ecf3' : 'rgba(232,236,243,.18)';
        ctx.fillRect(cx - 9 + hp * 7, cy + 10, 5, 2);
      }
      // 冷却环
      if (t.cool > 0 && t.seat === mySeat) {
        ctx.strokeStyle = 'rgba(232,236,243,.4)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 16, -Math.PI / 2, -Math.PI / 2 + (1 - t.cool / 6) * Math.PI * 2); ctx.stroke();
      }
    }
    // 子弹
    ctx.fillStyle = '#fde68a';
    for (var bi = 0; bi < simState.bullets.length; bi++) {
      var b = simState.bullets[bi];
      ctx.beginPath(); ctx.arc(b.x / 1000, HUD_H + b.y / 1000, 3, 0, 7); ctx.fill();
    }
    drawHud();
    drawStick();
  }

  function drawBoot() {
    ctx.fillStyle = PAGE_BG; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#5b657d'; ctx.font = '14px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText('正在加入对局…', W / 2, H / 2);
  }

  function drawHud() {
    ctx.fillStyle = 'rgba(15,19,28,.96)'; ctx.fillRect(0, 0, W, HUD_H);
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(0, HUD_H + .5); ctx.lineTo(W, HUD_H + .5); ctx.stroke();
    // 双队存活/击杀
    var alive = { A: 0, B: 0 }, hpSum = { A: 0, B: 0 };
    for (var i = 0; i < simState.tanks.length; i++) {
      var t = simState.tanks[i];
      if (!t.alive) continue;
      alive[t.team]++; hpSum[t.team] += t.hp;
    }
    ctx.font = '12px ' + FONT; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.fillStyle = TEAM_COLOR.A;
    ctx.fillText('A 存活' + alive.A + ' 击杀' + simState.kills.A, 10, HUD_H / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = TEAM_COLOR.B;
    ctx.fillText('击杀' + simState.kills.B + ' 存活' + alive.B + ' B', W - 10, HUD_H / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = '#e8ecf3';
    var secLeft = Math.max(0, Math.ceil((simState.maxTicks - simState.tick) / 10));
    ctx.fillText(mmss(secLeft), W / 2, HUD_H / 2 - 7);
    var ping = mode === 'online' && session ? (session.rttMs ? session.rttMs + 'ms' : '--') : '离线';
    ctx.font = '10px ' + FONT; ctx.fillStyle = '#5b657d';
    ctx.fillText(ping + ' · ' + S.META.mode, W / 2, HUD_H / 2 + 8);
  }

  function mmss(s) { var m = (s / 60) | 0; return (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); }

  function drawStick() {
    if (!stick.active) return;
    ctx.strokeStyle = 'rgba(232,236,243,.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(stick.ox, stick.oy, 34, 0, 7); ctx.stroke();
    var dx = stick.x - stick.ox, dy = stick.y - stick.oy, d = Math.sqrt(dx * dx + dy * dy);
    var m = Math.min(d, 34);
    ctx.fillStyle = 'rgba(232,236,243,.4)';
    ctx.beginPath(); ctx.arc(stick.ox + (d ? dx / d * m : 0), stick.oy + (d ? dy / d * m : 0), 14, 0, 7); ctx.fill();
  }

  /* ---------- 对局事件 → 特效 ---------- */
  function applyEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.k === 'shot') { var t = simState.tanks[e.seat]; if (t) fx.push({ k: 'shot', x: t.x, y: t.y, ttl: 120 }); }
      if (e.k === 'hit') fx.push({ k: 'hit', x: simState.tanks[e.seat] ? simState.tanks[e.seat].x : 0, y: simState.tanks[e.seat] ? simState.tanks[e.seat].y : 0, ttl: 300 });
    }
    if (fx.length > 40) fx.splice(0, fx.length - 40);
  }

  /* ---------- 终局 ---------- */
  function finish(result) {
    if (matchOver) return;
    matchOver = true;
    var win = myTeam ? (result.winner === myTeam ? 1 : result.winner === 'draw' ? 0.5 : 0) : 0.5;
    report('levelEnd', { win: win, score: (simState.kills[myTeam || 'A'] || 0), reason: result.reason });
    report('end', { win: win, score: (simState.kills[myTeam || 'A'] || 0) });
    showResult(result);
  }

  function showResult(result) {
    var title, sub;
    if (!myTeam) { title = '对局结束'; sub = '旁观视角'; }
    else if (result.winner === 'draw') { title = '平局'; sub = '势均力敌'; }
    else if (result.winner === myTeam) { title = '胜利'; sub = '击杀 ' + simState.kills.A + ' : ' + simState.kills.B; }
    else { title = '失败'; sub = '击杀 ' + simState.kills.A + ' : ' + simState.kills.B; }
    var el = document.getElementById('result');
    el.style.display = 'flex';
    el.innerHTML =
      '<div class="rbox"><div class="rtitle">' + title + '</div><div class="rsub">' + sub + '</div>' +
      '<button id="again" type="button">再来一局</button>' +
      '<button id="tolobby" type="button" class="ghost">回大厅</button></div>';
    document.getElementById('again').onclick = function () {
      el.style.display = 'none';
      location.href = location.pathname + (mode === 'offline' ? '?debug=1&again=1' : '?quick=1');
    };
    document.getElementById('tolobby').onclick = function () { location.href = '/multiplayer.html'; };
  }

  /* ---------- 离线练习（同 sim 同 brain；判定路径零 Math.random——bot 随机源用房间 seed 派生） ---------- */
  function startOffline(opts) {
    opts = opts || {};
    mode = 'offline';
    var seed = S.fnv1a32('offline-' + (opts.seedSalt || '0'));
    var levels = opts.bots || ['balanced', 'casual', 'balanced'];
    simState = S.create(seed, { hp: opts.hp, maxTicks: opts.maxTicks });
    buildWallLayer(simState);
    mySeat = 0; myTeam = 'A';
    rosterMap = { 0: { kind: 'human', name: '你' } };
    for (var i = 1; i < 4; i++) rosterMap[i] = { kind: 'bot', name: 'Bot·' + ({ casual: '休闲', balanced: '均衡', competitive: '竞技' })[levels[i - 1]] };
    bots = {};
    for (var j = 1; j < 4; j++) bots[j] = { rng: S.mulberry32((seed ^ (j * 0x9e3779b9)) >>> 0), level: levels[j - 1] };
    beginMatch();
    if (offlineTimer) clearInterval(offlineTimer);
    offlineTimer = setInterval(function () {
      if (matchOver) { clearInterval(offlineTimer); return; }
      var inputs = {};
      inputs[0] = currentInput();
      for (var s = 1; s < 4; s++) inputs[s] = S.brain(simState, s, bots[s].level, bots[s].rng);
      stepLocal(inputs);
    }, S.META.tickMs);
  }

  function stepLocal(inputs) {
    snapshotPrev();
    var r = S.step(simState, inputs);
    lastTickAt = performance.now();
    applyEvents(r.events);
    if (r.over) { clearInterval(offlineTimer); finish(r.result); }
  }

  function beginMatch() {
    started = true; matchOver = false; lastTickAt = performance.now();
    document.getElementById('joining').style.display = 'none';
    report('start', { mode: mode, room: session ? session.roomId : 'offline' });
  }

  /* ---------- 在线（S1：服务端帧驱动本地镜像） ---------- */
  function startOnline(roomId) {
    mode = 'online';
    document.getElementById('joining').style.display = 'flex';
    session = G.connect({
      roomId: roomId || undefined,
      quick: !roomId,
      gameId: 'net-tank',
      maxTicks: new URLSearchParams(location.search).get('maxTicks') ? Number(new URLSearchParams(location.search).get('maxTicks')) : undefined,
      onWelcome: function (m) {
        mySeat = m.seat; myTeam = m.seat >= 0 ? (m.seat % 2 === 0 ? 'A' : 'B') : null;
        simState = m.state;
        buildWallLayer(simState);
        for (var i = 0; i < m.room.seats.length; i++) rosterMap[m.room.seats[i].seat] = m.room.seats[i];
        if (m.room.state === 'live') beginMatch();
        else document.getElementById('joining').textContent = '开赛中 ' + Math.ceil(m.room.countdownMs / 1000) + 's';
      },
      onStarted: function (m) {
        simState = m.state;
        buildWallLayer(simState);
        beginMatch();
      },
      onFrame: function (m) {
        if (!simState) return;
        if (m.frame !== simState.tick + 1) {
          if (m.frame <= simState.tick) return;          // 重复帧忽略
          session.sync();                                 // 缺帧：请求全量重同步（协议 §4.1）
          return;
        }
        snapshotPrev();
        var r = S.step(simState, m.inputs);
        lastTickAt = performance.now();
        applyEvents(r.events);
        if (m.over && r.over) finish(r.result);
        // 本地输入随帧上行（input delay=1）
        if (!matchOver) session.sendInput(currentInput());
      },
      onState: function (m) { simState = m.state; buildWallLayer(simState); },
      onSeat: function (m) { for (var i = 0; i < m.seats.length; i++) rosterMap[m.seats[i].seat] = m.seats[i]; },
      onEnd: function (m) { finish(m.result); },
      onClosed: function () { if (!matchOver) showResult({ winner: 'draw', reason: 'abandon' }); },
      onError: function (m) {
        if (m.code === 'reconnect-timeout' || m.code === 'room-gone') fallbackOffline('对局已结束');
      },
      onStatus: function (st) {
        var el = document.getElementById('joining');
        if (st === 'reconnecting') { el.style.display = 'flex'; el.textContent = '重连中…'; }
      },
    });
    // 网关不可达兜底：4s 仍无 welcome → 离线练习
    setTimeout(function () {
      if (!started && session && session.status !== 'live') fallbackOffline('网关不可达，已切换离线练习');
    }, 4000);
  }

  var fellBack = false;
  function fallbackOffline(reason) {
    if (started && !matchOver) return; // 对局进行中断线：保持画面（重连窗内自动恢复）
    if (fellBack) return;
    fellBack = true;
    if (session) { try { session.close(); } catch (e) { /* 已断 */ } }
    session = null;
    var el = document.getElementById('banner');
    el.textContent = reason; el.style.display = 'block';
    startOffline();
  }

  /* ---------- 调试钩子（GAMES-30 契约：perf-smoke/play-check 零改动可跑） ---------- */
  window.__GAMES_DEBUG__ = {
    events: [],
    start: function (level, opts) { startOffline(Object.assign({ seedSalt: String(level || 1) }, opts || {})); },
    state: function () { return JSON.parse(JSON.stringify(simState)); },
    seat: function () { return mySeat; },
    roomId: function () { return session ? session.roomId : null; },
    mode: function () { return mode; },
    fps: function () { return fpsV; },
    perf: function () { return { inputMaxMs: Math.round(inputMaxMs), fps: fpsV }; },
  };

  /* ---------- 启动 ---------- */
  fit();
  report('boot', { slug: 'net-tank', version: '1.0.0', mode: 'net' });
  var q = new URLSearchParams(location.search);
  requestAnimationFrame(render);
  if (q.get('debug') === '1') startOffline({ seedSalt: q.get('again') ? String(Date.now() % 97) : '1' });
  else if (q.get('room')) startOnline(q.get('room'));
  else startOnline(null); // 快速匹配
})();
