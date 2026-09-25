'use strict';
/* =====================================================================
 * 挡板生存引擎（spec §15）：底部挡板连续接住反弹下落球，坚持 goal(L) 秒即胜；
 * 漏球耗失误，missMax 耗尽即败。
 * 曲线：goal(L)=ceil(goalSec×(1+0.10(L−1)/(Ln−1)))；speed(L)=ballSpeed×(1+0.35(L−1)/(Ln−1))。
 * 球生成：从 1 球起，每 12s 或每 5 次接球 +1 球，cap=maxBalls；
 *         发射角由 seed 掷点（避开垂直正下 ±15°）；触板偏移决定反射角。
 * 计分：score=接球×10+存活秒×2；s2=goal(L)×12，s3=goal(L)×15。
 * 物理：固定步长 1/120s 累加器。板水平跟指。
 * ===================================================================== */
const PaddlePongEngine = (function () {
  const R = 8;
  const goalOf = (t, L, n) => Math.ceil(t.goalSec * (1 + 0.10 * (L - 1) / (n - 1)));
  const speedOf = (t, L, n) => t.ballSpeed * (1 + 0.35 * (L - 1) / (n - 1));

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ goalSec: 45, ballSpeed: 220, maxBalls: 4, paddleW: 110, missMax: 3 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level;
    const goal = goalOf(t, L, n), speed = speedOf(t, L, n);
    const paddleY = area.y + area.h - 34;

    let px = area.w / 2;
    let balls = [], elapsed = 0, catches = 0, misses = 0, nextAddAt = 12, score = 0, done = false;
    let acc = 0, pops = [];
    spawnBall();

    /** 发射角：避开垂直正下 ±15°（§15 生成规则）——从上方两侧斜下入場 */
    function seededAngle() {
      const side = rng() < 0.5 ? -1 : 1;
      const a = (15 + rng() * 50) * Math.PI / 180;              // 与竖直向下的夹角 ∈ [15°,65°]
      return { vx: Math.sin(a) * speed * side, vy: Math.cos(a) * speed };
    }
    function spawnBall() {
      const v = seededAngle();
      balls.push({ x: area.w * (0.2 + rng() * 0.6), y: area.y + 14, vx: v.vx, vy: v.vy, born: 0.6 });
    }
    function catchBall(b) {
      catches++;
      pops.push({ x: b.x, y: paddleY - 16, t: 0.5 });
      const off = G.clamp((b.x - px) / (t.paddleW / 2), -1, 1); // 触板偏移 → 反射角
      const a = off * 55 * Math.PI / 180;
      b.vx = Math.sin(a) * speed;
      b.vy = -Math.abs(Math.cos(a) * speed);
      b.y = paddleY - R - 0.5;
      b.antiStuck = 0;
      if (catches % 5 === 0) addBall('连接 5 球');               // 每 5 次接球 +1 球
    }
    function addBall(why) {
      if (balls.length >= t.maxBalls || done) return;
      spawnBall();
      game.toast(`+1 球（${why}）`);
    }
    function step() {
      if (done) return;
      for (const b of balls) {
        b.x += b.vx * STEP; b.y += b.vy * STEP;
        if (b.born > 0) b.born -= STEP;
        if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx); }
        if (b.x > area.w - R) { b.x = area.w - R; b.vx = -Math.abs(b.vx); }
        if (b.y < area.y + R) { b.y = area.y + R; b.vy = Math.abs(b.vy); }
        /* 防水平死循环：轻微上抬 */
        if (Math.abs(b.vy) < speed * 0.18) b.vy = (b.vy < 0 ? -1 : 1) * speed * 0.18;
        if (b.vy > 0 && b.y >= paddleY - R && b.y < paddleY + 14 &&
          Math.abs(b.x - px) <= t.paddleW / 2 + R && b.born <= 0) catchBall(b);
      }
      const out = balls.filter(b => b.y > area.y + area.h + 20);
      for (const b of out) {
        balls.splice(balls.indexOf(b), 1);
        misses++;
        game.toast(`漏球！失误 ${misses}/${t.missMax}`);
        if (misses >= t.missMax) { done = true; game.lose(score); return; }
        if (balls.length === 0) spawnBall();                    // 场上无球则补发（不空场）
      }
    }
    const STEP = 1 / 120;

    return {
      startLevel() { game.setHud([{ t: '秒', v: 0 }, { t: '接', v: 0 }, { t: '失误', v: 0 }]); },
      update(dt) {
        acc += dt;
        while (acc >= STEP) {
          elapsed += STEP;
          acc -= STEP;
          step();
          if (elapsed >= nextAddAt) { nextAddAt += 12; addBall('每 12 秒'); }  // 每 12s +1 球
          if (done) break;
        }
        score = Math.round(catches * 10 + elapsed * 2);
        if (!done && elapsed >= goal) {
          done = true; game.win(score, { s2: goal * 12, s3: goal * 15 });
        }
        for (const p of pops) p.t -= dt;
        pops = pops.filter(p => p.t > 0);
        game.setHud([{ t: `/${goal}秒`, v: Math.floor(Math.min(elapsed, goal)) }, { t: '接', v: catches }, { t: '失误', v: `${misses}/${t.missMax}` }]);
      },
      onDown() { },
      onMove(x) { if (!done) px = G.clamp(x, t.paddleW / 2, area.w - t.paddleW / 2); },
      onUp() { },
      render(g) {
        /* 目标进度线（顶部状态区下方细条） */
        const pr = G.clamp(elapsed / goal, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = '#7bd88f'; g.fillRect(20, area.y + 6, (area.w - 40) * pr, 4);
        for (const b of balls) {
          g.beginPath(); g.arc(b.x, b.y, R, 0, 7);
          g.fillStyle = b.born > 0 ? '#ffd166' : '#ff8fa3'; g.fill();
        }
        g.fillStyle = done ? '#3a4358' : '#6ea8ff';
        G.roundRect(g, px - t.paddleW / 2, paddleY - 5, t.paddleW, 10, 5); g.fill();
        g.fillStyle = '#9fc0ff'; G.roundRect(g, px - t.paddleW / 2 + 4, paddleY - 3, t.paddleW - 8, 3, 1.5); g.fill();
        for (const p of pops) {
          g.globalAlpha = G.clamp(p.t * 2.4, 0, 1);
          g.fillStyle = '#ffd166'; g.font = G.FONT(13, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('+' + 10, p.x, p.y - (0.5 - p.t) * 24);
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          goal, speed: +speed.toFixed(2), catches, misses, score, done, elapsed: +elapsed.toFixed(2),
          nextAddAt, px: +px.toFixed(2),
          balls: balls.map(b => [+b.x.toFixed(2), +b.y.toFixed(2), +b.vx.toFixed(2), +b.vy.toFixed(2), +b.born.toFixed(2)]),
        };
      },
    };
  };
})();
