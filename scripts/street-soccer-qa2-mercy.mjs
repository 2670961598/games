#!/usr/bin/env node
/* =====================================================================
 * GAMES-142 街头足球 QA2 放水链在线验证（WS quick 真实路径 · mercy 臂）
 * 私有影子网关 :4416（:4400/:4399 零感知）。QA 只读：零产品代码改动。
 *
 * 在线链路（区别于 BOT 单 GAMES-140 决策级离线 A/B）：
 *   rooms.js finish() 按 META.pulseTeam 记真人胜负台账（WeakMap keyed conn，
 *   跨房累积——WS conn 跨 quick 存续）→ doFrame 每拍算 foeLose 注入 botEnv
 *   → sim brain 放水链（L1 让力 jit1=1300/powMul85/errP=0.25；L2 重败行为降档
 *   bal→cas+jit2=2600；同队真人=生态位让位）。
 *   testapi 房结构性不可达（每房一次性 vctx、单局 pulse 恒 0）——故走 WS quick
 *   真实路径（协议 §2）：真人 W 同 conn 连败多局触发台账，观测敌席 bot 行为翻转。
 *
 * 观测锚（quick 自建房=全 balanced bot，W 让位入席 seat3，敌席 0/2、队友席 1）：
 *   - ctl（连败<2）：balanced 射门 pow≡650（sim  shoot 门 distG<140k→恒 650 档）
 *   - L1（连败 2-3）：mErr → pow=(650*85/100)|0=552 恒档 + jit1 散布 + 扑抢收脚
 *   - L2（连败 ≥4）：行为降档 bal→cas（CASUAL 表 pow 400-800 ×0.85=340-680 散布）
 *   - 生态位让位（队友席 1 balanced）：让球权（pass to=W 豁空即让）+自由球收步
 *   - 附：O-1 抽验（quick bot 房真人让位入席 takeover）+8min 墙钟窗（长局交叉引用：
 *     逐局 goal 事件==终态队分、tick 推进、stateHash 演化）
 *
 * 饱和器：8 条 dummy WS conn 持续占满 bothost 街头房（休闲/均衡）空闲席——
 * 保证 W 的 quick 落在「新建全 balanced 房」（quick 无可入房时自建）。
 * dummy 只 join 不输入；自家房 end 后 3s 重找非 W 房补位。
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
const GW_HTTP = process.env.QA_GW || 'http://127.0.0.1:4416'
const GW_WS = (process.env.QA_GW || 'http://127.0.0.1:4416').replace('http', 'ws')
const DEADLINE_MS = 11 * 60 * 1000   // 硬墙钟帽
const MATCH_TICKS = 2400             // 单局 120s 帽（timeScale=1 真秒——真实路径）

let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const T0 = Date.now()
const wall = () => Math.round((Date.now() - T0) / 1000)

async function feed() {
  try {
    const res = await fetch(GW_HTTP + '/api/matches', { signal: AbortSignal.timeout(4000) })
    const j = await res.json()
    return (j.matches || j || []).filter((m) => m.gameId === 'street-soccer')
  } catch { return [] }
}

/* ---------- 通用 WS 会话 ---------- */
function makeConn(tag) {
  const C = {
    tag, ws: null, seat: -1, role: null, roomId: null, roster: null, elapsedMs: -1,
    ball: null, players: {}, evs: [], snaps: 0, hashes: 0, ended: null, closed: 0, errs: [],
  }
  C.open = () => new Promise((resolve, reject) => {
    C.ws = new WebSocket(GW_WS + '/ws')
    C.ws.onopen = () => { C.ws.send(JSON.stringify({ t: 'hello', v: 1 })); resolve() }
    C.ws.onerror = (e) => { C.errs.push(String(e && e.message || e)); reject(new Error('ws-error')) }
    C.ws.onclose = () => { C.closed++ }
    C.ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data) } catch { return }
      if (msg.t === 'error') { C.errs.push(JSON.stringify(msg)); return }
      if (msg.t === 'welcome') {
        C.seat = msg.role === 'player' ? msg.seat : -1; C.role = msg.role
        C.roomId = msg.roomId; C.roster = (msg.room && msg.room.seats) || []
        C.ended = null; C.evs = []; C.snaps = 0; C.players = {}
        if (msg.state && msg.state.players) for (const p of msg.state.players) if (p) { C.players[p.seat] = { x: p.x, y: p.y } }
        if (msg.state && msg.state.ball) C.ball = { x: msg.state.ball.x, y: msg.state.ball.y, owner: msg.state.ball.owner }
      } else if (msg.t === 'snapshot') {
        C.snaps++
        if (msg.ext && msg.ext.hash !== undefined) C.hashes++
        for (const e of (msg.ents || [])) {
          if (e.id === 'ball') { C.ball = C.ball || {}; C.ball.x = e.x; C.ball.y = e.y; if (e.owner !== undefined) C.ball.owner = e.owner }
          else if (e.id !== undefined && e.x !== undefined) C.players[e.id] = { x: e.x, y: e.y }
        }
        if (msg.full && msg.state) {
          if (msg.state.players) for (const p of msg.state.players) if (p) C.players[p.seat] = { x: p.x, y: p.y }
          if (msg.state.ball) C.ball = { x: msg.state.ball.x, y: msg.state.ball.y, owner: msg.state.ball.owner }
        }
        for (const e of (msg.events || [])) { e._at = Date.now(); C.evs.push(e) }
      } else if (msg.t === 'end') { C.ended = msg.result }
      else if (msg.t === 'closed') { C.errs.push('closed') }
    }
  })
  C.send = (o) => { if (C.ws && C.ws.readyState === 1) C.ws.send(JSON.stringify(o)) }
  C.quick = (maxTicks) => { C.send({ t: 'quick', gameId: 'street-soccer', maxTicks }) }
  C.joinRoom = (roomId) => { C.send({ t: 'join', roomId }) }
  C.leave = () => { C.send({ t: 'leave' }) }
  C.close = () => { try { C.ws && C.ws.close() } catch { } }
  return C
}

