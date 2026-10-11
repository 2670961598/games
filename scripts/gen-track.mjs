/* =====================================================================
 * gen-track —— 极速卡丁 赛道表生成器（GAMES-109 · S7，设计 §1.3/§4.1/附决策 8）
 * 段语法（三原语）→ 中心线折线表 + 派生表（弧长/切向/曲率/赛车线/线速画像/墙位），
 * 产出提交为源码常量 games/multiplayer/speed-kart/tracks.cjs——两端零运行时推导分歧
 * （TRIG16「烘焙即提交」纪律的赛道版）。本脚本自身允许浮点（离线工具，产物是常量）。
 *
 * 用法：node scripts/gen-track.mjs   → 校验（闭合/自交）通过才写文件
 * 护栏：全段转角代数和=360°；闭合差 ≤2px（直道长确定性松弛解算+末点吸附）；
 *       中心线两两测交+平行段间距 ≥0.8×W/2 检查——段表改动后须本脚本验签通过才可提交。
 * ===================================================================== */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'games/multiplayer/speed-kart/tracks.cjs')

/* ---------- 段表（设计 §1.3 赛道库；°为转角；H=发卡语义标记，几何同 A） ---------- */
const TRACKS = [
  { id: 't-bay', name: '海湾初航', W: 132, laps: 3, world: 5200, walls: 'none',
    segs: ['S3200', 'A280,90', 'S2400', 'A260,90', 'S1600', 'A220,35', 'A220,-35', 'S1800', 'A280,90', 'S2600', 'A260,90', 'S2000'] },
  { id: 't-canyon', name: '峡谷发卡', W: 108, laps: 2, world: 5600, walls: 'rock',
    segs: ['S6000', 'A240,90', 'S2100', 'H40,150', 'S800', 'A150,-90', 'S2800', 'H35,160', 'S1000', 'A160,-60', 'S2300', 'H45,150', 'S1000', 'A160,-40'] },
  { id: 't-neon', name: '霓虹街道', W: 96, laps: 2, world: 5600, walls: 'all',
    segs: ['S5200', 'A120,60', 'A90,-60', 'S1400', 'A70,45', 'A70,-45', 'A70,45', 'S1800', 'A140,90', 'A100,45', 'A100,-45', 'S3000', 'A220,90', 'S2200', 'A180,90', 'S1200', 'A180,45', 'S2000'] },
]

const SAMPLE = 25 // 中心线采样间距（px，§1.3）

function parseSeg(s) {
  const m = /^([SAH])(-?[\d.]+)(?:,(-?[\d.]+))?$/.exec(s)
  if (!m) throw new Error(`bad seg: ${s}`)
  return m[1] === 'S' ? { kind: 'S', len: +m[2] } : { kind: m[1], R: +m[2], deg: +m[3] }
}

/* 段序推进（与 build 同一弧离散化：n=max(4,round(弧长/25)) 子段折线）→ 终点位形 */
function walk(segs, lens) {
  let x = 0, y = 0, h = 0, si = 0
  for (const s of segs) {
    if (s.kind === 'S') { const L = lens[si++]; x += Math.cos(h) * L; y += Math.sin(h) * L }
    else {
      const n = Math.max(4, Math.round((s.R * Math.abs(s.deg) * Math.PI) / 180 / SAMPLE))
      const sub = (s.deg * Math.PI / 180) / n
      const ch = 2 * s.R * Math.sin(Math.abs(sub) / 2)
      for (let i = 1; i <= n; i++) { const mid = h + sub / 2; x += Math.cos(mid) * ch; y += Math.sin(mid) * ch; h += sub }
    }
  }
  return { x, y }
}
/* 直道方向表（各直道入口航向单位向量） */
function straightDirs(segs) {
  const dirs = []
  let h = 0
  for (const s of segs) {
    if (s.kind === 'S') dirs.push([Math.cos(h), Math.sin(h)])
    else h += (s.deg * Math.PI / 180)
  }
  return dirs
}
/* 闭合解算（§1.3「收尾段确定性配平」广义化）：转角和=360° 只保证终态航向回正；
 * 侧长不闭合（设计表 t-bay 实测残差 1548px）时对全部直道长做确定性松弛——
 * 每轮按弦向残差在各直道方向上的投影均摊（α=2/nS，Σdir⊗dir≈(nS/2)I），
 * 迭代至 ≤0.5px。转角/半径不动（弯道性格保持），直道长度微调（设计本就是 ≈ 口径）。 */
