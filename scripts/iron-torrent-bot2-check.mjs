/* =====================================================================
 * iron-torrent-bot2-check（GAMES-149 · BOT 深化验收挂具）——参照
 * street-soccer-bot2-check 范式（GAMES-140/snake-king GAMES-102），六支柱：
 *   N1 三档梯度：全同档房 × 3 seed × 3000 tick（本地全速）——命中率/HE 战术面/
 *      终局提前度/开局先占四指标档间梯度（QA1 §4 行为谱口径续证）
 *   N2 开局树双证：三档各 2 seed 起跑段（前 30s=300 tick）指标表（首开火时间/
 *      位移距离/提前量预判率/锚点驻泊率）+ 离线判别器（按指标向量判档 6/6 全对=
 *      行为可分性）+ 确定性双跑（事件流逐字节相等）
 *   N3 放水链决策级 A/B（env 同 rooms.js botEnv 形状）：配置注入链（game.json
 *      bot.mercy/bot.casual）/L1 让力（提前量迭代降档+散布附加+失误犹豫窗）/
 *      L2 重败（行为降档 comp→bal：ping 集火熄灭）/生态位让位（收步跟后+让火力位）
 *   N4 深化决策面（三档真分化）：casual 失误率参数化（aimP/holdP/turnP 全链可调）/
 *      balanced 受击退掩体+锚点巡航破僵局/competitive 占点-歼灭模式切换+ping 集火
 *   N5 让位入口/旁观位语义（RoomManager 离线实例零端口）
 *   N6 确定性/回放等价：混档局在线驱动 == replayInputs 输入日志重放（A8 离线同构；
 *      服务端路径由冻结命令 api-check iron-torrent 覆盖）
 * 用法：node scripts/iron-torrent-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { ironTorrentSim: SIM } = await import(join(ROOT, 'server/gateway/sims/iron-torrent.js'))
const { RoomManager } = await import(join(ROOT, 'server/gateway/rooms.js'))
const S = require(join(ROOT, 'games/multiplayer/iron-torrent/sim.cjs'))
const C = S.consts

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(1)
const K = 1000 // milli 换算

/* ANCHORS 锚点表镜像（sim 冻结常量，§4.2——sim 未导出，挂具侧照抄判锚驻泊） */
const ANCHORS = [
  [[45000, 320000], [45000, 180000], [120000, 170000]],
  [[45000, 180000], [45000, 320000], [120000, 330000]],
  [[295000, 320000], [295000, 180000], [220000, 170000]],
  [[295000, 180000], [295000, 320000], [220000, 330000]],
]

/* ---------- 本地全速驱动一局（4 席全 bot；env 透传 brain=适配器出口包装链） ---------- */
function driveRoom(seed, lvls, ticks, env) {
  const st = SIM.create(seed, {})
  const room = { seats: lvls.map((_, i) => ({ seat: i, kind: 'bot' })) }
  const evLog = []
  let capPeak = 0
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (let s = 0; s < 4; s++) inputs[s] = SIM.brain(st, s, lvls[s], null, env)
    const r = SIM.step(st, inputs, room)
    for (const e of r.events || []) {
      e.tick = st.tick
      evLog.push(e)
      if (e.k === 'capTick' && e.bar > capPeak) capPeak = e.bar
    }
    if (r.over) break
  }
  const cnt = (k, f) => evLog.filter((e) => e.k === k && (!f || f(e))).length
  return {
    st, evLog, capPeak, endTick: st.tick,
    fires: cnt('fire'), heFires: cnt('fire', (e) => e.ammo === 1),
    hits: cnt('hit'), kills: cnt('kill'), capTicks: cnt('capTick'),
    reason: null, // r.over 由 drive 外层填（终局 result 不入账本）
  }
}

