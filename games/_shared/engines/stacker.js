'use strict';
/* =====================================================================
 * 叠塔引擎（spec §10）：方块左右摆动，点按落块逐层上叠；未对齐部分裁掉，
 * 块越叠越窄，脱靶耗失误；塔高达标即胜，块宽 < trimMin 或 missMax 耗尽即败。
 * 曲线：swing(L)=swingBase×(1+swingK×p)；target(L)=ceil(targetBase×(1+0.10p))；
 *       关内微曲线：每 5 层摆速 +6%（层数子进度）。p=(L−1)/(Ln−1)。
 * 生成（§10）：摆动起始方向由 seed 决定；完美重叠（≥90% 宽）不裁切并回涨 4px（cap=blockW0）。
 * 计分：score=层数×10+完美层×15；s2=target(L)×12，s3=target(L)×15。
 * 镜头随塔顶上移，落点判定区保持屏幕中带（§10 单手映射：全屏点按即落块）。
 * ===================================================================== */
const StackerEngine = (function () {
  const BH = 22;             // 层高 px
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ blockW0: 220, swingBase: 160, swingK: 0.80, trimMin: 12, missMax: 5, targetBase: 18 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const swing0 = +(t.swingBase * (1 + t.swingK * p)).toFixed(2);
    const target = Math.ceil(t.targetBase * (1 + 0.10 * p));

    /* --- 关卡状态 --- */
    const ground = area.y + area.h - 14;
    let layers = [{ x: area.w / 2, w: t.blockW0 }];        // [0]=底座（不计层数）
    let dir = rng() < 0.5 ? 1 : -1;                        // 起始方向由 seed 决定（§10）
    let cur = { x: area.w / 2, w: t.blockW0 };
    let misses = 0, perfects = 0, score = 0, done = false, flash = 0;
    let down = null;

    const placed = () => layers.length - 1;
    const swingSpeed = () => swing0 * (1 + 0.06 * Math.floor(placed() / 5));   // 每 5 层 +6%
    const camY = () => Math.max(0, (layers.length + 1) * BH - area.h * 0.55);  // 镜头随塔顶上移
    const layerY = (i) => ground - (i + 1) * BH + camY();

    function drop() {
      if (done) return;
      const top = layers[layers.length - 1];
      const l1 = cur.x - cur.w / 2, r1 = cur.x + cur.w / 2;
      const l2 = top.x - top.w / 2, r2 = top.x + top.w / 2;
      const ov = Math.min(r1, r2) - Math.max(l1, l2);
      if (ov <= 0) {                                       // 脱靶：耗失误，块损失（宽度不变重来）
        misses++;
        game.toast(`脱靶！失误 ${misses}/${t.missMax}`);
        if (misses >= t.missMax) { done = true; game.lose(score); }
        return;
      }
      const perfect = ov >= 0.9 * Math.min(cur.w, top.w);
      if (perfect) {                                       // 完美：不裁切 + 回涨 4px（cap blockW0）
        layers.push({ x: cur.x, w: Math.min(t.blockW0, cur.w + 4) });
        perfects++; flash = 0.5;
      } else {
        if (ov < t.trimMin) { done = true; game.lose(score); return; }   // 裁后过窄（§10 失败）
        const cx = (Math.max(l1, l2) + Math.min(r1, r2)) / 2;
        layers.push({ x: cx, w: ov });
      }
      cur = { x: dir > 0 ? cur.w / 2 + 10 : area.w - cur.w / 2 - 10, w: layers[layers.length - 1].w };
      dir = -dir;
      score = placed() * 10 + perfects * 15;
      if (placed() >= target) {                            // 塔高达标（§10）
        done = true; game.win(score, { s2: target * 12, s3: target * 15 });
      }
    }

    function step() {
      if (done) return;
      const v = swingSpeed();
      cur.x += dir * v * STEP;
      const lo = cur.w / 2 + 10, hi = area.w - cur.w / 2 - 10;
      if (cur.x < lo) { cur.x = lo; dir = 1; }
      if (cur.x > hi) { cur.x = hi; dir = -1; }
      if (flash > 0) flash -= STEP;
    }

    return {
      startLevel() { game.setHud([{ t: `/${target}层`, v: 0 }, { t: '完美', v: 0 }, { t: '失误', v: 0 }]); },
      update(dt) {
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        game.setHud([
          { t: `/${target}层`, v: placed() },
          { t: '完美', v: perfects },
          { t: `/${t.missMax}误`, v: misses },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) drop(); down = null; },
      render(g) {
        /* 地面 */
        g.fillStyle = '#232c42'; g.fillRect(0, ground + camY(), area.w, area.h);
        /* 已叠层 */
        for (let i = 0; i < layers.length; i++) {
          const ly = layers[i], y = layerY(i);
          if (y < area.y - BH || y > area.y + area.h + BH) continue;
          const hue = 210 + (i * 12) % 80;
          g.fillStyle = i === 0 ? '#3b4a6b' : `hsl(${hue},45%,${44 - (i % 3) * 5}%)`;
          G.roundRect(g, ly.x - ly.w / 2, y, ly.w, BH - 1, 3); g.fill();
          if (i === layers.length - 1 && flash > 0) {
            g.strokeStyle = '#ffd166'; g.lineWidth = 2;
            G.roundRect(g, ly.x - ly.w / 2, y, ly.w, BH - 1, 3); g.stroke();
          }
        }
        /* 摆动块（屏幕中带落点判定区） */
        const cy = layerY(layers.length);
        g.fillStyle = '#9fc0ff';
        G.roundRect(g, cur.x - cur.w / 2, cy, cur.w, BH - 1, 3); g.fill();
        /* 对齐参考线 */
        const top = layers[layers.length - 1];
        g.strokeStyle = '#ffd166aa'; g.lineWidth = 1; g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(top.x - top.w / 2, cy); g.lineTo(top.x - top.w / 2, cy + BH); g.stroke();
        g.beginPath(); g.moveTo(top.x + top.w / 2, cy); g.lineTo(top.x + top.w / 2, cy + BH); g.stroke();
        g.setLineDash([]);
      },
      __state() {
        return {
          swing0, target, missMax: t.missMax, trimMin: t.trimMin, blockW0: t.blockW0,
          dir, placed: placed(), perfects, misses, score, done,
          cur: { x: +cur.x.toFixed(2), w: cur.w },
          layers: layers.map(l => [+l.x.toFixed(2), l.w]),
          swingNow: +swingSpeed().toFixed(2),
        };
      },
    };
  };
})();
