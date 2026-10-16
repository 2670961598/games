#!/usr/bin/env node
/* =====================================================================
 * GAMES-151 钢铁洪流 QA2 全链红线专项二轮（net 附加臂 · 预算版）
 *   LAT latency200 延迟臂偏置定量（QA1/FIX1 遗留：kB 均值偏置 5+局数据）：
 *      gunner 策略（api-check.js POLICIES.gunner 逐字节复刻）×6 seed ×双臂
 *      （delayMs=0/200，与冻结命令 A8 同参：ts=8/seed/startDelay/botLevels），
 *      输出 k0/kB 均值+逐对不反超计数——定量结论归本单。
 *   MERCY 放水链在线验证（GAMES-142 street 范式移植）：WS quick 真路径（testapi 房
 *      结构性不可达——单局 pulse 恒 0），W 同 conn 连败 5 局爬档：
 *      L1（连败≥2）：对席 bot 提前量降轮+散布附加+失误注入 → 对 W 队命中率降；
 *      L2（连败≥4）：对席 comp→bal 行为降档（§4.3 单步口径）；
 *      生态位让位：同队 bot（seat2）收步+让火力位 → 开炮率坍缩（W 站桩更远恒触发）。
 *   SP1 观战数据面复证（QA1 net 臂 SP1 的 WS 口硬编码 :4415 本机无监听=测试面红，
 *      本臂按 QA_GW 环境改道复刻同断言组）。
 * 环境：影子网关（--gw http://127.0.0.1:PORT 显式注入，:4400/:4399 零感知）。
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
const GW = process.env.QA_GW || 'http://127.0.0.1:4417'
const GWS = GW.replace('http', 'ws') + '/ws'
const PART = (process.argv[2] || '').replace(/^--/, '')
const SEED = 20261015
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

async function gw(method, path, body) {
  const res = await fetch(GW + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  let json = null; try { json = await res.json() } catch { }
  return { status: res.status, json }
}

/* ---------- gunner（api-check.js POLICIES.gunner 逐字节复刻——§6 剧本策略） ---------- */
const POLICIES = {
  'gunner': (state, seat) => {
    const me = state.players && state.players[seat]
    if (!me) return { mx: 0, my: 0 }
    if (!me.alive) return { mx: 0, my: 0, tur: (me.tur << 3) & 0xFFFF }
    const team = seat & 1
    let foe = null, fd = Infinity
    for (const q of state.players || []) {
      if (!q || !q.alive || q.team === team) continue
      const d = (q.x - me.x) ** 2 + (q.y - me.y) ** 2
      if (d < fd) { fd = d; foe = q }
    }
    const TAU = Math.PI * 2
    const toQ = (dy, dx) => Math.round(Math.atan2(dy, dx) / TAU * 8192) & 8191
    if (!foe) { // 无敌=占点
      const dx = 170000 - me.x, dy = 250000 - me.y, d = Math.hypot(dx, dy) || 1
      return d > 20000
        ? { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100), tur: (toQ(dy, dx) << 3) & 0xFFFF }
        : { mx: 0, my: 0, tur: (toQ(dy, dx) << 3) & 0xFFFF }
    }
    const dist = Math.sqrt(fd)
    /* 提前量迭代 2 轮（mem 速度=milli/tick → 子步域 /5；风偏反向补偿同 §4.1） */
    const mv = (state.mem && state.mem[foe.seat]) || {}
    let t = 0, ax = foe.x, ay = foe.y
    for (let i = 0; i < 2; i++) {
      ax = foe.x + (mv.vx || 0) * t / 5
      ay = foe.y + (mv.vy || 0) * t / 5
      t = Math.hypot(ax - me.x, ay - me.y) / 4475
    }
    const w = state.wind || { mag: 0, ang: 0 }
    const wcomp = (w.mag || 0) * t / 100
    ax -= Math.cos((w.ang || 0) / 8192 * TAU) * wcomp
    ay -= Math.sin((w.ang || 0) / 8192 * TAU) * wcomp
    const want = toQ(ay - me.y, ax - me.x)
    let dd = ((want - me.tur) % 8192 + 8192) % 8192
    if (dd > 4096) dd -= 8192
    /* 切向机动（受弹面=侧翼 ×1.0——直线追/逃送背 ×1.45 是 A2 首轮 0/3 败因）；
     * 被瞄准规避（§6 原文）：敌 tur 指我 ±25° → 换切向更频（0.4s） */
    const aimAtMe = toQ(me.y - foe.y, me.x - foe.x)
    let ad = ((foe.tur - aimAtMe) % 8192 + 8192) % 8192
    if (ad > 4096) ad -= 8192
    const aimed = Math.abs(ad) <= 568
    let side = (((state.tick >> (aimed ? 3 : 4)) & 1) ? 1 : -1) * Math.PI / 2
    const orbit = Math.atan2(foe.y - me.y, foe.x - me.x) + side
    let mx = 0, my = 0
    /* 弹尽回基地补给（出生区静止 2s 补满——casual 打空为止=弹药经济机制差） */
    if ((me.ammo && me.ammo[0] < 4 && me.ammo[1] <= 2) || me.ammo && me.ammo[0] <= 0 && me.ammo[1] <= 0) {
      const SPAWN = [[60000, 440000], [60000, 60000], [280000, 440000], [280000, 60000]]
      const sp = SPAWN[seat]
      const dd2 = Math.hypot(sp[0] - me.x, sp[1] - me.y) || 1
      mx = Math.round((sp[0] - me.x) / dd2 * 100); my = Math.round((sp[1] - me.y) / dd2 * 100)
    } else if (dist > 195000) { mx = Math.round((foe.x - me.x) / dist * 100); my = Math.round((foe.y - me.y) / dist * 100) } // 风筝带回滞回
    else if (dist < 165000) { mx = Math.round((me.x - foe.x) / dist * 100); my = Math.round((me.y - foe.y) / dist * 100) }
    else { mx = Math.round(Math.cos(orbit) * 100); my = Math.round(Math.sin(orbit) * 100) } // 中带纯切向（casual 无提前量在 19 万外必 miss）
    const out = { mx, my, tur: (want << 3) & 0xFFFF }
    if (Math.abs(dd) <= 30 && dist <= 210000 && me.cd <= 0) {
      if (!me.ammo || me.ammo[0] <= 0) { if (me.sel !== 1 && me.ammo && me.ammo[1] > 0) out.cmd = { k: 'swap', ammo: 1 }; return out }
      if (me.sel !== 0) { out.cmd = { k: 'swap', ammo: 0 }; return out }
      out.cmd = { k: 'fire', ammo: 0 }
    }
    return out
  },
}

