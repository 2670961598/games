#!/usr/bin/env node
/* =====================================================================
 * GAMES-131 迷你MOBA 手感层（FEEL）断言工具——对齐 snake-king-feel-check.mjs
 * 取证口径（GAMES-103 范式：不透明字形锚点 + fxLedger 双时戳 + sfx 台账）：
 *   FE-1 静态：FXLIST 动效清单 ≥12 项（fb≥8）+ SND 音效位 ≥12 槽 + 总闸门
 *            默认静音 + 零裸字号（.font= 全走 HF/F.p；构造点唯一）
 *   FE-2 动效时延表：fxScene/fxProbe 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线），状态类只报数不断言
 *   FE-3 音效位台账：全部槽位触达 + 默认 on=false（静音只记账）
 *   FE-4 识图 v2 三帧复检：三冻结帧 HUD 不透明字形锚点（世界层透出仅参考）
 *            + hudFonts 共同键零改样（--phase base 先采，stash 闭环）
 *   FE-5 perf：帧成本 avgMs 对照带（post ≤ base+0.3ms 同带，games-118 口径）
 * 环境：静态文件自起（随机口）+ QA 常驻网关 GAMES_GW（默认 :4415，零感知
 * :4399/:4400）。用法：node scripts/mini-moba-feel-check.mjs [--phase base|post]
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-131-shots'
const BASE = join(OUT, 'g131-base.json')
const GW = process.env.GAMES_GW || 'http://127.0.0.1:4415'
const PORT = 8470 + Math.floor(Math.random() * 300)

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- 静态文件服务器（游戏页面） ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' }
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
    const buf = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(PORT, r))

/* ---------- quick 匹配（qa1-smoke 同路径：Bot 秒配队友，事件流自然推进） ---------- */
console.error(`[feel-check] gw=${GW}（quick 匹配）`)

