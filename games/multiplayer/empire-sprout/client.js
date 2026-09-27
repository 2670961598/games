/* =====================================================================
 * 帝国萌芽 empire-sprout 客户端逻辑（GAMES-68）——构建期内联进 index.html。
 * 依赖前置内联：sim.cjs（window.EMPSim）+ _shared/net.js（window.GNet）。
 * 模式：
 *   online —— ?room=<id> 指定房或快速匹配；S3 双通道（§5.1）：
 *     建设=S2 快照渲染（onSnapshot 二式合并，客户端零判定）；
 *     战斗=S1 帧镜像（onFrame → battleStep 本地推进，缺帧 sync 重同步）；
 *     出征走 o 壳（建设层权威）→ 桥合成战斗帧 T+1（spawn 事件随帧到）。
 *   offline —— 网关不可达/?debug=1 离线练习（同 sim 同 brain，本地 100ms 推进）。
 * 单拇指映射（设计 §1.4）：领地表盘点选（建造/练兵/出征面板）；
 * 战场表盘长按 ≥400ms 设集结线、快出条一键出征；〔城〕⟷〔军〕切换钮。
 * 视觉（§7）：晨曦绿野×夯土城邦——建设盘 #241B12 深耕土 / 战斗盘 #14201A 暮草原；
 * 阵营 A 琥珀 #E8A33D / B 青 #3DC8E8（形状第二通道：A 椭圆底盘/B 方形、A 实心/B 分段血条）。
 * ===================================================================== */
