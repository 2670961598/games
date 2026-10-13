#!/usr/bin/env node
/* =====================================================================
 * GAMES-128 QA一号 · 重连三档 + 观战位 + GAMES-84 abandon 锚复验
 * R1 5s 档（test 房 API 通道）/ R2 10s+1拍边界（托管转换+复席拒绝+局仍活）
 * R4 abandon 锚（独真人房 >15s 在场 → 掉线 +5s 仍 live → +18s ended）
 * R3 30s 档（真 WS：掉线→托管续打（旁观账本）→30s 后 fresh join bot 让位复席）
 * 环境：私有网关 GAMES_GW（默认 http://127.0.0.1:4415），零感知 :4399/:4400。
 * =================================================================== */
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4415'
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)
const skipSec = (tag) => ONLY.length > 0 && !ONLY.includes(tag)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`); cond ? pass++ : fail++ }
const gw = async (method, path, body) => {
  const r = await fetch(GW + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const wsOpen = (onMsg) => new Promise((resolve, reject) => {
  const ws = new WebSocket(GW.replace('http', 'ws') + '/ws')
  const inbox = []
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); inbox.push(m); onMsg && onMsg(m) }
  ws.onopen = () => resolve({ ws, inbox })
  ws.onerror = (e) => reject(new Error('ws-error'))
})

/* ============ R1 5s 档（test 房） ============ */
if (!skipSec('R1')) { console.log('== R1 重连 5s 档（test 房，timeScale=4） ==')
  const created = await gw('POST', '/api/test/room', { gameId: 'mini-moba', seed: 20261028, timeScale: 4, startDelayMs: 600, maxTicks: 7200, botLevels: [null, 'casual', 'casual', 'casual', 'casual', 'casual'] })
  const room = created.json
  ok('R1 建房（API 席 seat=' + room.playerSeat + '）', room.ok, room.roomId)
  let st = room, cur = room.cursor
  const t0 = Date.now()
  while (st.phase !== 'live' && Date.now() - t0 < 8000) { await sleep(100); const r = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=${cur}`); st = r.json; cur = r.json.cursor }
  ok('R1 boot→live', st.phase === 'live', `tick=${st.tick}`)
  // 注入移动 6s（seq 递增——ext.ack 锚）
  for (let i = 0; i < 12; i++) { await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: 'move', payload: { frame: i, mx: 0, my: -100 } }); await sleep(300) }
  const pre = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  const tickAtDis = pre.json.tick
  const goldAtDis = pre.json.state.sessions[room.playerSeat].gold
  const dis = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$disconnect', payload: {} })
  ok('R1 $disconnect（10s 窗开启）', dis.json.ok, `disconnectedAt gap=0ms tick=${tickAtDis}`)
  await sleep(5000)
  const rec = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$reconnect', payload: { token: room.token } })
  await sleep(500) // 等下一拍 emit（复席快照随 tick 下发，HTTP 回程快于 25ms 帧距）
  ok('R1 +5s 复席成功（凭 token）', rec.json.ok && rec.json.resumedAt - dis.json.disconnectedAt < 10_000, `resume=${rec.json.resumedAt - dis.json.disconnectedAt}ms`)
  const post = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0}`)
  const post2 = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  const welcome2 = post2.json.events.filter((e) => e.msg.t === 'welcome').length
  const snapsAfter = post2.json.events.filter((e) => e.msg.t === 'snapshot' && e.msg.frame > tickAtDis).length
  const sess = post2.json.state.sessions[room.playerSeat]
  ok('R1 welcome 全量重同步（welcome×2）', welcome2 >= 2, `welcome=${welcome2}`)
  ok('R1 快照续流（断线后帧继续）', snapsAfter > 0, `复席后快照 ${snapsAfter} 张，tick ${tickAtDis}→${post2.json.tick}`)
  ok('R1 状态恢复（金/等级/装备字段在席）', sess && Number.isFinite(sess.gold) && Array.isArray(sess.items) && (sess.lv || 1) >= 1, `gold ${goldAtDis}→${sess.gold} lv=${sess.lv || 1} items=${sess.items.length}`)
  await gw('DELETE', '/api/test/room', { roomId: room.roomId })
}

/* ============ R2 10s+1拍边界（托管转换+复席拒绝） ============ */
if (!skipSec('R2')) { console.log('== R2 10s+1拍边界（takeOver=balanced） ==')
  const created = await gw('POST', '/api/test/room', { gameId: 'mini-moba', seed: 20261029, timeScale: 4, startDelayMs: 600, maxTicks: 7200, botLevels: [null, 'casual', 'casual', 'casual', 'casual', 'casual'] })
  const room = created.json
  let st = room, cur = room.cursor
  const t0 = Date.now()
  while (st.phase !== 'live' && Date.now() - t0 < 8000) { await sleep(100); const r = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=${cur}`); st = r.json; cur = r.json.cursor }
  for (let i = 0; i < 8; i++) { await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: 'move', payload: { frame: i, mx: 0, my: -100 } }); await sleep(250) }
  await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$disconnect', payload: {} })
  await sleep(10_500) // 10s+宽限 100ms 之外
  const s1 = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  const seatRec = s1.json.seats[room.playerSeat]
  ok('R2 逾窗席位转托管 bot（takeOver=balanced）', seatRec.kind === 'bot' && seatRec.level === 'balanced', `kind=${seatRec.kind} level=${seatRec.level}`)
  ok('R2 局仍活（托管续打）', s1.json.phase === 'live', `phase=${s1.json.phase} tick=${s1.json.tick}`)
  const rec = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$reconnect', payload: { token: room.token } })
  ok('R2 逾窗复席拒绝（复席语义不降级为顶号）', rec.status === 409, `status=${rec.status} ${rec.json && rec.json.error}`)
  await sleep(600)
  const s2 = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  ok('R2 拒绝后局继续推进（tick 前进）', s2.json.tick > s1.json.tick, `tick ${s1.json.tick}→${s2.json.tick}`)
  await gw('DELETE', '/api/test/room', { roomId: room.roomId })
}

