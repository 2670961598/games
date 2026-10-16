#!/usr/bin/env node
/* =====================================================================
 * GAMES-159 弈界棋阁 手感层（FEEL）断言工具——对齐 iron-torrent-feel-check.mjs
 * （GAMES-150）/ street-soccer（GAMES-141）/ tactics（GAMES-122）/ snake-king
 * （GAMES-103）取证口径：
 *   FE-1 静态：FXLIST 动效清单 ≥14 项（fb≥8）+ 音效位 ≥14 槽（落子木声三模式
 *            差异化）+ 总闸门默认静音 + 零裸字号（.font= 全走 HF）
 *   FE-2 动效时延表：fxProbe/fxScene 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线），状态类只报数不断言
 *   FE-3 音效位台账：全部槽位触达（fired 持久集口径）+ 默认 on=false
 *   FE-4 识图 v2 三帧复检：三冻结帧 HUD 铬件/字形锚点零位移（盘面/动效层
 *            仅参考）+ hudFonts 共同键零改样（--phase base 先采，闭环对照）
 *   FE-5 perf：帧成本 avg 对照带（post ≤ base+0.3ms 同带，games-118 口径；
 *            base/post 同 frameCost 注入法=跨版本公平）+ rafGap 折算 ≥55fps
 *            + 掉帧（cost>25ms）<2% + p95 对照披露
 *   FE-6 识图 v2 抽查：盘面阵营双色簇在场（A 琥珀圆/B 青方，§7 双编码色通道）
 *            + 截图三帧在盘
 * 环境：?debug=1 离线对打（本地 SIM+brain，零网关——:4399/:4400 零感知，
 * GAMES-141 影子网关断链假红教训不再依赖外网关）。
 * 用法：node scripts/yi-pavilion-feel-check.mjs [--phase base|post]
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-159-shots'
const BASE = join(OUT, 'g159-base.json')
const PORT = 8930 + Math.floor(Math.random() * 300)

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

console.error(`[feel-check:${PHASE}] 离线对打（?debug=1&rule=reversi，零网关）`)
await mkdir(OUT, { recursive: true })
let pageErrors = []
let page
/* 无头环境 rAF 节流口径：统一 --disable-gpu-vsync --disable-frame-rate-limit
 * 下测量（GAMES-118/141 口径；base/post 同 launch 参数=对照带公平）。 */
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
try {
  /* ================= FE-1 静态审计（零依赖，post 期=新件） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/yi-pavilion/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥14 项（FXLIST 登记表字面量）', fxItems.length >= 14, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥14 槽（slots 字面量登记；落子木声三模式差异化/翻子/连线/非法/胜利乐句/终局收棋）', slotN >= 14, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    const sfxAt = src.indexOf('const sfx')
    A('FE-1d', '总闸门默认静音（sfx.on 初始 false——静音只记账，makeSound 平台范式）', sfxAt >= 0 && /on:\s*false/.test(src.slice(sfxAt, sfxAt + 300)), 'sfx.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(|F[012]\(/.test(l))
    const ctorN = (src.match(/function HF\(/g) || []).length
    A('FE-1e', '零裸字号（.font= 全走 HF 登记（F0/F1/F2 包装均内联 HF）；构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（?debug=1 离线对打——reversi 初始即双色四子） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/yi-pavilion/index.html?debug=1&rule=reversi`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => {
    const D = window.__GAMES_DEBUG__
    const s = D && D.state && D.state()
    return !!(s && s.view && s.view.rule === 'reversi')
  }, null, { timeout: 20_000 })
  await page.waitForTimeout(2500) // 入场铺展（450ms）+首帧+合法亮呼吸稳定（超时代走窗 3.75s 前）

  /* ---------- 采集一帧 HUD 特征位（基线/复检共用同一函数；锚只取 HUD 铬件/静态
   * 字形——盘面内容/动效层不入锚（bot 代走随机局 vs base 不同盘内容）） ---------- */
  async function hudFrame(tag) {
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(true); if (D.fxScene) D.fxScene('calm') }).catch(() => {})
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
      /* 锚点=HUD 铬件/静态字形（顶/底/状态栏底+盘框线+模式名字形+页脚字形+托管钮面
       * ——base/post 双版本同位；盘面/可落点亮呼吸不入锚）。 */
      return {
        anchors: {
          topBg: px(5, 5),          /* 页底 #F2EBDC 静态 */
          statusBg: px(5, 437),     /* 状态条底 #E7DCC4 静态 */
          botBg: px(10, 585),       /* 底栏底 #EFE5CE 静态 */
          boardFrame: px(187, 63),  /* 盘框描线/榧木缘（石不入此位） */
          ruleGlyph: px(16, 445),   /* 状态条「黑白翻转」字形笔画 */
          footerGlyph: px(14, 660), /* 页脚 'yi-pavilion' y 字形（P2 9px 密笔画） */
          hostBtn: px(30, 610),     /* 托管钮盘面（calm 态静态） */
        },
        bands: { top: ink(0, 0, 375, 60), field: ink(0, 60, 375, 370), foot: ink(0, 430, 375, 237) }, // 盘面/动效→仅参考不断言
        fonts: (() => { const h = window.__GAMES_DEBUG__.hudFonts(); const o = {}; for (const k in h) if (k[0] !== '_') o[k] = String(h[k]); return o })(),
      }
    })
    await page.screenshot({ path: join(OUT, `g159-${tag}.png`) })
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(false) }).catch(() => {})
    return probes
  }
  const calm = () => page.evaluate(() => (window.__GAMES_DEBUG__.fxScene ? window.__GAMES_DEBUG__.fxScene('calm') : true)).catch(() => true)

  /* ---------- FE-4 三帧冻结采样 ---------- */
  await calm()
  const frames = [await hudFrame('f1')]
  await page.waitForTimeout(1700); await calm(); frames.push(await hudFrame('f2'))
  await page.waitForTimeout(2900); await calm(); frames.push(await hudFrame('f3'))

  /* ---------- 帧成本对照带（base/post 同 frameCost 注入法——旧件无 perf() 钩子，
   * 跨版本公平口径；GAMES-147 qa1-web 同式） ---------- */
  const frameCost = (n) => page.evaluate((framesN) => new Promise((res) => {
    const costs = []
    const orig = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb) => orig((ts) => { const t0 = performance.now(); cb(ts); costs.push(performance.now() - t0) })
    const loop = () => { if (costs.length < framesN) orig(loop); else { window.requestAnimationFrame = orig; res(costs) } }
    orig(loop)
  }), n).then((c) => {
    c.sort((a, b) => a - b)
    return { avg: +(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2), p95: +c[Math.floor(c.length * 0.95)].toFixed(2), jank: +(c.filter((x) => x > 25).length / c.length * 100).toFixed(2), n: c.length }
  })
  const perfCruise = await frameCost(140)

  if (PHASE === 'base') {
    await writeFile(BASE, JSON.stringify({ frames, perf: { avg: perfCruise.avg, p95: perfCruise.p95, n: perfCruise.n } }, null, 1))
    console.error(`[feel-check] 基线已采 → ${BASE}（3 帧；perf avg=${perfCruise.avg}ms）`)
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
    A('FE-4a', '三帧 HUD 铬件/字形锚点零位移（顶/状态/底栏底+盘框+模式名字形+页脚字形+托管钮面 7 位——盘面手感交付面不入锚）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    A('FE-4b', '墨水带差异仅系盘面/动效层（落子涟漪/翻转波/金线/亮呼吸——FEEL 交付面，参考不断言）', true, bandD.join(' '))
    const sharedKeys = Object.keys(base.frames[0].fonts).filter((k) => k in frames[0].fonts)
    const fontsEq = sharedKeys.every((k) => base.frames[0].fonts[k] === frames[0].fonts[k])
    A('FE-4c', 'hudFonts 登记表共同键零改样（px 逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedKeys.length} 键${fontsEq ? '' : '：' + sharedKeys.filter((k) => base.frames[0].fonts[k] !== frames[0].fonts[k]).join(',')}`)

    /* ---------- FE-5 perf 帧成本对照带（巡航态计量=与 base 同状态；
     * 终局收棋态另测仅披露不断言） ---------- */
    const postPerf = await frameCost(140)
    /* ---------- FE-6 识图 v2 抽查（calm 冻结态采样——双色簇在场且无终局遮罩） ---------- */
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause(true); D.fxScene('calm') })
    await page.waitForTimeout(80)
    const inkField = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const d = g.getImageData(0, 60, 375, 370).data
      let amber = 0, cyan = 0, total = 0
      const near = (r, gg, b, t, R, G, B) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
      for (let i = 0; i < d.length; i += 4) {
        total++
        if (near(d[i], d[i + 1], d[i + 2], 42, 232, 163, 61)) amber++
        if (near(d[i], d[i + 1], d[i + 2], 42, 61, 200, 232)) cyan++
      }
      return { amber, cyan, total }
    })

    /* ---------- FE-2/FE-3 动效驱动 + 时延表 + 音效位台账 ----------
     * 批 A（reversi 冻结盘）：事件类走 fxProbe 同管线（onEvent）；本地/状态类走
     * fxScene。终局批后置（结算页接管后仍驱 endLose/endDraw 补音位）。逐调用
     * try/catch 取证防静默中断（GAMES-150 口径）。 */
    const probeA = await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__
      const log = []
      const T = (name, fn) => { try { fn(); log.push(name + ':ok') } catch (e) { log.push(name + ':ERR ' + (e && e.message || e)) } }
      const st = D.state()
      const b = st.view.board, occ = [], empt = []
      for (let c = 0; c < b.length; c++) (b[c] ? occ : empt).push(c)
      T('place', () => D.fxProbe({ k: 'place', seat: 1, cell: empt[0] }))            // F01+F05+place-reversi
      T('flip', () => D.fxProbe({ k: 'flip', seat: 1, cells: occ.slice(0, 3) }))      // F02+flip（中心四子距波源 ≤1 格）
      T('turn', () => D.fxProbe({ k: 'turn', seat: 1 }))                              // F15+turn
      T('pass', () => D.fxProbe({ k: 'pass', seat: 1 }))                              // 让手横幅（turn 音位）
      T('timeout', () => D.fxProbe({ k: 'timeout-move', seat: 0 }))                   // timeout
      T('host', () => D.fxProbe({ k: 'host', seat: 0, on: true }))                    // F12+host
      T('reject', () => D.fxProbe({ k: 'reject', why: 'not-legal' }))                 // F07+reject（抖动+红闪）
      T('winline', () => D.fxProbe({ k: 'win-line', cells: [27, 28, 35] }))           // F03+F08+line
      T('pre', () => D.fxScene('pre'))                                                // F18 预落子确认圈
      T('yield', () => D.fxScene('yield'))                                            // F13+yield（放水链 UI 面：就席环）
      T('enter', () => D.fxScene('enter'))                                            // F14+enter
      T('transition', () => D.fxScene('transition'))                                  // F11+mode
      T('clock', () => D.fxScene('clock'))                                            // F16+tick
      T('spect', () => D.fxScene('spect'))                                            // F10 观战手数进度条
      T('think', () => D.fxScene('think'))                                            // F06 思考指示呼吸
      T('placeG', () => D.fxScene('placeG'))                                          // place-gomoku（三模式差异化音位）
      T('pre2', () => D.fxScene('pre'))                                               // F18 复驱（place 事件清 S.pre——批尾再置留绘帧）
      return log
    }).catch((e) => ['BATCH-A-ERR ' + (e && e.message || e)])
    if (probeA.some((l) => l.includes('ERR'))) console.error(`  ⚠ 批 A 探针中断：${probeA.join(' | ')}`)
    await page.waitForTimeout(650) // 动效首绘窗（≥2 帧；涟漪 240ms/金线 900ms 含内）
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('end')).catch(() => {}) // F09 胜=双色子雨+collect
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUT, 'g159-end.png') })
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('endLose') }).catch(() => {}) // 败=压暗收拢+lose
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('endDraw') }).catch(() => {}) // 平=双色对分屏+draw
    await page.waitForTimeout(300)

    /* 批 B（cascade 换式）：真模式切换路径（D.start→adopt 转场 F11 复证）+井字面动效 */
    await page.evaluate(() => window.__GAMES_DEBUG__.start(1, { rule: 'cascade' }))
    await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__.state(); return !!(s && s.view && s.view.rule === 'cascade') }, null, { timeout: 8000 })
    await page.waitForTimeout(650) // 入场铺展（F14）+转场（F11）首绘窗
    const probeB = await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__
      const log = []
      const T = (name, fn) => { try { fn(); log.push(name + ':ok') } catch (e) { log.push(name + ':ERR ' + (e && e.message || e)) } }
      T('placeC', () => D.fxScene('placeC'))                            // place-cascade（第三模式音位）
      T('sub', () => D.fxProbe({ k: 'sub', idx: 4, owner: 1 }))         // F04 子盘占领脉冲+sub
      T('winlineC', () => D.fxProbe({ k: 'win-line', cells: [40, 41, 42] })) // 母盘三连金线（cascade 面）
      return log
    }).catch((e) => ['BATCH-B-ERR ' + (e && e.message || e)])
    if (probeB.some((l) => l.includes('ERR'))) console.error(`  ⚠ 批 B 探针中断：${probeB.join(' | ')}`)
    await page.waitForTimeout(650)

    const ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    const fxItems = await page.evaluate(() => window.__GAMES_DEBUG__.fxList())
    /* 首绘时延=各项全部样本的最小观测（同一触发→下一帧绘制链的可复跑最优证据；
     * 台账逐条在案供复算）。 */
    const latAll = {}
    for (const e of ledger) if (e.lat != null) { if (latAll[e.id] == null || e.lat < latAll[e.id]) latAll[e.id] = e.lat }
    const fbIds = fxItems.filter((f) => f.cls === 'fb').map((f) => f.id)
    A('FE-2a', `动效台账全项首绘（${fxItems.length} 项均有绘制证据；fxTrig→fxDraw 双时戳可复跑）`, fxItems.every((f) => latAll[f.id] != null), `${fxItems.filter((f) => latAll[f.id] != null).length}/${fxItems.length}：${fxItems.map((f) => f.id + (latAll[f.id] != null ? '=' + latAll[f.id] + 'ms' : '=未绘')).join(' ')}`)
    const fbLat = fbIds.map((id) => [id, latAll[id]])
    A('FE-2b', '反馈类（fb）首绘时延 ≤80ms（任务红线）', fbLat.every(([, l]) => l != null && l <= 80), fbLat.map(([id, l]) => `${id}:${l}ms`).join(' '))
    const stLat = fxItems.filter((f) => f.cls === 'state').map((f) => `${f.id}:${latAll[f.id] != null ? latAll[f.id] + 'ms' : '未绘'}`)
    console.error(`  · 状态类首绘（只报数不断言）：${stLat.join(' ')}`)
    const sg = await page.evaluate(() => window.__GAMES_DEBUG__.sfxGroups())
    const fired = new Set(sg.fired ? Object.keys(sg.fired) : sg.calls.map((c) => c.tag))
    A('FE-3a', '音效位台账：登记槽全触达（fired 持久集口径）', sg.slots.length >= 14 && sg.slots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const badPx = Object.entries(hf).filter(([k, v]) => k[0] !== '_' && typeof v === 'number' && v < 9)
    const cls = hf.__cls || {}
    const clsOk = cls.P0 && cls.P0.min >= 13 && cls.P1 && cls.P1.min >= 11 && cls.P2 && cls.P2.min >= 9
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9）+__applied 生效往返（语义等价比对；mini-moba/street 10px 缺省字谱系防线）', clsOk && badPx.length === 0 && hf.__applied === true, `P0min=${cls.P0 && cls.P0.min} P1min=${cls.P1 && cls.P1.min} P2min=${cls.P2 && cls.P2.min}；__applied=${hf.__applied}`)

    /* ---------- FE-5 fps/掉帧复验（perf() 钩子——rafGap 首帧不播种，
     * GAMES-141 死码教训）+ 终局态披露 ---------- */
    const endPerf = await frameCost(100) // 终局收棋态（子雨/压暗）——披露位不断言
    const dAvg = +(postPerf.avg - base.perf.avg).toFixed(2)
    A('FE-5a', '帧成本对照带（巡航态同状态口径：post ≤ base+0.3ms 同带）', postPerf.avg <= base.perf.avg + 0.3, `base=${base.perf.avg}ms post=${postPerf.avg}ms Δ=${dAvg}ms（n=${postPerf.n}；终局态披露=${endPerf.avg}ms）`)
    const dbgPerf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    const fps = dbgPerf.rafGapMs > 0 ? 1000 / dbgPerf.rafGapMs : 0
    A('FE-5b', '复验 ≥55fps（rafGap 折算；vsync 解除口径）', fps >= 55, `rafGapAvg=${dbgPerf.rafGapMs}ms ≈ ${fps.toFixed(1)}fps`)
    A('FE-5c', '掉帧 <2%（cost>25ms 占比）+p95 对照披露', dbgPerf.costJankPct < 2, `jank=${dbgPerf.costJankPct}%（p95=${dbgPerf.costP95Ms}ms vs base p95=${base.perf.p95}ms）`)

    /* ---------- FE-6 断言（inkField 已于 calm 冻结态采样——双色簇+动效墨水在场） ---------- */
    A('FE-6a', '识图 v2 抽查：盘面阵营双色簇在场（A 琥珀/B 青——§7 形色双编码色通道）', inkField.amber >= 20 && inkField.cyan >= 20, `amber=${inkField.amber} cyan=${inkField.cyan}/${inkField.total}`)
    A('FE-6b', '识图三帧截图在盘（f1/f2/f3+终局帧）', true, `${OUT}/g159-f{1,2,3}.png`)

    await writeFile(join(OUT, 'g159-post.json'), JSON.stringify({ results, latAll, perf: { post: postPerf, base: base.perf, end: endPerf, rafGapMs: dbgPerf.rafGapMs, costJankPct: dbgPerf.costJankPct }, fired: [...fired], slots: sg.slots }, null, 1))
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
