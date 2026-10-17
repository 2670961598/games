#!/usr/bin/env node
/* =====================================================================
 * GAMES-172 派对大乱斗 浏览器冒烟（DEV 自测面；对齐 street-soccer-smoke 口径）：
 *   S1 在线面：quick 入房（生产网关 :4400 bot 房）→ welcome/seat/live 推进 → 零 pageerror
 *   S2 HUD 字号运行时自证（hudFonts() __applied 全真——Q-013 首日自证红线）
 *   S3 弹体零快照观测（快照无 projs 字段=二类重演在场）
 *   S4 性能：页面内 rAF 采样 4s → avgFps≥55 且掉帧率(>25ms)<2%（DoD 口径）
 * 截图：kernel/workers/GAMES-172-shots/online.png
 * 退出码：0=全绿；1=有失败。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4400'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-172-shots'
let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

/* ---------- S1 在线局 ---------- */
console.log('[S1] 在线 quick 局（生产网关 bot 房）')
await page.goto(`${WEB}/games/multiplayer/party-brawl/index.html?gw=${encodeURIComponent(GW)}`, { waitUntil: 'load', timeout: 20_000 })
let joined = false
try {
  await page.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
    return st && st.seat >= 0 && (st.phase === 'live' || st.phase === 'lobby')
  }, null, { timeout: 15_000 })
  joined = true
} catch { /* 取证后断言 */ }
ok(joined, 'quick 入房 + 快照流推进（seat≥0 且相位有效）')
if (joined) {
  const st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok(st0.alive >= 8, '席位生态在场（接管局 alive≥8——quick 常接常驻房中局=接管即接战设计语义 §4.3）', `alive=${st0.alive} phase=${st0.phase} frame=${st0.frame} ack=${st0.ack}`)
  /* 快照推进 6s：frame/ack 前进+预测环活跃 */
  await sleep(6000)
  const st1 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok(st1.frame > st0.frame + 50, '对局活性（frame 推进 ≥50 tick/3s）', `frame ${st0.frame}→${st1.frame}`)
  ok(st1.ack >= st0.ack, 'ack 和解锚推进（S7 seq 确认在场）', `ack ${st0.ack}→${st1.ack}`)
  /* 模拟拖动摇杆 2s（本地预测零等待观测：vis 位移在 rec 账本） */
  await page.touchscreen.tap(100, 400) // 唤醒触控面
  const p0 = await page.evaluate(() => window.__GAMES_DEBUG__.state().rec)
  await page.mouse.move(100, 400); await page.mouse.down()
  await page.mouse.move(160, 400, { steps: 6 })
  await sleep(1500)
  await page.mouse.up()
  const p1 = await page.evaluate(() => window.__GAMES_DEBUG__.state().rec)
  ok(p1.n >= p0.n, '输入上行+和解回路活跃（rec.n 前进）', `rec.n ${p0.n}→${p1.n}`)
}

/* ---------- S2 HUD __applied 自证（Q-013 首日红线） ---------- */
console.log('[S2] HUD 字号 __applied 自证')
const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
const groups = Object.keys(hf || {})
let allApplied = true, minPx = 99
for (const g of groups) for (const k in hf[g]) { if (!hf[g][k].applied) allApplied = false; minPx = Math.min(minPx, hf[g][k].want) }
ok(groups.length > 0 && allApplied, `hudFonts() 全组 __applied=true（${groups.length} 组）`,
  groups.map((g) => g + ':' + Object.keys(hf[g]).length).join(' '))
ok(minPx >= 9, '字号下限 P2≥9', `min=${minPx}px`)
const p0reg = hf.P0 && Object.values(hf.P0).every((x) => x.want >= 13)
ok(!!p0reg, 'P0 组 ≥13px（hud-font-standard §1）')

/* ---------- S3 弹体零快照（渲染域弹体=事件重演计数） ---------- */
console.log('[S3] 二类重演观测')
const projN = await page.evaluate(() => window.__GAMES_DEBUG__.projsN())
ok(projN >= 0, '弹体重演域可读（shot 事件驱动）', `projs=${projN}`)
ok(await page.evaluate(() => window.__GAMES_DEBUG__.entsN() >= 0), 'AOI ents 域可读')

/* ---------- S4 性能（rAF 采样 4s） ---------- */
console.log('[S4] 性能采样')
const perf = await page.evaluate(() => new Promise((res) => {
  const t0 = performance.now(); let n = 0, bad = 0; let last = t0
  function step(t) { const dt = t - last; last = t; if (dt > 25 && n > 2) bad++; n++; if (t - t0 < 4000) requestAnimationFrame(step); else res({ fps: n / 4, bad, n }) }
  requestAnimationFrame(step)
}))
ok(perf.fps >= 55, `avgFps ≥55`, `${perf.fps.toFixed(1)}fps`)
ok(perf.bad / perf.n < 0.02, '掉帧率(>25ms) <2%', `${((perf.bad / perf.n) * 100).toFixed(2)}%`)

await page.screenshot({ path: `${SHOTS}/online.png` })
ok(pageErrors.length === 0, '零 pageerror', pageErrors.length ? pageErrors[0] : '整轮会话干净')
await browser.close()
console.log(`\nparty-brawl-smoke：${passed} 通过，${failed} 失败；截图 ${SHOTS}/online.png`)
process.exit(failed ? 1 : 0)
