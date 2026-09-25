'use strict';
/* =====================================================================
 * GAMES-22 车道跑酷 Phaser 表现层（spec §9）。
 * 消费同目录 lane-runner.js 逻辑引擎（纯 JS，QA harness 可 vm 驱动）——本场景只做：
 *   纹理生成（一次 generateTexture）/ 分段 sprite 视口同步（屏外回收池化）/
 *   输入转发（Phaser Input，swipe 判定在逻辑引擎）。车道生成/碰撞/计分/seed
 *   全部在逻辑引擎内（安全走廊不变量与确定性不变）。
 * ===================================================================== */
class LaneRunnerScene extends GE.PlayScene {
  constructor() { super('play'); }

  createPlay() {
    const A = this.area;
    this.makeTextures();
    this.logic = LaneRunnerEngine(this.gameCtx);
    this.logic.startLevel();
    const st = this.logic.__state();

    /* 车道分隔线（静态，一次绘制） */
    const lg = this.add.graphics();
    for (let l = 0; l <= 3; l++) {
      lg.lineStyle(l % 3 === 0 ? 2 : 1, 0x1c2438, 1);
      lg.lineBetween(A.w / 3 * l, A.y, A.w / 3 * l, A.y + A.h);
    }
    /* 顶栏下进度条 */
    this.pBarBg = this.add.rectangle(20, A.y + 8, A.w - 40, 4, 0x1a2133).setOrigin(0, 0.5);
    this.pBar = this.add.rectangle(20, A.y + 8, 1, 4, 0x7bd88f).setOrigin(0, 0.5);

    /* 终点线（tileSprite 竖条带，随 dist 滚动） */
    this.finishLine = this.add.tileSprite(A.w / 2, 0, A.w, 16, 'lr-finish');

    /* 角色（纹理 34×46 + 头部高光） */
    this.player = this.add.container(0, 0, [
      this.add.image(0, 0, 'lr-player'),
    ]);

    this.cells = new Map();     // key "s,l" → sprite（ob-low/ob-tall/coin 混合池按纹理分池）
    this.pools = { 1: [], 2: [], 3: [] };
    this._coins = 0;
  }

  makeTextures() {
    if (this.textures.exists('lr-player')) return;
    const g = this.make.graphics({ add: false });
    g.fillStyle(0x3b4a6b, 1); g.fillRoundedRect(0, 0, 68, 42, 6); g.generateTexture('lr-ob-low', 68, 42);
    g.clear();
    g.fillStyle(0x5b3b6b, 1); g.fillRoundedRect(0, 0, 72, 88, 6);
    g.fillStyle(0xff8fa3, 1); g.fillRect(0, 0, 72, 6);
    g.generateTexture('lr-ob-tall', 72, 88);
    g.clear();
    g.fillStyle(0xffd166, 1); g.fillCircle(9, 9, 9);
    g.lineStyle(2, 0xb8860b, 1); g.strokeCircle(9, 9, 6);
    g.generateTexture('lr-coin', 18, 18);
    g.clear();
    g.fillStyle(0x9fc0ff, 1); g.fillRoundedRect(0, 0, 34, 46, 9);
    g.fillStyle(0xe8ecf3, 1); g.fillCircle(17, 12, 6);
    g.generateTexture('lr-player', 34, 46);
    g.clear();
    /* 终点旗纹（8×8 双色格） */
    g.fillStyle(0x7bd88f, 1); g.fillRect(0, 0, 8, 8);
    g.fillStyle(0xe8f5ec, 1); g.fillRect(0, 0, 4, 4); g.fillRect(4, 4, 4, 4);
    g.generateTexture('lr-finish', 8, 8);
    g.destroy();
  }

  updatePlay(dt) {
    this.logic.update(dt);
    const st = this.logic.__state();
    this._state = st;   // QA/debug 句柄（__GAMES_DEBUG__.state() 透出）
    const A = this.area;
    const playerY = A.y + A.h * 0.70;
    const laneW = A.w / 3;
    const laneX = (l) => laneW * (l + 0.5);

    /* 进度条 */
    this.pBar.width = Math.max(1, (A.w - 40) * GE.clamp(st.dist / st.distance, 0, 1));

    /* 终点线 */
    const fy = playerY - (st.distance - st.dist);
    this.finishLine.setVisible(fy > A.y - 10 && fy < A.y + A.h).setPosition(A.w / 2, fy);

    /* 分段物品视口同步：seg±6 内创建，出屏回收（池按类型分池，零纹理切换浪费） */
    const seg = Math.floor(st.dist / 120);
    const seen = new Set();
    for (let s = Math.max(0, seg - 6); s <= Math.min(st.segN - 1, seg + 6); s++) {
      const z = s * 120 + 60;
      const y = playerY - (z - st.dist);
      if (y < A.y + 12 || y > A.y + A.h + 40) continue;
      for (let l = 0; l < 3; l++) {
        const v = +st.lanes[s][l];
        if (!v) continue;
        const key = s + ',' + l;
        seen.add(key);
        let sp = this.cells.get(key);
        if (!sp) {
          sp = this.pools[v].pop() || this.add.image(0, 0, v === 1 ? 'lr-ob-low' : v === 3 ? 'lr-ob-tall' : 'lr-coin');
          sp.setTexture(v === 1 ? 'lr-ob-low' : v === 3 ? 'lr-ob-tall' : 'lr-coin').setVisible(true);
          if (v === 2) this.tweens.add({ targets: sp, scale: { from: 0.9, to: 1.1 }, duration: 600, yoyo: true, repeat: -1, ease: 'sine.inout' });
          this.cells.set(key, sp);
        }
        const x = laneX(l);
        if (v === 1) sp.setPosition(x, y - 21);
        else if (v === 3) sp.setPosition(x, y - 44);
        else sp.setPosition(x, y - 26);
      }
    }
    for (const [key, sp] of this.cells) {
      if (!seen.has(key)) {
        this.tweens.killTweensOf(sp);
        sp.setVisible(false);
        this.pools[sp.texture.key === 'lr-coin' ? 2 : sp.texture.key === 'lr-ob-tall' ? 3 : 1].push(sp);
        this.cells.delete(key);
      }
    }

    /* 角色（换道 x 平滑 + 跳跃 y + 无敌闪烁） */
    this.player.setPosition(st.px, playerY - 23 - st.jumpY);
    this.player.list[0].setAlpha(st.invuln > 0 && Math.floor(st.invuln * 10) % 2 === 0 ? 0.25 : 1);

    /* 金币音效（差分装饰） */
    if (st.coins > this._coins) this.snd('pop');
    this._coins = st.coins;
  }

  playDown(x, y) { this.logic.onDown(x, y); }
  playMove(x, y) { this.logic.onMove(x, y); }
  playUp(x, y) { this.logic.onUp(x, y); }
}
