/* =====================================================================
 * 深海食物链 两端同一段纯函数（S6 第二证，设计书 §2.3/§2.4/§5.1）。
 * 单一事实源：服务端 sim（games/multiplayer/deep-foodchain/sim.cjs require 载入）
 * 与客户端（index.html <script> 载入，设 window.DeepF）跑同一份代码：
 *   - 成长四权衡曲线 r(M)/v(M)/w(M)（§2.3 表逐档——r 走 Q16 烘焙常量整数式）；
 *   - 体型四档表 tierOf/aoiR/zoom（§2.4"档即视野"，机制/带宽/Bot 三面共用一张表）；
 *   - 吞噬值表 devourOf（§2.5 一裁三账的公式核——剧本 A7 离线复算源）；
 *   - 转向积分 stepTurn（§3.1 两端同式，指哪游哪的核）+ 扫掠 segDist2（§5.3）。
 * Q16 定点纪律（设计 §2.1 定位）：无逐帧确定性义务（snake 同款声明），
 * 定点服务于两端同式纯函数 + 剧本可复算——r(M)/吞噬值全整数可复算；
 * 移动积分三角沿用 Math.*（语义稳定即可，S6 首证同口径）。
 * 整数习惯：位置 milli-px（int），角度整数度 [0,359]。
 * ===================================================================== */
