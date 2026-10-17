#!/usr/bin/env node
/* GAMES-168 R1 第三档补针 v2：真 quick 房（非测试房——测试房 WS join 必 room-gone 隔离，GAMES-74 坑）
 * 断线 12s（>10s+1拍）→ 席位转 bot 托管 → WS 再 join 同房 play → 让位就座+实体状态延续。 */
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => { if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) } else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const open = (afterWelcome) => new Promise((res) => {
  const ws = new WebSocket('ws://127.0.0.1:4424')
  const c = { ws, wl: null, seat: -9, fish: null, snaps: 0 }
  ws.onopen = () => afterWelcome(ws)
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.t === 'welcome') { c.wl = m; c.seat = m.role === 'player' ? m.seat : -1; res(c) }
    if (m.t === 'snapshot') { c.snaps++; const f = (m.ents || []).find((e) => e.id === 's' + c.seat); if (f) c.fish = f }
    if (m.t === 'error') { c.err = m; res(c) }
  }
  ws.onerror = () => res(c)
  setTimeout(() => res(c), 10000)
})
const c1 = await open((ws) => { ws.send(JSON.stringify({ t: 'join', mode: 'play', name: 'QA逾窗A' })); ws.send(JSON.stringify({ t: 'quick', gameId: 'deep-foodchain' })) })
ok('R1c', '真 quick 房就座（首连接）', c1.seat >= 0 && !!(c1.wl && c1.wl.roomId), `seat=${c1.seat} room=${c1.wl && c1.wl.roomId}`)
const RID = c1.wl && c1.wl.roomId
await sleep(2500) // 本人鱼起场+觅食
const m0 = c1.fish
try { c1.ws.close() } catch { }   // 断线（与 WS close 同路：goneAt 计时）
await sleep(12000)                // 逾 10s+1拍 → 席位转 bot 托管（casual 继续游+觅食）
const c2 = await open((ws) => ws.send(JSON.stringify({ t: 'join', roomId: RID, mode: 'play', name: 'QA逾窗回归' })))
await sleep(2500)
ok('R1c', '逾窗回归让位就座（WS join play→托管 bot 让席，非顶号非旁观）', c2.seat >= 0 && !!c2.fish, `seat=${c2.seat}（原席 ${c1.seat}）role=${c2.wl && c2.wl.role}`)
if (c2.fish && m0) ok('R1c', '回归席实体状态延续（M/tier 在场——托管期世界照常运转）', c2.fish.M >= 20 && Number.isInteger(c2.fish.t), `M ${m0.M}→${c2.fish.M} tier=${c2.fish.t} snaps=${c2.snaps}`)
try { c2.ws.close() } catch { }
console.log(`\n${failed === 0 ? 'QA2-RECLAIM2 OK' : 'QA2-RECLAIM2 FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
