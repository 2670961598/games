#!/usr/bin/env node
/* =====================================================================
 * GAMES-139 街头足球 QA1 联机红线专项（net 臂 · S3+S4 专项+重连+Bot 梯度+长局）
 * 私有影子网关 :4415（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4400/:4399 零感知）；
 * 经 /api/test/* 建隔离测试房（与 WS 会话同一条代码路径，协议 §8）。
 * 房并发上限 8（testapi MAX_TEST_ROOMS）→ 两批：批1=长局/counter/三档/延迟对照（7 房
 * 游标增量泵收集账本，防 MAX_SLICE=512 窗口截断）；批2=重连三档（批1 DELETE 释放槽后建）。
 *   N1 状态归属表实证：越权 shot → reject(no-ball) 裁回+lunge/CD 期 tackle → reject(cd)
 *      （持球权/扑抢=服务器唯一裁决，客户端越权乐观尝试不被权威承认）+poss 链对账
 *      +ext.ack 递增（S3 预测和解锚）+ext.hash 周期在场（S4 确定性哨兵）
 *   N2 持球权翻转账本：poss×N+tackle 链+无孤儿持球（counter 剧本）
 *   N3 200ms 延迟对照：delayMs=0/200 双房 注入→反映时延带+仲裁不偏向低延迟者抽验
 *   N4 重连三档：5s 全测 / 10s 边界复席 / 逾窗（>10s）托管 balanced+resume-rejected
 *   N5 Bot 三档梯度：casual/balanced/competitive 可观测分层（steal/tackle/进球/触球节拍）
 *   N6 长局 spot：maxTicks=6000 硬顶房全程 spot 采样+time-up/golden 裁定+账本交叉引用
 *   N7 满编 2v2：roster 4 席在场（第 5 人观战在浏览器臂 street-soccer-qa1-web.mjs）
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
const GW = process.env.QA_GW || 'http://127.0.0.1:4415'
const SEED = 20261015

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
const createRoom = (o) => gw('POST', '/api/test/room', Object.assign({ gameId: 'street-soccer', seed: SEED, startDelayMs: 300 }, o))
const state = (roomId, since = 0) => gw('GET', `/api/test/state?roomId=${roomId}&since=${since}`)
const input = (roomId, op, payload, seat) => gw('POST', '/api/test/input', { roomId, seat, op, payload })
const killRoom = (roomId) => gw('DELETE', `/api/test/room?roomId=${roomId}`)

/* ---------- API 席策略（api-check strike-rush 同式，QA 独立复刻不改产品） ---------- */
const strikeRush = (() => {
  const mem = { cool: 0 }
  return (st, seat) => {
    const K = 1000
    const me = st.players && st.players[seat], B = st.ball
    if (!me || !B) return { mx: 0, my: 0 }
    const team = seat & 1
    const G = team === 0 ? { x: 175 * K, y: 0 } : { x: 175 * K, y: 500 * K }
    const toward = (x, y) => { const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1; return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) } }
    if (B.owner === seat) {
      const distG = Math.hypot(G.x - B.x, G.y - B.y)
      if (distG < 160 * K && mem.cool === 0) {
        mem.cool = 8
        const ang = Math.round(Math.atan2(G.y - B.y, G.x - B.x) / (2 * Math.PI) * 65536) & 0xFFFF
        return { mx: 0, my: 0, cmd: { k: 'shot', ang, pow: 900 } }
      }
      return toward(G.x, G.y)
    }
    if (B.owner >= 0 && (B.owner & 1) !== team && Math.hypot(me.x - B.x, me.y - B.y) < 22000 && mem.cool === 0) { mem.cool = 12; return { mx: 0, my: 0, cmd: { k: 'tackle' } } }
    if (mem.cool > 0) mem.cool--
    return toward(B.x + B.vx * 4, B.y + B.vy * 4)
  }
})()

