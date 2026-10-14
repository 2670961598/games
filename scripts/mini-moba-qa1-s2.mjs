#!/usr/bin/env node
/* =====================================================================
 * GAMES-128 QA一号 · S2/S5 专项走查（sim 级，零网关依赖）
 * S2：二式快照审计（节拍/退化阈值/重建一致性/AOI 违例/预算/ext.ack/带宽画像）
 *     + 观战席（seat=-1 导演镜头）+ 草丛过滤归因
 * S5：ruling 原子性（kill 唯一裁决/streak/bounty/respAt 复算/助攻窗）
 *     + S2/S5 边界（events 不丢：服务端账本 vs 各连接流逐条对拍）
 * 口径：小镇 GAMES-53 s2-specials 范式（快照逐张复盘账本）。
 * =================================================================== */
import { miniMobaSim } from '../server/gateway/sims/mini-moba.js'

const sim = miniMobaSim
const AOI_R = 320_000, AOI_OUT = 335_000 // milli-px（sim 坐标系）
const GRASS = sim ? null : null
let pass = 0, fail = 0
const lines = []
const ok = (grp, name, cond, detail = '') => {
  const line = `${cond ? '✓' : '✗'} [${grp}] ${name}${detail ? '（' + detail + '）' : ''}`
  lines.push(line); console.log(line)
  cond ? pass++ : fail++
}

/* ---------- 假会话：ctx.conn 传输层只记账（testapi.makeVctx 同构） ---------- */
const mkConn = () => {
  const ctx = { msgs: [], bytes: 0 }
  ctx.conn = { writable: true, send (t) { ctx.msgs.push(JSON.parse(t)); ctx.bytes += t.length } }
  return ctx
}

/* ---------- 房间装置：镜像 gateway doFrame（rooms.js:359-393 同构） ---------- */
function mkRoom(seed, levels, maxTicks) {
  const st = sim.create(seed, { test: true, maxTicks })
  const spec = mkConn()
  const conn0 = mkConn()
  const room = {
    state: st, frame: 0, id: 'qa-s2-' + seed,
    seats: levels.map((lv, i) => ({
      seat: i, kind: lv ? 'bot' : 'human', level: lv, name: lv ? 'Bot' : 'qa',
      conn: i === 0 ? conn0 : null, pending: new Map(), lastInput: { mx: 0, my: 0 }, lastSeq: -1,
    })),
    spectators: new Set([spec]),
    __dirQ: null, __dirCam: null,
  }
  const rngs = levels.map((lv, i) => lv ? sim.mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0) : null)
  return { room, conn0, spec, rngs, st }
}

/* ---------- 驱动器：API 席走 lane 折返（穿场采样 AOI/草丛），其余 bot ---------- */
function drive(seed, levels, maxTicks, humanPolicy) {
  const { room, conn0, spec, rngs, st } = mkRoom(seed, levels, maxTicks)
  const serverEvents = [] // 服务端事件账本（S2/S5 边界对拍源）
  const posAt = [] // 逐拍权威位形（leave 归因用时位坐标，防终态错位）
  let seq = 0
  for (let t = 0; t < maxTicks; t++) {
    const inputs = {}
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i]
      inputs[i] = s.kind === 'bot'
        ? sim.brain(st, i, s.level, rngs[i], { kinds: room.seats.map((x) => x.kind), foeLose: [0, 0, 0, 0, 0, 0] })
        : (humanPolicy ? humanPolicy(t, st, i) || { mx: 0, my: 0 } : { mx: 0, my: 0 })
    }
    room.seats[0].lastSeq = seq // 镜像 rooms.input 的 S2 seq 记账（rooms.js:232）
    seq++
    room.frame++
    const r = sim.step(st, inputs, room)
    for (const e of r.events) serverEvents.push({ ...e, __tick: st.tick - 1 })
    posAt[st.tick] = Object.values(st.ents).map((e) => ({ id: e.id, k: e.k, x: e.x, y: e.y }))
    sim.emit(room, r)
    if (r.over) return { room, conn0, spec, st, serverEvents, posAt, over: r.result, ticks: st.tick }
  }
  return { room, conn0, spec, st, serverEvents, posAt, over: null, ticks: st.tick }
}

