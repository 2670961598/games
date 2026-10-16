#!/usr/bin/env node
/* =====================================================================
 * GAMES-156 弈界棋阁 QA1 联机红线专项（net 臂 · S5 回合权威+多规则三模式+
 * 托管三层+断线重连/观战+Bot 三档梯度+长局 spot+满编+F1 取证）
 * 私有影子网关 :4420（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4400/:4399 零感知）；
 * 剧本房一律 /api/test/* 隔离测试房（与 WS 会话同一条代码路径，协议 §8——测试房
 * WS 面按 room-gone 隔离为设计态，观战/满编走 quick 真实房原生 WS）。
 *   Q1 回合权威·非法步拒绝：bad-cell/not-your-turn/occupied（五子）+
 *      no-flip（黑白）+ wrong-board/dead-board（井字送位窗）
 *   Q2 合法步裁决账本：逐 ruling 后置态对账（place 归属/flip 全翻/sub 即时定盘/
 *      moveNo 单调+turn 交替）
 *   Q3 三模式确定性同锚：三房 welcome.room.duel.hash 同值==sim.ENGINE_HASH+
 *      每 mode 在线终态 stateHash==replayOps(opsLog) 重放
 *   Q4 托管三层单步化：①步限 timeout-move 单步 casual 代走（③连 3 全超时步
 *      afk 认负——第 3 次先终局不再发事件=单步语义面）②host 开关 hosted 续打
 *      +任意合法 op 夺回 ③断线窗尽托管（R3 档）
 *   Q5 重连三档（timeScale=1 真秒）：5s 全测/10s 窗内复席/30s 逾窗托管+409
 *   Q6 观战位+满编（quick 真实房 WS）：spectate 收同一 ruling 流（零隐藏=原始帧
 *      逐字节相等）+reject 只回违规席（vis 路由）+满员第 3 连接 play→观战承接
 *   Q7 Bot 三档梯度：离线直驱（inputs {op} 包壳=网关 brain 同构）——五子威胁
 *      响应率/黑白位置分（F1 污染甄别）/井字 SUB 完美度+战绩矩阵；在线三档抽查
 *   Q8 长局 spot：gomoku 防守长打+5s 采样 tick/clock/moveNo/stateHash+账本对账
 *   F1 取证（P0 退回）：reversi feat.mustBlock=对方角威胁格对己方恒非法，casual/
 *      balanced 无条件盲返 mustBlock[0]→applyOp reject→同 rng 逐 tick 重试同格
 *      →烧穿步限×3 → bot 假 afk 认负（有合法手一步不走）；离线位面解剖+面宽
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/yi-pavilion/sim.cjs')

const GW = process.env.QA_GW || 'http://127.0.0.1:4420'
const GW_WS = process.env.QA_GW_WS || 'ws://127.0.0.1:4420'
const SEED = 20261016

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
const createRoom = (o) => gw('POST', '/api/test/room', Object.assign({ gameId: 'yi-pavilion', seed: SEED, startDelayMs: 300 }, o))
const input = (roomId, op, payload, seat) => gw('POST', '/api/test/input', { roomId, seat, op, payload })
const killRoom = (roomId) => gw('DELETE', `/api/test/room?roomId=${roomId}`)

const allEvs = (R) => R.rulings.flatMap((m) => m.events || [])
const evs = (R, k) => allEvs(R).filter((e) => e.k === k)
const policy = (rule, st, seat) => {
  const f = S.feat(st, seat)
  if (f.winNow && f.winNow.length && (f.winNow[0] === null || S.legal(st, seat).includes(f.winNow[0]))) {
    if (f.winNow[0] !== null && S.legal(st, seat).includes(f.winNow[0])) return f.winNow[0]
  }
  const lg = S.legal(st, seat)
  if (f.mustBlock && f.mustBlock.length && lg.includes(f.mustBlock[0])) return f.mustBlock[0]
  if (!lg.length) return -1
  return lg[(st.moveNo * 7 + 3) % lg.length]
}

/* ---------- 房间壳：游标泵 + 后台策略驱动（hold 给探针让路，步限保活防饿死） ---------- */
function makeRoom(tag, resp) {
  const R = {
    tag, id: resp && resp.roomId, seat: resp && resp.playerSeat, token: resp && resp.token,
    cur: 0, rulings: [], last: null, ended: null, spots: [], done: false, hold: false,
  }
  R.ingest = (s) => {
    R.cur = s.cursor; R.last = s
    for (const r of (s.events || [])) if (r.msg && r.msg.t === 'ruling') R.rulings.push(r.msg)
    if (s.result) R.ended = s
  }
  R.pull = async () => {
    const s = await gw('GET', `/api/test/state?roomId=${R.id}&since=${R.cur}`)
    if (s.json && s.json.ok) R.ingest(s.json)
    return s.json
  }
  R.pump = async (ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms && !R.done) { await R.pull(); if (R.ended) { R.done = true; break } await sleep(140) }
    return R
  }
  R.drive = async (ms = 120000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms && !R.done) {
      if (R.hold) { await sleep(120); continue }
      const s = await R.pull()
      if (!s || !s.ok) break
      if (R.ended || (s.state && s.state.over)) { R.done = true; break }
      const st = s.state
      if (st && st.phase === 'live' && st.turn === R.seat) {
        const mv = policy(st.rule, st, R.seat)
        if (mv >= 0) await input(R.id, 'place', { op: { k: 'place', cell: mv } })
      }
      await sleep(140)
    }
    R.done = true
    return R
  }
  return R
}
/* 探针：等「房 live+轮到我+cond」；hold 期间步限保活（剩 <12s 时代打一策略手防 afk 饿死） */
async function probeTurn(R, cond, act, ms = 30000, pollMs = 110) {
  const t0 = Date.now()
  R.hold = true
  try {
    while (Date.now() - t0 < ms) {
      const s = await R.pull()
      if (!s || !s.ok || s.state.over) return null
      const st = s.state
      if (s.phase === 'live' && st.turn === R.seat) {
        if (cond(st)) return await act(st)
        if ((st.deadline - st.tick) * 10 < 12000) { // 保活：临步限代打一手
          const mv = policy(st.rule, st, R.seat)
          if (mv >= 0) await input(R.id, 'place', { op: { k: 'place', cell: mv } })
        }
      }
      await sleep(pollMs)
    }
    return null
  } finally { R.hold = false }
}
async function awaitReject(R, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await R.pull()
    const e = allEvs(R).find((x) => x.k === 'reject' && !x._qa)
    if (e) { e._qa = 1; return e }
    await sleep(90)
  }
  return null
}

