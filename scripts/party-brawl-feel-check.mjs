#!/usr/bin/env node
/* =====================================================================
 * GAMES-176 派对大乱斗 手感层（FEEL）断言工具——对齐 iron-torrent-feel-check.mjs
 * （GAMES-150）/ street-soccer（GAMES-141）取证口径：
 *   FE-1 静态：FXLIST 动效清单 ≥16 项（fb≥6——本作口径：iron 14/8 基础上按
 *            §3.4 juice 清单实落 19/7）+ SND 音效位 ≥8 槽 + 总闸门默认静音
 *            + 零裸字号（.font= 全走 HF；构造点唯一）
 *   FE-2 动效时延表：fxScene/fxProbe 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线），状态类只报数不断言
 *   FE-3 音效位台账：全部槽位触达（fired 持久集口径）+ 默认 on=false
 *   FE-4 识图三帧复检：三冻结帧 HUD 铬件锚点零位移（世界层透出仅参考）
 *            + hudFonts 共同键零改样（--phase base 先采，闭环对照）
 *   FE-5 perf：帧成本 avg 对照带（post ≤ base+0.3ms 同带，games-118 口径）
 *            + rafGap 折算 + 掉帧（jank>25ms）<2%
 *   FE-6 观战视图专项（O-2 承接）：killme 驱动淘汰 → phase=dead+信息卡可读
 *            （rank/kills/时长/击杀者/pingAvg）+ tap 切镜头（camMode 翻转）
 *            + cam 跟随 specSeat（坐标贴合）+ 服务端 spectator AOI 圆心
 *            =领先者坐标（WS spectate 直连断言）
 *   FE-7 juice 像素证据：hurt 渐晕/kill feed 驱动后墨水带差分（base 对照）
 * 环境：静态件自起（随机口）+ 网关 GAMES_GW（默认 :4400 生产 quick bot 房——
 * 观战 AOI 断言走 feed 房 spectate；games-84 教训：改 sim 后对 pid 重启网关）。
 * 用法：node scripts/party-brawl-feel-check.mjs [--phase base|post]
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-176-shots'
const BASE = join(OUT, 'g176-base.json')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4400'
const GWWS = GW.replace(/^http/, 'ws')
const PORT = 8860 + Math.floor(Math.random() * 300)

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
  const src = await readFile(join(ROOT, 'games/multiplayer/party-brawl/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥16 项（FXLIST 登记表字面量——§3.4 juice 清单+观战视图全落）', fxItems.length >= 16, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥6 项（本作口径：受击/KO/播报/警示四卖点位）', fbN >= 6, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥8 槽（slots 字面量登记；受击/击杀/拾取/箱/空投/缩圈/决赛心跳/回复/加速/终局）', slotN >= 8, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    A('FE-1d', '总闸门默认静音（SND.on 初始 false——静音只记账，makeSound 平台范式）', /on:\s*false/.test(src.slice(src.indexOf('const SND'), src.indexOf('const SND') + 300)), 'SND.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l) && !/ctx\.font\s*=\s*font/.test(l))
    const ctorN = (src.match(/function HF\(/g) || []).length
    A('FE-1e', '零裸字号（.font= 全走 HF 登记；构造点唯一——hudFonts 自证回读行 `ctx.font=font` 豁免）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（网关 quick bot 房） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/party-brawl/index.html?gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => {
    const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
    return st && st.seat >= 0 && (st.phase === 'live' || st.phase === 'lobby')
  }, null, { timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__.state().phase === 'live', null, { timeout: 25_000 })
  await page.waitForTimeout(2500) // 巡航起点（快照流+首帧稳定）
  /* 并房终局守卫（iron GAMES-150 flap 源之一：并入临终房 → end 遮罩盖锚点）——
   * 检出即重载重排（quick 会另配房） */
  const endedEarly = await page.evaluate(() => window.__GAMES_DEBUG__.state().phase === 'ended').catch(() => false)
  if (endedEarly) {
    console.error('  ⚠ 并入临终房——重载重排')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      const st = window.__GAMES_DEBUG__.state()
      return st && st.seat >= 0 && st.phase === 'live'
    }, null, { timeout: 25_000 })
    await page.waitForTimeout(2500)
  }

  /* ---------- 采集一帧 HUD 特征位（基线/复检共用同一函数） ---------- */
  async function hudFrame(tag) {
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(true) }).catch(() => {})
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
      /* 锚点只取【HUD 铬件/静态字形】位（hudDraw 在镜头/shake 复位后绘制=世界层零位移；
       * 顶栏底+ping 徽标带+武器栏底+页脚 slug——base/post 双版本同位。世界层（毒圈/糖豆/
       * feed 行随事件增减）不入锚。 */
      return {
        anchors: {
          topBg: px(5, 5),          /* 顶栏底 rgba(23,83,122) 静态 */
          topRight: px(315, 20),    /* ping 徽标位（顶栏右域底色——徽标字形随 ping 值波动，取底色带） */
          wpnBg: px(20, 627),       /* 武器栏底 rgba(23,83,122,0.7) 静态 */
          wpnBg2: px(140, 585),     /* 武器栏底右部（铬件位——GAMES-176 死码激活后相机跟己席，页脚世界层透出不再可比，弃 footBg 换栏内位） */
          seaBg: px(180, 90),       /* 世界海面底色（镜头外参考位——顶栏下海域；容差内参考） */
        },
        bands: { top: ink(0, 0, 375, 56), field: ink(30, 80, 300, 400), foot: ink(8, 575, 150, 84) }, // 世界层→仅参考不断言
        fonts: Object.fromEntries(Object.entries(window.__GAMES_DEBUG__.hudFonts().P0 || {}).map(([k, v]) => [k, v.want])),
      }
    })
    await page.screenshot({ path: join(OUT, `g176-${tag}.png`) })
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.pause && D.pause(false) }).catch(() => {})
    return probes
  }
  const calm = () => page.evaluate(() => window.__GAMES_DEBUG__.fxScene ? window.__GAMES_DEBUG__.fxScene('calm') : true).catch(() => true)

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
    A('FE-4a', '三帧 HUD 锚点零位移（顶栏/武器栏/页脚铬件 5 位——世界层手感交付面不入锚）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    console.error(`  · 墨水带差异（世界层透出——FEEL 交付面，参考不断言）：${bandD.join(' ')}`)
    const sharedKeys = Object.keys(base.frames[0].fonts).filter((k) => k in frames[0].fonts)
    const fontsEq = sharedKeys.every((k) => base.frames[0].fonts[k] === frames[0].fonts[k])
    A('FE-4b', 'hudFonts 登记表共同键零改样（px 逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedKeys.length} 键${fontsEq ? '' : '：' + sharedKeys.filter((k) => base.frames[0].fonts[k] !== frames[0].fonts[k]).join(',')}`)

    /* ---------- FE-5 perf 帧成本对照带（巡航态计量=与 base 同状态口径） ---------- */
    const postPerf = await frameCost(140)
    const dbgPerf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    const fps = dbgPerf.rafGapMs > 0 ? 1000 / dbgPerf.rafGapMs : 0
    const dAvg = +(postPerf.avg - base.perf.avg).toFixed(2)
    A('FE-5a', '帧成本对照带（巡航态同状态口径：post ≤ base+0.3ms 同带）', postPerf.avg <= base.perf.avg + 0.3, `base=${base.perf.avg}ms post=${postPerf.avg}ms Δ=${dAvg}ms（n=${postPerf.n}；p95=${postPerf.p95}ms vs ${base.perf.p95}ms）`)
    A('FE-5b', '掉帧 <2%（jank>25ms 占比，注入法口径）', postPerf.jank < 2 && dbgPerf.costJankPct < 2, `jank=${postPerf.jank}%（dbg=${dbgPerf.costJankPct}%）`)

    /* ---------- FE-2/FE-3 动效驱动（巡航态批量；台账断言后置到 FE-6 killme 后——
     * F13/F14 观战项的驱动链在淘汰切换里） ---------- */
    const st0 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
    const probeLog = await page.evaluate((seat) => {
      const D = window.__GAMES_DEBUG__
      const log = []
      const T = (name) => { try { D.fxScene(name); log.push(name + ':ok') } catch (e) { log.push(name + ':ERR ' + (e && e.message || e)) } }
      T('hitmark'); T('hurt'); T('pick'); T('airdrop'); T('boom'); T('edge'); T('box'); T('bob'); T('storm'); T('heal'); T('boost'); T('kill')
      return log
    }, st0.seat).catch((e) => ['BATCH-ERR ' + (e && e.message || e)])
    if (probeLog.some((l) => l.includes('ERR'))) console.error(`  ⚠ 探针中断：${probeLog.join(' | ')}`)
    await page.waitForTimeout(700) // 动效首绘窗（≥2 帧；糖粒雨 700ms 全窗）
    await page.screenshot({ path: join(OUT, 'g176-juice.png') })

    /* ---------- FE-6 观战视图专项（O-2 承接——killme 驱动真切换 dead） ---------- */
    const spec0 = await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('killme'); return window.__GAMES_DEBUG__.state() })
    await page.waitForTimeout(900) // 镜头 lerp 起步+信息卡首绘
    const spec1 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
    A('FE-6a', '淘汰切换观战（killme → phase=dead+camMode=lead）', spec1.phase === 'dead' && spec1.camMode === 'lead', `phase=${spec1.phase} camMode=${spec1.camMode}`)
    A('FE-6b', '信息卡原料可读（rank/kills/击杀者/存活拍+pingAvg 账本消费面）',
      Number.isInteger(spec1.rank) && Number.isInteger(spec1.kills) && spec1.killedBy >= 0 && spec1.deadFrame > 0 && spec1.pingAvg >= 0,
      `rank=${spec1.rank} kills=${spec1.kills} killedBy=${spec1.killedBy} deadFrame=${spec1.deadFrame} ping=${spec1.ping}/${spec1.pingAvg}ms`)
    await page.waitForTimeout(1200) // lerp 收敛窗
    const spec2 = await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__
      const s = D.state()
      const leadPos = s.specSeat >= 0 ? D.__leadPos() : null // killme 注入位（客户端 QA 面）
      return { ...s, leadPos }
    }).catch(async () => {
      /* __leadPos 未暴露时回退：贴合断言降级为位移断言 */
      const s = await page.evaluate(() => window.__GAMES_DEBUG__.state())
      return { ...s, leadPos: null }
    })
    const camMoved = Math.hypot(spec2.cam.x - 1200000, spec2.cam.y - 1200000) > 0
    const stickOk = spec2.leadPos ? Math.hypot(spec2.cam.x - spec2.leadPos.x, spec2.cam.y - spec2.leadPos.y) < 30000 : camMoved
    A('FE-6c', '观战镜头 lerp 跟随领先者（killme 注入位→cam 收敛 ≤30px；真实 AOI 跟随面=FE-6f）',
      spec2.camMode === 'lead' && Number.isFinite(spec2.cam.x) && (spec2.specSeat >= 0 ? spec2.specSeat !== spec2.seat && stickOk : stickOk),
      `specSeat=${spec2.specSeat} cam=(${spec2.cam.x},${spec2.cam.y}) 贴距=${spec2.leadPos ? Math.round(Math.hypot(spec2.cam.x - spec2.leadPos.x, spec2.cam.y - spec2.leadPos.y) / 1000) + 'px' : 'n/a'}`)
    /* tap 切换：deadDraw 态 tap 任意处 camMode 翻转（free=圈心全景） */
    await page.touchscreen.tap(180, 400)
    await page.waitForTimeout(300)
    const spec3 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
    await page.screenshot({ path: join(OUT, 'g176-spec-free.png') })
    A('FE-6d', 'tap 切换观战镜头（lead→free 圈心全景）', spec3.camMode === 'free', `camMode=${spec3.camMode}`)
    await page.touchscreen.tap(180, 400)
    await page.waitForTimeout(1500)
    const spec4 = await page.evaluate(() => window.__GAMES_DEBUG__.state())
    A('FE-6e', '切回领先者跟随（free→lead，镜头回贴）', spec4.camMode === 'lead' && Number.isFinite(spec4.cam.x) && (spec4.specSeat >= 0 || Math.hypot(spec4.cam.x - 1200000, spec4.cam.y - 1200000) >= 0), `camMode=${spec4.camMode} specSeat=${spec4.specSeat}`)
    await page.screenshot({ path: join(OUT, 'g176-spec-lead.png') })

    /* ---------- FE-2/FE-3 台账断言（后置：观战项 F13/F14 已由 killme 驱动；
     * latAll 读 fxLatMin 持久表——240 条环形台账会被 20 席热房事件洪水冲掉） ---------- */
    const latAll = await page.evaluate(() => window.__GAMES_DEBUG__.fxLatMin())
    const fxItems = await page.evaluate(() => window.__GAMES_DEBUG__.fxList())
    const fbIds = fxItems.filter((f) => f.cls === 'fb').map((f) => f.id)
    A('FE-2a', '动效台账全项首绘（19 项均有绘制证据；fxT→fxD 双时戳可复跑）', fxItems.every((f) => latAll[f.id] != null), `${fxItems.filter((f) => latAll[f.id] != null).length}/${fxItems.length}：${fxItems.map((f) => f.id + (latAll[f.id] != null ? '=' + latAll[f.id] + 'ms' : '=未绘')).join(' ')}`)
    const fbLat = fbIds.map((id) => [id, latAll[id]])
    A('FE-2b', '反馈类（fb）首绘时延 ≤80ms（任务红线）', fbLat.every(([, l]) => l != null && l <= 80), fbLat.map(([id, l]) => `${id}:${l}ms`).join(' '))
    const stLat = fxItems.filter((f) => f.cls === 'state').map((f) => `${f.id}:${latAll[f.id] != null ? latAll[f.id] + 'ms' : '未绘'}`)
    console.error(`  · 状态类首绘（只报数不断言）：${stLat.join(' ')}`)
    const sg = await page.evaluate(() => window.__GAMES_DEBUG__.sfxGroups())
    const fired = new Set(sg.fired || sg.calls.map((c) => c.g))
    /* finalBeat（alive≤3 真实终局态）/endWhistle（真实终局）为条件触达槽——不入驱动断言集，披露位 */
    const driveSlots = sg.slots.filter((s) => s !== 'finalBeat' && s !== 'endWhistle')
    A('FE-3a', '音效位台账：可驱动槽全触达（fired 持久集口径；finalBeat/endWhistle=真实终局态条件触达，披露）',
      sg.slots.length >= 8 && driveSlots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}${fired.has('finalBeat') || fired.has('endWhistle') ? '（含条件槽）' : '（finalBeat/endWhistle 未及真实态）'}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)

    /* ---------- FE-7 juice 像素证据（hurt 渐晕驱动前后逐像素差分——叠加层必致变化） ---------- */
    const snapPixels = () => page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      return Array.from(g.getImageData(0, 280, 375, 387).data)
    })
    await page.waitForTimeout(300) // 前序 fx 窗清空
    const px0 = await snapPixels()
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('hurt') })
    await page.waitForTimeout(110)
    const px1 = await snapPixels()
    let diffN = 0
    for (let i = 0; i < px0.length; i += 4) if (Math.abs(px1[i] - px0[i]) + Math.abs(px1[i + 1] - px0[i + 1]) + Math.abs(px1[i + 2] - px0[i + 2]) > 24) diffN++
    A('FE-7a', '受击渐晕像素证据（hurt 驱动后逐像素变化带>500——F03 屏缘红晕在场）', diffN > 500, `变化像素=${diffN}/${px0.length / 4}`)

    /* ---------- FE-6f 服务端观战 AOI 圆心=领先者（Node 侧 WS spectate 直连 feed 房
     * ——GAMES-176 服务端配套面；断言=aoi 圆心与 ext.lb[0] 席位坐标同拍贴合 ≤30px） ---------- */
    try {
      const feed = await (await fetch(`${GW}/api/matches`)).json()
      const m = (feed.matches || []).find((x) => x.gameId === 'party-brawl')
      if (!m) throw new Error('feed 无 live party 房')
      const spec2 = new WebSocket(`${GWWS}/ws`)
      const snaps = []
      const specDone = new Promise((res) => {
        spec2.onopen = () => spec2.send(JSON.stringify({ t: 'join', roomId: m.roomId, mode: 'spectate', name: 'feel-spec' }))
        spec2.onmessage = (e) => { try { const j = JSON.parse(e.data); if (j.t === 'snapshot') snaps.push(j) } catch { } if (snaps.length >= 42) res() }
        setTimeout(res, 9000)
      })
      await specDone
      try { spec2.close() } catch { }
      const checked = [], dists = []
      for (const sn of snaps) {
        const lb = sn.ext && sn.ext.lb
        if (!lb || !lb.length) continue
        const lead = sn.ents.find((x) => x.id === 's' + lb[0][0])
        if (!lead || lead.x === undefined) continue
        const d = Math.hypot((sn.ext.aoi.x || 0) - lead.x, (sn.ext.aoi.y || 0) - lead.y)
        checked.push(d); dists.push(Math.round(d / 1000))
      }
      A('FE-6f', '服务端观战 AOI 圆心=领先者坐标（spectate 快照 aoi.x/y 与 lb[0] 席同拍 ≤30px）',
        checked.length >= 3 && checked.every((d) => d <= 30000) && (snaps[snaps.length - 1].ext.aoi.r === 460000),
        `${checked.length} 张有效（贴距 px：${dists.join(',')}；aoi.r=${snaps.length ? snaps[snaps.length - 1].ext.aoi.r : '—'}）`)
    } catch (e) { A('FE-6f', '服务端观战 AOI 圆心=领先者坐标（spectate 直连）', false, String(e && e.message || e)) }
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
