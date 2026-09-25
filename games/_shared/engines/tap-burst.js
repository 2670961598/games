'use strict';
/* =====================================================================
 * 狂点爆发引擎（spec §7）：时限内点够冒出的目标圆点数；点中红色陷阱叉点扣分断连击。
 * 曲线：target(L)=ceil(targetBase×(1+0.10p))；time(L)=max(10,round(timeSec×(1−0.15p)))；
 *       size(L)=max(48,round(sizePx×(1−0.10p)))；rate(L)=spawnPerSec×(1+0.20p)（schema k=0.20）；
 *       decoy(L)=decoyRate×(1+0.10p)（schema k=0.10）；p=(L−1)/(Ln−1)。
 * 裁量③：spawnPerSec/decoyRate 的威胁曲线取 §4.1 标准线性（schema 表 k 注记）——
 *   无 rate 曲线则 master L30 目标数 29<33 结构性不可赢，加曲线后五档全量可赢（QA 断言）。
 * 生成（§7）：位置由 seed 均匀分布于中央 90% 屏区、两两不重叠（重生掷点，确定性）。
 * 裁量①：spawnPerSec 释为"目标出现速率"——陷阱为**额外**流（每目标掷 decoyRate 附带一只），
 *   若陷阱挤占目标配额则 master L30 数学不可赢（2.4×14×0.88≈29 < target 33），故取加流释读；
 *   起始 t0=0.3s 均匀节拍，目标常驻至被点（"尽快点够"= 纯手速轴）。
 * 裁量②：空点/点陷阱均断连击（连击=连续点中目标数）。
 * 计分：score=有效点击×10+最大连击×5−陷阱点击×15（下限 0）；s2=target(L)×12，s3=target(L)×15。
 * 交互（§7）：全屏点按；顶部进度 target/计数与倒计时。
 * ===================================================================== */
