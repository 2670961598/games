/* =====================================================================
 * 钢铁洪流 iron-torrent —— S4 预测弹道（连续预测+离散段重演组合）共享确定性
 * 模拟（GAMES-146）。单一事实源：服务端（server/gateway/sims/iron-torrent.js
 * require 本文件）与回放器（api-check A7 输入日志重放）跑同一份代码。
 * 设计事实源：docs/designs/iron-torrent.md（GAMES-145 评审通过版）——数值表 §2
 * 直接对书；S4 状态归属表 §5.1；弹道结算序 §2.3 末/§5.3。
 *
 * S4 两半拼合（设计附决策 1）：
 *   - 坦克位/车体向/炮塔角=状态域（tick=50ms 步进，客户端连续预测-和解，kart 范式）；
 *   - 弹丸=物理域（每 tick 固定 SUBS=5 子步 Q16 积分，出膛参数完全决定全轨迹——
 *     离散事件确定性段重演，pool 范式）；fire 事件携带含散布的出射角+初速分量
 *     （客户端零 rng 复现义务，附决策 6）。
 *
 * 确定性纪律（§5.2 红线清单）：全整数 milli int32；算术只 + − × >> |(a/b)|0；
 * 三角 TRIG16/ATAN8 跨作复用（games/multiplayer/pool-physics/trig16.cjs 第三作，
 * 附决策 12）；开方二分整数 isqrt；零 Math.*、零 Date.now；固定子步 S=5；固定
 * 结算序（§5.3）；serialize 键字母序；散布 rng=mulberry32(seed^shotSeq) 且结果
 * 随 fire 事件下发；风=seed 派生（welcome 下发，不耗运行时 rng）。
 *
 * v1 收窄（设计书隐含/预算收敛，REPORT 披露）：HE 撞掩体=弹终+tile 伤害（不炸
 * 坦克 AOE）；AOE 只伤敌队（bot 自伤复杂度收窄）；掩体锚点表=通用路线点（非逐
 * tile 推导）；地图=程序化固定布局（生成代码即常量表，镜像对称 by construction）。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node（.cjs）
  root.IronSim = api;                                                      // 浏览器内联（classic script）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TRIG = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('../pool-physics/trig16.cjs') : globalThis.PoolTrig; // 跨作复用 pool 烘焙常量（浏览器前置 script 设 window.PoolTrig）
  var TRIG16 = TRIG.TRIG16, ATAN8 = TRIG.ATAN8;

  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 常量（设计 §2 数值表抄录；全整数 milli） ---------- */
  var SEATS = 4;
  var TICK_MS = 50;               // 房间 tick（§2.1）
  var SUBS = 5;                   // 每 tick 固定 5 物理子步（子步 10ms，两级时钟）
  var MAX_TICKS = 9600;           // 480s 硬顶（§1.1）
  var W_M = 340000, H_M = 500000; // 战场内域（§2.1）
  var R_T = 11000;                // 坦克半径（§2.2）
  var Z0 = 14000;                 // 炮口高（§2.2）
  var H_T = 20000;                // 坦克高（命中带 z∈[0,20000]，§2.4）
  var R_HIT2 = 13000 * 13000;     // 判定半径²（r_hit=13000，§2.6）
  var LIVES = 5;                  // 每队命池（§1.1）
  var RESPAWN_TICKS = 120;        // 6s 重生（§1.1）
  var CD_FIRE = 50;               // 装填 2.5s（§1.4）
  var MAG = [15, 8];              // 弹匣 AP/HE（§1.4）
  var CAP_R2 = 45000 * 45000;     // 占点圈 r=45px（§2.5）
  var CAP_MAX = 100000;           // 占点进度满（§2.5）
  var CAP_RATE = 55;              // 占点速率/tick×净人数（§2.5）
  var CAP_CX = 170000, CAP_CY = 250000;
  var AMMO_BOX = 30000;           // 基地弹药架 30×30px（§1.4）
  var AMMO_TICKS = 40;            // 站入静止 2s 补满（§1.4）
  var PUSH_D = 22000;             // 坦克推挤重叠判据（r_t×2，§2.6）
  var G_SUB = 30;                 // 重力 30 milli/子步²（§2.3）
  var AOE_R = 30000;              // HE AOE 半径（§2.3）
  var AOE_HI = 52429, AOE_LO = 16384; // AOE 线性 0.80→0.25 Q16（§2.3）
  var HE_TANK = 52429;            // HE 直击 ×0.80 Q16（§2.3）
  var REAR_MUL = 95027;           // 背面 ×1.45 Q16（§2.6）
  var WALL_H = 42000, CRATE_H = 26000; // 掩体高度（§2.4/§2.5）
  var TILE = 20000;               // tile 20px（§2.5）
  var TGX = 17, TGY = 25;         // 17×25 tiles（§2.5）
  var WALL_HP = 255, CRATE_HP = 69;     // tile 耐久档（§2.5 表换算：wall 260→255 档 / crate 70→69 档，拆解发数对书）
  var TILE_MARGIN = 14000;        // 坦克-tile 碰撞：格边到圆心裕量（r_t+缓冲）

  /* 坦克三类（§2.2 表抄录；spd=milli/tick，转向=brads(8192 圈)/tick，scat=8192 档散布半角） */
  var CLS = {
    heavy: { code: 'heavy', hp: 140, spd: 5000, body: 273, turret: 85,  ap: 38, scat: 36, front: 29491 }, // ×0.45
    all:   { code: 'all',   hp: 100, spd: 6500, body: 341, turret: 102, ap: 30, scat: 18, front: 39322 }, // ×0.60
    td:    { code: 'td',    hp: 72,  spd: 5750, body: 295, turret: 93,  ap: 48, scat: 8,  front: 45875 }, // ×0.70
  };
  var DEFAULT_CLS = ['all', 'all', 'all', 'all']; // 进房默认中坦（§2.2）；API 席 0 缺省位

  /* 弹种参数（§2.3 表；v_h/vz 烘焙常量） */
  var AMMO = [
    { code: 'ap', vh: 4475, vz: 470,  mag: 15 },  // AP 穿甲：平直
    { code: 'he', vh: 1991, vz: 1671, mag: 8 },   // HE 榴弹：高弧
  ];
  /* tile 档伤表（§2.3 对掩体每发：AP=炮伤×0.60 / HE=炮伤×1.76，×255/260 换档取整） */
  var TILE_DMG = {
    ap: { heavy: 22, all: 18, td: 28 },
    he: { heavy: 66, all: 52, td: 83 },
  };

  /* 出生点（§2.1：A 底部偶席/B 顶部；镜像对称 §2.7e） */
  var SPAWN = [
    [60000, 440000], [60000, 60000], [280000, 440000], [280000, 60000],
  ];

  /* ---------- 定点助手（pool 同式；角=8192 brads 档） ---------- */
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
  function clampI(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function d2(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
  function teamOf(seat) { return seat & 1; } // 0=A（偶席，底部基地）/1=B

  /* ---------- 地图三张（§2.5 固定表；程序化布局=常量，镜像对称 by construction） ---------- */
  var MAP_IDS = ['m-cross', 'm-gate', 'm-dune'];
  function tileIdx(gx, gy) { return gy * TGX + gx; }
  function buildMap(mapId) {
    var t = new Array(TGX * TGY).fill(0); // 0=地面 /1=wall /2=crate /9=rock 边界骨架
    var set = function (gx, gy, v) { if (gx >= 0 && gx < TGX && gy >= 0 && gy < TGY) t[tileIdx(gx, gy)] = v; };
    var setMir = function (gx, gy, v) { set(gx, gy, v); set(gx, TGY - 1 - gy, v); }; // 上下镜像（§2.7e 公平）
    var cy = (TGY - 1) >> 1; // 12
    if (mapId === 'm-cross') {
      /* 废墟十字：十字混凝土带（竖臂 col8 rows3..12 镜像；横臂 row12 cols3..13）——臂间窗口=AP 射界 */
      for (var gy1 = 3; gy1 <= cy; gy1++) setMir(8, gy1, 1);
      for (var gx1 = 3; gx1 <= 13; gx1++) set(gx1, cy, 1);
      setMir(3, 4, 2); setMir(13, 4, 2); setMir(5, 9, 2); setMir(11, 9, 2); // 散木箱（对称）
      return t;
    }
    if (mapId === 'm-gate') {
      /* 铁桥隘口：左右双混凝土墙各留中门 60px（rows 11..13 空=3 格门）——门是 HE 弹雨漏斗 */
      for (var gy2 = 3; gy2 <= 21; gy2++) { if (gy2 >= 11 && gy2 <= 13) continue; setMir(4, gy2, 1); setMir(12, gy2, 1); }
      setMir(8, 5, 2); setMir(8, 9, 2); // 走廊木箱（对称）
      return t;
    }
    /* m-dune 沙丘环岛：中央混凝土环（半径 70px 断续，上下左右四口）+散木箱——环形绞肉。
     * 口位按轴向判定（|dx|≥3 或 |dy|≥3）——dy 翻转不变=上下镜像 by construction（§2.7e） */
    var cgx = (TGX - 1) >> 1, cgy = cy; // 格心（8,12）
    for (var gy3 = 0; gy3 < TGY; gy3++) for (var gx3 = 0; gx3 < TGX; gx3++) {
      var dx = gx3 - cgx, dy = gy3 - cgy, dist = isqrt(dx * dx + dy * dy);
      if (dist === 3 || dist === 4) { // 环带 ~70px（3.5 格）
        var inGap = (dx >= 3 || dx <= -3 || dy >= 3 || dy <= -3); // 四向口（轴向=镜像安全）
        if (!inGap) t[tileIdx(gx3, gy3)] = 1;
      }
    }
    setMir(2, 8, 2); setMir(14, 8, 2); setMir(8, 3, 2); setMir(8, 21, 2); // 散木箱
    return t;
  }
  /* 边界硬墙（不可破坏骨架，§2.1）：外圈一圈 rock */
  function withRocks(t) {
    var out = t.slice();
    for (var gx = 0; gx < TGX; gx++) { out[tileIdx(gx, 0)] = 9; out[tileIdx(gx, TGY - 1)] = 9; }
    for (var gy = 0; gy < TGY; gy++) { out[tileIdx(0, gy)] = 9; out[tileIdx(TGX - 1, gy)] = 9; }
    return out;
  }
  function mapOf(seed) { return MAP_IDS[fnv1a32('map:' + (seed >>> 0)) % 3]; }
  /* 风偏（§2.3：W_mag∈[0,12000] 三档+W_ang 四向，seed 派生不耗运行时 rng） */
  function windOf(seed) {
    var h = fnv1a32('wind:' + (seed >>> 0));
    return { mag: h % 12001, ang: ((h >>> 16) & 3) << 11 };
  }

  /* =====================================================================
   * create(seed, opts)
   * ===================================================================== */
  function create(seed, opts) {
    opts = opts || {};
    var mapId = opts.map || mapOf(seed);
    var wind = windOf(seed);
    var layout = withRocks(buildMap(mapId));
    var hp = new Array(TGX * TGY).fill(0);
    for (var i = 0; i < layout.length; i++) hp[i] = layout[i] === 1 ? WALL_HP : layout[i] === 2 ? CRATE_HP : 0;
    var st = {
      v: 1, gameId: 'iron-torrent', seed: seed >>> 0, tick: 0,
      testRoom: !!opts.test, maxTicks: Number.isInteger(opts.maxTicks) && opts.maxTicks > 0 ? opts.maxTicks : MAX_TICKS,
      map: mapId, wind: wind,
      phase: 'play', clock: MAX_TICKS,
      lives: [LIVES, LIVES],          // 命池 A/B（§1.1）
      capBar: 0, capTeam: -1,         // 占点进度/当前净占方（§2.5）
      players: [], mem: [],
      projs: [], nextProj: 1,         // 活动弹道（物理域）
      tiles: layout, tileHp: hp,      // 掩体类型/耐久档
      classes: (opts.classes || DEFAULT_CLS).slice(0, SEATS),
      stats: { kills: [0, 0, 0, 0], dmg: [0, 0, 0, 0], crumbles: [0, 0, 0, 0], carried: 0, shots: [0, 0, 0, 0], hits: [0, 0, 0, 0] },
      inLog: [], lastIn: [null, null, null, null], _qp: [-1, -1, -1, -1],
      shotSeq: 0,                     // 散布 rng 流序（§2.3）
      auto: opts.autopilot === true ? 0 : -1, // 测试房服务器节拍自动驾驶席（A7 双跑，street 同款）
      pendingEnd: null,
    };
    for (var s = 0; s < SEATS; s++) ensurePlayer(st, s);
    return st;
  }
  function ensurePlayer(st, seat) {
    var p = st.players[seat];
    if (p) return p;
    var c = CLS[st.classes[seat]] || CLS.all;
    var sp = SPAWN[seat];
    p = st.players[seat] = {
      seat: seat, team: teamOf(seat), cls: c.code, x: sp[0], y: sp[1], dir: teamOf(seat) === 0 ? 2048 : 0,
      tur: teamOf(seat) === 0 ? 2048 : 0, hp: c.hp, alive: 1,
      cd: 0, sel: 0, ammo: [MAG[0], MAG[1]], respAt: -1, stillT: 0,
    };
    return p;
  }
  /* tile 助手（milli 坐标 → tile） */
  function tileAt(st, x, y) {
    var gx = (x / TILE) | 0, gy = (y / TILE) | 0;
    if (gx < 0 || gx >= TGX || gy < 0 || gy >= TGY) return 9;
    return st.tiles[tileIdx(gx, gy)];
  }
  function tileH(v) { return v === 1 ? WALL_H : v === 2 ? CRATE_H : v === 9 ? 1 << 30 : 0; }
  /* 坦克圆 vs tile AABB（分轴移动用：位置合法=不叠任何 solid tile） */
  function posBlocked(st, x, y) {
    if (x < R_T || x > W_M - R_T || y < R_T || y > H_M - R_T) return true; // 硬墙围笼（§2.1）
    var gx0 = ((x - TILE_MARGIN) / TILE) | 0, gx1 = ((x + TILE_MARGIN) / TILE) | 0;
    var gy0 = ((y - TILE_MARGIN) / TILE) | 0, gy1 = ((y + TILE_MARGIN) / TILE) | 0;
    for (var gy = gy0; gy <= gy1; gy++) for (var gx = gx0; gx <= gx1; gx++) {
      if (gx < 0 || gx >= TGX || gy < 0 || gy >= TGY) continue;
      if (st.tiles[tileIdx(gx, gy)] === 0) continue;
      var cx = clampI(x, gx * TILE, gx * TILE + TILE), cy2 = clampI(y, gy * TILE, gy * TILE + TILE);
      if (d2(x, y, cx, cy2) < (R_T + 2000) * (R_T + 2000)) return true; // tile 圆角裕量
    }
    return false;
  }

  /* =====================================================================
   * step(st, inputs, room) —— tick 结算序（§5.3 红线）
   * ===================================================================== */
  function step(st, inputs, room) {
    var ev = [];
    var dirty = {};
    var mark = function (id) { dirty[id] = 1; };
    var kinds = room ? room.seats.map(function (s) { return s.kind; }) : null;
    rememberVel(st); // 席位速度记账（提前量解算源；tick 首拍统一路径——在线/回放/autopilot 同源）

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
        tur: ((raw.tur | 0) & 0xFFFF) >> 3, // uint16 brads → 8192 档（§1.6 协议纪律）
        cmd: raw.cmd && typeof raw.cmd === 'object' ? raw.cmd : null,
      };
      eff[i] = e;
      var li = st.lastIn[i];
      var chg = !li || li.mx !== e.mx || li.my !== e.my || li.tur !== e.tur;
      if (chg || e.cmd) {
        st.inLog.push([st.tick, i, e.mx, e.my, e.tur, e.cmd || 0]);
        st.lastIn[i] = { mx: e.mx, my: e.my, tur: e.tur };
      }
      /* carried 记账（§5.4 宽限兜底在场证据，latency200 断言源）：人类席本 tick 无新日志=沿用 */
      if (kinds && kinds[i] === 'human' && !chg && !e.cmd) st.stats.carried++;
    }

    /* ① cmd 应用（fire/swap；服务器校验非法 reject 回流 §5.3） */
    for (var s1 = 0; s1 < SEATS; s1++) {
      var p1 = st.players[s1];
      if (p1 && eff[s1] && eff[s1].cmd) execCmd(st, s1, eff[s1].cmd, ev, mark);
    }

    /* ② 相位机（重生队列/占点/终局判定，§5.3） */
    tickPhase(st, ev, mark);

    /* ③ 坦克移动积分+车体转向（tick 步进；分轴 tile 碰撞） */
    for (var s3 = 0; s3 < SEATS; s3++) {
      var p = st.players[s3];
      if (!p) continue;
      if (p.cd > 0) p.cd--;
      if (!p.alive) {
        if (p.respAt >= 0 && st.tick >= p.respAt && st.lives[p.team] > 0) {
          /* 重生：己方基地满弹出场（§1.1） */
          var sp = SPAWN[p.seat];
          p.x = sp[0]; p.y = sp[1]; p.hp = CLS[p.cls].hp; p.alive = 1; p.cd = 0;
          p.ammo = [MAG[0], MAG[1]]; p.sel = 0; p.respAt = -1;
          p.dir = p.team === 0 ? 2048 : 0; p.tur = p.dir;
          ev.push({ k: 'respawn', seat: p.seat, x: p.x, y: p.y, frame: st.tick });
          mark('p' + p.seat);
        }
        continue;
      }
      var inp = eff[s3] || { mx: 0, my: 0, tur: p.tur };
      var c = CLS[p.cls];
      var vx = (c.spd * inp.mx / 100) | 0, vy = (c.spd * inp.my / 100) | 0;
      if (vx || vy) {
        /* 车体渐转向移动方向（转向上限 §2.2） */
        var want = atan2Q(vx, vy);
        var dd = angDiff(want, p.dir);
        var stepA = dd > 0 ? (dd > c.body ? c.body : dd) : (dd < -c.body ? -c.body : dd);
        p.dir = (p.dir + stepA) & 8191;
        /* 分轴移动（x/y 各试一次，被 tile 挡则该轴停） */
        if (!posBlocked(st, p.x + vx, p.y)) p.x += vx;
        if (!posBlocked(st, p.x, p.y + vy)) p.y += vy;
      }
      /* 炮塔限速转向（§2.2：75-90°/s 重量感+绕侧战术根） */
      var td = angDiff(inp.tur, p.tur);
      var stp = td > 0 ? (td > c.turret ? c.turret : td) : (td < -c.turret ? -c.turret : td);
      p.tur = (p.tur + stp) & 8191;
      /* 基地弹药架：出生区静止 40 tick 补满（§1.4） */
      var boxOk = false;
      for (var sib = 0; sib < SEATS; sib++) {
        if (sib === p.seat) continue;
        var sb = SPAWN[sib];
        if (Math.abs(p.x - sb[0]) <= AMMO_BOX && Math.abs(p.y - sb[1]) <= AMMO_BOX) { boxOk = true; break; }
      }
      if (boxOk && !vx && !vy) {
        if (++p.stillT >= AMMO_TICKS && (p.ammo[0] < MAG[0] || p.ammo[1] < MAG[1])) {
          p.ammo = [MAG[0], MAG[1]]; p.stillT = 0; mark('p' + p.seat);
        }
      } else p.stillT = 0;
      mark('p' + p.seat);
    }
    /* ④ 坦克推挤（圆圆重叠各半分离，对序 seat 升序固定 1 轮，§2.6） */
    for (var a = 0; a < SEATS; a++) {
      var pa = st.players[a]; if (!pa || !pa.alive) continue;
      for (var b2 = a + 1; b2 < SEATS; b2++) {
        var pb = st.players[b2]; if (!pb || !pb.alive) continue;
        var ddx = pb.x - pa.x, ddy = pb.y - pa.y, dd2 = d2(pa.x, pa.y, pb.x, pb.y);
        if (dd2 >= PUSH_D * PUSH_D || dd2 === 0) continue;
        var d = isqrt(dd2), ov = PUSH_D - d;
        var nx = (ddx << 16) / d | 0, ny = (ddy << 16) / d | 0;
        var half = (ov * 32768) >> 16; // 各半分离
        if (!posBlocked(st, pa.x - ((nx * half) >> 16), pa.y - ((ny * half) >> 16))) { pa.x -= (nx * half) >> 16; pa.y -= (ny * half) >> 16; }
        if (!posBlocked(st, pb.x + ((nx * half) >> 16), pb.y + ((ny * half) >> 16))) { pb.x += (nx * half) >> 16; pb.y += (ny * half) >> 16; }
        mark('p' + a); mark('p' + b2);
      }
    }
    /* ⑤ 弹道子步 ×5（§2.3 结算序红线：①平面积分→②垂直积分→③掩体→④坦克→⑤落地→⑥记账） */
    var wx = (cosQ16(st.wind.ang) * ((st.wind.mag / 100) | 0)) >> 16; // 风漂移 milli/子步（§2.3）
    var wy = (sinQ16(st.wind.ang) * ((st.wind.mag / 100) | 0)) >> 16;
    for (var sub = 0; sub < SUBS; sub++) projSub(st, wx, wy, ev, mark);

    /* 终局（§1.1：eliminated/capture/timeout） */
    var over = st.pendingEnd;
    if (!over && st.tick + 1 >= st.maxTicks) over = timeoutRuling(st);
    if (over) {
      st.phase = 'ended';
      var res = { winner: over.winner, reason: over.reason, scores: {} };
      for (var s5 = 0; s5 < SEATS; s5++) res.scores[s5] = st.stats.kills[s5];
      ev.push({ k: 'end', winner: over.winner, reason: over.reason });
      st.tick++;
      return { events: ev, dirty: mark, over: true, result: res };
    }
    st.tick++;
    return { events: ev, dirty: mark, over: false, result: null };
  }

  /* 相位机：占点推进/终局判定（§2.5/§1.1） */
  function tickPhase(st, ev, mark) {
    var nA = 0, nB = 0;
    for (var s = 0; s < SEATS; s++) {
      var p = st.players[s];
      if (!p || !p.alive) continue;
      if (d2(p.x, p.y, CAP_CX, CAP_CY) <= CAP_R2) { if (p.team === 0) nA++; else nB++; }
    }
    var net = nA - nB;
    if (net !== 0) {
      st.capTeam = net > 0 ? 0 : 1;
      st.capBar = clampI(st.capBar + CAP_RATE * net, 0, CAP_MAX);
      if (st.tick % 10 === 0) ev.push({ k: 'capTick', team: st.capTeam, bar: st.capBar });
      if (st.capBar >= CAP_MAX) st.pendingEnd = { winner: st.capTeam === 0 ? 'A' : 'B', reason: 'capture' };
    } else if (st.capBar > 0 && st.tick % 10 === 0) {
      /* 无人占不回落（净 0 冻结，§2.5「敌方净占则同速回落」口径：负净值才回落） */
    }
    /* 歼灭终局：命池尽且场上全灭（§1.1） */
    for (var tm = 0; tm < 2; tm++) {
      if (st.lives[tm] > 0) continue;
      var anyAlive = false;
      for (var s2 = 0; s2 < SEATS; s2++) {
        var q = st.players[s2];
        if (q && q.team === tm && q.alive) { anyAlive = true; break; }
      }
      if (!anyAlive) st.pendingEnd = { winner: tm === 0 ? 'B' : 'A', reason: 'eliminated' };
    }
    void mark;
  }
  /* timeout 裁定链（§1.1：存活台数→占点进度→累计伤害→draw） */
  function timeoutRuling(st) {
    var alive = [0, 0], dmg = [0, 0];
    for (var s = 0; s < SEATS; s++) {
      var p = st.players[s];
      if (p && p.alive) alive[p.team]++;
      dmg[s & 1] += st.stats.dmg[s];
    }
    var w = 'draw';
    if (alive[0] !== alive[1]) w = alive[0] > alive[1] ? 'A' : 'B';
    else if (st.capBar !== 0) w = st.capTeam === 0 ? 'A' : 'B';
    else if (dmg[0] !== dmg[1]) w = dmg[0] > dmg[1] ? 'A' : 'B';
    return { winner: w, reason: 'timeout' };
  }

  /* ---------- 离散 cmd（fire/swap；非法 {k:'reject'} 回流 §5.3） ---------- */
  function execCmd(st, seat, cmd, ev, mark) {
    var p = st.players[seat];
    var k = cmd.k;
    if (k === 'swap') {
      var a = cmd.ammo | 0;
      if (a !== 0 && a !== 1) return ev.push({ k: 'reject', seat: seat, op: 'swap', why: 'bad-ammo' });
      p.sel = a;
      mark('p' + seat);
      return;
    }
    if (k === 'fire') {
      var am = cmd.ammo | 0;
      if (am !== 0 && am !== 1) return ev.push({ k: 'reject', seat: seat, op: 'fire', why: 'bad-ammo' });
      if (!p.alive) return ev.push({ k: 'reject', seat: seat, op: 'fire', why: 'dead' });
      if (p.cd > 0) return ev.push({ k: 'reject', seat: seat, op: 'fire', why: 'cd' });
      if (p.ammo[am] <= 0) return ev.push({ k: 'reject', seat: seat, op: 'fire', why: 'empty' });
      /* 散布（§2.3：rng=mulberry32(seed^shotSeq)，最终出射角随事件下发——零客户端复现义务） */
      var c = CLS[p.cls];
      var rng = mulberry32((st.seed ^ Math.imul(st.shotSeq + 1, 0x9e3779b9)) >>> 0);
      st.shotSeq++;
      var scat = c.scat;
      var ang = (p.tur + ((((rng() * 2 - 1) * scat) | 0)) + 8192) & 8191;
      var A = AMMO[am];
      var ox = p.x + ((cosQ16(ang) * (R_T + 3000)) >> 16);
      var oy = p.y + ((sinQ16(ang) * (R_T + 3000)) >> 16);
      p.ammo[am]--; p.cd = CD_FIRE;
      st.projs.push({ id: st.nextProj++, seat: seat, ammo: am, x: ox, y: oy, z: Z0,
        vx: (cosQ16(ang) * A.vh) >> 16, vy: (sinQ16(ang) * A.vh) >> 16, vz: A.vz });
      st.stats.shots[seat]++;
      ev.push({ k: 'fire', seat: seat, ammo: am, ang: ang, x: ox, y: oy, z: Z0,
        vx: (cosQ16(ang) * A.vh) >> 16, vy: (sinQ16(ang) * A.vh) >> 16, vz: A.vz });
      mark('p' + seat);
      return;
    }
    /* 未知 cmd 静默 noop */
  }

  /* ---------- 弹道子步（§2.3 红线序；坦克位子步内冻结） ---------- */
  function projSub(st, wx, wy, ev, mark) {
    for (var pi = 0; pi < st.projs.length; pi++) {
      var pr = st.projs[pi];
      /* ① 平面积分（含风偏漂移） */
      pr.x += pr.vx + wx; pr.y += pr.vy + wy;
      /* ② 垂直积分 */
      pr.z += pr.vz; pr.vz -= G_SUB;
      /* ③ 掩体命中（tile 查表，z≤h_wall 且弹心入 tile，§2.3） */
      var tv = tileAt(st, pr.x, pr.y);
      if (tv !== 0 && pr.z <= tileH(tv)) {
        hitTile(st, pr, tv, ev, mark);
        st.projs.splice(pi, 1); pi--;
        continue;
      }
      /* ④ 坦克命中（id 升序，z≤h_t 且距离²≤r_hit²，§2.3） */
      var hit = -1;
      for (var s = 0; s < SEATS; s++) {
        var p = st.players[s];
        if (!p || !p.alive || s === pr.seat) continue;
        if (pr.z <= H_T && d2(pr.x, pr.y, p.x, p.y) <= R_HIT2) { hit = s; break; }
      }
      if (hit >= 0) {
        hitTank(st, pr, hit, ev, mark);
        if (pr.ammo === 1) splash(st, pr, ev, mark); // HE 直击另算 AOE（§2.3）
        st.projs.splice(pi, 1); pi--;
        continue;
      }
      /* ⑤ 落地（z≤0：HE 爆炸/AP 入土，§2.3） */
      if (pr.z <= 0) {
        if (pr.ammo === 1) splash(st, pr, ev, mark);
        st.projs.splice(pi, 1); pi--;
        continue;
      }
    }
  }
  /* 掩体伤害（§2.5 档伤表；归零 crumble→tile 变地面） */
  function hitTile(st, pr, tv, ev, mark) {
    if (tv === 9) return; // 边界骨架不可拆
    var gx = (pr.x / TILE) | 0, gy = (pr.y / TILE) | 0;
    if (gx < 0 || gx >= TGX || gy < 0 || gy >= TGY) return;
    var ti = tileIdx(gx, gy);
    var shooter = st.players[pr.seat];
    var cls = shooter ? shooter.cls : 'all';
    var dmg = TILE_DMG[pr.ammo === 0 ? 'ap' : 'he'][cls] || 18;
    st.tileHp[ti] = Math.max(0, st.tileHp[ti] - dmg);
    if (st.tileHp[ti] === 0) {
      st.tiles[ti] = 0;
      if (shooter) st.stats.crumbles[shooter.seat]++;
      ev.push({ k: 'crumble', tile: ti });
      mark('tile' + ti);
    }
  }
  /* 坦克直击（§2.6：部位修正=入射向 vs 车体朝向） */
  function hitTank(st, pr, victim, ev, mark) {
    var p = st.players[victim];
    var shooter = st.players[pr.seat];
    var c = CLS[p.cls];
    var base = shooter ? CLS[shooter.cls].ap : 30;
    var dmg = pr.ammo === 0 ? base : ((base * HE_TANK) >> 16);
    /* 部位（§2.6）：|入射角−车体向| <60°正面减免 / >120°背面加成 / 其余侧翼 */
    var angIn = atan2Q(pr.vx, pr.vy);
    var d = angDiff(angIn, p.dir);
    if (d < 0) d = -d;
    var part;
    if (d < 1365) { dmg = (dmg * c.front) >> 16; part = 'front'; }
    else if (d > 2731) { dmg = (dmg * REAR_MUL) >> 16; part = 'rear'; }
    else part = 'side';
    p.hp -= dmg;
    if (shooter) { st.stats.dmg[shooter.seat] += dmg; st.stats.hits[shooter.seat]++; }
    ev.push({ k: 'hit', seat: pr.seat, victim: victim, dmg: dmg, angIn: angIn, part: part, frame: st.tick });
    if (p.hp <= 0) killTank(st, victim, pr.seat, ev, mark);
    mark('p' + victim);
  }
  /* HE AOE（§2.3：半径 30000 线性 0.80→0.25 base；只伤敌队 v1 收窄） */
  function splash(st, pr, ev, mark) {
    ev.push({ k: 'splash', seat: pr.seat, x: pr.x, y: pr.y, frame: st.tick });
    var shooter = st.players[pr.seat];
    var base = shooter ? CLS[shooter.cls].ap : 30;
    for (var s = 0; s < SEATS; s++) {
      var p = st.players[s];
      if (!p || !p.alive || s === pr.seat) continue;
      if (p.team === (shooter ? shooter.team : 0)) continue; // 只伤敌队（v1）
      var d = isqrt(d2(pr.x, pr.y, p.x, p.y));
      if (d > AOE_R) continue;
      var mul = AOE_HI - (((AOE_HI - AOE_LO) * d) / AOE_R | 0);
      var dmg = (base * mul) >> 16;
      p.hp -= dmg;
      if (shooter) st.stats.dmg[shooter.seat] += dmg;
      ev.push({ k: 'hit', seat: pr.seat, victim: s, dmg: dmg, angIn: -1, part: 'splash', frame: st.tick });
      if (p.hp <= 0) killTank(st, s, pr.seat, ev, mark);
      mark('p' + s);
    }
  }
  /* 击毁（§1.1：命池 −1→有余量 120 tick 重生；命池尽=真出局——下限保护 0，
   * 同拍并发杀不产生负账本） */
  function killTank(st, victim, bySeat, ev, mark) {
    var p = st.players[victim];
    p.alive = 0; p.hp = 0;
    var L = st.lives[p.team];
    st.lives[p.team] = L > 0 ? L - 1 : 0;
    st.stats.kills[bySeat >= 0 ? bySeat : 0]++;
    ev.push({ k: 'kill', seat: bySeat, victim: victim, frame: st.tick });
    if (L > 0) p.respAt = st.tick + RESPAWN_TICKS;
    else p.respAt = -1;
    mark('p' + victim);
  }

  /* =====================================================================
   * Bot 三档（§4 冻结方案：提前量闭式迭代解核+档间迭代深度/噪声/弹种战术差）
   * rng=mulberry32(seed^seat^tick>>2)（§4.2）；散布噪声只耗本席 rng 流
   * ===================================================================== */
  var BOT_EVERY = { casual: 10, balanced: 6, competitive: 4 };
  var ITER_N = { casual: 0, balanced: 2, competitive: 3 }; // 迭代深度（§4.2）
  var NOISE = { casual: 0, balanced: 9, competitive: 2 };  // 附加散布（8192 档）
  /* 掩体锚点表（§4.2 balanced 站桩轮换/competitive 绕侧途径）——三图通用安全路线：
   * 中央结构（十字臂/双墙/环）都以边路绕行（m-cross 横臂 cols3..13 近全宽，唯
   * col1-2/col14-15 有南北口），末锚=中心圈两翼（不穿墙带） */
  var ANCHORS = [
    [[45000, 320000], [45000, 180000], [120000, 170000]],   // A 队席 0：左路边绕→中心西翼
    [[45000, 180000], [45000, 320000], [120000, 330000]],   // B 队席 1（镜像）
    [[295000, 320000], [295000, 180000], [220000, 170000]], // A 队席 2：右路
    [[295000, 180000], [295000, 320000], [220000, 330000]], // B 队席 3
  ];
  /* 提前量解算核（§4.1 伪代码直译：闭式迭代+风偏补偿；全整数。
   * 速度=mem 记账 milli/tick → 子步域 /5；风补偿=mag×t/100 milli 反向） */
  function solveLead(st, me, tgt, ammo) {
    var vh = AMMO[ammo].vh;
    var t = 0, ax = tgt.x, ay = tgt.y;
    var n = 3;
    for (var it = 0; it < n; it++) {
      ax = tgt.x + ((tgtVelX(st, tgt) * t / 5) | 0);
      ay = tgt.y + ((tgtVelY(st, tgt) * t / 5) | 0);
      t = (isqrt(d2(me.x, me.y, ax, ay)) / vh) | 0; // 平面匀速闭式（除法向零取整）
    }
    /* 风偏反向补偿（§4.1：飞行期风总漂移=mag×t/100 milli，提前量反向扣除） */
    var wdy = ((st.wind.mag * t) / 100) | 0;
    ax -= (cosQ16(st.wind.ang) * wdy) >> 16;
    ay -= (sinQ16(st.wind.ang) * wdy) >> 16;
    return { x: ax, y: ay, t: t };
  }
  /* 目标速度估计（mem 上拍位差分；无记忆=0——casual 无提前量即不调用） */
  function tgtVelX(st, tgt) {
    var m = st.mem[tgt.seat];
    return m && m.vx ? m.vx : 0;
  }
  function tgtVelY(st, tgt) {
    var m = st.mem[tgt.seat];
    return m && m.vy ? m.vy : 0;
  }
  function rememberVel(st) { // 每 tick 开头由 step 记账（mem 席位速度 milli/tick；在线/回放同路径）
    for (var s = 0; s < SEATS; s++) {
      var p = st.players[s];
      if (!p) continue;
      var m = st.mem[s] || (st.mem[s] = { vx: 0, vy: 0, lx: p.x, ly: p.y });
      m._pvx = m.vx; m._pvy = m.vy; // 前拍速度（competitive 减速预判用，§4.1）
      m.vx = p.x - m.lx; m.vy = p.y - m.ly; m.lx = p.x; m.ly = p.y;
    }
  }
  /* 线段上是否有己方坦克（开炮门禁，§4.1：13000 步进采样） */
  function friendOnLine(st, me, tx, ty) {
    var d = isqrt(d2(me.x, me.y, tx, ty)), steps = Math.max(1, (d / 13000) | 0);
    for (var s = 1; s <= steps; s++) {
      var px = me.x + ((tx - me.x) * s / steps) | 0, py = me.y + ((ty - me.y) * s / steps) | 0;
      for (var i = 0; i < SEATS; i++) {
        var p = st.players[i];
        if (!p || !p.alive || p.seat === me.seat || p.team !== me.team) continue;
        if (d2(px, py, p.x, p.y) < 16000 * 16000) return true;
      }
    }
    return false;
  }

  function brain(st, seat, level, _rng, env) {
    var P = st.players[seat];
    if (!P) return { mx: 0, my: 0 };
    var out = { mx: 0, my: 0, tur: P.tur << 3 };
    if (!P.alive) return out;
    var rng = mulberry32((st.seed ^ Math.imul(seat + 11, 0x9e3779b9) ^ ((st.tick >> 2) * 0x45d9f3b)) >>> 0);
    var M = st.mem[seat] || (st.mem[seat] = {});
    var anchors = ANCHORS[seat];
    var team = seat & 1;
    /* 敌清单（最近敌优先） */
    var foe = null, fd = 1e15; // milli² 距离量级哨兵（2^30≈1e9 会被 380000²≈1.4e11 压过）
    for (var i = 0; i < SEATS; i++) {
      var q = st.players[i];
      if (!q || !q.alive || q.team === team) continue;
      var dd = d2(P.x, P.y, q.x, q.y);
      /* competitive 集火：hp 最低敌距离加权（§4.2 ping 集火——平方距离域 1e11 量级，
       * hp²×2500（100hp→2.5e9≈50000 milli 等效折减）才可达影响域） */
      if (level === 'competitive') dd -= q.hp * q.hp * 2500;
      if (dd < fd) { fd = dd; foe = q; }
    }
    var steer = function (x, y, sp) {
      var dx = x - P.x, dy = y - P.y, d = isqrt(dx * dx + dy * dy) || 1;
      if (d < 9000) return 0;
      out.mx = clampI(((dx * 100) / d) | 0, -100, 100);
      out.my = clampI(((dy * 100) / d) | 0, -100, 100);
      return d;
    };
    if (!foe) {
      /* 无敌可打：占点/回基地 */
      steer(CAP_CX, CAP_CY);
      out.tur = (atan2Q(CAP_CX - P.x, CAP_CY - P.y) << 3) & 0xFFFF;
      return out;
    }
    var dist = isqrt(fd);
    /* 决策间隔节流（§4.2）：casual 10/balanced 6/competitive 4 tick */
    var every = BOT_EVERY[level] || 6;
    if (M.dt === undefined) M.dt = 0;
    var fresh = M.dt <= 0;
    if (fresh) M.dt = every;
    M.dt--;
    if (!M.ai) M.ai = { tx: P.x, ty: P.y, anchor: 0, fired: 0 };

    /* ---- 瞄准（§4.1）---- */
    var aimAt = foe;
    if (level !== 'casual' && fresh) {
      var lead = solveLead(st, P, foe, 0);
      M.ai.tx = lead.x; M.ai.ty = lead.y;
      /* competitive 减速预判（§4.1：对减速目标用 (v_pre+v_now)/2——近似：提前量 ×85%） */
      if (level === 'competitive') {
        var m2 = st.mem[foe.seat];
        if (m2 && m2._pvx !== undefined && Math.abs(m2.vx) < Math.abs(m2._pvx) - 500) {
          M.ai.tx = foe.x + (((M.ai.tx - foe.x) * 87) >> 7);
          M.ai.ty = foe.y + (((M.ai.ty - foe.y) * 87) >> 7);
        }
      }
    } else if (level === 'casual') {
      M.ai.tx = foe.x; M.ai.ty = foe.y; // 无提前量（§4.2 单据口径：直线逼近乱射）
    }
    var wantTur = atan2Q(M.ai.tx - P.x, M.ai.ty - P.y) & 8191;
    var noise = NOISE[level] || 0;
    if (noise && fresh) wantTur = (wantTur + ((((rng() * 2 - 1) * noise) | 0)) + 8192) & 8191;
    out.tur = (wantTur << 3) & 0xFFFF;

    /* ---- 弹种（§4.2 表；HE 几何约束：ELEV 40° 固定=落点恒在 ~221000 射程环——
     * 中近距对坦克只可 AP 直射（HE 峰 60px 掠顶越墙，瞄谁都不中）；HE 用法=远距
     * 射程环压制/砸环上墙段（拆墙开门）；墙后中近目标=机动绕（锚点轮换面））---- */
    var ammo = 0;
    if (level !== 'casual') {
      ammo = dist > 190000 && dist < 245000 && P.ammo[1] > 0 ? 1 : 0;
      if (P.ammo[ammo] <= 0) ammo = ammo === 0 ? 1 : 0;
    } else if (P.ammo[0] <= 0) ammo = 1;

    /* ---- 移动（§4.2 三档移动面）---- */
    if (level === 'casual') {
      /* 直线逼近（不绕掩体，穿开阔地）；60000 内收步对轰（贴脸必中=假命中带，收窄） */
      if (dist > 60000) steer(foe.x, foe.y);
      else if (dist < 40000) steer(P.x - (foe.x - P.x), P.y - (foe.y - P.y));
    } else if (level === 'balanced') {
      /* 掩体轮换：站桩射 2-4 发→移至下一锚（锚=掩体后 8000 近似=锚点即固定安全位） */
      if (dist > 200000) { var an = anchors[M.ai.anchor % anchors.length]; steer(an[0], an[1]); }
      else if (M.ai.fired >= 2 + ((rng() * 3) | 0)) { M.ai.fired = 0; M.ai.anchor++; }
      else if (dist < 90000) { // 切向绕行（保持侧翼受弹面，不送背）
        var ta = (atan2Q(foe.x - P.x, foe.y - P.y) + ((st.tick >> 4) & 1 ? 2048 : -2048)) & 8191;
        steer(P.x + ((cosQ16(ta) * 40000) >> 16), P.y + ((sinQ16(ta) * 40000) >> 16));
      }
      /* 回防/补给（§4.2） */
      if (st.capTeam === (team ^ 1) && st.capBar > 60000) steer(CAP_CX, CAP_CY);
      if (P.ammo[0] < 4) { var sp2 = SPAWN[seat]; steer(sp2[0], sp2[1]); }
    } else {
      /* competitive 绕侧（§4.2：目标背面 120-180° 入射带途径点——近似=目标侧后 45° 位） */
      var backAng = foe.dir;
      var sideAng = (backAng + (seat === 0 || seat === 1 ? 2048 : -2048)) & 8191; // 左右分席绕
      var fx = foe.x + ((cosQ16(sideAng) * 60000) >> 16);
      var fy = foe.y + ((sinQ16(sideAng) * 60000) >> 16);
      if (dist > 160000 || Math.abs(angDiff(atan2Q(P.x - foe.x, P.y - foe.y), backAng)) < 2731) {
        steer(clampI(fx, 20000, W_M - 20000), clampI(fy, 20000, H_M - 20000));
      }
      /* 占点权重（§4.2：进度差/敌全占回防+开局 1 人先占） */
      if (st.tick < 300 && (seat & 1) === 0 && seat === 2) steer(CAP_CX, CAP_CY);
      else if (st.capTeam === (team ^ 1) && st.capBar > 50000) steer(CAP_CX, CAP_CY);
      if (P.ammo[0] < 4) { var sp3 = SPAWN[seat]; steer(sp3[0], sp3[1]); }
    }

    /* 卡死滑墙（net-tank sx 账本同款）：有输入而近拍位移≈0=被 tile 挡 → 方向旋转
     * 90° 蹭出（3 拍判定/9 拍后回直行再评估）——三档共用（直线逼近/锚点轮换均会撞墙带） */
    if ((out.mx || out.my) && Math.abs(M.vx || 0) + Math.abs(M.vy || 0) < 800) {
      M.stuck = (M.stuck || 0) + 1;
      if (M.stuck > 3) { var t0 = out.mx; out.mx = -out.my; out.my = t0; if (M.stuck > 12) M.stuck = 0; }
    } else M.stuck = 0;

    /* ---- 开炮门禁（§4.1：炮塔到位 ≤1°+通路无己方+弹种合适+射程内——
     * AP 落地 ~215000/HE 落点环 ~221000，射程外开火=纯浪费弹药）---- */
    var aligned = Math.abs(angDiff(wantTur, P.tur)) <= 22; // 1°≈22 档
    var inRange = dist <= (ammo === 1 ? 245000 : 210000);
    if (aligned && inRange && P.cd <= 0 && P.ammo[ammo] > 0 && !friendOnLine(st, P, M.ai.tx, M.ai.ty)) {
      if (P.sel !== ammo) { out.cmd = { k: 'swap', ammo: ammo }; return out; }
      out.cmd = { k: 'fire', ammo: ammo };
      M.ai.fired = (M.ai.fired || 0) + 1;
    }
    return out;
  }
  /* 射线被掩体挡（AP 视角：弹道低飞段被 wall/crate 拦——采样步进 10000） */
  function losBlocked(st, me, foe) {
    var d = isqrt(d2(me.x, me.y, foe.x, foe.y)), steps = Math.max(1, (d / 10000) | 0);
    for (var s = 1; s < steps; s++) {
      var px = me.x + ((foe.x - me.x) * s / steps) | 0, py = me.y + ((foe.y - me.y) * s / steps) | 0;
      if (tileAt(st, px, py) !== 0) return true;
    }
    return false;
  }

  /* autopilot（A7 确定性双跑：服务器节拍 gunner——§6 剧本策略同式：迭代 2 轮提前量+到位开炮） */
  function autopilotImpl(st, seat) {
    var P = st.players[seat];
    if (!P) return { mx: 0, my: 0 };
    var out = { mx: 0, my: 0, tur: P.tur << 3 };
    if (!P.alive) return out;
    var team = seat & 1;
    var foe = null, fd = 1e15; // milli² 距离量级哨兵（2^30≈1e9 会被 380000²≈1.4e11 压过）
    for (var i = 0; i < SEATS; i++) {
      var q = st.players[i];
      if (!q || !q.alive || q.team === team) continue;
      var dd = d2(P.x, P.y, q.x, q.y);
      if (dd < fd) { fd = dd; foe = q; }
    }
    if (!foe) { steer0(out, P, CAP_CX, CAP_CY); return out; }
    var dist = isqrt(fd);
    /* 接近至 <200000（§6 gunner：接近→AP→追角→fire） */
    if (dist > 190000) steer0(out, P, foe.x, foe.y);
    else if (dist < 60000) { out.mx = clampI((((P.x - foe.x) * 100) / dist) | 0, -100, 100); out.my = clampI((((P.y - foe.y) * 100) / dist) | 0, -100, 100); }
    var lead = solveLead(st, P, foe, 0);
    out.tur = (atan2Q(lead.x - P.x, lead.y - P.y) << 3) & 0xFFFF;
    /* 切向机动（受弹面=侧翼管理，被瞄准规避：敌 tur 指我 ±25°=即将被弹→换切向）；
     * 贴身 <60000 直线拉开（短暂送背换射程，炮塔独立照打）；弹尽回基地补给
     * （AP<4 且 HE≤2——casual 打空为止=弹药经济差是 A2 机制差，§4.2 balanced 同款） */
    var aimed = false;
    var aimAtMe = atan2Q(P.x - foe.x, P.y - foe.y);
    if (Math.abs(angDiff(foe.tur, aimAtMe)) <= 568) aimed = true; // 25°=568 档（casual 追角窗）
    var side = ((st.tick >> 4) & 1) ? 2048 : -2048; // 0.8s 换向
    if (aimed) side = ((st.tick >> 3) & 1) ? 2048 : -2048; // 被瞄准换向更频
    var orbit = (atan2Q(foe.x - P.x, foe.y - P.y) + side) & 8191;
    if (P.ammo[0] < 4 && P.ammo[1] <= 2) { var spA = SPAWN[seat]; steer0(out, P, spA[0], spA[1]); }
    else if (dist > 195000) steer0(out, P, foe.x, foe.y);            // 风筝带回滞回：外沿接近
    else if (dist < 165000) steer0(out, P, P.x - (foe.x - P.x), P.y - (foe.y - P.y)); // 内沿拉开
    /* 中带=纯切向横移（径向距离保持）——casual 无提前量在 19 万距离打移动靶必 miss
     * （误差 55k >> r_hit 13k），风筝带=gunner 的机制性无敌区（A2 机制差） */
    else steer0(out, P, P.x + ((cosQ16(orbit) * 30000) >> 16), P.y + ((sinQ16(orbit) * 30000) >> 16));
    if (Math.abs(angDiff(atan2Q(lead.x - P.x, lead.y - P.y), P.tur)) <= 22 && P.cd <= 0 && P.ammo[0] > 0 && dist <= 210000) {
      if (P.sel !== 0) { out.cmd = { k: 'swap', ammo: 0 }; return out; }
      out.cmd = { k: 'fire', ammo: 0 };
    } else if (P.ammo[0] <= 0 && P.cd <= 0 && P.sel !== 1 && P.ammo[1] > 0) out.cmd = { k: 'swap', ammo: 1 };
    return out;
  }
  function steer0(out, P, x, y) {
    var dx = x - P.x, dy = y - P.y, d = isqrt(dx * dx + dy * dy) || 1;
    if (d < 9000) return;
    out.mx = clampI(((dx * 100) / d) | 0, -100, 100);
    out.my = clampI(((dy * 100) / d) | 0, -100, 100);
  }

  /* ---------- 确定性（serialize/hash + 回放器，A7 红线） ---------- */
  function serialize(st) {
    var ps = [];
    for (var i = 0; i < SEATS; i++) {
      var p = st.players[i];
      ps.push(p ? [p.x, p.y, p.dir, p.tur, p.hp, p.alive, p.cd, p.sel, p.ammo[0], p.ammo[1], p.respAt] : null);
    }
    var pr = [];
    for (var j = 0; j < st.projs.length; j++) pr.push([st.projs[j].id, st.projs[j].seat, st.projs[j].ammo, st.projs[j].x, st.projs[j].y, st.projs[j].z, st.projs[j].vx, st.projs[j].vy, st.projs[j].vz]);
    /* 键字母序（红线）：capBar/capTeam/clock/inLogN/lives/map/phase/players/projs/shotSeq/tick/tileHp */
    return JSON.stringify({
      capBar: st.capBar, capTeam: st.capTeam, clock: st.clock, inLogN: st.inLog.length,
      lives: [st.lives[0], st.lives[1]], map: st.map, phase: st.phase,
      players: ps, projs: pr, shotSeq: st.shotSeq, tick: st.tick, tileHp: st.tileHp,
    });
  }
  function hashState(st) { return fnv1a32(serialize(st)); }
  function hashQuick(st) { // ext.hash 哨兵（每 10 张：全员+弹道+占点权威态）
    var h = fnv1a32(st.tick + ':' + st.capBar + ':' + st.lives[0] + ',' + st.lives[1] + ':' + st.projs.length);
    for (var i = 0; i < SEATS; i++) {
      var p = st.players[i];
      h = fnv1a32(h + ':' + (p ? p.x + ',' + p.y + ',' + p.tur + ',' + p.hp : 'x'));
    }
    return h;
  }
  /** 回放器（A7：在线终态 == 输入日志重放）——inLog=[tick,seat,mx,my,tur,cmd?] 稀疏变更日志 */
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
    var hold = [{ mx: 0, my: 0, tur: 0 }, { mx: 0, my: 0, tur: 0 }, { mx: 0, my: 0, tur: 0 }, { mx: 0, my: 0, tur: 0 }];
    var lastCmd = [-1, -1, -1, -1];
    while (st.tick < (maxTicks || MAX_TICKS)) {
      var inputs = {};
      for (var s = 0; s < SEATS; s++) {
        if (room.seats[s].kind === 'bot') inputs[s] = brain(st, s, (o.botLevels && o.botLevels[s]) || 'balanced');
      }
      var list = byTick[st.tick];
      if (list) for (var q2 = 0; q2 < list.length; q2++) {
        var en = list[q2];
        hold[en[1]] = { mx: en[2], my: en[3], tur: (en[4] << 3) & 0xFFFF }; // inLog 的 tur=8192 档量化值——升回 uint16 再经 step >>3 还原（防双重右移）
        if (en[5]) lastCmd[en[1]] = st.tick;
      }
      for (var h2 = 0; h2 < SEATS; h2++) {
        if (room.seats[h2].kind === 'bot') continue;
        inputs[h2] = Object.assign({}, hold[h2]);
        if (lastCmd[h2] === st.tick) inputs[h2].cmd = byTick[st.tick].filter(function (e2) { return e2[1] === h2 && e2[5]; })[0][5];
      }
      var r = step(st, inputs, room);
      if (r.over) break;
    }
    return st;
  }

  /* ---------- 弹道前瞻（预览线/客户端同 sim 前瞻，§3.3/§5.5 三面同源） ---------- */
  /** previewTrace：从 (x,y) 以角 ang/弹种 ammo 跑 §2.3 同配方子步积分，返回采样点列
   * （16 点×5 子步/点=80 子步；无散布项=散布中心线；掩体态取传入 tileAtFn——客户端用最近快照） */
  function previewTrace(x, y, ang, ammo, wind, tileAtFn, maxPts) {
    var A = AMMO[ammo];
    var pts = [{ x: x, y: y, z: Z0 }];
    var px = x, py = y, pz = Z0, vz = A.vz;
    var vx = (cosQ16(ang) * A.vh) >> 16, vy = (sinQ16(ang) * A.vh) >> 16;
    var wx = (cosQ16(wind.ang) * ((wind.mag / 100) | 0)) >> 16;
    var wy = (sinQ16(wind.ang) * ((wind.mag / 100) | 0)) >> 16;
    var n = (maxPts || 16) * 5;
    for (var s = 0; s < n; s++) {
      px += vx + wx; py += vy + wy;
      pz += vz; vz -= G_SUB;
      var tv = tileAtFn(px, py);
      if (tv !== 0 && pz <= tileH(tv)) { pts.push({ x: px, y: py, z: pz }); break; }
      if (pz <= 0) { pz = 0; pts.push({ x: px, y: py, z: 0 }); break; }
      if (s % 5 === 4) pts.push({ x: px, y: py, z: pz });
    }
    return pts;
  }

  var LEVELS = ['casual', 'balanced', 'competitive'];
  var ENGINE = 'iron-int-v1';
  var ENGINE_HASH = fnv1a32(ENGINE + ':' + TRIG16.join(',') + ':' + ATAN8.join(',') + ':' + [
    W_M, H_M, R_T, Z0, H_T, LIVES, RESPAWN_TICKS, CD_FIRE, CAP_RATE, CAP_MAX, G_SUB,
    TILE, TGX, TGY, WALL_HP, CRATE_HP,
    JSON.stringify(CLS), JSON.stringify(AMMO), JSON.stringify(TILE_DMG), JSON.stringify(SPAWN),
    JSON.stringify(MAP_IDS.map(function (m) { return withRocks(buildMap(m)); })),
  ].join(','));

  var META = {
    gameId: 'iron-torrent', title: '钢铁洪流', mode: '2v2-armored', seats: SEATS,
    tickMs: TICK_MS, cmdInput: true,
    roomPrefix: 'iron', // feed 字典序 element<empire<iron<moba…（§7 无冲突不扰房序断言）
    takeOver: 'balanced', // 断线托管=balanced（§4.3：挂机=送命池）
    tech: 'S4',
  };

  return {
    META: META, LEVELS: LEVELS, ENGINE: ENGINE, ENGINE_HASH: ENGINE_HASH,
    create: create, step: step, brain: brain,
    serialize: serialize, hashState: hashState, hashQuick: hashQuick, replayInputs: replayInputs,
    previewTrace: previewTrace, rememberVel: rememberVel,
    fnv1a32: fnv1a32, mulberry32: mulberry32,
    consts: {
      TICK_MS: TICK_MS, SUBS: SUBS, MAX_TICKS: MAX_TICKS, W_M: W_M, H_M: H_M,
      CLS: CLS, AMMO: AMMO, SPAWN: SPAWN, TILE: TILE, TGX: TGX, TGY: TGY,
      CAP_CX: CAP_CX, CAP_CY: CAP_CY, CAP_R2: CAP_R2, MAG: MAG, CD_FIRE: CD_FIRE,
      LIVES: LIVES, mapOf: mapOf, windOf: windOf, tileH: tileH,
    },
  };
});