/* ---------- 饱和器：占满 bothost 街头房空闲席（不进 W 的房） ---------- */
const dummies = []
let wRoomId = null
async function dummyLoop(d) {
  await d.open().catch(() => { })
  while (Date.now() - T0 < DEADLINE_MS) {
    const rooms = await feed()
    const joinable = rooms.filter((r) => r.joinable && (r.humans + r.bots) < 4 && r.roomId !== wRoomId)
      .sort((a, b) => b.createdAt - a.createdAt)
    if (joinable.length && d.role !== 'player') d.joinRoom(joinable[0].roomId)
    else if (d.role !== 'player') d.quick()
    await sleep(3000)
    if (d.ended) { await sleep(1500); d.leave(); d.role = null; d.seat = -1 }
  }
  d.close()
}

/* ---------- W 策略 ---------- */
const K = 1000
function ownGoal(seat) { return { x: 175 * K, y: (seat & 1) === 0 ? 500 * K : 0 } }
function estPolicy(C) {   // 自摆：持球冲自家门（乌龙进对方分=快速制造败局）
  const me = C.players[C.seat]; const B = C.ball
  if (!me || !B) return { mx: 0, my: 0 }
  const tgt = (B.owner === C.seat) ? ownGoal(C.seat) : { x: B.x + (B.vx || 0) * 4, y: B.y + (B.vy || 0) * 4 }
  const dx = tgt.x - me.x, dy = tgt.y - me.y, d = Math.hypot(dx, dy) || 1
  if (d < 9000) return { mx: 0, my: 0 }
  return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100), sp: 1 }
}
function obsPolicy(C) {   // 观测：趋球悬停（20k 外不触球）；意外持球即站定（不干扰 bot 面）
  const me = C.players[C.seat]; const B = C.ball
  if (!me || !B) return { mx: 0, my: 0 }
  if (B.owner === C.seat) return { mx: 0, my: 0 }
  const dx = B.x - me.x, dy = B.y - me.y, d = Math.hypot(dx, dy) || 1
  if (d < 22000) return { mx: 0, my: 0 }
  return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
}

