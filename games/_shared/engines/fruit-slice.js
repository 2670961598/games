'use strict';
/* =====================================================================
 * 划切水果引擎（spec §23）：水果抛物线飞出，单指划线切割；60s 时限内切果 ≥ target(L)
 * 即胜；漏果耗 missMax、切炸弹耗 lives，任一耗尽即败；超时未达标亦败。
 * 曲线：target(L)=ceil(targetBase×(1+0.10p))；fly(L)=flySpeed×(1+0.25p)；
 *       rate(L)=spawnRate×(1+0.25p)。p=(L−1)/(Ln−1)；bombRate/时限 60s 按档位常量。
 * 生成（§23）：物类（果/炸弹）、水平位置、抛射角 60°–105° 由 seed 掷点成整场时间表；
 *   同屏物 cap=6（到场时超帽则本场跳过该枚，时间表仍确定）。
 * 裁量：spec 未给重力——取 g=fly²/800，使 90° 抛射顶点 ≈400px（≈0.62 场高），
 *       档位越快滞空越短、横漂越急，威胁轴与 flySpeed 一致。
 * 计分：score=果×10+一刀多果n×n×5−切炸弹×30（下限 0）；s2=target(L)×12，s3=target(L)×15。
 * 交互：划线轨迹与果圆求交判定切中，切中沿轨迹显刀光（§23 单手映射）。
 * ===================================================================== */
