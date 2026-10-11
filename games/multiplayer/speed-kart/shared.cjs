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
  /* GAMES-112 人格深化/放水链参数（§4.2 表落参数；全在 brain 层、sim 核零改动） */
  var BOT_MARGIN = { casual: 34000, balanced: 24000, competitive: 20000 } // 车侧余量 m milli
  var BOT_BRAKEW = { casual: 120, balanced: 140, competitive: 100 }  // 油门前瞻窗系数 ‰（balanced 提前收油=限速余量）
  var BOT_MISS_P = 12       // casual 失误起窗概率 ‰/决策拍（决策 5/s → 4-8s 一失）
  var BOT_BLOCK_T = 24      // 被堵 1.2s → competitive 抽头超车（§4.2）
  var BOT_PULL_T = 40       // 抽头持线 tick（2s 完成超越）
  var BOT_DEF_GAP = 95000   // 防守卡位：追兵 95px 内横向关门（≈尾流上限）
  var MERCY_DFT = { minFoeLose: 2, hardFoeLose: 4, holdM: 400000 } // 放水链缺省（适配器从 game.json bot.mercy 注入同值；离线确定性不读文件）

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
    pulsePos: 2, // GAMES-112 放水链：多席竞速按完赛名次记真人 pulse（pos≤2=胜，连败=放水信号源）
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

    /* 输入面接线（GAMES-112）：漂移开关键落 kart 态——此前 integrate 只读 k.dr 无写点，
     * §2.5 漂移/蓄力/boost 物理自交付起是死代码（dr 恒 0）；单源两端同式激活 */
    k.dr = inp.dr ? 1 : 0

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
    else { // 松油滑行：阻力逆速度方向且不过零（滑到停，不倒溜）——原式恒 −120 会把
      // 静止车拖成倒溜（绿灯死窗滚过起跑线 → s 回绕 → 控制器/回正在镜像几何里锁死）
      if (k.v > 0) { k.v += car.drag; if (k.v < 0) k.v = 0 }
      else if (k.v < 0) { k.v -= car.drag; if (k.v > 0) k.v = 0 }
    }
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
    /* 起跑线缝投影翻转守卫：缝上静止/微动车（idle 泊格/AFK/碰擦抖动）的 s 在 ±0 两侧
     * 跳变，ds≈±len 伪装成一次反向/正向穿越 → pOff 虚增=名次污染（A3 idle 泊格
     * pos=3/6 实锤）。真过线的车一拍位移 ≥2px；物理位移 <2px 的"回绕"必是投影伪影：
     * 只重锚 s/idx，不动任何账。 */
    if (fw || bw) {
      var pdx = k.x - (k.pX === undefined ? k.x : k.pX), pdy = k.y - (k.pY === undefined ? k.y : k.pY)
      if (pdx * pdx + pdy * pdy < 4000000) { k.s = p.s; k.idx = p.idx; k.pX = k.x; k.pY = k.y; return }
    }
    k.pX = k.x; k.pY = k.y
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
   * Bot 三档（§4 赛车线控制器 + GAMES-112 人格深化/放水链）。
   * 控制器=pure pursuit 前瞻 + 线速画像窗口油门 + 档位漂移；深化层全在 brain：
   *   casual 休闲巡航：中心线+大噪声+随机失误窗（错向压杆/误刹）+被堵减速跟随；
   *   balanced 学徒：赛车线+限速余量（前瞻窗 ×1.4 提前收油）+并线礼让横向避让；
   *   competitive 车手：路线优化（被堵 1.2s 侧向抽头超车/尾流跟车 1.2s 后变线）+
   *     漂移蓄放（漂移中压滑角蓄 tier、近弯末松漂释放 boost）+防守卡位（追兵近关门）。
   * 放水链（env 驱动，bot 对 bot 全力——foeLose/让位只认 human 席）：
   *   连败让力（foeLose≥minFoeLose 圈速×0.90+噪声×1.6 / ≥hardFoeLose ×0.78+噪声×2.5+停漂）
   *   + 生态位让位（真人近后方 holdM 内让线收油——名次压制缓解）。
   * 脚本侧 racer-line 策略共用 policyInput（读快照伪 state——§6 pool pot-solver 先例）。
   * ===================================================================== */
  function botDecide(st, k, per, rng, useLine, env) {
    var tr = st.tr
    var m = k.m
    m.dt = BOT_EVERY[per] || 2
    var car = CARS[k.car]
    var halfW = tr.W >> 1
    if (m.blk === undefined) { m.blk = 0; m.fol = 0; m.pul = 0; m.side = 0; m.mt = 0; m.mb = 0; m.mk = 0; m.rng = rng || null }
    if (!m.rng && rng) m.rng = rng // 席位重接管（bot→human→bot）后重锚稳定 rng（失误窗恢复）

    /* ---- 放水链：连败让力梯度（foeLose=对席真人连败数，rooms pulse 台账） ---- */
    var mercy = (env && env.mercy) || MERCY_DFT
    var fl = env && env.foeLose ? (env.foeLose[k.seat] || 0) : 0
    var lk = BOT_LINE_K[per] || 0.92
    var nz = BOT_NOISE[per] || 0
    if (fl >= mercy.hardFoeLose) { lk *= 0.78; nz *= 2.5 }     // L2 重让：圈速大衰减+失误注入+停漂
    else if (fl >= mercy.minFoeLose) { lk *= 0.90; nz *= 1.6 } // L1 让力：圈速衰减+噪声放大

    /* ---- 前瞻目标（§4.1 pure pursuit；×14 调参）+ 档位横向偏移（路线优化/礼让/卡位） ---- */
    var la = 60000 + k.v * 14
    var ti = (((k.s + la) / tr.stepM) | 0) % tr.n
    var loff = 0 // 横向偏移 milli（侧正=左法向 n=(−ty,tx)；0=贴参考线）
    /* 生态位让位：真人近后方（同圈近距落后）→ 让线（偏出赛车线+收油，下方 vTar 再降） */
    var yieldHold = false
    var kinds = env && env.kinds
    if (kinds && !k.fin) {
      for (var y = 0; y < SEATS; y++) {
        if (y === k.seat || kinds[y] !== 'human' || !st.karts[y]) continue
        var hy = st.karts[y]
        var dpy = (k.s - hy.s) + (k.cross - hy.cross) * tr.lenM
        if (dpy > 0 && dpy <= mercy.holdM && hy.laps <= k.laps + 1) {
          yieldHold = true
          if (per !== 'competitive' || !m.pul) loff = (hy.lat >= k.lat ? -1 : 1) * 20000 // 让出内线
          break
        }
      }
    }
    /* 前车态势：被堵（前方同道近距）/并线（横排）/追兵（后方更快）/跟车目标（前 90-250px） */
    var blkAhead = null, beside = null, chaser = null, prey = null
    for (var o = 0; o < SEATS; o++) {
      if (o === k.seat) continue
      var q = st.karts[o]
      if (!q || q.fin) continue
      var dsq = q.s - k.s
      if (dsq > (tr.lenM >> 1)) dsq -= tr.lenM
      else if (dsq < -(tr.lenM >> 1)) dsq += tr.lenM
      var dlq = q.lat - k.lat
      var adl = dlq < 0 ? -dlq : dlq
      if (dsq > 10000 && dsq < 150000 && adl < 30000) {
        if (!blkAhead || dsq < blkAhead.ds) blkAhead = { ds: dsq, dl: dlq }
      } else if (dsq < 30000 && dsq > -30000 && adl < 40000) beside = { ds: dsq, dl: dlq }
      else if (dsq >= 90000 && dsq <= 260000 && adl < 42000) {
        if (!prey || dsq < prey.ds) prey = { ds: dsq, o: q }
      }
      if (dsq < 0 && -dsq < 160000 && adl < 46000 && q.v > k.v) chaser = { dl: dlq }
    }
    /* competitive 路线优化：被堵/尾流计时 → 侧向 ±(W/2−m) 抽头（§4.2；接受轻碰无避让） */
    if (per === 'competitive' && !yieldHold) {
      if (m.pul > 0) { m.pul--; loff = m.side * (halfW - BOT_MARGIN.competitive) }
      else {
        var ev2 = BOT_EVERY[per] || 2
        if (blkAhead) m.blk += ev2; else m.blk = 0
        if (k.draft) m.fol += ev2; else if (!blkAhead) m.fol = 0
        if (m.blk >= BOT_BLOCK_T || m.fol >= BOT_BLOCK_T) {
          m.side = blkAhead ? (blkAhead.dl >= 0 ? -1 : 1) : (k.lat > 0 ? -1 : 1) // 从对方空侧/外侧抽头
          m.pul = BOT_PULL_T; m.blk = 0; m.fol = 0
          loff = m.side * (halfW - BOT_MARGIN.competitive)
        }
      }
      /* 防守卡位：追兵近距 → 向其侧横向关门（领跑护线，§4.2 防守卡位） */
      if (!m.pul && chaser && (chaser.dl < 0 ? -chaser.dl : chaser.dl) < BOT_DEF_GAP) loff = (chaser.dl >= 0 ? 1 : -1) * 15000
    }
    /* balanced 并线礼让：±0.5 余量横向避让（§4.2） */
    if (per === 'balanced' && beside && !yieldHold) loff = (beside.dl >= 0 ? -1 : 1) * (BOT_MARGIN.balanced >> 1)

    var tx = useLine[ti * 2], ty = useLine[ti * 2 + 1]
    /* competitive 主动跟车（§4.2 尾流）：非抽头期且前方 90-250px 同道有车 → 目标点=其车位
     * （pure pursuit 追点自然收进 30-90px 尾流带；k.draft 后 m.fol 计时满 1.2s 走下方抽头） */
    if (per === 'competitive' && prey && !m.pul && !yieldHold) { tx = prey.o.x; ty = prey.o.y }
    if (loff) {
      /* 绝对钳制：偏移后目标点的赛道横向位 ≤ W/2−余量（防抽头/卡位把车指到墙外） */
      var ln = -tr.tan[ti * 2 + 1], ltn = tr.tan[ti * 2]
      var lineLat = (((useLine[ti * 2] - tr.pts[ti * 2]) * ln) + ((useLine[ti * 2 + 1] - tr.pts[ti * 2 + 1]) * ltn)) / 65536
      var room = halfW - (BOT_MARGIN[per] || 24000)
      if (lineLat + loff > room) loff = room - lineLat
      else if (lineLat + loff < -room) loff = -room - lineLat
      tx += (ln * loff) / 65536
      ty += (ltn * loff) / 65536
    }
    var desired = atan2Q(tx - k.x, ty - k.y)
    if (rng && nz) desired += ((rng() * 2 - 1) * nz * 8) | 0
    /* casual 随机失误窗（稳定 rng 才启用——AFK 托管逐拍新 rng 不触发）：错向压杆+可选误刹 */
    if (per === 'casual' && rng && rng === m.rng) {
      if (m.mt > 0) { m.mt--; if (m.mt === 0) { m.mb = 0; m.mk = 0 } }
      else if (((rng() * 1000) | 0) < BOT_MISS_P) { m.mt = 14 + ((rng() * 17) | 0); m.mb = rng() < 0.5 ? -1 : 1; m.mk = rng() < 0.5 ? 1 : 0 }
    }
    var stCmd = clampI((angDiff(desired, k.a) * 1200) >> 16, -100, 100)
    if (m.mt > 0) stCmd = clampI(stCmd + m.mb * 70, -100, 100)

    /* ---- 油门：前瞻窗（刹 ahead）线速画像低点 ×档位系数（画像已回溯两遍；含让力/让位） ---- */
    var vPx = k.v / 1000
    var winPx = ((vPx * vPx) / 4.5) * ((BOT_BRAKEW[per] || 100) / 100) + 150
    var span = Math.max(4, (winPx / (tr.stepM / 1000)) | 0)
    var vTar = 99999999
    for (var w = 0; w <= span; w++) {
      var pv = tr.prof[(k.idx + w) % tr.n] * lk
      if (pv < vTar) vTar = pv
    }
    var vCar = (car.vmax * lk) | 0
    if (vTar > vCar) vTar = vCar
    if (yieldHold) vTar = (vTar * 0.82) | 0 // 生态位让位：收油让车（真人近后方）
    m.th = k.v < vTar - 2000 ? 1 : k.v > vTar + 4000 ? -1 : 0
    if (per === 'casual' && blkAhead && blkAhead.ds < 100000 && m.th > 0) m.th = 0 // 被堵减速跟随（§4.2）
    if (m.mk && m.mt > 0) m.th = -1 // 失误窗误刹
    m.st = stCmd

    /* ---- 漂移（§4.2：casual 不用 / balanced 短漂稳住 / competitive 蓄放） ----
     * competitive 触发域 R≤250px：表值最紧 62px 发卡弧仅 ~100-200px（2-8 采样），
     * R≤70 域内蓄不满 tier1=20 tick 滑角——扩到入弯段让蓄力跨 入弯-发卡 全程；
     * balanced R≤90 短漂（表值无 ≤50 弯，设计 §4.2 阈值在生成赛道上无命中面） */
    if (per === 'casual' || fl >= mercy.hardFoeLose) { m.dr = 0; return } // 重让停漂（放水不拼）
    var thr = per === 'competitive' ? 250000 : 90000
    var minR = 999999999
    var radSpan = (200000 / tr.stepM) | 0
    for (var w2 = 0; w2 <= radSpan; w2++) {
      var rr2 = tr.rad[(k.idx + w2) % tr.n]
      if (rr2 > 0 && rr2 < minR) minR = rr2
    }
    var inCorner = minR <= thr && k.v > 4000
    if (per === 'competitive' && inCorner) {
      /* 弯区出口距离：脚下起 corner 游程末端（弯前直道不截断、弯内 ≤3 采样缝容忍） */
      var run = -1, gap = 0, seen = false
      for (var w3 = 0; w3 <= radSpan + 6; w3++) {
        var rc = tr.rad[(k.idx + w3) % tr.n]
        if (rc > 0 && rc <= thr) { seen = true; run = w3; gap = 0 }
        else if (seen && ++gap > 3) break
      }
      if (run * tr.stepM < k.v * 5) { m.dr = 0; return } // 距弯末 ≤5 tick 松漂 → 出弯释放 boost
      m.dr = 1
      var slip = angDiff(k.a, k.d); if (slip < 0) slip = -slip
      if (slip < 5400) m.st = clampI(stCmd + (stCmd >= 0 ? 35 : -35), -100, 100) // 压滑角蓄 tier
    } else m.dr = inCorner ? 1 : 0
  }
  function brainImpl(st, seat, level, rng, env) {
    var k = st.karts[seat]
    if (!k || st.phase === 'countdown') return { st: 0, th: 0, dr: 0 }
    var per = level || 'balanced'
    if (!k.m) Object.defineProperty(k, 'm', { value: { dt: 0, st: 0, th: 1, dr: 0 }, writable: true, enumerable: false })
    if (k.m.dt <= 0) botDecide(st, k, per, rng, per === 'casual' ? st.tr.pts : st.tr.line, env)
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

  /* =====================================================================
   * S7 预测器（§5.1 单源核心）——浏览器客户端本地预测与 api 臂虚拟客户端共用。
   * 三 API：anchor(权威己车态@tick) → push(在途输入@预计生效 tick) → advanceTo(目标 tick)。
   * 影子 = 权威锚点 + 在途输入重放（integrate 同式）——逐拍重锚把预测误差压在单拍内；
   * progress 同跑（本地圈点=客户端"本地感知圈时"账本，T7-A 对照条源，§3.4）。
   * 输入生效语义与服务器一致：at ≤ 当前 tick 的最新一条粘性沿用（seatInput 同式）。
   * ===================================================================== */
  function makePredictor(trackId) {
    var tr = TRACKS[trackId] || TRACKS['t-bay']
    var stView = {
      tr: tr, grid: buildGrid(tr), phase: 'race', tick: 0,
      cpCount: Math.max(1, (tr.lenM / CP_SPAN) | 0), stats: { jumpViol: 0 },
    }
    var ring = []          // 在途输入环形缓冲（容量 96，§5.1 容量 64 的 api 臂余量版）
    var lastInp = { st: 0, th: 0, dr: 0 }
    var shadow = null, t = 0
    var events = []        // 本地圈点事件账本（drain 消费）
    function anchor(k, tick) {
      shadow = {
        seat: k.seat, car: k.car | 0, name: k.name,
        x: k.x, y: k.y, a: k.a & 0xffff, d: (k.d === undefined ? k.a : k.d) & 0xffff, v: k.v,
        s: k.s || 0, lat: k.lat || 0, idx: k.idx || 0, cross: k.cross || 0, laps: k.laps || 0,
        cp: k.cp || 1, pOff: k.pOff || 0, lapT0: k.lapT0 || 0, lastLapTick: k.lastLapTick || 0,
        lapTimes: k.lapTimes ? k.lapTimes.slice() : [], best: k.best || 0, fin: k.fin || 0,
        dr: k.dr || 0, ch: k.ch || 0, tier: k.tier || 0, bo: k.bo || 0, boMul: k.boMul || 65536,
        draft: k.draft || 0, drT: k.drT || 0, pen: k.pen || 0, jump: 0,
        surf: 0, off: 0, wallHit: 0, boostN: 0, _bt: 0,
      }
      t = tick
      // 已生效（at ≤ 锚点）的在途输入出环；未生效的留着重放（§5.1 ①）。
      // lastInp 同步为最后出环者 = 服务器粘性 inCur（重放起点指令，宽限同式）
      var keep = []
      for (var i = 0; i < ring.length; i++) {
        if (ring[i].at > tick) keep.push(ring[i])
        else lastInp = ring[i].inp
      }
      ring = keep
    }
    function push(at, inp) {
      ring.push({ at: at, inp: inp })
      if (ring.length > 96) ring.shift()
    }
    function advanceTo(tick) {
      if (!shadow) return null
      if (tick > t + 64) tick = t + 64   // 快进上限：锚丢失防长跑发散（§5.1 重放成本上界）
      while (t < tick) {
        t++
        stView.tick = t
        // 相位翻转与 step() 同拍：tick≥COUNTDOWN 的该拍即转 race 并积分（先翻再积，
        // 与服务端 step 内顺序一致——否则绿灯死窗内影子站桩、真车拖阻倒溜，预测失真）
        if (stView.phase === 'countdown' && t >= COUNTDOWN) stView.phase = 'race'
        while (ring.length && ring[0].at <= t) lastInp = ring.shift().inp
        if (stView.phase !== 'countdown') {  // 倒计时冻结 ①-⑤（§2.8，与服务端同式）
          integrate(stView, shadow, lastInp)
          progress(stView, shadow, events)
        }
      }
      return shadow
    }
    return {
      anchor: anchor, push: push, advanceTo: advanceTo,
      setPhase: function (p) { stView.phase = p },
      kart: function () { return shadow },
      tick: function () { return t },
      drainEvents: function () { return events.splice(0) },
      ringInfo: function () { return ring.map(function (e) { return e.at + ':' + e.inp.st + '/' + e.inp.th }) }, // 调试口
    }
  }

  /* =====================================================================
   * api 臂虚拟客户端策略（§5.6/附决策 12）：api 玩家=虚拟会话，本策略把"同式客户端
   * 预测"搬进脚本侧——每拍锚回服务器真值、快进在途输入、在"预测的现在"上决策
   * （racer-line 控制器同式）。这是 armB 完赛性的根：裸几何预瞄在 v≈0 起步段失效
   * （首输入晚 ~16 tick 落地 → 低速无 GV 钳制的跟踪环 ±100 饱和振荡 → 冲出赛道趴
   * 草地）——预测快进让决策态先跑起来，反馈环有效延迟归零。
   *
   * 飞行窗自校准（突发时钟标定，REPORT 注记）：网关 50ms 定时器 ×timeScale8 每拍补
   * ~8 tick → GET 锚滞 0-8 tick 随机——固定 adv 无法两全（超前=陈旧指令虚构外推、
   * 欠补=旧航向当现在）。策略自持发送序号、读服务器 inCur[seat].q 回执，EMA 观测
   * 真实飞行 tick；adv（决策视界）与 apply（push 落地估）同源随动，恒差 ≈ 轮询 1 拍。
   * 增益随飞行窗退火（1200×5/(5+flight)，下限 280）+ 死区 400 brads——死时间越长
   * 增益越低（经典相位裕度换法，离线台标定）。
   * 草地回正（尾部事件兜底）：瞄前方线点全油门自救（草地 vmax 自钳，§2.3）。
   * ===================================================================== */
  function makeRacerPolicy(o) {
    o = o || {}
    var padPx = o.pad || 0      // 刹 ahead 窗加宽（px）
    var vTarK = o.vTarK || 65536 // 线速画像系数（Q16）
    var flight = Math.max(1, o.apply || 2) // 飞行窗 EMA 初值（决策→服务器消费 tick）
    var P = null, tr = null
    var seq = 0                 // 发送序号镜像（playScript 帧号同源，0 起每发 +1）
    var sentLog = []            // [{q, sentTick}] 飞行观测账本
    var fn = function (view, seat) {
      /* 飞行窗自校准：inCur.q 回执（已消费序号）→ 首见拍中点估落地 tick */
      var ack = view && view.inCur && view.inCur[seat] ? (view.inCur[seat].q | 0) : -1
      if (ack >= 0) {
        while (sentLog.length && sentLog[0].q <= ack) {
          var obs = view.tick - sentLog[0].sentTick
          if (obs >= 0 && obs < 64) flight = (flight * 3 + obs + 1) >> 2  // EMA 75/25 + 落地拍余量
          sentLog.shift()
        }
      }
      if (!view || view.phase === 'countdown') { seq++; return { st: 0, th: 0, dr: 0 } }
      if (!P) { P = makePredictor(view.track.id); tr = TRACKS[view.track.id]; fn.predictor = P }
      var me = null
      if (view.karts) for (var i = 0; i < view.karts.length; i++) if (view.karts[i].seat === seat) me = view.karts[i]
      if (!me) { seq++; return { st: 0, th: 0, dr: 0 } }
      var apply = flight                    // push 落地估
      var adv = flight + 1                  // 决策视界=自身指令落地拍（超前=虚构、欠补=旧态）
      P.setPhase(view.phase)
      P.anchor(me, view.tick)
      var k = P.advanceTo(view.tick + adv) || me
      var absLat = k.lat < 0 ? -k.lat : k.lat
      var out
      if (absLat > (tr.W >> 1) - 12000 && k.v > 1500) { // 草地回正
        // 瞄前方线点（同主控制器前瞻）——瞄"齐平 s 线点"在倒行/深出界时目标在侧后方，
        // 纯追踪微分同向锁死成绕圈（离线台实锤：s 回绕后 3000 tick 绕圈 0 完圈）
        var rIdx = (((k.s + 60000 + k.v * (14 + flight)) / tr.stepM) | 0) % tr.n
        var rDes = atan2Q(tr.line[rIdx * 2] - k.x, tr.line[rIdx * 2 + 1] - k.y)
        out = { st: clampI((angDiff(rDes, k.a || 0) * 400) >> 16, -70, 70), th: 1, dr: 0 }
      } else {
        var v = k.v || 0, s = k.s || 0
        // 前瞻吃进飞行距离（60+v×14 基线 + v×flight）：指令落地前车已走 v×flight px——
        // 前瞻<死区位移时瞄点在落地前被跑过（追点追不上车，lat 振荡 ±600 实锤）
        var ti = (((s + 60000 + v * (14 + flight)) / tr.stepM) | 0) % tr.n
        var diff = angDiff(atan2Q(tr.line[ti * 2] - k.x, tr.line[ti * 2 + 1] - k.y), k.a || 0)
        var g = Math.max(280, ((1200 * 5) / (5 + flight)) | 0)  // 增益退火
        var ad = diff < 0 ? -diff : diff
        out = { st: ad < 400 ? 0 : clampI((diff * g) >> 16, -100, 100), th: 0, dr: 0 } // 死区 400
        var vPx = v / 1000
        var span = Math.max(4, (((vPx * vPx) / 4.5 + 150 + padPx + vPx * flight) / (tr.stepM / 1000)) | 0)
        var idx = (s / tr.stepM) | 0
        var vTar = 99999999
        for (var w = 0; w <= span; w++) { var pv = tr.prof[(idx + w) % tr.n]; if (pv < vTar) vTar = pv }
        vTar = ((vTar * vTarK) >> 16)
        out.th = v < vTar - 2000 ? 1 : v > vTar + 4000 ? -1 : 0
        var minR = 999999999
        var radSpan = (200000 / tr.stepM) | 0
        for (var w2 = 0; w2 <= radSpan; w2++) { var rr = tr.rad[(idx + w2) % tr.n]; if (rr > 0 && rr < minR) minR = rr }
        out.dr = minR <= 70000 && v > 4000 ? 1 : 0
      }
      P.push(view.tick + apply, out)
      sentLog.push({ q: seq, sentTick: view.tick })
      if (sentLog.length > 96) sentLog.shift()
      seq++
      return out
    }
    fn.predictor = P // 调试口（离线台对拍影子 vs 服务器真值）
    fn.flightOf = function () { return flight } // 调试口（自校准飞行窗读数）
    return fn
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
    /* GAMES-112：bot env 同 rooms.js doFrame 形状（kinds+foeLose 全零——测试房连败台账
     * 恒零）——brain 读 env 后回放与在线逐字节一致的必要条件（A6 parity） */
    var rEnv = { kinds: room.seats.map(function (sr) { return sr.kind }), foeLose: room.seats.map(function () { return 0 }) }
    var fakeQ = 1000000
    while (st.tick < (maxTicks || MAX_TICKS)) {
      var inputs = {}
      for (i = 0; i < SEATS; i++) {
        if (room.seats[i].kind === 'bot') inputs[i] = brainImpl(st, i, o.botLevels[i] || 'balanced', rngs[i], rEnv)
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
    makePredictor: makePredictor, makeRacerPolicy: makeRacerPolicy,
    brain: brainImpl, policyInput: policyInput, botDecide: botDecide,
    serialize: serialize, hashState: hashState, hashKart: hashKart, replayInputs: replayInputs,
    fnv1a32: fnv1a32, mulberry32: mulberry32,
    clampI: clampI, isqrt: isqrt, angDiff: angDiff, cosQ16: cosQ16, sinQ16: sinQ16, atan2Q: atan2Q,
  }
})