function solveClosure(segs) {
  const dirs = straightDirs(segs)
  const nS = dirs.length
  const lens = segs.filter((s) => s.kind === 'S').map((s) => s.len)
  for (let it = 0; it < 2000; it++) {
    const flat = []
    for (const d of dirs) flat.push(d[0], d[1])
    const end = walk(segs, lens)
    const gx = -end.x, gy = -end.y
    if (Math.hypot(gx, gy) <= 0.5) break
    for (let i = 0; i < nS; i++) lens[i] += (2 / nS) * (gx * dirs[i][0] + gy * dirs[i][1])
    void flat
  }
  return lens
}

/* 主构建：直道 25px/点、弧弦 25px 折线；H 段记录弧长区间（墙位标注用） */
function build(segs, lens) {
  const pts = [{ x: 0, y: 0 }], hacks = []
  let x = 0, y = 0, h = 0, arc = 0, si = 0
  for (const s of segs) {
    if (s.kind === 'S') {
      const L = lens[si++]
      const n = Math.max(1, Math.round(L / SAMPLE))
      for (let i = 1; i <= n; i++) { x += (Math.cos(h) * L) / n; y += (Math.sin(h) * L) / n; pts.push({ x, y }); arc += L / n }
    } else {
      const s0 = arc
      const n = Math.max(4, Math.round((s.R * Math.abs(s.deg) * Math.PI) / 180 / SAMPLE))
      const sub = (s.deg * Math.PI / 180) / n
      const ch = 2 * s.R * Math.sin(Math.abs(sub) / 2)
      for (let i = 1; i <= n; i++) { const mid = h + sub / 2; x += Math.cos(mid) * ch; y += Math.sin(mid) * ch; h += sub; pts.push({ x, y }); arc += ch }
      hacks.push({ s0, s1: arc, R: s.R, deg: s.deg, kind: s.kind })
    }
  }
  return { pts, hacks }
}

/* 均匀重采样（弧长参数化，闭合环）→ {pts, k, tan, n, step, total} */
function derive(pts, hacks) {
  const N = pts.length
  const cum = [0]
  for (let i = 1; i <= N; i++) {
    const a = pts[i - 1], b = pts[i % N]
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const total = cum[N]
  const m = Math.round(total / SAMPLE)
  const RP = []
  let j = 0
  for (let i = 0; i < m; i++) {
    const target = (i * total) / m
    while (j < N - 1 && cum[j + 1] < target) j++
    const a = pts[j], b = pts[j + 1]
    const f = (target - cum[j]) / ((cum[j + 1] - cum[j]) || 1)
    RP.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, s: target })
  }
  const k = RP.map((p, i) => {
    const a = RP[(i - 1 + m) % m], b = RP[(i + 1) % m]
    const ax = p.x - a.x, ay = p.y - a.y, bx = b.x - p.x, by = b.y - p.y
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1
    const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
    const cross = (ax * by - ay * bx) / (la * lb)
    return Math.acos(dot) * (cross >= 0 ? 1 : -1) / SAMPLE // rad/px（屏幕系 cw+）
  })
  const ks = k.map((_, i) => { // 盒窗 7 平滑（§4.1 步骤 1）
    let acc = 0
    for (let d = -3; d <= 3; d++) acc += k[(i + d + m) % m]
    return acc / 7
  })
  const tan = RP.map((p, i) => {
    const b = RP[(i + 1) % m], a = RP[(i - 1 + m) % m]
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  })
  return { pts: RP, k: ks, tan, n: m, step: SAMPLE, total: m * SAMPLE, hacks }
}

/* 赛车线（§4.1 步骤 2）：弯带切内（+m 余量到边界）、弯间摆外 0.7、余弦过渡 ±40 采样 */
function racingLine(d, W, margin) {
  const n = d.n, half = W / 2 - margin
  const zone = d.k.map((k) => (Math.abs(k) > 1 / 300 ? Math.sign(k) : 0))
  const off = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    if (zone[i] !== 0) off[i] = zone[i] * half
    else {
      let sig = 0
      for (let dd = 1; dd < n / 2 && sig === 0; dd++) {
        if (zone[(i + dd) % n] !== 0) sig = -zone[(i + dd) % n]
        else if (zone[(i - dd + n) % n] !== 0) sig = -zone[(i - dd + n) % n]
      }
      off[i] = sig * half * 0.7
    }
  }
  const offS = off.map((_, i) => { // 余弦²过渡
    let acc = 0, wsum = 0
    for (let dd = -40; dd <= 40; dd++) {
      const w = Math.cos(((dd / 40) * Math.PI) / 2) ** 2
      acc += off[(i + dd + n) % n] * w; wsum += w
    }
    return acc / wsum
  })
  /* 屏幕系（y 下）：n=(−ty,tx) 指向 cw 弯圆心侧——off=+zone·half 即切内（两侧通用） */
  return d.pts.map((p, i) => ({ x: p.x - d.tan[i].y * offS[i], y: p.y + d.tan[i].x * offS[i] }))
}

