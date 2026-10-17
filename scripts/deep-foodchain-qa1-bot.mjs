#!/usr/bin/env node
/* =====================================================================
 * GAMES-165 深海食物链 QA1 Bot 三档梯度补测件（net 臂 Q6 修复复跑）
 * 首跑教训：testapi 原始 state 鱼记录字段是 .tier（fishFull 快照路径才映射 .t）——
 * 按快照字段名读原始 state 得 NaN；且收口须等采样器终局（async 竞态截尾）。
 * 断言面（设计 §4.2 三档可感知差异口径）：吞噬数 comp>casual / 死亡数 casual>comp /
 * casual dash=0 / 末位平均档位 comp≥casual；eat 事件分层=密度场觅食可观测（披露位）。
 * ===================================================================== */
import { writeFile } from 'node:fs/promises'

const GW = process.env.QA_GW || 'http://127.0.0.1:4421'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-165'
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
const LV = {}
MIX20.forEach((lv, i) => { if (lv) LV[i] = lv.slice(0, 3) === 'com' ? 'comp' : lv.slice(0, 3) === 'bal' ? 'bal' : 'cas' })

const r0 = await gw('POST', '/api/test/room', { gameId: 'deep-foodchain', seed: 20261017, startDelayMs: 300, timeScale: 3, maxTicks: 3700, botLevels: MIX20 })
if (!(r0.json && r0.json.ok)) { console.error('建房失败', JSON.stringify(r0.json)); process.exit(2) }
const roomId = r0.json.roomId
const agg = { comp: { k: 0, d: 0, dash: 0, samp: 0, tier: 0 }, bal: { k: 0, d: 0, dash: 0, samp: 0, tier: 0 }, cas: { k: 0, d: 0, dash: 0, samp: 0, tier: 0 } }
const eats = { comp: 0, bal: 0, cas: 0 }
const devAll = []
let cur = 0
const t0 = Date.now()
while (Date.now() - t0 < 132000) {
  const r = await gw('GET', `/api/test/state?roomId=${roomId}&since=${cur}`)
  if (r.json && r.json.ok) {
    cur = r.json.cursor
    const st = r.json.state
    if (st) {
      for (const e of Object.values(st.ents)) {
        if (e.k !== 'fish' || e.dead) continue
        const lv = LV[e.seat]; if (!lv) continue
        agg[lv].samp++
        agg[lv].tier += (e.tier ?? 0)
        if (e.boost) agg[lv].dash++
      }
      for (const ev0 of (r.json.events || [])) for (const e of ((ev0.msg && ev0.msg.events) || [])) {
        if (e.k === 'devour') { devAll.push(e); if (LV[e.by]) agg[LV[e.by]].k++; if (LV[e.seat]) agg[LV[e.seat]].d++ }
        if (e.k === 'eat' && LV[e.seat]) eats[LV[e.seat]]++
      }
    }
    if (r.json.result) break
  }
  await sleep(2000)
}
await gw('DELETE', `/api/test/room?roomId=${roomId}`).catch(() => { })
const avgT = (a) => +(a.tier / (a.samp || 1)).toFixed(2)
const bad = devAll.filter((e) => {
  const gain = Math.floor(e.mv * 11 / 20)
  let n = Math.ceil((e.mv - gain) / 2); n = n < 3 ? 3 : n > 30 ? 30 : n
  return e.gain !== gain || e.drops !== n
})
console.log(`  · 满轮台账：devour×${devAll.length}（对账坏 ${bad.length}）eat comp=${eats.comp} bal=${eats.bal} cas=${eats.cas}`)
ok('Q6', '吞噬数分层：competitive > casual（Q2 猎物评估+拦截闭式解 vs 恒空）', agg.comp.k > agg.cas.k, `kills comp=${agg.comp.k} bal=${agg.bal.k} cas=${agg.cas.k}`)
ok('Q6', '死亡数分层：casual > competitive（饲料位弱避险 vs 猎手规避）', agg.cas.d > agg.comp.d, `deaths cas=${agg.cas.d} bal=${agg.bal.d} comp=${agg.comp.d}`)
ok('Q6', 'casual 恒不 dash（人格参数 dash=从不——质量换速度是猎/逃技）', agg.cas.dash === 0, `casual boost 采样=${agg.cas.dash}/${agg.cas.samp}（comp=${agg.comp.dash} bal=${agg.bal.dash}）`)
ok('Q6', '末位平均档位：comp ≥ casual（成长分层外显）', avgT(agg.comp) >= avgT(agg.cas), `avg tier comp=${avgT(agg.comp)} bal=${avgT(agg.bal)} cas=${avgT(agg.cas)}`)
ok('Q2b', '一裁三账对账（满轮）：devour.gain==floor(mv×11/20) 且 drops==clamp(ceil(dropT/2),3,30)', devAll.length > 0 && bad.length === 0, `devour×${devAll.length} 全对（首例 mv=${devAll[0] && devAll[0].mv} gain=${devAll[0] && devAll[0].gain} drops=${devAll[0] && devAll[0].drops}）`)
await writeFile(EVID + '/bot-evidence.json', JSON.stringify({ agg: { comp: { k: agg.comp.k, d: agg.comp.d, dash: agg.comp.dash, avgT: avgT(agg.comp) }, bal: { k: agg.bal.k, d: agg.bal.d, dash: agg.bal.dash, avgT: avgT(agg.bal) }, cas: { k: agg.cas.k, d: agg.cas.d, dash: agg.cas.dash, avgT: avgT(agg.cas) } }, eats, devours: devAll.length, bad: bad.length }, null, 2))
console.log(`\n${failed === 0 ? 'QA1-BOT OK' : 'QA1-BOT FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
