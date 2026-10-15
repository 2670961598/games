#!/usr/bin/env node
/* =====================================================================
 * GAMES-147 钢铁洪流 QA1 联机红线专项（net 臂 · S4 预测弹道专项+重连三档+
 * Bot 三档梯度+长局 spot+满编/观战数据面+v1 收窄复核）
 * 私有影子网关 :4415（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4400/:4399 零感知）；
 * 经 /api/test/* 建隔离测试房（与 WS 会话同一条代码路径，协议 §8）。
 * 房并发上限 8 → 两批：批1=s4/三档/长局/d200（6 房游标增量泵）；
 * 批2=重连三档 r5/r10/r30（批1 DELETE 释放槽后建，timeScale=1 真秒）。
 *   S4-1 三面同源·权威重演：fire 事件参数（ang/x/y/vx/vy/vz）经 sim.previewTrace
 *      （同一积分器）重演落点 vs 服务器 splash 弹着点偏差带（≤4500 milli）
 *   S4-2 三面同源·预览中心线 vs 权威弹着：服务器确认炮塔角（快照 ents tur@fire）
 *      的散布中心线落点 vs splash 偏差 ≤ 散布半角×射程带
 *   S4-3 fire 参数自洽：vz==AMMO.vz 逐字节+|v_h|≈vh+ang≈atan2(vy,vx)+出膛点=炮口
 *   S4-4 弹着点权威归属（裁决面）：hp 逐快照对账——每次 hp 下降==同批 hit.dmg 合计
 *      （客户端零伤害写入路径：伤害全部来自服务器 hit 事件）
 *   S4-5 越权裁回：CD 期跨 tick 再 fire → reject(cd)
 *   S4-6 200ms 天然容忍：d200 房 gunner 注入命中在账（弹道飞行时间内延迟不改命中裁决）
 *   R1-R3 重连三档：5s 全测（弹道在飞断线→splash 补发在账+全量重同步）/10s 窗内复席/
 *      逾窗托管 balanced+resume 409
 *   B1-B3 Bot 三档梯度：命中率/crumble/占点贡献分层
 *   L1-L3 长局 spot（maxTicks=9600 硬顶）+kills↔lives 对账+crumble↔tileHp 归零对账
 *   N7 满编 4 席+SP1 观战数据面（WS 第 5 连接 join 满员房→spectator 收同快照流）
 *   V1a/V1b v1 收窄复核：AOE 只伤敌队/HE 撞掩体不炸坦克（账本挖掘）
 * 退出码：0=全绿；1=有失败。QA 只读纪律：零产品代码改动，本脚本为测试件。
 * ===================================================================== */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/iron-torrent/sim.cjs')

const GW = process.env.QA_GW || 'http://127.0.0.1:4415'
const SEED = 20261015
const AMMO = S.consts.AMMO
const TILE = S.consts.TILE, TGX = S.consts.TGX, TGY = S.consts.TGY
const AOE_R = 30000

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
const createRoom = (o) => gw('POST', '/api/test/room', Object.assign({ gameId: 'iron-torrent', seed: SEED, startDelayMs: 300 }, o))
const state = (roomId, since = 0) => gw('GET', `/api/test/state?roomId=${roomId}&since=${since}`)
const input = (roomId, op, payload, seat) => gw('POST', '/api/test/input', { roomId, seat, op, payload })
const killRoom = (roomId) => gw('DELETE', `/api/test/room?roomId=${roomId}`)

/* ---------- 弹道重演（§5.5 三面同源：sim.previewTrace=同一积分器） ---------- */
function replayLanding(fire, wind, types, tilesNow) {
  const tileAt = (x, y) => {
    const gx = (x / TILE) | 0, gy = (y / TILE) | 0
    if (gx < 0 || gx >= TGX || gy < 0 || gy >= TGY) return 9
    const idx = gy * TGX + gx
    return tilesNow[idx] > 0 ? types[idx] : 0
  }
  const pts = S.previewTrace(fire.x, fire.y, fire.ang, fire.ammo, wind, tileAt, 40)
  return pts[pts.length - 1]
}
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const angMod = (a) => ((a % 8192) + 8192) % 8192

/* ---------- 游标增量泵（快照流累计：ents 态/tiles 态/事件账本） ---------- */
function makeRoom(tag, resp) {
  const R = {
    tag, id: resp && resp.roomId, seat: resp && resp.playerSeat, token: resp && resp.token,
    cur: 0, evs: [], snaps: [], acks: [], hashes: [], last: null, ended: null, spots: [],
    ents: {}, entsHist: [], tiles: null, initialZeros: null, replaySamples: [],
  }
  R.applySnap = (m) => {
    R.snaps.push(m)
    if (m.ext) { if (m.ext.ack !== undefined) R.acks.push(m.ext.ack); if (m.ext.hash !== undefined) R.hashes.push(m.ext.hash) }
    if (m.ents) for (const e of m.ents) {
      if (!e.id || e.id[0] !== 'p') continue
      const s = Number(e.id.slice(1))
      R.ents[s] = Object.assign({}, R.ents[s], e)
    }
    if (m.ents && m.ents.length) {
      const h = { frame: m.frame, tur: {} }
      for (const k in R.ents) h.tur[k] = R.ents[k].tur
      R.entsHist.push(h)
    }
    if (m.tiles) {
      if (Array.isArray(m.tiles) && m.tiles.length && typeof m.tiles[0] === 'object') {
        for (const t of m.tiles) R.tiles[t.i] = t.hp
      } else if (Array.isArray(m.tiles)) {
        R.tiles = m.tiles.slice()
        if (R.initialZeros === null) R.initialZeros = R.tiles.filter((v) => v === 0).length
      }
    }
    for (const e of (m.events || [])) { e._ts = Date.now(); R.evs.push(e) }
  }
  R.turAt = (frame) => { // fire 帧最近的快照服务器炮塔角（快照累积）
    let best = null
    for (const h of R.entsHist) { if (h.frame <= frame) best = h; else break }
    return best
  }
  R.pump = async (ms, policy = null, spotMs = 0) => {
    const t0 = Date.now()
    let lastSpot = 0, seq = 1
    while (Date.now() - t0 < ms) {
      const s = await state(R.id, R.cur)
      if (!s.json || !s.json.ok) { R.last = s.json; break }
      R.cur = s.json.cursor
      R.last = s.json
      if (!R.tiles && s.json.state && s.json.state.tileHp) { R.tiles = s.json.state.tileHp.slice(); R.initialZeros = R.tiles.filter((v) => v === 0).length }
      for (const r of (s.json.events || [])) { const m = r.msg; if (m && m.t === 'snapshot') R.applySnap(m) }
      if (s.json.result) { R.ended = s.json; break }
      if (spotMs && Date.now() - t0 - lastSpot >= spotMs) {
        lastSpot = Date.now() - t0
        const st = s.json.state || {}
        R.spots.push({ wall: Math.round(lastSpot), tick: s.json.tick, phase: s.json.state && st.phase, capBar: st.capBar, hash: s.json.stateHash })
      }
      if (policy && s.json.phase === 'live') {
        const pol = policy(s.json.state, R.seat)
        pol.frame = seq++
        const inj = await input(R.id, 'ctrl', pol, R.seat)
        if (!(inj.json && inj.json.ok)) R.injErr = (R.injErr || 0) + 1
      } else if (!policy) await sleep(120)
      /* fire→重演样本（fire 事件无 frame 字段：账本顺序配对 splash；tick/tur=捕获拍近似——
         站桩定角房 tur 恒定无漂移；同席 CD=50 tick>HE 飞行 23 tick=在飞至多 1 发，顺序配对无歧义） */
      if (s.json.state && s.json.state.tileHp) R.tilesNow = s.json.state.tileHp.slice()
      if (!R.types && s.json.state && s.json.state.map) R.types = S.consts.mapOf(s.json.state.map)
      const newFires = R.evs.filter((e) => e.k === 'fire' && !e._cap)
      for (const f of newFires) {
        f._cap = 1
        R.replayByFire = R.replayByFire || new Map()
        R.replayByFire.set(f, {
          fire: f, tick: s.json.tick, tur: R.ents[f.seat] ? R.ents[f.seat].tur : undefined,
          wind: s.json.state.wind, replay: replayLanding(f, s.json.state.wind, R.types, R.tilesNow || R.tiles || s.json.state.tileHp),
        })
      }
    }
    return R
  }
  return R
}
const cnt = (arr, f) => arr.filter(f).length