(function () {
  'use strict';

  var S = window.EMPSim, G = window.GNet;
  var W = 375, H = 667, TOP_H = 56, BOT_H = 106, MID_H = 505;
  var ROW_PX = 25, ROWS = 20, LANES = 3;
  var TEAM_COLOR = { A: '#E8A33D', B: '#3DC8E8' };
  var RES_COLOR = { g: '#E8C46A', w: '#B08A5A', i: '#8FB8C8' };
  var RES_CN = { g: '粮', w: '木', i: '铁' };
  var BG_CITY = '#241B12', BG_WAR = '#14201A';
  var FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif";
  var UNIT_CN = { inf: '步兵', razor: '装甲', arty: '炮兵', sniper: '狙击', medic: '军医', heavy: '重坦' };
  var UNIT_CODES = ['inf', 'razor', 'arty', 'sniper', 'medic', 'heavy'];
  var LONGPRESS_MS = 400, ERUPT_AT = 1800, MARCH_CD = 200;

  var cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  var mode = 'offline', session = null, mySeat = 0, myTeam = 'A';
  var simState = null;               // 离线=本地 sim；在线=welcome/state 权威引用（battle 镜像种子）
  var battle = null, warTick = -1;   // 战斗层本地镜像 + 已应用帧号（S1）
  var snap = null;                   // 建设层快照视图（S2 二式合并：seats/teams）
  var dial = 'city';                 // 表盘：city | war
  var started = false, matchOver = false;
  var rosterMap = {};
  var bots = {}, offlineTimer = 0;
  var press = null, longfired = false;
  var panel = null;                  // {type:'build',plot}|{type:'train',kind}|{type:'attack',sel,lane}
  var trainN = 1, atkSel = null, lastAtk = null;
  var bannerTxt = '', bannerTtl = 0, eruptSeen = false;
  var fx = [], shake = 0, marchPend = null;
  var fpsV = 60, inputMaxMs = 0, lastInputAt = 0;
  var HUDF = {};                     // GAMES-57 字号自证登记表（每帧覆写；识图复检断言源）
  var qCmd = [];                     // 离线/QA 指令队列（cmd 注入通道）

  /* ---------- 上报（宿主钩子优先，本地兜底） ---------- */
  function report(event, payload) {
    try { if (window.__GAMES_HOOK__ && window.__GAMES_HOOK__.report) window.__GAMES_HOOK__.report(event, payload); } catch (e) { /* 永不抛 */ }
    if (window.__GAMES_DEBUG__) window.__GAMES_DEBUG__.events.push({ event: event, payload: payload, at: Date.now() });
  }

  function fit() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ================= 视图取数（离线=simState 直读；在线=快照合并） ================= */
  function seatView(i) {
    if (mode === 'offline') {
      var s = simState.build.seats[i];
      var pool = {}; for (var c in s.pools) pool[c] = s.pools[c].length;
      return { seat: i, res: { g: (s.res.g / 1000) | 0, w: (s.res.w / 1000) | 0, i: (s.res.i / 1000) | 0 }, plots: s.plots, queues: s.queues, pool: pool, marchCd: s.marchCd };
    }
    return snap && snap.seats[i] || null;
  }
  function teamsView() {
    if (mode === 'offline') return simState.teams;
    return snap && snap.teams || { A: { wall: 800, keep: 1200, merit: 0 }, B: { wall: 800, keep: 1200, merit: 0 } };
  }
  function tickView() { return mode === 'offline' ? simState.tick : (snap ? snap.tick : 0); }
  function poolN(seatV) { var n = 0; if (seatV) for (var c in seatV.pool) n += seatV.pool[c]; return n; }

  /* ================= 布局几何 ================= */
  var GEO = {
    plotsOwn: [], plotsAlly: [],
    poolBtn: null, qBox: null, togCity: null, togWar: null, quickBar: null,
    panelClose: null, panelCards: [], panelOk: null, panelMinus: null, panelPlus: null, panelLanes: [],
  };
  (function () {
    for (var i = 0; i < 4; i++) {
      GEO.plotsOwn.push({ x: 214 + (i % 2) * 74, y: 88 + ((i / 2) | 0) * 106, w: 66, h: 82 });
      GEO.plotsAlly.push({ x: 12 + (i % 2) * 66, y: 88 + ((i / 2) | 0) * 106, w: 58, h: 74 });
    }
    GEO.qBox = { x: 96, y: H - 78, w: 130, h: 30 };
    GEO.togCity = { x: 232, y: H - 84, w: 62, h: 38 };
    GEO.togWar = { x: 300, y: H - 84, w: 62, h: 38 };
    GEO.quickBar = { x: 12, y: H - 44, w: 150, h: 34 };
  })();

  /* ================= 渲染 ================= */
  var lastFrameT = 0, fpsAcc = 0, fpsN = 0, fpsAt = 0;
  function render(now) {
    requestAnimationFrame(render);
    if (!simState && !snap) return;
    var t0 = performance.now();
    if (lastInputAt && !inputMaxMs) inputMaxMs = Math.max(0, t0 - lastInputAt);
    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.88; if (shake < 0.4) shake = 0; }
    drawTop(now);
    if (dial === 'city') drawCity(); else drawWar(now);
    drawBottom();
    if (panel) drawPanel();
    drawFx(now);
    drawBanner(now);
    ctx.restore();
    var dt = performance.now() - t0;
    fpsAcc += dt; fpsN++;
    if (now - fpsAt > 500) { fpsV = Math.round(1000 / Math.max(0.1, fpsAcc / Math.max(1, fpsN))); fpsAt = now; fpsAcc = 0; fpsN = 0; }
  }

  function drawTop(now) {
    var me = seatView(mySeat) || seatView(0);
    ctx.fillStyle = '#1a130c'; ctx.fillRect(0, 0, W, TOP_H);
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(0, TOP_H - 1, W, 1);
    var t = tickView();
    HUDF.top = { res: 13, rate: 11, clock: 13, merit: 13 };
    if (me) {
      var xs = [12, 128, 244];
      ['g', 'w', 'i'].forEach(function (r, idx) {
        ctx.fillStyle = RES_COLOR[r]; ctx.font = '600 11px ' + FONT;
        ctx.fillText(RES_CN[r], xs[idx], 20);
        ctx.fillStyle = '#f0e8d8'; ctx.font = '600 13px ' + FONT;
        var rate = { g: 3, w: 2, i: 1 }[r] + ecoYield(me, r);
        ctx.fillText(String(me.res[r]) + '  +' + rate + '/s', xs[idx] + 14, 21);
      });
    }
    if (t < ERUPT_AT) {
      var left = Math.ceil((ERUPT_AT - t) / 10);
      ctx.fillStyle = '#e8c46a'; ctx.font = '600 13px ' + FONT; ctx.textAlign = 'center';
      ctx.fillText('军团战爆发 ' + String(Math.floor(left / 60)) + ':' + String(left % 60).padStart(2, '0'), W / 2, 43);
    } else {
      var tm = teamsView();
      ctx.font = '600 13px ' + FONT; ctx.textAlign = 'center';
      ctx.fillStyle = TEAM_COLOR.A; ctx.fillText('战功 ' + tm.A.merit, W / 2 - 55, 43);
      ctx.fillStyle = '#8b93a7'; ctx.fillText(':', W / 2, 43);
      ctx.fillStyle = TEAM_COLOR.B; ctx.fillText(String(tm.B.merit), W / 2 + 32, 43);
      ctx.fillStyle = '#8b93a7'; ctx.font = '11px ' + FONT;
      ctx.fillText(Math.floor(t / 600) + ':' + String(Math.floor(t / 10) % 60).padStart(2, '0'), W - 30, 21);
    }
    ctx.textAlign = 'left';
  }
  function ecoYield(me, r) {  // 建筑产出率（快照 plots 求和）
    var y = { farm: { 1: 4, 2: 9, 3: 15 }, lumber: { 1: 3, 2: 7, 3: 12 }, mine: { 1: 2, 2: 5, 3: 9 } };
    var n = 0; if (me && me.plots) for (var i = 0; i < me.plots.length; i++) { var p = me.plots[i]; if (p && y[p.kind]) n += y[p.kind][p.lv] || 0; }
    return n;
  }

  /* ---------- 领地表盘（§2.1） ---------- */
  function drawCity() {
    ctx.fillStyle = BG_CITY; ctx.fillRect(0, TOP_H, W, MID_H);
    ctx.strokeStyle = 'rgba(232,196,106,.05)'; ctx.lineWidth = 1;
    for (var gx = 0; gx < W; gx += 25) { ctx.beginPath(); ctx.moveTo(gx, TOP_H); ctx.lineTo(gx, TOP_H + MID_H); ctx.stroke(); }
    for (var gy = TOP_H; gy < TOP_H + MID_H; gy += 25) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    HUDF.city = { bname: 11, blv: 11, hplabel: 11, hp: 13, ally: 9 };
    var allySeat = mySeat ^ 2;
    var av = seatView(allySeat);
    ctx.fillStyle = '#8b93a7'; ctx.font = '9px ' + FONT;
    ctx.fillText('盟友领地（' + ((rosterMap[allySeat] && rosterMap[allySeat].name) || 'Bot') + '）', 12, TOP_H + 14);
    for (var i = 0; i < 4; i++) {
      var r = GEO.plotsAlly[i], p = av && av.plots && av.plots[i];
      ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(r.x, r.y, r.w, r.h);
      if (p) { ctx.fillStyle = 'rgba(176,138,90,.35)'; ctx.fillRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8); ctx.fillStyle = '#a89a80'; ctx.font = '9px ' + FONT; ctx.fillText(S.BUILDS[p.kind].cn + ' Lv' + p.lv, r.x + 6, r.y + 16); }
    }
    var me = seatView(mySeat);
    ctx.fillStyle = '#e8c46a'; ctx.font = '11px ' + FONT;
    ctx.fillText('己方建筑位（6 选 4）', 214, TOP_H + 14);
    for (var j = 0; j < 4; j++) {
      var rr = GEO.plotsOwn[j], pp = me && me.plots && me.plots[j];
      ctx.fillStyle = 'rgba(232,196,106,.08)'; ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
      ctx.strokeStyle = pp ? 'rgba(232,196,106,.5)' : 'rgba(232,196,106,.25)';
      ctx.setLineDash(pp ? [] : [4, 3]); ctx.strokeRect(rr.x + .5, rr.y + .5, rr.w - 1, rr.h - 1); ctx.setLineDash([]);
      if (pp) {
        ctx.fillStyle = 'rgba(176,138,90,.5)'; ctx.fillRect(rr.x + 5, rr.y + 5, rr.w - 10, rr.h - 10);
        ctx.fillStyle = '#e8dcc8'; ctx.font = '600 11px ' + FONT;
        ctx.fillText(S.BUILDS[pp.kind].cn, rr.x + 8, rr.y + 22);
        ctx.fillStyle = '#e8c46a'; ctx.font = '600 11px ' + FONT;
        ctx.fillText('Lv' + pp.lv, rr.x + 8, rr.y + 38);
        if (pp.lv < 3) { ctx.fillStyle = '#8b93a7'; ctx.font = '9px ' + FONT; ctx.fillText('可升级', rr.x + 8, rr.y + 54); }
      } else {
        ctx.fillStyle = '#6b6252'; ctx.font = '11px ' + FONT; ctx.fillText('+ 建造', rr.x + 8, rr.y + 22);
      }
    }
    /* 联盟城心/城墙 HP 镜像（战斗层只读投影，§5.4） */
    var tm = teamsView();
    drawHpMirror(W / 2 - 34, TOP_H + 96, tm[myTeam], '城心', 1200);
    drawHpMirror(W / 2 - 34, TOP_H + 150, { hp: tm[myTeam].wall, kind: 'wall' }, '城墙', 800);
    /* 队列进度 */
    var q = me && me.queues && me.queues[0];
    if (q) {
      ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(120, TOP_H + 230, 135, 46);
      ctx.fillStyle = '#d8ccb8'; ctx.font = '9px ' + FONT;
      ctx.fillText(S.BUILDS[q.kind].cn + ' · ' + UNIT_CN[q.unit] + ' ×' + q.n, 126, TOP_H + 244);
      var prog = mode === 'offline' ? q.prog / S.consts.TRAIN_TICKS[(q.tier || 1) - 1] : 0.5;
      ctx.fillStyle = 'rgba(232,196,106,.25)'; ctx.fillRect(126, TOP_H + 252, 123, 6);
      ctx.fillStyle = '#e8c46a'; ctx.fillRect(126, TOP_H + 252, 123 * Math.min(1, prog), 6);
    }
  }
  function drawHpMirror(x, y, o, label, max) {
    var hp = o.kind === 'wall' ? o.hp : o.keep;
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(x, y, 68, 40);
    ctx.fillStyle = '#8b93a7'; ctx.font = '11px ' + FONT; ctx.fillText(label, x + 6, y + 14);
    ctx.fillStyle = '#f0e8d8'; ctx.font = '600 13px ' + FONT; ctx.fillText(String(hp), x + 6, y + 32);
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x + 6, y + 34, 56, 3);
    ctx.fillStyle = TEAM_COLOR[myTeam]; ctx.fillRect(x + 6, y + 34, 56 * Math.max(0, hp) / max, 3);
  }

  /* ---------- 战场表盘（slg 车道制同款骨架，§2.1） ---------- */
  function fieldY(rowM) { return TOP_H + rowM / 1000 / ROW_PX * ROW_PX; }
  function laneX(lane, off) { return 12 + lane * 117 + (off || 0); }
  function drawWar(now) {
    ctx.fillStyle = BG_WAR; ctx.fillRect(0, TOP_H, W, MID_H);
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    for (var l = 0; l <= 3; l++) { ctx.beginPath(); ctx.moveTo(12 + l * 117, TOP_H); ctx.lineTo(12 + l * 117, TOP_H + 505); ctx.stroke(); }
    for (var rgy = 0; rgy <= 20; rgy++) { ctx.beginPath(); ctx.moveTo(12, TOP_H + rgy * 25.25); ctx.lineTo(363, TOP_H + rgy * 25.25); ctx.stroke(); }
    HUDF.war = { hp: 13, lane: 9, unitTier: 9, cd: 13, poolWar: 13 };
    var tm = teamsView();
    /* B 墙/心（上） */
    drawSideBars(TOP_H + 4, 'B', tm.B, true);
    /* A 墙/心（下） */
    drawSideBars(TOP_H + 468, 'A', tm.A, false);
    if (!battle) return;
    /* 墙体（裂纹三档）+ 城心 */
    for (var i = 0; i < battle.bld.length; i++) {
      var b = battle.bld[i];
      var y = TOP_H + (b.y / 25000 + 0.5) * 25.25;
      if (b.kind === 'wall') {
        ctx.fillStyle = b.team === 'A' ? 'rgba(232,163,61,.35)' : 'rgba(61,200,232,.35)';
        ctx.fillRect(12, y - 3, 351, 6);
        var crack = b.hp > b.max * 0.75 ? 0 : b.hp > b.max * 0.5 ? 1 : b.hp > b.max * 0.25 ? 2 : 3;
        if (crack) { ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.beginPath(); for (var s2 = 0; s2 < crack * 3; s2++) { var cx2 = 20 + s2 * 40; ctx.moveTo(cx2, y - 3); ctx.lineTo(cx2 + 6, y + 3); } ctx.stroke(); }
      } else {
        ctx.fillStyle = b.team === 'A' ? 'rgba(232,163,61,.6)' : 'rgba(61,200,232,.6)';
        ctx.fillRect(W / 2 - 28, y - 8, 56, 16);
        ctx.fillStyle = '#0b0e14'; ctx.font = '600 9px ' + FONT; ctx.textAlign = 'center';
        ctx.fillText('城心', W / 2, y + 3); ctx.textAlign = 'left';
      }
    }
    /* 单位（A 椭圆底盘/B 方形；己方白圈） */
    var us = battle.units;
    for (var u = 0; u < us.length; u++) {
      var un = us[u];
      var x = laneX(un.lane, ((un.id * 37) % 40) - 14), y = TOP_H + (un.y / 25000 + 0.5) * 25.25;
      var col = TEAM_COLOR[un.team];
      ctx.fillStyle = un.code === 'medic' ? '#d8e8d0' : col;
      if (un.team === 'A') { ctx.beginPath(); ctx.ellipse(x, y, 7, 5, 0, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(x - 6, y - 5, 12, 10);
      if (un.seat === mySeat) { ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = '600 9px ' + FONT; ctx.fillText('T' + un.tier, x + 6, y - 5);
      /* 血条：A 实心 / B 分段 */
      var w = 14 * un.hp / un.maxHp;
      if (un.team === 'A') { ctx.fillStyle = col; ctx.fillRect(x - 7, y - 9, w, 2); }
      else { ctx.fillStyle = col; for (var sg = 0; sg < 4; sg++) { if (w > sg * 3.5) ctx.fillRect(x - 7 + sg * 4, y - 9, 2.5, 2); } }
    }
    /* 集结旗（阵营色形状双编码：A 三角旗/B 燕尾旗） */
    var myRally = battle.rally[mySeat] || [-1, -1, -1];
    for (var ln = 0; ln < 3; ln++) {
      var rrow = myRally[ln];
      if (rrow < 0) continue;
      var rx = laneX(ln, 40), ry = TOP_H + (rrow + 0.5) * 25.25;
      ctx.strokeStyle = TEAM_COLOR[myTeam]; ctx.beginPath(); ctx.moveTo(rx, ry - 10); ctx.lineTo(rx, ry + 8); ctx.stroke();
      ctx.fillStyle = TEAM_COLOR[myTeam];
      if (myTeam === 'A') { ctx.beginPath(); ctx.moveTo(rx, ry - 10); ctx.lineTo(rx + 9, ry - 6); ctx.lineTo(rx, ry - 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(rx, ry - 10); ctx.lineTo(rx + 8, ry - 7); ctx.lineTo(rx + 5, ry - 5); ctx.lineTo(rx + 8, ry - 3); ctx.lineTo(rx, ry); ctx.fill(); }
    }
    /* 出征 CD 环 */
    var me = seatView(mySeat);
    if (me && me.marchCd > 0) {
      ctx.strokeStyle = 'rgba(232,196,106,.7)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(W - 26, TOP_H + 462, 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - me.marchCd / MARCH_CD)); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = '#e8c46a'; ctx.font = '600 13px ' + FONT; ctx.fillText(String(Math.ceil(me.marchCd / 10)), W - 32, TOP_H + 467);
    }
  }
  function drawSideBars(y, team, o, top) {
    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(12, y, 351, 30);
    ctx.fillStyle = TEAM_COLOR[team]; ctx.font = '600 13px ' + FONT;
    ctx.fillText(team + ' 心 ' + o.keep, 20, y + 20);
    ctx.fillText('墙 ' + o.wall, 130, y + 20);
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(190, y + 8, 160, 5);
    ctx.fillStyle = TEAM_COLOR[team]; ctx.fillRect(190, y + 8, 160 * Math.max(0, o.wall) / 800, 5);
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(190, y + 18, 160, 5);
    ctx.fillStyle = TEAM_COLOR[team]; ctx.fillRect(190, y + 18, 160 * Math.max(0, o.keep) / 1200, 5);
  }

  /* ---------- 底栏（§2.1：兵池徽标/队列/〔城〕⟷〔军〕） ---------- */
  function drawBottom() {
    ctx.fillStyle = '#171009'; ctx.fillRect(0, H - BOT_H, W, BOT_H);
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(0, H - BOT_H, W, 1);
    HUDF.bottom = { pool: 16, q: 9, tog: 13, quick: 11 };
    var me = seatView(mySeat);
    var pn = poolN(me);
    /* 兵池徽标（tap → 出征面板） */
    ctx.fillStyle = pn > 0 ? 'rgba(232,163,61,.25)' : 'rgba(255,255,255,.05)';
    ctx.fillRect(12, H - 78, 72, 34);
    ctx.strokeStyle = 'rgba(232,163,61,.6)'; ctx.strokeRect(12.5, H - 77.5, 71, 33);
    ctx.fillStyle = '#e8dcc8'; ctx.font = '600 16px ' + FONT;
    ctx.fillText(String(pn), 22, H - 55);
    ctx.fillStyle = '#8b93a7'; ctx.font = '11px ' + FONT; ctx.fillText('/12 兵池', 44, H - 55);
    /* 队列摘要 */
    var q = me && me.queues && me.queues[0];
    ctx.fillStyle = '#8b93a7'; ctx.font = '9px ' + FONT;
    ctx.fillText(q ? '练兵中 ' + UNIT_CN[q.unit] + '×' + q.n : '队列空闲', 96, H - 58);
    /* 快出条（战场表盘：一键复用上次编队） */
    if (dial === 'war') {
      ctx.fillStyle = lastAtk ? 'rgba(232,196,106,.3)' : 'rgba(255,255,255,.05)';
      ctx.fillRect(GEO.quickBar.x, GEO.quickBar.y, GEO.quickBar.w, GEO.quickBar.h);
      ctx.fillStyle = lastAtk ? '#e8c46a' : '#6b6252'; ctx.font = '600 11px ' + FONT;
      ctx.fillText('快出 · 上次编队', GEO.quickBar.x + 10, GEO.quickBar.y + 21);
    }
    /* 切换钮（当前盘高亮） */
    drawTog(GEO.togCity, '〔城〕', dial === 'city');
    drawTog(GEO.togWar, '〔军〕', dial === 'war', tickView() >= ERUPT_AT);
  }
  function drawTog(r, txt, on, warn) {
    ctx.fillStyle = on ? 'rgba(232,196,106,.35)' : 'rgba(255,255,255,.05)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = on ? '#e8c46a' : 'rgba(255,255,255,.15)'; ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    ctx.fillStyle = on ? '#f0e8d8' : '#8b93a7'; ctx.font = '600 13px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText(txt, r.x + r.w / 2, r.y + 24);
    if (warn && !on) { ctx.fillStyle = '#e8a33d'; ctx.beginPath(); ctx.arc(r.x + r.w - 8, r.y + 8, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.textAlign = 'left';
  }

  /* ---------- 面板（建造 6 卡/升级/练兵/出征，P1 ≥11px） ---------- */
  function drawPanel() {
    ctx.fillStyle = 'rgba(10,7,4,.82)'; ctx.fillRect(0, TOP_H, W, MID_H);
    HUDF.panel = { title: 13, name: 11, cost: 11, desc: 9, btn: 13, n: 13 };
    ctx.textAlign = 'center';
    if (panel.type === 'build' || panel.type === 'upgrade') {
      var me = seatView(mySeat);
      var cur = me.plots[panel.plot];
      ctx.fillStyle = '#e8dcc8'; ctx.font = '600 13px ' + FONT;
      ctx.fillText(panel.type === 'build' ? '建造（同类至多 1 座）' : '升级 ' + S.BUILDS[cur.kind].cn + ' → Lv' + (cur.lv + 1), W / 2, TOP_H + 34);
      var kinds = panel.type === 'build' ? ['farm', 'lumber', 'mine', 'camp', 'works', 'range'] : [cur.kind];
      for (var i = 0; i < kinds.length; i++) {
        var k = kinds[i], x = 18 + (i % 3) * 118, y = TOP_H + 56 + ((i / 3) | 0) * 128;
        var lv = panel.type === 'build' ? 0 : cur.lv;
        var cost = S.BUILDS[k].cost[Math.min(2, lv)];
        var afford = true; for (var r in cost) if (me.res[r] < cost[r] / 1000) afford = false;
        ctx.fillStyle = afford ? 'rgba(232,196,106,.12)' : 'rgba(255,255,255,.04)';
        ctx.fillRect(x, y, 106, 112);
        ctx.strokeStyle = afford ? 'rgba(232,196,106,.4)' : 'rgba(255,255,255,.1)'; ctx.strokeRect(x + .5, y + .5, 105, 111);
        ctx.fillStyle = '#e8dcc8'; ctx.font = '600 11px ' + FONT;
        ctx.fillText(S.BUILDS[k].cn + (panel.type === 'build' ? '' : ' Lv' + (cur.lv + 1)), x + 53, y + 22);
        ctx.fillStyle = afford ? '#e8c46a' : '#a05a4a'; ctx.font = '11px ' + FONT;
        ctx.fillText(Object.keys(cost).map(function (r) { return RES_CN[r] + cost[r] / 1000; }).join(' '), x + 53, y + 44);
        ctx.fillStyle = '#8b93a7'; ctx.font = '9px ' + FONT;
        var desc = S.BUILDS[k].yield ? '产出 ' + Object.keys(S.BUILDS[k].yield[0]).map(function (r) { return RES_CN[r] + '+' + (S.BUILDS[k].yield[0][r] / 100); }).join(' ') + '/s' : '兵池 ' + S.BUILDS[k].pool.map(function (u) { return UNIT_CN[u]; }).join('/');
        ctx.fillText(desc, x + 53, y + 64);
        ctx.fillStyle = '#f0e8d8'; ctx.font = '600 11px ' + FONT;
        ctx.fillText(afford ? '建造' : '资源不足', x + 53, y + 96);
        GEO.panelCards[i] = { x: x, y: y, w: 106, h: 112, kind: k, afford: afford };
      }
    } else if (panel.type === 'train') {
      var me2 = seatView(mySeat);
      var camp = me2.plots[panel.plot];
      ctx.fillStyle = '#e8dcc8'; ctx.font = '600 13px ' + FONT;
      ctx.fillText(S.BUILDS[panel.kind].cn + ' Lv' + camp.lv + '（T' + camp.lv + ' 档）', W / 2, TOP_H + 34);
      var pool2 = S.BUILDS[panel.kind].pool;
      for (var i2 = 0; i2 < pool2.length; i2++) {
        var u2 = pool2[i2], x2 = 40 + i2 * 150, y2 = TOP_H + 60;
        var c2 = S.UNITS[u2].cost[camp.lv - 1];
        var afford2 = me2.res.g >= c2[0] && me2.res.i >= c2[1];
        ctx.fillStyle = atkSel === u2 || (atkSel === null && i2 === 0) ? 'rgba(232,196,106,.18)' : 'rgba(255,255,255,.05)';
        ctx.fillRect(x2, y2, 130, 120);
        ctx.strokeStyle = 'rgba(232,196,106,.35)'; ctx.strokeRect(x2 + .5, y2 + .5, 129, 119);
        ctx.fillStyle = '#e8dcc8'; ctx.font = '600 11px ' + FONT; ctx.fillText(UNIT_CN[u2], x2 + 65, y2 + 24);
        ctx.fillStyle = afford2 ? '#e8c46a' : '#a05a4a'; ctx.font = '11px ' + FONT;
        ctx.fillText('粮' + c2[0] + (c2[1] ? ' 铁' + c2[1] : ''), x2 + 65, y2 + 46);
        ctx.fillStyle = '#8b93a7'; ctx.font = '9px ' + FONT;
        ctx.fillText('HP' + S.UNITS[u2].hp[camp.lv - 1] + ' 攻' + S.UNITS[u2].atk[camp.lv - 1], x2 + 65, y2 + 64);
        ctx.fillText('T' + camp.lv + ' · ' + S.consts.TRAIN_TICKS[camp.lv - 1] / 10 + 's/个', x2 + 65, y2 + 80);
        GEO.panelCards[i2] = { x: x2, y: y2, w: 130, h: 120, unit: u2, afford: afford2 };
      }
      /* 步进 1-5 */
      ctx.fillStyle = '#f0e8d8'; ctx.font = '600 13px ' + FONT;
      ctx.fillText('×' + trainN, W / 2, TOP_H + 230);
      GEO.panelMinus = { x: W / 2 - 60, y: TOP_H + 208, w: 40, h: 34 };
      GEO.panelPlus = { x: W / 2 + 20, y: TOP_H + 208, w: 40, h: 34 };
      ctx.strokeStyle = 'rgba(232,196,106,.5)';
      ctx.strokeRect(GEO.panelMinus.x, GEO.panelMinus.y, 40, 34); ctx.fillText('−', GEO.panelMinus.x + 20, TOP_H + 231);
      ctx.strokeRect(GEO.panelPlus.x, GEO.panelPlus.y, 40, 34); ctx.fillText('+', GEO.panelPlus.x + 20, TOP_H + 231);
    } else if (panel.type === 'attack') {
      var me3 = seatView(mySeat);
      ctx.fillStyle = '#e8dcc8'; ctx.font = '600 13px ' + FONT;
      ctx.fillText('出征编队（整池 ≤12 · CD ' + MARCH_CD / 10 + 's）', W / 2, TOP_H + 34);
      var codes = UNIT_CODES.filter(function (c) { return me3.pool[c] > 0; });
      if (!codes.length) { ctx.fillStyle = '#8b93a7'; ctx.font = '11px ' + FONT; ctx.fillText('兵池为空——先练兵', W / 2, TOP_H + 80); }
      for (var i3 = 0; i3 < codes.length; i3++) {
        var u3 = codes[i3], x3 = 18 + (i3 % 3) * 118, y3 = TOP_H + 56 + ((i3 / 3) | 0) * 74;
        var have = me3.pool[u3], want = panel.sel[u3] || 0;
        ctx.fillStyle = 'rgba(232,196,106,' + (want ? 0.25 : 0.08) + ')';
        ctx.fillRect(x3, y3, 106, 62);
        ctx.strokeStyle = want ? '#e8c46a' : 'rgba(255,255,255,.15)'; ctx.strokeRect(x3 + .5, y3 + .5, 105, 61);
        ctx.fillStyle = '#e8dcc8'; ctx.font = '600 11px ' + FONT; ctx.fillText(UNIT_CN[u3] + ' ' + want + '/' + have, x3 + 53, y3 + 26);
        ctx.fillStyle = '#8b93a7'; ctx.font = '9px ' + FONT; ctx.fillText('tap +1 / 长按清零', x3 + 53, y3 + 46);
        GEO.panelCards[i3] = { x: x3, y: y3, w: 106, h: 62, atkUnit: u3 };
      }
      /* 车道三分选 */
      ctx.fillStyle = '#8b93a7'; ctx.font = '11px ' + FONT; ctx.fillText('选择车道', W / 2, TOP_H + 216);
      for (var l3 = 0; l3 < 3; l3++) {
        var xl = 68 + l3 * 90;
        ctx.fillStyle = panel.lane === l3 ? 'rgba(232,163,61,.35)' : 'rgba(255,255,255,.06)';
        ctx.fillRect(xl, TOP_H + 226, 78, 40);
        ctx.strokeStyle = panel.lane === l3 ? '#e8a33d' : 'rgba(255,255,255,.15)'; ctx.strokeRect(xl + .5, TOP_H + 226.5, 77, 39);
        ctx.fillStyle = '#f0e8d8'; ctx.font = '600 13px ' + FONT; ctx.fillText('车道 ' + l3, xl + 39, TOP_H + 251);
        GEO.panelLanes[l3] = { x: xl, y: TOP_H + 226, w: 78, h: 40, lane: l3 };
      }
    }
    /* 确认/关闭 */
    if (panel.type !== 'upgrade') {
      GEO.panelOk = { x: W / 2 - 50, y: TOP_H + 282, w: 100, h: 42 };
      ctx.fillStyle = 'rgba(232,196,106,.35)'; ctx.fillRect(GEO.panelOk.x, GEO.panelOk.y, 100, 42);
      ctx.fillStyle = '#f0e8d8'; ctx.font = '600 13px ' + FONT;
      ctx.fillText(panel.type === 'build' ? '建 造' : panel.type === 'train' ? '入 队' : '出 征', W / 2, GEO.panelOk.y + 27);
    }
    GEO.panelClose = { x: W - 46, y: TOP_H + 10, w: 36, h: 30 };
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(GEO.panelClose.x, GEO.panelClose.y, 36, 30);
    ctx.fillStyle = '#8b93a7'; ctx.font = '600 13px ' + FONT; ctx.fillText('×', W - 28, TOP_H + 31);
    ctx.textAlign = 'left';
  }

  /* ---------- 特效/横幅 ---------- */
  function drawFx(now) {
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i];
      var p = (now - f.t0) / f.dur;
      if (p >= 1) { fx.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - p;
      if (f.k === 'ring') { ctx.strokeStyle = f.col; ctx.beginPath(); ctx.arc(f.x, f.y, 6 + p * 22, 0, Math.PI * 2); ctx.stroke(); }
      else if (f.k === 'txt') { ctx.fillStyle = f.col; ctx.font = '600 13px ' + FONT; ctx.fillText(f.txt, f.x, f.y - p * 24); }
      ctx.globalAlpha = 1;
    }
  }
  function drawBanner(now) {
    if (bannerTtl <= 0) return;
    bannerTtl -= 16;
    var a = Math.min(1, bannerTtl / 300);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(20,12,4,.85)'; ctx.fillRect(0, TOP_H + 170, W, 64);
    ctx.fillStyle = '#e8a33d'; ctx.font = '700 20px ' + FONT; ctx.textAlign = 'center';
    ctx.fillText(bannerTxt, W / 2, TOP_H + 210);
    ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  }

  /* ================= 事件应用（战斗帧/快照 events → 表现） ================= */
  function applyBattleEvents(evs) {
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.k === 'erupt') {
        eruptSeen = true; dial = 'war';
        bannerTxt = '⚔ 军团战爆发！'; bannerTtl = 2000; shake = 5;
      } else if (e.k === 'spawn' && e.seat === mySeat) {
        fx.push({ k: 'ring', x: laneX(e.lane, 20), y: TOP_H + (e.row + 0.5) * 25.25, col: TEAM_COLOR[myTeam], t0: performance.now(), dur: 500 });
      } else if (e.k === 'walldown') { shake = 5; bannerTxt = (e.team === myTeam ? '我方城墙被破！' : '敌方城墙被破！'); bannerTtl = 1400; }
      else if (e.k === 'keepdown') { shake = 6; }
    }
  }
  function applyBuildEvents(evs) {
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.seat !== mySeat) continue;
      if (e.k === 'built') { banner(e.kind ? S.BUILDS[e.kind].cn + (e.lv > 1 ? ' 升级 Lv' + e.lv : ' 建成') : ''); fx.push({ k: 'txt', txt: '建成', x: 250, y: TOP_H + 200, col: '#e8c46a', t0: performance.now(), dur: 800 }); }
      else if (e.k === 'march') { banner('军团出征 · 车道' + e.lane); }
      else if (e.k === 'reject') { banner('✕ ' + ({ resw: '木材不足', resi: '铁不足', resg: '粮食不足', 'queue-full': '队列已满', 'pool-full': '兵池已满', cd: '出征冷却中', peace: '和平期不可出征', 'no-camp': '先建兵营', 'dup-kind': '同类已建', 'max-lv': '已满级', 'kind-mismatch': '类型不符', 'not-in-pool': '该营不可练此兵', pool: '兵池不足', 'bad-units': '编队无效' }[e.why] || e.why)); }
      else if (e.k === 'train-q') { fx.push({ k: 'txt', txt: '入队 ×' + e.n, x: 160, y: TOP_H + 250, col: '#e8c46a', t0: performance.now(), dur: 700 }); }
    }
  }
  function banner(txt) { if (txt) { bannerTxt = txt; bannerTtl = 1300; } }

  /* ================= 输入 ================= */
  function inR(r, x, y) { return r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
  function sendO(op) {
    lastInputAt = performance.now(); inputMaxMs = 0;
    if (mode === 'online') session.sendInput({ o: op });
    else qCmd.push({ o: op });
  }
  function sendC(cmd) {
    lastInputAt = performance.now(); inputMaxMs = 0;
    if (mode === 'online') session.sendInput({ c: cmd });
    else qCmd.push({ c: cmd });
  }

  cv.addEventListener('pointerdown', function (ev) {
    var pt = ev.touches ? ev.touches[0] : ev;
    var x = pt.pageX - cv.offsetLeft, y = pt.pageY - cv.offsetTop;
    press = { x: x, y: y, t: performance.now(), moved: false };
    longfired = false;
  });
  cv.addEventListener('pointermove', function (ev) {
    if (!press) return;
    var pt = ev.touches ? ev.touches[0] : ev;
    var x = pt.pageX - cv.offsetLeft, y = pt.pageY - cv.offsetTop;
    if (Math.abs(x - press.x) > 12 || Math.abs(y - press.y) > 12) press.moved = true;
  });
  cv.addEventListener('pointerup', function (ev) {
    if (!press || press.moved || longfired) { press = null; return; }
    var x = press.x, y = press.y;
    press = null;
    if (matchOver || !started) return;
    onTap(x, y);
  });
  cv.addEventListener('pointerleave', function () { press = null; });
  setInterval(function () {   /* 长按检测（战场表盘 rally，≥400ms） */
    if (press && !press.moved && !longfired && performance.now() - press.t >= LONGPRESS_MS) {
      if (dial === 'war' && yInField(press.y) && started && !matchOver) {
        longfired = true;
        var lane = Math.max(0, Math.min(2, ((press.x - 12) / 117) | 0));
        var row = Math.max(0, Math.min(19, ((press.y - TOP_H) / 25.25) | 0));
        sendC({ k: 'rally', lane: lane, row: row });
        fx.push({ k: 'ring', x: press.x, y: press.y, col: TEAM_COLOR[myTeam], t0: performance.now(), dur: 600 });
      }
    }
  }, 60);
  function yInField(y) { return y > TOP_H + 34 && y < TOP_H + 465; }

  function onTap(x, y) {
    /* 面板打开时独占 */
    if (panel) { panelTap(x, y); return; }
    if (inR(GEO.togCity, x, y)) { dial = 'city'; return; }
    if (inR(GEO.togWar, x, y)) { dial = 'war'; return; }
    if (dial === 'city') {
      var meV = seatView(mySeat);
      if (!meV) return;                                    // 旁观席无领地操作
      for (var i = 0; i < 4; i++) {
        if (!inR(GEO.plotsOwn[i], x, y)) continue;
        var me = meV, p = me.plots[i];
        if (p && p.kind === 'lumber' || p && (p.kind === 'farm' || p.kind === 'mine') || p) {
          if (['camp', 'works', 'range'].indexOf(p.kind) >= 0) { panel = { type: 'train', plot: i, kind: p.kind }; atkSel = null; trainN = 1; }
          else panel = { type: 'upgrade', plot: i };
        } else panel = { type: 'build', plot: i };
        return;
      }
      /* 兵池徽标 → 出征面板 */
      if (x >= 12 && x < 84 && y >= H - 78 && y < H - 44) {
        var me2 = meV, sel = {};
        for (var c in me2.pool) if (me2.pool[c] > 0) sel[c] = me2.pool[c];
        panel = { type: 'attack', sel: sel, lane: 1 };
        return;
      }
    } else {
      /* 快出条：复用上次编队（不足按比例裁） */
      if (inR(GEO.quickBar, x, y) && lastAtk) {
        var me3 = seatView(mySeat), units = {};
        for (var u in lastAtk) units[u] = Math.min(lastAtk[u], me3.pool[u] || 0);
        var tot = 0; for (var u2 in units) tot += units[u2];
        if (tot > 0) sendO({ k: 'attack', lane: lastAtk.lane != null ? lastAtk.lane : 1, units: units });
        return;
      }
    }
  }
  function panelTap(x, y) {
    if (inR(GEO.panelClose, x, y)) { panel = null; return; }
    var me = seatView(mySeat);
    if (panel.type === 'build') {
      for (var i = 0; i < GEO.panelCards.length; i++) {
        var cd = GEO.panelCards[i];
        if (cd && inR(cd, x, y) && cd.afford) { sendO({ k: 'build', plot: panel.plot, kind: cd.kind }); panel = null; return; }
      }
      if (inR(GEO.panelOk, x, y) && GEO.panelCards.length === 1) { sendO({ k: 'build', plot: panel.plot, kind: GEO.panelCards[0].kind }); panel = null; }
    } else if (panel.type === 'upgrade') {
      for (var j = 0; j < GEO.panelCards.length; j++) {
        var cd2 = GEO.panelCards[j];
        if (cd2 && inR(cd2, x, y) && cd2.afford) { sendO({ k: 'build', plot: panel.plot, kind: cd2.kind }); panel = null; return; }
      }
    } else if (panel.type === 'train') {
      for (var k = 0; k < GEO.panelCards.length; k++) {
        var cd3 = GEO.panelCards[k];
        if (cd3 && inR(cd3, x, y)) { atkSel = cd3.unit; return; }
      }
      if (inR(GEO.panelMinus, x, y)) { trainN = Math.max(1, trainN - 1); return; }
      if (inR(GEO.panelPlus, x, y)) { trainN = Math.min(5, trainN + 1); return; }
      if (inR(GEO.panelOk, x, y) && atkSel) { sendO({ k: 'train', kind: panel.kind, unit: atkSel, n: trainN }); panel = null; }
    } else if (panel.type === 'attack') {
      for (var m = 0; m < GEO.panelCards.length; m++) {
        var cd4 = GEO.panelCards[m];
        if (cd4 && inR(cd4, x, y)) {
          var key = cd4.atkUnit, have = me.pool[key] || 0, cur = panel.sel[key] || 0;
          panel.sel[key] = cur >= have ? 0 : cur + 1;
          return;
        }
      }
      for (var l = 0; l < 3; l++) if (inR(GEO.panelLanes[l], x, y)) { panel.lane = GEO.panelLanes[l].lane; return; }
      if (inR(GEO.panelOk, x, y)) {
        var units = {}, tot = 0;
        for (var c2 in panel.sel) if (panel.sel[c2] > 0 && (me.pool[c2] || 0) >= panel.sel[c2]) { units[c2] = panel.sel[c2]; tot += panel.sel[c2]; }
        if (tot > 0) { lastAtk = { lane: panel.lane }; for (var c3 in units) lastAtk[c3] = units[c3]; sendO({ k: 'attack', lane: panel.lane, units: units }); }
        panel = null;
      }
    }
  }

  /* ================= 离线练习（?debug=1 / 网关不可达降级；同 sim 同 brain） ================= */
  function startOffline(opts) {
    opts = opts || {};
    mode = 'offline';
    var seed = S.fnv1a32('offline-' + (opts.seedSalt || '0'));
    var levels = opts.bots || ['balanced', 'casual', 'balanced'];
    simState = S.create(seed, { maxTicks: opts.maxTicks });
    mySeat = 0; myTeam = 'A';
    rosterMap = { 0: { kind: 'human', name: '你' } };
    bots = {};
    for (var j = 1; j < 4; j++) bots[j] = { rng: S.mulberry32((seed ^ (j * 0x9e3779b9)) >>> 0), level: levels[j - 1] };
    battle = JSON.parse(JSON.stringify(simState.battle));
    warTick = ERUPT_AT - 1;
    beginMatch();
    if (offlineTimer) clearInterval(offlineTimer);
    offlineTimer = setInterval(function () {
      if (matchOver) { clearInterval(offlineTimer); return; }
      var inputs = {};
      var q = qCmd.shift();
      if (q) inputs[0] = q;
      var env = { kinds: ['human', 'bot', 'bot', 'bot'] };
      for (var s = 1; s < 4; s++) inputs[s] = S.brain(simState, s, bots[s].level, bots[s].rng, env);
      var r = S.step(simState, inputs);
      applyBuildEvents(r.events);
      if (r.battleEvents) applyBattleEvents(r.battleEvents);
      syncBattleAfterStep(r);
      if (r.over) finish(r.result);
    }, S.META.tickMs);
  }
  /* 离线 battle 镜像=直接取权威 state（本地就是权威）；在线独立镜像由 onFrame 推进 */
  function syncBattleAfterStep() { battle = simState.battle; warTick = simState.tick; }

  function stepLocal(inputs) {
    var r = S.step(simState, inputs);
    applyBuildEvents(r.events);
    if (r.battleEvents) applyBattleEvents(r.battleEvents);
    syncBattleAfterStep();
    if (r.over) finish(r.result);
  }

  /* ================= 在线（S3：快照渲染 + 帧镜像） ================= */
  function startOnline(roomId) {
    mode = 'online';
    document.getElementById('joining').style.display = 'flex';
    session = G.connect({
      roomId: roomId || undefined,
      quick: !roomId,
      gameId: 'empire-sprout',
      maxTicks: new URLSearchParams(location.search).get('maxTicks') ? Number(new URLSearchParams(location.search).get('maxTicks')) : undefined,
      onWelcome: function (m) {
        mySeat = m.seat; myTeam = m.seat >= 0 ? (m.seat % 2 === 0 ? 'A' : 'B') : 'A';
        simState = m.state;
        seedBattle(m.state, m.frame);
        mergeSnap({ full: 1, ents: snapEntsFromState(m.state), tick: m.state.tick });
        for (var i = 0; i < m.room.seats.length; i++) rosterMap[m.room.seats[i].seat] = m.room.seats[i];
        if (m.room.state === 'live') beginMatch();
        else document.getElementById('joining').textContent = '开赛中 ' + Math.ceil(m.room.countdownMs / 1000) + 's';
      },
      onStarted: function (m) {
        simState = m.state;
        seedBattle(m.state, 0);
        mergeSnap({ full: 1, ents: snapEntsFromState(m.state), tick: 0 });
        beginMatch();
      },
      onSnapshot: function (m) {
        mergeSnap(m);
        if (m.events && m.events.length) applyBuildEvents(m.events);
        if (!started && m.frame > 0) beginMatch();
      },
      onFrame: function (m) {
        if (!battle) return;
        if (m.frame !== warTick + 1) {
          if (m.frame <= warTick) return;            // 重复帧忽略
          session.sync();                             // 缺帧：全量重同步（协议 §4.1）
          return;
        }
        var evs = S.battleStep(simMirrorState(), m.inputs);   // 与服务端同函数同输入 → 同状态
        warTick = m.frame;
        applyBattleEvents(evs);
        applyBattleEvents(m.events);                  // 权威事件（erupt 等服务端合成）
        if (!matchOver) session.sendInput({ c: qCmd.length && qCmd[0].c ? qCmd.shift().c : { k: 'noop' } });  // input delay=1
        if (m.over && !matchOver) finishFromServer();
      },
      onState: function (m) { simState = m.state; seedBattle(m.state, m.frame); mergeSnap({ full: 1, ents: snapEntsFromState(m.state), tick: m.state.tick }); },
      onSeat: function (m) { for (var i = 0; i < m.seats.length; i++) rosterMap[m.seats[i].seat] = m.seats[i]; },
      onEnd: function (m) { finish(m.result); },
      onClosed: function () { if (!matchOver) showResult({ winner: 'draw', reason: 'abandon' }, true); },
      onError: function (m) {
        if (m.code === 'room-gone') fallbackOffline('对局已结束');
        else if (m.code === 'reconnect-timeout') showRejoin();
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
  /* 战斗镜像种子：welcome/state 双层合一（§5.5：重连一次性恢复双层） */
  function seedBattle(st, frame) {
    battle = JSON.parse(JSON.stringify(st.battle));
    warTick = Math.min(frame, st.tick);
    if (st.tick < ERUPT_AT) warTick = st.tick;    // 静默期：镜像冻结在当前 tick（首帧 1800 对齐）
  }
  function simMirrorState() { return { tick: warTick, battle: battle }; }
  function snapEntsFromState(st) {
    var ents = st.build.seats.map(function (s, i) {
      var pool = {}; for (var c in s.pools) pool[c] = s.pools[c].length;
      return { id: 's' + i, seat: i, res: { g: (s.res.g / 1000) | 0, w: (s.res.w / 1000) | 0, i: (s.res.i / 1000) | 0 }, plots: s.plots, queues: s.queues, pool: pool, marchCd: s.marchCd };
    });
    ents.push({ id: 'tA', team: 'A', wall: st.teams.A.wall, keep: st.teams.A.keep, merit: st.teams.A.merit });
    ents.push({ id: 'tB', team: 'B', wall: st.teams.B.wall, keep: st.teams.B.keep, merit: st.teams.B.merit });
    return ents;
  }
  function mergeSnap(m) {
    if (!snap || m.full) snap = { seats: {}, teams: {}, tick: m.frame };
    snap.tick = m.frame;
    for (var i = 0; i < (m.ents || []).length; i++) {
      var e = m.ents[i];
      if (e.id[0] === 's') snap.seats[e.seat] = e;
      else snap.teams[e.team] = e;
    }
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
  function showRejoin() {
    if (matchOver || fellBack) return;
    var roomId = session ? session.roomId : null;
    var el = document.getElementById('joining');
    el.textContent = '连接已断，可重新进入对战';
    if (roomId) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'rejoin'; btn.textContent = '重新进入对战';
      btn.onclick = function () {
        var q = new URLSearchParams(location.search);
        q.set('room', roomId);
        location.href = location.pathname + '?' + q.toString();
      };
      el.appendChild(btn);
    }
    el.style.display = 'flex';
  }

  function beginMatch() {
    started = true; matchOver = false;
    document.getElementById('joining').style.display = 'none';
    report('start', { mode: mode, room: session ? session.roomId : 'offline' });
  }

  /* ================= 终局 ================= */
  function finishFromServer() {
    /* 战斗层本地推完 over 帧：权威 result 由 end 消息/快照 result 给出；先静默等待 end */
  }
  function finish(result) { showResult(result, false); }
  function showResult(result, silent) {
    if (matchOver) return;
    matchOver = true;
    if (offlineTimer) clearInterval(offlineTimer);
    var tm = teamsView();
    var win = result.winner === myTeam;
    var el = document.getElementById('result');
    var merit = result.scores || { A: tm.A.merit, B: tm.B.merit };
    el.innerHTML = '<div class="rbox">'
      + '<div class="rtitle" style="color:' + (result.winner === 'draw' ? '#8b93a7' : TEAM_COLOR[result.winner]) + '">' + (result.winner === 'draw' ? '平局' : win ? '凯旋' : '覆灭') + '</div>'
      + '<div class="rsub">' + ({ eliminated: '城心易主', timeout: '超时裁定（比城心 HP%）', abandon: '对局中止' }[result.reason] || result.reason) + '</div>'
      + '<div class="rtable">'
      + '<div class="rrow"><span>战功 A : B</span><b>' + merit.A + ' : ' + merit.B + '</b></div>'
      + '<div class="rrow"><span>城墙残量 A : B</span><b>' + tm.A.wall + ' : ' + tm.B.wall + '</b></div>'
      + '<div class="rrow"><span>城心残量 A : B</span><b>' + tm.A.keep + ' : ' + tm.B.keep + '</b></div>'
      + '</div>'
      + '<button id="again">再来一局</button><button class="ghost" id="lobby">回大厅</button></div>';
    el.style.display = 'flex';
    document.getElementById('again').onclick = function () { location.href = location.pathname; };
    document.getElementById('lobby').onclick = function () { location.href = '/multiplayer.html'; };
    report('levelEnd', { result: result });
    report('end', { result: result });
  }

  /* ================= 调试钩子（GAMES-30 契约：perf-smoke/play-check 零改动可跑） ================= */
  window.__GAMES_DEBUG__ = {
    events: [],
    start: function (level, opts) { startOffline(Object.assign({ seedSalt: String(level || 1) }, opts || {})); },
    state: function () { return JSON.parse(JSON.stringify(simState)); },
    seat: function () { return mySeat; },
    roomId: function () { return session ? session.roomId : null; },
    mode: function () { return mode; },
    fps: function () { return fpsV; },
    perf: function () { return { inputMaxMs: Math.round(inputMaxMs), fps: fpsV }; },
    cmd: function (cmd) { qCmd.push(cmd); },
    hudFonts: function () { return JSON.parse(JSON.stringify(HUDF)); },
    dial: function () { return dial; },
  };

  /* ================= 启动 ================= */
  fit();
  report('boot', { slug: 'empire-sprout', version: '1.0.0', mode: 'net' });
  var q = new URLSearchParams(location.search);
  requestAnimationFrame(render);
  if (q.get('debug') === '1') startOffline({ seedSalt: q.get('again') ? String(Date.now() % 97) : '1', maxTicks: q.get('maxTicks') ? Number(q.get('maxTicks')) : undefined });
  else if (q.get('room')) startOnline(q.get('room'));
  else startOnline(null); // 快速匹配
})();
