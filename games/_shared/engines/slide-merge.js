'use strict';
/* =====================================================================
 * 滑动合并引擎（spec §12，2048 式）：四方向滑动，同数字块碰撞合并；
 * 盘面出现 ≥ target(L) 的块即通关；无可合并且 rescue 耗尽即失败。
 * target(L) = min(targetCap, 64 × 2^floor((L−1)/5))（每 5 关翻倍，封顶档位）。
 * score = Σ每次合成产生块的面值；s2 = target×2，s3 = target×3。
 * ===================================================================== */
const SlideMergeEngine = (function () {
  const TILE_BG = { 2: '#3d4b6e', 4: '#4a5a83', 8: '#5a6f9e', 16: '#6ea8ff', 32: '#7bd88f', 64: '#ffd166', 128: '#ff9f43', 256: '#ff8fa3', 512: '#b56cff', 1024: '#4dd0e1', 2048: '#f2789f', 4096: '#9fffcb' };
  const targetOf = (t, L) => Math.min(t.targetCap, 64 * Math.pow(2, Math.floor((L - 1) / 5)));

  return function (game) {
    const { cfg, rng } = game;
    const t = Object.assign({ gridLen: 4, targetCap: 1024, spawn4Rate: 0.10, rescue: 3 }, cfg.typeExtra);
    const N = t.gridLen;
    const area = game.area;
    const bw = Math.floor(area.w * 0.92), cell = Math.floor((bw - (N + 1) * 8) / N);
    const bx = Math.floor((area.w - (cell * N + (N + 1) * 8)) / 2), by = area.y + 120;
    let grid, score, target, rescue, over, won;
    let pop = new Map();      // 合成/新块弹出动画 {idx: t}
    let down = null;

    const idx = (r, c) => r * N + c;
    function spawn() {
      const empties = [];
      for (let i = 0; i < N * N; i++) if (!grid[i]) empties.push(i);
      if (!empties.length) return;
      const i = empties[(rng() * empties.length) | 0];
      grid[i] = rng() < t.spawn4Rate ? 4 : 2;
      pop.set(i, 1);
    }
    /* 一行向左压实+合并（2048 规则：每块每次移动至多参与一次合并） */
    function slideRow(row) {
      const a = row.filter(v => v);
      const out = [];
      for (let i = 0; i < a.length; i++) {
        if (i + 1 < a.length && a[i] === a[i + 1]) { out.push(a[i] * 2); score += a[i] * 2; i++; }
        else out.push(a[i]);
      }
      while (out.length < N) out.push(0);
      return out;
    }
    function move(dir) {
      const before = grid.slice();
      for (let k = 0; k < N; k++) {
        let line = [];
        for (let j = 0; j < N; j++) line.push(dir === 'l' || dir === 'r' ? grid[idx(k, j)] : grid[idx(j, k)]);
        if (dir === 'r' || dir === 'd') line.reverse();
        const out = slideRow(line);
        if (dir === 'r' || dir === 'd') out.reverse();
        for (let j = 0; j < N; j++) {
          const i = dir === 'l' || dir === 'r' ? idx(k, j) : idx(j, k);
          if (grid[i] !== out[j]) pop.set(i, 1);
          grid[i] = out[j];
        }
      }
      return grid.some((v, i) => v !== before[i]);
    }
    function canMove() {
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const v = grid[idx(r, c)];
        if (!v) return true;
        if (c + 1 < N && grid[idx(r, c + 1)] === v) return true;
        if (r + 1 < N && grid[idx(r + 1, c)] === v) return true;
      }
      return false;
    }
    function reshuffle() {    // 死局重洗：保留面值集合，重布位置（消费 rescue，rng 驱动）
      const vals = grid.filter(v => v);
      for (let attempt = 0; attempt < 60; attempt++) {
        grid.fill(0);
        const order = vals.slice();
        for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
        const cells = [];
        for (let i = 0; i < N * N; i++) cells.push(i);
        for (let i = cells.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp; }
        for (let i = 0; i < order.length; i++) grid[cells[i]] = order[i];
        if (canMove()) return true;
      }
      return false;
    }
    const hud = () => [{ t: '分数', v: score }, { t: '重洗', v: rescue }];

    return {
      startLevel() {
        grid = new Array(N * N).fill(0);
        score = 0; rescue = t.rescue; over = false; won = false; pop = new Map();
        target = targetOf(t, game.level);
        spawn(); spawn();
        game.setHud(hud());
      },
      update(dt) { for (const [k, v] of pop) { const nv = v - dt * 4; nv <= 0 ? pop.delete(k) : pop.set(k, nv); } },
      render(g) {
        /* 目标块提示 */
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = '#8b94a7'; g.font = G.FONT(13, 500);
        g.fillText('合成目标块', area.w / 2, by - 78);
        const tRad = 30;
        g.fillStyle = TILE_BG[target] || '#6ea8ff';
        G.roundRect(g, area.w / 2 - tRad, by - 64, tRad * 2, tRad * 2, 10); g.fill();
        g.fillStyle = '#101522'; g.font = G.FONT(target >= 1024 ? 15 : 18, 800);
        g.fillText('' + target, area.w / 2, by - 64 + tRad);
        /* 棋盘 */
        const bs = cell * N + (N + 1) * 8;
        g.fillStyle = '#1a2133'; G.roundRect(g, bx, by, bs, bs, 14); g.fill();
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          const i = idx(r, c), x = bx + 8 + c * (cell + 8), y = by + 8 + r * (cell + 8);
          g.fillStyle = '#151b2b'; G.roundRect(g, x, y, cell, cell, 10); g.fill();
          const v = grid[i];
          if (!v) continue;
          const p = pop.has(i) ? 1 + 0.18 * pop.get(i) : 1;    // 弹出动画
          const s = cell * p / 2, cx = x + cell / 2, cy = y + cell / 2;
          g.fillStyle = TILE_BG[v] || '#9fffcb';
          G.roundRect(g, cx - s, cy - s, s * 2, s * 2, 10); g.fill();
          g.fillStyle = v <= 4 ? '#c8d3e8' : '#101522';
          g.font = G.FONT(v >= 1024 ? cell * .3 : v >= 128 ? cell * .36 : cell * .42, 800);
          g.fillText('' + v, cx, cy + 1);
        }
        g.fillStyle = '#5b6478'; g.font = G.FONT(11, 400); g.textAlign = 'left';
        g.fillText('滑动合并相同数字', bx, by + bs + 22);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) {
        if (!down || over) { down = null; return; }
        const dir = G.swipeDir(x - down.x, y - down.y);
        down = null;
        if (!dir) return;
        if (!move(dir)) { game.toast('无处可滑'); return; }   // 无效滑动不补块
        spawn();
        game.setHud(hud());
        if (grid.some(v => v >= target)) { over = true; game.win(score, { s2: target * 2, s3: target * 3 }); return; }
        if (!canMove()) {
          if (rescue > 0) {
            rescue--;
            if (reshuffle()) { game.toast(`死局！自动重洗（剩 ${rescue} 次）`); game.setHud(hud()); }
            else { over = true; game.lose(score); }
          } else { over = true; game.lose(score); }
        }
      },
      __state: () => ({ grid: grid.slice(), score, target, rescue, N }),
    };
  };
})();
