'use strict';
/* =====================================================================
 * 块填充引擎（spec §26，1010! 式）：10×10 无重力棋盘，每轮发 3 个形状块，
 * 放满整行/整列即消除；三块都放不下（refresh 耗尽）即败。
 * GAMES-49 迁移重构（原生基座黄金样本范式）：判定路径逐字保留（rng 消费序/形状池/
 * 计分/死局刷新与旧版一致——test-c 确定性/曲线/贪心模拟断言原样可跑）；
 * 表现层按 GAMES-24 §7.2.A 强化：
 *   A1 棋盘底+已填格静态层离屏缓存（只在放置/消格时重绘，主循环只 blit；
 *      vm 桩回退直绘——帧成本从 ~200 roundRect 降至 1 次 blit）；
 *   A2 消格爆点/得分浮字装饰池上限 MAX_FX（装饰不入 __state，不影响判定）；
 *   A4 HUD 源头脏检查（值变才 setHud，消灭逐帧分配/GC churn）；
 *   零 G./GE. 依赖（任何外壳/vm 桩可驱动）。
 * 曲线：target(L)=ceil(targetScore×(1+0.15(L−1)/(Ln−1)))；pent(L)=min(0.25,pentRate×(1+0.20(L−1)/(Ln−1)))。
 * 生成：形状池固定 21 形（1–5 格自由多格全集：1+1+2+5+12）；每轮 3 块由 seed 按
 *       pent(L) 掷复杂度再选形；障碍格位置由 seed 置于非角格。
 * 计分：score=放置格数×1+消行/列每行×10×格数(=100)+行列同消×30；
 *       s2=target(L)×1.2，s3=target(L)×1.5。
 * 映射：从底部块槽拖入棋盘（块渲染于指上 48px 保可见），接近格点自动吸附，抬起即确认。
 * ===================================================================== */
