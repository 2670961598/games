#!/usr/bin/env node
/* =====================================================================
 * GAMES-168 深海食物链 QA2 W2 复测件（AFK 收窄边界——台账单调口径修正）
 * 首跑教训：bot 死亡重生重建 mem → md/bl 台账清零，Σ当前值可跌（Δmd=-1 假红）。
 * 修正口径：逐席历史最大值（单调估计）——托管窗 Δ=maxΣ增量，死亡重置不影响。
 * 链路：追大鱼送死×2 → L1（deaths≥2,kills==0）→ 贴猎手证 md 增 → 冻结输入 →
 * afk.t≥600 托管 → 托管窗 md/bl 停增（近距采样非空转）→ 夺回。
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { writeFile } from 'node:fs/promises'

const GW = process.env.QA_GW || 'http://127.0.0.1:4424'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-168'
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function gw(method, path, body) {
  const res = await fetch(GW + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  let json = null; try { json = await res.json() } catch { }
  return { status: res.status, json }
}
const MIX20 = [null, 'competitive', 'competitive', 'competitive', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
const LV = { 1: 'comp', 2: 'comp', 3: 'comp', 4: 'bal', 5: 'bal', 6: 'bal', 7: 'bal', 8: 'bal', 9: 'bal', 10: 'cas', 11: 'cas', 12: 'cas', 13: 'cas', 14: 'cas', 15: 'cas', 16: 'cas', 17: 'cas', 18: 'cas', 19: 'cas' }
const hunter = (e) => LV[e.seat] === 'comp' || LV[e.seat] === 'bal'

/* 逐席单调最大台账（死亡重生清零不影响——收窄判据的测量面修正） */
const mkMon = () => {
  const m = { md: new Map(), bl: new Map() }
  return {
    feed(st) { for (const e of Object.values(st.ents)) { if (e.k !== 'fish' || e.dead || !hunter(e) || !e.mem || !e.mem.ch) continue; const k = e.seat; m.md.set(k, Math.max(m.md.get(k) || 0, e.mem.ch.md || 0)); m.bl.set(k, Math.max(m.bl.get(k) || 0, e.mem.ch.bl || 0)) } },
    sum(w) { let s = 0; for (const v of m[w].values()) s += v; return s },
  }
}

const r0 = await gw('POST', '/api/test/room', { gameId: 'deep-foodchain', seed: 20261019, startDelayMs: 300, timeScale: 3, botLevels: MIX20 })
if (!(r0.json && r0.json.ok)) { console.error('建房失败', JSON.stringify(r0.json)); process.exit(2) }
const R = { id: r0.json.roomId, seat: r0.json.playerSeat, cur: 0, evs: [], last: null }
R.pull = async () => {
  const r = await gw('GET', `/api/test/state?roomId=${R.id}&since=${R.cur}`)
  if (!(r.json && r.json.ok)) return r.json
  R.cur = r.json.cursor; R.last = r.json
  for (const e of (r.json.events || [])) { const mm = e.msg || {}; if (mm.events) for (const ev of mm.events) R.evs.push(ev) }
  return r.json
}
const input = (op, payload) => gw('POST', '/api/test/input', { roomId: R.id, seat: R.seat, op, payload })
const stOf = () => R.last && R.last.state
const me = () => stOf() && stOf().ents['s' + R.seat]
const evidence = {}
const minDistHunter = (st, f) => { let d = Infinity; for (const e of Object.values(st.ents)) { if (e.k !== 'fish' || e.dead || !hunter(e)) continue; d = Math.min(d, Math.hypot(e.x - f.x, e.y - f.y)) } return d }
const aimAt = async (filt) => {
  const st = stOf(), f = me(); if (!st || !f) return
  let b = null
  for (const e of Object.values(st.ents)) { if (e.k === 'fish' || e.dead) continue; }
  for (const e of Object.values(st.ents)) { if (e.k !== 'fish' || e.dead || !filt(e)) continue; if (!b || Math.hypot(e.x - f.x, e.y - f.y) < Math.hypot(b.x - f.x, b.y - f.y)) b = e }
  if (!b) return
  const a = ((Math.atan2(b.y - f.y, b.x - f.x) / Math.PI * 180) % 360 + 360) % 360
  await input('a', { a: Math.round(a), dash: 0 }).catch(() => { })
}

await sleep(1500); await R.pull()
const MON = mkMon()
MON.feed(stOf())
const baseSums = { md: MON.sum('md'), bl: MON.sum('bl') }

