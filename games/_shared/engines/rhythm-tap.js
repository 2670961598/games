'use strict';
/* =====================================================================
 * 节奏点击引擎（spec §30）：四轨音符下落，到判定线时点对应轨区。
 * 判定窗：Perfect ±perfectMs；Great ±2×；Good ±3×；超窗 Miss。
 * 血量：Miss / Great 以下（即 Good、Miss）各 −1（§30 字面口径）。
 * 谱面生成（seed）：节拍网格上每拍按 density 期望掷音符数（floor+frac 掷点），
 *   轨号均匀掷点；约束：同拍多押仅相邻轨（单指可交替）、同轨同拍不重、
 *   同轨相邻音符最小间隔 1 拍；总数收敛到 notes(L)。
 *   注：density 期望与"双押率 0.15"在 density>1.15 时不可同时严格成立，
 *   以 density 期望为准（决定音符密度/总数），邻轨约束严格执行（引擎侧仲裁，见 REPORT）。
 * score = Perfect×100 + Great×70 + Good×40 + 连击加成每注+2（cap 100）；
 * s2 = 80×notes(L)，s3 = 92×notes(L)。
 * ===================================================================== */
const RhythmTapEngine = (function () {
  const LANE_COL = ['#6ea8ff', '#7bd88f', '#ffd166', '#ff8fa3'];
  const JUDGE_COL = { Perfect: '#ffd166', Great: '#7bd88f', Good: '#6ea8ff', Miss: '#ff8fa3' };

  const bpmOf = (t, L, n) => Math.round(t.bpm * (1 + 0.30 * (L - 1) / (n - 1)));
  const notesOf = (t, L, n) => Math.ceil(t.notesBase * (1 + 0.50 * (L - 1) / (n - 1)));

  return function (game) {
    const { cfg, rng } = game;
    const t = Object.assign({ bpm: 100, density: 1.20, notesBase: 60, perfectMs: 50, life: 6 }, cfg.typeExtra);
    const area = game.area;
    const bpm = bpmOf(t, game.level, cfg.levels);
    const notesN = notesOf(t, game.level, cfg.levels);
    const beat = 60 / bpm;
    const laneW = area.w / 4;
    const judgeY = area.y + area.h * 0.80;          // 判定线
    const spawnY = area.y - 20;
    const travel = 1.35;                            // 音符从顶到判定线秒数（视觉）
    const fallV = (judgeY - spawnY) / travel;

    let notes, life, score, combo, comboMax, over, won, tNow, judged;
    let pops = [], flashes = [0, 0, 0, 0];
    let counts = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };

    /* ---- 谱面生成（seed 驱动，全量前置 → 同 seed 同关谱面逐字节一致） ---- */
    function genChart() {
      notes = [];
      const lastBeatLane = [-9, -9, -9, -9];
      const whole = Math.floor(t.density), frac = t.density - whole;
      for (let b = 0; notes.length < notesN; b++) {
        let cnt = whole + (rng() < frac ? 1 : 0);
        cnt = Math.min(cnt, 2);                     // 单指约束：同拍至多双押
        if (cnt === 0) continue;
        const lanes = [];
        let guard = 0;
        while (lanes.length < cnt && guard++ < 24) {
          const lane = (rng() * 4) | 0;
          if (lanes.includes(lane)) continue;
          if (b - lastBeatLane[lane] < 1) continue;  // 同轨相邻音符 ≥1 拍
          lanes.push(lane);
        }
        if (!lanes.length) continue;
        /* 双押仅相邻轨：不满足则只留首发轨 */
        if (lanes.length === 2 && Math.abs(lanes[0] - lanes[1]) !== 1) lanes.pop();
        for (const lane of lanes) {
          if (notes.length >= notesN) break;
          notes.push({ beat: b, lane, hit: 0, judge: '' });   // hit: 0 未判 1 已判
          lastBeatLane[lane] = b;
        }
      }
    }

    const chartLen = () => (notes.length ? notes[notes.length - 1].beat : 0) * beat + 1.2;
    const noteTime = (nt) => nt.beat * beat + 0.6;   // 0.6s 预备

    return {
      startLevel() {
        genChart();
        life = t.life; score = 0; combo = 0; comboMax = 0; over = false; won = false; tNow = 0;
        pops = []; flashes = [0, 0, 0, 0]; counts = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };
        judged = 0;
        game.setHud([{ t: '生命', v: life }, { t: '连击', v: 0 }]);
      },
      update(dt) {
        if (over) return;
        tNow += dt;
        for (let i = 0; i < 4; i++) flashes[i] = Math.max(0, flashes[i] - dt * 5);
        for (const p of pops) p.t -= dt * 2.2;
        pops = pops.filter(p => p.t > 0);
        /* 过窗未击 → Miss */
        for (const nt of notes) {
          if (!nt.hit && tNow - noteTime(nt) > t.perfectMs / 1000 * 3) {
            nt.hit = 1; nt.judge = 'Miss'; judged++;
            counts.Miss++; combo = 0; life--;
            pops.push({ x: laneW * (nt.lane + .5), y: judgeY, t: 1, s: 'Miss' });
            game.setHud([{ t: '生命', v: life }, { t: '连击', v: combo }]);
            if (life <= 0) { over = true; game.lose(score); return; }
          }
        }
        /* 谱面走完 */
        if (judged >= notes.length && tNow > chartLen()) {
          over = true; won = true;
          game.win(score, { s2: 80 * notesN, s3: 92 * notesN });
        }
      },
      render(g) {
        /* 轨道 */
        for (let l = 0; l < 4; l++) {
          g.fillStyle = l % 2 ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.045)';
          g.fillRect(laneW * l, area.y, laneW, area.h);
          if (flashes[l] > 0) {
            g.fillStyle = `rgba(110,168,255,${flashes[l] * .25})`;
            g.fillRect(laneW * l, judgeY - 130, laneW, 130);
          }
          g.strokeStyle = '#232c42'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(laneW * (l + 1), area.y); g.lineTo(laneW * (l + 1), area.y + area.h); g.stroke();
          g.fillStyle = '#3a4358'; g.font = G.FONT(11, 500); g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('' + (l + 1), laneW * (l + .5), area.y + area.h - 14);
        }
        /* 判定线 */
        g.fillStyle = '#e8ecf3'; g.fillRect(0, judgeY - 1.5, area.w, 3);
        /* 音符 */
        for (const nt of notes) {
          if (nt.hit) continue;
          const dt = noteTime(nt) - tNow;
          const y = judgeY - dt * fallV;
          if (y < spawnY - 30 || y > area.y + area.h + 20) continue;
          const x = laneW * (nt.lane + .5), w = laneW * .62;
          g.fillStyle = LANE_COL[nt.lane];
          G.roundRect(g, x - w / 2, y - 9, w, 18, 9); g.fill();
          g.fillStyle = 'rgba(255,255,255,.4)';
          G.roundRect(g, x - w / 2 + 3, y - 7, w - 6, 5, 3); g.fill();
        }
        /* 判定弹字与连击 */
        for (const p of pops) {
          g.globalAlpha = G.clamp(p.t, 0, 1);
          g.fillStyle = JUDGE_COL[p.s]; g.font = G.FONT(p.s === 'Perfect' ? 17 : 15, 800);
          g.textAlign = 'center';
          g.fillText(p.s, p.x, judgeY - 44 - (1 - p.t) * 22);
          g.globalAlpha = 1;
        }
        if (combo >= 5) {
          g.textAlign = 'center'; g.fillStyle = '#e8ecf3'; g.font = G.FONT(26, 800);
          g.fillText('×' + combo, area.w / 2, area.y + area.h * 0.34);
          g.fillStyle = '#8b94a7'; g.font = G.FONT(11, 500);
          g.fillText('COMBO', area.w / 2, area.y + area.h * 0.34 + 20);
        }
      },
      onDown() { },
      onMove() { },
      onUp(x, y) {
        if (over || y < area.y + area.h * 0.45) return;   // 判定区：屏下 55%
        const lane = G.clamp(Math.floor(x / laneW), 0, 3);
        flashes[lane] = 1;
        /* 最近未击音符（该轨） */
        let best = null, bestAbs = Infinity;
        for (const nt of notes) {
          if (nt.hit || nt.lane !== lane) continue;
          const a = Math.abs(noteTime(nt) - tNow);
          if (a < bestAbs) { bestAbs = a; best = nt; }
        }
        if (!best) return;
        const pMs = t.perfectMs / 1000;
        let j = '';
        if (bestAbs <= pMs) j = 'Perfect';
        else if (bestAbs <= pMs * 2) j = 'Great';
        else if (bestAbs <= pMs * 3) j = 'Good';
        else return;                                     // 窗外空点不计
        best.hit = 1; best.judge = j; judged++;
        counts[j]++;
        combo++; comboMax = Math.max(comboMax, combo);
        const base = j === 'Perfect' ? 100 : j === 'Great' ? 70 : 40;
        score += base + 2 * Math.min(combo, 100);         // 连击加成每注 +2（cap 100）
        if (j === 'Good') { life--; }                     // Great 以下 −1
        pops.push({ x: laneW * (lane + .5), y: judgeY, t: 1, s: j });
        if (life <= 0) { over = true; game.lose(score); return; }
        game.setHud([{ t: '生命', v: life }, { t: '连击', v: combo }]);
      },
      __state: () => ({ notes: notes.map(n => ({ beat: n.beat, lane: n.lane, hit: n.hit, judge: n.judge })), life, score, combo, notesN, bpm, tNow, counts: { ...counts } }),
    };
  };
})();
