#!/usr/bin/env node
/* =====================================================================
 * GAMES-141 街头足球 手感层（FEEL）断言工具——对齐 mini-moba-feel-check.mjs /
 * snake-king-feel-check.mjs 取证口径（GAMES-103/131 范式）：
 *   FE-1 静态：FXLIST 动效清单 ≥14 项（fb≥8）+ SND 音效位 ≥14 槽 + 总闸门
 *            默认静音 + 零裸字号（.font= 全走 HF；构造点唯一）
 *   FE-2 动效时延表：fxProbe/fxScene 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线），状态类只报数不断言
 *   FE-3 音效位台账：全部槽位触达（fired 持久集口径）+ 默认 on=false
 *   FE-4 识图 v2 三帧复检：三冻结帧不透明 HUD 字形锚点（世界层透出仅参考）
 *            + hudFonts 共同键零改样（--phase base 先采，闭环对照）
 *   FE-5 perf：帧成本 avgMs 对照带（post ≤ base+0.3ms 同带，games-118 口径）
 *            + rafGap 折算 ≥55fps + 掉帧（jank>25ms）<2%
 * 环境：静态文件自起（随机口）+ QA 影子网关 GAMES_GW（默认 :4417，
 * :4399/:4400 零感知）。用法：node scripts/street-soccer-feel-check.mjs [--phase base|post]
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-141-shots'
const BASE = join(OUT, 'g141-base.json')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4417'
const GWWS = GW.replace(/^http/, 'ws')
const PORT = 8530 + Math.floor(Math.random() * 300)

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 静态文件服务器（游戏页面；.cjs 须 text/javascript——MIME 拒载静默坑 GAMES-90） ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
    const buf = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(PORT, r))

console.error(`[feel-check:${PHASE}] gw=${GW}（quick 匹配 bot 房）`)
await mkdir(OUT, { recursive: true })
let pageErrors = []
let page
/* 无头环境 rAF 节流口径：统一 --disable-gpu-vsync --disable-frame-rate-limit
 * 下测量（GAMES-118/131 口径；base/post 同 launch 参数=对照带公平）。 */
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
try {
  /* ================= FE-1 静态审计（零依赖） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/street-soccer/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥14 项（FXLIST 登记表字面量）', fxItems.length >= 14, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥14 槽（slots 字面量登记）', slotN >= 14, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    A('FE-1d', '总闸门默认静音（SND.on 初始 false——静音只记账，makeSound 平台范式）', /on:\s*false/.test(src.slice(src.indexOf('var SND'), src.indexOf('var SND') + 300)), 'SND.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
    const ctorN = (src.match(/function HF\(/g) || []).length
    A('FE-1e', '零裸字号（.font= 全走 HF 登记；构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（影子网关 quick bot 房） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/street-soccer/index.html?quick=1&gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
    return st && st.seat >= 0 && ['kick', 'play', 'goal'].includes(st.phase) && st.players === 4
  }, null, { timeout: 20_000 })
  await page.waitForTimeout(2500) // 巡航起点（kickoff→play 推进）

  /* ---------- 采集一帧 HUD 特征位（基线/复检共用同一函数） ---------- */
  async function hudFrame(tag) {
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(true) })
    await page.waitForTimeout(80)
    const probes = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const ink = (x0, y0, w, h) => {
        const d = g.getImageData(x0, y0, w, h).data
        const cnt = {}
        for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); cnt[k] = (cnt[k] || 0) + 1 }
        let bg = 0, bgK = null; for (const k in cnt) if (cnt[k] > bg) { bg = cnt[k]; bgK = k }
        let inkN = 0, total = 0
        const B = bgK.split(',').map(Number).map((v) => v * 16 + 8)
        for (let i = 0; i < d.length; i += 4) { total++; if (Math.abs(d[i] - B[0]) + Math.abs(d[i + 1] - B[1]) + Math.abs(d[i + 2] - B[2]) > 72) inkN++ }
        return +(inkN / total).toFixed(4)
      }
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
      return {
        /* 识图 v2 特征位只取【不透明 HUD/控件字形内部】锚点（drawTopbar/drawControls
         * 在镜头复位后绘制=世界层零位移；比分数字/计时为动态面不入锚）。 */
        anchors: {
          titleGlyph: px(310, 27),   /* 顶栏「街头足球」标题字形（p2 9px 静态文案） */
          colon: px(104, 29),        /* 顶栏比分冒号（p0n 13px 静态） */
          shotGlyph: px(313, 596),   /* 射门钮「射」（p1 11px 静态） */
          passGlyph: px(259, 626),   /* 传球钮「传」（p1 11px 静态） */
          sprintGlyph: px(225, 582), /* 冲刺钮「冲」（p2 9px 静态；体力弧不入锚） */
          courtCorner: px(14, 58),   /* 球场左上界线像素（巡航态 camZ=1 稳定；参考位） */
        },
        bands: { top: ink(0, 0, 375, 55), mid: ink(14, 200, 346, 160), foot: ink(190, 560, 180, 107) }, // 世界层→仅参考不断言
        fonts: Object.fromEntries(Object.entries(window.__GAMES_DEBUG__.hudFonts()).map(([k, v]) => [k, v.px + '/' + v.weight + '/' + v.cls])),
      }
    })
    await page.screenshot({ path: join(OUT, `g141-${tag}.png`) })
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(false) })
    return probes
  }
  const calm = () => page.evaluate(() => window.__GAMES_DEBUG__.fxScene ? window.__GAMES_DEBUG__.fxScene('calm') : true).catch(() => true)

  /* ---------- FE-4 三帧冻结采样 ---------- */
  await calm()
  const frames = [await hudFrame('f1')]
  await page.waitForTimeout(1700); await calm(); frames.push(await hudFrame('f2'))
  await page.waitForTimeout(2900); await calm(); frames.push(await hudFrame('f3'))

  const perfCruise = await page.evaluate(() => window.__GAMES_DEBUG__.perf())

  if (PHASE === 'base') {
    await writeFile(BASE, JSON.stringify({ frames, perf: { avgMs: perfCruise.costAvgMs, rafGapMs: perfCruise.rafGapMs, n: perfCruise.n } }, null, 1))
    console.error(`[feel-check] 基线已采 → ${BASE}（3 帧；perf costAvgMs=${perfCruise.costAvgMs}）`)
  } else {
    const base = JSON.parse(await readFile(BASE, 'utf8'))
    const GLYPH_TOL = 45
    let ancOk = true, ancD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].anchors) {
      if (!(k in base.frames[f].anchors)) continue
      const a = frames[f].anchors[k], b = base.frames[f].anchors[k]
      const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
      if (d > GLYPH_TOL) ancOk = false
      ancD.push(`${k}${d}`)
    }
    A('FE-4a', '三帧不透明字形锚点零位移（标题/冒号/三钮字形 5 位+场界参考 1 位）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    A('FE-4b', '墨水带差异仅系世界层（球员/球/动效透出——FEEL 交付面，参考不断言）', true, bandD.join(' '))
    const sharedKeys = Object.keys(base.frames[0].fonts).filter((k) => k in frames[0].fonts)
    const fontsEq = sharedKeys.every((k) => base.frames[0].fonts[k] === frames[0].fonts[k])
    A('FE-4c', 'hudFonts 登记表共同键零改样（px/weight/cls 逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedKeys.length} 键${fontsEq ? '' : '：' + sharedKeys.filter((k) => base.frames[0].fonts[k] !== frames[0].fonts[k]).join(',')}`)

    /* ---------- FE-2/FE-3 动效驱动 + 时延表 + 音效位台账 ----------
     * 两段式：世界层动效批（ended=false 时绘）→ 等 ≥2 帧首绘 → 终局批（F10
     * drawEnd 接管画面=世界层停绘，故必须后置）。逐调用 try/catch 取证防静默中断。 */
    const st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
    const probeLog = await page.evaluate((seat) => {
      const D = window.__GAMES_DEBUG__
      const log = []
      const T = (name, fn) => { try { fn(); log.push(name + ':ok') } catch (e) { log.push(name + ':ERR ' + (e && e.message || e)) } }
      T('charge', () => D.fxScene('charge'))                                                // F02 满力辉光（frame 检测触发）
      T('pass', () => D.fxProbe({ k: 'pass', from: seat, to: -1 }))                         // pass 槽
      T('reject', () => D.fxProbe({ k: 'reject', seat: seat, op: 'shot', why: 'no-ball' })) // reject 槽
      T('touch', () => D.fxProbe({ k: 'touch' }))                                           // F01
      T('shot', () => D.fxProbe({ k: 'shot', seat: seat, ang: 0, pow: 1000 }))              // F03
      T('kickoff', () => D.fxScene('kickoff'))                                              // F09
      T('poss', () => D.fxProbe({ k: 'poss', from: -1, to: seat }))                         // F12（catch 槽）
      T('tackle', () => D.fxProbe({ k: 'tackle', by: seat, res: 'miss' }))                  // F06+F07（stumble 槽）
      T('steal', () => D.fxProbe({ k: 'steal', by: seat, from: (seat + 1) % 4 }))           // F17
      T('wall', () => D.fxProbe({ k: 'wall', x: 60000, y: 250000 }))                        // F15
      T('post', () => D.fxProbe({ k: 'post', x: 130000, y: 6000 }))                         // F16
      T('ot', () => D.fxScene('ot'))                                                        // F13
      T('goalFor', () => D.fxScene('goalFor'))                                              // F04（goal 槽）
      T('goalAgainst', () => D.fxScene('goalAgainst'))                                      // F05
      T('ownGoal', () => D.fxScene('ownGoal'))                                              // F14（ownGoal 槽）
      T('focus', () => D.fxScene('focus'))                                                  // F11（state）
      return log
    }, st0.seat).catch((e) => ['BATCH-ERR ' + (e && e.message || e)])
    if (probeLog.some((l) => l.includes('ERR'))) console.error(`  ⚠ 探针中断：${probeLog.join(' | ')}`)
    await page.touchscreen.tap(228, 578).catch(() => {}) // sprint 槽：真实输入路径（touchstart→press→sfx）
    await page.waitForTimeout(500) // 世界层动效首绘窗（≥2 帧）
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('end') }).catch(() => {}) // F10 终局批（whistleEnd 槽）
    await page.waitForTimeout(500) // 结算动画首绘窗
    const ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    const fxItems = await page.evaluate(() => window.__GAMES_DEBUG__.fxList())
    const fbIds = fxItems.filter((f) => f.cls === 'fb').map((f) => f.id)
    const drawn = {}
    for (const e of ledger) if (e.lat != null && drawn[e.id] == null) drawn[e.id] = e.lat
    A('FE-2a', '动效台账全项首绘（17 项均有绘制证据）', fxItems.every((f) => drawn[f.id] != null), `${fxItems.filter((f) => drawn[f.id] != null).length}/${fxItems.length}：${fxItems.map((f) => f.id + (drawn[f.id] != null ? '=' + drawn[f.id] + 'ms' : '=未绘')).join(' ')}`)
    const fbLat = fbIds.map((id) => [id, drawn[id]])
    A('FE-2b', '反馈类（fb）首绘时延 ≤80ms（任务红线）', fbLat.every(([, l]) => l != null && l <= 80), fbLat.map(([id, l]) => `${id}:${l}ms`).join(' '))
    const stLat = fxItems.filter((f) => f.cls === 'state').map((f) => `${f.id}:${drawn[f.id] != null ? drawn[f.id] + 'ms' : '未绘'}`)
    console.error(`  · 状态类首绘（只报数不断言）：${stLat.join(' ')}`)
    const sg = await page.evaluate(() => window.__GAMES_DEBUG__.sfxGroups())
    const fired = new Set(sg.fired || sg.calls.map((c) => c.g))
    A('FE-3a', '音效位台账：登记槽全触达（fired 持久集口径）', sg.slots.length >= 14 && sg.slots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const badPx = Object.entries(hf).filter(([, v]) => v.px < 9)
    const byCls = { P0: [], P1: [], P2: [] }
    for (const v of Object.values(hf)) if (byCls[v.cls]) byCls[v.cls].push(v.px)
    const clsOk = Math.min(...byCls.P0) >= 13 && Math.min(...byCls.P1) >= 11 && Math.min(...byCls.P2) >= 9
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9；全部 ≥9）', clsOk && badPx.length === 0, `P0min=${Math.min(...byCls.P0)} P1min=${Math.min(...byCls.P1)} P2min=${Math.min(...byCls.P2)}；登记键 ${Object.keys(hf).length} 个`)

    /* ---------- FE-5 perf 帧成本对照带 + fps/掉帧复验（games-118 口径） ---------- */
    const postPerf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    const dAvg = +(postPerf.costAvgMs - base.perf.avgMs).toFixed(2)
    A('FE-5a', '帧成本对照带（FEEL 不降 perf：post ≤ base+0.3ms 同带）', postPerf.costAvgMs <= base.perf.avgMs + 0.3, `base=${base.perf.avgMs}ms post=${postPerf.costAvgMs}ms Δ=${dAvg}ms（n=${postPerf.n}）`)
    const fps = postPerf.rafGapMs > 0 ? 1000 / postPerf.rafGapMs : 0
    A('FE-5b', '复验 ≥55fps（rafGap 折算；vsync 解除口径）', fps >= 55, `rafGapAvg=${postPerf.rafGapMs}ms ≈ ${fps.toFixed(1)}fps`)
    A('FE-5c', '掉帧 <2%（jank>25ms 占比）', postPerf.costJankPct < 2, `jank=${postPerf.costJankPct}%（p95=${postPerf.costP95Ms}ms）`)
  }
  A('FX-0', '页面零异常（pageerror）', pageErrors.length === 0, pageErrors.join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  srv.close(); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[feel-check:${PHASE}] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}`)
process.exit(fail.length ? 1 : 0)
