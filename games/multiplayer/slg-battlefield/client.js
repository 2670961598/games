/* =====================================================================
 * 指挥官战场 slg-battlefield 客户端逻辑（GAMES-43）——构建期内联进 index.html。
 * 依赖前置内联：sim.cjs（window.SLGSim）+ _shared/net.js（window.GNet）。
 * 模式：
 *   online —— ?room=<id> 指定房或快速匹配（GNet 唯一网络出口，S1 帧驱动本地镜像模拟）；
 *   offline —— 网关不可达/无房参数时的离线练习（同 sim 同 brain，本地 10Hz 推进）；
 *   debug —— ?debug=1 强制离线 + __GAMES_DEBUG__ 钩子（perf-smoke/play-check 口径同 GAMES-30）。
 * 单拇指操作映射（设计 §1.4）：拖出兵卡→车道=出兵；点技能钮（瞄准类再点车道）；
 * 长按战场 ≥400ms=设集结线；点研究钮=升阶。乐观表现（§3.1）：松手即刻扣 CP 显示/
 * 涟漪/舱门动效，权威帧 300ms 内到场纠正，CP 不足权威帧拒绝 → 卡牌红闪回弹。
 * 视觉（§7）：暗色战场 #0D1117 + 阵营双色 A 琥珀 #E8A33D / B 青 #3DC8E8。
 * ===================================================================== */
