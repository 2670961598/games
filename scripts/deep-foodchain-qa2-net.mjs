#!/usr/bin/env node
/* =====================================================================
 * GAMES-168 深海食物链 QA2 全链红线专项（net 臂 · FIX1 跳过/BOT/FEEL 上线后复验）
 * 私有影子网关 :4424（:4399/:4400 零感知）；剧本房一律 /api/test/* 隔离测试房。
 *   D1 deterministic 三等：同 seed 三房零输入并行跑 → 逐 tick 指纹（fnv1a32）交集比对
 *   R1 重连三档复验：5s 全测/9.3s 窗内/31s 逾窗夺回——体型(tier)/质量(M)/kills/score 延续
 *   H1 托管（AFK 60s）：冻结输入→afk.t≥600 casual 代打（自转+觅食）→输入夺回
 *   W1 放水链在线复证：真人席连败(deaths≥2,kills==0)→bot 降问台账 md++/让力失误 bl++
 *      （comp/bal 台账——casual 自带 blunder 不入判据）
 *   W2 AFK 收窄边界：同席冻结输入托管后（deaths 仍累积）→ md/bl 停增（唯一门差=afk.t≥600）
 *   L1 长局 spot 8min：round rollover×2/crown×2+A8 残差+活鱼下界+O-1 重生窗恢复时延
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { createRequire } from 'node:module'
import { writeFile, mkdir } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/deep-foodchain/sim.cjs')
const P = require('../games/multiplayer/deep-foodchain/shared.cjs')

const GW = process.env.QA_GW || 'http://127.0.0.1:4424'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-168'
const SEED = 20261018

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  return !!cond
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const evidence = {}

async function gw(method, path, body) {
  const res = await fetch(GW + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  let json = null; try { json = await res.json() } catch { }
  return { status: res.status, json }
}
const createRoom = (o) => gw('POST', '/api/test/room', Object.assign({ gameId: 'deep-foodchain', seed: SEED, startDelayMs: 300 }, o))
const input = (roomId, seat, op, payload) => gw('POST', '/api/test/input', { roomId, seat, op, payload })
const killRoom = (roomId) => gw('DELETE', `/api/test/room?roomId=${roomId}`)

function makeRoom(tag, resp) {
  const R = { tag, id: resp.roomId, seat: resp.playerSeat, token: resp.token, cur: 0, welcomes: [], evs: [], last: null }
  R.pull = async () => {
    const r = await gw('GET', `/api/test/state?roomId=${R.id}&since=${R.cur}`)
    if (!(r.json && r.json.ok)) return r.json
    R.cur = r.json.cursor; R.last = r.json
    for (const e of (r.json.events || [])) {
      const m = e.msg || {}
      if (m.t === 'welcome') R.welcomes.push(m)
      if (m.events) for (const ev of m.events) R.evs.push(ev)
    }
    return r.json
  }
  return R
}
const stOf = (R) => R.last && R.last.state
const liveFish = (st) => Object.values(st.ents).filter((e) => e.k === 'fish' && !e.dead)
const massResidual = (st) => {
  let sumM = 0, sumDots = 0
  for (const id in st.ents) { const e = st.ents[id]; if (e.k === 'fish' && !e.dead) sumM += e.M; else if (e.k === 'drop') sumDots += e.v }
  const L = st.ledger
  return sumM + sumDots + L.expired - L.endow - L.ate - L.gained - L.dropped + L.dashed
}
/* 确定性指纹：全 state 投影（剔 name=席位名随房随机）fnv1a32 */
const fpOf = (st) => {
  const proj = (e) => { const c = Object.assign({}, e); delete c.name; return c }
  const ents = Object.keys(st.ents).sort().map((id) => [id, proj(st.ents[id])])
  return S.fnv1a32(JSON.stringify([st.tick, st.round, st.ledger, st.stats, st.afk, st.bloom, ents]))
}