;(function (root) {
  'use strict'

  var W = 1800 * 1000            // 世界宽 milli-px（§2.1）
  var H = 1800 * 1000
  var TICK_MS = 100              // 10Hz
  var ROUND_TICKS = 3600         // 一轮 6 分钟（§1.1）
  var M0 = 20                    // 破卵质量（§1.2）
  var M_CAP = 4000               // 质量封顶（§2.3 附决策 5）
  var SPAWN_PROT = 30            // 出生保护 30 tick（§2.5）
  var RESPAWN_TICKS = 30         // 重生 3s（§1.2）
  var DROP_TTL = 900             // 掉落光点 TTL 90s（§2.2）
  var DROPS_CAP = 240            // 瞬态光点硬顶（§2.2）
  var BOT_TARGET = 20            // 房实体目标 20 鱼（§2.1）
  var EAT_PAD = 10000            // 吞噬吸附半径 r+10px（§2.2）
  var DASH_MIN = 30              // dash 仅 M≥30 可用（§2.3）
  var DASH_OFF = 26              // 掉至 M<26 自动熄灭（§2.3）
  var MOUTH_K = 8                // 嘴点 = 头心 + r×0.8 前向（§2.2）
  var K_NUM = 5, K_DEN = 4       // 吞噬可吞性 K=1.25=5/4（§2.5 整数比，免浮点）

  /* ---------- 成长曲线（§2.3 表逐档；Q16 39322=0.6，isqrt 二分 15 轮） ----------
   * r(M)=6+(isqrt(M)×39322>>16) px；v 单位 mpx/tick（=px/s×100）；
   * ω(M)=max(10,25−floor(M/100)) °/tick——长大有代价：v −36%、ω −60%（§2.3） */
  function isqrt(n) {
    if (n <= 0) return 0
    var x = n, y = (n + 1) >> 1
    while (y < x) { x = y; y = (x + (n / x | 0)) >> 1 }
    return x
  }
  function rOf(M) { return 6 + (isqrt(M) * 39322 >> 16) }        // px（吞噬判定半径）
  function rOfM(M) { return rOf(M) * 1000 }                       // mpx
  function vOf(M) { var v = 150 - ((M / 50) | 0); return (v < 95 ? 95 : v) * 100 } // mpx/tick
  function wOf(M) { var w = 25 - ((M / 100) | 0); return w < 10 ? 10 : w }         // °/tick

  /* ---------- 体型四档表（§2.4——档即视野：AOI/zoom/称号三面单一事实源） ---------- */
  var TIERS = [
    { t: 0, name: '浮游', lo: 20, hi: 80, aoi: 380, zoom: 1.00, col: '#8FD8C8' },
    { t: 1, name: '小鱼', lo: 80, hi: 300, aoi: 440, zoom: 0.92, col: '#6FA8FF' },
    { t: 2, name: '猎鲨', lo: 300, hi: 1000, aoi: 500, zoom: 0.84, col: '#5C7A99' },
    { t: 3, name: '沧鲸', lo: 1000, hi: 4000, aoi: 560, zoom: 0.76, col: '#3D5A80' },
  ]
  /* 档位判定（含 §2.4 滞回：降档带 −5% 防档界抖动——curT 为当前档位时
   * M 跌回下界×0.95 才降；升档即时；死亡重置恒回 T0 由调用方处理） */
  function tierOf(M, curT) {
    var t = curT || 0
    while (t < 3 && M >= TIERS[t + 1].lo) t++
    while (t > 0 && M < Math.round(TIERS[t].lo * 0.95)) t--
    return t
  }
  function aoiR(t) { return TIERS[t].aoi * 1000 }   // mpx（§5.2 订阅口径）
  function zoomOf(t) { return TIERS[t].zoom }

  /* ---------- 吞噬值表（§2.5 一裁三账公式核——剧本 A7 离线复算源） ----------
   * gain=55% 入猎手（floor(Mv×11/20)）；dropT=45% 回收；化粒数 clamp(ceil/2,3,30)
   * 每粒 value 2 残差并末粒（大鱼尸=末粒巨点，"移动矿"叙事 §1.2） */
  function devourOf(Mv) {
    var gain = ((Mv * 11) / 20) | 0
    var dropT = Mv - gain
    var n = Math.ceil(dropT / 2)
    n = n < 3 ? 3 : n > 30 ? 30 : n
    return { gain: gain, dropT: dropT, drops: n }
  }
  /* 可吞性（连续体型比 K=1.25 纯 r 比较，档位不参与判定，§2.4） */
  function canSwallow(rMine, rVictim) { return rMine * K_DEN >= rVictim * K_NUM }

  /* ---------- 转向积分（§3.1：目标角逼近，最短弧，角速度受限） ---------- */
  function angDiff(a, b) { var d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d }
  function stepTurn(a, target, w) {
    var d = angDiff(a, target)
    if (d > w) d = w
    if (d < -w) d = -w
    return ((a + d) % 360 + 360) % 360
  }

  /* 点到线段距离平方（§5.3 扫掠判定核：头位移线段 vs 对方圆——防隧穿） */
  function segDist2(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1
    var l2 = dx * dx + dy * dy
    var t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0
    if (t < 0) t = 0; else if (t > 1) t = 1
    var qx = x1 + dx * t - px, qy = y1 + dy * t - py
    return qx * qx + qy * qy
  }

  var api = {
    W: W, H: H, TICK_MS: TICK_MS, ROUND_TICKS: ROUND_TICKS,
    M0: M0, M_CAP: M_CAP, SPAWN_PROT: SPAWN_PROT, RESPAWN_TICKS: RESPAWN_TICKS,
    DROP_TTL: DROP_TTL, DROPS_CAP: DROPS_CAP, BOT_TARGET: BOT_TARGET,
    EAT_PAD: EAT_PAD, DASH_MIN: DASH_MIN, DASH_OFF: DASH_OFF, MOUTH_K: MOUTH_K,
    K_NUM: K_NUM, K_DEN: K_DEN, TIERS: TIERS,
    isqrt: isqrt, rOf: rOf, rOfM: rOfM, vOf: vOf, wOf: wOf,
    tierOf: tierOf, aoiR: aoiR, zoomOf: zoomOf,
    devourOf: devourOf, canSwallow: canSwallow,
    stepTurn: stepTurn, angDiff: angDiff, segDist2: segDist2,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DeepF = api
})(typeof window !== 'undefined' ? window : globalThis)
