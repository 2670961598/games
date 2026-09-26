'use strict';
/* =====================================================================
 * 车道跑酷引擎（spec §9）：三纵向车道，左右滑换道、上滑跳，跑到终点线即胜；
 * 撞障碍耗 hearts，耗尽即败。
 * GAMES-30 试点重构（原生基座黄金样本）：判定路径逐字保留（rng 消费序/步长/物理
 * 与旧版一致——QA 确定性/可赢性断言原样可跑）；表现层按 GAMES-24 §7.2.A 强化：
 *   A1 车道线/地面静态层离屏缓存（一次成图、主循环只 blit；bench 已证明可行），
 *      无 document.createElement 环境（vm 桩/QA harness）自动回退直绘；
 *   零 G./GE. 依赖（任何外壳/vm 桩可驱动）。
 * 曲线：speed(L)=speed×(1+0.35p)；obsRate(L)=min(0.50, obsRate×(1+0.25p))；
 *       distance(L)=round(distanceBase×(1+0.50p))；coinTarget(L)=ceil(15×(1+0.40p))，p=(L−1)/(Ln−1)。
 * 生成（§9）：车道按 120px 分段逐车道掷点障碍/金币；硬约束：任一横截面 ≥1 空车道、
 *   连续障碍段 ≤3；本实现另加"安全走廊"不变量（相邻段空车道相差 ≤1，
 *   高于 spec 下限的可达性保证——单次换道必有活路），障碍分矮(可跳)/高(必换道)两类。
 * 计分：score=金币×20+剩余hearts×50；s2=coinTarget(L)×24，s3=coinTarget(L)×30。
 * 物理：固定步长 1/120s 累加器；角色固定屏高 70% 处（§9 单手映射）。
 * ===================================================================== */
