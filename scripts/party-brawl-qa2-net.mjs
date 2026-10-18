#!/usr/bin/env node
/* =====================================================================
 * party-brawl-qa2-net（GAMES-177 · QA2 在线口径探针——网关 :4400 testapi 路径）
 * 面 1 eco-online：生产混编实配 3/6/11（bothost.js:106）在线复证 3 seed——
 *   testapi botLevels=[null,comp,comp,bal×6,cas×11] + autopilot=true
 *   （autopilot 席=brainImpl 'competitive' 服务器节拍驱动，sim.cjs ①——恰复刻
 *   生产混编巨房 3comp/6bal/11cas 全 bot 生态，真协议路径）
 *   断言（重锚后 conformance 口径，qa2-eco 离线证据的在线面）：
 *   E1' 每局最佳 comp 席 rank≤5（决赛豆席位上限，设计 §4.2 重锚口径）
 *   E2' comp 人均击杀率 > bal 且 > cas（席位占比不均的公平计量）
 *   E3' N3 严格序 comp≤bal≤cas 毒伤拍（生产占比基座）
 * 面 2 a9-spectrum：latency200 双臂×3seed 复跑 ≥2 迭代——kills 对谱 (k0,kB)
 *   ≥10 对样本回填（校准四 ≤2 泊松噪声带覆盖率验证；api-check 同式：
 *   royale-rush 策略闭包逐字节复制、statSeeds {S,S+1,S+2}）
 * 用法：node scripts/party-brawl-qa2-net.mjs [eco|a9|all]（缺省 all；
 *   a9 迭代数可 A9_ITERS=n 环境变量覆写，缺省 2）
 * ===================================================================== */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PB = require(join(ROOT, 'games/multiplayer/party-brawl/sim.cjs'))

const GW = process.env.GAMES_GW || 'http://127.0.0.1:4400'
const MODE = process.argv[2] || 'all'
const A9_ITERS = Number(process.env.A9_ITERS || 2)
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
let pass = 0, fail = 0
const ok = (id, name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}

