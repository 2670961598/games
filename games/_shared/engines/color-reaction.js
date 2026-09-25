'use strict';
/* =====================================================================
 * 颜色反应引擎（spec §22，Stroop 范式）：出示大号颜色词（墨色随机），判断"墨色与词义
 * 是否一致"，点屏左半=一致 ✔ / 右半=不一致 ✘；完成 rounds(L) 且 miss 未耗尽即胜。
 * 曲线：rounds(L)=ceil(roundsBase×(1+0.20p))；round(L)=max(600,round(perRoundMs×(1−0.30p)))；
 *       p=(L−1)/(Ln−1)；agreeRate 固定 0.5、maxMiss/trapSwitch 档位常量。
 * 生成（§22）：每轮词/墨色/是否一致由 seed 掷点；词池色池固定 8 词 8 色（红橙黄绿青蓝紫黑）；
 *   不一致轮的墨色取 (词+1+⌊rng×7⌋)%8 保证异色且均匀。
 * trapSwitch（§22）：L>10 起偶发"反规则轮"（题义反转，答对方向取反；率 0.12 裁量），
 *   当轮顶部黄条提示 1s。
 * 裁量：错答 −15 并计 miss；超时计 miss 不断扣分分（−15 仅错答）；两者均断连击；
 *   "连击×3"取最大连击。
 * 计分：score=正确×10+最大连击×3−错答×15（下限 0）；s2=rounds(L)×12，s3=rounds(L)×15。
 * 交互（§22）：controls tap-zone——屏幕下 1/2 左右两大热区，题面在中央。
 * ===================================================================== */