/* ============ Q1/Q2/Q3 三房：权威拒绝+裁决账本+同锚 ============ */
console.log('── Q1/Q2/Q3 回合权威·裁决账本·三模式同锚 ──')
const modeRooms = {}
for (const rule of ['gomoku', 'reversi', 'cascade']) {
  const r = await createRoom({ rule, botLevels: [null, 'casual'], timeScale: 8 })
  if (!(r.json && r.json.ok)) { ok('Q3', `${rule} 建房`, false, JSON.stringify(r.json)); continue }
  const R = makeRoom(rule, r.json)
  modeRooms[rule] = R
  R._drv = R.drive()
}
await sleep(700)
{
  const R = modeRooms.gomoku
  const t0 = Date.now()
  await input(R.id, 'place', { op: { k: 'place', cell: 99999 } })
  const r1 = await awaitReject(R)
  ok('Q1', '非法步·越界 cell=99999 → reject(bad-cell) 只回违规席', !!(r1 && r1.why === 'bad-cell'),
    `${r1 ? 'reject(' + r1.why + ')@' + (Date.now() - t0) + 'ms' : '未见 reject'}`)
  let r2 = null
  for (let attempt = 0; attempt < 3 && !r2; attempt++) {
    const s = await R.pull()
    if (!s || s.state.over || s.phase !== 'live') { await sleep(300); continue }
    if (s.state.turn !== R.seat) { await sleep(300); continue }
    await input(R.id, 'place', { op: { k: 'place', cell: s.state.board.findIndex((v) => v === 0) } })
    await sleep(60)
    await input(R.id, 'place', { op: { k: 'place', cell: 0 } })
    r2 = await awaitReject(R, 2500)
  }
  ok('Q1', '非法步·串手（bot 思考窗注入）→ reject(not-your-turn)', !!(r2 && r2.why === 'not-your-turn'),
    r2 ? `reject(${r2.why})` : '未捕获（竞态重试×3 落空——turn 校验恒在，冻结命令 A4 交叉引用）')
  const r3 = await probeTurn(R, (st) => st.board.some((v) => v !== 0), async (st) => {
    const occ = st.board.findIndex((v) => v !== 0)
    await input(R.id, 'place', { op: { k: 'place', cell: occ } })
    return awaitReject(R)
  })
  ok('Q1', '非法步·占位（已占格）→ reject(occupied)', !!(r3 && r3.why === 'occupied'),
    r3 ? `reject(${r3.why})` : '未捕获')
}
{
  const R = modeRooms.reversi
  const r = await probeTurn(R, () => true, async (st) => {
    const legal = S.legal(st, R.seat)
    const bad = [0, 7, 56, 63, 27, 28, 35, 36].find((c) => !legal.includes(c))
    if (bad === undefined) return 'no-bad-cell'
    await input(R.id, 'place', { op: { k: 'place', cell: bad } })
    return awaitReject(R)
  })
  ok('Q1', '非法步·黑白非夹击位 → reject(no-flip)', !!(r && r !== 'no-bad-cell' && r.why === 'no-flip'),
    r && r.why ? `reject(${r.why})` : '未捕获')
}
{
  const R = modeRooms.cascade
  const rw = await probeTurn(R, (st) => st.last >= 0 && S.cascadeWindow(st) !== null, async (st) => {
    const legal = S.legal(st, R.seat)
    const empty = st.board.map((v, i) => v === 0 ? i : -1).filter((i) => i >= 0)
    const wrong = empty.find((c) => !legal.includes(c))
    if (wrong === undefined) return 'no-window'
    await input(R.id, 'place', { op: { k: 'place', cell: wrong } })
    return awaitReject(R)
  }, 40000)
  ok('Q1', '非法步·井字送位窗外 → reject(wrong-board)', !!(rw && rw !== 'no-window' && rw.why === 'wrong-board'),
    rw && rw.why ? `reject(${rw.why})` : '未捕获（窗竞态）')
  const rd = await probeTurn(R, (st) => st.sub.some((v) => v !== -1) && S.cascadeWindow(st) === null, async (st) => {
    const legal = S.legal(st, R.seat)
    const empty = st.board.map((v, i) => v === 0 ? i : -1).filter((i) => i >= 0)
    /* 窗=null（上一手定盘后自由）时 check 序先于 wrong-board → 死盘格可直达 dead-board */
    const dead = empty.find((c) => !legal.includes(c) && st.sub[S.SUB_OF[c]] !== -1)
    if (dead === undefined) return 'no-dead'
    await input(R.id, 'place', { op: { k: 'place', cell: dead } })
    return awaitReject(R)
  }, 45000)
  ok('Q1', '非法步·井字死盘（已归属子盘格）→ reject(dead-board)', !!(rd && rd !== 'no-dead' && rd.why === 'dead-board'),
    rd && rd.why ? `reject(${rd.why})` : '未捕获（对局进度未及死盘面——送位窗拒已证规则面在场）')
}
for (const rule of ['gomoku', 'reversi', 'cascade']) {
  const R = modeRooms[rule]
  if (!R) continue
  await R._drv
  const st = R.last && R.last.state
  const res = R.ended && R.ended.result
  ok('Q2', `${rule} 对局达终局（策略驱动 vs casual）`, !!res,
    res ? `reason=${res.reason} winner=${res.winner} moveNo=${st && st.moveNo}` : '预算内未终局')
  let placeOk = 0, placeBad = 0, flipOk = 0, flipBad = 0, subOk = 0, subBad = 0
  for (const m of R.rulings) {
    const v = m.state
    if (!v) continue
    for (const e of (m.events || [])) {
      if (e.k === 'place') { (v.board[e.cell] === e.seat + 1) ? placeOk++ : placeBad++ }
      if (e.k === 'flip') { (e.cells.every((c) => v.board[c] === e.seat + 1) && e.cells.length === e.n) ? flipOk++ : flipBad++ }
      if (e.k === 'sub') { (v.sub[e.idx] === e.owner) ? subOk++ : subBad++ }
    }
  }
  ok('Q2', `${rule} 裁决账本·place 事件↔后置态归属逐手对账`, placeOk > 0 && placeBad === 0,
    `place ${placeOk}/${placeOk + placeBad} 对账`)
  if (rule === 'reversi') ok('Q2', '黑白 flip 事件↔后置态全翻对账（n=cells.length）', flipOk > 0 && flipBad === 0,
    `flip ${flipOk}/${flipOk + flipBad}（自动 pass×${evs(R, 'pass').length}）`)
  if (rule === 'cascade') ok('Q2', '井字 sub 定盘↔归属表即时对账', subOk > 0 && subBad === 0,
    `sub ${subOk}/${subOk + subBad} owners=${evs(R, 'sub').map((e) => e.owner).join('')}`)
  const turns = evs(R, 'turn')
  const turnAlt = turns.length >= 2 && turns.every((e, i) => i === 0 || e.seat !== turns[i - 1].seat)
  ok('Q2', `${rule} turn 事件交替+moveNo 单调（回合权威换手流）`, turnAlt && st && st.moveNo >= 2,
    `turn×${turns.length} moveNo=${st && st.moveNo}`)
  const sAll = await gw('GET', `/api/test/state?roomId=${R.id}&since=0`)
  const wel = ((sAll.json && sAll.json.events) || []).map((r) => r.msg).find((m) => m && m.t === 'welcome' && m.room && m.room.duel)
  const engineHash = wel && wel.room.duel.hash
  ok('Q3', `${rule} welcome.room.duel 声明块（engine+rule+hash）`,
    !!(wel && wel.room.duel.engine === 'yi-board-int-v1' && wel.room.duel.rule === rule && Number.isInteger(engineHash)),
    wel ? `${wel.room.duel.engine}#${engineHash}` : '未见')
  if (st && res) {
    const rp = S.replayOps(st.seed, st.opsLog, st.maxTicks)
    const rh = S.hashState(rp)
    if (res.reason === 'afk') {
      /* F2（退回项）：afk 终局局回放必分歧——replayOps 重放 place 不带 fromBot=true，
       * afkStreak 被「人类 op 复位」分支误清零；在线 bot 通道（fromBot=true）不清零
       * →非连续停摆累计至 3 认负（「连续 3 全超时步」连续语义未落实）→回放不终局 */
      ok('F2', `${rule} afk 终局局回放分歧取证（replayOps fromBot 口径 vs 在线 bot 通道——A6 破绽）`,
        rp.over === false || rh !== R.last.stateHash,
        `online reason=afk moveNo=${st.moveNo} vs replay over=${rp.over} moveNo=${rp.moveNo}（归因 F1+F2 退回项）`)
    } else {
      ok('Q3', `${rule} 确定性回放：replayOps(opsLog) 终态 hash==在线 stateHash`, rh === R.last.stateHash,
        `replay=${rh} online=${R.last.stateHash}`)
    }
  }
  R._hash = engineHash
  await killRoom(R.id)
}
{
  const hs = ['gomoku', 'reversi', 'cascade'].map((r) => modeRooms[r] && modeRooms[r]._hash)
  ok('Q3', '三模式同锚护栏：三房 engine hash 同值==sim.ENGINE_HASH（单哈希全量覆盖）',
    hs.length === 3 && hs.every((h) => h === S.ENGINE_HASH), `online=[${hs.join(',')}] sim=${S.ENGINE_HASH}`)
}