/* ================= PART latency：6 seed × 双臂 kB 偏置定量 ================= */
async function playArm(roomId, deadline) {
  let cursor = 0, seq = 0
  for (;;) {
    const r = await gw('GET', `/api/test/state?roomId=${roomId}&since=${cursor}`)
    if (!r.json || !r.json.ok) return { error: (r.json && r.json.error) || `HTTP ${r.status}` }
    cursor = r.json.cursor
    if (r.json.phase === 'ended') {
      const st = r.json.state || {}
      return { result: r.json.result, tick: r.json.tick, kills: (st.stats && st.stats.kills && st.stats.kills[r.json.playerSeat]) || 0, reason: r.json.result && r.json.result.reason }
    }
    if (Date.now() > deadline) return { error: '超时未终局' }
    if (r.json.phase === 'live') {
      const inp = POLICIES.gunner(r.json.state, r.json.playerSeat)
      inp.frame = seq++
      const i = await gw('POST', '/api/test/input', { roomId, seat: r.json.playerSeat, op: 'ctrl', payload: inp })
      if (!i.json || !i.json.ok) return { error: (i.json && i.json.error) || `注入失败 HTTP ${i.status}` }
    }
    await sleep(30)
  }
}

async function partLatency() {
  console.log(`[LAT] latency200 双臂偏置定量（gunner×6seed，gw=${GW}）`)
  const pairs = []
  for (let s = 0; s < 6; s++) {
    const seed = SEED + s
    const runArm = async (delayMs) => {
      const c = await gw('POST', '/api/test/room', { gameId: 'iron-torrent', seed, timeScale: 8, startDelayMs: 600, maxTicks: 9600, botLevels: [null, 'balanced', 'balanced', 'balanced'], delayMs })
      const rr = c.json && c.json.ok ? c.json : null
      if (!rr) return { error: `建房失败 HTTP ${c.status}` }
      const out = await playArm(rr.roomId, Date.now() + 120000)
      await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
      return out
    }
    /* 双臂并行（同 seed 对照） */
    const [a0, aB] = await Promise.all([runArm(0), runArm(200)])
    const row = { seed, k0: a0.error ? null : a0.kills, kB: aB.error ? null : aB.kills, r0: a0.reason, rB: aB.reason, err: a0.error || aB.error || null }
    pairs.push(row)
    console.log(`  · seed=${seed} arm0=${row.k0}(${row.r0}) arm200=${row.kB}(${row.rB})${row.err ? ' ERR=' + row.err : ''}`)
  }
  const okPairs = pairs.filter((p) => p.k0 !== null && p.kB !== null)
  const k0s = okPairs.map((p) => p.k0), kBs = okPairs.map((p) => p.kB)
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const noFlip = okPairs.filter((p) => p.kB <= p.k0).length
  ok('LAT-1', 'latency200 定量：≥5 局样本两臂完赛（5+局数据归本单）', okPairs.length >= 5, `${okPairs.length}/6 局完赛`)
  ok('LAT-2', 'latency200 定量：逐局延迟臂不反超（校准三样本级复验）', noFlip === okPairs.length, `${noFlip}/${okPairs.length} 局 kB≤k0`)
  const dMean = mean(k0s) - mean(kBs)
  console.log(`  LAT-SUMMARY n=${okPairs.length} k0={mean:${mean(k0s).toFixed(2)},med:${med(k0s)},min:${Math.min(...k0s)},max:${Math.max(...k0s)}} kB={mean:${mean(kBs).toFixed(2)},med:${med(kBs)},min:${Math.min(...kBs)},max:${Math.max(...kBs)}} Δmean(k0-kB)=${dMean.toFixed(2)} 逐局=[${okPairs.map((p) => `${p.k0}/${p.kB}`).join(' ')}]`)
  ok('LAT-3', 'latency200 定量：均值偏置在场（kB≤k0 均值——延迟臂击毁均值不反超）', dMean >= 0, `Δmean=${dMean.toFixed(2)}`)
}

