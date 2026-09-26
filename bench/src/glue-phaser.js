'use strict';
/* GAMES-24 基准——Phaser 接线层（3.90 / 4.2 共用一份，API 兼容性本身即评估证据）。
 * 口径：canvas 由模板提供；游戏尺寸 = 375×667×DPR（Scale.FIT 进 375×667 舞台 ⇒ CSS 尺寸
 * 375×667、背板 750×1334 @DPR2）；根 Container scale=DPR ⇒ 场景坐标保持逻辑 375×667。
 * （相机 setZoom 方案被否：其缩放锚在视口中心，worldX/worldY 带偏移，输入换算易错——
 *  这个坑本身记入选型报告的"上手成本"证据。）
 * 纹理按 DPR 放大生成 + setDisplaySize 逻辑尺寸（保清晰度平价）。
 * 循环：Phaser update(delta) 内做固定步长累加（判定确定性与原生完全一致）；
 * B.frame 打在 postrender（每呈现帧一次）。 */
(function () {
  const B = window.__BENCH__;
  const dpr = B.dpr;
  const emit = () => { };
  const sim = B.game === 'tap'
    ? R24.makeTap(B.load, 'bench-tap', emit)
    : R24.makeRunner(B.load, 'bench-run', emit);
  B.markSim();

  const W = R24.W, H = R24.H;

  /* hue → 0xRRGGBB（tint 用，与原生 hsl(h,72,56) 视觉近似） */
  function hueInt(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
  }

  class BenchScene extends Phaser.Scene {
    constructor() { super('bench'); }

    create() {
      /* DPR 方案：根 Container 统一 scale=DPR（不用相机 zoom——其缩放锚点是视口中心，
       * worldX/worldY 会带偏移；Container 拓扑对 v3/v4 语义一致且坐标换算只有一层除法）。 */
      this.root = this.add.container(0, 0);
      this.root.setScale(dpr);
      const mk = (key, w, h, draw) => {                    /* 纹理按 DPR 放大生成 */
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        draw(g, dpr);
        g.generateTexture(key, Math.ceil(w * dpr), Math.ceil(h * dpr));
        g.destroy();
      };
      mk('dot', 64, 64, (g, s) => { g.fillStyle(0xffffff); g.fillCircle(32 * s, 32 * s, 32 * s); });
      mk('decoy', 64, 64, (g, s) => {
        g.fillStyle(0x33343a); g.fillCircle(32 * s, 32 * s, 32 * s);
        g.lineStyle(6 * s, 0xff5252); g.beginPath();
        g.moveTo(20 * s, 20 * s); g.lineTo(44 * s, 44 * s); g.moveTo(44 * s, 20 * s); g.lineTo(20 * s, 44 * s); g.strokePath();
      });
      mk('spark', 8, 8, (g, s) => { g.fillStyle(0xffffff); g.fillCircle(4 * s, 4 * s, 4 * s); });
      mk('coin', 26, 26, (g, s) => { g.fillStyle(0xffd54f); g.fillCircle(13 * s, 13 * s, 13 * s); g.lineStyle(2 * s, 0xb8860b); g.strokeCircle(13 * s, 13 * s, 11 * s); });
      mk('obLow', 60, 42, (g, s) => { g.fillStyle(0x7aa5e0); g.fillRoundedRect(0, 0, 60 * s, 42 * s, 8 * s); });
      mk('obTall', 60, 88, (g, s) => { g.fillStyle(0xe05252); g.fillRoundedRect(0, 0, 60 * s, 88 * s, 8 * s); });
      mk('player', 32, 32, (g, s) => { g.fillStyle(0x66f0ff); g.fillCircle(16 * s, 16 * s, 16 * s); g.fillStyle(0x0b0e14); g.fillCircle(16 * s, 16 * s, 7 * s); });

      this.itemMap = new Map();                            /* tap：id → Image（池化） */
      this.pool = { dot: [], decoy: [], spark: [], coin: [], obLow: [], obTall: [] };
      this.segMap = new Map();                             /* runner：seg:lane → Image */
      this._tk = (o) => o.texture.key;                     /* v3/v4 通用的纹理键取法 */

      if (sim.kind === 'runner') {
        const bg = this.make.graphics({ x: 0, y: 0, add: false });
        bg.fillStyle(0x151a26); bg.fillRect(sim.area.x, sim.area.y, sim.area.w, sim.area.h);
        bg.lineStyle(1, 0x12ffffff, 0.07);
        for (let l = 1; l < sim.LANES; l++) { bg.beginPath(); bg.moveTo(l * sim.laneW + 0.5, sim.area.y); bg.lineTo(l * sim.laneW + 0.5, sim.area.y + sim.area.h); bg.strokePath(); }
        this.root.add(bg);
        this.player = this.make.image({ key: 'player', x: 0, y: 0 });
        this.root.add(this.player);
      } else {
        this.sparks = [];                                  /* popFx → 8 spark 组（附着在 fx 对象上） */
      }

      /* ---------- 输入（p.x/p.y 为画布坐标，÷DPR 即逻辑坐标） ---------- */
      this.input.on('pointerdown', (p) => {
        const x = p.x / dpr, y = p.y / dpr;
        if (sim.kind === 'tap') sim.tap(x, y);
        else this._down = { x, y };
      });
      this.input.on('pointerup', (p) => {
        if (sim.kind === 'runner' && this._down) sim.swipe(p.x / dpr - this._down.x, p.y / dpr - this._down.y);
        this._down = null;
      });

      this.game.events.on('postrender', () => B.frame(performance.now()));

      /* ---------- 机器人：决策在页内（确定性），执行由宿主受信输入（CDP mouse）回放 ---------- */
      const BOT_OUT = [];
      sim.onStep = R24.makeBot(sim,
        (x, y) => BOT_OUT.push({ k: 'tap', x, y }),
        (dx, dy) => BOT_OUT.push({ k: 'swipe', dx, dy }));
      window.__BOT_DRAIN__ = () => BOT_OUT.splice(0);

      this.hudEl = document.getElementById('hud');
      this._hudStr = '';
      this._overAt = 0;
      this._last = performance.now();
    }

    upd(dt) {
      if (!sim.done) sim.update(dt);
      else if (!this._overAt) this._overAt = performance.now();
      if (this._overAt && performance.now() - this._overAt > 800) {
        this._overAt = 0; sim.restarts++; B.restarts = sim.restarts;
        sim.reset();
        if (sim.kind === 'runner') { for (const [k, img] of this.segMap) { img.setVisible(false); this.pool[this._tk(img)].push(img); } this.segMap.clear(); }
      }
    }

    update() {
      const now = performance.now();
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this.upd(dt);
      this.sync();
      this.hud();
      B.simEvents = sim.events;
    }

    img(texKey, x, y) {
      let img = this.pool[texKey].pop();
      if (!img) { img = this.make.image({ key: texKey, x, y }); this.root.add(img); }
      img.setTexture(texKey); img.setPosition(x, y); img.setVisible(true); img.setAlpha(1);
      return img;
    }

    sync() {
      if (sim.kind === 'tap') {
        const alive = new Set();
        for (const it of sim.items) {
          alive.add(it.id);
          let img = this.itemMap.get(it.id);
          if (!img) {
            img = this.img(it.decoy ? 'decoy' : 'dot', it.x, it.y);
            img.setTint(it.decoy ? 0xffffff : hueInt(it.hue, 72, 56));   /* 池化复用必须重设 tint */
            this.itemMap.set(it.id, img);
          }
          const age = sim.anim - it.born, pop = Math.min(1, age / 0.12), rr = it.r * (0.6 + 0.4 * pop);
          img.setPosition(it.x, it.y); img.setDisplaySize(rr * 2, rr * 2);
        }
        for (const [id, img] of this.itemMap) {
          if (!alive.has(id)) { img.setVisible(false); this.pool[this._tk(img)].push(img); this.itemMap.delete(id); }
        }
        /* 火花：fx 对象首次见到时挂 8 spark，过期回收 */
        for (let i = this.sparks.length - 1; i >= 0; i--) {
          const rec = this.sparks[i];
          if (!sim.popFx.includes(rec.fx)) {
            for (const s of rec.parts) { s.setVisible(false); this.pool.spark.push(s); }
            this.sparks.splice(i, 1);
          }
        }
        for (const fx of sim.popFx) {
          if (!fx._d) {
            fx._d = true;
            const parts = [];
            for (let k = 0; k < fx.sparks.length; k++) {
              const s = this.img('spark', fx.x, fx.y); s.setTint(hueInt(fx.hue, 80, 60)); parts.push(s);
            }
            this.sparks.push({ fx, parts });
          }
        }
        for (const rec of this.sparks) {
          const fx = rec.fx, k = fx.t / 0.4;
          for (let j = 0; j < fx.sparks.length; j++) {
            const sp = fx.sparks[j], s = rec.parts[j];
            s.setPosition(fx.x + Math.cos(sp.a) * (1 - k) * sp.sp * 0.4, fx.y + Math.sin(sp.a) * (1 - k) * sp.sp * 0.4);
            s.setDisplaySize(7 * k, 7 * k); s.setAlpha(k);
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
        for (let s = s0; s <= s1; s++) {
          for (let l = 0; l < sim.LANES; l++) {
            const v = sim.lanes[s][l];
            if (!v) continue;
            const key = s + ':' + l;
            const cx = (l + 0.5) * sim.laneW, zc = s * sim.SEG + sim.SEG / 2, y = worldY(zc);
            if (y < A.y - 60 || y > A.y + A.h + 60) continue;
            alive.add(key); ents++;
            const texKey = v === 2 ? 'coin' : (v === 3 ? 'obTall' : 'obLow');
            let img = this.segMap.get(key);
            if (img && this._tk(img) !== texKey) { img.setVisible(false); this.pool[this._tk(img)].push(img); this.segMap.delete(key); img = null; }
            if (!img) { img = this.img(texKey, cx, y); this.segMap.set(key, img); }
            else img.setPosition(cx, y);
          }
        }
        for (const [key, img] of this.segMap) {
          if (!alive.has(key)) { img.setVisible(false); this.pool[this._tk(img)].push(img); this.segMap.delete(key); }
        }
        const blink = sim.invuln > 0 && Math.floor(sim.anim * 10) % 2;
        this.player.setPosition(sim.px, py - sim.jumpY).setAlpha(blink ? 0.3 : 1);
        B.noteEntities(ents + 1);
      }
    }

    hud() {
      let s;
      if (sim.kind === 'tap') s = `目标 ${sim.hits}/${sim.target} ｜ 连击 ${sim.combo} ｜ 秒 ${Math.max(0, Math.ceil(sim.timeLeft))} ｜ 分 ${sim.score}`;
      else s = `金币 ${sim.coins} ｜ 命 ${Math.max(0, sim.hearts)} ｜ 距离 ${Math.min(sim.segN * sim.SEG, Math.floor(sim.dist))}/${sim.distance} ｜ 分 ${sim.score}`;
      if (s !== this._hudStr) { this._hudStr = s; this.hudEl.textContent = s; }
    }
  }

  /* 提供既有 canvas 时 Phaser 禁止 AUTO（custom environment 铁则）——自行探测后显式指定 */
  function hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }
  B.extra = { webgl: hasWebGL() };

  new Phaser.Game({
    type: hasWebGL() ? Phaser.WEBGL : Phaser.CANVAS,
    parent: 'stage',
    canvas: document.getElementById('cv'),
    width: W * dpr, height: H * dpr,
    backgroundColor: '#10141d',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    banner: false,
    scene: BenchScene,
  });
})();
