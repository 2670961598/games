/* =====================================================================
 * 弈界棋阁 确定性多规则回合引擎（GAMES-155 · S5 回合权威第三证）
 * 单一事实源：服务端适配器（server/gateway/sims/yi-pavilion.js）require 本文件；
 * 客户端本地复算（非法格压暗/威胁角标/送位盘描边，§3.2）以 classic script 载入
 * 同一份代码——双环境出口见底部 UMD（Node=module.exports / 浏览器=root.YiPavSim）。
 *
 * 多规则集统一表达（设计 §5.3，票面核心）：RULES 注册表五函数
 *   init()→state₀ / legal(state,seat)→[cell] / apply(state,seat,cell)→{state',events}
 *   end(state)→{winner,reason}|null / feat(state,seat)→F（§4.1 特征提取器）
 * 三规则同一 Int8 格数组 + 同一 cell=r·W+c；回合引擎/托管/回放/双跑/feed 全部
 * per-rule 零改动——多规则=数据不是代码分叉；第六棋种=新表项。
 *
 * S5 纪律（设计 §5，element/tactics 范式照搬）：op→ruling 单通道、服务器权威
 * 校验、零快照纯事件驱动、零隐藏信息（个性化恒等——canonical 即广播视图，
 * 观战=对局视图）、托管三层（超时单步代走/持续托管/afk 三分离）、输入日志回放
 * == 在线 hash（§5.6 双跑口径）。确定性：判定路径零 Math.random/Date.now（随机
 * 只在 casual 决策与托管代走——决策流 rng 定桩 §5.5）；serialize 键字母序。
 * 计时面（tick/clock/deadline/turnStartTick）不入 hash——双跑/回放口径（pool
 * restHash 同族先例：墙钟抖动不扰确定性断言）。
 * ===================================================================== */
'use strict'
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api // Node（.cjs：网关/api-check require）
  root.YiPavSim = api                                                       // 浏览器 classic script（本地复算/离线对打）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

const META = {
  gameId: 'yi-pavilion', title: '弈界棋阁', mode: '1v1-board', seats: 2,
  tickMs: 10, persistent: false, takeOver: 'balanced', roomPrefix: 'yi',
}
const LEVELS = ['casual', 'balanced', 'competitive', 'hosted']
/* 计时制全表（§2.5）：每方总钟 240s（己方行棋走表，归零判负）+ 步限 30s（到点
 * casual 单步代走，不判负）+ maxTicks 60000 硬顶（§1.6 通道 5）。 */
const CLOCK_MS = 240000
const STEP_TICKS = 3000    // 30s / tickMs=10
/* Bot 拟人延时（tick=10ms，§4.5；门控=回合内相对 tick——轮询抖动免疫） */
const BOT_DELAY = { casual: [80, 180], balanced: [120, 220], competitive: [150, 250], hosted: [100, 200] }

