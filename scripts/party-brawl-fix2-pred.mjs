#!/usr/bin/env node
/* =====================================================================
 * party-brawl-fix2-pred（GAMES-178 · FIX2 预测域激活探针——§5.3 撕裂预算
 * 激活态实测，200ms 臂帧级数据）
 *   修复面：predictor anchor tick（sim frame 域）vs advanceTo/push at（输入
 *   seq 域）两域错配 → 预测退化为「最近权威位」（100ms 阶跃）。修复=sim tick
 *   域统一（卡丁范式：simTick 本地估计+flight EMA 自校准+push@simTick+flight，
 *   GAMES-178）。
 *   P1 环境：自起静态服务+影子网关（显式 PORT）+TCP 延迟代理（每向 100ms=
 *   RTT 200ms=§5.3 200ms 臂——games-110 卡丁范式；测试房封锁 WS join，故走
 *   quick 真房接管席）
 *   P2 驱动：页 quick 接管 bot 席 → 摇杆保持段×3（正向 10s→反向 6s→斜向 8s）
 *   P3 断言：
 *     B1 域统一自证：flight EMA 收敛 ∈[1,8]；simTick−lastFrame ∈[0,flight+10]
 *     B2 预测激活：lead（影子超前权威锚距离）中位 ≥10px——修复前恒≈0（100ms 阶跃态）
 *     B3 偏差带（§5.3 修正量行）：dPx 中位 ≤3px、p95 ≤12px（200ms 臂常态）
 *     B4 分流率（§5.3 峰值列）：硬回滚 ≤0.5 次/s、软收敛事件 ≤2 次/s（常态列披露）
 *     B5 视觉撕裂（§5.3 撕裂行）：混合带步长 ≤2.5px/帧（代码封顶实测）+
 *            累计修正 ≤60px/s
 *   数据：GAMES-178-shots/pred-band.json（帧级/逐快照账本全量）
 * 用法：node scripts/party-brawl-fix2-pred.mjs
 * =====================================================================
 */
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GW_PORT = Number(process.env.FIX2_GW_PORT || 4478)
const PX_PORT = Number(process.env.FIX2_PX_PORT || 4488)
const GWWS = `ws://127.0.0.1:${PX_PORT}`
const OUT = '/Volumes/BigDisk/Studio/kernel/workers/GAMES-178-shots'
const PORT = 8860 + Math.floor(Math.random() * 300)

let pass = 0, fail = 0
const ok = (id, name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
  else { fail++; console.error(`  ✗ ${id} ${name}${detail ? '（' + detail + '）' : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const med = (xs) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0
const pct = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0

let chromium
try { chromium = (await import('playwright')).chromium }
catch { console.error('playwright 未安装：npm i -D playwright'); process.exit(2) }

/* ---------- P1a 静态服务（游戏页面；.cjs 须 text/javascript——GAMES-90 MIME 坑） ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' }
const srv = httpServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''))
    const buf = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => srv.listen(PORT, r))

/* ---------- P1b 影子网关（显式 PORT——缺省=生产 4400 红线，games-125 铁律） ---------- */
await mkdir(OUT, { recursive: true })
const gwProc = spawn('node', [join(ROOT, 'server/gateway/index.js')], { env: { ...process.env, PORT: String(GW_PORT) }, stdio: ['ignore', 'ignore', 'pipe'] })
gwProc.stderr.on('data', (d) => process.stderr.write('[gw] ' + d))
let gwUp = false
for (let i = 0; i < 50 && !gwUp; i++) {
  try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/healthz`); gwUp = r.ok } catch { await sleep(200) }
}
if (!gwUp) { console.error('影子网关未起（healthz 无应答）'); process.exit(2) }