/* ============ Q4 托管三层 ============ */
console.log('── Q4 托管三层单步化 ──')
{
  const r = await createRoom({ rule: 'gomoku', botLevels: [null, 'casual'], timeScale: 8 })
  const R = makeRoom('t1', r.json)
  await R.pump(15000)
  const myTm = evs(R, 'timeout-move').filter((e) => e.seat === R.seat)
  const stEnd = R.last && R.last.state
  const res = R.ended && R.ended.result
  const myStones = stEnd ? stEnd.board.filter((v) => v === R.seat + 1).length : 0
  ok('Q4', '层①超时自动走子·单步代走（每个 timeout-move 后恰 1 子=非批量；第 3 次全超时步先终局不再发事件）',
    myTm.length === 2 && myStones === 2,
    `timeout-move×${myTm.length} 代走子数=${myStones}（afkStreak=${JSON.stringify(stEnd && stEnd.afkStreak)}）`)
  ok('Q4', '层③ afk 认负·连续 3 全超时步 → end(afk) 对方胜（代走不重置计数=fromBot 门）',
    !!(res && res.reason === 'afk' && res.winner === 'B'),
    res ? `reason=${res.reason} winner=${res.winner}` : `未终局`)
  await killRoom(R.id)
}
{
  const r = await createRoom({ rule: 'gomoku', botLevels: [null, 'casual'], timeScale: 1 })
  const R = makeRoom('t2', r.json)
  await sleep(600)
  await input(R.id, 'place', { op: { k: 'host', on: true } })
  await R.pump(11000)
  const st1 = R.last && R.last.state
  const hostEvs = evs(R, 'host')
  const myStones = st1 ? st1.board.filter((v) => v === R.seat + 1).length : 0
  ok('Q4', '层②主动托管·host 事件广播+hostedNext 续打在账（我零 op 落子增长）',
    hostEvs.length >= 1 && hostEvs[0].on === true && st1 && st1.hostOn[R.seat] === true && myStones >= 2,
    `host×${hostEvs.length} 我方托管期落子=${myStones}（真秒档：gated 1-2s/手）`)
  let offEv = null
  const got = await probeTurn(R, (st) => st.hostOn[R.seat] === true, async (st) => {
    const legal = S.legal(st, R.seat)
    await input(R.id, 'place', { op: { k: 'place', cell: legal[legal.length - 1] } })
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && !offEv) {
      await R.pull()
      offEv = evs(R, 'host').find((e) => e.seat === R.seat && e.on === false) || null
      if (offEv) break
      await sleep(80)
    }
    return offEv
  }, 20000, 40)
  ok('Q4', '层②任意合法 op 夺回（host off 自动广播）', !!(got || offEv), (got || offEv) ? 'host off 在账' : '未捕获')
  await killRoom(R.id)
}

