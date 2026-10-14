#!/usr/bin/env node
/* =====================================================================
 * GAMES-132 QA二号 · 延迟对照 + 重连三档 + 满员旁观 + feed 新鲜度
 * D1 200ms 延迟对照 3+3 局（TCP 代理垫 100ms×2 单向；quick 真人 WS：
 *    ext.ack 预测和解锚——ack 滞后/单调性/全量快照退化比/拒绝数）
 * D2 重连三档：5s 全测（test 房 API）+10s 逾窗拒绝+30s 托管让位（真 WS）
 *    + GAMES-84 abandon 锚复验（独真人房 15s 窗）
 * D3 满员与旁观：6 真人满员+第 7 人 spectate+第 8 人 play 满员兜底旁观
 * D4 feed 新鲜度两点（elapsedMs 前进+spectators 实时反映）
 * 环境：私有网关 GAMES_GW（默认 http://127.0.0.1:4416），零感知 :4399/:4400。
 * =================================================================== */
import net from 'node:net'
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4416'
const GW_PORT = Number(GW.split(':').pop())
const PROXY_PORT = GW_PORT + 1
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)
const skipSec = (tag) => ONLY.length > 0 && !ONLY.includes(tag)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '（' + detail + '）' : ''}`); cond ? pass++ : fail++ }
const gw = async (method, path, body) => {
  const r = await fetch(GW + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const wsOpen = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket((url || GW).replace('http', 'ws') + '/ws')
  const inbox = []
  ws.onmessage = (ev) => { inbox.push(JSON.parse(ev.data)) }
  ws.onopen = () => resolve({ ws, inbox })
  ws.onerror = () => reject(new Error('ws-error'))
})

/* ---------- TCP 延迟代理（chunk 级单向 100ms 垫 = RTT 200ms） ---------- */
let proxyBytes = 0
const delayProxy = await new Promise((resolve) => {
  const srv = net.createServer((client) => {
    const upstream = net.connect(GW_PORT, '127.0.0.1')
    const pipe = (from, to) => from.on('data', (c) => { proxyBytes += c.length; setTimeout(() => to.writable && to.write(c), 100) })
    pipe(client, upstream); pipe(upstream, client)
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy())
    client.on('error', () => {}); upstream.on('error', () => {})
  })
  srv.listen(PROXY_PORT, '127.0.0.1', () => resolve(srv))
})
const GW_DELAYED = `http://127.0.0.1:${PROXY_PORT}`