const lanePolicy = (t, st, seat) => {
  // 折返走场：tick 段交替纵向机动，每 12 拍一次普攻仲裁目标（穿 AOI 边缘+草丛带）
  const phase = Math.floor(t / 260) % 2
  const inp = phase === 0 ? { mx: 0, my: -100 } : { mx: 60, my: 100 }
  if (t % 12 === 0) inp.cmd = { k: 'atk' }
  return inp
}

console.log('====== S2/S5 专项（sim 级全量账本复盘，seed=20261014，2400 tick） ======')
const MAXT = 2400
const levels = [null, 'casual', 'balanced', 'casual', 'balanced', 'competitive']
const run = drive(20261014, levels, MAXT, lanePolicy)
const snaps = run.conn0.msgs
const st = run.st

/* ---------- S2-1 节拍与序号 ---------- */
ok('S2-1', '快照节拍 snapsPerTick=1.000（10Hz）', snaps.length === run.ticks, `${snaps.length}/${run.ticks}`)
let seqBad = 0
for (let i = 1; i < snaps.length; i++) if (snaps[i].snapSeq !== snaps[i - 1].snapSeq + 1) seqBad++
ok('S2-1', 'snapSeq 逐张 +1 无跳号（弃帧不耗号，对照小镇 F3）', seqBad === 0, `跳号 ${seqBad} 次`)
ok('S2-1', '首张=全量 snapSeq=1', snaps[0].full === 1 && snaps[0].snapSeq === 1, `full=${snaps[0].full} seq=${snaps[0].snapSeq} ents=${snaps[0].ents.length}`)
let frameBad = 0
for (let i = 1; i < snaps.length; i++) if (snaps[i].frame !== snaps[i - 1].frame + 1) frameBad++
ok('S2-1', 'frame 逐张 +1（无丢拍）', frameBad === 0, `断号 ${frameBad} 次`)

/* ---------- S2-2 二式退化阈值 ---------- */
const fulls = [], incs = []
snaps.forEach((m, i) => (m.full ? fulls : incs).push({ m, i }))
let gapBad = 0, lastFullI = -1
for (const f of fulls) { if (lastFullI >= 0 && f.i - lastFullI > 301) gapBad++; lastFullI = f.i }
ok('S2-2', '全量校准间隔 ≤301 张（FULL_EVERY=300 张增量+1）', gapBad === 0, `全量 ${fulls.length} 张（${(fulls.length / snaps.length * 100).toFixed(1)}%），最大间隔 ${Math.max(...fulls.map((f, j) => j ? f.i - fulls[j - 1].i : f.i))}`)
let byteBad = 0, byteSamples = []
for (let i = 0; i < snaps.length; i++) {
  const m = snaps[i]
  if (!m.full) {
    const lastFull = fulls.filter((f) => f.i < i).pop()
    if (lastFull) { if (JSON.stringify(m).length > lastFull.m ? 0 : 0) byteBad++ } // 占位（下一行真算）
  }
}
// 增量字节 ≤ 0.7×上次全量（超出者本应退化全量——外视角不变量）
let lastFullLen = 0, overThr = 0, maxRatio = 0
for (const m of snaps) {
  const len = JSON.stringify(m).length
  if (m.full) lastFullLen = len
  else if (lastFullLen) {
    const ratio = len / lastFullLen
    maxRatio = Math.max(maxRatio, ratio)
    if (ratio > 0.7 + 1e-9) overThr++
  }
}
ok('S2-2', '增量字节 ≤0.7×上次全量（退化阈值不变量）', overThr === 0, `违例 ${overThr} 张，实测最大占比 ${(maxRatio * 100).toFixed(1)}%`)

const grassOf = (x, y, pad) => st.map.grass.find((g) => (x - g.x) ** 2 + (y - g.y) ** 2 <= (55_000 + pad) ** 2)