/* ============ Q5 重连三档（timeScale=1 真秒） ============ */
console.log('── Q5 断线重连三档 ──')
async function reconnectTier(tag, waitMs) {
  const r = await createRoom({ rule: 'gomoku', botLevels: [null, 'casual'], timeScale: 1 })
  const R = makeRoom(tag, r.json)
  await probeTurn(R, () => true, async () => input(R.id, 'place', { op: { k: 'place', cell: 7 * 15 + 7 } }), 20000)
  await sleep(1000)
  await R.pull()
  const dis = await input(R.id, '$disconnect')
  await sleep(waitMs)
  const rc = await input(R.id, '$reconnect')
  const post = (await gw('GET', `/api/test/state?roomId=${R.id}&since=0`)).json
  return { R, dis, rc, pre: R.last, post }
}
{
  const { R, dis, rc, pre, post } = await reconnectTier('r5', 5000)
  const stPre = pre && pre.state, stPost = post && post.state
  const seatHuman = post && post.seats && post.seats[R.seat] && post.seats[R.seat].kind === 'human'
  const stonesPre = stPre ? stPre.board.filter((v) => v).length : 0
  ok('R1', '5s 全测·断线后席位保留（kind=human）+窗内 $reconnect 复席',
    !!(dis.json.ok && rc.json.ok && rc.json.seat === R.seat && seatHuman),
    `disconnect→5s→reconnect seat=${rc.json.seat} roster.kind=${post && post.seats && post.seats[R.seat] && post.seats[R.seat].kind}`)
  ok('R1', '5s 全测·welcome 全量恢复（盘面延续/双 clock/turn/last/moveNo/rule）',
    !!(rc.json.ok && stPre && stPost && stPost.board.length === 225 && stPost.moveNo >= stPre.moveNo && stPost.rule === 'gomoku'
      && stPost.clock[R.seat] <= stPre.clock[R.seat] && stPost.clock[R.seat] > 0 && stPost.board.filter((v) => v).length >= stonesPre),
    `moveNo ${stPre.moveNo}→${stPost.moveNo} clock ${stPre.clock[R.seat]}→${stPost.clock[R.seat]} 子数 ${stonesPre}→${stPost.board.filter((v) => v).length} last=${stPost.last}`)
  let continued = 'n/a'
  if (stPost && !stPost.over && stPost.turn === R.seat) {
    const legal = S.legal(stPost, R.seat)
    if (legal.length) {
      const before = stPost.moveNo
      await input(R.id, 'place', { op: { k: 'place', cell: legal[0] } })
      await sleep(1500)
      const after = (await gw('GET', `/api/test/state?roomId=${R.id}&since=0`)).json
      continued = after.state.moveNo > before && !after.state.over ? 'placed' : after.state.over ? 'ended' : 'no-advance'
    }
  } else continued = stPost && stPost.over ? 'ended' : 'not-my-turn'
  ok('R1', '5s 全测·复席后我方续走（place 受理+moveNo 前进）', continued === 'placed' || continued === 'ended', `续走=${continued}`)
  await killRoom(R.id)
}
{
  const { R, rc, post } = await reconnectTier('r10', 9600)
  const stPost = post && post.state
  ok('R2', '10s 档·窗内（10s+1 拍宽限）复席成功+全量恢复', !!(rc.json.ok && rc.json.seat === R.seat),
    rc.json.ok ? `seat=${rc.json.seat} moveNo=${stPost && stPost.moveNo} clock=${stPost && stPost.clock[R.seat]} roster=${post && post.seats && post.seats[R.seat].kind}` : `err=${rc.json.error}`)
  await killRoom(R.id)
}
{
  const r = await createRoom({ rule: 'gomoku', botLevels: [null, 'casual'], timeScale: 1 })
  const R = makeRoom('r30', r.json)
  await probeTurn(R, () => true, async () => input(R.id, 'place', { op: { k: 'place', cell: 7 * 15 + 7 } }), 20000)
  const dis = await input(R.id, '$disconnect')
  await R.pump(31000)
  const st = R.last && R.last.state
  const roster = R.last && R.last.seats
  const myStones = st ? st.board.filter((v) => v === R.seat + 1).length : 0
  const rc = await input(R.id, '$reconnect')
  ok('R3', '30s 档·逾窗席位转 bot（roster.kind=bot）+托管续走在账（我席子数增长）',
    !!(roster && roster[R.seat].kind === 'bot' && myStones >= 2),
    `roster[${R.seat}].kind=${roster && roster[R.seat].kind} 我席子数=${myStones}（断线时 1）`)
  ok('R3', '30s 档·逾窗 $reconnect → 409 resume-rejected（不降级顶号）', rc.status === 409,
    `status=${rc.status} err=${rc.json && rc.json.error}`)
  ok('R3', '30s 档·棋局不断（托管期推进）', !!(st && (R.ended || st.phase === 'live' || st.over)),
    `phase=${st && st.phase} over=${st && st.over}${R.ended ? ' roomResult=' + R.ended.result.reason : ''}`)
  await killRoom(R.id)
}