/* ============ D1 200ms 延迟对照（3+3 局，quick 真人 WS） ============ */
let rejectedTotal = 0
const runD1Room = async (label, url) => {
  const { ws, inbox } = await wsOpen(url)
  const recvAt = [] // 与 inbox 同长（自接管起逐条对齐）
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    inbox.push(m); recvAt.push(Date.now())
    if (m.t === 'reject' || m.t === 'error') rejectedTotal++
  }
  ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
  const t0 = Date.now()
  while (!inbox.some((m) => m.t === 'welcome') && Date.now() - t0 < 8000) await sleep(120)
  const wel = inbox.find((m) => m.t === 'welcome')
  if (!wel || wel.seat == null || wel.seat < 0) { ws.close(); throw new Error(label + ' 无席（bot 让位未发生）') }
  // 等 live：快照流起且帧在前进（quick 可并入已 live 房，无 started 广播）
  let lastFrame = -1
  const t1 = Date.now()
  while ((lastFrame < 0 || !inbox.some((m) => m.t === 'snapshot' && m.frame > lastFrame)) && Date.now() - t1 < 10000) {
    await sleep(150)
    const snaps0 = inbox.filter((m) => m.t === 'snapshot')
    if (snaps0.length) lastFrame = snaps0[snaps0.length - 1].frame
  }
  const sentAt = {} // seq → 发送墙钟（ack 滞后=预测窗重放成本，ms 级分辨率）
  const sentAtFrame = {}
  let seq = 0, rejected = 0
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    inbox.push(m); recvAt.push(Date.now())
    if (m.t === 'snapshot') lastFrame = m.frame
    if (m.t === 'reject' || m.t === 'error') { rejected++; rejectedTotal++ }
  }
  const timer = setInterval(() => {
    if (ws.readyState !== 1) return
    const dir = seq % 2 ? { mx: 80, my: -60 } : { mx: -60, my: 80 } // 变向移动：预测误差可见
    sentAt[seq] = Date.now(); sentAtFrame[seq] = lastFrame
    ws.send(JSON.stringify({ t: 'input', frame: seq++, keys: dir }))
  }, 200)
  const playMs = 12_000
  await sleep(playMs)
  clearInterval(timer)
  await sleep(200) // 末批 ack 回显
  const snaps = [], snapAt = []
  inbox.forEach((m, i) => { if (m.t === 'snapshot') { snaps.push(m); snapAt.push(recvAt[i]) } })
  ws.close()
  return { label, wel, snaps, snapAt, sentAt, sentAtFrame, sentSeq: seq, rejected, playMs }
}
const d1Stats = (r) => {
  const frames = r.snaps.map((s) => s.frame)
  let monoBad = 0; for (let i = 1; i < frames.length; i++) if (frames[i] < frames[i - 1]) monoBad++
  const lags = [], ackSeq = []
  let ackJump = 0, ackBeyond = 0
  r.snaps.forEach((s, i) => {
    const a = s.ext && s.ext.ack
    if (a == null || a < 0) return
    if (ackSeq.length && a < ackSeq[ackSeq.length - 1]) ackJump++
    if (a > r.sentSeq) ackBeyond++
    ackSeq.push(a)
    if (r.sentAt[a] != null) lags.push(r.snapAt[i] - r.sentAt[a]) // 收到该快照的墙钟 - ack 序发送墙钟
  })
  const fulls = r.snaps.filter((s) => s.full).length
  const mean = (xs) => xs.length ? +(xs.reduce((x, y) => x + y, 0) / xs.length).toFixed(1) : -1
  return { frames, monoBad, lags, lagMean: mean(lags), lagMax: lags.length ? Math.max(...lags) : -1, fulls, ackJump, ackBeyond, acks: ackSeq.length }
}
const d1Results = []
if (!skipSec('D1')) { console.log('== D1 200ms 延迟对照（3+3 局；代理单向 100ms；quick 真人 WS；对比 QA1 基线） ==')
  const arms = []
  for (let i = 0; i < 6; i++) arms.push(i % 2 === 0 ? 'delay' : 'direct')
  for (const arm of arms) {
    const url = arm === 'delay' ? GW_DELAYED : GW
    const r = await runD1Room(`${arm}`, url)
    const st = d1Stats(r)
    d1Results.push({ arm, st })
    console.log(`  局[${arm}] seat=${r.wel.seat} snaps=${r.snaps.length} acks=${st.acks} lagMean=${st.lagMean}ms lagMax=${st.lagMax}ms fulls=${st.fulls}/${r.snaps.length} monoBad=${st.monoBad} ackJump=${st.ackJump} ackBeyond=${st.ackBeyond} rejected=${r.rejected}`)
    d1Results[d1Results.length - 1].dump = { snaps: r.snaps.length, acks: st.acks, lagMean: st.lagMean, lagMax: st.lagMax, fulls: st.fulls, monoBad: st.monoBad, ackJump: st.ackJump, ackBeyond: st.ackBeyond, rejected: r.rejected, frameFirst: st.frames[0], frameLast: st.frames[st.frames.length - 1] }
  }
  const agg = (arm) => {
    const rs = d1Results.filter((x) => x.arm === arm)
    const lagMean = +(rs.reduce((a, x) => a + x.st.lagMean, 0) / rs.length).toFixed(1)
    const lagMax = Math.max(...rs.map((x) => x.st.lagMax))
    const fullR = rs.reduce((a, x) => a + x.st.fulls, 0)
    const snapsN = rs.reduce((a, x) => a + x.st.frames.length, 0)
    const monoBad = rs.reduce((a, x) => a + x.st.monoBad, 0)
    const ackJump = rs.reduce((a, x) => a + x.st.ackJump, 0)
    const ackBeyond = rs.reduce((a, x) => a + x.st.ackBeyond, 0)
    const adv = rs.reduce((a, x) => a + (x.st.frames[x.st.frames.length - 1] - x.st.frames[0]), 0)
    return { lagMean, lagMax, fullR, snapsN, monoBad, ackJump, ackBeyond, adv }
  }
  const D = agg('delay'), B = agg('direct')
  const rejTotal = rejectedTotal
  const { writeFileSync } = await import('node:fs')
  writeFileSync('/tmp/moba132-d1.json', JSON.stringify(d1Results.map((x) => x.dump), null, 1))
  ok('D1 双臂各 3 局 quick 入房（bot 让位给席）', d1Results.length === 6 && d1Results.every((x) => x.arm), `6 局 seat 均得`)
  ok('D1 延迟下零拒绝零错误（单连接保序）', rejTotal === 0, `reject/error=${rejTotal}`)
  ok('D1 快照帧单调前进（延迟不乱序）', D.monoBad === 0 && B.monoBad === 0, `乱序 delay=${D.monoBad} direct=${B.monoBad}`)
  ok('D1 ack 单调且不超发（协议正确性）', D.ackJump === 0 && B.ackJump === 0 && D.ackBeyond === 0 && B.ackBeyond === 0, `回跳 ${D.ackJump}/${B.ackJump} 越界 ${D.ackBeyond}/${B.ackBeyond}`)
  ok('D1 延迟臂 ack 回显滞后可观测且受控（RTT 200ms，<600ms 帽）', D.lagMean > B.lagMean + 80 && D.lagMean < 600 && D.lagMax < 1000, `delay mean=${D.lagMean}ms max=${D.lagMax}ms vs direct mean=${B.lagMean}ms max=${B.lagMax}ms`)
  ok('D1 二式快照不因延迟退化（full 比 <5% 双臂）', D.snapsN > 0 && B.snapsN > 0 && D.fullR / D.snapsN < 0.05 && B.fullR / B.snapsN < 0.05, `delay ${D.fullR}/${D.snapsN} direct ${B.fullR}/${B.snapsN}`)
  ok('D1 服务端权威节奏不受延迟拖累（tick 100ms 档，前进≈墙钟）', D.adv > 3 * 11000 / 100 * 0.8 && B.adv > 3 * 11000 / 100 * 0.8, `delay +${Math.round(D.adv)} direct +${Math.round(B.adv)} tick`)
}

