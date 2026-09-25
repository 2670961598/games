'use strict';
/* =====================================================================
 * 翻牌配对引擎（spec §20）：网格扣牌两两翻開配对，误试步数上限内配平全部。
 * 曲线：pairs(L)=min(pairsCap,round(pairsBase×(1+0.30p)))；moves(L)=ceil(pairs(L)×moveFactor)；
 *       p=(L−1)/(Ln−1)。peekMs=入场预览（资源类反向）；gridW=列数（行=⌈卡数/列⌉）。
 * 生成（§20）：牌面花色与位置由 seed 洗牌（Fisher–Yates）；"无重复三连同花初始行"
 *   ——每花色恰 2 张，三连数学上不可能，不变量由 QA 断言兜底（见注释裁量）。
 * 裁量：一次误试=翻第二张牌记 1 步；误试双牌亮 0.75s（步进计时，非 setTimeout）后扣回；
 *   预览期间点按忽略；步数耗尽且未配平=败，末次尝试若配平则先判胜。
 * 计分：score=配对数×30+剩余步×5；s2=pairs(L)×36，s3=pairs(L)×45。
 * 交互（§20）：牌格占屏宽 92%，牌面热区即牌格；顶部步数余量。
 * ===================================================================== */
const MemoryFlipEngine = (function () {
  const HOLD = 0.75;           // 误试亮牌时长（秒，步进）
  const STEP = 1 / 120;

  return function (game) {
    const { cfg, rng, area } = game;
    const t = Object.assign({ pairsBase: 8, pairsCap: 12, gridW: 4, peekMs: 1500, moveFactor: 2.5 }, cfg.typeExtra);
    const n = cfg.levels, L = game.level, p = (L - 1) / (n - 1);
    const pairs = Math.min(t.pairsCap, Math.round(t.pairsBase * (1 + 0.30 * p)));
    const movesMax = Math.ceil(pairs * t.moveFactor);
    const cols = t.gridW, rows = Math.ceil(pairs * 2 / cols);

    /* --- 洗牌（seed，Fisher–Yates） --- */
    const deck = [];
    for (let s = 0; s < pairs; s++) { deck.push(s, s); }
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    /* --- 牌格几何（占屏宽 92%，§20） --- */
    const gw = area.w * 0.92, x0 = (area.w - gw) / 2;
    const gy0 = area.y + 40, gh = area.h - 58;
    const cw = gw / cols, ch = gh / rows;
    const cardW = Math.min(cw - 8, ch - 8, 96), cardH = cardW;
    const rect = i => [x0 + (i % cols) * cw + (cw - cardW) / 2, gy0 + Math.floor(i / cols) * ch + (ch - cardH) / 2];

    /* --- 运行状态 --- */
    let cards = deck.map((face, i) => ({ face, i, up: false, matched: false }));
    let peek = t.peekMs / 1000, flip1 = null, flip2 = null;
    let holdT = 0, movesUsed = 0, matched = 0, score = 0, done = false, anim = 0;
    let down = null;

    function finishCheck() {
      if (matched >= pairs) {                                  // 配平全部（§20）
        done = true; score = pairs * 30 + (movesMax - movesUsed) * 5;
        game.win(score, { s2: pairs * 36, s3: pairs * 45 });
        return true;
      }
      if (movesUsed >= movesMax) { done = true; score = matched * 30; game.lose(score); return true; }   // 步数耗尽
      return false;
    }

    function step() {
      if (done) return;
      if (peek > 0) { peek -= STEP; if (peek <= 0) { peek = 0; for (const c of cards) c.up = false; } return; }
      if (holdT > 0) {                                         // 误试亮牌→扣回
        holdT -= STEP;
        if (holdT <= 0) {
          flip1.up = flip2.up = false; flip1 = flip2 = null;
          finishCheck();                                       // 步数耗尽在扣回后判定
        }
      }
    }

    function tap(x, y) {
      if (done || peek > 0 || holdT > 0) return;
      for (const c of cards) {
        if (c.matched) continue;
        const [cx, cy] = rect(c.i);
        if (x >= cx && x <= cx + cardW && y >= cy && y <= cy + cardH) {
          if (c.up) return;                                    // 已亮未判的牌不可再点
          c.up = true;
          if (!flip1) { flip1 = c; return; }
          flip2 = c;
          movesUsed++;                                         // 翻第二张记 1 步（裁量）
          if (flip1.face === flip2.face) {                     // 配对
            flip1.matched = flip2.matched = true;
            matched++;
            flip1 = flip2 = null;
            finishCheck();
          } else {
            holdT = HOLD;                                      // 误试：亮牌→扣回
          }
          return;
        }
      }
    }

    return {
      startLevel() { game.setHud([{ t: `/对${pairs}`, v: 0 }, { t: `/${movesMax}步`, v: 0 }, { t: '预览', v: peek }]); },
      update(dt) {
        anim += dt;
        let acc = dt;
        while (acc >= STEP) { acc -= STEP; step(); if (done) break; }
        game.setHud([
          { t: `/对${pairs}`, v: matched },
          { t: `/${movesMax}步`, v: movesUsed },
          { t: peek > 0 ? '预览' : '配对', v: peek > 0 ? +peek.toFixed(1) : matched },
        ]);
      },
      onDown(x, y) { down = { x, y }; },
      onMove() { },
      onUp(x, y) { if (down && Math.abs(x - down.x) < 24 && Math.abs(y - down.y) < 24) tap(x, y); down = null; },
      render(g) {
        for (const c of cards) {
          const [cx, cy] = rect(c.i);
          const hue = (c.face * 47 + 205) % 360;
          if (c.up || c.matched || peek > 0) {                 // 亮面
            g.globalAlpha = c.matched ? 0.55 : 1;
            g.fillStyle = `hsl(${hue},62%,52%)`;
            G.roundRect(g, cx, cy, cardW, cardH, 10); g.fill();
            g.strokeStyle = `hsl(${hue},62%,38%)`; g.lineWidth = 2;
            G.roundRect(g, cx, cy, cardW, cardH, 10); g.stroke();
            g.fillStyle = '#fff'; g.font = G.FONT(Math.min(26, cardW * 0.4), 800);
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(['♠', '♥', '♦', '♣', '★', '●', '▲', '◆', '✿', '❄', '☾', '⛨', '✚', '✈', '⚓', '☘'][c.face % 16], cx + cardW / 2, cy + cardH / 2);
            g.globalAlpha = 1;
          } else {                                             // 扣面
            g.fillStyle = '#2c3a5c';
            G.roundRect(g, cx, cy, cardW, cardH, 10); g.fill();
            g.strokeStyle = '#3b4a6b'; g.lineWidth = 2;
            G.roundRect(g, cx + 5, cy + 5, cardW - 10, cardH - 10, 7); g.stroke();
            g.fillStyle = '#3b4a6b'; g.font = G.FONT(13, 600);
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('?', cx + cardW / 2, cy + cardH / 2);
          }
        }
        if (peek > 0) {                                        // 预览倒计时带（§20）
          g.fillStyle = 'rgba(11,14,20,.7)'; g.fillRect(0, area.y + 8, area.w, 30);
          g.fillStyle = '#ffd166'; g.font = G.FONT(15, 700); g.textAlign = 'center';
          g.fillText(`记住位置 ${peek.toFixed(1)}s`, area.w / 2, area.y + 23);
        }
      },
      __state() {
        return {
          pairs, movesMax, movesUsed, matched, peekMs: t.peekMs,
          peek: +peek.toFixed(2), hold: +holdT.toFixed(2), cols, rows, done, score,
          cards: cards.map(c => [c.face, c.matched ? 1 : 0, c.up ? 1 : 0]),
          rects: cards.map(c => { const [cx, cy] = rect(c.i); return [+cx.toFixed(1), +cy.toFixed(1), +cardW.toFixed(1), +cardH.toFixed(1)]; }),
        };
      },
    };
  };
})();