const MIX20 = [null, 'competitive', 'competitive', 'competitive', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
const LV = { 1: 'comp', 2: 'comp', 3: 'comp', 4: 'bal', 5: 'bal', 6: 'bal', 7: 'bal', 8: 'bal', 9: 'bal', 10: 'cas', 11: 'cas', 12: 'cas', 13: 'cas', 14: 'cas', 15: 'cas', 16: 'cas', 17: 'cas', 18: 'cas', 19: 'cas' }
/* md/bl 台账聚合：仅 comp/bal（casual 自带 per.blunder=0.12 污染 bl；md 需 hunt>0）。
 * 台账随死亡重生清零（respawn 重建 mem）→ 逐席取历史最大值=单调估计。 */
const mercyLedger = (st) => {
  let md = 0, bl = 0, casBl = 0
  for (const e of Object.values(st.ents)) {
    if (e.k !== 'fish' || e.dead) continue
    const lv = LV[e.seat]; if (!lv) continue
    const ch = e.mem && e.mem.ch; if (!ch) continue
    if (lv === 'cas') casBl = Math.max(casBl, ch.bl || 0)
    else { md += ch.md || 0; bl += ch.bl || 0 }
  }
  return { md, bl, casBl }
}

/* ============ L1 长局 spot 8min（先起后台，采样与其余段并行）============ */
console.log('── L1 长局 spot 8min（后台起房，末段收口；ts2→9600 tick 跨 2 轮界）──')
const LR = makeRoom('long', (await createRoom({ timeScale: 2, botLevels: MIX20 })).json)
const longSamples = []
let longDone = false
const recovs = [] // O-1：live<20 检出后 300ms 细粒度探针测恢复时延
;(async () => {
  await sleep(1500)
  const t0 = Date.now()
  while (Date.now() - t0 < 480000 && !longDone) {
    await LR.pull().catch(() => { })
    const st = stOf(LR)
    if (st) {
      const lf = liveFish(st)
      const lb = st.leaderboard || []
      const lbOk = lb.length <= 10 && lb.every((x, i) => i === 0 || lb[i - 1].score >= x.score)
        && lf.every((f) => lb.length === 0 || f.score <= lb[0].score)
      longSamples.push({ tick: st.tick, round: st.round.n, live: lf.length, resid: massResidual(st), lbOk, devours: st.stats.devours })
      if (lf.length < 20 && recovs.length < 6) { // O-1 恢复时延细测
        const t1 = Date.now()
        for (let i = 0; i < 18; i++) {
          await LR.pull().catch(() => { })
          const s2 = stOf(LR)
          if (s2 && liveFish(s2).length >= 20) { recovs.push(Date.now() - t1); break }
          await sleep(300)
        }
      }
    }
    await sleep(10000)
  }
  longDone = true
})()

/* ============ D1 deterministic 三等（三房并行零输入 → 指纹交集比对）============ */
console.log('── D1 deterministic 三等（同 seed 三房，ts4 零输入跑 2500 tick）──')
{
  const rooms = []
  for (let i = 0; i < 3; i++) rooms.push(makeRoom('det' + i, (await createRoom({ timeScale: 4, botLevels: MIX20 })).json))
  const series = rooms.map(() => new Map())
  const t0 = Date.now()
  let done = false
  ;(async () => { // 后台采样器：tick≥1900 起逐 40ms 记 (tick,fp)
    await sleep(46000)
    while (!done && Date.now() - t0 < 150000) {
      for (let i = 0; i < 3; i++) {
        await rooms[i].pull().catch(() => { })
        const st = stOf(rooms[i])
        if (st && st.tick >= 1900) series[i].set(st.tick, fpOf(st))
      }
      if ([0, 1, 2].every((i) => { const ks = [...series[i].keys()]; return ks.length && Math.max(...ks) >= 2500 })) break
      await sleep(40)
    }
    done = true
  })()
  /* 前景先跑 W/R 段，末尾收口 D1（见文末） */
  globalThis.__det = { rooms, series, waitDone: async () => { while (!done) await sleep(1000) } }
}

/* ============ W1/W2/H1 放水链在线+AFK 收窄+托管（同房三段，ts3）============ */
console.log('── W1 放水链在线复证（真人连败→bot 降问 md/让力 bl——决策级已证，在线链路复证）──')
{
  const R = makeRoom('mercy', (await createRoom({ timeScale: 3, botLevels: MIX20 })).json)
  const me = () => { const f = stOf(R) && stOf(R).ents['s' + R.seat]; return f }
  const aim = async (pick) => { // 非托管保持：每拍发目标角（sig 变化防 afk 计数）
    const st = stOf(R); if (!st) return
    const f = me(); if (!f) return
    const tgt = pick(st, f); if (!tgt) return
    const a = ((Math.atan2(tgt.y - f.y, tgt.x - f.x) / Math.PI * 180) % 360 + 360) % 360
    await input(R.id, R.seat, 'a', { a: Math.round(a), dash: 0 }).catch(() => { })
  }
  const minDistTo = (st, f, filt) => {
    let m = Infinity
    for (const e of Object.values(st.ents)) { if (e.k !== 'fish' || e.dead || !filt(e)) continue; m = Math.min(m, Math.hypot(e.x - f.x, e.y - f.y)) }
    return m
  }
  const hunter = (e) => LV[e.seat] === 'comp' || LV[e.seat] === 'bal'
  const big = (e) => e.M >= 60
  /* 段 0+1：先送两条命（追大鱼求被吞）→ L1 触发 → 贴近 comp/bal 测 md/bl */
  await sleep(1500); await R.pull()
  let baseMd = 0, phase1Md = 0, phase1Bl = 0, phase1Near = 0, phase1Samp = 0, deathsAtL1 = 0, t0 = Date.now()
  let l1 = false
  while (Date.now() - t0 < 150000 && !l1) { // W1 前段：求死（追最近大鱼）
    await aim((st, f) => { let b = null; for (const e of Object.values(st.ents)) { if (e.k === 'fish' && !e.dead && big(e) && hunter(e) && (!b || Math.hypot(e.x - f.x, e.y - f.y) < Math.hypot(b.x - f.x, b.y - f.y))) b = e } return b })
    await sleep(1000); await R.pull().catch(() => { })
    const f = me()
    if (f && f.deaths >= 2 && f.kills === 0) { l1 = true; deathsAtL1 = f.deaths }
  }
  const fL1 = me()
  ok('W1', '连败入靶在线可达（真人席 deaths≥2 且 kills==0 → L1 放水档；追大鱼送死自然达）', !!l1,
    l1 ? `deaths=${fL1.deaths} kills=${fL1.kills} M=${fL1.M}` : `150s 预算窗未达（deaths=${fL1 && fL1.deaths}）`)
  baseMd = mercyLedger(stOf(R)).md
  ok('W1', '入靶前降问台账为 0（md 仅放水路径递增——判据洁净度基线）', baseMd === 0, `Σmd=${baseMd}`)
  if (l1) {
    t0 = Date.now()
    while (Date.now() - t0 < 90000 && phase1Md === 0) { // W1 后段：贴近 comp/bal 猎手
      await aim((st, f) => { let b = null; for (const e of Object.values(st.ents)) { if (e.k === 'fish' && !e.dead && hunter(e) && (!b || Math.hypot(e.x - f.x, e.y - f.y) < Math.hypot(b.x - f.x, b.y - f.y))) b = e } return b })
      await sleep(1000); await R.pull().catch(() => { })
      const st = stOf(R), f = me(); if (!st || !f) continue
      const L = mercyLedger(st)
      phase1Md = Math.max(phase1Md, L.md); phase1Bl = Math.max(phase1Bl, L.bl)
      phase1Samp++
      if (minDistTo(st, f, hunter) <= 360000) phase1Near++
    }
    ok('W1', '降问在线触发（连败席入 360px 圈 → 猎手 Q2 整问停用，md 台账递增）', phase1Md > 0,
      `ΔΣmd=${phase1Md}（${phase1Samp} 采样 ×近距 ${phase1Near}）`)
    ok('W1', '让力失误在线在场（blunder ±70°+dash 熄灭 p=0.3/0.5——bl 台账 comp/bal）', phase1Bl > 0, `ΔΣbl=${phase1Bl}（概率面，决策级已证）`)
    evidence.w1 = { deathsAtL1, baseMd, phase1Md, phase1Bl, phase1Samp, phase1Near }

    /* ============ H1/W2：冻结输入 → 托管（afk.t≥600）→ md 停增（收窄）→ 夺回 ============ */
    console.log('── H1/W2 托管+AFK 收窄边界（同房：冻结输入→60s 托管→台账停增→夺回）──')
    const fFreeze = me()
    const freezeA = fFreeze && fFreeze.a, freezeM = fFreeze && fFreeze.M
    const mdAtFreeze = mercyLedger(stOf(R))
    let hosted = false, afkTSeen = 0, preTurns = 0
    t0 = Date.now()
    while (Date.now() - t0 < 60000 && !hosted) { // 前窗（t<600）：冻结期航向恒定（输入仍生效）
      await sleep(2000); await R.pull().catch(() => { })
      const st = stOf(R), f = me(); if (!st || !f) continue
      const at = st.afk && st.afk[R.seat]; if (at) afkTSeen = at.t
      if (Math.abs(((f.a - freezeA + 540) % 360) - 180) > 30) preTurns++
      if (at && at.t >= 600) hosted = true
    }
    const hostedTick = stOf(LR) && null
    ok('H1', '托管门=afk.t≥600（60s 输入签名不变——st.afk 簿记在线可读）', hosted, `afk.t=${afkTSeen}（ts3=20s 墙钟；冻结前窗自转 ${preTurns} 次=0 预期）`)
    let mdHost0 = -1, blHost0 = -1, hostNear = 0, hostSamp = 0, hostTurns = 0, hostEats = 0, hostDeaths0 = -1, hostKills = 0, hostM = []
    if (hosted) {
      const L0 = mercyLedger(stOf(R)); mdHost0 = L0.md; blHost0 = L0.bl
      hostDeaths0 = me().deaths; hostKills = me().kills
      const eatMark = R.evs.filter((e) => e.k === 'eat' && e.seat === R.seat).length
      t0 = Date.now(); const a0 = me().a; hostM.push(me().M)
      while (Date.now() - t0 < 60000) { // 托管窗 60s：casual 代打自转+觅食+台账观察
        await sleep(2000); await R.pull().catch(() => { })
        const st = stOf(R), f = me(); if (!st || !f) continue
        hostSamp++
        if (Math.abs(((f.a - a0 + 540) % 360) - 180) > 30) hostTurns++
        hostM.push(f.M)
        if (minDistTo(st, f, hunter) <= 360000) hostNear++
        const at = st.afk && st.afk[R.seat]; if (at) afkTSeen = Math.max(afkTSeen, at.t)
      }
      hostEats = R.evs.filter((e) => e.k === 'eat' && e.seat === R.seat).length - eatMark
    }
    const fHost = me()
    ok('H1', '托管代打生效（冻结输入下自转改航——非本人输入驱动鱼）', hosted && hostTurns >= 2,
      `托管窗自转 ${hostTurns} 次 vs 冻结前窗 ${preTurns} 次（冻结前航向恒 ${freezeA}°→${fHost && fHost.a.toFixed(0)}°）`)
    ok('H1', '托管期觅食在场（casual 代打顺路吃——「回来看战果」语义）', hostEats > 0,
      `eat×${hostEats} M 轨迹 ${freezeM}→${hostM.length ? hostM[hostM.length - 1] : '?'}（deaths ${hostDeaths0}→${fHost && fHost.deaths}）`)
    const dMd = phase1Md >= 0 ? mercyLedger(stOf(R)).md - Math.max(mdHost0, 0) : -1
    const dBl = mercyLedger(stOf(R)).bl - Math.max(blHost0, 0)
    ok('W2', 'AFK 收窄在线（托管席连败仍在案但 md/bl 停增——唯一门差=afk.t≥600）',
      hosted && dMd === 0 && dBl === 0 && hostNear >= 5,
      `托管窗 Δmd=${dMd} Δbl=${dBl}（×近距采样 ${hostNear}/${hostSamp}——非空转判据）`)
    /* 夺回：发新输入 → 航向跟随 */
    let recaptured = false, recMs = -1
    if (hosted) {
      const t2 = Date.now()
      await input(R.id, R.seat, 'a', { a: 200, dash: 0 }).catch(() => { })
      for (let i = 0; i < 16; i++) {
        await sleep(250); await R.pull().catch(() => { })
        const f = me()
        if (f && Math.abs(((f.a - 200 + 540) % 360) - 180) < 15) { recaptured = true; recMs = Date.now() - t2; break }
      }
    }
    ok('H1', '输入即夺回（新输入签名→afk 清零→航向 2s 内跟随）', recaptured, recMs >= 0 ? `${recMs}ms 收敛至 200°` : '2s 窗未跟随')
    evidence.h1w2 = { afkTSeen, preTurns, hostTurns, hostEats, hostNear, hostSamp, dMd, dBl, recaptured, recMs, hostDeaths: [hostDeaths0, fHost && fHost.deaths], hostKills, hostMtail: hostM.slice(-6) }
  }
  await killRoom(R.id).catch(() => { })
}

/* ============ R1 重连三档复验（体型/质量状态延续——QA1 同式+tier 一致性）============ */
console.log('── R1 重连三档复验（5s/9.3s/31s——tier/M/kills/score 延续）──')
{
  const R = makeRoom('rc', (await createRoom({ timeScale: 1, botLevels: MIX20 })).json)
  await sleep(1500); await R.pull()
  const snap = () => { const f = stOf(R).ents['s' + R.seat]; return f && { M: f.M, t: f.tier, k2: f.kills, d: f.deaths, skin: f.skin, sc: f.score } }
  const rec = async (label, waitMs) => {
    const before = snap()
    await input(R.id, R.seat, '$disconnect')
    await sleep(waitMs)
    await R.pull()
    const during = stOf(R).ents['s' + R.seat]
    const r = await input(R.id, R.seat, '$reconnect', { token: R.token })
    let wl = null
    for (let i = 0; i < 30 && !wl; i++) { await sleep(200); await R.pull(); wl = R.welcomes[R.welcomes.length - 1] }
    const after = snap()
    const stA = stOf(R)
    ok('R1', `${label}：重连复席（welcome+本人鱼在场）`, !!(r.json && r.json.ok && wl && after), `resume=${r.json && r.json.ok ? 'ok' : 'reject'} M ${before && before.M}→${after && after.M}`)
    if (before && after) {
      ok('R1', `${label}：体型/质量状态延续（tier 与 tierOf(M,前档) 滞回一致+kills 单调+score 口径恒成立）`,
        after.t >= 0 && after.t <= 3 && after.t === P.tierOf(after.M, before.t) && after.k2 >= before.k2 && after.sc === Math.floor(after.M / 4) + after.k2 * 40 && after.skin === before.skin,
        `tier ${before.t}→${after.t}（M ${before.M}→${after.M}）kills ${before.k2}→${after.k2} score ${before.sc}→${after.sc}`)
    }
    ok('R1', `${label}：断线期席位鱼恒活（世界不因掉线缺鱼）`, !!(during && !during.dead), `dead=${during && during.dead}`)
    ok('R1', `${label}：重连后账本一致（A8 残差 0）`, massResidual(stA) === 0, `resid=${massResidual(stA)}`)
  }
  await rec('5s 全测', 5000)
  await rec('9.3s 窗内边缘', 9300)
  await rec('31s 逾窗夺回', 31000)
  evidence.r1 = { tiers: 'per-tier in asserts' }
  await killRoom(R.id).catch(() => { })
}

/* ============ D1 收口 ============ */
console.log('── D1 收口（指纹交集比对）──')
{
  const { rooms, series, waitDone } = globalThis.__det
  await waitDone()
  const common = [...series[0].keys()].filter((t) => series[1].has(t) && series[2].has(t))
  let bad = 0
  for (const t of common) {
    const f0 = series[0].get(t)
    if (series[1].get(t) !== f0 || series[2].get(t) !== f0) bad++
  }
  ok('D1', 'deterministic 三等：同 seed 三房逐 tick 指纹全等（fnv1a32 全 state 投影——bots/托管/账本确定性）',
    common.length >= 30 && bad === 0, `交集 tick×${common.length}（各房采样 ${series.map((s) => s.size).join('/')}）违例 ${bad}${common.length ? ` 例指纹 ${series[0].get(common[0])}` : ''}`)
  evidence.d1 = { perRoom: series.map((s) => s.size), common: common.length, bad, fpSample: common.length ? series[0].get(common[common.length - 1]) : null }
  for (const r of rooms) await killRoom(r.id).catch(() => { })
}

/* ============ L1 收口（8min）============ */
console.log('── L1 收口（等待 8min 窗结束）──')
{
  while (!longDone) await sleep(5000)
  await LR.pull().catch(() => { })
  const st = stOf(LR)
  const crowns = LR.evs.filter((e) => e.k === 'crown').length
  const rounds = st ? st.round.n : (longSamples[longSamples.length - 1] || {}).round
  const minLive = Math.min(...longSamples.map((s) => s.live))
  const below = longSamples.filter((s) => s.live < 20)
  const residBad = longSamples.filter((s) => s.resid !== 0).length
  const lbBad = longSamples.filter((s) => !s.lbOk).length
  const dev = st && st.stats.devours
  ok('L1', '轮 rollover×2：8min（ts2=9600 tick）跨 7200 tick 双轮界（QA1 5min 单界交叉引用）', rounds >= 3 && crowns >= 2, `round.n=${rounds} crown×${crowns}`)
  ok('L1', '长局质量守恒全程+排行榜全程一致', residBad === 0 && lbBad === 0, `A8 违例=${residBad} lb 违例=${lbBad}（${longSamples.length} 采样）`)
  ok('L1', '长局活鱼下界 ≥17 且瞬态占比 <20%（O-1 重生窗重叠率口径）', minLive >= 17 && below.length / longSamples.length < 0.2,
    `min=${minLive} <20 采样=${below.length}/${longSamples.length}${recovs.length ? ` 恢复时延 ms=[${recovs.join(',')}]` : '（窗内未检出）'}`)
  ok('L1', '长局吞噬生态（devour/tick 与 QA1 5min 同量级——交叉引用）', dev > 100, `devour×${dev} @tick=${st && st.tick}（QA1 83@6000）`)
  evidence.l1 = { samples: longSamples.length, rounds, crowns, minLive, below: below.length, recovs, residBad, lbBad, devours: dev, tick: st && st.tick, finalLedger: st && st.ledger }
  await killRoom(LR.id).catch(() => { })
}

await mkdir(EVID, { recursive: true })
await writeFile(EVID + '/net-evidence.json', JSON.stringify(evidence, null, 2))
console.log(`\n${failed === 0 ? 'QA2-NET OK' : 'QA2-NET FAILED'}：${passed} 通过，${failed} 失败（证据 ${EVID}/net-evidence.json）`)
process.exit(failed === 0 ? 0 : 1)