/* ---------- N1 三档梯度 ---------- */
console.log('== N1 三档梯度（全同档房 × 3 seed × 3000 tick 本地全速）==')
const LVLS = ['casual', 'balanced', 'competitive']
const SEEDS = [20261001, 20261002, 20261003]
const n1 = {}
for (const lvl of LVLS) {
  n1[lvl] = SEEDS.map((sd) => driveRoom(sd, [lvl, lvl, lvl, lvl], 3000))
  const rs = n1[lvl]
  console.log(`  ${lvl.padEnd(12)} fires=${f1(avg(rs.map((r) => r.fires)))} HE=${f1(avg(rs.map((r) => r.heFires)))} rate=${f1(avg(rs.map((r) => r.hits / Math.max(r.fires, 1))))} kills=${f1(avg(rs.map((r) => r.kills)))} endTick=${f1(avg(rs.map((r) => r.endTick)))} capTick=${f1(avg(rs.map((r) => r.capTicks)))}`)
}
const m = (lvl, k) => avg(n1[lvl].map((r) => r[k]))
const rate = (lvl) => avg(n1[lvl].map((r) => r.hits / Math.max(r.fires, 1)))
ok('D1', '命中率梯度：comp 最高（>cas 且 >bal——提前量解算收敛）', rate('competitive') > rate('casual') && rate('competitive') > rate('balanced'),
  `cas=${f1(rate('casual'))} bal=${f1(rate('balanced'))} comp=${f1(rate('competitive'))}`)
/* D2 混跑对位面：全同档房双方互为中距（HE 环少访）；bal-vs-cas 对位中 cas 蜂拥
 * 贴脸、bal 拉距=射程环压制 HE 有舞台（QA1 §4 战术面口径的对位版） */
const heMatch = SEEDS.map((sd) => {
  const r = driveRoom(sd, ['balanced', 'casual', 'balanced', 'casual'], 3000)
  const by = (team) => r.evLog.filter((e) => e.k === 'fire' && e.ammo === 1 && e.seat % 2 === team).length
  return { bal: by(0), cas: by(1) }
})
ok('D2', 'HE 战术面：bal-vs-cas 对位中 bal 侧战术 HE 使用 > cas 侧（射程环压制 vs 弹尽兜底）',
  avg(heMatch.map((r) => r.bal)) > avg(heMatch.map((r) => r.cas)),
  `bal=${f1(avg(heMatch.map((r) => r.bal)))} cas=${f1(avg(heMatch.map((r) => r.cas)))}（3 seed）`)
ok('D3', '终局提前度：comp 平均 endTick < cas（压制力终结对局，QA1 §4 续证）', m('competitive', 'endTick') < m('casual', 'endTick'),
  `comp=${f1(m('competitive', 'endTick'))} bal=${f1(m('balanced', 'endTick'))} cas=${f1(m('casual', 'endTick'))}`)
ok('D4', '开局先占：comp 房 capTick 事件全 3 seed 非零（席 2 先占分工）', n1.competitive.every((r) => r.capTicks > 0),
  `comp capTick=${n1.competitive.map((r) => r.capTicks).join('/')} cas=${n1.casual.map((r) => r.capTicks).join('/')}`)

/* ---------- N2 开局树双证 ---------- */
console.log('== N2 开局树双证（三档各 2 seed 前 30s=300 tick 指标表 + 判别器 + 确定性）==')
const N2S = [20261011, 20261012]
/* 起跑段画像：首开火 tick/人均位移（排除重生跳变）/提前量预判率（tur 指向 3 轮迭代
 * 提前点比指向目标当前位更近的采样占比——目标须在动且两方向可分）/锚点驻泊率（己席
 * 锚链 30000 内采样占比）/占点圈驻泊率（CAP_R2 内） */