/* ---------- 确定性 RNG（fnv1a32 + mulberry32，目录通用纪律） ---------- */
function fnv1a32(str) {
  let h = 0x811c9dc5
  const s = typeof str === 'string' ? str : JSON.stringify(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
    h ^= h >>> 13; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 16 // 雪崩
  }
  return h >>> 0
}
function mulberry32(a) {
  let t = a >>> 0
  return function () {
    t = (t + 0x6D2B79F5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1) >>> 0
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61) >>> 0
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
const foe = (s) => (s === 0 ? 1 : 0)

/* ---------- 井字子盘完美解表 SUB[19683]（§2.4——票面「井字=完美解」子盘层闭式兑现） ----------
 * 3×3 井字 minimax 全解：值 v∈{-1,0,1}（行棋方视角）+ 最佳着点 m（tie-break 格序
 * argmax，零随机）；digits little-endian 三进制（c[i]=格 i 值：0 空 1 先手 2 后手；
 * 行棋方由子数差闭式判定）。生成于模块加载（~18 万步 <50ms），表冻结入 engine
 * hash（§5.3）——competitive 井字着点恒查表（§4.4）。 */
const SUB_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
function subWinLine(c, p) { for (const l of SUB_LINES) if (c[l[0]] === p && c[l[1]] === p && c[l[2]] === p) return l; return null }
function subCellsOf(idx) { const c = new Array(9); let b = idx; for (let i = 0; i < 9; i++) { c[i] = b % 3; b = (b / 3) | 0 } return c }
function subIndexOf(c) { let b = 0; for (let i = 8; i >= 0; i--) b = b * 3 + c[i]; return b }
const SUB = new Array(19683) // idx → {v, m}（m=-1 终局）
function subSolve(idx) {
  if (SUB[idx]) return SUB[idx]
  const c = subCellsOf(idx)
  let n1 = 0, n2 = 0
  for (let i = 0; i < 9; i++) { if (c[i] === 1) n1++; else if (c[i] === 2) n2++ }
  const me = n1 === n2 ? 1 : 2 // 先手=1；子数差闭式定行棋方（非法子数差态不可达，防御性求解）
  if (subWinLine(c, 3 - me)) { SUB[idx] = { v: -1, m: -1 }; return SUB[idx] } // 上一手方已成线
  let empt = 0
  for (let i = 0; i < 9; i++) if (!c[i]) empt++
  if (empt === 0) { SUB[idx] = { v: 0, m: -1 }; return SUB[idx] }
  let bv = -2, bm = -1
  for (let i = 0; i < 9; i++) {
    if (c[i]) continue
    c[i] = me
    const v = subWinLine(c, me) ? 1 : -subSolve(subIndexOf(c)).v
    c[i] = 0
    if (v > bv) { bv = v; bm = i } // 严格大于 → 平值取低格（格序 argmax tie-break）
  }
  SUB[idx] = { v: bv, m: bm }
  return SUB[idx]
}
for (let i = 0; i < 19683; i++) subSolve(i)

/* ---------- 五子连型评分表（§2.2 滑窗口径：窗内只含己子与空时按己子数计型） ---------- */
const GOMOKU_PAT = [0, 10, 450, 8000, 10000, 10000000] // 活一/活二/活三/冲四/（活四并档）/连五
/* ---------- 黑白位置权重表 WGT[64]（§2.3 经典教科书值整数化） ---------- */
const WGT = [
  120, -20, 20, 5, 5, 20, -20, 120,
  -20, -40, -5, -5, -5, -5, -40, -20,
  20, -5, 15, 3, 3, 15, -5, 20,
  5, -5, 3, 3, 3, 3, -5, 5,
  5, -5, 3, 3, 3, 3, -5, 5,
  20, -5, 15, 3, 3, 15, -5, 20,
  -20, -40, -5, -5, -5, -5, -40, -20,
  120, -20, 20, 5, 5, 20, -20, 120,
]
const CORNERS = [0, 7, 56, 63]
/* 角已归属 → X/C 邻位取 |w|（§2.3 稳定化修正，competitive 面并入 feat 常态） */
function wgtAt(board, cell) {
  const r = (cell / 8) | 0, c = cell % 8
  let w = WGT[cell]
  if (w < 0) { // X/C 负位：四角归属即取绝对值
    for (let k = 0; k < 4; k++) {
      const cr = (CORNERS[k] / 8) | 0, cc = CORNERS[k] % 8
      if (Math.abs(r - cr) <= 1 && Math.abs(c - cc) <= 1 && board[CORNERS[k]] !== 0) { w = -w; break }
    }
  }
  return w
}
/* 稳定子 stab（§2.3 闭式口径）：每条边从已归属角起连续同色链长之和（角未归属该端计 0） */
function stabOf(board, seat) {
  const v = seat + 1
  let sum = 0
  const half = (cells) => { // cells[0]=角端，沿边向内
    if (board[cells[0]] === 0) return
    for (const c of cells) {
      if (board[c] !== board[cells[0]]) break // 连续同色链终止
      if (board[c] === v) sum++
    }
  }
  const top = [], bot = [], left = [], right = []
  for (let c = 0; c < 8; c++) { top.push(c); bot.push(56 + c); left.push(c * 8); right.push(c * 8 + 7) }
  half(top); half([...top].reverse()); half(bot); half([...bot].reverse())
  half(left); half([...left].reverse()); half(right); half([...right].reverse())
  return sum
}

/* ---------- 通用棋盘工具（统一 cell 编码 §2.1） ---------- */
const D4 = [[0, 1], [1, 0], [1, 1], [1, -1]] // 行/列/两斜
const D8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
function chainLen(board, W, H, cell, val) { // 过 cell 的最长同色连长（含）
  const r = (cell / W) | 0, c = cell % W
  let best = 1
  for (const [dr, dc] of D4) {
    let n = 1
    for (let i = 1; ; i++) { const rr = r + dr * i, cc = c + dc * i; if (rr < 0 || rr >= H || cc < 0 || cc >= W || board[rr * W + cc] !== val) break; n++ }
    for (let i = 1; ; i++) { const rr = r - dr * i, cc = c - dc * i; if (rr < 0 || rr >= H || cc < 0 || cc >= W || board[rr * W + cc] !== val) break; n++ }
    if (n > best) best = n
  }
  return best
}
function winLineCells(board, W, H, cell, val) { // ≥5 连的连线格（无则 null）
  const r = (cell / W) | 0, c = cell % W
  for (const [dr, dc] of D4) {
    const cells = [cell]
    for (let i = 1; ; i++) { const rr = r + dr * i, cc = c + dc * i; if (rr < 0 || rr >= H || cc < 0 || cc >= W || board[rr * W + cc] !== val) break; cells.push(rr * W + cc) }
    for (let i = 1; ; i++) { const rr = r - dr * i, cc = c - dc * i; if (rr < 0 || rr >= H || cc < 0 || cc >= W || board[rr * W + cc] !== val) break; cells.push(rr * W + cc) }
    if (cells.length >= 5) return cells.sort((a, b) => a - b)
  }
  return null
}
/* 滑窗连型分（§2.2：窗内只含己子与空 → PAT[己子数]；双向各计） */
function gomokuWindowScore(board, seat) {
  const W = 15, H = 15, v = seat + 1, o = seat === 0 ? 2 : 1
  const out = [0, 0]
  const scan = (cells) => { // cells=一条线上 5 连续格窗序列
    for (let i = 0; i + 5 <= cells.length; i++) {
      let a = 0, b = 0
      for (let j = 0; j < 5; j++) { const x = board[cells[i + j]]; if (x === v) a++; else if (x === o) b++ }
      if (b === 0 && a > 0) out[0] += GOMOKU_PAT[a]
      else if (a === 0 && b > 0) out[1] += GOMOKU_PAT[b]
    }
  }
  const line = []
  for (let r = 0; r < H; r++) { line.length = 0; for (let c = 0; c < W; c++) line.push(r * W + c); scan(line) }
  for (let c = 0; c < W; c++) { line.length = 0; for (let r = 0; r < H; r++) line.push(r * W + c); scan(line) }
  for (let s = -14; s <= 14; s++) { line.length = 0; for (let r = 0; r < H; r++) { const c = r + s; if (c >= 0 && c < W) line.push(r * W + c) } scan(line) }        // ↘
  for (let s = 0; s <= 28; s++) { line.length = 0; for (let r = 0; r < H; r++) { const c = s - r; if (c >= 0 && c < W) line.push(r * W + c) } scan(line) }        // ↗
  return out // [own, foe]
}
/* 假想落子后的成型点集（winNow=一步致胜；threat=活三/冲四成点 §4.1） */
function gomokuMakeCells(board, seat) {
  const W = 15, H = 15
  const v = seat + 1
  const win = [], thr = []
  for (let cell = 0; cell < 225; cell++) {
    if (board[cell] !== 0) continue
    board[cell] = v
    const n = chainLen(board, W, H, cell, v)
    board[cell] = 0
    if (n >= 5) win.push(cell)
    else if (n === 4) thr.push({ cell, lv: 10000 })
    else if (n === 3) {
      // 两端空=活三（该向成 3 且两端紧邻均空）
      const r = (cell / W) | 0, c = cell % W
      for (const [dr, dc] of D4) {
        let n1 = 1, n2 = 1
        for (let i = 1; ; i++) { const rr = r + dr * i, cc = c + dc * i; if (rr < 0 || rr >= H || cc < 0 || cc >= W || board[rr * W + cc] !== v) break; n1++ }
        for (let i = 1; ; i++) { const rr = r - dr * i, cc = c - dc * i; if (rr < 0 || rr >= H || cc < 0 || cc >= W || board[rr * W + cc] !== v) break; n2++ }
        if (n1 + n2 - 1 === 3) {
          const e1r = r + dr * n1, e1c = c + dc * n1, e2r = r - dr * n2, e2c = c - dc * n2
          const ok1 = e1r >= 0 && e1r < H && e1c >= 0 && e1c < W && board[e1r * W + e1c] === 0
          const ok2 = e2r >= 0 && e2r < H && e2c >= 0 && e2c < W && board[e2r * W + e2c] === 0
          if (ok1 && ok2) thr.push({ cell, lv: 8000 })
          break
        }
      }
    }
  }
  return { win, thr }
}

/* ---------- 黑白工具 ---------- */
function reversiFlips(board, seat, cell) {
  if (board[cell] !== 0) return []
  const v = seat + 1, o = seat === 0 ? 2 : 1
  const r = (cell / 8) | 0, c = cell % 8
  const out = []
  for (const [dr, dc] of D8) {
    const run = []
    let rr = r + dr, cc = c + dc
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr * 8 + cc] === o) { run.push(rr * 8 + cc); rr += dr; cc += dc }
    if (run.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr * 8 + cc] === v) out.push(...run)
  }
  return out
}

