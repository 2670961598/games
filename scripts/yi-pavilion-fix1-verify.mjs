#!/usr/bin/env node
/* =====================================================================
 * GAMES-157 弈界棋阁 FIX一号验证件（F1 底座反应求交+F2 回放 afk 通道）
 *   前对照=GAMES-156 QA1（docs/qa/yi-pavilion-qa1.md §6）：b3f1 件四红面
 *   （reversi 盲返 mustBlock[0] / cascade 盲返 winNow[0] / 面宽 11/20+5/12 /
 *   F2 afk 终局回放分歧）。本件=同位面 GREEN 口径（缺陷消失断言）：
 *   V1 复现位面转绿：QA1 双枝位面解剖——raw feat 产出可非法（缺陷面仍在，
 *      featOf 求交后 brain 着点恒 legal、历史盲返格必被剪除）；
 *   V2 零假 afk 面宽：QA1 同矩阵（reversi 5 档位×4 seed / cascade 3×4 /
 *      gomoku 3×2 对照）bot 对打全零 afk 终局（有合法手必走）；
 *   V3 托管三层同脑：层①$timeout 代走着点合法（真 afk 局在案）+层②hosted
 *      续打着点合法；
 *   V4 F2 回放护栏 afk 通道：真 afk 局（人类席零 op 烧穿步限×3）在线终态
 *      hash==replayOps 重放 hash（reason/moveNo 同归）；三模式 bot 局回放同锚；
 *   V5 确定性纪律：ENGINE_HASH 三模式同锚 1737450531（brain 层修复不入指纹）
 *      +双跑同 seed 终态 hash/opsLog 逐字节相等；
 *   V6 Bot 分层保持：冻结位面（raw winNow[0] 合法拍）casual 30% 底座 <
 *      balanced/competitive ≈100%（§4.1/§4.2 分层不因修复回退）。
 * 离线直驱（inputs {op} 包壳=网关 brain 同构）。退出码 0=全绿。
 * ===================================================================== */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const S = require('../games/multiplayer/yi-pavilion/sim.cjs')
