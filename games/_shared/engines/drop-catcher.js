'use strict';
/* =====================================================================
 * 接落物引擎（spec §18）：顶部持续掉落好物与坏物，拖篮子接好物、躲坏物。
 * 曲线：catchTarget(L)=ceil(catchTarget×(1+0.10(L−1)/(Ln−1)))；fall(L)=fallSpeed×(1+0.35(L−1)/(Ln−1))。
 * 生成：物类（好/坏，badRate 占比）、水平位、下落微斜率由 seed 掷点；
 *       好物分值档（普通 10/稀有 30，占比 0.15）亦由 seed 决定。
 * 判定：篮身热区放宽 8px 容错（§18 映射）；接坏物或漏好物均 −1 命（schema 落值），
 *       漏好物同时断连击（连击是分数轴，不计即时失败）。
 * 计分：score=好物面值+连击×5−接坏物×20（下限 0）；s2=catchTarget(L)×12，s3=×15。
 * 物理：固定步长 1/120s 累加器。篮子水平跟指（限屏宽内）。
 * ===================================================================== */
const DropCatcherEngine = (function () {
  const TOL = 8;                                         // 篮身热区放宽 8px
  const targetOf = (t, L, n) => Math.ceil(t.catchTarget * (1 + 0.10 * (L - 1) / (n - 1)));
  const fallOf = (t, L, n) => t.fallSpeed * (1 + 0.35 * (L - 1) / (n - 1));

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ catchTarget: 20, fallSpeed: 240, spawnRate: 1.50, badRate: 0.20, basketW: 110, lives: 3 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level;
    const target = targetOf(t, L, n), fall = fallOf(t, L, n);
    const basketY = area.y + area.h - 44, basketH = 26;

    let bx = area.w / 2;
    let items = [], spawnAcc = 0, caught = 0, combo = 0, maxCombo = 0, badCaught = 0, lives = t.lives;
    let score = 0, done = false, acc = 0, pops = [];

    function spawnItem() {
      const bad = rng() < t.badRate;                      // 物类掷点
      const rare = !bad && rng() < 0.15;                  // 稀有 30 / 普通 10
      items.push({
        bad, val: bad ? 0 : rare ? 30 : 10,
        x: 16 + rng() * (area.w - 32), y: area.y - 12,    // 水平位掷点
        slope: (rng() - 0.5) * 46,                        // 微斜率掷点（px/s 水平漂移）
        rare, counted: false,
      });
    }
    function fail(hard) {
      lives--;
      combo = 0;
      if (lives <= 0) { done = true; game.lose(score); }
      else game.toast(hard ? `坏物！生命 ${lives}/${t.lives}` : `漏接！生命 ${lives}/${t.lives}`);
    }
    function step() {
      if (done) return;
      spawnAcc += t.spawnRate * STEP;
      while (spawnAcc >= 1) { spawnAcc -= 1; spawnItem(); }
      for (const it of [...items]) {
        it.y += fall * STEP;
        it.x += it.slope * STEP;
        if (it.x < 10 || it.x > area.w - 10) it.slope = -it.slope;   // 边界折返
        const inBasket = Math.abs(it.x - bx) <= t.basketW / 2 + TOL
          && it.y >= basketY - TOL && it.y <= basketY + basketH + 6;
        if (inBasket) {
          items.splice(items.indexOf(it), 1);
          if (it.bad) {
            badCaught++;
            score = Math.max(0, score - 20);              // 接坏物 −20（下限 0）
            pops.push({ x: it.x, y: basketY - 14, t: 0.5, text: '−20', col: '#ff8fa3' });
            fail(true);
            if (done) return;
          } else {
            caught++; combo++; maxCombo = Math.max(maxCombo, combo);
            score += it.val + combo * 5;                  // 面值 + 连击×5
            pops.push({ x: it.x, y: basketY - 14, t: 0.5, text: `+${it.val + combo * 5}`, col: it.rare ? '#ffd166' : '#7bd88f' });
            if (caught >= target) {
              done = true; game.win(score, { s2: target * 12, s3: target * 15 });
              return;
            }
          }
        } else if (it.y > area.y + area.h + 16) {
          items.splice(items.indexOf(it), 1);
          if (!it.bad) fail(false);                       // 漏好物：断连击 + 耗命（不即败）
          if (done) return;
        }
      }
    }
    const STEP = 1 / 120;

    return {
      startLevel() { game.setHud([{ t: `/${target}`, v: 0 }, { t: '连击', v: 0 }, { t: '命', v: lives }]); },
      update(dt) {
        acc += dt;
        while (acc >= STEP) { step(); acc -= STEP; if (done) break; }
        for (const p of pops) p.t -= dt;
        pops = pops.filter(p => p.t > 0);
        game.setHud([{ t: `/${target}`, v: caught }, { t: '连击', v: combo }, { t: '命', v: lives }]);
      },
      onDown(x) { if (!done) bx = G.clamp(x, t.basketW / 2, area.w - t.basketW / 2); },
      onMove(x) { if (!done) bx = G.clamp(x, t.basketW / 2, area.w - t.basketW / 2); },
      onUp() { },
      render(g) {
        for (const it of items) {
          g.save(); g.translate(it.x, it.y);
          if (it.bad) {                                    // 坏物：尖刺球
            g.fillStyle = '#ff6b81'; g.beginPath();
            for (let i = 0; i < 8; i++) {
              const a = i / 8 * Math.PI * 2;
              const r = i % 2 ? 6 : 11;
              g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
            }
            g.closePath(); g.fill();
          } else if (it.rare) {                            // 稀有：星形
            g.fillStyle = '#ffd166'; g.beginPath();
            for (let i = 0; i < 10; i++) {
              const a = -Math.PI / 2 + i / 10 * Math.PI * 2;
              const r = i % 2 ? 5.5 : 12;
              g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
            }
            g.closePath(); g.fill();
          } else {                                         // 普通：圆果
            g.fillStyle = '#7bd88f'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
            g.fillStyle = '#4a9e63'; g.beginPath(); g.ellipse(0, -10, 3, 4.5, 0.4, 0, 7); g.fill();
          }
          g.restore();
        }
        /* 篮子 */
        g.fillStyle = done ? '#3a4358' : '#b5814a';
        g.beginPath();
        g.moveTo(bx - t.basketW / 2 - TOL, basketY);
        g.lineTo(bx + t.basketW / 2 + TOL, basketY);
        g.lineTo(bx + t.basketW / 2 - 8, basketY + basketH);
        g.lineTo(bx - t.basketW / 2 + 8, basketY + basketH);
        g.closePath(); g.fill();
        g.strokeStyle = '#8a5c30'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(bx - t.basketW / 2 - TOL, basketY); g.lineTo(bx + t.basketW / 2 + TOL, basketY); g.stroke();
        /* 接取进度线 */
        const pr = G.clamp(caught / target, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = '#7bd88f'; g.fillRect(20, area.y + 6, (area.w - 40) * pr, 4);
        for (const p of pops) {
          g.globalAlpha = G.clamp(p.t * 2.4, 0, 1);
          g.fillStyle = p.col; g.font = G.FONT(13, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(p.text, p.x, p.y - (0.5 - p.t) * 26);
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          target, fall: +fall.toFixed(2), caught, combo, maxCombo, badCaught, lives, score, done,
          bx: +bx.toFixed(2), items: items.map(i => [i.bad ? 1 : 0, i.rare ? 1 : 0, +i.x.toFixed(2), +i.y.toFixed(2), +i.slope.toFixed(2)]),
        };
      },
    };
  };
})();
