#!/usr/bin/env node
/* GAMES-168 R1 第三档补针：逾窗（>10s+1拍）resume 拒绝=协议红线（QA1 同式空洞绿纠偏），
 * 逾窗回归走 bot 让位路径（WS join play→托管 bot 让席）——状态延续经实体持久（托管期成长可见）。 */
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => { if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) } else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const GW = process.env.QA_GW || 'http://127.0.0.1:4424'
async function gw(method, path, body) {
  const res = await fetch(GW + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  let json = null; try { json = await res.json() } catch { } return { status: res.status, json }
}
const cr = await gw('POST', '/api/test/room', { gameId: 'deep-foodchain', seed: 20261020, startDelayMs: 300, timeScale: 3, botLevels: [null, 'competitive', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual'] })
const R = { id: cr.json.roomId, seat: cr.json.playerSeat, token: cr.json.token, cur: 0, last: null }
const pull = async () => { const r = await gw('GET', `/api/test/state?roomId=${R.id}&since=${R.cur}`); if (r.json && r.json.ok) { R.cur = r.json.cursor; R.last = r.json.state } return r.json }
await sleep(2000); await pull()
const me = () => R.last && R.last.ents['s' + R.seat]
const m0 = me()
ok('R1c', '起场（API 席就座）', !!m0, `seat=${R.seat} M=${m0 && m0.M}`)
await gw('POST', '/api/test/input', { roomId: R.id, seat: R.seat, op: '$disconnect' })
await sleep(12000) // ts3：逾 10s+1拍宽限 → 席位转 bot 托管
await pull()
const mid = me()
const rr = await gw('POST', '/api/test/input', { roomId: R.id, seat: R.seat, op: '$reconnect', payload: { token: R.token } })
ok('R1c', '逾窗 resume 正确拒绝（复席语义不容降级为顶号——托管转换后 token 已清）', rr.status === 409 && !(rr.json && rr.json.ok), `HTTP ${rr.status} ${rr.json && rr.json.error || ''}`)
ok('R1c', '托管期席位鱼恒活且照常觅食（takeOver=casual）', !!(mid && !mid.dead) && mid.M !== m0.M, `M ${m0.M}→${mid.M} dead=${mid && mid.dead}`)
/* 逾窗回归=WS join 让位路径 */
const ws = new WebSocket('ws://127.0.0.1:4424')
let wl = null, own = null
ws.onopen = () => ws.send(JSON.stringify({ t: 'join', roomId: R.id, mode: 'play', name: 'QA逾窗回归' }))
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === 'welcome') { wl = m; own = 's' + m.seat } if (m.t === 'snapshot' && own) { const f = (m.ents || []).find((e) => e.id === own); if (f) { ws.__f = f } } }
await sleep(3500)
const f = ws.__f
ok('R1c', '逾窗回归走让位路径（WS join play→托管 bot 让席，welcome 就座）', !!(wl && wl.seat >= 0 && f), `seat=${wl && wl.seat}（原席 ${R.seat}）M=${f && f.M} tier=${f && f.t}`)
if (f && mid) ok('R1c', '逾窗回归状态延续（让位席实体 M/tier 延续——托管期成长可见「回来看战果」）', f.M >= mid.M * 0.9 && Number.isInteger(f.t), `M ${mid.M}→${f.M} tier ${mid.tier}→${f.t}`)
try { ws.close() } catch { }
await gw('DELETE', `/api/test/room?roomId=${R.id}`).catch(() => { })
console.log(`\n${failed === 0 ? 'QA2-RECLAIM OK' : 'QA2-RECLAIM FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
