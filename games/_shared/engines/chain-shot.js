'use strict';
/* =====================================================================
 * 珠链消除引擎（spec §27，祖玛式）：轨道珠链向洞口推进，点按任意方向射珠入链，
 * 同色 ≥3 消除；每次消除链尾回退 60px；双击发射器换珠（swap 次/关）。
 * 链表示：colors[0]=首珠（最近洞口），s_i = head_s − i×spacing（连续无隙，消除即贴合 → 天然连锁）。
 * 物理：固定步长 1/120s 累加器，跨设备一致；命中插入按切线投影定前后。
 * score = 消珠×10 + 连锁级数×5 + 单次消≥4珠×20；s2 = balls×12，s3 = balls×15。
 * ===================================================================== */
const ChainShotEngine = (function () {
  const PAL = ['#ff8fa3', '#ffd166', '#7bd88f', '#6ea8ff', '#b56cff', '#4dd0e1'];
  const R = 10.5, SP = R * 2, SHOT_V = 560;

  const chainOf = (t, L, n) => t.chainSpeed * (1 + 0.40 * (L - 1) / (n - 1));
  const ballsOf = (t, L, n) => Math.ceil(t.totalBalls * (1 + 0.30 * (L - 1) / (n - 1)));

  /* ---- 轨道形状池（螺旋 / S 波 / 双环），密集采样后按弧长参数化 ---- */
  function buildTrack(kind, area) {
    const pts = [];
    const push = (x, y) => pts.push({ x, y });
    if (kind === 0) {           // 螺旋（外→内）
      const cx = area.w / 2, cy = area.y + area.h * 0.40;
      for (let i = 0; i <= 720; i++) {
        const u = i / 720, th = u * Math.PI * 3.1, r = 24 + (1 - u) * 108;
        push(cx + Math.cos(th) * r * 1.25, cy + Math.sin(th) * r);
      }
    } else if (kind === 1) {    // S 波（下→上）
      for (let i = 0; i <= 720; i++) {
        const u = i / 720;
        push(30 + (area.w - 60) * u, area.y + area.h * 0.74 - Math.sin(u * Math.PI * 3) * area.h * 0.26);
      }
    } else {                    // 双环
      const cx = area.w / 2, cy = area.y + area.h * 0.42, rr = Math.min(area.w * 0.36, 120);
      for (let i = 0; i <= 360; i++) { const th = -Math.PI / 2 + i / 360 * Math.PI * 1.8; push(cx - rr * 0.9 + Math.cos(th) * rr, cy + Math.sin(th) * rr); }
      for (let i = 0; i <= 360; i++) { const th = Math.PI / 2 + i / 360 * Math.PI * 1.8; push(cx + rr * 0.9 + Math.cos(th) * rr, cy + Math.sin(th) * rr); }
    }
    /* 弧长参数化：累计长度表 → pos(s) 插值；总长重采样至 trackLen */
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = cum[cum.length - 1], LEN = 1200;
    const pos = (s) => {
      const d = G.clamp(s / LEN, 0, 1) * total;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; cum[mid] < d ? lo = mid + 1 : hi = mid; }
      const i = Math.max(1, lo), f = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return { x: G.lerp(pts[i - 1].x, pts[i].x, f), y: G.lerp(pts[i - 1].y, pts[i].y, f) };
    };
    return { pos, pts, LEN };
  }

  return function (game) {
    const { cfg, rng } = game;
    const t = Object.assign({ chainSpeed: 30, colors: 4, totalBalls: 40, swap: 5, trackLen: 1200 }, cfg.typeExtra);
    const C = Math.min(t.colors, PAL.length);
    const area = game.area;
    const track = buildTrack((rng() * 3) | 0, area);   // 轨道形状由 seed 掷点（§27 生成规则）
    const shooter = { x: area.w / 2, y: area.y + area.h * 0.80 };
    const chainSpeed = chainOf(t, game.level, cfg.levels);
    const totalBalls = ballsOf(t, game.level, cfg.levels);

    let queue, colors, head_s, cur, nxt, swapLeft, score, over, won;
    let shot = null, shotsFired = 0;
    let acc = 0;                       // 固定步长累加器
    let aim = null, lastShooterTap = 0, now = 0;
    let pops = [];

    const headPos = () => track.pos(head_s);
    function spawnQueued() { while (queue.length && head_s - colors.length * SP >= 0) colors.push(queue.shift()); }

    function shootAt(x, y) {
      const dx = x - shooter.x, dy = y - shooter.y, d = Math.hypot(dx, dy) || 1;
      shot = { x: shooter.x, y: shooter.y, vx: dx / d * SHOT_V, vy: dy / d * SHOT_V, color: cur, trail: [] };
      cur = nxt; nxt = (rng() * C) | 0; shotsFired++;
    }
    function ballXY(i) { return track.pos(head_s - i * SP); }
    function tangent(i) {          // 轨道切线（指向洞口方向）
      const a = track.pos(head_s - i * SP + 2), b = track.pos(head_s - i * SP - 2);
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      return { x: (a.x - b.x) / d, y: (a.y - b.y) / d };
    }
    /* 消除与连锁：返回 {removed, depth}；每次消除链整体回退 60px（§27 减速机制） */
    function eliminate(at) {
      let removed = 0, depth = 0, idx = at;
      while (true) {
        const c = colors[idx];
        let a = idx, b = idx;
        while (a > 0 && colors[a - 1] === c) a--;
        while (b < colors.length - 1 && colors[b + 1] === c) b++;
        const n = b - a + 1;
        if (n < 3) break;
        depth++;
        const p = track.pos(head_s - ((a + b) / 2) * SP);
        pops.push({ x: p.x, y: p.y, t: 1, color: PAL[c] });
        colors.splice(a, n);
        removed += n;
        score += n * 10 + depth * 5 + (n >= 4 ? 20 : 0);
        head_s = Math.max(head_s - 60, (colors.length - 1) * SP);   // 链尾回退 60px（贴地钳制）
        idx = Math.min(a, colors.length - 1);                        // 贴合点重扫
        if (colors.length === 0) break;
      }
      return { removed, depth };
    }
    function step(dt) {             // 固定 1/120s 物理步
      now += dt;
      if (!over) head_s += chainSpeed * dt;
      spawnQueued();
      if (head_s >= track.LEN && colors.length) { over = true; game.lose(score); }
      if (!colors.length && !queue.length && !over && !won) { won = true; over = true; game.win(score, { s2: totalBalls * 12, s3: totalBalls * 15 }); }
      if (!shot) return;
      shot.x += shot.vx * dt; shot.y += shot.vy * dt;
      shot.trail.push({ x: shot.x, y: shot.y });
      if (shot.trail.length > 8) shot.trail.shift();
      if (shot.x < -30 || shot.x > area.w + 30 || shot.y < area.y - 30 || shot.y > area.y + area.h + 30) { shot = null; return; }
      for (let i = 0; i < colors.length; i++) {
        const p = ballXY(i);
        if (Math.hypot(shot.x - p.x, shot.y - p.y) <= R * 2) {
          const tg = tangent(i);
          const ahead = (shot.x - p.x) * tg.x + (shot.y - p.y) * tg.y > 0;
          const at = ahead ? i : i + 1;                    // 切向投影定插入位
          colors.splice(at, 0, shot.color);
          const c = shot.color;
          let a = at, b = at;
          while (a > 0 && colors[a - 1] === c) a--;
          while (b < colors.length - 1 && colors[b + 1] === c) b++;
          if (b - a + 1 >= 3) eliminate(at);
          shot = null;
          break;
        }
      }
    }

    return {
      startLevel() {
        queue = []; colors = [];
        for (let i = 0; i < totalBalls; i++) queue.push((rng() * C) | 0);   // 珠色序列由 seed 掷点
        head_s = track.LEN * 0.42;
        cur = (rng() * C) | 0; nxt = (rng() * C) | 0;                       // 发射器珠色由 seed 掷点
        swapLeft = t.swap >= 99 ? Infinity : t.swap;
        score = 0; over = false; won = false; shot = null; pops = []; now = 0;
        spawnQueued();
        game.setHud([{ t: '分数', v: 0 }, { t: '换珠', v: swapLeft === Infinity ? '∞' : swapLeft }]);
      },
      update(dt) {
        acc += dt;
        let guard = 0;
        while (acc >= 1 / 120 && guard++ < 8) { step(1 / 120); acc -= 1 / 120; }
        for (const p of pops) p.t -= dt * 2.5;
        pops = pops.filter(p => p.t > 0);
      },
      render(g) {
        /* 轨道 */
        g.strokeStyle = '#232c42'; g.lineWidth = R * 2 + 6; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        for (let i = 0; i < track.pts.length; i += 4) { const p = track.pos(i / (track.pts.length - 1) * track.LEN); i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
        g.stroke();
        g.strokeStyle = '#1a2133'; g.lineWidth = R * 2; g.stroke();
        /* 洞口 */
        const hole = track.pos(track.LEN);
        g.fillStyle = '#05070c'; g.beginPath(); g.arc(hole.x, hole.y, R + 6, 0, 7); g.fill();
        g.strokeStyle = '#3a4a6b'; g.lineWidth = 2; g.stroke();
        /* 珠链 */
        for (let i = colors.length - 1; i >= 0; i--) {
          const p = ballXY(i);
          g.fillStyle = PAL[colors[i]];
          g.beginPath(); g.arc(p.x, p.y, R, 0, 7); g.fill();
          g.fillStyle = 'rgba(255,255,255,.35)';
          g.beginPath(); g.arc(p.x - R * .3, p.y - R * .35, R * .3, 0, 7); g.fill();
        }
        /* 飞行珠 */
        if (shot) {
          for (let i = 0; i < shot.trail.length; i++) {
            g.globalAlpha = i / shot.trail.length * .5;
            g.fillStyle = PAL[shot.color];
            g.beginPath(); g.arc(shot.trail[i].x, shot.trail[i].y, R * .8, 0, 7); g.fill();
          }
          g.globalAlpha = 1;
          g.fillStyle = PAL[shot.color];
          g.beginPath(); g.arc(shot.x, shot.y, R, 0, 7); g.fill();
        }
        /* 发射器（屏下 1/3） */
        g.fillStyle = '#2c3a5c'; g.beginPath(); g.arc(shooter.x, shooter.y, R + 8, 0, 7); g.fill();
        g.strokeStyle = '#6ea8ff'; g.lineWidth = 2; g.stroke();
        g.fillStyle = PAL[cur]; g.beginPath(); g.arc(shooter.x, shooter.y, R, 0, 7); g.fill();
        g.fillStyle = PAL[nxt]; g.beginPath(); g.arc(shooter.x + R + 14, shooter.y - R - 6, R * .72, 0, 7); g.fill();
        g.strokeStyle = '#3a4a6b'; g.lineWidth = 1.5; g.stroke();
        /* 瞄准线 */
        if (aim) {
          g.strokeStyle = 'rgba(110,168,255,.4)'; g.lineWidth = 2; g.setLineDash([6, 6]);
          g.beginPath(); g.moveTo(shooter.x, shooter.y); g.lineTo(aim.x, aim.y); g.stroke();
          g.setLineDash([]);
        }
        for (const p of pops) {
          g.globalAlpha = G.clamp(p.t, 0, 1);
          g.strokeStyle = p.color; g.lineWidth = 3;
          g.beginPath(); g.arc(p.x, p.y, (1 - p.t) * 34 + 8, 0, 7); g.stroke();
          g.globalAlpha = 1;
        }
        if (swapLeft === 0) { g.fillStyle = '#5b6478'; g.font = G.FONT(10, 500); g.textAlign = 'center'; g.fillText('换珠已用尽', shooter.x, shooter.y + R + 22); }
      },
      onDown(x, y) { aim = { x, y }; },
      onMove(x, y) { aim = { x, y }; },
      onUp(x, y) {
        aim = null;
        if (over) return;
        /* 双击发射器 = 换珠 */
        if (Math.hypot(x - shooter.x, y - shooter.y) < 36) {
          if (now - lastShooterTap < 0.35 && swapLeft > 0) {
            const tmp = cur; cur = nxt; nxt = tmp; swapLeft--;
            game.setHud([{ t: '分数', v: score }, { t: '换珠', v: swapLeft === Infinity ? '∞' : swapLeft }]);
            game.toast('已换珠');
          }
          lastShooterTap = now;
          return;
        }
        if (shot) return;                     // 场上单飞行珠
        shootAt(x, y);
      },
      __state: () => ({ colors: colors.slice(), queue: queue.slice(), head_s, score, totalBalls, LEN: track.LEN, trackPos: track.pos }),
    };
  };
})();