function openingProfile(seed, lvl, ticks = 300) {
  const st = SIM.create(seed, {})
  const room = { seats: [0, 1, 2, 3].map((i) => ({ seat: i, kind: 'bot' })) }
  let firstFire = -1, disp = 0, leadN = 0, leadHit = 0, anchN = 0, anchIn = 0, capN = 0, capIn = 0, samples = 0
  let last = st.players.map((p) => [p.x, p.y])
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (let s = 0; s < 4; s++) inputs[s] = SIM.brain(st, s, lvl)
    const r = SIM.step(st, inputs, room)
    for (const e of r.events || []) if (e.k === 'fire' && firstFire < 0) firstFire = st.tick
    for (let s = 0; s < 4; s++) {
      const p = st.players[s]
      const d = Math.hypot(p.x - last[s][0], p.y - last[s][1])
      if (d < 50000) disp += d
      last[s] = [p.x, p.y]
    }
    if (t % 5 === 0) {
      samples++
      for (let s = 0; s < 4; s++) {
        const p = st.players[s]
        if (!p || !p.alive) continue
        anchN++
        if (ANCHORS[s].some((a) => (p.x - a[0]) ** 2 + (p.y - a[1]) ** 2 < 30000 * 30000)) anchIn++
        if ((p.x - C.CAP_CX) ** 2 + (p.y - C.CAP_CY) ** 2 <= C.CAP_R2) { capIn++; capN++ }
        /* 提前量预判率：敌最近者、在动（mem 速度）、两方向角差 >150 档才可分辨 */
        let foe = null, fd = Infinity
        for (let q = 0; q < 4; q++) {
          const fp = st.players[q]
          if (!fp || !fp.alive || fp.team === p.team) continue
          const dd = (p.x - fp.x) ** 2 + (p.y - fp.y) ** 2
          if (dd < fd) { fd = dd; foe = fp }
        }
        const mv = st.mem[foe && foe.seat]
        if (!foe || !mv || Math.abs(mv.vx) + Math.abs(mv.vy) < 800) continue
        const lead = lead3(p, foe, mv)
        const dirCur = Math.atan2(foe.y - p.y, foe.x - p.x)
        const dirLd = Math.atan2(lead.y - p.y, lead.x - p.x)
        const dirTur = (((SIM.brain(st, s, lvl).tur >> 3) & 8191) / 8192) * 2 * Math.PI
        if (Math.abs(angRad(dirTur, dirCur)) * 8192 / (2 * Math.PI) * 8192 < 150) continue
        const aCur = Math.abs(angRad(dirTur, dirCur)), aLd = Math.abs(angRad(dirTur, dirLd))
        if (Math.abs(aCur - aLd) < 0.02) continue
        leadN++
        if (aLd < aCur) leadHit++
      }
    }
  }
  return { firstFire, disp: disp / 4, leadRate: leadHit / Math.max(leadN, 1), anchorRate: anchIn / Math.max(anchN, 1), capRate: capIn / Math.max(samples * 4, 1) }
}
const angRad = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d }
/* lead3：§4.1 三轮闭式迭代镜像（挂具侧；风=0 场景免风偏复刻） */
function lead3(me, tgt, mv) {
  const vh = C.AMMO[0].vh
  let t = 0, ax = tgt.x, ay = tgt.y
  for (let i = 0; i < 3; i++) {
    ax = tgt.x + ((mv.vx * t / 5) | 0)
    ay = tgt.y + ((mv.vy * t / 5) | 0)
    t = (Math.hypot(ax - me.x, ay - me.y) / vh) | 0
  }
  return { x: ax, y: ay }
}
const prof = {}
for (const lvl of LVLS) prof[lvl] = N2S.map((sd) => openingProfile(sd, lvl))
console.log('  档位/seed       首开火  位移(k)  提前量率  锚驻泊  占点圈')
for (const lvl of LVLS) prof[lvl].forEach((r, i) => {
  console.log(`  ${lvl.padEnd(12)}#${N2S[i]} ${String(r.firstFire).padStart(5)} ${String(Math.round(r.disp / K)).padStart(7)} ${(r.leadRate * 100).toFixed(0).padStart(7)}% ${(r.anchorRate * 100).toFixed(0).padStart(6)}% ${(r.capRate * 100).toFixed(0).padStart(6)}%`)
})
/* 判别器：提前量率低=casual（无提前量直瞄当前位）；锚驻泊高=balanced（掩体轮换
 * 驻锚作战）；余者=competitive（绕侧不驻锚）。阈值取三档实测带中点（跑后标定：
 * leadRate cas∈[.04,.12] vs bal/comp≥.44 → .30；anchorRate bal∈[.46,.53] vs
 * comp=.08 → .35） */
const LEAD_CAS = 0.30, ANCHOR_BAL = 0.35
const discrimin = (r) => (r.leadRate < LEAD_CAS ? 'casual' : r.anchorRate > ANCHOR_BAL ? 'balanced' : 'competitive')
let hits = 0, det = []
for (const lvl of LVLS) prof[lvl].forEach((r, i) => { const g = discrimin(r); if (g === lvl) hits++; else det.push(`${lvl}#${N2S[i]}→${g}`) })
ok('N2a', '开局树判别器：三档 2 seed 共 6 局按指标向量判档全对（行为可分性）', hits === 6,
  `6/${hits} 对${det.length ? '，误判：' + det.join('，') : ''}`)