/* ---------- 井字工具 ---------- */
const subIdxOfCell = (cell) => (((cell / 9) | 0) / 3 | 0) * 3 + (((cell % 9) / 3) | 0) // cell → 所属子盘号
const SUB_OF = []
for (let cell = 0; cell < 81; cell++) SUB_OF.push(subIdxOfCell(cell))
function subCells3(sub) { // 子盘号 → 9 格号（格序）
  const bi = ((sub / 3) | 0), bj = sub % 3
  const out = []
  for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++) out.push((bi * 3 + br) * 9 + (bj * 3 + bc))
  return out
}
function subStateOf(board, sub) { // 子盘 → {cells9(0/1/2), idx}
  const cs = subCells3(sub)
  const c9 = new Array(9).fill(0)
  for (let i = 0; i < 9; i++) c9[i] = board[cs[i]]
  return { c9, idx: subIndexOf(c9) }
}
function subClaimAt(board, sub, seat) { // 一步定盘着点（落子即使本盘三连归属）
  const { c9 } = subStateOf(board, sub)
  if (c9.includes(0) === false) return []
  const v = seat + 1
  const out = []
  const save = c9.slice()
  for (let i = 0; i < 9; i++) {
    if (c9[i]) continue
    c9[i] = v
    if (subWinLine(c9, v)) out.push(subCells3(sub)[i])
    c9[i] = 0
  }
  void save
  return out
}
/* 送位窗（§1.5 规则 1）：上手落位 (br,bc) → 本手子盘 (br,bc)；死盘自由 */
function cascadeWindow(st) {
  if (st.last < 0) return null // 首手全盘自由
  const br = ((st.last / 9) | 0) % 3, bc = (st.last % 9) % 3
  const target = br * 3 + bc
  if (st.sub[target] !== -1) return null // 死盘 → 自由
  return target
}
function metaLineOf(sub, owner) { // 母盘三连线（sub 归属数组）
  for (const l of SUB_LINES) if (sub[l[0]] === owner && sub[l[1]] === owner && sub[l[2]] === owner) return l
  return null
}
/* 井字 feat 母盘启发权重差（§2.4：归属 40/中心 +20/一步定盘 +30/三连威胁 +500/送位危险 −45） */
function cascadeEval(st, seat) {
  const f = foe(seat)
  let own = 0, foeS = 0
  const claimMine = [[], []] // [seat 的] 一步可定盘 (sub, cell) 列表
  for (let b = 0; b < 9; b++) {
    if (st.sub[b] === seat + 1) own += 40 + (b === 4 ? 20 : 0)
    else if (st.sub[b] === f + 1) foeS += 40 + (b === 4 ? 20 : 0)
  }
  for (let seatX = 0; seatX < 2; seatX++) for (let b = 0; b < 9; b++) if (st.sub[b] === -1) for (const cell of subClaimAt(st.board, b, seatX)) claimMine[seatX].push({ sub: b, cell })
  own += 30 * claimMine[seat].length
  foeS += 30 * claimMine[f].length
  for (const l of SUB_LINES) {
    let om = 0, fm = 0, alive = -1, aliveM = -1
    for (const b of l) { if (st.sub[b] === seat + 1) om++; else if (st.sub[b] === f + 1) fm++; else { if (alive === -1) alive = b; if (aliveM === -1) aliveM = b } }
    if (om === 2 && alive >= 0) own += 500
    if (fm === 2 && aliveM >= 0) foeS += 500
  }
  /* 送位危险：结果态中行棋方（被送者）在所送盘可一步定盘 → 送方（1−turn）罚 45。
   * ΔV 评估（模拟己手后取 feat）下即「本手送位危险」项。 */
  if (st.last >= 0) {
    const tgt = cascadeWindow(st)
    if (tgt !== null && subClaimAt(st.board, tgt, st.turn).length > 0) {
      if (st.turn === seat) own -= 45; else foeS -= 45
    }
  }
  return { own, foe: foeS, claims: claimMine }
}
/* 井字 winNow/mustBlock：定关键盘成母盘三连的格（§4.1） */
function cascadeWinCells(st, seat) {
  const out = []
  for (const l of SUB_LINES) {
    let om = 0, alive = -1, blocked = false
    for (const b of l) { if (st.sub[b] === seat + 1) om++; else if (st.sub[b] === 0 || st.sub[b] === (foe(seat) + 1)) blocked = true; else if (alive === -1) alive = b }
    if (!blocked && om === 2 && alive >= 0) for (const cell of subClaimAt(st.board, alive, seat)) out.push(cell)
  }
  return out
}

/* =====================================================================
 * RULES 规则注册表（§5.3——五函数：init/legal/apply/end/feat）
 * ===================================================================== */