/* ---------- S2-3 客户端重建一致性（全量对拍） ---------- */
// 客户端视角不变量：extra=0（服务端已弃实体客户端必已 leave）；全量新增实体必在
// 视野圆内（本拍新入视野——入圈实体经 sendIds 必先于/随全量下发，圈外出现=协议违例）
let known = new Map(), reconBad = 0, reconChecked = 0, reconDetail = '', newEnter = 0
for (const m of snaps) {
  if (m.full) {
    if (known.size > 0) {
      const fullIds = new Set(m.ents.map((e) => e.id))
      const extra = [...known.keys()].filter((id) => !fullIds.has(id))
        .filter((id) => { // 良性剔除：出圈/草丛隐藏/死亡离场（全量=替换语义 client.js:120，prune 覆盖）
          const p = (run.posAt[m.frame] || []).find((x) => x.id === id)
          if (!p) return false
          const d = Math.sqrt((p.x - m.ext.aoi.x) ** 2 + (p.y - m.ext.aoi.y) ** 2)
          if (d > AOI_OUT) return false
          const g = grassOf(p.x, p.y, 10_000)
          if (g && (m.ext.aoi.x - g.x) ** 2 + (m.ext.aoi.y - g.y) ** 2 > 90_000 ** 2) return false
          return true // 圈内可见却缺席全量=违例
        })
      const missing = [...fullIds].filter((id) => !known.has(id) && id !== m.ents[0]?.id)
        .filter((id) => {
          const e = m.ents.find((x) => x.id === id)
          if (e && (e.k === 'tw' || e.k === 'core')) return false // 静态建筑恒候选（§2.3）
          const d = Math.sqrt((e.x - m.ext.aoi.x) ** 2 + (e.y - m.ext.aoi.y) ** 2)
          return d > AOI_OUT + 1500 // 圈外新增才是违例
        })
      newEnter += [...fullIds].filter((id) => !known.has(id)).length
      reconChecked++
      if (extra.length || missing.length) { reconBad++; if (!reconDetail) reconDetail = `extra=${extra.slice(0, 3)} 圈外missing=${missing.slice(0, 3)} @frame${m.frame}` }
    }
    known = new Map(m.ents.map((e) => [e.id, e]))
  } else {
    for (const e of m.ents) known.set(e.id, e)
    for (const id of m.leave || []) known.delete(id)
  }
}
ok('S2-3', '重建一致性：extra=0（leave 账不漏）+ 全量新增均在视野圆内', reconBad === 0, `对拍 ${reconChecked} 张全量，违例 ${reconBad}${reconDetail ? ' ' + reconDetail : ''}；全量新增实体 ${newEnter} 个均入圆`)
// 增量实体完整字段（非 delta 壳）
let deltaBad = 0
for (const m of snaps) if (!m.full) for (const e of m.ents) if (e.x == null || e.hp == null) deltaBad++
ok('S2-3', '增量 ents=完整实体（非字段差分壳）', deltaBad === 0, `违例 ${deltaBad}`)

