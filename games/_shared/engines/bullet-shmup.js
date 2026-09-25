'use strict';
/* =====================================================================
 * 弹幕射击引擎（spec §16）：竖版自动射击，拖动机体躲避弹幕并清空敌波。
 * 曲线：waves(L)=min(wavesCap,5+⌊5(L−1)/(Ln−1)⌋)；eSpeed(L)=bulletSpeed×(1+0.30(L−1)/(Ln−1))；
 *       eHP(L)=enemyHP+⌊L/max(4,Ln/6)⌋。
 * 生成：每波 6 架，pattern 池（直线俯冲/正弦横移/两侧夹进/悬停散射）由 seed 选用；
 *       弹型扇形/瞄准二选一由 seed 掷点；每敌机同屏弹数 ≤ density。
 * 映射：拖动机体（指上偏移 40px 免手指挡机体），自动连射（playerFireMs 固定）。
 * 计分：score=击落×10×HP+清波×50；s2=12×enemies(L)，s3=15×enemies(L)（enemies=waves×6）。
 * 物理：固定步长 1/120s 累加器。
 * ===================================================================== */
const BulletShmupEngine = (function () {
  const wavesOf = (t, L, n) => Math.min(t.wavesCap, 5 + Math.floor(5 * (L - 1) / (n - 1)));
  const eSpeedOf = (t, L, n) => t.bulletSpeed * (1 + 0.30 * (L - 1) / (n - 1));
  const eHPOf = (t, L, n) => t.enemyHP + Math.floor(L / Math.max(4, n / 6));
  const PCOL = ['#7bd88f', '#ffd166', '#6ea8ff', '#ff8fa3'];

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ wavesCap: 10, enemyHP: 2, bulletSpeed: 200, density: 3, lives: 3, playerFireMs: 150 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level;
    const waves = wavesOf(t, L, n), eSpeed = eSpeedOf(t, L, n), eHP0 = eHPOf(t, L, n);
    const enemiesTotal = waves * 6;

    const ship = { x: area.w / 2, y: area.y + area.h - 110, r: 9 };
    let finger = null;                                   // {x,y} 拖动锚点（指上偏移 40px）
    let lives = t.lives, score = 0, done = false, inv = 0;
    let waveNo = 0, waveEnemies = [], waveGap = 0;       // 波内敌机以 delay 分批入场，出清即判波次
    let eBullets = [], pBullets = [], pops = [];
    let fireTimer = 0, acc = 0;

    function startWave() {
      waveNo++;
      const pattern = (rng() * 4) | 0;                   // 波型由 seed 选用（§16 生成规则）
      for (let i = 0; i < 6; i++) {
        const delay = 0.3 + i * 0.28;
        const hp = eHP0;
        let sp;
        if (pattern === 0) {                             // 直线俯冲
          sp = { kind: 0, x: area.w * (0.12 + rng() * 0.76), y: area.y - 16 - i * 6, vx: 0, vy: eSpeed * 0.75 };
        } else if (pattern === 1) {                      // 正弦横移
          sp = { kind: 1, x: area.w * (0.15 + rng() * 0.7), y: area.y - 16 - i * 6, vx: 0, vy: eSpeed * 0.45, ph: rng() * 6.28, amp: 40 + rng() * 45, om: 1.6 + rng() * 1.2, x0: 0 };
          sp.x0 = sp.x;
        } else if (pattern === 2) {                      // 两侧夹进
          const left = rng() < 0.5;
          sp = { kind: 2, x: left ? -14 - rng() * 30 : area.w + 14 + rng() * 30, y: area.y + 26 + rng() * 90, vx: (left ? 1 : -1) * eSpeed * 0.55, vy: eSpeed * 0.22, tx: area.w * (0.3 + rng() * 0.4) };
        } else {                                         // 悬停散射
          sp = { kind: 3, x: area.w * (0.15 + rng() * 0.7), y: area.y - 16, vx: 0, vy: eSpeed * 0.5, hoverY: area.y + 70 + rng() * 80, hoverT: 3.4 };
        }
        sp.delay = delay; sp.hp = hp; sp.hp0 = hp; sp.age = 0; sp.fireAt = 0.9 + rng() * 0.8; sp.aimed = rng() < 0.5;
        waveEnemies.push(sp);
      }
    }
    startWave();

    function enemyFire(e) {
      const live = eBullets.filter(b => b.owner === e).length;
      if (live >= t.density) return;                     // 每敌机同屏弹数 ≤ density
      const fan = !e.aimed;                              // 弹型：扇形/瞄准二选一（seed 掷点）
      if (fan) {
        for (let i = 0; i < t.density; i++) {
          const a = Math.PI / 2 + (-0.55 + 1.1 * (t.density === 1 ? 0.5 : i / (t.density - 1)));
          eBullets.push({ x: e.x, y: e.y + 10, vx: Math.cos(a) * eSpeed, vy: Math.sin(a) * eSpeed, owner: e });
        }
      } else {
        const dx = ship.x - e.x, dy = ship.y - e.y, d = Math.hypot(dx, dy) || 1;
        for (let i = 0; i < t.density; i++) {
          const sp = 0.09 * (i - (t.density - 1) / 2);
          const ca = Math.cos(sp), sa = Math.sin(sp);
          const ux = (dx / d) * ca - (dy / d) * sa, uy = (dx / d) * sa + (dy / d) * ca;
          eBullets.push({ x: e.x, y: e.y + 10, vx: ux * eSpeed, vy: uy * eSpeed, owner: e });
        }
      }
      e.fireAt += 1.5 + rng() * 0.9;
    }
    function killEnemy(e) {
      score += 10 * e.hp0;                               // 击落×10×HP（§16 计分）
      pops.push({ x: e.x, y: e.y, t: 0.5 });
      waveEnemies.splice(waveEnemies.indexOf(e), 1);
      eBullets = eBullets.filter(b => b.owner !== e);
      checkWave();
    }
    function checkWave() {
      if (waveEnemies.length === 0) {
        score += 50;                                     // 清波×50
        if (waveNo >= waves) { done = true; game.win(score, { s2: 12 * enemiesTotal, s3: 15 * enemiesTotal }); }
        else waveGap = 0.9;
      }
    }
    function hitPlayer() {
      if (inv > 0 || done) return;
      lives--;
      eBullets = [];                                     // 被击中清弹（重生保护）
      if (lives <= 0) { done = true; game.lose(score); }
      else { inv = 2; game.toast(`被击中！机体 ${lives}/${t.lives}`); }
    }
    function step() {
      if (done) return;
      /* 自动连射（固定 playerFireMs） */
      fireTimer += STEP;
      while (fireTimer * 1000 >= t.playerFireMs) {
        fireTimer -= t.playerFireMs / 1000;
        pBullets.push({ x: ship.x, y: ship.y - 12, vy: -520 });
      }
      /* 敌机 */
      for (const e of [...waveEnemies]) {
        if (e.delay > 0) { e.delay -= STEP; continue; }
        e.age += STEP;
        if (e.kind === 0) { e.x += e.vx * STEP; e.y += e.vy * STEP; }
        else if (e.kind === 1) {
          e.y += e.vy * STEP; e.ph += e.om * STEP;
          e.x = e.x0 + Math.sin(e.ph) * e.amp;
          e.x = G.clamp(e.x, 14, area.w - 14);
        } else if (e.kind === 2) {
          const toward = e.tx - e.x;
          if (Math.abs(toward) > 4 && e.age < 6) e.x += Math.sign(toward) * Math.abs(e.vx) * STEP;
          else e.y += e.vy * 3.4 * STEP;
          e.y += e.vy * STEP * 0.4;
        } else {
          if (e.y < e.hoverY) e.y += e.vy * STEP;
          else if (e.hoverT > 0) e.hoverT -= STEP;
          else e.y += eSpeed * 1.1 * STEP;
        }
        if (e.age >= e.fireAt && e.y > area.y + 10 && e.y < area.y + area.h * 0.75) enemyFire(e);
        if (e.y > area.y + area.h + 24 || e.x < -60 || e.x > area.w + 60) {
          waveEnemies.splice(waveEnemies.indexOf(e), 1);  // 离场（不计分）
          checkWave();
        }
      }
      /* 弹与机体 */
      for (const b of pBullets) {
        b.y += b.vy * STEP;
        if (b.dead) continue;
        for (const e of waveEnemies) {
          if (e.delay > 0 || e.hp <= 0) continue;
          if (Math.hypot(b.x - e.x, b.y - e.y) < 13) {
            e.hp--;
            pops.push({ x: b.x, y: b.y, t: 0.22, small: true });
            b.dead = true;
            if (e.hp <= 0) killEnemy(e);
            break;
          }
        }
      }
      pBullets = pBullets.filter(b => !b.dead && b.y > area.y - 20);
      for (const b of eBullets) { b.x += b.vx * STEP; b.y += b.vy * STEP; }
      eBullets = eBullets.filter(b => b.y < area.y + area.h + 20 && b.y > area.y - 30 && b.x > -20 && b.x < area.w + 20);
      /* 机体中弹判定（inv 期闪烁无敌） */
      if (inv > 0) inv -= STEP;
      for (const b of eBullets) {
        if (Math.hypot(b.x - ship.x, b.y - ship.y) < ship.r + 4) { hitPlayer(); break; }
      }
      for (const e of waveEnemies) {
        if (e.delay <= 0 && Math.hypot(e.x - ship.x, e.y - ship.y) < ship.r + 11) { hitPlayer(); break; }
      }
      /* 波间隙 */
      if (waveGap > 0 && !done) { waveGap -= STEP; if (waveGap <= 0) startWave(); }
    }
    const STEP = 1 / 120;

    return {
      startLevel() { game.setHud([{ t: '分', v: 0 }, { t: '波', v: `1/${waves}` }, { t: '机', v: lives }]); },
      update(dt) {
        acc += dt;
        while (acc >= STEP) { step(); acc -= STEP; if (done) break; }
        for (const p of pops) p.t -= dt;
        pops = pops.filter(p => p.t > 0);
        game.setHud([{ t: '分', v: score }, { t: '波', v: `${Math.min(waveNo, waves)}/${waves}` }, { t: '机', v: lives }]);
      },
      onDown(x, y) { finger = { x, y }; ship.x = G.clamp(x, 14, area.w - 14); ship.y = G.clamp(y - 40, area.y + 40, area.y + area.h - 24); },
      onMove(x, y) {
        if (finger) { ship.x = G.clamp(x, 14, area.w - 14); ship.y = G.clamp(y - 40, area.y + 40, area.y + area.h - 24); }
      },
      onUp() { finger = null; },
      render(g) {
        /* 自机（拖动跟随，指上偏移 40px；无敌期闪烁） */
        if (!(inv > 0 && ((performance.now() / 90) | 0) % 2 === 0 && !done)) {
          g.save(); g.translate(ship.x, ship.y);
          g.fillStyle = done ? '#3a4358' : '#e8ecf3';
          g.beginPath(); g.moveTo(0, -13); g.lineTo(10, 10); g.lineTo(0, 5); g.lineTo(-10, 10); g.closePath(); g.fill();
          g.fillStyle = '#6ea8ff'; g.fillRect(-2, -4, 4, 8);
          g.restore();
        }
        /* 敌机：按波型着色 */
        for (const e of waveEnemies) {
          if (e.delay > 0) continue;
          g.save(); g.translate(e.x, e.y);
          g.fillStyle = PCOL[e.kind];
          G.roundRect(g, -11, -9, 22, 18, 5); g.fill();
          g.fillStyle = '#101522'; g.beginPath(); g.arc(0, 1, 3.4, 0, 7); g.fill();
          if (e.hp0 > 1 && e.hp < e.hp0) {                // 剩余耐久示数
            g.fillStyle = '#0b0e14'; g.font = G.FONT(8, 700); g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('' + e.hp, 0, -14);
          }
          g.restore();
        }
        g.fillStyle = '#9fc0ff';
        for (const b of pBullets) g.fillRect(b.x - 1.5, b.y - 7, 3, 10);
        for (const b of eBullets) {
          g.beginPath(); g.arc(b.x, b.y, 4, 0, 7); g.fillStyle = '#ff8fa3'; g.fill();
          g.beginPath(); g.arc(b.x, b.y, 1.8, 0, 7); g.fillStyle = '#ffd9e0'; g.fill();
        }
        for (const p of pops) {
          g.globalAlpha = G.clamp(p.t * (p.small ? 4 : 2.4), 0, 1);
          g.fillStyle = p.small ? '#9fc0ff' : '#ffd166'; g.font = G.FONT(p.small ? 11 : 14, 700);
          g.textAlign = 'center'; g.textBaseline = 'middle';
          if (!p.small) g.fillText('+' + 10 * eHP0, p.x, p.y - (0.5 - p.t) * 30);
          g.globalAlpha = 1;
        }
      },
      __state() {
        return {
          waves, eSpeed: +eSpeed.toFixed(2), eHP0, enemiesTotal, lives, score, done, waveNo,
          ship: [+ship.x.toFixed(2), +ship.y.toFixed(2)],
          enemies: waveEnemies.map(e => [e.kind, +e.x.toFixed(2), +e.y.toFixed(2), e.hp, +e.delay.toFixed(2), +e.fireAt.toFixed(2), e.aimed ? 1 : 0]),
          pB: pBullets.length, eB: eBullets.length,
        };
      },
    };
  };
})();
