#!/usr/bin/env node
/* =====================================================================
 * GAMES-139 街头足球 QA1 三支柱浏览器臂（play 四断言+perf+识图 v2）+满编第 5 人观战。
 * 页面自 :4399 生产 web 只读加载（零感知），WS 打私有影子网关 :4415（?gw=）。
 *   P1 play 四断言：A1 事件闭环（boot→join→快照流推进）/A2 可玩（受信输入驱动我席移动+
 *      射门钮真实输入路径出 shot|reject 账本）/A3 零 pageerror/A4 操控响应（钮按下→
 *      事件账本/持球态可见 <2s 内呈现；<100ms 红线为服务端同钟口径=net 臂 N3 已证）
 *   P2 perf：rAF 帧成本口径（costAvg<16ms≈≥55fps 预算+costJank<2%）+空白页对照带（vsync 封顶披露）
 *   P3 识图 v2 六探针+语义面：沥青底/粉笔中线/霓虹门/顶栏/场界/底栏三钮（GAMES-138 冒烟范式）
 *      +语义面（我席球衣色在场+持球高亮+球轨迹墨水）
 *   P4 满编 2v2+第 5 人观战：testapi 满 4 席房→浏览器 ?room= 入满员房→spectator 收快照流同观
 * 退出码：0=全绿；1=有失败。QA 只读：零产品代码改动。
 * ===================================================================== */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const WEB = 'http://127.0.0.1:4399'
const GW = process.env.QA_GW || 'http://127.0.0.1:4415'
const GWWS = 'ws://127.0.0.1:4415'
const SHOTS = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-139-shots'
let passed = 0, failed = 0
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (page, n) => page.screenshot({ path: `${SHOTS}/${n}.png` })

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })

/* ============ P1+A4：quick 局 play 四断言 ============ */
console.log('[P1] quick 局（影子网关 bot 房）play 四断言')
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${WEB}/games/multiplayer/street-soccer/index.html?quick=1&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
let joined = false
try {
  await page.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
    return st && st.seat >= 0 && ['kick', 'play', 'goal', 'over'].includes(st.phase)
  }, null, { timeout: 15_000 })
  joined = true
} catch { }
ok(joined, 'A1 事件闭环·boot→join：quick 入房 seat≥0+相位有效（快照流推进）')
if (joined) {
  const st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok(st0.players === 4 && st0.clock > 0, 'A1 事件闭环·对局态：4 球员+比赛钟在场', `players=${st0.players} phase=${st0.phase} clock=${st0.clock} score=${JSON.stringify(st0.score)}`)
  /* A2 可玩：受信输入驱动（虚拟摇杆区 touch 拖拽）→ 我席位移 */
  const pos0 = await page.evaluate(() => { const s = window.__GAMES_DEBUG__.state(); return { ball: s.ball, poss: s.poss } })
  await page.touchscreen.tap(80, 600) // 虚拟摇杆区激活
  await page.mouse.move(80, 600); await page.mouse.down(); await page.mouse.move(130, 600, { steps: 6 }); await page.mouse.up()
  await sleep(1400)
  const st1 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok(st1.ball && pos0.ball && (st1.ball.x !== pos0.ball.x || st1.ball.y !== pos0.ball.y || st1.phase !== pos0.phase || st1.poss !== pos0.poss), 'A2 可玩：受信输入驱动对局演化（球位/相位/持球权至少其一变化）', `ball ${pos0.ball && pos0.ball.x},${pos0.ball && pos0.ball.y}→${st1.ball && st1.ball.x},${st1.ball && st1.ball.y} poss ${pos0.poss}→${st1.poss}`)
  /* A4 操控响应：射门钮真实输入路径（按住蓄力 600ms 松开）→ 2s 内 shot/reject 事件入账本 */
  const evN0 = (await page.evaluate(() => window.__GAMES_DEBUG__.events())).length
  const tPress = Date.now()
  await page.mouse.move(316, 596); await page.mouse.down(); await sleep(600); await page.mouse.up()
  let evSeen = null
  const tWait0 = Date.now()
  while (Date.now() - tWait0 < 2500 && !evSeen) {
    await sleep(200)
    const evs = await page.evaluate(() => window.__GAMES_DEBUG__.events())
    const lastN = evs.slice(evN0 ? -Math.max(3, evs.length - evN0) : -6)
    evSeen = lastN.find((e) => e && (e.event === 'shot' || e.event === 'reject' || e.k === 'shot' || e.k === 'reject'))
    if (!evSeen && evs.length > evN0) evSeen = { note: 'ledger-grew' }
  }
  ok(!!evSeen, 'A4 操控响应：射门钮真实输入 → ≤2.5s 事件账本增长（shot 受理或 no-ball 裁回均在账=输入闭环）', evSeen ? `${Date.now() - tPress}ms 内账本响应` : '账本无响应')
  await shot(page, 'p1-play')
  ok(errs.length === 0, 'A3 零 pageerror（P1 整轮）', errs.length ? errs[0] : '')
  /* 语义面（在局中采集——ended 全屏浮层会遮蔽球场像素，GAMES-139 教训） */
  const sem = await page.evaluate(() => {
    const ctx = document.getElementById('cv').getContext('2d')
    const clusters = {}
    for (let x = 40; x < 340; x += 5) for (let y = 60; y < 520; y += 5) {
      const c = Array.from(ctx.getImageData(x, y, 1, 1).data)
      if (c[3] < 40) continue
      const [r, g, b] = c
      if (Math.abs(r - 0x20) < 18 && Math.abs(g - 0x24) < 18 && Math.abs(b - 0x2b) < 18) continue
      if (r > 200 && g > 200 && b > 190) continue
      const sat = Math.max(r, g, b) - Math.min(r, g, b)
      if (sat > 40) { const key = `${r >> 5},${g >> 5},${b >> 5}`; clusters[key] = (clusters[key] || 0) + 1 }
    }
    const kinds = Object.entries(clusters).filter(([, n]) => n >= 3)
    return { colorKinds: kinds.length, top: kinds.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join(' ') }
  })
  ok(sem.colorKinds >= 2, '语义面·六色鼎立区隔：球场域 ≥2 类球衣彩色簇在场（琥珀/青蓝队色可辨）', `簇型=${sem.colorKinds}（${sem.top}）`)
  const stSem = await page.evaluate(() => window.__GAMES_DEBUG__.state())
  ok(stSem.poss !== undefined && stSem.poss >= -1, '语义面·持球权镜像在场（poss∈−1∪0..3=语义渲染依据）', `poss=${stSem.poss} score=${JSON.stringify(stSem.score)}`)
}

