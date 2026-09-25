'use strict';
/* =====================================================================
 * 三消引擎（spec §11）：8×8，滑向即与邻位交换，≥3 同色横竖连消除，
 * 步数内冲目标分。4 连条纹（清行/列）、L/T 或 ≥5 连炸弹（3×3）。
 * 计分：消除块数×10 + 条纹触发×50 + 炸弹触发×100；连锁段内每级 ×1.5（cap=cascadeCap 级）。
 * ===================================================================== */
const Match3Engine = (function () {
  const PAL = ['#ff8fa3', '#ffd166', '#7bd88f', '#6ea8ff', '#b56cff', '#ff9f43', '#4dd0e1'];
  const SHAPES = ['circle', 'square', 'tri', 'diamond', 'star', 'ring', 'cross'];

  /* 曲线（§11；档位数值由 game.json typeExtra 落值） */
  const targetOf = (t, L, n) => Math.ceil(t.targetScore * (1 + 0.15 * (L - 1) / (n - 1)));
  const movesOf = (t, L, n) => Math.max(12, Math.round(t.movesBase * (1 - 0.10 * (L - 1) / (n - 1))));
  const blockerOf = (t, L, n) => Math.min(0.15, t.blockerRate * (1 + 0.3 * (L - 1) / (n - 1)));

  return function (game) {
    const { cfg, rng } = game;
    const t = Object.assign({ gridN: 8, colors: 5, movesBase: 25, targetScore: 2000, blockerRate: 0.05, cascadeCap: 5 }, cfg.typeExtra);
    const N = t.gridN, C = Math.min(t.colors, PAL.length);
    const area = game.area;
    const cell = Math.floor(Math.min(area.w * 0.94, 380) / N);
    const bw = cell * N, bx = (area.w - bw) / 2, by = area.y + 54;

    let grid, ice, target, movesLeft, score, over = false;
    let sel = null, down = null;
    let fx = [];            // 消除闪光特效 {x,y,t,color}
    let wave = 0;           // 连锁级数（0 = 首次消除）
    let waveTimer = 0;      // 波间节奏计时（视觉）
    let pending = false;    // 有待处理的连锁
    let fallOff = new Float32Array(N * N); // 下落动画偏移（视觉）

    /* ---------- 生成：①无现成 ≥3 连 ②至少 1 步可消除（否则整体重掷） ---------- */
    function genBoard() {
      for (let attempt = 0; ; attempt++) {
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          let v;
          do { v = (rng() * C) | 0; }
          while ((c >= 2 && grid[r * N + c - 1] === v && grid[r * N + c - 2] === v) ||
                 (r >= 2 && grid[(r - 1) * N + c] === v && grid[(r - 2) * N + c] === v));
          grid[r * N + c] = v;
        }
        ice.fill(0);
        const k = Math.round(N * N * blockerOf(t, game.level, cfg.levels));
        let placed = 0, guard = 0;
        while (placed < k && guard++ < N * N * 4) {
          const i = (rng() * N * N) | 0;
          if (!ice[i] && (i / N | 0) > 0) { ice[i] = 1; placed++; }   // 顶行不冻结，保证可从上方补位
        }
        if (hasValidSwap()) return;
      }
    }
    function matchAtOnce(r, c) {  // 该格是否处于 ≥3 连中（冻结格不参与匹配）
      const v = grid[r * N + c];
      if (v < 0 || ice[r * N + c]) return false;
      let h = 1; for (let i = c - 1; i >= 0 && grid[r * N + i] === v && !ice[r * N + i]; i--) h++;
      for (let i = c + 1; i < N && grid[r * N + i] === v && !ice[r * N + i]; i++) h++;
      if (h >= 3) return true;
      let s = 1; for (let i = r - 1; i >= 0 && grid[i * N + c] === v && !ice[i * N + c]; i--) s++;
      for (let i = r + 1; i < N && grid[i * N + c] === v && !ice[i * N + c]; i++) s++;
      return s >= 3;
    }
    function hasValidSwap() {
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        for (const [dr, dc] of [[0, 1], [1, 0]]) {
          const r2 = r + dr, c2 = c + dc;
          if (r2 >= N || c2 >= N) continue;
          const i = r * N + c, j = r2 * N + c2;
          if (ice[i] || ice[j]) continue;
          const tmp = grid[i]; grid[i] = grid[j]; grid[j] = tmp;
          const ok = matchAtOnce(r, c) || matchAtOnce(r2, c2);
          grid[j] = grid[i]; grid[i] = tmp;
          if (ok) return true;
        }
      }
      return false;
    }

    /* ---------- 消除求解：横竖 run → 分组；4 连条纹、L/T 或 ≥5 炸弹 ---------- */
    function findGroups() {
      const runs = [];
      for (let r = 0; r < N; r++) {   // 横向 run
        let c = 0;
        while (c < N) {
          const v = grid[r * N + c];
          if (v < 0 || ice[r * N + c]) { c++; continue; }
          let e = c + 1; while (e < N && grid[r * N + e] === v && !ice[r * N + e]) e++;
          if (e - c >= 3) runs.push({ cells: range(r, c, 0, e - c), dir: 'h' });
          c = e;
        }
      }
      for (let c = 0; c < N; c++) {   // 纵向 run
        let r = 0;
        while (r < N) {
          const v = grid[r * N + c];
          if (v < 0 || ice[r * N + c]) { r++; continue; }
          let e = r + 1; while (e < N && grid[e * N + c] === v && !ice[e * N + c]) e++;
          if (e - r >= 3) runs.push({ cells: range(r, c, e - r, 0), dir: 'v' });
          r = e;
        }
      }
      /* run 合并为分组（共享格即同组） */
      const groups = [];
      const owner = new Map();
      for (const run of runs) {
        let grp = null;
        for (const i of run.cells) if (owner.has(i)) { grp = owner.get(i); break; }
        if (!grp) { grp = { cells: new Set(), hasH: false, hasV: false }; groups.push(grp); }
        for (const i of run.cells) { grp.cells.add(i); owner.set(i, grp); }
        grp[run.dir === 'h' ? 'hasH' : 'hasV'] = true;
      }
      return groups;
    }
    function range(r, c, h, w) {
      const a = [];
      for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) a.push((r + i) * N + (c + j));
      return a;
    }

    /* ---------- 一波消除（同步结算逻辑；特效/下落为视觉层） ---------- */
    function resolveWave() {
      const groups = findGroups();
      if (!groups.length) return false;
      const mult = Math.pow(1.5, Math.min(wave, t.cascadeCap));   // 连锁倍率：每级 ×1.5，封 cascadeCap 级
      const clearSet = new Set();
      let gems = 0, stripe = 0, bomb = 0;
      const specials = [];
      for (const grp of groups) {
        const size = grp.cells.size;
        if (size >= 5 || (grp.hasH && grp.hasV)) { bomb++; specials.push({ i: anchor(grp), kind: 'bomb' }); }
        else if (size === 4) { stripe++; specials.push({ i: anchor(grp), kind: grp.hasH ? 'stripe-h' : 'stripe-v' }); }
        for (const i of grp.cells) clearSet.add(i);
      }
      /* 特效触发：条纹清行/列（+50）、炸弹清 3×3（+100）；被波及的特殊格连锁触发 */
      const visited = new Set();
      const queue = specials.slice();
      while (queue.length) {
        const s = queue.shift();
        if (visited.has(s.i)) continue;
        visited.add(s.i);
        let hit = [];
        if (s.kind === 'stripe-h') { const r = s.i / N | 0; hit = range(r, 0, 1, N); }
        else if (s.kind === 'stripe-v') { const c = s.i % N; hit = range(0, c, N, 1); }
        else if (s.kind === 'bomb') { const r = s.i / N | 0, c = s.i % N; hit = range(Math.max(0, r - 1), Math.max(0, c - 1), Math.min(3, N - r + 1), Math.min(3, N - c + 1)); }
        for (const i of hit) {
          if (grid[i] < 0) continue;
          clearSet.add(i);
          if (i !== s.i && specials.some(sp => sp.i === i && !visited.has(i))) queue.push(specials.find(sp => sp.i === i));
        }
      }
      /* 结算清除 + 相邻匹配破冰 */
      for (const i of clearSet) {
        if (grid[i] < 0) continue;
        if (!ice[i]) gems++;
        fx.push({ x: bx + (i % N) * cell + cell / 2, y: by + (i / N | 0) * cell + cell / 2, t: 1, color: PAL[grid[i]] });
        grid[i] = -1;
      }
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const i = r * N + c;
        if (ice[i] && grid[i] >= 0) {
          const nb = [[0, 1], [0, -1], [1, 0], [-1, 0]];
          for (const [dr, dc] of nb) {
            const j = (r + dr) * N + (c + dc);
            if (r + dr >= 0 && r + dr < N && c + dc >= 0 && c + dc < N && clearSet.has(j)) { ice[i] = 0; break; }
          }
        }
      }
      score += Math.round((gems * 10 + stripe * 50 + bomb * 100) * mult);
      gravityRefill();
      wave++;
      return true;
    }
    function anchor(grp) {          // 特殊格锚点：组内最后格（视觉近似组心即可）
      let last = -1; for (const i of grp.cells) if (i > last) last = i;
      return last;
    }
    function gravityRefill() {
      for (let c = 0; c < N; c++) {
        let w = N - 1;
        for (let r = N - 1; r >= 0; r--) {          // 压实
          const i = r * N + c;
          if (grid[i] >= 0) { const v = grid[i], f = ice[i]; grid[i] = -1; ice[i] = 0; grid[w * N + c] = v; ice[w * N + c] = f; fallOff[w * N + c] = (w - r) * cell; w--; }
        }
        for (let r = w; r >= 0; r--) { grid[r * N + c] = (rng() * C) | 0; ice[r * N + c] = 0; fallOff[r * N + c] = (w + 1) * cell; }
      }
    }

    /* ---------- 输入：滑向即交换 ---------- */
    function trySwap(r1, c1, r2, c2) {
      const i = r1 * N + c1, j = r2 * N + c2;
      if (r2 < 0 || r2 >= N || c2 < 0 || c2 >= N || ice[i] || ice[j]) { game.toast('无法交换'); return; }
      const tmp = grid[i]; grid[i] = grid[j]; grid[j] = tmp;
      const ti = ice[i]; ice[i] = ice[j]; ice[j] = ti;
      if (matchAtOnce(r1, c1) || matchAtOnce(r2, c2)) {
        movesLeft--; wave = 0; pending = true; waveTimer = 0.05;
        game.setHud(hud()); fx.push({ x: bx + c2 * cell + cell / 2, y: by + r2 * cell + cell / 2, t: .5, color: '#fff' });
      } else {
        const tm2 = grid[i]; grid[i] = grid[j]; grid[j] = tm2;
        const ti2 = ice[i]; ice[i] = ice[j]; ice[j] = ti2;
        game.toast('换不动');
      }
    }
    const hud = () => [{ t: '分数', v: score }, { t: '步数', v: movesLeft }];

    const api = {
      startLevel() {
        grid = new Int8Array(N * N); ice = new Uint8Array(N * N); fallOff = new Float32Array(N * N);
        target = targetOf(t, game.level, cfg.levels);
        movesLeft = movesOf(t, game.level, cfg.levels);
        score = 0; over = false; wave = 0; pending = false; fx = []; sel = null;
        genBoard();
        game.setHud(hud());
      },
      update(dt) {
        for (const f of fx) f.t -= dt * 3;
        fx = fx.filter(f => f.t > 0);
        for (let i = 0; i < N * N; i++) if (fallOff[i] > 0) fallOff[i] = Math.max(0, fallOff[i] - dt * 900);
        if (pending) {
          waveTimer -= dt;
          if (waveTimer <= 0) {
            const had = resolveWave();
            game.setHud(hud());
            if (score >= target) { over = true; game.win(score, { s2: target * 1.2, s3: target * 1.5 }); return; }
            if (!had) {
              pending = false;
              if (movesLeft <= 0 && score < target) { over = true; game.lose(score); }
              else if (!hasValidSwap()) { genBoard(); game.toast('无可消步，重排'); }   // 死盘重掷（消费 rng，确定性成立）
            } else waveTimer = 0.28;
          }
        }
      },
      render(g) {
        /* 目标进度条（顶） */
        const pw = area.w - 24, px = 12, py = area.y + 10, ph = 14;
        g.fillStyle = '#1a2133'; G.roundRect(g, px, py, pw, ph, 7); g.fill();
        g.fillStyle = score >= target ? '#7bd88f' : '#6ea8ff';
        G.roundRect(g, px + 2, py + 2, Math.max(4, (pw - 4) * G.clamp(score / target, 0, 1)), ph - 4, 5); g.fill();
        g.fillStyle = '#8b94a7'; g.font = G.FONT(11, 500); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`${score} / ${target}`, area.w / 2, py + ph / 2 + .5);
        /* 棋盘 */
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          const i = r * N + c, x = bx + c * cell, y = by + r * cell + fallOff[i];
          g.fillStyle = (r + c) % 2 ? '#161e31' : '#131927';
          g.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          if (grid[i] < 0) continue;
          drawGem(g, x + cell / 2, y + cell / 2, cell * .36, grid[i]);
          if (sel && sel.r === r && sel.c === c) { g.strokeStyle = '#ffd166'; g.lineWidth = 3; G.roundRect(g, x + 2, y + 2, cell - 4, cell - 4, 8); g.stroke(); }
          if (ice[i]) {
            g.fillStyle = 'rgba(180,220,255,.28)'; G.roundRect(g, x + 2, y + 2, cell - 4, cell - 4, 8); g.fill();
            g.strokeStyle = 'rgba(200,235,255,.55)'; g.lineWidth = 1.5; G.roundRect(g, x + 2, y + 2, cell - 4, cell - 4, 8); g.stroke();
          }
        }
        /* 消除闪光 */
        for (const f of fx) {
          g.globalAlpha = G.clamp(f.t, 0, 1);
          g.fillStyle = f.color;
          g.beginPath(); g.arc(f.x, f.y, cell * .3 + (1 - f.t) * cell * .5, 0, 7); g.fill();
          g.globalAlpha = 1;
        }
      },
      onDown(x, y) {
        down = { x, y };
        const c = Math.floor((x - bx) / cell), r = Math.floor((y - by) / cell);
        sel = (r >= 0 && r < N && c >= 0 && c < N) ? { r, c } : null;
      },
      onMove() { },
      onUp(x, y) {
        if (!down || !sel || over || pending) { down = null; return; }
        const dir = G.swipeDir(x - down.x, y - down.y);
        down = null;
        if (!dir) return;                     // 原地点按 = 仅选中
        const d = { l: [0, -1], r: [0, 1], u: [-1, 0], d: [1, 0] }[dir];
        trySwap(sel.r, sel.c, sel.r + d[0], sel.c + d[1]);
        sel = null;
      },
      __state: () => ({ grid: Array.from(grid), ice: Array.from(ice), target, movesLeft, score, N, colors: C, pending }),
    };
    function drawGem(g, cx, cy, rad, v) {
      const col = PAL[v], sh = SHAPES[v];
      g.fillStyle = col; g.strokeStyle = col; g.lineWidth = rad * .38;
      g.beginPath();
      if (sh === 'circle') g.arc(cx, cy, rad, 0, 7);
      else if (sh === 'square') G.roundRect(g, cx - rad * .9, cy - rad * .9, rad * 1.8, rad * 1.8, rad * .3);
      else if (sh === 'tri') { g.moveTo(cx, cy - rad); g.lineTo(cx + rad, cy + rad * .8); g.lineTo(cx - rad, cy + rad * .8); g.closePath(); }
      else if (sh === 'diamond') { g.moveTo(cx, cy - rad); g.lineTo(cx + rad, cy); g.lineTo(cx, cy + rad); g.lineTo(cx - rad, cy); g.closePath(); }
      else if (sh === 'star') { for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? rad * .5 : rad; k ? g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr) : g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); }
      else if (sh === 'ring') g.arc(cx, cy, rad * .7, 0, 7);
      else { g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy); g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad); }
      if (sh === 'ring') g.stroke(); else g.fill();
    }
    return api;
  };
})();