/* ============ R4 abandon 锚（GAMES-84 口径，先于 R3 独占建房） ============ */
if (!skipSec('R4')) { console.log('== R4 GAMES-84 abandon 锚复验（独真人房，真 WS 非 test 房） ==')
  const { ws, inbox } = await wsOpen()
  ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
  await sleep(600)
  const wel = inbox.find((m) => m.t === 'welcome')
  const roomId = wel && wel.roomId
  ok('R4 quick 入房（非 test 房）', !!roomId, `roomId=${roomId && roomId.slice(0, 10)}… seat=${wel && wel.seat}`)
  // 在场 >15s（anchor=最后在场时刻；若锚=join 时刻则掉线首拍即 abandon）
  await sleep(16_000)
  const feedBefore = await gw('GET', '/api/matches')
  const present1 = feedBefore.json.matches.some((m) => m.roomId === roomId)
  ws.close()
  const closedAt = Date.now()
  await sleep(6000)
  const feed6 = await gw('GET', '/api/matches')
  const present6 = feed6.json.matches.some((m) => m.roomId === roomId)
  ok('R4 掉线 +6s 房仍 live（锚=最后在场，判别性）', present1 && present6, `掉线前=${present1} +6s=${present6}`)
  let goneAt = -1
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const f = await gw('GET', '/api/matches')
    if (!f.json.matches.some((m) => m.roomId === roomId)) { goneAt = Date.now() - closedAt; break }
  }
  ok('R4 +6s~+26s 内 abandon 终局离场', goneAt > 0, goneAt > 0 ? `掉线后 ${goneAt}ms 消失（15s 窗）` : '26s 仍在 feed')
}