const RULES = {
  /* ---------- 五子连珠 gomoku · 15×15 ---------- */
  gomoku: {
    W: 15, H: 15, confirmTap: true,
    init() {
      const st = { board: new Array(225).fill(0), sub: new Array(9).fill(-1) }
      return st
    },
    legal(st) {
      const out = []
      for (let c = 0; c < 225; c++) if (st.board[c] === 0) out.push(c)
      return out
    },
    check(st, seat, cell) { return st.board[cell] === 0 ? null : 'occupied' },
    apply(st, seat, cell) {
      st.board[cell] = seat + 1
      const events = [{ k: 'place', seat, cell }]
      const line = winLineCells(st.board, 15, 15, cell, seat + 1)
      if (line) events.push({ k: 'win-line', cells: line })
      return events
    },
    end(st) {
      for (let c = 0; c < 225; c++) if (st.board[c] && winLineCells(st.board, 15, 15, c, st.board[c])) {
        return { winner: st.board[c] === 1 ? 'A' : 'B', reason: 'five' }
      }
      for (let c = 0; c < 225; c++) if (st.board[c] === 0) return null
      return { winner: 'draw', reason: 'count' } // 满盘兜底（§2.2）
    },
    timeoutJudge(st) { // 硬顶即时判定（§1.6 通道 5）：最长连→子数
      const t = [0, 1].map((s) => { let mx = 0, n = 0; for (let c = 0; c < 225; c++) { if (st.board[c] === s + 1) { n++; mx = Math.max(mx, chainLen(st.board, 15, 15, c, s + 1)) } } return { mx, n } })
      if (t[0].mx !== t[1].mx) return { winner: t[0].mx > t[1].mx ? 'A' : 'B', reason: 'timeout' }
      if (t[0].n !== t[1].n) return { winner: t[0].n > t[1].n ? 'A' : 'B', reason: 'timeout' }
      return { winner: 'draw', reason: 'timeout' }
    },
    feat(st, seat) {
      const f = foe(seat)
      const ws = gomokuWindowScore(st.board, seat)
      const mine = gomokuMakeCells(st.board, seat)
      const theirs = gomokuMakeCells(st.board, f)
      let ownMax = 0, foeMax = 0
      for (let c = 0; c < 225; c++) { if (st.board[c]) { const n = chainLen(st.board, 15, 15, c, st.board[c]); if (st.board[c] === seat + 1 && n > ownMax) ownMax = n; if (st.board[c] === f + 1 && n > foeMax) foeMax = n } }
      return {
        score: ws[0] - ws[1], ownV: ws[0], foeV: ws[1],
        winNow: mine.win, mustBlock: theirs.win,
        threats: mine.thr, danger: theirs.thr,
        legal: null, // 全空格（Bot 侧邻域收窄，§4.3）
        counts: { own: ownMax, foe: foeMax },
      }
    },
    scores(st) {
      const out = {}
      for (let s = 0; s < 2; s++) {
        let n = 0, mx = 0
        for (let c = 0; c < 225; c++) if (st.board[c] === s + 1) { n++; mx = Math.max(mx, chainLen(st.board, 15, 15, c, s + 1)) }
        out[s === 0 ? 'A' : 'B'] = { moves: n, longest: mx, clockMs: st.clock[s] }
      }
      return out
    },
  },

  /* ---------- 黑白翻转 reversi · 8×8（标准奥赛罗） ---------- */
  reversi: {
    W: 8, H: 8, confirmTap: false,
    init() {
      const board = new Array(64).fill(0)
      board[28] = 1; board[35] = 1 // 黑(席0)：(3,4)(4,3)
      board[27] = 2; board[36] = 2 // 白(席1)：(3,3)(4,4)
      return { board, sub: new Array(9).fill(-1) }
    },
    legal(st, seat) {
      const out = []
      for (let c = 0; c < 64; c++) if (st.board[c] === 0 && reversiFlips(st.board, seat, c).length) out.push(c)
      return out
    },
    check(st, seat, cell) { return reversiFlips(st.board, seat, cell).length ? null : 'no-flip' },
    apply(st, seat, cell) {
      const cells = reversiFlips(st.board, seat, cell)
      st.board[cell] = seat + 1
      for (const c of cells) st.board[c] = seat + 1
      const events = [{ k: 'place', seat, cell }]
      if (cells.length) events.push({ k: 'flip', cells, n: cells.length, seat })
      return events
    },
    end(st) {
      let a = 0, b = 0, empty = 0
      for (let c = 0; c < 64; c++) { if (st.board[c] === 1) a++; else if (st.board[c] === 2) b++; else empty++ }
      if (empty === 0 || (this.legal(st, 0).length === 0 && this.legal(st, 1).length === 0)) {
        return { winner: a === b ? 'draw' : a > b ? 'A' : 'B', reason: 'count' }
      }
      return null
    },
    timeoutJudge(st) { // 即时数子
      let a = 0, b = 0
      for (let c = 0; c < 64; c++) { if (st.board[c] === 1) a++; else if (st.board[c] === 2) b++ }
      return { winner: a === b ? 'draw' : a > b ? 'A' : 'B', reason: 'timeout' }
    },
    feat(st, seat) {
      const f = foe(seat)
      let w = 0
      for (let c = 0; c < 64; c++) { const v = st.board[c]; const x = wgtAt(st.board, c) * (v === seat + 1 ? 1 : v === f + 1 ? -1 : 0); w += x }
      const mob = [this.legal(st, seat).length, this.legal(st, f).length]
      const stab = stabOf(st.board, seat) - stabOf(st.board, f)
      const score = w + 8 * (mob[0] - mob[1]) + 4 * stab
      let a = 0, b = 0
      for (let c = 0; c < 64; c++) { if (st.board[c] === 1) a++; else if (st.board[c] === 2) b++ }
      const cornerThreat = (sx) => CORNERS.filter((c) => st.board[c] === 0 && reversiFlips(st.board, sx, c).length)
      return {
        score, ownV: score, foeV: 0, // 黑白评估为单一位置分（ownV 带 WGT 全量，托管倾向作用于整体）
        winNow: [], mustBlock: cornerThreat(f),
        threats: cornerThreat(seat).map((cell) => ({ cell, lv: 120 })), danger: cornerThreat(f).map((cell) => ({ cell, lv: 120 })),
        legal: mob[0] > 0 ? null : [],
        counts: { own: seat === 0 ? a : b, foe: seat === 0 ? b : a },
      }
    },
    scores(st) {
      const out = {}
      for (let s = 0; s < 2; s++) {
        let n = 0, corners = 0
        for (let c = 0; c < 64; c++) if (st.board[c] === s + 1) { n++; if (CORNERS.includes(c)) corners++ }
        out[s === 0 ? 'A' : 'B'] = { discs: n, corners, maxFlip: st.stats[s].maxFlip }
      }
      return out
    },
  },

  /* ---------- 连环井字 cascade · 9×9 井字扩展 ---------- */
  cascade: {
    W: 9, H: 9, confirmTap: false,
    init() { return { board: new Array(81).fill(0), sub: new Array(9).fill(-1) } },
    legal(st) {
      const win = cascadeWindow(st)
      const out = []
      for (let cell = 0; cell < 81; cell++) {
        if (st.board[cell] !== 0) continue
        if (win === null) { if (st.sub[SUB_OF[cell]] === -1) out.push(cell) } // 自由=任意活盘
        else if (SUB_OF[cell] === win) out.push(cell)
      }
      return out
    },
    check(st, seat, cell) {
      const win = cascadeWindow(st)
      if (win !== null && SUB_OF[cell] !== win) return 'wrong-board'
      if (st.sub[SUB_OF[cell]] !== -1) return 'dead-board'
      return null
    },
    apply(st, seat, cell) {
      st.board[cell] = seat + 1
      const events = [{ k: 'place', seat, cell }]
      const sub = SUB_OF[cell]
      const { c9 } = subStateOf(st.board, sub)
      const line = subWinLine(c9, seat + 1)
      if (line) { st.sub[sub] = seat + 1; events.push({ k: 'sub', idx: sub, owner: seat + 1, seat }) }
      else if (!c9.includes(0)) { st.sub[sub] = 0; events.push({ k: 'sub', idx: sub, owner: 0, seat }) }
      const ml = metaLineOf(st.sub, seat + 1)
      if (ml) events.push({ k: 'win-line', cells: ml.map((b) => subCells3(b)[4]), subs: ml })
      return events
    },
    end(st) {
      for (const owner of [1, 2]) { const ml = metaLineOf(st.sub, owner); if (ml) return { winner: owner === 1 ? 'A' : 'B', reason: 'meta' } }
      for (let b = 0; b < 9; b++) if (st.sub[b] === -1) {
        let empty = false
        for (const c of subCells3(b)) if (st.board[c] === 0) { empty = true; break }
        if (empty) return null // 仍有可落格
      }
      let a = 0, b = 0
      for (let i = 0; i < 9; i++) { if (st.sub[i] === 1) a++; else if (st.sub[i] === 2) b++ }
      return { winner: a === b ? 'draw' : a > b ? 'A' : 'B', reason: 'boards' }
    },
    timeoutJudge(st) { // 占盘数
      let a = 0, b = 0
      for (let i = 0; i < 9; i++) { if (st.sub[i] === 1) a++; else if (st.sub[i] === 2) b++ }
      return { winner: a === b ? 'draw' : a > b ? 'A' : 'B', reason: 'timeout' }
    },
    feat(st, seat) {
      const ev = cascadeEval(st, seat)
      const f = foe(seat)
      let a = 0, b = 0
      for (let i = 0; i < 9; i++) { if (st.sub[i] === 1) a++; else if (st.sub[i] === 2) b++ }
      return {
        score: ev.own - ev.foe, ownV: ev.own, foeV: ev.foe,
        winNow: cascadeWinCells(st, seat), mustBlock: cascadeWinCells(st, f),
        threats: ev.claims[seat].map((x) => ({ cell: x.cell, lv: 30 })), danger: ev.claims[f].map((x) => ({ cell: x.cell, lv: 30 })),
        legal: null,
        counts: { own: seat === 0 ? a : b, foe: seat === 0 ? b : a },
      }
    },
    scores(st) {
      const out = {}
      for (let s = 0; s < 2; s++) {
        let boards = 0, moves = 0
        for (let i = 0; i < 9; i++) if (st.sub[i] === s + 1) boards++
        for (let c = 0; c < 81; c++) if (st.board[c] === s + 1) moves++
        out[s === 0 ? 'A' : 'B'] = { boards, subWins: boards, moves }
      }
      return out
    },
  },
}
const RULE_NAMES = ['gomoku', 'reversi', 'cascade']