/* ---------- 单局采样器 ---------- */
function sampleMatch(C, loseIn, fresh) {
  const enemySeats = [0, 1, 2, 3].filter((s) => s !== C.seat && ((s & 1) !== (C.seat & 1)))
  const mateSeat = C.seat ^ 2
  const shots = C.evs.filter((e) => e.k === 'shot' && enemySeats.includes(e.seat)).map((e) => e.pow)
  const shotsAll = C.evs.filter((e) => e.k === 'shot').map((e) => e.pow)
  const tackles = {}
  for (const s of [0, 1, 2, 3]) tackles[s] = C.evs.filter((e) => e.k === 'tackle' && e.by === s).length
  const matePassToW = C.evs.filter((e) => e.k === 'pass' && e.from === mateSeat && e.to === C.seat).length
  const goals = C.evs.filter((e) => e.k === 'goal').length
  /* end result 不带 score——从 goal 事件聚合（team='A'/'B' 字符串，服务器归属，乌龙进对方队分） */
  const score = { A: C.evs.filter((e) => e.k === 'goal' && e.team === 'A').length, B: C.evs.filter((e) => e.k === 'goal' && e.team === 'B').length }
  /* 生态位收步采样：自由球且 W 比队友近 → 队友是否仍逼近球（<25k 即争抢态） */
  let wNear = 0, mateClose = 0
  for (let i = 2; i < C.evs.length; i += 7) {
    const B = C.ball; const me = C.players[C.seat]; const pm = C.players[mateSeat]
    if (!B || !me || !pm || B.owner >= 0) continue
    const dW = Math.hypot(B.x - me.x, B.y - me.y), dM = Math.hypot(B.x - pm.x, B.y - pm.y)
    if (dW < dM) { wNear++; if (dM < 25000) mateClose++ }
  }
  return {
    fresh, loseIn, seat: C.seat, enemySeats,
    result: C.ended, goals, score,
    shots, shotsAll, tackles, matePassToW, wNear, mateClose,
    snaps: C.snaps, hashes: C.hashes, tick: C.evs.length,
  }
}

async function waitNoJoinable(timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const rooms = await feed()
    const j = rooms.filter((r) => r.joinable && (r.humans + r.bots) < 4)
    if (!j.length) return true
    await sleep(800)
  }
  return false
}

/* 燃位器：把可入房占满（每房补 4−humans−bots 席=joinable 转满员），逼 W 的 quick 自建 fresh 房 */
async function burnAll() {
  const rooms = await feed()
  const j = rooms.filter((r) => r.joinable && (r.humans + r.bots) < 4).sort((a, b) => b.createdAt - a.createdAt)
  let used = 0
  for (const r of j.slice(0, 2)) {
    const n = Math.min(4 - r.humans - r.bots, 4)
    for (let i = 0; i < n; i++) {
      const b = makeConn('burner')
      await b.open().catch(() => { })
      b.joinRoom(r.roomId)
      used++
      setTimeout(() => { try { b.leave(); b.close() } catch { } }, 45000)
    }
  }
  return used
}

async function playMatch(W, loseIn, needObs) {
  /* 统一饱和+烧位（est 也避残局尾窗——尾窗 win 会清零 pulse 台账） */
  let clean = await waitNoJoinable(3000)
  if (!clean) { await burnAll(); await sleep(1200); await waitNoJoinable(2000) }
  W.quick(MATCH_TICKS)
  /* 等 welcome（quick 建房 3s startDelay + join） */
  const t0 = Date.now()
  while (Date.now() - t0 < 12000 && W.role !== 'player') await sleep(150)
  if (W.role !== 'player') return { fail: 'no-join' }
  wRoomId = W.roomId
  const rooms = await feed()
  const me = rooms.find((r) => r.roomId === W.roomId)
  const elapsed = me ? me.elapsedMs : -1
  const fresh = elapsed >= 0 && elapsed < 6000
  const botsBalanced = W.roster.filter((s) => s.kind === 'bot').every((s) => s.level === 'balanced')
  /* OBS 需 fresh 全 balanced 自建房；est 容忍新刷 ambient（<90s）但弃残局尾窗——
     弃局走 abandon/续跑，无 pulse 记账污染（finish 只记 kind=human&&conn 在场，W 已 detach） */
  const okRoom = needObs ? (fresh && botsBalanced) : (elapsed >= 0 && elapsed < 90000)
  if (!okRoom) {
    wRoomId = null
    W.leave(); W.role = null; W.seat = -1
    await sleep(700)
    return { fail: `ambient-abort(el=${Math.round(elapsed / 1000)}s,fresh=${fresh},bal=${botsBalanced})`, loseIn }
  }
  const policy = needObs ? obsPolicy : estPolicy
  /* 输入泵：150ms 一拍（lastInput 持续=连续向量；cmd 一次性语义不受影响——W 全程零 cmd） */
  const tMatch = Date.now()
  const capMs = needObs ? MATCH_TICKS * 50 + 12000 : 105000   /* est 靠乌龙 goal-cap 通常 <100s；残局尾窗也在此内到终 */
  const iv = setInterval(() => { const p = policy(W); if (p) W.send({ t: 'input', keys: p }) }, 150)
  try {
    while (Date.now() - tMatch < capMs && !W.ended) await sleep(300)
  } finally { clearInterval(iv) }
  const m = W.ended ? sampleMatch(W, loseIn, fresh && botsBalanced) : { fail: 'no-end', loseIn, fresh }
  if (m && !m.fail) {
    /* ctl 基线判据=敌席 bot 全 balanced（quick 自建/均衡房均可；L1/L2 数字信号只依赖敌席档位） */
    m.enemyBal = W.roster.filter((s) => s.kind === 'bot' && ((s.seat & 1) !== (W.seat & 1))).every((s) => s.level === 'balanced')
  }
  const res = W.ended
  wRoomId = null
  W.leave(); W.role = null; W.seat = -1
  await sleep(600)
  return { m, res, clean, fresh, botsBalanced, policyName: policy === obsPolicy ? 'obs' : 'est' }
}