/* ============ D2a 5s 档全测（test 房 API 通道） ============ */
if (!skipSec('D2a')) { console.log('== D2a 重连 5s 档全测（test 房，timeScale=4） ==')
  const created = await gw('POST', '/api/test/room', { gameId: 'mini-moba', seed: 20261101, timeScale: 4, startDelayMs: 600, maxTicks: 7200, botLevels: [null, 'casual', 'casual', 'casual', 'casual', 'casual'] })
  const room = created.json
  let st = room, cur = room.cursor
  const t0 = Date.now()
  while (st.phase !== 'live' && Date.now() - t0 < 8000) { await sleep(100); const r = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=${cur}`); st = r.json; cur = r.json.cursor }
  ok('D2a boot→live', st.phase === 'live', `tick=${st.tick}`)
  for (let i = 0; i < 8; i++) { await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: 'move', payload: { frame: i, mx: 40, my: -90 } }); await sleep(250) }
  const pre = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  const tickAtDis = pre.json.tick
  const dis = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$disconnect', payload: {} })
  ok('D2a $disconnect', dis.json.ok, `tick=${tickAtDis}`)
  await sleep(5200)
  const rec = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$reconnect', payload: { token: room.token } })
  await sleep(500)
  const gap = rec.json.resumedAt - dis.json.disconnectedAt
  ok('D2a +5s 复席成功（10s 窗内，凭 token）', rec.json.ok && gap < 10_000, `resume gap=${gap}ms`)
  const post = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  const evs = post.json.events.map((e) => e.msg)
  const welcomeAfter = evs.filter((m) => m.t === 'welcome').length
  const fullAfter = evs.filter((m) => m.t === 'snapshot' && m.full && m.frame > tickAtDis).length
  const sess = post.json.state && post.json.state.sessions[room.playerSeat]
  ok('D2a 复席后全量重同步（welcome 重发+断点后 full 快照）', welcomeAfter >= 1 && fullAfter >= 1, `welcome=${welcomeAfter} full@>dis=${fullAfter}`)
  ok('D2a 会话字段恢复（gold/等级有限值）', sess && Number.isFinite(sess.gold), `gold=${sess && sess.gold}`)
  const live2 = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=${post.json.cursor}`)
  ok('D2a 复席后局续进（tick 高于断点；若终局则 phase=ended 而非冻结）', live2.json.tick > tickAtDis || live2.json.phase === 'ended', `tick ${tickAtDis}→${live2.json.tick} phase=${live2.json.phase}`)
}

