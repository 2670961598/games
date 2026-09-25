'use strict';
/* =====================================================================
 * 打地鼠引擎（spec §19）：3×3 地鼠窝，冒头窗内点中得分，炸弹点了扣分耗命。
 * 曲线：hitTarget(L)=ceil(hitTarget×(1+0.10p))；popup(L)=max(450,round(popupMs×(1−0.30p)))；
 *       concurrent(L)=min(4,round(concurrent×(1+0.30p)))；p=(L−1)/(Ln−1)；timeSec=30 档位常量。
 * 生成（§19）：冒头节拍表由 seed 生成——每 popup(L)ms 一轮、每轮 concurrent(L) 窝同时冒头；
 *   硬约束：同一窝不连续两轮冒头、炸弹不出现在前 5 秒（教学保护）。
 * 裁量：连击=连续命中地鼠（点空/点炸弹均断）；"连击×5"取最大连击（与 §7 口径一致）；
 *   每轮地鼠停留 = popup(L)（与下一轮交接同步收头），hit 窗即冒头窗。
 * 计分：score=命中×10+最大连击×5−点炸弹×20（下限 0）；s2=hitTarget(L)×12，s3=×15。
 * 交互（§19）：九窝网格占屏中部 80% 宽，单指点按；顶部进度与倒计时。
 * ===================================================================== */