const detA = driveRoom(N2S[0], ['competitive', 'competitive', 'competitive', 'competitive'], 300).evLog.map((e) => JSON.stringify(e)).join('|')
const detB = driveRoom(N2S[0], ['competitive', 'competitive', 'competitive', 'competitive'], 300).evLog.map((e) => JSON.stringify(e)).join('|')
ok('N2b', '确定性双跑：同 seed 同档事件流逐字节相等', detA === detB, `${detA.length}B`)

/* ---------- 决策级场景构造（snake-king scene 同式：直接摆位后单拍调 brain） ---------- */
function mkScene() {
  const st = SIM.create(20261015, {})
  const room = { seats: [0, 1, 2, 3].map((i) => ({ seat: i, kind: 'bot' })) }
  SIM.step(st, {}, room) // 席位自愈 spawn 全员
  st.wind = { ang: 0, mag: 0 } // 免风偏（挂具 lead3 不复刻风补偿）
  st.tick = 400               // 越过开局先占窗（comp 占点分工不干扰战术面场景）
  return st
}
const put = (st, seat, x, y) => { const p = st.players[seat]; p.x = x; p.y = y; p.alive = true; p.cd = 0; p.hp = 100; p.ammo = [20, 10]; p.sel = 0 }
const vel = (st, seat, vx, vy) => { st.mem[seat] = Object.assign({}, st.mem[seat], { vx, vy, _pvx: vx, _pvy: vy, lx: st.players[seat].x, ly: st.players[seat].y }) }
const alignTo = (st, seat, tx, ty) => { const p = st.players[seat]; p.tur = angBr(st, seat, tx, ty) }
const angBr = (st, seat, tx, ty) => { const p = st.players[seat]; return Math.atan2(ty - p.y, tx - p.x) / (2 * Math.PI) * 8192 & 8191 }
const turOf = (out) => (out.tur >> 3) & 8191
const angDiffBr = (a, b) => { let d = Math.abs(a - b) % 8192; return d > 4096 ? 8192 - d : d }
const cosTo = (out, st, seat, tx, ty) => {
  const p = st.players[seat], dx = tx - p.x, dy = ty - p.y, l = Math.hypot(dx, dy) || 1
  const ol = Math.hypot(out.mx, out.my) || 1
  return (out.mx * dx + out.my * dy) / (ol * l)
}
const forceFresh = (st, seat) => { if (st.mem[seat]) st.mem[seat].dt = 0 } // 决策节流按调用数递减——稀疏采样场景显式归零=逐拍 fresh
const kinds4 = (h0 = 'bot', h1 = 'bot', h2 = 'bot', h3 = 'bot') => ({ kinds: [h0, h1, h2, h3], foeLose: [0, 0, 0, 0] })
const envLose = (foeLose, h0 = 'bot', h1 = 'bot', h2 = 'bot', h3 = 'bot') => {
  const e = kinds4(h0, h1, h2, h3); e.foeLose = [foeLose, foeLose, foeLose, foeLose]; return e
}

/* ---------- N3 放水链 A/B 决策级 ---------- */
console.log('== N3 放水链+深化 决策级 A/B（env 同 rooms.js botEnv 形状，走适配器出口包装）==')
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/iron-torrent/game.json'), 'utf8'))
ok('M0', '配置注入链：game.json bot.mercy/bot.casual 参数位在位（适配器 env 注入可调）',
  !!(cfg.bot && cfg.bot.mercy && cfg.bot.mercy.min === 2 && cfg.bot.mercy.hard === 4 && cfg.bot.mercy.noise1 === 9
    && cfg.bot.casual && cfg.bot.casual.aimP === 0.22 && cfg.bot.casual.holdP === 0.18 && cfg.bot.casual.turnP === 0.10),
  `mercy×${Object.keys(cfg.bot.mercy).length} 键 casual×${Object.keys(cfg.bot.casual).length} 键`)

/* L1 提前量迭代降档：comp 对横移目标瞄向角 vs 挂具 lead3（真 3 轮解）误差——
 * ctl≈噪声 2 档；L1（foeLose=2，humanFoe 席 1）迭代 3→2 轮=系统性提前量欠解
 * （240k 距离+12000 milli/tick 横移：2 轮 vs 3 轮解差 ~570 档可分辨） */
