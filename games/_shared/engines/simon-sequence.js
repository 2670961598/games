'use strict';
/* =====================================================================
 * 序列记忆引擎（spec §21）：色块面板按序点亮，玩家依序复述；答对整条序列 +1 续玩，
 * 直到 targetLen(L)；答错耗 retries 即败。
 * 曲线：targetLen(L)=min(targetLenCap,3+⌊12p⌋)；flash(L)=max(250,round(flashMs×(1−0.25p)))；
 *       gapMs=flash(L)×0.45（§21 键间间隔）；p=(L−1)/(Ln−1)；pads/startLen 档位常量。
 * 生成（§21）：序列每位由 seed 在 pads 键上均匀掷点；约束：不连续三同键（重掷，确定序）。
 * 流程：show（逐键点亮 flash(L)ms + 间隔 gapMs）→ input（复述）→ 全对则 len+1 再 show；
 *   答错：retries 余 >0 时消耗 1 次重放同长度，否则判负。
 * 裁量：show 期点按忽略（§21 复述期禁多点的对偶面）；重试不重生成序列（同序列重放）。
 * 计分：score=复述步数×10+通关×50（复述步数=累计答对的单键数）；s2=targetLen×12，s3=×15。
 * 交互（§21）：pad 均分大区块（4 键 2×2 / 6 键 2×3 / 9 键 3×3），热区 ≥44px。
 * ===================================================================== */
const SimonSequenceEngine = (function () {
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ pads: 4, flashMs: 550, gapMs: 250, startLen: 3, targetLenCap: 15, retries: 1 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const targetLen = Math.min(t.targetLenCap, 3 + Math.floor(12 * p));
    const flash = Math.max(250, Math.round(t.flashMs * (1 - 0.25 * p)));
    const gap = Math.round(flash * 0.45);
    const len0 = Math.max(1, Math.min(t.startLen, targetLen));

    /* --- 序列预生成（seed；不连续三同键 §21） --- */
    const seq = [];
    while (seq.length < targetLen) {
      const k = Math.floor(rng() * t.pads);
      const m = seq.length;
      if (m >= 2 && seq[m - 1] === k && seq[m - 2] === k) continue;   // 重掷（rng 已消费，仍确定）
      seq.push(k);
    }

    /* --- pad 布局（4→2×2 / 6→2×3 / 9→3×3，§21） --- */
    const cols = t.pads === 9 ? 3 : 2, rows = Math.ceil(t.pads / cols);
    const gw = area.w * 0.88, x0 = (area.w - gw) / 2;
    const gy0 = area.y + 56, gh = Math.min(area.h - 80, gw);
    const pw = gw / cols, ph = gh / rows;
    const padRect = k => [x0 + (k % cols) * pw + 7, gy0 + Math.floor(k / cols) * ph + 7, pw - 14, ph - 14];
    const HUES = [210, 0, 115, 45, 275, 320, 180, 30, 250];

    /* --- 运行状态 --- */
    let len = len0, phase = 'show', showT = 0, pos = 0;
    let steps = 0, retriesLeft = t.retries, done = false, anim = 0;
    let litK = -1, litOn = false, wrongK = -1, down = null;

    function step() {
      if (done) return;
      if (phase === 'show') {                                  // 逐键点亮（时间轴步进）
        showT += STEP;
        const unit = (flash + gap) / 1000;
        const idx = Math.floor(showT / unit);
        if (idx >= len) { phase = 'input'; pos = 0; litK = -1; litOn = false; return; }
        const inUnit = showT - idx * unit;
        litK = seq[idx]; litOn = inUnit <= flash / 1000;
      }
    }

    function tap(x, y) {
      if (done || phase !== 'input') return;
      for (let k = 0; k < t.pads; k++) {
        const [px, py, w, h] = padRect(k);
        if (x >= px && x <= px + w && y >= py && y <= py + h) {
          if (k === seq[pos]) {                                // 答对：推进
            pos++; steps++;
            litK = k; litOn = true;
            if (pos >= len) {                                  // 整条复述完 → +1 续玩（§21）
              if (len >= targetLen) { done = true; game.win(steps * 10 + 50, { s2: targetLen * 12, s3: targetLen * 15 }); return; }
              len++; phase = 'show'; showT = 0; pos = 0;
            }
          } else if (retriesLeft > 0) {                        // 答错：耗 1 次重试重放（裁量）
            retriesLeft--;
            phase = 'show'; showT = 0; pos = 0;
          } else {                                             // retries 耗尽（§21）
            wrongK = k; done = true; game.lose(steps * 10);
          }
          return;
        }
      }
    }

    return {
      startLevel() { game.setHud([{ t: `/长${targetLen}`, v: len0 }, { t: '步', v: 0 }, { t: '重试', v: retriesLeft }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        if (phase === 'input' && !done) { litOn = false; }     // 复述期点亮仅闪现
        game.setHud([
          { t: `/长${targetLen}`, v: len },
          { t: '步', v: steps },
          { t: '重试', v: retriesLeft },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) tap(x, y); down = null; },
      render(g) {
        /* 状态提示条 */
        g.fillStyle = '#1a2133'; g.fillRect(0, area.y + 6, area.w, 30);
        g.fillStyle = phase === 'show' ? '#ffd166' : '#7bd88f'; g.font = G.FONT(14, 700);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(phase === 'show' ? `记住序列（长度 ${len}）` : `请复述（${pos}/${len}）`, area.w / 2, area.y + 21);
        /* pads */
        for (let k = 0; k < t.pads; k++) {
          const [px, py, w, h] = padRect(k);
          const lit = k === litK && litOn, wrong = k === wrongK;
          g.fillStyle = wrong ? '#ff5f7e' : lit
            ? `hsl(${HUES[k]},85%,62%)`
            : `hsl(${HUES[k]},52%,30%)`;
          G.roundRect(g, px, py, w, h, 16); g.fill();
          g.strokeStyle = lit ? '#fff' : `hsl(${HUES[k]},52%,44%)`; g.lineWidth = lit ? 4 : 2;
          G.roundRect(g, px, py, w, h, 16); g.stroke();
          g.fillStyle = lit ? '#101522' : `hsl(${HUES[k]},40%,72%)`; g.font = G.FONT(Math.min(22, w * 0.3), 800);
          g.fillText(String(k + 1), px + w / 2, py + h / 2);
        }
      },
      __state() {
        return {
          targetLen, flashMs: flash, gapMs: gap, pads: t.pads, retries0: t.retries, retriesLeft,
          len, phase, pos, steps, done, score: done ? steps * 10 + 0 : 0,
          seq: seq.slice(),
          padRects: Array.from({ length: t.pads }, (_, k) => { const [px, py, w, h] = padRect(k); return [+px.toFixed(1), +py.toFixed(1), +w.toFixed(1), +h.toFixed(1)]; }),
        };
      },
    };
  };
})();
