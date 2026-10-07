/* =====================================================================
 * 蛇王争霸 两端同一段纯函数（S6，设计书 §2.3/§5.1/§5.3）。
 * 单一事实源：服务端 sim（server/gateway/sims/snake-king.js 经 require 载入）
 * 与客户端（index.html <script> 载入，设 window.SnakeK）跑同一份代码：
 *   - 成长四权衡曲线 v(n)/w(n)/zoom(n)/aoiR(n)（§2.3 表逐档）；
 *   - 转向积分 stepTurn（§3.1 两端同式，指哪转哪的核）；
 *   - 蛇身=path 回放派生 segsFromPath（§5.1 增量只发头的技术支点）。
 * 整数纪律（沿用目录 milli-px 习惯）：位置 milli-px（int），角度整数度 [0,359]，
 * 运算只有 +-*/ 与 Math.*，无 Date/random 入判定路径。
 * ===================================================================== */
;(function (root) {
  'use strict'

  var W = 1800 * 1000            // 世界宽 milli-px（§2.1）
  var H = 1800 * 1000
  var TICK_MS = 100              // 10Hz
  var ROUND_TICKS = 3600         // 一轮 6 分钟（§1.1）
  var N0 = 10                    // 出生节数
  var N_CAP = 140                // 长度封顶（附决策 11）
  var SEG_GAP = 12000            // 节距 12px（§2.3）
  var PATH_CAP = 144             // path ring 容量（§5.1）
  var SPAWN_PROT = 30            // 出生保护 30 tick（§2.4）
  var RESPAWN_TICKS = 30         // 复活 3s（§1.2）
  var HEAD_R = 7000              // 蛇头碰撞半径 7px
  var EAT_R = 14000              // 吃判定距离 14px（§2.2）
  var HIT_R = 14000              // 头-身碰撞距离 14px（§2.4）
  var WALL_MARGIN = 8000         // 撞墙边距 8px
  var DROP_TTL = 900             // 掉落光点 TTL 90s（§2.4）
  var DROPS_CAP = 240            // 瞬态光点硬顶（§2.4）
  var BOT_TARGET = 20            // 房实体目标 20 蛇（§2.1）
  var EAT_DOTS = { grass: 1, berry: 2, ore: 4, drop: 2, tail: 1 } // 三档+瞬态（§2.2）

  /* ---------- 成长四权衡曲线（§2.3 表逐档；v 单位 mpx/tick） ---------- */
  function vOf(n) { return Math.max(110000, 130000 - 2000 * Math.floor((n - 10) / 10)) }
  function wOf(n) { return Math.max(12, 26 - Math.floor(n / 10)) }       // °/tick
  function zoomOf(n) { return Math.max(0.70, 1.00 - (n - 10) * 0.0025) }
  function aoiRpx(n) { return Math.round(420 / zoomOf(n)) }              // 订阅半径 px（§5.2）
  function aoiR(n) { return aoiRpx(n) * 1000 }                           // mpx

  /* ---------- 转向积分（§3.1：目标角逼近，最短弧，角速度受限） ---------- */
  function angDiff(a, b) { var d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d }
  function stepTurn(a, target, w) {
    var d = angDiff(a, target)
    if (d > w) d = w
    if (d < -w) d = -w
    return ((a + d) % 360 + 360) % 360
  }

  /* ---------- 蛇身=path 回放（§5.1：节位置不入网络，两端同式派生） ----------
   * path 为扁平 mpx 数组 [x0,y0,x1,y1,…]，path[0]=最新头点（头轨迹倒序）。
   * 沿 path 自头回退累计弧长，每 SEG_GAP 取一节，共 n 节（含头节=path[0]）。 */
  function segsFromPath(path, n) {
    var out = []
    if (!path || path.length < 2) return out
    out.push(path[0], path[1])
    var need = 12000 // 下一节距头点的弧长
    var acc = 0
    for (var i = 2; out.length < n * 2; i += 2) {
      var ax = path[i - 2], ay = path[i - 1]
      var bx, by
      if (i + 1 < path.length) { bx = path[i]; by = path[i + 1] }
      else if (i - 1 + 2 < path.length && i >= 4) { // 沿末端方向直线外延（path 不足时身体拉直）
        bx = ax + (path[i - 2] - path[i - 4]); by = ay + (path[i - 1] - path[i - 3])
      } else { bx = ax; by = ay }
      var dx = bx - ax, dy = by - ay
      var seg = Math.sqrt(dx * dx + dy * dy)
      if (seg <= 0) continue
      while (acc + seg >= need && out.length < n * 2) {
        var t = (need - acc) / seg
        out.push(Math.round(ax + dx * t), Math.round(ay + dy * t))
        need += 12000
      }
      acc += seg
      if (i + 1 >= path.length) break
    }
    return out
  }

  /* 点到线段距离平方（§5.1 扫掠判定核：头位移线段 vs 体节圆） */
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
    N0: N0, N_CAP: N_CAP, SEG_GAP: SEG_GAP, PATH_CAP: PATH_CAP,
    SPAWN_PROT: SPAWN_PROT, RESPAWN_TICKS: RESPAWN_TICKS,
    HEAD_R: HEAD_R, EAT_R: EAT_R, HIT_R: HIT_R, WALL_MARGIN: WALL_MARGIN,
    DROP_TTL: DROP_TTL, DROPS_CAP: DROPS_CAP, BOT_TARGET: BOT_TARGET, EAT_DOTS: EAT_DOTS,
    vOf: vOf, wOf: wOf, zoomOf: zoomOf, aoiR: aoiR, aoiRpx: aoiRpx,
    stepTurn: stepTurn, angDiff: angDiff, segsFromPath: segsFromPath, segDist2: segDist2,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.SnakeK = api
})(typeof window !== 'undefined' ? window : globalThis)