/* 线速画像（§4.1 步骤 3）：v=sqrt(a·R)（赛车线曲率）→ 回溯两遍刹 ahead + 前向加速上限 */
function speedProfile(line, d, vmaxPx, aBrake = 2.25, aAcc = 0.48) { // a 单位 px/tick²
  const n = d.n
  const v = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = line[(i - 1 + n) % n], b = line[i], c = line[(i + 1) % n]
    const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1
    const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
    const cross = (ax * by - ay * bx) / (la * lb)
    const kk = Math.abs(Math.acos(dot) * (cross >= 0 ? 1 : -1) / SAMPLE)
    v[i] = Math.min(vmaxPx, kk > 1e-9 ? Math.sqrt(aBrake / kk) : 1e9)
  }
  for (let pass = 0; pass < 2; pass++)
    for (let i = n - 1; i >= 0; i--) {
      const nx = v[(i + 1) % n]
      const cap = Math.sqrt(nx * nx + 2 * aBrake * SAMPLE)
      if (v[i] > cap) v[i] = cap
    }
  for (let i = 1; i < 2 * n; i++) {
    const idx = i % n, pv = v[(idx - 1 + n) % n]
    const cap = Math.sqrt(pv * pv + 2 * aAcc * SAMPLE)
    if (v[idx] > cap) v[idx] = cap
  }
  return v
}

/* 自交与平行间距校验（段表防手改造出自交环，§1.3） */
function checkNoCross(pts, W) {
  const n = pts.length
  const minGap = W / 2 * 0.8
  const cell = 100, grid = new Map()
  const key = (i, j) => i + ',' + j
  const segs = []
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    const s = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), a, b }
    segs.push(s)
    for (let ci = Math.floor(s.x0 / cell); ci <= Math.floor(s.x1 / cell); ci++)
      for (let cj = Math.floor(s.y0 / cell); cj <= Math.floor(s.y1 / cell); cj++) {
        if (!grid.has(key(ci, cj))) grid.set(key(ci, cj), [])
        grid.get(key(ci, cj)).push(i)
      }
  }
  const cross = (s1, s2) => {
    const d1 = (s2.b.x - s2.a.x) * (s1.a.y - s2.a.y) - (s2.b.y - s2.a.y) * (s1.a.x - s2.a.x)
    const d2 = (s2.b.x - s2.a.x) * (s1.b.y - s2.a.y) - (s2.b.y - s2.a.y) * (s1.b.x - s2.a.x)
    const d3 = (s1.b.x - s1.a.x) * (s2.a.y - s1.a.y) - (s1.b.y - s1.a.y) * (s2.a.x - s1.a.x)
    const d4 = (s1.b.x - s1.a.x) * (s2.b.y - s1.a.y) - (s1.b.y - s1.a.y) * (s2.b.x - s1.a.x)
    return d1 * d2 < 0 && d3 * d4 < 0
  }
  const segDist2 = (s1, s2) => {
    let best = 1e18
    const P = [s1.a, s1.b, { x: (s1.a.x + s1.b.x) / 2, y: (s1.a.y + s1.b.y) / 2 }]
    const Q = [s2.a, s2.b, { x: (s2.a.x + s2.b.x) / 2, y: (s2.a.y + s2.b.y) / 2 }]
    for (const p of P) for (const q of Q) best = Math.min(best, (p.x - q.x) ** 2 + (p.y - q.y) ** 2)
    return best
  }
  for (let i = 0; i < n; i++) {
    const s1 = segs[i]
    const near = new Set()
    for (let ci = Math.floor(s1.x0 / cell); ci <= Math.floor(s1.x1 / cell); ci++)
      for (let cj = Math.floor(s1.y0 / cell); cj <= Math.floor(s1.y1 / cell); cj++) {
        const arr = grid.get(key(ci, cj))
        if (arr) for (const j of arr) if (Math.abs(j - i) > 3 && Math.abs(j - i) < n - 3) near.add(j)
      }
    for (const j of near) {
      if (cross(s1, segs[j])) throw new Error(`自交：段 ${i}×${j}`)
      const d2 = segDist2(s1, segs[j])
      if (d2 < minGap * minGap) throw new Error(`平行间距不足：段 ${i}-${j} 距 ${Math.sqrt(d2).toFixed(1)}px < ${minGap.toFixed(1)}px`)
    }
  }
}