const MoleWhackEngine = (function () {
  const GRACE = 5;             // 炸弹教学保护秒数（§19）
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ hitTarget: 20, timeSec: 30, popupMs: 900, concurrent: 2, bombRate: 0.15, lives: 3 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const target = Math.ceil(t.hitTarget * (1 + 0.10 * p));
    const popup = Math.max(450, Math.round(t.popupMs * (1 - 0.30 * p)));
    const conc = Math.min(4, Math.round(t.concurrent * (1 + 0.30 * p)));

    /* --- 九窝几何（§19：中部 80% 宽） --- */
    const gw = area.w * 0.8, x0 = (area.w - gw) / 2;
    const gy0 = area.y + 66, gh = Math.min(area.h - 92, gw * 0.92);
    const cw = gw / 3, ch = gh / 3, holeR = Math.min(cw, ch) * 0.34;
    const holeXY = i => [x0 + (i % 3) * cw + cw / 2, gy0 + Math.floor(i / 3) * ch + ch / 2];

    /* --- 整场节拍表（seed）：轮 → {窝, 是否炸弹}[]；约束 §19 两条 --- */
    const rounds = [];
    let prevHoles = [];
    for (let rt = 0; rt < t.timeSec; rt += popup / 1000) {
      const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter(h => !prevHoles.includes(h));   // 同窝不连续两轮
      const set = [];
      for (let k = 0; k < conc && pool.length; k++) {
        const idx = Math.floor(rng() * pool.length);
        const hole = pool.splice(idx, 1)[0];
        set.push({ hole, bomb: rt >= GRACE && rng() < t.bombRate });                 // 前 5s 无炸弹
      }
      rounds.push({ t: +rt.toFixed(4), set });
      prevHoles = set.map(s => s.hole);
    }

    /* --- 运行状态 --- */
    let moles = [], timeLeft = t.timeSec, roundIdx = 0;
    let hits = 0, bombs = 0, lives = t.lives;
    let combo = 0, maxCombo = 0, score = 0, done = false, anim = 0;
    let down = null, popFx = [];

    const curScore = () => Math.max(0, hits * 10 + maxCombo * 5 - bombs * 20);

    function step() {
      if (done) return;
      timeLeft -= STEP;
      const now = t.timeSec - timeLeft;
      while (roundIdx < rounds.length && rounds[roundIdx].t <= now) {   // 换轮：旧头收起、新头冒出
        moles = [];
        for (const s of rounds[roundIdx].set) moles.push({ hole: s.hole, bomb: s.bomb, born: anim });
        roundIdx++;
      }
      if (timeLeft <= 0) { done = true; score = curScore(); game.lose(score); }   // 时限到未达标（§19）
    }

    function tap(x, y) {
      if (done) return;
      for (let i = 0; i < 9; i++) {
        const [hx, hy] = holeXY(i);
        if ((x - hx) * (x - hx) + (y - hy) * (y - hy) <= (holeR + 14) * (holeR + 14)) {   // 热区放宽 14px
          const m = moles.find(mm => mm.hole === i);
          if (m) {
            moles = moles.filter(mm => mm !== m);
            if (m.bomb) {                                      // 点炸弹：扣 20 耗命断连击（§19）
              bombs++; lives--; combo = 0;
              game.toast(`炸弹！剩 ${lives} 命`);
              if (lives <= 0) { done = true; score = curScore(); game.lose(score); return; }
            } else {
              hits++; combo++; maxCombo = Math.max(maxCombo, combo);
              popFx.push({ hole: i, t: 0.35 });
              if (hits >= target) { done = true; score = curScore(); game.win(score, { s2: target * 12, s3: target * 15 }); return; }
            }
            return;
          }
          combo = 0;                                           // 点空窝断连击（裁量）
          return;
        }
      }
    }

    return {
      startLevel() { game.setHud([{ t: `/${target}`, v: 0 }, { t: '命', v: lives }, { t: '秒', v: t.timeSec }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        score = curScore();
        for (const f of popFx) f.t -= dt;
        popFx = popFx.filter(f => f.t > 0);
        game.setHud([
          { t: `/${target}`, v: hits },
          { t: `x${lives}`, v: Math.ceil(Math.max(0, timeLeft)) },
          { t: '连击', v: combo },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) tap(x, y); down = null; },
      render(g) {
        /* 倒计时条 */
        const tr = G.clamp(timeLeft / t.timeSec, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = tr > 0.25 ? '#7bd88f' : '#ff8fa3'; g.fillRect(20, area.y + 6, (area.w - 40) * tr, 4);
        /* 九窝 */
        for (let i = 0; i < 9; i++) {
          const [hx, hy] = holeXY(i);
          g.fillStyle = '#1a2133';
          g.beginPath(); g.ellipse(hx, hy + holeR * 0.5, holeR * 1.15, holeR * 0.55, 0, 0, 7); g.fill();
          g.strokeStyle = '#232c42'; g.lineWidth = 3; g.stroke();
          const m = moles.find(mm => mm.hole === i);
          if (m) {
            const rise = G.clamp((anim - m.born) / 0.12, 0, 1);        // 冒头弹跳（装饰）
            const my = hy + holeR * 0.35 - rise * holeR * 1.1;
            if (m.bomb) {
              g.fillStyle = '#1a2133'; g.beginPath(); g.arc(hx, my, holeR * 0.62, 0, 7); g.fill();
              g.strokeStyle = '#ff8fa3'; g.lineWidth = 2.5; g.stroke();
              g.strokeStyle = '#ffd166'; g.beginPath(); g.moveTo(hx + 4, my - holeR * 0.62); g.lineTo(hx + 10, my - holeR * 0.62 - 7); g.stroke();
            } else {
              g.fillStyle = '#b08968'; g.beginPath(); g.arc(hx, my, holeR * 0.62, 0, 7); g.fill();
              g.fillStyle = '#8a6a4f'; g.beginPath(); g.ellipse(hx, my + holeR * 0.3, holeR * 0.5, holeR * 0.34, 0, 0, 7); g.fill();
              g.fillStyle = '#101522';
              g.beginPath(); g.arc(hx - holeR * 0.22, my - holeR * 0.12, 2.4, 0, 7); g.fill();
              g.beginPath(); g.arc(hx + holeR * 0.22, my - holeR * 0.12, 2.4, 0, 7); g.fill();
              g.fillStyle = '#ff8fa3'; g.beginPath(); g.ellipse(hx, my + holeR * 0.1, holeR * 0.16, holeR * 0.12, 0, 0, 7); g.fill();
            }
          }
          const f = popFx.find(pf => pf.hole === i);
          if (f) {
            g.globalAlpha = G.clamp(f.t / 0.35, 0, 1);
            g.fillStyle = '#ffd166'; g.font = G.FONT(20, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('✓', hx, hy - holeR * 1.2); g.globalAlpha = 1;
          }
        }
      },
      __state() {
        return {
          target, popupMs: popup, concurrent: conc, bombRate: t.bombRate, livesMax: t.lives, timeSec: t.timeSec,
          roundsN: rounds.length, roundIdx,
          rounds: rounds.map(r => [+r.t.toFixed(3), r.set.map(s => [s.hole, s.bomb ? 1 : 0])]),
          timeLeft: +timeLeft.toFixed(2), hits, bombs, livesLeft: lives, combo, maxCombo, score, done,
          holes: Array.from({ length: 9 }, (_, i) => { const [hx, hy] = holeXY(i); return [+hx.toFixed(1), +hy.toFixed(1), +holeR.toFixed(1)]; }),
          moles: moles.map(m => [m.hole, m.bomb ? 1 : 0]),
        };
      },
    };
  };
})();