const FruitSliceEngine = (function () {
  const DUR = 60;             // 时限常量（§23）
  const CAP = 6;              // 同屏物上限
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ targetBase: 25, spawnRate: 1.40, flySpeed: 520, bombRate: 0.12, missMax: 5, lives: 3 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const target = Math.ceil(t.targetBase * (1 + 0.10 * p));
    const fly = +(t.flySpeed * (1 + 0.25 * p)).toFixed(2);
    const rate = +(t.spawnRate * (1 + 0.25 * p)).toFixed(3);
    const grav = fly * fly / 800;
    const bottom = area.y + area.h;

    /* --- 整场生成时间表（seed） --- */
    const spawns = [];
    for (let tt = 0.55; tt < DUR; tt += 1 / rate) {
      spawns.push({
        t: +tt.toFixed(3),
        bomb: rng() < t.bombRate,
        x: 34 + rng() * (area.w - 68),
        ang: (60 + rng() * 45) * Math.PI / 180,            // 60°–105°（§23）
        hue: Math.floor(rng() * 360),
      });
    }
    let sp = 0;

    /* --- 运行状态 --- */
    let items = [], timeLeft = DUR, fruits = 0, bombs = 0, misses = 0, lives = t.lives;
    let multiAcc = 0, strokeCuts = 0, score = 0, done = false, anim = 0;
    let trail = [], downAt = null;

    function curScore() { return Math.max(0, fruits * 10 + multiAcc - bombs * 30); }

    /** 线段 (a,b) 与圆 (c,r) 相交 */
    function segHit(ax, ay, bx, by, cx, cy, r) {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const tt = len2 ? G.clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
      const px = ax + dx * tt, py = ay + dy * tt;
      return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r;
    }
    function sliceByTrail() {
      if (trail.length < 2) return;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        if (b.age > 0.12) continue;
        for (const it of items) {
          if (it.dead) continue;
          if (segHit(a.x, a.y, b.x, b.y, it.x, it.y, it.r)) {
            it.dead = true;
            it.pop = 0.35;
            if (it.bomb) {
              bombs++; lives--;
              game.toast(`切中炸弹！剩 ${lives} 命`);
              if (lives <= 0) { done = true; score = curScore(); game.lose(score); return; }
            } else {
              fruits++; strokeCuts++;
              if (fruits >= target) { done = true; score = curScore(); game.win(score, { s2: target * 12, s3: target * 15 }); return; }
            }
          }
        }
      }
    }

    function step() {
      if (done) return;
      timeLeft -= STEP;
      while (sp < spawns.length && spawns[sp].t <= DUR - timeLeft) {
        if (items.filter(i => !i.dead && i.y < bottom + 30).length < CAP) {
          const s = spawns[sp];
          items.push({
            x: s.x, y: bottom + 14, vx: Math.cos(s.ang) * fly, vy: -Math.sin(s.ang) * fly,
            bomb: s.bomb, r: s.bomb ? 18 : 21, hue: s.hue, spin: (s.hue / 360) * Math.PI * 2, dead: false, pop: 0,
          });
        }
        sp++;
      }
      for (const it of items) {
        if (it.dead) { it.pop -= STEP; continue; }
        it.vy += grav * STEP;
        it.x += it.vx * STEP; it.y += it.vy * STEP; it.spin += STEP * 2;
        if (it.x < it.r) { it.x = it.r; it.vx = Math.abs(it.vx); }
        if (it.x > area.w - it.r) { it.x = area.w - it.r; it.vx = -Math.abs(it.vx); }
        if (it.y > bottom + 34) {
          it.dead = true; it.pop = 0;
          if (!it.bomb) {                                   // 漏果耗失误（炸弹落地不计，§23）
            misses++;
            game.toast(`漏果 ${misses}/${t.missMax}`);
            if (misses >= t.missMax) { done = true; score = curScore(); game.lose(score); return; }
          }
        }
      }
      items = items.filter(i2 => !i2.dead || i2.pop > 0);
      sliceByTrail();
      if (!done && timeLeft <= 0) { done = true; score = curScore(); game.lose(score); }   // 超时未达标
    }

    return {
      startLevel() { game.setHud([{ t: `/${target}果`, v: 0 }, { t: '命', v: lives }, { t: '秒', v: DUR }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        for (const pt of trail) pt.age += dt;
        trail = trail.filter(pt => pt.age < 0.14);
        score = curScore();
        game.setHud([
          { t: `/${target}果`, v: fruits },
          { t: `/${t.missMax}漏`, v: misses },
          { t: `x${lives}`, v: Math.ceil(Math.max(0, timeLeft)) },
        ]);
      },
      onDown(x, y) { downAt = { x, y }; trail.push({ x, y, age: 0 }); },
      onMove(x, y) { if (!downAt) return; trail.push({ x, y, age: 0 }); if (trail.length > 9) trail.shift(); },
      onUp(x, y) {
        trail.push({ x, y, age: 0 });
        if (strokeCuts >= 2) {                              // 一刀多果 n×n×5（§23）
          multiAcc += strokeCuts * strokeCuts * 5;
          game.toast(`一刀 ${strokeCuts} 果 +${strokeCuts * strokeCuts * 5}`);
        }
        strokeCuts = 0;
        downAt = null;
      },
      render(g) {
        /* 顶栏下时限条 */
        const tr = G.clamp(timeLeft / DUR, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = tr > 0.25 ? '#7bd88f' : '#ff8fa3'; g.fillRect(20, area.y + 6, (area.w - 40) * tr, 4);
        /* 目标果数环 */
        g.strokeStyle = '#2c3a5c'; g.lineWidth = 4;
        g.beginPath(); g.arc(area.w / 2, area.y + 44, 22, 0, 7); g.stroke();
        g.strokeStyle = '#ffd166';
        g.beginPath(); g.arc(area.w / 2, area.y + 44, 22, -Math.PI / 2, -Math.PI / 2 + 7 * G.clamp(fruits / target, 0, 1)); g.stroke();
        /* 物件 */
        for (const it of items) {
          if (it.dead) {                                    // 切开的半瓣飞散（装饰）
            if (it.pop > 0 && !it.bomb) {
              g.globalAlpha = G.clamp(it.pop * 3, 0, 1);
              g.fillStyle = `hsl(${it.hue},70%,60%)`;
              g.beginPath(); g.arc(it.x - 12, it.y - 14 * it.pop, 8, 0, 7); g.fill();
              g.beginPath(); g.arc(it.x + 12, it.y - 10 * it.pop, 8, 0, 7); g.fill();
              g.globalAlpha = 1;
            }
            continue;
          }
          if (it.bomb) {
            g.fillStyle = '#1a2133'; g.beginPath(); g.arc(it.x, it.y, it.r, 0, 7); g.fill();
            g.strokeStyle = '#ff8fa3'; g.lineWidth = 2; g.stroke();
            g.strokeStyle = '#ffd166'; g.beginPath(); g.moveTo(it.x + 6, it.y - it.r); g.lineTo(it.x + 14, it.y - it.r - 8); g.stroke();
          } else {
            g.fillStyle = `hsl(${it.hue},72%,58%)`;
            g.beginPath(); g.arc(it.x, it.y, it.r, 0, 7); g.fill();
            g.fillStyle = `hsl(${it.hue},72%,42%)`;
            g.beginPath(); g.arc(it.x + it.r * 0.35, it.y + it.r * 0.3, it.r * 0.3, 0, 7); g.fill();
            g.save(); g.translate(it.x, it.y - it.r); g.rotate(Math.sin(it.spin) * 0.4);
            g.fillStyle = '#7bd88f'; G.roundRect(g, -7, -5, 14, 6, 3); g.fill(); g.restore();
          }
        }
        /* 刀光轨迹（切中反馈沿轨迹，§23） */
        if (trail.length >= 2) {
          g.strokeStyle = '#e8ecf3'; g.lineWidth = 3; g.lineCap = 'round';
          g.beginPath(); g.moveTo(trail[0].x, trail[0].y);
          for (let i = 1; i < trail.length; i++) {
            g.globalAlpha = G.clamp(1 - trail[i].age / 0.14, 0, 1) * 0.9;
            g.lineTo(trail[i].x, trail[i].y);
          }
          g.stroke(); g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          target, fly, rate, bombRate: t.bombRate, missMax: t.missMax, lives: t.lives, grav: +grav.toFixed(2),
          spawnsN: spawns.length, sp,
          timeLeft: +timeLeft.toFixed(2), fruits, bombs, misses, livesLeft: lives, multiAcc, score, done,
          items: items.filter(i => !i.dead).map(i => [+i.x.toFixed(2), +i.y.toFixed(2), +i.vx.toFixed(2), +i.vy.toFixed(2), i.bomb ? 1 : 0]),
        };
      },
    };
  };
})();