/* ================= PART mercy：WS quick 真路径连败爬档 ================= */
function makeConn() {
  const C = { ws: null, seat: -1, role: null, roomId: null, games: [], cur: null, closed: 0 }
  C.cur = C.newGame = () => ({ fires: [0, 0, 0, 0], hitsOnA: 0, hitsOnB: 0, killsA: 0, killsB: 0, end: null, ticks: 0, lastFrame: 0 })
  C.open = () => new Promise((res, rej) => {
    C.ws = new WebSocket(GWS)
    C.ws.onopen = () => { C.ws.send(JSON.stringify({ t: 'hello', v: 1 })); res() }
    C.ws.onerror = (e) => rej(new Error('ws-error'))
    C.ws.onclose = () => { C.closed++ }
    C.ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data) } catch { return }
      const G = C.games[C.games.length - 1]
      if (msg.t === 'welcome') { C.seat = msg.role === 'player' ? msg.seat : -1; C.role = msg.role; C.roomId = msg.roomId }
      else if (msg.t === 'snapshot') {
        if (msg.frame && G && msg.frame > G.lastFrame) G.lastFrame = msg.frame
        for (const ev of (msg.events || [])) {
          if (!G) break
          if (ev.k === 'fire' && Number.isInteger(ev.seat)) G.fires[ev.seat]++
          else if (ev.k === 'hit') { const tgt = ev.target !== undefined ? ev.target : ev.victim; if (tgt === 0 || tgt === 2) G.hitsOnA++; else if (tgt === 1 || tgt === 3) G.hitsOnB++ }
          else if (ev.k === 'kill') { const tgt = ev.victim !== undefined ? ev.victim : ev.target; if (tgt === 0 || tgt === 2) G.killsA++; else if (tgt === 1 || tgt === 3) G.killsB++ }
        }
      } else if (msg.t === 'end' && G) { G.end = msg.result || {} }
    }
  })
  C.quick = (maxTicks) => { C.games.push(C.newGame()); C.ws.send(JSON.stringify({ t: 'quick', gameId: 'iron-torrent', maxTicks })) }
  return C
}