/* ---------- P1c TCP 延迟代理：PX_PORT → GW_PORT，每向 100ms（tactics-duel-qa2-lib 同式） ---------- */
const proxy = tcpServer((csock) => {
  csock.setNoDelay(true); csock.pause()
  const usock = connect(GW_PORT, '127.0.0.1')
  usock.setNoDelay(true)
  usock.once('connect', () => csock.resume())
  const kill = () => { try { csock.destroy() } catch { /* 已断 */ } try { usock.destroy() } catch { /* 已断 */ } }
  csock.on('data', (d) => setTimeout(() => { try { usock.write(d) } catch { kill() } }, 100))
  usock.on('data', (d) => setTimeout(() => { try { csock.write(d) } catch { kill() } }, 100))
  csock.on('close', kill); usock.on('close', kill)
  csock.on('error', kill); usock.on('error', kill)
})
await new Promise((r) => proxy.listen(PX_PORT, '127.0.0.1', r))
console.log(`[fix2-pred] 影子网关 :${GW_PORT} + 延迟代理 :${PX_PORT}（每向 100ms=200ms 臂=§5.3 口径）`)

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
let pageErrors = []
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  /* ---------- P2 页面 quick 接管+摇杆驱动（近终局房重试至新鲜局） ---------- */
  let seat = -1
  for (let attempt = 0; attempt < 3 && seat < 0; attempt++) {
    await page.goto(`http://127.0.0.1:${PORT}/games/multiplayer/party-brawl/index.html?gw=${encodeURIComponent(GWWS)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    try {
      await page.waitForFunction(() => {
        const st = window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.state()
        return st && st.seat >= 0 && st.phase === 'live'
      }, null, { timeout: 25_000 })
      const st = await page.evaluate(() => window.__GAMES_DEBUG__.state())
      if (st.frame > 8000) { await sleep(2000); continue } // 近终局房（party 上限 9600）——重试新局
      seat = st.seat
    } catch { /* 重试 */ }
  }
  if (seat < 0) { ok('B0', 'quick 接管席+live（三轮内新鲜局）', false, '未就席'); throw new Error('no-seat') }
  console.log(`[fix2-pred] 接管席 ${seat}——摇杆驱动 24s（正向10s/反向6s/斜向8s）`)

  const phase = () => page.evaluate(() => window.__GAMES_DEBUG__.state().phase).catch(() => 'gone')
  const drive = async (dx, dy, ms) => {
    await page.touchscreen.tap(100, 400) // 唤醒触控面
    await page.mouse.move(100, 400); await page.mouse.down()
    await page.mouse.move(100 + dx, 400 + dy, { steps: 8 })
    const t0 = Date.now()
    while (Date.now() - t0 < ms && (await phase()) === 'live') await sleep(300)
    await page.mouse.up(); await sleep(400)
  }
  const t0 = Date.now()
  await drive(70, 0, 10_000)   // 正向满速段（速度锚定主证）
  await drive(-70, 0, 6_000)   // 反向段（ramp 瞬态=偏差带尾部）
  await drive(50, 50, 8_000)   // 斜向段
  const durS = (Date.now() - t0) / 1000
  const probe = await page.evaluate(() => window.__GAMES_DEBUG__.predProbe()).catch(() => null)
  if (!probe) { ok('B0', 'predProbe 可读', false, '页面已终局/丢失'); throw new Error('no-probe') }
  ok(pageErrors.length === 0, 'B0', '零 pageerror（域改动整链净）', pageErrors.length ? pageErrors[0] : `${probe.predLog.length} 快照样本/${durS.toFixed(0)}s`)

  /* ---------- P3 断言 ---------- */
  const L = probe.predLog
  if (L.length < 50) ok('B0', '样本量（≥50 快照——驱动链完整）', false, `predLog=${L.length}（驱动未生效或快照断流）`)
  const dPx = L.map((e) => e.d / 1000)
  const leadPx = L.map((e) => e.lead / 1000)
  ok('B1', '域统一自证：flight EMA 收敛 ∈[1,8]（ack 回执自校准在岗）', probe.flight >= 1 && probe.flight <= 8, `flight=${probe.flight}（末拍 simTick−lastFrame=${probe.simTick - probe.lastFrame}）`)
  ok('B1', '本地时钟护栏：simTick−lastFrame ∈[0, flight+10]（不落后权威帧/不开环跑飞）', probe.simTick - probe.lastFrame >= 0 && probe.simTick - probe.lastFrame <= probe.flight + 10, `Δ=${probe.simTick - probe.lastFrame}`)
  ok('B2', '预测激活：lead（超前权威锚）中位 ≥10px 且峰值 ≥20px（≈RTT 4 tick）——修复前恒≈0（100ms 阶跃态）；含静止窗样本（v=0→lead=0 合法），中位即持续激活证', med(leadPx) >= 10 && Math.max(...leadPx) >= 20, `lead 中位=${med(leadPx).toFixed(1)}px p5=${pct(leadPx, 0.05).toFixed(1)}px（静止窗合法 0）max=${Math.max(...leadPx).toFixed(1)}px`)
  ok('B3', '偏差带·中位（§5.3 修正量 ≤3px）', med(dPx) <= 3, `中位=${med(dPx).toFixed(2)}px（n=${dPx.length}）`)
  ok('B3', '偏差带·p95（§5.3 ≤12px）', pct(dPx, 0.95) <= 12, `p95=${pct(dPx, 0.95).toFixed(2)}px p99=${pct(dPx, 0.99).toFixed(2)}px max=${Math.max(...dPx).toFixed(2)}px`)
  const softRate = probe.rec.soft / durS, hardRate = probe.rec.hard / durS
  ok('B4', '硬回滚率 ≤0.5 次/s（§5.3 峰值列；常态列 ≤0.1/s 披露）', hardRate <= 0.5, `hard=${probe.rec.hard}（${hardRate.toFixed(2)}/s）；soft=${probe.rec.soft}（${softRate.toFixed(2)}/s）`)
  ok('B4', '软收敛事件率 ≤2 次/s（§5.3 峰值列；常态列 ≤0.8/s 披露）', softRate <= 2, `soft=${probe.rec.soft}/${durS.toFixed(0)}s`)
  const blendSteps = probe.visSteps.filter((e) => e.b === 1).map((e) => e.s)
  ok('B5', '视觉撕裂·混合带步长 ≤2.5px/帧（硬回滚封顶实测；无混合带=硬回滚未触发，披露）', blendSteps.length === 0 || Math.max(...blendSteps) <= 2.51, blendSteps.length ? `混合带 ${blendSteps.length} 帧 max=${Math.max(...blendSteps).toFixed(2)}px` : `硬回滚 0 次（偏差带 p99=${pct(dPx, 0.99).toFixed(2)}px 未越 6px 门）`)
  const corrPx = dPx.filter((v) => v > 0.6).reduce((a, b) => a + b, 0)
  ok('B5', '累计修正 ≤60px/s（§5.3 撕裂行累计口径）', corrPx / durS <= 60, `Σ修正=${corrPx.toFixed(0)}px / ${durS.toFixed(0)}s = ${(corrPx / durS).toFixed(1)}px/s`)

  /* 帧级数据落盘（REPORT 证据：逐快照 d/lead + 视觉步长台账） */
  await writeFile(join(OUT, 'pred-band.json'), JSON.stringify({
    arm: 'tcp-proxy 100ms×2=RTT200', seat, durS: +durS.toFixed(1), flight: probe.flight, rec: probe.rec,
    dPx: { med: +med(dPx).toFixed(2), p95: +pct(dPx, 0.95).toFixed(2), p99: +pct(dPx, 0.99).toFixed(2), max: +Math.max(...dPx).toFixed(2) },
    leadPx: { med: +med(leadPx).toFixed(2), max: +Math.max(...leadPx).toFixed(2) },
    predLog: L, visSteps: probe.visSteps, pageErrors,
  }, null, 1))
  console.log(`  · 帧级数据：${OUT}/pred-band.json（predLog ${L.length} 条+visSteps ${probe.visSteps.length} 帧）`)
} finally {
  await browser.close().catch(() => {})
  proxy.close(); gwProc.kill('SIGTERM'); srv.close()
}
console.log(`\nparty-brawl-fix2-pred：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
