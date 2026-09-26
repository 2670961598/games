'use strict';
/* GAMES-24 基准——原生 Canvas2D 接线层（现有路线的工程化上限参照）。
 * 外壳口径对齐 games/_shared/common.js：375×667 逻辑分辨率、DPR 缩放夹 1..3、
 * rAF + 固定步长累加器、Pointer 事件（tap 全屏点按 / swipe ≥24px 主轴定向）。
 * 渲染即扫即画（无显示对象层）；HUD 走 DOM（全引擎统一，去文本渲染混杂因子）。 */
(function () {
  const B = window.__BENCH__;
  const emitQueue = [];
  const emit = (k, v) => { emitQueue.push([k, v]); };
  const sim = B.game === 'tap'
    ? R24.makeTap(B.load, 'bench-tap', emit)
    : R24.makeRunner(B.load, 'bench-run', emit);
  B.markSim();

  const W = R24.W, H = R24.H;
  const cvs = document.getElementById('cv'), g = cvs.getContext('2d');
  B.extra = { webgl: false, renderer: 'canvas2d' };
  let scale = 1;
  function fit() {                                  /* 同 common.js.fit() */
    const vw = window.innerWidth, vh = window.innerHeight;
    const s = Math.min(vw / W, vh / H), dpr = Math.min(window.devicePixelRatio || 1, 3);
    cvs.style.width = (W * s) + 'px'; cvs.style.height = (H * s) + 'px';
    cvs.width = Math.round(W * s * dpr); cvs.height = Math.round(H * s * dpr);
    scale = s * dpr;
  }
  fit();
  const toXY = (e) => {
    const r = cvs.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  };

  /* ---------- 输入（§5.4 词表：tap / swipe-lr+swipe-any） ---------- */
  let down = null;
  cvs.addEventListener('pointerdown', (e) => { const p = toXY(e); down = p; if (sim.kind === 'tap') sim.tap(p.x, p.y); });
  cvs.addEventListener('pointerup', (e) => {
    if (sim.kind !== 'runner' || !down) { down = null; return; }
    const p = toXY(e); sim.swipe(p.x - down.x, p.y - down.y); down = null;
  });

  /* ---------- 机器人：决策在页内（确定性），执行由宿主用受信输入（CDP mouse）回放 ----------
   *（Phaser 3.90+ 忽略非受信合成 DOM 事件，三引擎统一走受信输入更接近真机口径） */
  const BOT_OUT = [];
  sim.onStep = R24.makeBot(sim,
    (x, y) => BOT_OUT.push({ k: 'tap', x, y }),
    (dx, dy) => BOT_OUT.push({ k: 'swipe', dx, dy }));
  window.__BOT_DRAIN__ = () => BOT_OUT.splice(0);

  /* ---------- HUD（DOM，值变才写） ---------- */
  const hud = document.getElementById('hud');
  let hudStr = '';
  function hudRender() {
    let s;
    if (sim.kind === 'tap') s = `目标 ${sim.hits}/${sim.target} ｜ 连击 ${sim.combo} ｜ 秒 ${Math.max(0, Math.ceil(sim.timeLeft))} ｜ 分 ${sim.score}`;
    else s = `金币 ${sim.coins} ｜ 命 ${Math.max(0, sim.hearts)} ｜ 距离 ${Math.min(sim.segN * sim.SEG, Math.floor(sim.dist))}/${sim.distance} ｜ 分 ${sim.score}`;
    if (s !== hudStr) { hudStr = s; hud.textContent = s; }
  }

  /* ---------- 渲染 ---------- */
  function hsl(h, s, l) { return `hsl(${h} ${s}% ${l}%)`; }
  function render() {
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = '#10141d'; g.fillRect(0, 0, W, H);
    if (sim.kind === 'tap') {
      for (const it of sim.items) {
        const age = sim.anim - it.born, pop = Math.min(1, age / 0.12);   /* 出生弹入 */
        const rr = it.r * (0.6 + 0.4 * pop);
        g.beginPath(); g.arc(it.x, it.y, rr, 0, 7);
        g.fillStyle = it.decoy ? 'hsl(0 15% 30%)' : hsl(it.hue, 72, 56); g.fill();
        if (it.decoy) {                                     /* 陷阱叉（§7 红叉） */
          g.strokeStyle = '#ff5252'; g.lineWidth = 5; g.beginPath();
          g.moveTo(it.x - rr * 0.4, it.y - rr * 0.4); g.lineTo(it.x + rr * 0.4, it.y + rr * 0.4);
          g.moveTo(it.x + rr * 0.4, it.y - rr * 0.4); g.lineTo(it.x - rr * 0.4, it.y + rr * 0.4); g.stroke();
        }
      }
      for (const f of sim.popFx) {                          /* 命中火花（装饰，同量全引擎） */
        const k = f.t / 0.4;
        for (const sp of f.sparks) {
          g.beginPath();
          g.arc(f.x + Math.cos(sp.a) * (1 - k) * sp.sp * 0.4, f.y + Math.sin(sp.a) * (1 - k) * sp.sp * 0.4, 3.5 * k, 0, 7);
          g.fillStyle = hsl(f.hue, 80, 60, ); g.globalAlpha = k; g.fill();
        }
        g.globalAlpha = 1;
      }
    } else {
      const A = sim.area;
      g.fillStyle = '#151a26'; g.fillRect(A.x, A.y, A.w, A.h);
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
      for (let l = 1; l < sim.LANES; l++) { g.beginPath(); g.moveTo(l * sim.laneW, A.y); g.lineTo(l * sim.laneW, A.y + A.h); g.stroke(); }
      /* 可见分段窗：相机随 dist 前滚（只画窗内，同 pooling 语义） */
      const z0 = sim.dist - 80, z1 = sim.dist + (A.y + A.h) + 80;
      const py = sim.playerY;
      const worldY = (z) => py - (z - sim.dist);            /* 世界 z → 屏幕 y */
      const s0 = Math.max(0, Math.floor(z0 / sim.SEG)), s1 = Math.min(sim.segN - 1, Math.floor(z1 / sim.SEG));
      let ents = 0;
      for (let s = s0; s <= s1; s++) {
        for (let l = 0; l < sim.LANES; l++) {
          const v = sim.lanes[s][l];
          if (!v) continue;
          const cx = (l + 0.5) * sim.laneW, zc = s * sim.SEG + sim.SEG / 2, y = worldY(zc);
          if (y < A.y - 60 || y > A.y + A.h + 60) continue;
          ents++;
          if (v === 2) { g.beginPath(); g.arc(cx, y, 13, 0, 7); g.fillStyle = '#ffd54f'; g.fill(); g.strokeStyle = '#b8860b'; g.lineWidth = 2; g.stroke(); }
          else {
            const hh = sim.OB_H[v];
            g.fillStyle = v === 3 ? '#e05252' : '#7aa5e0';
            g.beginPath(); g.roundRect ? g.roundRect(cx - 30, y - hh / 2, 60, hh, 8) : g.rect(cx - 30, y - hh / 2, 60, hh); g.fill();
          }
        }
      }
      B.noteEntities(ents);
      /* 角色 */
      g.beginPath(); g.arc(sim.px, py - sim.jumpY, 16, 0, 7);
      g.fillStyle = sim.invuln > 0 && Math.floor(sim.anim * 10) % 2 ? '#66f0ff44' : '#66f0ff'; g.fill();
      g.fillStyle = '#0b0e14'; g.beginPath(); g.arc(sim.px, py - sim.jumpY, 7, 0, 7); g.fill();
      return;
    }
    B.noteEntities(sim.items.length + sim.popFx.length);
  }

  /* ---------- 主循环 ---------- */
  let last = performance.now(), overAt = 0;
  function loop(t) {
    B.frame(t);
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (!sim.done) sim.update(dt);
    else if (!overAt) overAt = t;
    if (overAt && t - overAt > 800) { overAt = 0; sim.restarts++; B.restarts = sim.restarts; sim.reset(); }
    B.simEvents = sim.events;
    render(); hudRender();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
