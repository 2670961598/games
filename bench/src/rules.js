'use strict';
/* =====================================================================
 * GAMES-24 引擎基准——共享规则层（全引擎字节一致，build.mjs 内联进每个页面）。
 * 目的：Phaser3 / Phaser4 / PixiJS8 / 原生Canvas 四个栈跑**同一套**玩法状态机：
 *      同 seed → 同关卡布局 → 同实体流 → 同判定/计分，引擎层只负责渲染/输入/循环接线。
 *      这样 fps / 内存 / 冷启动差异才可归因于引擎而非玩法实现差异。
 * 口径：玩法参数逐字对齐线上引擎（games/_shared/engines/tap-burst.js §7、
 *      lane-runner.js §9），PRNG 为 spec §5.6 冻结实现；关卡固定 L15/30（曲线中段，
 *      稳定工作负载）。?load=N 为压力倍率（只放大生成密度/速度，判定逻辑不变）。
 * ===================================================================== */
const R24 = (function () {

  /* ---------- §5.6 PRNG（冻结，与 games/_shared/common.js 逐字一致） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  const W = 375, H = 667, TOP = 48;      /* §5.4 竖屏逻辑分辨率 + 顶栏高 */
  const STEP = 1 / 120;                  /* 固定物理步长（全引擎一致，判定确定性铁律） */
  const LEVEL = 15, LEVELS = 30;         /* 固定中段关卡（曲线 p≈0.448） */
  const P = (LEVEL - 1) / (LEVELS - 1);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  /* =====================================================================
   * 玩法一：tap-burst（高频点击类代表，§7）
   * 曲线/计分/生成逻辑逐字对齐线上引擎；load 只乘 spawnPerSec 并放宽在场上限。
   * ===================================================================== */
  function makeTap(load, slug, emit) {
    const t = { targetBase: 20, timeSec: 20, sizePx: 72, spawnPerSec: 1.6, decoyRate: 0.08 };
    /* 压力档：目标数随 load 线性放大（否则机器人 21 中后秒赢重启，压力上不去） */
    const target = Math.ceil(t.targetBase * (1 + 0.10 * P) * load);
    const time = Math.max(10, Math.round(t.timeSec * (1 - 0.15 * P)));
    const size = Math.max(48, Math.round(t.sizePx * (1 - 0.10 * P)));
    const rate = +(t.spawnPerSec * (1 + 0.20 * P)).toFixed(3);
    const decoyRate = +Math.min(0.5, t.decoyRate * (1 + 0.10 * P)).toFixed(3);
    const rateL = rate * load;
    const CAP = Math.min(480, Math.ceil(rateL * time) + 16);   /* 压力档防失控上限（同引擎同值） */
    const T0 = 0.3;
    /* 游戏区（顶栏下方，与 common.js 外壳一致） */
    const area = { x: 0, y: TOP, w: W, h: H - TOP };
    const r = size / 2;
    const bx = area.w * 0.05 + r, bX = area.w * 0.95 - r;
    const by = area.y + area.h * 0.05 + r, bY = area.y + area.h * 0.95 - r;

    const S = {
      kind: 'tap', W, H, area, target, time, size, rate: rateL, decoyRate,
      items: [], popFx: [], timeLeft: 0, hits: 0, decoyHits: 0,
      combo: 0, maxCombo: 0, score: 0, done: false, anim: 0,
      rng: null, botRng: null, spawns: [], sp: 0, idc: 0,
      restarts: 0, events: 0, params: { target, time, size, rate: rateL, decoyRate, load, CAP },
    };

    function place() {   /* 落点两两不重叠：环形重试再放（确定性，同线上 §7） */
      for (let k = 0; k < 24; k++) {
        const x = bx + S.rng() * (bX - bx), y = by + S.rng() * (bY - by);
        if (S.items.every(it => (it.x - x) * (it.x - x) + (it.y - y) * (it.y - y) > (it.r + r + 6) * (it.r + r + 6))) return { x, y };
      }
      return { x: bx + S.rng() * (bX - bx), y: by + S.rng() * (bY - by) };
    }

    S.reset = function () {
      S.rng = mulberry32(fnv1a32(`${slug}#${LEVEL}`));
      S.botRng = mulberry32(fnv1a32(`${slug}#bot#${LEVEL}`));
      S.spawns = [];
      for (let tt = T0; tt < time; tt += 1 / rateL) {
        S.spawns.push({ t: +tt.toFixed(4), decoy: S.rng() < decoyRate, hue: Math.floor(S.rng() * 360) });
      }
      S.items.length = 0; S.popFx.length = 0; S.sp = 0; S.idc = 0;
      S.timeLeft = time; S.hits = 0; S.decoyHits = 0; S.combo = 0; S.maxCombo = 0;
      S.score = 0; S.done = false; S.anim = 0;
      if (S.restarts > 0) emit('restart', {});
    };

    function step() {
      if (S.done) return;
      S.timeLeft -= STEP;
      const now = time - S.timeLeft;
      while (S.sp < S.spawns.length && S.spawns[S.sp].t <= now) {
        if (S.items.length >= CAP) { S.sp++; continue; }        /* 上限即跳过（护压力档） */
        const s = S.spawns[S.sp];
        const pos = place();
        const it = { id: ++S.idc, x: pos.x, y: pos.y, r: s.decoy ? r * 0.72 : r, decoy: s.decoy, hue: s.hue, born: S.anim };
        S.items.push(it); S.events++; S.sp++;
        emit('spawn', it);
      }
      if (S.timeLeft <= 0) { S.done = true; S.score = curScore(); emit('over', { win: false, score: S.score }); }
    }

    const curScore = () => Math.max(0, S.hits * 10 + S.maxCombo * 5 - S.decoyHits * 15);

    S.update = function (dt) {          /* dt 为帧间隔（秒），内部固定步长累加（同线上） */
      S.anim += dt;
      let acc = dt;
      while (acc >= STEP) { acc -= STEP; step(); if (S.onStep) S.onStep(); if (S.done) break; }
      S.score = curScore();
      for (let i = S.popFx.length - 1; i >= 0; i--) { S.popFx[i].t -= dt; if (S.popFx[i].t <= 0) S.popFx.splice(i, 1); }
    };

    S.tap = function (x, y) {           /* 顶至底取最先命中；空点/陷阱断连击（裁量②） */
      if (S.done) return;
      for (let i = S.items.length - 1; i >= 0; i--) {
        const it = S.items[i];
        if ((x - it.x) * (x - it.x) + (y - it.y) * (y - it.y) <= it.r * it.r) {
          S.items.splice(i, 1); S.events++;
          if (it.decoy) { S.decoyHits++; S.combo = 0; emit('decoyHit', it); }
          else {
            S.hits++; S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
            const sparks = [];
            for (let k = 0; k < 8; k++) sparks.push({ a: (k / 8) * Math.PI * 2 + (S.hits % 8) * 0.13, sp: 120 + ((S.hits * 7 + k * 13) % 60) });
            S.popFx.push({ x: it.x, y: it.y, hue: it.hue, t: 0.4, sparks });
            emit('pop', it);
            if (S.hits >= target) { S.done = true; S.score = curScore(); emit('over', { win: true, score: S.score }); return; }
          }
          return;
        }
      }
      S.combo = 0;                       /* 空点断连击 */
    };

    S.reset();
    return S;
  }

  /* =====================================================================
   * 玩法二：lane-runner（滚动+碰撞类代表，§9）
   * 三车道/安全走廊生成/跳跳物理/计分逐字对齐线上引擎。
   * load：speed×load^0.75、obsRate/coinRate 趋近压力上限（文档化公式）。
   * ===================================================================== */
  function makeRunner(load, slug, emit) {
    const SEG = 120, LANES = 3, OB_LOW = 42, OB_TALL = 88, TALL_RATE = 0.35;
    const t = { speed: 300, obsRate: 0.30, hearts: 3, coinRate: 0.10, distanceBase: 2000 };
    /* 压力档：speed 与 distance 同乘 load^0.75（轮次时长不变、单位时间实体流加密），
     * obsRate/coinRate 趋近上限；判定逻辑不变。 */
    const speed = +(t.speed * (1 + 0.35 * P) * Math.pow(load, 0.75)).toFixed(2);
    const obsRate = Math.min(0.55, t.obsRate * (1 + 0.25 * P) * (1 + (load - 1) * 0.35));
    const coinRate = Math.min(0.35, t.coinRate * (1 + (load - 1) * 0.5));
    const distance = Math.round(t.distanceBase * (1 + 0.50 * P) * Math.pow(load, 0.75));
    const coinTarget = Math.ceil(15 * (1 + 0.40 * P));
    const area = { x: 0, y: TOP, w: W, h: H - TOP };
    const laneW = area.w / LANES;
    const playerY = area.y + area.h * 0.70;          /* §9 单手映射：角色固定屏高 70% */
    const OB_H = { 1: OB_LOW, 3: OB_TALL };

    const S = {
      kind: 'runner', W, H, area, SEG, LANES, laneW, playerY, speed, distance, OB_H,
      lanes: [], safePlan: [], segN: 0,
      lane: 1, px: 0, jumpY: 0, vy: 0, dist: 0, coins: 0, hearts: t.hearts, invuln: 0,
      done: false, score: 0, anim: 0, rng: null, botRng: null,
      restarts: 0, events: 0, params: { speed, obsRate, coinRate, distance, coinTarget, load },
    };

    S.reset = function () {
      S.rng = mulberry32(fnv1a32(`${slug}#${LEVEL}`));
      S.botRng = mulberry32(fnv1a32(`${slug}#bot#${LEVEL}`));
      S.segN = Math.ceil(distance / SEG);
      S.lanes = []; S.safePlan = [];
      let run = 0, safe = Math.floor(S.rng() * LANES);
      for (let s = 0; s < S.segN; s++) {
        const row = [0, 0, 0];                      /* 0空 1矮障 2金币 3高障 */
        if (run < 3) {
          for (let l = 0; l < LANES; l++) {
            const r = S.rng();
            if (r < obsRate) row[l] = S.rng() < TALL_RATE ? 3 : 1;
            else if (r < obsRate + coinRate) row[l] = 2;
          }
          let free = [0, 1, 2].filter(k => row[k] !== 1 && row[k] !== 3);
          if (!free.length) { row[Math.floor(S.rng() * LANES)] = 0; free = [0, 1, 2].filter(k => row[k] !== 1 && row[k] !== 3); }
          const near = free.filter(k => Math.abs(k - safe) <= 1);
          if (near.length) safe = near[Math.floor(S.rng() * near.length)];
          else {
            let best = 0;
            for (let k = 1; k < LANES; k++) if (Math.abs(k - safe) < Math.abs(best - safe)) best = k;
            row[best] = 0; safe = best;
          }
          run = (row[0] === 1 || row[0] === 3 || row[1] === 1 || row[1] === 3 || row[2] === 1 || row[2] === 3) ? run + 1 : 0;
        } else run = 0;
        S.lanes.push(row); S.safePlan.push(safe);
      }
      S.lane = 1; S.px = laneW * 1.5; S.jumpY = 0; S.vy = 0;
      S.dist = 0; S.coins = 0; S.hearts = t.hearts; S.invuln = 0;
      S.done = false; S.score = 0; S.anim = 0;
      if (S.restarts > 0) emit('restart', {});
    };

    const laneX = (l) => laneW * (l + 0.5);

    S.swipe = function (dx, dy) {       /* §12 定向：位移 ≥24px 主轴优先 */
      if (S.done) return;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      if (Math.abs(dx) >= Math.abs(dy)) { const nl = clamp(S.lane + (dx > 0 ? 1 : -1), 0, LANES - 1); if (nl !== S.lane) S.lane = nl; }
      else if (dy < 0 && S.jumpY <= 0) S.vy = 560;
    };

    function step() {
      if (S.done) return;
      S.dist += speed * STEP;
      if (S.invuln > 0) S.invuln -= STEP;
      const tx = laneX(S.lane);
      S.px += clamp(tx - S.px, -900 * STEP, 900 * STEP);
      if (S.jumpY > 0 || S.vy > 0) { S.vy -= 1500 * STEP; S.jumpY += S.vy * STEP; if (S.jumpY <= 0) { S.jumpY = 0; S.vy = 0; } }
      const seg = Math.floor(S.dist / SEG);
      for (let s = Math.max(0, seg - 1); s <= Math.min(S.segN - 1, seg + 1); s++) {
        const z = s * SEG + SEG / 2;
        if (Math.abs(z - S.dist) >= 28) continue;
        const v = S.lanes[s][S.lane];
        if (v === 2) { S.coins++; S.lanes[s][S.lane] = 0; S.events++; emit('coin', { s, lane: S.lane }); }
        else if ((v === 1 || v === 3) && S.invuln <= 0) {
          if (!(v === 1 && S.jumpY > OB_LOW - 6)) {
            S.hearts--; S.invuln = 1.2; S.events++;
            emit('hit', { hearts: S.hearts });
            if (S.hearts <= 0) { S.done = true; S.score = S.coins * 20 + S.hearts * 50; emit('over', { win: false, score: S.score }); return; }
          }
        }
      }
      if (S.dist >= S.distance) { S.done = true; S.score = S.coins * 20 + S.hearts * 50; emit('over', { win: true, score: S.score }); }
    }

    S.update = function (dt) {
      S.anim += dt;
      let acc = dt;
      while (acc >= STEP) { acc -= STEP; step(); if (S.onStep) S.onStep(); if (S.done) break; }
    };

    S.reset();
    return S;
  }

  /* =====================================================================
   * 确定性机器人（fps/内存跑的自动游玩，跨引擎同一决策序列）：
   * 通过 emitTap/emitSwipe 合成 PointerEvent 打到画布上，走**引擎输入管线**而非直调 sim。
   * tap：140ms 一决策——55% 点最新目标（±3px 抖动）、5% 点陷阱、40% 随机空点
   *      （"跟不上的玩家"口径：压力档下目标积压 → 渲染负载随 load 爬坡）。
   * runner：220ms 一决策——朝前方安全走廊换道；当前道前方矮障则跳；15% 随机扰动。
   * ===================================================================== */
  function makeBot(sim, emitTap, emitSwipe) {
    let next = 0.14;
    return function botTick() {
      if (sim.done) return;
      if (sim.kind === 'tap') {
        next -= STEP;
        if (next > 0) return;
        next = 0.14;
        const r = sim.botRng();
        const targets = sim.items.filter(it => !it.decoy);
        const decoys = sim.items.filter(it => it.decoy);
        if (r < 0.55 && targets.length) {
          const it = targets[targets.length - 1];
          emitTap(it.x + (sim.botRng() - 0.5) * 6, it.y + (sim.botRng() - 0.5) * 6);
        } else if (r < 0.60 && decoys.length) {
          const it = decoys[decoys.length - 1];
          emitTap(it.x, it.y);
        } else {
          emitTap(20 + sim.botRng() * (W - 40), sim.area.y + 20 + sim.botRng() * (sim.area.h - 40));
        }
      } else {
        next -= STEP;
        if (next > 0) return;
        next = 0.22;
        const seg = Math.floor(sim.dist / sim.SEG);
        const look = Math.min(sim.segN - 1, seg + 3);
        const desired = sim.safePlan[look];
        const r = sim.botRng();
        if (r < 0.15) { emitSwipe(r < 0.075 ? -60 : 60, 0); }
        else if (desired !== sim.lane) { emitSwipe(desired > sim.lane ? 60 : -60, 0); }
        else {
          const ahead = sim.lanes[Math.min(sim.segN - 1, seg + 1)];
          if (ahead && ahead[sim.lane] === 1) emitSwipe(0, -60);
          else if (r > 0.9) emitSwipe(0, -60);
        }
      }
    };
  }

  return { fnv1a32, mulberry32, W, H, TOP, STEP, LEVEL, LEVELS, makeTap, makeRunner, makeBot, clamp };
})();