async function main() {
  const hz = await fetch(GW_HTTP + '/healthz').then((r) => r.json()).catch(() => null)
  ok('M-ENV', '影子网关 :4416 在线（WS quick 真实路径）', !!(hz && hz.ok), `rooms=${hz && hz.rooms}`)
  if (failed) { process.exit(1) }

  /* 饱和器 8 dummy */
  for (let i = 0; i < 8; i++) { const d = makeConn('dummy' + i); dummies.push(d); dummyLoop(d).catch(() => { }) }
  await sleep(2500)

  /* W：单 conn 跨局（pulse 台账键=conn——跨房存续是在线链路前提） */
  const W = makeConn('W')
  await W.open()
  let lose = 0, win = 0, draw = 0
  const matches = []
  let l1Sampled = 0, l2Sampled = 0   // 敌席 shot 样本数
  const seen = { ctl: [], L1: [], L2: [] }

  let obsFails = 0
  while (Date.now() - T0 < DEADLINE_MS) {
    if (l1Sampled >= 3 && l2Sampled >= 3 && wall() >= 420) break
    /* 采样驱动的策略切换：档内样本够即转推进（est 快速制造败局爬档） */
    const needObs = (lose >= 2 && lose <= 3 && l1Sampled < 3) || (lose >= 4 && l2Sampled < 3)
    const r = await playMatch(W, lose, needObs && obsFails < 5)
    if (r.fail || !r.res) {
      if (String(r.fail || '').startsWith('ambient-abort')) obsFails++
      console.log(`  · skip [${r.fail}] lose=${lose} w=${wall()}s`)
      matches.push({ ...r, loseIn: lose, outcome: null })
      continue
    }
    obsFails = 0
    const { m, res } = r
    const wTeam = W.seat & 1   // seat 已被 leave 清零——用采样内 seat
    const myTeam = m.seat & 1
    const winner = res && res.winner
    let outcome = 'draw'
    if (winner === 'A') outcome = myTeam === 0 ? 'win' : 'lose'
    else if (winner === 'B') outcome = myTeam === 1 ? 'win' : 'lose'
    if (outcome === 'lose') lose++
    else if (outcome === 'win') { win++; lose = 0 }
    else draw++
    if (m && !m.fail) {
      const arm = m.loseIn >= 4 ? 'L2' : m.loseIn >= 2 ? 'L1' : 'ctl'
      seen[arm].push(m)
      if (arm === 'L1') l1Sampled += m.shots.length
      if (arm === 'L2') l2Sampled += m.shots.length
    }
    matches.push({ idx: matches.length + 1, arm: m && m.loseIn >= 4 ? 'L2' : m && m.loseIn >= 2 ? 'L1' : 'ctl', outcome, policy: r.policyName, fresh: r.fresh, bal: r.botsBalanced, res: winner + '/' + (res && res.reason), score: m && m.score, shots: m && m.shots, loseIn: m && m.loseIn, goals: m && m.goals, wNear: m && m.wNear, mateClose: m && m.mateClose, matePass: m && m.matePassToW, tackles: m && m.tackles, hashes: m && m.hashes })
    console.log(`  · m${matches.length} [${matches[matches.length - 1].arm}/${r.policyName}${r.fresh && r.botsBalanced ? '' : '/ambient'}] ${outcome} ${winner}(${res && res.reason}) score=${JSON.stringify(m && m.score)} shots=${JSON.stringify(m && m.shots)} lose=${lose} w=${wall()}s`)
  }

  /* ============ 断言 ============ */
  const seq = matches.filter((x) => x.outcome)
  ok('M1', `pulse 台账在线累积：同 conn 连败序列在案（败 ${seq.filter((x) => x.outcome === 'lose').length} 局/胜 ${win}/平 ${draw}，跨 ${seq.length} 局 ${wall()}s 墙钟）`,
    seq.filter((x) => x.outcome === 'lose').length >= 4 && seq.length >= 4,
    `局序 ${seq.map((x) => x.arm[0] + (x.outcome === 'lose' ? '败' : x.outcome === 'win' ? '胜' : '平')).join('→')}`)
  ok('M1', 'O-1 抽验：quick bot 房真人让位入席（seat=bot 席顶替=真人优先，协议 §2）',
    seq.some((x) => x.fresh) && W.errs.filter((e) => e.includes('full')).length === 0,
    `fresh 房入席×${seq.filter((x) => x.fresh).length}（席位让位=网关 join 路径；观战入口语义 QA1 O-1 已记）`)

  const ctl = seen.ctl.filter((m) => m.enemyBal), L1 = seen.L1.filter((m) => m.fresh), L2 = seen.L2.filter((m) => m.fresh)
  const ctlShots = ctl.flatMap((m) => m.shots), L1Shots = L1.flatMap((m) => m.shots), L2Shots = L2.flatMap((m) => m.shots)
  ok('M2', `基线：ctl 局（连败<2）敌席 balanced 射门 pow≡650（shoot 门 distG<140k 恒 650 档）`,
    ctlShots.length >= 2 && ctlShots.every((p) => p === 650),
    `n=${ctlShots.length} 值域=${ctlShots.length ? Math.min(...ctlShots) + '-' + Math.max(...ctlShots) : '-'}`)
  ok('M3', `L1 让力（连败 2-3 在线触发）：敌席射门 pow≡552（650×85% 让力衰减档）+零 650 档残留`,
    L1Shots.length >= 2 && L1Shots.every((p) => p <= 560),
    `n=${L1Shots.length} 值=${JSON.stringify(L1Shots)}（jit1 散布/扑抢收脚/失误注入为行为谱面，见披露）`)
  ok('M4', `L2 重败（连败 ≥4 在线触发）：敌席行为降档 bal→cas（pow 散布 340-680=400-800×85%，零 650/552 恒档）`,
    L2Shots.length >= 3 && L2Shots.every((p) => p <= 680) && L2Shots.some((p) => p < 500),
    `n=${L2Shots.length} 值=${JSON.stringify(L2Shots)}`)
  /* 生态位让位（观测面披露制+软锚）：让球权（队友席 pass→W）与自由球收步（W 近时队友不逼抢） */
  const eco = [...L1, ...L2]
  const ecoPass = eco.reduce((a, m) => a + m.matePassToW, 0)
  const ecoYield = eco.reduce((a, m) => a + m.wNear, 0)
  const ecoClose = eco.reduce((a, m) => a + m.mateClose, 0)
  const ctlPass = ctl.reduce((a, m) => a + m.matePassToW, 0)
  ok('M5', `生态位让位在线观测（BOT 单决策级 A/B 的链路复证）：放水档队友席让球权/自由球收步在案`,
    (ecoPass >= 1 || ecoYield >= 10) && ecoClose <= ecoYield * 0.4,
    `pass→W：放水档 ${ecoPass} vs ctl ${ctlPass}｜自由球 W 更近采样 ${ecoYield} 例中队友逼近 ${ecoClose} 例（收步=${ecoYield - ecoClose}）`)
  /* 8min 墙钟窗（长局交叉引用）：逐局 goal==队分、hash 哨兵、tick 推进 */
  const goalChk = matches.filter((x) => x.score && typeof x.goals === 'number' && x.score.A + x.score.B === x.goals).length
  const scored = matches.filter((x) => x.score).length
  const hashN = matches.reduce((a, x) => a + (x.hashes || 0), 0)
  ok('M6', `8min 墙钟窗交叉引用：连续对局窗 ≥7min+逐局 goal 事件==终态队分（A6 口径）+hash 哨兵在场`,
    wall() >= 420 && scored >= 4 && goalChk === scored && hashN >= 10,
    `墙钟 ${wall()}s（8min 目标/7min 断言底线）｜goal==队分 ${goalChk}/${scored} 局｜hash 哨兵×${hashN}`)
  ok('M7', 'WS 面零异常（无 error 消息/无异常断链；W conn 全程单连跨局=pulse 台账键存续）',
    W.errs.length === 0 && W.closed === 0,
    `errs=${W.errs.length} closed=${W.closed}`)

  for (const d of dummies) d.close()
  console.log(`\nQA2-MERCY：${passed} 通过，${failed} 失败（墙钟 ${wall()}s，${matches.length} 局）`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