/* ============ Q6 观战位+满编（quick 真实房 WS——测试房 WS 面按 room-gone 隔离） ============ */
console.log('── Q6 观战位+满编 ──')
function wsConn() {
  const ws = new WebSocket(GW_WS)
  const c = { ws, raw: [], open: false }
  ws.onopen = () => { c.open = true }
  ws.onmessage = (e) => { c.raw.push(String(e.data)) }
  return new Promise((res) => {
    ws.onopen = () => { c.open = true; res(c) }
    ws.onerror = () => res(c)
    setTimeout(() => res(c), 4000)
  })
}
const jsonOf = (c) => c.raw.map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
{
  const A = await wsConn()
  A.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
  await sleep(500)
  const B = await wsConn()
  B.ws.send(JSON.stringify({ t: 'quick', gameId: 'yi-pavilion', rule: 'gomoku' }))
  await sleep(4200) // quick 房 startDelayMs=3000 → live
  const wA = jsonOf(A).find((m) => m.t === 'welcome'), wB = jsonOf(B).find((m) => m.t === 'welcome')
  const roomId = wA && wA.roomId
  const seatA = wA && wA.seat, seatB = wB && wB.seat
  ok('Q6', 'quick 真实房双真人入房（A/B 各就席，房间 2/2 满编）',
    !!(roomId && wB && wB.roomId === roomId && seatA !== seatB && seatA >= 0 && seatB >= 0),
    `room=${roomId} seatA=${seatA} seatB=${seatB}`)
  // A 首手（live 后 turn=0——若 A 非 0 席则由 B 打）
  const P = seatA === 0 ? A : B, Q = seatA === 0 ? B : A
  const wP = seatA === 0 ? wA : wB
  const st0 = wP.state
  P.ws.send(JSON.stringify({ t: 'op', k: 'place', cell: 7 * 15 + 7 }))
  await sleep(1200)
  // 观战位加入（对局进行中）
  const C = await wsConn()
  C.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'spectate', name: 'qa-spectator' }))
  await sleep(800)
  const wC = jsonOf(C).find((m) => m.t === 'welcome')
  ok('Q6', '观战位·WS spectate join → welcome（role=spectator，对局视图同源）',
    !!(wC && wC.role === 'spectator' && wC.state && wC.state.rule === 'gomoku'),
    wC ? `role=${wC.role}（welcome.state.rule=${wC.state && wC.state.rule}）` : '未见 welcome')
  // Q 落一子（第二手）→ P/C 同帧对比 + P 打非法步看 C 是否收到 reject
  const rulingP = jsonOf(P).filter((m) => m.t === 'ruling')
  const lastState = (rulingP.length ? rulingP[rulingP.length - 1].state : st0)
  const lg = S.legal(lastState, seatA === 0 ? 1 : 0)
  const cellQ = lg[3] !== undefined ? lg[3] : lg[0]
  Q.ws.send(JSON.stringify({ t: 'op', k: 'place', cell: cellQ }))
  // 同拍 P 打占位非法步 → reject 只回 P（vis 席位路由）
  await sleep(80)
  P.ws.send(JSON.stringify({ t: 'op', k: 'place', cell: 7 * 15 + 7 }))
  await sleep(1400)
  const rulQ_P = jsonOf(P).filter((m) => m.t === 'ruling' && (m.events || []).some((e) => e.k === 'place' && e.cell === cellQ)).pop()
  const rawQ_P = A === P ? A.raw.filter((s) => s.includes(`"cell":${cellQ}`) && s.includes('"place"')).pop() : B.raw.filter((s) => s.includes(`"cell":${cellQ}`) && s.includes('"place"')).pop()
  const rawQ_C = C.raw.filter((s) => s.includes(`"cell":${cellQ}`) && s.includes('"place"')).pop()
  ok('Q6', '零隐藏信息·观战者收到与对局方逐字节相同的原始 ruling 帧（恒等映射）',
    !!(rawQ_P && rawQ_C && rawQ_P === rawQ_C),
    rawQ_P && rawQ_C ? `原始帧相等（len=${rawQ_C.length}B cell=${cellQ}）` : `P=${!!rawQ_P} C=${!!rawQ_C}`)
  const rejP = jsonOf(P).some((m) => m.t === 'ruling' && (m.events || []).some((e) => e.k === 'reject'))
  const rejC = jsonOf(C).some((m) => m.t === 'ruling' && (m.events || []).some((e) => e.k === 'reject'))
  const rejQ = jsonOf(Q).some((m) => m.t === 'ruling' && (m.events || []).some((e) => e.k === 'reject'))
  ok('Q6', 'reject 只回违规席（P 收到；观战者 C 与对家 Q 零感知——vis 席位路由）',
    !!(rejP && !rejC && !rejQ), `P=${rejP} C=${rejC} Q=${rejQ}（tactics F1 同族探针面）`)
  // 满编第 3 连接 play join → 观战承接
  const D = await wsConn()
  D.ws.send(JSON.stringify({ t: 'join', roomId, mode: 'play', name: 'qa-third' }))
  await sleep(1000)
  const wD = jsonOf(D).find((m) => m.t === 'welcome')
  const seatsFull = (wC && wC.room && wC.room.seats || []).filter((x) => x && x.kind === 'human').length >= 2
  ok('Q6', '满编·2 真人席占满+第 3 连接 play join → 观战位承接（不顶号不崩）',
    !!(seatsFull && wD && wD.role === 'spectator'),
    `human 席=${seatsFull ? 2 : '?'} 第三连接 role=${wD && wD.role}`)
  P.ws.send(JSON.stringify({ t: 'op', k: 'concede' }))
  await sleep(600)
  for (const c of [A, B, C, D]) { try { c.ws.close() } catch { } }
}