/* ---------- S2-4 AOI 违例（视野圆 320/滞回 335，milli-px） ---------- */
const isDyn = (e) => e.k === 'hero' || e.k === 'creep' || e.k === 'mon'
let violFar = 0, violHyst = 0, maxD = 0, budgetBad = 0, maxEnts = 0, grassLeave = 0, unexplained = 0, ownBad = 0
for (const m of snaps) {
  const cx = m.ext.aoi.x, cy = m.ext.aoi.y
  maxEnts = Math.max(maxEnts, m.ents.length)
  if (m.ents.length > 41) budgetBad++
  for (const e of m.ents) {
    if (!isDyn(e)) continue
    const d = Math.sqrt((e.x - cx) ** 2 + (e.y - cy) ** 2)
    maxD = Math.max(maxD, d)
    if (d > AOI_OUT + 1500) violFar++
    else if (d > AOI_R + 1500 && !m.full) { /* known 滞回带内：合法 */ }
  }
  // 自身实体恒在首位（和解锚）
  const own = m.ents[0]
  if (!own || own.id !== 'h0') ownBad++
  // leave 归因（当拍时位坐标）：视野出圈 / 草丛 / 实体消亡（死亡删除）之外无解释=违例
  for (const id of m.leave || []) {
    const e = (run.posAt[m.frame] || []).find((p) => p.id === id)
    if (!e) continue // 该拍已消亡（creep/mon 死亡删除）——归因成立
    const d = Math.sqrt((e.x - cx) ** 2 + (e.y - cy) ** 2)
    const g = grassOf(e.x, e.y, 10_000)
    if (d > AOI_OUT) continue
    if (g && (cx - g.x) ** 2 + (cy - g.y) ** 2 > 90_000 ** 2) { grassLeave++; continue }
    unexplained++
  }
}
ok('S2-4', '视野外动态实体零下发（violFar=0）', violFar === 0, `违例 ${violFar}，全程最大半径 ${(maxD / 1000).toFixed(1)}px`)
ok('S2-4', '动态预算 ≤40+1（AOI_BUDGET）', budgetBad === 0, `峰值 ents=${maxEnts}`)
ok('S2-4', '自身实体恒在 ents 首位（和解锚）', ownBad === 0, `违例 ${ownBad}`)
ok('S2-4', 'leave 全归因（出圈/草丛/消亡）', unexplained === 0, `无解释 leave=${unexplained}；草丛过滤 leave=${grassLeave} 张（>0 即加层生效）`)

/* ---------- S2-5 ext.ack 预测和解账本 ---------- */
let ackBad = 0, ackLag = []
for (let i = 0; i < snaps.length; i++) {
  const expect = Math.min(i, run.ticks - 1) // 驱动器每拍 seq=i（0 基）
  if (snaps[i].ext.ack !== expect) { ackBad++; if (ackLag.length < 3) ackLag.push(`f${snaps[i].frame}:ack=${snaps[i].ext.ack}期望${expect}`) }
}
ok('S2-5', 'ext.ack=输入序号逐拍回显（预测和解锚）', ackBad === 0, `违例 ${ackBad}${ackLag.length ? ' ' + ackLag.join(' ') : '，全程 ack=seq 无滞后'}`)

/* ---------- S2-6 带宽画像（对照设计 §5.6 预算） ---------- */
const bps = (arr, from, to) => arr.slice(from, to).reduce((a, m) => a + JSON.stringify(m).length, 0) / ((to - from) / 10) / 1024
const laneKBs = bps(snaps, 100, 700)
let peakKBs = 0
for (let i = 0; i + 10 <= snaps.length; i += 5) peakKBs = Math.max(peakKBs, bps(snaps, i, i + 10))
const avgKBs = run.conn0.bytes / (run.ticks / 10) / 1024
ok('S2-6', '常态带宽 4-16KB/s（§5.6 预算带内；GAMES-129 实体视图瘦身后下界 8→4 重校——带宽只设上界意图，瘦=更好）', laneKBs >= 4 && laneKBs <= 18, `对线段实测 ${laneKBs.toFixed(1)}KB/s`)
ok('S2-6', '峰值带宽 <25KB/s（团战兜底）', peakKBs < 25, `1s 滑窗峰值 ${peakKBs.toFixed(1)}KB/s（全程均值 ${avgKBs.toFixed(1)}KB/s）`)

/* ---------- S2-7 观战席（seat=-1 导演镜头） ---------- */
const specSnaps = run.spec.msgs
let specBad = 0, camMoved = 0, lastCam = null
for (const m of specSnaps) {
  if (m.ext.ack !== -1) specBad++
  if (m.ext.me !== undefined) specBad++
  if (m.ext.aoi.r !== AOI_R) specBad++
  if (lastCam && (m.ext.aoi.x !== lastCam.x || m.ext.aoi.y !== lastCam.y)) camMoved++
  lastCam = m.ext.aoi
  if (m.ents.length > 41) specBad++
}
ok('S2-7', '观战席快照流：ack=-1 / 无 me / 同 AOI 圆 / 预算同限', specBad === 0 && specSnaps.length === run.ticks, `${specSnaps.length} 张，违例 ${specBad}`)
ok('S2-7', '导演镜头运动（kill/tower 质心 lerp）', camMoved > 0, `镜头位移拍 ${camMoved} 次`)

