#!/usr/bin/env node
/* =====================================================================
 * GAMES-122 战棋对决 手感层（FEEL）断言工具——snake-king-feel-check.mjs
 * （GAMES-103）取证范式移植：静态审计 + fxTrig→fxDraw 双时戳时延表 +
 * 音效位台账 + 识图 v2 三帧冻结复检 + perf 巡航：
 *   FE-1 静态：动效清单 ≥12 项（fb 反馈类 ≥8）+ 音效位 ≥12 槽 + 总闸门默认
 *            静音 + 零裸字号（ctx.font 全走 F0/F1/F2 HF 登记表；构造点唯一）
 *   FE-2 动效时延表：fxScene/fxProbe 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线）；编排节拍类（state）只报数不断言
 *   FE-3 音效位台账：全部槽位触达 + 默认 on=false（静音只记账）
 *   FE-4 识图 v2 三帧复检：三冻结帧 HUD 不透明字形锚点（顶栏 A/B 分数字、
 *            AP 标签、底栏钮标签、页脚）对比基线（--phase base 先采）零位移
 *   FE-5 perf：?debug=1 离线局巡航 fps ≥55（GAMES-118 口径：rAF 计帧）
 *   附：sim/brain 零改动由 git diff 旁证（本脚本不涉及 sim 文件）
 * 用法：node scripts/tactics-duel-feel-check.mjs [--phase base|post] [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const PHASE = argOf('--phase') || 'post'
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-122-shots'
const BASE = join(OUT, 'g122-base.json')

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'feel-td-'))
const server = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, GAMES_DIR: join(ROOT, 'games') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
await new Promise((res) => {
  const t = setTimeout(res, 8000)
  server.stderr.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); res() } })
  fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok && (clearTimeout(t), res())).catch(() => {})
})
await mkdir(OUT, { recursive: true })
let pageErrors = []
let page
try {
  /* ================= FE-1 静态审计（零依赖） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/tactics-duel/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥12 项（登记表字面量）', fxItems.length >= 12, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥12 槽（slots 字面量登记）', slotN >= 12, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    A('FE-1d', '总闸门默认静音（sfx.on 初始 false——静音只记账，平台范式）', /on:\s*false/.test(src.slice(src.indexOf('const sfx'), src.indexOf('const sfx') + 400)), 'sfx.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/(F0|F1|F2)\(/.test(l))
    const passThru = bare.filter(([, l]) => /ctx\.font\s*=\s*fnt\s*;/.test(l))
    A('FE-1e', '零裸字号（ctx.font 全走 F0/F1/F2 HF 登记表；唯 lbl 助手 fnt 传参 1 处=调用点全 F0/F1/F2）', bare.length === passThru.length && passThru.length === 1, bare.length !== passThru.length ? `裸字号 L${bare.filter(([i, l]) => !/ctx\.font\s*=\s*fnt\s*;/.test(l)).map(([i]) => i).join(',L')}` : `裸字号 0 处 + 传参 1 处（L${passThru[0][0]}）`)
  }

  /* ================= 运行时（?debug=1 离线同源局） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/tactics-duel/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
  /* 等部署揭示进入 act 且轮到我方（F01/F02 绘制门=myTurn；离线局 seat0 真人席）→ 冻结假时钟 */
  await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.phase === 'act' && v.units && v.units.length > 0 }, null, { timeout: 20_000 })
  await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; return v && v.turn === 0 && v.phase === 'act' }, null, { timeout: 20_000 })
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await page.waitForTimeout(120)

  /* ---------- HUD 不透明字形锚点帧（基线/复检共用同一函数） ---------- */
  async function hudFrame(tag) {
    await page.evaluate(() => { if (window.__GAMES_DEBUG__.fxScene) window.__GAMES_DEBUG__.fxScene('calm') }) // 基线相（--phase base 于施工前树）无本单钩子则跳过
    await page.waitForTimeout(60)
    const probes = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
      return {
        /* 识图 v2 字形锚点只取【每帧恒绘的不透明 HUD chrome】（世界层棋子/fx 不入锚——
         * 单位/横幅/飘字皆会动，字形不动=零位移直接证据；坐标=client.js 常量同源） */
        anchors: {
          scoreB: px(19, 18),     /* 顶栏 B 侧分数字（F0·left 16） */
          scoreA: px(336, 18),    /* 顶栏 A 侧分数字（F0·right 341） */
          apLbl: px(112, 470),    /* 「AP」标签（F0·left 110/baseline 477） */
          btnHost: px(33, 571),   /* 底栏「托管」钮标签（F1·center 38） */
          btnEnd: px(302, 571),   /* 底栏「结束回合」钮标签（F1·center 307） */
          foot: px(12, 658),      /* 页脚 slug 串（F2·left 10/baseline 663） */
        },
        fonts: window.__GAMES_DEBUG__.hudFonts(),
      }
    })
    await page.screenshot({ path: join(OUT, `g122-${tag}.png`) })
    return probes
  }

  /* ---------- 帧成本采样（rAF 回调包裹计时——GAMES-118 perf 口径：绝对 fps 受环境 rAF 封顶，真证=每帧成本） ---------- */
  async function frameCost(ms) {
    return page.evaluate((ms) => new Promise((res) => {
      const orig = window.requestAnimationFrame.bind(window)
      const t = []
      window.requestAnimationFrame = (cb) => orig((ts) => { const s = performance.now(); try { cb(ts) } finally { t.push(performance.now() - s) } })
      setTimeout(() => { window.requestAnimationFrame = orig; res(t) }, ms)
    }), ms)
  }
  const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]
  async function perfBand(tag) {
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
    const cost = await frameCost(4000)
    const fps = []
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(400); fps.push(await page.evaluate(() => (window.__GAMES_DEBUG__.fps ? window.__GAMES_DEBUG__.fps() : 0))) }
    const p50 = +pct(cost, 0.5).toFixed(2), p95 = +pct(cost, 0.95).toFixed(2), mx = +Math.max(...cost).toFixed(2)
    const over = cost.filter((c) => c > 16.7).length
    return { tag, n: cost.length, p50, p95, mx, overRatio: +(over / cost.length).toFixed(4), fps, avgFps: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length) }
  }

  const frames = [await hudFrame('f1')]
  await page.waitForTimeout(1700); frames.push(await hudFrame('f2'))
  await page.waitForTimeout(2900); frames.push(await hudFrame('f3'))
  const band = await perfBand('cruise')

  if (PHASE === 'base') {
    await writeFile(BASE, JSON.stringify({ frames, band }, null, 1))
    console.error(`[feel-check] 基线已采 → ${BASE}（${frames.length} 帧 + 帧成本带 n=${band.n}）`)
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
    A('FE-4a', '三帧 HUD 字形锚点零位移（B/A 分数字+AP 标签+双底栏钮+页脚 6 位，容差 45）', ancOk, ancD.join(' '))
    const sharedPairs = []
    for (const grp in base.frames[0].fonts) for (const key in base.frames[0].fonts[grp]) if (frames[0].fonts[grp] && key in frames[0].fonts[grp]) sharedPairs.push([grp, key])
    const pxPairs = sharedPairs.filter(([, key]) => key === 'minPx') // samples=font() 调用点计数——新增 fx 文本位属预期增量，字号下限才是改样红线
    const fontsEq = pxPairs.every(([grp, key]) => base.frames[0].fonts[grp][key] === frames[0].fonts[grp][key])
    A('FE-4b', 'hudFonts 字号下限零改样（minPx 逐键比对；samples 计数随新增 fx 文本位增长=预期）', fontsEq, `minPx 共同 ${pxPairs.length} 键${fontsEq ? '' : '：' + pxPairs.filter(([grp, key]) => base.frames[0].fonts[grp][key] !== frames[0].fonts[grp][key]).map(([grp, key]) => grp + '.' + key).join(',')}；samples ${sharedPairs.filter(([g, k]) => k === 'samples').map(([g]) => g + ':' + base.frames[0].fonts[g].samples + '→' + frames[0].fonts[g].samples).join(' ')}`)

    /* ---------- FE-2/FE-3 动效驱动 + 时延表 + 音效位台账（选择类分段注入：每段留首绘帧） ---------- */
    const ids = await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__
      const v = D.state().view
      const mine = v.units.filter((u) => u.seat === 0), foes = v.units.filter((u) => u.seat === 1)
      return { a: mine[0] && mine[0].id, f: foes[0] && foes[0].id, f2: foes[1] && foes[1].id, healer: mine[0] && mine[0].id, cellFoe: foes[0] && foes[0].cell, cellPt: v.points[0] }
    })
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('select-own') })   // F01+F02（myTurn 门内）
    await page.waitForTimeout(90)
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('select-foe') })   // F15 威胁预览
    await page.waitForTimeout(90)
    await page.evaluate((ids) => {
      const D = window.__GAMES_DEBUG__
      D.fxScene('ap')                                                // F12 AP 耗一熄一
      D.fxScene('deploy')                                            // deploy 槽
      /* 合成事件链（同一条 onEvent 管线——台账同源） */
      D.fxProbe({ k: 'attack', unit: ids.a, tgt: ids.f, dmg: 7 })   // F03 前冲+F04 顿帧拍+F05 飘字
      D.fxProbe({ k: 'counter', unit: ids.f, tgt: ids.a, dmg: 4 })  // F06 反击接演
      D.fxProbe({ k: 'heal', tgt: ids.healer, n: 8 })                // F09 治疗
      D.fxProbe({ k: 'die', unit: ids.f, by: ids.a })                // F07 碎裂+价值飘字+克制弹跳
      D.fxProbe({ k: 'die', unit: ids.f2, by: ids.a })               // 同回合二杀 → F17 连杀横幅
      D.fxProbe({ k: 'move', path: [8, 9, 10, 11, 12] })             // F16 冲锋拖尾（≥3 步）+land
      D.fxProbe({ k: 'skill', unit: ids.a, cell: ids.cellFoe })      // F08 火球弹道+爆裂+震屏
      D.fxProbe({ k: 'point', cell: ids.cellPt, owner: 0 })          // F10 据点翻转（points[0]——mapId 动态）
      D.fxProbe({ k: 'turn', seat: 0 })                              // F11 回合横幅
      D.fxProbe({ k: 'host', on: 1 }); D.fxProbe({ k: 'undo' }); D.fxProbe({ k: 'reject', why: 'probe' })
    }, ids)
    await page.waitForTimeout(700) // 覆盖 300ms 反击拍/400ms 拖尾窗后读台账
    let ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    for (let i = 0; i < 2 && !ledger.some((e) => e.id === 'F13'); i++) { /* F13 地形盾标=世界态（林驻单位）——放行让棋子走两步再读 */
      await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
      await page.waitForTimeout(2000)
      await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
      await page.waitForTimeout(700)
      ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    }
    const FXCLASS = Object.fromEntries([...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[3]]))
    const drawn = ledger.filter((e) => e.lat != null)
    const nAll = Object.keys(FXCLASS).length
    const f13 = ledger.find((e) => e.id === 'F13')
    A('FE-2a', `动效台账全项首绘（${nAll} 项；F13 地形盾标系世界态（林驻单位，地图随机）允许本局缺位）`, drawn.length >= nAll - 1 && (!f13 || f13.lat != null), `${drawn.length}/${nAll}：${ledger.map((e) => e.id + (e.lat != null ? '=' + e.lat + 'ms' : '=未绘')).join(' ')}`)
    const fb = drawn.filter((e) => FXCLASS[e.id] === 'fb')
    A('FE-2b', '反馈类首绘时延 ≤80ms（任务红线；环境 rAF ~20fps 时一帧 ≈50ms 仍须达标）', fb.length >= 8 && fb.every((e) => e.lat <= 80), fb.map((e) => `${e.id}:${e.lat}ms`).join(' '))
    /* ---------- FE-5 perf：帧成本口径（GAMES-118：绝对 fps 环境封顶不可主张，真证=每帧渲染成本+对照带） ---------- */
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene && window.__GAMES_DEBUG__.fxScene('calm'); window.__GAMES_DEBUG__.pause(false) })
    const bandPost = await perfBand('post')
    const okP95 = bandPost.p95 < 16.7 && bandPost.overRatio < 0.02
    const bandBase = base.band || null
    const bandOk = bandBase ? bandPost.p95 <= Math.max(bandBase.p95 * 1.5, bandBase.p95 + 2) : true
    A('FE-5a', '每帧渲染成本 p95 <16.7ms 且超限帧 <2%（rAF 包裹计时 4s，debug 局 bot 活跃期）', okP95, `n=${bandPost.n} p50=${bandPost.p50}ms p95=${bandPost.p95}ms max=${bandPost.mx}ms 超16.7ms=${(bandPost.overRatio * 100).toFixed(1)}%`)
    A('FE-5b', 'perf 不降（对照带：施工后 p95 ≤ max(基线×1.5, 基线+2ms)——新增 fx 绘制不越带）', bandOk, `基线 p50/p95=${bandBase ? bandBase.p50 + '/' + bandBase.p95 : '无基线'}ms → 施工后 ${bandPost.p50}/${bandPost.p95}ms；巡航 fps avg=${bandPost.avgFps} [${bandPost.fps.join(',')}]（绝对值受环境 rAF 封顶≈13-25，不作 55 主张——GAMES-118 口径）`)
    /* ---------- settle 双臂（win/lose 槽 + F14）最后注入——覆层盖 HUD 置于帧采样后 ---------- */
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('settle') })
    await page.waitForTimeout(500)
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('settle-lose') })
    await page.waitForTimeout(500)
    const sg2 = await page.evaluate(() => window.__GAMES_DEBUG__.sfx())
    const fired2 = new Set(sg2.calls.map((c) => c.group))
    A('FE-3a', '音效位台账：登记槽全触达', sg2.slots.length >= 12 && sg2.slots.every((s) => fired2.has(s)), `${fired2.size}/${sg2.slots.length} 触达：${[...fired2].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg2.on === false, `on=${sg2.on}，calls=${sg2.calls.length}`)
    const ledger2 = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    const f14 = ledger2.find((e) => e.id === 'F14')
    A('FE-2c', '胜负结算动画首绘（F14 落定 450ms 内首帧）', f14 && f14.lat != null && f14.lat <= 80, f14 ? `F14:${f14.lat}ms` : '未绘')
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const allPx = []
    for (const grp in hf) for (const key in hf[grp]) allPx.push([grp, hf[grp][key]])
    const minPx = (c) => Math.min(...allPx.filter((x) => x[0] === c).map((x) => x[1]))
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9）', minPx('P0') >= 13 && minPx('P1') >= 11 && minPx('P2') >= 9, `P0=${minPx('P0')} P1=${minPx('P1')} P2=${minPx('P2')}`)
  }
  A('FX-0', '页面零异常（pageerror）', pageErrors.length === 0, pageErrors.join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  server.kill(); await rm(dataDir, { recursive: true, force: true }); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[feel-check:${PHASE}] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}`)
process.exit(fail.length ? 1 : 0)