function leadErrArm(foeLose) {
  const st = mkScene()
  put(st, 0, 60 * K, 250 * K); put(st, 1, 300 * K, 250 * K)
  put(st, 2, 40 * K, 200 * K); put(st, 3, 320 * K, 300 * K)
  vel(st, 1, 0, 24000)
  vel(st, 0, 1500, 0) // 防「静止有输入」误触卡死滑墙旋转（噪声面场景无关移动）
  const env = foeLose ? envLose(foeLose, 'bot', 'human') : kinds4()
  const errs = []
  for (let t = 0; t < 24; t++) {
    st.tick = 400 + t * 5 // 逐 fresh 决策拍采样
    forceFresh(st, 0)
    const out = SIM.brain(st, 0, 'competitive', null, env)
    const ld = lead3(st.players[0], st.players[1], st.mem[1])
    errs.push(angDiffBr(turOf(out), angBr(st, 0, ld.x, ld.y)))
  }
  return avg(errs)
}
const le0 = leadErrArm(0), le1 = leadErrArm(2), le2 = leadErrArm(4)
ok('M1', 'L1 让力·提前量降档：连败 2 局瞄向系统性偏离真提前量解（ctl≈噪声位）', le0 < 40 && le1 > 150,
  `foeLose 0/2/4 → ${Math.round(le0)}/${Math.round(le1)}/${Math.round(le2)} brads`)

/* 散布附加：对静止目标（理想瞄向恒定）tur 采样标准差——ctl 2/L1 2+9/L2 降档 bal 9+18
 * （样本相对首样回绕解包后再求方差——0/8191 界附近直接均值会假爆） */
function noiseArm(foeLose) {
  const st = mkScene()
  put(st, 0, 100 * K, 250 * K); put(st, 1, 240 * K, 250 * K)
  put(st, 2, 80 * K, 200 * K); put(st, 3, 280 * K, 300 * K)
  vel(st, 0, 1500, 0)
  vel(st, 1, 0, 0)
  const env = foeLose ? envLose(foeLose, 'bot', 'human') : kinds4()
  const raw = []
  for (let t = 0; t < 36; t++) {
    st.tick = 400 + t * 5 // 逐 fresh 决策拍采样（噪声只在 fresh 拍抽取）
    forceFresh(st, 0)
    const out = SIM.brain(st, 0, 'competitive', null, env)
    raw.push(turOf(out))
  }
  const base = raw[0]
  const un = raw.map((a) => { let d = (a - base) % 8192; if (d > 4096) d -= 8192; if (d < -4096) d += 8192; return d })
  const mean = avg(un)
  return Math.sqrt(avg(un.map((d) => (d - mean) ** 2)))
}
const ns0 = noiseArm(0), ns1 = noiseArm(2), ns2 = noiseArm(4)
ok('M2', '散布附加梯度：L1 > ctl 且 L2（降档+noise2）> L1（静止目标 tur 方差带）', ns0 < ns1 && ns1 < ns2,
  `std ctl/L1/L2 = ${f1(ns0)}/${f1(ns1)}/${f1(ns2)} brads`)

/* 失误注入·犹豫窗：静止目标对齐在环内，60 拍 fire 出射率——ctl 全射，L1 有 hold 窗 */
function holdArm(foeLose) {
  const st = mkScene()
  put(st, 0, 100 * K, 250 * K); put(st, 1, 240 * K, 250 * K)
  put(st, 2, 80 * K, 200 * K); put(st, 3, 280 * K, 300 * K)
  alignTo(st, 0, 240 * K, 250 * K)
  const env = foeLose ? envLose(foeLose, 'bot', 'human') : kinds4()
  let fires = 0
  for (let t = 0; t < 60; t++) {
    st.tick = 400 + t
    const out = SIM.brain(st, 0, 'competitive', null, env)
    if (out.cmd && out.cmd.k === 'fire') fires++
  }
  return fires / 60
}
const h0r = holdArm(0), h1r = holdArm(2)
ok('M3', 'L1 让力·失误注入犹豫窗：fire 出射率 ctl=1.0 → 连败档显著回落', h0r === 1 && h1r < 0.93,
  `ctl=${h0r.toFixed(2)} / L1=${h1r.toFixed(2)}`)