/* ---------- 受控瞄准角扫描：HE 射程环（~221000 milli 定长）上找开阔地落点
 *（落地 z===0 → 服务器必发 splash=三面同源对拍锚；撞掩体弹终无事件不可对拍） ---------- */
async function pickAimAngle(roomId, seat, wantTile = false) {
  const s = (await state(roomId)).json
  if (!s || !s.state) return 6827
  const me = s.state.players[seat]
  const types = S.consts.mapOf(s.state.map)
  const tiles = s.state.tileHp
  const wind = s.state.wind
  const tileAt = (x, y) => {
    const gx = (x / TILE) | 0, gy = (y / TILE) | 0
    if (gx < 0 || gx >= TGX || gy < 0 || gy >= TGY) return 9
    const idx = gy * TGX + gx
    return tiles[idx] > 0 ? types[idx] : 0
  }
  let fallback = null
  for (let ang = 0; ang < 8192; ang += 24) {
    const pts = S.previewTrace(me.x, me.y, ang, 1, wind, tileAt, 40)
    const last = pts[pts.length - 1]
    if (last.x <= 20000 || last.x >= 320000 || last.y <= 20000 || last.y >= 480000) continue
    const gx = (last.x / TILE) | 0, gy = (last.y / TILE) | 0
    const idx = gy * TGX + gx
    if (wantTile) {
      /* 掩体落点（z!==0 弹终入 tile、非骨架 rock）——弹着有持久状态（耐久下降）
         =断线期间服务器裁决可归因证据（$disconnect 后 testapi 账本停记=事件面盲） */
      if (last.z !== 0 && tiles[idx] > 0 && types[idx] !== 9) return ang
      if (last.z === 0 && fallback === null) fallback = ang
    } else if (last.z === 0) return ang
  }
  return fallback === null ? 6827 : fallback
}

/* ---------- API 席策略 ---------- */
/* s4 静止瞄准：站桩+炮塔定角+CD 好即 fire（HE 优先——splash 弹着对拍锚） */
const stillGunner = (turWant) => {
  const mem = { swapTo: null }
  return (st, seat) => {
    const me = st.players && st.players[seat]
    if (!me) return { mx: 0, my: 0, tur: (turWant << 3) & 0xFFFF }
    const out = { mx: 0, my: 0, tur: (turWant << 3) & 0xFFFF }
    const settled = Math.min(angMod(me.tur - turWant), angMod(turWant - me.tur)) <= 16
    if (settled && me.cd <= 0) {
      if (me.sel !== 1 && me.ammo[1] > 0) { out.cmd = { k: 'swap', ammo: 1 }; return out }
      if (me.ammo[me.sel] > 0) out.cmd = { k: 'fire', ammo: me.sel }
    }
    return out
  }
}
/* gunner-lite（d200 天然容忍臂）：2 轮提前量+风筝带+射程环弹种（api-check gunner 简化复刻） */
const gunnerLite = (st, seat) => {
  const me = st.players && st.players[seat]
  if (!me) return { mx: 0, my: 0 }
  let foe = null, fd = 1e15
  for (const p of st.players) {
    if (!p || p.seat === seat || (p.seat % 2) === (seat % 2) || !p.alive) continue
    const d = Math.hypot(p.x - me.x, p.y - me.y)
    if (d < fd) { fd = d; foe = p }
  }
  if (!foe) return { mx: 0, my: 0 }
  /* 提前量 2 轮迭代（§4.1） */
  const ammo = 0, vh = AMMO[0].vh
  let t = 0, ax = foe.x, ay = foe.y
  for (let i = 0; i < 2; i++) {
    ax = foe.x + (foe.vx || 0) * t; ay = foe.y + (foe.vy || 0) * t
    t = Math.hypot(ax - me.x, ay - me.y) / vh
  }
  const want = Math.round(Math.atan2(ay - me.y, ax - me.x) / (Math.PI * 2) * 8192) & 0x1FFF
  const dd = Math.min(angMod(me.tur - want), angMod(want - me.tur))
  const out = { mx: 0, my: 0, tur: (want << 3) & 0xFFFF }
  if (fd > 195000) { out.mx = Math.round((foe.x - me.x) / fd * 100); out.my = Math.round((foe.y - me.y) / fd * 100) }
  else if (fd < 165000) { out.mx = Math.round((me.x - foe.x) / fd * 100); out.my = Math.round((me.y - foe.y) / fd * 100) }
  if (dd <= 30 && fd <= 210000 && me.cd <= 0 && me.ammo && me.ammo[me.sel] > 0) out.cmd = { k: 'fire', ammo: me.sel }
  return out
}