const BlockFitEngine = (function () {
  const N = 10, CELL = 30;
  const MAX_FX = 32;          // §7.2.A.2 装饰并发上限（爆点+浮字合计，超限弃最旧）
  const targetOf = (t, L, n) => Math.ceil(t.targetScore * (1 + 0.15 * (L - 1) / (n - 1)));
  const pentOf = (t, L, n) => Math.min(0.25, t.pentRate * (1 + 0.20 * (L - 1) / (n - 1)));
  /* 21 形状池（cells 归一化坐标 [x,y]） */
  const SHAPES = [
    [[0, 0]],
    [[0, 0], [1, 0]],
    [[0, 0], [1, 0], [2, 0]],
    [[0, 0], [1, 0], [1, 1]],
    [[0, 0], [1, 0], [2, 0], [3, 0]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [2, 0], [1, 1]],
    [[0, 0], [1, 0], [2, 0], [2, 1]],
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],              // I5
    [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]],              // L5
    [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],              // P
    [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],              // F
    [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],              // T
    [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],              // U
    [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],              // V
    [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],              // W
    [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],              // X
    [[0, 0], [0, 1], [1, 1], [0, 2], [0, 3]],              // Y
    [[1, 0], [2, 0], [0, 1], [1, 1], [0, 2]],              // N
    [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],              // Z
  ];
  const SMALL = SHAPES.slice(0, 9), PENT = SHAPES.slice(9); // 1–4 格 / 5 格
  const PCOL = ['#6ea8ff', '#7bd88f', '#ffd166', '#ff8fa3', '#b56cff', '#4dd0e1'];
  const colorOf = (cells) => PCOL[(cells.length + cells[0][0] + cells[0][1]) % PCOL.length];

  /* 本地工具（判定路径零外部依赖；与 GE/common.js 实现逐字一致） */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  const FONT = (px, w) => `${w || 400} ${px}px -apple-system,"PingFang SC","Noto Sans SC",sans-serif`;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ targetScore: 2000, pentRate: 0.12, obstacleStart: 0, piecesPerRound: 3, refresh: 0 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level;
    const target = targetOf(t, L, n), pent = pentOf(t, L, n);
    const boardX = (area.w - N * CELL) / 2, boardY = area.y + 14;

    /* ---- 棋盘：0 空 / 1 填 / 2 障碍 ---- */
    const grid = new Array(N * N).fill(0);
    {
      const corners = new Set(['0,0', `${N - 1},0`, `0,${N - 1}`, `${N - 1},${N - 1}`]);
      let placedObs = 0, guard = 0;
      while (placedObs < t.obstacleStart && guard++ < 500) {  // 障碍由 seed 置于非角格
        const r = (rng() * N) | 0, c = (rng() * N) | 0;
        if (grid[r * N + c] === 0 && !corners.has(`${c},${r}`)) { grid[r * N + c] = 2; placedObs++; }
      }
    }

    let pieces = [], score = 0, done = false, refreshLeft = t.refresh;
    let drag = null;                                     // {idx, x, y}
    let pops = [], clearFx = [];

    /* --- §7.2.A.1 静态层：棋盘底+已填格（只在放置/消格时变化，版本号触发重绘） --- */
    let gridVer = 0, seenVer = -1, boardLayer = null;     // { w, h, cvs|null }；cvs=null 回退直绘
    function staticLayer() {
      if (boardLayer && boardLayer.w === area.w && boardLayer.h === area.h && seenVer === gridVer) return boardLayer;
      let ok = false;
      try {
        if (typeof document !== 'undefined' && document.createElement) {
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(area.w * 2)); c.height = Math.max(1, Math.round(area.h * 2));
          const lg = c.getContext('2d');
          if (lg) { lg.scale(2, 2); drawBoard(lg, 0); ok = true; boardLayer = { w: area.w, h: area.h, cvs: c }; seenVer = gridVer; }
        }
      } catch (e) { ok = false; }
      if (!ok) boardLayer = { w: area.w, h: area.h, cvs: null };
      return boardLayer;
    }

    function dealRound() {
      pieces = [];
      for (let i = 0; i < t.piecesPerRound; i++) {       // 每轮 3 块：pent(L) 掷复杂度再选形
        const pool = rng() < pent ? PENT : SMALL;
        pieces.push({ cells: pool[(rng() * pool.length) | 0] });
      }
    }
    dealRound();

    const canPlace = (cells, r, c) => cells.every(([dx, dy]) => {
      const x = c + dx, y = r + dy;
      return x >= 0 && x < N && y >= 0 && y < N && grid[y * N + x] === 0;
    });
    const anyPlacement = (cells) => {
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (canPlace(cells, r, c)) return true;
      return false;
    };
    function checkDeadlock() {
      if (pieces.some(p => p && anyPlacement(p.cells))) return;
      if (refreshLeft > 0) {                             // 死局免费刷新：重发三块
        refreshLeft--;
        dealRound();
        game.toast('死局 · 免费换块');
        checkDeadlock();
      } else {
        done = true; game.lose(score);                   // 三块均无处可放且 refresh 耗尽
      }
    }
    function placeAt(idx, r, c) {
      const p = pieces[idx];
      score += p.cells.length;                           // 放置格数×1
      for (const [dx, dy] of p.cells) grid[(r + dy) * N + (c + dx)] = 1;
      /* 消行/列：每行×10×格数（=100），行列同消 +30 */
      const fullRows = [], fullCols = [];
      for (let rr = 0; rr < N; rr++) {
        let full = true;
        for (let cc = 0; cc < N; cc++) if (grid[rr * N + cc] === 0) { full = false; break; }
        if (full) fullRows.push(rr);
      }
      for (let cc = 0; cc < N; cc++) {
        let full = true;
        for (let rr = 0; rr < N; rr++) if (grid[rr * N + cc] === 0) { full = false; break; }
        if (full) fullCols.push(cc);
      }
      const lines = fullRows.length + fullCols.length;
      if (lines > 0) {
        score += lines * 10 * N;
        if (fullRows.length > 0 && fullCols.length > 0) score += 30;   // 行列同消×30
        for (const rr of fullRows) for (let cc = 0; cc < N; cc++) { clearFx.push({ x: boardX + cc * CELL + CELL / 2, y: boardY + rr * CELL + CELL / 2, t: 0.4 }); grid[rr * N + cc] = 0; }
        for (const cc of fullCols) for (let rr = 0; rr < N; rr++) { grid[rr * N + cc] = 0; clearFx.push({ x: boardX + cc * CELL + CELL / 2, y: boardY + rr * CELL + CELL / 2, t: 0.4 }); }
        if (clearFx.length > MAX_FX) clearFx.splice(0, clearFx.length - MAX_FX);   // §7.2.A.2 上限
        game.toast(`消除 ${fullRows.length} 行 ${fullCols.length} 列 +${lines * 10 * N + (fullRows.length && fullCols.length ? 30 : 0)}`);
      }
      pieces[idx] = null;
      pops.push({ x: boardX + (c + 1) * CELL, y: boardY + r * CELL, t: 0.4, text: '+' + p.cells.length });
      if (pops.length > MAX_FX) pops.splice(0, pops.length - MAX_FX);
      gridVer++;                                          // 静态层重绘触发（放置/消格改变棋盘）
      if (!done && score >= target) {                    // score ≥ target(L) 即通关
        done = true; game.win(score, { s2: Math.ceil(target * 1.2), s3: Math.ceil(target * 1.5) });
        return;
      }
      if (pieces.every(p => p === null)) dealRound();    // 三块放完 → 下一轮
      checkDeadlock();
    }
    /* 拖拽热区（§5.5 ≥44px）：三个块槽 */
    const trayY = boardY + N * CELL + 14;
    const slotW = (area.w - 24) / 3;
    function slotRect(i) { return { x: 12 + i * slotW, y: trayY + 6, w: slotW - 8, h: area.y + area.h - trayY - 14 }; }
    /** 棋盘底+已填格+障碍（oy=层内 0 偏移 / 直绘 area.y；静态层一次成图） */
    function drawBoard(g, oy) {
      g.fillStyle = '#151b2e'; roundRect(g, boardX - 5, boardY - oy - 5, N * CELL + 10, N * CELL + 10, 10); g.fill();
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const v = grid[r * N + c];
        g.fillStyle = v === 0 ? '#1a2133' : v === 2 ? '#5b6478' : '#2c3a5c';
        roundRect(g, boardX + c * CELL + 1, boardY - oy + r * CELL + 1, CELL - 2, CELL - 2, 3); g.fill();
        if (v === 1) {
          g.fillStyle = '#3a4a6e';
          roundRect(g, boardX + c * CELL + 4, boardY - oy + r * CELL + 4, CELL - 8, CELL - 8, 2); g.fill();
        }
      }
    }
    function drawPiece(g, cells, ox, oy, cell, valid) {
      g.fillStyle = valid === false ? '#5b6478' : colorOf(cells);
      for (const [dx, dy] of cells) roundRect(g, ox + dx * cell + 1, oy + dy * cell + 1, cell - 2, cell - 2, 3), g.fill();
    }
    function ghostAnchor() {
      if (!drag) return null;
      const cells = pieces[drag.idx].cells;
      let w = 0, h = 0;
      for (const [dx, dy] of cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1); }
      const cx = drag.x - w * CELL / 2, cy = drag.y - 24 - h * CELL / 2;   // 块体中心随指、锚定于指上 24px
      const c = Math.round((cx - boardX) / CELL), r = Math.round((cy - boardY) / CELL);
      return { r, c, w, h, ok: canPlace(cells, r, c) };
    }

    /* HUD 源头脏检查（§7.2.A.4）：值变才 setHud（分/换为事件级变化） */
    let hudS = -1, hudR = -1;

    return {
      startLevel() { game.setHud([{ t: '分', v: 0 }, { t: `/${target}`, v: 0 }, { t: '换', v: refreshLeft }]); },
      update(dt) {
        for (const p of pops) p.t -= dt;
        pops = pops.filter(p => p.t > 0);
        for (const f of clearFx) f.t -= dt;
        clearFx = clearFx.filter(f => f.t > 0);
        if (score !== hudS || refreshLeft !== hudR) {
          hudS = score; hudR = refreshLeft;
          game.setHud([{ t: '分', v: score }, { t: `/${target}`, v: Math.min(score, target) }, { t: '换', v: refreshLeft }]);
        }
      },
      onDown(x, y) {
        if (done) return;
        for (let i = 0; i < pieces.length; i++) {
          if (!pieces[i]) continue;
          const s = slotRect(i);
          if (x >= s.x - 6 && x <= s.x + s.w + 6 && y >= s.y && y <= s.y + s.h) { drag = { idx: i, x, y }; return; }
        }
      },
      onMove(x, y) { if (drag) { drag.x = x; drag.y = y; } },
      onUp() {
        if (!drag) return;
        const a = ghostAnchor();
        if (a && a.ok) placeAt(drag.idx, a.r, a.c);
        else if (a) game.toast('放不下这里');
        drag = null;
      },
      render(g) {
        /* 棋盘：§7.2.A.1 静态层 blit（放置/消格才重绘；vm 桩回退直绘） */
        const layer = staticLayer();
        if (layer.cvs) g.drawImage(layer.cvs, 0, area.y, area.w, area.h);
        else drawBoard(g, area.y);
        /* 目标进度线 */
        const pr = clamp(score / target, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, boardY - 12, area.w - 40, 3);
        g.fillStyle = '#7bd88f'; g.fillRect(20, boardY - 12, (area.w - 40) * pr, 3);
        /* 块槽 */
        for (let i = 0; i < pieces.length; i++) {
          const p = pieces[i];
          const s = slotRect(i);
          g.fillStyle = '#151b2e'; roundRect(g, s.x, s.y, s.w, s.h, 10); g.fill();
          if (!p) continue;
          let w = 0, h = 0;
          for (const [dx, dy] of p.cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1); }
          const sc = Math.min(16, Math.min((s.w - 20) / w, (s.h - 20) / h));  // 槽内缩略
          drawPiece(g, p.cells, s.x + (s.w - w * sc) / 2, s.y + (s.h - h * sc) / 2, sc, null);
        }
        /* 拖拽中的块 + 吸附幽灵 */
        if (drag && pieces[drag.idx]) {
          const a = ghostAnchor();
          if (a && a.r >= -1 && a.c >= -1 && a.r < N && a.c < N) {
            const cells = pieces[drag.idx].cells;
            g.globalAlpha = a.ok ? 0.55 : 0.3;
            drawPiece(g, cells, boardX + a.c * CELL, boardY + a.r * CELL, CELL, a.ok);
            g.globalAlpha = 1;
          }
          const cells = pieces[drag.idx].cells;
          let w = 0, h = 0;
          for (const [dx, dy] of cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1); }
          drawPiece(g, cells, drag.x - w * CELL / 2, drag.y - 48 - h * CELL / 2, CELL, null);  // 指上 48px 保可见（§26）
        }
        for (const f of clearFx) {
          g.globalAlpha = clamp(f.t * 2.5, 0, 1) * 0.8;
          g.fillStyle = '#ffd166'; g.beginPath(); g.arc(f.x, f.y, 4 + (0.4 - f.t) * 26, 0, 7); g.fill();
          g.globalAlpha = 1;
        }
        for (const p of pops) {
          g.globalAlpha = clamp(p.t * 2.5, 0, 1);
          g.fillStyle = '#9fc0ff'; g.font = FONT(12, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(p.text, p.x, p.y - (0.4 - p.t) * 24);
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          target, pent: +pent.toFixed(3), score, done, refreshLeft,
          grid: grid.slice(),
          pieces: pieces.map(p => p ? p.cells.map(c => c.join(',')).join('|') : null),
        };
      },
    };
  };
})();