/* ---------- 建局 ---------- */
function create(seed, opts = {}) {
  const rule = RULE_NAMES.includes(opts.rule) ? opts.rule : 'gomoku'
  const handicap = rule === 'gomoku' && [0, 2, 3].includes(opts.handicap) ? opts.handicap : 0
  const base = RULES[rule].init()
  const st = {
    v: 1, seed: seed >>> 0, maxTicks: Number.isInteger(opts.maxTicks) ? opts.maxTicks : 60000,
    tick: 0, rule, handicap,
    phase: 'live', over: false, result: null,
    board: base.board, sub: base.sub,
    turn: 0, moveNo: 0, last: -1, last2: -1,
    clock: [CLOCK_MS, CLOCK_MS], passStreak: 0,
    hostOn: [false, false], afkStreak: [0, 0], turnOps: [0, 0],
    turnStartTick: 0, deadline: 0,
    stats: [0, 1].map(() => ({ moves: 0, maxChain: 0, maxFlip: 0, threatMoves: 0, doubleWin: 0 })),
    opsLog: [{ s: -1, k: 'room', rule, handicap }], // 回放器按此建同型局（§5.6）
    outbox: [], _botLevel: null,
  }
  return st
}

/* ---------- 事件/账本公共件 ---------- */
function emit(st, events, vis) { st.outbox.push({ events, vis: vis === undefined ? 'all' : vis }) }
function logOp(st, seat, k, extra) { st.opsLog.push(Object.assign({ s: seat, k }, extra || {})) }

/* ---------- 终局（§1.6 八通道） ---------- */
function endScores(st) { return RULES[st.rule].scores(st) }
function endGame(st, winner, reason) {
  if (st.over) return
  st.over = true
  st.phase = 'ended'
  st.result = { winner, reason, scores: endScores(st), quip: quip(st, winner) }
  emit(st, [{ k: 'end', winner, reason }], 'all')
}

/* ---------- 换手（§1.5 ⑥：含黑白自动 pass 链 + 五子让子手序） ---------- */
function switchTurn(st) {
  st.moveNo++
  const R = RULES[st.rule]
  if (st.rule === 'gomoku' && st.moveNo < st.handicap) {
    st.turn = 0 // 让子：前 N 手恒黑（席 0）连放（§1.3）
  } else {
    st.turn = 1 - st.turn
  }
  if (st.rule === 'reversi') { // ④ 自动 pass：换手后对方无合法手 → pass 再换回；双无手 → 数子终局
    let guard = 2
    while (guard-- > 0 && !st.over) {
      if (R.legal(st, st.turn).length > 0) break
      st.passStreak++
      logOp(st, st.turn, 'pass', {}) // 系统事件入账（§5.6——回放重算自动忽略）
      emit(st, [{ k: 'pass', seat: st.turn }], 'all')
      if (st.passStreak >= 2 || R.legal(st, 1 - st.turn).length === 0) {
        const e = R.end(st)
        endGame(st, e ? e.winner : 'draw', e ? e.reason : 'count')
        return
      }
      st.turn = 1 - st.turn
    }
    if (R.legal(st, st.turn).length === 0) { const e = R.end(st); endGame(st, e ? e.winner : 'draw', 'count'); return }
  }
  st.passStreak = 0
  st.turnOps = [0, 0]
  st.turnStartTick = st.tick
  st.deadline = st.tick + STEP_TICKS
  emit(st, [{ k: 'turn', seat: st.turn, moveNo: st.moveNo }], 'all')
}

/* ---------- op 权威校验+结算（WS op/测试注入/Bot 三源共用；§5.1 三消息目录） ---------- */
function applyOp(st, seat, op, fromBot) {
  if (st.over) return { reject: 'over' }
  const k = op && op.k
  const R = RULES[st.rule]
  if (k === 'host') { // 主动托管开关（任意时刻合法；任意合法 op 即夺回）
    st.hostOn[seat] = !!op.on
    st.afkStreak[seat] = 0 // op 在场=非挂机（§1.4 零 op 口径）
    emit(st, [{ k: 'host', seat, on: st.hostOn[seat] }], 'all')
    logOp(st, seat, 'host', { on: st.hostOn[seat] ? 1 : 0 })
    return { ok: true }
  }
  if (k === 'concede') { logOp(st, seat, 'concede', {}); endGame(st, seat === 0 ? 'B' : 'A', 'resign'); return { ok: true } }
  if (fromBot !== true && st.hostOn[seat]) { st.hostOn[seat] = false; emit(st, [{ k: 'host', seat, on: false }], 'all') }
  if (k !== 'place') return { reject: 'bad-op' }
  const cell = Number(op.cell)
  if (!Number.isInteger(cell) || cell < 0 || cell >= R.W * R.H) return { reject: 'bad-cell' }
  if (st.turn !== seat) return { reject: 'not-your-turn' }
  const chk = R.check(st, seat, cell)
  if (chk) return { reject: chk }
  if (fromBot !== true) st.afkStreak[seat] = 0 // 玩家本人 op 才断连败计数（§1.4：代走/托管 op 不入「零 op」口径）
  st.turnOps[seat]++
  const preWin = st.rule === 'cascade' ? cascadeWinCells(st, seat).length : 0 // 双威胁判定（quip §4.7）
  /* ①校验→②入子→③规则结算（固定序 §1.5） */
  const events = R.apply(st, seat, cell)
  st.last2 = st.last
  st.last = cell
  st.stats[seat].moves++
  if (st.rule === 'gomoku') {
    const n = chainLen(st.board, 15, 15, cell, seat + 1)
    if (n > st.stats[seat].maxChain) st.stats[seat].maxChain = n
    if (n >= 3) st.stats[seat].threatMoves++
  }
  if (st.rule === 'reversi') {
    const fl = events.find((e) => e.k === 'flip')
    if (fl && fl.n > st.stats[seat].maxFlip) st.stats[seat].maxFlip = fl.n
  }
  if (st.rule === 'cascade' && preWin >= 2 && events.some((e) => e.k === 'win-line')) st.stats[seat].doubleWin = 1
  logOp(st, seat, 'place', { cell, fb: fromBot === true ? 1 : 0 }) // fb=bot 通道标记（F2：回放须按原通道重放，防 afkStreak 误清零）
  /* ⑤胜负检查（④pass 在换手内） */
  const fin = R.end(st)
  if (fin) { emit(st, events, 'all'); endGame(st, fin.winner, fin.reason); return { ok: true } }
  /* ⑥换手 */
  emit(st, events, 'all')
  switchTurn(st)
  return { ok: true }
}

