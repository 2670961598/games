'use strict';
/* =====================================================================
 * 贪吃蛇引擎（spec §13）：20×20 网格，四方向滑动转向（不允许直接反向），
 * 吃食物长身体，长度达标即胜；撞身/撞石、撞墙（solid 档）即败。
 * 曲线：speed(L)=speed×(1+0.40p)；targetLen(L)=ceil(targetLenBase×(1+0.10p))；
 *       obstacle(L)=round(obstacleBase×(1+0.30p))。p=(L−1)/(Ln−1)。
 * 生成（§13）：食物与石块位置由 seed 生成，硬约束：食物不落在蛇身/石块 2 格邻域内，
 *   石块不封死任一象限（实现取强：自由格从蛇头洪泛全连通 → 任何象限不孤立）；
 *   后续食物从 seed 预生成序列取（对石块/蛇身仍保持距离约束，遇占位顺延）。
 * 计分：score=食物×20+通关奖励100；s2=24×targetLen(L)，s3=30×targetLen(L)。
 * 撞墙语义按档位：wrap 穿墙 / solid 撞墙即败（§13 档位表）。
 * ===================================================================== */
const SnakeEngine = (function () {
  const N = 20;
  const DIRV = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };
  const OPP = { u: 'd', d: 'u', l: 'r', r: 'l' };
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ speed: 6.0, targetLenBase: 15, obstacleBase: 8, wall: 'wrap' }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const speed = +(t.speed * (1 + 0.40 * p)).toFixed(2);
    const targetLen = Math.ceil(t.targetLenBase * (1 + 0.10 * p));
    const obstN = Math.round(t.obstacleBase * (1 + 0.30 * p));

    /* --- 蛇初始：中心竖排 3 节，头朝上 --- */
    let snake = [[10, 10], [10, 11], [10, 12]];
    const stones = new Set();

    const key = (x, y) => y * N + x;
    const cheb = (a, b, c, d) => Math.max(Math.abs(a - c), Math.abs(b - d));
    /** 自由格（不含蛇身）从蛇头洪泛是否全连通（石块不封死象限，§13） */
    function connected() {
      const body = new Set(snake.map(s => key(s[0], s[1])));
      const headK = key(snake[0][0], snake[0][1]);
      const seen = new Uint8Array(N * N);
      const q = [snake[0]];
      seen[headK] = 1;
      let reach = 0;
      while (q.length) {
        const [x, y] = q.pop();
        reach++;
        for (const d of 'udlr') {
          const nx = x + DIRV[d][0], ny = y + DIRV[d][1];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const k = key(nx, ny);
          if (seen[k] || stones.has(k) || (body.has(k) && k !== headK)) continue;
          seen[k] = 1; q.push([nx, ny]);
        }
      }
      return reach === N * N - stones.size - (snake.length - 1);   // 可达 = 全格 − 石块 − 非头蛇身（头本身计入 reach）
    }
    /** 石块布置：seed 掷点 + 连通性硬约束（失败整体重掷，上限 60 次） */
    for (let attempt = 0; attempt < 60 && stones.size < obstN; attempt++) {
      stones.clear();
      let guard = 0;
      while (stones.size < obstN && guard++ < 500) {
        const x = Math.floor(rng() * N), y = Math.floor(rng() * N);
        const k = key(x, y);
        if (stones.has(k)) continue;
        if (snake.some(s => cheb(s[0], s[1], x, y) < 2)) continue;   // 出生保护 2 格
        stones.add(k);
        if (!connected()) stones.delete(k);
      }
      if (stones.size === obstN) break;
    }

    /** 食物候选序列：seed 预生成（硬约束：距初始蛇身/石块 ≥2 格，§13 生成规则） */
    const need = targetLen - snake.length;
    const foodPlan = [];
    {
      let guard = 0;
      while (foodPlan.length < need + 16 && guard++ < 3000) {
        const x = Math.floor(rng() * N), y = Math.floor(rng() * N);
        if (snake.some(s => cheb(s[0], s[1], x, y) < 3)) continue;
        let ok = true;
        stones.forEach(k => { if (cheb(k % N, (k / N) | 0, x, y) < 3) ok = false; });
        if (!ok || foodPlan.some(f => f[0] === x && f[1] === y)) continue;
        foodPlan.push([x, y]);
      }
    }
    /** 取下一个合法食物：预生成序列顺延；耗尽则行序首个合法格（确定性兜底） */
    let food = null;
    function nextFood() {
      const body = new Set(snake.map(s => key(s[0], s[1])));
      while (foodPlan.length) {
        const f = foodPlan.shift();
        const k = key(f[0], f[1]);
        if (body.has(k) || stones.has(k)) continue;
        let ok = true;
        stones.forEach(s => { if (cheb(s % N, (s / N) | 0, f[0], f[1]) < 3) ok = false; });
        if (!ok) continue;
        return f;
      }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const k = key(x, y);
        if (!body.has(k) && !stones.has(k)) return [x, y];
      }
      return null;
    }
    food = nextFood();

    /* --- 运行状态 --- */
    let dir = 'u', queue = [], acc = 0, foods = 0, score = 0, done = false, down = null, anim = 0;

    function step() {
      if (done) return;
      if (queue.length) {
        const d = queue.shift();
        if (d !== OPP[dir]) dir = d;                       // 不允许直接反向（§13）
      }
      let nx = snake[0][0] + DIRV[dir][0], ny = snake[0][1] + DIRV[dir][1];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) {
        if (t.wall === 'solid') { done = true; game.lose(score); return; }   // solid 撞墙即败
        nx = (nx + N) % N; ny = (ny + N) % N;              // wrap 穿墙
      }
      const growing = food && nx === food[0] && ny === food[1];
      const tail = snake[snake.length - 1];
      for (let i = 0; i < snake.length; i++) {
        if (i === snake.length - 1 && !growing) break;     // 尾格将 vacate，穿过合法
        if (snake[i][0] === nx && snake[i][1] === ny) { done = true; game.lose(score); return; }
      }
      snake.unshift([nx, ny]);
      if (growing) {
        foods++;
        food = nextFood();
        score = foods * 20;
        if (snake.length >= targetLen) {                   // 长度达标（§13）
          done = true; game.win(score + 100, { s2: 24 * targetLen, s3: 30 * targetLen });
          return;
        }
      } else snake.pop();
      if (!food) { food = nextFood(); }
    }

    return {
      startLevel() { game.setHud([{ t: `/${targetLen}`, v: snake.length }, { t: '食', v: 0 }, { t: '石', v: stones.size }]); },
      update(dt) {
        anim += dt;
        acc += dt;
        const interval = 1 / speed;
        let guard = 0;
        while (acc >= interval && guard++ < 8) { acc -= interval; step(); if (done) break; }
        game.setHud([
          { t: `/${targetLen}长`, v: snake.length },
          { t: '食', v: foods },
          { t: '石', v: stones.size },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) {
        if (!down) return;
        const d = G.swipeDir(x - down.x, y - down.y);
        down = null;
        if (!d) return;
        const last = queue.length ? queue[queue.length - 1] : dir;
        if (d !== OPP[last] && queue.length < 2) queue.push(d);   // 队列内也不可反向
      },
      render(g) {
        const cell = 17, bx = (area.w - cell * N) / 2, by = area.y + 34;
        /* 棋盘底 */
        g.fillStyle = '#141a2b'; g.fillRect(bx - 4, by - 4, cell * N + 8, cell * N + 8);
        g.strokeStyle = '#1c2438'; g.lineWidth = 1;
        for (let i = 0; i <= N; i++) {
          g.beginPath(); g.moveTo(bx + i * cell, by); g.lineTo(bx + i * cell, by + N * cell); g.stroke();
          g.beginPath(); g.moveTo(bx, by + i * cell); g.lineTo(bx + N * cell, by + i * cell); g.stroke();
        }
        if (t.wall === 'wrap') {                           // 穿墙档：边缘虚线提示
          g.strokeStyle = '#7bd88f55'; g.setLineDash([6, 6]); g.lineWidth = 2;
          g.strokeRect(bx - 4, by - 4, cell * N + 8, cell * N + 8); g.setLineDash([]);
        }
        /* 石块 */
        g.fillStyle = '#3b4a6b';
        stones.forEach(k => {
          const x = k % N, y = (k / N) | 0;
          G.roundRect(g, bx + x * cell + 1, by + y * cell + 1, cell - 2, cell - 2, 3); g.fill();
        });
        /* 食物（脉动装饰，不涉判定） */
        if (food) {
          const r = cell * 0.32 + Math.sin(anim * 5) * 1.5;
          g.beginPath(); g.arc(bx + (food[0] + 0.5) * cell, by + (food[1] + 0.5) * cell, r, 0, 7);
          g.fillStyle = '#ff8fa3'; g.fill();
        }
        /* 蛇身 */
        for (let i = snake.length - 1; i >= 0; i--) {
          const s = snake[i];
          g.fillStyle = i === 0 ? '#ffd166' : `hsl(140,50%,${52 - Math.min(18, i * 2)}%)`;
          G.roundRect(g, bx + s[0] * cell + 1, by + s[1] * cell + 1, cell - 2, cell - 2, i === 0 ? 6 : 3); g.fill();
        }
      },
      __state() {
        return {
          speed, targetLen, obstN: stones.size, wall: t.wall, foods, score, done,
          dir, queue: queue.join(''),
          snake: snake.map(s => s.join(',')),
          stones: [...stones].sort((a, b) => a - b),
          food: food && food.join(','), foodPlanLeft: foodPlan.length,
        };
      },
    };
  };
})();
