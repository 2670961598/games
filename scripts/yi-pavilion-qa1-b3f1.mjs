#!/usr/bin/env node
/* =====================================================================
 * GAMES-156 弈界棋阁 QA1 补强件 v2（首跑复盘：B3 winNow 采样饿死+F1 cascade
 * 位面归因错枝——candidates 非 gomoku 恒 legal 干净，真凶=feat.winNow[0] 不查
 * 送位窗（cascadeWinCells 与 legal 不求交），三档底座反应全部盲返）
 *   B3v3 井字完美度·冻结位面执行率：扫描对局采集「winNow[0] 合法」决策位面，
 *      同一位面三档 brain 各问一次（位置集相同=公平对照）——casual 30% 底座反应
 *      vs balanced/competitive 恒执行（§4.1/§4.2 可观测分层）。
 *   F1 终版位面解剖：reversi（mustBlock[0] 对己非法，casual/balanced 双验）+
 *      cascade（winNow[0] 送位窗外，三档同盲）+ 面宽（cascade 5/12 复跑+gomoku 对照 0）。
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

/* ============ B3v3 冻结位面三档执行率 ============ */
console.log('── B3v3 井字完美度·冻结位面执行率 ──')
{
  const acc = { casual: { c: 0, h: 0 }, balanced: { c: 0, h: 0 }, competitive: { c: 0, h: 0 } }
  let lcg = 20261016
  const rnd = () => (lcg = (lcg * 1103515245 + 12345) & 0x7fffffff) / 0x80000000
  for (const seed of [703, 704, 705, 706, 707, 708, 730, 731, 732, 733]) {
    const st = S.create(seed, { rule: 'cascade' })
    while (!st.over && acc.casual.c < 18) {
      /* 当拍若 winNow[0] 合法 → 冻结位面：三档 brain 各问一次（brain 不改 st） */
      const lg = S.legal(st, st.turn)
      const f = S.feat(st, st.turn)
      if (f.winNow && f.winNow.length && lg.includes(f.winNow[0])) {
        /* 决策核直探（casualNext/balancedNext/competitiveNext 导出面=brain 去 gated 思考窗；
         * 窗是时序非棋力——直推位面 tick 不前进门恒闭，brain() 恒 {} 假红） */
        const next = { casual: S.casualNext, balanced: S.balancedNext, competitive: S.competitiveNext }
        for (const lv of ['casual', 'balanced', 'competitive']) {
          const cell = next[lv](st, st.turn)
          acc[lv].c++
          if (cell === f.winNow[0]) acc[lv].h++
        }
      }
      /* 随机合法手直推（不走 brain=绕开 F1 假 afk；applyOp 权威位直落） */
      S.applyOp(st, st.turn, { k: 'place', cell: lg[(rnd() * lg.length) | 0] })
    }
    if (acc.casual.c >= 18) break
  }
  const r = (lv) => acc[lv].h / Math.max(1, acc[lv].c)
  ok('B3', '井字·定盘着点执行率分层（冻结位面同位置集三档对照：winNow[0] 合法拍）balanced/competitive≥95%>casual（§4.1 恒执行底座反应 vs §4.2 casual 30%）',
    r('balanced') >= 0.95 && r('competitive') >= 0.95 && r('casual') < r('balanced') - 0.15 && acc.casual.c >= 15,
    `casual=${(r('casual') * 100).toFixed(0)}%（${acc.casual.h}/${acc.casual.c}） balanced=${(r('balanced') * 100).toFixed(0)}% competitive=${(r('competitive') * 100).toFixed(0)}%（同 ${acc.casual.c} 位面）`)
}

/* ============ F1 终版位面解剖 ============ */
console.log('── F1 终版位面解剖（双模式双枝）──')
{
  const dissect = (rule, seeds) => {
    for (const seed of seeds) {
      const st = S.create(seed, { rule })
      const lv = ['casual', 'casual']
      let g = 0
      while (!st.over && g++ < 90000) {
        const inputs = {}
        for (let s = 0; s < 2; s++) {
          if (!lv[s] || st.turn !== s) continue
          const b = S.brain(st, s, lv[s])
          if (b && b.op) {
            if (!S.legal(st, s).includes(b.op.cell)) {
              const f = S.feat(st, s)
              return { rule, seed, s, cell: b.op.cell, legalN: S.legal(st, s).length,
                mb: f.mustBlock && f.mustBlock[0] || null, wn: f.winNow && f.winNow[0] || null,
                blindMB: !!(f.mustBlock && f.mustBlock.length && b.op.cell === f.mustBlock[0]),
                blindWN: !!(f.winNow && f.winNow.length && b.op.cell === f.winNow[0]) }
            }
            inputs[s] = { op: b.op }
          }
        }
        S.step(st, inputs)
      }
    }
    return null
  }
  const dR = dissect('reversi', [20261016, 11, 12, 13, 14, 15])
  const dC = dissect('cascade', [11, 704, 20261016, 12, 13, 14, 15, 705, 706])
  /* reversi 双验：casual/balanced 在同位面都盲返 mustBlock[0] */
  const rBlind = dR && dR.blindMB
  ok('F1', 'reversi 位面：brain 着点 ∉ legal==mustBlock[0] 盲返（feat.mustBlock 可对己方非法；30% 分支/恒执行分支同盲）',
    !!dR && rBlind,
    dR ? `seed=${dR.seed} 席${dR.s}：着点=${dR.cell}==mustBlock[0]，legal=${dR.legalN} 格不含该点` : '未及位面')
  ok('F1', 'cascade 位面：brain 着点 ∉ legal==winNow[0] 盲返（cascadeWinCells 不查送位窗；三档底座反应同盲）',
    !!dC && dC.blindWN,
    dC ? `seed=${dC.seed} 席${dC.s}：着点=${dC.cell}==winNow[0]（mustBlock=${dC.mb}），legal=${dC.legalN} 格不含该点` : '未及位面')
  /* 面宽：cascade 假 afk 率（首跑 5/12 复跑核）+ gomoku 对照 0 */
  const quick = (rule, lvA, lvB, seed) => {
    const st = S.create(seed, { rule }); const lv = [lvA, lvB]; let g = 0
    while (!st.over && g++ < 90000) { const inputs = {}; for (let s = 0; s < 2; s++) { if (!lv[s] || st.turn !== s) continue; const b = S.brain(st, s, lv[s]); if (b && b.op) inputs[s] = { op: b.op } } S.step(st, inputs) }
    return st
  }
  let afkC = 0, totC = 0
  for (const pair of [['casual', 'casual'], ['balanced', 'casual'], ['competitive', 'casual']])
    for (const seed of [11, 12, 13, 14]) { totC++; if (quick('cascade', pair[0], pair[1], seed).result.reason === 'afk') afkC++ }
  let afkG = 0
  for (const pair of [['casual', 'casual'], ['balanced', 'casual'], ['competitive', 'casual']]) for (const seed of [11, 12]) { if (quick('gomoku', pair[0], pair[1], seed).result.reason === 'afk') afkG++ }
  ok('F1', '面宽：cascade bot 对打假 afk 率（12 局·三档；gomoku 对照 6 局恒 0——缺陷限多规则特征提取器）',
    afkC >= 2 && afkG === 0, `cascade ${afkC}/${totC} 假 afk vs gomoku ${afkG}/6`)
}
console.log(`\n${failed === 0 ? 'QA1-B3F1 OK' : 'QA1-B3F1 FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
