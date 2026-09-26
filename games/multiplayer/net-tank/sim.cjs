/* =====================================================================
 * 净斗坦克 net-tank —— S1 帧同步共享确定性模拟（GAMES-40）
 * 单一事实源：服务端（server/gateway/sims/net-tank.js 经 require 载入本文件）
 * 与客户端（构建期内联进 index.html，设 window.NTSim）跑同一份代码。
 *
 * 确定性纪律（docs/net-protocol.md §5，红线）：
 *   - 判定路径零 Math.random；布局随机源 = mulberry32(fnv1a32(roomSeed))（§5.6 逐字实现）；
 *   - 模拟状态全整数（位置/速度为 milli-px），运算只用 + - * 与 Math.floor/trunc/sqrt/sign
 *     （IEEE754 确定性运算），除法结果立即取整；
 *   - 输入向量量化为整数后入模拟：mx/my ∈ [-100,100]，fire ∈ {0,1}。
 *
 * 场地：15×25 格（cell 25px → 375×625），四角出生位，对称墙；
 * 4 席 2v2（team = seat % 2，A=偶 B=奇）；HP 3；子弹 1 伤害；无友伤；无复活。
 * 终局：一队全灭（eliminated）或 maxTicks 到点按存活 HP 总和判胜（平则 draw）。
 *
 * Bot 三档（brain）：casual 慢反应随机游走 / balanced 保持距离索敌 / competitive 预判+侧移躲避。
 * brain 只在服务端 Bot 宿主与客户端离线练习模式调用；其随机源不入帧协议（输入即产物）。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node（.cjs）
  root.NTSim = api;                                                        // 浏览器内联（classic script）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- §5.6 PRNG 参考实现（与 games/_shared/common.js 逐字一致，冻结） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 常量（全整数，milli-px 单位） ---------- */
  const COLS = 15, ROWS = 25, CELL = 25;
  const CELL_M = CELL * 1000;             // 25000
  const W_M = COLS * CELL_M, H_M = ROWS * CELL_M;
  const HALF_M = 9000;                    // 坦克半边（18px 判定盒）
  const BHALF_M = 4000;                   // 子弹半边（8px 判定盒）
  const SPEED_M = 11000;                  // 坦克 110 px/tick(100ms)
  const BSPEED_M = 32000;                 // 子弹 320 px/tick
  const COOLDOWN = 6;                     // 开火冷却 6 tick（600ms）
  const LIFE = 16;                        // 子弹存活 16 tick（1.6s）
  const HP = 3;
  const SEATS = 4;
  const MAX_TICKS = 1200;                 // 120s

  const META = {
    gameId: 'net-tank', title: '净斗坦克', seats: SEATS, tickMs: 100, maxTicks: MAX_TICKS,
    cols: COLS, rows: ROWS, cell: CELL, W: COLS * CELL, H: ROWS * CELL,
    hpMax: HP, mode: '2v2-team', teams: { A: [0, 2], B: [1, 3] },
  };

  /* 出生位：四角（A 左上/右下，B 右上/左下），格子坐标 */
  const SPAWNS = [
    { c: 1, r: 1 }, { c: 13, r: 1 }, { c: 13, r: 23 }, { c: 1, r: 23 },
  ];

  const clamp100 = (v) => (v < -100 ? -100 : v > 100 ? 100 : v | 0);

  /* ---------- 场地生成（对称墙 + 出生区净空 + 连通性保险） ---------- */
  function genWalls(rng) {
    // 先边框；再左半场随机块镜像到右半（轴对称，出生区 3×3 净空）
    const g = [];
    for (let r = 0; r < ROWS; r++) {
      const row = new Array(COLS).fill(0);
      for (let c = 0; c < COLS; c++) {
        if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) row[c] = 1;
      }
      g.push(row);
    }
    const clear = (c0, r0) => {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const c = c0 + dc, r = r0 + dr;
        if (c > 0 && c < COLS - 1 && r > 0 && r < ROWS - 1) g[r][c] = 0;
      }
    };
    for (let s = 0; s < SEATS; s++) clear(SPAWNS[s].c, SPAWNS[s].r);
    for (let r = 2; r < ROWS - 2; r++) {
      for (let c = 2; c <= 7; c++) {
        if (rng() < 0.14) {
          const ok = SPAWNS.every((s) => Math.abs(s.c - c) > 1 || Math.abs(s.r - r) > 1)
            && SPAWNS.every((s) => Math.abs(s.c - (COLS - 1 - c)) > 1 || Math.abs(s.r - r) > 1);
          if (ok) { g[r][c] = 1; g[r][COLS - 1 - c] = 1; }
        }
      }
    }
    return g.map((row) => row.join('').replace(/0/g, '0').replace(/1/g, '1'));
  }

  /** 出生点互相可达（BFS，确定性）；不可达返回 false */
  function connected(walls) {
    const seen = new Array(ROWS * COLS).fill(0);
    const q = [SPAWNS[0].r * COLS + SPAWNS[0].c];
    seen[q[0]] = 1;
    let head = 0;
    while (head < q.length) {
      const p = q[head++], r = (p / COLS) | 0, c = p % COLS;
      const nb = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]];
      for (const [nc, nr] of nb) {
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const i = nr * COLS + nc;
        if (seen[i] || walls[nr].charCodeAt(nc) === 49) continue;
        seen[i] = 1; q.push(i);
      }
    }
    return SPAWNS.every((s) => seen[s.r * COLS + s.c]);
  }

  const solid = (walls, c, r) => (c < 0 || r < 0 || c >= COLS || r >= ROWS) ? true : walls[r].charCodeAt(c) === 49;

  /** 顺墙推挤（复用轴碰撞）：给坦克一个位移，被墙挡住则停在墙前 */
  function tryPush(walls, t, dx, dy) {
    moveX(walls, t, dx)
    moveY(walls, t, dy)
  }

  /* ---------- 初始态 ---------- */
  function create(seed, opts) {
    const maxTicks = (opts && opts.maxTicks) || MAX_TICKS;
    const rng = mulberry32(seed >>> 0);
    let walls = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = genWalls(rng);
      if (connected(w)) { walls = w; break; }
    }
    if (!walls) walls = genWalls(() => 0); // 兜底：仅边框（连通性必然成立）
    const cx = ((COLS / 2) | 0) * CELL_M + (CELL_M >> 1);
    const cy = ((ROWS / 2) | 0) * CELL_M + (CELL_M >> 1);
    const tanks = SPAWNS.map((s, seat) => {
      const x = s.c * CELL_M + CELL_M / 2 | 0;
      const y = s.r * CELL_M + CELL_M / 2 | 0;
      return {
        seat, team: seat % 2 === 0 ? 'A' : 'B', x, y,
        fx: x < cx ? 100 : -100, fy: y < cy ? 100 : -100, // 初始朝向场地中心
        hp: (opts && opts.hp) || HP, alive: true, cool: 0, lvx: 0, lvy: 0,
      };
    });
    return { v: 1, seed: seed >>> 0, tick: 0, maxTicks, walls, tanks, bullets: [], kills: { A: 0, B: 0 } };
  }

  /* ---------- 碰撞（轴分离 + 贴边吸附；坦克 < 1 格宽，前沿单列检测充分） ---------- */
  function moveX(walls, t, d) {
    if (!d) return;
    let nx = t.x + d;
    const edge = nx + (d > 0 ? HALF_M : -HALF_M);
    const c = Math.floor(edge / CELL_M);
    const r0 = Math.floor((t.y - HALF_M + 1) / CELL_M);
    const r1 = Math.floor((t.y + HALF_M - 1) / CELL_M);
    if (solid(walls, c, r0) || solid(walls, c, r1)) {
      nx = d > 0 ? c * CELL_M - HALF_M - 1 : (c + 1) * CELL_M + HALF_M + 1;
    }
    t.x = nx;
  }
  function moveY(walls, t, d) {
    if (!d) return;
    let ny = t.y + d;
    const edge = ny + (d > 0 ? HALF_M : -HALF_M);
    const r = Math.floor(edge / CELL_M);
    const c0 = Math.floor((t.x - HALF_M + 1) / CELL_M);
    const c1 = Math.floor((t.x + HALF_M - 1) / CELL_M);
    if (solid(walls, c0, r) || solid(walls, c1, r)) {
      ny = d > 0 ? r * CELL_M - HALF_M - 1 : (r + 1) * CELL_M + HALF_M + 1;
    }
    t.y = ny;
  }

  /** 输入向量 → 整数速度（milli-px/tick）；对角超长归一（sqrt 为 IEEE754 确定性运算） */
  function velocity(mx, my) {
    let nx = clamp100(mx | 0), ny = clamp100(my | 0);
    const len = Math.sqrt(nx * nx + ny * ny);
    if (len > 100) {
      const s = 100 / len;
      nx = Math.trunc(nx * s); ny = Math.trunc(ny * s);
    }
    return { vx: Math.trunc(nx * SPEED_M / 100), vy: Math.trunc(ny * SPEED_M / 100), nx, ny };
  }

  /* ---------- 单帧推进（inputs: {<seat>:{mx,my,fire}}，缺席按零输入） ---------- */
  function step(state, inputs) {
    const ev = [];
    const { walls, tanks, bullets } = state;

    // 1) 坦克移动/开火
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      if (!t.alive) continue;
      const inp = inputs[t.seat] || { mx: 0, my: 0, fire: 0 };
      const { vx, vy, nx, ny } = velocity(inp.mx, inp.my);
      t.lvx = vx; t.lvy = vy;
      const px0 = t.x, py0 = t.y;
      moveX(walls, t, vx);
      moveY(walls, t, vy);
      // 防卡死账本（确定性）：有力输出但位移 <2px 记 1 tick 卡死，brain 据此脱困
      const movedSq = (t.x - px0) * (t.x - px0) + (t.y - py0) * (t.y - py0);
      if (nx * nx + ny * ny > 900 && movedSq < 4000000) t.sx = (t.sx || 0) < 99 ? t.sx + 1 : t.sx;
      else t.sx = 0;
      if (nx !== 0 || ny !== 0) { t.fx = nx; t.fy = ny; }
      if (t.cool > 0) t.cool--;
      if (inp.fire && t.cool === 0) {
        const fl = Math.sqrt(t.fx * t.fx + t.fy * t.fy) || 1;
        const s = BSPEED_M / fl;
        const dx = Math.trunc(t.fx * s), dy = Math.trunc(t.fy * s);
        bullets.push({ x: t.x + Math.trunc(t.fx * 120), y: t.y + Math.trunc(t.fy * 120), dx, dy, team: t.team, by: t.seat, life: LIFE });
        t.cool = COOLDOWN;
        ev.push({ k: 'shot', seat: t.seat });
      }
    }

    // 1.5) 坦克实体分离（不可互穿——防对穿振荡导致的"贴脸永不开火"；席位对序推挤，确定性）
    for (let i = 0; i < tanks.length; i++) {
      const a = tanks[i]
      if (!a.alive) continue
      for (let j = i + 1; j < tanks.length; j++) {
        const b = tanks[j]
        if (!b.alive) continue
        const ddx = b.x - a.x, ddy = b.y - a.y
        const ox = 2 * HALF_M - (ddx < 0 ? -ddx : ddx)
        const oy = 2 * HALF_M - (ddy < 0 ? -ddy : ddy)
        if (ox <= 0 || oy <= 0) continue
        if (ox < oy) {
          const s = ddx >= 0 ? 1 : -1
          const half = (ox / 2) | 0
          tryPush(walls, a, -s * (ox - half), 0)
          tryPush(walls, b, s * half, 0)
        } else {
          const s = ddy >= 0 ? 1 : -1
          const half = (oy / 2) | 0
          tryPush(walls, a, 0, -s * (oy - half))
          tryPush(walls, b, 0, s * half)
        }
      }
    }

    // 2) 子弹推进（数组序稳定，filter 保序）。子步推进：单步 32px 会隧穿 20px 外目标/薄墙，
    //    定长 4 子步（8px/步，整数插值）——命中判定盒 26px、墙格 25px，均不可跳过
    const SUB = 4;
    const live = [];
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      const bx0 = b.x, by0 = b.y;
      let dead = false;
      for (let k = 1; k <= SUB && !dead; k++) {
        b.x = bx0 + Math.trunc(b.dx * k / SUB);
        b.y = by0 + Math.trunc(b.dy * k / SUB);
        const c0 = Math.floor((b.x - BHALF_M) / CELL_M), c1 = Math.floor((b.x + BHALF_M) / CELL_M);
        const r0 = Math.floor((b.y - BHALF_M) / CELL_M), r1 = Math.floor((b.y + BHALF_M) / CELL_M);
        if (solid(walls, c0, r0) || solid(walls, c1, r0) || solid(walls, c0, r1) || solid(walls, c1, r1)) { dead = true; break; }
        let hit = -1;
        for (let j = 0; j < tanks.length; j++) {
          const t = tanks[j];
          if (!t.alive || t.team === b.team) continue; // 无友伤
          const ddx = b.x - t.x, ddy = b.y - t.y;
          if (ddx < 0 ? -ddx < HALF_M + BHALF_M : ddx < HALF_M + BHALF_M) {
            if (ddy < 0 ? -ddy < HALF_M + BHALF_M : ddy < HALF_M + BHALF_M) { hit = j; break; }
          }
        }
        if (hit >= 0) {
          const t = tanks[hit];
          t.hp--;
          ev.push({ k: 'hit', seat: t.seat, by: b.by, hp: t.hp });
          if (t.hp <= 0) {
            t.alive = false;
            state.kills[b.team === 'A' ? 'A' : 'B']++;
            ev.push({ k: 'die', seat: t.seat, by: b.by });
          }
          dead = true;
          break;
        }
      }
      if (dead || --b.life <= 0) continue;
      live.push(b);
    }
    state.bullets = live;
    state.tick++;

    // 3) 终局判定（服务端权威；客户端同码复核）
    let aliveA = 0, aliveB = 0, hpA = 0, hpB = 0;
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      if (!t.alive) continue;
      if (t.team === 'A') { aliveA++; hpA += t.hp; } else { aliveB++; hpB += t.hp; }
    }
    if (aliveA === 0 || aliveB === 0) {
      return { events: ev, over: true, result: { winner: aliveA === 0 && aliveB === 0 ? 'draw' : (aliveA === 0 ? 'B' : 'A'), scores: { ...state.kills }, reason: 'eliminated' } };
    }
    if (state.tick >= state.maxTicks) {
      return { events: ev, over: true, result: { winner: hpA === hpB ? 'draw' : (hpA > hpB ? 'A' : 'B'), scores: { ...state.kills }, reason: 'timeout' } };
    }
    return { events: ev, over: false };
  }

  const serialize = (state) => JSON.stringify(state);
  const deserialize = (json) => JSON.parse(json);

  /* =====================================================================
   * Bot 决策 brain(state, seat, level, rng) → {mx,my,fire}
   * rng 由调用方持有（服务端每 bot 一个 mulberry32；离线模式客户端自持）。
   * 输出即输入向量，走与真人完全相同的帧通道。
   * ===================================================================== */
  /** BFS 网格寻路（确定性：固定邻居序/Int16Array 回溯）→ 返回路径第一步格中心 milli-px；不可达/同格返回 null */
  function bfsNext(walls, fc, fr, tc, tr) {
    if (fc === tc && fr === tr) return null
    const start = fr * COLS + fc, goal = tr * COLS + tc
    const prev = new Int16Array(COLS * ROWS).fill(-1)
    const seen = new Uint8Array(COLS * ROWS)
    const q = [start]
    seen[start] = 1
    let head = 0, found = false
    while (head < q.length && !found) {
      const p = q[head++]
      if (p === goal) { found = true; break }
      const r = (p / COLS) | 0, c = p % COLS
      for (let k = 0; k < 4; k++) { // 固定邻居序：上左下右（确定性纪律）
        const nc = c + (k === 0 ? 0 : k === 1 ? -1 : k === 2 ? 0 : 1)
        const nr = r + (k === 0 ? -1 : k === 1 ? 0 : k === 2 ? 1 : 0)
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue
        const i = nr * COLS + nc
        if (seen[i] || walls[nr].charCodeAt(nc) === 49) continue
        seen[i] = 1
        prev[i] = p
        q.push(i)
      }
    }
    if (!found) return null
    let cur = goal
    const first = start
    let guard = 0
    while (prev[cur] !== first && prev[cur] !== -1 && guard++ < COLS * ROWS) cur = prev[cur]
    if (prev[cur] !== first) return null
    const r = (cur / COLS) | 0, c = cur % COLS
    return { x: c * CELL_M + (CELL_M >> 1), y: r * CELL_M + (CELL_M >> 1) }
  }

  /** 视线检查（确定性采样）：两点间每 ~12px 采一点，穿墙返回 false */
  function los(walls, x0, y0, x1, y1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 12000 | 0
    for (let i = 1; i <= steps; i++) {
      const x = x0 + ((x1 - x0) / steps * i | 0), y = y0 + ((y1 - y0) / steps * i | 0)
      if (solid(walls, Math.floor(x / CELL_M), Math.floor(y / CELL_M))) return false
    }
    return true
  }

  function nearestEnemy(state, me) {
    let best = null, bd = Infinity; // milli-px 平方距离可达 ~4e11，不可用 1<<30 当上界
    for (let i = 0; i < state.tanks.length; i++) {
      const t = state.tanks[i];
      if (!t.alive || t.team === me.team) continue;
      const dx = t.x - me.x, dy = t.y - me.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = t; }
    }
    return best ? { t: best, d: Math.sqrt(bd) | 0 } : null;
  }

  function brain(state, seat, level, rng) {
    const me = state.tanks[seat];
    if (!me || !me.alive) return { mx: 0, my: 0, fire: 0 };
    const target = nearestEnemy(state, me);

    // casual：每 5 tick 决策一次的短记忆（用 tick 相位 + 确定性伪随机替代记忆）
    if (level === 'casual') {
      if (!target) return { mx: 0, my: 0, fire: 0 };
      const phase = (state.tick + seat * 5) % 5;
      const r = rng();
      let mx = 0, my = 0;
      if (phase === 0) {
        // 换一个游走/追击方向：70% 朝敌带 ±45° 抖动，30% 随机向
        if (r < 0.7) {
          const dx = target.t.x - me.x, dy = target.t.y - me.y;
          const jx = (rng() - 0.5) * Math.abs(dx) * 0.8 | 0;
          const jy = (rng() - 0.5) * Math.abs(dy) * 0.8 | 0;
          mx = clamp100(dx / 100 | 0); my = clamp100(dy / 100 | 0);
          mx = clamp100(mx + jx / 100 | 0); my = clamp100(my + jy / 100 | 0);
        } else {
          const a = (rng() * 4) | 0;
          mx = a === 0 ? 100 : a === 1 ? -100 : 0;
          my = a === 2 ? 100 : a === 3 ? -100 : 0;
        }
      }
      // 粗略瞄准门（朝向大致对敌才开火）+ 低弹幕率——休闲档弱在乱逛与低命中，不是射速
      const fdx = target.t.x - me.x, fdy = target.t.y - me.y;
      const fl = Math.sqrt(me.fx * me.fx + me.fy * me.fy) || 1;
      const aim0 = (me.fx / fl) * fdx + (me.fy / fl) * fdy;
      const fire = target.d < 260000 && aim0 > 0 && rng() < 0.12 ? 1 : 0;
      return { mx, my, fire };
    }

    if (level === 'balanced') {
      if (!target) return { mx: 0, my: 0, fire: 0 };
      const dx = target.t.x - me.x, dy = target.t.y - me.y;
      const d = target.d; // milli-px
      let mx = 0, my = 0;
      if (d > 220000 || d < 140000) {
        // 进出距离带：BFS 寻路走向/背向敌人（远则逼近，近则拉开）
        const sign = d > 220000 ? 1 : -1;
        const wp = bfsNext(state.walls,
          Math.floor(me.x / CELL_M), Math.floor(me.y / CELL_M),
          Math.floor(target.t.x / CELL_M), Math.floor(target.t.y / CELL_M));
        if (wp && sign > 0) {
          mx = clamp100((wp.x - me.x) / 2000 | 0); my = clamp100((wp.y - me.y) / 2000 | 0);
        } else {
          mx = clamp100(sign * (dx / 2000 | 0)); my = clamp100(sign * (dy / 2000 | 0));
        }
      } else { // 环绕：切向移动
        mx = clamp100(-dy / 2000 | 0); my = clamp100(dx / 2000 | 0);
      }
      // 大致朝敌才开火（方向叉积小于阈值）
      const cross = me.fx * dy - me.fy * dx;
      const dot = me.fx * dx + me.fy * dy;
      const aligned = dot > 0 && (cross < 0 ? -cross : cross) < (dot / 2 | 0 ? (dot / 2 | 0) : 1);
      const fire = target.d < 260000 && aligned && rng() < 0.85 ? 1 : 0;
      if (me.sx >= 3) { // 防卡死：期望方向旋转 90° 蹭出
        const flip = ((state.tick >> 2) & 1) === 1 ? 1 : -1;
        const t0 = mx;
        mx = clamp100(-my * flip); my = clamp100(t0 * flip);
      }
      return { mx, my, fire };
    }

    // competitive：预判提前量 + 来弹垂直躲避 + 近距缠斗
    if (!target) return { mx: 0, my: 0, fire: 0 };
    const t = target.t;
    const dx = t.x - me.x, dy = t.y - me.y;
    const dist = Math.sqrt(dx * dx + dy * dy) | 0;
    const eta = dist / BSPEED_M | 0; // 子弹飞行 tick 数
    const ax = t.x + (t.lvx * eta | 0) - me.x; // 预判点
    const ay = t.y + (t.lvy * eta | 0) - me.y;
    // 躲避：检查己方来袭子弹（敌队、且弹道将在 2 tick 内经过附近）。
    // 仅中远距躲避——近战(<40px)站桩对射换血：对弹幕流永躲=永不开火的死循环（平衡教训）
    let dodge = null;
    if (dist >= 40000) {
      for (let i = 0; i < state.bullets.length; i++) {
        const b = state.bullets[i];
        if (b.team === me.team) continue;
        const relx = me.x - b.x, rely = me.y - b.y;
        const ahead = relx * b.dx + rely * b.dy; // >0 = 朝我来
        if (ahead <= 0) continue;
        const bx = b.x + b.dx * 2, by = b.y + b.dy * 2;
        if ((bx - me.x < 0 ? -(bx - me.x) : bx - me.x) < 60000 && (by - me.y < 0 ? -(by - me.y) : by - me.y) < 60000) {
          dodge = b; break;
        }
      }
    }
    let mx, my;
    if (me.sx >= 3) {
      // 脱困：沿敌向的垂直方向蹭出凹角，(tick>>2)&1 交替正反（确定性，无随机源）
      const flip = ((state.tick >> 2) & 1) === 1 ? 1 : -1;
      const dl = dist || 1;
      const dirx = Math.trunc(dx / dl * 100), diry = Math.trunc(dy / dl * 100);
      mx = clamp100(-diry * flip);
      my = clamp100(dirx * flip);
    } else if (dodge) {
      // 垂直于弹道方向侧移（代价：暂时丢失瞄准轴——朝向绑定移动方向的 lite 模型）
      mx = clamp100(dodge.dy / 320 | 0); my = clamp100(-dodge.dx / 320 | 0);
    } else if (dist < 40000) {
      // 近距对轴：已对准且有视线 → 停车身开火（朝向锁定敌向，杜绝对穿振荡）；
      // 未对准则逼近——速度按接触距离衰减（贴住即停，防对穿互换振荡）
      const fl0 = Math.sqrt(me.fx * me.fx + me.fy * me.fy) || 1;
      const dot0 = (me.fx / fl0) * (dx / (dist || 1)) + (me.fy / fl0) * (dy / (dist || 1));
      if (dot0 > 0.9 && los(state.walls, me.x, me.y, t.x, t.y)) return { mx: 0, my: 0, fire: 1 };
      const dl = dist || 1;
      const f = Math.min(1, Math.max(0, dist - 19000) / 22000);
      mx = clamp100(Math.trunc(dx / dl * 100 * f));
      my = clamp100(Math.trunc(dy / dl * 100 * f));
    } else {
      // BFS 寻路压向敌人（移动方向即朝向 → 边走边对轴）；无路（同格/异常）直压预判点
      const wp = bfsNext(state.walls,
        Math.floor(me.x / CELL_M), Math.floor(me.y / CELL_M),
        Math.floor(t.x / CELL_M), Math.floor(t.y / CELL_M));
      const gx = wp ? wp.x : me.x + ax, gy = wp ? wp.y : me.y + ay;
      mx = clamp100((gx - me.x) / 2000 | 0);
      my = clamp100((gy - me.y) / 2000 | 0);
    }
    // 开火：当前朝向对预判点的偏差（贴脸放宽阈值，远距狙击收紧）
    const fl = Math.sqrt(me.fx * me.fx + me.fy * me.fy) || 1;
    const ux = me.fx / fl, uy = me.fy / fl;
    const tl = Math.sqrt(ax * ax + ay * ay) || 1;
    const tx = ax / tl, ty = ay / tl;
    const aimDot = ux * tx + uy * ty;
    const aimLine = dist < 80000 ? 0.75 : 0.92;
    const fire = dist < 300000 && aimDot > aimLine ? 1 : 0;
    return { mx, my, fire };
  }

  const LEVELS = ['casual', 'balanced', 'competitive'];

  return { META, create, step, serialize, deserialize, brain, fnv1a32, mulberry32, LEVELS, clamp100 };
});
