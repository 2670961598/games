'use strict';
/* =====================================================================
 * 弹珠打砖引擎（spec §14）：底部拖板反弹弹珠清砖阵，清空即胜、弹珠落尽即败。
 * 曲线：rows(L)=min(rowsCap,4+⌊4(L−1)/(Ln−1)⌋)；speed(L)=ballSpeed×(1+0.40(L−1)/(Ln−1))；
 *       paddle(L)=max(60,round(paddleW×(1−0.20(L−1)/(Ln−1)))）。
 * 生成：砖阵按 seed 每格 0.75 占砖率掷点；砖分=10×HP×行深系数(1.0–1.5，深行高分)；
 *       板触球偏移决定反射角（±60° 经典手感）；发射角由 seed 掷点。
 * 计分：score=Σ砖分+剩余balls×50；s2=12×bricks(L)，s3=15×bricks(L)。
 * 物理：固定步长 1/120s 累加器，跨设备一致。拖板 1:1 跟指，点按一次发射。
 * ===================================================================== */
const BreakoutEngine = (function () {
  const COLS = 8, BW = 42, BH = 16, GAP = 2, R = 6;
  const rowsOf = (t, L, n) => Math.min(t.rowsCap, 4 + Math.floor(4 * (L - 1) / (n - 1)));
  const speedOf = (t, L, n) => t.ballSpeed * (1 + 0.40 * (L - 1) / (n - 1));
  const paddleOf = (t, L, n) => Math.max(60, Math.round(t.paddleW * (1 - 0.20 * (L - 1) / (n - 1))));
  /** 行深系数：靠上（深）行 1.5 → 靠板行 1.0 */
  const depthK = (r, rows) => 1 + 0.5 * (rows - 1 - r) / Math.max(1, rows - 1);

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ ballSpeed: 260, paddleW: 90, rowsCap: 8, brickHP: 1, balls: 3 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level;
    const rows = rowsOf(t, L, n), speed = speedOf(t, L, n), pw = paddleOf(t, L, n);
    const x0 = (area.w - (COLS * BW + (COLS - 1) * GAP)) / 2;
    const topY = area.y + 34;
    const paddleY = area.y + area.h - 34;

    /* ---- 砖阵（seed 掷点，0.75 占砖率） ---- */
    const bricks = [];                 // {r,c,hp,hp0,x,y,val}
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        if (rng() < 0.75) {
          const hp = t.brickHP;
          bricks.push({
            r, c, hp, hp0: hp,
            x: x0 + c * (BW + GAP), y: topY + r * (BH + GAP),
            val: Math.round(10 * hp * depthK(r, rows)),
          });
        }
      }
    }
    const bricksTotal = bricks.length;

    let px = area.w / 2;               // 板中心 x
    let ballsLeft = t.balls, score = 0, done = false, launched = false;
    let ball = null, acc = 0, shake = 0, pops = [];
    let launchAng = 0;                 // 发射角（seed 掷点，±25°~±55°）
    {
      const side = rng() < 0.5 ? -1 : 1;
      launchAng = side * (25 + rng() * 30) * Math.PI / 180;
    }
    resetBall();

    function resetBall() {
      launched = false;
      ball = { x: px, y: paddleY - R - 4, vx: 0, vy: 0 };
    }
    function launch() {
      if (launched || done) return;
      launched = true;
      ball.vx = Math.sin(launchAng) * speed;
      ball.vy = -Math.cos(launchAng) * speed;
    }
    function reflectPaddle() {
      const off = G.clamp((ball.x - px) / (pw / 2), -1, 1);   // 触板偏移 → 反射角（经典手感）
      const a = off * 60 * Math.PI / 180;
      ball.vx = Math.sin(a) * speed;
      ball.vy = -Math.cos(a) * speed;
      ball.y = paddleY - R - 0.5;
    }
    function hitBrick(b) {
      b.hp--;
      if (b.hp <= 0) {
        score += b.val;
        pops.push({ x: b.x + BW / 2, y: b.y + BH / 2, t: 0.5, v: b.val });
        bricks.splice(bricks.indexOf(b), 1);
        if (bricks.length === 0) {
          done = true;
          score += ballsLeft * 50;                             // 剩余弹珠奖励（§14 计分）
          game.win(score, { s2: 12 * bricksTotal, s3: 15 * bricksTotal });
        }
      } else {
        pops.push({ x: b.x + BW / 2, y: b.y + BH / 2, t: 0.3, v: 0 });
      }
      shake = 0.08;
    }
    /** 圆-矩形碰撞：命中返回法线轴 */
    function collideBricks() {
      for (const b of bricks) {
        const cx = G.clamp(ball.x, b.x, b.x + BW), cy = G.clamp(ball.y, b.y, b.y + BH);
        const dx = ball.x - cx, dy = ball.y - cy;
        if (dx * dx + dy * dy <= R * R) {
          const ox = (BW / 2 + R) - Math.abs(ball.x - (b.x + BW / 2));
          const oy = (BH / 2 + R) - Math.abs(ball.y - (b.y + BH / 2));
          if (ox < oy) ball.vx = -ball.vx; else ball.vy = -ball.vy;
          hitBrick(b);
          return true;                                          // 单步单砖，避免连环穿透
        }
      }
      return false;
    }
    function step() {
      if (!launched || done) return;
      ball.x += ball.vx * STEP; ball.y += ball.vy * STEP;
      if (ball.x < R) { ball.x = R; ball.vx = Math.abs(ball.vx); }
      if (ball.x > area.w - R) { ball.x = area.w - R; ball.vx = -Math.abs(ball.vx); }
      if (ball.y < area.y + R) { ball.y = area.y + R; ball.vy = Math.abs(ball.vy); }
      if (ball.vy > 0 && ball.y >= paddleY - R && ball.y < paddleY + 14 &&
        Math.abs(ball.x - px) <= pw / 2 + R) reflectPaddle();
      collideBricks();
      if (ball.y > area.y + area.h + 20) {                      // 落板：耗一珠
        ballsLeft--;
        if (ballsLeft <= 0) { done = true; game.lose(score); }
        else resetBall();
      }
    }
    const STEP = 1 / 120;

    return {
      startLevel() { game.setHud([{ t: '分', v: 0 }, { t: '砖', v: bricksTotal }, { t: '珠', v: ballsLeft }]); },
      update(dt) {
        if (!launched && !done) { ball.x = px; ball.y = paddleY - R - 4; }  // 粘板期跟板
        acc += dt;
        while (acc >= STEP) { step(); acc -= STEP; if (done) break; }
        if (shake > 0) shake -= dt;
        for (const p of pops) p.t -= dt;
        pops = pops.filter(p => p.t > 0);
        game.setHud([{ t: '分', v: score }, { t: '砖', v: bricks.length }, { t: '珠', v: ballsLeft }]);
      },
      onDown() { },
      onMove(x) { if (!done) px = G.clamp(x, pw / 2, area.w - pw / 2); },  // 板 1:1 跟指
      onUp() { launch(); },                                     // 发射 = 点按一次（§14 映射；拖板定位后抬起亦发射）
      render(g) {
        for (const b of bricks) {
          const k = depthK(b.r, rows);
          g.fillStyle = b.hp0 > 1 ? (b.hp > 1 ? '#ffd166' : '#e8a93e') : `hsl(${200 + k * 90}, 62%, ${44 + k * 14}%)`;
          G.roundRect(g, b.x, b.y, BW, BH, 3); g.fill();
          if (b.hp0 > 1 && b.hp > 1) {                            // 双耐久砖：内衬示余
            g.strokeStyle = '#1a2133'; g.lineWidth = 1.5; G.roundRect(g, b.x + 3, b.y + 3, BW - 6, BH - 6, 2); g.stroke();
          }
        }
        /* 板 */
        g.fillStyle = done ? '#3a4358' : '#6ea8ff';
        G.roundRect(g, px - pw / 2, paddleY - 5, pw, 10, 5); g.fill();
        g.fillStyle = '#9fc0ff'; G.roundRect(g, px - pw / 2 + 4, paddleY - 3, pw - 8, 3, 1.5); g.fill();
        /* 球 */
        if (ball) {
          g.beginPath(); g.arc(ball.x, ball.y, R, 0, 7); g.fillStyle = '#e8ecf3'; g.fill();
          if (!launched && !done) {                               // 待发射：示意轨迹
            g.strokeStyle = '#3a4358'; g.setLineDash([4, 5]); g.beginPath();
            g.moveTo(ball.x, ball.y);
            g.lineTo(ball.x + Math.sin(launchAng) * 54, ball.y - Math.cos(launchAng) * 54);
            g.stroke(); g.setLineDash([]);
          }
        }
        /* 得分飘字（装饰） */
        for (const p of pops) {
          g.globalAlpha = G.clamp(p.t * 2.4, 0, 1);
          g.fillStyle = '#ffd166'; g.font = G.FONT(12, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
          if (p.v) g.fillText('+' + p.v, p.x, p.y - (0.5 - p.t) * 26);
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          rows, speed: +speed.toFixed(2), pw, bricksTotal, ballsLeft, score, done, launched,
          bricks: bricks.map(b => [b.r, b.c, b.hp]),
          ball: launched ? [+ball.x.toFixed(2), +ball.y.toFixed(2)] : null,
          px: +px.toFixed(2), launchAng: +launchAng.toFixed(4),
        };
      },
    };
  };
})();
