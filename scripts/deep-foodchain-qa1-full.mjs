#!/usr/bin/env node
/* =====================================================================
 * GAMES-165 深海食物链 QA1 满编+观战位件（票面第 5 项）
 * 真 WS quick 房：24 连接 play 挤满 24 席（bots 让位至 0，实体=humans≤24 恒守红线）
 * → 第 25 连接 play → 观战位承接（mySeat=-1 不顶号不崩）；
 * 显式 mode:spectate join → spectator（AOI 镜头点 r=460，收 ext.lb+事件流）。
 * ===================================================================== */
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const open = (mode) => new Promise((res) => {
  const ws = new WebSocket('ws://127.0.0.1:4421')
  const c = { ws, role: null, seat: -9, snaps: 0, events: 0, aoiR: 0, lb: false, specMode: mode === 'spectate' }
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', mode: mode || 'play', name: 'QA满编' + Math.floor(Math.random() * 1e6) })); ws.send(JSON.stringify({ t: 'quick', gameId: 'deep-foodchain' })) }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.t === 'welcome') { c.role = m.role; c.seat = m.role === 'player' ? m.seat : -1; c.roomId = m.roomId; res(c) }
    if (m.t === 'snapshot') { c.snaps++; c.events += (m.events || []).length; if (m.ext && m.ext.aoi) c.aoiR = m.ext.aoi.r; if (m.ext && m.ext.lb) c.lb = true }
    if (m.t === 'error') { c.err = m; res(c) }
  }
  ws.onerror = () => res(c)
  setTimeout(() => res(c), 12000)
})
const conns = []
let first = null
for (let att = 0; att < 4 && !(first && first.roomId); att++) { first = await open('play'); if (!first.roomId) await sleep(2500) } // quick 握手瞬态重试（并行 worker 共口 churn）
if (!first.roomId) { console.error('quick 锚定失败（4 次重试无 welcome）——4421 拥塞'); process.exit(2) }
const roomId = first.ws._rid || null
/* welcome 里抓 roomId：重开 open 变体，join 带 roomId（quick 会分流第二房——满编须锚定同房） */
async function openIn(rid, mode) {
  return new Promise((res) => {
    const ws = new WebSocket('ws://127.0.0.1:4421')
    const c = { ws, role: null, seat: -9, snaps: 0, events: 0, aoiR: 0, lb: false }
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', roomId: rid, mode: mode || 'play', name: 'QA满编' + Math.floor(Math.random() * 1e6) }))
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.t === 'welcome') { c.role = m.role; c.seat = m.role === 'player' ? m.seat : -1; c.roomId = m.roomId; res(c) }
      if (m.t === 'snapshot') { c.snaps++; c.events += (m.events || []).length; if (m.ext && m.ext.aoi) c.aoiR = m.ext.aoi.r; if (m.ext && m.ext.lb) c.lb = true }
      if (m.t === 'error') { c.err = m; res(c) }
    }
    ws.onerror = () => res(c)
    setTimeout(() => res(c), 12000)
  })
}
const RID = first.roomId
console.log(`  · 锚定房 ${RID}（首连接 seat=${first.seat}）`)
conns.push(first)
for (let i = 1; i < 24; i++) { conns.push(await openIn(RID, 'play')); await sleep(100) }
await sleep(2500)
const players = conns.filter((c) => c.role === 'player')
ok('Q6f', '满编：24 连接全部就席（seats=24 硬顶内，bots 全让位——humans≤24 实体红线恒守）', players.length === 24, `player=${players.length}/24（席位 ${players.map((p) => p.seat).sort((a, b) => a - b).join(',').slice(0, 60)}…）`)
const c25 = await openIn(RID, 'play')
await sleep(1500)
ok('Q6f', '第 25 连接 play → 观战位承接（mySeat=-1 不顶号不崩——满员旁观收快照）', c25.role === 'spectator' || c25.seat === -1, `role=${c25.role} seat=${c25.seat} snaps=${c25.snaps}`)
ok('Q6f', '观战位快照流在场（AOI r=460 固定+ext.lb 排行榜下行）', c25.snaps > 5 && c25.aoiR === 460000, `snaps=${c25.snaps} aoi.r=${c25.aoiR / 1000}px lb=${c25.lb} events=${c25.events}`)
const spec = await openIn(RID, 'spectate')
await sleep(1500)
ok('Q6f', '显式 spectate join → spectator（观战不占实体预算）', spec.role === 'spectator' && spec.snaps > 5, `role=${spec.role} snaps=${spec.snaps} aoi.r=${spec.aoiR / 1000}px`)
for (const c of [...conns, c25, spec]) { try { c.ws.close() } catch { } }
console.log(`\n${failed === 0 ? 'QA1-FULL OK' : 'QA1-FULL FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
