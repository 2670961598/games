'use strict';
/* =====================================================================
 * GAMES 原生基座 GE（games/_shared/engine.js）——GAMES-30
 * 来源：GAMES-24 选型报告结论（原生 Canvas + 结构化基线胜出 4.85/5），以 bench/
 *      结构化基线（外壳+固定步长+PRNG，bench/src/glue-native.js）为蓝本产品化，零外部引擎依赖。
 * 职责（单据任务 2 的四件套）：
 *   - seed PRNG：§5.6 冻结逐字实现（fnv1a32 + mulberry32），每关
 *     rng = mulberry32(fnv1a32(`${slug}#${level}`))，判定路径零 Math.random；
 *   - tier 参数注入：cfg.typeExtra 五档落值解包 + TIER_CN 词表 + 曲线复算 helper
 *     （§4.1 线性 lin / §4.2 资源反向 inv）供引擎直接消费；
 *   - 375×667 安全区词表：W/H/TOP 常量 + fit()（DPR 夹 1..3、安全区 inset 扣减）
 *     + toXY() 坐标换算 + area() 游戏区矩形；
 *   - 统一计分上报协议：§5.3 事件词表 boot/start/levelEnd/end/perf（宿主 hook 优先、
 *     telemetry 兜底）+ §5.2 localStorage 三键（节流/flush/损坏静默重置）。
 * 引擎契约（与 common.js 逐字兼容，QA harness 原样可驱动）：
 *   engineFactory(game) → { startLevel, update(dt), render(g), onDown, onMove, onUp, __state? }
 *   game = { W, H, cfg, level, area, rng, setHud([{t,v}]≤3), toast(text), win(score,opt), lose(score) }
 * §7.2.A 强化清单落地（GAMES-24 报告 D 阶段输入）：
 *   A1 静态层离屏缓存：GE.layer() 一次成图、主循环只 blit（bench 已证明可行）；
 *   A2 粒子并发上限：由各引擎按池语义自限（见 tap-burst MAX_FX）；
 *   A3 帧预算监控进 telemetry：long17 口径照搬 bench（帧间隔>17.5ms），滚动窗 p95>18ms 告警；
 *   A4 HUD 脏检查写：值变才 fillText（修复 common.js 只画 1/2 组的历史缺陷，三组三等分）。
 * ?debug=1 QA 钩子：window.__GAMES_DEBUG__ = { events, start(level), state(), fps(), perf() }
 *   —— 与 GAMES-22 口径同形（perf-smoke 零改动可跑）；boot 事件在钩子注入后才上报（沉淀 183-87）。
 * 构建：build-g30.mjs 将本文件与 CONFIG + 逻辑引擎 + boot 调用内联进单文件 index.html
 *   （§5.1 自包含铁律；server 对 /games/_* 一律 404，无相对引用可能）。
 * ===================================================================== */