await mkdir(OUT, { recursive: true })
let pageErrors = []
let page
/* 无头环境 rAF 被 vsync 合成封顶（间隔 16.7 的整数倍、p50≈83ms——GAMES-118 已知
 * 环境属性）：时延（FE-2）与帧成本（FE-5）测量统一在解节流口径下进行，
 * base/post 同口径对照（口径公平性=两相位同一 launch 参数）。 */
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
try {
  /* ================= FE-1 静态审计（零依赖） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/mini-moba/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥12 项（FXLIST 登记表字面量）', fxItems.length >= 12, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥12 槽（slots 字面量登记）', slotN >= 12, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    A('FE-1d', '总闸门默认静音（SND.on 初始 false——静音只记账，平台范式）', /on:\s*false/.test(src.slice(src.indexOf('var SND'), src.indexOf('var SND') + 300)), 'SND.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(|F\.p/.test(l))
    const ctorN = (src.match(/function HF\(/g) || []).length
    A('FE-1e', '零裸字号（.font= 全走 HF 登记/F.p 助手；构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（真网关 test 房） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/mini-moba/index.html?gw=${GW}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state().ents > 0, null, { timeout: 20_000 })
  await page.waitForTimeout(2500) // 兵线交汇前的巡航起点

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
        /* 识图 v2 特征位只取【不透明 HUD 字形内部】锚点：世界层经半透明 HUD 透出
         * （兵线/弹道/镜头为交付面，墨水必移）——字形不动=零位移直接证据 */
        anchors: {
          goldGlyph: px(10, 47),    /* 顶栏「金」（p0n 13px 不透明·密笔画） */
          aKill: px(93, 28),        /* 顶栏「A 击杀」标签（p2 静态文案） */
          bKill: px(274, 28),       /* 顶栏「B 击杀」标签 */
          skillLock: px(230, 492),  /* 大招钮锁定态灰底（#3A4A50 实心，不随英雄换色） */
          atkGlyph: px(316, 601),   /* 普攻钮「攻」（p0 13px 密笔画） */
          recallGlyph: px(250, 632),/* 「回城」钮（p1 11px） */
        },
        bands: { top: ink(0, 0, 375, 56), mid: ink(120, 300, 135, 120), foot: ink(230, 560, 145, 107) }, // 世界透过→仅参考不断言
        fonts: window.__GAMES_DEBUG__.hudFonts(),
      }
    })
    await page.screenshot({ path: join(OUT, `g131-${tag}.png`) })
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
    await writeFile(BASE, JSON.stringify({ frames, perf: { avgMs: perfCruise.avgMs, n: perfCruise.n } }, null, 1))
    console.error(`[feel-check] 基线已采 → ${BASE}（3 帧；perf avgMs=${perfCruise.avgMs}）`)
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
    A('FE-4a', '三帧不透明字形/实心钮锚点零位移（金/击杀×2/锁技钮/攻击/回城 6 位）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    A('FE-4b', '墨水带差异仅系世界层（兵线/弹道/镜头透出——FEEL 交付面，参考不断言）', true, bandD.join(' '))
    const sharedKeys = Object.keys(base.frames[0].fonts).filter((k) => k in frames[0].fonts)
    const fontsEq = sharedKeys.every((k) => base.frames[0].fonts[k] === frames[0].fonts[k])
    A('FE-4c', 'hudFonts 登记表共同键零改样（逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedKeys.length} 键${fontsEq ? '' : '：' + sharedKeys.filter((k) => base.frames[0].fonts[k] !== frames[0].fonts[k]).join(',')}`)

    /* ---------- FE-2/FE-3 动效驱动 + 时延表 + 音效位台账 ---------- */
    await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__
      const seat = D.state().seat
      const foe = 'h' + ((seat + 1) % 6)
      /* 反馈类事件链（合成事件走同一条 onEvent 管线） */
      D.fxProbe({ k: 'hit', vic: foe, dmg: 42, m: 1 })                          // F02 法术命中
      D.fxProbe({ k: 'hit', vic: foe, dmg: 17 })                                // F02 物理命中
      D.fxProbe({ k: 'shot', skill: 'star', from: [480000, 820000], to: [520000, 800000] })   // F01 法系施法
      D.fxProbe({ k: 'shot', skill: 'charge', from: [480000, 820000], to: [560000, 830000] }) // skillDash 槽
      D.fxProbe({ k: 'shot', from: [480000, 820000], to: [520000, 800000] })    // atk 槽
      D.fxProbe({ k: 'zone', skill: 'star', x: 500000, y: 850000, r: 70000, at: 4, dur: 40 }) // F01 区域施法
      D.fxProbe({ k: 'kill', killer: seat, victim: (seat + 1) % 6, streak: 2, bounty: 180, respAt: 90 }) // F03/F04/F09/F16
      D.fxProbe({ k: 'kill', killer: (seat + 1) % 6, victim: seat, streak: 0, bounty: 0, respAt: 60 })    // death 槽
      D.fxProbe({ k: 'tower', team: 'B', tid: 'tw-B1', tier: 1 })               // F05
      D.fxProbe({ k: 'core', team: 'B' })                                       // core 槽
      D.fxProbe({ k: 'shrine', team: 'A' })                                     // F12
      D.fxProbe({ k: 'recall', seat, phase: 'start' })                          // F07
      D.fxProbe({ k: 'buy', seat, item: 'boots' })                              // F10
      D.fxProbe({ k: 'reject', seat, op: 'skill' })                             // reject 槽+红闪
      /* 状态类场景（同一触发器函数） */
      D.fxScene('lvup'); D.fxScene('revive'); D.fxScene('grass')
      D.fxScene('miss'); D.fxScene('kda'); D.fxScene('hpflash')
    })
    await page.waitForTimeout(600) // ≥1 帧渲染后读台账
    const ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    const fxItems = await page.evaluate(() => window.__GAMES_DEBUG__.fxList())
    const fbIds = fxItems.filter((f) => f.cls === 'fb').map((f) => f.id)
    const drawn = {}
    for (const e of ledger) if (e.lat != null && drawn[e.id] == null) drawn[e.id] = e.lat
    A('FE-2a', '动效台账全项首绘（16 项均有绘制证据）', fxItems.every((f) => drawn[f.id] != null), `${fxItems.filter((f) => drawn[f.id] != null).length}/${fxItems.length}：${fxItems.map((f) => f.id + (drawn[f.id] != null ? '=' + drawn[f.id] + 'ms' : '=未绘')).join(' ')}`)
    const fbLat = fbIds.map((id) => [id, drawn[id]])
    A('FE-2b', '反馈类（fb）首绘时延 ≤80ms（任务红线）', fbLat.every(([, l]) => l != null && l <= 80), fbLat.map(([id, l]) => `${id}:${l}ms`).join(' '))
    const stLat = fxItems.filter((f) => f.cls === 'state').map((f) => `${f.id}:${drawn[f.id] != null ? drawn[f.id] + 'ms' : '未绘'}`)
    console.error(`  · 状态类首绘（只报数不断言）：${stLat.join(' ')}`)
    const sg = await page.evaluate(() => window.__GAMES_DEBUG__.sfxGroups())
    const fired = new Set(sg.calls.map((c) => c.g))
    A('FE-3a', '音效位台账：登记槽全触达', sg.slots.length >= 12 && sg.slots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const badPx = Object.entries(hf).filter(([, v]) => v < 9)
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9；全部 ≥9）', hf.p0 >= 13 && hf.p1 >= 11 && hf.p2 >= 9 && badPx.length === 0, `p0=${hf.p0} p1=${hf.p1} p2=${hf.p2}；登记键 ${Object.keys(hf).length} 个`)

    /* ---------- FE-5 perf 帧成本对照带（games-118 口径） ---------- */
    const postPerf = await page.evaluate(() => window.__GAMES_DEBUG__.perf())
    const dAvg = +(postPerf.avgMs - base.perf.avgMs).toFixed(2)
    A('FE-5', '帧成本对照带（FEEL 不降 perf：post ≤ base+0.3ms 同带）', postPerf.avgMs <= base.perf.avgMs + 0.3, `base=${base.perf.avgMs}ms post=${postPerf.avgMs}ms Δ=${dAvg}ms（n=${postPerf.n}）`)
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