/* ---------- 超时单步代走（托管三层①：casual 随手代一步，§1.4/§5.5） ---------- */
function timeoutStep(st) {
  const seat = st.turn
  logOp(st, seat, '$timeout', {}) // 先入账（回放须见标记才能重演代走段，§5.6）
  if (st.turnOps[seat] === 0) { // 全超时步（零 op）→ afk 计数（代走 op 不入计数）
    st.afkStreak[seat]++
    if (st.afkStreak[seat] >= 3) { endGame(st, seat === 0 ? 'B' : 'A', 'afk'); return }
  } else st.afkStreak[seat] = 0
  emit(st, [{ k: 'timeout-move', seat }], 'all')
  const mv = casualNext(st, seat)
  if (mv !== null && mv !== undefined) applyOp(st, seat, { k: 'place', cell: mv }, true)
  if (!st.over && st.turn === seat) switchTurn(st) // 无合法手兜底（reversi pass 链已内建）
}

/* ---------- 帧推进（事件驱动：计时器外零计算 §5.7） ---------- */
function step(st, inputs) {
  st.tick++
  if (st.over) return { over: true, result: st.result }
  if (!st.deadline) { st.deadline = st.tick + STEP_TICKS; st.turnStartTick = st.tick } // live 首拍锚步限
  st.clock[st.turn] -= META.tickMs // 棋钟独立走表（托管不暂停，§2.5）
  if (st.clock[st.turn] <= 0) { st.clock[st.turn] = 0; endGame(st, st.turn === 0 ? 'B' : 'A', 'clock'); return { over: true, result: st.result } }
  if (st.tick >= st.maxTicks) { const e = RULES[st.rule].timeoutJudge(st); endGame(st, e.winner, e.reason); return { over: true, result: st.result } }
  if (inputs) { // bot 席帧通道 op（与 WS op 同一 applyOp 权威入口）
    for (let s = 0; s < 2; s++) {
      const o = inputs[s] && inputs[s].op
      if (o && typeof o === 'object' && typeof o.k === 'string' && !st.over) applyOp(st, s, o, true)
    }
  }
  for (let s = 0; s < 2; s++) { // 主动托管续打（§5.5 层②：balanced 核+倾向继承）
    if (!st.hostOn[s] || st.over || st.turn !== s) continue
    const mv = hostedNext(st, s)
    if (mv !== null && mv !== undefined) applyOp(st, s, { k: 'place', cell: mv }, true)
  }
  if (!st.over && st.tick >= st.deadline) timeoutStep(st)
  return st.over ? { over: true, result: st.result } : {}
}

/* =====================================================================
 * Bot 三档（§4 统一框架：决策域与规则域解耦——feat 特征提取器注入）
 * ===================================================================== */
function botRng(st, seat, idx) { // §5.5 决策流：seed^seat^moveNo^决策序（同 seed 同决策）
  return mulberry32((st.seed ^ Math.imul(seat + 1, 0x9E3779B9) ^ (st.moveNo * 0x10001) ^ idx) >>> 0)
}
function decIdx(st, seat) { let n = 0; for (const o of st.opsLog) if (o.s === seat && o.k === 'place') n++; return n }
function gated(st, seat, level) { // 拟人延时门（回合内相对 tick——轮询抖动免疫）
  const rng = botRng(st, seat, 47000 + decIdx(st, seat))
  const [lo, hi] = BOT_DELAY[level] || BOT_DELAY.balanced
  return (st.tick - st.turnStartTick) < lo + ((rng() * (hi - lo)) | 0)
}
function cloneState(st) { // scratch 副本（§4.3 pool/element 克隆先例）
  return {
    v: st.v, seed: st.seed, maxTicks: st.maxTicks, tick: st.tick, rule: st.rule, handicap: st.handicap,
    phase: st.phase, over: false, result: null,
    board: st.board.slice(), sub: st.sub.slice(),
    turn: st.turn, moveNo: st.moveNo, last: st.last, last2: st.last2,
    clock: [st.clock[0], st.clock[1]], passStreak: st.passStreak,
    hostOn: [false, false], afkStreak: st.afkStreak.slice(), turnOps: st.turnOps.slice(),
    turnStartTick: st.turnStartTick, deadline: st.deadline,
    stats: st.stats.map((x) => Object.assign({}, x)),
    opsLog: [], outbox: [], _botLevel: st._botLevel,
  }
}
/* 候选域收窄（§4.3）：五子=有子邻域 2 格（无子=中心 5×5）；黑白/井字=合法手 */
function candidates(st, seat) {
  const R = RULES[st.rule]
  const legal = R.legal(st, seat)
  if (st.rule !== 'gomoku') return legal.length ? legal : []
  if (legal.length === 225) { const out = []; for (let r = 5; r < 10; r++) for (let c = 5; c < 10; c++) out.push(r * 15 + c); return out }
  const near = new Set()
  for (let c = 0; c < 225; c++) {
    if (st.board[c] === 0) continue
    const r = (c / 15) | 0, cc = c % 15
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const rr = r + dr, c2 = cc + dc
      if (rr >= 0 && rr < 15 && c2 >= 0 && c2 < 15 && st.board[rr * 15 + c2] === 0) near.add(rr * 15 + c2)
    }
  }
  return [...near].sort((a, b) => a - b)
}
function simulatePlace(st, seat, cell) {
  const cl = cloneState(st)
  const r = applyOp(cl, seat, { k: 'place', cell }, true)
  if (r && r.reject) return null
  return cl
}
/* 底座反应求交（F1 修复·GAMES-157）：feat 提取器跨规则复用，winNow/mustBlock 按规则
 * 语义可含「对己非法」格——reversi mustBlock=对手可翻角（不查己方夹击）；cascade
 * winNow/mustBlock=定盘成点（不查送位窗/死盘）。盲返 → applyOp 拒绝 → 决策流 rng 定桩
 * 同格重试 → 烧穿步限×3 假 afk（QA1 §6.1）。产出与 legal 求交=一处防线全链自愈：
 * 三档 bot+托管层①casual 代走②hosted 同脑路径，及导出面消费方（api-check 策略/客户端
 * 红角提示）。gomoku 产出恒空格=合法，求交恒等（对照模式零扰动）。 */
