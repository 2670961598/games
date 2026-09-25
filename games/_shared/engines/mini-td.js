'use strict';
/* =====================================================================
 * 简化塔防引擎（spec §29）：点空位建塔（底部三选一卡），塔自动索敌（优先最近洞口），
 * 漏怪耗基地命。塔三型：箭塔 50 单体 / 冰塔 70 减速 40% / 炮塔 120 溅射；可升 2 级
 * （每次费用 ×1.5、伤害效果 ×1.6）；出售返还投入 70%（spec 未定，引擎侧约定）。
 * 曲线：waves(L)=min(cap,5+⌊5(L−1)/(Ln−1)⌋)；hp(L,w)=ceil(HP×(1+0.35k_L)×(1+0.08w))；
 *       waveSize/speed 按 k=0.20 线性；killGold=ceil(hp×0.6)；出怪间隔 900ms；快速怪 ×1.5 速 ×0.7 血（占 0.25，seed 预掷全序）。
 * score = 击杀×10 + 剩余命×50 + 清波×30；s2 = 12×enemies(L)，s3 = 15×enemies(L)。
 * ===================================================================== */
const MiniTDEngine = (function () {
  const TOWERS = {
    arrow: { name: '箭塔', cost: 50, dmg: 2, rate: 2.0, range: 95, color: '#6ea8ff' },
    ice: { name: '冰塔', cost: 70, dmg: 1, rate: 1.0, range: 85, slow: 0.4, slowT: 1.5, color: '#4dd0e1' },
    cannon: { name: '炮塔', cost: 120, dmg: 4, rate: 0.8, range: 80, splash: 45, color: '#ff9f43' },
  };
  const wavesOf = (t, L, n) => Math.min(t.wavesCap, 5 + Math.floor(5 * (L - 1) / (n - 1)));
  const sizeOf = (t, L, n) => Math.round(t.waveSize * (1 + 0.20 * (L - 1) / (n - 1)));
  const speedOf = (t, L, n) => t.enemySpeed * (1 + 0.20 * (L - 1) / (n - 1));
  const hpOf = (t, L, n, w) => Math.ceil(t.enemyHP * (1 + 0.35 * (L - 1) / (n - 1)) * (1 + 0.08 * w));

  /* S 形路径模板池 ×3（waypoint 折线；总长约 1100px） */
  const TPL = [
    [[-20, 150], [290, 150], [290, 340], [85, 340], [85, 530], [395, 530]],
    [[60, 40], [315, 40], [315, 240], [60, 240], [60, 440], [315, 440], [315, 590], [-20, 590]],
    [[-20, 90], [300, 90], [300, 260], [75, 260], [75, 430], [300, 430], [300, 590], [60, 590]],
  ];

  return function (game) {
    const { cfg, rng } = game;
    const t = Object.assign({ gold0: 120, livesBase: 10, enemyHP: 10, waveSize: 8, wavesCap: 10, enemySpeed: 40, slots: 12 }, cfg.typeExtra);
    const area = game.area, N = cfg.levels, L = game.level;
    const wavesN = wavesOf(t, L, N), sizeN = sizeOf(t, L, N), spd = speedOf(t, L, N);
    const enemiesTotal = wavesN * sizeN;

    /* 路径（seed 选模板）+ 弧长参数化 */
    const tpl = TPL[(rng() * TPL.length) | 0];
    const path = tpl.map(([x, y]) => ({ x, y: area.y + 20 + y * (area.h - 40) / 600 }));
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const pathLen = cum[cum.length - 1];
    function posAt(d) {
      d = G.clamp(d, 0, pathLen);
      let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
      const f = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return { x: G.lerp(path[i - 1].x, path[i].x, f), y: G.lerp(path[i - 1].y, path[i].y, f) };
    }

    /* 塔位：沿路径两侧均匀布设（每侧 t.slots/2 个，等距；越界翻面重试） */
    const slots = [];
    const half = Math.floor(t.slots / 2);
    for (let k = 0; k < t.slots; k++) {
      const sideGroup = k < half ? 0 : 1;                 // 0 = 优先一侧，1 = 优先另一侧
      const i = k % half;
      const d = 70 + (pathLen - 140) * (i + 0.5) / half;  // 两侧错位半格
      const p = posAt(d);
      const q = posAt(d + 4), dx = q.x - p.x, dy = q.y - p.y, dl = Math.hypot(dx, dy) || 1;
      for (const side of (sideGroup ? [1, -1] : [-1, 1])) {
        const nx = p.x + (-dy / dl) * 42 * side, ny = p.y + (dx / dl) * 42 * side;
        if (nx > 26 && nx < area.w - 26 && ny > area.y + 26 && ny < area.y + area.h - 96) { slots.push({ x: nx, y: ny, tower: null }); break; }
      }
    }

    /* 出怪类型全序（seed 预掷，保证同 seed 同关完全一致） */
    const fastSeq = [];
    for (let i = 0; i < enemiesTotal; i++) fastSeq.push(rng() < 0.25);

    let gold, lives, wave, enemies, beams, booms, over, won, score;
    let spawnLeft = 0, spawnT = 0, interT = 0, waveClears = 0, countedWave = 0, kills = 0;
    let card = null;   // {slot} 建塔卡 | {slot, tower} 升级/出售卡

    const hud = () => [{ t: '金币', v: gold }, { t: '生命', v: lives }];
    function startWave(w) {
      wave = w; spawnLeft = sizeN; spawnT = 0;
      game.setHud(hud());
    }
    function enemyHp(w) { return hpOf(t, L, N, w); }
    function finish(win) {
      if (over) return;
      over = true; won = win;
      score = kills * 10 + (win ? lives * 50 : 0) + waveClears * 30;
      win ? game.win(score, { s2: 12 * enemiesTotal, s3: 15 * enemiesTotal }) : game.lose(score);
    }

    return {
      startLevel() {
        gold = t.gold0; lives = t.livesBase; wave = 0; kills = 0; waveClears = 0; countedWave = 0;
        enemies = []; beams = []; booms = []; over = false; won = false; card = null;
        startWave(1);
      },
      update(dt) {
        if (over) return;
        /* 出怪（间隔 900ms） */
        if (spawnLeft > 0) {
          spawnT -= dt;
          if (spawnT <= 0) {
            spawnT += 0.9;
            const fast = fastSeq[(wave - 1) * sizeN + (sizeN - spawnLeft)];
            const hp = Math.ceil(enemyHp(wave) * (fast ? 0.7 : 1));
            enemies.push({ d: 0, hp, hp0: hp, speed: spd * (fast ? 1.5 : 1), fast, slowT: 0 });
            spawnLeft--;
          }
        } else if (enemies.length === 0) {
          if (wave > countedWave) { waveClears++; countedWave = wave; game.toast(`第 ${wave} 波守住！`); }
          if (wave >= wavesN) { finish(true); return; }
          interT += dt;
          if (interT >= 1.2) { interT = 0; startWave(wave + 1); }
        }
        /* 敌人推进 */
        for (const e of enemies) {
          e.slowT = Math.max(0, e.slowT - dt);
          e.d += e.speed * (e.slowT > 0 ? 0.6 : 1) * dt;
        }
        const leaked = enemies.filter(e => e.d >= pathLen);
        if (leaked.length) {
          lives -= leaked.length;
          enemies = enemies.filter(e => e.d < pathLen);
          game.setHud(hud());
          if (lives <= 0) { finish(false); return; }
        }
        /* 塔索敌（优先离洞口最近）与开火 */
        for (const s of slots) {
          const tw = s.tower;
          if (!tw) continue;
          tw.cd = Math.max(0, tw.cd - dt);
          if (tw.cd > 0) continue;
          let best = null;
          for (const e of enemies) {
            const p = posAt(e.d);
            if (Math.hypot(p.x - s.x, p.y - s.y) <= tw.range) { if (!best || e.d > best.d) best = e; }
          }
          if (!best) continue;
          const spec = TOWERS[tw.kind], lv = tw.level;
          const dmg = spec.dmg * Math.pow(1.6, lv);
          const bp = posAt(best.d);
          beams.push({ x1: s.x, y1: s.y, x2: bp.x, y2: bp.y, t: .12, color: spec.color });
          tw.cd = 1 / (spec.rate * Math.pow(1.15, lv));
          if (spec.splash) {
            booms.push({ x: bp.x, y: bp.y, r: spec.splash * (1 + 0.2 * lv), t: .3 });
            for (const e of enemies) {
              const p = posAt(e.d);
              if (Math.hypot(p.x - bp.x, p.y - bp.y) <= spec.splash * (1 + 0.2 * lv)) e.hp -= dmg;
            }
          } else {
            best.hp -= dmg;
            if (spec.slowT) best.slowT = spec.slowT * (1 + 0.4 * lv);
          }
        }
        /* 结算死亡（击杀金 = ceil(hp0×0.6)，含快速怪折算） */
        const dead = enemies.filter(e => e.hp <= 0);
        if (dead.length) {
          for (const e of dead) { gold += Math.ceil(e.hp0 * 0.6); kills++; }
          enemies = enemies.filter(e => e.hp > 0);
          game.setHud(hud());
        }
        for (const b of beams) b.t -= dt;
        beams = beams.filter(b => b.t > 0);
        for (const b of booms) b.t -= dt;
        booms = booms.filter(b => b.t > 0);
      },
      render(g) {
        /* 路径 */
        g.strokeStyle = '#232c42'; g.lineWidth = 30; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) g.lineTo(path[i].x, path[i].y);
        g.stroke();
        g.strokeStyle = '#1a2133'; g.lineWidth = 24; g.stroke();
        const exit = posAt(pathLen);
        g.fillStyle = '#05070c'; g.beginPath(); g.arc(exit.x, exit.y, 15, 0, 7); g.fill();
        g.strokeStyle = '#ff8fa3'; g.lineWidth = 2; g.stroke();
        /* 波次信息 */
        g.fillStyle = '#8b94a7'; g.font = G.FONT(12, 500); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`第 ${Math.min(wave, wavesN)} / ${wavesN} 波 · 剩余敌人 ${enemies.length + spawnLeft}`, area.w / 2, area.y + 18);
        /* 塔位与塔 */
        for (const s of slots) {
          if (!s.tower) {
            g.fillStyle = card && card.slot === s ? '#2f4166' : '#1c2537';
            g.strokeStyle = '#3a4a6b'; g.lineWidth = 1.5;
            G.roundRect(g, s.x - 16, s.y - 16, 32, 32, 8); g.fill(); g.stroke();
            g.fillStyle = '#3f4f70'; g.font = G.FONT(15, 700); g.fillText('+', s.x, s.y + 1);
          } else {
            const tw = s.tower, spec = TOWERS[tw.kind];
            g.fillStyle = spec.color;
            g.beginPath(); g.arc(s.x, s.y, 13 + tw.level * 2, 0, 7); g.fill();
            g.strokeStyle = '#101522'; g.lineWidth = 2; g.stroke();
            g.fillStyle = '#101522'; g.font = G.FONT(9, 800);
            g.fillText(tw.kind === 'arrow' ? '箭' : tw.kind === 'ice' ? '冰' : '炮', s.x, s.y + .5);
            if (tw.level > 0) { g.fillStyle = '#ffd166'; g.font = G.FONT(9, 700); g.fillText('★'.repeat(tw.level), s.x, s.y - 20); }
            if (card && card.slot === s) { g.strokeStyle = '#ffd166'; g.lineWidth = 2.5; g.beginPath(); g.arc(s.x, s.y, 18, 0, 7); g.stroke(); }
          }
        }
        /* 敌人 */
        for (const e of enemies) {
          const p = posAt(e.d);
          g.fillStyle = e.fast ? '#ffd166' : '#ff8fa3';
          g.beginPath(); g.arc(p.x, p.y, e.fast ? 8 : 10, 0, 7); g.fill();
          g.strokeStyle = '#101522'; g.lineWidth = 1.5; g.stroke();
          if (e.hp < e.hp0) {   /* 血条 */
            g.fillStyle = '#101522'; g.fillRect(p.x - 11, p.y - 17, 22, 4);
            g.fillStyle = '#7bd88f'; g.fillRect(p.x - 10, p.y - 16, 20 * G.clamp(e.hp / e.hp0, 0, 1), 2);
          }
          if (e.slowT > 0) { g.strokeStyle = 'rgba(77,208,225,.7)'; g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, 13, 0, 7); g.stroke(); }
        }
        for (const b of beams) {
          g.globalAlpha = b.t / .12; g.strokeStyle = b.color; g.lineWidth = 2.5;
          g.beginPath(); g.moveTo(b.x1, b.y1); g.lineTo(b.x2, b.y2); g.stroke(); g.globalAlpha = 1;
        }
        for (const b of booms) {
          g.globalAlpha = b.t / .3; g.strokeStyle = '#ff9f43'; g.lineWidth = 3;
          g.beginPath(); g.arc(b.x, b.y, b.r * (1 - b.t / .3) + 6, 0, 7); g.stroke(); g.globalAlpha = 1;
        }
        /* 底部建塔/升级卡（主操作区，屏下 1/3） */
        if (card && !over) {
          const cy = area.y + area.h - 74;
          g.fillStyle = '#151b2eee'; g.fillRect(0, cy - 8, area.w, 96);
          const items = [];
          if (!card.slot.tower) {
            for (const k of Object.keys(TOWERS)) items.push({ key: k, label: `${TOWERS[k].name} ${TOWERS[k].cost}`, ok: gold >= TOWERS[k].cost });
          } else {
            const tw = card.slot.tower, spec = TOWERS[tw.kind];
            if (tw.level < 2) items.push({ key: 'up', label: `升级 ${Math.round(spec.cost * 1.5)}`, ok: gold >= Math.round(spec.cost * 1.5) });
            items.push({ key: 'sell', label: `出售 +${Math.round(tw.invest * .7)}`, ok: true });
            items.push({ key: 'cancel', label: '取消', ok: true });
          }
          const bw = 106, bh = 52, gap = 10, x0 = (area.w - items.length * bw - (items.length - 1) * gap) / 2;
          items.forEach((it, i) => {
            it.r = { x: x0 + i * (bw + gap), y: cy + 6, w: bw, h: bh };
            g.fillStyle = it.ok ? '#2c3a5c' : '#1a2133';
            G.roundRect(g, it.r.x, it.r.y, it.r.w, it.r.h, 10); g.fill();
            g.strokeStyle = it.ok ? '#4a5a83' : '#232c42'; g.lineWidth = 1.5; G.roundRect(g, it.r.x, it.r.y, it.r.w, it.r.h, 10); g.stroke();
            g.fillStyle = it.ok ? '#e8ecf3' : '#5b6478'; g.font = G.FONT(13, 600);
            g.fillText(it.label, it.r.x + bw / 2, it.r.y + bh / 2);
          });
          card.items = items;
        }
      },
      onDown() { },
      onMove() { },
      onUp(x, y) {
        if (over) return;
        /* 先走卡片按钮 */
        if (card && card.items) {
          for (const it of card.items) {
            const r = it.r;
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
              const tw = card.slot.tower;
              if (!tw && it.ok) {
                card.slot.tower = { kind: it.key, level: 0, cd: 0, range: TOWERS[it.key].range, invest: TOWERS[it.key].cost };
                gold -= TOWERS[it.key].cost;
              } else if (tw && it.key === 'up' && it.ok) {
                const cost = Math.round(TOWERS[tw.kind].cost * 1.5);
                gold -= cost; tw.invest += cost; tw.level++;
              } else if (tw && it.key === 'sell') {
                gold += Math.round(tw.invest * .7); card.slot.tower = null;
              }
              card = null; game.setHud(hud());
              return;
            }
          }
          card = null; return;                       // 点卡片外 = 关卡
        }
        /* 点塔位/塔 */
        for (const s of slots) {
          if (Math.hypot(x - s.x, y - s.y) <= 26) { card = { slot: s }; return; }
        }
      },
      __state: () => ({
        gold, lives, wave, wavesN, sizeN, enemiesTotal, kills, waveClears, over,
        slots: slots.map(s => ({ x: s.x, y: s.y, tower: s.tower ? { kind: s.tower.kind, level: s.tower.level } : null })),
        pathPos: posAt, pathLen, hp: enemyHp(wave), card: !!card,
      }),
    };
  };
})();