/* ---------- 生成 ---------- */
function gen() {
  const out = []
  for (const t of TRACKS) {
    const segs = t.segs.map(parseSeg)
    let turn = 0
    for (const s of segs) if (s.kind !== 'S') turn += s.deg
    if (Math.abs(turn - 360) > 1e-9) throw new Error(`[${t.id}] 转角代数和 ${turn} ≠ 360°`)
    const lens = solveClosure(segs)
    const { pts, hacks } = build(segs, lens)
    const p0 = pts[0], pn = pts[pts.length - 1]
    const gap = Math.hypot(pn.x - p0.x, pn.y - p0.y)
    if (gap > 2) throw new Error(`[${t.id}] 闭合差 ${gap.toFixed(2)}px > 2px（松弛解算未收敛）`)
    pts[pts.length - 1] = { x: p0.x, y: p0.y } // ≤2px 确定性吸附
    const d = derive(pts, hacks)
    checkNoCross(d.pts, t.W)
    /* 平移到世界中心（world=设计值与 bbox+带宽+200px 安全带取大） */
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
    for (const p of d.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
    const margin = t.W / 2 + 200
    const world = Math.max(t.world, Math.ceil(Math.max(x1 - x0 + 2 * margin, y1 - y0 + 2 * margin) / 100) * 100)
    const ox = world / 2 - (x0 + x1) / 2, oy = world / 2 - (y0 + y1) / 2
    for (const p of d.pts) { p.x += ox; p.y += oy }
    const line = racingLine(d, t.W, 24)
    const prof = speedProfile(line, d, 18) // 上界 18px/tick=360px/s（车型系数运行期缩放）
    /* 墙位标注：all=3（双侧）；rock=发卡段外侧（±带）；none=0。
     * 编码=墙侧法向号：+1=latN>+max 墙、−1=latN<−max 墙、3=双侧；外侧=背离曲率中心。 */
    const wall = new Array(d.n).fill(0)
    if (t.walls === 'all') wall.fill(3)
    else if (t.walls === 'rock') {
      for (const h of d.hacks) {
        if (h.kind !== 'H') continue
        for (let i = 0; i < d.n; i++) {
          const s = d.pts[i].s
          const inSeg = s >= h.s0 - SAMPLE * 8 && s <= h.s1 + SAMPLE * 4
          if (inSeg) wall[i] = d.k[i] > 0 ? -1 : 1
        }
      }
    }
    const MI = 65536
    const ptsF = [], tanF = [], lineF = [], radF = []
    for (let i = 0; i < d.n; i++) {
      ptsF.push(Math.round(d.pts[i].x * 1000), Math.round(d.pts[i].y * 1000))
      lineF.push(Math.round(line[i].x * 1000), Math.round(line[i].y * 1000))
      tanF.push(Math.round(d.tan[i].x * MI), Math.round(d.tan[i].y * MI))
      radF.push(Math.abs(d.k[i]) < 1e-9 ? 0 : Math.round(Math.abs(1 / d.k[i]) * 1000))
    }
    out.push({
      id: t.id, name: t.name, laps: t.laps, W: Math.round(t.W * 1000), world: Math.round(world * 1000),
      walls: t.walls, n: d.n, stepM: Math.round(SAMPLE * 1000), lenM: Math.round(d.total * 1000),
      pts: ptsF, tan: tanF, line: lineF, rad: radF, wall, prof: prof.map((v) => Math.min(18000, Math.round(v * 1000))),
    })
    console.log(`✓ ${t.id} ${t.name}: n=${d.n} 中心线 ${Math.round(d.total)}px L=${t.laps} world=${world} wall=${t.walls} 自交校验过`)
  }
  return out
}

const tracks = gen()
const banner = `/* 自动生成（scripts/gen-track.mjs，GAMES-109）——请勿手改；段表改动后重跑生成器验签通过才可提交。
 * 字段：{id,name,laps,W(milli),world,walls,n,stepM,lenM,pts[x,y…]milli,tan Q16,line 赛车线 milli,rad 半径 milli(0=直道),wall(0 无/±1 单侧/3 双侧),prof 线速 milli/tick}
 * 派生自设计 §1.3 段表（直道长经闭合解算微调——段表转角和=360° 但侧长不闭合，t-bay 残差 1548px）。 */\n`
const body = `(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.KartTracks = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  return ${JSON.stringify(tracks)}
})
`
writeFileSync(OUT, banner + body)
console.log(`写入 ${OUT}（${(body.length / 1024).toFixed(1)}KB）`)