const TapBurstEngine = (function () {
  const T0 = 0.3;              // 首目标出现时刻（秒）
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ targetBase: 20, timeSec: 20, sizePx: 72, spawnPerSec: 1.6, decoyRate: 0.08 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const target = Math.ceil(t.targetBase * (1 + 0.10 * p));
    const time = Math.max(10, Math.round(t.timeSec * (1 - 0.15 * p)));
    const size = Math.max(48, Math.round(t.sizePx * (1 - 0.10 * p)));
    const rate = +(t.spawnPerSec * (1 + 0.20 * p)).toFixed(3);   // schema k=0.20（裁量③）
    const decoyRate = +Math.min(0.5, t.decoyRate * (1 + 0.10 * p)).toFixed(3);
    const r = size / 2;
    /* 中央 90% 屏区（§7） */
    const bx = area.w * 0.05 + r, bX = area.w * 0.95 - r;
    const by = area.y + area.h * 0.05 + r, bY = area.y + area.h * 0.95 - r;

    /* --- 整场生成时间表（seed；均匀节拍，逐目标掷陷阱附带与落点） --- */
    const spawns = [];
    for (let tt = T0; tt < time; tt += 1 / rate) {
      spawns.push({ t: +tt.toFixed(4), decoy: rng() < decoyRate, x: bx + rng() * (bX - bx), y: by + rng() * (bY - by), hue: Math.floor(rng() * 360) });
    }
    let sp = 0;

    /* --- 运行状态 --- */
    let items = [], timeLeft = time, hits = 0, decoyHits = 0;
    let combo = 0, maxCombo = 0, score = 0, done = false, anim = 0;
    let down = null;
    let popFx = [];                                            // 命中粒子（装饰）

    const curScore = () => Math.max(0, hits * 10 + maxCombo * 5 - decoyHits * 15);

    /** 落点与在场目标两两不重叠（§7）：不满足则按环形重试再放（确定性） */
    function place(s) {
      for (let k = 0; k < 24; k++) {
        const x = bx + rng() * (bX - bx), y = by + rng() * (bY - by);
        if (items.every(it => (it.x - x) * (it.x - x) + (it.y - y) * (it.y - y) > (it.r + r + 6) * (it.r + r + 6))) return { x, y };
      }
      return { x: bx + rng() * (bX - bx), y: by + rng() * (bY - by) };   // 兜底仍均匀（极稠时放宽间距）
    }

    function step() {
      if (done) return;
      timeLeft -= STEP;
      const now = time - timeLeft;
      while (sp < spawns.length && spawns[sp].t <= now) {
        const s = spawns[sp];
        const pos = place(s);
        items.push({ x: pos.x, y: pos.y, r: s.decoy ? r * 0.72 : r, decoy: s.decoy, hue: s.hue, born: anim });
        sp++;
      }
      if (timeLeft <= 0) { done = true; score = curScore(); game.lose(score); }   // 时限到未达标（§7）
    }

    function tap(x, y) {
      if (done) return;
      /* 顶至底取最先命中的在场物 */
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if ((x - it.x) * (x - it.x) + (y - it.y) * (y - it.y) <= it.r * it.r) {
          items.splice(i, 1);
          if (it.decoy) {                                      // 陷阱：扣分断连击（§7）
            decoyHits++; combo = 0;
            game.toast('陷阱！−15');
          } else {
            hits++; combo++; maxCombo = Math.max(maxCombo, combo);
            popFx.push({ x: it.x, y: it.y, hue: it.hue, t: 0.4 });
            if (hits >= target) { done = true; score = curScore(); game.win(score, { s2: target * 12, s3: target * 15 }); return; }
          }
          return;
        }
      }
      combo = 0;                                               // 空点断连击（裁量②）
    }

    return {
      startLevel() { game.setHud([{ t: `/${target}`, v: 0 }, { t: '连击', v: 0 }, { t: '秒', v: time }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        score = curScore();
        for (const f of popFx) f.t -= dt;
        popFx = popFx.filter(f => f.t > 0);
        game.setHud([
          { t: `/${target}`, v: hits },
          { t: '连击', v: combo },
          { t: 'x' + Math.max(0, decoyHits), v: Math.ceil(Math.max(0, timeLeft)) },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) tap(x, y); down = null; },
      render(g) {
        /* 顶栏下倒计时条 */
        const tr = G.clamp(timeLeft / time, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = tr > 0.25 ? '#7bd88f' : '#ff8fa3'; g.fillRect(20, area.y + 6, (area.w - 40) * tr, 4);
        /* 目标/陷阱 */
        for (const it of items) {
          if (it.decoy) {                                      // 红色陷阱叉点（§7）
            g.fillStyle = '#2a1520'; g.beginPath(); g.arc(it.x, it.y, it.r, 0, 7); g.fill();
            g.strokeStyle = '#ff8fa3'; g.lineWidth = 4;
            const d = it.r * 0.55;
            g.beginPath(); g.moveTo(it.x - d, it.y - d); g.lineTo(it.x + d, it.y + d);
            g.moveTo(it.x + d, it.y - d); g.lineTo(it.x - d, it.y + d); g.stroke();
          } else {
            const pulse = 1 + Math.sin(anim * 5 + it.hue) * 0.04;
            g.fillStyle = `hsl(${it.hue},70%,58%)`;
            g.beginPath(); g.arc(it.x, it.y, it.r * pulse, 0, 7); g.fill();
            g.fillStyle = 'rgba(255,255,255,.35)';
            g.beginPath(); g.arc(it.x - it.r * 0.28, it.y - it.r * 0.3, it.r * 0.24, 0, 7); g.fill();
            g.strokeStyle = `hsl(${it.hue},70%,42%)`; g.lineWidth = 2;
            g.beginPath(); g.arc(it.x, it.y, it.r * pulse, 0, 7); g.stroke();
          }
        }
        /* 命中粒子（装饰） */
        for (const f of popFx) {
          g.globalAlpha = G.clamp(f.t / 0.4, 0, 1);
          g.fillStyle = `hsl(${f.hue},80%,70%)`;
          for (let i = 0; i < 6; i++) {
            const a = i * Math.PI / 3, d = (0.4 - f.t) * 130;
            g.beginPath(); g.arc(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, 3.2, 0, 7); g.fill();
          }
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          target, time, size, rate, decoyRate,
          spawnsN: spawns.length, sp,
          realByDeadline: spawns.length,                        // 陷阱为加流：目标数=全场生成数（裁量①）
          timeLeft: +timeLeft.toFixed(2), hits, decoyHits, combo, maxCombo, score, done,
          items: items.map(it => [+it.x.toFixed(2), +it.y.toFixed(2), +it.r.toFixed(1), it.decoy ? 1 : 0, it.hue]),
        };
      },
    };
  };
})();