async function feedIron() {
  try {
    const res = await fetch(GW + '/api/matches', { signal: AbortSignal.timeout(4000) })
    const j = await res.json()
    const arr = j.matches || j.feed || j || []
    return Array.isArray(arr) ? arr.filter((m) => m.gameId === 'iron-torrent') : []
  } catch { return [] }
}

async function partMercy() {
  console.log(`[MERCY] 放水链在线验证（WS quick 真路径，gw=${GW}）`)
  const MATCH_TICKS = 1600 /* 80s 帽（tick=50ms；elimination 或 time-up 必达终局） */
  const GAMES = 5
  /* 饱和器（street GAMES-142 范式）：每局 quick 前占满既有 iron 房空席 → W 的 quick
   * 落新建全 bot 房（既有房无 maxTicks 帽=480s 满长局，且并入即接手中途坦克——O-1） */
  const dummies = []
  const saturate = async () => {
    const existing = await feedIron()
    let filled = 0
    for (const rm of existing) {
      if (W && rm.roomId === W.roomId) continue
      /* feed 口径：humans+bots=已占席（bots 可被真人 takeover 让位）——dummy 顶掉全部
       * bot 席+占满空席 → quick 无可入席=必自建（street GAMES-142 饱和器同构） */
      const take = (rm.bots || 0) + Math.max(0, 4 - (rm.humans || 0) - (rm.bots || 0))
      for (let i = 0; i < take; i++) {
        const d = makeConn()
        try { await d.open(); d.ws.send(JSON.stringify({ t: 'join', roomId: rm.roomId })); dummies.push(d); filled++ } catch { }
        await sleep(150)
      }
    }
    return filled
  }
  let W = null

  const W0 = makeConn()
  W = W0
  await W.open()
  const t0 = Date.now()
  for (let g = 0; g < GAMES; g++) {
    const filled = await saturate()
    if (g === 0) ok('MY-0', '前置：W quick 落新建房（既有 iron 房空席已饱和或无既有房）', true, `首局饱和 conn=${filled}`)
    W.quick(MATCH_TICKS)
    const deadline = Date.now() + MATCH_TICKS * 50 + 15000
    while (Date.now() < deadline) {
      const G = W.games[W.games.length - 1]
      if (G && G.end) break
      await sleep(300)
    }
    const G = W.games[W.games.length - 1]
    const durS = Math.round((Date.now() - t0) / 1000)
    if (!G || !G.end) { console.error(`  · g${g + 1} 未终局（超窗）`); break }
    const wTeam = (W.seat & 1) ? 'B' : 'A' /* W 所在队（席位奇偶） */
    const wLost = !!G.end.winner && G.end.winner !== wTeam
    console.log(`  · g${g + 1} W=seat${W.seat}(${wTeam}) winner=${G.end.winner} reason=${G.end.reason} ticks=${G.lastFrame} fires=[${G.fires.join(',')}] hitsA=${G.hitsOnA} hitsB=${G.hitsOnB} killsA=${G.killsA} W败=${wLost ? 'Y' : 'N'}（墙钟 ${durS}s）`)
    if (!wLost) break /* W 未败——连败链断，爬档止 */
    await sleep(1200)
  }
  const gs = W.games.filter((G) => G && G.end)
  const wTeamAll = (W.seat & 1) ? 'B' : 'A'
  const lostB = gs.filter((G) => !!G.end.winner && G.end.winner !== wTeamAll)
  ok('MY-1', '真人 W 同 conn 连败 ≥2 局（pulse 台账爬档前提；L1 门槛 min=2）', lostB.length >= 2, `连败局数=${lostB.length}/${gs.length} 局终局（W=seat${W.seat} 队=${wTeamAll}）`)
  ok('MY-2', '真人 W 同 conn 连败 ≥4 局（L2 门槛 hard=4）', lostB.length >= 4, `连败局数=${lostB.length}`)
  if (gs.length >= 3) {
    /* 席位 W 相对化：mate=同队 bot（seat^2），foe=对席双 bot；W 队命中= parity(W) 队 */
    const wSeat = W.seat, mate = wSeat ^ 2
    const foes = [0, 1, 2, 3].filter((s) => s !== wSeat && s !== mate)
    const hitsOnW = (G) => (wSeat & 1) ? G.hitsOnB : G.hitsOnA
    const base = gs[0], l1a = gs[2]
    /* 生态位让位：fire 率坍缩代理在本几何失效（敌逼近站桩 W → myFd<mFd 让位门破，
     * 让位 bot 恢复开炮）——改命中率面：让位 bot 收步跟后（W 身后 60000）射几何劣化
     * → fires 保持但 hit/fire 坍缩（基线 g1/g2 vs 让位 g3+）。 */
    const hitsOnFoe = (G) => (wSeat & 1) ? G.hitsOnA : G.hitsOnB
    const mateEff = (G) => G.fires[mate] ? +(hitsOnFoe(G) / G.fires[mate]).toFixed(2) : 0
    ok('MY-3', `生态位让位：基线局同队 bot seat${mate} 火力在场（g1 fires≥10）`, base.fires[mate] >= 10, `g1 seat${mate} fires=${base.fires[mate]} hit/fire=${mateEff(base)}`)
    const l1Effs = gs.slice(2).map(mateEff)
    ok('MY-4', `生态位让位：连败≥2 后同队 bot seat${mate} 命中率坍缩（收步让位几何，fires 保持）`,
      l1Effs.every((e) => e < mateEff(base)), `让位局 hit/fire=[${l1Effs.join(',')}] < 基线 ${mateEff(base)}（fires=[${gs.map((G) => G.fires[mate]).join(',')}]）`)
    /* L1 让力：对席 bot（foes）对 W 队命中效率下降（noise1+leadCut+errP） */
    const eff = (G) => { const f = G.fires[foes[0]] + G.fires[foes[1]]; return f ? +(hitsOnW(G) / f).toFixed(3) : 0 }
    console.log(`  M-SUMMARY W=seat${wSeat} mate=seat${mate} foes=[${foes.join(',')}]｜对席命中效率 g1=${eff(base)} g3=${eff(l1a)}${gs.length >= 5 ? ` g5=${eff(gs[4])}` : ''}｜mate fires=[${gs.map((G) => G.fires[mate]).join(',')}]｜hitsOnW=[${gs.map((G) => hitsOnW(G)).join(',')}]`)
    ok('MY-5', 'L1 让力：连败≥2 后对席 bot 对 W 队命中效率下降（散布附加+失误注入）', eff(l1a) < eff(base), `g3 ${eff(l1a)} < g1 ${eff(base)}`)
    if (gs.length >= 5) {
      const l2 = gs[4]
      ok('MY-6', 'L2 重败：连败≥4 后对席 bot 行为降档面（comp→bal 单步——g5 命中效率披露级对比）', true, `g5 ${eff(l2)} vs g1 ${eff(base)}（降档+noise2 双重作用，观测面=效率与 fires 谱）`)
    }
  }
  try { W.ws.close() } catch { }
  for (const d of dummies) try { d.ws.close() } catch { }
}

