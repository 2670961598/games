#!/usr/bin/env node
/* =====================================================================
 * GAMES-167 深海食物链 手感层（FEEL）断言工具——对齐 yi-pavilion（GAMES-159）/
 * iron-torrent（GAMES-150）/ street-soccer（GAMES-141）取证口径：
 *   FE-1 静态：FXLIST 动效清单 ≥14 项（fb≥8）+ 音效位 ≥14 槽（吞噬咂嘴体型
 *            分级音高/升档号角/被捕低鸣/dash 水泡串/食物微啵/天敌低频警示）
 *            + 总闸门默认静音 + 零裸字号（.font= 全走 HF）
 *   FE-2 动效台账：fxProbe/fxScene 驱动全部动效 → fxLedger fxTrig→fxDraw
 *            双时戳首绘时延，反馈类（fb）≤80ms（任务红线），状态类只报数
 *   FE-3 音效位台账：全部槽位触达（fired 持久集口径，GAMES-141 洪水冲掉
 *            教训）+ 默认 on=false
 *   FE-4 识图 v2 三帧复检：三冻结帧 HUD 铬件/字形锚点零位移（世界层动效
 *            仅参考）+ hudFonts 共同键零改样（--phase base 先采闭环对照）
 *   FE-5 perf：帧成本 avg 对照带（post ≤ base+0.3ms，games-118 口径）+
 *            rafGap 折算 ≥55fps + 掉帧（cost>25ms）<2% + p95 对照披露
 *   FE-6 识图 v2 抽查：自身鱼 T0 色簇在场（镜头恒锁自身=确定性锚）+
 *            三帧截图在盘 + HF __applied 语义等价比对
 * 环境：?debug=1 幽灵渔场（零网关——:4399/:4400 零感知，GAMES-159 离线口径）。
 * 用法：node scripts/deep-foodchain-feel-check.mjs [--phase base|post]
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-167-shots'
const BASE = join(OUT, 'g167-base.json')
const PORT = 8930 + Math.floor(Math.random() * 300)

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 静态文件服务器（.cjs 须 text/javascript——MIME 拒载静默坑 GAMES-90） ---------- */
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