/* ============ Q7 Bot 三档梯度（离线直驱=网关 brain 同构 {op} 包壳） ============ */
console.log('── Q7 Bot 三档梯度 ──')
function offlineGame(rule, lvA, lvB, seed) {
  const st = S.create(seed, { rule })
  const levels = [lvA, lvB]
  /* 分母=决策时刻（gate 开、b.op 产出的一拍）——按 tick 计会虚胖同回合重复计数 */
  const probe = { blockChances: 0, blockHits: 0, subChances: 0, subHits: 0 }
  let guard = 0
  while (!st.over && guard++ < 90000) {
    const inputs = {}
    for (let s = 0; s < 2; s++) {
      if (!levels[s] || st.turn !== s) continue
      const b = S.brain(st, s, levels[s])
      if (b && b.op) {
        if (s === 0 && rule === 'gomoku') {
          const f = S.feat(st, s)
          if (f.mustBlock && f.mustBlock.length) { probe.blockChances++; if (b.op.cell === f.mustBlock[0]) probe.blockHits++ }
        }
        if (s === 0 && rule === 'cascade') {
          const win = S.cascadeWindow(st)
          if (win !== null && st.sub[win] === -1) {
            const ss = S.subStateOf(st.board, win)
            const sub = S.SUB[ss.idx]
            const want = sub && sub.m >= 0 ? S.subCells3(win)[sub.m] : null
            if (want !== null && st.board[want] === 0) { probe.subChances++; if (b.op.cell === want) probe.subHits++ }
          }
        }
        inputs[s] = { op: b.op }
      }
    }
    S.step(st, inputs)
  }
  return { st, probe, winner: st.result && st.result.winner }
}
{
  const one = (lv) => offlineGame('gomoku', lv, 'balanced', 701)
  const gCas = one('casual'), gBal = one('balanced'), gCom = one('competitive')
  const rate = (g) => g.probe.blockChances ? g.probe.blockHits / g.probe.blockChances : null
  ok('B1', '五子·威胁响应率分档（mustBlock 命中率：casual<balanced≈competitive）',
    rate(gCas) !== null && rate(gCas) < rate(gBal) && rate(gBal) >= 0.95 && rate(gCom) >= 0.95,
    `casual=${(rate(gCas) * 100).toFixed(0)}%（${gCas.probe.blockHits}/${gCas.probe.blockChances}） balanced=${(rate(gBal) * 100).toFixed(0)}% competitive=${(rate(gCom) * 100).toFixed(0)}%（各 vs balanced）`)
}
{
  // 黑白位置分：F1（盲堵假 afk）污染甄别——只用 count 正常终局局；全 afk 则红+归因 F1
  const stat = (g) => { let w = 0, d = 0; for (let c = 0; c < 64; c++) if (g.st.board[c] === 1) { w += S.WGT[c]; d++ } return { w, d, corners: S.CORNERS.filter((c) => g.st.board[c] === 1).length, reason: g.st.result && g.st.result.reason, winner: g.winner } }
  const pick = (lv) => {
    for (const seed of [702, 721, 722, 723, 724, 725]) {
      const g = offlineGame('reversi', lv, 'casual', seed)
      if (g.st.result && g.st.result.reason === 'count') return stat(g)
    }
    return stat(offlineGame('reversi', lv, 'casual', 702))
  }
  const rCas = pick('casual'), rBal = pick('balanced'), rCom = pick('competitive')
  const allCount = [rCas, rBal, rCom].every((x) => x.reason === 'count')
  ok('B2', '黑白·位置分分档（count 终局局：balanced/competitive WGT>casual vs 同对手；F1 甄别口径）',
    allCount && rCom.w > rCas.w && rBal.w > rCas.w,
    allCount ? `WGT casual=${rCas.w} balanced=${rBal.w} competitive=${rCom.w}｜角=${rCas.corners}/${rBal.corners}/${rCom.corners}` : `F1 污染：非 count 终局（${rCas.reason}/${rBal.reason}/${rCom.reason}）——归因退回项 F1`)
}
{
  /* 井字可观测分层：定盘着点执行率（winNow=本手可定盘格）——双席同局采集
   *（casual 席 30% 反应 vs competitive 恒执行=SUB 价值层的行为面投影） */
  function cascadeClaimRate(lvA, lvB, seed) {
    const st = S.create(seed, { rule: 'cascade' })
    const lv = [lvA, lvB]
    const acc = [{ c: 0, h: 0 }, { c: 0, h: 0 }]
    let g = 0
    while (!st.over && g++ < 90000) {
      const inputs = {}
      for (let s = 0; s < 2; s++) {
        if (!lv[s] || st.turn !== s) continue
        const b = S.brain(st, s, lv[s])
        if (b && b.op) {
          const f = S.feat(st, s)
          if (f.winNow && f.winNow.length && S.legal(st, s).includes(f.winNow[0])) {
            acc[s].c++; if (b.op.cell === f.winNow[0]) acc[s].h++
          }
          inputs[s] = { op: b.op }
        }
      }
      S.step(st, inputs)
    }
    return { acc, reason: st.result && st.result.reason, winner: st.result && st.result.winner }
  }
  const g1 = cascadeClaimRate('casual', 'competitive', 703)
  const g2 = cascadeClaimRate('competitive', 'casual', 704)
  const rc = g1.acc[0], pc = g1.acc[1], pc2 = g2.acc[0], rc2 = g2.acc[1]
  const rCas = (rc.h + rc2.h) / Math.max(1, rc.c + rc2.c), rCom = (pc.h + pc2.h) / Math.max(1, pc.c + pc2.c)
  ok('B3', '井字·可观测分层：定盘着点执行率（winNow 恒合法）competitive>casual（双席双局采集）',
    rCom > rCas && rCom >= 0.95 && (rc.c + rc2.c) >= 4,
    `casual=${(rCas * 100).toFixed(0)}%（${rc.h + rc2.h}/${rc.c + rc2.c}） competitive=${(rCom * 100).toFixed(0)}%（${pc.h + pc2.h}/${pc.c + pc2.c}）局果=${g1.reason}/${g1.winner}+${g2.reason}/${g2.winner}`)
}
{
  let comWins = 0, total = 0, afkN = 0
  const detail = []
  for (const side of [0, 1]) for (const seed of [711, 712, 713]) {
    const g = side === 0 ? offlineGame('gomoku', 'competitive', 'casual', seed) : offlineGame('gomoku', 'casual', 'competitive', seed)
    if (g.winner === (side === 0 ? 'A' : 'B')) comWins++
    if (g.st.result && g.st.result.reason === 'afk') afkN++
    total++
    detail.push(`g${side}${g.winner}`)
  }
  ok('B4', '战绩面：competitive vs casual 压倒（五子离线 6 局双侧；黑白/井字另见 F1 退回）', comWins >= 5 && afkN === 0,
    `${comWins}/${total} afk=${afkN}（${detail.join(' ')}）`)
}
{
  for (const lv of ['casual', 'balanced', 'competitive']) {
    const r = await createRoom({ rule: 'gomoku', botLevels: [null, lv], timeScale: 8 })
    const R = makeRoom('bot-' + lv, r.json)
    await R.drive(25000)
    const st = R.last && R.last.state
    const res = R.ended && R.ended.result
    const botMoves = st ? st.opsLog.filter((o) => o.k === 'place' && o.s !== R.seat).length : 0
    ok('B5', `在线抽查·${lv} 房推进（bot 着全走 applyOp 权威位在账）`, botMoves >= 2,
      `bot 着×${botMoves}${res ? ' reason=' + res.reason + ' winner=' + res.winner : '（预算窗内未终局）'}`)
    await killRoom(R.id)
  }
}