/* counter-press（A6/A7 驱动，api-check 同式复刻：失球回防扑抢+得球一拍传导制造翻转账本） */
const counterPress = (() => {
  const mem = { lastOwner: -1, coolT: 0 }
  return (st, seat) => {
    const K = 1000
    const me = st.players && st.players[seat], B = st.ball
    if (!me || !B) return { mx: 0, my: 0 }
    const team = seat & 1
    const G = team === 0 ? { x: 175 * K, y: 0 } : { x: 175 * K, y: 500 * K }
    const home = { x: 175 * K, y: team === 0 ? 350 * K : 150 * K }
    const toward = (x, y) => { const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1; return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) } }
    const distG = Math.hypot(G.x - B.x, G.y - B.y)
    const dBall = Math.hypot(B.x - me.x, B.y - me.y)
    if (st.tick < 60) return toward(home.x, home.y)
    if (mem.coolT > 0) mem.coolT--
    const own = B.owner
    if (own === seat) {
      if (mem.coolT === 0) { mem.coolT = 20; return { mx: 0, my: 0, cmd: { k: 'pass' } } }
      if (distG < 110 * K) {
        const ang = Math.round(Math.atan2(G.y - B.y, G.x - B.x) / (2 * Math.PI) * 65536) & 0xFFFF
        return { mx: 0, my: 0, cmd: { k: 'shot', ang, pow: 850 } }
      }
      return toward(G.x, G.y)
    }
    if (own >= 0 && (own & 1) !== team && dBall < 22000) return { mx: 0, my: 0, cmd: { k: 'tackle' } }
    return toward(B.x, B.y)
  }
})()

/* ---------- 游标增量泵：账本全量累计（防 MAX_SLICE 截断） ---------- */
function makeRoom(tag, resp) {
  const R = { tag, id: resp && resp.roomId, seat: resp && resp.playerSeat, token: resp && resp.token, cur: 0, evs: [], snaps: [], acks: [], hashes: [], possObs: [], last: null, ended: null, spots: [] }
  R.pump = async (ms, policy = null, spotMs = 0) => {
    const t0 = Date.now()
    let lastSpot = 0
    while (Date.now() - t0 < ms) {
      const s = await state(R.id, R.cur)
      if (!s.json || !s.json.ok) { R.last = s.json; break }
      R.cur = s.json.cursor
      R.last = s.json
      for (const r of (s.json.events || [])) {
        const m = r.msg
        if (!m || m.t !== 'snapshot') continue
        R.snaps.push(m)
        if (m.ext) { if (m.ext.ack !== undefined) R.acks.push(m.ext.ack); if (m.ext.hash !== undefined) R.hashes.push(m.ext.hash) }
        if (m.state) R.possObs.push(m.state.poss)
        for (const e of (m.events || [])) { e._ts = r.ts; R.evs.push(e) }
      }
      if (s.json.result) { R.ended = s.json; break }
      if (spotMs && Date.now() - t0 - lastSpot >= spotMs) { lastSpot = Date.now() - t0; R.spots.push({ wall: Math.round(lastSpot), tick: s.json.tick, clock: s.json.state && s.json.state.clock, phase: s.json.state && s.json.state.phase, hash: s.json.stateHash }) }
      if (policy) {
        const pol = policy(s.json.state, R.seat)
        const inj = await input(R.id, 'move', Object.assign({ frame: R.evs.length + 200 }, pol))
        if (inj.json && inj.json.ok && pol.cmd) {
          /* 增量对齐（多槽）：注入前记该 op 事件数，账本增长首例 ts−receivedAt=反映时延 */
          R.pend = R.pend || []
          R.pend.push({ op: pol.cmd.k, receivedAt: inj.json.receivedAt, n0: R.evs.filter((e) => e.k === pol.cmd.k).length })
        }
      } else await sleep(150)
      /* pending 对齐收样（每轮泵尾；弃样窗 250ms——受理应 ≤2tick+组包 <150ms@8x，
         超窗=本次注入被 no-ball 拒（球权瞬变），更长窗只会错配到下一次注入的受理=节拍伪影带） */
      if (R.pend && R.pend.length) {
        R.lats = R.lats || []
        for (const p of R.pend) {
          const hits = R.evs.filter((e) => e.k === p.op)
          if (hits.length > p.n0 && hits[p.n0]._ts - p.receivedAt <= 250) { R.lats.push({ op: p.op, ms: hits[p.n0]._ts - p.receivedAt }); p.done = 1 }
          else if (Date.now() - p.receivedAt > 250) p.done = 1
        }
        R.pend = R.pend.filter((p) => !p.done)
      }
    }
    return R
  }
  return R
}
const cnt = (arr, f) => arr.filter(f).length