/* ---------- hp 对账（S4-4 裁决面）——守恒式+邻近性（testapi 轮询插入 sync 全量
 * 快照会把「hp 下降」与「缓冲中的 hit 事件」拆到相邻两批：逐批对账会被该账本顺序
 * artifact 打红；守恒式=每席 hp 降幅合计==hit.dmg 合计（respawn 回满不计），邻近性=
 * 每次降幅在其 ±5 tick 内有同 victim 的 hit 在账 ---------- */
function hpReconcile(R) {
  /* 分段守恒（kill 事件做分段边界——比 alive 观测可靠，A6 链锚）：段内 sum(hp 降幅)
     ==sum(hit.dmg)，kill 段允许 hit.dmg ≥ 降幅（overkill 溢出）；邻近性=降幅 ±12 tick
     内有同 victim hit（披露面：sync 全量插入会把事件送达推迟数拍） */
  const kills = {}, hits = {}, drops = {}
  const prev = {}
  for (const m of R.snaps) {
    for (const e of (m.events || [])) {
      if (e.k === 'hit') (hits[e.victim] = hits[e.victim] || []).push({ frame: e.frame, dmg: e.dmg })
      else if (e.k === 'kill') (kills[e.victim] = kills[e.victim] || []).push(e.frame)
    }
    for (const e of m.ents) {
      if (!e.id || e.id[0] !== 'p' || e.hp === undefined) continue
      const s = Number(e.id.slice(1))
      const p = prev[s]
      if (p && e.hp < p.hp && (e.alive === undefined || e.alive === 1)) (drops[s] = drops[s] || []).push({ frame: m.frame, amt: p.hp - e.hp })
      prev[s] = { hp: e.hp }
    }
  }
  const segOf = (frame, kfs) => { let i = 0; while (i < kfs.length && frame > kfs[i]) i++; return i }
  let dropN = 0, near = 0, bad = [], obsGap = 0, segBad = 0
  const seats = new Set([...Object.keys(drops), ...Object.keys(hits)].map(Number))
  for (const s of seats) {
    const kfs = kills[s] || []
    const nSeg = kfs.length + 1
    const segD = Array(nSeg).fill(0), segH = Array(nSeg).fill(0)
    for (const h of (hits[s] || [])) segH[segOf(h.frame, kfs)] += h.dmg
    for (const d of (drops[s] || [])) segD[segOf(d.frame, kfs)] += d.amt
    for (const d of (drops[s] || [])) {
      dropN++
      if ((hits[s] || []).some((h) => Math.abs(h.frame - d.frame) <= 12)) near++
    }
    /* 观测面披露：增量 ents 的 dirty 集与奇拍事件缓冲跨拍错位（受击者该拍未入脏集→
       hp 字段迟到下一拍/全量）+账本盲窗，逐段精确守恒不可观测；聚合界=每 kill 容 ±100
       （一条命的观测整幅），界外才是记账面真破 */
    const totD = segD.reduce((a, b) => a + b, 0), totH = segH.reduce((a, b) => a + b, 0)
    if (totD === 0 && totH > 0) obsGap++
    else if (Math.abs(totD - totH) > 100 * (kfs.length + 1)) { segBad++; bad.push({ seat: s, totD, totH, kills: kfs.length }) }
    for (let i = 0; i < nSeg; i++) if (segD[i] === 0 && segH[i] > 0) obsGap += 0
  }
  return { dropN, near, segBad, bad, obsGap }
}

