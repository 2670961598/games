'use strict';
/* =====================================================================
 * 狂点爆发引擎（spec §7）：时限内点够冒出的目标圆点数；点中红色陷阱叉点扣分断连击。
 * GAMES-30 试点重构（原生基座黄金样本）：判定路径逐字保留（rng 消费序/步长/计分
 * 与旧版一致——QA 确定性/可赢性断言原样可跑）；表现层按 GAMES-24 §7.2.A 强化：
 *   A2 命中火花并发上限 MAX_FX（低端机极端积压防护）+ bench 式 8 向确定性火花；
 *   A1+ 出生弹入动画（bench 蓝本）；零 G./GE. 依赖（任何外壳/vm 桩可驱动）。
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
  const MAX_FX = 24;           // §7.2.A.2 命中火花并发上限（超限弃最旧，装饰层不影响判定）
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

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

    /* --- 整场生成时间表（seed；均匀节拍，目标每拍必有，陷阱为额外附带流） ---
     * 裁量①修复（GAMES-30 E2E 抓出）：旧实现陷阱挤占生成位（decoy 掷中则该拍变陷阱），
     * master L1 目标数 33×0.88≈29 < target 30 结构性不可赢，与下述文档裁定矛盾；
     * 现兑现"额外流"原意：每拍必出 1 目标，另掷 decoyRate 附带 1 陷阱（同拍落地，
     * 位置由 place() 掷点避让）。rng 消费数/拍不变（每拍 4 掷）。 */
    const spawns = [];
    for (let tt = T0; tt < time; tt += 1 / rate) {
      const decoy = rng() < decoyRate;
      const x = bx + rng() * (bX - bx), y = by + rng() * (bY - by), hue = Math.floor(rng() * 360);
      spawns.push({ t: +tt.toFixed(4), decoy: false, x, y, hue });
      if (decoy) spawns.push({ t: +tt.toFixed(4), decoy: true, x, y, hue });
    }
    let sp = 0;

    /* --- 运行状态 --- */
    let items = [], timeLeft = time, hits = 0, decoyHits = 0;
    let combo = 0, maxCombo = 0, score = 0, done = false, anim = 0;
    let down = null;
    let popFx = [];                                            // 命中粒子（装饰，§7.2.A.2 上限）
    /* HUD 源头脏检查（§7.2.A.4）：值变才 setHud（秒/连击/命中均事件级变化，消灭逐帧分配） */
    let hudH = -1, hudC = -1, hudS = -1;
    let acc0 = 0;                                              // 固定步长余数跨帧携带（GAMES-30 修复：丢弃式累加器在 120Hz 帧到位≈STEP 时整帧丢步，引擎慢 ~17%）

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
            /* bench 式 8 向火花（角度/速度由 hits 确定性导出，装饰不入 __state） */
            const sparks = [];
            for (let k = 0; k < 8; k++) sparks.push({ a: (k / 8) * Math.PI * 2 + (hits % 8) * 0.13, sp: 120 + ((hits * 7 + k * 13) % 60) });
            if (popFx.length >= MAX_FX) popFx.shift();        // §7.2.A.2：并发上限（弃最旧）
            popFx.push({ x: it.x, y: it.y, hue: it.hue, t: 0.4, sparks });
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
        acc0 += dt;
        while (acc0 >= STEP) { acc0 -= STEP; step(); if (done) break; }
        score = curScore();
        for (const f of popFx) f.t -= dt;
        popFx = popFx.filter(f => f.t > 0);
        const sec = Math.ceil(Math.max(0, timeLeft));
        if (hits !== hudH || combo !== hudC || sec !== hudS) {
          hudH = hits; hudC = combo; hudS = sec;
          game.setHud([
            { t: `/${target}`, v: hits },
            { t: '连击', v: combo },
            { t: 'x' + Math.max(0, decoyHits), v: sec },
          ]);
        }
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) tap(x, y); down = null; },
      render(g) {
        /* 顶栏下倒计时条 */
        const tr = clamp(timeLeft / time, 0, 1);
        g.fillStyle = '#1a2133'; g.fillRect(20, area.y + 6, area.w - 40, 4);
        g.fillStyle = tr > 0.25 ? '#7bd88f' : '#ff8fa3'; g.fillRect(20, area.y + 6, (area.w - 40) * tr, 4);
        /* 目标/陷阱（bench 式出生弹入：0.12s 0.6→1） */
        for (const it of items) {
          const pop = Math.min(1, (anim - it.born) / 0.12);
          const rr = it.r * (0.6 + 0.4 * pop);
          if (it.decoy) {                                      // 红色陷阱叉点（§7）
            g.fillStyle = '#2a1520'; g.beginPath(); g.arc(it.x, it.y, rr, 0, 7); g.fill();
            g.strokeStyle = '#ff8fa3'; g.lineWidth = 4;
            const d = rr * 0.55;
            g.beginPath(); g.moveTo(it.x - d, it.y - d); g.lineTo(it.x + d, it.y + d);
            g.moveTo(it.x + d, it.y - d); g.lineTo(it.x - d, it.y + d); g.stroke();
          } else {
            const pulse = 1 + Math.sin(anim * 5 + it.hue) * 0.04;
            g.fillStyle = `hsl(${it.hue},70%,58%)`;
            g.beginPath(); g.arc(it.x, it.y, rr * pulse, 0, 7); g.fill();
            g.fillStyle = 'rgba(255,255,255,.35)';
            g.beginPath(); g.arc(it.x - rr * 0.28, it.y - rr * 0.3, rr * 0.24, 0, 7); g.fill();
            g.strokeStyle = `hsl(${it.hue},70%,42%)`; g.lineWidth = 2;
            g.beginPath(); g.arc(it.x, it.y, rr * pulse, 0, 7); g.stroke();
          }
        }
        /* 命中火花（装饰；bench 式径向飞散+衰减） */
        for (const f of popFx) {
          const k = f.t / 0.4;
          g.globalAlpha = clamp(k, 0, 1);
          for (const s of f.sparks) {
            const d = (0.4 - f.t) * s.sp * 0.4;
            g.fillStyle = `hsl(${f.hue},80%,70%)`;
            g.beginPath(); g.arc(f.x + Math.cos(s.a) * d, f.y + Math.sin(s.a) * d, 3.2 * k, 0, 7); g.fill();
          }
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          target, time, size, rate, decoyRate,
          spawnsN: spawns.length, sp,
          realByDeadline: spawns.reduce((a, s) => a + (s.decoy ? 0 : 1), 0),   // 真实目标数（陷阱为额外流，不计入——GAMES-30 修正口径）
          timeLeft: +timeLeft.toFixed(2), hits, decoyHits, combo, maxCombo, score, done,
          items: items.map(it => [+it.x.toFixed(2), +it.y.toFixed(2), +it.r.toFixed(1), it.decoy ? 1 : 0, it.hue]),
        };
      },
    };
  };
})();