/* ============ Q8 长局 spot（gomoku 防守长打：封胜+一步压窗） ============ */
console.log('── Q8 长局 spot ──')
{
  const r = await createRoom({ rule: 'gomoku', botLevels: [null, 'casual'], timeScale: 8, maxTicks: 60000 })
  const R = makeRoom('long', r.json)
  /* 防守策略 v2：必堵>威胁前瞻（模拟落子后：对方 winNow 数重罚+danger 高分罚+窗分收益）
   * >缓铺；绝不主动取胜点（winNow 过滤）→ 拖长 */
  const defense = (st, seat) => {
    const f = S.feat(st, seat)
    const lg = S.legal(st, seat)
    if (!lg.length) return -1
    if (f.mustBlock && f.mustBlock.length && lg.includes(f.mustBlock[0])) {
      /* 双威胁（mustBlock≥2）堵不成——挑同时压最多点的格 */
      if (f.mustBlock.length === 1) return f.mustBlock[0]
      return f.mustBlock[0]
    }
    const near = new Set()
    for (let c = 0; c < 225; c++) {
      if (st.board[c] === 0) continue
      const rr = (c / 15) | 0, cc = c % 15
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const r2 = rr + dr, c2 = cc + dc
        if (r2 >= 0 && r2 < 15 && c2 >= 0 && c2 < 15 && st.board[r2 * 15 + c2] === 0) near.add(r2 * 15 + c2)
      }
    }
    const cand = [...near].sort((a, b) => a - b).filter((c) => !(f.winNow || []).includes(c))
    if (!cand.length) return lg[(st.moveNo * 3 + 1) % lg.length]
    let best = cand[0], bestScore = -Infinity
    for (const c of cand) {
      const b2 = st.board.slice(); b2[c] = seat + 1
      const f2 = S.feat({ board: b2, rule: 'gomoku' }, seat)
      const foeWin = (f2.mustBlock || []).length
      const foeDanger = (f2.danger || []).reduce((a, t) => a + Math.max(0, t.lv - 4000), 0)
      const sc = f2.score - 1000000 * foeWin - 6 * foeDanger
      if (sc > bestScore) { bestScore = sc; best = c }
    }
    return best
  }
  const t0 = Date.now()
  let lastSpot = 0, lastPlace = 0
  while (Date.now() - t0 < 48000 && !R.done) {
    const s = await R.pull()
    if (!s || !s.ok) break
    if (R.ended || (s.state && s.state.over)) { R.done = true; break }
    const st = s.state
    if (st.phase === 'live' && st.turn === R.seat && Date.now() - lastPlace >= 400) {
      const mv = defense(st, R.seat)
      if (mv >= 0) { await input(R.id, 'place', { op: { k: 'place', cell: mv } }); lastPlace = Date.now() }
    } else await sleep(120)
    if (Date.now() - t0 - lastSpot >= 2000) {
      lastSpot = Date.now() - t0
      const st2 = R.last.state
      R.spots.push({ wall: Math.round(lastSpot), tick: R.last.tick, moveNo: st2.moveNo, clock: st2.clock[0] + st2.clock[1], hash: R.last.stateHash, stones: st2.board.filter((v) => v).length })
    }
  }
  const st = R.last && R.last.state
  const spots = R.spots
  const tickMax = Math.max(0, ...(spots.map((p) => p.tick).concat(R.last ? [R.last.tick] : [])))
  const tickMono = spots.every((p, i) => i === 0 || p.tick > spots[i - 1].tick)
  const clockDesc = spots.every((p, i) => i === 0 || p.clock < spots[i - 1].clock)
  const places = st ? st.opsLog.filter((o) => o.k === 'place').length : -1
  const stones = st ? st.board.filter((v) => v).length : -1
  const moveOk = st ? st.moveNo === places : false
  ok('L1', '长局 spot·连续采样（tick 单调+棋钟递减+hash 演化）+账本对账（opsLog 手数==盘面==moveNo）',
    spots.length >= 6 && tickMono && clockDesc && places >= 0 && places === stones && moveOk,
    `spots×${spots.length} tick_max=${tickMax} moveNo=${st && st.moveNo} place 账=${places}=子数${R.ended ? ' 终局=' + R.ended.result.reason + '/' + R.ended.result.winner : ''}`)
  ok('L1', '长局 5min 局钟覆盖（≥30000 tick；棋钟制单局上界=240s×2，另见观察项）',
    tickMax >= 30000,
    `tick_max=${tickMax}（${R.ended ? 'reason=' + R.ended.result.reason : '窗口止于预算'}——spots hash ${spots.length ? spots[0].hash + '→' + spots[spots.length - 1].hash : 'n/a'}）`)
  await killRoom(R.id)
}