/* L2 行为降档（决策面）：ping 集火是 comp 专属——mate tur 指远敌 X（135k，ping 加权
 * 4e9 翻转最近敌选择）；L2（foeLose=4→降档 balanced）ping 熄灭=回最近敌 Y（120k） */
function pingArm(foeLose) {
  const st = mkScene()
  put(st, 0, 100 * K, 250 * K)
  put(st, 1, 235 * K, 250 * K)  // 敌 X（东 135k，mate tur 指向它）
  put(st, 3, 100 * K, 370 * K)  // 敌 Y（南 120k，最近敌）
  put(st, 2, 100 * K, 250 * K)  // mate 与我同位，tur 指向 X（东）
  st.players[2].tur = 0
  vel(st, 1, 0, 0); vel(st, 3, 0, 0)
  st.tick = 500
  const env = foeLose ? envLose(foeLose, 'bot', 'human') : kinds4()
  const out = SIM.brain(st, 0, 'competitive', null, env)
  const dirX = angBr(st, 0, 235 * K, 250 * K), dirY = angBr(st, 0, 100 * K, 370 * K)
  return angDiffBr(turOf(out), dirX) < angDiffBr(turOf(out), dirY) ? 'X' : 'Y'
}
ok('M4', 'L2 重败·行为降档：comp ping 集火选 mate 指向敌 → 降档 balanced 回最近敌', pingArm(0) === 'X' && pingArm(4) === 'Y',
  `ctl=${pingArm(0)}（ping 集火）/ L2=${pingArm(4)}`)

/* 生态位让位：同队真人（席 2）连败——ctl 前压交火；连败档 bot 收步到真人身后+让炮 */
function yieldArm(foeLose, mateAmmo) {
  const st = mkScene()
  put(st, 0, 130 * K, 250 * K)  // bot 比真人更近火线
  put(st, 1, 300 * K, 250 * K)  // 敌（东 170k）
  put(st, 2, 100 * K, 250 * K)  // 真人队友（西，距敌 200k）
  put(st, 3, 280 * K, 400 * K)
  if (mateAmmo === 0) st.players[2].ammo = [0, 0]
  alignTo(st, 0, 300 * K, 250 * K)
  vel(st, 1, 0, 0)
  st.tick = 600
  const env = envLose(foeLose, 'bot', 'bot', 'human')
  const out = SIM.brain(st, 0, 'competitive', null, env)
  const mate = st.players[2], foe = st.players[1]
  const l = Math.hypot(mate.x - foe.x, mate.y - foe.y) || 1
  const bx = mate.x + (mate.x - foe.x) / l * 60 * K, by = mate.y + (mate.y - foe.y) / l * 60 * K
  return { cosFoe: cosTo(out, st, 0, foe.x, foe.y), cosBehind: cosTo(out, st, 0, bx, by), fire: out.cmd && out.cmd.k === 'fire' ? 1 : 0 }
}
const y0 = yieldArm(0), y1 = yieldArm(2), y1b = yieldArm(2, 0)
ok('M5', '生态位让位·收步：ctl 朝敌前压 → 连败档朝真人身后收步（不抢火线）', y0.cosFoe > 0.5 && y1.cosBehind > 0.5 && y1.cosFoe < 0.3,
  `cos敌 ctl=${y0.cosFoe.toFixed(2)} / 连败=${y1.cosFoe.toFixed(2)}，cos身后=${y1.cosBehind.toFixed(2)}`)
ok('M6', '生态位让位·让火力位：真人更近且有余弹 → bot 让炮；真人弹尽不白让', y0.fire === 1 && y1.fire === 0 && y1b.fire === 1,
  `ctl=${y0.fire} 让位=${y1.fire} 真人弹尽=${y1b.fire}`)

/* ---------- N4 深化决策面（三档真分化） ---------- */
console.log('== N4 深化决策面（casual 失误参数化 / balanced 受击退掩体+巡航 / comp 模式切换+ping）==')
/* casual 失误率参数化：env.casual 全量注入——aimP=1 恒大偏（tur 偏离敌向 ≈jit）+
 * holdP=1 恒犹豫（零 fire）；turnP=1 恒背敌；零失误配置回 DEV 冻结行为 */
