#!/usr/bin/env node
/* =====================================================================
 * GAMES-179 派对大乱斗 VIS——识图终审：全状态截图谱+像素核双证（≥24 面）
 * 对齐 deep-foodchain（GAMES-169）/street-soccer（GAMES-143）取证口径：
 * 网关 quick bot 房真局全乘（GAMES-176 feel-check 同环境；games-84 纪律——
 * 本单零 sim/渲染改动〔唯一增量=fxScene('victim') QA 注入面，killme 同式〕，
 * 常驻 :4400 即验证网关）。
 *   §A HF 体系核（6）：__applied 全键生效自证（Q-013 第三作口径）+P0≥13、
 *      P1≥11、P2≥9+零裸字号静态审计+24 键运行时覆盖（boot→ended 全相位触达）
 *   §B 双编码三组（6）：亮色竞技场基调（海/草/沙+中位 luma——T7 平台首款亮色）+
 *      己席白圈（阵营形状通道——皮肤 #FFF3D6 与 SKINS[6] 撞色靠环区分）+
 *      皮肤调色板 8 色两两可辨（静态 pairwise）+毒圈实线 vs 虚线双通道+
 *      圈外斜纹罩 vs 圈内零罩+箱方双编码（行宽签名+武器色描边）
 *   §C FEEL 19 项 FX 抽验（9）：受击闪白/命中三连/爆炸环/KO 大字/糖粒雨/
 *      拾取浮标（chevron+钮）/拾取确认环/毒圈警示渐晕/空投金圈/医疗+加速/箱弹出
 *      （≥票面 6 态下限，冻结帧差分对账——base 同态对照）
 *   §D 状态谱（6）：开局 lobby 全景/对战中（控件三钮）/缩圈各相位（自然 P0→S1→S2+
 *      确定性场 mid/late）/观战位（淘汰信息卡+跟领先者+圈心全景 tap）/终局战报
 *   §E 谱系一致（2）：HUD 4 锚跨态零位移（live vs dead）+页面零异常
 * 用法：node scripts/party-brawl-vis-check.mjs [--gw ws://127.0.0.1:4400]
 * 截图：/Volumes/BigDisk/Studio/kernel/workers/GAMES-179-shots/
 * ===================================================================== */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const GW = argOf('--gw') || 'ws://127.0.0.1:4400'
const OUT = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-179-shots'
const EVID = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-179'
const PORT = 9260 + Math.floor(Math.random() * 300)

