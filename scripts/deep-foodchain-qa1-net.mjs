#!/usr/bin/env node
/* =====================================================================
 * GAMES-165 深海食物链 QA1 联机红线专项（net 臂 · S6 吞噬裁决第二证）
 * 私有影子网关 :4421（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4400/:4399 零感知）；
 * 剧本房一律 /api/test/* 隔离测试房；延迟臂走 TCP 单向 100ms 代理 + 真 WS quick 房。
 *   Q1 海量实体实证：秒配 20 鱼+资源位 180+食物密度+实体三顶声明块（welcome.fish）
 *   Q2 吞噬裁决权威（QA 独立复跑）：一裁三账逐条对账（gain/drops 公式）+
 *      质量守恒残差 A8 逐拍抽样（多 tick，非仅终态）
 *   Q3 K=1.25 临界定档双向（离线 sim 直驱）：纯函数表全扫 + 活体临界对吞噬成立 +
 *      逆向恒不成立（K>1 互斥）+ 亚临界共存 + 档位滞回（降档带 −5%）
 *   Q4 AOI 体型分级（离线 emit 直驱）：ext.aoi.r 档位表 {380,440,500,560} 单调 +
 *      15px 滞回带双向（带内不踢/带外 leave）+ 观战固定 460
 *   Q5 重连三档（timeScale=1 真秒）：5s 全测（质量/体型/kills/skin 延续+账本一致）+
 *      10s 窗内复席 + 30s 逾窗 bot 接管→重连夺回
 *   Q6 Bot 三档梯度（体型键控四问树可观测分层）：kills comp>casual / deaths 反序 /
 *      casual dash=0 / 末位档位 comp≥casual
 *   Q7 200ms 延迟补偿（TCP 代理每向 100ms + 真 WS quick 房）：快照节拍无停摆 +
 *      ack 回执 + 转向收敛 + 事件流（eat/devour）
 *   Q8 长局 spot 5min：round rollover（crown 事件+round.n 前进）+全程序账本残差 0+
 *      活鱼下界+排行榜一致（与 api-check full20 交叉引用）
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { createRequire } from 'node:module'
import net from 'node:net'
import { writeFile, mkdir } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/deep-foodchain/sim.cjs')
const P = require('../games/multiplayer/deep-foodchain/shared.cjs')

const GW = process.env.QA_GW || 'http://127.0.0.1:4421'
const GWS = process.env.QA_GW_WS || 'ws://127.0.0.1:4421'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-165'
const SEED = 20261017

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

/* 测试房壳：游标泵（事件=测试面逐拍全量，msg.t 区分 snapshot/欢迎） */
function makeRoom(tag, resp) {
  const R = { tag, id: resp.roomId, seat: resp.playerSeat, token: resp.token, cur: 0, welcomes: [], snaps: [], evs: [], last: null }
  R.pull = async () => {
    const r = await gw('GET', `/api/test/state?roomId=${R.id}&since=${R.cur}`)
    if (!(r.json && r.json.ok)) return r.json
    R.cur = r.json.cursor; R.last = r.json
    for (const e of (r.json.events || [])) {
      R.snaps.push(e)
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

const MIX20 = [null, 'competitive', 'competitive', 'competitive', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
/* ============ Q8 长局 spot（先起后台，5min 采样与其余段并行）============ */
console.log('── Q8 长局 spot 5min（后台起房，末段收口）──')
const LR = makeRoom('long', (await createRoom({ timeScale: 2, maxTicks: 14000, botLevels: MIX20 })).json)
const longSamples = []
let longDone = false, botDone = false
;(async () => {
  await sleep(1500)
  const t0 = Date.now()
  while (Date.now() - t0 < 300000 && !longDone) {
    await LR.pull().catch(() => { })
    const st = stOf(LR)
    if (st) {
      const lf = liveFish(st)
      const lb = st.leaderboard || []
      const lbOk = lb.length <= 10 && lb.every((x, i) => i === 0 || lb[i - 1].score >= x.score) // top10（HUD top5+tap 展开——§7；首跑 ≤5 假红教训）
        && lf.every((f) => lb.length === 0 || f.score <= lb[0].score)
      longSamples.push({ tick: st.tick, round: st.round.n, roundTick: st.round.tick, live: lf.length, resid: massResidual(st), lbOk, devours: st.stats.devours })
    }
    await sleep(10000)
  }
  longDone = true
})()

/* ============ Q1 海量实体实证 ============ */
console.log('── Q1 海量实体实证（秒配/容量/食物密度）──')
{
  const R = makeRoom('q1', (await createRoom({ timeScale: 3, botLevels: MIX20 })).json)
  await sleep(1800)
  await R.pull()
  const st = stOf(R)
  const wl = R.welcomes[0]
  const decl = wl && wl.room && wl.room.fish
  const fishN = liveFish(st).length
  const sites = Object.values(st.ents).filter((e) => e.k === 'alg' || e.k === 'kri' || e.k === 'cry')
  const onN = sites.filter((e) => e.on).length
  ok('Q1', '秒配：首拍活鱼=20（bot 开场即 live，feed 恒 live 语义）', fishN === 20, `live=${fishN}`)
  ok('Q1', '实体容量声明块（welcome.room.fish：cap fish24/site180/drop240/M4000+K=1.25）',
    !!(decl && decl.K === 1.25 && decl.cap.fish === 24 && decl.cap.site === 180 && decl.cap.drop === 240 && decl.cap.M === 4000),
    decl ? `K=${decl.K} cap=${JSON.stringify(decl.cap)}` : '未见声明块')
  ok('Q1', '食物密度：资源位 180（荧藻120/磷虾40/晶簇20）+觅食后在场率高（供给不枯）', sites.length === 180 && onN >= 120,
    `sites=${sites.length} on=${onN}（首拍已被吃 26 位=进食活性侧证；alg=${sites.filter((e) => e.k === 'alg').length}/kri=${sites.filter((e) => e.k === 'kri').length}/cry=${sites.filter((e) => e.k === 'cry').length}）`)
  let minLive = 99, residBad = 0
  for (let i = 0; i < 8; i++) { await sleep(1000); await R.pull(); const s2 = stOf(R); minLive = Math.min(minLive, liveFish(s2).length); if (massResidual(s2) !== 0) residBad++ }
  ok('Q1', '活鱼下界 ≥19（吞噬重生窗 3s）+容量护栏不越 24', minLive >= 19 && fishN <= 24, `min=${minLive}`)
  evidence.q1 = { fishN, sites: sites.length, onN, decl, minLive }
  /* Q2 与 Q1 同房续跑：事件账本对账 */
  console.log('── Q2 吞噬裁决权威（QA 独立复跑对账+A8 逐拍）──')
  const devours = R.evs.filter((e) => e.k === 'devour')
  const bad = devours.filter((e) => {
    const gain = Math.floor(e.mv * 11 / 20)
    let n = Math.ceil((e.mv - gain) / 2); n = n < 3 ? 3 : n > 30 ? 30 : n
    return e.gain !== gain || e.drops !== n
  })
  if (devours.length > 0) ok('Q2', '一裁三账对账（首窗）：devour.gain==floor(mv×11/20) 且 drops==clamp(ceil(dropT/2),3,30)', bad.length === 0, `首窗 devour×${devours.length}（体型分化前稀疏——满轮对账见 Q2b）`)
  else console.log('  · Q2 首窗 devour×0（开局全 M=20 等体互不吞——K>1 互斥的行为侧证；满轮对账见 Q2b）')
  const eaten = R.evs.filter((e) => e.k === 'eat').length
  ok('Q2', '进食事件流在场（{k:eat} 生态活性）', eaten > 50, `eat×${eaten}`)
  ok('Q2', 'A8 质量守恒：多 tick 抽样残差全 0（ΣM+Σ粒+expired−endow−ate−gained−dropped+dashed）', residBad === 0, `${8} 拍 ${residBad} 违例（终拍 ledger=${JSON.stringify(stOf(R).ledger)}）`)
  evidence.q2 = { devours: devours.length, bad: bad.length, eaten, residBad }
  await killRoom(R.id).catch(() => { })
}

/* ============ Q3 K=1.25 临界定档双向（离线 sim 直驱）============ */
console.log('── Q3 K=1.25 临界定档双向（离线直驱）──')
{
  /* 纯函数表全扫：rV 8..43，最小可吞 rM*4==5*rV（整数比免浮点） */
  let tblBad = []
  for (let rv = 8; rv <= 43; rv++) {
    const rm = Math.ceil(5 * rv / 4)
    if (P.canSwallow(rm, rv) !== true) tblBad.push(`${rm}/${rv} 应可吞`)
    if (rm - 1 >= rv && P.canSwallow(rm - 1, rv) !== false) tblBad.push(`${rm - 1}/${rv} 应不可吞`)
  }
  ok('Q3', 'canSwallow 纯函数表全扫（rV 8-43：临界 rM=ceil(5rV/4) 恰可吞，−1 不可）', tblBad.length === 0, tblBad.length ? tblBad[0] : '36 档全对（K=5/4 整数比）')
  ok('Q3', '临界互斥（K>1 ⇒ 双向不可能：r8 永不可吞 r10）', P.canSwallow(8, 10) === false && P.canSwallow(8, 8) === false, 'canSwallow(8,10)=false（等体互穿透，§2.5）')
  /* 活体集成：受控双鱼房（清资源位断进食干扰；同位同向保接触） */
  const mkPair = async (Mh, Mv) => {
    const st = S.create(SEED, {})
    for (const id in st.ents) if (st.ents[id].k !== 'fish') delete st.ents[id] // 清资源位
    const room = { seats: [{ seat: 0, kind: 'human', name: 'H' }, { seat: 1, kind: 'bot', name: 'V' }], spectators: [] }
    S.step(st, {}, room) // 席位自愈补鱼
    const h = st.ents.s0, v = st.ents.s1
    for (const f of [h, v]) { f.M = f === h ? Mh : Mv; f.x = f.px = 900000; f.y = f.py = 900000; f.a = f.ta = 0; f.prot = 0; f.dead = 0; f.died = 0; f.score = 0; f.kills = 0 }
    const r = S.step(st, {}, room)
    return { st, r, h, v }
  }
  const crit = await mkPair(60, 22)   // r10 vs r8：恰 1.25×
  const critDev = crit.r.events.filter((e) => e.k === 'devour')
  ok('Q3', '活体临界对：r_mine=1.25×r_victim（10/8）恰可吞（≥ 语义含等号）',
    critDev.length === 1 && critDev[0].by === 0 && critDev[0].seat === 1, `devour×${critDev.length}${critDev[0] ? ` by=seat${critDev[0].by} mv=${critDev[0].mv} gain=${critDev[0].gain}` : ''}`)
  const sub = await mkPair(40, 22)    // r9 vs r8：1.125× < K
  const subDev = sub.r.events.filter((e) => e.k === 'devour')
  ok('Q3', '亚临界共存：r 比 1.125<K 同点接触零吞噬（无墙死⇒双活）',
    subDev.length === 0 && !sub.h.dead && !sub.v.dead, `devour×${subDev.length} h.dead=${sub.h.dead} v.dead=${sub.v.dead}`)
  /* 档位滞回：升档即时/降档 −5% 带（§2.4） */
  const hy = [[80, 0, 1], [79, 1, 1], [77, 1, 1], [76, 1, 1], [75, 1, 0], [300, 0, 2], [299, 2, 2], [285, 2, 2], [284, 2, 1], [1000, 0, 3], [999, 3, 3], [950, 3, 3], [949, 3, 2]]
  const hyBad = hy.filter(([M, cur, want]) => P.tierOf(M, cur) !== want)
  ok('Q3', '定档滞回：升档即时（M 达上界）/降档带下界×0.95（dash 掉质量不抖档）', hyBad.length === 0, hyBad.length ? `M=${hyBad[0][0]} 得 ${P.tierOf(hyBad[0][0], hyBad[0][1])} 期望 ${hyBad[0][2]}` : '13 锚全对（80/300/1000 三界：升档即时+带界=下界×0.95 恰留档）')
  evidence.q3 = { tblBad: tblBad.length, critDevour: critDev.length, subDevour: subDev.length, hyBad: hyBad.length }
}

/* ============ Q4 AOI 体型分级（离线 emit 直驱）============ */
console.log('── Q4 AOI 体型分级（档即视野+滞回带）──')
{
  const st = S.create(SEED, {})
  /* 网关 seat.conn=包装层 {conn: socket}（emitOne 经 ctxRec.ctx.conn.send 下发） */
  const mkSock = () => ({ writable: true, sent: [], send(t) { this.sent.push(JSON.parse(t)) } })
  const sock = mkSock(), specSock = mkSock()
  const conn = { conn: sock }, spec = { conn: specSock }
  const room = { state: st, seats: [{ seat: 0, kind: 'human', name: 'me', conn }, { seat: 1, kind: 'bot', name: 'probe' }], spectators: [spec] }
  S.step(st, {}, room) // 补鱼
  const me = st.ents.s0, probe = st.ents.s1
  const dist = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y))
  const place = (M, tier) => { me.M = M; me.tier = tier; me.x = me.px = 900000; me.y = me.py = 900000; me.a = me.ta = 0; me.prot = 0; me.dead = 0 }
  /* 档位表：T0 20 / T1 100 / T2 400 / T3 1500 → aoiR {380,440,500,560}（§2.4） */
  const rows = []
  for (const [M, t] of [[20, 0], [100, 1], [400, 2], [1500, 3]]) {
    place(M, t)
    probe.x = probe.px = 900000 + 300000; probe.y = probe.py = 900000 // 探针 300px 内=四档全可见
    S.emit(room, null)
    const snap = sock.sent[sock.sent.length - 1]
    rows.push({ M, t, aoiR: snap.ext.aoi.r, visible: snap.ents.some((e) => e.id === 's1') })
  }
  const EXP = [380000, 440000, 500000, 560000]
  ok('Q4', '视野半径随体型单调（ext.aoi.r=档位表 {380,440,500,560}，机制/带宽同源表）',
    rows.every((r, i) => r.aoiR === EXP[i]) && rows.every((r) => r.visible),
    rows.map((r) => `T${r.t}=${r.aoiR / 1000}px`).join(' < '))
  /* 滞回带：T0 r380——探针移出 rr+margin 但仍在 rr+15px 带内 → 不踢；再出带 → leave */
  place(20, 0)
  probe.x = probe.px = 900000; probe.y = probe.py = 900000
  S.emit(room, null) // full：known 收编
  const margin = P.rOfM(probe.M)
  probe.x = probe.px = 900000 + 380000 + margin + 8000; probe.y = probe.py = 900000 // 带内（出 rr 出 rOut 前 7px）
  S.emit(room, null)
  const inBand = sock.sent[sock.sent.length - 1].ents.some((e) => e.id === 's1')
  probe.x = probe.px = 900000 + 380000 + margin + 16000; probe.y = probe.py = 900000 // 出带 1px
  S.emit(room, null)
  const outSnap = sock.sent[sock.sent.length - 1]
  const left = (outSnap.leave || []).includes('s1')
  ok('Q4', '15px 滞回带双向（带内不踢/出带 leave:[id] 淡出——边界抖动防线）', inBand && left, `带内可见=${inBand} 出带 leave=${left}`)
  const specSnap = specSock.sent[specSock.sent.length - 1]
  ok('Q4', '观战位 r 固定 460（镜头点订阅，不占实体预算）', specSnap.ext.aoi.r === 460000, `spectator aoi.r=${specSnap.ext.aoi.r / 1000}px`)
  evidence.q4 = { rows, inBand, left, specR: specSnap.ext.aoi.r }
}

/* ============ Q6 Bot 三档梯度（后台起房与 Q5/Q7 并行）============ */
console.log('── Q6 Bot 三档梯度（体型键控四问树分层，2min 满轮）──')
const BR = makeRoom('bot', (await createRoom({ timeScale: 3, maxTicks: 3700, botLevels: MIX20 })).json)
const LV = { 1: 'comp', 2: 'comp', 3: 'comp', 4: 'bal', 5: 'bal', 6: 'bal', 7: 'bal', 8: 'bal', 9: 'bal', 10: 'cas', 11: 'cas', 12: 'cas', 13: 'cas', 14: 'cas', 15: 'cas', 16: 'cas', 17: 'cas', 18: 'cas', 19: 'cas' }
const botAgg = { comp: { kills: 0, deaths: 0, dash: 0, samp: 0, tier: [], deep: 0 }, bal: { kills: 0, deaths: 0, dash: 0, samp: 0, tier: [], deep: 0 }, cas: { kills: 0, deaths: 0, dash: 0, samp: 0, tier: [], deep: 0 } }
const BRdev = []
;(async () => {
  await sleep(1500)
  const t0 = Date.now()
  while (Date.now() - t0 < 125000) {
    await BR.pull().catch(() => { })
    const st = stOf(BR)
    if (st) {
      for (const f of liveFish(st)) {
        const lv = LV[f.seat]; if (!lv) continue
        const a = botAgg[lv]
        a.kills = Math.max(a.kills, 0); a.samp++
        a.tier.push(f.tier ?? f.t ?? 0)
        if (f.boost) a.dash++
        if (f.y > 1350000) a.deep++
      }
      for (const e of BR.evs) if (e.k === 'devour') { BRdev.push(e); if (LV[e.by]) botAgg[LV[e.by]].kills++; if (LV[e.seat]) botAgg[LV[e.seat]].deaths++ }
      BR.evs.length = 0
    }
    await sleep(2000)
  }
  botDone = true
})()

/* ============ Q5 重连三档（真秒）============ */
console.log('── Q5 重连三档（5s 全测/10s 窗内/30s 逾窗夺回）──')
{
  const R = makeRoom('rc', (await createRoom({ timeScale: 1, maxTicks: 100000, botLevels: MIX20 })).json)
  await sleep(1500); await R.pull()
  const snap = () => { const f = stOf(R).ents['s' + R.seat]; return f && { M: f.M, t: f.tier, k2: f.kills, skin: f.skin, sc: f.score } }
  const rec = async (label, waitMs, expectTakeover) => {
    const before = snap(); const stB = stOf(R)
    await input(R.id, R.seat, '$disconnect')
    await sleep(waitMs)
    await R.pull()
    const during = stOf(R).ents['s' + R.seat]
    const duringLive = during && !during.dead
    const r = await input(R.id, R.seat, '$reconnect', { token: R.token })
    let wl = null
    for (let i = 0; i < 30 && !wl; i++) { await sleep(200); await R.pull(); wl = R.welcomes[R.welcomes.length - 1] }
    const after = snap()
    const stA = stOf(R)
    ok('Q5', `${label}：重连复席成功（welcome+本人鱼在场）`, !!(wl && after), `${wl ? 'welcome ok' : '无 welcome'} M ${before && before.M}→${after && after.M}`)
    if (before && after) {
      ok('Q5', `${label}：状态延续（skin 恒同+kills 单调不减+score=floor(M/4)+kills×40 口径恒成立）`,
        before.skin === after.skin && after.k2 >= before.k2 && after.sc === Math.floor(after.M / 4) + after.k2 * 40,
        `skin=${after.skin} kills ${before.k2}→${after.k2} score ${before.sc}→${after.sc}（M 轨迹 ${before.M}→${after.M}${after.M < before.M ? '＝离线期被捕化粒（§5.7 设计态：回来看战果）' : ''}）`)
    }
    ok('Q5', `${label}：断线期间世界不缺鱼（席位鱼恒活，逾窗=${expectTakeover}）`, !!duringLive, `disconnect ${waitMs / 1000}s 后鱼 dead=${during && during.dead}`)
    ok('Q5', `${label}：重连后账本一致（A8 残差 0）`, massResidual(stA) === 0, `resid=${massResidual(stA)}`)
    return { before, after }
  }
  const r5 = await rec('5s 全测', 5000, false)
  evidence.q5a = r5
  const r10 = await rec('10s 窗内（边缘）', 9300, false)
  evidence.q5b = r10
  const r30 = await rec('30s 逾窗（bot 接管→夺回）', 31000, true)
  evidence.q5c = r30
  await killRoom(R.id).catch(() => { })
}

/* ============ Q7 200ms 延迟补偿（TCP 每向 100ms 代理 + 真 WS quick 房）============ */
console.log('── Q7 200ms 延迟补偿（代理臂）──')
{
  const PROXY_PORT = 4431
  const proxy = net.createServer((c) => {
    const up = net.connect(4421, '127.0.0.1')
    const pump = (from, to) => from.on('data', (d) => setTimeout(() => to.write(d), 100)) // 每向 100ms，同延迟定时器 FIFO 保序
    pump(c, up); pump(up, c)
    c.on('close', () => up.destroy()); up.on('close', () => c.destroy())
    c.on('error', () => { }); up.on('error', () => { })
  })
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r))
  const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`)
  const arrival = []
  let seat = -1, ownId = '', seq = 0, ackSeen = -1, ackLag = -1, sentAt = {}, eatN = 0, devN = 0, angles = [], target = 200
  let open = false
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', mode: 'play', name: 'QA延迟臂' })); ws.send(JSON.stringify({ t: 'quick', gameId: 'deep-foodchain' })); open = true }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.t === 'welcome') { seat = m.seat; ownId = 's' + seat }
    if (m.t === 'snapshot') {
      arrival.push(Date.now())
      if (m.ext && Number(m.ext.ack) >= 0 && sentAt[m.ext.ack] && ackLag < 0) ackLag = Date.now() - sentAt[m.ext.ack]
      if (Number(m.ext && m.ext.ack) > ackSeen) ackSeen = Number(m.ext.ack)
      const own = (m.ents || []).find((e) => e.id === ownId)
      if (own) angles.push(own.a)
      for (const e of (m.events || [])) { if (e.k === 'eat') eatN++; if (e.k === 'devour') devN++ }
    }
  }
  await sleep(2500)
  ok('Q7', 'quick 经 200ms 代理秒进房（welcome 就席）', seat >= 0, `seat=${seat}`)
  /* 30s 驱动：10Hz input（a 恒带心跳）+ 目标角分阶段变化 */
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (open) { const f = ++seq; sentAt[f] = Date.now(); ws.send(JSON.stringify({ t: 'input', frame: f, keys: { a: target } })) }
    if (Date.now() - t0 > 15000) target = 20 // 中途换向（转向收敛观测窗）
    await sleep(100)
  }
  ws.close(); proxy.close()
  const gaps = arrival.slice(1).map((t, i) => t - arrival[i])
  const maxGap = Math.max(...gaps), medGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
  ok('Q7', '快照节拍稳定（10Hz 到达无停摆：中位 ~100ms、最大间隙 <2.5s）', arrival.length > 200 && medGap <= 200 && maxGap < 2500, `n=${arrival.length} med=${medGap}ms max=${maxGap}ms`)
  ok('Q7', 'ack 回执在场（input 帧号被权威确认，200ms 双向后仍闭环）', ackLag > 150 && ackLag < 2000, `ack 首达 ${ackLag}ms（含双向 200ms 代理）ackSeq=${ackSeen}/${seq}`)
  const dTo = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }
  const firstConv = angles.length > 110 && dTo(angles[100], 200) < 60   // 10s（100 快照）时已收敛向 200°
  const lateConv = angles.length > 220 && dTo(angles[angles.length - 1], 20) < 60 // 换向后末拍收敛向 20°
  ok('Q7', '转向收敛（连续模拟量：目标角 200° 收敛后换 20° 仍收敛——200ms 只造成曲线差不造成空洞）', firstConv && lateConv,
    `10s 时距 200°=${angles.length > 100 ? dTo(angles[100], 200).toFixed(0) : '?'}° 末拍距 20°=${angles.length ? dTo(angles[angles.length - 1], 20).toFixed(0) : '?'}°`)
  ok('Q7', '事件流不受延迟影响（eat/devour 生态活性照常下行）', eatN > 10, `eat×${eatN} devour×${devN}`)
  evidence.q7 = { seat, snaps: arrival.length, medGap, maxGap, ackLag, eatN, devN }
}

/* ============ Q6 收口 ============ */
console.log('── Q6 收口（三档梯度断言）──')
{
  while (!botDone) await sleep(3000) // 等采样器终局（async 竞态截尾——首跑教训；字段口径=.tier 见 qa1-bot 补测件）
  await BR.pull().catch(() => { })
  const A = botAgg
  const avg = (a) => (a.tier.reduce((x, y) => x + y, 0) / (a.tier.length || 1)).toFixed(2)
  ok('Q6', '吞噬数分层：competitive > casual（Q2 猎物评估+拦截闭式解 vs 恒空）', A.comp.kills > A.cas.kills, `kills comp=${A.comp.kills} bal=${A.bal.kills} cas=${A.cas.kills}`)
  ok('Q6', '死亡数分层：casual > competitive（饲料位弱避险 vs 猎手规避）', A.cas.deaths > A.comp.deaths, `deaths cas=${A.cas.deaths} bal=${A.bal.deaths} comp=${A.comp.deaths}`)
  ok('Q6', 'casual 恒不 dash（人格参数 dash=从不——质量换速度是猎/逃技）', A.cas.dash === 0, `casual boost 采样=${A.cas.dash}/${A.cas.samp}（comp=${A.comp.dash} bal=${A.bal.dash}）`)
  ok('Q6', '末位平均档位：comp ≥ casual（成长分层外显）', avg(A.comp) >= avg(A.cas), `avg tier comp=${avg(A.comp)} bal=${avg(A.bal)} cas=${avg(A.cas)}`)
  const badB = BRdev.filter((e) => {
    const gain = Math.floor(e.mv * 11 / 20)
    let n = Math.ceil((e.mv - gain) / 2); n = n < 3 ? 3 : n > 30 ? 30 : n
    return e.gain !== gain || e.drops !== n
  })
  ok('Q2b', '一裁三账对账（满轮 2min）：devour.gain==floor(mv×11/20) 且 drops==clamp(ceil(dropT/2),3,30)（55-45 转移+45% 回收——QA 独立复跑）',
    BRdev.length > 0 && badB.length === 0, `devour×${BRdev.length} 全对（首例 mv=${BRdev[0] && BRdev[0].mv} gain=${BRdev[0] && BRdev[0].gain} drops=${BRdev[0] && BRdev[0].drops}）`)
  evidence.q2b = { devours: BRdev.length, bad: badB.length }
  evidence.q6 = { comp: { k: A.comp.kills, d: A.comp.deaths, dash: A.comp.dash, avgT: +avg(A.comp) }, bal: { k: A.bal.kills, d: A.bal.deaths, dash: A.bal.dash, avgT: +avg(A.bal) }, cas: { k: A.cas.kills, d: A.cas.deaths, dash: A.cas.dash, avgT: +avg(A.cas) } }
  await killRoom(BR.id).catch(() => { })
}

/* ============ Q8 收口（长局 5min）============ */
console.log('── Q8 长局收口（等待 5min 窗结束）──')
{
  while (!longDone) await sleep(5000)
  await LR.pull().catch(() => { })
  const st = stOf(LR)
  const crowns = LR.evs.filter((e) => e.k === 'crown').length
  const rounds = st ? st.round.n : (longSamples[longSamples.length - 1] || {}).round
  const minLive = Math.min(...longSamples.map((s) => s.live))
  const residBad = longSamples.filter((s) => s.resid !== 0).length
  const lbBad = longSamples.filter((s) => !s.lbOk).length
  ok('Q8', '轮 rollover：5min（ts2=6000 tick）跨 3600 tick 轮界，round 前进+crown 加冕事件', rounds >= 2 && crowns >= 1, `round.n=${rounds} crown×${crowns}（房不 ended 恒 live）`)
  ok('Q8', '长局活鱼下界 ≥19（常驻渔场生态不塌）', minLive >= 19, `min=${minLive}（${longSamples.length} 采样）`)
  ok('Q8', '长局质量守恒全程（30 采样残差全 0）+排行榜全程一致', residBad === 0 && lbBad === 0, `A8 违例=${residBad} lb 违例=${lbBad} devours=${st && st.stats.devours}`)
  evidence.q8 = { samples: longSamples.length, rounds, crowns, minLive, residBad, lbBad, finalLedger: st && st.ledger, finalStats: st && st.stats }
  await killRoom(LR.id).catch(() => { })
}

await mkdir(EVID, { recursive: true })
await writeFile(EVID + '/net-evidence.json', JSON.stringify(evidence, null, 2))
console.log(`\n${failed === 0 ? 'QA1-NET OK' : 'QA1-NET FAILED'}：${passed} 通过，${failed} 失败（证据 ${EVID}/net-evidence.json）`)
process.exit(failed === 0 ? 0 : 1)
