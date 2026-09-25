'use strict';
/* =====================================================================
 * 水排序引擎（spec §24）：点源管再点目标管倾倒；只能倒向同色顶层或空管。
 * 生成：由已解终局出发，用 seed 反向执行 N=⌈moves×0.6⌉ 次合法倒水 → 生成即保证可解；
 *       终局仍为已解（退化）则重掷。反向倒水 = 从 B 顶部取 j 层同色放回 A（A 顶异色或空）。
 * 通关：全部颜色各自归拢为整管；步数耗尽即失败。
 * score = colors(L)×100 + 剩余步×10；星级（覆盖 §3.2）：2★ used ≤ 0.80×moves，3★ used ≤ 0.65×moves。
 * ===================================================================== */
const WaterSortEngine = (function () {
  const PAL = ['#ff8fa3', '#ffd166', '#7bd88f', '#6ea8ff', '#b56cff', '#ff9f43', '#4dd0e1', '#f6a5c0', '#a3d977', '#7c9eff', '#e2b6ff', '#ffd48a', '#8affd4', '#ff7b7b'];

  const colorsOf = (t, L, n) => Math.min(t.colorsCap, t.colorsBase + Math.floor((L - 1) / Math.max(1, Math.floor(n / 5))));
  const movesOf = (t, colors) => Math.ceil(colors * t.tubeCap * t.moveFactor * 0.5);

  return function (game) {
    const { cfg, rng } = game;
    const t = Object.assign({ colorsBase: 5, colorsCap: 10, tubeCap: 4, emptyTubes: 2, moveFactor: 2.2 }, cfg.typeExtra);
    const CAP = t.tubeCap;
    const area = game.area;

    let tubes, colors, movesLimit, used, over, sel = -1, animPulse;

    const topRun = (tb) => { const n = tb.length; if (!n) return { c: -1, k: 0 }; let k = 1; while (k < n && tb[n - 1 - k] === tb[n - 1]) k++; return { c: tb[n - 1], k }; };
    const solved = () => tubes.every(tb => tb.length === 0 || (tb.length === CAP && tb.every(v => v === tb[0])));

    /* 反向生成（每次重掷继续消费同一 rng 流，保持确定性） */
    function generate() {
      for (let attempt = 0; attempt < 32; attempt++) {
        tubes = [];
        for (let c = 0; c < colors; c++) tubes.push(new Array(CAP).fill(c));
        for (let e = 0; e < t.emptyTubes; e++) tubes.push([]);
        const n = Math.ceil(movesLimit * 0.6);
        let moved = 0;
        for (let s = 0; s < n; s++) {
          /* 反向倒水：B 顶部 j 层同色 → A（A 空或顶异色） */
          const srcs = [];
          for (let i = 0; i < tubes.length; i++) if (tubes[i].length) srcs.push(i);
          if (!srcs.length) break;
          const B = srcs[(rng() * srcs.length) | 0];
          const run = topRun(tubes[B]);
          const dsts = [];
          for (let i = 0; i < tubes.length; i++) {
            if (i === B || tubes[i].length >= CAP) continue;
            const tr = topRun(tubes[i]);
            if (tr.k === 0 || tr.c !== run.c) dsts.push(i);
          }
          if (!dsts.length) continue;
          const A = dsts[(rng() * dsts.length) | 0];
          const room = Math.min(run.k, CAP - tubes[A].length);   // 可回填层数
          const j = room - ((rng() * room) | 0);                 // j ∈ [1, room]
          for (let m = 0; m < j; m++) tubes[A].push(tubes[B].pop());
          moved += j;
        }
        if (moved > 0 && !solved()) return;                    // 非退化 → 采纳
      }
      /* 32 掷仍退化（理论不可能）：保留最后一局 */
    }
    function pour(a, b) {
      const ra = topRun(tubes[a]);
      const space = CAP - tubes[b].length;
      const k = Math.min(ra.k, space);
      for (let m = 0; m < k; m++) tubes[b].push(tubes[a].pop());
      return k;
    }
    const canPour = (a, b) => a !== b && tubes[a].length && tubes[b].length < CAP &&
      (tubes[b].length === 0 || tubes[b][tubes[b].length - 1] === tubes[a][tubes[a].length - 1]);

    /* 布局：每行 5 管 */
    let layout = null;
    function computeLayout() {
      const per = 5, tw = 46, gapX = 14, gapY = 26;
      const rows = Math.ceil(tubes.length / per);
      const totalW = per * tw + (per - 1) * gapX;
      const x0 = (area.w - totalW) / 2;
      const th = CAP * 24 + 8;
      const y0 = area.y + 58;
      layout = { per, tw, th, pos: [] };
      for (let i = 0; i < tubes.length; i++) {
        const r = Math.floor(i / per), c = i % per;
        layout.pos.push({ x: x0 + c * (tw + gapX) + (r % 2 ? 7 : 0), y: y0 + r * (th + gapY) });
      }
    }
    function tubeAt(x, y) {
      for (let i = 0; i < layout.pos.length; i++) {
        const p = layout.pos[i];
        if (x >= p.x - 6 && x <= p.x + layout.tw + 6 && y >= p.y - 44 && y <= p.y + layout.th + 8) return i;  // 热区加宽（≥44px）
      }
      return -1;
    }

    return {
      startLevel() {
        colors = colorsOf(t, game.level, cfg.levels);
        movesLimit = movesOf(t, colors);
        used = 0; over = false; sel = -1; animPulse = 0;
        generate();
        computeLayout();
        game.setHud([{ t: '颜色', v: colors }, { t: '步数', v: movesLimit }]);
      },
      update(dt) { animPulse = Math.max(0, animPulse - dt); },
      render(g) {
        /* 步数进度条 */
        const pw = area.w - 24, px = 12, py = area.y + 10;
        g.fillStyle = '#1a2133'; G.roundRect(g, px, py, pw, 12, 6); g.fill();
        g.fillStyle = used / movesLimit > 0.8 ? '#ff8fa3' : '#6ea8ff';
        G.roundRect(g, px + 2, py + 2, Math.max(3, (pw - 4) * (1 - used / movesLimit)), 8, 4); g.fill();
        g.fillStyle = '#8b94a7'; g.font = G.FONT(11, 500); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`剩余 ${movesLimit - used} 步`, area.w / 2, py + 6);
        for (let i = 0; i < tubes.length; i++) {
          const p = layout.pos[i], tw = layout.tw, th = layout.th;
          const isSel = i === sel;
          g.save();
          if (isSel) { g.translate(0, -8); g.shadowColor = '#ffd166'; g.shadowBlur = 10; }
          /* 管体（玻璃） */
          g.fillStyle = 'rgba(140,170,220,.10)';
          g.strokeStyle = isSel ? '#ffd166' : '#3a4a6b'; g.lineWidth = isSel ? 3 : 2;
          G.roundRect(g, p.x, p.y, tw, th, 9); g.fill(); g.stroke();
          g.restore();
          /* 水层（自底向上） */
          const lh = 24, ly = p.y + th - 4;
          for (let m = 0; m < tubes[i].length; m++) {
            g.fillStyle = PAL[tubes[i][m]];
            G.roundRect(g, p.x + 3.5, ly - (m + 1) * lh + 1, tw - 7, lh - 2, 4); g.fill();
          }
          /* 管口椭圆 */
          g.strokeStyle = '#3a4a6b'; g.lineWidth = 2;
          g.beginPath(); g.ellipse(p.x + tw / 2, p.y + 2, tw / 2 - 3, 5, 0, 0, 7); g.stroke();
          if (isSel) {   /* 顶部浮层提示（将倒出的顶层） */
            const run = topRun(tubes[i]);
            g.fillStyle = PAL[run.c];
            G.roundRect(g, p.x + 6, p.y - 40, tw - 12, 12, 6); g.fill();
            g.fillStyle = '#101522'; g.font = G.FONT(10, 700);
            g.fillText('倒出 ' + Math.min(run.k, CAP), p.x + tw / 2, p.y - 33.5);
          }
        }
      },
      onDown() { },
      onMove() { },
      onUp(x, y) {
        if (over) return;
        const i = tubeAt(x, y);
        if (i < 0) { sel = -1; return; }
        if (sel === -1) {
          if (tubes[i].length) { sel = i; game.toast('已选源管，点目标管'); }
          else game.toast('空管不能作源');
          return;
        }
        if (i === sel) { sel = -1; return; }                    // 再点同管 = 取消
        if (canPour(sel, i)) {
          pour(sel, i);
          used++;
          animPulse = .3;
          game.setHud([{ t: '颜色', v: colors }, { t: '步数', v: movesLimit - used }]);
          sel = -1;
          if (solved()) {
            over = true;
            const score = colors * 100 + (movesLimit - used) * 10;
            const stars = 1 + (used <= 0.80 * movesLimit ? 1 : 0) + (used <= 0.65 * movesLimit ? 1 : 0);
            game.win(score, { stars });
          } else if (used >= movesLimit) { over = true; game.lose(0); }
        } else {
          game.toast('只能倒向同色顶层或空管');
          sel = tubes[i].length ? i : -1;                        // 换选
        }
      },
      __state: () => ({ tubes: tubes.map(tb => tb.slice()), colors, movesLimit, used, layout, solved: solved() }),
    };
  };
})();
