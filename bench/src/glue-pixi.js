'use strict';
/* GAMES-24 基准——PixiJS 8 接线层（渲染器 + 自研游戏循环）。
 * 口径：resolution=DPR + autoDensity（背板 750×1334 @DPR2，CSS 375×667），stage 逻辑坐标
 * 375×667；纹理用 renderer.generateTexture 从 Graphics 烘焙（resolution 自动 ×DPR）。
 * 循环：app.ticker 驱动，内部固定步长累加（判定确定性与原生/Phaser 完全一致）；
 * 输入：画布 DOM Pointer 事件（全屏手势词表的惯用接法，与原生同一管线）。 */
(async function () {
  const B = window.__BENCH__;
  const dpr = B.dpr;
  const emit = () => { };
  const sim = B.game === 'tap'
    ? R24.makeTap(B.load, 'bench-tap', emit)
    : R24.makeRunner(B.load, 'bench-run', emit);
  B.markSim();

  const W = R24.W, H = R24.H;
  const app = new PIXI.Application();
  B.extra = { webgl: true };
  await app.init({
    canvas: document.getElementById('cv'),
    width: W, height: H,
    background: '#10141d',
    resolution: dpr, autoDensity: true, antialias: true,
  });
  document.getElementById('stage').appendChild(app.canvas);

  /* hue → 0xRRGGBB（tint 用，与原生 hsl(h,72,56) 视觉近似） */
  function hueInt(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
  }

  const tex = {};
  const mkTex = (key, size, draw) => {
    const g = new PIXI.Graphics();
    draw(g);
    tex[key] = app.renderer.generateTexture(g);
    g.destroy();
  };
  mkTex('dot', 64, (g) => g.circle(32, 32, 32).fill(0xffffff));
  mkTex('decoy', 64, (g) => {
    g.circle(32, 32, 32).fill(0x33343a);
    g.moveTo(20, 20).lineTo(44, 44).moveTo(44, 20).lineTo(20, 44).stroke({ width: 6, color: 0xff5252 });
  });
  mkTex('spark', 8, (g) => g.circle(4, 4, 4).fill(0xffffff));
  mkTex('coin', 26, (g) => { g.circle(13, 13, 13).fill(0xffd54f).circle(13, 13, 11).stroke({ width: 2, color: 0xb8860b }); });
  mkTex('obLow', 42, (g) => g.roundRect(0, 0, 60, 42, 8).fill(0x7aa5e0));
  mkTex('obTall', 88, (g) => g.roundRect(0, 0, 60, 88, 8).fill(0xe05252));
  mkTex('player', 32, (g) => { g.circle(16, 16, 16).fill(0x66f0ff).circle(16, 16, 7).fill(0x0b0e14); });

  const itemMap = new Map();
  const pool = { dot: [], decoy: [], spark: [], coin: [], obLow: [], obTall: [] };
  const segMap = new Map();
  let sparks = [];

  if (sim.kind === 'runner') {
    const bg = new PIXI.Graphics();
    bg.rect(sim.area.x, sim.area.y, sim.area.w, sim.area.h).fill(0x151a26);
    for (let l = 1; l < sim.LANES; l++) bg.moveTo(l * sim.laneW + 0.5, sim.area.y).lineTo(l * sim.laneW + 0.5, sim.area.y + sim.area.h).stroke({ width: 1, color: 0xffffff, alpha: 0.07 });
    app.stage.addChild(bg);
  }
  const player = sim.kind === 'runner' ? new PIXI.Sprite(tex.player) : null;
  if (player) { player.anchor.set(0.5); app.stage.addChild(player); }

  /* ---------- 输入（与原生同一 DOM 管线） ---------- */
  const cvs = app.canvas;
  let down = null;
  const toXY = (e) => {
    const r = cvs.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  };
  cvs.addEventListener('pointerdown', (e) => {
    const p = toXY(e); down = p;
    if (sim.kind === 'tap') sim.tap(p.x, p.y);
  });
  cvs.addEventListener('pointerup', (e) => {
    if (sim.kind !== 'runner' || !down) { down = null; return; }
    const p = toXY(e); sim.swipe(p.x - down.x, p.y - down.y); down = null;
  });

  /* ---------- 机器人：决策在页内（确定性），执行由宿主受信输入（CDP mouse）回放 ---------- */
  const BOT_OUT = [];
  sim.onStep = R24.makeBot(sim,
    (x, y) => BOT_OUT.push({ k: 'tap', x, y }),
    (dx, dy) => BOT_OUT.push({ k: 'swipe', dx, dy }));
  window.__BOT_DRAIN__ = () => BOT_OUT.splice(0);

  /* ---------- HUD（DOM，值变才写） ---------- */
  const hudEl = document.getElementById('hud');
  let hudStr = '';
  function hudRender() {
    let s;
    if (sim.kind === 'tap') s = `目标 ${sim.hits}/${sim.target} ｜ 连击 ${sim.combo} ｜ 秒 ${Math.max(0, Math.ceil(sim.timeLeft))} ｜ 分 ${sim.score}`;
    else s = `金币 ${sim.coins} ｜ 命 ${Math.max(0, sim.hearts)} ｜ 距离 ${Math.min(sim.segN * sim.SEG, Math.floor(sim.dist))}/${sim.distance} ｜ 分 ${sim.score}`;
    if (s !== hudStr) { hudStr = s; hudEl.textContent = s; }
  }

  const spr = (texKey, x, y) => {
    const s = pool[texKey].pop() || new PIXI.Sprite(tex[texKey]);
    s.texture = tex[texKey]; s.anchor.set(0.5);
    s.position.set(x, y); s.visible = true; s.alpha = 1;
    app.stage.addChild(s);
    return s;
  };

  function sync() {
    if (sim.kind === 'tap') {
      const alive = new Set();
      for (const it of sim.items) {
        alive.add(it.id);
        let s = itemMap.get(it.id);
        if (!s) {
          s = spr(it.decoy ? 'decoy' : 'dot', it.x, it.y);
          s.tint = it.decoy ? 0xffffff : hueInt(it.hue, 72, 56);   /* 池化复用必须重设 tint */
          itemMap.set(it.id, s);
        }
        const age = sim.anim - it.born, pop = Math.min(1, age / 0.12), rr = it.r * (0.6 + 0.4 * pop);
        s.position.set(it.x, it.y); s.width = rr * 2; s.height = rr * 2;
      }
      for (const [id, s] of itemMap) {
        if (!alive.has(id)) { s.visible = false; pool[s.texture === tex.decoy ? 'decoy' : 'dot'].push(s); itemMap.delete(id); }
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const rec = sparks[i];
        if (!sim.popFx.includes(rec.fx)) {
          for (const p of rec.parts) { p.visible = false; pool.spark.push(p); }
          sparks.splice(i, 1);
        }
      }
      for (const fx of sim.popFx) {
        if (!fx._d) {
          fx._d = true;
          const parts = [];
          for (let k = 0; k < fx.sparks.length; k++) {
            const s = spr('spark', fx.x, fx.y); s.tint = hueInt(fx.hue, 80, 60); parts.push(s);
          }
          sparks.push({ fx, parts });
        }
      }
      for (const rec of sparks) {
        const fx = rec.fx, k = fx.t / 0.4;
        for (let j = 0; j < fx.sparks.length; j++) {
          const sp = fx.sparks[j], s = rec.parts[j];
          s.position.set(fx.x + Math.cos(sp.a) * (1 - k) * sp.sp * 0.4, fx.y + Math.sin(sp.a) * (1 - k) * sp.sp * 0.4);
          s.width = 7 * k; s.height = 7 * k; s.alpha = k;
        }
      }
      B.noteEntities(sim.items.length + sim.popFx.length);
    } else {
      const A = sim.area, py = sim.playerY;
      const worldY = (z) => py - (z - sim.dist);
      const z0 = sim.dist - 80, z1 = sim.dist + (A.y + A.h) + 80;
      const s0 = Math.max(0, Math.floor(z0 / sim.SEG)), s1 = Math.min(sim.segN - 1, Math.floor(z1 / sim.SEG));
      const alive = new Set();
      let ents = 0;
      const keyOf = (v) => v === 2 ? 'coin' : (v === 3 ? 'obTall' : 'obLow');
      for (let s = s0; s <= s1; s++) {
        for (let l = 0; l < sim.LANES; l++) {
          const v = sim.lanes[s][l];
          if (!v) continue;
          const key = s + ':' + l;
          const cx = (l + 0.5) * sim.laneW, zc = s * sim.SEG + sim.SEG / 2, y = worldY(zc);
          if (y < A.y - 60 || y > A.y + A.h + 60) continue;
          alive.add(key); ents++;
          const texKey = keyOf(v);
          let img = segMap.get(key);
          if (img && img.texture !== tex[texKey]) { img.visible = false; pool[poolKeyOf(img)].push(img); segMap.delete(key); img = null; }
          if (!img) { img = spr(texKey, cx, y); segMap.set(key, img); }
          else img.position.set(cx, y);
        }
      }
      for (const [key, img] of segMap) {
        if (!alive.has(key)) { img.visible = false; pool[poolKeyOf(img)].push(img); segMap.delete(key); }
      }
      const blink = sim.invuln > 0 && Math.floor(sim.anim * 10) % 2;
      player.position.set(sim.px, py - sim.jumpY); player.alpha = blink ? 0.3 : 1;
      B.noteEntities(ents + 1);
    }
  }
  function poolKeyOf(img) {
    for (const k in tex) if (img.texture === tex[k]) return k;
    return 'dot';
  }

  let overAt = 0, last = performance.now();
  app.ticker.add(() => {
    B.frame(performance.now());
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!sim.done) sim.update(dt);
    else if (!overAt) overAt = now;
    if (overAt && now - overAt > 800) {
      overAt = 0; sim.restarts++; B.restarts = sim.restarts;
      sim.reset();
      if (sim.kind === 'runner') { for (const [k, img] of segMap) { img.visible = false; pool[poolKeyOf(img)].push(img); } segMap.clear(); }
    }
    sync(); hudRender();
    B.simEvents = sim.events;
  });
})();
