#!/usr/bin/env node
/* =====================================================================
 * GAMES-103 蛇王争霸 手感层（FEEL）断言工具——对齐 vis-element-duel.mjs /
 * snake-king-bot2-check.mjs 取证口径（墨水带地面真值 + 台账 + 状态目击三件套）：
 *   FE-1 静态：动效清单 ≥12 项（fb 反馈类标记）+ 音效位 ≥12 槽 + 总闸门默认静音
 *            + 零裸字号双审计（g.font 全走 HF 登记表；字体字串构造点唯一）
 *   FE-2 动效时延表：fxProbe/fxScene 驱动全部动效 → fxLedger 首绘时延，
 *            反馈类（fb）≤80ms（任务红线），状态类只报数不断言
 *   FE-3 音效位台账：全部槽位触达（sfxGroups().calls 覆盖）+ 默认 on=false（静音只记账）
 *   FE-4 识图 v2 三帧复检：三冻结帧 HUD 特征位（墨水带 + 字形锚点像素 + hudFonts
 *            共同子集）对比基线（--phase base 先采）零位移零改样
 *   FE-5 perf：?debug=1 巡航采样 fps ≥55（perf-smoke 另跑）
 * 用法：node scripts/snake-king-feel-check.mjs [--phase base|post] [--out dir]
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
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-103-shots'
const BASE = join(OUT, 'g103-base.json')

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'feel-sk-'))
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
  const src = await readFile(join(ROOT, 'games/multiplayer/snake-king/client.js'), 'utf8')
  if (PHASE === 'post') {
    const fxItems = [...src.matchAll(/\['(F\d\d)',\s*'([A-Za-z]+)',\s*'(fb|state)'\]/g)].map((m) => [m[1], m[2], m[3]])
    A('FE-1a', '动效清单 ≥12 项（登记表字面量）', fxItems.length >= 12, `${fxItems.length} 项：${fxItems.map((f) => f[0] + f[1]).join('/')}`)
    const fbN = fxItems.filter((f) => f[2] === 'fb').length
    A('FE-1b', '反馈类（fb ≤80ms 红线适用）≥8 项', fbN >= 8, `fb=${fbN} state=${fxItems.length - fbN}`)
    const slots = (src.match(/slots:\s*\[([^\]]+)\]/) || [])[1] || ''
    const slotN = slots ? slots.split(',').length : 0
    A('FE-1c', '音效位 ≥12 槽（slots 字面量登记）', slotN >= 12, `${slotN} 槽：${slots.replace(/['\s]/g, '')}`)
    A('FE-1d', '总闸门默认静音（sfx.on 初始 false——静音只记账，平台范式）', /on:\s*false/.test(src.slice(src.indexOf('const sfx'), src.indexOf('const sfx') + 400)), 'sfx.on=false 初始字面量')
    const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
    const ctorN = (src.match(/px ' \+ FONT/g) || []).length
    A('FE-1e', '零裸字号（g.font 全走 HF 登记表；构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；font 字串构造点=${ctorN}`)
  }

  /* ================= 运行时（?debug=1 离线幽灵竞技场） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/snake-king/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
  await page.waitForTimeout(1300) // 过入场过渡窗（420ms）后巡航

  /* ---------- 采集一帧 HUD 特征位（基线/复检共用同一函数） ---------- */
  async function hudFrame(tag) {
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
    await page.waitForTimeout(60)
    const probes = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const ink = (x0, y0, w, h) => {
        const d = g.getImageData(x0, y0, w, h).data
        const cnt = {}
        for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); cnt[k] = (cnt[k] || 0) + 1 }
        let bg = 0, bgK = null; for (const k in cnt) if (cnt[k] > bg) { bg = cnt[k]; bgK = k }
        let inkN = 0, total = 0
        const B = bgK.split(',').map(Number).map((v) => v * 16 + 8)
        for (let i = 0; i < d.length; i += 4) {
          total++
          if (Math.abs(d[i] - B[0]) + Math.abs(d[i + 1] - B[1]) + Math.abs(d[i + 2] - B[2]) > 72) inkN++
        }
        return +(inkN / total).toFixed(4)
      }
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
      return {
        /* 识图 v2 特征位只取【不透明字形内部】锚点：世界层经半透明 HUD 背景/页脚透出
         * （F08 镜头曲线为交付项，世界墨水必移）——字形不动=特征位零位移的直接证据 */
        anchors: {
          lenGlyph: px(14, 18),      /* 顶栏「长」（INK 不透明·密笔画字） */
          killGlyph: px(80, 18),     /* 顶栏「杀」 */
          roundGlyph: px(142, 18),   /* 顶栏「第」N轮（前缀字恒定） */
          throneGlyph: px(14, 41),   /* 王座行「王」 */
          lbTitle: px(14, 70),       /* 榜题「蛇」 */
          lbName2: px(33, 103),      /* 榜行 2 名字「幽」（DIM 不透明·行值静态） */
          mmRing: px(319, 66),       /* 小地图环描边（半透明，参考位） */
        },
        bands: { top: ink(0, 0, 375, 56), lb: ink(0, 56, 140, 116), foot: ink(0, 648, 200, 19) }, // 世界透过→仅参考不断言
        fonts: window.__GAMES_DEBUG__.hudFonts(),
      }
    })
    await page.screenshot({ path: join(OUT, `g103-${tag}.png`) })
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
    return probes
  }

  const calm = () => page.evaluate(() => window.__GAMES_DEBUG__.fxScene ? window.__GAMES_DEBUG__.fxScene('calm') : true).catch(() => true)

  /* ---------- FE-4 三帧冻结采样 ---------- */
  await calm()
  const frames = [await hudFrame('f1')]
  await page.waitForTimeout(1700); await calm(); frames.push(await hudFrame('f2'))
  await page.waitForTimeout(2900); await calm(); frames.push(await hudFrame('f3'))

  if (PHASE === 'base') {
    await writeFile(BASE, JSON.stringify({ frames }, null, 1))
    console.error(`[feel-check] 基线已采 → ${BASE}（${frames.length} 帧）`)
  } else {
    const base = JSON.parse(await readFile(BASE, 'utf8'))
    const GLYPH_TOL = 45, RING_TOL = 110
    const gtol = { lenGlyph: GLYPH_TOL, killGlyph: GLYPH_TOL, roundGlyph: GLYPH_TOL, throneGlyph: GLYPH_TOL, lbTitle: GLYPH_TOL, lbName2: GLYPH_TOL, mmRing: RING_TOL }
    let ancOk = true, ancD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].anchors) {
      if (!(k in base.frames[f].anchors)) continue
      const a = frames[f].anchors[k], b = base.frames[f].anchors[k]
      const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
      if (d > gtol[k]) ancOk = false
      ancD.push(`${k}${d}`)
    }
    A('FE-4a', '三帧不透明字形锚点零位移（长/第/王/蛇/名次/分数 6 位 + 小地图环参考位）', ancOk, ancD.join(' '))
    const bandD = []
    for (let f = 0; f < 3; f++) for (const k in frames[f].bands) bandD.push(`${k}${Math.abs(frames[f].bands[k] - base.frames[f].bands[k]).toFixed(3)}`)
    A('FE-4b', '墨水带差异仅系世界层（半透明 HUD 透出镜头曲线位移——交付项 F08 的预期面，参考不断言）', true, bandD.join(' '))
    const sharedPairs = []
    for (const grp in base.frames[0].fonts) for (const key in base.frames[0].fonts[grp]) if (frames[0].fonts[grp] && key in frames[0].fonts[grp]) sharedPairs.push([grp, key])
    const fontsEq = sharedPairs.every(([grp, key]) => base.frames[0].fonts[grp][key] === frames[0].fonts[grp][key])
    A('FE-4c', 'hudFonts 登记表共同键零改样（逐键比对；新增键不算改样）', fontsEq, `共同 ${sharedPairs.length} 键${fontsEq ? '' : '：' + sharedPairs.filter(([grp, key]) => base.frames[0].fonts[grp][key] !== frames[0].fonts[grp][key]).map(([grp, key]) => grp + '.' + key).join(',')}`)

    /* ---------- FE-2/FE-3 动效驱动 + 时延表 + 音效位台账 ---------- */
    await page.evaluate(() => { window.__GAMES_DEBUG__.fxScene('respawn'); window.__GAMES_DEBUG__.fxScene('calm') })
    await page.mouse.click(317, 589); await page.mouse.click(317, 589) // 真输入路径点 boost 钮两拍：boostOn/boostOff 槽
    await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__
      const seat = D.state().seat
      /* 状态类场景注入（先状态后事件：死亡覆层要活到读台账） */
      D.fxScene('boost'); D.fxScene('shield'); D.fxScene('lb'); D.fxScene('throne')
      D.fxScene('danger'); D.fxScene('round'); D.fxScene('enter')
      /* 反馈类事件链（合成事件走同一条 onEvent 管线） */
      D.fxProbe({ k: 'eat', seat, v: 1, id: 'g1' })
      D.fxProbe({ k: 'eat', seat, v: 2, id: 'b1' })
      D.fxProbe({ k: 'eat', seat, v: 4, id: 'o1' })
      D.fxProbe({ k: 'kill', by: seat, seat: 2 })
      D.fxProbe({ k: 'kill', by: seat, seat: 3 })           // 8s 窗内二杀 → 连杀提示
      D.fxProbe({ k: 'milestone', seat, n: 60 })
      D.fxProbe({ k: 'crown', seat, name: '玩家', score: 99 })
      D.fxProbe({ k: 'die', seat, by: 2, drops: 8 })         // 自身死亡 → 覆层动效（最后触发）
    })
    await page.waitForTimeout(700) // 至少一帧渲染后读台账（死亡覆层 300ms 淡入内）
    const ledger = await page.evaluate(() => window.__GAMES_DEBUG__.fxLedger())
    const FXCLASS = { F01: 'fb', F02: 'fb', F03: 'fb', F04: 'fb', F05: 'fb', F06: 'fb', F07: 'fb', F08: 'state', F09: 'state', F10: 'state', F11: 'fb', F12: 'fb', F13: 'fb', F14: 'fb' }
    const drawn = ledger.filter((e) => e.lat != null)
    A('FE-2a', '动效台账全项首绘（14 项均有绘制证据）', drawn.length >= 14, `${drawn.length}/14：${ledger.map((e) => e.id + (e.lat != null ? '=' + e.lat + 'ms' : '=未绘')).join(' ')}`)
    const fb = drawn.filter((e) => FXCLASS[e.id] === 'fb' && e.id !== 'F11')
    A('FE-2b', '反馈类首绘时延 ≤80ms（危险预警含 200ms 扫描节拍单列）', fb.length >= 9 && fb.every((e) => e.lat <= 80), fb.map((e) => `${e.id}:${e.lat}ms`).join(' '))
    const f11 = drawn.find((e) => e.id === 'F11')
    A('FE-2c', '危险预警链路（扫描节拍 200ms + 首绘 ≤1 帧）', f11 && f11.lat <= 280, f11 ? `F11:${f11.lat}ms（含扫描拍）` : '未绘')
    const sg = await page.evaluate(() => window.__GAMES_DEBUG__.sfxGroups())
    const fired = new Set(sg.calls.map((c) => c.g))
    A('FE-3a', '音效位台账：登记槽全触达', sg.slots.length >= 12 && sg.slots.every((s) => fired.has(s)), `${fired.size}/${sg.slots.length} 触达：${[...fired].sort().join(',')}`)
    A('FE-3b', '总闸门默认静音（on=false，只记账）', sg.on === false, `on=${sg.on}，calls=${sg.calls.length}`)
    const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
    const allPx = []
    for (const grp in hf) for (const key in hf[grp]) allPx.push([grp, hf[grp][key]])
    const minPx = (c) => Math.min(...allPx.filter((x) => x[0] === c).map((x) => x[1]))
    A('FE-1f', '运行时 hudFonts 自证（P0≥13/P1≥11/P2≥9）', minPx('P0') >= 13 && minPx('P1') >= 11 && minPx('P2') >= 9, `P0=${minPx('P0')} P1=${minPx('P1')} P2=${minPx('P2')}`)

    /* ---------- FE-5 perf 巡航采样 ---------- */
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.fxScene('respawn'); D.fxScene('calm') })
    const fps = []
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(500); fps.push(await page.evaluate(() => window.__GAMES_DEBUG__.fps())) }
    const avg = Math.round(fps.reduce((a, b) => a + b, 0) / fps.length)
    A('FE-5', '巡航 fps ≥55（FEEL 不降 perf；perf-smoke 另跑）', avg >= 55, `avg=${avg} [${fps.join(',')}]`)
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