function featOf(st, seat) {
  const f = RULES[st.rule].feat(st, seat)
  const lg = RULES[st.rule].legal(st, seat)
  f.winNow = f.winNow.filter((c) => lg.includes(c))
  f.mustBlock = f.mustBlock.filter((c) => lg.includes(c))
  return f
}
/* casual 随手（§4.2：rng 随机+30% 底座反应） */
function casualNext(st, seat) {
  const rng = botRng(st, seat, 9100 + decIdx(st, seat))
  const R = RULES[st.rule]
  const f = featOf(st, seat)
  if (rng() < 0.3) { // 共享底座反应（附决策 9：规则性反应非棋力——casual 30% 命中）
    if (f.winNow.length) return f.winNow[0]
    if (f.mustBlock.length) return f.mustBlock[0]
  }
  const pool = candidates(st, seat)
  if (!pool.length) return null
  if (st.rule === 'reversi' && rng() < 0.3) { // 抢角意识（§4.2）
    const corner = pool.filter((c) => CORNERS.includes(c))
    if (corner.length) return corner[0]
  }
  return pool[(rng() * pool.length) | 0]
}
/* balanced 价值评估（§4.3：ΔV argmax，tie-break 格序——零随机） */
function balancedNext(st, seat, opts = {}) {
  const F0 = featOf(st, seat)
  if (F0.winNow.length) return F0.winNow[0] // 恒执行底座反应（§4.1；F1：产出已与 legal 求交）
  if (F0.mustBlock.length) return F0.mustBlock[0]
  const pool = candidates(st, seat)
  let best = null, bestD = -Infinity
  const aQ8 = opts.attackQ8 || 256, sQ8 = opts.solidQ8 || 256
  for (const cell of pool) {
    const cl = simulatePlace(st, seat, cell)
    if (!cl || cl.over) { if (cl && cl.over && cl.result.winner === (seat === 0 ? 'A' : 'B')) return cell; continue }
    const F1 = RULES[st.rule].feat(cl, seat)
    const d = ((F1.ownV * aQ8) >> 8) - ((F1.foeV * sQ8) >> 8) - (((F0.ownV * aQ8) >> 8) - ((F0.foeV * sQ8) >> 8))
    if (d > bestD) { bestD = d; best = cell } // 严格大于=平值取低格（格序 tie-break）
  }
  return best // F1 第二成因（GAMES-157）：全候选 ΔV≤0 位面原返 null→烧步限假 afk
  // （「有合法手一步不走」同症状）；argmax 含负值=劣势局走最不差手（零随机语义不变）
}
/* competitive 三件套（§4.4 per-rule 深化——零随机） */
function competitiveNext(st, seat) {
  const F0 = featOf(st, seat)
  if (F0.winNow.length) return F0.winNow[0]
  if (F0.mustBlock.length) return F0.mustBlock[0]
  if (st.rule === 'reversi') { // 末局完全搜索：空格 ≤10 → α-β minimax 以最终子差收官（<200ms 预算）
    let empty = 0
    for (let c = 0; c < 64; c++) if (st.board[c] === 0) empty++
    if (empty <= 10) {
      const best = reversiEndgame(st, seat, -65, 65, 0)
      if (best.cell !== null && best.cell !== undefined) return best.cell
    }
  }
  const pool = candidates(st, seat)
  const scored = []
  for (const cell of pool) {
    const cl = simulatePlace(st, seat, cell)
    if (!cl) continue
    if (cl.over) { if (cl.result.winner === (seat === 0 ? 'A' : 'B')) return cell; continue }
    const F1 = RULES[st.rule].feat(cl, seat)
    let d = F1.score - F0.score
    /* 五子 danger 偏置（§4.4：lv≥8000 威胁分 ×11÷10 向零取整——防守预判可执行式） */
    if (st.rule === 'gomoku') for (const t of F1.danger) if (t.lv >= 8000) d -= (t.lv * 11 / 10) | 0
    /* 井字：SUB 完美解子盘项（§4.4-3——着点后子盘完美值）+ 双威胁构造 +15 */
    if (st.rule === 'cascade') {
      const sub = SUB_OF[cell]
      const { c9 } = subStateOf(cl.board, sub)
      const sv = SUB[subIndexOf(c9)]
      if (sv) d += 200 * (cl.sub[sub] === seat + 1 ? 1 : -sv.v) // 定盘=满值；未定=对手视角完美值取负
      if (cascadeWinCells(cl, seat).length >= 2) d += 15
    }
    scored.push({ cell, d, cl })
  }
  scored.sort((a, b) => b.d - a.d || a.cell - b.cell)
  if (!scored.length) return null
  /* 一层前瞻（五子束宽 3 / 井字母盘 2-ply）：对手最强应手反评估（§4.4） */
  const beam = st.rule === 'gomoku' ? 3 : scored.length
  let best = scored[0].cell, bestV = -Infinity
  for (let i = 0; i < Math.min(beam, scored.length); i++) {
    const s = scored[i]
    const f = foe(seat)
    const reply = balancedNext(s.cl, f)
    let v = s.d
    if (reply !== null && reply !== undefined) {
      const cl2 = simulatePlace(s.cl, f, reply)
      if (cl2 && !cl2.over) v = RULES[st.rule].feat(cl2, seat).score - F0.score
      else if (cl2 && cl2.over && cl2.result.winner !== (seat === 0 ? 'A' : 'B')) v = -1000000 // 对手应手致我败
    }
    if (v > bestV) { bestV = v; best = s.cell }
  }
  return best
}
/* 黑白末局 α-β（§4.4-2：以最终子差最优收官；节点=合法手剪枝） */
function reversiEndgame(st, seat, alpha, beta, depth) {
  const R = RULES.reversi
  const legal = R.legal(st, seat)
  if (!legal.length) {
    if (!R.legal(st, foe(seat)).length) { // 双无手 → 终局子差
      let a = 0, b = 0
      for (let c = 0; c < 64; c++) { if (st.board[c] === 1) a++; else if (st.board[c] === 2) b++ }
      return { v: seat === 0 ? a - b : b - a, cell: null }
    }
    const pass = cloneState(st) // 轮转 pass：仅翻行棋方（不走 switchTurn 副作用链）
    pass.turn = foe(seat)
    pass.moveNo++
    const r = reversiEndgame(pass, foe(seat), -beta, -alpha, depth + 1)
    return { v: -r.v, cell: null }
  }
  if (depth > 14) { // 预算帽（≤10 空时深度天然 ≤11——防御性）
    let a = 0, b = 0
    for (let c = 0; c < 64; c++) { if (st.board[c] === 1) a++; else if (st.board[c] === 2) b++ }
    return { v: seat === 0 ? a - b : b - a, cell: legal[0] }
  }
  let bv = -65, bc = null
  for (const cell of legal) {
    const cl = cloneState(st)
    applyOp(cl, seat, { k: 'place', cell }, true)
    const r = reversiEndgame(cl, foe(seat), -beta, -alpha, depth + 1)
    const v = -r.v
    if (v > bv) { bv = v; bc = cell }
    if (v > alpha) alpha = v
    if (alpha >= beta) break
  }
  return { v: bv, cell: bc }
}
/* 托管倾向继承（§4.6：attackBias/solidBias——盘面确定性代理复算，重放可验） */
function tendencyOf(st, seat) {
  let own = 0, atk = 0, solid = 0
  const W = RULES[st.rule].W
  for (const o of st.opsLog) { // 本席已入账落子（输入日志复算口径）
    if (o.s !== seat || o.k !== 'place') continue
    own++
    const cell = o.cell
    const r = (cell / W) | 0, c = cell % W
    if (st.rule === 'gomoku' || st.rule === 'reversi') {
      let touch = false
      for (const [dr, dc] of D8) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < RULES[st.rule].H && cc >= 0 && cc < W && st.board[rr * W + cc] === foe(seat) + 1) touch = true }
      if (touch) atk++
      if (st.rule === 'reversi' && (CORNERS.includes(cell) || WGT[cell] >= 15)) solid++
      if (st.rule === 'gomoku') solid++ // 棋类无专门稳定位：贴身/阻断视作稳健向（atk 已单列）
    } else if (st.rule === 'cascade') {
      if (SUB_OF[cell] !== 4) solid++ // 非中心盘=稳守倾向
    }
  }
  const tot = Math.max(1, own)
  return { attackQ8: Math.max(128, Math.min(384, Math.round((0.5 + atk / tot) * 256))), solidQ8: Math.max(128, Math.min(384, Math.round((0.5 + solid / tot) * 256))) }
}
function hostedNext(st, seat) { // 持续托管（§5.5 层②）：balanced 核 + 倾向继承
  if (gated(st, seat, 'hosted')) return null
  const t = tendencyOf(st, seat)
  return balancedNext(st, seat, t)
}
/* ---------- brain（Bot 宿主统一入口；决策流 keyed——同 seed 同决策） ---------- */
function brain(state, seat, level) {
  const st = state
  if (!st || st.over || st.turn !== seat) return {}
  if (gated(st, seat, level)) return {}
  let mv = null
  if (level === 'casual') mv = casualNext(st, seat)
  else if (level === 'competitive') mv = competitiveNext(st, seat)
  else mv = balancedNext(st, seat)
  if (mv === null || mv === undefined) return {}
  return { op: { k: 'place', cell: mv } }
}

