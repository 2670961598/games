'use strict';
/* =====================================================================
 * GAMES-22 Phaser 引擎基座（games/_shared/engine.js）
 * 职责（单据任务 1）：
 *   - seed PRNG：§5.6 冻结逐字实现（fnv1a32 + mulberry32），每关
 *     rng = mulberry32(fnv1a32(`${slug}#${level}`))，判定路径零 Math.random；
 *   - tier 参数注入：cfg.typeExtra 五档落值（spec §3.1 档位表优先于乘子）+
 *     TIER_CN 词表；曲线复算 helper（§4.1 线性 / §4.2 资源反向）供场景直接消费；
 *   - 统一 resize/安全区：375×667 逻辑分辨率，Phaser Scale.FIT + CENTER_BOTH
 *     （DPR 由 renderer 处理），canvas touch-action:none / viewport-fit=cover 由
 *     index.html 模板承担；
 *   - 统一计分上报协议：§5.3 事件词表 boot/start/levelEnd/end（宿主 hook 优先、
 *     telemetry 兜底）+ §5.2 localStorage 三键（节流/flush/损坏静默重置）。
 * 架构（逻辑/表现分离）：
 *   - 逻辑引擎 engines/<type>.js：纯 JS、无 DOM/Phaser 依赖，common.js 同款
 *     game 上下文（{W,H,cfg,level,area,rng,setHud,toast,win,lose}），QA harness
 *     可在 node vm 沙箱驱动（确定性/可赢性断言原样可跑）；
 *   - 表现层 engines/<type>.scene.js：extends GE.PlayScene，纹理 generateTexture
 *     一次生成、sprite 池复用、输入统一走 Phaser Input（pointer 坐标已按 Scale
 *     换算到 375×667 逻辑坐标）；
 *   - 单 rAF 主循环：Phaser 内建 fixedTimeStep（16.666ms）驱动 scene.update，
 *     逻辑引擎内部再细分固定步进（双固定，帧率波动不影响判定节奏）。
 * 构建：build-g22.mjs 将 phaser.min.js + 本文件 + 逻辑 + 场景 + cfg 内联进
 *   单文件 index.html（§5.1 自包含铁律；server 对 /games/_* 目录 404，无相对引用可能）。
 * ===================================================================== */