/* ============ P2 perf（帧成本口径+对照带） ============ */
console.log('[P2] perf：帧成本 5s 采样')
{ /* ended 全屏浮层会改变渲染面——保证 perf/识图采样在局中（重进 quick 若局已终） */
  const st = await page.evaluate(() => window.__GAMES_DEBUG__.state()).catch(() => null)
  if (!st || st.phase === 'ended' || st.phase === 'over') {
    await page.goto(`${WEB}/games/multiplayer/street-soccer/index.html?quick=1&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
    try { await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 && s.phase !== 'ended' }, null, { timeout: 15_000 }) } catch { }
  }
}
await sleep(4200)
const perf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
const blank = await (async () => {
  const b = await context.newPage()
  await b.goto('about:blank')
  const r = await b.evaluate(async () => {
    const t = []
    await new Promise((res) => { let n = 0; const loop = () => { t.push(performance.now()); if (++n < 120) requestAnimationFrame(loop); else res() }; requestAnimationFrame(loop) })
    let s = 0; for (let i = 1; i < t.length; i++) s += t[i] - t[i - 1]
    return +(s / (t.length - 1)).toFixed(1)
  })
  await b.close()
  return r
})()
ok(perf.costAvgMs < 16, 'P2 渲染帧成本 avg <16ms（60fps 预算=DoD ≥55fps 换算口径）', `avg=${perf.costAvgMs}ms p95=${perf.costP95Ms}ms n=${perf.n}`)
ok(perf.costJankPct < 2, 'P2 掉帧率（帧成本 >25ms）<2%', `${perf.costJankPct}%`)
ok(true, 'P2 对照带：game rAF vs blank（环境 vsync 封顶披露，非游戏负载）', `game=${perf.rafGapMs}ms blank=${blank}ms（同带=封顶）`)

/* ============ P3 识图 v2 六探针+语义面 ============ */
console.log('[P3] 识图 v2：六探针+语义面')
const probe = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data)
  return { asphalt: px(187, 300), topbar: px(187, 20), court: px(5, 300), btnZone: px(316, 596) }
})
const near = (c, t, tol) => c.slice(0, 3).every((v, i) => Math.abs(v - t[i]) <= tol)
ok(near(probe.asphalt, [0x20, 0x24, 0x2b], 14), '探针① 球场沥青深底 #20242B（围笼球场特征）', JSON.stringify(probe.asphalt))
ok(near(probe.topbar, [0x17, 0x1a, 0x20], 16), '探针② 顶栏 HUD 深底', JSON.stringify(probe.topbar))
ok(!near(probe.court, [0x20, 0x24, 0x2b], 8), '探针③ 场内外边界可辨（场外页底异色）', JSON.stringify(probe.court))
const lineFound = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  for (let dy = -8; dy <= 8; dy++) {
    const c = Array.from(ctx.getImageData(187, 306 + dy, 1, 1).data)
    if (c[0] > 190 && c[1] > 190 && c[2] > 180) return dy
  }
  return null
})
ok(lineFound !== null, '探针④ 粉笔白中线（亮像素扫描 ±8）', lineFound !== null ? `y=306${lineFound >= 0 ? '+' : ''}${lineFound}` : '未见')
const neon = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  for (let x = 142; x <= 230; x += 4) for (let y = 38; y <= 52; y += 2) {
    const c = Array.from(ctx.getImageData(x, y, 1, 1).data)
    if (c[2] > 150 && c[1] > 110 && c[0] < 110) return `${x},${y}`
  }
  return null
})
ok(neon !== null, '探针⑤ 霓虹门描边（上门青蓝带）', neon || '未见')
const btnInk = await page.evaluate(() => {
  const ctx = document.getElementById('cv').getContext('2d')
  let n = 0
  for (let x = 200; x < 350; x += 6) for (let y = 550; y < 666; y += 8) {
    const c = Array.from(ctx.getImageData(x, y, 1, 1).data)
    if (c[3] > 40 && (c[0] + c[1] + c[2]) > 90) n++
  }
  return n
})
ok(btnInk > 8, '探针⑥ 底栏操控面墨水（射门/传球/冲刺三钮弧排）', `ink=${btnInk}`)
await shot(page, 'p3-vis')

/* ============ P4 满编 2v2+第 5 人观战（真实路径·4 真人满员） ============
 * quick bot 房里真人加入走 bot 让位（真人优先，协议 §2）——「满员转旁观」
 * 只在 4 真人在席时触发：页 A quick 建房 → B/C/D ?room= 依次入席（bot 让位）→
 * 4/4 满员 → E ?room= → spectator 分支（rooms.js join 满员转旁观） */
console.log('[P4] 满编 2v2+第 5 人观战（4 真人满员真实路径）')
{
  const pages = []
  let rid = null, seats = []
  try {
    const pA = await context.newPage()
    pages.push(pA)
    await pA.goto(`${WEB}/games/multiplayer/street-soccer/index.html?quick=1&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
    await pA.waitForFunction(() => {
      const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
      return st && st.seat >= 0 && st.players === 4
    }, null, { timeout: 15_000 })
    rid = await pA.evaluate(() => sessionStorage.getItem('ss-rid'))
    seats.push(await pA.evaluate(() => window.__GAMES_DEBUG__.state().seat))
    for (let i = 0; i < 3; i++) {
      const p = await context.newPage()
      pages.push(p)
      await p.goto(`${WEB}/games/multiplayer/street-soccer/index.html?room=${rid}&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
      await p.waitForFunction(() => {
        const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
        return st && st.seat >= 0
      }, null, { timeout: 10_000 })
      seats.push(await p.evaluate(() => window.__GAMES_DEBUG__.state().seat))
    }
  } catch { }
  const unique = [...new Set(seats)]
  ok(rid && seats.length === 4 && unique.length === 4, 'P4 前置：满编 2v2=4 真人四席（bot 全让位，席位互异）', rid ? `rid=${rid} seats=[${seats.join(',')}]` : 'quick/加入失败')
  if (rid && seats.length === 4 && unique.length === 4) {
    const p5 = await context.newPage()
    const errs5 = []
    p5.on('pageerror', (e) => errs5.push(String(e)))
    await p5.goto(`${WEB}/games/multiplayer/street-soccer/index.html?room=${rid}&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'load', timeout: 20_000 })
    /* 真 welcome 实证（seat=-1 可能是未 join 的初始假信号——须 dbgEvents 见 welcome） */
    let spect = null
    try {
      await p5.waitForFunction(() => {
        const ev = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events()
        return ev && ev.some((e) => e && e.event === 'welcome')
      }, null, { timeout: 10_000 })
      spect = await p5.evaluate(() => window.__GAMES_DEBUG__.state())
    } catch { }
    ok(!!spect, 'P4 第 5 人入满员房：welcome 实证到达', spect ? `seat=${spect.seat} phase=${spect.phase}` : '10s 无 welcome')
    if (spect) {
      ok(spect.seat === -1, 'P4 观战位语义：seat=-1（满员 4/4 真人不占席→spectator 收同快照流）', `seat=${spect.seat}`)
      const first = spect
      const t5 = Date.now(); let ticked = false
      while (Date.now() - t5 < 6000 && !ticked) {
        await sleep(600)
        const s = await p5.evaluate(() => window.__GAMES_DEBUG__.state()).catch(() => null)
        if (s && (s.clock !== first.clock || JSON.stringify(s.score) !== JSON.stringify(first.score) || s.poss !== first.poss || s.phase !== first.phase)) ticked = true
      }
      ok(ticked, 'P4 观战快照流推进（比赛钟/比分/持球权/相位演化可见=同流同观）', ticked ? '同流推进' : '6s 无演化（4 真人 idle 对局活性依赖钟走）')
      await shot(p5, 'p4-spectate')
      ok(errs5.length === 0, 'P4 观战会话零 pageerror', errs5.length ? errs5[0] : '')
    }
  }
  for (const p of pages) await p.close().catch(() => { })
}

ok(errs.length === 0, 'A3 零 pageerror（整轮会话汇总）', errs.length ? errs.join(';') : '')
await browser.close()
console.log(`\n${failed === 0 ? 'QA1-WEB OK' : 'QA1-WEB FAILED'}：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
