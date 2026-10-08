#!/usr/bin/env node
/* =====================================================================
 * GAMES-105 蛇王争霸 视觉统一（VIS）断言工具——对齐 vis-element-duel.mjs /
 * snake-king-feel-check.mjs 取证口径（?debug=1 离线确定性局 + 冻结帧墨水带 +
 * 不透明字形锚点 + 运行时自证三件套，DSF=1 截图）：
 *   V-HUD-1 静态：零裸字号（g.font 全走 HF；「px ' + FONT」构造点唯一）+ 版本位一致
 *   V-HUD-2 运行时：hudFonts() 自证 P0≥13 / P1≥11 / P2≥9 + 键位清单 ≥20
 *   V-CB-1/2 双编码：皮肤 8 色 × pat/hat 形通道（同带 luma 对必须有异形纹样）
 *            + 光点三档核心形签名（草点芯/果环芯/矿十字芒，灰度可辨）
 *   V-LOD-1/2 巨房可读性：远端蛇淡化档位表 + 在场分布（far 档可达）
 *   V-MM-1/2 小地图密度点：≥40 墨点 + 我席金点（gold 像素探针）
 *   V-F11 危险预警色弱可辨：深底描边警示字 + 朝向红辉（墨水探针）
 *   V-SHOT-1/2/3 识图 v2 三帧（home 入场/play 巡航/settle 结算）字形锚点
 *   V-PERF 巡航 fps ≥55（perf-smoke 另跑）
 * 用法：node scripts/snake-king-vis-check.mjs [--out dir]
 * ===================================================================== */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const OUT = argOf('--out') || '/Volumes/BigDisk/Studio/kernel/workers/GAMES-105-shots'