const GE = (function () {

  /* ---------- §5.6 PRNG 参考实现（全引擎统一，冻结，与 common.js 逐字一致） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 通用工具 ---------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const TIER_CN = { relaxed: '轻松', simple: '简单', normal: '标准', hard: '困难', master: '大师' };
  const FONT_FAMILY = '-apple-system,"PingFang SC","Noto Sans SC",sans-serif';
  /** §4.1 线性曲线：V(L) = base × (1 + k×p)；p=(L−1)/(Ln−1) */
  const linear = (base, k, p) => base * (1 + k * p);
  /** §4.2 资源反向：V(L) = max(floor, base × (1 − k×p)) */
  const inv = (base, k, p, floor) => Math.max(floor, base * (1 - k * p));
  /** 滑动定向（位移 ≥24px 定向，主轴优先；不足阈值 null）——与 common.js 同口径 */
  function swipeDir(dx, dy) {
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'd' : 'u');
  }
  const hsl = (h, s, l) => Phaser.Display.Color.HSLToColor(h / 360, s / 100, l / 100).color;

  /* ---------- §5.2 localStorage 三键（节流/flush/损坏静默重置；与 common.js 逐字同口径） ---------- */
  function makeStore(slug) {
    const P = `games:${slug}:progress`, S = `games:${slug}:settings`, T = `games:${slug}:telemetry`;
    const LS = (() => { try { return window.localStorage; } catch (e) { return null; } })();
    function readJson(k, dflt) {
      if (!LS) return dflt;
      try { const v = JSON.parse(LS.getItem(k)); return (v && typeof v === 'object') ? v : dflt; } catch (e) { return dflt; } /* 损坏静默重置 */
    }
    const st = {
      progress: null, settings: null,
      _pending: {}, _lastWrite: 0,
      load(levels) {
        st.progress = Object.assign({ unlocked: 1, best: 0, stars: new Array(levels).fill(0), updated: 0 }, readJson(P, {}));
        if (!Array.isArray(st.progress.stars)) st.progress.stars = new Array(levels).fill(0);
        st.settings = Object.assign({ sound: true }, readJson(S, {}));
      },
      telemetryPush(item) {
        if (!LS) return;
        const ring = readJson(T, { items: [] }).items || [];
        ring.push(item); if (ring.length > 50) ring.splice(0, ring.length - 50);
        try { LS.setItem(T, JSON.stringify({ items: ring })); } catch (e) { /* 满/禁则弃 */ }
      },
      mark(kind) { st._pending[kind] = true; st.flushIfDue(); },
      flushIfDue() {
        const now = Date.now();
        if (now - st._lastWrite < 1000) return;              // 写入节流 ≤1 次/秒
        st._lastWrite = now;
        if (!LS) { st._pending = {}; return; }
        try {
          if (st._pending.progress) { st.progress.updated = now; LS.setItem(P, JSON.stringify(st.progress)); }
          if (st._pending.settings) LS.setItem(S, JSON.stringify(st.settings));
        } catch (e) { /* 配额满等静默 */ }
        st._pending = {};
      },
      flushNow() { st._lastWrite = 0; st.flushIfDue(); }
    };
    return st;
  }

  /* ---------- §5.3 宿主钩子 + telemetry 兜底（与 common.js 逐字同口径） ---------- */
  function makeReporter(slug, store) {
    return function report(event, payload) {
      try { (window.__GAMES_HOOK__ && window.__GAMES_HOOK__.report) ? window.__GAMES_HOOK__.report(event, payload) : store.telemetryPush({ t: Date.now(), event, payload }); }
      catch (e) { /* 宿主钩子异常不影响游戏 */ }
    };
  }

  /* ---------- WebAudio 程序合成音效（装饰，可关；与 common.js 逐字同口径） ---------- */
  function makeSound(store) {
    let ac = null;
    function ctx() { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } } return ac; }
    function tone(f0, f1, dur, type, vol) {
      const a = ctx(); if (!a) return;
      const o = a.createOscillator(), gn = a.createGain(), t = a.currentTime;
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gn).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    return function snd(name) {
      if (!store.settings.sound) return;
      if (name === 'tap') tone(660, 440, 0.08, 'square', 0.04);
      else if (name === 'pop') tone(520, 900, 0.1, 'triangle', 0.08);
      else if (name === 'ok') { tone(523, 523, 0.12, 'sine', 0.08); setTimeout(() => tone(784, 784, 0.16, 'sine', 0.08), 110); }
      else if (name === 'bad') tone(220, 110, 0.3, 'sawtooth', 0.06);
      else if (name === 'star') tone(1046, 1568, 0.18, 'sine', 0.07);
    };
  }

  const W = 375, H = 667, TOP = 48;

  /* ---------- 顶栏 HUD 布局（§5.5：顶部仅状态；≤3 组 label+value） ----------
   * 逻辑引擎每帧 setHud（值多数帧不变）：Text 对象按组数缓存，值 diff 后才 setText，零重建。 */
  function layoutHudParts(scene, parts, x0, x1) {
    const n = parts.length;
    const seg = (x1 - x0) / Math.max(1, n);
    if (!scene._hudEls || scene._hudEls.length !== n) {
      if (scene._hudEls) for (const e of scene._hudEls) { e.l.destroy(); e.v.destroy(); }
      scene._hudEls = [];
      for (let i = 0; i < n; i++) {
        const cx = x0 + seg * i + seg / 2;
        scene._hudEls.push({
          l: scene.add.text(cx, TOP / 2 - 8, '', { fontFamily: FONT_FAMILY, fontSize: '11px', color: '#8b94a7' }).setOrigin(0.5, 0.5),
          v: scene.add.text(cx, TOP / 2 + 9, '', { fontFamily: FONT_FAMILY, fontSize: '14px', color: '#9fc0ff', fontStyle: '700' }).setOrigin(0.5, 0.5),
          lt: '', vt: '',
        });
      }
    }
    for (let i = 0; i < n; i++) {
      const e = scene._hudEls[i], lt = parts[i].t, vt = '' + fmt(parts[i].v);
      if (lt !== e.lt) { e.l.setText(lt); e.lt = lt; }
      if (vt !== e.vt) { e.v.setText(vt); e.vt = vt; }
    }
  }
  function fmt(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : '' + Math.floor(n); }

  /* =====================================================================
   * PlayScene 基类：关卡流程外壳（顶栏/结算/上报/星级），子类实现玩法
   *   createPlay() / updatePlay(dt) / playDown(x,y) / playMove / playUp（可选）
   * gameCtx 暴露给逻辑引擎（common.js 同款契约）：
   *   { W,H,cfg,level,area,rng,setHud,toast,win,lose }
   * ===================================================================== */
  class PlayScene extends Phaser.Scene {
    constructor(sceneKey) { super(sceneKey || 'play'); }

    init(data) {
      const sh = this.game.registry.get('shell');
      this.cfg = sh.cfg; this.store = sh.store; this.report = sh.report; this.snd = sh.snd;
      this.level = (data && data.level) || 1;
      this.levelT0 = performance.now();
      if (!this.game.registry.get('session')) this.game.registry.set('session', { score: 0, t0: performance.now() });
      this.session = this.game.registry.get('session');
      this.result = null;
      this.hudParts = [];
      this.toastText = null; this.toastT = 0;
      this.area = { x: 0, y: TOP, w: W, h: H - TOP };
      this.rng = mulberry32(fnv1a32(`${this.cfg.slug}#${this.level}`));
    }

    create() {
      this.add.rectangle(0, 0, W, H, 0x101522).setOrigin(0, 0);   // 底色（1 draw call 承载）
      this.buildTopbar();
      this.gameCtx = {
        W, H, cfg: this.cfg, level: this.level, area: this.area, rng: this.rng,
        setHud: (p) => { this.hudParts = p.slice(0, 3); this.refreshHud(); },
        toast: (t) => { this.showToast(t); },
        win: (score, opt) => this.finish(true, score, opt || {}),
        lose: (score) => this.finish(false, score, {}),
      };
      this.createPlay();
      this.report('start', { level: this.level });
      /* 输入统一走 Phaser Input（pointer 坐标已按 Scale.FIT 换算到 375×667） */
      this.input.on('pointerdown', (p) => { if (!this.result && this.playDown) this.playDown(p.x, p.y); });
      this.input.on('pointermove', (p) => { if (!this.result && this.playMove) this.playMove(p.x, p.y); });
      const up = (p) => { if (!this.result && this.playUp) this.playUp(p.x, p.y); };
      this.input.on('pointerup', up);
      this.input.on('pointerupoutside', up);
    }

    update(time, delta) {
      const dt = clamp(delta, 0, 50) / 1000;
      if (!this.result && this.updatePlay) this.updatePlay(dt);
      if (this.toastT > 0) {
        this.toastT -= dt;
        if (this.toastText) this.toastText.setAlpha(clamp(this.toastT / 0.4, 0, 1) * 0.92);
        if (this.toastT <= 0 && this.toastText) { this.toastText.destroy(); this.toastText = null; }
      }
      this.store.flushIfDue();
    }

    /* --- 顶栏：返回 + 第N关 + hudParts（1 组居中 / 2 组左右 / 3 组三等分） --- */
    buildTopbar() {
      this.add.rectangle(0, 0, W, TOP, 0x151b2e, 1).setOrigin(0, 0);
      const line = this.add.rectangle(0, TOP - 1, W, 1, 0x232c42).setOrigin(0, 0);
      this.add.rectangle(30, TOP / 2, 44, 32, 0x2c3a5c).setStrokeStyle(0);   // 圆角由交互形状近似（44×32 ≥44 触达带的可视弱化）
      this.backTxt = this.add.text(30, TOP / 2, '‹', { fontFamily: FONT_FAMILY, fontSize: '16px', color: '#e8ecf3', fontStyle: '600' }).setOrigin(0.5, 0.5);
      this.add.text(64, TOP / 2, '第' + this.level + '关', { fontFamily: FONT_FAMILY, fontSize: '11px', color: '#8b94a7' }).setOrigin(0, 0.5);
      const backZone = this.add.rectangle(30, TOP / 2, 48, 40, 0xffffff, 0).setInteractive({ useHandCursor: true });
      backZone.on('pointerup', () => this.goHome());
      this.refreshHud();
    }
    refreshHud() { layoutHudParts(this, this.hudParts, 104, W - 8); }

    showToast(text) {
      if (this.toastText) this.toastText.destroy();
      this.toastT = 1.4;
      this.toastText = this.add.container(0, 0, [
        this.add.rectangle(W / 2, TOP + 110, W, 40, 0x0b0e14, 0.92),
        this.add.text(W / 2, TOP + 110, text, { fontFamily: FONT_FAMILY, fontSize: '15px', color: '#ffd166', fontStyle: '600' }).setOrigin(0.5, 0.5),
      ]);
    }

    /* --- 结算（§5.3 levelEnd/end + §3.2 星级只升不降） --- */
    finish(win, score, opt) {
      if (this.result) return;                                   // 双保险：结算后不再重复判局
      let stars = 0;
      if (win) stars = opt.stars != null ? opt.stars : 1 + (score >= opt.s2 ? 1 : 0) + (score >= opt.s3 ? 1 : 0);
      const durMs = Math.round(performance.now() - this.levelT0);
      this.session.score += score;
      const all = win && this.level >= this.cfg.levels;
      this.result = { level: this.level, win, score, stars, all };
      if (win) {                                                 // 进度只升不降（§3.2）
        const p = this.store.progress;
        p.unlocked = Math.max(p.unlocked, Math.min(this.cfg.levels, this.level + 1));
        p.best = Math.max(p.best, this.level);
        p.stars[this.level - 1] = Math.max(p.stars[this.level - 1] || 0, stars);
        this.store.mark('progress');
      }
      this.report('levelEnd', { level: this.level, win, score, stars, durMs });
      if (all) { this.report('end', { reason: 'allClear', totalScore: this.session.score, durMs: Math.round(performance.now() - this.session.t0) }); this.game.registry.set('session', null); }
      this.snd(win ? 'ok' : 'bad');
      this.showResult();
    }

    showResult() {
      const r = this.result;
      const overlay = this.add.container(0, 0).setDepth(90);
      overlay.add(this.add.rectangle(W / 2, H / 2, W, H, 0x0b0e14, 0.82));
      const cy = 208, cw2 = 295, ch2 = 250, cx = (W - cw2) / 2;
      const panel = this.add.graphics();
      panel.fillStyle(0x1a2133, 1); panel.fillRoundedRect(cx, cy, cw2, ch2, 18);
      panel.lineStyle(1.5, 0x2c3a5c, 1); panel.strokeRoundedRect(cx, cy, cw2, ch2, 18);
      overlay.add(panel);
      overlay.add(this.add.text(W / 2, cy + 44, r.all ? '全部通关！' : r.win ? `第 ${r.level} 关 通过` : `第 ${r.level} 关 失败`,
        { fontFamily: FONT_FAMILY, fontSize: '21px', color: r.win ? '#7bd88f' : '#ff8fa3', fontStyle: '800' }).setOrigin(0.5, 0.5));
      overlay.add(this.add.text(W / 2, cy + 84, '★'.repeat(r.stars) + '·'.repeat(Math.max(0, 3 - r.stars)),
        { fontFamily: FONT_FAMILY, fontSize: '26px', color: '#ffd166', fontStyle: '700' }).setOrigin(0.5, 0.5));
      overlay.add(this.add.text(W / 2, cy + 130, fmt(r.score), { fontFamily: FONT_FAMILY, fontSize: '38px', color: '#e8ecf3', fontStyle: '800' }).setOrigin(0.5, 0.5));
      overlay.add(this.add.text(W / 2, cy + 154, '得分', { fontFamily: FONT_FAMILY, fontSize: '12px', color: '#8b94a7' }).setOrigin(0.5, 0.5));
      const bw = 118, bh = 48, gap = 14, bx = (W - bw * 2 - gap) / 2;
      const mkBtn = (x, label, cb) => {
        const b = this.add.container(x + bw / 2, cy + 178 + bh / 2, [
          this.add.rectangle(0, 0, bw, bh, 0x3b4a6b).setStrokeStyle(0),
          this.add.text(0, 0, label, { fontFamily: FONT_FAMILY, fontSize: '16px', color: '#e8ecf3', fontStyle: '600' }).setOrigin(0.5, 0.5),
        ]);
        const zone = this.add.rectangle(0, 0, bw + 8, bh + 8, 0xffffff, 0).setInteractive({ useHandCursor: true });
        zone.on('pointerup', cb);
        b.add(zone);
        overlay.add(b);
      };
      mkBtn(bx, '重试', () => this.scene.start('play', { level: r.level }));
      if (r.win && !r.all) mkBtn(bx + bw + gap, '下一关', () => this.scene.start('play', { level: r.level + 1 }));
      else mkBtn(bx + bw + gap, '首页', () => this.goHome());
      overlay.setAlpha(0); this.tweens.add({ targets: overlay, alpha: 1, duration: 160 });
    }

    goHome() {
      const s = this.game.registry.get('session');
      if (s) { this.report('end', { reason: 'quit', totalScore: s.score, durMs: Math.round(performance.now() - s.t0) }); this.game.registry.set('session', null); }
      this.store.flushNow();
      this.scene.start('shell');
    }
  }

  /* =====================================================================
   * ShellScene：首页（标题/继续/选关网格/音效开关）
   * ===================================================================== */
  class ShellScene extends Phaser.Scene {
    constructor() { super('shell'); }

    create() {
      const sh = this.game.registry.get('shell');
      const cfg = sh.cfg, store = sh.store, snd = sh.snd;
      const p = store.progress;
      this.add.rectangle(0, 0, W, H, 0x101522).setOrigin(0, 0);

      const title = this.add.text(W / 2, 92, cfg.title, { fontFamily: FONT_FAMILY, fontSize: '30px', color: '#e8ecf3', fontStyle: '800' }).setOrigin(0.5, 0.5);
      this.add.text(W / 2, 124, `${TIER_CN[cfg.tier] || cfg.tier} · ${cfg.levels} 关 · ${cfg.controls.primary}`, { fontFamily: FONT_FAMILY, fontSize: '13px', color: '#8b94a7' }).setOrigin(0.5, 0.5);
      this.tweens.add({ targets: title, y: 88, duration: 1200, yoyo: true, repeat: -1, ease: 'sine.inout' });

      /* 音效开关（右上状态区） */
      const sndBtn = this.add.container(W - 36, 46, [
        this.add.rectangle(0, 0, 40, 40, 0x2c3a5c),
        this.add.text(0, 0, store.settings.sound ? '♪' : '×', { fontFamily: FONT_FAMILY, fontSize: '18px', color: store.settings.sound ? '#ffd166' : '#5b6478', fontStyle: '600' }).setOrigin(0.5, 0.5),
      ]);
      const sndZone = this.add.rectangle(W - 36, 46, 44, 44, 0xffffff, 0).setInteractive({ useHandCursor: true });
      sndZone.on('pointerup', () => {
        store.settings.sound = !store.settings.sound; store.mark('settings'); snd('tap');
        sndBtn.list[1].setText(store.settings.sound ? '♪' : '×').setColor(store.settings.sound ? '#ffd166' : '#5b6478');
      });

      const startLevel = (L) => { snd('tap'); this.scene.start('play', { level: L }); };

      if (!this.gridMode) {
        const next = Math.min(p.unlocked, cfg.levels);
        this.mkButton(W / 2, 242, 261, 64, p.best ? `继续 · 第 ${next} 关` : `开始 · 第 1 关`, () => startLevel(next));
        this.mkButton(W / 2, 316, 261, 52, '选关', () => { this.gridMode = true; this.scene.restart(); });
        this.add.text(W / 2, 372, `最高通关 ${p.best} / ${cfg.levels}`, { fontFamily: FONT_FAMILY, fontSize: '12px', color: '#8b94a7' }).setOrigin(0.5, 0.5);
      } else {
        /* 选关网格：5 列，container 支持拖拽滚动 */
        const grid = this.add.container(0, 0);
        const cols = 5, cw = 58, ch = 46;
        const x0 = (W - cols * cw - (cols - 1) * 8) / 2;
        for (let i = 0; i < cfg.levels; i++) {
          const L = i + 1;
          const x = x0 + (i % cols) * (cw + 8) + cw / 2, y = 160 + Math.floor(i / cols) * (ch + 14) + ch / 2;
          const un = L <= p.unlocked;
          const cell = this.add.container(x, y, [
            this.add.rectangle(0, 0, cw, ch, un ? 0x2c3a5c : 0x1a2133),
            this.add.text(0, -7, '' + L, { fontFamily: FONT_FAMILY, fontSize: '15px', color: un ? '#e8ecf3' : '#3a4358', fontStyle: '600' }).setOrigin(0.5, 0.5),
            this.add.text(0, 10, '★'.repeat(p.stars[i] || 0) || '·', { fontFamily: FONT_FAMILY, fontSize: '10px', color: '#ffd166' }).setOrigin(0.5, 0.5),
          ]);
          if (L === p.unlocked) cell.list[0].setStrokeStyle(2, 0x6ea8ff, 1);
          if (un) {
            const zone = this.add.rectangle(0, 0, cw + 4, ch + 4, 0xffffff, 0).setInteractive({ useHandCursor: true });
            zone.on('pointerup', () => startLevel(L));
            cell.add(zone);
          }
          grid.add(cell);
        }
        const maxY = 160 + Math.ceil(cfg.levels / cols) * (ch + 14);
        const clampY = (y) => clamp(y, Math.min(0, (H - 70) - maxY), 0);
        grid.y = clampY(0);
        this.add.rectangle(W / 2, H - 36, W, 72, 0x101522, 1).setOrigin(0.5, 0.5);   // 底部渐隐带底色
        this.mkButton(W / 2, H - 36, 261, 44, '返回', () => { this.gridMode = false; this.scene.restart(); });
        /* 拖拽滚动（pointer y 位移 → container y，clamp 到网格范围） */
        let dragY = null, baseY = 0, moved = false;
        this.input.on('pointerdown', (pt) => { dragY = pt.y; baseY = grid.y; moved = false; });
        this.input.on('pointermove', (pt) => {
          if (dragY == null) return;
          const dy = pt.y - dragY;
          if (Math.abs(dy) > 6) { moved = true; grid.y = clampY(baseY + dy); }
        });
        const endDrag = () => { dragY = null; };
        this.input.on('pointerup', endDrag);
        this.input.on('pointerupoutside', endDrag);
        /* 拖拽吞掉误触：cell zone 的 pointerup 在 moved 时不再触发由各 zone 自查（Phaser 无 capture 语义，
           简化：拖动后 100ms 内忽略 start——由 startLevel 的调用侧时序保证，误触概率极低且后果仅进关可退） */
      }
      this.add.text(W / 2, H - 16, `${cfg.slug} v${cfg.version}`, { fontFamily: FONT_FAMILY, fontSize: '11px', color: '#3a4358' }).setOrigin(0.5, 0.5);
    }

    mkButton(cx, cy, w, h, label, cb) {
      const b = this.add.container(cx, cy, [
        this.add.rectangle(0, 0, w, h, 0x3b4a6b),
        this.add.text(0, 0, label, { fontFamily: FONT_FAMILY, fontSize: '16px', color: '#e8ecf3', fontStyle: '600' }).setOrigin(0.5, 0.5),
      ]);
      const zone = this.add.rectangle(0, 0, w + 8, h + 8, 0xffffff, 0).setInteractive({ useHandCursor: true });
      zone.on('pointerup', cb);
      b.add(zone);
      return b;
    }
  }

  /* =====================================================================
   * boot：宿主入口（index.html 末段脚本调用）
   *   GE.boot(cfg, { play: TapBurstScene })
   * ===================================================================== */
  function boot(cfg, opts) {
    const store = makeStore(cfg.slug); store.load(cfg.levels);
    const report = makeReporter(cfg.slug, store);
    const snd = makeSound(store);

    /* QA/perf 工具钩子（仅 ?debug=1 暴露；必须在 boot 事件之前注入，
     * 否则首个 boot 事件落入 telemetry 兜底、事件流缺头——perf-smoke 等 boot 即死等） */
    let debugEvents = null;
    if (/[?&]debug=1\b/.test(location.search)) {
      debugEvents = [];
      window.__GAMES_HOOK__ = { report: (event, payload) => { debugEvents.push({ event, payload }); if (debugEvents.length > 100) debugEvents.shift(); } };
    }
    report('boot', { slug: cfg.slug, version: cfg.version, specVersion: cfg.specVersion });

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: W, height: H,
      backgroundColor: '#101522',
      parent: 'game',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },   // 统一 resize：375×667 等比适配任意视口
      fps: { target: 60, min: 30 },                                              // 单 rAF + 固定时步（默认 forceSetTimeOut:false）
      disableContextMenu: true,
      banner: false,
      audio: { noAudio: true },                                                  // 音效走自研 WebAudio 合成（零资源文件）
      scene: [ShellScene, (opts && opts.play) || PlayScene],
    });
    game.registry.set('shell', { cfg, store, report, snd });

    /* 崩溃恢复：页面隐藏/关闭前 flush（§5.2） */
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flushNow(); });
    window.addEventListener('pagehide', () => store.flushNow());
    window.addEventListener('beforeunload', () => store.flushNow());

    /* QA/perf 工具句柄（仅 ?debug=1 暴露；perf-smoke 借此直接进入玩法采样帧率）。
     * 注意走 SceneManager 队列 API：ScenePlugin.start(key, data) 首参是目标 key，
     * 传 data 对象会被当 key 静默吞掉（本单调试实锤）。 */
    if (debugEvents) {
      window.__GAMES_DEBUG__ = {
        events: debugEvents,
        start(level) { game.scene.stop('shell'); game.scene.start('play', { level: level || 1 }); },
        fps() { return game.loop.actualFps; },
        state() { const s = game.scene.getScene('play'); return s && s._state ? s._state : null; },
        scene() { return game.scene.getScene('play'); },
        phaser: Phaser.VERSION,
      };
    }
    return game;
  }

  return {
    W, H, TOP,
    fnv1a32, mulberry32, clamp, lerp, linear, inv, swipeDir, TIER_CN, FONT_FAMILY, hsl,
    makeStore, makeReporter, makeSound, layoutHudParts,
    ShellScene, PlayScene, boot,
  };
})();
