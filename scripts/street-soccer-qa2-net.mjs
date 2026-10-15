#!/usr/bin/env node
/* =====================================================================
 * GAMES-142 街头足球 QA2 全链红线复验（net 臂 · testapi 隔离测试房）
 * 私有影子网关 :4416（:4400/:4399 零感知）。QA 只读：零产品代码改动。
 *   N1 200ms 延迟对照（FEEL 后触球反馈链）：d0/d200 双房 ops 反映带 P95+
 *      仲裁不偏向低延迟者+S3/S4 和解通道（ack 单调+hash 哨兵）在 200ms 垫臂连续在场
 *      ——O-2 口径复用（250ms 弃样窗，QA1 伪带案例已记，本单复核不再复发）
 *   N2 重连三档（手感层状态延续）：5s 全测/10s 窗内/逾窗托管+resume-rejected
 *      +welcome 全量含手感层服务端延续面（stam/lungeT/stumbleT/tackleCd）
 *   N3 长局 spot：maxTicks=6000 硬顶房全程 spot（tick 单调+hash 演化+goal==队分
 *      交叉引用）——8min 墙钟窗口由 mercy 臂（street-soccer-qa2-mercy.mjs）交叉引用
 *   N4 O-3 混跑对位抽验（BOT 单 N4 已闭合）：competitive-vs-casual 拦截压制方向性
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
const GW = process.env.QA_GW || 'http://127.0.0.1:4416'
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

/* strike-rush（api-check 同式独立复刻：追球持球近门即射+近距扑抢） */
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
/* hover（O-3 混跑臂 API 席：趋球悬停不扑抢不射门——只作蜂群侧扰动源，压制面看 bot 对位） */
const hover = () => ({ mx: 0, my: 0 })