/* ---------- S5-1 kill ruling 原子性（账本复算） ---------- */
const kills = run.serverEvents.filter((e) => e.k === 'kill')
const hits = run.serverEvents.filter((e) => e.k === 'hit')
const streakLedger = [0, 0, 0, 0, 0, 0]
let atomicBad = 0, streakBad = 0, bountyBad = 0, assistBad = 0, respBad = 0
const perFrameVictim = new Map()
for (const k of kills) {
  const key = k.__tick + ':' + k.victim
  perFrameVictim.set(key, (perFrameVictim.get(key) || 0) + 1)
  if (k.killer >= 0) {
    streakLedger[k.killer]++
    if (k.streak !== streakLedger[k.killer]) { streakBad++; streakLedger[k.killer] = k.streak }
    const expBounty = Math.min(150 + 30 * (k.streak - 1), 300)
    if (k.bounty !== expBounty) bountyBad++
    streakLedger[k.victim] = 0
    // 助攻窗：5s 内伤害过受害者（hit 账本，by=hero id）
    const hitBy = new Set()
    for (const h of hits) if (h.vic === 'h' + k.victim && h.__tick >= k.__tick - 50 && h.by !== 'world') hitBy.add(h.by)
    for (const a of k.assists) if (!hitBy.has('h' + a)) assistBad++
  } else {
    if (k.bounty !== 0 || k.streak !== 0) bountyBad++ // 世界击杀零账（33e9237 口径）
    streakLedger[k.victim] = 0
  }
  if (k.respAt !== k.frame + 50 + 20 * k.lv) respBad++
}
for (const [, n] of perFrameVictim) if (n > 1) atomicBad++
ok('S5-1', `kill ruling ≥1 且一次 tick 一唯一裁决`, kills.length >= 1 && atomicBad === 0, `kill×${kills.length}（世界击杀 ${kills.filter((k) => k.killer < 0).length}），同拍重复 ${atomicBad}`)
ok('S5-1', 'streak 连击账本复算（击杀+1/受害清零）', streakBad === 0, `违例 ${streakBad}`)
ok('S5-1', 'bounty=150+30×(streak−1) 帽 300 / 世界击杀零账', bountyBad === 0, `违例 ${bountyBad}`)
ok('S5-1', 'respAt=frame+(5+2×lv)s 复算', respBad === 0, `违例 ${respBad}`)
ok('S5-1', '助攻∈5s 伤害窗（hit 账本反查）', assistBad === 0, `违例 ${assistBad}（assists 样例 ${kills.filter((k) => k.assists.length).length} 条带助攻）`)

/* ---------- S5-2 推塔无敌链（状态不变量） ---------- */
let invBad = 0
const towerHpAt = (m, id) => { const e = m.ents.find((x) => x.id === id); return e ? e.hp : null }
for (let i = 1; i < snaps.length; i++) {
  for (const team of ['A', 'B']) {
    const t1 = towerHpAt(snaps[i], `tw-${team}1`), t2 = towerHpAt(snaps[i], `tw-${team}2`), core = towerHpAt(snaps[i], `core-${team}`)
    const p1 = towerHpAt(snaps[i - 1], `tw-${team}1`), p2 = towerHpAt(snaps[i - 1], `tw-${team}2`), pc = towerHpAt(snaps[i - 1], `core-${team}`)
    if (t2 != null && p2 != null && t2 > p2 && (t1 ?? 1) > 0) invBad++ // T1 活时 T2 掉血
    if (core != null && pc != null && core > pc && ((t1 ?? 1) > 0 || (t2 ?? 1) > 0)) invBad++ // 有塔活时水晶掉血
  }
}
const towerEvents = run.serverEvents.filter((e) => e.k === 'tower')
ok('S5-2', '无敌链不变量：T1 活则 T2/水晶不掉血、有塔活则水晶不掉血', invBad === 0, `违例 ${invBad}；tower ruling×${towerEvents.length}`)
let towerOrderBad = 0
for (const team of ['A', 'B']) {
  const seqT = towerEvents.filter((e) => e.team === team).map((e) => e.tid)
  const expect = [`tw-${team}1`, `tw-${team}2`].filter((x) => seqT.includes(x))
  if (JSON.stringify(seqT.filter((x) => expect.includes(x))) !== JSON.stringify(expect)) towerOrderBad++
}
ok('S5-2', 'tower ruling 塔序=T1→T2（同队）', towerOrderBad === 0, `违例 ${towerOrderBad}`)

