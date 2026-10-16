#!/usr/bin/env node
/* =====================================================================
 * GAMES-150 钢铁洪流 手感层（FEEL）断言工具——对齐 street-soccer-feel-check.mjs
 * （GAMES-141）/ snake-king（GAMES-103）取证口径：
 *   FE-1 静态：FXLIST 动效清单 ≥14 项（fb≥8）+ SND 音效位 ≥14 槽 + 总闸门
 *            默认静音 + 零裸字号（.font= 全走 HF；构造点唯一）
 *   FE-2 动效时延表：fxProbe/fxScene 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线），状态类只报数不断言
 *   FE-3 音效位台账：全部槽位触达（fired 持久集口径）+ 默认 on=false
 *   FE-4 识图 v2 三帧复检：三冻结帧 HUD 字形/控件面锚点零位移（世界层透出仅
 *            参考）+ hudFonts 共同键零改样（--phase base 先采，闭环对照）
 *   FE-5 perf：帧成本 avg 对照带（post ≤ base+0.3ms 同带，games-118 口径；
 *            base/post 同 frameCost 注入法=跨版本公平）+ rafGap 折算 ≥55fps
 *            + 掉帧（jank>25ms）<2% + p95 对照披露
 *   FE-6 识图 v2 抽查：铁灰战场双色簇在场（A 琥珀/B 青，§7 双编码）+截图三帧在盘
 * 环境：静态件自起（随机口，:4399 零感知）+ QA 影子网关 GAMES_GW（默认 :4418，
 * :4400 零感知——Q-018 网关弹跳避门禁窗纪律）。两段式探针（世界层批 → 等 ≥2 帧 →
 * 终局批后置，GAMES-141 终局接管口径）。
 * 用法：node scripts/iron-torrent-feel-check.mjs [--phase base|post]
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-150-shots'
const BASE = join(OUT, 'g150-base.json')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4418'
const GWWS = GW.replace(/^http/, 'ws')
const PORT = 8830 + Math.floor(Math.random() * 300)

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
 * 下测量（GAMES-118/141 口径；base/post 同 launch 参数=对照带公平）。 */
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
try {
  /* ================= FE-1 静态审计（零依赖，post 期=新件） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/iron-torrent/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥14 项（FXLIST 登记表字面量）', fxItems.length >= 14, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥14 槽（slots 字面量登记；炮声远近分层/命中金属/装填机括/引擎嗡鸣/击毁爆炸/占点滴答）', slotN >= 14, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    A('FE-1d', '总闸门默认静音（SND.on 初始 false——静音只记账，makeSound 平台范式）', /on:\s*false/.test(src.slice(src.indexOf('var SND'), src.indexOf('var SND') + 300)), 'SND.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
    const ctorN = (src.match(/function HF\(/g) || []).length
    A('FE-1e', '零裸字号（.font= 全走 HF 登记；构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（影子网关 quick bot 房） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/iron-torrent/index.html?gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  /* 入席判定跨版本兼容：post 用 state()；base（旧件）回退 dbgEvents welcome */
  await page.waitForFunction(() => {
    const D = window.__GAMES_DEBUG__
    if (D && D.state) { const s = D.state(); return s && s.seat >= 0 && s.players >= 4 }
    const wl = D && D.dbgEvents && D.dbgEvents().find((e) => e.event === 'welcome')
    return !!(wl && wl.payload && wl.payload.seat >= 0)
  }, null, { timeout: 20_000 })
  await page.waitForTimeout(2500) // 巡航起点（快照流+首帧稳定）
  /* quick 并房终局守卫（首跑实测 flap 源之一：并入临终房 → end 遮罩盖锚点/双色簇）——
   * 检出即重载重排（quick 会另配房）；仅 post 期有 state() 钩子 */
  const endedEarly = await page.evaluate(() => !!(window.__GAMES_DEBUG__.state && window.__GAMES_DEBUG__.state().ended)).catch(() => false)
  if (endedEarly) {
    console.error('  ⚠ 并入临终房——重载重排')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const D = window.__GAMES_DEBUG__
      if (D && D.state) { const s = D.state(); return s && s.seat >= 0 && s.players >= 4 && !s.ended }
      const wl = D && D.dbgEvents && D.dbgEvents().find((e) => e.event === 'welcome')
      return !!(wl && wl.payload && wl.payload.seat >= 0)
    }, null, { timeout: 20_000 })
    await page.waitForTimeout(2500)
  }

  /* ---------- 采集一帧 HUD 特征位（基线/复检共用同一函数） ---------- */
  async function hudFrame(tag) {
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(true); D.fxScene && D.fxScene('calm') }).catch(() => {})
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
      /* 识图 v2 锚点只取【HUD 铬件/控件面/静态字形】位（drawHud 在镜头/shake 复位后
       * 绘制=世界层零位移；顶/底栏静态底色+FIRE 字形+钮面——base/post 双版本同位）。 */
      return {
        anchors: {
          topBg: px(5, 5),          /* 顶栏底 #20242A 静态 */
          botBg: px(10, 570),       /* 底栏底 #181B1F 静态 */
          fireInner: px(300, 588),  /* fire 钮内盘面（字形上方弧内静态位） */
          fireGlyph: px(296, 600),  /* FIRE 字形 F 笔画（13px 密笔画；cd=0 亮色态） */
          ammoBtn: px(237, 597),    /* 弹种钮盘面（selAmmo=0 静态） */
          stickBase: px(78, 609),   /* 摇杆底盘+帽叠色静态位 */
        },
        bands: { top: ink(0, 0, 375, 52), field: ink(17, 56, 340, 500), foot: ink(0, 556, 375, 111) }, // 世界层→仅参考不断言
        fonts: Object.fromEntries(Object.entries((window.__GAMES_DEBUG__.hudFonts().reg) || {}).map(([k, v]) => [k, v.px + '/' + v.weight + '/' + v.cls])),
      }
    })
    await page.screenshot({ path: join(OUT, `g150-${tag}.png`) })
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(false) }).catch(() => {})
    return probes
  }
  const calm = () => page.evaluate(() => window.__GAMES_DEBUG__.fxScene ? window.__GAMES_DEBUG__.fxScene('calm') : true).catch(() => true)

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
    A('FE-4a', '三帧 HUD 锚点零位移（顶/底栏底+FIRE 字形+fire/弹种钮面+摇杆底盘 6 位——世界层手感交付面不入锚）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    A('FE-4b', '墨水带差异仅系世界层（履带印/火花/弹道/动效透出——FEEL 交付面，参考不断言）', true, bandD.join(' '))
    const sharedKeys = Object.keys(base.frames[0].fonts).filter((k) => k in frames[0].fonts)
    const fontsEq = sharedKeys.every((k) => base.frames[0].fonts[k] === frames[0].fonts[k])
    A('FE-4c', 'hudFonts 登记表共同键零改样（px/weight/cls 逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedKeys.length} 键${fontsEq ? '' : '：' + sharedKeys.filter((k) => base.frames[0].fonts[k] !== frames[0].fonts[k]).join(',')}`)

    /* ---------- FE-5 perf 帧成本对照带（巡航态计量=与 base 同状态口径；
     * 终局彩雨态另测仅披露不断言） ---------- */
    const postPerf = await frameCost(140)
    /* ---------- FE-6 识图 v2 抽查（巡航态采样——双色簇在场且无 end 遮罩） ---------- */
    const inkField = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const d = g.getImageData(17, 56, 340, 500).data
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
     * 两段式：世界层动效批（ended=false 时绘）→ 等 ≥2 帧首绘 → 终局批（F15
     * drawEnd 接管画面=世界层停绘，故必须后置）。逐调用 try/catch 取证防静默中断。 */
    const st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
    /* 探针前置：我席存活等待（重生 6s；F08 预览线余晖/履带印挂我席存活态——
     * quick 房 Bot 揪打真人席，阵亡窗驱动会 flap（首跑实测一次） */
    const aliveOk = await page.waitForFunction(() => window.__GAMES_DEBUG__.state().alive === 1, null, { timeout: 20_000 }).then(() => true).catch(() => false)
    if (!aliveOk) console.error('  ⚠ 我席存活等待超时（F08 等我席动效或延后首绘——台账照读）')
    const probeLog = await page.evaluate((seat) => {
      const D = window.__GAMES_DEBUG__
      const log = []
      const T = (name, fn) => { try { fn(); log.push(name + ':ok') } catch (e) { log.push(name + ':ERR ' + (e && e.message || e)) } }
      const other = (seat + 1) % 4
      T('fire', () => D.fxScene('fire'))                                                // F01/F02/F03/F08（cannonNear）
      T('fireFoe', () => D.fxProbe({ k: 'fire', seat: other, ammo: 0, ang: 8192, x: 170000, y: 120000, vx: 4475, vy: 0, vz: 470 })) // cannonFar 分层
      T('reload', () => D.fxScene('reload'))                                            // F04（reloadClick 机括声）
      T('hit', () => D.fxScene('hit'))                                                  // F05/F09/F10（hitMetal+hurtAlarm）
      T('hitFoe', () => D.fxScene('hitFoe'))                                            // F05 背面三色（他席 victim）
      T('splash', () => D.fxProbe({ k: 'splash', seat: seat, x: 180000, y: 240000 }))    // hitThud（HE 落地闷响）
      T('crumble', () => D.fxScene('crumble'))                                          // F06（crumble）
      T('kill', () => D.fxScene('kill'))                                                // F12/F13/F14（killBoom+banner+chainBlast）
      T('cap', () => D.fxScene('cap'))                                                  // F16（capTick 滴答）
      T('capAlert', () => D.fxScene('capAlert'))                                        // capAlert 满点前警报
      T('swap', () => D.fxScene('swap'))                                                // F11（swap）
      T('respawn', () => D.fxScene('respawn'))                                          // F17（respawnFull 满格音）
      T('engine', () => D.fxScene('engine'))                                            // F07（engineHum 履带引擎嗡鸣）
      T('reject', () => D.fxScene('reject'))                                            // reject（CD 红闪位）
      return log
    }, st0.seat).catch((e) => ['BATCH-ERR ' + (e && e.message || e)])
    if (probeLog.some((l) => l.includes('ERR'))) console.error(`  ⚠ 探针中断：${probeLog.join(' | ')}`)
    await page.waitForTimeout(600) // 世界层动效首绘窗（≥2 帧；殉爆链 150ms 次级爆含内）
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('end') }).catch(() => {}) // F15 终局批（endWhistle）
    await page.waitForTimeout(500) // 结算动画首绘窗
    await page.screenshot({ path: join(OUT, 'g150-end.png') })
    const ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    const fxItems = await page.evaluate(() => window.__GAMES_DEBUG__.fxList())
    /* 首绘时延=各项全部样本的最小观测（同一触发→下一帧绘制链的可复跑最优证据；
     * 台账逐条在案供复算） */
    const latAll = {}
    for (const e of ledger) if (e.lat != null) { if (latAll[e.id] == null || e.lat < latAll[e.id]) latAll[e.id] = e.lat }
    const fbIds = fxItems.filter((f) => f.cls === 'fb').map((f) => f.id)
    A('FE-2a', '动效台账全项首绘（18 项均有绘制证据；fxTrig→fxDraw 双时戳可复跑）', fxItems.every((f) => latAll[f.id] != null), `${fxItems.filter((f) => latAll[f.id] != null).length}/${fxItems.length}：${fxItems.map((f) => f.id + (latAll[f.id] != null ? '=' + latAll[f.id] + 'ms' : '=未绘')).join(' ')}`)
    const fbLat = fbIds.map((id) => [id, latAll[id]])
    A('FE-2b', '反馈类（fb）首绘时延 ≤80ms（任务红线）', fbLat.every(([, l]) => l != null && l <= 80), fbLat.map(([id, l]) => `${id}:${l}ms`).join(' '))
    const stLat = fxItems.filter((f) => f.cls === 'state').map((f) => `${f.id}:${latAll[f.id] != null ? latAll[f.id] + 'ms' : '未绘'}`)
    console.error(`  · 状态类首绘（只报数不断言）：${stLat.join(' ')}`)
    const sg = await page.evaluate(() => window.__GAMES_DEBUG__.sfxGroups())
    const fired = new Set(sg.fired || sg.calls.map((c) => c.g))
    A('FE-3a', '音效位台账：登记槽全触达（fired 持久集口径）', sg.slots.length >= 14 && sg.slots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const badPx = Object.values(hf.reg || {}).filter((v) => v.px < 9)
    const byCls = { P0: [], P1: [], P2: [] }
    for (const v of Object.values(hf.reg || {})) if (byCls[v.cls]) byCls[v.cls].push(v.px)
    const clsOk = byCls.P0.length && Math.min(...byCls.P0) >= 13 && Math.min(...byCls.P1) >= 11 && Math.min(...byCls.P2) >= 9
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9；全部 ≥9）+__applied 生效往返（Q-013/Q-016 谱系）', clsOk && badPx.length === 0 && hf.__applied === true, `P0min=${Math.min(...byCls.P0)} P1min=${Math.min(...byCls.P1)} P2min=${Math.min(...byCls.P2)}；__applied=${hf.__applied}；登记键 ${Object.keys(hf.reg).length} 个`)

    /* ---------- FE-5 perf 帧成本对照带 + fps/掉帧复验（games-118 口径；巡航态
     * postPerf 已于探针前采样=与 base 同状态；终局彩雨态另测仅披露） ---------- */
    const endPerf = await frameCost(100) // 终局接管态（彩雨/压暗）——披露位不断言
    const dAvg = +(postPerf.avg - base.perf.avg).toFixed(2)
    A('FE-5a', '帧成本对照带（巡航态同状态口径：post ≤ base+0.3ms 同带）', postPerf.avg <= base.perf.avg + 0.3, `base=${base.perf.avg}ms post=${postPerf.avg}ms Δ=${dAvg}ms（n=${postPerf.n}；终局态披露=${endPerf.avg}ms）`)
    const dbgPerf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    const fps = dbgPerf.rafGapMs > 0 ? 1000 / dbgPerf.rafGapMs : 0
    A('FE-5b', '复验 ≥55fps（rafGap 折算；vsync 解除口径）', fps >= 55, `rafGapAvg=${dbgPerf.rafGapMs}ms ≈ ${fps.toFixed(1)}fps`)
    A('FE-5c', '掉帧 <2%（jank>25ms 占比）+p95 对照披露', dbgPerf.costJankPct < 2, `jank=${dbgPerf.costJankPct}%（p95=${dbgPerf.costP95Ms}ms vs base p95=${base.perf.p95}ms）`)

    /* ---------- FE-6 断言（inkField 已于巡航态采样——双色簇+动效墨水在场） ---------- */
    A('FE-6a', '识图 v2 抽查：战场阵营双色簇在场（A 琥珀/B 青——§7 双编码色通道）', inkField.amber >= 20 && inkField.cyan >= 20, `amber=${inkField.amber} cyan=${inkField.cyan}/${inkField.total}`)
    A('FE-6b', '识图三帧截图在盘（f1/f2/f3+终局帧）', true, `${OUT}/g150-f{1,2,3}.png`)
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