(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var S = window.SLGSim, G = window.GNet;
  var W = 375, H = 667, TOP_H = 60, BOT_H = 107;
  var FIELD_H = 500;                       // 20 行 × 25px（设计 §1.1）
  var ROW_PX = 25;
  var TEAM_COLOR = { A: '#E8A33D', B: '#3DC8E8' };
  var TEAM_DIM = { A: 'rgba(232,163,61,', B: 'rgba(61,200,232,' };
  var BG = '#0D1117', PAGE_BG = '#0b0e14', GRID = '#151b12', GRID_LINE = 'rgba(255,255,255,.04)';
  var LANE_LINE = 'rgba(255,255,255,.08)';
  var FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif";
  var UNIT_CN = { inf: '步兵', razor: '装甲', arty: '炮兵', sniper: '狙击', medic: '军医', heavy: '重坦' };
  var SKILL_CN = ['火力覆盖', '紧急维修', '空降突击', '集结号令'];
  var AIM_SKILL = [true, false, true, false];       // barrage/drop 需瞄准

  /* ---------- 上报（§5.3 契约：宿主钩子优先，本地兜底） ---------- */
  function report(event, payload) {
    try {
      if (window.__GAMES_HOOK__ && window.__GAMES_HOOK__.report) window.__GAMES_HOOK__.report(event, payload);
    } catch (e) { /* 上报永不抛 */ }
    if (window.__GAMES_DEBUG__) window.__GAMES_DEBUG__.events.push({ event: event, payload: payload, at: Date.now() });
  }

  /* ---------- 画布（安全区 + DPR 夹 1..3） ---------- */
  var canvas = document.getElementById('cv'), ctx = canvas.getContext('2d');
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  function fit() {
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var scale = Math.min(vw / W, vh / H);
    canvas.style.width = Math.round(W * scale) + 'px'; canvas.style.height = Math.round(H * scale) + 'px';
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', fit);

  /* ---------- 指挥区几何（底栏 107px 三行，§1.1） ---------- */
  var BOT_Y = TOP_H + FIELD_H;                       // 560
  var ROW1_Y = BOT_Y, ROW1_H = 26;                   // 资源条｜兵力条｜研究钮
  var CARDS_Y = BOT_Y + ROW1_H, CARD_H = 46;         // 6 出兵卡
  var SKILL_Y = CARDS_Y + CARD_H, SKILL_H = 34;      // 4 技能钮
  var CARD_W = (W - 8 - 5 * 3) / 6;                  // 边距 4 + 卡间距 3
  var SKILL_W = (W - 8 - 3 * 6) / 4;
  var UNIT_ORDER = ['inf', 'razor', 'arty', 'sniper', 'medic', 'heavy'];
  var COUNTER_TXT = { inf: '→炮', razor: '→步', arty: '→甲', sniper: '→步', medic: '疗', heavy: '→建' };

  function cardRect(i) { return { x: 4 + i * (CARD_W + 3), y: CARDS_Y, w: CARD_W, h: CARD_H }; }
  function skillRect(i) { return { x: 4 + i * (SKILL_W + 6), y: SKILL_Y, w: SKILL_W, h: SKILL_H }; }
  var researchRect = { x: W - 52, y: ROW1_Y + 3, w: 48, h: 20 };

  /* ---------- 对局状态 ---------- */
  var mode = null;                 // 'online' | 'offline'
  var simState = null;             // 本地镜像模拟（确定性，与服务端同码）
  var prevY = null;                // 插值用：上一帧单位 y {id:y}
  var lastTickAt = 0;              // 上次 sim 推进时刻（插值 alpha）
  var mySeat = -1, myTeam = null, session = null, rosterMap = {};
  var fx = [];                     // 表现性特效
  var matchOver = false, started = false;
  var bots = null, offlineTimer = 0;
  var cmdQueue = [];               // 本地指令队列（每帧至多发 1 条，§5.1）
  var pendingCost = 0;             // 乐观表现：已排队未确认的 CP 扣减（镜像帧到场纠正）
  var aiming = -1;                 // 瞄准中的技能 id（-1 无）
  var selLane = 1;                 // 键盘选中的车道（调试/键盘通道）
  var lastBaseHp = { A: 1500, B: 1500 };  // 基地受击脉冲（表现层看状态差分）
  var inputMaxMs = 0, lastInputTs = 0;
  var killStreak = 0, killStreakAt = 0, bannerTtl = 0, bannerTxt = '';
  var shakeT = 0, shakeAmp = 0, slowmoUntil = 0;

  function mySeatState() { return simState && simState.seats[mySeat]; }
  function snapshotPrev() {
    prevY = {};
    for (var i = 0; i < simState.units.length; i++) prevY[simState.units[i].id] = simState.units[i].y;
  }

  /* ---------- 输入：单拇指三手势 + 键盘（调试/QA 通道） ---------- */
  var drag = null;                 // {unit, x, y, active}
  var press = null;                // {x, y, t, moved, longfired}
  var LONGPRESS_MS = 400;

  function queueCmd(cmd) {
    if (cmdQueue.length < 4) cmdQueue.push(cmd);      // 连续快速操作本地排队，逐帧各发 1 条（§5.1）
    if (cmd.k === 'spawn') {
      var spec = S.UNITS[cmd.unit], cost = spec.costs[mySeatState() ? mySeatState().tier - 1 : 0];
      pendingCost += cost * 1000;
      addFloat(W / 2, BOT_Y + 30, '-' + cost, '#f87171');
    }
  }
  function markInput(ts) { if (ts) lastInputTs = ts; }
  function toCanvas(t) {
    var r = canvas.getBoundingClientRect();
    return { x: (t.clientX - r.left) / r.width * W, y: (t.clientY - r.top) / r.height * H };
  }
  function laneAt(x) { return Math.max(0, Math.min(2, (x / (W / 3)) | 0)); }
  function rowAt(y) { return Math.max(0, Math.min(19, ((y - TOP_H) / ROW_PX) | 0)); }
  function inField(p) { return p.y >= TOP_H && p.y < BOT_Y; }

  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault(); markInput(e.timeStamp);
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], p = toCanvas(t);
      if (p.y >= CARDS_Y && p.y < CARDS_Y + CARD_H) {           // 拖出兵卡
        var ci = Math.max(0, Math.min(5, ((p.x - 4) / (CARD_W + 3)) | 0));
        drag = { unit: UNIT_ORDER[ci], x: p.x, y: p.y, id: t.identifier, fromCard: true };
      } else if (p.y >= SKILL_Y && p.y < SKILL_Y + SKILL_H) {   // 点技能钮
        var si = Math.max(0, Math.min(3, ((p.x - 4) / (SKILL_W + 6)) | 0));
        if (AIM_SKILL[si]) { aiming = aiming === si ? -1 : si; }
        else { queueCmd({ k: 'skill', id: si }); aiming = -1; fxSkillBtn(si); }
      } else if (p.y >= ROW1_Y && p.y < ROW1_Y + ROW1_H && p.x >= researchRect.x) {  // 研究钮
        var st = mySeatState();
        var nextTier = st && st.tier === 1 ? 2 : st && st.tier === 2 ? 3 : 0;
        if (nextTier) queueCmd({ k: 'research', tier: nextTier });
      } else if (inField(p)) {                                    // 战场：瞄准落点 / 长按集结
        if (aiming >= 0) {
          queueCmd({ k: 'skill', id: aiming, lane: laneAt(p.x), row: rowAt(p.y) });
          fxSkillBtn(aiming);
          fx.push({ k: 'aim', x: p.x, y: p.y, ttl: 300, max: 300 });
          aiming = -1;
        } else {
          press = { x: p.x, y: p.y, t: e.timeStamp, moved: false, longfired: false, id: t.identifier };
        }
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], p = toCanvas(t);
      if (drag && t.identifier === drag.id) { drag.x = p.x; drag.y = p.y; }
      if (press && t.identifier === press.id && (Math.abs(p.x - press.x) > 10 || Math.abs(p.y - press.y) > 10)) press.moved = true;
    }
  }, { passive: false });
  function endTouch(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i], p = toCanvas(t);
      if (drag && t.identifier === drag.id) {
        if (inField(p)) {                                         // 松手落点=车道 → 出兵（§1.4）
          var lane = laneAt(p.x);
          queueCmd({ k: 'spawn', unit: drag.unit, lane: lane });
          fx.push({ k: 'ripple', x: p.x, y: Math.max(TOP_H + 8, Math.min(BOT_Y - 8, p.y)), ttl: 200, max: 200 });
          fx.push({ k: 'door', team: myTeam || 'A', ttl: 200, max: 200 });
        }
        drag = null;
      }
      if (press && t.identifier === press.id) press = null;
    }
  }
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  /* 键盘（QA/调试）：1-6 出兵到选中车道，Q/W/E/R 技能，U 研究，←→ 选车道 */
  window.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k >= '1' && k <= '6') { markInput(e.timeStamp); queueCmd({ k: 'spawn', unit: UNIT_ORDER[Number(k) - 1], lane: selLane }); }
    else if (k === 'q' || k === 'Q') { markInput(e.timeStamp); queueCmd({ k: 'skill', id: 0, lane: selLane, row: 9 }); fxSkillBtn(0); }
    else if (k === 'w' || k === 'W') { queueCmd({ k: 'skill', id: 1 }); fxSkillBtn(1); }
    else if (k === 'e' || k === 'E') { queueCmd({ k: 'skill', id: 2, lane: selLane, row: 9 }); fxSkillBtn(2); }
    else if (k === 'r' || k === 'R') { queueCmd({ k: 'skill', id: 3 }); fxSkillBtn(3); }
    else if (k === 'u' || k === 'U') { var st = mySeatState(); var nt = st && st.tier === 1 ? 2 : 3; queueCmd({ k: 'research', tier: nt }); }
    else if (k === 'ArrowLeft') { selLane = Math.max(0, selLane - 1); }
    else if (k === 'ArrowRight') { selLane = Math.min(2, selLane + 1); }
  });

  function fxSkillBtn(id) { fx.push({ k: 'skillbtn', id: id, ttl: 180, max: 180 }); }
  function addFloat(x, y, txt, color) { fx.push({ k: 'float', x: x, y: y, txt: txt, color: color, ttl: 700, max: 700 }); }

  /* ---------- 事件 → 特效（零 diff 触发，协议 §5） ---------- */
  /* die 事件不带坐标（协议形状冻结）——step 前快照单位坐标，step 后按阵亡序对位 */
  var posById = {};
  function snapshotPos() { posById = {}; for (var i = 0; i < simState.units.length; i++) { var u = simState.units[i]; posById[u.id] = { x: unitX(u), y: TOP_H + u.y / 1000 }; } }
  function deadPositions() {
    var alive = {};
    for (var i = 0; i < simState.units.length; i++) alive[simState.units[i].id] = 1;
    var out = Object.keys(posById).map(Number).filter(function (id) { return !alive[id]; }).sort(function (a, b) { return a - b; });
    return out.map(function (id) { return posById[id]; });
  }

  function applyEvents(events, deadPos) {
    var now = performance.now();
    var di = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.k === 'spawn') {
        fx.push({ k: 'door', team: e.seat % 2 === 0 ? 'A' : 'B', ttl: 200, max: 200 });
        fx.push({ k: 'ripple', x: 62.5 + e.lane * 125, y: e.seat % 2 === 0 ? BOT_Y - 14 : TOP_H + 14, ttl: 200, max: 200 });
      } else if (e.k === 'die') {
        var p = deadPos && deadPos[di++] || { x: W / 2, y: H / 2 };
        fx.push({ k: 'boom', x: p.x, y: p.y, team: e.seat % 2 === 0 ? 'A' : 'B', ttl: 300, max: 300 });
        if (e.by === mySeat && simState.seats[mySeat]) {
          if (now - killStreakAt < 5000) killStreak++; else killStreak = 1;
          killStreakAt = now;
          if (killStreak >= 3) { bannerTxt = '连续歼击 ×' + killStreak; bannerTtl = 1200; }
        }
      } else if (e.k === 'skill') {
        fx.push({ k: 'cast', seat: e.seat, id: e.id, ttl: 350, max: 350 });
        if (e.id === 0) fx.push({ k: 'barrage-in', lane: e.lane, row: e.row, ttl: 400, max: 400 });
      } else if (e.k === 'cap') {
        if (e.alpha >= 100) { bannerTxt = (e.owner === (myTeam || 'A') ? '信号塔占领' : '信号塔失守'); bannerTtl = 900; }
      } else if (e.k === 'basehp' && e.hp === 0) {
        slowmoUntil = now + 2000; shakeT = 500; shakeAmp = 6;
      }
    }
    if (fx.length > 90) fx.splice(0, fx.length - 90);
  }

  /* ---------- 渲染 ---------- */
  var fpsN = 0, fpsAt = 0, fpsV = 0;
  var staticLayer = null;                            // A1 纪律：战场底图一次成图
  function buildStatic() {
    staticLayer = document.createElement('canvas');
    staticLayer.width = W * dpr; staticLayer.height = FIELD_H * dpr;
    var g = staticLayer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG; g.fillRect(0, 0, W, FIELD_H);
    g.fillStyle = GRID;                                     // 暗橄榄噪点格（行网格微弱可见）
    for (var r = 0; r < 20; r++) for (var c = 0; c < 15; c++) {
      if ((r * 15 + c) % 7 === 0) g.fillRect(c * 25 + 6, r * 25 + 6, 13, 13);
    }
    g.strokeStyle = GRID_LINE; g.lineWidth = 1;
    for (var rr = 1; rr < 20; rr++) { g.beginPath(); g.moveTo(0, rr * 25 + .5); g.lineTo(W, rr * 25 + .5); g.stroke(); }
    g.strokeStyle = LANE_LINE;                              // 车道分隔线（8% 中性灰）
    for (var l = 1; l < 3; l++) { g.beginPath(); g.moveTo(l * 125 + .5, 0); g.lineTo(l * 125 + .5, FIELD_H); g.stroke(); }
    /* 基地带（顶/底）与防御塔底座 */
    g.fillStyle = 'rgba(255,255,255,.03)';
    g.fillRect(0, 0, W, 25); g.fillRect(0, FIELD_H - 25, W, 25);
  }

  function unitX(u) { return 62.5 + u.lane * 125 + (((u.id * 97) % 70) - 35) * 0.55; }   // 确定性横向散布（渲染层）

  function render(now) {
    requestAnimationFrame(render);
    fpsN++;
    if (now - fpsAt > 500) { fpsV = Math.round(fpsN * 1000 / (now - fpsAt)); fpsN = 0; fpsAt = now; }
    if (lastInputTs) { inputMaxMs = Math.max(inputMaxMs, now - lastInputTs); lastInputTs = 0; }
    if (!simState) { drawBoot(); return; }

    var slow = now < slowmoUntil ? 0.5 : 1;           // 终局慢动作（渲染层 timeScale，模拟不变）
    var alpha = started && !matchOver ? Math.min(1, (now - lastTickAt) / (S.META.tickMs * slow)) : 1;
    ctx.fillStyle = PAGE_BG; ctx.fillRect(0, 0, W, H);
    ctx.save();
    if (shakeT > 0) { var s2 = shakeAmp * (shakeT / 500); ctx.translate((Math.random() - .5) * 2 * s2, (Math.random() - .5) * 2 * s2); shakeT -= 16; }
    if (staticLayer) ctx.drawImage(staticLayer, 0, TOP_H, W, FIELD_H);

    drawBases();
    drawTowers();
    drawRallies();
    drawUnits(alpha);
    drawFx(now);
    ctx.restore();
    drawTop();
    drawBottom(now);
    if (bannerTtl > 0) {                               // 连杀/占点横幅
      bannerTtl -= 16;
      ctx.fillStyle = 'rgba(11,14,20,.8)'; ctx.fillRect(W / 2 - 90, TOP_H + 130, 180, 26);
      ctx.fillStyle = '#e8ecf3'; ctx.font = '700 13px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(bannerTxt, W / 2, TOP_H + 143);
    }
    if (drag && drag.fromCard) drawDragCard();
    if (aiming >= 0) drawAiming();
    if (mode !== 'online' || !started) drawSelLane();
  }

  function drawBoot() {
    ctx.fillStyle = PAGE_BG; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#5b657d'; ctx.font = '14px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('正在加入对局…', W / 2, H / 2);
  }

  /* 顶栏 60px：敌方基地血条 + 双向积分条 + pop + ping（§7） */
  function drawTop() {
    ctx.fillStyle = 'rgba(13,17,23,.97)'; ctx.fillRect(0, 0, W, TOP_H);
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(0, TOP_H + .5); ctx.lineTo(W, TOP_H + .5); ctx.stroke();
    var foe = myTeam === 'B' ? 'A' : 'B';
    var foeBase = null, myBaseHp = 1500;
    for (var i = 0; i < simState.bld.length; i++) {
      var b = simState.bld[i];
      if (b.kind !== 'base') continue;
      if (b.team === foe) foeBase = b;
      if (b.team === (myTeam || 'A')) myBaseHp = b.hp;
    }
    ctx.textBaseline = 'middle';
    /* 行 1 左：敌方基地 HP 条 */
    var fh = foeBase ? Math.max(0, foeBase.hp) : 0;
    ctx.font = '10px ' + FONT; ctx.textAlign = 'left';
    ctx.fillStyle = TEAM_COLOR[foe]; ctx.fillText('敌方基地', 8, 11);
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(8, 19, 200, 7);
    ctx.fillStyle = TEAM_COLOR[foe]; ctx.fillRect(8, 19, 200 * fh / 1500, 7);
    ctx.fillStyle = '#8b93a7'; ctx.fillText(String(fh), 212, 22);
    /* 行 1 右：双向积分条（向中间汇聚，先到 400 端溢出告警色） */
    var sc = simState.score;
    var mid = W - 130 + 61;
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(W - 130, 8, 122, 10);
    ctx.fillStyle = sc.A >= 400 ? '#fde68a' : TEAM_COLOR.A; ctx.fillRect(mid - (Math.min(400, sc.A) / 400) * 61, 8, (Math.min(400, sc.A) / 400) * 61, 10);
    ctx.fillStyle = sc.B >= 400 ? '#fde68a' : TEAM_COLOR.B; ctx.fillRect(mid, 8, (Math.min(400, sc.B) / 400) * 61, 10);
    ctx.font = '9px ' + FONT; ctx.fillStyle = '#8b93a7';
    ctx.fillText('积分 ' + sc.A, W - 130, 26); ctx.textAlign = 'right'; ctx.fillText(sc.B + ' 积分', W - 8, 26);
    /* 行 2 左：我方基地 HP */
    ctx.textAlign = 'left'; ctx.font = '10px ' + FONT;
    ctx.fillStyle = TEAM_COLOR[myTeam || 'A']; ctx.fillText('我方基地', 8, 38);
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(58, 34, 150, 7);
    ctx.fillStyle = TEAM_COLOR[myTeam || 'A']; ctx.fillRect(58, 34, 150 * myBaseHp / 1500, 7);
    ctx.fillStyle = '#8b93a7'; ctx.fillText(String(myBaseHp), 212, 37);
    /* 行 2 右：兵力 / 剩余时间 */
    var st = mySeatState();
    var pop = st ? simState.units.filter(function (u) { return u.seat === mySeat; }).length : 0;
    var mm = Math.max(0, ((simState.maxTicks - simState.tick) / 10) | 0);
    var tstr = ((mm / 60) | 0) + ':' + (mm % 60 < 10 ? '0' : '') + (mm % 60);
    ctx.textAlign = 'center'; ctx.font = '10px ' + FONT;
    ctx.fillStyle = pop >= 12 ? '#f87171' : '#e8ecf3';
    ctx.fillText('兵力 ' + pop + '/12', W - 95, 37);
    ctx.fillStyle = '#8b93a7'; ctx.fillText(tstr, W - 32, 37);
    /* 行 3：ping · 模式 */
    var ping = mode === 'online' && session ? (session.rttMs ? session.rttMs + 'ms' : '--') : '离线';
    ctx.font = '9px ' + FONT; ctx.fillStyle = '#5b657d'; ctx.textAlign = 'left';
    ctx.fillText(ping + ' · ' + S.META.mode, 8, 52);
  }

  /* 战场层：基地（含裂纹三档）/防御塔/信号塔（环形占领进度） */
  function drawBases() {
    for (var i = 0; i < simState.bld.length; i++) {
      var b = simState.bld[i];
      var y = TOP_H + b.y / 1000;
      if (b.kind === 'base') {
        var h = 22;
        ctx.fillStyle = 'rgba(255,255,255,.05)';
        ctx.fillRect(0, b.team === 'B' ? TOP_H : BOT_Y - h, W, h);
        ctx.fillStyle = b.team === 'A' ? '#E8A33D' : '#3DC8E8';   // 阵营色内缘光带
        ctx.globalAlpha = .3;
        if (b.team === 'B') ctx.fillRect(0, TOP_H, W, 4); else ctx.fillRect(0, BOT_Y - 4, W, 4);
        ctx.globalAlpha = 1;
        /* 裂纹三档（75/50/25%） */
        var pct = b.hp / b.max;
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1;
        var n = pct <= .25 ? 5 : pct <= .5 ? 3 : pct <= .75 ? 1 : 0;
        for (var c = 0; c < n; c++) {
          var x0 = 40 + c * 70;
          ctx.beginPath();
          if (b.team === 'B') { ctx.moveTo(x0, TOP_H); ctx.lineTo(x0 + 8, TOP_H + 10); ctx.lineTo(x0 + 2, TOP_H + 20); }
          else { ctx.moveTo(x0, BOT_Y); ctx.lineTo(x0 + 8, BOT_Y - 10); ctx.lineTo(x0 + 2, BOT_Y - 20); }
          ctx.stroke();
        }
        /* 基地血条（战场内缘） */
        ctx.fillStyle = 'rgba(255,255,255,.15)';
        var by = b.team === 'B' ? TOP_H + 24 : BOT_Y - 30;
        ctx.fillRect(67, by, 240, 4);
        ctx.fillStyle = TEAM_COLOR[b.team]; ctx.fillRect(67, by, 240 * Math.max(0, b.hp) / b.max, 4);
        /* 受击脉冲（表现层差分） */
        if (lastBaseHp[b.team] > b.hp) { fx.push({ k: 'basehit', team: b.team, ttl: 260, max: 260 }); if (b.team === myTeam) { shakeT = Math.max(shakeT, 160); shakeAmp = 3; } }
        lastBaseHp[b.team] = b.hp;
      } else {                                          // dtower：中车道方块塔 + 血条
        ctx.fillStyle = '#2a3247'; ctx.strokeStyle = TEAM_COLOR[b.team]; ctx.lineWidth = 1.5;
        var tx = 62.5 + 125 - 14, ty = y - 14;
        ctx.fillRect(tx, ty, 28, 28); ctx.strokeRect(tx, ty, 28, 28);
        ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(tx - 4, ty - 8, 36, 4);
        ctx.fillStyle = TEAM_COLOR[b.team]; ctx.fillRect(tx - 4, ty - 8, 36 * Math.max(0, b.hp) / b.max, 4);
      }
    }
  }

  function drawTowers() {
    for (var i = 0; i < simState.towers.length; i++) {
      var tw = simState.towers[i];
      var x = 62.5 + tw.lane * 125, y = TOP_H + tw.y / 1000;
      ctx.fillStyle = '#39466a'; ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 7, y + 8); ctx.lineTo(x - 5, y - 12); ctx.lineTo(x + 5, y - 12); ctx.lineTo(x + 7, y + 8); ctx.closePath(); ctx.fill(); ctx.stroke();
      var col = tw.owner ? TEAM_COLOR[tw.owner] : '#8b93a7';
      if (tw.cap > 0 && tw.cap < 100) col = tw.capTeam ? TEAM_COLOR[tw.capTeam] : col;
      ctx.strokeStyle = col; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 15, -Math.PI / 2, -Math.PI / 2 + (tw.cap / 100) * Math.PI * 2); ctx.stroke();
      if (tw.owner) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y - 12, 3, 0, 7); ctx.fill(); }
      ctx.font = '9px ' + FONT; ctx.fillStyle = 'rgba(139,147,167,.9)'; ctx.textAlign = 'center';
      ctx.fillText(i === 0 ? 'Alpha' : 'Bravo', x, y + 20);
    }
  }

  function drawRallies() {                              // 集结旗（己方各车道，§1.4）
    if (mySeat < 0 || !simState.seats[mySeat]) return;
    var rally = simState.seats[mySeat].rally;
    for (var l = 0; l < 3; l++) {
      if (rally[l] < 0) continue;
      var x = 62.5 + l * 125 - 46, y = TOP_H + rally[l] * ROW_PX + 12;
      ctx.strokeStyle = 'rgba(232,236,243,.35)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 18, y); ctx.lineTo(x + 18, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = '#e8ecf3'; ctx.beginPath(); ctx.moveTo(x, y + 8); ctx.lineTo(x, y - 10); ctx.stroke();
      ctx.fillStyle = TEAM_COLOR[myTeam || 'A'];
      ctx.beginPath(); ctx.moveTo(x, y - 10); ctx.lineTo(x + 9, y - 7); ctx.lineTo(x, y - 4); ctx.closePath(); ctx.fill();
    }
  }

  /* 单位：俯视 2.5D 剪影（底盘阴影 + 阵营色本体 12-18px）+ 微血条 */
  function drawUnits(alpha) {
    var units = simState.units;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var py = u.y;
      if (prevY && prevY[u.id] !== undefined && alpha < 1) py = prevY[u.id] + (u.y - prevY[u.id]) * alpha;
      var x = unitX(u), y = TOP_H + py / 1000;
      var col = TEAM_COLOR[u.team];
      var sz = u.code === 'heavy' ? 16 : u.code === 'razor' ? 13 : u.code === 'arty' ? 12 : u.code === 'sniper' ? 9 : u.code === 'medic' ? 11 : 10;
      if (u.drop > 0) {                                  // 空降舱下落（15 tick 无敌）
        ctx.fillStyle = TEAM_DIM[u.team] + '.5)';
        ctx.beginPath(); ctx.arc(x, y - u.drop * 2.2, sz * .6, 0, 7); ctx.fill();
        continue;
      }
      ctx.fillStyle = 'rgba(0,0,0,.35)';                 // 底盘阴影
      ctx.beginPath(); ctx.ellipse(x, y + 3, sz * .6, sz * .28, 0, 0, 7); ctx.fill();
      ctx.fillStyle = col;
      if (u.code === 'medic') {                          // 军医：圆 + 十字
        ctx.beginPath(); ctx.arc(x, y, sz * .55, 0, 7); ctx.fill();
        ctx.fillStyle = '#0D1117'; ctx.fillRect(x - 4, y - 1.2, 8, 2.4); ctx.fillRect(x - 1.2, y - 4, 2.4, 8);
      } else if (u.code === 'razor' || u.code === 'heavy') {
        ctx.fillRect(x - sz / 2, y - sz / 3, sz, sz * .66);
        ctx.fillStyle = 'rgba(0,0,0,.3)';
        ctx.fillRect(x - sz / 2, y - sz / 6, sz, sz * .3);
        if (u.code === 'heavy') { ctx.fillStyle = col; ctx.fillRect(x - 2, y - sz / 2 - 2, 4, 5); }
      } else if (u.code === 'arty' || u.code === 'sniper') {
        ctx.beginPath(); ctx.arc(x, y, sz * .5, 0, 7); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - (u.team === 'A' ? 9 : -9)); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, sz * .5, 0, 7); ctx.fill();
      }
      if (u.seat === mySeat) { ctx.strokeStyle = 'rgba(232,236,243,.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, sz * .75 + 2, 0, 7); ctx.stroke(); }
      if (u.hp < u.maxHp) {                              // 微血条
        ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.fillRect(x - 7, y - sz * .75 - 5, 14, 2);
        ctx.fillStyle = col; ctx.fillRect(x - 7, y - sz * .75 - 5, 14 * Math.max(0, u.hp) / u.maxHp, 2);
      }
      if (u.tier > 1) { ctx.fillStyle = '#fde68a'; ctx.font = '8px ' + FONT; ctx.textAlign = 'center'; ctx.fillText('T' + u.tier, x + 9, y - 6); }
    }
  }

  function drawFx(now) {
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i];
      f.ttl -= 16;
      if (f.ttl <= 0) { fx.splice(i, 1); continue; }
      var p = f.ttl / f.max;
      if (f.k === 'ripple') {
        ctx.strokeStyle = 'rgba(232,236,243,' + (p * .6) + ')'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, (1 - p) * 26 + 4, 0, 7); ctx.stroke();
      } else if (f.k === 'door') {
        var dy = f.team === 'A' ? BOT_Y - 26 : TOP_H + 2;
        ctx.fillStyle = TEAM_DIM[f.team] + (p * .8) + ')';
        ctx.fillRect(W / 2 - 30, dy, 60, 24 * (1 - p * .5));
      } else if (f.k === 'boom') {
        var col = f.team === 'A' ? '232,163,61' : '61,200,232';
        for (var j = 0; j < 5; j++) {
          var a2 = j * 1.26 + (1 - p) * 2;
          var d = (1 - p) * 22;
          ctx.fillStyle = 'rgba(' + col + ',' + (p * .8) + ')';
          ctx.fillRect(f.x + Math.cos(a2) * d - 1.5, f.y + Math.sin(a2) * d - 1.5, 3, 3);
        }
      } else if (f.k === 'float') {
        ctx.fillStyle = f.color; ctx.globalAlpha = p; ctx.font = '700 12px ' + FONT; ctx.textAlign = 'center';
        ctx.fillText(f.txt, f.x, f.y - (1 - p) * 18); ctx.globalAlpha = 1;
      } else if (f.k === 'cast') {
        ctx.fillStyle = 'rgba(253,230,138,' + (p * .25) + ')'; ctx.fillRect(0, 0, W, H);
      } else if (f.k === 'barrage-in') {
        var bx = 62.5 + f.lane * 125, by = TOP_H + f.row * ROW_PX + 12;
        ctx.strokeStyle = 'rgba(248,113,113,' + (p * .8) + ')'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bx, by, 45 * (1 - p * .4), 0, 7); ctx.stroke();
      } else if (f.k === 'aim') {
        ctx.strokeStyle = 'rgba(248,113,113,.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, 8 + (1 - p) * 10, 0, 7); ctx.stroke();
      } else if (f.k === 'basehit') {
        var g2 = ctx.createLinearGradient(0, f.team === 'B' ? TOP_H : BOT_Y - 80, 0, f.team === 'B' ? TOP_H + 80 : BOT_Y);
        var bc = f.team === myTeam ? '232,163,61' : '61,200,232';
        g2.addColorStop(0, 'rgba(' + bc + ',0)'); g2.addColorStop(1, 'rgba(' + bc + ',' + (p * .5) + ')');
        ctx.fillStyle = g2;
        ctx.fillRect(0, f.team === 'B' ? TOP_H : BOT_Y - 80, W, 80);
      } else if (f.k === 'skillbtn') {
        var r2 = skillRect(f.id);
        ctx.strokeStyle = 'rgba(253,230,138,' + p + ')'; ctx.lineWidth = 2;
        ctx.strokeRect(r2.x - 1, r2.y - 1, r2.w + 2, r2.h + 2);
      }
    }
    /* barrage 落点爆闪（权威 shell 落弹帧）——由 events 驱动已入列 barrage-in */
  }

  function drawDragCard() {
    var spec = S.UNITS[drag.unit];
    var tier = mySeatState() ? mySeatState().tier : 1;
    var cost = spec.costs[tier - 1];
    var over = inField(drag);
    var lane = laneAt(drag.x);
    if (over) {                                          // 目标车道地面高亮呼吸
      ctx.fillStyle = 'rgba(232,236,243,.06)';
      ctx.fillRect(lane * 125, TOP_H, 125, FIELD_H);
      ctx.strokeStyle = 'rgba(232,236,243,.3)'; ctx.lineWidth = 2;
      ctx.strokeRect(lane * 125 + 3, TOP_H + 3, 119, FIELD_H - 6);
    }
    ctx.fillStyle = '#1c2333'; ctx.strokeStyle = '#e8ecf3'; ctx.lineWidth = 1.5;
    ctx.fillRect(drag.x - 24, drag.y - 30, 48, 52); ctx.strokeRect(drag.x - 24, drag.y - 30, 48, 52);
    ctx.fillStyle = '#e8ecf3'; ctx.font = '700 12px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText(UNIT_CN[drag.unit], drag.x, drag.y - 12);
    ctx.fillStyle = '#fbbf24'; ctx.font = '10px ' + FONT; ctx.fillText(cost + ' CP', drag.x, drag.y + 4);
  }

  function drawAiming() {
    ctx.fillStyle = 'rgba(248,113,113,.05)'; ctx.fillRect(0, TOP_H, W, FIELD_H);
    ctx.fillStyle = 'rgba(11,14,20,.85)'; ctx.fillRect(0, TOP_H + FIELD_H / 2 - 12, W, 22);
    ctx.fillStyle = '#f87171'; ctx.font = '12px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText(SKILL_CN[aiming] + '：点击目标车道', W / 2, TOP_H + FIELD_H / 2 + 1);
  }

  function drawSelLane() {
    if (mode === 'online' && started) return;
    ctx.strokeStyle = 'rgba(253,230,138,.4)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(selLane * 125 + 2, TOP_H + 2, 121, FIELD_H - 4);
  }

  /* 底部指挥区 107px：资源行｜6 出兵卡｜4 技能钮（§7） */
  function drawBottom(now) {
    ctx.fillStyle = 'rgba(13,17,23,.98)'; ctx.fillRect(0, BOT_Y, W, BOT_H);
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(0, BOT_Y + .5); ctx.lineTo(W, BOT_Y + .5); ctx.stroke();
    var st = mySeatState();
    var tier = st ? st.tier : 1;
    var cpShow = st ? Math.max(0, (st.cp - pendingCost) / 1000 | 0) : 0;
    var rate = st ? 2 + (simState.towers[0].owner === st.team ? 1 : 0) + (simState.towers[1].owner === st.team ? 1 : 0) : 2;
    /* 行 1：CP + 增速 | 兵力 | 研究钮 */
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fbbf24'; ctx.font = '700 16px ' + FONT; ctx.textAlign = 'left';
    ctx.fillText(String(cpShow), 10, ROW1_Y + 13);
    ctx.font = '9px ' + FONT; ctx.fillStyle = '#8b93a7';
    ctx.fillText('CP +' + rate + '/s', 10 + String(cpShow).length * 10 + 4, ROW1_Y + 15);
    var pop = st ? simState.units.filter(function (u) { return u.seat === mySeat; }).length : 0;
    ctx.fillStyle = pop >= 12 ? '#f87171' : '#8b93a7'; ctx.font = '10px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText('兵力 ' + pop + '/12', W - 120, ROW1_Y + 13);
    /* 研究钮（当前阶徽记+进度；资源不足置灰） */
    var rr = researchRect;
    var researching = st && st.research;
    var afford = st && !researching && ((tier === 1 && st.cp >= 150000) || (tier === 2 && st.cp >= 300000));
    ctx.fillStyle = researching ? 'rgba(253,230,138,.25)' : afford ? 'rgba(253,230,138,.14)' : 'rgba(255,255,255,.06)';
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
    ctx.strokeStyle = afford || researching ? '#fde68a' : 'rgba(255,255,255,.15)'; ctx.lineWidth = 1;
    ctx.strokeRect(rr.x, rr.y, rr.w, rr.h);
    ctx.fillStyle = afford || researching ? '#fde68a' : '#5b657d'; ctx.font = '9px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText(researching ? 'T' + st.research.tier + ' 研发中' : '升 T' + (tier + 1), rr.x + rr.w / 2, rr.y + rr.h / 2);
    if (researching) {
      var total = st.research.tier === 2 ? 300 : 450;
      var done = Math.min(total, total - (st.research.due - simState.tick));
      ctx.fillStyle = '#fde68a'; ctx.fillRect(rr.x, rr.y + rr.h - 3, rr.w * done / total, 3);
    }
    /* 行 2：6 出兵卡 */
    for (var i = 0; i < 6; i++) {
      var code = UNIT_ORDER[i], spec = S.UNITS[code];
      var r = cardRect(i);
      var cost = spec.costs[tier - 1];
      var usable = st && (st.cp - pendingCost) >= cost * 1000 && st.spawnCd <= 0 && pop < 12;
      ctx.fillStyle = usable ? '#1c2333' : '#141927';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = usable ? 'rgba(232,236,243,.35)' : 'rgba(232,236,243,.1)'; ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = usable ? '#e8ecf3' : '#5b657d';
      ctx.font = '700 11px ' + FONT; ctx.textAlign = 'center';
      ctx.fillText(UNIT_CN[code], r.x + r.w / 2, r.y + 13);
      ctx.font = '8px ' + FONT; ctx.fillStyle = usable ? '#fbbf24' : '#5b657d';
      ctx.fillText(cost + 'CP', r.x + r.w / 2, r.y + 25);
      ctx.fillStyle = 'rgba(139,147,167,.8)';
      ctx.fillText(COUNTER_TXT[code], r.x + r.w / 2, r.y + 36);
      if (drag && drag.unit === code) { ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 2; ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); }
    }
    /* 行 3：4 技能钮（能量环 + 冷却扇形遮罩） */
    for (var s2 = 0; s2 < 4; s2++) {
      var sk = S.SKILLS[s2];
      var sr = skillRect(s2);
      var castable = st && st.energy >= sk.cost && st.cd[s2] <= 0;
      ctx.fillStyle = castable ? '#233046' : '#141927';
      ctx.fillRect(sr.x, sr.y, sr.w, sr.h);
      /* 冷却扇形遮罩 */
      if (st && st.cd[s2] > 0) {
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.beginPath();
        ctx.moveTo(sr.x + sr.w / 2, sr.y + sr.h / 2);
        ctx.arc(sr.x + sr.w / 2, sr.y + sr.h / 2, 30, -Math.PI / 2, -Math.PI / 2 + (st.cd[s2] / sk.cd) * Math.PI * 2);
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = castable ? '#fde68a' : 'rgba(255,255,255,.15)'; ctx.lineWidth = 1;
      ctx.strokeRect(sr.x, sr.y, sr.w, sr.h);
      ctx.fillStyle = castable ? '#e8ecf3' : '#5b657d';
      ctx.font = '10px ' + FONT; ctx.textAlign = 'center';
      ctx.fillText(SKILL_CN[s2], sr.x + sr.w / 2, sr.y + 11);
      ctx.font = '8px ' + FONT; ctx.fillStyle = castable ? '#3dc8e8' : '#5b657d';
      ctx.fillText(sk.cost + '能', sr.x + sr.w / 2, sr.y + 24);
      if (aiming === s2) { ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2; ctx.strokeRect(sr.x + 1, sr.y + 1, sr.w - 2, sr.h - 2); }
    }
    /* 能量条（指挥官能量，行 1 右侧环） */
    if (st) {
      ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(W - 165, ROW1_Y + 13, 8, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#3dc8e8';
      ctx.beginPath(); ctx.arc(W - 165, ROW1_Y + 13, 8, -Math.PI / 2, -Math.PI / 2 + (st.energy / 100) * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#8b93a7'; ctx.font = '8px ' + FONT; ctx.textAlign = 'center';
      ctx.fillText(String(st.energy), W - 165, ROW1_Y + 14);
    }
  }

  /* ---------- 长按集结（≥400ms，§1.4） ---------- */
  setInterval(function () {
    if (press && !press.moved && !press.longfired && performance.now() - (press.t || 0) >= LONGPRESS_MS && started && !matchOver) {
      press.longfired = true;
      var lane = laneAt(press.x), row = rowAt(press.y);
      queueCmd({ k: 'rally', lane: lane, row: row });
      fx.push({ k: 'ripple', x: 62.5 + lane * 125, y: TOP_H + row * ROW_PX + 12, ttl: 300, max: 300 });
    }
  }, 80);

  /* ---------- 终局 ---------- */
  function finish(result) {
    if (matchOver) return;
    matchOver = true;
    var win = myTeam ? (result.winner === myTeam ? 1 : result.winner === 'draw' ? 0.5 : 0) : 0.5;
    report('levelEnd', { win: win, score: (simState.score[myTeam || 'A'] || 0), reason: result.reason });
    report('end', { win: win, score: (simState.score[myTeam || 'A'] || 0) });
    showResult(result);
  }

  function showResult(result) {
    var st = simState.seats[mySeat] || simState.seats[0];
    var title, tcol;
    if (!myTeam) { title = '对局结束'; tcol = '#e8ecf3'; }
    else if (result.winner === 'draw') { title = '平局'; tcol = '#e8ecf3'; }
    else if (result.winner === myTeam) { title = '胜利'; tcol = TEAM_COLOR[myTeam]; }
    else { title = '失败'; tcol = '#8b93a7'; }
    /* 战报：积分/击杀/出兵/最高阶 双方对照 + MVP 兵种（本场输出最高） */
    var row = function (n, a, b) { return '<div class="rrow"><span>' + n + '</span><b style="color:' + TEAM_COLOR.A + '">' + a + '</b><b style="color:' + TEAM_COLOR.B + '">' + b + '</b></div>'; };
    var mvp = { code: 'inf', dmg: -1 };
    for (var i = 0; i < simState.units.length; i++) { var u = simState.units[i]; if (u.seat === (mySeat >= 0 ? mySeat : 0) && u.atk > mvp.dmg) { mvp = { code: u.code, dmg: u.atk }; } }
    var el = document.getElementById('result');
    el.style.display = 'flex';
    el.innerHTML =
      '<div class="rbox"><div class="rtitle" style="color:' + tcol + '">' + title + '</div>' +
      '<div class="rsub">' + ({ eliminated: '基地攻防定胜负', score: '积分通道 400 分', timeout: '超时判定', abandon: '对局中断' }[result.reason] || result.reason) + '</div>' +
      '<div class="rtable">' +
      row('积分', simState.score.A, simState.score.B) +
      row('击杀', simState.kills.A, simState.kills.B) +
      row('出兵', simState.seats[0].spawned + simState.seats[2].spawned, simState.seats[1].spawned + simState.seats[3].spawned) +
      row('最高阶', 'T' + Math.max(simState.seats[0].tier, simState.seats[2].tier), 'T' + Math.max(simState.seats[1].tier, simState.seats[3].tier)) +
      '</div>' +
      '<div class="rmvp">MVP · ' + UNIT_CN[mvp.code] + '</div>' +
      '<button id="again" type="button">再来一局</button>' +
      '<button id="replay" type="button" class="ghost" disabled>战报回放（即将推出）</button>' +
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
    simState = S.create(seed, { maxTicks: opts.maxTicks });
    buildStatic();
    mySeat = 0; myTeam = 'A';
    rosterMap = { 0: { kind: 'human', name: '你' } };
    bots = {};
    for (var j = 1; j < 4; j++) bots[j] = { rng: S.mulberry32((seed ^ (j * 0x9e3779b9)) >>> 0), level: levels[j - 1] };
    beginMatch();
    if (offlineTimer) clearInterval(offlineTimer);
    offlineTimer = setInterval(function () {
      if (matchOver) { clearInterval(offlineTimer); return; }
      var inputs = {};
      inputs[0] = { cmd: cmdQueue.shift() || { k: 'noop' } };
      for (var s = 1; s < 4; s++) inputs[s] = S.brain(simState, s, bots[s].level, bots[s].rng);
      stepLocal(inputs);
    }, S.META.tickMs);
  }

  function stepLocal(inputs) {
    snapshotPrev();
    snapshotPos();
    var r = S.step(simState, inputs);
    lastTickAt = performance.now();
    pendingCost = 0;                                    // 权威帧到场，乐观扣减纠正
    applyEvents(r.events, deadPositions());
    if (r.over) { clearInterval(offlineTimer); finish(r.result); }
  }

  function beginMatch() {
    started = true; matchOver = false; lastTickAt = performance.now();
    document.getElementById('joining').style.display = 'none';
    report('start', { mode: mode, room: session ? session.roomId : 'offline' });
  }

  /* ---------- 在线（S1：服务端帧驱动本地镜像；重连=welcome 全量 state，rAF 自然追帧） ---------- */
  function startOnline(roomId) {
    mode = 'online';
    document.getElementById('joining').style.display = 'flex';
    session = G.connect({
      roomId: roomId || undefined,
      quick: !roomId,
      gameId: 'slg-battlefield',
      maxTicks: new URLSearchParams(location.search).get('maxTicks') ? Number(new URLSearchParams(location.search).get('maxTicks')) : undefined,
      onWelcome: function (m) {
        mySeat = m.seat; myTeam = m.seat >= 0 ? (m.seat % 2 === 0 ? 'A' : 'B') : null;
        simState = m.state;
        buildStatic();
        for (var i = 0; i < m.room.seats.length; i++) rosterMap[m.room.seats[i].seat] = m.room.seats[i];
        if (m.room.state === 'live') beginMatch();
        else document.getElementById('joining').textContent = '开赛中 ' + Math.ceil(m.room.countdownMs / 1000) + 's';
      },
      onStarted: function (m) {
        simState = m.state;
        buildStatic();
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
        snapshotPos();
        var r = S.step(simState, m.inputs);
        lastTickAt = performance.now();
        pendingCost = 0;                                  // 权威帧到场，乐观扣减纠正
        applyEvents(r.events, deadPositions());
        if (m.over && r.over) finish(r.result);
        if (!matchOver) session.sendInput({ cmd: cmdQueue.shift() || { k: 'noop' } });   // input delay=1
      },
      onState: function (m) { simState = m.state; buildStatic(); },
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
    setTimeout(function () {
      if (!started && session && session.status !== 'live') fallbackOffline('网关不可达，已切换离线练习');
    }, 4000);
  }

  var fellBack = false;
  function fallbackOffline(reason) {
    if (started && !matchOver) return;
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
    cmd: function (cmd) { queueCmd(cmd); },              // QA 注入通道（本地指令队列）
  };

  /* ---------- 启动 ---------- */
  fit();
  report('boot', { slug: 'slg-battlefield', version: '1.0.0', mode: 'net' });
  var q = new URLSearchParams(location.search);
  requestAnimationFrame(render);
  if (q.get('debug') === '1') startOffline({ seedSalt: q.get('again') ? String(Date.now() % 97) : '1' });
  else if (q.get('room')) startOnline(q.get('room'));
  else startOnline(null); // 快速匹配
})();
