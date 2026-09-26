'use strict';
/* GAMES-24 基准——页内度量层（全引擎一致，build.mjs 内联）。
 * tReady：boot 完成后首个呈现帧的时刻（performance.now，导航起点为 0）；
 * fps：ready+500ms 暖机后 rAF 时间戳采样 10s（无头 60Hz 口径）；
 * 实体峰值/均值：每帧上报在场实体数（渲染压力的地面真值，跨引擎对齐证明）。
 * 宿主（run.mjs）经 __BENCH__.collect() 取数；mem 模式由宿主外采 performance.memory。 */
window.__BENCH__ = (function () {
  const q = new URLSearchParams(location.search);
  const B = {
    engine: document.documentElement.dataset.engine,
    game: document.documentElement.dataset.game,
    mode: q.get('mode') || 'start',
    load: +(q.get('load') || 1),
    dpr: Math.min(window.devicePixelRatio || 1, 3),
    tScript: performance.now(),          /* 内联主体首行时刻（≈ DOM 解析到脚本执行） */
    tSim: 0, tReady: 0,
    frames: null, fpsDone: false, _fpsT0: 0, FPS_DUR: 10, WARM: 0.5,
    peak: 0, sumEnt: 0, entFrames: 0, restarts: 0, simEvents: 0,
    extra: {},
  };
  B.markSim = () => { B.tSim = performance.now(); };
  let readied = false;
  B.markReady = function () {
    if (readied) return; readied = true;
    B.tReady = performance.now();
  };
  B.frame = function (t) {              /* 各引擎在其渲染循环入口调用（rAF/POST_RENDER/ticker） */
    B.markReady();
    if (B.mode !== 'fps') return;
    if (B.frames === null) {
      if (t - B.tReady >= B.WARM * 1000) { B.frames = [t]; B._fpsT0 = t; }
    } else {
      B.frames.push(t);
      if (t - B._fpsT0 >= B.FPS_DUR * 1000) B.fpsDone = true;
    }
  };
  B.noteEntities = function (n) {
    if (n > B.peak) B.peak = n;
    B.sumEnt += n; B.entFrames++;
  };
  B.collect = function () {
    const nav = performance.getEntriesByType('navigation')[0];
    const out = {
      engine: B.engine, game: B.game, mode: B.mode, load: B.load, dpr: B.dpr,
      tScript: Math.round(B.tScript * 10) / 10,
      tSim: Math.round(B.tSim * 10) / 10,
      tReady: Math.round(B.tReady * 10) / 10,
      nav: nav ? {
        ttfb: Math.round(nav.responseStart),
        respEnd: Math.round(nav.responseEnd),
        dcl: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
      } : null,
      peak: B.peak, avgEnt: B.entFrames ? Math.round((B.sumEnt / B.entFrames) * 10) / 10 : 0,
      restarts: B.restarts, simEvents: B.simEvents,
      extra: B.extra,
      heap: (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null),
      fps: null,
    };
    if (B.frames && B.frames.length > 10) {
      const f = B.frames, dt = [];
      for (let i = 1; i < f.length; i++) dt.push(f[i] - f[i - 1]);
      const srt = dt.slice().sort((a, b) => a - b);
      const dur = (f[f.length - 1] - f[0]) / 1000;
      const per1s = [];
      for (let i = 0; i < f.length - 1; ) {   /* 逐秒桶最小帧率（掉帧带证据） */
        let j = i, cnt = 0;
        while (j < f.length - 1 && f[j] - f[i] < 1000) { j++; cnt++; }
        per1s.push(cnt); i = j;
      }
      out.fps = {
        dur: Math.round(dur * 100) / 100,
        avg: Math.round(((f.length - 1) / dur) * 100) / 100,
        p95: Math.round(srt[Math.floor(srt.length * 0.95)] * 100) / 100,
        p99: Math.round(srt[Math.floor(srt.length * 0.99)] * 100) / 100,
        max: Math.round(srt[srt.length - 1] * 100) / 100,
        long17: dt.filter(d => d > 17.5).length,
        long34: dt.filter(d => d > 34).length,
        min1s: Math.min(...per1s), max1s: Math.max(...per1s),
        n: f.length,
      };
    }
    return out;
  };
  return B;
})();