/* 段 1：送死×2 → L1 */
let t0 = Date.now(), l1 = false
while (Date.now() - t0 < 150000 && !l1) {
  await aimAt((e) => e.M >= 60 && hunter(e))
  await sleep(1000); await R.pull().catch(() => { })
  const f = me()
  if (f && f.deaths >= 2 && f.kills === 0) l1 = true
}
const fL1 = me()
ok('W2', '连败入靶（deaths≥2 kills==0 → L1；同式复跑）', !!l1, `deaths=${fL1 && fL1.deaths} kills=${fL1 && fL1.kills}`)

/* 段 2：贴猎手 → md/bl 增（非托管：sig 逐拍变化） */
let md1 = 0, bl1 = 0, near1 = 0, samp1 = 0
t0 = Date.now()
while (Date.now() - t0 < 90000 && md1 === 0) {
  await aimAt(hunter)
  await sleep(1000); await R.pull().catch(() => { })
  const st = stOf(), f = me(); if (!st || !f) continue
  MON.feed(st); samp1++
  md1 = MON.sum('md') - baseSums.md; bl1 = MON.sum('bl') - baseSums.bl
  if (minDistHunter(st, f) <= 360000) near1++
}
ok('W2', '非托管降问在场（同席 sig 变化期 md 递增——对照组）', md1 > 0, `Δmd=${md1} Δbl=${bl1}（${samp1} 采样 ×近距 ${near1}）`)

/* 段 3：冻结输入 → afk.t≥600 托管 → 单调台账停增 */
let hosted = false, afkT = 0
t0 = Date.now()
while (Date.now() - t0 < 60000 && !hosted) {
  await sleep(2000); await R.pull().catch(() => { })
  const st = stOf(); if (!st) continue
  MON.feed(st)
  const at = st.afk && st.afk[R.seat]; if (at) afkT = at.t
  if (at && at.t >= 600) hosted = true
}
ok('W2', '托管门 afk.t≥600（60s 签名冻结——st.afk 簿记）', hosted, `afk.t=${afkT}`)
const hostBase = { md: MON.sum('md'), bl: MON.sum('bl') }
let nearH = 0, sampH = 0, deathsH0 = -1, eats0 = 0
if (hosted) {
  deathsH0 = me().deaths
  eats0 = R.evs.filter((e) => e.k === 'eat' && e.seat === R.seat).length
  t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    await sleep(2000); await R.pull().catch(() => { })
    const st = stOf(), f = me(); if (!st || !f) continue
    MON.feed(st); sampH++
    if (minDistHunter(st, f) <= 360000) nearH++
    const at = st.afk && st.afk[R.seat]; if (at) afkT = Math.max(afkT, at.t)
  }
}
const dMd = MON.sum('md') - hostBase.md, dBl = MON.sum('bl') - hostBase.bl
const fH = me()
const eatsH = R.evs.filter((e) => e.k === 'eat' && e.seat === R.seat).length - eats0
ok('W2', 'AFK 收窄在线（托管席单调台账停增——唯一门差=afk.t≥600；近距采样非空转）',
  hosted && dMd === 0 && dBl === 0 && nearH >= 5,
  `托管窗 Δmd=${dMd} Δbl=${dBl}（×近距 ${nearH}/${sampH}；deaths ${deathsH0}→${fH && fH.deaths} kills=${fH && fH.kills}——连败在案仍停增）`)
ok('W2', '托管席仍活跃在场（casual 代打觅食——非空转判据的另一半）', eatsH > 0, `eat×${eatsH}`)
/* 夺回 */
let rec = false, recMs = -1
if (hosted) {
  const t2 = Date.now()
  await input('a', { a: 200, dash: 0 }).catch(() => { })
  for (let i = 0; i < 16; i++) { await sleep(250); await R.pull().catch(() => { }); const f = me(); if (f && Math.abs(((f.a - 200 + 540) % 360) - 180) < 15) { rec = true; recMs = Date.now() - t2; break } }
}
ok('W2', '输入即夺回（复跑收尾）', rec, recMs >= 0 ? `${recMs}ms` : '未收敛')
evidence.w2fix = { baseSums, md1, bl1, samp1, near1, hosted, afkT, dMd, dBl, nearH, sampH, deaths: [deathsH0, fH && fH.deaths], eatsH, recMs }
await gw('DELETE', `/api/test/room?roomId=${R.id}`).catch(() => { })
await writeFile(EVID + '/mercy2-evidence.json', JSON.stringify(evidence, null, 2))
console.log(`\n${failed === 0 ? 'QA2-MERCY2 OK' : 'QA2-MERCY2 FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
