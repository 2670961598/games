/* =====================================================================
 * street-soccer-bot2-check（GAMES-140 · BOT 深化验收挂具）——参照
 * snake-king-bot2-check 范式（GAMES-102），六支柱：
 *   N1 三档梯度：全同档房 × 3 seed × 1800 tick（本地全速）——进球贡献/触球节拍/
 *      对抗谱（tackle+steal）/终局提前度四指标档间梯度（QA1 §4 行为谱口径续证）
 *   N2 开局树双证：三档各 2 seed 起跑段（前 30s=600 tick）指标表（触球/射门/传球/
 *      跑位热区）+ 离线判别器（按指标向量判档 6/6 全对=行为可分性）+ 确定性双跑
 *      （事件流逐字节相等）
 *   N3 放水链决策级 A/B：配置注入链（game.json bot.mercy/bot.casual）/
 *      L1 让力（射门精度衰减）/ L2 重败（行为降档）/ 生态位让位（自由球不与
 *      同队真人争抢+让球权）；深化决策面（balanced 直塞/competitive 一脚出球+
 *      无球侧穿插+墙式前插）
 *   N4 QA1 O-3 补测：balanced 混跑对位（vs competitive / vs casual 各 3 seed）
 *      steal/tackle 观测面——验证非零并记录（bal-vs-bal 同档对位 0 的观测面缺口）
 *   N5 让位入口/旁观位语义复核（QA1 O-1）：RoomManager 离线实例——真人加入走
 *      bot 让位（seat 最大 bot 席）/显式 spectate 不占席/满员 4 真人第 5 人旁观
 *   N6 确定性/回放等价：同 seed 混档局在线驱动 == replayInputs 输入日志重放
 *      （A8 离线同构；服务端路径由冻结命令 api-check street-soccer 覆盖）
 * 用法：node scripts/street-soccer-bot2-check.mjs
 * ===================================================================== */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { streetSoccerSim: SIM } = await import(join(ROOT, 'server/gateway/sims/street-soccer.js'))
const { RoomManager } = await import(join(ROOT, 'server/gateway/rooms.js'))
const S = require(join(ROOT, 'games/multiplayer/street-soccer/sim.cjs'))

