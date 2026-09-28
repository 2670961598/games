/* =====================================================================
 * 八球台球 pool-physics —— S4 服务端权威物理共享确定性模拟（GAMES-78）
 * 单一事实源：服务端（server/gateway/sims/pool-physics.js 经 require 载入本文件）
 * 与客户端（构建期内联进 index.html，设 window.PoolSim）跑同一份代码——
 * 收到 ruling.shot 即本地确定性重演，快照逐字节比对自证（设计 §5.4）。
 * 设计事实源：docs/designs/pool-physics.md（GAMES-77 评审通过版）。
 *
 * 确定性纪律（设计 §2.1/§5.4 红线清单）：
 *   - 全整数态：位置/速度 milli-px int32；算术只 + − ×(操作数整数|积|<2^53) >> |(a/b)|0；
 *   - 零 Math.* / 零 Date.now：三角用烘焙表 TRIG16/ATAN8（trig16.cjs，提交常量），
 *     开方用二分整数 isqrt；
 *   - 固定子步 S=5/子步 2ms；碰撞固定 2 轮 pairwise（对序 id 字典序）；结算序固定
 *     ①积分→②球-球×2→③库边(id 升序)→④袋检测/强制袋→⑤两相摩擦→⑥全停判定；
 *   - sim 判定路径零随机：seed 仅记录；随机只在 Bot brain（服务端 rng）与超时代打
 *     （rng=mulberry32(seed^shotNo<<16^seat)，§4）——双跑剧本依赖此性质；
 *   - serialize 键字母序；终态 hash 排除墙钟簿记（tick/timer/streak——回放不模拟等待）。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node（.cjs）
  root.PoolSim = api;                                                     // 浏览器内联（classic script）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 烘焙三角表（§2.2）：Node require / 浏览器前置内联 window.PoolTrig */
  var TRIG = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./trig16.cjs') : root.PoolTrig;
  var TRIG16 = TRIG.TRIG16, ATAN8 = TRIG.ATAN8;

  /* ---------- PRNG 参考实现（与 games/_shared/common.js 逐字一致，冻结；仅 Bot/代打用） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 常量（数值表=设计书 §2 抄录；全整数 milli 单位） ---------- */
  var SEATS = 2;
  var TICK_MS = 10;                 // 房间 tick 100Hz（§2.1 时钟）
  var SUBS = 5;                     // 每 tick 固定 5 物理子步（子步 2ms，500Hz）
  var MAX_TICKS = 48000;            // 8 分钟硬顶（§1.1）
  var AIM_TICKS = 3000;             // 回合 30s 计时（§1.2）
  var MOTION_CAP = 5000;            // 球动硬帽 5000 子步（§2.3）
  var SPIN_EXPIRE = 3000;           // 自旋 3000 子步未触发自然过期（§2.5）
  var W_M = 340000, H_M = 170000;   // 库边内沿（§2.1）
  var R = 7500;                     // 球半径 milli（7.5px）
  var D2_MIN = 15000 * 15000;       // (2r)²
  var V_SLIP2 = 120 * 120;          // 两相分界（速度²，§2.3）
  var MU = 65369;                   // 0.997452 Q16.16 乘性摩擦
  var JIMP = 64225;                 // (1+e)/2=0.98 Q16.16（e_ball=0.96）
  var CUSH_N = 53740;               // 库边法向 0.82
  var CUSH_T = 58982;               // 库边切向 0.90
  var V0_K = 183501;                // pow=1000 → V0=2800 milli/子步（§2.3）
  var SPINV_HI = 19661, SPINV_LO = -16384, SPINS_K = 9830;  // §2.5
  var CUT_CORNER = 13000, CUT_MID = 12500;                  // 袋口区（§2.4）
  var FOOT_X = 255000, FOOT_Y = 85000;                      // 置球点（§2.5）
  var CUE0_X = 85000, CUE0_Y = 85000;                       // 白球开球位
  /* 袋表（§2.5）：[x, y, R_cap] */
  var POCKETS = [
    [0, 0, 13500], [170000, -6000, 11500], [340000, 0, 13500],
    [0, 170000, 13500], [170000, 176000, 11500], [340000, 170000, 13500],
  ];
  /* 开球阵型（§2.5 固定表，零随机——附决策 9）：[id, x, y] */
  var RACK = [
    [1, 255000, 85000],
    [9, 268100, 77450], [2, 268100, 92550],
    [3, 281200, 69900], [8, 281200, 85000], [10, 281200, 100100],
    [11, 294300, 62350], [4, 294300, 77450], [5, 294300, 92550], [12, 294300, 107650],
    [6, 307400, 54800], [13, 307400, 69900], [14, 307400, 85000], [7, 307400, 100100], [15, 307400, 115200],
  ];

  var META = {
    gameId: 'pool-physics', title: '八球台球', seats: SEATS, tickMs: TICK_MS, maxTicks: MAX_TICKS,
    mode: '1v1-pool', teams: { A: [0], B: [1] },
    opInput: true,                // S5 通道：t:'op'（shot/place/concede）一次性指令（协议 §6 S5 位）
    takeOver: 'casual',           // 断线逾时托管档（§5.3：casual 随手杆代打）
    tech: 'S4',                   // 服务端权威物理 + 确定性物理首证
    roomPrefix: 'pool',           // 房间 ID 前缀（§7：feed 字典序 emp-<mmo-<net-<pool-<slg-）
    W: 375, H: 667,
  };

  /* ---------- 整数算术（§2.1 纪律：除法向零取整、零 Math） ---------- */
  function isqrt(n) {             // 二分整数开方（n ≥ 0；倍进定界+二分，同输入同轮数——确定性）
    if (n <= 0) return 0;
    var hi = 1;
    while (hi * hi <= n) hi <<= 1;   // hi² > n（≤2^20 覆盖 2.4e11，mid² < 2^53 精确）
    var lo = hi >> 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (mid * mid <= n) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }
  var sgn = function (v) { return v > 0 ? 1 : v < 0 ? -1 : 0; };
  var clampI = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  /* 角度（8192 brads/圈量化档）→ cos/sin Q16.16（象限折叠，§2.2） */
  function cosQ16(q) { q &= 8191; var i = q & 2047; switch (q >> 11) { case 0: return TRIG16[2048 - i]; case 1: return -TRIG16[i]; case 2: return -TRIG16[2048 - i]; default: return TRIG16[i]; } }
  function sinQ16(q) { q &= 8191; var i = q & 2047; switch (q >> 11) { case 0: return TRIG16[i]; case 1: return TRIG16[2048 - i]; case 2: return -TRIG16[i]; default: return -TRIG16[2048 - i]; } }
  /* 整数 atan2（屏幕系 y 向下，0=+x 顺时针为正——与 ang 上传口径一致）：→ 8192 brads */
  function atan2Q(dx, dy) {
    var ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
    var q;
    if (ax >= ay) q = ATAN8[clampI(((ay << 11) / ax) | 0, 0, 2048)];
    else q = 2048 - ATAN8[clampI(((ax << 11) / ay) | 0, 0, 2048)];
    if (dx >= 0 && dy >= 0) return q;
    if (dx < 0 && dy >= 0) return 4096 - q;
    if (dx < 0 && dy < 0) return 4096 + q;
    return 8192 - q;
  }

  /* ---------- 初始态 ---------- */
  function create(seed, opts) {
    var maxTicks = (opts && Number.isInteger(opts.maxTicks) && opts.maxTicks > 0) ? opts.maxTicks : MAX_TICKS;
    var balls = [];
    for (var i = 0; i < 16; i++) balls.push({ x: 0, y: 0, vx: 0, vy: 0, pot: 0 }); // pot: 0 活 / 1 落袋 / 2 手中（白球）
    balls[0].x = CUE0_X; balls[0].y = CUE0_Y;
    for (var k = 0; k < RACK.length; k++) { var b = RACK[k]; balls[b[0]].x = b[1]; balls[b[0]].y = b[2]; }
    return {
      v: 1, seed: (seed >>> 0), tick: 0, maxTicks: maxTicks,
      phase: 'aim',                       // aim | motion | ended
      turn: 0, aimTicks: AIM_TICKS,
      openTable: true, groups: [-1, -1],  // groups[seat]：-1 未定 / 1 全色(1-7) / 2 花色(9-15)
      ballInHand: false,
      balls: balls, potOrder: [], pottedBy: [0, 0],
      shotN: 0, shots: [],                // 输入日志（§5.4 回放=重放输入序列）
      timeouts: [0, 0], fouls: [0, 0], streak: [0, 0], bestStreak: [0, 0],
      facts: null, sub: 0, lastShot: null, restHash: 0,
      spin: null,                          // {v, s, age} 白球自旋（两轴各自首次触发即耗散，§2.5）
      over: false, result: null, pendingEnd: null,
    };
  }

  /* ---------- 终局 ---------- */
  function endGame(st, winner, reason) {
    if (st.over) return;
    st.over = true; st.phase = 'ended';
    st.pendingEnd = { winner: winner, reason: reason };
    st.result = { winner: winner, scores: { A: st.pottedBy[0], B: st.pottedBy[1] }, reason: reason };
  }

  /* ---------- 袋/库边几何（§2.4/§2.5） ---------- */
  function inMouthX(x) { return x < CUT_CORNER || x > W_M - CUT_CORNER || (x > 170000 - CUT_MID && x < 170000 + CUT_MID); }
  function inMouthY(y) { return y < CUT_CORNER || y > H_M - CUT_CORNER; }
  function tryPot(st, id, ev) {
    var b = st.balls[id];
    for (var p = 0; p < 6; p++) {
      var dx = b.x - POCKETS[p][0], dy = b.y - POCKETS[p][1];
      var d2 = dx * dx + dy * dy;
      if (d2 <= POCKETS[p][2] * POCKETS[p][2]) { potBall(st, id, p, ev); return true; }
    }
    return false;
  }
  function potBall(st, id, pocket, ev) {
    var b = st.balls[id];
    b.pot = 1; b.vx = 0; b.vy = 0;
    st.potOrder.push(id);
    st.facts.potted.push(id);
    if (id === 0) st.facts.cuePotted = true; else st.pottedBy[st.turn]++;
    if (ev) ev.push({ k: 'pot', id: id, order: st.potOrder.length, pocket: pocket });
  }
  /* 强制袋（防越线逃逸，§2.5）：球心越库边线外 >7500 仍未捕获 → 判入最近袋 */
  function forcePot(st, id, ev) {
    var b = st.balls[id], best = -1, bd2 = 0;
    for (var p = 0; p < 6; p++) {
      var dx = b.x - POCKETS[p][0], dy = b.y - POCKETS[p][1], d2 = dx * dx + dy * dy;
      if (best < 0 || d2 < bd2) { best = p; bd2 = d2; }   // 平局按袋 id 升序（< 严格，全序）
    }
    potBall(st, id, best, ev);
  }

  /* ---------- 白球自旋触发（§2.5） ---------- */
  /* 高低杆：白球首次触球，碰后 v_cue += d̂×(V_pre×Qv>>16)（d̂=碰前白球方向） */
  function applySpinV(st, cuePreVx, cuePreVy) {
    var sp = st.spin; if (!sp || sp.v === 0 || sp.vDone) return;
    sp.vDone = true;
    var v2 = cuePreVx * cuePreVx + cuePreVy * cuePreVy;
    if (v2 === 0) return;
    var v = isqrt(v2);
    var q = sp.v > 0 ? SPINV_HI : SPINV_LO;
    var mag = (v * q) >> 16;                      // 可为负（低杆拉回）
    var cue = st.balls[0];
    cue.vx += ((mag * ((cuePreVx << 16) / v)) / 65536) | 0;   // 积可达 1.5e11：禁 >>16（Int32 回绕），用 /|0
    cue.vy += ((mag * ((cuePreVy << 16) / v)) / 65536) | 0;
  }
  /* 左右塞：白球首次碰库，反弹后切向 v_t += spinS×(|v_n_pre|×9830>>16)；v_n_pre≤200 忽略 */
  function applySpinS(st, v_n_pre, axis) {        // axis: 'x'|'y'（切向分量所在轴）
    var sp = st.spin; if (!sp || sp.s === 0 || sp.sDone) return;
    sp.sDone = true;
    if (v_n_pre >= -200 && v_n_pre <= 200) return;
    var mag = (sp.s * ((v_n_pre < 0 ? -v_n_pre : v_n_pre) * SPINS_K)) >> 16;
    var cue = st.balls[0];
    if (axis === 'x') cue.vx += mag; else cue.vy += mag;
  }

  /* ---------- 单个物理子步（§2.4 结算序固定：①..⑥） ---------- */
  function subStep(st, ev) {
    var balls = st.balls, i, j, b;
    /* ① 积分 */
    for (i = 0; i < 16; i++) { b = balls[i]; if (b.pot) continue; b.x += b.vx; b.y += b.vy; }
    /* ② 球-球弹性碰撞，固定 2 轮（红线），对序 id 字典序升序 */
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < 16; i++) {
        var bi = balls[i]; if (bi.pot) continue;
        for (j = i + 1; j < 16; j++) {
          var bj = balls[j]; if (bj.pot) continue;
          var dx = bj.x - bi.x, dy = bj.y - bi.y;
          var d2 = dx * dx + dy * dy;
          if (d2 === 0 || d2 >= D2_MIN) continue;
          var d = isqrt(d2);
          var nxQ = (dx << 16) / d, nyQ = (dy << 16) / d;       // Q16.16 法向（向零截断）
          var vrel = ((bi.vx - bj.vx) * nxQ + (bi.vy - bj.vy) * nyQ) >> 16;
          if (vrel > 0) {
            /* 首触事实（§2.6）：白球参与且接近 → firstHit（自旋取碰前方向，解算后施加，§2.5） */
            var wasFirst = false;
            if (st.facts && st.facts.firstHit < 0 && (i === 0 || j === 0)) {
              st.facts.firstHit = i === 0 ? j : i;
              wasFirst = true;
            }
            var preVx = balls[0].vx, preVy = balls[0].vy;
            var jimp = (vrel * JIMP) >> 16;
            bi.vx -= (jimp * nxQ) >> 16; bi.vy -= (jimp * nyQ) >> 16;
            bj.vx += (jimp * nxQ) >> 16; bj.vy += (jimp * nyQ) >> 16;
            if (wasFirst) applySpinV(st, preVx, preVy);
          }
          var ov = 15000 - d, h = ov >> 1;                        // 位置分离（各半）
          bi.x -= (h * nxQ) >> 16; bi.y -= (h * nyQ) >> 16;
          bj.x += (h * nxQ) >> 16; bj.y += (h * nyQ) >> 16;
        }
      }
    }
    /* ③ 库边反射（id 升序；袋口区不设库，§2.4/§2.5） */
    for (i = 0; i < 16; i++) {
      b = balls[i]; if (b.pot) continue;
      var hit = 0, isCue = i === 0;
      if (b.y < R && !inMouthX(b.x)) { hit = 1; var vn0 = b.vy; b.y = 2 * R - b.y; b.vy = -((b.vy * CUSH_N) >> 16); b.vx = (b.vx * CUSH_T) >> 16; if (isCue) applySpinS(st, vn0, 'x'); }
      else if (b.y > H_M - R && !inMouthX(b.x)) { hit = 1; var vn1 = b.vy; b.y = 2 * (H_M - R) - b.y; b.vy = -((b.vy * CUSH_N) >> 16); b.vx = (b.vx * CUSH_T) >> 16; if (isCue) applySpinS(st, vn1, 'x'); }
      if (b.x < R && !inMouthY(b.y)) { hit = 1; var vn2 = b.vx; b.x = 2 * R - b.x; b.vx = -((b.vx * CUSH_N) >> 16); b.vy = (b.vy * CUSH_T) >> 16; if (isCue) applySpinS(st, vn2, 'y'); }
      else if (b.x > W_M - R && !inMouthY(b.y)) { hit = 1; var vn3 = b.vx; b.x = 2 * (W_M - R) - b.x; b.vx = -((b.vx * CUSH_N) >> 16); b.vy = (b.vy * CUSH_T) >> 16; if (isCue) applySpinS(st, vn3, 'y'); }
      if (hit && st.facts && st.facts.firstHit >= 0) st.facts.anyCushionAfter = true;   // F4 判据：首触后（§1.3）
    }
    /* ④ 袋检测/强制袋 */
    for (i = 0; i < 16; i++) {
      b = balls[i]; if (b.pot) continue;
      if (!tryPot(st, i, ev)) {
        if (b.x < -R || b.x > W_M + R || b.y < -R || b.y > H_M + R) forcePot(st, i, ev);
      }
    }
    /* ⑤ 两相摩擦衰减（§2.3：快相乘性管距离 / 慢相减性管收尾） */
    for (i = 0; i < 16; i++) {
      b = balls[i]; if (b.pot) continue;
      if (b.vx * b.vx + b.vy * b.vy > V_SLIP2) { b.vx = (b.vx * MU) >> 16; b.vy = (b.vy * MU) >> 16; }
      else { if (b.vx !== 0) b.vx -= sgn(b.vx); if (b.vy !== 0) b.vy -= sgn(b.vy); }
    }
    /* ⑥ 自旋老化（3000 子步未触发自然过期，§2.5） */
    if (st.spin && ++st.spin.age >= SPIN_EXPIRE) st.spin = null;
  }

  function allStopped(st) {
    for (var i = 0; i < 16; i++) { var b = st.balls[i]; if (b.pot) continue; if (b.vx !== 0 || b.vy !== 0) return false; }
    return true;
  }

  /* ---------- 出杆（sanitize + 击球；人类 op / Bot inputs / 超时代打共用） ---------- */
  function strike(st, seat, shot) {
    var ang = (((shot.ang | 0) & 0xFFFF) >> 3) << 3;             // 量化 0.044°（§2.2 精度即协议）
    var q = ang >> 3;                                             // 8192 brads 档
    var pow = clampI(shot.pow | 0, 0, 1000);
    var spinV = shot.spinV === 1 || shot.spinV === -1 ? shot.spinV : 0;
    var spinS = shot.spinS === 1 || shot.spinS === -1 ? shot.spinS : 0;
    var V0 = (pow * V0_K) >> 16;
    var cue = st.balls[0];
    var rec = {
      frame: st.tick, no: st.shotN + 1, seat: seat, ang: ang, pow: pow, spinV: spinV, spinS: spinS,
      cue: { x: cue.x, y: cue.y },
    };
    st.shotN++; st.shots.push(rec); st.lastShot = rec;
    st.facts = { firstHit: -1, anyCushionAfter: false, potted: [], cuePotted: false, ownBefore: ownRemaining(st, seat) };
    st.spin = (spinV !== 0 || spinS !== 0) ? { v: spinV, s: spinS, vDone: false, sDone: false, age: 0 } : null;
    cue.vx = (V0 * cosQ16(q)) >> 16;
    cue.vy = (V0 * sinQ16(q)) >> 16;
    st.phase = 'motion'; st.sub = 0;
    st.timeouts[seat] = 0;
    return rec;
  }

  /* ---------- 规则（§1.3）：组别/剩余 ---------- */
  var groupOf = function (id) { return id >= 1 && id <= 7 ? 1 : id >= 9 && id <= 15 ? 2 : 0; };
  function ownRemaining(st, seat) {
    var g = st.groups[seat];
    if (g !== 1 && g !== 2) return 99;                            // 开放局：未定组视作未清空
    var n = 0;
    for (var i = 1; i <= 15; i++) if (groupOf(i) === g && !st.balls[i].pot) n++;
    return n;
  }
  function liveOfGroup(st, g) {
    var out = [];
    for (var i = 1; i <= 15; i++) if (groupOf(i) === g && !st.balls[i].pot) out.push(i);
    return out;
  }

  /* ---------- 结算（§1.3：分色/F1-F4/胜负/续杆换人） ---------- */
  function resolveShot(st, ev) {
    st.phase = 'aim';
    var seat = st.turn, foe = 1 - seat, f = st.facts, shot = st.lastShot;
    var eight = f.potted.indexOf(8) >= 0;
    /* 犯规判定（判据全部来自 sim 事实账本 §2.6） */
    var foul = null;
    if (f.cuePotted) foul = 'F1';
    else if (f.firstHit < 0) foul = 'F2';
    else if (st.openTable) { if (f.firstHit === 8) foul = 'F3'; }                     // 开放局首触 8 同罪
    else if (f.firstHit === 8) { if (f.ownBefore !== 0) foul = 'F3'; }                // 己组未清完首触 8
    else if (groupOf(f.firstHit) !== st.groups[seat] || f.ownBefore === 0) foul = 'F3'; // 错组首触 / 清完仍触彩球
    else if (!f.anyCushionAfter && f.potted.length === 0) foul = 'F4';
    /* 黑八分支（胜负 1/2，§1.3） */
    if (eight) {
      if (shot.no === 1) {
        /* 例外：破球杆 8 落袋 = 重置置球点（x−15100 步进至空位），不判负 */
        var x = FOOT_X, y = FOOT_Y;
        for (;;) {
          var occupied = false;
          for (var i = 0; i < 16; i++) { if (i === 8 || st.balls[i].pot) continue; var dx = st.balls[i].x - x, dy = st.balls[i].y - y; if (dx * dx + dy * dy < D2_MIN) { occupied = true; break; } }
          if (!occupied) break;
          x -= 15100; if (x < R) x += W_M - 2 * R;
        }
        var b8 = st.balls[8]; b8.pot = 0; b8.x = x; b8.y = y; b8.vx = 0; b8.vy = 0;
        var oi = st.potOrder.indexOf(8); if (oi >= 0) st.potOrder.splice(oi, 1);
        var fi = f.potted.indexOf(8); if (fi >= 0) f.potted.splice(fi, 1);
        st.pottedBy[seat]--;                                     // 重置不计分
        ev.push({ k: 'respot', id: 8 });
      } else {
        if (f.ownBefore === 0 && !foul) { endGame(st, seat === 0 ? 'A' : 'B', 'eight-ball'); return; }
        endGame(st, foe === 0 ? 'A' : 'B', 'early-eight'); return;
      }
    }
    /* 定色：开放局首次目标球落袋（同杆双类型按落袋顺序第一颗，§1.3） */
    if (st.openTable) {
      for (var k = 0; k < f.potted.length; k++) {
        var pid = f.potted[k], g = groupOf(pid);
        if (g === 0) continue;
        st.groups[seat] = g; st.groups[foe] = g === 1 ? 2 : 1; st.openTable = false;
        ev.push({ k: 'assign', seat: seat, group: g });
        break;
      }
    }
    /* 犯规 → 对方 ball-in-hand（§1.2） */
    if (foul) {
      st.fouls[seat]++;
      st.ballInHand = true;
      if (f.cuePotted) st.balls[0].pot = 2;                       // 白球离台，待对方放置
      st.turn = foe; st.aimTicks = AIM_TICKS;
      ev.push({ k: 'foul', seat: seat, why: foul });
      ev.push({ k: 'ballinhand', seat: foe });
      ev.push({ k: 'turn', seat: foe });
      st.streak[seat] = 0;
      return;
    }
    /* 续杆/换人：打进己组球续杆 */
    var cont = false;
    for (var m = 0; m < f.potted.length; m++) {
      var q2 = f.potted[m];
      if (q2 !== 8 && groupOf(q2) === st.groups[seat]) cont = true;
    }
    if (cont) { st.streak[seat]++; if (st.streak[seat] > st.bestStreak[seat]) st.bestStreak[seat] = st.streak[seat]; }
    else { st.streak[seat] = 0; st.turn = foe; ev.push({ k: 'turn', seat: foe }); }
    st.aimTicks = AIM_TICKS;
  }

  /* ---------- op 通道（S5：shot/place/concede；服务器权威校验） ---------- */
  function applyOp(st, seat, msg) {
    if (st.over) return { ok: false };
    var k = msg && msg.k;
    if (k === 'concede') { endGame(st, (1 - seat) === 0 ? 'A' : 'B', 'resign'); return { ok: true, ended: true }; }
    if (k === 'place') {
      if (st.phase !== 'aim' || seat !== st.turn || !st.ballInHand) return { ok: false, reject: 'not-ballinhand' };
      var x = msg.x | 0, y = msg.y | 0;
      if (x < R || x > W_M - R || y < R || y > H_M - R) return { ok: false, reject: 'out-of-bounds' };
      for (var p = 0; p < 6; p++) {
        var pdx = x - POCKETS[p][0], pdy = y - POCKETS[p][1];
        if (pdx * pdx + pdy * pdy <= POCKETS[p][2] * POCKETS[p][2]) return { ok: false, reject: 'on-pocket' };
      }
      for (var i = 1; i <= 15; i++) {
        if (st.balls[i].pot) continue;
        var dx = st.balls[i].x - x, dy = st.balls[i].y - y;
        if (dx * dx + dy * dy < 15001 * 15001) return { ok: false, reject: 'overlap' };
      }
      var cue = st.balls[0];
      cue.x = x; cue.y = y; cue.vx = 0; cue.vy = 0; cue.pot = 0;
      st.ballInHand = false;
      return { ok: true, placed: true };
    }
    if (k === 'shot') {
      if (st.phase !== 'aim' || seat !== st.turn) return { ok: false, reject: 'not-your-turn' };
      if (st.ballInHand || st.balls[0].pot) return { ok: false, reject: 'ball-in-hand' };
      var rec = strike(st, seat, msg);
      return { ok: true, shot: rec };
    }
    return { ok: false, reject: 'unknown-op' };
  }

  /* ---------- 每 tick 推进（房间 10ms；motion 期每 tick 固定 5 子步） ---------- */
  function step(st, inputs) {
    var r = { events: [] };
    if (st.over) { r.over = true; r.result = st.result; return r; }
    st.tick++;
    /* 硬顶：超时剩球少者胜（§1.3 胜负 3） */
    if (st.tick >= st.maxTicks) {
      var remA = timeoutRemaining(st, 0), remB = timeoutRemaining(st, 1);
      endGame(st, remA < remB ? 'A' : remB < remA ? 'B' : 'draw', 'timeout');
      r.over = true; r.result = st.result; r.ended = st.result;
      return r;
    }
    if (st.phase === 'aim') {
      /* Bot 出杆/放球（inputs[seat].op——与真人 op 同一 applyOp 校验通道，零特例） */
      var inp = inputs && inputs[st.turn];
      if (inp && inp.op && (inp.op.k === 'shot' || inp.op.k === 'place')) {
        var pr = applyOp(st, st.turn, inp.op);
        if (pr.ok && pr.shot) {
          r.ruling = true; r.shot = pr.shot; r.events.push({ k: 'shot', seat: st.turn, no: pr.shot.no });
        } else if (pr.ok && pr.placed) {
          r.ruling = true; r.events.push({ k: 'place', seat: st.turn, x: st.balls[0].x, y: st.balls[0].y });
        }
        return r;
      }
      st.aimTicks--;
      if (st.aimTicks <= 0) {
        /* 30s 超时：casual 随手杆代打；连续 3 次 → afk 认负（§1.2/§4.2） */
        st.timeouts[st.turn]++;
        if (st.timeouts[st.turn] >= 3) {
          endGame(st, (1 - st.turn) === 0 ? 'A' : 'B', 'afk');
          r.over = true; r.result = st.result; r.ended = st.result;
          return r;
        }
        var rng = mulberry32(((st.seed ^ (st.shotN << 16) ^ (st.turn * 0x9e37)) >>> 0));
        var auto = timeoutShot(st, st.turn, rng);
        var savedStreak = st.timeouts[st.turn];      // 代打不豁免连击（§1.2：连续 3 次超时才 afk）
        var rec2 = strike(st, st.turn, auto);
        st.timeouts[st.turn] = savedStreak;
        r.ruling = true; r.shot = rec2;
        r.events.push({ k: 'timeout-shot', seat: st.turn, no: rec2.no });
        return r;
      }
      return r;
    }
    if (st.phase === 'motion') {
      var ev = [];
      for (var s = 0; s < SUBS; s++) subStep(st, ev);
      st.sub += SUBS;
      var settled = allStopped(st);
      if (settled || st.sub >= MOTION_CAP) {
        if (!settled) for (var i = 0; i < 16; i++) { var b = st.balls[i]; if (!b.pot) { b.vx = 0; b.vy = 0; } }
        var rev = [];
        for (var e2 = 0; e2 < ev.length; e2++) rev.push(ev[e2]);
        resolveShot(st, rev);
        st.restHash = hashRules(st);           // 结算里程碑快照（A6 回放比对锚，§5.4）
        r.events = rev; r.ruling = true; r.resolve = true;
        if (st.over) { r.over = true; r.result = st.result; r.ended = st.result; }
      } else {
        r.events = ev;
        r.motion = true;
        r.snapDue = (st.sub % 50 === SUBS);                       // 10Hz 追帧（每 10 tick 一张，§5.2）
      }
      return r;
    }
    return r;
  }
  /* 超时裁定口径（§1.3）：定色后比己组剩球；开放局比总剩球（进球多者剩得少——
   * 全桌剩球对双方同值，以各席进球数破平，仍平则 draw） */
  function timeoutRemaining(st, seat) {
    if (!st.openTable) return ownRemaining(st, seat);
    var live = 0;
    for (var i = 1; i <= 15; i++) if (!st.balls[i].pot) live++;
    return live - st.pottedBy[seat] * 2;                          // 进球多者"剩得少"（确定性口径）
  }

  /* ---------- 公共投影（ruling.state / welcome.state 即全量 state 本身，§5.2 静止期事件驱动） ---------- */
  function serialize(st) {
    /* 键字母序 canonical（§5.4 红线）；排除墙钟簿记 tick/aimTicks/timeouts/streak（回放不模拟等待） */
    var balls = [];
    for (var i = 0; i < 16; i++) { var b = st.balls[i]; balls.push([b.pot, b.vx, b.vy, b.x, b.y]); }
    var o = {
      ballInHand: st.ballInHand ? 1 : 0,
      balls: balls,
      groups: [st.groups[0], st.groups[1]],
      openTable: st.openTable ? 1 : 0,
      over: st.over ? 1 : 0,
      phase: st.over ? 'ended' : st.phase,
      potOrder: st.potOrder.slice(),
      pottedBy: [st.pottedBy[0], st.pottedBy[1]],
      result: st.result ? { reason: st.result.reason, winner: st.result.winner } : null,
      seed: st.seed,
      shotN: st.shotN,
      turn: st.turn,
      v: 1,
    };
    return JSON.stringify(o);
  }
  function hashState(st) { return fnv1a32(serialize(st)); }
  /* 规则态 canonical（A6 回放比对口径）：只含 strike+resolve 可复现的字段——
   * 不含 over/phase/result（timeout 可在球动中硬切断、afk 在 aim 冻结，均属
   * shot 日志表达力之外的终局元数据）与 ballInHand 后续放置（无 strike 跟随时）。
   * 在线侧在每次 motion 结算后快照 restHash，回放终态与本值相等即确定性证明。 */
  function serializeRules(st) {
    var balls = [];
    for (var i = 0; i < 16; i++) { var b = st.balls[i]; balls.push([b.pot, b.vx, b.vy, b.x, b.y]); }
    return JSON.stringify({
      ballInHand: st.ballInHand ? 1 : 0,
      balls: balls,
      groups: [st.groups[0], st.groups[1]],
      openTable: st.openTable ? 1 : 0,
      potOrder: st.potOrder.slice(),
      pottedBy: [st.pottedBy[0], st.pottedBy[1]],
      seed: st.seed,
      shotN: st.shotN,
      turn: st.turn,
      v: 1,
    });
  }
  function hashRules(st) { return fnv1a32(serializeRules(st)); }

  /* ---------- 回放器（§5.4：回放=重放输入序列；不重跑 Bot） ----------
   * 返回终态：hashRules(replay) 应与在线 st.restHash（最后一次结算快照）相等——
   * shot 之外到达的终局（timeout 硬顶/afk/abandon）与无 strike 跟随的 ball-in-hand
   * 放置不改变结算里程碑，故两侧口径天然对齐。 */
  function replayShots(seed, shots, maxTicks) {
    var st = create(seed, { maxTicks: maxTicks });
    for (var i = 0; i < shots.length; i++) {
      var sh = shots[i];
      var cue = st.balls[0];
      cue.x = sh.cue.x; cue.y = sh.cue.y; cue.vx = 0; cue.vy = 0;
      if (cue.pot) cue.pot = 0;       // ball-in-hand 放置/F1 离台复位均隐含在 cue 位
      st.ballInHand = false;
      st.turn = sh.seat;
      strike(st, sh.seat, sh);
      /* motion 逐 tick 推进至全停/结算（与在线同一条 step 路径） */
      var guard = 0;
      while (st.phase === 'motion' && !st.over && guard++ < 4000) step(st, null);
      if (st.over) break;
    }
    return st;
  }

  /* =====================================================================
   * Bot 三档（§4：几何解析瞄准 + competitive 前瞻双轨；整数纪律同守）
   * ===================================================================== */
  var botMems = new (typeof WeakMap !== 'undefined' ? WeakMap : Object)();
  function memOf(st, seat) {
    var m = botMems.get(st);
    if (!m) { m = {}; botMems.set(st, m); }
    if (!m[seat]) m[seat] = { turnKey: '', fireAt: -1 };
    return m[seat];
  }
  /* 单位向量（brads → cos/sin Q16.16） */
  function unitTo(ax, ay, bx, by) { return atan2Q(bx - ax, by - ay); }

  /* 通路检查：线段每 7500 采样，任一他球距 <15000 → 堵死（§4.1） */
  function pathClear(st, x1, y1, x2, y2, ignore) {
    var dx = x2 - x1, dy = y2 - y1;
    var d = isqrt(dx * dx + dy * dy);
    if (d === 0) return true;
    var steps = (d / 7500) | 0;
    for (var s = 1; s <= steps; s++) {
      var px = x1 + (((dx * s) / steps) | 0), py = y1 + (((dy * s) / steps) | 0);
      for (var i = 0; i < 16; i++) {
        if (i === 0 || i === ignore || st.balls[i].pot) continue;
        var qx = st.balls[i].x - px, qy = st.balls[i].y - py;
        if (qx * qx + qy * qy < D2_MIN) return false;
      }
    }
    return true;
  }
  /* 候选生成（§4.1 ghost ball 反射几何）：己组活球 × 6 袋 */
  function candidates(st, seat, groupBalls) {
    var cue = st.balls[0], out = [];
    for (var bi = 0; bi < groupBalls.length; bi++) {
      var id = groupBalls[bi], b = st.balls[id];
      for (var p = 0; p < 6; p++) {
        var px = POCKETS[p][0], py = POCKETS[p][1];
        var aBP = atan2Q(px - b.x, py - b.y);                     // b→p 方向
        var gx = b.x - ((15000 * cosQ16(aBP)) >> 16);             // ghost = b − dir×15000
        var gy = b.y - ((15000 * sinQ16(aBP)) >> 16);
        if (gx < R || gx > W_M - R || gy < R || gy > H_M - R) continue;
        var ang = atan2Q(gx - cue.x, gy - cue.y);                 // cue→ghost 瞄准角（brads→<<3 上传）
        /* 切角可行性：cos_cut ≥ 16384（≤75°）——积 65536²=2^32 会 Int32 回绕，禁 >>16 */
        var cut = ((cosQ16(aBP) * cosQ16(ang) + sinQ16(aBP) * sinQ16(ang)) / 65536) | 0;
        if (cut < 16384) continue;
        if (!pathClear(st, cue.x, cue.y, gx, gy, id)) continue;
        if (!pathClear(st, b.x, b.y, px, py, id)) continue;
        var dcg2 = (b.x - cue.x) * (b.x - cue.x) + (b.y - cue.y) * (b.y - cue.y);
        var dbp2 = (px - b.x) * (px - b.x) + (py - b.y) * (py - b.y);
        var score = (((cut * cut) / 1048576) | 0) - (isqrt(dcg2) >> 20) - (isqrt(dbp2) >> 19);
        out.push({ id: id, pocket: p, ang: ang, cut: cut, dcg: isqrt(dcg2), dbp: isqrt(dbp2), score: score });
      }
    }
    out.sort(function (a, b) { return b.score - a.score || a.id - b.id || a.pocket - b.pocket; });  // 全序
    return out;
  }
  function powHeur(c) {
    /* 力度启发 = clamp(250 + (dist_cg + dist_bp/cos_cut)×3/2¹², 150, 900)（§4.1） */
    var term = c.dcg + (((c.dbp * 64) / (c.cut >> 10)) | 0);
    return clampI(250 + ((term * 3) >> 12), 150, 900);
  }
  function bradsNoise(rng, span) { return (((rng() * 2 - 1) * span) | 0); }

  /* 超时代打 / casual 随手杆人格（§4.2：best 候选 ±800 brads 噪声 pow 500——超时口径；
   * casual 席=候选池随机挑一 ±2000 brads） */
  function timeoutShot(st, seat, rng) {
    var g = st.groups[seat];
    var balls = st.openTable ? allLive(st) : liveOfGroup(st, g === 1 || g === 2 ? g : 1);
    if (ownRemaining(st, seat) === 0) balls = [8];
    var cands = candidates(st, seat, balls.length ? balls : allLive(st));
    if (!cands.length) {
      var near = nearestBall(st);
      return { ang: (unitTo(st.balls[0].x, st.balls[0].y, st.balls[near].x, st.balls[near].y) << 3), pow: 500, spinV: 0, spinS: 0 };
    }
    var c = cands[0];
    return { ang: ((c.ang + 800 * (rng() < 0.5 ? -1 : 1)) << 3) & 0xFFFF, pow: 500, spinV: 0, spinS: 0 };
  }
  function allLive(st) {
    var out = [];   // 开放局候选池：全体 1-15 除 8（首触 8 = F3，落 8 = early-eight，§1.3）
    for (var i = 1; i <= 15; i++) if (i !== 8 && !st.balls[i].pot) out.push(i);
    return out;
  }
  function nearestBall(st) {
    var cue = st.balls[0], best = -1, bd = 0;
    for (var i = 1; i <= 15; i++) {
      if (i === 8 || st.balls[i].pot) continue;
      var dx = st.balls[i].x - cue.x, dy = st.balls[i].y - cue.y, d2 = dx * dx + dy * dy;
      if (best < 0 || d2 < bd) { best = i; bd = d2; }
    }
    return best < 0 ? 8 : best;   // 只剩 8（清色局）
  }

  /* brain（§4.2 三档；决策时机=tick 相对（确定性），rng=席位 rng） */
  function brain(st, seat, level, rng) {
    if (st.over || st.phase !== 'aim' || st.turn !== seat) return null;
    if (st.ballInHand || st.balls[0].pot) {
      /* ball-in-hand 放置：网格 12×6 采样取静态评分最高位（§4.2） */
      var bestX = -1, bestY = -1, bestScore = -2147483648;
      var g = st.groups[seat], pool = st.openTable ? allLive(st) : liveOfGroup(st, g === 1 || g === 2 ? g : 1);
      if (ownRemaining(st, seat) === 0) pool = st.balls[8].pot ? [] : [8];
      var cands0 = pool.length ? candidates(st, seat, pool) : [];
      for (var gx = 1; gx <= 12; gx++) {
        for (var gy = 1; gy <= 6; gy++) {
          var x = ((W_M - 2 * R) * gx / 13 + R) | 0, y = ((H_M - 2 * R) * gy / 7 + R) | 0;
          var legal = true;
          for (var p = 0; p < 6; p++) { var pdx = x - POCKETS[p][0], pdy = y - POCKETS[p][1]; if (pdx * pdx + pdy * pdy <= POCKETS[p][2] * POCKETS[p][2]) { legal = false; break; } }
          if (!legal) continue;
          for (var q = 1; q <= 15; q++) { if (st.balls[q].pot) continue; var qx = st.balls[q].x - x, qy = st.balls[q].y - y; if (qx * qx + qy * qy < 15001 * 15001) { legal = false; break; } }
          if (!legal) continue;
          var sc = placeScore(st, x, y, cands0);
          if (bestX < 0 || sc > bestScore) { bestScore = sc; bestX = x; bestY = y; }
        }
      }
      if (bestX >= 0) return { op: { k: 'place', x: bestX, y: bestY } };
      return { op: { k: 'place', x: CUE0_X, y: CUE0_Y } };
    }
    var mem = memOf(st, seat);
    var key = st.shotN + ':' + st.turn + ':' + st.phase;
    if (mem.turnKey !== key) {
      mem.turnKey = key;
      var delay = level === 'casual' ? 50 + ((rng() * 100) | 0) : level === 'balanced' ? 100 + ((rng() * 100) | 0) : 200 + ((rng() * 100) | 0);
      mem.fireAt = st.tick + delay;
      mem.plan = null;
      return null;
    }
    if (st.tick < mem.fireAt) return null;
    /* 破球杆（shotN===0：第一杆） */
    if (st.shotN === 0) {
      var apex = st.balls[1];
      var bang = unitTo(st.balls[0].x, st.balls[0].y, apex.x, apex.y);
      if (level === 'casual') return { op: { k: 'shot', ang: ((bang + bradsNoise(rng, 2700)) << 3) & 0xFFFF, pow: 1000, spinV: 0, spinS: 0 } };
      if (level === 'balanced') return { op: { k: 'shot', ang: (bang << 3) & 0xFFFF, pow: 1000, spinV: 0, spinS: 0 } };
      return { op: { k: 'shot', ang: ((bang + (rng() < 0.5 ? -800 : 800)) << 3) & 0xFFFF, pow: 1000, spinV: 1, spinS: 0 } };
    }
    /* 候选池 */
    var g2 = st.groups[seat];
    var pool2 = st.openTable ? allLive(st) : liveOfGroup(st, g2 === 1 || g2 === 2 ? g2 : 1);
    if (!st.openTable && ownRemaining(st, seat) === 0 && !st.balls[8].pot) pool2 = [8];
    var cands = candidates(st, seat, pool2);
    if (level === 'casual') {
      if (!cands.length) { var n1 = nearestBall(st); return { op: { k: 'shot', ang: (unitTo(st.balls[0].x, st.balls[0].y, st.balls[n1].x, st.balls[n1].y) << 3) & 0xFFFF, pow: 300 + ((rng() * 500) | 0), spinV: 0, spinS: 0 } }; }
      var pick = cands[(rng() * cands.length) | 0];
      return { op: { k: 'shot', ang: ((pick.ang + bradsNoise(rng, 2000)) << 3) & 0xFFFF, pow: 300 + ((rng() * 500) | 0), spinV: 0, spinS: 0 } };
    }
    if (!cands.length) {
      /* 无候选：安全球（§4.2——competitive 轻杆贴库留位） */
      var n2 = nearestBall(st);
      var safeAng = unitTo(st.balls[0].x, st.balls[0].y, st.balls[n2].x, st.balls[n2].y);
      return { op: { k: 'shot', ang: ((safeAng + bradsNoise(rng, level === 'competitive' ? 40 : 160)) << 3) & 0xFFFF, pow: 250, spinV: 0, spinS: 0 } };
    }
    if (level === 'balanced') {
      var c1 = cands[0];
      return { op: { k: 'shot', ang: ((c1.ang + bradsNoise(rng, 160)) << 3) & 0xFFFF, pow: powHeur(c1), spinV: 0, spinS: 0 } };
    }
    /* competitive：静态 top-6 进前瞻（§4.3：scratch 副本合法，≤16 次硬帽） */
    if (!mem.plan) {
      mem.plan = lookahead(st, seat, cands.slice(0, 6));
    }
    var best = mem.plan;
    var noise = best.fromLookahead ? 40 : 160;
    return { op: { k: 'shot', ang: ((best.ang + bradsNoise(rng, noise)) << 3) & 0xFFFF, pow: best.pow, spinV: best.spinV, spinS: 0 } };
  }

  /* 放置位静态评分：以放置位为 cue 重算候选最优 score（越大越好） */
  function placeScore(st, x, y, cands0) {
    var g = st.groups[st.turn];
    var pool = st.openTable ? allLive(st) : liveOfGroup(st, g === 1 || g === 2 ? g : 1);
    var saved = { x: st.balls[0].x, y: st.balls[0].y };
    st.balls[0].x = x; st.balls[0].y = y;
    var cs = candidates(st, st.turn, pool);
    st.balls[0].x = saved.x; st.balls[0].y = saved.y;
    return cs.length ? cs[0].score : -100000;
  }

  /* 前瞻（§4.3）：克隆 scratch、跑确定性引擎至全停、按公式打分；≤2 变体×≤6 候选 */
  function lookahead(st, seat, cands) {
    var own = ownRemaining(st, seat);
    var best = null, bestScore = -2147483648;
    var sims = 0;
    for (var ci = 0; ci < cands.length && sims < 16; ci++) {
      var variants = [0, -0.1, 0.1];                              // {启发, −10%, +10%}（§4.2）
      for (var vi = 0; vi < variants.length && sims < 16; vi++) {
        var c = cands[ci];
        var pow = clampI((powHeur(c) * (1 + variants[vi])) | 0, 100, 1000);
        var spinV = 0;
        if (own === 0) { /* 打 8 杆：长台直线低杆防跟进、贴库球高杆（两规则，整数判定） */
          var cueB = st.balls[0], tgt = st.balls[c.id];
          var straightish = c.cut > 58000;
          spinV = straightish && c.dcg > 200000 ? -1 : (tgt.y < 30000 || tgt.y > 140000 ? 1 : 0);
        }
        var scratch = cloneForSim(st);
        strike(scratch, seat, { ang: (c.ang << 3), pow: pow, spinV: spinV, spinS: 0 });
        var guard = 0;
        var pev = [];
        while (scratch.phase === 'motion' && !scratch.over && guard++ < 1100) stepScratch(scratch, pev);
        var score = 0;
        score += 1000 * (scratch.pottedBy[seat] - st.pottedBy[seat]);   // 己方进球数（开放局同样计）
        if (scratch.facts.cuePotted) score -= 800;
        if (scratch.facts.potted.indexOf(8) >= 0 && own !== 0) score -= 600;
        /* 下一杆质量：终局静态评分最优值；无候选=−200 */
        var pool2 = scratch.groups[seat] === -1 ? allLive(scratch) : liveOfGroup(scratch, scratch.groups[seat]);
        if (ownRemaining(scratch, seat) === 0 && !scratch.balls[8].pot) pool2 = [8];
        var next = candidates(scratch, seat, pool2);
        score += next.length ? clampI(next[0].score, -200, 200) : -200;
        /* 走位分：白球到下一目标平均距离的负值/2^15 */
        if (next.length) {
          var dsum = 0;
          for (var ni = 0; ni < next.length && ni < 3; ni++) dsum += next[ni].dcg;
          score -= (dsum / (next.length > 3 ? 3 : next.length)) >> 15;
        }
        sims++;
        if (best === null || score > bestScore) { bestScore = score; best = { ang: c.ang, pow: pow, spinV: spinV, spinS: 0, fromLookahead: true }; }
      }
    }
    if (best === null) { var c0 = cands[0]; best = { ang: c0.ang, pow: powHeur(c0), spinV: 0, spinS: 0, fromLookahead: false }; }
    return best;
  }
  function pottedOwn(st, seat, g) {
    var n = 0;
    if (g !== 1 && g !== 2) return 0;
    for (var i = 1; i <= 15; i++) if (groupOf(i) === g && st.balls[i].pot) n++;
    return n;
  }
  /* scratch 副本：只克隆物理/规则态（facts/spin 重建；簿记字段不需要） */
  function cloneForSim(st) {
    var balls = [];
    for (var i = 0; i < 16; i++) { var b = st.balls[i]; balls.push({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, pot: b.pot }); }
    var c = {
      v: 1, seed: st.seed, tick: st.tick, maxTicks: st.maxTicks,
      phase: st.phase, turn: st.turn, aimTicks: st.aimTicks,
      openTable: st.openTable, groups: [st.groups[0], st.groups[1]], ballInHand: false,
      balls: balls, potOrder: st.potOrder.slice(), pottedBy: [st.pottedBy[0], st.pottedBy[1]],
      shotN: st.shotN, shots: [], timeouts: [0, 0], fouls: [0, 0], streak: [0, 0], bestStreak: [0, 0],
      facts: null, sub: 0, lastShot: null, spin: null, over: false, result: null, pendingEnd: null,
    };
    return c;
  }
  /* scratch 推进：与在线同一条 step（无 bot 输入） */
  function stepScratch(st, pev) { return step(st, null); }

  var LEVELS = ['casual', 'balanced', 'competitive'];

  /* 物理引擎版本 hash（welcome.room.physics：fnv1a32(TRIG16+ATAN8+常量表 JSON)，§5.1） */
  var ENGINE = 'pool-int-v1';
  var ENGINE_HASH = fnv1a32(ENGINE + ':' + TRIG16.join(',') + ':' + ATAN8.join(',') + ':' +
    [R, W_M, H_M, MU, JIMP, CUSH_N, CUSH_T, V0_K, V_SLIP2, MOTION_CAP, SUBS, CUT_CORNER, CUT_MID].join(','));

  return {
    META: META, LEVELS: LEVELS, ENGINE: ENGINE, ENGINE_HASH: ENGINE_HASH,
    create: create, step: step, applyOp: applyOp, strike: strike,
    serialize: serialize, hashState: hashState, serializeRules: serializeRules, hashRules: hashRules, replayShots: replayShots,
    brain: brain, fnv1a32: fnv1a32, mulberry32: mulberry32,
    _dbg: { candidates: candidates, pathClear: pathClear, atan2Q: atan2Q, cosQ16: cosQ16, sinQ16: sinQ16 },
    consts: {
      TICK_MS: TICK_MS, SUBS: SUBS, MAX_TICKS: MAX_TICKS, AIM_TICKS: AIM_TICKS, MOTION_CAP: MOTION_CAP,
      R: R, W_M: W_M, H_M: H_M, MU: MU, V_SLIP2: V_SLIP2, POCKETS: POCKETS, RACK: RACK,
      FOOT_X: FOOT_X, FOOT_Y: FOOT_Y, CUE0: { x: CUE0_X, y: CUE0_Y },
    },
  };
});
