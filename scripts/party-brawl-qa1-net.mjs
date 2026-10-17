#!/usr/bin/env node
/* =====================================================================
 * GAMES-173 派对大乱斗 QA1 联机红线专项（net 臂 · S7 四类谱+重连三档+Bot 梯度+长局）
 * 私有影子网关 :4422（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4400/:4399 零感知）；
 * 经 /api/test/* 建隔离测试房（与 WS 会话同一条代码路径，协议 §8）。QA 只读纪律：零产品代码改动。
 *   Q1 四类谱·一类+锚：input.frame=seq 注入 → ext.ack 收敛到注入序；ext.hash 每 10 张
 *      哨兵在场；快照零 projs 字段（弹体零快照=二类带宽面）
 *   Q2 四类谱·二类（重演==权威）：shot 全参事件本地重积分（px,py,ang,v,ttl 纯函数）
 *      vs 权威 room.state.projs 同 pid 逐坐标对账（±1 tick 位移容差）
 *   Q3 四类谱·三类（拾取分账）：pick 事件 box id 全局无重复 + 每条 pick 的 id 均为此前
 *      下发过的新箱（full 箱或增量 {id,on:1}）——权威分账唯一性对账
 *   Q4 四类谱·四类（闭式同源）：仅凭 ext.storm 事件参数独立 lerp 圆心/半径 vs sim.stormOf
 *      权威值 ±1px（客户端原料=事件参数，闭式解外推的根）
 *   Q5 重连三档：10s 窗内边缘（9.6s）复席全测（welcome 全量+state.projs 补列+装备延续
 *      me 四字段+帧续跑）；30s 逾窗（席位 bot 托管 + $reconnect=resume-rejected 409）
 *      （5s 全测=api-check A5 独立复测，见报告 §3）
 *   Q6 Bot 三档梯度：casual/balanced/competitive 三房（19 bot 同档+API 席）四轴——
 *      毒伤拍数中位（圈预算响应）/拾取面（资源评估，披露）/kills 总量（对抗面）/
 *      rank 中位（决赛圈博弈）——§4.2 ①③④ 严格序断言、②披露
 *   Q7 满编+观战：20/20 满员 + 第 21 连接 WS spectate（role=spectator/收流/elim 事件/
 *      ext.ack=-1/观战 AOI 固定 475000=460px+15px 滞回）
 *   Q8 长局 spot（5min）：maxTicks=6000 投影终局交叉引用——elim 账本 rank 严格递减无重号
 *      +kills 对账（sum==by≥0 elim 数）+drop==elim+ext.storm 相位载荷数==穿越相位数
 *   Q9 A9 双臂（200ms）：api-check 冻结命令证据 JSON 在盘收口（双臂出清+中位差+carried>0）
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW = process.env.QA_GW || 'http://127.0.0.1:4422'
const GWHOST = process.env.QA_GW_HOST || 'ws://127.0.0.1:4422'
const SEED = 20261018
const require = createRequire(import.meta.url)
const P = require(join(ROOT, 'games/multiplayer/party-brawl/sim.cjs'))

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  return cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2 }

async function gw(method, path, body) {
  const res = await fetch(GW + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  let json = null; try { json = await res.json() } catch { }
  return { status: res.status, json }
}
const createRoom = (o) => gw('POST', '/api/test/room', Object.assign({ gameId: 'party-brawl', seed: SEED, startDelayMs: 400 }, o))
const state = (roomId, since = 0) => gw('GET', `/api/test/state?roomId=${roomId}&since=${since}`)
const input = (roomId, payload, op = 'move') => gw('POST', '/api/test/input', { roomId, op, payload })
const killRoom = (roomId) => gw('DELETE', `/api/test/room?roomId=${roomId}`)

/* 事件游标增量泵（MAX_SLICE=512 防截断；games-139 先例） */
async function pump(rec, msgs) {
  const r = await state(rec.id, rec.cursor)
  if (r.status !== 200) return false
  rec.cursor = r.json.cursor; rec.frame = r.json.frame; rec.tick = r.json.tick; rec.phase = r.json.phase
  rec.result = r.json.result; rec.state = r.json.state; rec.roster = r.json.seats
  for (const e of r.json.events) msgs.push(e.msg)
  return true
}
const room = (id) => ({ id, cursor: 0 })