const LaneRunnerEngine = (function () {
  const SEG = 120;          // 分段长 px（§9）
  const LANES = 3;
  const OB_LOW = 42, OB_TALL = 88;   // 矮障碍（可跳过）/ 高障碍（必须换道）
  const TALL_RATE = 0.35;   // 障碍中高障碍占比（seed 掷点）
  const STEP = 1 / 120;

  /* 本地工具（判定路径零外部依赖；与 GE/common.js 实现逐字一致） */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  const FONT = (px, w) => `${w || 400} ${px}px -apple-system,"PingFang SC","Noto Sans SC",sans-serif`;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ speed: 300, obsRate: 0.30, hearts: 3, coinRate: 0.10, distanceBase: 2000 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const speed = +(t.speed * (1 + 0.35 * p)).toFixed(2);
    const obsRate = Math.min(0.50, t.obsRate * (1 + 0.25 * p));
    const distance = Math.round(t.distanceBase * (1 + 0.50 * p));
    const coinTarget = Math.ceil(15 * (1 + 0.40 * p));
    const laneW = area.w / LANES;
    const playerY = area.y + area.h * 0.70;

    /* --- §7.2.A.1 静态层：车道分隔线 + 地面底色（不变层一次成图，主循环只 blit） --- */
    let laneLayer = null;                                     // { w, h, cvs|null }；cvs=null 回退直绘
    function staticLayer() {
      if (laneLayer && laneLayer.w === area.w && laneLayer.h === area.h) return laneLayer;
      let ok = false;
      try {
        if (typeof document !== 'undefined' && document.createElement) {
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(area.w * 2)); c.height = Math.max(1, Math.round(area.h * 2));
          const lg = c.getContext('2d');
          if (lg) { lg.scale(2, 2); drawLanes(lg, 0); ok = true; laneLayer = { w: area.w, h: area.h, cvs: c }; }
        }
      } catch (e) { ok = false; }
      if (!ok) laneLayer = { w: area.w, h: area.h, cvs: null };
      return laneLayer;
    }
    /** 车道底色+分隔线（oy=层内 0 偏移 / 直绘 area.y） */
    function drawLanes(g, oy) {
      g.fillStyle = '#151a26'; g.fillRect(0, oy, area.w, area.h);
      for (let l = 0; l <= LANES; l++) {
        g.strokeStyle = '#1c2438'; g.lineWidth = l % LANES === 0 ? 2 : 1;
        g.beginPath(); g.moveTo(laneW * l, oy); g.lineTo(laneW * l, oy + area.h); g.stroke();
      }
    }

    /* --- 关卡生成：lanes[seg][lane] = 0空 1矮障 2金币 3高障 --- */
    const segN = Math.ceil(distance / SEG);
    const lanes = [];
    const safePlan = [];                                   // 生成期记录的可达走廊（相邻差 ≤1）
    let run = 0, safe = Math.floor(rng() * LANES);
    for (let s = 0; s < segN; s++) {
      const row = [0, 0, 0];
      if (run < 3) {                                       // 连续障碍段 ≤3：达到 3 段则本段强制空
        for (let l = 0; l < LANES; l++) {
          const r = rng();
          if (r < obsRate) row[l] = rng() < TALL_RATE ? 3 : 1;
          else if (r < obsRate + t.coinRate) row[l] = 2;
        }
        let free = [0, 1, 2].filter(k => row[k] !== 1 && row[k] !== 3);
        if (!free.length) { row[Math.floor(rng() * LANES)] = 0; free = [0, 1, 2].filter(k => row[k] !== 1 && row[k] !== 3); }
        const near = free.filter(k => Math.abs(k - safe) <= 1);
        if (near.length) safe = near[Math.floor(rng() * near.length)];
        else {                                             // 走廊不变量：清出距 safe 最近的车道
          let best = 0;
          for (let k = 1; k < LANES; k++) if (Math.abs(k - safe) < Math.abs(best - safe)) best = k;
          row[best] = 0; safe = best;
        }
        run = (row[0] === 1 || row[0] === 3 || row[1] === 1 || row[1] === 3 || row[2] === 1 || row[2] === 3) ? run + 1 : 0;
      } else run = 0;
      lanes.push(row);
      safePlan.push(safe);                                 // 生成选定的安全车道（该车道本段保证空）
    }

    /* --- 玩家状态 --- */
    let lane = 1, px = area.w / 2, jumpY = 0, vy = 0;
    let dist = 0, coins = 0, hearts = t.hearts, invuln = 0, done = false, score = 0;
    let down = null;
    /* HUD 源头脏检查（§7.2.A.4）：值变才 setHud（里程显示量化 10px，消灭逐帧分配/GC churn） */
    let hudD = -1, hudC = -1, hudH = -1;
    let acc0 = 0;                                              // 固定步长余数跨帧携带（GAMES-30 修复：丢弃式累加器在 120Hz 帧到位≈STEP 时整帧丢步，引擎慢 ~17%）

    const laneX = (l) => laneW * (l + 0.5);
    function swipe(dx, dy) {
      if (done) return;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      if (Math.abs(dx) >= Math.abs(dy)) { const nl = clamp(lane + (dx > 0 ? 1 : -1), 0, LANES - 1); if (nl !== lane) { lane = nl; } }
      else if (dy < 0 && jumpY <= 0) { vy = 560; }         // 上滑跳（§9）
    }

    function step() {
      if (done) return;
      dist += speed * STEP;
      if (invuln > 0) invuln -= STEP;
      /* 换道平滑 */
      const tx = laneX(lane);
      px += clamp(tx - px, -900 * STEP, 900 * STEP);
      /* 跳跃物理 */
      if (jumpY > 0 || vy > 0) { vy -= 1500 * STEP; jumpY += vy * STEP; if (jumpY <= 0) { jumpY = 0; vy = 0; } }
      /* 判定：与玩家 z 邻近分段交互 */
      const seg = Math.floor(dist / SEG);
      for (let s = Math.max(0, seg - 1); s <= Math.min(segN - 1, seg + 1); s++) {
        const z = s * SEG + SEG / 2;
        if (Math.abs(z - dist) >= 28) continue;
        const v = lanes[s][lane];
        if (v === 2) { coins++; lanes[s][lane] = 0; }
        else if ((v === 1 || v === 3) && invuln <= 0) {
          if (!(v === 1 && jumpY > OB_LOW - 6)) {          // 矮障碍跳起越过
            hearts--; invuln = 1.2;
            game.toast(`撞障碍！剩 ${hearts} 命`);
            if (hearts <= 0) { done = true; score = coins * 20 + hearts * 50; game.lose(score); return; }
          }
        }
      }
      if (dist >= distance) {                              // 抵达终点（§9）
        done = true; score = coins * 20 + hearts * 50;
        game.win(score, { s2: coinTarget * 24, s3: coinTarget * 30 });
      }
    }

    return {
      startLevel() { game.setHud([{ t: '程', v: 0 }, { t: '币', v: 0 }, { t: '命', v: hearts }]); },
      update(dt) {
        acc0 += dt;
        while (acc0 >= STEP) { acc0 -= STEP; step(); if (done) break; }
        score = coins * 20 + hearts * 50;
        const d10 = Math.round(dist / 10) * 10;
        if (d10 !== hudD || coins !== hudC || hearts !== hudH) {
          hudD = d10; hudC = coins; hudH = hearts;
          game.setHud([
            { t: `/${(distance / 1000).toFixed(1)}k`, v: Math.min(distance, d10) },
            { t: `/${coinTarget}币`, v: coins },
            { t: '命', v: hearts },
          ]);
        }
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down) { swipe(x - down.x, y - down.y); down = null; } },
      render(g) {
        /* 车道与地面：§7.2.A.1 静态层 blit（vm 桩回退直绘） */
        const layer = staticLayer();
        if (layer.cvs) g.drawImage(layer.cvs, 0, area.y, area.w, area.h);
        else drawLanes(g, area.y);
        /* 顶栏下进度条 */
        const pr = clamp(dist / distance, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = '#7bd88f'; g.fillRect(20, area.y + 6, (area.w - 40) * pr, 4);
        /* 障碍/金币（z→screenY：物品在玩家前方 dist 之上方） */
        const seg = Math.floor(dist / SEG);
        for (let s = Math.max(0, seg - 6); s <= Math.min(segN - 1, seg + 6); s++) {
          const z = s * SEG + SEG / 2;
          const y = playerY - (z - dist);
          if (y < area.y + 12 || y > area.y + area.h + 40) continue;
          for (let l = 0; l < LANES; l++) {
            const v = lanes[s][l];
            const x = laneX(l);
            if (v === 1) { g.fillStyle = '#3b4a6b'; roundRect(g, x - 34, y - OB_LOW, 68, OB_LOW, 6); g.fill(); }
            else if (v === 3) {
              g.fillStyle = '#5b3b6b'; roundRect(g, x - 36, y - OB_TALL, 72, OB_TALL, 6); g.fill();
              g.fillStyle = '#ff8fa3'; g.fillRect(x - 36, y - OB_TALL, 72, 6);
            } else if (v === 2) {
              g.beginPath(); g.arc(x, y - 26, 9, 0, 7); g.fillStyle = '#ffd166'; g.fill();
              g.fillStyle = '#b8860b'; g.font = FONT(10, 700); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('¥', x, y - 26);
            }
          }
        }
        /* 终点线 */
        const fy = playerY - (distance - dist);
        if (fy > area.y - 10 && fy < area.y + area.h) {
          g.fillStyle = '#7bd88f';
          for (let i = 0; i < 14; i++) g.fillRect((i % 2) * laneW * 1.5, fy - 8 + i * 8, laneW * 1.5, 8);
        }
        /* 角色 */
        const blink = invuln > 0 && Math.floor(invuln * 10) % 2 === 0;
        if (!blink) {
          g.fillStyle = '#9fc0ff';
          roundRect(g, px - 17, playerY - 46 - jumpY, 34, 46, 9); g.fill();
          g.fillStyle = '#e8ecf3'; g.beginPath(); g.arc(px, playerY - 34 - jumpY, 6, 0, 7); g.fill();
        }
      },
      __state() {
        return {
          speed, obsRate: +obsRate.toFixed(3), distance, coinTarget, hearts: t.hearts,
          segN, lanes: lanes.map(r => r.join('')), safePlan: safePlan.join(''),
          lane, px: +px.toFixed(2), jumpY: +jumpY.toFixed(2),
          dist: +dist.toFixed(2), coins, heartsLeft: hearts, invuln: +invuln.toFixed(2), score, done,
        };
      },
    };
  };
})();