let pass = 0, fail = 0
function ok(id, name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.log(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
const f1 = (x) => +x.toFixed(1)
const K = 1000 // milli 换算
const H = 500000

/* ---------- 本地全速驱动一局（4 席全 bot；env 透传 brain=适配器出口包装链） ----------
 * 事件按拍批注 tick（账本事件本体无 frame 字段——pass/onetwo 链窗口判定用） */
function driveRoom(seed, lvls, ticks, env) {
  const st = SIM.create(seed, {})
  const room = { seats: lvls.map((_, i) => ({ seat: i, kind: 'bot' })) }
  const evLog = []
  let over = null
  /* 二过一链（墙式配合观测面）：A pass→B 后 ≤40 拍内 B 回传 A，且 A 向进攻门推进
   * ≥25000（真前插跑位——过滤安全球横传/回传乒乓）；逐拍采样 A 的位姿（账本无位置） */
  let onetwo = 0
  const pend = {}
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (let s = 0; s < 4; s++) inputs[s] = SIM.brain(st, s, lvls[s], null, env)
    const r = SIM.step(st, inputs, room)
    for (const e of r.events) {
      e.tick = st.tick
      evLog.push(e)
      if (e.k === 'goal') { for (const k2 of Object.keys(pend)) delete pend[k2]; continue }
      if (e.k !== 'pass' || e.to < 0) continue
      const pa = pend[e.to]
      if (pa && pa.to === e.from && e.tick - pa.t <= 40) {
        const pA = st.players[e.to], adv = e.to % 2 === 0 ? pa.y - pA.y : pA.y - pa.y
        if (adv >= 25000) onetwo++
        delete pend[e.to]
      }
      const pF = st.players[e.from]
      if (pF) pend[e.from] = { to: e.to, t: e.tick, y: pF.y }
    }
    if (r.over) { over = r.result; break }
  }
  const cnt = (k, f) => evLog.filter((e) => e.k === k && (!f || f(e))).length
  return {
    st, evLog, over,
    goals: st.score.A + st.score.B,
    touch: cnt('touch'), shot: cnt('shot'), pass: cnt('pass'),
    tackle: cnt('tackle'), tackleWin: cnt('tackle', (e) => e.res === 'win'),
    steal: cnt('steal'), onetwo,
    endTick: st.tick,
  }
}

/* 起跑段画像（前 600 tick 固定窗）：触球/射门/传球/对抗 + 跑位热区
 * （进攻向三分带占格比 + 横向三通道占格比）+ 距球均值 + 双人拉开均值 */
function openingProfile(seed, lvl, ticks = 600) {
  const st = SIM.create(seed, {})
  const room = { seats: [0, 1, 2, 3].map((i) => ({ seat: i, kind: 'bot' })) }
  const zone = [0, 0, 0], xz = [0, 0, 0]
  let dBall = 0, spread = 0, n = 0, touch = 0, shot = 0, pass = 0, tackle = 0
  for (let t = 0; t < ticks; t++) {
    const inputs = {}
    for (let s = 0; s < 4; s++) inputs[s] = SIM.brain(st, s, lvl)
    const r = SIM.step(st, inputs, room)
    for (const e of r.events) { if (e.k === 'touch') touch++; else if (e.k === 'shot') shot++; else if (e.k === 'pass') pass++; else if (e.k === 'tackle') tackle++ }
    if (t % 12 === 0) {
      n++
      let db = 0
      for (const p of st.players) {
        if (!p) continue
        db += Math.sqrt((p.x - st.ball.x) ** 2 + (p.y - st.ball.y) ** 2)
        const fwd = p.team === 0 ? p.y : H - p.y // 归一：值小=靠进攻门
        zone[fwd < 166667 ? 0 : fwd < 333333 ? 1 : 2]++
        xz[p.x < 116667 ? 0 : p.x < 233334 ? 1 : 2]++
      }
      dBall += db / 4
      const a = st.players[0], b = st.players[2], c = st.players[1], d = st.players[3]
      spread += (Math.hypot(a.x - b.x, a.y - b.y) + Math.hypot(c.x - d.x, c.y - d.y)) / 2
    }
  }
  return { touch, shot, pass, tackle, dBall: dBall / n, spread: spread / n, zone, xz, n }
}

/* ---------- 决策级场景构造（snake-king scene 同式：直接摆位后单拍调 brain） ---------- */
function mkScene() {
  const st = SIM.create(20261015, {})
  const room = { seats: [0, 1, 2, 3].map((i) => ({ seat: i, kind: 'bot' })) }
  SIM.step(st, {}, room) // 席位自愈 spawn 全员
  return st
}
const put = (st, seat, x, y) => { const p = st.players[seat]; p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.stumbleT = 0; p.lungeT = 0 }
const putBall = (st, x, y, owner) => { const B = st.ball; B.x = x; B.y = y; B.vx = 0; B.vy = 0; B.owner = owner }
const kinds4 = (h0 = 'bot', h1 = 'bot', h2 = 'bot', h3 = 'bot') => ({ kinds: [h0, h1, h2, h3], foeLose: [0, 0, 0, 0] })
const head = (out, tx, ty, st, seat) => { // 输出向量与（自席→目标）方向夹角余弦
  const p = st.players[seat], dx = tx - p.x, dy = ty - p.y, l = Math.hypot(dx, dy) || 1
  const ol = Math.hypot(out.mx, out.my) || 1
  return (out.mx * dx + out.my * dy) / (ol * l)
}
const angErrBrads = (out, st, seat) => { // shot 指向与「球→敌门心」夹角（8192 brads 圈）
  const G = seat % 2 === 0 ? { x: 175 * K, y: 0 } : { x: 175 * K, y: 500 * K }
  const q = (out.cmd.ang >> 3) & 8191
  const want = Math.atan2(G.y - st.ball.y, G.x - st.ball.x) / (2 * Math.PI) * 8192
  let d = Math.abs(q - want) % 8192
  return d > 4096 ? 8192 - d : d
}
const envLose = (foeLose, h0 = 'human', h1 = 'bot', h2 = 'bot', h3 = 'bot') => {
  const e = kinds4(h0, h1, h2, h3); e.foeLose = [foeLose, foeLose, foeLose, foeLose]; return e
}

console.log('== N1 三档梯度（全同档房 × 3 seed × 1800 tick 本地全速）==')
const LVLS = ['casual', 'balanced', 'competitive']
const SEEDS = [20261001, 20261002, 20261003]
const N1T = 1800
const n1 = {}
for (const lvl of LVLS) {
  n1[lvl] = SEEDS.map((sd) => driveRoom(sd, [lvl, lvl, lvl, lvl], N1T))
  console.log(`  ${lvl.padEnd(12)} goals=${f1(avg(n1[lvl].map((r) => r.goals)))} touch=${f1(avg(n1[lvl].map((r) => r.touch)))} shot=${f1(avg(n1[lvl].map((r) => r.shot)))} pass=${f1(avg(n1[lvl].map((r) => r.pass)))} tackle=${f1(avg(n1[lvl].map((r) => r.tackle)))} steal=${f1(avg(n1[lvl].map((r) => r.steal)))} onetwo=${f1(avg(n1[lvl].map((r) => r.onetwo)))} endTick=${f1(avg(n1[lvl].map((r) => r.endTick)))}`)
}
const m = (lvl, k) => avg(n1[lvl].map((r) => r[k]))
ok('D1', '进球贡献梯度：comp > bal 且 comp > cas（QA1 §4 口径续证）', m('competitive', 'goals') > m('balanced', 'goals') && m('competitive', 'goals') > m('casual', 'goals'),
  `cas=${f1(m('casual', 'goals'))} bal=${f1(m('balanced', 'goals'))} comp=${f1(m('competitive', 'goals'))}`)
ok('D2', '触球节拍梯度：cas 蜂群 > comp 且 > bal', m('casual', 'touch') > m('competitive', 'touch') && m('casual', 'touch') > m('balanced', 'touch'),
  `cas=${f1(m('casual', 'touch'))} bal=${f1(m('balanced', 'touch'))} comp=${f1(m('competitive', 'touch'))}`)
ok('D3', '对抗谱梯度：cas（扑抢+抢断）> bal', m('casual', 'tackle') + m('casual', 'steal') > m('balanced', 'tackle') + m('balanced', 'steal'),
  `cas tack+steal=${f1(m('casual', 'tackle') + m('casual', 'steal'))} bal=${f1(m('balanced', 'tackle') + m('balanced', 'steal'))}`)
ok('D4', '终局提前度：comp 平均 endTick < bal（goal-cap 提前终局=强度信号）', m('competitive', 'endTick') < m('balanced', 'endTick'),
  `comp=${f1(m('competitive', 'endTick'))} bal=${f1(m('balanced', 'endTick'))}`)

console.log('== N2 开局树双证（三档各 2 seed 前 30s=600 tick 指标表 + 判别器 + 确定性）==')
const N2S = [20261011, 20261012]
const prof = {}
for (const lvl of LVLS) prof[lvl] = N2S.map((sd) => openingProfile(sd, lvl))
console.log('  档位/seed      touch  shot  pass  tackle  进攻三/中三/本方三  左/中/右通道  dBall  spread')
for (const lvl of LVLS) prof[lvl].forEach((r, i) => {
  const zn = r.zone.reduce((a, b) => a + b, 0) || 1, xn = r.xz.reduce((a, b) => a + b, 0) || 1
  console.log(`  ${lvl.padEnd(10)}#${N2S[i]} ${String(r.touch).padStart(5)} ${String(r.shot).padStart(5)} ${String(r.pass).padStart(5)} ${String(r.tackle).padStart(7)}   ${Math.round(r.zone[0] / zn * 100)}%/${Math.round(r.zone[1] / zn * 100)}%/${Math.round(r.zone[2] / zn * 100)}%   ${Math.round(r.xz[0] / xn * 100)}%/${Math.round(r.xz[1] / xn * 100)}%/${Math.round(r.xz[2] / xn * 100)}%   ${Math.round(r.dBall / K)}k  ${Math.round(r.spread / K)}k`)
})
/* 判别器：按起跑段指标向量判档——蜂群触球峰=casual、射门谱=comp（满段射+一脚出球
   到达率高）、余者=balanced；阈值取三档实测带中点（casual touch∈[80,116] vs
   bal∈[32,51] → 65；bal shot 恒 0 vs comp∈[5,6] → 4） */
const TOUCH_CAS = 65, SHOT_COMP = 4
const discrimin = (r) => (r.touch > TOUCH_CAS ? 'casual' : r.shot >= SHOT_COMP ? 'competitive' : 'balanced')
let hits = 0, det = []
for (const lvl of LVLS) prof[lvl].forEach((r, i) => { const g = discrimin(r); if (g === lvl) hits++; else det.push(`${lvl}#${N2S[i]}→${g}`) })
ok('N2a', '开局树判别器：三档 2 seed 共 6 局按指标向量判档全对（行为可分性）', hits === 6,
  `6/${hits} 对${det.length ? '，误判：' + det.join('，') : ''}`)
const detA = driveRoom(N2S[0], ['competitive', 'competitive', 'competitive', 'competitive'], 600).evLog.map((e) => JSON.stringify(e)).join('|')
const detB = driveRoom(N2S[0], ['competitive', 'competitive', 'competitive', 'competitive'], 600).evLog.map((e) => JSON.stringify(e)).join('|')
ok('N2b', '确定性双跑：同 seed 同档事件流逐字节相等', detA === detB, `${detA.length}B`)

console.log('== N3 放水链+深化 决策级 A/B（env 同 rooms.js botEnv 形状，走适配器出口包装）==')
const cfg = JSON.parse(readFileSync(join(ROOT, 'games/multiplayer/street-soccer/game.json'), 'utf8'))
ok('M0', '配置注入链：game.json bot.mercy/bot.casual 阈值在位（适配器 env 注入可调）',
  !!(cfg.bot && cfg.bot.mercy && cfg.bot.mercy.min === 2 && cfg.bot.mercy.hard === 4
    && cfg.bot.casual && cfg.bot.casual.passP === 0.15 && cfg.bot.casual.jit === 3400),
  `mercy={min:${cfg.bot.mercy.min},hard:${cfg.bot.mercy.hard}} casual×${Object.keys(cfg.bot.casual).length} 键`)

/* L1/L2 射门精度衰减：comp 席 1（B 队，攻下门）持球于射窗（门心连线无敌无压），
 * foeLose 0/2/4 三臂各 40 拍采样 shot 指向误差（brads）——ctl≈0（comp jit=0）、
 * L1（散布附加 jit1=1300）、L2（降档 balanced+jit2=2600）误差带递增 */
function shotErrArm(foeLose) {
  const st = mkScene()
  put(st, 1, 175 * K, 400 * K); put(st, 3, 60 * K, 460 * K)
  put(st, 0, 175 * K, 30 * K); put(st, 2, 300 * K, 60 * K)
  putBall(st, 175 * K, 400 * K, 1)
  const env = envLose(foeLose)
  const errs = []
  for (let t = 0; t < 40; t++) {
    st.tick = 100 + t
    const out = SIM.brain(st, 1, 'competitive', null, env)
    if (out.cmd && out.cmd.k === 'shot') errs.push(angErrBrads(out, st, 1))
  }
  return avg(errs)
}
const e0 = shotErrArm(0), e1 = shotErrArm(2), e2 = shotErrArm(4)
ok('M1', 'L1 让力·射门精度衰减：连败 2 局 shot 指向误差带显著抬升（ctl≈0）', e0 < 100 && e1 > 300,
  `foeLose 0/2/4 → ${Math.round(e0)}/${Math.round(e1)}/${Math.round(e2)} brads`)
ok('M2', 'L2 重败·散布加倍：误差带 > L1', e2 > e1, `${Math.round(e2)} > ${Math.round(e1)} brads`)

/* L2 行为降档（决策面）：comp 持球被压 ~29k（不封门心线）、队友被罩 → ctl 期望值
 * 仲裁仍射；L2（foeLose=4→降档 balanced）被压即出安全球 */
function downgradeArm(foeLose) {
  const st = mkScene()
  put(st, 1, 175 * K, 400 * K); put(st, 3, 60 * K, 460 * K)
  put(st, 0, 203 * K, 410 * K); put(st, 2, 60 * K, 440 * K)      // A 队：压球者 29.7k（线外）+ 罩队友者
  putBall(st, 175 * K, 400 * K, 1)
  st.tick = 200
  const out = SIM.brain(st, 1, 'competitive', null, envLose(foeLose))
  return out.cmd && out.cmd.k
}
ok('M3', 'L2 重败·行为降档：被压时 comp 射门 → 降档 balanced 安全球出球', downgradeArm(0) === 'shot' && downgradeArm(4) === 'pass',
  `foeLose 0=${downgradeArm(0)} / 4=${downgradeArm(4)}`)

/* 生态位让位（O-1 决策面）：自由球、同队真人更近 → ctl 蜂拥追球、连败档收步到
 * 保护位（不与真人争球权）；持球让球权：真人队友豁空（未达直塞窗）→ 连败档即让 */
function yieldArm(foeLose) {
  const st = mkScene()
  put(st, 0, 175 * K, 300 * K); put(st, 2, 175 * K, 210 * K)     // bot0 与真人队友 2（距球 40000/20000）
  put(st, 1, 100 * K, 100 * K); put(st, 3, 250 * K, 100 * K)
  putBall(st, 175 * K, 250 * K, -1)
  st.tick = 300
  const env = envLose(foeLose, 'bot', 'bot', 'human', 'bot')     // 真人在席 2=bot0 队友
  const chase = SIM.brain(st, 0, 'balanced', null, env)
  const cosBall = head(chase, st.ball.x, st.ball.y, st, 0)
  const st2 = mkScene()
  put(st2, 0, 175 * K, 300 * K); put(st2, 2, 175 * K, 260 * K)   // 真人队友豁空略前（未达直塞窗 −50k）
  put(st2, 1, 100 * K, 420 * K); put(st2, 3, 250 * K, 420 * K)
  putBall(st2, 175 * K, 300 * K, 0)
  st2.tick = 300
  const give = SIM.brain(st2, 0, 'balanced', null, env)
  return { cosBall, giveCmd: give.cmd && give.cmd.k }
}
const y0 = yieldArm(0), y1 = yieldArm(2)
ok('M4', '生态位让位·自由球不与同队真人争抢：ctl 蜂拥追球 → 连败档收步保护位', y0.cosBall > 0.9 && y1.cosBall < 0.3,
  `指向球余弦 ctl=${y0.cosBall.toFixed(2)} / 连败=${y1.cosBall.toFixed(2)}`)
ok('M5', '生态位让位·让球权：真人队友豁空前插 → 连败档即让（ctl 自己带球推进）', y0.giveCmd !== 'pass' && y1.giveCmd === 'pass',
  `ctl=${y0.giveCmd || 'dribble'} / 连败=${y1.giveCmd}`)

/* 深化决策面（三档真分化）：balanced 直塞 / competitive 一脚出球+无球侧穿插+墙式前插 */
function throughBallArm(mateAhead) {
  const st = mkScene()
  put(st, 0, 175 * K, 300 * K); put(st, 2, 175 * K, mateAhead ? 150 * K : 420 * K)
  if (mateAhead) st.players[2].vy = -6000                      // 前插跑动（A 攻上门 y=0）
  put(st, 1, 60 * K, 430 * K); put(st, 3, 290 * K, 430 * K)
  putBall(st, 175 * K, 300 * K, 0)
  st.tick = 400
  const out = SIM.brain(st, 0, 'balanced', null, kinds4())
  return out.cmd && out.cmd.k
}
ok('T1', 'balanced 传球选择：队友前插更近门+豁空 → 直塞出球（对照队友拖后自带）',
  throughBallArm(true) === 'pass' && throughBallArm(false) !== 'pass',
  `前插=${throughBallArm(true)} / 拖后=${throughBallArm(false) || 'dribble'}`)

function oneTouchArm() {
  const st = mkScene()
  put(st, 1, 175 * K, 400 * K); put(st, 3, 175 * K, 470 * K)      // 队友 3 前插更近门（B 攻下门）且豁空
  put(st, 0, 60 * K, 60 * K); put(st, 2, 290 * K, 60 * K)
  putBall(st, 175 * K, 400 * K, 1)
  st.mem[1] = undefined // 首拍得球（justGot 窗）
  st.tick = 500
  const out = SIM.brain(st, 1, 'competitive', null, kinds4())
  return out.cmd && out.cmd.k
}
ok('T2', 'competitive 一脚出球：刚得球+队友前插豁空 → 同拍即传（触球推跳过）', oneTouchArm() === 'pass', `cmd=${oneTouchArm()}`)

function crossArm(ballLeft) {
  const st = mkScene()
  put(st, 3, ballLeft ? 80 * K : 270 * K, 300 * K)                // 队友（B 席 3）持球
  put(st, 0, 175 * K, 430 * K); put(st, 2, 60 * K, 430 * K)
  put(st, 1, 175 * K, 300 * K)
  putBall(st, ballLeft ? 80 * K : 270 * K, 300 * K, 3)
  st.mem[1] = { dt: 0, role: 1, hys: 0, pc: 0, gago: 0, lastOwn: 3 } // OFF 角色
  st.tick = 600
  const out = SIM.brain(st, 1, 'competitive', null, kinds4())
  return out.mx // 球在左（x<175k）→ 无球侧=右通道 → mx>0；球在右 → mx<0
}
ok('T3', 'competitive 无球侧穿插：穿插侧=球横向对侧（球左我右/球右我左）', crossArm(true) > 15 && crossArm(false) < -15,
  `球左 mx=${crossArm(true)} / 球右 mx=${crossArm(false)}`)

function gagoArm(active) {
  const st = mkScene()
  put(st, 3, 175 * K, 380 * K)                                    // 席 1 刚出球给 3（B 攻下门 y=500k）
  put(st, 0, 60 * K, 100 * K); put(st, 2, 290 * K, 100 * K)
  put(st, 1, 175 * K, 300 * K)
  putBall(st, 175 * K, 360 * K, 3)
  st.mem[1] = { dt: 0, role: 1, hys: 0, pc: 0, gago: active ? 14 : 0, lastOwn: 3 }
  st.tick = 700
  const out = SIM.brain(st, 1, 'competitive', null, kinds4())
  return { mx: out.mx, my: out.my }
}
const gOn = gagoArm(true), gOff = gagoArm(false)
ok('T4', 'competitive 墙式配合前插窗：出球后 14 拍直线插向球-门连线前方（对照=无球侧斜插远门柱）',
  gOn.my > 20 && Math.abs(gOn.mx) < 10 && gOff.mx < -20,
  `gago 开 mx/my=${gOn.mx}/${gOn.my}（直插） / 关 mx=${gOff.mx}（斜插）`)

console.log('== N4 QA1 O-3 补测：balanced 混跑对位（各 3 seed，steal/tackle 观测面非零）==')
function matchup(lvlA, lvlB, seeds) {
  return seeds.map((sd) => {
    const r = driveRoom(sd, [lvlA, lvlB, lvlA, lvlB], N1T)
    const tack = (team) => r.evLog.filter((e) => e.k === 'tackle' && e.by % 2 === team).length
    const steal = (team) => r.evLog.filter((e) => e.k === 'steal' && e.by % 2 === team).length
    return { seed: sd, score: `${r.st.score.A}:${r.st.score.B}`, balT: tack(0), balS: steal(0), oppT: tack(1), oppS: steal(1), endTick: r.endTick, reason: r.over && r.over.reason }
  })
}
const rowsBC = matchup('balanced', 'competitive', SEEDS)
console.log('  bal-vs-comp（A=balanced / B=competitive）')
rowsBC.forEach((r) => console.log(`    seed=${r.seed} 比分${r.score} bal tack/steal=${r.balT}/${r.balS} comp tack/steal=${r.oppT}/${r.oppS} end=${r.endTick}(${r.reason})`))
ok('O3a', 'O-3 补测·balanced vs competitive：balanced 侧 steal+tackle 非零（对位混跑观测面在位）',
  rowsBC.every((r) => r.balT + r.balS > 0), `3 局 bal 侧对抗数 ${rowsBC.map((r) => r.balT + r.balS).join('/')}`)
ok('O3b', 'O-3 补测·balanced vs competitive：competitive 侧 steal+tackle 非零',
  rowsBC.every((r) => r.oppT + r.oppS > 0), `3 局 comp 侧对抗数 ${rowsBC.map((r) => r.oppT + r.oppS).join('/')}`)
const rowsBCa = matchup('balanced', 'casual', SEEDS)
console.log('  bal-vs-casual（A=balanced / B=casual）')
rowsBCa.forEach((r) => console.log(`    seed=${r.seed} 比分${r.score} bal tack/steal=${r.balT}/${r.balS} cas tack/steal=${r.oppT}/${r.oppS} end=${r.endTick}(${r.reason})`))
ok('O3c', 'O-3 补测·balanced vs casual：双侧 steal+tackle 非零', rowsBCa.every((r) => r.balT + r.balS > 0 && r.oppT + r.oppS > 0),
  `bal ${rowsBCa.map((r) => r.balT + r.balS).join('/')} cas ${rowsBCa.map((r) => r.oppT + r.oppS).join('/')}`)

console.log('== N5 让位入口/旁观位语义复核（QA1 O-1，RoomManager 离线实例零端口）==')
{
  const rm = new RoomManager({ log: () => {} })
  rm.register(SIM)
  const mkCtx = () => ({ conn: { writable: true, send: () => {} }, room: null, seat: -1, role: null, isTest: false })
  const room = rm.create({ gameId: 'street-soccer', bots: [{ level: 'balanced' }, { level: 'balanced' }, { level: 'casual' }, { level: 'balanced' }], startDelayMs: 5000 })
  const h1 = mkCtx()
  const j1 = rm.join(h1, { roomId: room.id, mode: 'play', name: 'H1' })
  ok('Y1', '让位入口：真人加入 bot 房走 seat 最大 bot 席让位（协议 §2 真人优先）', j1.ok && j1.seat === 3 && j1.takeover && room.seats[3].kind === 'human',
    `takeover seat=${j1.seat}（kind=${room.seats[3].kind}，余 bot 席 [${room.seats.filter((s) => s.kind === 'bot').map((s) => s.seat).join(',')}])`)
  const sp = mkCtx()
  const js = rm.join(sp, { roomId: room.id, mode: 'spectate' })
  ok('Y2', '旁观位语义：显式 spectate 不占席不让位（有空位仍旁观——围观 bot 房入口）', js.ok && sp.role === 'spectator' && sp.seat === -1 && room.seats[2].kind === 'bot',
    `role=${sp.role} seat=${sp.seat}（席 2 仍 ${room.seats[2].kind}）`)
  for (const s of [2, 1, 0]) { if (room.seats[s].kind !== 'human') { const c = mkCtx(); rm.join(c, { roomId: room.id, mode: 'play', name: 'H' + s }) } }
  const fifth = mkCtx()
  const j5 = rm.join(fifth, { roomId: room.id, mode: 'play', name: 'H5' })
  ok('Y3', '满员 4 真人：第 5 人自动转旁观（seat=−1 同流观战，QA1 §5 真实路径离线复核）', j5.ok && j5.spectator && fifth.seat === -1 && fifth.role === 'spectator',
    `spectator=${!!j5.spectator} role=${fifth.role}（满员 ${room.seats.filter((s) => s.kind === 'human').length}/4 真人）`)
}

console.log('== N6 确定性/回放等价（混档局在线驱动 == replayInputs 重放，A8 离线同构）==')
{
  const lvls = ['balanced', 'competitive', 'balanced', 'competitive']
  const live = driveRoom(20261020, lvls, 1200)
  const st2 = S.replayInputs(20261020, { botLevels: lvls }, live.st.inLog, live.endTick)
  const onetwoComp = n1.competitive.reduce((a, r) => a + r.onetwo, 0)
  const onetwoBal = n1.balanced.reduce((a, r) => a + r.onetwo, 0)
  ok('R1', '回放等价：在线终态 stateHash == replayInputs 输入日志重放 hash（混档 bot 局）',
    SIM.hashState(live.st) === S.hashState(st2), `hash=${SIM.hashState(live.st)}`)
  ok('T5', '墙式配合观测面：comp 全同档 3 局二过一链（≤40 拍回传对）多于 bal 同档局', onetwoComp > onetwoBal && onetwoComp >= 3,
    `comp×3局 onetwo=${onetwoComp} vs bal=${onetwoBal}`)
}

console.log(`\n${pass} 通过 ${fail} 失败`)
process.exit(fail ? 1 : 0)