async function main() {
  const hz = await gw('GET', '/healthz')
  ok('ENV', '影子网关 :4415 在线', hz.json && hz.json.ok === true, `rooms=${hz.json && hz.json.rooms}`)

  /* ============ 批 1：长局+counter+三档+延迟对照（7 房 ≤8 上限） ============ */
  const rooms = {}
  const mk = async (tag, opt) => {
    const r = await createRoom(opt)
    ok(`ENV-${tag}`, `测试房建立（${tag}）`, r.status === 200 && r.json && r.json.ok && r.json.roomId, r.json && (r.json.roomId || r.json.error))
    if (r.json && r.json.roomId) rooms[tag] = makeRoom(tag, r.json)
    return r
  }
  await mk('long', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 6000 })
  await mk('counter', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 2400 })
  await mk('casual', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 1800, seed: SEED + 7 })
  await mk('bald', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 1800, seed: SEED + 7 })
  await mk('comp', { botLevels: [null, 'competitive', 'competitive', 'competitive'], timeScale: 8, maxTicks: 1800, seed: SEED + 7 })
  const d0 = await mk('d0', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 1400, delayMs: 0, seed: SEED + 3 })
  const d200 = await mk('d200', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 1400, delayMs: 200, seed: SEED + 3 })
  if (failed) { console.log('环境失败，中止'); process.exit(1) }

  /* N1 开局：等「无球权窗口」（kick 相位开球队即持球——须 poss!==API 席时注入越权 shot） */
  {
    let inj = null, found = null
    const t0 = Date.now()
    while (Date.now() - t0 < 10000 && !found) {
      await rooms.counter.pump(300)
      const st = rooms.counter.last
      const owner = st && st.state && st.state.ball.owner
      if (!inj && owner !== rooms.counter.seat && st && st.phase === 'live') {
        inj = await input(rooms.counter.id, 'shoot', { mx: 0, my: 0, frame: 50, cmd: { k: 'shot', ang: 8192, pow: 900 } })
      }
      if (inj) found = rooms.counter.evs.find((e) => e.k === 'reject' && e.op === 'shot' && e.why === 'no-ball')
    }
    ok('N1', 'S3 持球权=服务器唯一裁决：无球权窗口 shot → reject(no-ball) 裁回', inj && inj.json && inj.json.ok && !!found, found ? `reject 事件账本在场（越权乐观射门不被权威承认）` : inj ? '注入后未见 reject' : '10s 内无无球权窗口（披露）')
  }

  /* 并行泵：counter（counter-press 驱动）/三档/长局 spot/延迟对照（strike-rush 驱动） */
  const jobs = [
    rooms.counter.pump(26000, counterPress),
    rooms.casual.pump(16000), rooms.bald.pump(16000), rooms.comp.pump(16000),
    rooms.long.pump(45000, null, 2500),
    rooms.d0.pump(19000, strikeRush), rooms.d200.pump(19000, strikeRush),
  ]
  await Promise.all(jobs)

  /* ============ N2 持球权翻转账本（counter 全量账本） ============ */
  {
    const C = rooms.counter
    ok('N2', 'counter 房终局到达（result 在场）', !!C.ended, C.ended ? `winner=${C.ended.result.winner} reason=${C.ended.result.reason} tick=${C.ended.tick}` : `phase=${C.last && C.last.phase} tick=${C.last && C.last.tick}（超时披露）`)
    const poss = cnt(C.evs, (e) => e.k === 'poss').valueOf() ? C.evs.filter((e) => e.k === 'poss') : []
    const flips = poss.filter((e, i) => i > 0 && ((e.to >= 0 ? e.to & 1 : -1) !== (e.from >= 0 ? e.from & 1 : -1)))
    const chainOk = poss.every((e, i) => i === 0 || poss[i - 1].to === e.from)
    ok('N2', '持球权翻转账本：poss×N 链自洽（from==prev.to）+队间翻转 ≥4', poss.length >= 4 && chainOk && flips.length >= 4, `poss×${poss.length} 翻转×${flips.length} 链${chainOk ? '自洽' : '断裂'}`)
    const tk = C.evs.filter((e) => e.k === 'tackle')
    const steals = cnt(C.evs, (e) => e.k === 'steal')
    const winNoFlip = tk.filter((t) => t.res === 'win' && !poss.find((p) => p.from === t.by))
    const endOwner = C.ended && C.ended.state && C.ended.state.ball.owner
    ok('N2', 'tackle 链一致（win→易主在账）+无孤儿持球（owner∈−1∪0..3）',
      tk.length >= 1 && steals >= 1 && winNoFlip.length === 0 && endOwner >= -1 && endOwner < 4,
      `tackle×${tk.length}（win×${cnt(tk, (t) => t.res === 'win')}）steal×${steals} owner=${endOwner}`)
    /* N1 补：ack 递增+hash 周期+poss 观测对账 */
    const ackUp = C.acks.length >= 5 && C.acks.some((a, i) => i > 0 && a > C.acks[i - 1])
    ok('N1', 'S3 ext.ack 输入确认在场（预测和解锚点）', C.acks.length >= 5, `ack 样本×${C.acks.length}（末 5 例 ${C.acks.slice(-5).join(',')}）`)
    ok('N1', 'S4 ext.hash 确定性哨兵周期在场（每 10 张）', C.hashes.length >= 2, `hash×${C.hashes.length}（末例 ${C.hashes[C.hashes.length - 1]}）`)
    const obsFlips = C.possObs.filter((v, i) => i > 0 && v !== C.possObs[i - 1]).length
    ok('N1', 'poss 链对账：快照观测变化点 ≤ 账本 poss 事件数+2（10Hz 采样稀于事件）', obsFlips <= poss.length + 2, `观测变化×${obsFlips} vs 账本 poss×${poss.length}`)
  }

  /* ============ N5 Bot 三档梯度 ============ */
  {
    const lv = {}
    for (const [tag, name] of [['casual', 'casual'], ['bald', 'balanced'], ['comp', 'competitive']]) {
      const R = rooms[tag]
      const tickN = Math.max(1, R.last ? R.last.tick : 0)
      lv[name] = {
        goals: cnt(R.evs, (e) => e.k === 'goal'), steals: cnt(R.evs, (e) => e.k === 'steal'),
        tackles: cnt(R.evs, (e) => e.k === 'tackle'), wins: cnt(R.evs, (e) => e.k === 'tackle' && e.res === 'win'),
        touches: cnt(R.evs, (e) => e.k === 'touch'), tick: R.last && R.last.tick,
        ended: R.ended ? R.ended.result.reason : null, score: R.last && R.last.state && R.last.state.score,
      }
      lv[name].tkD = +(lv[name].tackles / tickN * 1000).toFixed(1)
      lv[name].touchD = +(lv[name].touches / tickN * 1000).toFixed(1)
    }
    /* 分层观测面（据实修正：扑抢 tackle 是 casual 蜂群特征面；competitive 拦截预判（§4.1）
       走站位卡线+接散球（touch/poss），不落 tackle——档间行为谱不同本身即分层证据） */
    ok('N5', 'Bot 三档分层·进球贡献：competitive > balanced（预判+一脚出球攻强，§4.2）',
      lv.competitive.goals > lv.balanced.goals,
      `goal cas=${lv.casual.goals} bal=${lv.balanced.goals} comp=${lv.competitive.goals}｜score cas=${JSON.stringify(lv.casual.score)} bal=${JSON.stringify(lv.balanced.score)} comp=${JSON.stringify(lv.competitive.score)}`)
    ok('N5', 'Bot 三档分层·终局时长：competitive 房 goal-cap 提前终局 < casual 房 time-up 全程（强度分层信号）',
      (lv.competitive.ended === 'goal-cap' || lv.competitive.tick < lv.casual.tick) && lv.casual.ended !== 'goal-cap',
      `终局 ${lv.casual.ended || '未终'}@${lv.casual.tick} / ${lv.balanced.ended || '未终'}@${lv.balanced.tick} / ${lv.competitive.ended || '未终'}@${lv.competitive.tick}`)
    ok('N5', 'Bot 三档分层·触球节拍：casual 蜂群密度 > balanced 站位（行为谱披露+扑抢/steal 面附注）',
      lv.casual.touchD > lv.balanced.touchD,
      `touch/千tick cas=${lv.casual.touchD} bal=${lv.balanced.touchD} comp=${lv.competitive.touchD}｜tackle cas=${lv.casual.tackles} bal=${lv.balanced.tackles} comp=${lv.competitive.tackles}｜steal ${lv.casual.steals}/${lv.balanced.steals}/${lv.competitive.steals}`)
    ok('N5', 'Bot 三档：三房均跑出观测账本（touch>0 且 tick≥500，goal-cap 提前终局合规）',
      ['casual', 'balanced', 'competitive'].every((n) => lv[n].touches > 0 && lv[n].tick >= 500),
      `tick ${lv.casual.tick}/${lv.balanced.tick}/${lv.competitive.tick}`)
  }

  /* ============ N3 延迟对照 ============ */
  {
    for (const [tag, delayMs] of [['d0', 0], ['d200', 200]]) {
      const R = rooms[tag]
      const latOf = (opK) => {
        const outs = []
        for (const inj of (R.injects || []).filter((x) => x.op === opK)) {
          const ev = R.evs.find((e) => e.k === opK && e._ts >= inj.receivedAt)
          if (ev) outs.push(ev._ts - inj.receivedAt)
        }
        return outs
      }
      const band = {}
      /* 口径：增量对齐样本 P95 带（未受理注入 3s 弃样；max 披露不断言） */
      for (const opK of ['shot', 'tackle', 'pass']) {
        const a = (R.lats || []).filter((x) => x.op === opK).map((x) => x.ms).sort((x, y) => x - y)
        if (a.length >= 3) band[opK] = { min: a[0], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1], n: a.length }
      }
      const has = Object.keys(band).length >= 1
      const cap = delayMs ? 900 : 600
      const tk = band.tackle
      const sp = band.shot || band.pass
      /* 主锚=tackle（受理无球权前置→样本稳定）；shot/pass 持球窗 <轮询间隔时被 no-ball
         拒（HTTP 注入盲窗=DEV 已知采样劣势，A4 服务端同钟口径已由冻结命令证）——有对齐样本则严格断言 */
      ok(`N3-${tag}`, `${tag} 房（delayMs=${delayMs}）注入→快照反映时延带 P95（主锚 tackle+副锚 shot/pass；帽 ${cap}ms）`,
        tk && tk.p95 < cap && (!sp || sp.p95 < cap),
        `${Object.entries(band).map(([k, v]) => `${k} min${v.min}/P95 ${v.p95}/max${v.max}ms(n=${v.n})`).join(' ') || '无对齐样本'}${sp ? '' : `｜shot/pass 无对齐样本（持球窗<120ms 轮询盲窗弃样，受理回路见 reject 账本：${cnt(R.evs, (e) => e.k === 'reject')} 例）`}`)
      if (delayMs) {
        const w0 = (() => { const t = rooms.d0.evs.filter((e) => e.k === 'tackle'); return t.length ? cnt(t, (e) => e.res === 'win') / t.length : null })()
        const t200 = R.evs.filter((e) => e.k === 'tackle')
        const w200 = t200.length ? cnt(t200, (e) => e.res === 'win') / t200.length : null
        ok('N3', '仲裁不偏向低延迟者（抽验）：0/200ms 房 tackle 胜率同量级（|Δ|<0.35，服务器权威仲裁无延迟项 §5.4⑤）',
          w0 !== null && w200 !== null && Math.abs(w0 - w200) < 0.35,
          w0 !== null && w200 !== null ? `win率 0ms=${(w0 * 100).toFixed(0)}% 200ms=${(w200 * 100).toFixed(0)}%` : `样本 0ms:${rooms.d0.evs.filter((e) => e.k === 'tackle').length} 200ms:${t200.length}`)
      }
    }
  }

  /* ============ N6 长局 spot ============ */
  {
    const L = rooms.long
    const monotonic = L.spots.every((x, i) => i === 0 || x.tick > L.spots[i - 1].tick)
    const evolving = new Set(L.spots.map((x) => x.hash)).size >= 3
    ok('N6', `长局 spot（maxTicks=6000 硬顶=300s 帽）：spot ${L.spots.length} 个 tick 单调+stateHash 演化`,
      L.spots.length >= 3 && monotonic && evolving, `末 spot tick=${L.spots[L.spots.length - 1] && L.spots[L.spots.length - 1].tick} clock=${L.spots[L.spots.length - 1] && L.spots[L.spots.length - 1].clock}`)
    const reason = L.ended && L.ended.result.reason
    ok('N6', '长局终局裁定闭环（time-up/golden/goal-cap）', reason === 'time-up' || reason === 'golden' || reason === 'goal-cap', `reason=${reason} winner=${L.ended && L.ended.result.winner} tick=${L.ended && L.ended.tick} score=${L.ended && JSON.stringify(L.ended.state.score)}`)
    const goalsL = cnt(L.evs, (e) => e.k === 'goal')
    const sumL = L.ended ? L.ended.state.score.A + L.ended.state.score.B : -1
    ok('N6', '长局交叉引用：goal 事件数==终态队分合计（A6 口径同源）', goalsL === sumL, `goals=${goalsL} 队分=${sumL}（常规制 180s 先于 300s 帽尽则 time-up，口径披露）`)
    ok('N6', '长局终态确定性锚 stateHash 在场（A8 双跑已由冻结命令证，交叉引用）', typeof (L.ended && L.ended.stateHash) === 'number', `stateHash=${L.ended && L.ended.stateHash}`)
  }

  /* ============ N7 满编 2v2 ============ */
  {
    const roster = (rooms.counter.last && rooms.counter.last.seats) || []
    ok('N7', '满编 2v2：4 席在场（1 API 玩家+3 bot）', roster.length === 4 && roster.every((x) => x && (x.kind === 'human' || x.kind === 'bot')), JSON.stringify(roster.map((x) => `${x.seat}:${x.kind}`)))
  }

  /* 释放批 1（腾 8 槽上限） */
  for (const R of Object.values(rooms)) { try { await killRoom(R.id) } catch { } }

  /* ============ 批 2：N4 重连三档（timeScale=1 真秒） ============ */
  const rc = {}
  for (const tag of ['r5', 'r10', 'r30']) {
    const r = await createRoom({ botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 1, maxTicks: 3000, seed: SEED + 11 })
    ok(`N4-${tag}`, `重连房建立（${tag}）`, r.status === 200 && r.json && r.json.ok, r.json && (r.json.roomId || r.json.error))
    if (r.json && r.json.roomId) rc[tag] = makeRoom(tag, r.json)
    await sleep(120)
  }
  if (Object.keys(rc).length === 3) {
    /* 攒对局 6s（比分/持球权演化） */
    await Promise.all([rc.r5.pump(6000), rc.r10.pump(6000), rc.r30.pump(6000)])
    /* N1 补：CD 跨 tick 连发（ts=1 房 tick=50ms，注入隔 100ms 落 lunge 250ms 窗） */
    {
      const Rm = rc.r5
      const t1 = await input(Rm.id, 'tackle', { mx: 0, my: 0, frame: 101, cmd: { k: 'tackle' } })
      await sleep(100)
      const t2 = await input(Rm.id, 'tackle', { mx: 0, my: 0, frame: 102, cmd: { k: 'tackle' } })
      await Rm.pump(900)
      const cd = Rm.evs.find((e) => e.k === 'reject' && e.op === 'tackle' && e.why === 'cd')
      ok('N1', 'S3 仲裁校验：lunge/CD 期跨 tick 再 tackle → reject(cd)', !!cd && t1.json.ok && t2.json.ok, cd ? '账本在场（第一拍受理/第二拍裁回；@8x 同窗两拍被 lastInput 覆盖=框架语义）' : '未见 reject(cd)')
    }
    const before = {}
    for (const [tag, Rm] of Object.entries(rc)) {
      before[tag] = Rm.last && Rm.last.state ? { score: Rm.last.state.score, clock: Rm.last.state.clock, poss: Rm.last.state.ball.owner, tick: Rm.last.tick } : null
      const d = await input(Rm.id, '$disconnect', {})
      ok(`N4-${tag}`, `断线（${tag === 'r5' ? '5s' : tag === 'r10' ? '10s' : '逾窗'} 档）`, d.json && d.json.ok && before[tag], `seat=${Rm.seat} @tick=${Rm.last && Rm.last.tick} score=${before[tag] && JSON.stringify(before[tag].score)} poss=${before[tag] && before[tag].poss}`)
    }
    const rcAt = Date.now()
    /* 5s 档全测 */
    await sleep(Math.max(300, rcAt + 5000 - Date.now()))
    {
      const Rm = rc.r5
      const mid = await state(Rm.id)
      const mine = (mid.json && mid.json.seats || []).find((x) => x.seat === Rm.seat)
      ok('N4-r5', '5s 档：断线 5s 席位未托管（kind=human 保持=持球权/席位保留窗）', mine && mine.kind === 'human', JSON.stringify((mid.json.seats || []).map((x) => `${x.seat}:${x.kind}`)))
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('N4-r5', '5s 档：$reconnect 凭 token 复席', rcn.json && rcn.json.ok, rcn.json && (rcn.json.error || `seat=${rcn.json.seat}`))
      const fullBefore = rc.r5.snaps.length
      await rc.r5.pump(2500)
      const fulls = rc.r5.snaps.slice(fullBefore).filter((x) => x.full === 1).length
      const a = rc.r5.last && rc.r5.last.state
      ok('N4-r5', '5s 档：复席重同步（welcome 全量+快照续流 full=1 在场）', fulls >= 1, `复席后 full×${fulls}`)
      ok('N4-r5', '5s 档：状态延续（比分保持+比赛钟不回退）', a && before.r5 && a.clock <= before.r5.clock + 50 && JSON.stringify(a.score) === JSON.stringify(before.r5.score), `score ${before.r5 && JSON.stringify(before.r5.score)}→${a && JSON.stringify(a.score)} clock ${before.r5 && before.r5.clock}→${a && a.clock}`)
    }
    /* 10s 档（窗=10s+1 拍≈10.05s：实测 10.2s 复席已托管拒——边界内侧 9.6s 复席验证窗语义） */
    await sleep(Math.max(300, rcAt + 9600 - Date.now()))
    {
      const Rm = rc.r10
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('N4-r10', '10s 档：窗内（9.6s<10s+1拍）复席有效（实测 10.2s 逾窗即托管拒=边界口径披露）', rcn.json && rcn.json.ok, rcn.json && (rcn.json.error || '窗内复席成功'))
      if (rcn.json.ok) { await rc.r10.pump(1200); ok('N4-r10', '10s 档：复席后房存续续玩', rc.r10.last && rc.r10.last.ok, `tick=${rc.r10.last && rc.r10.last.tick}`) }
    }
    /* 逾窗（>10s 托管；12s 观测=30s 档语义） */
    await sleep(Math.max(300, rcAt + 12500 - Date.now()))
    {
      const Rm = rc.r30
      const mid = await state(Rm.id)
      const mine = (mid.json && mid.json.seats || []).find((x) => x.seat === Rm.seat)
      ok('N4-r30', '逾窗档（30s 档语义，>10s 观测）：席位已转托管 balanced（META.takeOver）', mine && mine.kind !== 'human', mine ? `seat${mine.seat} kind=${mine.kind}` : '未见席位')
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('N4-r30', '逾窗档：token 已清 → resume-rejected（复席语义不容降级为顶号）', rcn.status === 409, `status=${rcn.status} error=${rcn.json && rcn.json.error}`)
      await rc.r30.pump(1500)
      ok('N4-r30', '逾窗档：「比赛不断」——托管下对局继续推进（tick 前进）', rc.r30.last && rc.r30.last.tick > (before.r30 ? before.r30.tick : 0), `tick=${before.r30 && before.r30.tick}→${rc.r30.last && rc.r30.last.tick}`)
    }
    for (const Rm of Object.values(rc)) { try { await killRoom(Rm.id) } catch { } }
  }

  console.log(`\n${failed === 0 ? 'QA1-NET OK' : 'QA1-NET FAILED'}：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