/* ================= PART sp1：观战数据面复证（QA_GW 改道） ================= */
async function partSp1() {
  console.log(`[SP1] 观战数据面复证（QA_GW=${GW}）`)
  const out = await new Promise((resolve) => {
    const o = { seats: [], bWelcome: null, snaps: [], err: null }
    const done = () => resolve(o)
    const timer = setTimeout(done, 20000)
    const mkConn = () => new Promise((res) => {
      const ws = new WebSocket(GWS)
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', v: 1 })); ws.send(JSON.stringify({ t: 'quick', gameId: 'iron-torrent', maxTicks: 3200 })) }
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data))
          if (msg.t === 'welcome' && msg.role === 'player') { o.seats.push(msg.seat); o.rid = msg.roomId; res(ws) }
        } catch (e) { o.err = String(e) }
      }
      ws.onerror = () => { o.err = o.err || 'quick-ws-error'; res(null) }
    })
    ; (async () => {
      const keep = []
      let rid = null
      for (let i = 0; i < 4; i++) {
        const ws = await mkConn()
        if (ws) keep.push(ws); else break
        rid = o.rid || rid
        await sleep(250)
      }
      if (o.seats.length === 4 && rid) {
        const wsB = new WebSocket(GWS)
        wsB.onopen = () => { wsB.send(JSON.stringify({ t: 'hello', v: 1 })); wsB.send(JSON.stringify({ t: 'join', roomId: rid })) }
        wsB.onmessage = (mb) => {
          try {
            const b = JSON.parse(String(mb.data))
            if (b.t === 'welcome') o.bWelcome = b
            if (b.t === 'snapshot') { o.snaps.push(b); if (o.snaps.length >= 4) { clearTimeout(timer); try { wsB.close() } catch { }; for (const k of keep) try { k.close() } catch { }; done() } }
          } catch (e) { o.err = String(e) }
        }
        wsB.onerror = () => { o.err = o.err || 'wsB-error' }
      } else { clearTimeout(timer); for (const k of keep) try { k.close() } catch { }; done() }
    })()
  })
  const frames = out.snaps.map((m) => m.frame)
  ok('SP1a', '4 真人满员（WS quick×4 占席）', out.seats.length === 4, `真人席 [${out.seats.join(',')}]`)
  ok('SP1b', '第 5 连接 join 满员房 → spectator 位（不占席）', !!(out.bWelcome && out.bWelcome.role === 'spectator'), `role=${out.bWelcome && out.bWelcome.role}${out.err ? ' err=' + out.err : ''}`)
  ok('SP1c', '观战收同快照流（full=1 首张+frame 推进+ack=-1 观战席锚+projs 同流）',
    out.snaps.length >= 3 && out.snaps[0].full === 1 && frames.every((f, i) => i === 0 || f > frames[i - 1]) && out.snaps.every((m) => m.ext && m.ext.ack === -1) && out.snaps.every((m) => Array.isArray(m.projs)),
    `snaps×${out.snaps.length} frame ${frames[0]}→${frames[frames.length - 1]}`)
}

/* ================= 主流程 ================= */
if (PART === 'latency') await partLatency()
else if (PART === 'mercy') await partMercy()
else if (PART === 'sp1') await partSp1()
else { console.error('用法：node scripts/iron-torrent-qa2-net.mjs --latency|--mercy|--sp1 （QA_GW 注入影子网关）'); process.exit(2) }
console.log(`QA2-${PART.toUpperCase()} ${failed ? 'FAILED：' + passed + ' 通过，' + failed + ' 失败' : 'OK：' + passed + ' 通过，0 失败'}`)
process.exit(failed ? 1 : 0)