/* ============ D2b 10s 档（逾窗：复席拒绝+托管+局仍活） ============ */
if (!skipSec('D2b')) { console.log('== D2b 重连 10s 档（逾窗拒绝→托管，局仍活） ==')
  const created = await gw('POST', '/api/test/room', { gameId: 'mini-moba', seed: 20261102, timeScale: 4, startDelayMs: 600, maxTicks: 7200, botLevels: [null, 'casual', 'casual', 'casual', 'casual', 'casual'] })
  const room = created.json
  let st = room, cur = room.cursor
  const t0 = Date.now()
  while (st.phase !== 'live' && Date.now() - t0 < 8000) { await sleep(100); const r = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=${cur}`); st = r.json; cur = r.json.cursor }
  const dis = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$disconnect', payload: {} })
  ok('D2b $disconnect', dis.json.ok, '')
  await sleep(10_600) // 逾 10s+1 拍重连窗（GAMES-63 统一口径）
  const rec = await gw('POST', '/api/test/input', { roomId: room.roomId, seat: room.playerSeat, op: '$reconnect', payload: { token: room.token } })
  ok('D2b 逾窗复席被拒（窗口=10s+1拍）', rec.json && rec.json.ok === false, JSON.stringify(rec.json).slice(0, 80))
  const s1 = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=0`)
  await sleep(1200)
  const s2 = await gw('GET', `/api/test/state?roomId=${room.roomId}&since=${s1.json.cursor}`)
  ok('D2b 托管接管局仍活（tick 续进）', s2.json.tick > s1.json.tick, `${s1.json.tick}→${s2.json.tick}`)
}

/* ============ D2c 30s 档（真 WS：托管续打→bot 让位复席+观战位） ============ */
if (!skipSec('D2c')) { console.log('== D2c 重连 30s 档（托管续打+让位复席+观战位，真 WS） ==')
  const { ws, inbox } = await wsOpen()
  ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
  await sleep(600)
  const wel = inbox.find((m) => m.t === 'welcome')
  const roomId = wel && wel.roomId, mySeat = wel && wel.seat
  ok('D2c quick 入房', !!wel, `seat=${mySeat}`)
  let seq = 0
  const timer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'input', frame: seq++, keys: { mx: 0, my: -100 } })) }, 200)
  await sleep(3000)
  const ackSnap = [...inbox].reverse().find((m) => m.t === 'snapshot')
  ok('D2c 真人输入 ack 回显', ackSnap && ackSnap.ext.ack >= 0 && ackSnap.ext.ack <= seq, `ack=${ackSnap && ackSnap.ext.ack} sent=${seq}`)
  clearInterval(timer)
  const tickAtDrop = ackSnap.frame
  const spec = await wsOpen()
  spec.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'spectate' }))
  await sleep(800)
  const specWel = spec.inbox.find((m) => m.t === 'welcome')
  ok('D2c 观战位接入', !!specWel && specWel.role === 'spectator', `role=${specWel && specWel.role}`)
  ws.close()
  await sleep(30_000)
  const specSnaps = spec.inbox.filter((m) => m.t === 'snapshot')
  const specSemBad = specSnaps.filter((m) => m.ext.ack !== -1 || m.ext.me !== undefined).length
  ok('D2c 断线 30s 托管续打（旁观账本 tick 前进）', specSnaps.length && specSnaps[specSnaps.length - 1].frame > tickAtDrop + 50, `tick ${tickAtDrop}→${specSnaps.length ? specSnaps[specSnaps.length - 1].frame : -1}`)
  ok('D2c 观战席语义（ack=-1 无 me）', specSemBad === 0, `违例 ${specSemBad}/${specSnaps.length}`)
  const back = await wsOpen()
  back.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'play' }))
  await sleep(800)
  const backWel = back.inbox.find((m) => m.t === 'welcome')
  const backSnaps = back.inbox.filter((m) => m.t === 'snapshot')
  const sess = backWel && backWel.state && backWel.state.sessions[backWel.seat]
  ok('D2c 逾窗回归走 bot 让位复席', backWel && backWel.seat >= 0 && backSnaps.length > 0, `seat=${backWel && backWel.seat}（原 ${mySeat}）快照 ${backSnaps.length} 张`)
  ok('D2c 全量恢复（gold 有限值+tick 高于掉线时）', sess && Number.isFinite(sess.gold) && backSnaps.length && backSnaps[backSnaps.length - 1].frame > tickAtDrop, `gold=${sess && sess.gold}`)
  back.ws.close(); spec.ws.close()
  await sleep(300)
}