const GE = (function () {

  /* ---------- §5.6 PRNG 参考实现（全引擎统一，冻结，与 common.js 逐字一致） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 通用工具 ---------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const TIER_CN = { relaxed: '轻松', simple: '简单', normal: '标准', hard: '困难', master: '大师' };
  const FONT = (px, w) => `${w || 400} ${px}px -apple-system,"PingFang SC","Noto Sans SC",sans-serif`;
  /** 滑动定向（§12：位移 ≥24px 定向，主轴优先）。不足阈值返回 null。 */
  function swipeDir(dx, dy) {
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'd' : 'u');
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  /* ---------- tier 参数注入（§3.1 档位表落值优先于乘子） ---------- */
  /** 曲线进度 p=(L−1)/(Ln−1)。 */
  function prog(level, levels) { return levels > 1 ? (level - 1) / (levels - 1) : 0; }
  /** §4.1 线性曲线：base×(1+k·p)（threat 递增用）。 */
  const lin = (base, k, p) => base * (1 + k * p);
  /** §4.2 资源反向曲线：base×(1−k·p)（资源递减用，下限 0）。 */
  const inv = (base, k, p) => Math.max(0, base * (1 - k * p));
  /** tier 解包：typeExtra 五档落值 + 曲线进度一并交给引擎。 */
  function tier(cfg, level) {
    return { extra: Object.assign({}, cfg.typeExtra || {}), p: prog(level, cfg.levels), cn: TIER_CN[cfg.tier] || cfg.tier };
  }

  /* ---------- 375×667 安全区词表（§5.4 竖屏逻辑分辨率） ---------- */
  const W = 375, H = 667, TOP = 48;
  const area = () => ({ x: 0, y: TOP, w: W, h: H - TOP });
  /** 刘海/圆角 inset（viewport-fit=cover 时 env() 生效；取不到按 0）。 */
  function safeInsets() {
    try {
      const cs = window.getComputedStyle && window.getComputedStyle(document.documentElement);
      if (!cs) return { t: 0, r: 0, b: 0, l: 0 };
      const px = (v) => Math.max(0, parseFloat(v) || 0);
      return { t: px(cs.getPropertyValue('env(safe-area-inset-top)')), r: px(cs.getPropertyValue('env(safe-area-inset-right)')), b: px(cs.getPropertyValue('env(safe-area-inset-bottom)')), l: px(cs.getPropertyValue('env(safe-area-inset-left)')) };
    } catch (e) { return { t: 0, r: 0, b: 0, l: 0 }; }
  }
  /** 外壳 resize：等比缩放夹进（视口−安全区），DPR 夹 1..3。 */
  function fit(cvs) {
    const ins = safeInsets();
    const vw = Math.max(0, window.innerWidth - ins.l - ins.r), vh = Math.max(0, window.innerHeight - ins.t - ins.b);
    const s = Math.min(vw / W, vh / H), dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    cvs.style.width = (W * s) + 'px'; cvs.style.height = (H * s) + 'px';
    cvs.width = Math.round(W * s * dpr); cvs.height = Math.round(H * s * dpr);
    return s * dpr;                                        /* 供 setTransform 用 */
  }
  /** 指针事件 → 375×667 逻辑坐标。 */
  function toXY(cvs, e) {
    const r = cvs.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  }

  /* ---------- §5.3 宿主钩子 + telemetry 兜底 ---------- */
  function makeReporter(slug, store) {
    return function report(event, payload) {
      try { (window.__GAMES_HOOK__ && window.__GAMES_HOOK__.report) ? window.__GAMES_HOOK__.report(event, payload) : store.telemetryPush({ t: Date.now(), event, payload }); }
      catch (e) { /* 宿主钩子异常不影响游戏 */ }
    };
  }

  /* ---------- §5.2 localStorage 三键（节流/flush/损坏静默重置） ---------- */
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

  /* ---------- WebAudio 程序合成音效（装饰，可关） ---------- */
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

  /* ---------- §7.2.A.1 静态层离屏缓存 ----------
   * 不变层（背景/车道线等）一次成图，主循环 drawImage blit（bench 已证明可行）。
   * 内部 2x 采样保证 DPR2 下线条锐利；无 document.createElement 环境（vm 桩）回退直绘。 */
  function layer(w, h, draw) {
    let cvs = null;
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        cvs = document.createElement('canvas');
        cvs.width = Math.max(1, Math.round(w * 2)); cvs.height = Math.max(1, Math.round(h * 2));
        const g = cvs.getContext('2d');
        if (!g) { cvs = null; }
        else { g.scale(2, 2); draw(g); }                     /* 逻辑坐标绘制 */
      }
    } catch (e) { cvs = null; }
    return {
      ok: !!cvs,
      /** blit 到逻辑矩形（目标 ctx 已带缩放变换）；不可用返回 false 由调用方直绘。 */
      blit(target, x, y, ww, hh) { if (cvs) { target.drawImage(cvs, x, y, ww, hh); return true; } return false; },
    };
  }

  /* ---------- 画布外壳 + 关卡流程（boot 入口；契约同 common.js） ---------- */
  function boot(cfg, engineFactory) {
    const cvs = document.getElementById('cv'), g = cvs.getContext('2d');
    let scale = 1;
    function refit() { scale = fit(cvs); }
    refit();
    window.addEventListener('resize', refit);

    const store = makeStore(cfg.slug); store.load(cfg.levels);
    const report = makeReporter(cfg.slug, store);
    const snd = makeSound(store);

    /* --- 会话与关卡状态 --- */
    let screen = 'home';            // home | play
    let engine = null, curLevel = 1, hudParts = [];
    let toast = { text: '', t: 0 };
    let result = null;              // {level,win,score,stars,next,all}
    let session = null;             // {score, t0} → end 事件
    let homeScroll = 0, gridMode = false, dragFrom = null;
    let levelT0 = performance.now();

    /* --- §7.2.A.3 帧预算监控（long17 口径照搬 bench：帧间隔>17.5ms） --- */
    const RING = 300;               // 滚动窗 ≈5s @60fps
    const gaps = new Float32Array(RING);
    let gapN = 0, gapHead = 0, lastFrameT = 0;
    let long17 = 0, p95WarnedAt = 0;
    function noteFrame(t) {
      if (lastFrameT) {
        const d = t - lastFrameT;
        if (gapN < RING) { gaps[gapHead] = d; gapHead = (gapHead + 1) % RING; gapN++; }
        else { gaps[gapHead] = d; gapHead = (gapHead + 1) % RING; }
        if (d > 17.5) long17++;
        if (screen === 'play' && !result && t - p95WarnedAt > 5000 && gapN >= 60) {
          p95WarnedAt = t;
          const sorted = Array.from(gaps.subarray(0, gapN)).sort((a, b) => a - b);
          const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
          if (p95 > 18) report('perf', { warn: true, p95Ms: +p95.toFixed(1), long17, slug: cfg.slug });  // 帧预算告警（遥测留痕，不打断玩法）
        }
      }
      lastFrameT = t;
    }
    function perfStat() {
      const sorted = Array.from(gaps.subarray(0, gapN)).sort((a, b) => a - b);
      const q = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : null;
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        frames: gapN, long17,
        long17R: gapN ? +(long17 / gapN).toFixed(4) : null,
        p95Ms: q(0.95), avgFrameMs: sorted.length ? +(sum / sorted.length).toFixed(1) : null,
        inputN: inputN, inputMaxMs: inputMaxMs ? +inputMaxMs.toFixed(1) : null,
        inputAvgMs: inputN ? +(inputSum / inputN).toFixed(1) : null,
      };
    }

    /* --- 输入延迟（质量红线：输入→呈现 <100ms；事件 timeStamp → 下一呈现帧） --- */
    const inputTs = [];
    let inputN = 0, inputMaxMs = 0, inputSum = 0;
    function noteInput(ts) { if (ts > 0) inputTs.push(ts); }

    /* --- ?debug=1 QA 钩子（先注入后 report('boot')，见沉淀 183-87） --- */
    const debugEvents = [];
    let debugOn = false;
    let paused = false;                                       // QA 暂停：截图等 CDP 停顿期间冻结引擎时序（E2E 确定性）
    try { debugOn = /(^|&)debug=1/.test((window.location && window.location.search || '').slice(1)); } catch (e) { debugOn = false; }
    if (debugOn) {
      window.__GAMES_DEBUG__ = {
        events: debugEvents,
        start(level) { startLevel(level || 1); },
        pause(v) { paused = !!v; },                           // 冻结/恢复引擎时序（渲染继续；QA 截图用）
        fps() { const s = perfStat(); return s.avgFrameMs ? +(1000 / s.avgFrameMs).toFixed(1) : null; },
        state() {
          return { screen, level: curLevel, tier: cfg.tier, hud: hudParts, result: result && { level: result.level, win: result.win, score: result.score, stars: result.stars }, engine: engine && engine.__state ? engine.__state() : null };
        },
        perf() { return perfStat(); },
        base: 'native',
      };
    }
    const dbg = (event, payload) => { if (debugOn) debugEvents.push({ t: Date.now(), event, payload }); };
    const report2 = (event, payload) => { dbg(event, payload); report(event, payload); };

    report2('boot', { slug: cfg.slug, version: cfg.version, specVersion: cfg.specVersion, base: 'native' });

    /* --- UI 帮助 --- */
    let hitButtons = [];
    function btn(r, label, cb) {
      g.fillStyle = '#3b4a6b'; roundRect(g, r.x, r.y, r.w, r.h, r.h / 2); g.fill();
      g.fillStyle = '#e8ecf3'; g.font = FONT(16, 600); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
      hitButtons.push({ r, cb });
    }
    function drawStars(x, y, n, size) {
      for (let i = 0; i < 3; i++) {
        g.fillStyle = i < n ? '#ffd166' : '#3a4358'; g.font = FONT(size, 700); g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText('★', x + i * (size + 2), y);
      }
    }
    const fmt = (n) => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : '' + Math.floor(n);

    /* --- 关卡流程（事件词表 §5.3） --- */
    function startLevel(L) {
      curLevel = L; screen = 'play'; result = null; hudParts = []; toast = { text: '', t: 0 };
      levelT0 = performance.now();
      if (!session) session = { score: 0, t0: performance.now() };
      engine = engineFactory({
        W, H, cfg, level: L,
        area: area(),
        rng: mulberry32(fnv1a32(`${cfg.slug}#${L}`)),
        setHud: (p) => { hudParts = p.slice(0, 3); },
        toast: (t) => { toast = { text: t, t: 1.4 }; },
        win: (score, opt) => finish(true, score, opt),
        lose: (score) => finish(false, score, {}),
      });
      engine.startLevel();
      report2('start', { level: L });
      snd('tap');
    }
    function finish(win, score, opt) {
      if (result) return;                                     // 双保险：结算后不再重复判局
      let stars = 0;
      if (win) stars = opt.stars != null ? opt.stars : 1 + (score >= opt.s2 ? 1 : 0) + (score >= opt.s3 ? 1 : 0);
      const durMs = Math.round(performance.now() - levelT0);
      session.score += score;
      const all = win && curLevel >= cfg.levels;
      result = { level: curLevel, win, score, stars, all, t: 0 };
      if (win) {                                              // 进度只升不降（§3.2）
        const p = store.progress;
        p.unlocked = Math.max(p.unlocked, Math.min(cfg.levels, curLevel + 1));
        p.best = Math.max(p.best, curLevel);
        p.stars[curLevel - 1] = Math.max(p.stars[curLevel - 1] || 0, stars);
        store.mark('progress');
      }
      report2('levelEnd', { level: curLevel, win, score, stars, durMs });
      if (all) { report2('end', { reason: 'allClear', totalScore: session.score, durMs: Math.round(performance.now() - session.t0) }); session = null; }
      snd(win ? 'ok' : 'bad');
    }
    function goHome() {
      if (screen === 'play' && session) {                     // 退出会话 → quit
        report2('end', { reason: 'quit', totalScore: session.score, durMs: Math.round(performance.now() - session.t0) });
        session = null;
      }
      screen = 'home'; result = null; engine = null; store.flushNow();
    }

    /* --- 输入路由（tap/swipe 词表 §5.4；timeStamp 进延迟队列） --- */
    cvs.addEventListener('pointerdown', (e) => {
      e.preventDefault(); cvs.setPointerCapture && cvs.setPointerCapture(e.pointerId);
      noteInput(e.timeStamp);
      const p = toXY(cvs, e);
      if (screen === 'play' && !result && engine) { engine.onDown(p.x, p.y); dbg('input', { kind: 'down', x: +p.x.toFixed(1), y: +p.y.toFixed(1) }); }
      dragFrom = { ...p, scroll: homeScroll, moved: false };
    });
    cvs.addEventListener('pointermove', (e) => {
      const p = toXY(cvs, e);
      if (screen === 'play' && !result && engine) engine.onMove(p.x, p.y);
      if (dragFrom && screen === 'home' && gridMode) {
        const dy = p.y - dragFrom.y;
        if (Math.abs(dy) > 6) { dragFrom.moved = true; homeScroll = clamp(dragFrom.scroll + dy, 0, 1e5); }
      }
    });
    const upHandler = (e) => {
      noteInput(e.timeStamp);
      const p = toXY(cvs, e);
      const wasDrag = dragFrom && dragFrom.moved; dragFrom = null;
      if (wasDrag) return;
      if (result) { for (const b of hitButtons) if (hit(b.r, p)) { b.cb(); return; } return; }
      if (screen === 'home') { for (const b of hitButtons) if (hit(b.r, p)) { b.cb(); return; } return; }
      if (engine) { engine.onUp(p.x, p.y); dbg('input', { kind: 'up', x: +p.x.toFixed(1), y: +p.y.toFixed(1) }); }
    };
    cvs.addEventListener('pointerup', upHandler);
    cvs.addEventListener('pointercancel', upHandler);
    function hit(r, p) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }

    /* --- 崩溃恢复：页面隐藏/关闭前 flush（§5.2） --- */
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flushNow(); });
    window.addEventListener('pagehide', () => store.flushNow());
    window.addEventListener('beforeunload', () => store.flushNow());

    /* --- 主循环（dt 夹 0..0.05s；判定节奏由引擎内部 1/120 固定步长保证） --- */
    function frame(t) {
      const dt = clamp((t - lastFrameT) / 1000, 0, 0.05);   // 先取上一帧间隔（noteFrame 会更新 lastFrameT）
      noteFrame(t);
      /* 输入→呈现延迟：事件 timeStamp → 本呈现帧 */
      while (inputTs.length) {
        const d = t - inputTs.shift();
        if (d >= 0 && d < 10000) { inputN++; inputSum += d; if (d > inputMaxMs) inputMaxMs = d; }
      }
      store.flushIfDue();
      hitButtons = [];
      g.setTransform(scale, 0, 0, scale, 0, 0);
      g.fillStyle = '#101522'; g.fillRect(0, 0, W, H);
      if (screen === 'home') drawHome();
      else drawPlay(paused ? 0 : dt);                         // QA 暂停：引擎时序冻结，画面保持
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    function drawHome() {
      const p = store.progress;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#e8ecf3'; g.font = FONT(30, 800); g.fillText(cfg.title, W / 2, 92);
      g.fillStyle = '#8b94a7'; g.font = FONT(14, 400);
      g.fillText(`${TIER_CN[cfg.tier] || cfg.tier} · ${cfg.levels} 关 · ${cfg.controls.primary}`, W / 2, 124);
      const next = Math.min(p.unlocked, cfg.levels);
      if (!gridMode) {
        btn({ x: 57, y: 210, w: 261, h: 64 }, p.best ? `继续 · 第 ${next} 关` : `开始 · 第 1 关`, () => startLevel(next));
        btn({ x: 57, y: 290, w: 261, h: 52 }, '选关', () => { gridMode = true; homeScroll = 0; });
        g.fillStyle = '#8b94a7'; g.font = FONT(12, 400);
        g.fillText(`最高通关 ${p.best} / ${cfg.levels}`, W / 2, 372);
      } else {
        g.save(); g.beginPath(); g.rect(0, 150, W, H - 210); g.clip();
        g.translate(0, -homeScroll);
        const cols = 5, cw = 58, ch = 46, x0 = (W - cols * cw - (cols - 1) * 8) / 2;
        for (let i = 0; i < cfg.levels; i++) {
          const L = i + 1, r = { x: x0 + (i % cols) * (cw + 8), y: 160 + Math.floor(i / cols) * (ch + 14), w: cw, h: ch };
          const un = L <= p.unlocked;
          g.fillStyle = un ? '#2c3a5c' : '#1a2133'; roundRect(g, r.x, r.y, r.w, r.h, 10); g.fill();
          if (L === p.unlocked) { g.strokeStyle = '#6ea8ff'; g.lineWidth = 2; roundRect(g, r.x, r.y, r.w, r.h, 10); g.stroke(); }
          g.fillStyle = un ? '#e8ecf3' : '#3a4358'; g.font = FONT(15, 600);
          g.fillText('' + L, r.x + r.w / 2, r.y + 16);
          g.font = FONT(11, 400);
          g.fillStyle = ['#3a4358', '#ffd166', '#ffd166', '#ffd166'][(p.stars[i] || 0)];
          g.fillText('★'.repeat(p.stars[i] || 0) || '·', r.x + r.w / 2, r.y + 33);
          if (un) hitButtons.push({ r, cb: () => startLevel(L) });
        }
        const maxY = 160 + Math.ceil(cfg.levels / cols) * (ch + 14);
        homeScroll = clamp(homeScroll, 0, Math.max(0, maxY - (H - 70)));
        g.restore();
        btn({ x: 57, y: H - 58, w: 261, h: 44 }, '返回', () => { gridMode = false; });
      }
      /* 音效开关（右上，状态区） */
      const sr = { x: W - 56, y: 26, w: 40, h: 40 };
      g.fillStyle = '#2c3a5c'; roundRect(g, sr.x, sr.y, sr.w, sr.h, 12); g.fill();
      g.fillStyle = store.settings.sound ? '#ffd166' : '#5b6478'; g.font = FONT(18, 600);
      g.fillText(store.settings.sound ? '♪' : '×', sr.x + 20, sr.y + 21);
      hitButtons.push({ r: sr, cb: () => { store.settings.sound = !store.settings.sound; store.mark('settings'); snd('tap'); } });
      g.fillStyle = '#3a4358'; g.font = FONT(11, 400); g.fillText(`${cfg.slug} v${cfg.version} · GE`, W / 2, H - 16);
    }

    /* --- 玩法态：引擎画布 + 顶栏（HUD 三组三等分；§7.2.A.4 脏检查在引擎源头做——
     *     值变才 setHud，GE 侧每帧重画。教训：GE 侧再加缓存与"半透明底逐帧重刷"互斥——
     *     93% α 底每帧盖掉旧墨 7%，低频值组（命/币）~1s 内被擦空；底改不透明 + 每帧重画） --- */
    function drawPlay(dt) {
      if (engine) { engine.update(dt); engine.render(g); }
      g.fillStyle = '#151b2e'; g.fillRect(0, 0, W, TOP);
      g.strokeStyle = '#232c42'; g.beginPath(); g.moveTo(0, TOP - .5); g.lineTo(W, TOP - .5); g.stroke();
      const back = { x: 8, y: 8, w: 44, h: 32 };
      g.fillStyle = '#2c3a5c'; roundRect(g, back.x, back.y, back.w, back.h, 8); g.fill();
      g.fillStyle = '#e8ecf3'; g.font = FONT(14, 600); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('‹', back.x + 22, back.y + 17);
      hitButtons.push({ r: back, cb: goHome });
      g.textAlign = 'left'; g.font = FONT(12, 500); g.fillStyle = '#8b94a7';
      g.fillText('第' + curLevel + '关', 64, TOP / 2);
      /* HUD ≤3 组三等分（修复旧壳只画 1/2 组的历史缺陷） */
      const n = hudParts.length;
      if (n) {
        const x0 = 112, span = (W - 8 - x0) / n, cw = Math.floor(span);
        g.textAlign = 'center';
        for (let i = 0; i < n; i++) {
          const part = hudParts[i];
          const cx = x0 + i * span;
          g.fillStyle = '#8b94a7'; g.font = FONT(11, 500); g.fillText(part.t, cx + cw / 2, TOP / 2 - 9);
          g.fillStyle = '#9fc0ff'; g.font = FONT(14, 700); g.fillText(fmt(part.v), cx + cw / 2, TOP / 2 + 9);
        }
      }
      /* toast */
      if (toast.t > 0) {
        toast.t -= dt;
        g.globalAlpha = clamp(toast.t / 0.4, 0, 1) * .92;
        g.fillStyle = '#0b0e14'; g.fillRect(0, TOP + 90, W, 40);
        g.fillStyle = '#ffd166'; g.font = FONT(15, 600); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(toast.text, W / 2, TOP + 110); g.globalAlpha = 1;
      }
      /* 结算浮层 */
      if (result) {
        result.t += dt;
        g.fillStyle = 'rgba(11,14,20,.82)'; g.fillRect(0, 0, W, H);
        const cy = 208, cw2 = 295, ch2 = 250, cx = (W - cw2) / 2;
        g.fillStyle = '#1a2133'; roundRect(g, cx, cy, cw2, ch2, 18); g.fill();
        g.strokeStyle = '#2c3a5c'; g.lineWidth = 1.5; roundRect(g, cx, cy, cw2, ch2, 18); g.stroke();
        g.textAlign = 'center';
        g.fillStyle = result.win ? '#7bd88f' : '#ff8fa3'; g.font = FONT(21, 800);
        g.fillText(result.all ? '全部通关！' : result.win ? '第 ' + result.level + ' 关 通过' : '第 ' + result.level + ' 关 失败', W / 2, cy + 44);
        drawStars(W / 2 - 36, cy + 84, result.stars, 26);
        g.fillStyle = '#e8ecf3'; g.font = FONT(38, 800); g.fillText(fmt(result.score), W / 2, cy + 130);
        g.fillStyle = '#8b94a7'; g.font = FONT(12, 400); g.fillText('得分', W / 2, cy + 154);
        const bw = 118, bh = 48, gap = 14, bx = (W - bw * 2 - gap) / 2;
        btn({ x: bx, y: cy + 178, w: bw, h: bh }, '重试', () => startLevel(result.level));
        if (result.win && !result.all) btn({ x: bx + bw + gap, y: cy + 178, w: bw, h: bh }, '下一关', () => startLevel(result.level + 1));
        else btn({ x: bx + bw + gap, y: cy + 178, w: bw, h: bh }, '首页', goHome);
      }
    }
  }

  return {
    W, H, TOP, area, fit, toXY, safeInsets,
    fnv1a32, mulberry32, clamp, lerp, prog, lin, inv, tier, TIER_CN,
    swipeDir, roundRect, FONT,
    makeStore, makeReporter, makeSound, layer, boot,
  };
})();