function casualArm(cu) {
  const st = mkScene()
  put(st, 0, 100 * K, 250 * K); put(st, 1, 240 * K, 250 * K)
  put(st, 2, 80 * K, 200 * K); put(st, 3, 280 * K, 300 * K)
  alignTo(st, 0, 240 * K, 250 * K)
  vel(st, 1, 0, 0)
  const env = { kinds: ['bot', 'bot', 'bot', 'bot'], foeLose: [0, 0, 0, 0], casual: cu }
  vel(st, 0, 1500, 0) // 防「静止有输入」误触卡死滑墙旋转（失误面场景无关移动）
  let fires = 0, angErr = 0, n = 0, away = 0
  for (let t = 0; t < 30; t++) {
    st.tick = 400 + t
    const out = SIM.brain(st, 0, 'casual', null, env)
    if (out.cmd && out.cmd.k === 'fire') fires++
    angErr += angDiffBr(turOf(out), angBr(st, 0, 240 * K, 250 * K)); n++
    if (cosTo(out, st, 0, 240 * K, 250 * K) < -0.5) away++
  }
  return { fires, angErr: angErr / n, away }
}
const cMax = casualArm({ aimP: 1, jit: 900, holdP: 1, turnP: 0 })
const cTurn = casualArm({ aimP: 0, jit: 900, holdP: 0, turnP: 1 })
const cZero = casualArm({ aimP: 0, jit: 900, holdP: 0, turnP: 0 })
ok('T1', 'casual 失误率参数化：aimP=1 恒大偏+holdP=1 恒犹豫（零 fire）；零失误配回冻结行为',
  cMax.angErr > 500 && cMax.fires === 0 && cZero.fires > 0 && cZero.angErr < 100,
  `大偏=${Math.round(cMax.angErr)}brads/火${cMax.fires}发；零失误=${Math.round(cZero.angErr)}brads/火${cZero.fires}发`)
ok('T2', 'casual 走位失误率：turnP=1 恒背敌盲走（对照零失误朝敌）', cTurn.away >= 28 && cZero.angErr < 100,
  `背敌拍 ${cTurn.away}/30`)

/* balanced 受击退掩体：hp 骤降后 60% 概率退最近锚——两 fresh 拍制（前拍记账 lhp，
 * 次拍带伤决策；12 组统计 ≥6）；ctl（无伤）恒不退 */
function retreatArm(hit) {
  const st = mkScene()
  put(st, 0, 170 * K, 250 * K)  // 场心（最近锚=席 0 末锚 120k,170k）
  put(st, 1, 400 * K, 250 * K)  // 敌远 230k（>200k=巡航/退锚分支）
  put(st, 2, 80 * K, 200 * K); put(st, 3, 280 * K, 300 * K)
  vel(st, 1, 0, 0)
  vel(st, 0, 1500, 0) // 防「静止有输入」误触卡死滑墙旋转（90° 旋转的假「朝锚」余弦）
  let retreats = 0
  for (let t = 0; t < 12; t++) {
    st.tick = 500 + t * 16
    forceFresh(st, 0)
    SIM.brain(st, 0, 'balanced', null, kinds4()) // fresh#1：记账 lhp=100
    if (hit) st.players[0].hp = 60
    st.tick += 8
    forceFresh(st, 0)
    const out = SIM.brain(st, 0, 'balanced', null, kinds4()) // fresh#2：带伤决策
    if (cosTo(out, st, 0, 120 * K, 170 * K) > 0.7) retreats++
    st.players[0].hp = 100
  }
  return retreats
}
const r0 = retreatArm(false), r1 = retreatArm(true)
ok('T3', 'balanced 受击退掩体：hp 骤降后多数 fresh 拍退最近锚（60% 概率统计带）；ctl 不退', r0 === 0 && r1 >= 6,
  `ctl=${r0}/12 受击=${r1}/12`)

/* competitive 占点-歼灭模式切换：敌占点 bar=50000 → 回防占点（朝 CAP）；
 * 无占点压力 → 绕侧追猎（不朝 CAP） */
