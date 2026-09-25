'use strict';
/* =====================================================================
 * 方块下落引擎（spec §25）：10×20 井，七种四格块 7-bag 序列（seed 洗牌），
 * 填满整行消除，消行数达标即胜；新块无处生成（堆顶）即败。
 * 曲线：drop(L)=max(120, round(dropMs×(1−0.50p)))；garbage(L)=round(garbageBase×p)；
 *       lines(L)=ceil((10+15p)×linesFactor)。p=(L−1)/(Ln−1)。
 * 生成（§25）：每 7 块一袋洗牌（公平分布）；关底预置垃圾行 1–2 洞位由 seed 决定。
 * 计分：score=消行×100+双消×300+三消×500+四消×800（按次计）；s2=150×lines(L)，s3=220×lines(L)。
 * 交互（§25 竖屏单手映射）：左右滑/横拖=移动（每格），上滑/点按=旋转，下滑=软降一格，
 *   快速下滑（fling，单次事件下移 >44px）=硬降；井居中占屏宽 60%。
 * ===================================================================== */
const BlockDropEngine = (function () {
  const COLS = 10, ROWS = 20, CELL = 22;
  const COLORS = ['', '#9fc0ff', '#ffd166', '#c792ea', '#7bd88f', '#ff8fa3', '#6ed0e0', '#ff9f6e', '#5b6478'];
  const SHAPES = [
    [[1, 1, 1, 1]],           // I
    [[1, 1], [1, 1]],         // O
    [[0, 1, 0], [1, 1, 1]],   // T
    [[1, 0, 0], [1, 1, 1]],   // J
    [[0, 0, 1], [1, 1, 1]],   // L
    [[1, 1, 0], [0, 1, 1]],   // S
    [[0, 1, 1], [1, 1, 0]],   // Z
  ];
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ dropMs: 800, wellW: 10, garbageBase: 4, nextN: 3, linesFactor: 1.0 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const drop = Math.max(120, Math.round(t.dropMs * (1 - 0.50 * p)));
    const garbage = Math.round(t.garbageBase * p);
    const linesTarget = Math.ceil((10 + 15 * p) * t.linesFactor);

    /* --- 井 + 关底垃圾行（1–2 洞位由 seed 掷点，§25） --- */
    const grid = [];
    for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(0));
    for (let i = 0; i < garbage; i++) {
      const row = ROWS - 1 - i;
      const holes = rng() < 0.5 ? 1 : 2;
      const c1 = Math.floor(rng() * COLS);
      let c2 = -1;
      if (holes === 2) c2 = (c1 + 1 + Math.floor(rng() * (COLS - 1))) % COLS;
      for (let c = 0; c < COLS; c++) if (c !== c1 && c !== c2) grid[row][c] = 8;
    }

    /* --- 7-bag（seed 洗牌；袋耗尽即重洗，取序确定 ⇒ 序列可复现） --- */
    let bag = [];
    function nextKind() {
      if (!bag.length) {
        bag = [0, 1, 2, 3, 4, 5, 6];
        for (let i = 6; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp; }
      }
      return bag.pop();
    }
    const queue = [];
    while (queue.length < t.nextN + 1) queue.push(nextKind());

    /* --- 当前块 --- */
    let piece = null, dropT = 0, lockT = 0, onFloor = false;
    let lines = 0, score = 0, done = false, flashRows = [];
    let ptr = null;

    function fits(cells, x, y) {
      for (let i = 0; i < cells.length; i++) for (let j = 0; j < cells[i].length; j++) {
        if (!cells[i][j]) continue;
        const cx = x + j, cy = y + i;
        if (cx < 0 || cx >= COLS || cy >= ROWS) return false;
        if (cy >= 0 && grid[cy][cx]) return false;
      }
      return true;
    }
    function spawn() {
      const k = queue.shift();
      queue.push(nextKind());
      const cells = SHAPES[k].map(r => r.slice());
      const x = Math.floor((COLS - cells[0].length) / 2);
      piece = { k, cells, x, y: 0 };
      dropT = 0; lockT = 0; onFloor = false;
      if (!fits(cells, x, 0)) { done = true; game.lose(score); }   // 堆顶：新块无处生成（§25）
    }
    function tryMove(dx, dy) {
      if (!piece || done) return false;
      if (!fits(piece.cells, piece.x + dx, piece.y + dy)) return false;
      piece.x += dx; piece.y += dy;
      if (dy > 0) { dropT = 0; }
      lockT = 0;
      return true;
    }
    function rotate() {
      if (!piece || done) return;
      const c = piece.cells, h = c.length, w = c[0].length;
      const r = [];
      for (let j = 0; j < w; j++) { r.push([]); for (let i = h - 1; i >= 0; i--) r[j].push(c[i][j]); }
      for (const k of [0, -1, 1, -2, 2]) {                 // 简化踢墙
        if (fits(r, piece.x + k, piece.y)) { piece.cells = r; piece.x += k; lockT = 0; return; }
      }
    }
    function ghostY() {
      let y = piece.y;
      while (fits(piece.cells, piece.x, y + 1)) y++;
      return y;
    }
    function hardDrop() {
      if (!piece || done) return;
      piece.y = ghostY();
      lock();
    }
    function lock() {
      for (let i = 0; i < piece.cells.length; i++) for (let j = 0; j < piece.cells[i].length; j++) {
        if (!piece.cells[i][j]) continue;
        const cy = piece.y + i;
        if (cy < 0) { done = true; game.lose(score); return; }     // 锁定越顶=堆顶败
        grid[cy][piece.x + j] = piece.k + 1;
      }
      const keep = [];
      for (let r = 0; r < ROWS; r++) (grid[r].every(v => v) ? flashRows.push(r) : keep.push(grid[r]));
      const cleared = flashRows.length;
      for (let i = 0; i < cleared; i++) keep.unshift(new Array(COLS).fill(0));
      for (let r = 0; r < ROWS; r++) grid[r] = keep[r];
      if (cleared) {
        lines += cleared;
        score += [0, 100, 300, 500, 800][Math.min(4, cleared)];    // 按次计（§25 计分）
      }
      piece = null;
      if (lines >= linesTarget) { done = true; game.win(score, { s2: 150 * linesTarget, s3: 220 * linesTarget }); return; }
      spawn();
    }

    function step() {
      if (done) return;
      if (!piece) return;
      dropT += STEP * 1000;
      if (dropT >= drop) {
        dropT = 0;
        if (!tryMove(0, 1)) onFloor = true;
      }
      if (onFloor) {
        if (fits(piece.cells, piece.x, piece.y + 1)) { onFloor = false; }
        else {
          lockT += STEP;
          if (lockT >= 0.55) lock();
        }
      }
    }

    spawn();

    return {
      startLevel() { game.setHud([{ t: `/${linesTarget}行`, v: 0 }, { t: '分', v: 0 }, { t: '下块', v: queue.length }]); },
      update(dt) {
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        if (flashRows.length) flashRows = [];
        game.setHud([
          { t: `/${linesTarget}行`, v: lines },
          { t: '分', v: score },
          { t: '垃圾', v: garbage },
        ]);
      },
      onDown(x, y) { ptr = { x, y, lx: x, ly: y, accX: 0, dispX: 0, dispY: 0 }; },
      onMove(x, y) {
        if (!ptr || done || !piece) return;
        const dx = x - ptr.lx, dy = y - ptr.ly;
        ptr.lx = x; ptr.ly = y;
        ptr.dispX += dx; ptr.dispY += dy;
        ptr.accX += dx;
        while (ptr.accX >= CELL) { tryMove(1, 0); ptr.accX -= CELL; }     // 横拖：每格移动
        while (ptr.accX <= -CELL) { tryMove(-1, 0); ptr.accX += CELL; }
        if (dy > 44) { hardDrop(); ptr = null; return; }                  // 快速下滑=硬降（fling）
        if (dy > 0) {
          ptr.accY = (ptr.accY || 0) + dy;
          while (ptr.accY >= CELL * 1.2) { tryMove(0, 1); ptr.accY -= CELL * 1.2; }   // 下拖=软降
        }
      },
      onUp(x, y) {
        if (!ptr || done || !piece) { ptr = null; return; }
        const dx = ptr.dispX, dy = ptr.dispY;
        ptr = null;
        if (Math.abs(dx) < 24 && Math.abs(dy) < 24) { rotate(); return; } // 点按=旋转（备选，§25）
        if (dy < -24 && Math.abs(dy) >= Math.abs(dx)) { rotate(); return; }   // 上滑=旋转
        if (dy > 24 && Math.abs(dy) >= Math.abs(dx)) { tryMove(0, 1); return; } // 下滑=软降一格
        if (Math.abs(dx) >= 24) tryMove(dx > 0 ? 1 : -1, 0);              // 短横滑=移一格
      },
      render(g) {
        const wx = (area.w - COLS * CELL) / 2, wy = area.y + 26;
        /* 井框 */
        g.fillStyle = '#141a2b'; g.fillRect(wx - 5, wy - 5, COLS * CELL + 10, ROWS * CELL + 10);
        g.strokeStyle = '#2c3a5c'; g.lineWidth = 2; g.strokeRect(wx - 5, wy - 5, COLS * CELL + 10, ROWS * CELL + 10);
        /* 已落格 */
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
          const v = grid[r][c];
          if (!v) continue;
          g.fillStyle = COLORS[v];
          G.roundRect(g, wx + c * CELL + 1, wy + r * CELL + 1, CELL - 2, CELL - 2, 3); g.fill();
        }
        if (piece && !done) {
          /* 落点投影 */
          const gy = ghostY();
          g.globalAlpha = 0.22;
          g.fillStyle = COLORS[piece.k + 1];
          for (let i = 0; i < piece.cells.length; i++) for (let j = 0; j < piece.cells[i].length; j++) {
            if (!piece.cells[i][j]) continue;
            const cy = gy + i;
            if (cy >= 0) G.roundRect(g, wx + (piece.x + j) * CELL + 1, wy + cy * CELL + 1, CELL - 2, CELL - 2, 3), g.fill();
          }
          g.globalAlpha = 1;
          /* 当前块（越顶行画在井上方半透明） */
          g.fillStyle = COLORS[piece.k + 1];
          for (let i = 0; i < piece.cells.length; i++) for (let j = 0; j < piece.cells[i].length; j++) {
            if (!piece.cells[i][j]) continue;
            const cy = piece.y + i;
            g.globalAlpha = cy < 0 ? 0.45 : 1;
            G.roundRect(g, wx + (piece.x + j) * CELL + 1, wy + cy * CELL + 1, CELL - 2, CELL - 2, 3); g.fill();
          }
          g.globalAlpha = 1;
        }
        /* next 预览（屏下拇指区上方，资源 nextN 块） */
        g.fillStyle = '#8b94a7'; g.font = G.FONT(11, 500); g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText('NEXT', wx, wy + ROWS * CELL + 24);
        for (let q = 0; q < Math.min(t.nextN, queue.length); q++) {
          const cells = SHAPES[queue[q]];
          const ox = wx + 52 + q * 56, oy = wy + ROWS * CELL + 14;
          g.fillStyle = COLORS[queue[q] + 1];
          for (let i = 0; i < cells.length; i++) for (let j = 0; j < cells[i].length; j++) {
            if (!cells[i][j]) continue;
            G.roundRect(g, ox + j * 11, oy + i * 11, 10, 10, 2); g.fill();
          }
        }
      },
      __state() {
        return {
          drop, garbage, linesTarget, nextN: t.nextN, lines, score, done,
          grid: grid.map(r => r.join('')).join('|'),
          piece: piece && { k: piece.k, x: piece.x, y: piece.y, cells: piece.cells.map(r => r.join('')).join('/') },
          queue: queue.join(','), bag: bag.join(''),
          lockT: +lockT.toFixed(3), onFloor,
        };
      },
    };
  };
})();