const results = []
const A = (id, name, ok, detail) => {
  const rec = { id, name, pass: !!ok, detail }
  const ex = results.findIndex((r) => r.id === id)
  if (ex >= 0) results[ex] = rec; else results.push(rec)
  console.error(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

console.error(`[vis-check] gw=${GW}（quick 匹配 bot 房——全状态真局乘）`)
await mkdir(OUT, { recursive: true }); await mkdir(EVID, { recursive: true })
const pageErrors = []
const shots = []
const PX_SRC = `window.__PX__ = (() => { const g = document.getElementById('cv').getContext('2d')
  const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]] }
  const mx = (x, y, r = 2) => { const d = g.getImageData(x - r, y - r, r * 2 + 1, r * 2 + 1).data; let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); return Math.round(m) }
  const cnt = (x0, y0, w, h, cls) => { const d = g.getImageData(x0, y0, w, h).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (cls(d[i], d[i + 1], d[i + 2])) n++; return n }
  const lumaMed = (y, x0 = 0, w = 375) => { const d = g.getImageData(x0, y, w, 1).data; const a = []; for (let i = 0; i < d.length; i += 4) a.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); a.sort((p, q) => p - q); return +a[a.length >> 1].toFixed(1) }
  const ring3 = (cx, cy, R, cls) => { let best = 0; for (const rr of [R - 1, R, R + 1]) { let hit = 0, tot = 0; for (let a = 0; a < 360; a += 10) { tot++; const p = px(cx + Math.cos(a * Math.PI / 180) * rr, cy + Math.sin(a * Math.PI / 180) * rr); if (cls(p[0], p[1], p[2])) hit++ } best = Math.max(best, hit / tot) } return +best.toFixed(2) }
  /* 探针组合件（page 域——evaluate 闭包不可跨 Node 作用域） */
  const cornerRed = () => { let n = 0; for (const [x0, y0, w, h] of [[0, 180, 26, 160], [349, 180, 26, 160], [0, 480, 26, 140], [349, 480, 26, 140]]) n += cnt(x0, y0, w, h, (r, g, b) => r > g + 18 && r > b + 10 && r > 60); return n }
  const centerWhite = () => cnt(176, 322, 24, 24, (r, g, b) => r >= 250 && g >= 245 && b >= 225)
  const banPair = () => ({ dark: cnt(30, 203, 315, 34, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 110), white: cnt(30, 203, 315, 34, (r, g, b) => r > 230 && g > 230 && b > 230) })
  const confetti = () => cnt(168, 288, 90, 80, (r, g, b) => (r > 190 && r > g + 30) || (r > 230 && g > 200 && b < 150) || (r > 150 && b > 190 && r > g + 20))
  const chev = () => cnt(186, 300, 40, 34, (r, g, b) => g > 222 && b > 145 && r < 185)
  const pickBtnPx = () => cnt(292, 478, 62, 62, (r, g, b) => g > 190 && r < 175 && b > 140)
  const gold = () => cnt(150, 240, 170, 130, (r, g, b) => r > 200 && g > 170 && b < 110 && r - b > 110)
  return { px, mx, cnt, lumaMed, ring3, cornerRed, centerWhite, banPair, confetti, chev, pickBtnPx, gold } })()`
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
let page
/* 冻结帧采样器（GAMES-103 范式+GAMES-169 复绘窗坑：改态后 ≥90ms 再冻结；截图在冻结窗内拍——探针/截图同帧） */
const freeze = async (fn, shotName, arg) => {
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(true))
  await sleep(90)
  const r = await page.evaluate(fn, arg)
  if (shotName) { await page.screenshot({ path: join(OUT, shotName) }); shots.push(shotName); console.error(`  📸 ${shotName}`) }
  await page.evaluate(() => window.__GAMES_DEBUG__.pause(false))
  return r
}
/* 无头 rAF 停摆护栏（games-147/172 系——Run 6 实证：驱动窗整段无新帧=差分恒 0）：驱动前确认活帧（rafN 单调计数） */
const drawnGate = async (minFrames = 3, timeoutMs = 3000) => {
  const n0 = await page.evaluate(() => window.__GAMES_DEBUG__.perf().rafN)
  for (let t = 0; t < timeoutMs; t += 150) {
    await sleep(150)
    const n = await page.evaluate(() => window.__GAMES_DEBUG__.perf().rafN)
    if (n - n0 >= minFrames) return true
  }
  return false
}
const anchors = () => {
  const P = window.__PX__
  return { topBg: P.mx(5, 5), aliveTxt: P.mx(9, 44), wpnBg: P.mx(16, 580) } // hp 读数锚剔除：dead 态顶栏 hp 退场（内容缺席非位移——Run 8 自然死亡实证；killme 死亡 Run 4 偶白=S.me.hp 残留假象）
}

try {
  /* ================= §A 静态审计（零依赖） ================= */
  const src = await readFile(join(ROOT, 'games/multiplayer/party-brawl/client.js'), 'utf8')
  const bare = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.font\s*=/.test(l) && !/HF\(/.test(l) && !/ctx\.font\s*=\s*font/.test(l))
  const ctorN = (src.match(/function HF\(/g) || []).length
  const STATIC_KEYS = ['dmg', 'heal', 'banner', 'hp', 'alive', 'ping', 'wname', 'ammo', 'bag', 'lb', 'foot', 'feed', 'pip', 'fire', 'skl', 'pick', 'dead', 'deadsub', 'deadcta', 'end', 'endrep', 'endcta', 'boot', 'pingavg']
  const missStatic = STATIC_KEYS.filter((k) => !new RegExp(`'${k}'`).test(src))
  A('A5', '零裸字号静态审计（.font= 全走 HF+构造点唯一+静态键全集 24 键无缺）',
    bare.length === 0 && ctorN === 1 && missStatic.length === 0,
    bare.length ? `裸字号 L${bare.map(([i]) => i).join(',')}` : `0 处；构造点=${ctorN}；缺键=${missStatic.length ? missStatic.join(',') : '无'}`)
  /* 皮肤调色板 8 色两两可辨（静态 pairwise——与 §7 表同源字面量） */
  const SKINS = ['#FF8A7A', '#FFE066', '#7DE8A8', '#6FC8FF', '#C98FE8', '#FFB98A', '#FFF3D6', '#FF9EC2']
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  let minD = 1e9, minPair = '', minDlu = 1e9
  const lumOf = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  for (let i = 0; i < SKINS.length; i++) for (let j = i + 1; j < SKINS.length; j++) {
    const a = hex(SKINS[i]), b = hex(SKINS[j])
    const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    if (d < minD) { minD = d; minPair = SKINS[i] + '~' + SKINS[j]; minDlu = Math.abs(lumOf(a) - lumOf(b)) }
  }
  A('B3a', '皮肤调色板 8 色两两可辨（静态 pairwise 城市距离 ≥55/765+灰度差——珊瑚~蜜桃最近对实测 63/29）',
    minD >= 55 && minDlu >= 20, `minΔ=${minD}（${minPair}，灰度差 ${minDlu.toFixed(0)}）；己席 #FFF3D6 与 SKINS[6] 同色=阵营白圈形状通道的存在性根由`)

  /* ================= 运行时（quick bot 房全乘） ================= */
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const goto = async (gw) => {
    await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/party-brawl/index.html?gw=${encodeURIComponent(gw || GW)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.evaluate(PX_SRC)
  }
  const st = () => page.evaluate(() => window.__GAMES_DEBUG__.state())

  /* ---------- 开局·空降态（boot 面——死口网关=确定性停留：INK 底+空降提示，真局首态） ---------- */
  await goto('ws://127.0.0.1:1')
  await sleep(700)
  await page.screenshot({ path: join(OUT, '01-boot.png') }); shots.push('01-boot.png'); console.error('  📸 01-boot.png（死口网关=boot 空降态确定性停留）')

  /* ---------- 开局 lobby（quick 配房——bot 秒配则并入已开局房，重试另配 ≤2 次） ---------- */
  await goto()
  await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 }, null, { timeout: 20_000 })
  let s0 = await st()
  for (let i = 0; i < 2 && s0.phase !== 'lobby'; i++) {
    console.error('  （并入已开局房——重载另配（开局 lobby 面取证））')
    await goto()
    await page.waitForFunction(() => { const s = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state(); return s && s.seat >= 0 }, null, { timeout: 20_000 })
    s0 = await st()
  }
  if (s0.phase === 'lobby') {
    await sleep(600)
    const d1 = await freeze(() => {
      const P = window.__PX__
      return { grass: P.cnt(60, 250, 240, 200, (r, g, b) => g > 150 && g > r + 20 && g > b + 40), midLuma: P.lumaMed(333), topBg: P.mx(5, 5) }
    }, '01-lobby.png')
    A('D1', '开局 lobby 全景在场（岛心镜头草绿主导+亮色中位 luma≥150+顶栏底）',
      d1.grass >= 3000 && d1.midLuma >= 150 && d1.topBg < 90, `草绿px=${d1.grass} 世界层中位luma=${d1.midLuma} 顶栏=${d1.topBg}`)
  } else console.error('  （quick bot 秒配=无 lobby 窗——开局面由 01-boot+02-live-p0 承接披露）')
  await page.waitForFunction(() => window.__GAMES_DEBUG__.state().phase === 'live', null, { timeout: 30_000 })
  await sleep(2500) // 快照流+预测收敛（FIX2 后 welcome 全量态即锚）

  /* ---------- 存活守卫游标（bot 猎杀/临终房→重载重排，A 去重幂等重跑） ---------- */
  let rejoins = 0
  const ensureLive = async () => {
    const s = await st().catch(() => null)
    if (!s || s.phase === 'ended' || s.phase === 'dead' || s.phase === 'boot') {
      if (rejoins++ >= 4) return false
      console.error(`  ⚠ 房态=${s && s.phase}——重载重排（第 ${rejoins} 次）`)
      await goto()
      await page.waitForFunction(() => { const x = window.__GAMES_DEBUG__.state(); return x && x.seat >= 0 && x.phase === 'live' }, null, { timeout: 30_000 })
      await sleep(2000)
    }
    return true
  }

  /* ---------- 探针步进（每步前 ensureLive——中途被淘汰即重进重跑该步） ---------- */
  /* victim 席选取：避 SKINS[6] 奶油（白系探针排除）+避 SKINS[3] 天蓝（≈海色探针排除）——糖粒雨/飘字窗可辨皮肤色系 */
  const steps = []
  steps.push(async () => { /* 对战中 P0：亮色基调 */
    const b1 = await freeze(() => {
      const P = window.__PX__
      const sea = P.cnt(0, 250, 40, 160, (r, g, b) => b > 190 && b > r + 20 && g > 130 && g < 220)
      const grass = P.cnt(60, 150, 240, 330, (r, g, b) => g > 150 && g > r + 20 && g > b + 40)
      const sand = P.cnt(0, 60, 375, 500, (r, g, b) => r > 220 && g > 200 && b > 130 && b < 200)
      return { sea, grass, sand, midLuma: P.lumaMed(333) }
    }, '02-live-p0.png')
    A('B1', '亮色竞技场基调（T7 平台首款亮色——海 #4FB8E8/草 #8FD96B/沙 #F5DE9C 带+世界层中位 luma≥150）',
      b1.sea + b1.grass + b1.sand >= 1200 && b1.midLuma >= 150, `海=${b1.sea} 草=${b1.grass} 沙=${b1.sand}px 世界层中位luma=${b1.midLuma}`)
  })
  steps.push(async () => { /* 己席白圈+控件+HUD 锚 */
    const own = await freeze(() => {
      const P = window.__PX__
      /* 采样点避朝向线（中心 ±1.25px 宽 INK 线）与眼点：屏心上移 6px 仍在 r12 豆体内 */
      const c = P.px(187.5, 327.5)
      return { c, ringW: P.ring3(187.5, 333.5, 17, (r, g, b) => r > 235 && g > 235 && b > 235) }
    })
    A('B2', '己席阵营双编码（白圈形状通道：#FFF3D6 豆体+白实线环 r≈16——色通道与远席 SKINS[6] 撞色靠环区分）',
      own.ringW >= 0.5 && Math.abs(own.c[0] - 255) <= 12 && Math.abs(own.c[1] - 243) <= 12 && Math.abs(own.c[2] - 214) <= 14,
      `豆体采样(187.5,327.5)=rgb(${own.c.join(',')}) 白环覆盖=${own.ringW}`)
    const ctl = await freeze(() => {
      const P = window.__PX__
      return { fireInk: P.cnt(298, 568, 50, 50, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b > 195), sklInk: P.cnt(298, 492, 50, 50, (r, g, b) => r > 150 && b > 180 && r > g + 20) }
    })
    A('D2', '对战控件三钮在场（射击钮 Ø72 半透白+技能钮 Ø56 紫——右下触件带）',
      ctl.fireInk >= 100 && ctl.sklInk >= 50, `射击钮区亮px=${ctl.fireInk} 技能钮紫px=${ctl.sklInk}`)
    ancLive = await freeze(anchors)
  })
  steps.push(async () => { /* 受击闪白 F03——基线=8 采样窗极小值（F06 警示脉冲同色 880ms 周期+真受击余晖 300ms 双源对冲） */
    const pre = []
    for (let i = 0; i < 8; i++) { pre.push(await page.evaluate(() => ({ cr: window.__PX__.cornerRed(), cw: window.__PX__.centerWhite() }))); await sleep(150) } // 基线采样不冻结（pause 车流诱发无头 rAF 停摆——games-147/172 系；min 口径无需冻结确定性）
    const cr0 = Math.min(...pre.map((p) => p.cr))
    const cws = pre.map((p) => p.cw).sort((a, b) => a - b); const cw0 = cws[3] // 白基线=低中位（真受击白闪 200ms≪采样窗）
    await drawnGate()
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('hurt'))
    await sleep(45)
    const p1 = await freeze(() => ({ cr: window.__PX__.cornerRed(), cw: window.__PX__.centerWhite() }), '03-fx-hurt.png')
    await sleep(50)
    const p2 = await freeze(() => ({ cr: window.__PX__.cornerRed(), cw: window.__PX__.centerWhite() }))
    const cr1 = Math.max(p1.cr, p2.cr), cw1 = Math.max(p1.cw, p2.cw)
    A('C1', '受击闪白 F03（己席白罩 200ms+屏缘红晕 300ms——冻结帧差分；基线 min/后置 max 对冲 F06 同色纹脉冲）',
      cw1 - cw0 >= 3 && cr1 - cr0 >= 4, `Δ白罩=${cw1 - cw0}px Δ红晕=${cr1 - cr0}px（基线min=${cr0}→post max=${cr1}，白基线=${cw0}）`)
    await sleep(700)
  })
  steps.push(async () => { /* 命中三连 F01/F02——victim=缺席席注入（零快照回踩）+同拍 hit；白基线=3 采样极小值（真受击白闪对冲） */
    const pre = []
    for (let i = 0; i < 3; i++) { pre.push(await page.evaluate(() => ({ cw: window.__PX__.centerWhite() }))); await sleep(120) }
    const cw0 = Math.min(...pre.map((p) => p.cw))
    const redBox = () => { const P = window.__PX__; return { cw: P.centerWhite(), red: P.cnt(178, 292, 70, 50, (r, g, b) => r > 130 && g < 100 && b < 90 && r - g > 50) } }
    /* 热房 AOI 变动回踩：缺席席可在探针窗内被该席新快照 Object.assign(cur) 拉回真实位（文字出屏）——
     * 重试驱动 ≤4 次（每次重扫缺席席重注入，50ms 存活窗命中即绿） */
    let ok = false, cw1 = 0, red1 = 0, attN = 0
    for (let att = 0; att < 4 && !ok; att++) {
      attN = att + 1
      await drawnGate()
      await page.evaluate(() => {
        const D = window.__GAMES_DEBUG__, s = D.state()
        const seat = D.fxScene('victim')
        D.fxProbe({ k: 'hit', seat, by: s.seat, dmg: 12, hp: 88, sh: 0 })
      })
      await sleep(50)
      const p1 = await freeze(redBox, '04-fx-hitmark.png') // 每驱动画一次（成功驱动的 p1 留盘——循环成功即止）
      await sleep(40)
      const p2 = await freeze(redBox)
      cw1 = Math.max(p1.cw, p2.cw); red1 = Math.max(p1.red, p2.red)
      ok = cw1 - cw0 >= 2 && red1 >= 4
    }
    A('C8', '命中三连 F01/F02（准星 X 白划+伤害飘字红簇 -12——事件驱动冻结帧；缺席席注入位 +22px 屏内）',
      ok, `Δ白X=${cw1 - cw0}px 飘字红px=${red1}px（白基线min=${cw0}，驱动${attN} 次——热房 AOI 回踩重试）`)
    await sleep(850)
  })
  steps.push(async () => { /* 爆炸环 F16 */
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('boom'))
    await sleep(150)
    const b = await freeze(() => window.__PX__.cnt(176, 290, 130, 90, (r, g, b) => r > 200 && g > 140 && b < 120 && r - b > 90), '05-fx-boom.png')
    A('C7a', '爆炸冲击环 F16（橙 #FFB65C 扩散 400ms——偏位场橙簇）', b >= 3, `橙环px=${b}`)
    await sleep(600)
  })
  steps.push(async () => { /* KO 大字+糖粒雨 F04/F05/F08——victim 缺席席注入（糖粒雨落点=注入位 +22px 屏内，不倚真 bot 位置） */
    const b0 = await freeze(() => ({ b: window.__PX__.banPair(), c: window.__PX__.confetti() }))
    await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__, s = D.state()
      const seat = D.fxScene('victim')
      D.fxProbe({ k: 'elim', seat, by: s.seat, rank: 5 })
    })
    await sleep(230)
    const b1 = await freeze(() => ({ b: window.__PX__.banPair(), c: window.__PX__.confetti() }), '06-fx-kill.png')
    A('C2', 'KO 大字 F04（「淘汰 Px」横幅 1.2s——banner 带 INK 底+白 16px 字形墨水）',
      b1.b.dark - b0.b.dark >= 100 && b1.b.white >= 30, `banner带Δ暗底=${b1.b.dark - b0.b.dark}px 白字=${b1.b.white}px（${b0.b.dark}→${b1.b.dark}）`)
    A('C3', '糖粒雨 F08（14 粒皮肤色 4px 抛散 700ms——彩色非背景簇）',
      b1.c - b0.c >= 6, `Δ彩粒=${b1.c - b0.c}px（${b0.c}→${b1.c}）`)
    await sleep(2600)
  })
  steps.push(async () => { /* 拾取浮标+确认环 F11/F07 */
    const b0 = await freeze(() => ({ ch: window.__PX__.chev(), pb: window.__PX__.pickBtnPx() }))
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('bob'))
    await sleep(220)
    const b1 = await freeze(() => ({ ch: window.__PX__.chev(), pb: window.__PX__.pickBtnPx() }), '07-fx-pickbob.png')
    A('C4', '拾取浮标 F11（箱顶 chevron 绿浮动+拾取钮 Ø64 浮现——吸附圈内可拾态）',
      b1.ch - b0.ch >= 2 && b1.pb - b0.pb >= 40, `Δchevron=${b1.ch - b0.ch}px Δ拾取钮绿盘=${b1.pb - b0.pb}px（${b0.pb}→${b1.pb}）`)
    const ring = await freeze(() => window.__PX__.cnt(0, 317, 375, 33, (r, g, b) => g > r + 30 && g > 140 && b > 130))
    console.error(`  ℹ F11 吸附圈虚线探针：中带绿px=${ring}（几何预期：半径 28000*0.55/30=513px > 屏角距 382px——恒出屏，见 O-1 披露）`)
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('pick'))
    await sleep(90)
    const badge = await freeze(() => window.__PX__.ring3(187.5, 333.5, 30, (r, g, b) => g > r + 20 && g > 130), '08-fx-pickbadge.png')
    A('C5', '拾取确认环 F07（绿 #3DDC84 扩散 200ms——中心环角度采样）', badge >= 0.2, `绿环覆盖=${badge}`)
    await sleep(500)
  })
  steps.push(async () => { /* 毒圈警示渐晕 F06——确定性净场（巨圈 r=1500m 圆心=镜头：屏角距 695m 全在圈内=零斜纹罩底噪，
     * 真实 edgeOn 判定同步关闭〔dEdge=1500m≫120m〕——基线≈0）+warnForce 驱动窗（2s）内 6 采样×150ms
     * 跨满 880ms 脉冲周期取峰（Run 10 根因：角带红分类器混叠圈外斜纹罩〔基线 1795px 已饱和——真实骑圈态〕，
     * 渐晕叠加不增分类数且镜头移动净减 49px ⇒ 恒负Δ；净场后脉冲峰 α≈0.54 才入红类） */
    await page.evaluate(() => {
      const D = window.__GAMES_DEBUG__, s = D.state()
      D.fxScene('stormsave')
      D.fxProbe({ k: 'storm', p: 3, t0: s.frame, t1: s.frame + 1200, r0: 1500000, r1: 1500000, x0: s.cam.x, y0: s.cam.y, x1: s.cam.x, y1: s.cam.y })
    })
    await sleep(400)
    const pre = []
    for (let i = 0; i < 3; i++) { pre.push(await page.evaluate(() => window.__PX__.cornerRed())); await sleep(150) }
    const cr0 = Math.min(...pre)
    await drawnGate()
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('edge'))
    let cr1 = 0, shotDone = false
    for (let i = 0; i < 6; i++) {
      const cr = await page.evaluate(() => window.__PX__.cornerRed())
      if (cr > cr1) cr1 = cr
      if (!shotDone && cr >= cr0 + 40) { await freeze(() => window.__PX__.cornerRed(), '09-fx-edge.png'); shotDone = true } // 峰相位冻结留档（暂停帧=最近绘制≈峰）
      await sleep(150)
    }
    if (!shotDone) await freeze(() => window.__PX__.cornerRed(), '09-fx-edge.png')
    A('C6', '毒圈警示渐晕 F06（圈边距<120px 屏缘红紫脉冲——净场〔全屏圈内〕warnForce 驱动窗同路径+周期取峰）',
      cr1 - cr0 >= 15, `Δ边缘红=${cr1 - cr0}px（净场基线min=${cr0}→post max=${cr1}）`)
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('stormrestore'))
    await sleep(400)
  })
  steps.push(async () => { /* 空投金圈 F10 */
    const a0 = await freeze(() => ({ g: window.__PX__.gold(), b: window.__PX__.banPair() }))
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('airdrop'))
    await sleep(450)
    const a1 = await freeze(() => ({ g: window.__PX__.gold(), b: window.__PX__.banPair() }), '10-fx-airdrop.png')
    A('C7', '空投金圈 F10（金 #FFE062 环脉冲 2s+「空投标落点」横幅——偏位金簇+banner 墨水）',
      a1.g - a0.g >= 3 && a1.b.dark - a0.b.dark >= 100, `Δ金环=${a1.g - a0.g}px bannerΔ暗底=${a1.b.dark - a0.b.dark}px`)
    await sleep(2200)
  })
  steps.push(async () => { /* 医疗+加速 F17/F19 */
    await page.evaluate(() => { const D = window.__GAMES_DEBUG__; D.fxProbe({ k: 'heal', seat: D.state().seat, v: 25 }); D.fxScene('boost') })
    await sleep(200)
    const hb = await freeze(() => { const P = window.__PX__; return { green: P.cnt(150, 270, 75, 50, (r, g, b) => g > 175 && r < 140), blue: P.cnt(150, 300, 75, 55, (r, g, b) => b > 175 && r < 155) } }, '11-fx-heal-boost.png')
    A('C7b', '医疗回复+加速残影 F17/F19（绿 +N 飘字+蓝加速环 500ms——双环同帧）',
      hb.green >= 3 && hb.blue >= 3, `绿px=${hb.green} 蓝px=${hb.blue}`)
    await sleep(800)
  })
  steps.push(async () => { /* 掉落箱 F09+B5/B6 双编码 */
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('box'))
    await sleep(130)
    const box = await freeze(() => {
      const P = window.__PX__
      /* 箱位：vis+(30000,22000) → 屏心 +(16.5,12.1)px ≈ (204,345.6)；行宽签名=方形中段行同宽 */
      const rows = []
      for (let dy = -9; dy <= 9; dy += 3) { let n = 0; for (let dx = -11; dx <= 11; dx++) { const p = P.px(204 + dx, 345 + dy); if (p[0] > 225 && p[1] > 225 && p[2] > 225) n++ } rows.push(n) }
      const orange = P.cnt(194, 335, 22, 22, (r, g, b) => r > 195 && g > 120 && b < 130 && r - b > 80)
      const dust = P.cnt(184, 324, 42, 42, (r, g, b) => r > 170 && g > 200 && b > 120 && b < 215)
      return { rows, orange, dust }
    }, '12-fx-box.png')
    const rowMid = Math.max(...box.rows.slice(1, -1)), rowEdge = Math.max(box.rows[0], box.rows[box.rows.length - 1])
    A('B5a', '武器箱方形双编码（wpn 箱=方+武器色描边——行宽签名中段峰≥8 且边行收敛 ≥2）',
      rowMid >= 8 && rowMid - rowEdge >= 2, `行宽=[${box.rows.join(',')}] 中段峰=${rowMid} 边行=${rowEdge}`)
    A('B6', '武器色描边在场（霰弹橙 #FFB65C——箱周橙簇）', box.orange >= 3, `橙描边px=${box.orange}`)
    A('C8b', '掉落箱弹出 F09（scale 回弹 300ms+落地尘环沙色）', box.dust >= 2, `尘环沙色px=${box.dust}`)
  })
  console.error('── §B/§C 对战中探针+FX 抽验（票面 6 态+扩展）──')
  let ancLive = null
  for (let i = 0; i < steps.length; i++) {
    if (!(await ensureLive())) { A('RUN', '执行完整性', false, `重进次数耗尽（步 ${i}）`); break }
    await steps[i]()
  }

  /* ---------- 缩圈确定性场（fxProbe storm 全参——客户端闭式渲染真路径；ext.storm 变才带=8 次/局不回踩） ---------- */
  console.error('── §D 缩圈相位谱（确定性场+自然相位）──')
  const stormShot = async (r0, r1, file) => {
    await page.evaluate((rr) => {
      const D = window.__GAMES_DEBUG__
      const s = D.state()
      D.fxProbe({ k: 'storm', p: 3, t0: s.frame, t1: s.frame + 1200, r0: rr[0], r1: rr[1], x0: s.cam.x, y0: s.cam.y, x1: s.cam.x, y1: s.cam.y })
    }, [r0, r1])
    await sleep(350)
    return freeze((r1m) => {
      const P = window.__PX__
      const st = window.__GAMES_DEBUG__.stormNow()
      const rPx = st.r / 1000 * 0.55
      const solid = P.ring3(187.5, 333.5, rPx, (r, g, b) => r > 225 && g > 225 && b > 225)
      const dashed = P.ring3(187.5, 333.5, Math.round(r1m / 1000 * 0.55), (r, g, b) => r > 225 && g > 225 && b > 225) /* 目标圈=下一相位末圆 r1 */
      const outside = P.cnt(0, 180, 55, 300, (r, g, b) => r > g + 12 && r > 70)
      const inside = P.cnt(150, 280, 75, 100, (r, g, b) => r > g + 12 && r > 70)
      return { rPx: Math.round(rPx), solid, dashed, outside, inside, r: st.r }
    }, file, r1)
  }
  let sm = null, sl = null
  if (await ensureLive()) {
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('stormsave'))
    sm = await stormShot(300000, 180000, '13-storm-mid.png')
    A('B4a', '毒圈当前圈白实线（确定性场 mid r=300m→屏 ~165px——36 向×3 半径采样覆盖 ≥0.7）',
      sm.solid >= 0.7, `r=${sm.rPx}px 覆盖=${sm.solid}`)
    A('B4b', '毒圈目标圈白虚线（下一相位末圆 r1=180m→99px——虚线断续覆盖 <0.8 形通道）',
      sm.dashed >= 0.15 && sm.dashed <= 0.8, `虚线覆盖=${sm.dashed}（实/虚同心双环=同帧双通道）`)
    A('B4c', '圈外红紫斜纹罩 vs 圈内零罩（STORM_A+斜纹 pattern——左带外圈红簇 > 屏心带 3×）',
      sm.outside >= 25 && sm.outside > sm.inside * 3 + 8, `圈外红=${sm.outside}px 圈内=${sm.inside}px`)
    sl = await stormShot(120000, 90000, '14-storm-late.png')
    A('D4a', '终段小圈相位（late r=120m→90m 场——F 相位形）', sl.solid >= 0.5, `r=${sl.rPx}px 覆盖=${sl.solid}`)
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('stormrestore')) // 注入场用毕复位——自然相位面（15/16）还原真圈
  }

  /* ---------- 自然相位（真局随拍——非注入） ---------- */
  const waitPh = async (want, capMs) => {
    const t0 = Date.now()
    while (Date.now() - t0 < capMs) {
      const s = await st()
      if (s.phase === 'ended') return 'ended'
      if (s.phase === 'dead') return 'dead'
      const p = await page.evaluate(() => { const f = window.__GAMES_DEBUG__.state().frame; const PH = window.PartySim.PHASES; for (let i = 0; i < PH.length; i++) if (f < PH[i].t1) return i; return PH.length })
      if (p >= want) return p
      await sleep(1500)
    }
    return null
  }
  const ph1 = await waitPh(1, 90000)
  if (ph1 === 'ended') throw new Error('临终房（自然相位未达）')
  if (typeof ph1 === 'number') { await sleep(400); await freeze(() => 1, '15-nat-S1.png'); console.error(`  📸 自然 S1 相位（ph=${ph1}）`) }
  else console.error(`  ⚠ S1 未及（${ph1}）——自然相位面由确定性场披露`)
  let ph3 = null
  if (typeof ph1 === 'number') {
    ph3 = await waitPh(3, 130000)
    if (ph3 === 'ended') throw new Error('临终房（S2 未达即终局）')
    if (typeof ph3 === 'number') { await sleep(400); await freeze(() => 1, '16-nat-S2.png'); console.error(`  📸 自然 S2 相位（ph=${ph3}）`) }
  }

  /* ---------- 淘汰信息卡+观战位（自然死亡优先，否则 killme 真切换 dead） ---------- */
  console.error('── §D 观战位/终局 ──')
  if (ph3 !== 'dead' && ph1 !== 'dead') {
    await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('killme'))
  } else console.error('  （自然淘汰——信息卡用真实击杀源）')
  await sleep(1400) // F13 镜头 lerp 0.12 跟领先者收敛
  const dead = await freeze(() => {
    const P = window.__PX__
    return {
      band: P.cnt(20, 226, 335, 36, (r, g, b) => r > 230 && g > 230 && b > 230),
      sub: P.cnt(20, 258, 335, 60, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b > 150),
      cta: P.cnt(60, 300, 255, 26, (r, g, b) => g > 190 && r < 150),
    }
  }, '17-dead-card.png')
  A('D3', '淘汰信息卡 F14（半卡 H/3 带：P0 标题白字+P1 副行（击杀/时长/击杀者+ping 双读）+绿 CTA 行）',
    dead.band >= 40 && dead.sub >= 25 && dead.cta >= 8, `标题白px=${dead.band} 副行=${dead.sub} CTA绿px=${dead.cta}`)
  const ancDead = await freeze(anchors)
  /* 圈心全景（tap 切换 specfree）——确定性场证明镜头跟踪：注入偏心圈（圆心=cam+60m 东移），
   * free 镜头须 lerp 0.12 追到新圆心（屏心呈环）；淘汰信息卡带（y 222-444）会遮中段弧——
   * 只在带外角度采样白环 */
  await page.evaluate(() => window.__GAMES_DEBUG__.fxScene('specfree'))
  await sleep(1200)
  await page.evaluate(() => {
    const D = window.__GAMES_DEBUG__
    const s = D.state()
    D.fxProbe({ k: 'storm', p: 3, t0: s.frame, t1: s.frame + 2000, r0: 300000, r1: 300000, x0: s.cam.x + 60000, y0: s.cam.y, x1: s.cam.x + 60000, y1: s.cam.y })
  })
  await sleep(3600) // lerp 0.12/帧收敛（~200 帧 → 残差 <1%）
  const free = await freeze(() => {
    const P = window.__PX__
    const rPx = 165
    let solid = 0, tot = 0
    for (let a = 0; a < 360; a += 10) {
      const x = 187.5 + Math.cos(a * Math.PI / 180) * rPx, y = 333.5 + Math.sin(a * Math.PI / 180) * rPx
      if (x < 4 || x > 371 || y < 60 || y > 663) continue
      if (y > 218 && y < 448) continue // 信息卡带遮蔽段不计样
      tot++; const p = P.px(x, y); if (p[0] > 225 && p[1] > 225 && p[2] > 225) solid++
    }
    let edge = 0
    for (const [x0, y0, w, h] of [[0, 66, 70, 150], [305, 66, 70, 150], [0, 460, 70, 170], [305, 460, 70, 170]]) edge += P.cnt(x0, y0, w, h, (r, g, b) => { const L = 0.299 * r + 0.587 * g + 0.114 * b; return L > 140 && Math.abs(r - g) + Math.abs(g - b) > 60 })
    return { solid: tot ? +(solid / tot).toFixed(2) : 0, tot, edge }
  }, '18-spec-free.png')
  A('D4', '观战圈心全景 F13（tap 切 free+偏心圈注入——镜头 lerp 追新圆心=屏心呈白实线环；卡带外角度采样）+F15 边缘席位指示',
    free.tot >= 8 && free.solid >= 0.5, `白环覆盖=${free.solid}（带外 ${free.tot} 向）边缘指示px=${free.edge}（含圈外斜纹罩混叠，披露项）`)

  /* ---------- 终局战报（自然 end——等待真局收官） ---------- */
  let ended = null
  const tEnd0 = Date.now()
  while (Date.now() - tEnd0 < 300000) {
    const s = await st()
    if (s.phase === 'ended') { ended = s; break }
    await sleep(1500)
  }
  if (!ended) throw new Error('终局等待超时（300s）——战报面未达')
  await sleep(300)
  const endp = await freeze(() => {
    const P = window.__PX__
    return {
      title: P.cnt(60, 104, 255, 30, (r, g, b) => r > 230 && g > 230 && b > 230),
      rep: P.cnt(30, 168, 315, 150, (r, g, b) => r > 230 && g > 230 && b > 230),
      cta: P.cnt(60, 535, 255, 26, (r, g, b) => g > 190 && r < 150),
      flat: P.lumaMed(333),
    }
  }, '19-ended.png')
  A('D5', '终局战报（INK 0.88 全罩+P0 终局标题+延迟补偿战报六行（回填/中位/峰值/ping）+绿 CTA）',
    endp.title >= 20 && endp.rep >= 120 && endp.cta >= 8 && endp.flat < 90, `标题=${endp.title} 战报行=${endp.rep}px CTA=${endp.cta} 底中位luma=${endp.flat}`)

  /* ---------- §A 运行时 HF 全量核（终态取表——全相位键已触达） ---------- */
  console.error('── §A HF/HUD 全量核 ──')
  const hfRaw = await page.evaluate(() => window.__GAMES_DEBUG__.hudFonts()).catch(() => null)
  if (!hfRaw) throw new Error('终局窗关闭过快（hudFonts 不可读）')
  const flat = {}
  for (const g in hfRaw) for (const k in hfRaw[g]) flat[`${g}.${k}`] = hfRaw[g][k]
  const notApplied = Object.entries(flat).filter(([, v]) => !v.applied).map(([k]) => k)
  A('A1', 'HF __applied 生效往返自证全键（Q-013 第三作口径——登记==ctx.font 回读逐键闭环）',
    notApplied.length === 0, `${Object.keys(flat).length} 键全 applied=${notApplied.length === 0}${notApplied.length ? '；红键=' + notApplied.join(',') : ''}`)
  const minPx = (G) => { const a = Object.entries(flat).filter(([k]) => k.startsWith(G + '.')).map(([, v]) => v.want); return a.length ? Math.min(...a) : 0 }
  A('A2', 'P0 运行时下限（≥13px 全档——hud-font-standard §1）', minPx('P0') >= 13, `P0min=${minPx('P0')}px`)
  A('A3', 'P1 运行时下限（≥11px）', minPx('P1') >= 11, `P1min=${minPx('P1')}px`)
  A('A4', 'P2 运行时下限（≥9px）', minPx('P2') >= 9, `P2min=${minPx('P2')}px`)
  const NEED = ['P0.dmg', 'P0.heal', 'P0.banner', 'P0.hp', 'P0.alive', 'P0.ping', 'P0.wname', 'P0.dead', 'P0.end', 'P1.ammo', 'P1.bag', 'P1.feed', 'P1.fire', 'P1.skl', 'P1.pick', 'P1.deadsub', 'P1.deadcta', 'P1.endrep', 'P1.endcta', 'P1.boot', 'P2.pingavg', 'P2.lb', 'P2.foot', 'P2.pip']
  /* P1.boot 豁免口径：本机网关 welcome <1 rAF——bootDraw 零帧即过（01-boot.png 死口网关页已证视觉面；键在 A5 静态全集中） */
  const missRT = NEED.filter((k) => flat[k] === undefined && !(k === 'P1.boot'))
  A('A6', 'HF 全 HUD 面键覆盖（运行时 reg ⊇ 23 键+P1.boot 静态/截图双证豁免——boot→live FX→dead→ended 全相位触达）',
    missRT.length === 0, `缺=${missRT.length ? missRT.join(',') : '无'}；P1.boot=${flat['P1.boot'] ? '运行时在册' : 'welcome<1 帧（01-boot.png+A5 静态双证）'}（运行时共 ${Object.keys(flat).length} 键）`)

  /* ---------- §E 谱系一致 ---------- */
  if (ancLive && ancDead) {
    let ancOk = true, worst = 0
    for (const k in ancLive) {
      const d = Math.abs(ancLive[k] - ancDead[k]); worst = Math.max(worst, d); if (d > 12) ancOk = false
    }
    A('E1', 'HUD 3 锚跨态零位移（live P0 vs dead——顶栏底/存活字/武器栏底 Δ≤12；hp 读数锚剔除=dead 态内容退场非位移）',
      ancOk, `最大Δ=${worst}（live=${JSON.stringify(ancLive)} dead=${JSON.stringify(ancDead)}）`)
  }
  A('FX-0', '页面零异常（pageerror——全乘含 FX 注入/毒圈场/killme/终局）', pageErrors.length === 0, pageErrors.join(' | ') || '0')

  await writeFile(join(EVID, 'vis-evidence.json'), JSON.stringify({ results, shots, hf: flat, storm: { sm, sl }, anchors: { live: ancLive, dead: ancDead }, pageErrors }, null, 1))
} catch (e) {
  A('RUN', '执行完整性', false, String((e && e.message) || e))
} finally {
  srv.close(); await browser.close()
}
const fail = results.filter((r) => !r.pass)
console.error(`\n[vis-check] ${results.length - fail.length}/${results.length} PASS${fail.length ? ' — 红：' + fail.map((f) => f.id).join(',') : ''}（截图 ${OUT}）`)
process.exit(fail.length ? 1 : 0)