async function gw(method, path, body) {
  const r = await fetch(GW + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await r.json() } catch { /* non-json */ }
  return { status: r.status, json }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function createRoom(opts) {
  const r = await gw('POST', '/api/test/room', opts)
  return r.json && r.json.ok ? r.json : null
}
async function waitEnd(roomId, budgetMs) {
  const deadline = Date.now() + budgetMs
  let cursor = 0
  for (;;) {
    const r = await gw('GET', `/api/test/state?roomId=${roomId}&since=${cursor}`)
    if (!r.json || !r.json.ok) return { error: r.json && r.json.error || `HTTP ${r.status}` }
    cursor = r.json.cursor
    if (r.json.phase === 'ended') return { state: r.json.state, result: r.json.result, seats: r.json.seats }
    if (Date.now() > deadline) return { error: 'budget 超时未终局' }
    await sleep(250)
  }
}

/* ---------- 面 1：eco-online（生产 3/6/11 在线复证） ---------- */
const TIER_ONLINE = (i) => (i <= 2 ? 'competitive' : i <= 8 ? 'balanced' : 'casual') // autopilot 席0=comp
async function ecoOnline() {
  console.log('[eco-online] 生产混编实配 3/6/11 在线复证（autopilot+testapi，3 seed）')
  const seeds = [20261018, 20261019, 20261020]
  const botLevels = [null, 'competitive', 'competitive',
    'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'balanced',
    'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual']
  const rows = []
  for (const seed of seeds) {
    const rr = await createRoom({ gameId: 'party-brawl', seed, timeScale: 8, startDelayMs: 600, maxTicks: 9600, botLevels, autopilot: true })
    if (!rr) { ok('ECO', `seed ${seed} 建房`, false, 'HTTP 建房失败'); continue }
    const fin = await waitEnd(rr.roomId, 120_000)
    await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
    if (fin.error) { ok('ECO', `seed ${seed} 终局`, false, fin.error); continue }
    const by = { competitive: [], balanced: [], casual: [] }
    for (const p of fin.state.players) by[TIER_ONLINE(p.seat)].push(p)
    const row = {}
    for (const tr of ['competitive', 'balanced', 'casual']) {
      row[tr] = {
        ranks: by[tr].map((p) => p.rank),
        kills: by[tr].reduce((a, p) => a + p.kills, 0),
        dots: by[tr].reduce((a, p) => a + ((fin.state.ledgers && fin.state.ledgers.stormDots && fin.state.ledgers.stormDots[p.seat]) || 0), 0),
        n: by[tr].length,
      }
    }
    rows.push({ seed, row, tick: fin.state.tick, reason: fin.result && fin.result.reason })
    console.log(`  seed ${seed} tick=${fin.state.tick}(${fin.result && fin.result.reason}) comp{r=[${row.competitive.ranks}] k=${row.competitive.kills} d=${row.competitive.dots}} bal{rMed=${med(row.balanced.ranks)} k=${row.balanced.kills} d=${row.balanced.dots}} cas{rMed=${med(row.casual.ranks)} k=${row.casual.kills} d=${row.casual.dots}}`)
  }
  if (rows.length === seeds.length) {
    const best = rows.map((r) => Math.min(...r.row.competitive.ranks))
    ok('ECO', `E1' 每局最佳 comp 席 rank≤5（决赛豆席位上限，重锚口径）`, best.every((b) => b <= 5), `best=[${best.join(',')}]`)
    const rate = rows.map((r) => `${(r.row.competitive.kills / r.row.competitive.n).toFixed(2)} vs bal ${(r.row.balanced.kills / r.row.balanced.n).toFixed(2)}/cas ${(r.row.casual.kills / r.row.casual.n).toFixed(2)}`)
    ok('ECO', `E2' comp 人均击杀率 > bal 且 > cas（占比不均公平计量）`,
      rows.every((r) => r.row.competitive.kills / r.row.competitive.n > r.row.balanced.kills / r.row.balanced.n && r.row.competitive.kills / r.row.competitive.n > r.row.casual.kills / r.row.casual.n),
      rate.join('，'))
    ok('ECO', `E3' N3 严格序 comp≤bal≤cas 毒伤拍（生产占比基座，在线）`,
      rows.every((r) => r.row.competitive.dots <= r.row.balanced.dots && r.row.balanced.dots <= r.row.casual.dots),
      `dots comp=[${rows.map((r) => r.row.competitive.dots)}] bal=[${rows.map((r) => r.row.balanced.dots)}] cas=[${rows.map((r) => r.row.casual.dots)}]`)
  }
}

/* ---------- 面 2：a9-spectrum（latency200 kills 对谱采样） ---------- */
/* royale-rush 策略闭包（api-check.js pbRoyaleRushFactory 逐字节复制——改此须双向同步） */
function pbStorm(state, t) { return PB ? PB.stormOf(state, t) : null }
function pbToward(me, x, y) {
  const dx = x - me.x, dy = y - me.y, d = Math.hypot(dx, dy) || 1
  if (d < 15000) return { mx: 0, my: 0 }
  return { mx: Math.round(dx / d * 100), my: Math.round(dy / d * 100) }
}
const pbAim = (me, x, y) => Math.round(Math.atan2(y - me.y, x - me.x) / (Math.PI * 2) * 65536) & 0xFFFF
function pbRoyaleRushFactory() {
  const mem = { lastDist: Infinity, contact: 0 }
  const FIRE_CAP = 3
  return (state, seat) => {
  const NOOP = { mx: 0, my: 0 }
  const me = state.players && state.players[seat]
  if (!me || !me.alive) return NOOP
  const out = { mx: 0, my: 0, aim: me.a || 0, fire: 0, skl: 0, pick: -1 }
  const hungry = me.w === 0 || (me.mag <= 0 && me.ammo <= 0)
  let goal = null
  const boxes = Object.values(state.boxes || {}).filter((b) => b.on)
  if (hungry) {
    let best = null, bd = Infinity
    for (const b of boxes) {
      if (b.k !== 'wpn' && b.k !== 'nade' && b.k !== 'drop') continue
      const d = (b.x - me.x) ** 2 + (b.y - me.y) ** 2
      if (d < bd) { bd = d; best = b }
    }
    if (best) {
      goal = { x: best.x, y: best.y }
      if (bd < 28000 * 28000) out.pick = Number(best.id.slice(1))
    }
  }
  if (out.pick < 0) for (const b of boxes) {
    if ((b.x - me.x) ** 2 + (b.y - me.y) ** 2 < 28000 * 28000) { out.pick = Number(b.id.slice(1)); break }
  }
  const c = pbStorm(state, state.tick)
  if (c) {
    const dEdge = Math.hypot(me.x - c.cx, me.y - c.cy) - c.r
    if (dEdge > -150000) {
      const k = c.r * 0.55
      const d = Math.hypot(me.x - c.cx, me.y - c.cy) || 1
      goal = { x: c.cx - (me.x - c.cx) / d * k, y: c.cy - (me.y - c.cy) / d * k }
    }
  }
  let foe = null, fd = Infinity
  for (const o of state.players || []) {
    if (!o || !o.alive || o.seat === seat || o.prot > 0) continue
    const d = (o.x - me.x) ** 2 + (o.y - me.y) ** 2
    if (d < fd) { fd = d; foe = o }
  }
  const armed = me.w > 0 && (me.mag > 0 || me.ammo > 0)
  const finalC = c && c.r <= 300000
  if (foe) {
    const dist = Math.sqrt(fd)
    if (dist < 60000 && armed && finalC) {
      if (mem.lastDist > 80000) mem.contact = 0
      mem.contact++
      if (mem.contact <= FIRE_CAP) {
        out.aim = pbAim(me, foe.x, foe.y)
        out.fire = 1
      }
      const d0 = Math.hypot(me.x - foe.x, me.y - foe.y) || 1
      if (dist < 400000) goal = { x: me.x + (me.x - foe.x) / d0 * 400000, y: me.y + (me.y - foe.y) / d0 * 400000 }
    } else if (dist < 300000 && !goal) {
      const lx = foe.x + (foe.vx || 0) * 20, ly = foe.y + (foe.vy || 0) * 20
      const d0 = Math.hypot(me.x - lx, me.y - ly) || 1
      goal = { x: me.x + (me.x - lx) / d0 * 400000, y: me.y + (me.y - ly) / d0 * 400000 }
    }
    mem.lastDist = dist
  } else mem.lastDist = Infinity
  if (me.meds > 0 && me.hp < 50 && !(state.tick % 40 < 2)) out.skl = 2
  if (!goal) {
    let sup = null, sd = Infinity
    for (const b of boxes) {
      if (b.k !== 'itm' && b.k !== 'drop' && b.k !== 'nade') continue
      const d = (b.x - me.x) ** 2 + (b.y - me.y) ** 2
      if (d < sd) { sd = d; sup = b }
    }
    if (sup && sd < 800000 * 800000) {
      goal = { x: sup.x, y: sup.y }
      if (sd < 28000 * 28000 && out.pick < 0) out.pick = Number(sup.id.slice(1))
    } else if (c) {
      /* 保持环=0.5r 缓旋（自参照半径点=原地停驻；旋起来不做固定靶）——决赛圈（r≤260px）抢圈心 */
      if (c.r <= 260000) goal = { x: c.cx, y: c.cy }
      else {
        const ang = (state.tick / 300) % (Math.PI * 2)
        const k2 = c.r * 0.5
        goal = { x: c.cx + Math.cos(ang) * k2, y: c.cy + Math.sin(ang) * k2 }
      }
    }
  }
  if (goal) { const mv = pbToward(me, goal.x, goal.y); out.mx = mv.mx; out.my = mv.my }
  return out
  }
}

/* playScript 精简同式（api-check：gwState 游标轮询→policy→ctrl 注入→ended 收割） */
async function playOne(seed, delayMs, budgetMs) {
  const rr = await createRoom({ gameId: 'party-brawl', seed, timeScale: 8, startDelayMs: 600, maxTicks: 9600,
    botLevels: [null, 'balanced', 'balanced', 'balanced', 'balanced', 'balanced', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual', 'casual'],
    delayMs, autopilot: false })
  if (!rr) return { error: 'HTTP 建房失败' }
  const policy = pbRoyaleRushFactory()
  let cursor = 0
  const deadline = Date.now() + budgetMs
  for (;;) {
    const r = await gw('GET', `/api/test/state?roomId=${rr.roomId}&since=${cursor}`)
    if (!r.json || !r.json.ok) { await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {}); return { error: r.json && r.json.error || `HTTP ${r.status}` } }
    cursor = r.json.cursor
    if (r.json.phase === 'ended') {
      const me = r.json.state && r.json.state.players ? r.json.state.players[r.json.playerSeat] : null
      const out = { kills: me ? me.kills : 0, reason: r.json.result && r.json.result.reason, tick: r.json.tick, carried: (r.json.state && r.json.state.stats && r.json.state.stats.carried) || 0 }
      await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {})
      return out
    }
    if (Date.now() > deadline) { await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {}); return { error: 'budget 超时未终局' } }
    if (r.json.phase === 'live') {
      const inp = policy(r.json.state, r.json.playerSeat)
      const i = await gw('POST', '/api/test/input', { roomId: rr.roomId, seat: r.json.playerSeat, op: 'ctrl', payload: inp })
      if (!i.json || !i.json.ok) { await gw('DELETE', '/api/test/room', { roomId: rr.roomId }).catch(() => {}); return { error: i.json && i.json.error || '注入失败' } }
    }
    await sleep(50)
  }
}

