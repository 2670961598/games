'use strict';
/* =====================================================================
 * 弹雨躲避引擎（spec §17）：无攻击纯躲避，操控小点在弹雨中存活到目标时间。
 * 曲线：goal(L)=ceil(goalSec×(1+0.10(L−1)/(Ln−1)))；rate(L)=spawnRate×(1+0.50(L−1)/(Ln−1))；
 *       speed(L)=projSpeed×(1+0.40(L−1)/(Ln−1))。
 * 生成：弹的边（上/左/右）、位、速（±10%）、型（直进/追踪弱导 8 帧）由 seed 逐发掷点；
 *       同屏弹 cap=40，超限改生成间隔（跳发）。
 * 映射：{primary:drag, secondary:hold}——拖点移动（指上偏移 24px 保可见），
 *       长按 ≥0.35s 触发慢动作（3s 时缓 0.5×，充能耗尽自动失效）；世界钟同步放缓（不骗时长）。
 * 计分：score=存活秒×10+险过(弹距<playerR×2)×5；s2=goal(L)×12，s3=goal(L)×15。中弹即败（一命制）。
 * 物理：固定步长 1/120s 累加器（慢动作期世界步长减半）。
 * ===================================================================== */
const BulletDodgeEngine = (function () {
  const PR = 5;                                          // 弹半径
  const goalOf = (t, L, n) => Math.ceil(t.goalSec * (1 + 0.10 * (L - 1) / (n - 1)));
  const rateOf = (t, L, n) => t.spawnRate * (1 + 0.50 * (L - 1) / (n - 1));
  const speedOf = (t, L, n) => t.projSpeed * (1 + 0.40 * (L - 1) / (n - 1));

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ goalSec: 30, spawnRate: 1.80, projSpeed: 180, playerR: 14, slowCharges: 2 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level;
    const goal = goalOf(t, L, n), rate = rateOf(t, L, n), speed = speedOf(t, L, n);

    const dot = { x: area.w / 2, y: area.y + area.h * 0.62 };
    let finger = null, holdT = 0;
    let slowLeft = 0, charges = t.slowCharges;
    let projs = [], spawnAcc = 0, elapsed = 0, near = 0, done = false;
    let acc = 0;

    function spawnProj() {
      if (projs.length >= 40) return;                    // 同屏 cap=40：超限跳发（改生成间隔）
      const edge = rng();                                 // 上 0.6 / 左 0.2 / 右 0.2
      let x, y, baseA;
      if (edge < 0.6) { x = 12 + rng() * (area.w - 24); y = area.y - 10; baseA = Math.PI / 2; }
      else if (edge < 0.8) { x = -10; y = area.y + 20 + rng() * (area.h - 140); baseA = 0; }
      else { x = area.w + 10; y = area.y + 20 + rng() * (area.h - 140); baseA = Math.PI; }
      const v = speed * (0.9 + rng() * 0.2);              // 速：±10% 掷点
      const a = baseA + (rng() - 0.5) * (edge < 0.6 ? 1.1 : 0.7);
      projs.push({
        x, y,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        home: rng() < 0.3, homeLeft: 8,                    // 追踪弱导：前 8 帧微导后直线
        counted: false,
      });
    }
    function step(w) {                                    // w = 世界步长（慢动作时减半）
      if (done) return;
      elapsed += w;
      spawnAcc += rate * w;
      while (spawnAcc >= 1) { spawnAcc -= 1; spawnProj(); }
      for (const p of projs) {
        if (p.home && p.homeLeft > 0) {                   // 弱导：向玩家轻转向
          p.homeLeft--;
          const dx = dot.x - p.x, dy = dot.y - p.y, d = Math.hypot(dx, dy) || 1;
          const v = Math.hypot(p.vx, p.vy);
          p.vx = G.lerp(p.vx, dx / d * v, 0.10);
          p.vy = G.lerp(p.vy, dy / d * v, 0.10);
        }
        p.x += p.vx * w; p.y += p.vy * w;
        const d = Math.hypot(p.x - dot.x, p.y - dot.y);
        if (d < t.playerR + PR) { done = true; game.lose(Math.round(elapsed * 10 + near * 5)); return; }
        if (!p.counted && d < t.playerR * 2 && d >= t.playerR + PR) {  // 险过：弹距<playerR×2
          p.counted = true; near++;
        }
      }
      projs = projs.filter(p => p.x > -30 && p.x < area.w + 30 && p.y > area.y - 30 && p.y < area.y + area.h + 30);
      if (!done && elapsed >= goal) {
        done = true;
        game.win(Math.round(elapsed * 10 + near * 5), { s2: goal * 12, s3: goal * 15 });
      }
    }
    const STEP = 1 / 120;

    return {
      startLevel() { game.setHud([{ t: '秒', v: 0 }, { t: '分', v: 0 }, { t: '缓', v: charges }]); },
      update(dt) {
        const scale = slowLeft > 0 ? 0.5 : 1;
        if (slowLeft > 0) slowLeft -= dt;                 // 慢动作实时长 3s
        acc += dt * scale;
        while (acc >= STEP) { step(STEP); acc -= STEP; if (done) break; }
        if (slowLeft <= 0 && holdT >= 0.35 && charges > 0 && !done) {
          /* 长按触发慢动作（充能耗尽自动失效） */
          charges--; slowLeft = 3; holdT = -1;            // holdT=-1：本次按住不再重复触发
          game.toast('时缓！');
        }
        if (finger) holdT += dt;
        game.setHud([{ t: `/${goal}秒`, v: Math.floor(Math.min(elapsed, goal)) }, { t: '分', v: Math.round(elapsed * 10 + near * 5) }, { t: '缓', v: charges + (slowLeft > 0 ? '●' : '') }]);
      },
      onDown(x, y) {
        finger = { x, y }; holdT = 0;
        dot.x = G.clamp(x, t.playerR, area.w - t.playerR);
        dot.y = G.clamp(y - 24, area.y + t.playerR, area.y + area.h - t.playerR);
      },
      onMove(x, y) {
        if (finger) {
          dot.x = G.clamp(x, t.playerR, area.w - t.playerR);
          dot.y = G.clamp(y - 24, area.y + t.playerR, area.y + area.h - t.playerR);
        }
      },
      onUp() { finger = null; holdT = 0; },
      render(g) {
        /* 慢动作氛围（装饰） */
        if (slowLeft > 0) { g.fillStyle = 'rgba(110,168,255,0.06)'; g.fillRect(0, area.y, area.w, area.h); }
        /* 弹 */
        for (const p of projs) {
          g.beginPath(); g.arc(p.x, p.y, PR, 0, 7);
          g.fillStyle = p.home ? '#ffd166' : '#ff8fa3'; g.fill();
          g.beginPath(); g.arc(p.x, p.y, 2, 0, 7); g.fillStyle = '#fff2f4'; g.fill();
        }
        /* 玩家小点：判定圈 + 险过圈（装饰） */
        g.beginPath(); g.arc(dot.x, dot.y, t.playerR * 2, 0, 7);
        g.strokeStyle = 'rgba(123,216,143,0.18)'; g.lineWidth = 1; g.stroke();
        g.beginPath(); g.arc(dot.x, dot.y, t.playerR, 0, 7);
        g.fillStyle = done ? '#3a4358' : '#7bd88f'; g.fill();
        g.beginPath(); g.arc(dot.x, dot.y, t.playerR * 0.45, 0, 7); g.fillStyle = '#eafff0'; g.fill();
        /* 目标进度线 */
        const pr = G.clamp(elapsed / goal, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = slowLeft > 0 ? '#6ea8ff' : '#7bd88f'; g.fillRect(20, area.y + 6, (area.w - 40) * pr, 4);
      },
      __state() {
        return {
          goal, rate: +rate.toFixed(3), speed: +speed.toFixed(2), charges, near, done,
          elapsed: +elapsed.toFixed(2),
          dot: [+dot.x.toFixed(2), +dot.y.toFixed(2)],
          projs: projs.map(p => [+p.x.toFixed(2), +p.y.toFixed(2), +p.vx.toFixed(2), +p.vy.toFixed(2), p.home ? 1 : 0]),
        };
      },
    };
  };
})();