const ColorReactionEngine = (function () {
  const TRAP_RATE = 0.12;      // 反规则轮出现率（裁量，§22"偶发"）
  const STEP = 1 / 120;
  const WORDS = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '黑'];
  const INKS = ['#ff5f5f', '#ff9f40', '#ffd166', '#58c470', '#4ec9c9', '#5b8dff', '#a97fff', '#c9d2e3'];

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ roundsBase: 20, perRoundMs: 1500, agreeRate: 0.50, maxMiss: 3, trapSwitch: true }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const rounds = Math.ceil(t.roundsBase * (1 + 0.20 * p));
    const roundMs = Math.max(600, Math.round(t.perRoundMs * (1 - 0.30 * p)));
    const trapOn = t.trapSwitch && L > 10;

    /* --- 整场轮次表（seed）：[词, 墨, 一致?, 反规则?] --- */
    const table = [];
    for (let i = 0; i < rounds; i++) {
      const word = Math.floor(rng() * 8);
      const agree = rng() < t.agreeRate;
      const ink = agree ? word : (word + 1 + Math.floor(rng() * 7)) % 8;
      const trap = trapOn && rng() < TRAP_RATE;
      table.push([word, ink, agree ? 1 : 0, trap ? 1 : 0]);
    }

    /* --- 热区（§22：下 1/2 左右两大区） --- */
    const midY = area.y + area.h * 0.52;
    const zoneL = [0, midY, area.w / 2, area.y + area.h - midY];
    const zoneR = [area.w / 2, midY, area.w / 2, area.y + area.h - midY];

    /* --- 运行状态 --- */
    let idx = 0, roundT = 0;
    let corrects = 0, wrongs = 0, misses = 0, combo = 0, maxCombo = 0;
    let score = 0, done = false, anim = 0, lastFx = null;
    let down = null;

    const curScore = () => Math.max(0, corrects * 10 + maxCombo * 3 - wrongs * 15);

    function answer(sideL) {                                  // sideL=true 左（一致）
      if (done || idx >= rounds) return;
      const [word, ink, agree, trap] = table[idx];
      const match = word === ink;
      const ok = sideL === (trap ? !match : match);            // 反规则轮取反（§22）
      lastFx = { ok, t: 0.4, side: sideL ? 'L' : 'R' };
      if (ok) { corrects++; combo++; maxCombo = Math.max(maxCombo, combo); }
      else { wrongs++; misses++; combo = 0; }                  // 错答：−15+miss+断连击（裁量）
      next();
    }

    function next() {
      idx++; roundT = 0;
      if (misses >= t.maxMiss) { done = true; score = curScore(); game.lose(score); return; }   // miss 耗尽（§22）
      if (idx >= rounds) { done = true; score = curScore(); game.win(score, { s2: rounds * 12, s3: rounds * 15 }); }   // 全轮完成（§22）
    }

    function step() {
      if (done || idx >= rounds) return;
      roundT += STEP;
      if (roundT >= roundMs / 1000) {                          // 超时：计 miss 断连击，不扣分（裁量）
        misses++; combo = 0;
        lastFx = { ok: false, t: 0.4, side: 'T' };
        next();
      }
    }

    function tap(x, y) {
      if (done || idx >= rounds || y < midY) return;           // 上半屏为题面（§22 题面在中央）
      answer(x < area.w / 2);
    }

    return {
      startLevel() { game.setHud([{ t: `/轮${rounds}`, v: 0 }, { t: `/${t.maxMiss}误`, v: 0 }, { t: '连击', v: 0 }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        score = curScore();
        if (lastFx && lastFx.t > 0) lastFx.t -= dt;
        game.setHud([
          { t: `/轮${rounds}`, v: idx },
          { t: `/${t.maxMiss}误`, v: misses },
          { t: '连击', v: combo },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) tap(x, y); down = null; },
      render(g) {
        const cur = table[Math.min(idx, rounds - 1)];
        if (cur && !done) {
          const [word, ink, agree, trap] = cur;
          const timeUsed = G.clamp(1 - roundT / (roundMs / 1000), 0, 1);
          /* 本轮倒计时环 */
          g.strokeStyle = '#1a2133'; g.lineWidth = 6;
          g.beginPath(); g.arc(area.w / 2, area.y + 96, 30, 0, 7); g.stroke();
          g.strokeStyle = timeUsed > 0.25 ? '#7bd88f' : '#ff8fa3';
          g.beginPath(); g.arc(area.w / 2, area.y + 96, 30, -Math.PI / 2, -Math.PI / 2 + 7 * timeUsed); g.stroke();
          /* 题面：大号颜色词 × 随机墨色 */
          g.fillStyle = INKS[ink];
          g.font = G.FONT(110, 800); g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(WORDS[word], area.w / 2, area.y + 190);
          g.fillStyle = '#8b94a7'; g.font = G.FONT(14, 500);
          g.fillText('墨色与词义一致吗？', area.w / 2, area.y + 268);
          /* 反规则轮黄条提示（§22：顶部黄条 1s） */
          if (trap && roundT <= 1) {
            g.fillStyle = 'rgba(255,209,102,.16)'; g.fillRect(0, area.y + 10, area.w, 34);
            g.fillStyle = '#ffd166'; g.font = G.FONT(15, 700);
            g.fillText('⚠ 反规则轮：答相反方向', area.w / 2, area.y + 27);
          }
        }
        /* 下 1/2 左右热区（§22） */
        g.font = G.FONT(17, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = 'rgba(123,216,143,.10)'; g.fillRect(zoneL[0] + 10, zoneL[1] + 10, zoneL[2] - 20, zoneL[3] - 10);
        g.fillStyle = 'rgba(255,143,163,.10)'; g.fillRect(zoneR[0] + 10, zoneR[1] + 10, zoneR[2] - 20, zoneR[3] - 10);
        g.fillStyle = '#7bd88f'; g.fillText('一致 ✔', zoneL[0] + zoneL[2] / 2, zoneL[1] + zoneL[3] / 2 - 12);
        g.fillStyle = '#ff8fa3'; g.fillText('不一致 ✘', zoneR[0] + zoneR[2] / 2, zoneR[1] + zoneR[3] / 2 - 12);
        g.fillStyle = '#8b94a7'; g.font = G.FONT(12, 400);
        g.fillText('点左半 / 右半作答', area.w / 2, zoneL[1] + zoneL[3] / 2 + 16);
        /* 判定反馈闪现 */
        if (lastFx && lastFx.t > 0) {
          g.globalAlpha = G.clamp(lastFx.t / 0.4, 0, 1) * 0.25;
          g.fillStyle = lastFx.ok ? '#7bd88f' : '#ff5f7e';
          if (lastFx.side === 'L') g.fillRect(zoneL[0], zoneL[1], zoneL[2], zoneL[3]);
          else if (lastFx.side === 'R') g.fillRect(zoneR[0], zoneR[1], zoneR[2], zoneR[3]);
          else g.fillRect(0, area.y + 10, area.w, 34);
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          rounds, roundMs, maxMiss: t.maxMiss, agreeRate: t.agreeRate, trapOn, roundT: +roundT.toFixed(2),
          idx, corrects, wrongs, misses, combo, maxCombo, score, done,
          traps: table.filter(r => r[3]).length,
          cur: idx < rounds ? table[idx].slice() : null,
          table: table.map(r => r.slice()),
        };
      },
    };
  };
})();
