'use strict';
/* =====================================================================
 * 迷宫冲刺引擎（spec §28）：递归回溯法由 seed 生成完美迷宫（唯一解），再拆
 * q=⌊size²×0.05⌋ 面墙制造环路；后段带钥匙与视野迷雾；限时集齐钥匙到出口即胜，超时即败。
 * 曲线：size(L)=min(sizeN+4, sizeN+⌊4p⌋)——本实现取 +2⌊2p⌋ 保持 schema"奇数"不变式（同包络）；
 *       keys(L)=min(keysCap, ⌊3p⌋)；time(L)=ceil(bfsPathLen×timeFactor/speed)；speed 常量 4.0。
 * 生成（§28）：钥匙放在 BFS 深度前 60% 的死端格（不足则放宽到全部死端）。
 * 计分：score=剩余秒×20+钥匙×50；s2=12×time(L)，s3=15×time(L)。
 * 交互（§28 单手映射）：滑动定向前进至下一个岔口（格吸附，免连滑）；顶部剩余时间条。
 * ===================================================================== */
const MazeDashEngine = (function () {
  const DIRV = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ sizeN: 11, timeFactor: 1.7, speed: 4.0, keysCap: 2, fogR: 0 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const size = Math.min(t.sizeN + 4, t.sizeN + 2 * Math.floor(2 * p));   // 奇偶不变式（schema 注）
    const keysN = Math.min(t.keysCap, Math.floor(3 * p));

    /* --- 墙表示：hwal[y][x] 竖立于 (x,y)-(x+1,y)；vwal[y][x] 竖立于 (x,y)-(x,y+1) --- */
    const hwal = [], vwal = [];
    for (let y = 0; y < size; y++) { hwal.push(new Array(Math.max(0, size - 1)).fill(true)); vwal.push(new Array(Math.max(0, size - 1)).fill(true)); }
    function open(x, y, d) {
      const vx = x + DIRV[d][0], vy = y + DIRV[d][1];
      if (vx < 0 || vy < 0 || vx >= size || vy >= size) return false;
      if (d === 'l') return !hwal[y][x - 1];
      if (d === 'r') return !hwal[y][x];
      if (d === 'u') return !vwal[y - 1][x];
      return !vwal[y][x];
    }
    function carve(x, y, d) {
      if (d === 'l') hwal[y][x - 1] = false;
      else if (d === 'r') hwal[y][x] = false;
      else if (d === 'u') vwal[y - 1][x] = false;
      else vwal[y][x] = false;
    }
    /* --- 递归回溯（迭代栈，邻序 seed 洗牌）→ 完美迷宫 --- */
    {
      const seen = new Uint8Array(size * size);
      const stack = [[0, 0]];
      seen[0] = 1;
      while (stack.length) {
        const [x, y] = stack[stack.length - 1];
        const cand = ['u', 'd', 'l', 'r'].filter(d => {
          const nx = x + DIRV[d][0], ny = y + DIRV[d][1];
          return nx >= 0 && ny >= 0 && nx < size && ny < size && !seen[ny * size + nx];
        });
        if (!cand.length) { stack.pop(); continue; }
        for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = cand[i]; cand[i] = cand[j]; cand[j] = tmp; }
        const d = cand[0];
        carve(x, y, d);
        const nx = x + DIRV[d][0], ny = y + DIRV[d][1];
        seen[ny * size + nx] = 1;
        stack.push([nx, ny]);
      }
    }
    /* --- 拆 q 面墙造环路（§28） --- */
    {
      const walls = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size - 1; x++) if (hwal[y][x]) walls.push(['h', x, y]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size; x++) if (vwal[y][x]) walls.push(['v', x, y]);
      for (let i = walls.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = walls[i]; walls[i] = walls[j]; walls[j] = tmp; }
      const q = Math.floor(size * size * 0.05);
      for (let i = 0; i < Math.min(q, walls.length); i++) {
        const [w, x, y] = walls[i];
        if (w === 'h') hwal[y][x] = false; else vwal[y][x] = false;
      }
    }
    /* --- BFS（起点→全图距离 / 死端 / 钥匙 / 时限基准） --- */
    const dist = new Int32Array(size * size).fill(-1);
    dist[0] = 0;
    {
      const q = [[0, 0]];
      for (let qi = 0; qi < q.length; qi++) {
        const [x, y] = q[qi];
        for (const d of 'udlr') {
          if (!open(x, y, d)) continue;
          const nx = x + DIRV[d][0], ny = y + DIRV[d][1], k = ny * size + nx;
          if (dist[k] === -1) { dist[k] = dist[y * size + x] + 1; q.push([nx, ny]); }
        }
      }
    }
    const exitCell = [size - 1, size - 1];
    const bfsLen = dist[(size - 1) * size + (size - 1)];
    const degree = (x, y) => 'udlr'.split('').filter(d => open(x, y, d)).length;
    const keys = new Set();
    {
      const deadEnds = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if ((x === 0 && y === 0) || (x === size - 1 && y === size - 1)) continue;
        if (degree(x, y) === 1) deadEnds.push([x, y]);
      }
      let band = deadEnds.filter(c => dist[c[1] * size + c[0]] <= 0.6 * bfsLen);
      if (band.length < keysN) band = deadEnds;            // 带内不足放宽（§28 意图内的兜底）
      for (let i = band.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = band[i]; band[i] = band[j]; band[j] = tmp; }
      for (let i = 0; i < Math.min(keysN, band.length); i++) keys.add(band[i][1] * size + band[i][0]);
    }
    /* 时限基准（裁量）：spec 的 bfsPathLen 取"经全部钥匙的强制路线最短路"——
     * 钥匙在死端格，纯起→终最短路会让高 keys 档超出 timeFactor 余量而不可赢；
     * keysCap ≤ 3 → 全排列精确解（≤6 组 BFS 距离拼和）。keys=0 时退化为纯最短路（公式原样）。 */
    function bfsDist(from, to) {
      if (from[0] === to[0] && from[1] === to[1]) return 0;
      const d = new Int32Array(size * size).fill(-1);
      d[from[1] * size + from[0]] = 0;
      const q = [from];
      for (let qi = 0; qi < q.length; qi++) {
        const [x, y] = q[qi];
        for (const dd of 'udlr') {
          if (!open(x, y, dd)) continue;
          const nx = x + DIRV[dd][0], ny = y + DIRV[dd][1], k = ny * size + nx;
          if (d[k] === -1) { d[k] = d[y * size + x] + 1; if (nx === to[0] && ny === to[1]) return d[k]; q.push([nx, ny]); }
        }
      }
      return -1;
    }
    let routeLen = bfsLen;
    {
      const keyCells = [...keys].map(k => [k % size, (k / size) | 0]);
      if (keyCells.length) {
        const start = [0, 0];
        let best = Infinity;
        const swap = (a, i, j) => { const b = a.slice(); const tmp = b[i]; b[i] = b[j]; b[j] = tmp; return b; }
        const permute = (arr, m) => {
          if (m === 1) {
            let total = 0, cur = start;
            for (const wp of [...arr, exitCell]) { total += bfsDist(cur, wp); cur = wp; }
            if (total < best) best = total;
            return;
          }
          for (let i = 0; i < m; i++) permute(swap(arr, i, m - 1), m - 1);
        };
        permute(keyCells, keyCells.length);
        routeLen = best;
      }
    }
    const time = Math.max(1, Math.ceil(routeLen * t.timeFactor / t.speed));

    /* --- 玩家：格吸附自动奔跑至岔口 --- */
    let cx = 0, cy = 0, path = [], prog = 0, pending = null;
    let keysGot = 0, timeLeft = time, score = 0, done = false, down = null;

    const moving = () => path.length > 0;
    function launch(d) {
      if (done || moving()) return;
      const nx = cx + DIRV[d][0], ny = cy + DIRV[d][1];
      if (!open(cx, cy, d)) { game.toast('此路不通'); return; }
      path = [[nx, ny]];
      prog = 0;
      extendFrom(nx, ny, cx, cy);
    }
    /** 从 (x,y) 沿来向直进到岔口或墙前（岔口=度 ≥3，进入即停，§28 免连滑）；
     *  (fx,fy)=来向格——直进不折返（含起点方向），保证"滑动一次跑一整段"语义 */
    function extendFrom(x, y, fx, fy) {
      let px = x, py = y, fromX = fx, fromY = fy;
      for (let hop = 0; hop < size * size; hop++) {
        if (degree(px, py) >= 3) return;                   // 岔口：停在进入格
        const next = 'udlr'.split('').find(d => {
          if (!open(px, py, d)) return false;
          const bx = px + DIRV[d][0], by = py + DIRV[d][1];
          return !(bx === fromX && by === fromY);          // 不掉头
        });
        if (!next) return;                                  // 死端/墙前停
        fromX = px; fromY = py;
        px += DIRV[next][0]; py += DIRV[next][1];
        path.push([px, py]);
      }
    }
    function arrive(x, y) {
      cx = x; cy = y;
      if (keys.has(y * size + x)) { keys.delete(y * size + x); keysGot++; game.toast(`钥匙 ${keysGot}/${keysN}`); }
      if (x === exitCell[0] && y === exitCell[1]) {
        if (keysGot >= keysN) {                             // 集齐钥匙到达出口（§28）
          done = true; score = Math.ceil(timeLeft) * 20 + keysGot * 50;
          game.win(score, { s2: 12 * time, s3: 15 * time });
        } else game.toast(`还差 ${keysN - keysGot} 把钥匙`);
      }
    }

    function step() {
      if (done) return;
      timeLeft -= STEP;
      if (timeLeft <= 0) { done = true; game.lose(score); return; }
      if (!path.length) return;
      prog += t.speed * STEP;
      while (path.length && prog >= 1) {
        prog -= 1;
        const [nx, ny] = path.shift();
        arrive(nx, ny);
        if (done) return;
        if (!path.length) { prog = 0; break; }
        if (pending && open(cx, cy, pending)) {             // 行进中转向：下一格起改向
          const d = pending; pending = null;
          const tx = cx + DIRV[d][0], ty = cy + DIRV[d][1];
          path = [[tx, ty]];
          extendFrom(tx, ty, cx, cy);
          break;
        }
      }
      if (!path.length && pending) {                        // 停稳后补执行行进中滑入的方向
        const d = pending; pending = null;
        launch(d);
      }
    }

    /* --- 渲染布局 --- */
    const cell = Math.floor(Math.min((area.w - 16) / size, (area.h - 30) / size));
    const mx = (area.w - cell * size) / 2, my = area.y + 22;
    const cxOf = (x) => mx + (x + 0.5) * cell;
    const cyOf = (y) => my + (y + 0.5) * cell;

    return {
      startLevel() { game.setHud([{ t: `/${time}秒`, v: time }, { t: '钥匙', v: `0/${keysN}` }, { t: '格', v: size }]); },
      update(dt) {
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        game.setHud([
          { t: `/${time}秒`, v: Math.ceil(Math.max(0, timeLeft)) },
          { t: '钥', v: `${keysGot}/${keysN}` },
          { t: '边', v: size },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) {
        if (!down) return;
        const d = G.swipeDir(x - down.x, y - down.y);
        down = null;
        if (!d) return;
        if (moving()) pending = d;
        else launch(d);
      },
      render(g) {
        /* 顶部剩余时间条（§28） */
        const tr = G.clamp(timeLeft / time, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = tr > 0.25 ? '#7bd88f' : '#ff8fa3'; g.fillRect(20, area.y + 6, (area.w - 40) * tr, 4);
        /* 墙 */
        g.strokeStyle = '#3b4a6b'; g.lineWidth = 2; g.lineCap = 'round';
        g.strokeRect(mx, my, cell * size, cell * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size - 1; x++) {
          if (!hwal[y][x]) continue;
          g.beginPath(); g.moveTo(mx + (x + 1) * cell, my + y * cell); g.lineTo(mx + (x + 1) * cell, my + (y + 1) * cell); g.stroke();
        }
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size; x++) {
          if (!vwal[y][x]) continue;
          g.beginPath(); g.moveTo(mx + x * cell, my + (y + 1) * cell); g.lineTo(mx + (x + 1) * cell, my + (y + 1) * cell); g.stroke();
        }
        /* 起点 / 出口 / 钥匙 */
        g.fillStyle = '#6ea8ff'; g.font = G.FONT(11, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('S', cxOf(0), cyOf(0));
        g.fillStyle = '#7bd88f'; G.roundRect(g, cxOf(exitCell[0]) - cell * 0.36, cyOf(exitCell[1]) - cell * 0.36, cell * 0.72, cell * 0.72, 4); g.fill();
        g.fillStyle = '#101522'; g.fillText('E', cxOf(exitCell[0]), cyOf(exitCell[1]));
        g.fillStyle = '#ffd166';
        keys.forEach(k => {
          const x = k % size, y = (k / size) | 0;
          g.save(); g.translate(cxOf(x), cyOf(y));
          g.beginPath(); g.arc(0, -2, 3.2, Math.PI, 0); g.lineTo(4.5, 2); g.lineTo(2, 2); g.lineTo(2, 6); g.lineTo(-2, 6); g.lineTo(-2, 2); g.lineTo(-4.5, 2); g.closePath(); g.fill();
          g.restore();
        });
        /* 玩家（格间插值） */
        let fx = cxOf(cx), fy = cyOf(cy);
        if (path.length) {
          const [nx, ny] = path[0];
          fx = G.lerp(cxOf(cx), cxOf(nx), G.clamp(prog, 0, 1));
          fy = G.lerp(cyOf(cy), cyOf(ny), G.clamp(prog, 0, 1));
        }
        g.beginPath(); g.arc(fx, fy, Math.max(4, cell * 0.3), 0, 7);
        g.fillStyle = '#ffd166'; g.fill();
        g.strokeStyle = '#101522'; g.lineWidth = 2; g.stroke();
        /* 迷雾（fogR>0 档：半径外遮蔽，§28 后段视野雾） */
        if (t.fogR > 0) {
          const r = t.fogR * cell;
          const grad = g.createRadialGradient(fx, fy, r * 0.55, fx, fy, r);
          grad.addColorStop(0, 'rgba(11,14,20,0)');
          grad.addColorStop(1, 'rgba(11,14,20,0.94)');
          g.fillStyle = grad;
          g.fillRect(0, area.y, area.w, area.h);
        }
      },
      __state() {
        return {
          size, keysN, bfsLen, routeLen, time, fogR: t.fogR, timeFactor: t.timeFactor,
          hwal: hwal.map(r => r.map(v => v ? 1 : 0).join('')).join('|'),
          vwal: vwal.map(r => r.map(v => v ? 1 : 0).join('')).join('|'),
          keys: [...keys].sort((a, b) => a - b),
          cx, cy, path: path.map(c => c.join(',')), prog: +prog.toFixed(3), pending,
          keysGot, timeLeft: +timeLeft.toFixed(2), score, done,
        };
      },
    };
  };
})();
