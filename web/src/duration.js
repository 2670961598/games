// 游戏可见时长计时器：GAMES-5 需求 4（可见计时、切走/隐藏暂停）。
// 纯逻辑模块——时钟通过 { now } 注入，scripts/smoke-feed.js 用假时钟测试。

export class DurationTracker {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now
    this._since = null // 当前运行区间的起点；null = 已暂停
    this._total = 0 // 已落账的累计毫秒
  }

  get running() {
    return this._since !== null
  }

  /** 累计毫秒（含正在运行的区间） */
  get elapsed() {
    return this._total + (this.running ? this._now() - this._since : 0)
  }

  start() {
    if (!this.running) this._since = this._now()
  }

  stop() {
    if (this.running) {
      this._total += this._now() - this._since
      this._since = null
    }
  }

  /** 取走全部累计并清零（先 stop 再结算；之后可重新 start） */
  consume() {
    this.stop()
    const t = this._total
    this._total = 0
    return t
  }
}
