/* =====================================================================
 * 街头足球 street-soccer —— S3+S4 混合权威+定点物理球共享确定性模拟（GAMES-138）
 * 单一事实源：服务端（server/gateway/sims/street-soccer.js require 本文件）与
 * 回放器（api-check A8 输入日志重放）跑同一份代码。
 * 设计事实源：docs/designs/street-soccer.md（GAMES-137 评审通过版）——数值表 §2
 * 直接对书；S3 状态归属表/触球三态机 §2.5/§5.1；协议 §5.3。
 *
 * 确定性纪律（设计 §6，pool §5.4 清单复刻）：
 *   - 全整数态：位置/速度 milli-px int32（球速=milli/每子步；球员速=milli/每 tick）；
 *     算术只 + − × >> |(a/b)|0；三角 TRIG16/ATAN8（跨作复用 pool-physics/trig16.cjs，
 *     两端字节一致）；开方二分整数 isqrt；零 Math.*、零 Date.now（渲染不在本文件）；
 *   - 两级时钟：球员 tick=50ms 步进（状态域），球每 tick 固定 SUBS=5 子步（物理域，
 *     子步=10ms）；子步内球员位冻结（§2.3 反隧道校核的确定性口径）；
 *   - 结算序固定：tick=①cmd→②相位机→③球员移动/体力→④推挤 LUT→⑤球子步×5
 *     （积分→接触→门柱→围板→捕获→摩擦/自旋）→⑥触球推/失球→⑦计时终局；
 *   - sim 判定路径随机全走无状态 rng=mulberry32(seed^tick^席位混合)（仲裁/散布/
 *     Bot）——同 seed 双跑逐字节幂等，回放器零 rng 流对账（kart A6 前例的强化）；
 *   - serialize 键字母序；inLog=稀疏变更日志（[tick,seat,mx,my,sp,cmd?]）。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node（.cjs）
  root.StreetSim = api;                                                    // 浏览器内联（classic script）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TRIG = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('../pool-physics/trig16.cjs') : globalThis.PoolTrig; // 跨作复用 pool 烘焙常量（§附决策 7；浏览器前置 script 载入设 window.PoolTrig）
  var TRIG16 = TRIG.TRIG16, ATAN8 = TRIG.ATAN8;

  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 常量（设计 §2 数值表抄录；全整数 milli） ---------- */
  var SEATS = 4;
  var TICK_MS = 50;              // 房间 tick（§2.3）
  var SUBS = 5;                  // 每 tick 固定 5 物理子步（子步 10ms）
  var MAX_TICKS = 6000;          // 300s 硬顶（§1.1 包络）
  var W_M = 350000, H_M = 500000; // 球场内域（§2.1）
  var R_B = 6000;                // 球半径
  var R_P = 11000;               // 球员半径
  var CATCH_R2 = 17000 * 17000;  // 球-球员接触判据（r_b+r_p）
  var LEASH = 26000;             // 触球推软栓（§2.5）
  var ANCHOR = 14000;            // 盘带身前锚点
  var ATTRACT = 28000;           // 传球接球吸引子（§3.3）
  var PUSH_D = 22000;            // 玩家推挤重叠判据（§2.4）
  var MU = 65143;                // 滚动摩擦 0.994 Q16
  var V_SLIP2 = 250 * 250;       // 两相分界（速度²）
  var E_WALL_N = 47186, E_WALL_T = 60293; // 板墙 0.72/0.92（§2.1）
  var E_POST = 51118;            // 门柱 0.78
  var SPIND = 64768;             // 自旋衰减 0.988
  var VMAX = 6200;               // 最大球速 milli/子步
  var BRAKE = 19661;             // 接球刹停 0.30
  var DRIBBLE_MUL = 241;         // 盘带 ×0.94（/256）
  var SPRINT_COST = 1400, SPRINT_REGEN = 900; // 体力（§1.6）
  var STAM_MIN = 20000, STAM_UNLOCK = 40000, STAM_MAX = 100000;
  var KICK_TICKS = 30;           // 开球 1.5s
  var GOAL_TICKS = 60;           // 进球 banner 3s
  var CLOCK_REG = 3600;          // 常规 180s play tick
  var CLOCK_OT = 1200;           // OT 60s
  var GOAL_CAP = 5;              // 封顶（§1.2）
  var GOAL_MOUTH_LO = 130000, GOAL_MOUTH_HI = 220000; // 门径（§2.1）
  var GOAL_CAP_Y0 = -8000, GOAL_CAP_Y1 = 508000;      // 捕获线（越线 0.8×球径）
  var CAV_LO = 135000, CAV_HI = 215000;                // 门腔侧壁
  var CAV_BACK0 = -18000, CAV_BACK1 = 518000;
  var POSTS = [ // 门柱圆柱 r=5000（§2.1，上/下门各二）
    { x: 130000, y: 6000 }, { x: 220000, y: 6000 },
    { x: 130000, y: 494000 }, { x: 220000, y: 494000 },
  ];
  var POST_R2 = 11000 * 11000;   // r_b+r_post
  var GX = 175000;               // 双门中轴 x

  /* 球员四类（§2.2：速度 milli/tick=px/s×50/10…抄表；str/散布（8192 brads 档）/满力球速） */
  var CLS = {
    fast:     { code: 'fast',     spd: 9500, sprint: 12160, str: 1, scat: 69,  v: 5600, ctrl: 0 },
    all:      { code: 'all',      spd: 8400, sprint: 10752, str: 2, scat: 44,  v: 5400, ctrl: 0 },
    striker:  { code: 'striker',  spd: 8000, sprint: 10240, str: 2, scat: 25,  v: 6200, ctrl: 0 },
    tank:     { code: 'tank',     spd: 7500, sprint: 9600,  str: 3, scat: 94,  v: 4600, ctrl: 40 },
  };
  var DEFAULT_CLS = ['striker', 'all', 'all', 'all']; // 席 0=API 席缺省炮手（§6 strike-rush 口径）

  /* 推挤份额 LUT（§2.4：share=(4−strA)/(8−strA−strB)，Q16 预计算 9 组合） */
  var PUSH_LUT = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (var la = 1; la <= 3; la++) for (var lb = 1; lb <= 3; lb++)
    PUSH_LUT[la - 1][lb - 1] = Math.round((4 - la) / (8 - la - lb) * 65536);

  /* 开球阵型表（§2.7 固定表零随机） */
  var FORM = {
    A: [[160000, 295000], [220000, 335000], [60000, 155000], [290000, 155000]], // A 开球：席0/2 近位+拖后，席1/3 防守
    B: [[60000, 345000], [290000, 345000], [160000, 205000], [220000, 165000]], // B 开球：席2/3 近位+拖后，席0/1 防守
  };

  /* ---------- 定点助手（pool 同式：isqrt/cosQ16/sinQ16/atan2Q，8192 brads 圈） ---------- */
  function isqrt(n) {
    if (n <= 0) return 0;
    var hi = 1;
    while (hi * hi <= n) hi <<= 1;
    var lo = hi >> 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (mid * mid <= n) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
  function cosQ16(q) { q &= 8191; var i = q & 2047; switch (q >> 11) { case 0: return TRIG16[2048 - i]; case 1: return -TRIG16[i]; case 2: return -TRIG16[2048 - i]; default: return TRIG16[i]; } }
  function sinQ16(q) { q &= 8191; var i = q & 2047; switch (q >> 11) { case 0: return TRIG16[i]; case 1: return TRIG16[2048 - i]; case 2: return -TRIG16[i]; default: return -TRIG16[2048 - i]; } }
  function atan2Q(dx, dy) {
    var ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy, q;
    if (ax >= ay) q = ATAN8[clampI(((ay << 11) / ax) | 0, 0, 2048)];
    else q = 2048 - ATAN8[clampI(((ax << 11) / ay) | 0, 0, 2048)];
    if (dx >= 0 && dy >= 0) return q;
    if (dx < 0 && dy >= 0) return 4096 - q;
    if (dx < 0 && dy < 0) return 4096 + q;
    return 8192 - q;
  }
  function angDiff(a, b) { var d = (a - b) & 8191; if (d > 4096) d -= 8192; return d; }
  var sgn = function (v) { return v > 0 ? 1 : v < 0 ? -1 : 0; };
  function clampI(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function d2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
  function teamOf(seat) { return seat & 1; } // 0=A（偶席，攻上门）/1=B
  function atkGoal(team) { return team === 0 ? { x: GX, y: 0 } : { x: GX, y: H_M }; }
  function ownGoal(team) { return team === 0 ? { x: GX, y: H_M } : { x: GX, y: 0 }; }

  /* =====================================================================
   * create(seed, opts)
   * ===================================================================== */
  function create(seed, opts) {
    opts = opts || {};
    var st = {
      v: 1, gameId: 'street-soccer', seed: seed >>> 0, tick: 0,
      testRoom: !!opts.test, maxTicks: Number.isInteger(opts.maxTicks) && opts.maxTicks > 0 ? opts.maxTicks : MAX_TICKS,
      phase: 'kick', phaseT: 0, clock: CLOCK_REG, ot: 0,
      kickTeam: 0,                    // 开球方（team；比赛开局 A/OT B，§2.6）
      score: { A: 0, B: 0 },
      goals: [0, 0, 0, 0],            // 各席进球（结算 scores）
      stats: { onT: [0, 0], possT: [0, 0], firstGoal: -1, tackles: [0, 0, 0, 0] },
      players: [], mem: [],
      ball: { x: 175000, y: 250000, vx: 0, vy: 0, w: 0, owner: -1, lastT: -1, passT: -1, passUntil: 0, noCatch: -1, noCatchUntil: 0 },
      classes: (opts.classes || DEFAULT_CLS).slice(0, SEATS),
      possSeat: -1,                   // 持球席位镜像（poss 事件账本源）
      inLog: [], lastIn: [null, null, null, null],
      auto: opts.autopilot === true ? 0 : -1, // 测试房服务器节拍自动驾驶席（A8 确定性双跑，kart 同款）
      pendingEnd: null,
    };
    for (var i = 0; i < SEATS; i++) ensurePlayer(st, i);
    resetFormation(st, 0);
    return st;
  }
  function ensurePlayer(st, seat) {
    var p = st.players[seat];
    if (p) return p;
    var c = CLS[st.classes[seat]] || CLS.all;
    p = st.players[seat] = {
      seat: seat, team: teamOf(seat), cls: c.code, x: 0, y: 0, vx: 0, vy: 0, dir: 0,
      stam: STAM_MAX, stamLock: 0, lungeT: 0, lungeDx: 0, lungeDy: 0, lungeHit: 0,
      stumbleT: 0, tackleCd: 0, stealBan: 0,
    };
    return p;
  }
  function resetFormation(st, kickTeam) {
    var f = FORM[kickTeam === 0 ? 'A' : 'B'];
    st.kickTeam = kickTeam;
    for (var i = 0; i < SEATS; i++) {
      var p = st.players[i];
      if (!p) continue;
      p.x = f[i][0]; p.y = f[i][1]; p.vx = 0; p.vy = 0;
      p.dir = atan2Q(175000 - p.x, 250000 - p.y);
      p.lungeT = 0; p.stumbleT = 0; p.tackleCd = 0; p.stealBan = 0;
      p.stam = STAM_MAX; p.stamLock = 0;
    }
    var b = st.ball;
    b.x = 175000; b.y = 250000; b.vx = 0; b.vy = 0; b.w = 0;
    b.owner = -1; b.lastT = -1; b.passT = -1; b.passUntil = 0; b.noCatch = -1; b.noCatchUntil = 0;
  }

  /* =====================================================================
   * step(st, inputs, room) —— tick 结算序（§5.3 红线）
   * ===================================================================== */
  function step(st, inputs, room) {
    var ev = [];
    var dirty = {};
    var mark = function (id) { dirty[id] = 1; };
    var kinds = room ? room.seats.map(function (s) { return s.kind; }) : null;

    /* 0. 席位自愈 + 输入采样（autopilot 席服务器节拍锁）+ inLog 稀疏记账 */
    var eff = [null, null, null, null];
    for (var i = 0; i < SEATS; i++) {
      var active = kinds ? (kinds[i] === 'human' || kinds[i] === 'bot') : true;
      if (!active) { if (st.players[i]) { st.players[i] = null; mark('p' + i); } continue; }
      ensurePlayer(st, i);
      var raw = inputs ? inputs[i] : null;
      if (st.auto === i) raw = autopilotImpl(st, i);
      raw = raw || {};
      var e = {
        mx: clampI(raw.mx | 0, -100, 100), my: clampI(raw.my | 0, -100, 100),
        sp: raw.sp ? 1 : 0, cmd: raw.cmd && typeof raw.cmd === 'object' ? raw.cmd : null,
      };
      eff[i] = e;
      var li = st.lastIn[i];
      var chg = !li || li.mx !== e.mx || li.my !== e.my || li.sp !== e.sp;
      if (chg || e.cmd) {
        st.inLog.push([st.tick, i, e.mx, e.my, e.sp, e.cmd || 0]);
        st.lastIn[i] = { mx: e.mx, my: e.my, sp: e.sp };
      }
    }

    /* ① cmd 应用（服务器逐条校验，非法 reject 回流 §5.3） */
    for (var s1 = 0; s1 < SEATS; s1++) {
      var p1 = st.players[s1];
      if (p1 && eff[s1] && eff[s1].cmd) execCmd(st, s1, eff[s1].cmd, ev, mark);
    }

    /* ② 相位机推进（§2.6；goal banner 期全场冻结） */
    st.phaseT++;
    if (st.phase === 'kick' && st.phaseT >= KICK_TICKS) { st.phase = 'play'; st.phaseT = 0; }
    else if (st.phase === 'kick' && st.ball.owner >= 0) { st.phase = 'play'; st.phaseT = 0; } // 任意触球即开踢（§1.1）
    else if (st.phase === 'goal' && st.phaseT >= GOAL_TICKS) {
      st.phase = 'kick'; st.phaseT = 0;
      resetFormation(st, st.kickTeam); // kickTeam 已在进球时改写为被进球方
      for (var s2 = 0; s2 < SEATS; s2++) mark('p' + s2);
      mark('ball');
    }

    /* ③ 球员移动积分+体力（kick/play 期可动；goal 冻结） */
    if (st.phase !== 'goal' && st.phase !== 'ended') {
      for (var s3 = 0; s3 < SEATS; s3++) {
        var p = st.players[s3];
        if (!p) continue;
        if (p.tackleCd > 0) p.tackleCd--;
        if (p.stealBan > 0) p.stealBan--;
        var inp = eff[s3] || { mx: 0, my: 0 };
        if (p.stumbleT > 0) { p.stumbleT--; p.vx = 0; p.vy = 0; mark('p' + s3); continue; }
        var c = CLS[p.cls] || CLS.all;
        if (p.lungeT > 0) { // 扑抢冲刺（3×速，§1.5）
          p.lungeT--;
          p.vx = p.lungeDx; p.vy = p.lungeDy;
          if (p.lungeT === 0 && !p.lungeHit) { // 扑空自绊 300ms
            p.stumbleT = 6; p.vx = 0; p.vy = 0;
            ev.push({ k: 'tackle', by: s3, res: 'miss' });
          }
        } else {
          var spd = c.spd;
          var wantSprint = inp.sp && !p.stamLock;
          if (wantSprint) spd = c.sprint;
          if (st.ball.owner === s3) spd = (spd * DRIBBLE_MUL) >> 8; // 盘带 ×0.94
          p.vx = (spd * inp.mx / 100) | 0; p.vy = (spd * inp.my / 100) | 0;
          if (inp.mx || inp.my) p.dir = atan2Q(inp.mx, inp.my);
        }
        /* 体力弧（§1.6：一条弧+力竭滞回） */
        if (wantSprint && (p.vx || p.vy)) {
          p.stam -= SPRINT_COST;
          if (p.stam < STAM_MIN) { p.stamLock = 1; }
        } else if (p.stam < STAM_MAX) p.stam = Math.min(STAM_MAX, p.stam + SPRINT_REGEN);
        if (p.stamLock && p.stam >= STAM_UNLOCK) p.stamLock = 0;
        p.x = clampI(p.x + p.vx, R_P, W_M - R_P);
        p.y = clampI(p.y + p.vy, R_P, H_M - R_P);
        mark('p' + s3);
      }
      /* ④ 玩家推挤（LUT 份额，对序 (i,j) 升序固定 1 轮 §2.4） */
      for (var a = 0; a < SEATS; a++) {
        var pa = st.players[a]; if (!pa) continue;
        for (var b2 = a + 1; b2 < SEATS; b2++) {
          var pb = st.players[b2]; if (!pb) continue;
          var ddx = pb.x - pa.x, ddy = pb.y - pa.y, dd = d2(pa.x, pa.y, pb.x, pb.y);
          if (dd >= PUSH_D * PUSH_D || dd === 0) continue;
          var d = isqrt(dd), ov = PUSH_D - d;
          var nx = (ddx << 16) / d | 0, ny = (ddy << 16) / d | 0;
          var sa = PUSH_LUT[(CLS[pa.cls].str - 1)][(CLS[pb.cls].str - 1)];
          var sb = PUSH_LUT[(CLS[pb.cls].str - 1)][(CLS[pa.cls].str - 1)];
          pa.x = clampI(pa.x - ((nx * ov >> 16) * sa >> 16), R_P, W_M - R_P);
          pa.y = clampI(pa.y - ((ny * ov >> 16) * sa >> 16), R_P, H_M - R_P);
          pb.x = clampI(pb.x + ((nx * ov >> 16) * sb >> 16), R_P, W_M - R_P);
          pb.y = clampI(pb.y + ((ny * ov >> 16) * sb >> 16), R_P, H_M - R_P);
          pa.vx = (pa.vx * 200) >> 8; pa.vy = (pa.vy * 200) >> 8; // 推挤期速度衰减（残余下 tick 解）
          pb.vx = (pb.vx * 200) >> 8; pb.vy = (pb.vy * 200) >> 8;
          mark('p' + a); mark('p' + b2);
        }
      }
      /* ⑤ 球子步 ×5（§2.3 固定序：积分→接触→门柱→围板→捕获→摩擦/自旋） */
      for (var sub = 0; sub < SUBS; sub++) ballSub(st, sub, ev, mark);
      /* ⑥ 触球推/失球判定（每 tick 一次，球子步后 §2.5） */
      dribble(st, ev, mark);
    }

    /* ⑦ 计时与终局裁决（§2.6：相位机 tick 末判定） */
    if (st.phase === 'play') {
      var tm = st.ball.owner >= 0 ? teamOf(st.ball.owner) : -1;
      if (tm >= 0) st.stats.possT[tm]++;
      st.clock--;
      if (st.clock <= 0) {
        if (!st.ot && st.score.A === st.score.B) {
          st.ot = 1; st.phase = 'kick'; st.phaseT = 0; st.clock = CLOCK_OT;
          resetFormation(st, 1); // OT B 开球（开局 A 开球补偿，§2.6）
          for (var s4 = 0; s4 < SEATS; s4++) mark('p' + s4);
          mark('ball');
          ev.push({ k: 'ot' });
        } else if (st.ot) st.pendingEnd = tiebreak(st);
        else st.pendingEnd = timeUp(st);
      }
    }
    /* poss 账本（A7 攻防转换断言源）：持球席位镜像变化 → {from,to} 事件 */
    var curPoss = st.ball.owner;
    if (curPoss !== st.possSeat) {
      ev.push({ k: 'poss', from: st.possSeat, to: curPoss });
      st.possSeat = curPoss;
    }
    var over = null;
    if (st.pendingEnd) over = st.pendingEnd;
    else if (st.tick + 1 >= st.maxTicks) over = timeUp(st); // 硬顶兜底（预期不触发）
    if (over) {
      st.phase = 'ended';
      var res = { winner: over.winner, reason: over.reason, scores: {} };
      for (var s5 = 0; s5 < SEATS; s5++) res.scores[s5] = st.goals[s5];
      ev.push({ k: 'end', winner: over.winner, reason: over.reason });
      st.tick++;
      return { events: ev, dirty: mark, over: true, result: res };
    }
    st.tick++;
    return { events: ev, dirty: mark, over: false, result: null };
  }

  function timeUp(st) {
    return st.ot ? tiebreak(st) : {
      winner: st.score.A > st.score.B ? 'A' : st.score.B > st.score.A ? 'B' : 'draw',
      reason: 'time-up',
    };
  }
  /* OT 仍平裁定链（§1.4）：射正 → 控球 tick → 先得分方 → draw（全账本可回算） */
  function tiebreak(st) {
    var w = 'draw';
    if (st.stats.onT[0] !== st.stats.onT[1]) w = st.stats.onT[0] > st.stats.onT[1] ? 'A' : 'B';
    else if (st.stats.possT[0] !== st.stats.possT[1]) w = st.stats.possT[0] > st.stats.possT[1] ? 'A' : 'B';
    else if (st.stats.firstGoal >= 0) w = st.stats.firstGoal === 0 ? 'A' : 'B';
    return { winner: w, reason: 'time-up' };
  }

  /* ---------- 离散 cmd（execCmd 白名单；非法 {k:'reject'} 回流 §5.3） ---------- */
  function execCmd(st, seat, cmd, ev, mark) {
    var p = st.players[seat];
    var B = st.ball;
    var k = cmd.k;
    if (k === 'shot') {
      if (B.owner !== seat) return ev.push({ k: 'reject', seat: seat, op: 'shot', why: 'no-ball' });
      var q = ((cmd.ang | 0) & 0xFFFF) >> 3;                 // uint16 brads → 8192 档（协议 §6）
      var pow = clampI(cmd.pow | 0, 0, 1000);
      var c = CLS[p.cls] || CLS.all;
      var G = atkGoal(p.team);
      var gq = atan2Q(G.x - B.x, G.y - B.y);
      var dv = angDiff(q, gq);
      if (dv < 0) dv = -dv;
      if (dv <= 307) q = gq;                                  // 吸附锥 ±13.5°→8192 档 307（§3.4）
      var sc = c.scat; if (pow < 300) sc = sc * 2;            // 轻触更飘（§2.3）
      var r99 = (rngAt(st, 0x51, seat)() * 99) | 0;
      q = (q + (((r99 - 50) * sc) / 50 | 0)) & 8191;
      var v = (c.v * pow / 1000) | 0;
      B.vx = (cosQ16(q) * v) >> 16; B.vy = (sinQ16(q) * v) >> 16;
      B.owner = -1; B.passT = -1; B.lastT = seat;
      B.noCatch = seat; B.noCatchUntil = st.tick + 12;
      ev.push({ k: 'shot', seat: seat, ang: q, pow: pow });
      if (rayOnTarget(st, B.x, B.y, q)) st.stats.onT[p.team]++; // 射正账本（裁定链第一序）
      mark('ball');
      return;
    }
    if (k === 'pass') {
      if (B.owner !== seat) return ev.push({ k: 'reject', seat: seat, op: 'pass', why: 'no-ball' });
      var mate = seat ^ 2;                                    // 2v2 队友唯一（§3.3 免瞄准）
      var pm = st.players[mate];
      var tx, ty, v2;
      if (pm) {
        var d0 = isqrt(d2(B.x, B.y, pm.x, pm.y));
        v2 = clampI(1800 + (d0 / 100 | 0), 1800, 5200);
        tx = pm.x; ty = pm.y;
        for (var it = 0; it < 2; it++) {                      // lead 引导点 T 迭代 2 次（§3.3）
          tx = pm.x + ((pm.vx * (d0 / (v2 * 5) | 0)) | 0);
          ty = pm.y + ((pm.vy * (d0 / (v2 * 5) | 0)) | 0);
          d0 = isqrt(d2(B.x, B.y, tx, ty));
        }
        if (!pathClear(st, B.x, B.y, tx, ty)) { pm = null; }  // 无可达路径 → 解围大脚
      }
      if (!pm) {                                              // 解围：朝向 v=5200（一键双语义）
        var cd2 = p.dir;
        B.vx = (cosQ16(cd2) * 5200) >> 16; B.vy = (sinQ16(cd2) * 5200) >> 16;
        B.owner = -1; B.passT = -1; B.lastT = seat;
        B.noCatch = seat; B.noCatchUntil = st.tick + 12;
        ev.push({ k: 'pass', from: seat, to: -1 });
        mark('ball');
        return;
      }
      var dd = isqrt(d2(B.x, B.y, tx, ty)) || 1;
      var vx2 = ((tx - B.x) / dd * v2) | 0, vy2 = ((ty - B.y) / dd * v2) | 0;
      B.vx = vx2; B.vy = vy2;
      B.owner = -1; B.passT = mate; B.passUntil = st.tick + 240; B.lastT = seat;
      B.noCatch = seat; B.noCatchUntil = st.tick + 12;
      ev.push({ k: 'pass', from: seat, to: mate });
      mark('ball');
      return;
    }
    if (k === 'tackle') {
      if (p.lungeT > 0 || p.tackleCd > 0) return ev.push({ k: 'reject', seat: seat, op: 'tackle', why: 'cd' });
      var cc = CLS[p.cls] || CLS.all;
      var dx = B.x - p.x, dy = B.y - p.y, dd2 = isqrt(d2(p.x, p.y, B.x, B.y)) || 1;
      p.lungeT = 5; p.lungeHit = 0; p.tackleCd = 30;
      p.lungeDx = ((dx / dd2 * cc.spd * 3) | 0); p.lungeDy = ((dy / dd2 * cc.spd * 3) | 0);
      p.dir = atan2Q(dx, dy);
      mark('p' + seat);
      return;
    }
    /* 未知 cmd 静默 noop（网关透传口径） */
  }
  /* 无状态 rng（同 seed 双跑幂等：仲裁/散布/Bot 共用族，§6 确定性口径） */
  function rngAt(st, tag, seat) {
    return mulberry32((st.seed ^ ((st.tick << 8) | 0) ^ Math.imul(seat + 1, 0x9e3779b9) ^ (tag * 0x85ebca6b)) >>> 0);
  }

  /* 射正回算（裁定链账本）：出脚射线在首面围板前过门线平面（近似=忽略人墙封堵，确定性纯函数） */
  function rayOnTarget(st, x, y, q) {
    var dx = cosQ16(q), dy = sinQ16(q);
    var tWall = 1 << 30;
    if (dx > 0) tWall = Math.min(tWall, ((344000 - x) << 16) / dx | 0);
    if (dx < 0) tWall = Math.min(tWall, ((6000 - x) << 16) / dx | 0);
    if (dy > 0) { // 下行：先到 494000 板（除非在门径）
      var t1 = ((494000 - y) << 16) / dy | 0;
      var mx = x + (((dx * t1) >> 16) | 0);
      if (mx < GOAL_MOUTH_LO || mx > GOAL_MOUTH_HI) tWall = Math.min(tWall, t1);
      else tWall = Math.min(tWall, ((508000 - y) << 16) / dy | 0); // 门径内→门线平面
    }
    if (dy < 0) {
      var t0 = ((6000 - y) << 16) / dy | 0;
      var mx0 = x + (((dx * t0) >> 16) | 0);
      if (mx0 < GOAL_MOUTH_LO || mx0 > GOAL_MOUTH_HI) tWall = Math.min(tWall, t0);
      else tWall = Math.min(tWall, ((-8000 - y) << 16) / dy | 0);
    }
    if (dy === 0) return false;
    var tg = dy > 0 ? ((508000 - y) << 16) / dy | 0 : ((-8000 - y) << 16) / dy | 0;
    if (tg <= 0 || tg >= tWall) return false;
    var gx = x + (((dx * tg) >> 16) | 0);
    return gx >= GOAL_MOUTH_LO + 5000 && gx <= GOAL_MOUTH_HI - 5000;
  }
  /* 通路检查（§3.3：线段 7500 milli 步进采样，pool 同式） */
  function pathClear(st, x1, y1, x2, y2) {
    var d = isqrt(d2(x1, y1, x2, y2)), steps = Math.max(1, (d / 7500) | 0);
    for (var s = 1; s <= steps; s++) {
      var px = x1 + ((x2 - x1) * s / steps) | 0, py = y1 + ((y2 - y1) * s / steps) | 0;
      if (px < 6000 || px > 344000 || py < 6000 || py > 494000) return false;
      for (var i = 0; i < 4; i++) if (d2(px, py, POSTS[i].x, POSTS[i].y) < 12000 * 12000) return false;
    }
    return true;
  }

  /* ---------- 球子步（§2.3 结算序红线） ---------- */
  function ballSub(st, sub, ev, mark) {
    var B = st.ball;
    if (st.pendingEnd || st.phase === 'goal' || st.phase === 'ended') return; // 进球/终局后球停摆（防连捕）
    /* ① 积分 */
    B.x += B.vx; B.y += B.vy;
    /* ② 球-球员接触（席升序；子步内球员位冻结）——三态机（§2.5） */
    if (B.owner < 0 && B.passT >= 0 && st.tick >= B.passUntil) B.passT = -1; // 传球窗过期
    if (B.noCatch >= 0 && st.tick >= B.noCatchUntil) B.noCatch = -1;         // 出脚者免接窗过期
    for (var s = 0; s < SEATS; s++) {
      var p = st.players[s];
      if (!p) continue;
      if (s === B.noCatch) continue; // 出脚/剥离者免接窗（球刚离脚，防自接刹停）
      var inAttract = B.owner < 0 && B.passT === s && d2(B.x, B.y, p.x, p.y) <= ATTRACT * ATTRACT;
      if (!inAttract && d2(B.x, B.y, p.x, p.y) > CATCH_R2) continue;
      if (B.owner < 0) {
        /* 接球（自由球任意接触即控；吸引域放宽=好球更好接） */
        B.owner = s; B.lastT = s; B.passT = -1;
        B.vx = (B.vx * BRAKE) >> 16; B.vy = (B.vy * BRAKE) >> 16; // 第一脚停球 ×0.30
        ev.push({ k: 'touch', seat: s });
        mark('ball');
      } else if (B.owner !== s) {
        /* 抢断仲裁（服务器唯一裁决，零预测 §5.1） */
        if (p.stealBan > 0) continue;
        arbitrate(st, s, ev, mark);
      }
      break; // 单子步单次解算（席序优先）
    }
    /* ③ 门柱（isqrt 圆碰撞，e=0.78 法向） */
    for (var pi = 0; pi < 4; pi++) {
      var po = POSTS[pi];
      var ddx = B.x - po.x, ddy = B.y - po.y, dd2 = ddx * ddx + ddy * ddy;
      if (dd2 >= POST_R2 || dd2 === 0) continue;
      var d = isqrt(dd2);
      var nx = (ddx << 16) / d | 0, ny = (ddy << 16) / d | 0;
      B.x = po.x + ((nx * 11000) >> 16);
      B.y = po.y + ((ny * 11000) >> 16);
      var vn = (B.vx * nx + B.vy * ny) >> 16;
      if (vn < 0) { // 反射 e_post=0.78 法向（v' = v − n·vn·(1+e)）
        B.vx -= (nx * vn * (65536 + E_POST) >> 16);
        B.vy -= (ny * vn * (65536 + E_POST) >> 16);
        B.w = clampI(B.w + ((B.vx * 328) >> 16), -600, 600);
        ev.push({ k: 'post', x: B.x, y: B.y });
      }
    }
    /* ④ 围板反射（无出界 §2.1；门径段不设墙） */
    wallReflect(st, ev);
    /* ⑤ 进球捕获（先于后壁触达，无卡死态） */
    if (B.y <= GOAL_CAP_Y0 || B.y >= GOAL_CAP_Y1 || (B.y < 6000 || B.y > 494000) && (B.vx * B.vx + B.vy * B.vy) <= V_SLIP2 && B.x > GOAL_MOUTH_LO && B.x < GOAL_MOUTH_HI) {
      goalScored(st, B.y <= GOAL_CAP_Y0 || (B.y < 6000 && B.x > GOAL_MOUTH_LO && B.x < GOAL_MOUTH_HI) ? 0 : 1, ev, mark);
      return;
    }
    /* ⑥ 两相摩擦+旋转衰减（§2.3） */
    var v2 = B.vx * B.vx + B.vy * B.vy;
    if (B.owner < 0) { // 持球态摩擦由触球推接管
      if (v2 > V_SLIP2) { B.vx = (B.vx * MU) >> 16; B.vy = (B.vy * MU) >> 16; }
      else {
        if (B.vx > 0) B.vx = Math.max(0, B.vx - 2); else if (B.vx < 0) B.vx = Math.min(0, B.vx + 2);
        if (B.vy > 0) B.vy = Math.max(0, B.vy - 2); else if (B.vy < 0) B.vy = Math.min(0, B.vy + 2);
      }
    }
    /* Magnus-lite（§2.3：v⊥ += ω×|v|×17>>21）+ 自旋衰减 */
    B.vx += ((-B.vy * B.w * 17) >> 21);
    B.vy += ((B.vx * B.w * 17) >> 21);
    B.w = (B.w * SPIND) >> 16;
    if (v2 > VMAX * VMAX) { var sc2 = (VMAX * 65536 / isqrt(v2)) | 0; B.vx = (B.vx * sc2) >> 16; B.vy = (B.vy * sc2) >> 16; }
    mark('ball');
  }

  /* 抢断仲裁（§2.5 公式照抄；rng 无状态=双跑幂等） */
  function arbitrate(st, tSeat, ev, mark) {
    var B = st.ball;
    var oSeat = B.owner;
    var tp = st.players[tSeat], op = st.players[oSeat];
    if (!tp || !op) return;
    var rng = rngAt(st, 0xa7, tSeat);
    var score = function (p, isCarrier, lunge) {
      var sc = (CLS[p.cls] || CLS.all).str * 100 + (lunge ? 50 : 0);
      var fx = B.x - p.x, fy = B.y - p.y;
      if (fx || fy) { var fa = atan2Q(fx, fy); if (Math.abs(angDiff(fa, p.dir)) <= 1024) sc += 25; } // 面向球 ±45°
      sc += (rng() * 99) | 0;
      if (isCarrier) sc -= 40;
      return sc;
    };
    var stt = score(tp, false, tp.lungeT > 0);
    var sto = score(op, true, false);
    if (tp.lungeT > 0) tp.lungeHit = 1;
    if (stt > sto + 40) {
      /* 夺权 */
      B.owner = tSeat; B.lastT = tSeat; B.passT = -1;
      op.stealBan = 25; // 被抢者 25 tick 禁再抢（防乒乓）
      ev.push({ k: 'steal', by: tSeat, from: oSeat });
      if (tp.lungeT > 0) ev.push({ k: 'tackle', by: tSeat, res: 'win' });
      mark('ball');
    } else {
      /* 均势剥离：球弹开（1500+rng2000） */
      var dx = B.x - op.x, dy = B.y - op.y, d = isqrt(d2(op.x, op.y, B.x, B.y)) || 1;
      var mag = 1500 + ((rng() * 2000) | 0);
      B.vx = ((dx / d * mag) | 0); B.vy = ((dy / d * mag) | 0);
      B.owner = -1; B.passT = -1; B.lastT = oSeat;
      B.noCatch = oSeat; B.noCatchUntil = st.tick + 12;
      op.stealBan = 25;
      if (tp.lungeT > 0) tp.lungeHit = 1;
      ev.push({ k: 'lost', seat: oSeat });
      mark('ball');
    }
  }

  /* 围板/门腔反射（§2.1：e_wall 0.72 法向/0.92 切向；碰板赋旋） */
  function wallReflect(st, ev) {
    var B = st.ball;
    var inMouthTop = B.y < 6000 && B.x > GOAL_MOUTH_LO - 6000 && B.x < GOAL_MOUTH_HI + 6000;
    var inMouthBot = B.y > 494000 && B.x > GOAL_MOUTH_LO - 6000 && B.x < GOAL_MOUTH_HI + 6000;
    if (B.x < 6000) { B.x = 6000; if (B.vx < 0) { B.w = clampI(B.w + ((B.vy * 328) >> 16), -600, 600); B.vx = (-B.vx * E_WALL_N) >> 16; B.vy = (B.vy * E_WALL_T) >> 16; ev.push({ k: 'wall', x: B.x, y: B.y }); } }
    else if (B.x > 344000) { B.x = 344000; if (B.vx > 0) { B.w = clampI(B.w + ((B.vy * 328) >> 16), -600, 600); B.vx = (-B.vx * E_WALL_N) >> 16; B.vy = (B.vy * E_WALL_T) >> 16; ev.push({ k: 'wall', x: B.x, y: B.y }); } }
    if (inMouthTop) {
      if (B.x < CAV_LO) { B.x = CAV_LO; if (B.vx < 0) { B.vx = (-B.vx * E_WALL_N) >> 16; B.vy = (B.vy * E_WALL_T) >> 16; } }
      else if (B.x > CAV_HI) { B.x = CAV_HI; if (B.vx > 0) { B.vx = (-B.vx * E_WALL_N) >> 16; B.vy = (B.vy * E_WALL_T) >> 16; } }
      if (B.y < CAV_BACK0) { B.y = CAV_BACK0; if (B.vy < 0) B.vy = (-B.vy * E_WALL_N) >> 16; }
    } else if (B.y < 6000) { B.y = 6000; if (B.vy < 0) { B.w = clampI(B.w + ((B.vx * 328) >> 16), -600, 600); B.vy = (-B.vy * E_WALL_N) >> 16; B.vx = (B.vx * E_WALL_T) >> 16; ev.push({ k: 'wall', x: B.x, y: B.y }); } }
    if (inMouthBot) {
      if (B.x < CAV_LO) { B.x = CAV_LO; if (B.vx < 0) { B.vx = (-B.vx * E_WALL_N) >> 16; B.vy = (B.vy * E_WALL_T) >> 16; } }
      else if (B.x > CAV_HI) { B.x = CAV_HI; if (B.vx > 0) { B.vx = (-B.vx * E_WALL_N) >> 16; B.vy = (B.vy * E_WALL_T) >> 16; } }
      if (B.y > CAV_BACK1) { B.y = CAV_BACK1; if (B.vy > 0) B.vy = (-B.vy * E_WALL_N) >> 16; }
    } else if (B.y > 494000) { B.y = 494000; if (B.vy > 0) { B.w = clampI(B.w + ((B.vx * 328) >> 16), -600, 600); B.vy = (-B.vy * E_WALL_N) >> 16; B.vx = (B.vx * E_WALL_T) >> 16; ev.push({ k: 'wall', x: B.x, y: B.y }); } }
  }

  /* 进球（相位机：banner→kick 复位；cap/golden 立即收官 §2.6） */
  function goalScored(st, scoringTeam, ev, mark) {
    var B = st.ball;
    var scorer = B.lastT >= 0 ? B.lastT : -1;
    var tname = scoringTeam === 0 ? 'A' : 'B';
    st.score[tname]++;
    if (scorer >= 0 && teamOf(scorer) === scoringTeam) st.goals[scorer]++; // 乌龙不计个人账（team 计分照加）
    if (st.stats.firstGoal < 0) st.stats.firstGoal = scoringTeam;
    B.owner = -1; B.passT = -1; B.vx = 0; B.vy = 0;
    ev.push({ k: 'goal', team: tname, scorer: scorer, frame: st.tick, tickInMatch: (st.ot ? CLOCK_OT : CLOCK_REG) - st.clock });
    st.kickTeam = 1 - scoringTeam; // 被进球方开球（§1.1）
    if (st.score[tname] >= GOAL_CAP || st.ot) {
      st.pendingEnd = st.ot
        ? { winner: tname, reason: 'golden' }
        : { winner: tname, reason: 'goal-cap' };
      return;
    }
    st.phase = 'goal'; st.phaseT = 0;
    mark('ball');
  }

  /* 触球推（盘带软栓，§2.5：弹性收敛=物理域唯一外来输入） */
  function dribble(st, ev, mark) {
    var B = st.ball;
    if (B.owner < 0) return;
    var p = st.players[B.owner];
    if (!p) { B.owner = -1; ev.push({ k: 'lost', seat: -1 }); return; }
    if (d2(p.x, p.y, B.x, B.y) > LEASH * LEASH) {
      B.owner = -1;
      ev.push({ k: 'lost', seat: p.seat });
      mark('ball');
      return;
    }
    var tx = p.x + ((cosQ16(p.dir) * ANCHOR) >> 16);
    var ty = p.y + ((sinQ16(p.dir) * ANCHOR) >> 16);
    var ovx = (p.vx * 13107) >> 16; // tick 速度 → 子步（×0.2）
    var ovy = (p.vy * 13107) >> 16;
    B.vx = ovx + ((tx - B.x) * 41 >> 10); // 等效弹簧 1/25 子步
    B.vy = ovy + ((ty - B.y) * 41 >> 10);
    var v2 = B.vx * B.vx + B.vy * B.vy;
    if (v2 > VMAX * VMAX) { var sc = (VMAX * 65536 / isqrt(v2)) | 0; B.vx = (B.vx * sc) >> 16; B.vy = (B.vy * sc) >> 16; }
    B.w = clampI((B.w + (p.vx >> 2)) | 0, -600, 600); // 盘带赋滚动视觉值（§2.3）
    mark('ball');
  }

  /* =====================================================================
   * Bot 三档（§4：攻防角色分配器 BALL/OFF × 持球-防守-自由三情境；
   * rng 无状态=mulberry32(seed^seat^tick)，回放零流对账）
   * ===================================================================== */
  var BOT_EVERY = { casual: 10, balanced: 6, competitive: 4 };
  function brain(st, seat, level, _rng, _env) {
    var P = st.players[seat];
    if (!P) return { mx: 0, my: 0 };
    var out = { mx: 0, my: 0, sp: 0 };
    if (P.stumbleT > 0 || P.lungeT > 0) return out; // 扑抢/自绊期零输入（lunge 由 sim 态驱动）
    var B = st.ball;
    var own = B.owner;
    var team = seat & 1;
    var mate = seat ^ 2;
    var rng = mulberry32((st.seed ^ Math.imul(seat + 11, 0x9e3779b9) ^ (st.tick * 0x45d9f3b)) >>> 0);
    var M = st.mem[seat] || (st.mem[seat] = { dt: 0, role: 0, hys: 0 });
    var G = atkGoal(team), OG = ownGoal(team);
    var steer = function (x, y, sp, stopR) {
      stopR = stopR || 8000;
      var dx = x - P.x, dy = y - P.y, d = isqrt(dx * dx + dy * dy);
      if (d <= stopR) return 0;
      out.mx = clampI(((dx * 100) / d) | 0, -100, 100);
      out.my = clampI(((dy * 100) / d) | 0, -100, 100);
      out.sp = sp && !P.stamLock && P.stam > STAM_MIN ? 1 : 0;
      return d;
    };
    var dToB = isqrt(d2(P.x, P.y, B.x, B.y));
    var distG = isqrt(d2(B.x, B.y, G.x, G.y));
    var pm = st.players[mate];
    var foes = [];
    for (var i = 0; i < SEATS; i++) {
      if (st.players[i] && (st.players[i].team !== team)) foes.push(st.players[i]);
    }
    var nearFoe = function (x, y, r) {
      for (var j = 0; j < foes.length; j++) if (d2(x, y, foes[j].x, foes[j].y) < r * r) return foes[j];
      return null;
    };
    var angTo = function (x, y) { return atan2Q(x - B.x, y - B.y) & 8191; };
    var shoot = function (pow, jit) {
      var q = angTo(G.x, G.y);
      if (jit) q = (q + (((rng() * 2 - 1) * jit) | 0)) & 8191; // 档内散布（casual ×2.5 量级）
      out.cmd = { k: 'shot', ang: (q << 3) & 0xFFFF, pow: pow };
    };
    var tryTackle = function () { out.cmd = { k: 'tackle' }; };

    if (level === 'casual') {
      /* 蜂群（§4.2）：双人都追球；持球直冲门心；距门近即射（散布大）；偶发传球/扑抢 */
      if (own === seat) {
        if (rng() < 0.15 && pm) { out.cmd = { k: 'pass' }; return out; }
        if (distG < 90000) { shoot(400 + ((rng() * 400) | 0), 3400); return out; }
        steer(G.x, G.y);
      } else {
        steer(B.x + B.vx * 4, B.y + B.vy * 4);
        if (own >= 0 && own % 2 !== team && dToB < 20000 && rng() < 0.30) tryTackle();
      }
      return out;
    }

    /* 角色分配器（balanced/competitive 共用；competitive 用拦截预判点 §4.1） */
    if (M.dt <= 0) {
      M.dt = BOT_EVERY[level] || 6;
      var chasePt = { x: B.x, y: B.y };
      if (level === 'competitive') { // 拦截预判：chase 点=球位+球速×t 迭代 3
        var cx = B.x, cy = B.y;
        for (var it = 0; it < 3; it++) {
          var dd = isqrt(d2(P.x, P.y, cx, cy)) || 1;
          var tt = (dd / ((CLS[P.cls] || CLS.all).spd * 5)) | 0;
          cx = clampI(B.x + B.vx * 5 * tt, 6000, 344000);
          cy = clampI(B.y + B.vy * 5 * tt, 6000, 494000);
        }
        chasePt = { x: cx, y: cy };
      }
      var dMe = isqrt(d2(P.x, P.y, chasePt.x, chasePt.y));
      var dMate = pm ? isqrt(d2(pm.x, pm.y, chasePt.x, chasePt.y)) : 1 << 30;
      if (M.role === 0) {
        if (dMe > dMate + 20000) { if (++M.hys >= 2) { M.role = 1; M.hys = 0; } } else M.hys = 0;
      } else {
        if (dMate > dMe + 20000) { if (++M.hys >= 2) { M.role = 0; M.hys = 0; } } else M.hys = 0;
      }
    }
    M.dt--;

    if (own === seat) {
      /* 持球（carrier 决策表） */
      var presser = nearFoe(P.x, P.y, 30000);
      if (presser && pm && level === 'balanced') { out.cmd = { k: 'pass' }; return out; }
      if (level === 'competitive') {
        /* 期望值仲裁（§4.2）：射门质量/传球质量/带球 三算分取大；蓄力满段才射 */
        var open = !nearFoeLine(st, B.x, B.y, G.x, G.y, 26000);
        var shootQ = distG < 170000 && open ? (200000 - distG) + 60000 : -1;
        var passQ = presser && pm && !nearFoe(pm.x, pm.y, 36000)
          ? 50000 + (isqrt(d2(pm.x, pm.y, G.x, G.y)) < distG ? 60000 : 0) : -1;
        if (shootQ >= passQ && shootQ > 40000) { shoot(1000, 0); return out; }
        if (passQ > 40000) { out.cmd = { k: 'pass' }; return out; }
        steer(G.x, G.y, distG > 120000);
        return out;
      }
      if (distG < 140000 && !nearFoeLine(st, B.x, B.y, G.x, G.y, 25000)) {
        shoot(distG > 250000 ? 1000 : distG > 150000 ? 850 : 650, 0);
        return out;
      }
      steer(G.x, G.y, distG > 120000);
      return out;
    }
    if (own >= 0 && own % 2 === team && pm) {
      /* 己方持球、我是 OFF（support 表：接应线=持球者身后 60000 偏门侧） */
      var c2 = st.players[own];
      var bx = c2.x - G.x, by = c2.y - G.y, bl = isqrt(bx * bx + by * by) || 1;
      var sx2 = c2.x + ((bx / bl * 60000) | 0) + 24000 * (team === 0 ? 1 : -1);
      var sy2 = c2.y + ((by / bl * 60000) | 0);
      if (level === 'competitive') { // 战术跑位：远门柱前插（重叠跑）
        var far = { x: G.x + (team === 0 ? 1 : -1) * 42000, y: team === 0 ? 30000 : H_M - 30000 };
        steer(far.x, far.y, 1, 15000);
        return out;
      }
      steer(clampI(sx2, 15000, W_M - 15000), clampI(sy2, 15000, H_M - 15000));
      return out;
    }
    if (M.role === 0) {
      /* BALL=上抢/夺球（press/chase 表） */
      var cx2 = B.x, cy2 = B.y;
      if (own >= 0 && own % 2 !== team) {
        /* press 逼外线（§4.1）：站位=球→己门连线 70% 处（卡死带球直进门的最短路径）；
         * competitive 再叠切传线（ball→敌 mate 中点，二选一近者） */
        var px2 = B.x + (((OG.x - B.x) * 7) / 5 | 0), py2 = B.y + (((OG.y - B.y) * 7) / 5 | 0);
        if (level === 'competitive' && pm) {
          var em = st.players[own ^ 2];
          if (em) {
            var mx2 = (B.x + em.x) >> 1, my2 = (B.y + em.y) >> 1;
            if (d2(P.x, P.y, mx2, my2) < d2(P.x, P.y, px2, py2)) { px2 = mx2; py2 = my2; }
          }
        }
        cx2 = clampI(px2, 15000, W_M - 15000); cy2 = clampI(py2, 15000, H_M - 15000);
      } else if (level === 'competitive') {
        cx2 = clampI(B.x + B.vx * 8, 6000, 344000); cy2 = clampI(B.y + B.vy * 8, 6000, 494000);
      }
      steer(cx2, cy2, dToB > 60000);
      var lungeOk = level === 'competitive'
        ? (own >= 0 && own % 2 !== team && dToB < 22000 && dToB > 8000 && rng() < 0.6) // 触球节拍扑抢（近似）
        : (own >= 0 && own % 2 !== team && dToB < 20000);
      if (lungeOk && P.tackleCd <= 0) tryTackle();
      return out;
    }
    /* OFF=保护/预位（cover/anticipate 表） */
    var cov = { x: B.x + (((OG.x - B.x) * 2) / 5 | 0), y: B.y + (((OG.y - B.y) * 2) / 5 | 0) }; // 连线 40%
    var ballNearOwn = d2(B.x, B.y, OG.x, OG.y) < 170000 * 170000;
    if (ballNearOwn) { // 己方最后 1/3：门线弧站位（门心向球 45000）
      var gx = B.x - OG.x, gy = B.y - OG.y, gl = isqrt(gx * gx + gy * gy) || 1;
      cov = { x: OG.x + ((gx / gl * 45000) | 0), y: OG.y + ((gy / gl * 45000) | 0) };
    }
    if (level === 'competitive' && own < 0) { // anticipate：围板反弹预判点（反射路径采样首点）
      var rx = B.x + B.vx * 20, ry = B.y + B.vy * 20;
      if (rx < 6000) rx = 12000 - rx; if (rx > 344000) rx = 688000 - rx;
      if (ry < 6000) ry = 12000 - ry; if (ry > 494000) ry = 988000 - ry;
      cov = { x: clampI(rx, 15000, W_M - 15000), y: clampI(ry, 15000, H_M - 15000) };
    }
    steer(clampI(cov.x, 15000, W_M - 15000), clampI(cov.y, 15000, H_M - 15000), dToB > 90000);
    return out;
  }
  /* 射门锥封堵检查（线上最近敌人距线 < r 即封堵） */
  function nearFoeLine(st, x1, y1, x2, y2, r) {
    var dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
    for (var i = 0; i < SEATS; i++) {
      var p = st.players[i];
      if (!p) continue;
      var t = ((p.x - x1) * dx + (p.y - y1) * dy);
      if (t <= 0 || t >= len2) continue;
      var px = x1 + ((dx * t) / len2 | 0), py = y1 + ((dy * t) / len2 | 0);
      if (d2(px, py, p.x, p.y) < r * r) return true;
    }
    return false;
  }

  /* autopilot（A8 确定性双跑：服务器节拍 strike-rush，§6 剧本策略同式） */
  function autopilotImpl(st, seat) {
    var P = st.players[seat];
    if (!P) return { mx: 0, my: 0 };
    var B = st.ball;
    var team = seat & 1;
    var G = atkGoal(team);
    var out = { mx: 0, my: 0, sp: 0 };
    var dToB = isqrt(d2(P.x, P.y, B.x, B.y));
    var distG = isqrt(d2(B.x, B.y, G.x, G.y));
    var steer = function (x, y) {
      var dx = x - P.x, dy = y - P.y, d = isqrt(dx * dx + dy * dy) || 1;
      out.mx = clampI(((dx * 100) / d) | 0, -100, 100);
      out.my = clampI(((dy * 100) / d) | 0, -100, 100);
    };
    if (B.owner === seat) {
      var foe = null, bd = 25000 * 25000;
      for (var i = 0; i < SEATS; i++) {
        var q = st.players[i];
        if (!q || q.team === team) continue;
        var dd = d2(P.x, P.y, q.x, q.y);
        if (dd < bd) { bd = dd; foe = q; }
      }
      if (foe) { out.cmd = { k: 'pass' }; return out; }
      if (distG < 130000) {
        var q2 = atan2Q(G.x - B.x, G.y - B.y) & 8191;
        out.cmd = { k: 'shot', ang: (q2 << 3) & 0xFFFF, pow: 900 };
        return out;
      }
      steer(G.x, G.y);
      return out;
    }
    if (B.owner >= 0 && (B.owner & 1) !== team && dToB < 22000 && P.tackleCd <= 0) {
      out.cmd = { k: 'tackle' };
      return out;
    }
    steer(B.x + B.vx * 4, B.y + B.vy * 4);
    return out;
  }

  /* ---------- 确定性（serialize/hash + 回放器，A8 红线） ---------- */
  function serialize(st) {
    var ps = [];
    for (var i = 0; i < SEATS; i++) {
      var p = st.players[i];
      ps.push(p ? [p.x, p.y, p.vx, p.vy, p.dir, p.stam, p.lungeT, p.stumbleT, p.stealBan, p.tackleCd] : null);
    }
    var b = st.ball;
    /* 键字母序（红线）：ball/clock/goals/inLogN/ot/phase/phaseT/players/possSeat/score/stats/tick */
    return JSON.stringify({
      ball: [b.x, b.y, b.vx, b.vy, b.w, b.owner, b.lastT, b.passT],
      clock: st.clock, goals: st.goals, inLogN: st.inLog.length, ot: st.ot,
      phase: st.phase, phaseT: st.phaseT, players: ps, possSeat: st.possSeat,
      score: [st.score.A, st.score.B],
      stats: [st.stats.onT[0], st.stats.onT[1], st.stats.possT[0], st.stats.possT[1], st.stats.firstGoal],
      tick: st.tick,
    });
  }
  function hashState(st) { return fnv1a32(serialize(st)); }
  function hashBall(st) { // ext.hash 哨兵（每 10 张：球+全员权威态，§5.2 ②）
    var h = fnv1a32(st.tick + ':' + st.ball.x + ',' + st.ball.y + ',' + st.ball.vx + ',' + st.ball.vy + ',' + st.ball.owner);
    for (var i = 0; i < SEATS; i++) {
      var p = st.players[i];
      h = fnv1a32(h + ':' + (p ? p.x + ',' + p.y + ',' + p.dir : 'x'));
    }
    return h;
  }
  /** 回放器（A8：在线终态 == 输入日志重放）——inLog=[tick,seat,mx,my,sp,cmd?] 稀疏变更日志 */
  function replayInputs(seed, opts, inLog, maxTicks) {
    var o = Object.assign({}, opts || {}, { autopilot: false });
    var st = create(seed, o);
    var byTick = {};
    for (var e = 0; e < inLog.length; e++) {
      var t = inLog[e][0];
      (byTick[t] || (byTick[t] = [])).push(inLog[e]);
    }
    var room = { seats: [] };
    for (var i = 0; i < SEATS; i++) {
      room.seats.push({ seat: i, kind: (o.botLevels && o.botLevels[i]) ? 'bot' : (o.botLevels ? 'human' : 'bot') });
    }
    /* 宽限沿用语义（在线=rooms lastInput 持续态）：非 bot 席无新日志 tick 沿用上一条，
     * cmd 只在该 tick 生效一次——与在线逐字节等价的必要条件 */
    var hold = [{ mx: 0, my: 0, sp: 0 }, { mx: 0, my: 0, sp: 0 }, { mx: 0, my: 0, sp: 0 }, { mx: 0, my: 0, sp: 0 }];
    var lastCmd = [-1, -1, -1, -1];
    while (st.tick < (maxTicks || MAX_TICKS)) {
      var inputs = {};
      for (var s = 0; s < SEATS; s++) {
        if (room.seats[s].kind === 'bot') inputs[s] = brain(st, s, (o.botLevels && o.botLevels[s]) || 'balanced');
      }
      var list = byTick[st.tick];
      if (list) for (var q = 0; q < list.length; q++) {
        var en = list[q];
        hold[en[1]] = { mx: en[2], my: en[3], sp: en[4] };
        if (en[5]) lastCmd[en[1]] = st.tick;
      }
      for (var h = 0; h < SEATS; h++) {
        if (room.seats[h].kind === 'bot') continue;
        inputs[h] = Object.assign({}, hold[h]);
        if (lastCmd[h] === st.tick) inputs[h].cmd = byTick[st.tick].filter(function (e) { return e[1] === h && e[5]; })[0][5];
      }
      var r = step(st, inputs, room);
      if (r.over) break;
    }
    return st;
  }

  var LEVELS = ['casual', 'balanced', 'competitive'];
  var ENGINE = 'street-int-v1';
  var ENGINE_HASH = fnv1a32(ENGINE + ':' + TRIG16.join(',') + ':' + ATAN8.join(',') + ':' + [
    W_M, H_M, R_B, R_P, CATCH_R2, LEASH, ANCHOR, ATTRACT, PUSH_D, MU, V_SLIP2,
    E_WALL_N, E_WALL_T, E_POST, SPIND, VMAX, GOAL_MOUTH_LO, GOAL_MOUTH_HI,
    GOAL_CAP_Y0, GOAL_CAP_Y1, KICK_TICKS, GOAL_TICKS, CLOCK_REG, CLOCK_OT, GOAL_CAP,
    SUBS, JSON.stringify(FORM), JSON.stringify(PUSH_LUT),
  ].join(','));

  var META = {
    gameId: 'street-soccer', title: '街头足球', mode: '2v2-street', seats: SEATS,
    tickMs: TICK_MS, cmdInput: true,
    roomPrefix: 'street', // feed 字典序 …speed<street<tactics（§7 无冲突）
    takeOver: 'balanced', // 断线托管=balanced（§4.3：挂机=空门放对手）
    tech: 'S3+S4',
  };

  return {
    META: META, LEVELS: LEVELS, ENGINE: ENGINE, ENGINE_HASH: ENGINE_HASH,
    create: create, step: step, brain: brain,
    serialize: serialize, hashState: hashState, hashBall: hashBall, replayInputs: replayInputs,
    fnv1a32: fnv1a32, mulberry32: mulberry32,
    consts: {
      TICK_MS: TICK_MS, SUBS: SUBS, MAX_TICKS: MAX_TICKS, W_M: W_M, H_M: H_M,
      CLS: CLS, FORM: FORM, LEASH: LEASH, CLOCK_REG: CLOCK_REG, CLOCK_OT: CLOCK_OT,
      GOAL_CAP: GOAL_CAP, POSTS: POSTS,
    },
  };
});