/* ============ D3 满员与旁观 + D4 feed 新鲜度 ============ */
if (!skipSec('D3')) { console.log('== D3 满员旁观（6 真人满员+第 7 观战+第 8 满员兜底）+ D4 feed 新鲜度 ==')
  const conns = []
  const first = await wsOpen()
  first.ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
  await sleep(600)
  const wel = first.inbox.find((m) => m.t === 'welcome')
  const roomId = wel && wel.roomId
  ok('D3 首连 quick 建房', !!wel, `roomId=${roomId} seat=${wel && wel.seat}`)
  conns.push(first)
  for (let i = 1; i < 6; i++) {
    const c = await wsOpen()
    c.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'play' }))
    await sleep(300)
    conns.push(c)
  }
  const seats = [wel.seat, ...conns.slice(1).map((c) => { const w = c.inbox.find((m) => m.t === 'welcome'); return w && w.seat })]
  ok('D3 6 真人满员（6 席互异 0-5）', new Set(seats).size === 6 && seats.every((s) => s >= 0 && s <= 5), `seats=${seats.join(',')}`)
  const feed1 = await gw('GET', '/api/matches')
  const m1 = feed1.json.matches.find((m) => m.roomId === roomId)
  ok('D4 feed 第 1 点：满员房在 feed（humans=6/joinable=false）', m1 && m1.humans === 6 && m1.joinable === false, `humans=${m1 && m1.humans} elapsed=${m1 && m1.elapsedMs}ms`)
  const feed1At = Date.now(), elapsed1 = m1 && m1.elapsedMs
  const seventh = await wsOpen()
  seventh.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'spectate' }))
  await sleep(800)
  const specWel = seventh.inbox.find((m) => m.t === 'welcome')
  const specSnaps = seventh.inbox.filter((m) => m.t === 'snapshot')
  ok('D3 第 7 人 spectate 入席观战', specWel && specWel.role === 'spectator' && specSnaps.length > 0, `role=${specWel && specWel.role} 快照 ${specSnaps.length} 张`)
  const eighth = await wsOpen()
  eighth.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'play' }))
  await sleep(800)
  const eigWel = eighth.inbox.find((m) => m.t === 'welcome')
  const eigSnaps = eighth.inbox.filter((m) => m.t === 'snapshot')
  ok('D3 第 8 人 play 撞满员兜底旁观（无可让 bot）', eigWel && eigWel.role === 'spectator' && eigWel.seat == null && eigSnaps.length > 0, `role=${eigWel && eigWel.role} seat=${eigWel && eigWel.seat} 快照 ${eigSnaps.length} 张`)
  const feed2 = await gw('GET', '/api/matches')
  const m2 = feed2.json.matches.find((m) => m.roomId === roomId)
  const wallDelta = Date.now() - feed1At
  ok('D4 feed 第 2 点：新鲜（elapsedMs 前进≈墙钟+spectators=2 实时）', m2 && m2.spectators === 2 && Math.abs((m2.elapsedMs - elapsed1) - wallDelta) < 5000, `Δelapsed=${m2 && m2.elapsedMs - elapsed1}ms vs 墙钟 ${wallDelta}ms spectators=${m2 && m2.spectators}`)
  seventh.ws.close(); eighth.ws.close()
  await sleep(400)
  const feed3 = await gw('GET', '/api/matches')
  const m3 = feed3.json.matches.find((m) => m.roomId === roomId)
  ok('D4 旁观离场即时反映（spectators 回 0）', m3 && m3.spectators === 0, `spectators=${m3 && m3.spectators}`)
  for (const c of conns) c.ws.close()
  await sleep(300)
}

/* ============ D2d GAMES-84 abandon 锚复验（独真人房） ============ */
if (!skipSec('D2d')) { console.log('== D2d abandon 锚复验（独真人 quick 房：在场>15s→掉线→+5s 仍 live→≤+26s 离场） ==')
  const { ws, inbox } = await wsOpen()
  ws.send(JSON.stringify({ t: 'quick', gameId: 'mini-moba' }))
  await sleep(600)
  const wel = inbox.find((m) => m.t === 'welcome')
  const roomId = wel && wel.roomId
  ok('D2d 独真人 quick 房建立', !!wel, roomId)
  await sleep(16_000) // 在场 >15s（GAMES-84 锚：在场超 15s 才进 abandon 判定窗）
  const feed0 = await gw('GET', '/api/matches')
  ok('D2d 掉线前在 feed', feed0.json.matches.some((m) => m.roomId === roomId), '')
  ws.close()
  const closedAt = Date.now()
  await sleep(6000)
  const f6 = await gw('GET', '/api/matches')
  ok('D2d 掉线 +6s 房仍 live（锚=最后在场，判别性）', f6.json.matches.some((m) => m.roomId === roomId), '')
  let goneAt = -1
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const f = await gw('GET', '/api/matches')
    if (!f.json.matches.some((m) => m.roomId === roomId)) { goneAt = Date.now() - closedAt; break }
  }
  ok('D2d +6s~+26s 内 abandon 终局离场', goneAt > 0, goneAt > 0 ? `掉线后 ${goneAt}ms 消失（15s 窗）` : '26s 仍在 feed')
}

delayProxy.close()
console.log(`\nQA二号 net：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