/* ============ F1 取证（P0 退回：reversi 盲堵假 afk） ============ */
console.log('── F1 取证·reversi 盲堵假 afk ──')
{
  /* 位面解剖（自包含确定性搜索）：离线直驱 casual 局逐手校验 brain 着点合法性，
   * 首个「着点 ∉ legal」位面即停——reversi/cascade 各搜一例；在线 seed 20261016
   * 同病（winner=A/reason=afk，opsLog $timeout×3 + timeout-move 零事件，取证在档） */
  let dissect = null
  for (const rule of ['reversi', 'cascade']) {
    for (const seed of [20261016, 11, 12, 13, 14, 15, 16, 17, 18, 703, 711, 712]) {
      const st = S.create(seed, { rule })
      const lv = ['casual', 'casual']
      let g = 0
      while (!st.over && g++ < 90000) {
        const inputs = {}
        let stop = false
        for (let s = 0; s < 2 && !stop; s++) {
          if (!lv[s] || st.turn !== s) continue
          const b = S.brain(st, s, lv[s])
          if (b && b.op) {
            if (!S.legal(st, s).includes(b.op.cell)) { dissect = dissect || {}; dissect[rule] = { st, s, cell: b.op.cell, seed }; stop = true; break }
            inputs[s] = { op: b.op }
          }
        }
        if (stop) break
        S.step(st, inputs)
      }
      if (dissect && dissect[rule]) break
    }
  }
  const dR = dissect && dissect.reversi, dC = dissect && dissect.cascade
  const disOne = (d, alsoBalanced) => {
    if (!d) return null
    const legal = S.legal(d.st, d.s)
    const f = S.feat(d.st, d.s)
    const cN = S.casualNext(d.st, d.s), bN = alsoBalanced ? S.balancedNext(d.st, d.s) : null
    let good = legal.length > 0 && f.mustBlock && f.mustBlock.length > 0 && d.cell === f.mustBlock[0]
      && !legal.includes(f.mustBlock[0]) && cN === f.mustBlock[0]
    if (alsoBalanced && bN !== f.mustBlock[0]) good = false
    return good ? { legal: legal.length, mb: f.mustBlock[0], cN, bN, seed: d.seed, s: d.s } : null
  }
  const rR = disOne(dR, true), rC = disOne(dC, false)
  ok('F1', '位面解剖（reversi 双验+cascade 单验）：feat.mustBlock[0] 对己方非法，casual/balanced 无条件盲返（applyOp 必拒→同 rng 逐 tick 重试同格）',
    !!rR && !!rC,
    `reversi seed=${rR ? rR.seed : '-'} 席${rR ? rR.s : '-'}：legal=${rR ? rR.legal : 0} 格不含 ${rR ? rR.mb : '-'}，casualNext→${rR ? rR.cN : '-'} balancedNext→${rR ? rR.bN : '-'}｜cascade seed=${rC ? rC.seed : '-'} 席${rC ? rC.s : '-'}：legal=${rC ? rC.legal : 0} 格不含 ${rC ? rC.mb : '-'}（gomoku 对照干净：mustBlock 恒空格=合法）`)
  /* 面宽：离线直驱 20 局（5 档位×4 seed）假 afk 率（gomoku 对照 0） */
  const quickGame = (rule, lvA, lvB, seed) => {
    const st2 = S.create(seed, { rule })
    const lv = [lvA, lvB]
    let g = 0
    while (!st2.over && g++ < 90000) {
      const inputs = {}
      for (let s = 0; s < 2; s++) { if (!lv[s] || st2.turn !== s) continue; const b = S.brain(st2, s, lv[s]); if (b && b.op) inputs[s] = { op: b.op } }
      S.step(st2, inputs)
    }
    return st2
  }
  let afkR = 0, totR = 0
  for (const pair of [['casual', 'casual'], ['balanced', 'casual'], ['balanced', 'balanced'], ['competitive', 'casual'], ['competitive', 'balanced']])
    for (const seed of [11, 12, 13, 14]) { const x = quickGame('reversi', pair[0], pair[1], seed); totR++; if (x.result.reason === 'afk') afkR++ }
  let afkG = 0
  for (const pair of [['casual', 'casual'], ['balanced', 'casual'], ['competitive', 'casual']]) for (const seed of [11, 12]) { const x = quickGame('gomoku', pair[0], pair[1], seed); if (x.result.reason === 'afk') afkG++ }
  ok('F1', '面宽：reversi bot 对打假 afk 率（在线同 seed 复现 11/20 一致量级；gomoku 对照 0）',
    afkR >= 5 && afkG === 0,
    `reversi ${afkR}/${totR} 假 afk（托管三层①casual 代走②hosted balanced③bot 席全走同脑路径）；gomoku ${afkG}/6`)
}

console.log(`\n${failed === 0 ? 'QA1-NET OK' : 'QA1-NET FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
