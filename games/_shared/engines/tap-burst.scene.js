'use strict';
/* =====================================================================
 * GAMES-22 狂点爆发 Phaser 表现层（spec §7）。
 * 消费同目录 tap-burst.js 逻辑引擎（纯 JS，QA harness 可 vm 驱动）——本场景只做：
 *   纹理生成（一次 generateTexture）/ sprite 池复用 / 输入转发（Phaser Input）/
 *   命中粒子与音效（装饰）。判定节奏/seed/计分全部在逻辑引擎内（确定性不变）。
 * ===================================================================== */
class TapBurstScene extends GE.PlayScene {
  constructor() { super('play'); }

  createPlay() {
    const A = this.area;
    this.makeTextures();
    this.logic = TapBurstEngine(this.gameCtx);
    this.logic.startLevel();

    /* 顶栏下倒计时条（状态区 §5.5） */
    this.tBarBg = this.add.rectangle(20, A.y + 8, A.w - 40, 4, 0x1a2133).setOrigin(0, 0.5);
    this.tBar = this.add.rectangle(20, A.y + 8, A.w - 40, 4, 0x7bd88f).setOrigin(0, 0.5);

    this.live = new Map();      // key "x,y" → sprite 组（主圆+高光 / 陷阱）
    this.pool = [];             // 回收池（纹理层复用，零 GC）
    this.fxPool = [];           // 命中粒子池
    this._hits = 0;
  }

  /** 纹理一次生成（白色基底 + tint 上色 → 任意 hue 零额外纹理） */
  makeTextures() {
    if (this.textures.exists('tb-dot')) return;
    const g = this.make.graphics({ add: false });
    g.fillStyle(0xffffff, 1); g.fillCircle(64, 64, 62); g.generateTexture('tb-dot', 128, 128);
    g.clear();
    g.fillStyle(0xffffff, 1); g.fillCircle(16, 16, 14); g.generateTexture('tb-shine', 32, 32);
    g.clear();
    g.fillStyle(0x2a1520, 1); g.fillCircle(40, 40, 38);
    g.lineStyle(5, 0xff8fa3, 1);
    g.lineBetween(22, 22, 58, 58); g.lineBetween(58, 22, 22, 58);
    g.generateTexture('tb-cross', 80, 80);
    g.clear();
    g.fillStyle(0xffffff, 1); g.fillCircle(8, 8, 6); g.generateTexture('tb-spark', 16, 16);
    g.destroy();
  }

  /** 从池取一个 sprite 组 */
  takeSprite(kind, hue) {
    const s = this.pool.pop() || {
      dot: this.add.image(0, 0, 'tb-dot'),
      shine: this.add.image(0, 0, 'tb-shine').setAlpha(0.35),
      cross: this.add.image(0, 0, 'tb-cross'),
    };
    const decoy = kind === 'decoy';
    s.dot.setVisible(!decoy).setTint(hue);
    s.shine.setVisible(!decoy);
    s.cross.setVisible(decoy);
    return s;
  }
  giveSprite(s) { this.tweens.killTweensOf(s.dot); s.dot.setVisible(false); s.shine.setVisible(false); s.cross.setVisible(false); this.pool.push(s); }

  /** 命中粒子（装饰，非判定路径）：6 向 spark 向外飞散 */
  burst(x, y, hue) {
    const tint = hue != null ? hue : 0xffffff;
    for (let i = 0; i < 6; i++) {
      const sp = this.fxPool.pop() || this.add.image(0, 0, 'tb-spark');
      sp.setVisible(true).setAlpha(1).setTint(tint).setPosition(x, y).setScale(1);
      const a = i * Math.PI / 3;
      this.tweens.add({
        targets: sp, x: x + Math.cos(a) * 52, y: y + Math.sin(a) * 52, alpha: 0, duration: 400, ease: 'cubic.out',
        onComplete: () => { sp.setVisible(false); this.fxPool.push(sp); },
      });
    }
  }

  updatePlay(dt) {
    this.logic.update(dt);
    const st = this.logic.__state();
    this._state = st;   // QA/debug 句柄（__GAMES_DEBUG__.state() 透出）
    /* --- 计时条 --- */
    const tr = GE.clamp(st.timeLeft / st.time, 0, 1);
    this.tBar.width = Math.max(0, (this.area.w - 40) * tr);
    this.tBar.fillColor = tr > 0.25 ? 0x7bd88f : 0xff8fa3;
    /* --- 目标/陷阱 sprite 同步（key diff，池复用） --- */
    const seen = new Set();
    for (const it of st.items) {
      const [x, y, r, decoy, hue] = it;
      const key = x + ',' + y;
      seen.add(key);
      let s = this.live.get(key);
      if (!s) {
        s = this.takeSprite(decoy ? 'decoy' : 'dot', GE.hsl(hue, 70, 58));
        s.decoy = !!decoy;
        s.dot.setPosition(x, y).setDisplaySize(r * 2, r * 2);
        s.shine.setPosition(x - r * 0.28, y - r * 0.3).setDisplaySize(r * 0.48, r * 0.48);
        s.cross.setPosition(x, y).setDisplaySize(r * 1.44, r * 1.44);
        if (!decoy) {   // 呼吸感（装饰 tween，不进判定路径）
          this.tweens.add({ targets: [s.dot], scale: { from: s.dot.scaleX * 0.96, to: s.dot.scaleX * 1.04 }, duration: 500, yoyo: true, repeat: -1, ease: 'sine.inout' });
        }
        this.live.set(key, s);
      }
    }
    for (const [key, s] of this.live) {
      if (!seen.has(key)) { this.giveSprite(s); this.live.delete(key); }
    }
    /* --- 命中音效/粒子（差分装饰） --- */
    if (st.hits > this._hits) { this.snd('pop'); this.burst(this._lastTap.x, this._lastTap.y, this._lastHue); }
    this._hits = st.hits;
  }

  playDown(x, y) { this.logic.onDown(x, y); }
  playMove(x, y) { this.logic.onMove(x, y); }
  playUp(x, y) {
    /* 记录 tap 时刻最近目标（粒子落点；判定在逻辑引擎） */
    const st = this.logic.__state();
    this._lastTap = { x, y };
    this._lastHue = null;
    for (const it of st.items) {
      const [ix, iy, r] = it;
      if ((x - ix) * (x - ix) + (y - iy) * (y - iy) <= r * r) { this._lastHue = GE.hsl(it[4], 80, 70); break; }
    }
    this.logic.onUp(x, y);
  }
}