/* ---------- 棋桌评语（§4.7 确定性查表，零随机；优先级取首命中） ---------- */
function quip(st, winner) {
  const lv = st._botLevel || 'balanced'
  const A = st.stats[0], Bs = st.stats[1]
  if (st.rule === 'gomoku') {
    if (winner === 'A' && A.threatMoves >= 2) return '双线开花，我堵不过来。'
    if (winner === 'A' && A.moves + Bs.moves <= 24) return `${A.moves + Bs.moves} 手连珠，快刀。`
    if (winner === 'A' && st.handicap >= 2) return '让子也赢——下次别让我了。'
    if (winner === 'B' && A.maxChain === 4) return '只差一格，差的偏偏是那一格。'
  } else if (st.rule === 'reversi') {
    const corners = (sx) => CORNERS.filter((c) => st.board[c] === sx + 1).length
    if (corners(winner === 'A' ? 0 : 1) === 4) return '四角尽收，盘面成了你的地图。'
    const fl = winner === 'A' ? A : Bs
    if (fl.maxFlip >= 12) return `一手翻${fl.maxFlip}子，潮水当场转向。`
    let a = 0, b = 0
    for (let c = 0; c < 64; c++) { if (st.board[c] === 1) a++; else if (st.board[c] === 2) b++ }
    if (winner === 'A' && a === 64) return '一盘未留。'
    if (winner !== 'draw' && Math.abs(a - b) >= 20) return '大比分——复盘请从角开始。'
  } else if (st.rule === 'cascade') {
    let a = 0, b = 0
    for (let i = 0; i < 9; i++) { if (st.sub[i] === 1) a++; else if (st.sub[i] === 2) b++ }
    if (winner !== 'draw' && (winner === 'A' ? A : Bs).doubleWin) return '那一步之后就没有悬念了。'
    if (winner !== 'draw' && (winner === 'A' ? a : b) >= 7) return '棋盘快被你圈完了。'
    if (winner === 'draw' && a === 4 && b === 4) return '四比四，势均力敌，再来。'
    if (winner !== 'draw' && Math.abs(a - b) <= 1 && st.result && st.result.reason === 'meta') return '一线之间，环环相扣。'
  }
  return { casual: '随手棋而已，陪下愉快。', balanced: '势均力敌，再来一盘。', competitive: '记住那手必堵。' }[lv] || '势均力敌，再来一盘。'
}

/* ---------- 零隐藏信息视图（§5.2：canonical 即广播视图——恒等映射） ---------- */
function viewFor(st, seat) { // seat 参数保留（谱系位）；零隐藏信息=不裁剪
  void seat
  return {
    phase: st.over ? 'ended' : st.phase, rule: st.rule, handicap: st.handicap,
    board: st.board.slice(), sub: st.sub.slice(),
    turn: st.turn, moveNo: st.moveNo, last: st.last, last2: st.last2,
    clock: [st.clock[0], st.clock[1]], passStreak: st.passStreak,
    host: st.hostOn.slice(), over: st.over,
    timerMs: st.over ? 0 : Math.max(0, (st.deadline ? st.deadline - st.tick : STEP_TICKS) * META.tickMs),
  }
}
/* canonical serialize（§5.6 键字母序；计时面 tick/clock/deadline/turnStartTick 不入——双跑口径） */
function serialize(st) {
  const sortK = (o) => {
    if (Array.isArray(o)) return o.map(sortK)
    if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o).sort()) r[k] = sortK(o[k]); return r }
    return o
  }
  return JSON.stringify(sortK({
    rule: st.rule, handicap: st.handicap, phase: st.phase,
    board: st.board, sub: st.sub, turn: st.turn, moveNo: st.moveNo,
    last: st.last, last2: st.last2, passStreak: st.passStreak,
    hostOn: st.hostOn, afkStreak: st.afkStreak, stats: st.stats,
  }))
}
function hashState(st) { return fnv1a32(serialize(st)) }
/* 回放器（§5.6：重放输入日志即整局复算；托管代走已固化为 $timeout 标记——回放重跑
 * casual（决策流 keyed 确定性）；自动 pass 由结算管线重算，日志 pass 条目跳过；
 * F2（GAMES-157）：place 按 fb 标记还原通道——bot 通道（代走/托管/bot 席）不重置
 * afkStreak，人类 op 才复位。旧日志无 fb=按人类重放（afk 免检局口径不变）） */
function replayOps(seed, ops, maxTicks) {
  let rule = 'gomoku', handicap = 0
  if (ops[0] && ops[0].k === 'room') { rule = RULE_NAMES.includes(ops[0].rule) ? ops[0].rule : 'gomoku'; handicap = ops[0].handicap || 0 }
  const st = create(seed, { maxTicks, rule, handicap })
  for (const o of ops) {
    if (st.over) break
    if (o.k === 'room' || o.k === 'pass') continue
    if (o.k === '$timeout') { timeoutStep(st); continue }
    if (o.k === 'host') applyOp(st, o.s, { k: 'host', on: !!o.on })
    else if (o.k === 'concede') applyOp(st, o.s, { k: 'concede' })
    else if (o.k === 'place') applyOp(st, o.s, { k: 'place', cell: o.cell }, o.fb === 1 ? true : undefined)
  }
  return st
}

/* 引擎/常量声明块（版本护栏 §5：一套 engine hash 护栏三模式——单哈希全量覆盖，附决策 13） */
const ENGINE_HASH = fnv1a32(JSON.stringify({
  meta: META, pat: GOMOKU_PAT, wgt: WGT, sub: SUB.map((x) => x.v * 16 + x.m).join(','),
  clock: CLOCK_MS, step: STEP_TICKS, delay: BOT_DELAY,
}))

return {
  META, LEVELS, RULES, RULE_NAMES, ENGINE_HASH, CLOCK_MS, STEP_TICKS, BOT_DELAY,
  fnv1a32, mulberry32, create, step, applyOp, brain, viewFor, serialize, hashState, replayOps,
  feat: featOf, legal: (st, seat) => RULES[st.rule].legal(st, seat),
  candidates, casualNext, balancedNext, competitiveNext, hostedNext, tendencyOf, quip,
  SUB, subClaimAt, cascadeWindow, SUB_OF, subCells3, subStateOf, chainLen, winLineCells, reversiFlips,
  CORNERS, WGT,
}
})