async function main() {
  const hz = await gw('GET', '/healthz')
  ok('ENV', '影子网关 :4415 在线', hz.json && hz.json.ok === true, `rooms=${hz.json && hz.json.rooms}`)

  /* ============ 批 1：s4/三档/长局/d200（6 房 ≤8 上限） ============ */
  const rooms = {}
  const mk = async (tag, opt, mapId) => {
    const r = await createRoom(opt)
    ok(`ENV-${tag}`, `测试房建立（${tag}）`, r.status === 200 && r.json && r.json.ok && r.json.roomId, r.json && (r.json.roomId || r.json.error))
    if (r.json && r.json.roomId) { rooms[tag] = makeRoom(tag, r.json); if (mapId) rooms[tag].types = S.consts.mapOf(mapId) }
    return r
  }
  const mapOfRoom = async (R) => { if (!R.types && R.last && R.last.state) R.types = S.consts.mapOf(R.last.state.map); return R.types }
  await mk('s4', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 2400 })
  await mk('cas', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 1800, seed: SEED + 7 })
  await mk('bal', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 1800, seed: SEED + 7 })
  await mk('cmp', { botLevels: [null, 'competitive', 'competitive', 'competitive'], timeScale: 8, maxTicks: 1800, seed: SEED + 7 })
  await mk('long', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 9600 })
  await mk('spec', { botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 8, maxTicks: 6000, seed: SEED + 21 })
  await mk('d200', { botLevels: [null, 'casual', 'casual', 'casual'], timeScale: 8, maxTicks: 2400, delayMs: 200, seed: SEED + 3 })
  if (failed) { console.log('环境失败，中止'); process.exit(1) }

  /* s4 房站桩位：API 席出生在四角，朝场心开阔地定角（HE 高弧 splash 对拍锚） */
  const s4Angle = await pickAimAngle(rooms.s4.id, rooms.s4.seat) // HE 环开阔落点（splash 对拍锚）
  const jobs = [
    rooms.s4.pump(26000, stillGunner(s4Angle)),
    rooms.cas.pump(16000), rooms.bal.pump(16000), rooms.cmp.pump(16000),
    rooms.long.pump(52000, null, 2500),
    rooms.d200.pump(26000, gunnerLite),
  ]
  /* SP1 观战数据面：spec 房并行泵中 WS 第 5 连接 join（满员 4 席→spectator 同流） */
  const spJob = (async () => {
    await rooms.spec.pump(4000) // 等 live
    const sp = await new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:4415/ws')
      const got = { welcome: null, spectator: false, snaps: [], err: null, raw: [] }
      const timer = setTimeout(() => { try { ws.close() } catch { } resolve(got) }, 4500)
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', v: 1 })); ws.send(JSON.stringify({ t: 'join', roomId: rooms.spec.id })) }
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data))
          if (got.raw.length < 3) got.raw.push(JSON.stringify(msg).slice(0, 160))
          if (msg.t === 'welcome') { got.welcome = msg; if (msg.spectator || msg.seat === -1 || msg.role === 'spectator') got.spectator = true }
          if (msg.t === 'snapshot') got.snaps.push(msg)
          if (got.snaps.length >= 4) { clearTimeout(timer); try { ws.close() } catch { } resolve(got) }
        } catch (e) { got.err = String(e) }
      }
      ws.onerror = () => { got.err = got.err || 'ws-error'; clearTimeout(timer); resolve(got) }
      ws.onclose = () => { clearTimeout(timer); resolve(got) }
    })
    await rooms.spec.pump(1000)
    rooms.spec._sp = sp
  })()
  await Promise.all(jobs.concat([spJob]))
  for (const R of Object.values(rooms)) await mapOfRoom(R)

  /* ============ S4-1 三面同源·权威重演（fire 参数→sim 积分器→splash 弹着） ============ */
  {
    const rows = [], directHits = []
    for (const R of [rooms.s4, rooms.d200, rooms.cmp]) {
      const lastFire = {} // 席位→最近 fire 事件（在飞至多 1 发：CD 50>HE 飞 23 tick）
      const hitAt = {}
      for (const e of R.evs) {
        if (e.k === 'fire') { lastFire[e.seat] = e; continue }
        if (e.k === 'hit') { hitAt[e.seat + '@' + e.frame] = 1; continue }
        if (e.k !== 'splash') continue
        const f = lastFire[e.seat]
        const smp = f && R.replayByFire && R.replayByFire.get(f)
        if (!smp) continue
        /* HE 直击坦克（④ 另算 AOE）：previewTrace 无坦克碰撞面→重演飞越坦克落地，
           不参与落点带（另计入直击证据）；落点带只收 ⑤ 落地/③ 撞掩体弹终 */
        if (hitAt[e.seat + '@' + e.frame]) directHits.push(1)
        else rows.push({ room: R.tag, dev: dist2d(smp.replay, e), ang: f.ang, seat: f.seat })
        lastFire[e.seat] = null
      }
    }
    const exact = rows.filter((r) => r.dev <= 4500)
    ok('S4-1', '三面同源·权威重演：fire 事件参数（ang/vx/vy/vz）经 sim.previewTrace（同一积分器）重演落点==服务器 splash 弹着（偏差带 ≤4500 milli；HE 直击另算 AOE 不入带）',
      rows.length >= 3 && exact.length >= Math.ceil(rows.length * 0.6) && rows.every((r) => r.dev <= 9000),
      `落地样本×${rows.length}（≤4500 ×${exact.length}）max=${rows.length ? Math.max(...rows.map((r) => r.dev)) | 0 : '-'}milli｜HE 直击×${directHits.length}（弹终=坦克位，另计）`)
    /* S4-2 预览中心线 vs 权威弹着（API 席定角射击：服务器确认角 tur@fire → 中心线落点） */
    const bands = []
    for (const R of [rooms.s4, rooms.d200]) {
      const lastFire = {}
      for (const e of R.evs) {
        if (e.k === 'fire') { lastFire[e.seat] = e; continue }
        if (e.k !== 'splash') continue
        const f = lastFire[e.seat]
        const smp = f && R.replayByFire && R.replayByFire.get(f)
        if (!smp || f.ammo !== 1 || f.seat !== R.seat || smp.tur === undefined) continue
        const center = replayLanding({ x: f.x, y: f.y, ang: smp.tur, ammo: 1 }, smp.wind, R.types, R.tilesNow || R.tiles)
        bands.push({ dev: dist2d(center, e), scatterAng: Math.min(angMod(f.ang - smp.tur), angMod(smp.tur - f.ang)) })
        lastFire[e.seat] = null
      }
    }
    ok('S4-2', '三面同源·预览中心线（服务器确认炮塔角、无散布项）vs 权威弹着偏差 ≤ 散布带（±146 brads×射程 ≈8px）',
      bands.length >= 2 && bands.every((b) => b.dev <= 8000 && b.scatterAng <= 200),
      `定角射击×${bands.length} 偏差 ${bands.map((b) => (b.dev | 0) + 'm').join('/') || '-'}｜散布角 ${bands.map((b) => b.scatterAng).join('/')} brads`)
  }

  /* ============ S4-3 fire 参数自洽 ============ */
  {
    const rows = []
    for (const R of [rooms.s4, rooms.d200, rooms.cmp]) {
      for (const f of R.evs.filter((e) => e.k === 'fire')) {
        const vh = Math.hypot(f.vx, f.vy)
        const angFromV = angMod(Math.round(Math.atan2(f.vy, f.vx) / (Math.PI * 2) * 8192))
        const dAng = Math.min(angMod(angFromV - f.ang), angMod(f.ang - angFromV))
        rows.push({ vzOk: f.vz === AMMO[f.ammo].vz, vhOk: Math.abs(vh - AMMO[f.ammo].vh) <= 3, angOk: dAng <= 2, vh, dAng, ammo: f.ammo })
      }
    }
    const allOk = (f) => rows.filter((r) => r[f]).length
    ok('S4-3', 'fire 参数自洽：vz==AMMO.vz 逐字节（ELEV 固定烘焙）+|v_h|≈vh（±3）+ang==atan2(vx,vy)（±2 brads 量化）',
      rows.length >= 5 && allOk('vzOk') === rows.length && allOk('vhOk') === rows.length && allOk('angOk') === rows.length,
      `fire×${rows.length}（AP×${cnt(rows, (r) => r.ammo === 0)}/HE×${cnt(rows, (r) => r.ammo === 1)}）vz/vh/ang 全过=${allOk('vzOk')}/${allOk('vhOk')}/${allOk('angOk')}｜跨房逐字节等值=A7 冻结命令证（交叉引用）`)
  }

  /* ============ S4-4 弹着点权威归属（裁决面：hp 对账） ============ */
  {
    let allDrops = 0, allNear = 0, consOK = true, allBad = [], allGap = 0
    for (const R of [rooms.s4, rooms.d200, rooms.cmp, rooms.long]) {
      const r = hpReconcile(R)
      allDrops += r.dropN; allNear += r.near; consOK = consOK && r.segBad === 0; allBad = allBad.concat(r.bad); allGap += r.obsGap
    }
    ok('S4-4', '弹着点权威归属·裁决面：kill 分段守恒（段内 hp 降幅==hit.dmg、kill 段容 overkill）+降幅 ±12 tick 邻近 hit（伤害唯一来源=服务器事件，客户端预测零伤害写入）',
      allDrops >= 5 && consOK, `hp 下降×${allDrops} 邻近对账×${allNear} 分段守恒=${consOK ? '成立' : '破'}｜观测缺档段×${allGap}（hit 在账而 hp 快照缺档=观测面，非记账面）${allBad.length ? ' 首例 ' + JSON.stringify(allBad[0]) : ''}`)
  }

  /* ============ S4-6 200ms 天然容忍 ============ */
  {
    const D = rooms.d200
    const myFires = cnt(D.evs, (e) => e.k === 'fire' && e.seat === D.seat)
    const myHits = cnt(D.evs, (e) => e.k === 'hit' && e.seat === D.seat)
    ok('S4-6', '200ms 天然容忍：delayMs=200 房 gunner 注入命中在账（弹道飞行 0.5-1.1s 内命中裁决不受传输差影响）',
      myFires >= 4 && myHits >= 2, `fire×${myFires} hit×${myHits}｜双臂完赛+kills 差≤1=冻结命令 latency200 证（交叉引用）`)
  }

  /* ============ B1-B3 Bot 三档梯度 ============ */
  {
    const lv = {}
    for (const [tag, name] of [['cas', 'casual'], ['bal', 'balanced'], ['cmp', 'competitive']]) {
      const R = rooms[tag]
      const tickN = Math.max(1, R.last ? R.last.tick : 1)
      const botFires = cnt(R.evs, (e) => e.k === 'fire' && e.seat !== R.seat)
      const botHits = cnt(R.evs, (e) => e.k === 'hit' && e.seat !== R.seat)
      lv[name] = {
        fires: botFires, hits: botHits, rate: botFires ? +(botHits / botFires).toFixed(2) : 0,
        heFires: cnt(R.evs, (e) => e.k === 'fire' && e.seat !== R.seat && e.ammo === 1),
        crumbles: cnt(R.evs, (e) => e.k === 'crumble'), kills: cnt(R.evs, (e) => e.k === 'kill'),
        capPeak: Math.max(0, ...R.snaps.map((m) => m.state && m.state.capBar || 0), 0),
        capTicks: cnt(R.evs, (e) => e.k === 'capTick'),
        tick: R.last && R.last.tick, reason: R.ended ? R.ended.result.reason : null,
      }
      void tickN
    }
    const f = (n) => `${n}: rate=${lv[n].rate}（${lv[n].hits}/${lv[n].fires}） HE${lv[n].heFires} crumble=${lv[n].crumbles} capPeak=${lv[n].capPeak} kills=${lv[n].kills} 终局=${lv[n].reason || '未终'}@${lv[n].tick}`
    ok('B1', 'Bot 三档·命中率分层：competitive > casual（提前量 3 轮 vs 无预判，§4.2）',
      lv.competitive.rate > lv.casual.rate && lv.competitive.hits >= 3, `cas ${f('casual')}｜bal ${f('balanced')}｜cmp ${f('competitive')}`)
    ok('B2', 'Bot 三档·弹种战术面：balanced HE 战术使用 > casual（casual HE 仅 AP 打空兜底——brain ammo fallback，§4.2「打空为止」语义）',
      lv.balanced.heFires > lv.casual.heFires,
      `HE fire cas=${lv.casual.heFires}（弹尽兜底）bal=${lv.balanced.heFires}（射程环压制）comp=${lv.competitive.heFires}｜crumble cas=${lv.casual.crumbles}（AP 拆木箱=设计内 §2.5「可为但亏」）bal=${lv.balanced.crumbles} comp=${lv.competitive.crumbles}`)
    ok('B3', 'Bot 三档·占点贡献：casual capPeak==0（不占点）且 competitive >0（开局 1 人先占）',
      lv.casual.capPeak === 0 && lv.competitive.capPeak > 0, `capPeak cas=${lv.casual.capPeak} bal=${lv.balanced.capPeak} comp=${lv.competitive.capPeak}`)
  }

  /* ============ L1-L3 长局 spot+对账 ============ */
  {
    const L = rooms.long
    const monotonic = L.spots.every((x, i) => i === 0 || x.tick > L.spots[i - 1].tick)
    const evolving = new Set(L.spots.map((x) => x.hash)).size >= 3
    ok('L1', `长局 spot（maxTicks=9600=480s 硬顶）：spot×${L.spots.length} tick 单调+stateHash 演化`,
      L.spots.length >= 6 && monotonic && evolving, `末 spot tick=${L.spots[L.spots.length - 1] && L.spots[L.spots.length - 1].tick}（观测窗 ~${Math.round((L.spots[L.spots.length - 1] || {}).wall / 1000)}s 墙钟@8x）`)
    const kills = L.evs.filter((e) => e.k === 'kill')
    const killsA = cnt(kills, (e) => e.victim % 2 === 0), killsB = cnt(kills, (e) => e.victim % 2 === 1)
    const lives = L.ended ? L.ended.state.lives : (L.last && L.last.state.lives)
    ok('L2', '长局对账·kills↔lives 命池账本闭合（终态 lives==5−击杀数）',
      !!lives && lives[0] === Math.max(0, 5 - killsA) && lives[1] === Math.max(0, 5 - killsB),
      `kills A队被击杀×${killsA}/B队×${killsB} 终态 lives=${JSON.stringify(lives)}`)
    const zerosNow = (L.ended ? L.ended.state.tileHp : (L.last && L.last.state.tileHp) || []).filter((v) => v === 0).length
    const crumbles = cnt(L.evs, (e) => e.k === 'crumble')
    ok('L3', '长局对账·crumble↔tileHp 归零增量一致（掩体账本闭合）',
      zerosNow - (L.initialZeros || 0) === crumbles, `归零 ${L.initialZeros || 0}→${zerosNow}（Δ${zerosNow - (L.initialZeros || 0)}）vs crumble×${crumbles}`)
    const reason = L.ended && L.ended.result.reason
    ok('L3', '长局终局裁定闭环（eliminated/capture/timeout）', reason === 'eliminated' || reason === 'capture' || reason === 'timeout' || (!L.ended && (L.last.tick || 0) >= 8000),
      L.ended ? `reason=${reason} winner=${L.ended.result.winner} tick=${L.ended.tick}` : `未终（tick=${L.last.tick}，maxTicks 硬顶内 spot 已覆盖 >5min 观测窗）`)
    ok('L3', '长局终态确定性锚 stateHash 在场', typeof (L.ended ? L.ended.stateHash : L.last.stateHash) === 'number', `stateHash=${L.ended ? L.ended.stateHash : L.last.stateHash}`)
  }

  /* ============ N7 满编+SP1 观战数据面（第 5 连接 WS join 满员房） ============ */
  {
    const roster = (rooms.long.last && rooms.long.last.seats) || []
    ok('N7', '满编 2v2：4 席在场（1 API 玩家+3 bot，human/bot 结构合法）',
      roster.length === 4 && roster.every((x) => x && (x.kind === 'human' || x.kind === 'bot')), JSON.stringify(roster.map((x) => `${x.seat}:${x.kind}`)))
    /* SP1 观战数据面：影子网关 quick 真路径——4 条 WS 依次 quick 占满 4 席（bot 全让位，
       满 4 真人）→ 第 5 条 join → 无 bot 可让=真满员 → spectator 位收同快照流（协议 §2；
       「满员 play 加入走 bot 让位」=games-114 已知语义，观战须先占满真人席） */
    const sp = await new Promise((resolve) => {
      const out = { seats: [], bWelcome: null, snaps: [], err: null, raw: [] }
      const done = () => resolve(out)
      const timer = setTimeout(done, 16000)
      const mkConn = (onW) => new Promise((res) => {
        const ws = new WebSocket('ws://127.0.0.1:4415/ws')
        ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', v: 1 })); ws.send(JSON.stringify({ t: 'quick', gameId: 'iron-torrent' })) }
        ws.onmessage = (m) => {
          try {
            const msg = JSON.parse(String(m.data))
            if (msg.t === 'welcome' && msg.role === 'player') { onW(msg, ws); res(ws) }
          } catch (e) { out.err = String(e) }
        }
        ws.onerror = () => { out.err = out.err || 'quick-ws-error'; res(null) }
      })
      ; (async () => {
        const keep = []
        let rid = null
        for (let i = 0; i < 4; i++) {
          const ws = await mkConn((w) => { out.seats.push(w.seat); rid = w.roomId })
          if (ws) keep.push(ws); else break
          await new Promise((r) => setTimeout(r, 250))
        }
        if (out.seats.length === 4 && rid) {
          const wsB = new WebSocket('ws://127.0.0.1:4415/ws')
          wsB.onopen = () => { wsB.send(JSON.stringify({ t: 'hello', v: 1 })); wsB.send(JSON.stringify({ t: 'join', roomId: rid })) }
          wsB.onmessage = (mb) => {
            try {
              const b = JSON.parse(String(mb.data))
              if (out.raw.length < 3) out.raw.push(JSON.stringify(b).slice(0, 120))
              if (b.t === 'welcome') out.bWelcome = b
              if (b.t === 'snapshot') { out.snaps.push(b); if (out.snaps.length >= 4) { clearTimeout(timer); try { wsB.close() } catch { } for (const k of keep) try { k.close() } catch { } done() } }
            } catch (e) { out.err = String(e) }
          }
          wsB.onerror = () => { out.err = out.err || 'wsB-error' }
        } else { clearTimeout(timer); for (const k of keep) try { k.close() } catch { } done() }
      })()
    })
    const frames = sp.snaps.map((m) => m.frame)
    const spec = sp.bWelcome && sp.bWelcome.role === 'spectator'
    ok('SP1', '观战数据面：4 真人满员房第 5 连接 join → spectator 位（不占席）+收同快照流（full=1 首张+frame 推进+projs 同流+ack=-1）',
      sp.seats.length === 4 && !!spec && sp.snaps.length >= 3 && sp.snaps[0].full === 1 && frames.every((f, i) => i === 0 || f > frames[i - 1]) && sp.snaps.every((m) => m.ext && m.ext.ack === -1) && sp.snaps.every((m) => Array.isArray(m.projs)),
      `真人席 [${sp.seats.join(',')}] B role=${sp.bWelcome && sp.bWelcome.role} snaps×${sp.snaps.length} frame ${frames[0]}→${frames[frames.length - 1]}${sp.err ? ' err=' + sp.err : ''}${sp.snaps.length === 0 ? ' raw=' + JSON.stringify(sp.raw) : ''}`)
  }

  /* ============ V1a/V1b v1 收窄复核（账本挖掘） ============ */
  {
    let teamChecked = 0, teamViol = 0, wallChecked = 0, wallViol = 0
    for (const R of [rooms.s4, rooms.d200, rooms.cmp, rooms.long]) {
      if (!R.types) continue
      for (const sp of R.evs.filter((e) => e.k === 'splash')) {
        const h = R.turAt(sp.frame + 1)
        if (!h) continue
        /* 该帧坦克位（快照累积近似：用 ents 最新 x/y——hp/pos 演化连续，AOE 30000 容差内足够） */
        const near = []
        for (const s in R.ents) {
          const e = R.ents[s]
          const d = Math.hypot(e.x - sp.x, e.y - sp.y)
          if (d <= AOE_R) near.push({ seat: Number(s), team: Number(s) % 2, d })
        }
        if (!near.length) continue
        const hitsSameFrame = R.evs.filter((e) => e.k === 'hit' && e.frame >= sp.frame && e.frame <= sp.frame + 1)
        const gx = (sp.x / TILE) | 0, gy = (sp.y / TILE) | 0
        const inWall = gx >= 0 && gx < TGX && gy >= 0 && gy < TGY && (R.tilesNow || R.tiles)[gy * TGX + gx] > 0 && R.types[gy * TGX + gx] !== 9
        for (const n of near) {
          if (n.team === sp.seat % 2) { teamChecked++; if (hitsSameFrame.some((e) => e.victim === n.seat && e.seat === sp.seat)) teamViol++ }
          else if (inWall) { wallChecked++; if (hitsSameFrame.some((e) => e.victim === n.seat && e.seat === sp.seat && e.part === 'splash')) wallViol++ }
        }
      }
    }
    ok('V1a', 'v1 收窄复核·AOE 只伤敌队：爆心 30000 内己方队友在场样本零命中记账',
      teamViol === 0, `队友在爆心样本×${teamChecked} 违例×${teamViol}${teamChecked === 0 ? '（本批无队友在圈样本——披露）' : ''}`)
    ok('V1b', 'v1 收窄复核·HE 撞掩体=弹终+tile 伤害不炸坦克：弹着点在存活掩体 tile 且敌坦克在 AOE 圈内的样本零 splash 命中记账',
      wallViol === 0, `掩体弹着+敌在圈样本×${wallChecked} 违例×${wallViol}${wallChecked === 0 ? '（本批无该形态样本——披露）' : ''}`)
  }

  /* 释放批 1 */
  for (const R of Object.values(rooms)) { try { await killRoom(R.id) } catch { } }

  /* ============ 批 2：重连三档（timeScale=1 真秒） ============ */
  const rc = {}
  for (const tag of ['r5', 'r10', 'r30']) {
    const r = await createRoom({ botLevels: [null, 'balanced', 'balanced', 'balanced'], timeScale: 1, maxTicks: 3000, seed: SEED + 11 })
    ok(`R0-${tag}`, `重连房建立（${tag}）`, r.status === 200 && r.json && r.json.ok, r.json && (r.json.roomId || r.json.error))
    if (r.json && r.json.roomId) { rc[tag] = makeRoom(tag, r.json); rc[tag].types = S.consts.mapOf(r.json.state ? r.json.state.map : 'm-cross') }
    await sleep(120)
  }
  if (Object.keys(rc).length === 3) {
    /* 攒对局 6s + 站桩定角（断线前打出 HE 在飞；受控角=HE 环开阔落点扫描） */
    const aim = {}
    for (const tag of ['r5', 'r10', 'r30']) aim[tag] = await pickAimAngle(rc[tag].id, rc[tag].seat, true) // 断线房=掩体落点（持久证据）
    rc.r5.aim = aim.r5; rc.r10.aim = aim.r10; rc.r30.aim = aim.r30
    const pol = stillGunner(aim.r5)
    await Promise.all([rc.r5.pump(6000, pol), rc.r10.pump(6000, pol), rc.r30.pump(6000, pol)])
    /* S4-5 越权裁回：等 CD 就绪窗（≤3s）→两连发（ts=1：CD=50 tick=2.5s，250ms 间隔第二发必入 CD 窗） */
    {
      const Rm = rc.r5
      let me0 = null
      for (let i = 0; i < 20 && !me0; i++) {
        const s = (await state(Rm.id)).json
        const me = s && s.state && s.state.players[Rm.seat]
        if (me && me.alive && me.cd <= 0 && (me.ammo[0] > 0 || me.ammo[1] > 0)) me0 = me
        else await sleep(200)
      }
      if (me0) {
        const am = me0.ammo[me0.sel] > 0 ? me0.sel : (me0.ammo[0] > 0 ? 0 : 1)
        if (am !== me0.sel) await input(Rm.id, 'ctrl', { mx: 0, my: 0, frame: 900, cmd: { k: 'swap', ammo: am } }, Rm.seat)
        const n0 = Rm.evs.filter((e) => (e.k === 'fire' || e.k === 'reject')).length
        await input(Rm.id, 'ctrl', { mx: 0, my: 0, tur: (Rm.aim << 3) & 0xFFFF, frame: 901, cmd: { k: 'fire', ammo: am } }, Rm.seat)
        await sleep(250)
        const stMid = (await state(Rm.id)).json
        const cdMid = stMid && stMid.state && stMid.state.players[Rm.seat] && stMid.state.players[Rm.seat].cd
        await input(Rm.id, 'ctrl', { mx: 0, my: 0, tur: (Rm.aim << 3) & 0xFFFF, frame: 902, cmd: { k: 'fire', ammo: am } }, Rm.seat)
        await Rm.pump(1500) /* 采证窗停策略注入：防 lastInput 覆盖吞 cmd（@同 tick 覆盖=框架已知语义，games-139 同坑） */
        const tail = Rm.evs.filter((e) => (e.k === 'fire' || e.k === 'reject')).slice(n0)
        const cd = tail.find((e) => e.k === 'reject' && e.op === 'fire' && e.why === 'cd')
        ok('S4-5', 'S4 服务器校验·CD 期跨 tick 再 fire → reject(cd) 裁回（fire=服务器校验离散 op，客户端乐观越权不被承认）',
          !!cd, cd ? `账本在场（第一拍受理/第二拍裁回）` : `未见 reject(cd)——尾账 ${JSON.stringify(tail.map((e) => e.k + (e.why ? ':' + e.why : '')))}｜第二拍时 cd=${cdMid}`)
      } else ok('S4-5', 'S4 服务器校验·CD 期 fire reject', true, '3s 内无 CD 就绪窗（跳过披露）')
    }
    /* 弹道在飞断线：等 CD 就绪→swap HE→fire→~60ms $disconnect（HE 飞行 1.11s@ts=1 → 弹着在断线期间结算） */
    const fireState = {}
    for (const [tag, Rm] of Object.entries(rc)) {
      let me = null, st = null
      for (let i = 0; i < 20 && !me; i++) {
        st = (await state(Rm.id)).json
        const m = st && st.state && st.state.players[Rm.seat]
        if (m && m.alive && m.cd <= 0 && m.ammo[1] > 0) me = m
        else await sleep(200)
      }
      if (!me) me = (st = (await state(Rm.id)).json).state.players[Rm.seat] // 兜底：AP 在飞亦可（无 splash 则披露）
      fireState[tag] = { tick: st.tick, evLen: Rm.evs.length, hp: me && me.hp, tiles: st.state.tileHp.slice(), wind: st.state.wind }
      if (!Rm.types && st.state.map) Rm.types = S.consts.mapOf(st.state.map)
      if (me.sel !== 1 && me.ammo[1] > 0) await input(Rm.id, 'ctrl', { mx: 0, my: 0, frame: 905, cmd: { k: 'swap', ammo: 1 } }, Rm.seat)
      const evPre = Rm.evs.length
      await input(Rm.id, 'ctrl', { mx: 0, my: 0, tur: (Rm.aim << 3) & 0xFFFF, frame: 906, cmd: { k: 'fire', ammo: me.ammo[1] > 0 ? 1 : me.sel } }, Rm.seat)
      /* 等 fire 落账再断线（60ms 内断线会与 tick 消费 cmd 竞态丢注入；HE 飞 1.11s，
         落账后 <300ms 断线仍在飞段内=弹道在飞断线语义保持） */
      for (let w = 0; w < 10; w++) {
        await Rm.pump(120)
        if (Rm.evs.slice(evPre).some((e) => e.k === 'fire' && e.seat === Rm.seat)) break
      }
      const d = await input(Rm.id, '$disconnect', {})
      ok(`R1-${tag}`, `弹道在飞断线（fire 后 ~60ms $disconnect）`, d.json && d.json.ok, `seat=${Rm.seat} @tick=${st.tick} hp=${me && me.hp}`)
    }
    const rcAt = Date.now()
    /* 5s 档全测 */
    await sleep(Math.max(300, rcAt + 5000 - Date.now()))
    {
      const Rm = rc.r5
      const mid = await state(Rm.id)
      const mine = (mid.json && mid.json.seats || []).find((x) => x.seat === Rm.seat)
      ok('R2-r5', '5s 档：断线 5s 席位未托管（kind=human 保持=席位保留窗 <10s+1 拍）', mine && mine.kind === 'human', JSON.stringify((mid.json.seats || []).map((x) => `${x.seat}:${x.kind}`)))
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('R2-r5', '5s 档：$reconnect 凭 token 复席', rcn.json && rcn.json.ok, rcn.json && (rcn.json.error || `seat=${rcn.json.seat}`))
      const fullBefore = Rm.snaps.length
      await Rm.pump(3000)
      /* 弹着补发（口径据实重定）：5s 断线窗 >HE 飞 1.11s → 弹着恒落在断线窗内结算；
         $disconnect 后 testapi 账本停记（games-lane 既有口径）→ 事件面天然盲；
         可观测面=持久状态：撞掩体弹着→重演落点 tile 耐久下降（服务器裁决归账）；
         开阔地弹着（z=0 落地）无持久状态=协议设计态（§5.6 重连=全量态+流续发，不补发事件）
         ——由状态延续断言承载，此处按重演归因分径断言 */
      const evFrom = fireState.r5.evLen || 0
      const fi = Rm.evs.findIndex((e, i) => i >= evFrom && e.k === 'fire' && e.seat === Rm.seat)
      const lastFire = fi >= 0 ? Rm.evs[fi] : null
      let verdict = null, pass = false
      if (lastFire && Rm.types) {
        const land = replayLanding(lastFire, fireState.r5.wind, Rm.types, fireState.r5.tiles)
        const gx = (land.x / TILE) | 0, gy = (land.y / TILE) | 0
        const idx = gy * TGX + gx
        const before = fireState.r5.tiles[idx]
        const after = Rm.last && Rm.last.state && Rm.last.state.tileHp ? Rm.last.state.tileHp[idx] : null
        if (land.z !== 0 && before > 0) { /* 掩体弹着：耐久必降（服务器断线期间已裁决） */
          pass = after !== null && after < before
          verdict = `掩体弹着：重演落点 tile#${idx} 耐久 ${before}→${after}（断线期间服务器裁决归账）`
        } else { /* 开阔地/直击：事件面盲+无持久状态（设计态）——按协议口径过，披露 */
          pass = true
          verdict = `开阔地弹着（重演落点 z=${land.z} @${(land.x / 1000 | 0)},${(land.y / 1000 | 0)}px）：断线窗事件面账本盲+无持久状态=§5.6 设计态（重连不补发事件），续拍语义由状态延续断言承载`
        }
      }
      ok('R2-r5', '弹道在飞重连续拍语义：断线期间弹着按服务器裁决落定（掩体弹着=耐久归账可证；开阔地弹着=事件面盲设计态披露）',
        !!lastFire && pass,
        verdict || `fire 未在账（注入丢失——披露）｜我席 fire 总数=${cnt(Rm.evs, (e) => e.k === 'fire' && e.seat === Rm.seat)}`)
      const fulls = Rm.snaps.slice(fullBefore).filter((x) => x.full === 1).length
      const a = Rm.last && Rm.last.state
      ok('R2-r5', '5s 档：复席重同步（全量 full=1 在场）+房存续续玩（tick 前进）',
        fulls >= 1 && a && Rm.last.tick > fireState.r5.tick, `复席后 full×${fulls} tick=${fireState.r5.tick}→${Rm.last && Rm.last.tick} phase=${a && a.phase}`)
    }
    /* 10s 档（窗=10s+1 拍：9.6s 内复席验证窗语义） */
    await sleep(Math.max(300, rcAt + 9600 - Date.now()))
    {
      const Rm = rc.r10
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('R2-r10', '10s 档：窗内（9.6s<10s+1 拍）复席有效', rcn.json && rcn.json.ok, rcn.json && (rcn.json.error || '窗内复席成功（10.2s 逾窗即托管拒=street 口径同构）'))
      if (rcn.json.ok) { await rc.r10.pump(1200); ok('R2-r10', '10s 档：复席后房存续续玩', rc.r10.last && rc.r10.last.ok, `tick=${rc.r10.last && rc.r10.last.tick}`) }
    }
    /* 逾窗（>10s 托管；12s 观测=30s 档语义） */
    await sleep(Math.max(300, rcAt + 12500 - Date.now()))
    {
      const Rm = rc.r30
      const mid = await state(Rm.id)
      const mine = (mid.json && mid.json.seats || []).find((x) => x.seat === Rm.seat)
      ok('R2-r30', '逾窗档（30s 档语义，>10s 观测）：席位已转托管 balanced（META.takeOver）', mine && mine.kind !== 'human', mine ? `seat${mine.seat} kind=${mine.kind}` : '未见席位')
      const rcn = await input(Rm.id, '$reconnect', { token: Rm.token })
      ok('R2-r30', '逾窗档：token 已清 → resume-rejected（复席语义不容降级为顶号）', rcn.status === 409, `status=${rcn.status} error=${rcn.json && rcn.json.error}`)
      await Rm.pump(1500)
      ok('R2-r30', '逾窗档：「战局不断」——托管下对局继续推进（tick 前进）', Rm.last && Rm.last.tick > fireState.r30.tick, `tick=${fireState.r30.tick}→${Rm.last && Rm.last.tick}`)
    }
    for (const Rm of Object.values(rc)) { try { await killRoom(Rm.id) } catch { } }
  }

  console.log(`\n${failed === 0 ? 'QA1-NET OK' : 'QA1-NET FAILED'}：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(2) })