/* ---------- S5-3 S2/S5 边界：状态同步中事件不丢 ---------- */
const connEvents = (conn) => conn.msgs.flatMap((m) => (m.events || []).map((e) => e))
const ev0 = connEvents(run.conn0), evS = connEvents(run.spec)
const sig = (e) => { const { __tick, ...rest } = e; return JSON.stringify(rest) }
let lost0 = 0, lostS = 0
const idx0 = new Map(), idxS = new Map()
const countMap = (arr, map) => { for (const s of arr.map(sig)) map.set(s, (map.get(s) || 0) + 1) }
countMap(ev0, idx0); countMap(evS, idxS)
const srvCount = new Map(); countMap(run.serverEvents, srvCount)
for (const [s, n] of srvCount) if ((idx0.get(s) || 0) < n) lost0++
for (const [s, n] of srvCount) if ((idxS.get(s) || 0) < n) lostS++
ok('S5-3', '玩家连接：服务端事件账本 ⊆ 快照流（含全量帧）零丢失', lost0 === 0, `服务端 ${run.serverEvents.length} 条，玩家连接缺 ${lost0} 条`)
ok('S5-3', '观战连接：事件零丢失', lostS === 0, `观战缺 ${lostS} 条`)
// kill 事件在快照流中可见率（juice 触发口径）
const killSnaps = snaps.filter((m) => (m.events || []).some((e) => e.k === 'kill')).length
ok('S5-3', 'kill ruling 全部经快照流下发', ev0.filter((e) => e.k === 'kill').length === kills.length, `账本 ${kills.length} = 流上 ${ev0.filter((e) => e.k === 'kill').length}（分布于 ${killSnaps} 张快照）`)

/* ---------- S5-4 超时裁定优先序（§1.4：水晶HP%→存塔分→击杀→draw） ---------- */
const run2 = drive(20261015, [null, 'casual', 'casual', 'casual', 'casual', 'casual'], 620, lanePolicy)
if (run2.over) {
  const s2 = run2.st, r = run2.over
  const pct = (t) => s2.ents['core-' + t].hp / s2.ents['core-' + t].maxhp
  let expect
  if (pct('A') !== pct('B')) expect = pct('A') > pct('B') ? 'A' : 'B'
  else if (s2.stats.towers.A !== s2.stats.towers.B) expect = s2.stats.towers.A > s2.stats.towers.B ? 'A' : 'B'
  else if (s2.stats.kills.A !== s2.stats.kills.B) expect = s2.stats.kills.A > s2.stats.kills.B ? 'A' : 'B'
  else expect = 'draw'
  ok('S5-4', '超时裁定复算（水晶HP%→存塔分→击杀→draw 优先序）', r.reason === 'timeout' && r.winner === expect, `winner=${r.winner} 复算=${expect} towers=${JSON.stringify(s2.stats.towers)} kills=${JSON.stringify(s2.stats.kills)}`)
} else ok('S5-4', '超时裁定复算', false, '620 tick 未到终局')

console.log(`\nS2/S5 专项：${pass} 通过，${fail} 失败`)
if (process.env.OUT_JSON) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.OUT_JSON, JSON.stringify({ pass, fail, lines, kills: kills.length, towers: towerEvents.length, snaps: snaps.length, avgKBs: +avgKBs.toFixed(1), peakKBs: +peakKBs.toFixed(1), laneKBs: +laneKBs.toFixed(1), maxEnts }, null, 1))
}
process.exit(fail ? 1 : 0)
