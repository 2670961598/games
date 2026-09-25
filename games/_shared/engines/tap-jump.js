'use strict';
/* =====================================================================
 * 飞翔跳跃引擎（spec §8）：点按上浮穿管道，过障数达标即胜；触管/触地即败（lives=1）。
 * 曲线：gap(L)=max(120,round(gapPx×(1−0.25p)))；speed(L)=pipeSpeed×(1+0.30p)；
 *       target(L)=ceil(5+20p)；p=(L−1)/(Ln−1)；gravity/tapImpulse 同乘子换算保弹道手感。
 * 生成（§8）：缺口垂直位置由 seed 链式生成（相邻缺口中心位移 ≤180px 保证理论可达）；
 *   gap 随关内进度（passed/target）再线性收窄 8%（关内微曲线）。
 * 裁量：触顶不死——上边界夹住（vy≥0），§8 败因仅"触管/触地"；
 *       管道懒生成（右缘离屏 <40px 时按 pipeInterval 补一根），rng 抽取序确定；
 *       管宽 PW=48（spec 未给）：穿越窗 (PW+2R)/speed 内须容纳抛物线弧——master 档
 *       gap 123 × 弧升 780²/5400=112.6px，PW=64 时窗 0.37s > 带内弧时长 0.41s 边缘
 *       且带内任何点跳必冲出上沿（112.6 > 99px 可用带），结构性近不可赢；PW=48 留出余量。
 * 计分：score=过障数×10；s2=target(L)×12，s3=target(L)×15（20%/50% 超额过障）。
 * 交互（§8）：全屏点按跳跃（pointerdown 即冲量，瞬时重开是核心体验）；死亡显重开热区。
 * ===================================================================== */
