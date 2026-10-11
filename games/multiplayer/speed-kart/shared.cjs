/* =====================================================================
 * 极速卡丁 sim-kart 单源核心（GAMES-109 · S7 预测与和解首证）。
 * 设计事实源：docs/designs/speed-kart.md（GAMES-108 评审合并版）。
 *
 * 单源纪律（§5.1）：本文件被服务端 sims/speed-kart.js require、也被客户端
 * <script> 前置内联（window.KartSim）——客户端本地预测与服务端权威跑同一份
 * integrate/step（§2 全整数配方），同输入同输出（ext.hash 校验锚）。
 *
 * 算术纪律（§2.1，pool §2.1 纪律全搬运）：位置 milli-px int32；速度 milli/tick；
 * 航向 a/速度方向 d 各一 uint16 brads（65536/圈，0=+x 顺时针——屏幕系 y 向下；
 * 三角查表时 >>3 折叠 8192 档 TRIG16）；sim 路径零 Math.*（TRIG16/ATAN8 烘焙表、
 * 二分 isqrt）；除法向零取整；结算序固定（§2.7）。
 *
 * 数值口径校准（REPORT 注记）：设计 §2.3 GV 常量 9,390,000 与其自身 §2.4 弯速表
 * （v_limit=isqrt(900×R) px/s）及例算互不一致（差 2.5×）——本实现以 §2.4 表为准
 * 反推 GV=23,467,500（=2250 milli/tick² × 10430 brads/rad）：R250→474px/s 全油门、
 * R40 抓地 190/漂移 216 等表值逐行成立；漂移 GV×1.30=30,507,750。
 * ===================================================================== */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./trig16.cjs'), require('./tracks.cjs'))
  else root.KartSim = factory(root.PoolTrig, root.KartTracks)
})(typeof self !== 'undefined' ? self : this, function (TRIG, TRACKS_ARR) {
  'use strict'
  var TRIG16 = TRIG.TRIG16, ATAN8 = TRIG.ATAN8
  var TRACKS = {}
  for (var ti = 0; ti < TRACKS_ARR.length; ti++) TRACKS[TRACKS_ARR[ti].id] = TRACKS_ARR[ti]

  /* ---------- PRNG（协议 §5 纪律：seed 经 mulberry32；仅 Bot/托管用） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h >>> 0 }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

  /* ---------- 常量（设计 §2 数值表抄录；全整数 milli / 65536-brads） ---------- */
  var TICK_MS = 50
  var SEATS = 6
  var MAX_TICKS = 7000        // 350s 硬顶（§1.1）
  var COUNTDOWN = 60          // 3s 起跑倒计时（§2.8）
  var JUMP_WINDOW = 10        // 末 10 tick 抢跑检测窗（§2.8）
  var PEN_TICKS = 20          // 抢跑罚：绿灯后 20 tick 禁油门（§2.8）
  var FINISH_WINDOW = 200     // 完赛窗 10s（§1.1）
  var AFK_TICKS = 600         // 30s 无输入 → casual 托管（§4.3）
  var R_KART = 13000          // 碰撞圆 r=13px（§2.1）
  var CARS = [                // 车型表（§2.2）
    { id: 0, name: '街跑', vmax: 16500, acc: 480, brake: -900, rev: -2200, drag: -120, w: 1350, dV: 60294, dG: 95027 },
    { id: 1, name: '火箭', vmax: 18000, acc: 420, brake: -900, rev: -2200, drag: -120, w: 1180, dV: 58982, dG: 95027 },
    { id: 2, name: '舞者', vmax: 15200, acc: 520, brake: -900, rev: -2200, drag: -120, w: 1560, dV: 61604, dG: 95027 },
  ]
  var GV = 23467500           // 抓地向心预算（§2.4 表反推，见文件头校准注记）
  var GV_DRIFT = 30507750     // 漂移 GV×1.30（§2.3）
  var ALIGN_GRIP = 1800, ALIGN_DRIFT = 550   // d 对齐率 brads/tick（§2.5）
  var SLIP_T = 4600           // 滑角阈值 25°（§2.5）
  var TIER1 = 20, TIER2 = 45  // 蓄力两档 tick（§2.5）
  var BOOST1 = { t: 30, mul: 75416, kick: 1800 }  // ×1.15 / 30 tick / +1800
  var BOOST2 = { t: 60, mul: 79954, kick: 2600 }  // ×1.22 / 60 tick / +2600
  var BOOST_ACC = 26214       // boost 期 acc×0.4（§2.5）
  var DRIFT_ACC = 39322       // 漂移期 acc×0.6（§2.5）
  var SURF = { road: { v: 65536, a: 65536, g: 65536 }, grass: { v: 36045, a: 32768, g: 36045 } } // §2.3
  var ROAD_EDGE = 12000       // |lat| ≤ W/2−12px 沥青
  var WALL_MARGIN = 16000     // 硬墙钳位 W/2−16px（§2.6）
  var WALL_N = 16384          // 法向反弹 ×0.25（§2.6）
  var WALL_V = 55706          // 刮墙 v×0.85
  var JIMP = 45875            // 车车冲量 (1+e)/2、e=0.35（§2.6）
  var BUMP_F = 63666          // 碰后 v×0.97
  var DRAFT_MIN = 30000, DRAFT_MAX = 90000, DRAFT_COS = 61599, DRAFT_T = 6, DRAFT_MUL = 73400 // §2.6
  var CP_SPAN = 1000000       // 检查点每 1000px（§1.4）
  var CP_TOL = 150000         // 容差带 ±150px
  var JUMP_S = 600000         // 单 tick |Δs|>600px 不记进度（防切道）
  var GRID_ROW = 60000, GRID_COL = 28000 // 发车格（§2.8）
  var BOT_EVERY = { casual: 4, balanced: 2, competitive: 2 }   // §4.2 决策间隔
  var BOT_LINE_K = { casual: 0.78, balanced: 0.92, competitive: 1.0 } // 线速系数
  var BOT_NOISE = { casual: 350, balanced: 120, competitive: 30 }     // 转向噪声 brads

  /* ---------- 整数算术（零 Math；除法向零取整） ---------- */
  function isqrt(n) {
    if (n <= 0) return 0
    var hi = 1
    while (hi * hi <= n) hi <<= 1
    var lo = hi >> 1
    while (lo < hi) { var mid = (lo + hi) >> 1; if (mid * mid <= n) lo = mid + 1; else hi = mid }
    return lo - 1
  }
  function clampI(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
  /* Q16 乘积回折：积可能超 int32（GV×65536≈1.5e12）——>> 会先 int32 截断（实测把 GV 折成 5612），
   * 全部走 (a*b/65536)|0（积 <2^53 精确、除法向零取整=纪律允许的 (a/b)|0 形） */
  function qmul(a, b) { return ((a * b) / 65536) | 0 }
  function angDiff(a, b) { var d = (a - b) & 0xffff; if (d > 32767) d -= 65536; return d }
  function cosQ16(q) { q = (q >> 3) & 8191; var i = q & 2047; switch (q >> 11) { case 0: return TRIG16[2048 - i]; case 1: return -TRIG16[i]; case 2: return -TRIG16[2048 - i]; default: return TRIG16[i] } }
  function sinQ16(q) { q = (q >> 3) & 8191; var i = q & 2047; switch (q >> 11) { case 0: return TRIG16[i]; case 1: return TRIG16[2048 - i]; case 2: return -TRIG16[i]; default: return -TRIG16[2048 - i] } }
  function atan2Q(dx, dy) { // → 65536 brads（屏幕系 y 向下，0=+x 顺时针为正）
    var ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy
    if (ax === 0 && ay === 0) return 0
    var q
    if (ax >= ay) q = ATAN8[clampI(((ay << 11) / ax) | 0, 0, 2048)]
    else q = 2048 - ATAN8[clampI(((ax << 11) / ay) | 0, 0, 2048)]
    if (dx >= 0 && dy >= 0) return q << 3
    if (dx < 0 && dy >= 0) return (4096 - q) << 3
    if (dx < 0 && dy < 0) return (4096 + q) << 3
    return (8192 - q) << 3
  }

  var META = {
    gameId: 'speed-kart', title: '极速卡丁', seats: SEATS, tickMs: TICK_MS, maxTicks: MAX_TICKS,
    mode: 'race-laps', teams: { A: [0], B: [1, 2, 3, 4, 5] },
    takeOver: 'casual', tech: 'S7', seqInput: true, // S7：input.frame=seq（ack 锚点，§5.1）
    roomPrefix: 'speed', // feed 字典序 speed- 排尾（§5.8）
    W: 375, H: 667,
  }

  /* ---------- 赛道投影（§5.2：空间哈希 cell 150px + 最近采样点切向投影） ---------- */
  var PROJ_CELL = 150000
  function buildGrid(tr) {
    var grid = new Map()
    for (var i = 0; i < tr.n; i++) {
      var key = ((tr.pts[i * 2] / PROJ_CELL) | 0) + ',' + ((tr.pts[i * 2 + 1] / PROJ_CELL) | 0)
      var arr = grid.get(key)
      if (arr) arr.push(i)
      else grid.set(key, [i])
    }
    return grid
  }
  function nearestIdx(tr, grid, x, y) {
    var cx = (x / PROJ_CELL) | 0, cy = (y / PROJ_CELL) | 0
    var best = -1, bd = Infinity
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
      var arr = grid.get((cx + dx) + ',' + (cy + dy))
      if (!arr) continue
      for (var j = 0; j < arr.length; j++) {
        var i = arr[j], ddx = tr.pts[i * 2] - x, ddy = tr.pts[i * 2 + 1] - y
        var d2 = ddx * ddx + ddy * ddy
        if (d2 < bd) { bd = d2; best = i }
      }
    }
    if (best < 0) { // 大幅出界兜底：全扫（确定性同序）
      for (var k = 0; k < tr.n; k++) {
        var kx = tr.pts[k * 2] - x, ky = tr.pts[k * 2 + 1] - y
        var kd = kx * kx + ky * ky
        if (kd < bd) { bd = kd; best = k }
      }
    }
    return best
  }
  /** 车心 → {s 弧长 milli（wrap [0,len)）, lat 有符号横向偏移（n=(−ty,tx) 侧正）, idx} */
  function project(tr, grid, x, y) {
    var idx = nearestIdx(tr, grid, x, y)
    var dx = x - tr.pts[idx * 2], dy = y - tr.pts[idx * 2 + 1]
    var tx = tr.tan[idx * 2], ty = tr.tan[idx * 2 + 1] // Q16
    var along = qmul(dx, tx) + qmul(dy, ty)
    var lat = qmul(-ty, dx) + qmul(tx, dy)
    var s = idx * tr.stepM + along
    if (s < 0) s += tr.lenM
    if (s >= tr.lenM) s -= tr.lenM
    return { s: s, lat: lat, idx: idx }
  }

  /* =====================================================================
   * create(seed, opts) —— 发车格（§2.8：2 列 ×3 排交错，seat i → 排 i/2 列 i%2）
   * ===================================================================== */
  function create(seed, opts) {
    opts = opts || {}
    var trackId = TRACKS[opts.track] ? opts.track : 't-bay'
    var tr = TRACKS[trackId]
    var st = {
      v: 1, gameId: 'speed-kart', seed: seed >>> 0, tick: 0,
      testRoom: !!opts.test, maxTicks: opts.maxTicks != null ? opts.maxTicks : MAX_TICKS,
      track: { id: tr.id, name: tr.name, laps: opts.laps || tr.laps, n: tr.n, lenM: tr.lenM, W: tr.W, world: tr.world, walls: tr.walls, stepM: tr.stepM },
      phase: 'countdown', // countdown → race → finished（完赛窗内）
      finishAt: 0, champion: -1,
      karts: [], ranks: [],
      cpCount: Math.max(1, (tr.lenM / CP_SPAN) | 0),
      rubberBand: 0, // §2.6 有意恒 0（弹性单对照位）
      stats: { carried: 0, jumpViol: 0, bumps: 0, walls: 0, drafts: 0 },
      inCur: [], inLog: [], afk: [],
      auto: opts.autopilot === true ? 0 : -1, // 测试房服务器侧自动驾驶席（A6 确定性双跑，REPORT 注记）
    }
    Object.defineProperty(st, 'tr', { value: tr, enumerable: false })
    Object.defineProperty(st, 'grid', { value: buildGrid(tr), enumerable: false })
    var t0x = tr.tan[0], t0y = tr.tan[1] // 起跑线切向 Q16；n=(−ty,tx)
    var a0 = atan2Q(t0x, t0y)
    for (var i = 0; i < SEATS; i++) {
      var backM = GRID_ROW + (i >> 1) * GRID_ROW
      var sideM = (i & 1) ? GRID_COL : -GRID_COL
      var x = tr.pts[0] - ((t0x * backM) >> 16) + (((-t0y) * sideM) >> 16)
      var y = tr.pts[1] - ((t0y * backM) >> 16) + (((t0x) * sideM) >> 16)
      var kart = {
        seat: i, car: i % CARS.length, name: 'P' + (i + 1),
        x: x, y: y, a: a0, d: a0, v: 0,
        s: 0, lat: 0, idx: 0, cross: 0, laps: 0, cp: 1, pOff: 0, lapT0: COUNTDOWN, lastLapTick: 0,
        lapTimes: [], best: 0, fin: 0, pen: 0, jump: 0,
        dr: 0, ch: 0, tier: 0, bo: 0, boMul: 65536, draft: 0, drT: 0, surf: 0, off: 0,
      }
      var p0 = project(tr, st.grid, kart.x, kart.y)
      kart.s = p0.s; kart.lat = p0.lat; kart.idx = p0.idx
      st.karts.push(kart)
      st.inCur.push({ q: -1, st: 0, th: 0, dr: 0 })
      st.afk.push(null)
    }
    rankAll(st)
    return st
  }

  /* =====================================================================
   * 输入面（§5.1）：人类输入=带 q 的稀疏键（th/dr 缺席=粘性沿用）；bot=brain 完整形。
   * q 推进即应用（到达即消费），无新 q 沿用=宽限兜底（carried 计数，§5.6）。
   * ===================================================================== */
  function seatInput(st, seat, inp) {
    var cur = st.inCur[seat]
    if (inp && typeof inp.q === 'number' && Number.isFinite(inp.q)) {
      var q = inp.q | 0
      if (q > cur.q) {
        var nx = {
          q: q,
          st: clampI(inp.st === undefined ? cur.st : (inp.st | 0), -100, 100),
          th: clampI(inp.th === undefined ? cur.th : (inp.th | 0), -1, 1),
          dr: inp.dr === undefined ? cur.dr : (inp.dr ? 1 : 0),
        }
        st.inCur[seat] = nx
        st.inLog.push([st.tick, seat, nx.st, nx.th, nx.dr])
      }
      return st.inCur[seat]
    }
    if (inp && (inp.st !== undefined || inp.th !== undefined || inp.dr !== undefined)) { // bot/托管
      var b = st.inCur[seat]
      var nst = clampI(inp.st | 0, -100, 100), nth = clampI(inp.th | 0, -1, 1), ndr = inp.dr ? 1 : 0
      if (nst !== b.st || nth !== b.th || ndr !== b.dr) st.inLog.push([st.tick, seat, nst, nth, ndr])
      st.inCur[seat] = { q: b.q, st: nst, th: nth, dr: ndr }
    }
    return st.inCur[seat]
  }

  /* =====================================================================
   * 单车积分（§2.7 ①-⑥；客户端预测与服务端权威同式——S7 单源根）
   * stLike 需含 {tr, grid, phase, tick}（预测侧传视图对象即可）
   * ===================================================================== */
  function integrate(stLike, k, inp) {
    var tr = stLike.tr
    var car = CARS[k.car]
    /* ① surface 查表（|lat|≤W/2−12 沥青；硬墙带视作路面附着） */
    var p = project(tr, stLike.grid, k.x, k.y)
    k.idx = p.idx
    var halfW = tr.W >> 1
    var absLat = p.lat < 0 ? -p.lat : p.lat
    var grass = absLat > halfW - ROAD_EDGE
    var surf = grass ? SURF.grass : SURF.road
    var sV = surf.v, sA = surf.a, sG = surf.g

    /* ② 推力（漂移/boost 状态机 + vmax 钳，§2.2/§2.3/§2.5） */
    var vEff = ((car.vmax * sV) >> 16)
    if (k.dr) vEff = (vEff * car.dV) >> 16            // 漂移损耗
    if (k.bo > 0) vEff = (vEff * k.boMul) >> 16       // 小涡轮
    if (k.draft > 0) vEff = (vEff * DRAFT_MUL) >> 16  // 尾流
    var acc = car.acc
    if (k.dr) acc = (acc * DRIFT_ACC) >> 16
    if (k.bo > 0) acc = (acc * BOOST_ACC) >> 16
    var th = k.pen > 0 ? 0 : inp.th                   // 抢跑罚禁油门（§2.8）
    if (th > 0) k.v += (acc * sA) >> 16
    else if (th < 0) k.v += car.brake
    else k.v += car.drag
    if (k.v > vEff) {
      if (k.bo > 0 || k.v - vEff <= 240) k.v = vEff
      else k.v -= 240                                  // boost 过期平滑回落（§2.5）
    }
    if (k.v < car.rev) k.v = car.rev
    var slip = angDiff(k.a, k.d); if (slip < 0) slip = -slip
    if (k.dr && slip > SLIP_T) {                       // 蓄力
      if (k.bo > 0) k.bo = 0                           // 新蓄力清零旧计时（不叠加）
      k.ch++
      k.tier = k.ch >= TIER2 ? 2 : k.ch >= TIER1 ? 1 : 0
    } else if (!k.dr && k.ch > 0) {                    // 释放
      if (k.tier >= 1) {
        var B = k.tier >= 2 ? BOOST2 : BOOST1
        k.bo = B.t; k.boMul = B.mul; k.v += B.kick
        k.boostN = 1; k._bt = k.tier
      }
      k.ch = 0; k.tier = 0
    }
    if (k.bo > 0) k.bo--
    if (k.pen > 0) k.pen--

    /* ③ 航向积分（ω_cmd=st×ωmax/100×漂移增益；W_eff=min(|ω_cmd|, GV_eff÷v)，§2.3） */
    var wCmd = ((inp.st * car.w) / 100) | 0
    if (k.dr) wCmd = (wCmd * car.dG) >> 16
    var gv = qmul(k.dr ? GV_DRIFT : GV, sG)
    var wAbs = wCmd < 0 ? -wCmd : wCmd
    var cap = k.v > 100 ? (gv / k.v) | 0 : wAbs
    if (cap > wAbs) cap = wAbs
    k.a = (k.a + (wCmd < 0 ? -cap : cap)) & 0xffff

    /* ④ 方向对齐（d += clamp(diff(a,d),±ALIGN_eff)，§2.5 两角模型） */
    var align = k.dr ? ALIGN_DRIFT : ALIGN_GRIP
    var dd = angDiff(k.a, k.d)
    if (dd > align) dd = align
    if (dd < -align) dd = -align
    k.d = (k.d + dd) & 0xffff

    /* ⑤ 位移积分 */
    k.x += (k.v * cosQ16(k.d)) >> 16
    k.y += (k.v * sinQ16(k.d)) >> 16

    /* ⑥ 赛道约束（硬墙钳制反弹 §2.6；草坪标记/出界计时） */
    var p2 = project(tr, stLike.grid, k.x, k.y)
    k.idx = p2.idx
    var wc = tr.wall[p2.idx]
    var wallSide = wc === 3 ? (p2.lat > 0 ? 1 : -1) : wc === 1 ? 1 : wc === -1 ? -1 : 0
    if (wallSide !== 0) {
      var lat2 = wallSide === 1 ? p2.lat : -p2.lat
      if (lat2 > halfW - WALL_MARGIN) {
        var txw = tr.tan[p2.idx * 2], tyw = tr.tan[p2.idx * 2 + 1]
        var nox = (-tyw * wallSide), noy = (txw * wallSide) // 外向法向 Q16
        var over = lat2 - (halfW - WALL_MARGIN) + 2000
        k.x -= qmul(nox, over)
        k.y -= qmul(noy, over)
        var cd = cosQ16(k.d), sd = sinQ16(k.d)
        var vx = (k.v * cd) >> 16, vy = (k.v * sinQ16(k.d)) >> 16
        var vn = (vx * nox + vy * noy) >> 16   // 法向分量（milli，外向正）
        if (vn > 0) {                          // 朝墙外 → 法向 ×−0.25 + v×0.85（§2.6）
          var vt = (vx * txw + vy * tyw) >> 16
          var vn2 = -((vn * WALL_N) >> 16)
          var nvx = ((vt * txw) >> 16) + ((vn2 * nox) >> 16)
          var nvy = ((vt * tyw) >> 16) + ((vn2 * noy) >> 16)
          var nv = isqrt(nvx * nvx + nvy * nvy)
          k.v = (nv * WALL_V) >> 16
          k.d = atan2Q(nvx, nvy)
          k.wallHit = 1
        }
      }
    }
    if (((p2.lat < 0 ? -p2.lat : p2.lat)) > halfW) k.off++
    k.lat = p2.lat
  }

  /* ⑦ 车-车碰撞（2 轮 pairwise，对序 seat 升序；各半分离+冲量 e=0.35，§2.6） */
  function collidePair(ka, kb, ev) {
    var dx = kb.x - ka.x, dy = kb.y - ka.y
    var d2 = dx * dx + dy * dy
    var min = R_KART * 2
    if (d2 >= min * min || d2 === 0) return false
    var d = isqrt(d2)
    var ux = ((dx << 16) / d) | 0, uy = ((dy << 16) / d) | 0 // Q16 单位
    var half = (min - d) >> 1
    ka.x -= (ux * half) >> 16; ka.y -= (uy * half) >> 16
    kb.x += (ux * half) >> 16; kb.y += (uy * half) >> 16
    var vax = (ka.v * cosQ16(ka.d)) >> 16, vay = (ka.v * sinQ16(ka.d)) >> 16
    var vbx = (kb.v * cosQ16(kb.d)) >> 16, vby = (kb.v * sinQ16(kb.d)) >> 16
    var rvn = (((vbx - vax) * ux + (vby - vay) * uy)) >> 16
    if (rvn <= 0) return false
    var j = (rvn * JIMP) >> 16
    vax -= (j * ux) >> 16; vay -= (j * uy) >> 16
    vbx += (j * ux) >> 16; vby += (j * uy) >> 16
    ka.v = ((isqrt(vax * vax + vay * vay)) * BUMP_F) >> 16
    kb.v = ((isqrt(vbx * vbx + vby * vby)) * BUMP_F) >> 16
    ka.d = atan2Q(vax, vay); kb.d = atan2Q(vbx, vby)
    if (ev && j > 2500) { ev.push({ k: 'bump', a: ka.seat, b: kb.seat, i: j }); return true }
    return false
  }

  /* ⑨ 进度/圈点（§5.2 弧长投影+检查点单调+跳段守卫；cross=过线计数/laps=完圈计数） */
  function progress(st, k, ev) {
    var tr = st.tr
    var oldS = k.s
    var p = project(tr, st.grid, k.x, k.y)
    var len = tr.lenM
    var ds = p.s - oldS
    var fw = false, bw = false
    if (ds < -(len >> 1)) { ds += len; fw = true }
    else if (ds > (len >> 1)) { ds -= len; bw = true }
    var ads = ds < 0 ? -ds : ds
    if (ads > JUMP_S) { st.stats.jumpViol++; k.s = p.s; k.idx = p.idx; return } // 跳段不记进度（§1.4）
    k.s = p.s; k.idx = p.idx
    /* 检查点单调：进入下一检查点 ±150px 容差带即前进（只前进，§1.4） */
    var nextCpS = (k.cp * CP_SPAN) % len
    var dcp = p.s - nextCpS
    if (dcp > (len >> 1)) dcp -= len
    else if (dcp < -(len >> 1)) dcp += len
    if ((dcp < 0 ? -dcp : dcp) <= CP_TOL) k.cp++
    if (bw) { k.pOff += len; return } // 倒行回绕：进度补偿，不记任何账
    if (!fw) return
    /* 正向过线（§1.4：检查点集齐才有效） */
    if (k.cp >= st.cpCount) {
      var lapMs = (st.tick - k.lapT0) * TICK_MS
      k.laps++
      k.lapTimes.push(lapMs)
      if (!k.best || lapMs < k.best) k.best = lapMs
      k.lapT0 = st.tick
      k.lastLapTick = st.tick
      k.cp = 1
      ev.push({ k: 'lap', seat: k.seat, lap: k.laps, ms: lapMs })
    } else if (k.cross === 0) { // 发车格首过线：开圈计时（不算完圈，§2.8 语义）
      k.cross = 1
      k.lapT0 = st.tick
      k.cp = 1
    } else { // 未集齐检查点的回流过线：重开检查点账（防切道，§5.2）
      k.cp = 1
      k.pOff -= len
    }
    k.cross++
  }
  /* 名次（§1.4）：总进度 P=cross×len+s+pOff 降序 → lastLapTick 升序 → seat 升序 */
  function totalProgress(k, lenM) { return k.cross * lenM + k.s + k.pOff }
  function rankAll(st) {
    var len = st.tr.lenM
    var order = st.karts.slice()
    order.sort(function (a, b) {
      var pa = totalProgress(a, len), pb = totalProgress(b, len)
      if (pb !== pa) return pb - pa
      if (a.lastLapTick !== b.lastLapTick) return a.lastLapTick - b.lastLapTick
      return a.seat - b.seat
    })
    st.ranks = order.map(function (k) { return k.seat })
  }

  /* =====================================================================
   * step —— tick 结算序（§2.7）。返回 {events, over, result}
   * ===================================================================== */
  function step(st, inputs, room) {
    var ev = []
    var kinds = room ? room.seats.map(function (s) { return s.kind }) : null
    var i, j, k

    /* ① 输入采样（autopilot 席服务器节拍锁；AFK 30s → casual 托管，§4.3） */
    var inpArr = []
    for (i = 0; i < SEATS; i++) {
      var raw = inputs ? inputs[i] : null
      if (st.auto === i) {
        raw = brainImpl(st, i, 'competitive', null)
        if (!st._auto) Object.defineProperty(st, '_auto', { value: { st: 1e9, th: 1e9, dr: 1e9 }, writable: true, enumerable: false })
        if (raw.st !== st._auto.st || raw.th !== st._auto.th || raw.dr !== st._auto.dr) {
          st.inLog.push([st.tick, i, raw.st, raw.th, raw.dr])
          st._auto.st = raw.st; st._auto.th = raw.th; st._auto.dr = raw.dr
        }
        st.inCur[i] = { q: st.tick, st: raw.st, th: raw.th, dr: raw.dr }
        inpArr.push(raw)
        st.afk[i] = null
        continue
      }
      var isHuman = !kinds || kinds[i] === 'human'
      if (isHuman && raw && typeof raw.q === 'number') {
        var sig = raw.st + ':' + raw.th + ':' + raw.dr + ':' + raw.q
        if (st.afk[i] && st.afk[i].sig === sig) st.afk[i].t++
        else st.afk[i] = { sig: sig, t: 0 }
        if (st.afk[i].t >= AFK_TICKS) raw = brainImpl(st, i, 'casual', mulberry32((st.seed ^ Math.imul(i + 7, 0x85ebca6b)) >>> 0))
      } else st.afk[i] = null
      inpArr.push(seatInput(st, i, raw))
    }
    /* carried 记账（§5.6）：本 tick 无新 q 消费的人类席拍数（宽限兜底在场证据） */
    if (!st._qp) Object.defineProperty(st, '_qp', { value: [-1, -1, -1, -1, -1, -1], writable: true, enumerable: false })
    for (i = 0; i < SEATS; i++) {
      if (st.auto === i) continue
      if (!kinds || kinds[i] === 'human') {
        if (st.inCur[i].q === st._qp[i]) st.stats.carried++
        st._qp[i] = st.inCur[i].q
      }
    }

    /* 相位推进（§1.1/§2.8）：countdown → race（绿灯+抢跑罚落地） */
    if (st.phase === 'countdown' && st.tick >= COUNTDOWN) {
      st.phase = 'race'
      for (i = 0; i < SEATS; i++) if (st.karts[i].jump) { st.karts[i].pen = PEN_TICKS; st.karts[i].jump = 0; ev.push({ k: 'jump', seat: i }) }
      ev.push({ k: 'green', tick: st.tick })
    }

    /* ①-⑥ 逐车积分（countdown 期冻结 ①-⑤、只记抢跑，§2.8） */
    for (i = 0; i < SEATS; i++) {
      if (st.phase === 'countdown') {
        var cdLeft = COUNTDOWN - st.tick
        if (cdLeft > 0 && cdLeft <= JUMP_WINDOW && inpArr[i].th > 0 && !st.karts[i].jump) st.karts[i].jump = 1
        continue
      }
      integrate(st, st.karts[i], inpArr[i])
    }

    /* ⑦ 车-车碰撞 ×2 轮（seat 升序，§2.6） */
    for (var round = 0; round < 2; round++)
      for (i = 0; i < SEATS; i++)
        for (j = i + 1; j < SEATS; j++)
          if (collidePair(st.karts[i], st.karts[j], ev)) st.stats.bumps++

    /* ⑧ 尾流检测（§2.6：30-90px+夹角<20° 持续≥6 tick → vmax×1.12） */
    for (i = 0; i < SEATS; i++) {
      var me = st.karts[i]
      var drafting = false
      for (j = 0; j < SEATS; j++) {
        if (j === i) continue
        var o = st.karts[j]
        var dx = o.x - me.x, dy = o.y - me.y
        var dd2 = dx * dx + dy * dy
        if (dd2 < DRAFT_MIN * DRAFT_MIN || dd2 > DRAFT_MAX * DRAFT_MAX) continue
        var d = isqrt(dd2)
        var cosv = ((((dx << 16) / d) | 0) * cosQ16(o.d) + (((dy << 16) / d) | 0) * sinQ16(o.d)) >> 16
        if (cosv > DRAFT_COS) { drafting = true; break }
      }
      if (drafting) { me.drT++; if (me.drT === DRAFT_T) { ev.push({ k: 'draft', seat: me.seat }); st.stats.drafts++ } }
      else me.drT = 0
      me.draft = me.drT >= DRAFT_T ? 1 : 0
    }

    /* ⑨ 进度/圈点/完赛/事件 */
    var L = st.track.laps
    for (i = 0; i < SEATS; i++) {
      k = st.karts[i]
      if (st.phase !== 'countdown') progress(st, k, ev)
      if (k.wallHit) { ev.push({ k: 'wall', seat: k.seat }); k.wallHit = 0; st.stats.walls++ }
      if (k.boostN) { ev.push({ k: 'boost', seat: k.seat, tier: k._bt || 1 }); k.boostN = 0 }
      if (!k.fin && k.laps >= L) {
        var finN = 1
        for (j = 0; j < SEATS; j++) if (st.karts[j].fin) finN++
        k.fin = finN
        ev.push({ k: 'finish', seat: k.seat, pos: k.fin })
        if (st.champion < 0) { st.champion = k.seat; st.finishAt = st.tick; st.phase = 'finished' }
      }
    }
    rankAll(st)

    /* ⑩ 终局（§1.4）：完赛窗收口 / maxTicks 超时按 rank 定格 */
    var over = null
    var allFin = true
    for (i = 0; i < SEATS; i++) if (!st.karts[i].fin) { allFin = false; break }
    if (st.champion >= 0 && (allFin || st.tick >= st.finishAt + FINISH_WINDOW)) over = overResult(st, 'finish')
    else if (st.tick >= st.maxTicks) over = overResult(st, 'timeout')
    if (over) over.winner = st.champion === 0 ? 'A' : st.champion > 0 ? 'B' : (st.ranks[0] === 0 ? 'A' : 'B')

    st.tick++
    return { events: ev, dirty: true, over: !!over, result: over }
  }
  function overResult(st, reason) {
    var scores = {}
    for (var i = 0; i < st.karts.length; i++) {
      var k = st.karts[i]
      scores[k.seat] = { pos: st.ranks.indexOf(k.seat) + 1, best: k.best || 0, laps: k.laps }
    }
    return { winner: 'A', reason: reason, scores: scores, teams: META.teams }
  }

  /* =====================================================================
   * Bot 三档（§4 赛车线控制器：pure pursuit 前瞻 + 线速画像窗口油门 + 档位漂移）。
   * 脚本侧 racer-line 策略共用 policyInput（读快照伪 state——§6 pool pot-solver 先例）。
   * ===================================================================== */
  function botDecide(st, k, per, rng, useLine) {
    var tr = st.tr
    var m = k.m
    m.dt = BOT_EVERY[per] || 2
    var la = 60000 + k.v * 14 // d_la 前瞻（§4.1 式样 ×14 调参：×6 时纯跟踪欠转向实测出弯道，REPORT 注记）
    var ti = (((k.s + la) / tr.stepM) | 0) % tr.n
    var desired = atan2Q(useLine[ti * 2] - k.x, useLine[ti * 2 + 1] - k.y)
    if (rng) desired += ((rng() * 2 - 1) * (BOT_NOISE[per] || 0) * 8) | 0
    var diff = angDiff(desired, k.a)
    m.st = clampI((diff * 1200) >> 16, -100, 100)
    /* 油门：前瞻窗（刹 ahead 距离+150px）内线速画像低点 ×档位系数（画像已回溯两遍） */
    var car = CARS[k.car]
    var vPx = k.v / 1000
    var winPx = (vPx * vPx) / 4.5 + 150
    var span = Math.max(4, (winPx / (tr.stepM / 1000)) | 0)
    var vTar = 99999999
    for (var w = 0; w <= span; w++) {
      var pv = (tr.prof[(k.idx + w) % tr.n] * BOT_LINE_K[per]) | 0
      if (pv < vTar) vTar = pv
    }
    var vCar = (car.vmax * BOT_LINE_K[per]) | 0
    if (vTar > vCar) vTar = vCar
    m.th = k.v < vTar - 2000 ? 1 : k.v > vTar + 4000 ? -1 : 0
    /* 漂移（§4.2：casual 不用 / balanced R≤50 短漂 / competitive R≤70 蓄放） */
    if (per === 'casual') { m.dr = 0; return }
    var thr = per === 'competitive' ? 70000 : 50000
    var minR = 999999999
    var radSpan = (200000 / tr.stepM) | 0
    for (var w2 = 0; w2 <= radSpan; w2++) {
      var rr2 = tr.rad[(k.idx + w2) % tr.n]
      if (rr2 > 0 && rr2 < minR) minR = rr2
    }
    m.dr = minR <= thr && k.v > 4000 ? 1 : 0
  }
  function brainImpl(st, seat, level, rng) {
    var k = st.karts[seat]
    if (!k || st.phase === 'countdown') return { st: 0, th: 0, dr: 0 }
    var per = level || 'balanced'
    if (!k.m) Object.defineProperty(k, 'm', { value: { dt: 0, st: 0, th: 1, dr: 0 }, writable: true, enumerable: false })
    if (k.m.dt <= 0) botDecide(st, k, per, rng, per === 'casual' ? st.tr.pts : st.tr.line)
    k.m.dt--
    return { st: k.m.st, th: k.m.th, dr: k.m.dr }
  }
  /** 脚本侧 racer-line 策略（api-check POLICIES['racer-line']）：读快照伪 state */
  function policyInput(view, seat) {
    var tr = TRACKS[(view && view.track && view.track.id) || 't-bay']
    var me = null
    if (view && view.karts) for (var i = 0; i < view.karts.length; i++) if (view.karts[i].seat === seat) me = view.karts[i]
    if (!me) return { st: 0, th: 0, dr: 0 }
    var v = me.v || 0, s = me.s || 0
    var la = 60000 + v * 14
    var ti = (((s + la) / tr.stepM) | 0) % tr.n
    var desired = atan2Q(tr.line[ti * 2] - me.x, tr.line[ti * 2 + 1] - me.y)
    var diff = angDiff(desired, me.a || 0)
    var stOut = clampI((diff * 1200) >> 16, -100, 100)
    var vPx = v / 1000
    var span = Math.max(4, (((vPx * vPx) / 4.5 + 150) / (tr.stepM / 1000)) | 0)
    var idx = (s / tr.stepM) | 0
    var vTar = 99999999
    for (var w = 0; w <= span; w++) { var pv = tr.prof[(idx + w) % tr.n]; if (pv < vTar) vTar = pv }
    var thOut = v < vTar - 2000 ? 1 : v > vTar + 4000 ? -1 : 0
    var minR = 999999999
    var radSpan = (200000 / tr.stepM) | 0
    for (var w2 = 0; w2 <= radSpan; w2++) { var rr2 = tr.rad[(idx + w2) % tr.n]; if (rr2 > 0 && rr2 < minR) minR = rr2 }
    var drOut = minR <= 70000 && v > 4000 ? 1 : 0
    return { st: stOut, th: thOut, dr: drOut }
  }

  /* ---------- 确定性（A6：serialize/hash + 回放器） ---------- */
  function serialize(st) {
    var out = [st.tick, st.phase, st.champion, st.finishAt]
    for (var i = 0; i < st.karts.length; i++) {
      var k = st.karts[i]
      out.push([k.x, k.y, k.a, k.d, k.v, k.s, k.cross, k.laps, k.cp, k.pOff, k.dr, k.ch, k.bo, k.pen, k.fin, k.lapT0, k.best])
    }
    out.push(st.stats.jumpViol, st.inLog.length)
    return JSON.stringify(out)
  }
  function hashState(st) { return fnv1a32(serialize(st)) }
  function hashKart(k, tick) { return fnv1a32(tick + ':' + k.x + ',' + k.y + ',' + k.a + ',' + k.d + ',' + k.v + ',' + k.s + ',' + k.laps + ',' + k.cp) }
  /** 回放器（A6：在线终态 == 回放重放）——inLog=[tick,seat,st,th,dr] 逐条复演 */
  function replayInputs(seed, opts, inLog, maxTicks) {
    var o = Object.assign({}, opts, { autopilot: false })
    var st = create(seed, o)
    var byTick = {}
    for (var e = 0; e < inLog.length; e++) {
      var t = inLog[e][0]
      ;(byTick[t] || (byTick[t] = [])).push(inLog[e])
    }
    var room = { seats: [] }
    for (var i = 0; i < SEATS; i++) room.seats.push({ seat: i, kind: o.botLevels && o.botLevels[i] ? 'bot' : 'human' })
    var rngs = []
    for (i = 0; i < SEATS; i++) rngs[i] = mulberry32((seed ^ Math.imul(i, 0x9e3779b9)) >>> 0)
    var fakeQ = 1000000
    while (st.tick < (maxTicks || MAX_TICKS)) {
      var inputs = {}
      for (i = 0; i < SEATS; i++) {
        if (room.seats[i].kind === 'bot') inputs[i] = brainImpl(st, i, o.botLevels[i] || 'balanced', rngs[i])
      }
      var list = byTick[st.tick]
      if (list) for (var q2 = 0; q2 < list.length; q2++) inputs[list[q2][1]] = { q: ++fakeQ, st: list[q2][2], th: list[q2][3], dr: list[q2][4] }
      var r = step(st, inputs, room)
      if (r.over) break
    }
    return st
  }

  var ENGINE = 'kart-int-v1'
  var ENGINE_HASH = fnv1a32(ENGINE + ':' + TRACKS_ARR.map(function (t) { return t.id + ':' + t.n + ':' + t.lenM + ':' + t.pts.length + ':' + t.prof.length + ':' + t.rad.length }).join('|') + ':' + [GV, GV_DRIFT, ALIGN_GRIP, ALIGN_DRIFT, SLIP_T, TIER1, TIER2, BOOST1.mul, BOOST2.mul, R_KART, JUMP_S].join(','))

  return {
    META: META, LEVELS: ['casual', 'balanced', 'competitive'],
    ENGINE: ENGINE, ENGINE_HASH: ENGINE_HASH,
    CARS: CARS, TRACKS: TRACKS, TICK_MS: TICK_MS, SEATS: SEATS, COUNTDOWN: COUNTDOWN, FINISH_WINDOW: FINISH_WINDOW,
    CP_SPAN: CP_SPAN, CP_TOL: CP_TOL, JUMP_S: JUMP_S, R_KART: R_KART, DRAFT_T: DRAFT_T,
    create: create, step: step, integrate: integrate, collidePair: collidePair, progress: progress,
    project: project, buildGrid: buildGrid, rankAll: rankAll, totalProgress: totalProgress,
    brain: brainImpl, policyInput: policyInput, botDecide: botDecide,
    serialize: serialize, hashState: hashState, hashKart: hashKart, replayInputs: replayInputs,
    fnv1a32: fnv1a32, mulberry32: mulberry32,
    clampI: clampI, isqrt: isqrt, angDiff: angDiff, cosQ16: cosQ16, sinQ16: sinQ16, atan2Q: atan2Q,
  }
})