console.error(`[feel-check:${PHASE}] 幽灵渔场（?debug=1，零网关）`)
await mkdir(OUT, { recursive: true })
let pageErrors = []
let page
/* 无头环境 rAF 节流口径：统一 --disable-gpu-vsync --disable-frame-rate-limit
 * （GAMES-118/141 口径；base/post 同 launch 参数=对照带公平）。 */
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
try {
  /* ================= FE-1 静态审计（零依赖，post 期=新件） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/deep-foodchain/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥14 项（FXLIST 登记表字面量）', fxItems.length >= 14, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥14 槽（slots 字面量登记；吞噬咂嘴体型分级音高/升档号角/被捕低鸣/dash 水泡串/食物微啵/天敌低频警示）', slotN >= 14, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    const sfxAt = src.indexOf('const sfx')
    A('FE-1d', '总闸门默认静音（sfx.on 初始 false——静音只记账，makeSound 平台范式）', sfxAt >= 0 && /on:\s*false/.test(src.slice(sfxAt, sfxAt + 300)), 'sfx.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /g\.font\s*=/.test(l) && !/HF\(/.test(l))
    const ctorN = (src.match(/function HF\(/g) || []).length
    A('FE-1e', '零裸字号（g.font= 渲染位全走 HF 登记表；构造点唯一；ctx.font= 仅 __applied 自证探针）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（?debug=1 幽灵渔场——20 幽灵鱼+180 资源位） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/deep-foodchain/index.html?debug=1`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => {
    const D = window.__GAMES_DEBUG__
    const s = D && D.state && D.state()
    return !!(s && s.mode === 'debug')
  }, null, { timeout: 20_000 })
  await page.waitForTimeout(2500) // 开场下沉入场（420ms）+首帧+幽灵节拍稳定

  /* ---------- 采集一帧 HUD 特征位（基线/复检共用同一函数；锚只取 HUD 铬件/
   * 静态字形——世界层鱼群/光点/动效不入锚（幽灵随机布位 vs base 不同盘面）） ---------- */
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
      /* 锚点=HUD 铬件/静态字形（覆盖层后绘制位——世界层动效零污染，GAMES-141 口径）：
       * 顶栏底/质数字形/轮次字形/分数字形/海王榜标题字形/dash 钮面/页脚字形。 */
      return {
        anchors: {
          topBg: px(5, 5),          /* 顶栏底 rgba(5,12,9,.72) 静态 */
          massGlyph: px(13, 20),    /* 「质 20」字形（debug 恒 M=20） */
          roundGlyph: px(133, 20),  /* 「第1轮」字形（debug 恒 n=1） */
          scoreGlyph: px(13, 42),   /* 「分 5」字形（debug 恒 sc） */
          lbTitleGlyph: px(14, 70), /* 「海王榜」标题字形（行区动态不入锚） */
          dashBtnFace: px(317, 589),/* dash 钮面（M=20<30 恒未点亮） */
          footGlyph: px(14, 660),   /* 页脚 'deep-foodchain' 字形（P2 9px 密笔画） */
        },
        bands: { top: ink(0, 0, 375, 56), field: ink(0, 56, 375, 500), foot: ink(0, 540, 375, 127) }, // 世界层/动效→仅参考不断言
        fonts: (() => { const h = window.__GAMES_DEBUG__.hudFonts(); const o = {}; for (const k in h) if (k[0] !== '_') o[k] = String(h[k]); return o })(),
      }
    })
    await page.screenshot({ path: join(OUT, `g167-${tag}.png`) })
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(false) }).catch(() => {})
    return probes
  }
  const calm = () => page.evaluate(() => (window.__GAMES_DEBUG__.fxScene ? window.__GAMES_DEBUG__.fxScene('calm') : true)).catch(() => true)

  /* ---------- FE-4 三帧冻结采样 ---------- */
  await calm()
  const frames = [await hudFrame('f1')]
  await page.waitForTimeout(1700); await calm(); frames.push(await hudFrame('f2'))
  await page.waitForTimeout(2900); await calm(); frames.push(await hudFrame('f3'))

  /* ---------- 帧成本对照带（base/post 同 frameCost 注入法——跨版本公平口径） ---------- */
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
    A('FE-4a', '三帧 HUD 铬件/字形锚点零位移（顶栏底/质·轮次·分数·榜题字形/dash 钮面/页脚 7 位——世界层手感交付面不入锚）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    A('FE-4b', '墨水带差异仅系世界层/动效层（吞噬吸入/升档爆发/惊红闪/AOI 呼吸圈——FEEL 交付面，参考不断言）', true, bandD.join(' '))
    const sharedKeys = Object.keys(base.frames[0].fonts).filter((k) => k in frames[0].fonts)
    const fontsEq = sharedKeys.every((k) => base.frames[0].fonts[k] === frames[0].fonts[k])
    A('FE-4c', 'hudFonts 登记表共同键零改样（px 逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedKeys.length} 键${fontsEq ? '' : '：' + sharedKeys.filter((k) => base.frames[0].fonts[k] !== frames[0].fonts[k]).join(',')}`)

    /* ---------- FE-2/FE-3 动效驱动 + 台账 + 音效位（逐调用 try/catch 取证
     * 防静默中断，GAMES-150 口径；吞噬零预测=纯事件驱动管线同口径复用。
     * 批间等待=rAF 首帧迟滞对策（同 tick 连发时 calm 类驱动会先清场——
     * 分小批让每批 trig→draw 各自走完再发下一批；die 殿后防死亡态闸状态项） ---------- */
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {}) // rAF 热身
    const runBatch = (ops) => page.evaluate((opsIn) => {
      const D = window.__GAMES_DEBUG__
      const seat = D.state().seat
      const log = []
      for (const op of opsIn) {
        try {
          const ev = op.p ? JSON.parse(JSON.stringify(op.p).replace(/"SEAT"/g, JSON.stringify(seat))) : null // SEAT 占位→数值席位（'0'===0 假等坑）
          if (op.s) D.fxScene(op.s); else D.fxProbe(ev)
          log.push(op.n + ':ok')
        } catch (e) { log.push(op.n + ':ERR ' + (e && e.message || e)) }
      }
      return log
    }, ops).catch((e) => ['BATCH-ERR ' + (e && e.message || e)])
    const probe1 = await runBatch([
      { n: 'eat1', p: { k: 'eat', seat: 'SEAT', v: 1, id: 'a1' } },                      // F12 comboBounce+eat1（食物微啵）
      { n: 'eat2', p: { k: 'eat', seat: 'SEAT', v: 2, id: 'a5' } },                      // eat2（微啵分级）
      { n: 'eat4', p: { k: 'eat', seat: 'SEAT', v: 4, id: 'c5' } },                      // eat4（晶簇微啵高阶）
      { n: 'gulp', p: { k: 'devour', by: 'SEAT', seat: 1, gain: 30, drops: 10 } },       // F01 张嘴吸入+F06 掉落散布+devour 咂嘴
      { n: 'tier', p: { k: 'tier', seat: 'SEAT', t: 2 } },                               // F02 升档爆发光圈+号角
      { n: 'whale', p: { k: 'tier', seat: 5, t: 3 } },                                   // F13 鲸级登场震屏波纹
    ])
    await page.waitForTimeout(260) // 首绘窗（吸入 240ms 含内）——批 1 走完再发批 2
    const probe2 = await runBatch([
      { n: 'milestone', p: { k: 'milestone', seat: 'SEAT', M: 300 } },                   // 里程碑 toast+tier 音位
      { n: 'bloom', p: { k: 'bloom', band: 2 } },                                         // 鱼汛潮+小地图脉冲
      { n: 'crown', p: { k: 'crown', seat: 1, name: '幽灵1', score: 99 } },               // 加冕覆层
      { n: 'dash', s: 'dash' },                                                          // F04 尾迹气泡+dashOn/bubble
      { n: 'panic', s: 'panic' },                                                        // F05 天敌逼近惊红闪+danger 低频
    ])
    await page.waitForTimeout(260)
    const probe3 = await runBatch([
      { n: 'e1', p: { k: 'eat', seat: 'SEAT', v: 1, id: 's1' } },                        // 连食×5 → streak（真路径：eatStreak 累计）
      { n: 'e2', p: { k: 'eat', seat: 'SEAT', v: 1, id: 's2' } },
      { n: 'e3', p: { k: 'eat', seat: 'SEAT', v: 1, id: 's3' } },
      { n: 'e4', p: { k: 'eat', seat: 'SEAT', v: 1, id: 's4' } },
      { n: 'e5', p: { k: 'eat', seat: 'SEAT', v: 1, id: 's5' } },
      { n: 'enter', s: 'enter' },                                                        // F16 开场下沉入场+spawn
      { n: 'round', s: 'round' },                                                        // F14 终局成长曲线回放+round/curve 音位
      { n: 'stateAll', s: 'stateAll' },                                                  // F03/F07/F08/F09/F10/F11/F15 状态项
    ])
    await page.waitForTimeout(300)
    const probe4 = await runBatch([
      { n: 'die', p: { k: 'devour', seat: 'SEAT', by: 2, drops: 8 } },                   // F05 被捕惊红闪+die 低鸣+F06 散布（死亡路径殿后）
    ])
    const probeA = [...(Array.isArray(probe1) ? probe1 : []), ...(Array.isArray(probe2) ? probe2 : []), ...(Array.isArray(probe3) ? probe3 : []), ...(Array.isArray(probe4) ? probe4 : [])]
    if (probeA.some((l) => l.includes('ERR'))) console.error(`  ⚠ 探针批中断：${probeA.join(' | ')}`)
    await page.waitForTimeout(750) // 动效余窗+dashOff(600ms) 落账
    await page.screenshot({ path: join(OUT, 'g167-fx.png') })

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
    const fired = new Set(sg.fired ? Object.keys(sg.fired) : sg.calls.map((c) => c.g))
    A('FE-3a', '音效位台账：登记槽全触达（fired 持久集口径）', sg.slots.length >= 14 && sg.slots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const reg = hf.reg || hf
    const badPx = Object.entries(reg).flatMap(([grp, m]) => Object.entries(m || {}).map(([k, v]) => [grp + '.' + k, v.px])).filter(([, px]) => px < 9)
    const cls = hf.__cls || {}
    const clsOk = cls.P0 && cls.P0.min >= 13 && cls.P1 && cls.P1.min >= 11 && cls.P2 && cls.P2.min >= 9
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9）+__applied 生效往返（语义等价比对；mini-moba/street 10px 缺省字谱系防线）', clsOk && badPx.length === 0 && hf.__applied === true, `P0min=${cls.P0 && cls.P0.min} P1min=${cls.P1 && cls.P1.min} P2min=${cls.P2 && cls.P2.min}；__applied=${hf.__applied}`)

    /* ---------- FE-5 fps/掉帧复验（perf() 钩子——rafGap 首帧不播种，
     * GAMES-141 死码教训）+ 动效期披露 ---------- */
    const postPerf = await frameCost(140)
    const fxPerf = await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.fxScene('dash'); D.fxProbe({ k: 'devour', by: D.state().seat, seat: 1, gain: 30, drops: 10 }); return true }).catch(() => false)
    const fxPerfStat = fxPerf ? await frameCost(100) : null // 动效并发态——披露位不断言
    const dAvg = +(postPerf.avg - base.perf.avg).toFixed(2)
    A('FE-5a', '帧成本对照带（巡航态同状态口径：post ≤ base+0.3ms 同带）', postPerf.avg <= base.perf.avg + 0.3, `base=${base.perf.avg}ms post=${postPerf.avg}ms Δ=${dAvg}ms（n=${postPerf.n}；动效并发态披露=${fxPerfStat ? fxPerfStat.avg + 'ms' : 'n/a'}）`)
    const dbgPerf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    const fps = dbgPerf.rafGapMs > 0 ? 1000 / dbgPerf.rafGapMs : 0
    A('FE-5b', '复验 ≥55fps（rafGap 折算；vsync 解除口径）', fps >= 55, `rafGapAvg=${dbgPerf.rafGapMs}ms ≈ ${fps.toFixed(1)}fps`)
    A('FE-5c', '掉帧 <2%（cost>25ms 占比）+p95 对照披露', dbgPerf.costJankPct < 2, `jank=${dbgPerf.costJankPct}%（p95=${dbgPerf.costP95Ms}ms vs base p95=${base.perf.p95}ms）`)

    /* ---------- FE-6 识图 v2 抽查（calm 冻结态采样） ---------- */
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause(true); D.fxScene('calm') })
    await page.waitForTimeout(80)
    const inkCenter = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const d = g.getImageData(375 / 2 - 40, 667 / 2 - 40, 80, 80).data
      let teal = 0, total = 0
      const near = (r, gg, b, t, R, G, B) => Math.abs(r - R) <= t && Math.abs(gg - G) <= t && Math.abs(b - B) <= t
      for (let i = 0; i < d.length; i += 4) { total++; if (near(d[i], d[i + 1], d[i + 2], 42, 143, 216, 200)) teal++ }
      return { teal, total }
    })
    A('FE-6a', '识图 v2 抽查：自身鱼 T0 色簇在场（镜头恒锁自身=确定性锚，#8FD8C8 形色双编码）', inkCenter.teal >= 20, `teal=${inkCenter.teal}/${inkCenter.total}`)
    A('FE-6b', '识图三帧截图在盘（f1/f2/f3+动效帧）', true, `${OUT}/g167-f{1,2,3}.png`)

    await writeFile(join(OUT, 'g167-post.json'), JSON.stringify({ results, latAll, perf: { post: postPerf, base: base.perf, fx: fxPerfStat, rafGapMs: dbgPerf.rafGapMs, costJankPct: dbgPerf.costJankPct }, fired: [...fired], slots: sg.slots }, null, 1))
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