function capSwitchArm(pressure) {
  const st = mkScene()
  put(st, 0, 170 * K, 120 * K)
  put(st, 1, 280 * K, 300 * K)
  put(st, 2, 100 * K, 100 * K); put(st, 3, 280 * K, 60 * K)
  if (pressure) { st.capTeam = 1; st.capBar = 50000 }
  vel(st, 1, 0, 0)
  st.tick = 600
  const out = SIM.brain(st, 0, 'competitive', null, kinds4())
  return cosTo(out, st, 0, C.CAP_CX, C.CAP_CY)
}
const cs0 = capSwitchArm(false), cs1 = capSwitchArm(true)
ok('T4', 'comp 占点-歼灭模式切换：敌占点 50% 进度立即回防（朝占点）vs 无压力绕侧追猎', cs1 > 0.6 && cs0 < 0.5,
  `cosCAP 无压力=${cs0.toFixed(2)} / 敌占点=${cs1.toFixed(2)}`)

/* ---------- N5 让位入口/旁观位语义（RoomManager 离线实例零端口） ---------- */
console.log('== N5 让位入口/旁观位语义（RoomManager 离线实例零端口）==')
{
  const rm = new RoomManager({ log: () => {} })
  rm.register(SIM)
  const mkCtx = () => ({ conn: { writable: true, send: () => {} }, room: null, seat: -1, role: null, isTest: false })
  const room = rm.create({ gameId: 'iron-torrent', bots: [{ level: 'balanced' }, { level: 'balanced' }, { level: 'casual' }, { level: 'balanced' }], startDelayMs: 5000 })
  const h1 = mkCtx()
  const j1 = rm.join(h1, { roomId: room.id, mode: 'play', name: 'H1' })
  ok('Y1', '让位入口：真人加入 bot 房走 seat 最大 bot 席让位（协议 §2 真人优先）', j1.ok && j1.seat === 3 && j1.takeover && room.seats[3].kind === 'human',
    `takeover seat=${j1.seat}（kind=${room.seats[3].kind}）`)
  const sp = mkCtx()
  const js = rm.join(sp, { roomId: room.id, mode: 'spectate' })
  ok('Y2', '旁观位语义：显式 spectate 不占席不让位（有空位仍旁观）', js.ok && sp.role === 'spectator' && sp.seat === -1 && room.seats[2].kind === 'bot',
    `role=${sp.role} seat=${sp.seat}`)
  for (const s of [2, 1, 0]) { if (room.seats[s].kind !== 'human') { const c = mkCtx(); rm.join(c, { roomId: room.id, mode: 'play', name: 'H' + s }) } }
  const fifth = mkCtx()
  const j5 = rm.join(fifth, { roomId: room.id, mode: 'play', name: 'H5' })
  ok('Y3', '满员 4 真人：第 5 人自动转旁观（seat=−1 同流观战）', j5.ok && j5.spectator && fifth.seat === -1 && fifth.role === 'spectator',
    `spectator=${!!j5.spectator} role=${fifth.role}`)
}

/* ---------- N6 确定性/回放等价 ---------- */
console.log('== N6 确定性/回放等价（混档局在线驱动 == replayInputs 重放，A8 离线同构）==')
{
  const lvls = ['balanced', 'competitive', 'balanced', 'casual']
  const live = driveRoom(20261020, lvls, 1200)
  const st2 = S.replayInputs(20261020, { botLevels: lvls }, live.st.inLog, live.endTick)
  ok('R1', '回放等价：在线终态 stateHash == replayInputs 输入日志重放 hash（混档 bot 局）',
    SIM.hashState(live.st) === S.hashState(st2), `hash=${SIM.hashState(live.st)} endTick=${live.endTick}`)
  /* env 在场零扰动口径：botEnv（kinds+foeLose 全 0，api 剧本房形状）与 env 缺省逐字节等价 */
  const a = driveRoom(20261021, lvls, 900)
  const b = driveRoom(20261021, lvls, 900, { kinds: ['bot', 'bot', 'bot', 'bot'], foeLose: [0, 0, 0, 0] })
  ok('R2', '放水链 env 零扰动：foeLose 全 0（剧本房形状）与 env 缺省事件流逐字节相等（A8 口径）',
    a.evLog.map((e) => JSON.stringify(e)).join('|') === b.evLog.map((e) => JSON.stringify(e)).join('|'),
    `${a.evLog.length} 事件`)
}

console.log(`\n${pass} 通过 ${fail} 失败`)
process.exit(fail ? 1 : 0)