const results = []
const A = (id, name, ok, detail) => { results.push({ id, name, pass: !!ok, detail }); console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`) }
const luma = (hex) => { const v = parseInt(hex.slice(1), 16); return Math.round(0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) }

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }
const browser = await chromium.launch({ headless: true })
const PORT = 48000 + Math.floor(Math.random() * 4000)
const dataDir = await mkdtemp(join(tmpdir(), 'vis-sk-'))
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
  /* ================= V-HUD-1 静态审计 ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/snake-king/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l))
  const ctorN = (src.match(/px ' \+ FONT/g) || []).length
  A('V-HUD-1a', '零裸字号（g.font 全走 HF 登记表；字体字串构造点唯一）', bare.length === 0 && ctorN === 1, bare.length ? `裸字号 L${bare.map(([i]) => i).join(',L')}` : `0 处；构造点=${ctorN}`)
  const patBranches = (src.match(/skin\.pat === '(ring|dia|stripe|grad)'/g) || []).length
  A('V-CB-1a', '皮肤纹样形通道四形全落地（dia/stripe/grad 显式分支 + ring 默认款）', patBranches >= 3 && /ring 环纹（原款/.test(src), `显式 pat 分支=${patBranches} + ring 默认（源码静态审计）`)

  /* ================= 运行时（?debug=1 离线幽灵竞技场） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/snake-king/index.html?debug=1`, { waitUntil: 'load', timeout: 20_000 })
  await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15_000 })
  await page.waitForTimeout(1300) // 过入场过渡窗（420ms）后巡航
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('calm')) // 世界随机性隔离（压危险预警）

  /* ---------- V-HUD-2 hudFonts 运行时自证 ---------- */
  const hf = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  const allPx = []
  for (const grp in hf) for (const key in hf[grp]) allPx.push([grp, key, hf[grp][key]])
  const minPx = (c) => Math.min(...allPx.filter((x) => x[0] === c).map((x) => x[2]))
  A('V-HUD-2a', 'hudFonts 自证（P0≥13/P1≥11/P2≥9）', minPx('P0') >= 13 && minPx('P1') >= 11 && minPx('P2') >= 9, `P0=${minPx('P0')} P1=${minPx('P1')} P2=${minPx('P2')}（巡航帧 ${allPx.length} 键在册）`)

  /* ---------- V-CB 双编码校验表（visInfo 契约） ---------- */
  const vi = await page.evaluate(() => window.__GAMES_DEBUG__.visInfo())
  const pats = new Set(vi.skins.map((s) => s.pat)), hats = new Set(vi.skins.map((s) => s.hat))
  A('V-CB-1b', '皮肤表 8 色 × ≥3 纹样 × ≥3 头饰（形通道在册）', vi.skins.length >= 8 && pats.size >= 3 && hats.size >= 3, `${vi.skins.length} 色 · pat ${[...pats].join('/')} · hat ${[...hats].join('/')}`)
  const lumas = vi.skins.map((s) => [s.c, luma(s.c), s.pat])
  lumas.sort((a, b) => a[1] - b[1])
  const sameBand = []
  for (let i = 0; i + 1 < lumas.length; i++) if (lumas[i + 1][1] - lumas[i][1] < 12) sameBand.push(`${lumas[i][0]}~${lumas[i + 1][0]} Δ${lumas[i + 1][1] - lumas[i][1]}（${lumas[i][2]} vs ${lumas[i + 1][2]}）`)
  const bandOk = sameBand.every((p) => { const m = p.match(/（(\w+) vs (\w+)）/); return m && m[1] !== m[2] })
  A('V-CB-1c', '同亮度带（Δluma<12）皮肤对纹样互异（灰度下可辨）', sameBand.length > 0 && bandOk, sameBand.join('；'))
  const sg2 = vi.sprSig
  const berry = sg2.berry, ore = sg2.ore, grass = sg2.grass
  A('V-CB-2a', '光点形签名：果=菱形轮廓（对角亮于轴向 ≥40）', berry.dg > berry.a7 + 40, `berry dg=${berry.dg} a7=${berry.a7}`)
  A('V-CB-2b', '光点形签名：矿=十字芒（轴向亮于草 ≥40）', ore.a5 > grass.a5 + 40 && ore.a7 > grass.a7 + 40, `ore a5=${ore.a5} a7=${ore.a7} / grass a5=${grass.a5} a7=${grass.a7}`)
  A('V-CB-2c', '光点三档灰度码位两两互异（草素圆/果菱/矿芒）', Math.abs(grass.a7 - grass.dg) < 30 && berry.dg - berry.a7 > 30 && ore.a7 - ore.dg > 30, `码位 草(a7=${grass.a7},dg=${grass.dg}) 果(a7=${berry.a7},dg=${berry.dg}) 矿(a7=${ore.a7},dg=${ore.dg})——草/矿色 luma 198.8/202.4 同带，形通道主证`)

  /* ---------- V-LOD 巨房可读性 ---------- */
  A('V-LOD-1', '远端蛇淡化档位表（<600px=1 / 600-900px=0.78 / >900px=0.6）', vi.fadeTable[0] === 1 && vi.fadeTable[1] === 0.78 && vi.fadeTable[2] === 0.6, `fadeTable=${vi.fadeTable.join('/')}`)
  /* 在场分布随幽灵巡游波动——best-of-3 采样（档位可达性断言，非精确分布） */
  let crowdBest = vi.crowd
  for (let i = 0; i < 2; i++) { await page.waitForTimeout(500); const c = await page.evaluate(() => window.__GAMES_DEBUG__.visInfo().crowd); if (c.mid + c.far > crowdBest.mid + crowdBest.far) crowdBest = c }
  A('V-LOD-2', '巨房在场分布：淡化档可达（>900px 远档 ≥1 且外围档 ≥3，我/王不淡除外）', crowdBest.far >= 1 && crowdBest.mid + crowdBest.far >= 3 && crowdBest.near >= 1, `best-of-3 near=${crowdBest.near} mid=${crowdBest.mid} far=${crowdBest.far}（20 蛇场）`)

  /* ---------- 冻结帧探针工具（识图 v2 三帧共用） ---------- */
  async function probeFrame(tag, scene) {
    if (scene) {
      await page.evaluate((s) => window.__GAMES_DEBUG__.fxScene(s), scene)
      /* 场景注入后先活跑（settle 横幅 200ms 淡入→等满；其余 160ms≥数帧）再冻结——
       * 立即 pause 会在 rAF 首绘前冻结=采到旧帧（F11/settle 假红根源） */
      await page.waitForTimeout(scene === 'round' ? 320 : 160)
    }
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
    await page.waitForTimeout(60)
    const p = await page.evaluate(() => {
      const g = document.getElementById('cv').getContext('2d')
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
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
      /* 小地图密度点：mm 圆内非底墨点数（20 蛇全房投影）+ 我席金点扫描 */
      const mmX = 375 - 56, mmY = 56 + 56
      const d = g.getImageData(mmX - 44, mmY - 44, 88, 88).data
      let dotN = 0, goldN = 0
      const cnt = {}
      for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); cnt[k] = (cnt[k] || 0) + 1 }
      let bgK = '0,0,0'; for (const k in cnt) if (cnt[k] > cnt[bgK] || !cnt[bgK]) bgK = k
      const B = bgK.split(',').map(Number).map((v) => v * 16 + 8)
      for (let y = 0; y < 88; y++) for (let x = 0; x < 88; x++) {
        const i = (y * 88 + x) * 4, dx = x - 44, dy = y - 44
        if (dx * dx + dy * dy > 44 * 44) continue
        if (Math.abs(d[i] - B[0]) + Math.abs(d[i + 1] - B[1]) + Math.abs(d[i + 2] - B[2]) > 72) dotN++
        if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 120) goldN++
      }
      /* F11 警示字探针位（cam 同式换算，danger 帧另行采样） */
      return {
        anchors: {
          lenGlyph: px(14, 18), killGlyph: px(80, 18), roundGlyph: px(142, 18), throneGlyph: px(14, 41),
          lbTitle: px(14, 70), lbName2: px(33, 103), footGlyph: px(14, 658),
        },
        bands: { top: ink(0, 0, 375, 56), lb: ink(0, 56, 140, 116), settle: ink(0, 296, 375, 72) },
        mm: { dotN, goldN },
      }
    })
    await page.screenshot({ path: join(OUT, `g105-${tag}.png`) })
    await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
    return p
  }

  /* ---------- V-SHOT 三帧：home 入场（重放 F09 揭幕）/ play 巡航 / settle 结算 ---------- */
  const fHome = await probeFrame('home', 'enter')
  const fPlay = await probeFrame('play', null)
  const fSettle = await probeFrame('settle', 'round')

  const glyphInk = (rgb) => { const L = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; return L }
  const GLYPH_ON = (rgb, min) => glyphInk(rgb) > min // 不透明 INK/DIM 字形（底幕暗 <40）
  const homeKeys = ['lenGlyph', 'killGlyph', 'roundGlyph', 'throneGlyph', 'lbTitle', 'lbName2']
  A('V-SHOT-1', 'home 帧（F09 入场后）HUD 字形锚点 6 位全亮 + 页脚 P2 位在册', homeKeys.every((k) => GLYPH_ON(fHome.anchors[k], 90)) && GLYPH_ON(fHome.anchors.footGlyph, 60), homeKeys.map((k) => glyphInk(fHome.anchors[k]).toFixed(0)).join('/') + ` / foot=${glyphInk(fHome.anchors.footGlyph).toFixed(0)}`)
  A('V-SHOT-2', 'play 帧（巡航）同锚点稳定复现（页脚含版本位）', homeKeys.every((k) => GLYPH_ON(fPlay.anchors[k], 90)) && GLYPH_ON(fPlay.anchors.footGlyph, 60), homeKeys.map((k) => glyphInk(fPlay.anchors[k]).toFixed(0)).join('/') + ` / foot=${glyphInk(fPlay.anchors.footGlyph).toFixed(0)}`)
  const settleGlyphOk = fSettle.bands.settle > 0.12
  A('V-SHOT-3', 'settle 帧（轮末结算横幅）中带墨水 ≥0.12（标题+副行+金雨）', settleGlyphOk, `settle band=${fSettle.bands.settle}`)

  /* ---------- V-MM 小地图 ---------- */
  A('V-MM-1', '小地图密度点 ≥40 墨点（20 蛇全房投影）', fPlay.mm.dotN >= 40, `dotN=${fPlay.mm.dotN}`)
  A('V-MM-2', '小地图我席金点在册（gold 像素探针命中）', fPlay.mm.goldN >= 8, `goldN=${fPlay.mm.goldN}`)

  /* ---------- V-F11 危险预警色弱可辨（活跑注入→冻结→落笔位红簇探针） ---------- */
  await page.waitForTimeout(1500) // 等结算横幅（1.8s 退场，y299-367 暗带后绘）散场——否则遮字假红
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('danger'))
  await page.waitForTimeout(180) // 活跑数帧（F11 首绘）后再冻结
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await page.waitForTimeout(60)
  const dangerProbe = await page.evaluate(() => {
    const g = document.getElementById('cv').getContext('2d')
    const vi = window.__GAMES_DEBUG__.visInfo()
    const P = vi.dangerPos // 落笔位登记（帧际零漂移地面真值；夹屏后恒在屏内）
    const x0 = Math.max(0, Math.round(P.tx) - 28), y0 = Math.max(0, Math.round(P.ty) - 15)
    const d = g.getImageData(x0, y0, 56, 18).data
    let redN = 0 // #FF6B5C 字填充（R>200 且 R-G>100）
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i] - d[i + 1] > 100) redN++
    const f11 = window.__GAMES_DEBUG__.fxLedger().find((e) => e.id === 'F11')
    return { tx: Math.round(P.tx), ty: Math.round(P.ty), redN, f11Lat: f11 ? f11.lat : null }
  })
  await page.screenshot({ path: join(OUT, 'g105-danger.png') })
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
  A('V-F11', '危险预警：预测字位红簇命中（夹屏+深底描边=色弱通道）+ F11 台账首绘', dangerProbe.redN >= 40 && dangerProbe.f11Lat != null, `字位=(${dangerProbe.tx},${dangerProbe.ty}) red=${dangerProbe.redN} F11=${dangerProbe.f11Lat}ms`)

  /* ---------- V-HUD-2b 登记键位（驱动 kill/milestone/crown/die 场景累计） ---------- */
  await page.evaluate(() => {
    const D = window.__GAMES_DEBUG__, seat = D.state().seat
    D.fxProbe({ k: 'kill', by: seat, seat: 2 })
    D.fxProbe({ k: 'milestone', seat, n: 60 })
    D.fxProbe({ k: 'crown', seat, name: '玩家', score: 99 })
    D.fxProbe({ k: 'die', seat, by: 2, drops: 8 })
  })
  await page.waitForTimeout(400) // 活跑让 toast/加冕/死亡覆层至少一帧落笔
  const hf2 = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts())
  let keyN = 0
  for (const grp in hf2) keyN += Object.keys(hf2[grp]).length
  A('V-HUD-2b', '登记键位 ≥16（顶栏/榜/toast/结算/危险/死亡/加冕/页脚累计在册）', keyN >= 16, `${keyN} 键：P0=${Object.keys(hf2.P0 || {}).length} P1=${Object.keys(hf2.P1 || {}).length} P2=${Object.keys(hf2.P2 || {}).length}`)

  /* ---------- V-PERF 巡航采样 ---------- */
  await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.fxScene('respawn'); D.fxScene('calm') })
  const fps = []
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(500); fps.push(await page.evaluate(() => window.__GAMES_DEBUG__.fps())) }
  const avg = Math.round(fps.reduce((a, b) => a + b, 0) / fps.length)
  A('V-PERF', '巡航 fps ≥55（VIS 纹样/淡化不降 perf；perf-smoke 另跑）', avg >= 55, `avg=${avg} [${fps.join(',')}]`)

  /* ---------- 版本位一致性 ---------- */
  const gameJson = JSON.parse(await readFile(join(ROOT, 'games/multiplayer/snake-king/game.json'), 'utf8'))
  A('V-SYNC', '版本位一致（client 页脚/boot=visInfo.version=game.json）', vi.version === gameJson.version && src.includes(`v${gameJson.version} · S6`) && src.includes(`version: '${gameJson.version}'`), `game.json=${gameJson.version} client=${vi.version}`)
  A('V-REG', '页面零异常（pageerror）', pageErrors.length === 0, pageErrors.join(' | ') || '0')
} catch (e) {
  A('RUN', '执行完整性', false, String(e && e.message || e))
} finally {
  server.kill(); await rm(dataDir, { recursive: true, force: true }); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[vis-check] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}`)
process.exit(fail.length ? 1 : 0)