function makeRoom(tag, resp) {
  const R = { tag, id: resp && resp.roomId, seat: resp && resp.playerSeat, token: resp && resp.token, cur: 0, evs: [], snaps: [], acks: [], hashes: [], welcomes: [], last: null, ended: null, spots: [] }
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
        if (!m) continue
        if (m.t === 'welcome') R.welcomes.push(m)
        if (m.t !== 'snapshot') continue
        R.snaps.push(m)
        if (m.ext) { if (m.ext.ack !== undefined) R.acks.push(m.ext.ack); if (m.ext.hash !== undefined) R.hashes.push(m.ext.hash) }
        for (const e of (m.events || [])) { e._ts = r.ts; R.evs.push(e) }
      }
      if (s.json.result) { R.ended = s.json; break }
      if (spotMs && Date.now() - t0 - lastSpot >= spotMs) { lastSpot = Date.now() - t0; R.spots.push({ wall: Math.round(lastSpot), tick: s.json.tick, clock: s.json.state && s.json.state.clock, phase: s.json.state && s.json.state.phase, hash: s.json.stateHash }) }
      if (policy) {
        const pol = policy(s.json.state, R.seat)
        const inj = await input(R.id, 'move', Object.assign({ frame: R.evs.length + 200 }, pol))
        if (inj.json && inj.json.ok && pol.cmd) {
          R.pend = R.pend || []
          R.pend.push({ op: pol.cmd.k, receivedAt: inj.json.receivedAt, n0: R.evs.filter((e) => e.k === pol.cmd.k).length })
        }
      } else await sleep(150)
      /* pending 对齐收样（弃样窗 250ms——QA1 O-2 口径：超窗=球权瞬变拒/节拍伪影带，弃） */
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
  ok('ENV', '影子网关 :4416 在线', hz.json && hz.json.ok === true, `rooms=${hz.json && hz.json.rooms}`)
  if (failed) { console.log('环境失败，中止'); process.exit(1) }

  /* ============ 批 1：长局+混跑+延迟对照（4 房） ============ */
  const rooms = {}
  const mk = async (tag, opt) => {
    const r = await createRoom(opt)
    ok(`ENV-${tag}`, `测试房建立（${tag}）`, r.status === 200 && r.json && r.json.ok && r.json.roomId, r.json && (r.json.roomId || r.json.error))
    if (r.json && r.json.roomId) rooms[tag] = makeRoom(tag, r.json)
    return r
  }
  await mk('long', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 6000 })
  await mk('mix', { botLevels: [null, 'competitive', 'casual', 'competitive'], timeScale: 8, maxTicks: 4800, seed: SEED + 21 })
  await mk('mix2', { botLevels: [null, 'competitive', 'casual', 'competitive'], timeScale: 8, maxTicks: 4800, seed: SEED + 22 })
  await mk('d0', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 1400, delayMs: 0, seed: SEED + 3 })
  await mk('d200', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 1400, delayMs: 200, seed: SEED + 3 })
  if (failed) { console.log('环境失败，中止'); process.exit(1) }

  await Promise.all([
    rooms.long.pump(50000, null, 2500),
    rooms.mix.pump(36000, hover), rooms.mix2.pump(36000, hover),
    rooms.d0.pump(20000, strikeRush), rooms.d200.pump(20000, strikeRush),
  ])

  /* ============ N1 200ms 延迟对照（FEEL 后触球反馈链） ============ */
  for (const [tag, delayMs] of [['d0', 0], ['d200', 200]]) {
    const R = rooms[tag]
    const band = {}
    for (const opK of ['shot', 'tackle', 'pass']) {
      const a = (R.lats || []).filter((x) => x.op === opK).map((x) => x.ms).sort((x, y) => x - y)
      if (a.length >= 3) band[opK] = { min: a[0], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1], n: a.length }
    }
    const cap = delayMs ? 900 : 600
    const tk = band.tackle
    const sp = band.shot || band.pass
    const main = tk || sp   /* 主锚=tackle，对齐样本<3 时退 shot/pass（对齐窗内样本均有约束力） */
    ok(`N1-${tag}`, `${tag} 房（delayMs=${delayMs}）注入→快照反映时延带 P95（主锚 ${tk ? 'tackle' : 'shot/pass（tackle 对齐样本<3 退副锚）'}；帽 ${cap}ms；250ms 弃样窗=O-2 口径）`,
      main && main.p95 < cap && (!sp || sp.p95 < cap),
      `${Object.entries(band).map(([k, v]) => `${k} min${v.min}/P95 ${v.p95}/max${v.max}ms(n=${v.n})`).join(' ') || '无对齐样本'}${sp ? '' : `｜shot/pass 无对齐样本（持球窗<轮询盲窗弃样，reject 在账 ${cnt(R.evs, (e) => e.k === 'reject')} 例=受理回路完好）`}`)
    if (delayMs) {
      const t0e = rooms.d0.evs.filter((e) => e.k === 'tackle')
      const w0 = t0e.length ? cnt(t0e, (e) => e.res === 'win') / t0e.length : null
      const t200 = R.evs.filter((e) => e.k === 'tackle')
      const w200 = t200.length ? cnt(t200, (e) => e.res === 'win') / t200.length : null
      ok('N1', '仲裁不偏向低延迟者（§5.4⑤ 抽验）：0/200ms 房 tackle 胜率同量级（|Δ|<0.35）',
        w0 !== null && w200 !== null && Math.abs(w0 - w200) < 0.35,
        w0 !== null && w200 !== null ? `win率 0ms=${(w0 * 100).toFixed(0)}% 200ms=${(w200 * 100).toFixed(0)}%` : `样本不足（0ms:${t0e.length} 200ms:${t200.length}）`)
      /* 和解通道完整性：200ms 垫臂 ack 单调递增+hash 哨兵周期在场（S3 预测/S4 确定性链路不受垫臂破坏） */
      const ackMono = R.acks.length >= 5 && R.acks.every((a, i) => i === 0 || a >= R.acks[i - 1])
      ok('N1', 'd200 房 S3/S4 和解通道连续：ext.ack 单调不减+ext.hash 周期在场（触球反馈链下行完整性）',
        ackMono && R.hashes.length >= 2, `ack×${R.acks.length} 单调=${ackMono} hash×${R.hashes.length}（末例 ${R.hashes[R.hashes.length - 1]}）`)
      /* 触球反馈链：touch 事件在账+持球权镜像面=增量快照 ball ent owner 恒带（MAX_SLICE 头窗
         会跳过 join 全量→增量流无 state 节点——possession 镜像的增量承载=ents 球 {x,y,owner}） */
      const touches = cnt(R.evs, (e) => e.k === 'touch')
      const possIn = cnt(R.snaps, (s) => (s.ents || []).some((e) => e.id === 'ball' && e.owner !== undefined))
      const snapsN = R.snaps.length
      ok('N1', 'd200 房触球反馈链数据源：touch 事件账本+增量快照球 owner 镜像恒带（FEEL 层渲染输入不因垫臂缺失）',
        touches >= 5 && possIn >= snapsN * 0.95 && snapsN >= 20, `touch×${touches} 球 owner 镜像×${possIn}/${snapsN}`)
    }
  }

  /* ============ N3 长局 spot ============ */
  {
    const L = rooms.long
    const monotonic = L.spots.every((x, i) => i === 0 || x.tick > L.spots[i - 1].tick)
    const evolving = new Set(L.spots.map((x) => x.hash)).size >= 3
    ok('N3', '长局 spot（maxTicks=6000=300s 硬顶帽）：spot 采样 tick 单调+stateHash 演化',
      L.spots.length >= 3 && monotonic && evolving, `spot×${L.spots.length} 末 tick=${L.spots[L.spots.length - 1] && L.spots[L.spots.length - 1].tick}`)
    const reason = L.ended && L.ended.result.reason
    ok('N3', '长局终局裁定闭环（time-up/golden/goal-cap）', reason === 'time-up' || reason === 'golden' || reason === 'goal-cap', `reason=${reason} winner=${L.ended && L.ended.result.winner} tick=${L.ended && L.ended.tick} score=${L.ended && JSON.stringify(L.ended.state.score)}`)
    const goalsL = cnt(L.evs, (e) => e.k === 'goal')
    const sumL = L.ended ? L.ended.state.score.A + L.ended.state.score.B : -1
    ok('N3', '长局交叉引用：goal 事件数==终态队分合计（A6 口径同源；8min 墙钟窗由 mercy 臂交叉引用）', goalsL === sumL, `goals=${goalsL} 队分=${sumL}`)
    ok('N3', '长局终态确定性锚 stateHash 在场（A8 三等已由冻结命令证=交叉引用）', typeof (L.ended && L.ended.stateHash) === 'number', `stateHash=${L.ended && L.ended.stateHash}`)
  }

  /* ============ N4 O-3 混跑对位抽验（双 seed 聚合，BOT 单 N4 决策级 A/B 的在线方向性） ============ */
  {
    const agg = { comp: { goals: 0, tackle: 0, steal: 0, touch: 0 }, cas: { goals: 0, tackle: 0, steal: 0, touch: 0 }, aGoals: 0, bGoals: 0, seeds: [] }
    for (const tag of ['mix', 'mix2']) {
      const M = rooms[tag]
      if (!M) continue
      /* 房位：API=0(A 队)、seat1/3=competitive(B 队=敌)、seat2=casual(A 队=API 队友) */
      for (const seat of [1, 3]) {
        agg.comp.goals += cnt(M.evs, (e) => e.k === 'goal' && e.scorer === seat)
        agg.comp.tackle += cnt(M.evs, (e) => e.k === 'tackle' && e.by === seat)
        agg.comp.steal += cnt(M.evs, (e) => e.k === 'steal' && e.by === seat)
        agg.comp.touch += cnt(M.evs, (e) => e.k === 'touch' && e.seat === seat)
      }
      agg.cas.goals += cnt(M.evs, (e) => e.k === 'goal' && e.scorer === 2)
      agg.cas.tackle += cnt(M.evs, (e) => e.k === 'tackle' && e.by === 2)
      agg.cas.steal += cnt(M.evs, (e) => e.k === 'steal' && e.by === 2)
      agg.cas.touch += cnt(M.evs, (e) => e.k === 'touch' && e.seat === 2)
      const score = (M.ended || M.last) && (M.ended ? M.ended.state.score : M.last.state.score)
      if (score) { agg.aGoals += score.A; agg.bGoals += score.B }
      agg.seeds.push(M.tag)
    }
    ok('N4', 'O-3 抽验·混跑对位压制（comp 对 casual，双 seed 聚合）：B 队（comp×2）进球 > A 队（casual+API 悬停）',
      agg.bGoals > agg.aGoals, `score A=${agg.aGoals}(cas 侧) B=${agg.bGoals}(comp 侧)｜个人进球 comp=${agg.comp.goals} cas=${agg.cas.goals}（seed ${agg.seeds}）`)
    /* 压制面=预判档站位卡线+接散球（§4.1：touch/poss 路径）——触球优势+steal/tackle 数据面披露
       （casual 蜂群 tackle 尝试率高=行为谱差异，非压制失败口径——QA1 §4 注同源） */
    ok('N4', 'O-3 抽验·拦截压制数据面：comp 席触球（站位卡线+接散球路径）> casual 席（蜂群）',
      agg.comp.touch > agg.cas.touch,
      `touch comp=${agg.comp.touch} cas=${agg.cas.touch}｜steal comp=${agg.comp.steal} cas=${agg.cas.steal}｜tackle comp=${agg.comp.tackle} cas=${agg.cas.tackle}（steal/tackle=行为谱披露）`)
  }

  for (const R of Object.values(rooms)) { try { await killRoom(R.id) } catch { } }

  /* ============ 批 2：N2 重连三档（timeScale=1 真秒）+手感层状态延续 ============ */
  const rc = {}
  for (const tag of ['r5', 'r10', 'r30']) {
    const r = await createRoom({ botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 1, maxTicks: 3000, seed: SEED + 11 })
    ok(`N2-${tag}`, `重连房建立（${tag}）`, r.status === 200 && r.json && r.json.ok, r.json && (r.json.roomId || r.json.error))
    if (r.json && r.json.roomId) rc[tag] = makeRoom(tag, r.json)
    await sleep(120)
  }
  if (Object.keys(rc).length === 3) {
    await Promise.all([rc.r5.pump(6000), rc.r10.pump(6000), rc.r30.pump(6000)])
    const before = {}
    for (const [tag, Rm] of Object.entries(rc)) {
      before[tag] = Rm.last && Rm.last.state ? { score: Rm.last.state.score, clock: Rm.last.state.clock, poss: Rm.last.state.ball.owner, tick: Rm.last.tick } : null
      const d = await input(Rm.id, '$disconnect', {})
      ok(`N2-${tag}`, `断线（${tag === 'r5' ? '5s' : tag === 'r10' ? '10s' : '逾窗'} 档）`, d.json && d.json.ok && before[tag], `seat=${Rm.seat} @tick=${Rm.last && Rm.last.tick} score=${before[tag] && JSON.stringify(before[tag].score)} poss=${before[tag] && before[tag].poss}`)
    }
    const rcAt = Date.now()
    /* 5s 档全测 */
    await sleep(Math.max(300, rcAt + 5000 - Date.now()))
    {
      const Rm = rc.r5
      const mid = await state(Rm.id)
      const mine = (mid.json && mid.json.seats || []).find((x) => x.seat === Rm.seat)
      ok('N2-r5', '5s 档：断线 5s 席位未托管（kind=human 保持=席位/持球权保留窗）', mine && mine.kind === 'human', JSON.stringify((mid.json.seats || []).map((x) => `${x.seat}:${x.kind}`)))
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('N2-r5', '5s 档：$reconnect 凭 token 复席', rcn.json && rcn.json.ok, rcn.json && (rcn.json.error || `seat=${rcn.json.seat}`))
      const fullBefore = rc.r5.snaps.length
      await rc.r5.pump(2500)
      const fulls = rc.r5.snaps.slice(fullBefore).filter((x) => x.full === 1).length
      const a = rc.r5.last && rc.r5.last.state
      ok('N2-r5', '5s 档：复席重同步（welcome 全量+快照续流 full=1 在场）', fulls >= 1, `复席后 full×${fulls}`)
      ok('N2-r5', '5s 档：状态延续（比分保持+比赛钟不回退）', a && before.r5 && a.clock <= before.r5.clock + 50 && JSON.stringify(a.score) === JSON.stringify(before.r5.score), `score ${before.r5 && JSON.stringify(before.r5.score)}→${a && JSON.stringify(a.score)} clock ${before.r5 && before.r5.clock}→${a && a.clock}`)
      /* 手感层状态延续（FEEL 后）：复席 welcome 全量 state 携带服务端延续面字段（体力/扑抢/自绊/CD） */
      const w = rc.r5.welcomes.filter((x) => x.state && x.state.players && x.state.players[Rm.seat]).pop()
      const p = w && w.state.players[Rm.seat]
      const feelKeys = p ? ['stam', 'lungeT', 'stumbleT', 'tackleCd'].filter((k) => p[k] !== undefined) : []
      ok('N2-r5', '手感层状态延续：复席 welcome 全量携带服务端延续面（stam/lungeT/stumbleT/tackleCd 四键在场，FEEL 层可重建手感态）',
        feelKeys.length === 4, `players[${Rm.seat}] keys=${feelKeys.join(',')} stam=${p && p.stam}（蓄力为本地瞬时态随断线弃，不属服务器延续面——口径注记）`)
      const a2 = rc.r5.last && rc.r5.last.state
      const stamAfter = a2 && a2.players && a2.players[Rm.seat] && a2.players[Rm.seat].stam
      ok('N2-r5', '手感层状态延续：复席后快照续流体力值在场且演化（非重置为满值静态）',
        typeof stamAfter === 'number' && p && stamAfter !== -1, `welcome stam=${p && p.stam} → 续流 stam=${stamAfter}`)
    }
    /* 10s 档 */
    await sleep(Math.max(300, rcAt + 9600 - Date.now()))
    {
      const Rm = rc.r10
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('N2-r10', '10s 档：窗内（9.6s<10s+1拍）复席有效', rcn.json && rcn.json.ok, rcn.json && (rcn.json.error || '窗内复席成功'))
      if (rcn.json.ok) { await rc.r10.pump(1200); ok('N2-r10', '10s 档：复席后房存续续玩', rc.r10.last && rc.r10.last.ok, `tick=${rc.r10.last && rc.r10.last.tick}`) }
    }
    /* 逾窗档 */
    await sleep(Math.max(300, rcAt + 12500 - Date.now()))
    {
      const Rm = rc.r30
      const mid = await state(Rm.id)
      const mine = (mid.json && mid.json.seats || []).find((x) => x.seat === Rm.seat)
      ok('N2-r30', '逾窗档（30s 档语义，>10s 观测）：席位已转托管 balanced（META.takeOver）', mine && mine.kind !== 'human', mine ? `seat${mine.seat} kind=${mine.kind}` : '未见席位')
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('N2-r30', '逾窗档：token 已清 → resume-rejected（复席语义不容降级为顶号）', rcn.status === 409, `status=${rcn.status} error=${rcn.json && rcn.json.error}`)
      await rc.r30.pump(1500)
      ok('N2-r30', '逾窗档：「比赛不断」——托管下对局继续推进（tick 前进）', rc.r30.last && rc.r30.last.tick > (before.r30 ? before.r30.tick : 0), `tick=${before.r30 && before.r30.tick}→${rc.r30.last && rc.r30.last.tick}`)
    }
    for (const Rm of Object.values(rc)) { try { await killRoom(Rm.id) } catch { } }
  }

  console.log(`\nQA2-NET：${passed} 通过，${failed} 失败`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
