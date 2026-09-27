/* =====================================================================
 * 星海小镇 mmo-township —— 两端同一段纯函数（S2 预测一致性，设计书 §5.5）
 * 单一事实源：服务端 sim（server/gateway/sims/mmo-township.js 经 require 载入本文件）
 * 与客户端（构建期内联进 index.html，设 window.MMOPredict）跑同一份代码：
 * 移动积分（速度/加速度）+ 静态碰撞（世界边界 + 建筑 AABB 表）——
 * 无外力时逐 tick 一致，客户端据此做本地移动预测，服务器快照做和解收敛。
 *
 * 整数纪律（沿用 S1 毫单位习惯）：位置/速度 milli-px（int32），运算只有
 * + - * 与 Math.trunc/round/atan2（同引擎确定），无 Date/random 入判定路径。
 *avatar 记录字段：{x,y,vx,vy,face,mv}（其余字段由调用方自行扩展）。
 * ===================================================================== */
(function (root) {
  'use strict'

  var W = 1400 * 1000        // 世界宽 milli-px
  var H = 2400 * 1000        // 世界高
  var SPEED = 120000         // 满速 120px/s（mpx/s）
  var ACC = 9000             // 加速度 900px/s² × 0.1s/tick = 9000 mpx/s 每 tick
  var RADIUS = 12000         // avatar 碰撞半径 12px
  var MARGIN = 14000         // 世界边界内缩（装饰带表达边界，§2.1）

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

  /** 轴向移动 + 碰撞推挤：先整体位移，再被扩张盒（box+radius）推出——滑墙自然成立 */
  function moveAxis(a, d, boxes, isX) {
    if (!d) return
    if (isX) a.x += d; else a.y += d
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i]
      var bx0 = b.x - RADIUS, bx1 = b.x + b.w + RADIUS
      var by0 = b.y - RADIUS, by1 = b.y + b.h + RADIUS
      if (a.x > bx0 && a.x < bx1 && a.y > by0 && a.y < by1) {
        if (isX) a.x = d > 0 ? bx0 : bx1
        else a.y = d > 0 ? by0 : by1
      }
    }
  }

  /**
   * 单 tick 移动积分（两端同式，§3.1：起停 ~0.13s 一拍即应）。
   * a: avatar（就地修改）；mx/my ∈ [-100,100]；boxes: 建筑 AABB [{x,y,w,h}] mpx。
   */
  function stepAvatar(a, mx, my, boxes) {
    var tvx = clamp(mx | 0, -100, 100) * (SPEED / 100)
    var tvy = clamp(my | 0, -100, 100) * (SPEED / 100)
    a.vx += clamp(tvx - a.vx, -ACC, ACC)
    a.vy += clamp(tvy - a.vy, -ACC, ACC)
    moveAxis(a, Math.trunc(a.vx / 10), boxes, true)   // v mpx/s × 0.1s = v/10 mpx
    moveAxis(a, Math.trunc(a.vy / 10), boxes, false)
    // 世界边界（静态，两端同表）
    a.x = clamp(a.x, MARGIN, W - MARGIN)
    a.y = clamp(a.y, MARGIN, H - MARGIN)
    a.mv = (a.vx !== 0 || a.vy !== 0) ? 1 : 0
    if (a.mv) a.face = (Math.round(Math.atan2(a.vy, a.vx) * 180 / Math.PI) + 360) % 360
    return a
  }

  /** 点到点距离（mpx，整数截断） */
  function dist(ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay
    return Math.trunc(Math.sqrt(dx * dx + dy * dy))
  }

  /**
   * 逐帧步进（客户端呈现层外推，GAMES-54 F2）：与 stepAvatar 同式积分+碰撞，
   * 步长按帧时长 dtMs 比例缩放——起步 ≤1 帧应答，与 10Hz 上报/快照节拍解耦。
   * 仅客户端渲染路径使用（位置/速度经此为浮点）；服务器与和解重放仍走整拍
   * stepAvatar（权威积分与 §5.5 语义不变，每张快照重锚定回整数域）。
   */
  function stepAvatarFrac(a, mx, my, boxes, dtMs) {
    if (!(dtMs > 0)) return a
    var tvx = clamp(mx | 0, -100, 100) * (SPEED / 100)
    var tvy = clamp(my | 0, -100, 100) * (SPEED / 100)
    var acc = ACC * dtMs / 100
    a.vx += clamp(tvx - a.vx, -acc, acc)
    a.vy += clamp(tvy - a.vy, -acc, acc)
    moveAxis(a, Math.trunc(a.vx * dtMs / 1000), boxes, true)
    moveAxis(a, Math.trunc(a.vy * dtMs / 1000), boxes, false)
    a.x = clamp(a.x, MARGIN, W - MARGIN)
    a.y = clamp(a.y, MARGIN, H - MARGIN)
    a.mv = (a.vx !== 0 || a.vy !== 0) ? 1 : 0
    if (a.mv) a.face = (Math.round(Math.atan2(a.vy, a.vx) * 180 / Math.PI) + 360) % 360
    return a
  }

  var api = { W: W, H: H, SPEED: SPEED, ACC: ACC, RADIUS: RADIUS, MARGIN: MARGIN, stepAvatar: stepAvatar, stepAvatarFrac: stepAvatarFrac, dist: dist, clamp: clamp }
  root.MMOPredict = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api // 服务端 require（net-tank sim.cjs 先例）
})(typeof window !== 'undefined' ? window : globalThis)