const TapJumpEngine = (function () {
  const R = 12;                // 鸟判定半径
  const PW = 48;               // 管宽（裁量：master 穿越几何，见头注）
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ gravity: 1800, tapImpulse: -520, pipeSpeed: 160, gapPx: 175, pipeInterval: 260 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const gap0 = Math.max(120, Math.round(t.gapPx * (1 - 0.25 * p)));
    const speed = +(t.pipeSpeed * (1 + 0.30 * p)).toFixed(2);
    const target = Math.ceil(5 + 20 * p);
    const birdX = Math.round(area.w * 0.30);
    const floorY = area.y + area.h - 26;

    /* --- 管道（懒生成，缺口中心链式 ≤180px，§8） --- */
    let pipes = [];
    function nextCenter(prev) {
      const minY = area.y + gap0 / 2 + 30, maxY = floorY - gap0 / 2 - 24;
      return G.clamp(prev + (rng() * 2 - 1) * 180, minY, maxY);
    }
    function spawnPipes() {
      if (!pipes.length) { pipes.push({ x: area.w + 140, cy: nextCenter(area.y + area.h / 2), counted: false }); return; }
      const last = pipes[pipes.length - 1];
      if (last.x < area.w + 40) pipes.push({ x: last.x + t.pipeInterval, cy: nextCenter(last.cy), counted: false });
    }

    /* --- 运行状态 --- */
    let y = area.y + area.h * 0.42, vy = 0;
    let passed = 0, score = 0, done = false, anim = 0, wingT = 0;
    let downAt = null;

    const gapNow = () => gap0 * (1 - 0.08 * G.clamp(passed / target, 0, 1));   // 关内微曲线（§8）

    /** 圆 vs 管对（x 重叠窗内判上下管；圆-矩形最近点） */
    function hitPipe(px, py) {
      const gNow = gapNow();
      for (const pi of pipes) {
        if (px + R < pi.x || px - R > pi.x + PW) continue;
        const topB = pi.cy - gNow / 2, botB = pi.cy + gNow / 2;
        const cx = G.clamp(px, pi.x, pi.x + PW);
        for (const [ry0, ry1] of [[area.y, topB], [botB, floorY]]) {
          const cy = G.clamp(py, ry0, ry1);
          if ((px - cx) * (px - cx) + (py - cy) * (py - cy) < R * R) return true;
        }
      }
      return false;
    }

    function step() {
      if (done) return;
      vy += t.gravity * STEP;
      y += vy * STEP;
      wingT += STEP;
      if (y < area.y + R + 2) { y = area.y + R + 2; if (vy < 0) vy = 0; }   // 触顶夹住（裁量）
      spawnPipes();
      for (const pi of pipes) {
        pi.x -= speed * STEP;
        if (!pi.counted && pi.x + PW < birdX - R) {
          pi.counted = true; passed++;
          score = passed * 10;
          if (passed >= target) { done = true; game.win(score, { s2: target * 12, s3: target * 15 }); return; }
        }
      }
      pipes = pipes.filter(pi => pi.x > -PW - 10);
      if (y + R >= floorY || hitPipe(birdX, y)) { done = true; game.lose(score); }   // 触地/触管（§8）
    }

    return {
      startLevel() { game.setHud([{ t: `/${target}障`, v: 0 }, { t: '命', v: 1 }, { t: '速', v: speed }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        game.setHud([
          { t: `/${target}障`, v: passed },
          { t: '过障', v: score },
          { t: '速', v: speed },
        ]);
      },
      onDown() { if (!done) { vy = t.tapImpulse; wingT = 0; } },
      onMove() { },
      onUp() { },
      render(g) {
        /* 远景装饰（不参与判定） */
        g.fillStyle = '#151d31';
        for (let i = 0; i < 5; i++) {
          const bx = ((i * 97 - anim * 12) % (area.w + 80) + area.w + 80) % (area.w + 80) - 40;
          const bh = 60 + (i * 53) % 90;
          g.fillRect(bx, floorY - bh, 52, bh);
        }
        /* 管道 */
        const gNow = gapNow();
        for (const pi of pipes) {
          const topB = pi.cy - gNow / 2, botB = pi.cy + gNow / 2;
          g.fillStyle = '#2e7d5b';
          g.fillRect(pi.x, area.y - 2, PW, topB - area.y + 2);
          g.fillRect(pi.x, botB, PW, floorY - botB);
          g.fillStyle = '#3aa374';
          g.fillRect(pi.x - 4, topB - 18, PW + 8, 18);
          g.fillRect(pi.x - 4, botB, PW + 8, 18);
          g.fillStyle = 'rgba(255,255,255,.08)';
          g.fillRect(pi.x + 6, area.y - 2, 10, topB - area.y + 2);
          g.fillRect(pi.x + 6, botB, 10, floorY - botB);
        }
        /* 地面 */
        g.fillStyle = '#232c42'; g.fillRect(0, floorY, area.w, area.y + area.h - floorY);
        g.fillStyle = '#2c3a5c'; g.fillRect(0, floorY, area.w, 4);
        /* 鸟 */
        g.save(); g.translate(birdX, y); g.rotate(G.clamp(vy / 900, -0.45, 1.1));
        g.fillStyle = '#ffd166'; g.beginPath(); g.arc(0, 0, R, 0, 7); g.fill();
        g.fillStyle = '#e8a93e';
        const flap = Math.sin(wingT * 26);
        g.beginPath(); g.ellipse(-3, 2 + flap * 2, 7, 4.5, flap * 0.5, 0, 7); g.fill();
        g.fillStyle = '#101522'; g.beginPath(); g.arc(4.5, -4, 2.1, 0, 7); g.fill();
        g.fillStyle = '#ff8fa3'; g.beginPath(); g.moveTo(9, 1); g.lineTo(15, 3); g.lineTo(9, 5.5); g.closePath(); g.fill();
        g.restore();
      },
      __state() {
        return {
          target, gap0, speed, gravity: t.gravity, tapImpulse: t.tapImpulse, pipeInterval: t.pipeInterval,
          birdX, R, PW, floorY,
          y: +y.toFixed(2), vy: +vy.toFixed(2), passed, score, done,
          pipes: pipes.map(pi => [+pi.x.toFixed(2), +pi.cy.toFixed(2), +gapNow().toFixed(2), pi.counted ? 1 : 0]),
        };
      },
    };
  };
})();