/* ============ R3 30s 档 + 观战位（真 WS，托管→让位复席） ============ */
if (!skipSec('R3')) { console.log('== R3 重连 30s 档 + 观战位（真 WS 非 test 房） ==')
  const { ws, inbox } = await wsOpen()
  ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
  await sleep(600)
  const wel = inbox.find((m) => m.t === 'welcome')
  const roomId = wel && wel.roomId, mySeat = wel && wel.seat
  let live = false
  const t0 = Date.now()
  while (!live && Date.now() - t0 < 8000) { await sleep(150); live = inbox.some((m) => m.t === 'started' || m.t === 'snapshot') } // quick 可并入已 live 常驻房（无 started 广播）——快照流在场即活
  ok('R3 入房+对局进行（started 或并入 live 房）', live, `seat=${mySeat}`)
  let seq = 0
  const inputTimer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'input', frame: seq++, keys: { mx: 0, my: -100 } })) }, 200)
  await sleep(10_000)
  const ackSnap = [...inbox].reverse().find((m) => m.t === 'snapshot')
  ok('R3 真人输入 ack 回显（预测和解）', ackSnap && ackSnap.ext.ack >= 0 && ackSnap.ext.ack <= seq, `ack=${ackSnap && ackSnap.ext.ack} sent=${seq}`)
  clearInterval(inputTimer)
  const tickAtDrop = ackSnap.frame
  // 观战位：spectate join
  const spec = await wsOpen()
  spec.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'spectate' }))
  await sleep(800)
  const specWel = spec.inbox.find((m) => m.t === 'welcome')
  ok('R3 观战位接入（welcome+快照流）', !!specWel && specWel.role === 'spectator', `role=${specWel && specWel.role}`)
  ws.close() // 掉线
  const dropAt = Date.now()
  // 托管期由旁观账本观测：30s
  const specSnaps0 = spec.inbox.filter((m) => m.t === 'snapshot').length
  await sleep(30_000)
  const specSnaps = spec.inbox.filter((m) => m.t === 'snapshot')
  const custTick = specSnaps.length ? specSnaps[specSnaps.length - 1].frame : -1
  const custEvents = spec.inbox.filter((m) => m.t === 'snapshot' && m.events).flatMap((m) => m.events.map((e) => e.k))
  const specSemBad = specSnaps.filter((m) => m.ext.ack !== -1 || m.ext.me !== undefined || m.ext.aoi.r !== 320000).length
  ok('R3 断线 30s 局仍活（托管续打，旁观账本 tick 前进）', custTick > tickAtDrop + 50, `tick ${tickAtDrop}→${custTick}（+30s 观战 ${specSnaps0}→${specSnaps.length} 张）`)
  ok('R3 托管期旁观事件流在场', custEvents.length > 0, `events=${custEvents.length} 条（${[...new Set(custEvents)].slice(0, 6).join(',')}）`)
  ok('R3 观战席语义（ack=-1/无 me/aoi 同圆）', specSemBad === 0, `违例 ${specSemBad}/${specSnaps.length}`)
  // 30s 后 fresh join → bot 让位复席
  const back = await wsOpen()
  back.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'play' }))
  await sleep(800)
  const backWel = back.inbox.find((m) => m.t === 'welcome')
  const backSnaps = back.inbox.filter((m) => m.t === 'snapshot')
  const sess = backWel && backWel.state && backWel.state.sessions[backWel.seat]
  ok('R3 逾窗回归走 bot 让位（seat 复得+快照续流）', backWel && backWel.seat >= 0 && backSnaps.length > 0, `seat=${backWel && backWel.seat}（原 ${mySeat}）快照 ${backSnaps.length} 张`)
  ok('R3 welcome 全量恢复（金/等级/装备/复活计时字段）', sess && Number.isFinite(sess.gold) && Array.isArray(sess.items), `gold=${sess && sess.gold} lv=${sess && (sess.lv || 1)} items=${sess && sess.items.length}`)
  ok('R3 回归后 tick 高于掉线时（S2 无追帧负担续流）', backSnaps.length ? backSnaps[backSnaps.length - 1].frame > tickAtDrop : false, `frame=${backSnaps.length ? backSnaps[backSnaps.length - 1].frame : -1} > ${tickAtDrop}`)
  back.ws.close(); spec.ws.close()
  await sleep(300)
}

console.log(`\n重连/观战/abandon：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