async function a9Spectrum() {
  console.log(`[a9-spectrum] latency200 kills 对谱采样（${A9_ITERS} 迭代 × 2 臂 × 3 seed，api-check 同式）`)
  const statSeeds = [20261018, 20261019, 20261020]
  const pairs = []   // (k0,kB) 逐 seed 对
  const meds = []    // 每迭代 med-of-3 (k0,kB)
  for (let it = 1; it <= A9_ITERS; it++) {
    const k0s = [], kBs = []
    for (const sd of statSeeds) {
      const a0 = await playOne(sd, 0, 120_000)
      const aB = await playOne(sd, 200, 120_000)
      if (a0.error || aB.error) { ok('A9X', `迭代${it} seed${sd} 出清`, false, `${a0.error || ''}${aB.error || ''}`); continue }
      k0s.push(a0.kills); kBs.push(aB.kills)
      pairs.push({ iter: it, seed: sd, k0: a0.kills, kB: aB.kills, r0: a0.reason, rB: aB.reason })
      console.log(`  iter${it} seed${sd}：arm0 k=${a0.kills}(${a0.reason}) armB k=${aB.kills}(${aB.reason}) carried ${a0.carried}/${aB.carried}`)
    }
    if (k0s.length === 3) meds.push({ iter: it, k0: med(k0s), kB: med(kBs) })
  }
  if (pairs.length) {
    console.log(`  ▸ 对谱 (k0,kB)：${pairs.map((p) => `(${p.k0},${p.kB})`).join(' ')}`)
    console.log(`  ▸ 中位谱 (med0,medB)：${meds.map((m) => `(${m.k0},${m.kB})`).join(' ')}`)
    const diffs = pairs.map((p) => Math.abs(p.k0 - p.kB))
    const cov = diffs.filter((d) => d <= 2).length
    ok('A9X', `kills 对谱样本 ≥10（后置数据回填）`, pairs.length >= 10, `n=${pairs.length} 对`)
    ok('A9X', `|k0−kB| ≤2 泊松噪声带覆盖率 100%（校准四口径验证）`, cov === pairs.length, `${cov}/${pairs.length}（diffs=[${diffs.join(',')}]）`)
    ok('A9X', `双臂均出清（last-standing/timeout）`, pairs.every((p) => ['last-standing', 'timeout'].includes(p.r0) && ['last-standing', 'timeout'].includes(p.rB)), `${pairs.filter((p) => p.r0 === 'last-standing').length}/${pairs.length} arm0 last-standing`)
    const mdiffs = meds.map((m) => Math.abs(m.k0 - m.kB))
    ok('A9X', `med-of-3 中位差 ≤2（api-check 断言同口径）`, mdiffs.every((d) => d <= 2), `diffs=[${mdiffs.join(',')}]`)
  }
}

console.log(`party-brawl-qa2-net（GW=${GW}，mode=${MODE}）`)
if (MODE === 'eco' || MODE === 'all') await ecoOnline()
if (MODE === 'a9' || MODE === 'all') await a9Spectrum()
console.log(`\nNET-CHECK ${fail === 0 ? 'OK' : 'RED'}：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