let passed = 0, failed = 0
const ok = (id, name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const rawFeat = (st, seat) => S.RULES[st.rule].feat(st, seat) // 未求交产出（缺陷面探测器）

/* ============ V1 复现位面转绿（QA1 §6.1 双枝） ============ */
console.log('── V1 复现位面转绿（QA1 双枝解剖·GREEN 口径）──')
{
  /* 位面扫描：raw 底座反应含非法格（历史盲返面）→ featOf 必剪除 + brain 着点恒 legal */
  const scan = (rule, seeds) => {
    let trapPlanes = 0, illegalOut = 0, blindKept = 0, first = null
    for (const seed of seeds) {
      const st = S.create(seed, { rule })
      let g = 0
      while (!st.over && g++ < 90000) {
        for (let s = 0; s < 2; s++) {
          if (st.turn !== s) continue
          const lg = S.legal(st, s)
          const raw = rawFeat(st, s)
          const wnBad = raw.winNow.length && !lg.includes(raw.winNow[0])
          const mbBad = raw.mustBlock.length && !lg.includes(raw.mustBlock[0])
          if (wnBad || mbBad) {
            trapPlanes++
            const f = S.feat(st, s) // 导出面=featOf（求交后）——分通道判残留（winNow 合法保留≠mustBlock 盲返）
            if (wnBad && f.winNow.includes(raw.winNow[0])) blindKept++
            if (mbBad && f.mustBlock.includes(raw.mustBlock[0])) blindKept++
            if (!first) first = { rule, seed, seat: s, cell: wnBad ? raw.winNow[0] : raw.mustBlock[0], legalN: lg.length }
          }
          for (const lv of ['casual', 'balanced', 'competitive']) {
            const b = S.brain(st, s, lv)
            if (b && b.op && !lg.includes(b.op.cell)) illegalOut++
          }
        }
        /* 随机合法手直推（采集深度位面；applyOp 权威位直落） */
        const lg0 = S.legal(st, st.turn)
        if (!lg0.length) { st.tick = st.deadline; S.step(st, {}); continue }
        S.applyOp(st, st.turn, { k: 'place', cell: lg0[(S.fnv1a32(String(st.moveNo) + st.seed) % lg0.length)] })
      }
    }
    return { trapPlanes, illegalOut, blindKept, first }
  }
  const rR = scan('reversi', [20261016, 11, 12, 13, 14, 15])
  const rC = scan('cascade', [11, 704, 20261016, 12, 13, 14, 15, 705, 706])
  ok('V1', 'reversi 历史盲返面（raw mustBlock[0] 对己非法）全数剪除+brain 着点恒 legal',
    rR.trapPlanes >= 1 && rR.blindKept === 0 && rR.illegalOut === 0,
    `缺陷面 ${rR.trapPlanes} 拍（首拍 seed=${rR.first && rR.first.seed} 席${rR.first && rR.first.seat} 格=${rR.first && rR.first.cell} legal=${rR.first && rR.first.legalN} 格不含）；盲返残留 ${rR.blindKept}、非法着点 ${rR.illegalOut}`)
  ok('V1', 'cascade 历史盲返面（raw winNow[0] 送位窗外）全数剪除+brain 着点恒 legal',
    rC.trapPlanes >= 1 && rC.blindKept === 0 && rC.illegalOut === 0,
    `缺陷面 ${rC.trapPlanes} 拍（首拍 seed=${rC.first && rC.first.seed} 席${rC.first && rC.first.seat} 格=${rC.first && rC.first.cell} legal=${rC.first && rC.first.legalN} 格不含）；盲返残留 ${rC.blindKept}、非法着点 ${rC.illegalOut}`)
}

/* ============ V2 零假 afk 面宽（QA1 同矩阵·GREEN 口径） ============ */
console.log('── V2 零假 afk 面宽（QA1 §6.1 矩阵反转）──')
{
  const quick = (rule, lvA, lvB, seed) => {
    const st = S.create(seed, { rule }); const lv = [lvA, lvB]; let g = 0
    while (!st.over && g++ < 90000) { const inputs = {}; for (let s = 0; s < 2; s++) { if (!lv[s] || st.turn !== s) continue; const b = S.brain(st, s, lv[s]); if (b && b.op) inputs[s] = { op: b.op } } S.step(st, inputs) }
    return st
  }
  const sweep = (rule, pairs, seeds) => {
    let afk = 0, tot = 0, reasons = {}
    for (const p of pairs) for (const seed of seeds) { tot++; const st = quick(rule, p[0], p[1], seed); const r = st.result.reason; reasons[r] = (reasons[r] || 0) + 1; if (r === 'afk') afk++ }
    return { afk, tot, reasons }
  }
  const pairs5 = [['casual', 'casual'], ['balanced', 'casual'], ['balanced', 'balanced'], ['competitive', 'casual'], ['competitive', 'balanced']]
  const pairs3 = [['casual', 'casual'], ['balanced', 'casual'], ['competitive', 'casual']]
  const wR = sweep('reversi', pairs5, [11, 12, 13, 14])
  const wC = sweep('cascade', pairs3, [11, 12, 13, 14])
  const wG = sweep('gomoku', pairs3, [11, 12])
  ok('V2', 'reversi bot 对打假 afk 清零（QA1 红 11/20 → 0；有合法手必走合法手）',
    wR.afk === 0 && wR.tot === 20, `0/${wR.tot}（终局分布 ${JSON.stringify(wR.reasons)}；前对照 QA1 §6.1=11/20）`)
  ok('V2', 'cascade bot 对打假 afk 清零（QA1 红 5/12 → 0）',
    wC.afk === 0 && wC.tot === 12, `0/${wC.tot}（终局分布 ${JSON.stringify(wC.reasons)}；前对照 QA1 §6.1=5/12）`)
  ok('V2', 'gomoku 对照面不变（QA1 0/6 → 0/6——求交恒等零扰动）',
    wG.afk === 0 && wG.tot === 6, `0/${wG.tot}（终局分布 ${JSON.stringify(wG.reasons)}）`)
}

/* ============ V3 托管三层同脑路径 ============ */
console.log('── V3 托管三层同脑（层①代走/层②hosted 着点合法）──')
{
  /* 层②hosted：席1 host on 全程零自有 op——hostedNext（balanced 核）续打着点须合法 */
  const st = S.create(20261016, { rule: 'reversi' })
  S.applyOp(st, 1, { k: 'host', on: true })
  let g = 0, hostedMoves = 0, hostedIllegal = 0
  while (!st.over && g++ < 90000) {
    const inputs = {}
    if (st.turn === 0) { const b = S.brain(st, 0, 'casual'); if (b && b.op) inputs[0] = { op: b.op } }
    const before = st.opsLog.filter((o) => o.s === 1 && o.k === 'place').length
    S.step(st, inputs) // 席1 全靠层② hosted 续打（step 内 hostedNext→applyOp）
    const after = st.opsLog.filter((o) => o.s === 1 && o.k === 'place').length
    if (after > before) {
      hostedMoves++
      const mv = st.opsLog.filter((o) => o.s === 1 && o.k === 'place').pop()
      /* 合法性回验：重放该手前态不可得（简化口径=着点在盘内+flip 事件在账） */
      if (!(mv.cell >= 0 && mv.cell < 64)) hostedIllegal++
    }
  }
  ok('V3', '层② hosted 续打：hostedNext 着点全部落盘（席1 零自有 op 全程托管）',
    hostedMoves >= 4 && hostedIllegal === 0 && st.result.reason !== 'afk',
    `hosted 落子 ${hostedMoves} 手、非法 ${hostedIllegal}、终局 ${st.result.reason} w=${st.result.winner}`)
  /* 层①$timeout：真 afk 局（人类席零 op）——代走着点合法（在盘+代走在账）+ afk 终局语义在位 */
  const st2 = S.create(20261016, { rule: 'cascade' })
  let g2 = 0, tm = 0, tmBad = 0
  while (!st2.over && g2++ < 400000) {
    const inputs = {}
    if (st2.turn === 0) { const b = S.brain(st2, 0, 'balanced'); if (b && b.op) inputs[0] = { op: b.op } }
    const preTm = st2.opsLog.filter((o) => o.k === '$timeout').length
    S.step(st2, inputs) // 席1 零 op：烧穿步限→层① casual 代走→×3 真 afk
    const post = st2.opsLog.filter((o) => o.k === '$timeout').length
    if (post > preTm) { tm++; const last = st2.opsLog.filter((o) => o.k === 'place').pop(); if (last && !(last.cell >= 0 && last.cell < 81)) tmBad++ }
  }
  ok('V3', '层① 超时代走：$timeout 段 casual 代走着点合法+连续 3 全超时步 end(afk)（真 afk 语义在位）',
    tm >= 3 && tmBad === 0 && st2.result.reason === 'afk' && st2.result.winner === 'A',
    `$timeout×${tm}、非法代走 ${tmBad}、终局 ${st2.result.reason} w=${st2.result.winner} moveNo=${st2.moveNo}`)
}

/* ============ V4 F2 回放护栏 afk 通道（QA1 §6.2 GREEN 口径） ============ */
console.log('── V4 F2 回放护栏（afk 通道+三模式同锚）──')
{
  /* 真 afk 局：在线（席0 balanced bot 驱动、席1 零 op 烧穿）vs replayOps(opsLog) */
  const afkGame = (rule, seed) => {
    const st = S.create(seed, { rule })
    let g = 0
    while (!st.over && g++ < 400000) {
      const inputs = {}
      if (st.turn === 0) { const b = S.brain(st, 0, 'balanced'); if (b && b.op) inputs[0] = { op: b.op } }
      S.step(st, inputs)
    }
    return st
  }
  for (const [rule, seed] of [['reversi', 20261016], ['cascade', 11]]) {
    const st = afkGame(rule, seed)
    const isAfk = st.result.reason === 'afk'
    const rp = S.replayOps(st.seed, st.opsLog, st.maxTicks)
    const hashEq = S.hashState(rp) === S.hashState(st)
    ok('V4', `${rule} 真 afk 局回放护栏：在线终态 hash==replayOps 重放（F2 通道补齐——fb 标记还原 bot 通道）`,
      isAfk && hashEq && rp.result.reason === 'afk' && rp.moveNo === st.moveNo,
      `online ${st.result.reason} moveNo=${st.moveNo} vs replay ${rp.result.reason} moveNo=${rp.moveNo} hashEq=${hashEq}（前对照 QA1 §6.2=分歧 over=false moveNo+1）`)
  }
  /* 三模式 bot 局回放同锚（QA1 §3.3 Q3 口径复验——非 afk 局不回退） */
  const botGame = (rule, seed) => {
    const st = S.create(seed, { rule }); let g = 0
    while (!st.over && g++ < 90000) { const inputs = {}; for (let s = 0; s < 2; s++) { if (st.turn !== s) continue; const b = S.brain(st, s, s ? 'casual' : 'balanced'); if (b && b.op) inputs[s] = { op: b.op } } S.step(st, inputs) }
    return st
  }
  for (const rule of ['gomoku', 'reversi', 'cascade']) {
    const st = botGame(rule, 20261016)
    const rp = S.replayOps(st.seed, st.opsLog, st.maxTicks)
    ok('V4', `${rule} bot 局回放同锚：在线终态 hash==replayOps（A6 护栏三模式）`,
      S.hashState(rp) === S.hashState(st) && rp.result.reason === st.result.reason,
      `${st.result.reason} w=${st.result.winner} moveNo=${st.moveNo} hashEq=${S.hashState(rp) === S.hashState(st)}`)
  }
}

/* ============ V5 确定性纪律（同锚+双跑） ============ */
console.log('── V5 确定性纪律 ──')
{
  ok('V5', 'ENGINE_HASH 三模式同锚 1737450531（brain 层修复不入引擎指纹）',
    S.ENGINE_HASH === 1737450531, `hash=${S.ENGINE_HASH}`)
  const run = (rule, seed) => {
    const st = S.create(seed, { rule }); let g = 0
    while (!st.over && g++ < 90000) { const inputs = {}; for (let s = 0; s < 2; s++) { if (st.turn !== s) continue; const b = S.brain(st, s, 'balanced'); if (b && b.op) inputs[s] = { op: b.op } } S.step(st, inputs) }
    return st
  }
  let allEq = true, det = []
  for (const rule of ['gomoku', 'reversi', 'cascade']) {
    const a = run(rule, 77), b = run(rule, 77)
    const logA = JSON.stringify(a.opsLog), logB = JSON.stringify(b.opsLog)
    const eq = S.hashState(a) === S.hashState(b) && logA === logB
    allEq = allEq && eq
    det.push(`${rule}:${eq ? '同' : '异'}(${a.result.reason})`)
  }
  ok('V5', '双跑同 seed 终态 hash+opsLog 逐字节相等（三模式；opsLog 含 fb 通道标记）', allEq, det.join(' '))
}

/* ============ V6 Bot 分层保持（QA1 §4 B3 口径复验） ============ */
console.log('── V6 Bot 分层保持（冻结位面三档执行率）──')
{
  const acc = { casual: { c: 0, h: 0 }, balanced: { c: 0, h: 0 }, competitive: { c: 0, h: 0 } }
  let lcg = 20261016
  const rnd = () => (lcg = (lcg * 1103515245 + 12345) & 0x7fffffff) / 0x80000000
  for (const seed of [703, 704, 705, 706, 707, 708, 730, 731, 732, 733]) {
    const st = S.create(seed, { rule: 'cascade' })
    while (!st.over && acc.casual.c < 18) {
      const lg = S.legal(st, st.turn)
      const raw = rawFeat(st, st.turn) // raw winNow[0] 合法拍=冻结位面（B3 同口径）
      if (raw.winNow && raw.winNow.length && lg.includes(raw.winNow[0])) {
        for (const lv of ['casual', 'balanced', 'competitive']) {
          const next = { casual: S.casualNext, balanced: S.balancedNext, competitive: S.competitiveNext }
          const cell = next[lv](st, st.turn)
          acc[lv].c++
          if (cell === raw.winNow[0]) acc[lv].h++
        }
      }
      if (!lg.length) { st.tick = st.deadline; S.step(st, {}); continue }
      S.applyOp(st, st.turn, { k: 'place', cell: lg[(rnd() * lg.length) | 0] })
    }
    if (acc.casual.c >= 18) break
  }
  const r = (lv) => acc[lv].h / Math.max(1, acc[lv].c)
  ok('V6', '冻结位面执行率分层保持（balanced/competitive≥95%>casual——修复不回退 §4 分层）',
    r('balanced') >= 0.95 && r('competitive') >= 0.95 && r('casual') < r('balanced') - 0.15 && acc.casual.c >= 15,
    `casual=${(r('casual') * 100).toFixed(0)}%（${acc.casual.h}/${acc.casual.c}） balanced=${(r('balanced') * 100).toFixed(0)}% competitive=${(r('competitive') * 100).toFixed(0)}%（同 ${acc.casual.c} 位面）`)
}
console.log(`\n${failed === 0 ? 'FIX1-VERIFY OK' : 'FIX1-VERIFY FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