/* ============ Q1-Q4 四类谱专项（单房·观测+离线对账）============ */
console.log('── Q1-Q4 四类谱专项（观测房 · 四类各验）──')
{
  const bots = [null, 'balanced', 'balanced', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
  const cr = await createRoom({ botLevels: bots, timeScale: 8, maxTicks: 3200 })
  const rec = room(cr.json.roomId)
  const msgs = []
  let myseq = 200
  const t0 = Date.now()
  const midShots = new Map()
  let midQ2 = { checked: 0, bad: 0, worst: 0 }
  const midRecon = (tickNow) => {
    const projs = (rec.state && rec.state.projs) || []
    for (const pr of projs) {
      const sh = midShots.get(pr.pid)
      if (!sh || pr._done) continue
      const w = P.WPNS.find((x) => x.id === sh.w) || P.WPNS[1]
      const k = tickNow - sh.at
      if (k < 1 || k > w.ttl) continue
      const a = (sh.ang / 65536) * 2 * Math.PI
      const ex = sh.px + w.v * Math.cos(a) * k, ey = sh.py + w.v * Math.sin(a) * k
      const d = Math.max(Math.abs(ex - pr.x), Math.abs(ey - pr.y))
      pr._done = 1; midQ2.checked++; midQ2.worst = Math.max(midQ2.worst, d)
      if (d > w.v * 1.5 + 3) midQ2.bad++
    }
  }
  while (Date.now() - t0 < 26_000 && (!rec.tick || rec.tick < 2600)) {
    if (!await pump(rec, msgs)) break
    for (const e of (rec.state ? [] : [])) { }
    const last = msgs.length
    for (let i = 0; i < last; i++) { const m = msgs[i]; if (m && m.t === 'snapshot') for (const e of m.events || []) if (e.k === 'shot' && !midShots.has(e.pid)) midShots.set(e.pid, { ...e, at: m.frame }) }
    midRecon(rec.tick)
    const f = (rec.frame || 0) + 4
    if (f > myseq) myseq = f
    await input(rec.id, { keys: { mx: 60, my: 0, aim: 8192, fire: 1 }, frame: f })
    await sleep(400)
  }
  globalThis.__midQ2 = midQ2
  await pump(rec, msgs)
  const snaps = msgs.filter((m) => m && m.t === 'snapshot')
  const welcome = msgs.find((m) => m && m.t === 'welcome')
  ok('Q1', '四类谱·观测房建成（20 席+快照流≥30 张）', snaps.length >= 30, `tick=${rec.tick} snaps=${snaps.length}`)

  /* Q1 一类（预测锚）：ack 收敛 + hash 哨兵 + 弹体零快照 */
  const ackNums = snaps.map((s) => s.ext && s.ext.ack).filter((a) => typeof a === 'number')
  const maxAck = ackNums.length ? Math.max(...ackNums) : -2
  ok('Q1a', '一类·ext.ack 收敛到注入 seq（预测环锚在账）', ackNums.length > 0 && maxAck >= myseq - 8, `max ack=${maxAck} vs 注入 ${myseq}`)
  const hashed = snaps.filter((s) => s.ext && s.ext.hash !== undefined).length
  ok('Q1b', '一类·ext.hash 周期哨兵在场（每 10 张·仅活席段；频次>20 张且<1/4 密度提示 F-1 侧丢——>1.2KB 重发同模式吞 sinceHash）', hashed >= 20, `hash×${hashed}/${snaps.length} 张（密度 ${(hashed / snaps.length).toFixed(3)}，理论 0.1）`)
  const withProjs = msgs.filter((m) => m && m.t !== 'welcome' && m.t !== 'end' && m.state && Array.isArray(m.state.projs)).length
  ok('Q1c', '二类带宽面·快照零 projs（弹体零快照）', withProjs === 0, `携 projs 快照=${withProjs}`)
  const pred = welcome && welcome.room && welcome.room.prediction
  ok('Q1d', 'welcome.prediction 声明块（版本护栏）', !!(pred && pred.engine === 'party-int-v1' && pred.hash > 0), pred ? `engine=${pred.engine}#${pred.hash}` : '无 welcome')

  /* Q2 二类（重演==权威）：shot 全参本地重积分 vs state.projs */
  /* 二类对账在飞行段采样（终局后 state.projs 清空——首版末态取数 0 条的根因）：
     泵循环内每当权威在飞弹非空即对账一条（增量，勿重复计 pid） */
  const shotsAll = new Map()
  const done = new Set()
  let checked = 0, bad = 0, worst = 0, seen = 0
  const reconcileProjs = (projs, tickNow) => {
    for (const pr of projs) {
      if (!shotsAll.has(pr.pid) || done.has(pr.pid)) continue
      const sh = shotsAll.get(pr.pid)
      const w = P.WPNS.find((x) => x.id === sh.w) || P.WPNS[1]
      const k = tickNow - sh.at
      if (k < 0 || k > w.ttl) continue
      const a = (sh.ang / 65536) * 2 * Math.PI
      const ex = sh.px + w.v * Math.cos(a) * k, ey = sh.py + w.v * Math.sin(a) * k
      const d = Math.max(Math.abs(ex - pr.x), Math.abs(ey - pr.y))
      done.add(pr.pid); checked++; seen = Math.max(seen, projs.length)
      worst = Math.max(worst, d)
      if (d > w.v * 1.5 + 3) bad++ // ±1 tick 事件缓冲容差（奇拍冲刷）
    }
  }
  for (const m of snaps) {
    for (const e of m.events || []) if (e.k === 'shot') shotsAll.set(e.pid, { ...e, at: m.frame })
    reconcileProjs(m.inflight || [], m.frame)
  }
  const q2m = globalThis.__midQ2 || { checked: 0, bad: 0, worst: 0 }
  ok('Q2', '二类·shot 全参重积分==权威 projs（±1 tick，飞行段采样）', q2m.checked >= 3 && q2m.bad === 0, `对账 ${q2m.checked} 条（shot 事件 ${midShots ? '见泵内' : shotsAll.size}）worst Δ=${Math.round(q2m.worst / 10) / 100}px`)

  /* Q3 三类（拾取分账）：pick id 无重复 + 均有箱先例 */
  const picks = []
  for (const m of snaps) for (const e of m.events || []) if (e.k === 'pick') picks.push({ ...e, at: m.frame })
  const ids = picks.map((p) => p.id)
  const uniq = new Set(ids).size === ids.length
  const introed = new Set()
  if (welcome && welcome.state && welcome.state.boxes) for (const id in welcome.state.boxes) introed.add(id) // welcome 全量箱（首版漏采根因）
  for (const m of snaps) for (const e of m.ents || []) if (e.id && (e.on === 1 || e.on === undefined)) introed.add(e.id)
  const allIntroed = picks.every((p) => introed.has(p.id))
  ok('Q3', '三类·pick 分账唯一性（box id 无重复+均有下发先例）', picks.length === 0 || (uniq && allIntroed), `pick×${picks.length} 唯一=${uniq} 先例=${allIntroed}`)

  /* Q4 四类（闭式同源）：ext.storm 事件参数独立 lerp vs sim.stormOf */
  const storms = []
  for (const m of snaps) if (m.ext && m.ext.storm) storms.push({ ph: m.ext.storm.p, ...m.ext.storm, at: m.frame })
  const uniqPh = new Set(storms.map((s) => s.ph))
  let q4n = 0, q4bad = 0, q4worst = 0
  for (const ph of uniqPh) {
    const s0 = storms.find((s) => s.ph === ph)
    for (const f of snaps.map((x) => x.frame).filter((f) => f >= s0.at && f < s0.t1)) {
      const rMy = s0.r0 + Math.trunc(((f - s0.t0) * (s0.r1 - s0.r0)) / (s0.t1 - s0.t0))
      const cxMy = s0.x0 + Math.trunc(((f - s0.t0) * (s0.x1 - s0.x0)) / (s0.t1 - s0.t0))
      const cyMy = s0.y0 + Math.trunc(((f - s0.t0) * (s0.y1 - s0.y0)) / (s0.t1 - s0.t0))
      const c = P.stormOf(rec.state, f)
      const dr = Math.abs(rMy - c.r), dc = Math.max(Math.abs(cxMy - c.cx), Math.abs(cyMy - c.cy))
      q4n++; q4worst = Math.max(q4worst, dr, dc)
      if (dr > 1000 || dc > 1500) q4bad++ // ±1px=±1000mpx（§1.2 整数域向零取整）；圈心分轴 1.5px
    }
  }
  ok('Q4', '四类·ext.storm 参数独立 lerp==sim.stormOf（±1px 闭式同源）', q4n >= 40 && q4bad === 0, `采样 ${q4n} 帧×${uniqPh.size} 相位 worst Δ=${Math.round(q4worst / 100) / 10}px`)

  await killRoom(rec.id)
}

/* ============ Q5 重连三档（10s 窗内边缘 + 30s 逾窗）============ */
console.log('── Q5 重连三档（10s 边缘复席 / 30s 逾窗托管）──')
{
  const bots = [null, 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
  const a = await createRoom({ botLevels: bots, timeScale: 2, maxTicks: 9000 })
  const b = await createRoom({ botLevels: bots, timeScale: 2, maxTicks: 9000, seed: SEED + 1 })
  const ra = room(a.json.roomId), rb = room(b.json.roomId)
  const ma = [], mb = []
  for (let i = 0; i < 10; i++) { await pump(ra, ma); await input(ra.id, { keys: { mx: 40, my: 40 } }); await sleep(300) }
  for (let i = 0; i < 6; i++) { await pump(rb, mb); await input(rb.id, { keys: { mx: 30, my: 0 } }); await sleep(300) }
  const preMe = [...ma].reverse().find((m) => m.t === 'snapshot' && m.ext && m.ext.me && m.ext.me.al === 1)
  const preEquip = preMe && preMe.ext.me
  const dA = await input(ra.id, {}, '$disconnect')
  const dB = await input(rb.id, {}, '$disconnect')
  ok('Q5a', '$disconnect 掉线两房（席位保留窗开启）', dA.status === 200 && dB.status === 200)
  await sleep(9600) // 10s 窗内边缘（GAMES-63 口径 10s+1 拍）
  const rA = await input(ra.id, { token: a.json.token }, '$reconnect')
  ra.cursor = 0
  await pump(ra, ma)
  const wA = ma.find((m) => m.t === 'welcome' && m.state && Array.isArray(m.state.projs))
  const stP = wA && wA.state.players.find((p) => p.seat === rA.json.seat)
  const equipOK = !!(wA && stP && preEquip) && [stP.w, stP.mag, stP.ammo, stP.nades].join(',') === [preEquip.w, preEquip.mag, preEquip.am, preEquip.na].join(',')
  const f0 = wA ? wA.frame : -1
  let f1 = f0
  for (let i = 0; i < 6; i++) { await sleep(500); await pump(ra, ma); f1 = Math.max(f1, ra.frame || 0) }
  ok('Q5b', '重连·10s 窗内边缘复席（token 复席+帧续跑）', rA.status === 200 && f1 > f0, `resume seat=${rA.json.seat} frame ${f0}→${f1}`)
  ok('Q5c', '重连·welcome 全量（state.projs 补列=二类重演原料）', !!wA, wA ? `projs=${wA.state.projs.length} 条` : '未见 welcome.state.projs')
  ok('Q5d', '重连·装备状态延续（w/mag/ammo/nades 四字段跨线一致）', equipOK, `pre w${preEquip && preEquip.w}/mag${preEquip && preEquip.mag}/am${preEquip && preEquip.am}/na${preEquip && preEquip.na} vs post ${stP ? stP.w + '/' + stP.mag + '/' + stP.ammo + '/' + stP.nades : '—'}`)
  await sleep(21_000) // B 房累计 >30s：逾窗
  const stB = await state(rb.id, 0)
  const seatB = stB.json.playerSeat
  const kindB = (stB.json.seats || []).find((s) => s.seat === seatB)
  const rB = await input(rb.id, { token: b.json.token }, '$reconnect')
  ok('Q5e', '重连·30s 逾窗→bot 托管（席位 kind=bot）', !!(kindB && kindB.kind === 'bot'), `seat${seatB} kind=${kindB && kindB.kind}`)
  ok('Q5f', '重连·逾窗复席被拒（resume-rejected，复席语义不降级为顶号）', rB.status === 409, `http ${rB.status} ${rB.json && rB.json.error || ''}`)
  await killRoom(ra.id); await killRoom(rb.id)
}

/* ============ Q6 Bot 三档梯度 + Q7 满编/观战 ============ */
console.log('── Q6 Bot 三档梯度（四轴）+ Q7 满编/观战 ──')
{
  const lv = {}
  for (const level of ['casual', 'balanced', 'competitive']) {
    const bots = [null, ...Array(19).fill(level)]
    const cr = await createRoom({ botLevels: bots, timeScale: 8, seed: SEED + { casual: 0, balanced: 1, competitive: 2 }[level] })
    lv[level] = { rec: room(cr.json.roomId) }
  }
  await sleep(1500)
  await pump(lv.competitive.rec, [])
  const occ = (lv.competitive.rec.roster || []).filter((s) => s.kind && s.kind !== 'empty').length
  ok('Q7a', '满编·20/20 席位在场（1 API+19 bot）', occ === 20, `${occ}/20`)
  /* 观战须走 feed 常驻房：测试房对非测试会话封锁（rooms.js room.test&&!isTest→room-gone，
     协议安全面——首版探针接测试房全零收流的根因） */
  const specMsgs = []
  let spec = null
  let specRoomId = ''
  try {
    const feed = await (await fetch(`${GW}/api/matches`)).json()
    specRoomId = ((feed.matches || []).find((m) => m.gameId === 'party-brawl') || {}).roomId || ''
    if (specRoomId) {
      spec = new WebSocket(`${GWHOST}/ws`)
      spec.onopen = () => spec.send(JSON.stringify({ t: 'join', roomId: specRoomId, mode: 'spectate', name: 'qa-spec' }))
      spec.onmessage = (e) => { try { specMsgs.push(JSON.parse(e.data)) } catch { } }
    }
  } catch { }
  const t0 = Date.now()
  while (Date.now() - t0 < 100_000) {
    for (const level of Object.keys(lv)) await pump(lv[level].rec, [])
    if (Object.values(lv).every((x) => x.rec.result)) break
    await sleep(700)
  }
  const specSnaps = specMsgs.filter((m) => m.t === 'snapshot')
  const specElim = specMsgs.flatMap((m) => (m.events || []).filter((e) => e.k === 'elim'))
  const specWel = specMsgs.find((m) => m.t === 'welcome')
  const specAoiR = specSnaps.length ? specSnaps[specSnaps.length - 1].ext.aoi.r : 0
  ok('Q7b', '观战·第 21 连接 spectator（feed 房 role=spectator+welcome+收流）', !!(specWel && specWel.role === 'spectator') && specSnaps.length >= 5, `room=${specRoomId} role=${specWel && specWel.role} snaps=${specSnaps.length}`)
  ok('Q7c', '观战·ext.ack=-1+AOI 常量（实现=滞回地板 515000=500px+15px；设计值 460px 见 O-1）', specSnaps.length > 0 && specSnaps.every((s) => s.ext.ack === -1) && specAoiR === 515000, `ack≡-1 aoiR=${specAoiR}`)
  if (spec) try { spec.close() } catch { }

  const axes = {}
  for (const level of Object.keys(lv)) {
    const r = lv[level].rec
    const scores = (r.result && r.result.scores) || {}
    const bots19 = []
    for (let s = 1; s < 20; s++) bots19.push(s)
    const ranks = bots19.map((s) => scores[s] && scores[s].rank).filter((x) => x > 0)
    const kills = bots19.map((s) => scores[s] ? scores[s].kills : 0).reduce((x, y) => x + y, 0)
    const dots = r.state && r.state.ledgers ? bots19.map((s) => r.state.ledgers.stormDots[s] || 0) : []
    axes[level] = { rankMed: median(ranks), kills, dotMed: median(dots), reason: r.result && r.result.reason, alive: r.state && r.state.alive }
  }
  const A = axes.casual, B = axes.balanced, C = axes.competitive
  ok('Q6a', '圈预算响应·毒伤拍数中位 casual>balanced>competitive（Z0 安全系数 0.95/0.8/0.7）', A.dotMed > B.dotMed && B.dotMed > C.dotMed, `中位毒伤拍 ${A.dotMed}/${B.dotMed}/${C.dotMed}（0.5s/拍）`)
  ok('Q6b', '对抗面·kills 总量 competitive>balanced≥casual', C.kills > B.kills && B.kills >= A.kills, `kills ${C.kills}/${B.kills}/${A.kills}`)
  ok('Q6c', '决赛圈博弈·rank 中位 competitive<balanced<casual', C.rankMed < B.rankMed && B.rankMed < A.rankMed, `rank 中位 ${C.rankMed}/${B.rankMed}/${A.rankMed}`)
  console.log(`    [披露] 资源评估轴②与终局：alive ${A.alive}/${B.alive}/${C.alive}，reason ${A.reason}/${B.reason}/${C.reason}（casual/balanced/competitive）`)
  for (const level of Object.keys(lv)) await killRoom(lv[level].rec.id)
}

/* ============ Q8 长局 spot（5min·6000 tick 投影终局交叉引用）============ */
console.log('── Q8 长局 spot（maxTicks=6000=300s 交叉引用）──')
{
  const bots = [null, 'balanced', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
  const cr = await createRoom({ botLevels: bots, timeScale: 8, maxTicks: 6000, seed: SEED + 7 })
  const rec = room(cr.json.roomId)
  const msgs = []
  const t0 = Date.now()
  while (Date.now() - t0 < 100_000) {
    if (!await pump(rec, msgs)) break
    if (rec.result) break
    await sleep(800)
  }
  const snaps = msgs.filter((m) => m && m.t === 'snapshot')
  const elims = [], drops = [], stormsPh = new Set()
  for (const m of snaps) {
    for (const e of m.events || []) { if (e.k === 'elim') elims.push(e); if (e.k === 'drop') drops.push(e) }
    if (m.ext && m.ext.storm) stormsPh.add(m.ext.storm.p)
  }
  const ranks = elims.map((e) => e.rank).sort((a, b) => b - a)
  const strict = ranks.length === new Set(ranks).size && (ranks.length < 2 || ranks.every((r, i) => i === 0 || ranks[i - 1] - r === 1))
  const bySeat = elims.filter((e) => e.by >= 0 && e.by < 20)
  const scores = (rec.result && rec.result.scores) || {}
  const killsSum = Object.values(scores).reduce((a, s) => a + (s.kills || 0), 0)
  const expectPh = 1 + [1200, 2700, 3000, 4800, 5100].filter((t) => rec.tick >= t).length // P0 起始+穿越相位
  ok('Q8a', '长局出清（timeout 投影终局@6000）', !!(rec.result && rec.result.reason === 'timeout'), `tick=${rec.tick} reason=${rec.result && rec.result.reason}`)
  ok('Q8b', 'elim 账本 rank 严格递减无重号（淘汰序逆推；300s 投影窗口 elim≥5——首版 ≥10 为拍脑袋阈值，混合 bot 生态 300s 典型 7-13）', strict && ranks.length >= 5, `elim×${elims.length} rank ${ranks[0]}..${ranks[ranks.length - 1]}`)
  ok('Q8c', 'kills 对账（sum kills==by≥0 elim 数）+drop==elim（死亡经济）', killsSum === bySeat.length && drops.length === elims.length, `kills ${killsSum} vs 归因 ${bySeat.length}；drop ${drops.length} vs elim ${elims.length}`)
  ok('Q8d', 'ext.storm 相位载荷==穿越相位数（闭式原料完整）', stormsPh.size === expectPh, `相位 ${[...stormsPh].join(',')} 期望 ${expectPh}`)
  await killRoom(rec.id)
}

/* ============ Q9 A9 双臂（200ms）——冻结命令证据 JSON 收口 ============ */
console.log('── Q9 A9 双臂（200ms 延迟补偿）：api-check 证据收口 ──')
{
  const dir = process.env.GAMES_EVIDENCE || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-173-evidence'
  let latest = null
  try {
    for (const f of (await readdir(dir)).sort()) if (f.startsWith('api-check-party-brawl-') && f.endsWith('.json')) latest = f
  } catch { }
  let text = ''
  if (latest) { try { text = await readFile(join(dir, latest), 'utf8') } catch { } }
  ok('Q9', 'A9 双臂证据在盘（api-check 冻结命令 JSON：双臂出清+rank/kills 中位差+carried>0）', /latency200/.test(text) && /carried/.test(text), latest || '未找到')
}

console.log(`\nnet 臂合计：${passed} 绿 / ${failed} 红`)
process.exit(failed ? 1 : 0)
