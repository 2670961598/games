#!/usr/bin/env node
// GAMES 单机压测（零依赖）：并发 keep-alive GET，测 RPS 与延迟分位。
// 用法：
//   node scripts/bench-api.js [path ...] [-d 秒=5] [-c 并发=16] [--port 4399] [--no-enc]
// 例：
//   node scripts/bench-api.js /api/games /api/health -d 10 -c 32
//   node scripts/bench-api.js /games/community/smoke-a/index.html --no-enc   # 不带 Accept-Encoding
import http from 'node:http'

const args = process.argv.slice(2)
let durationSec = 5
let concurrency = 16
let port = 4399
let acceptEnc = true
const paths = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '-d') durationSec = Number(args[++i])
  else if (a === '-c') concurrency = Number(args[++i])
  else if (a === '--port') port = Number(args[++i])
  else if (a === '--no-enc') acceptEnc = false
  else paths.push(a)
}
const targets = paths.length ? paths : ['/api/health', '/api/games']

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })

function oneRequest(path) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    const r = http.request(
      { host: '127.0.0.1', port, path, agent, headers: acceptEnc ? { 'Accept-Encoding': 'gzip, br' } : {} },
      (res) => {
        const n = +res.headers['content-length'] || 0
        res.resume() // 只计数不读内容
        res.on('end', () => resolve({ us: Number(process.hrtime.bigint() - t0) / 1000, status: res.statusCode, bytes: n, enc: res.headers['content-encoding'] || '' }))
      },
    )
    r.on('error', reject)
    r.end()
  })
}

async function worker(path, deadline, stats) {
  while (Date.now() < deadline) {
    try {
      const r = await oneRequest(path)
      stats.count++
      if (r.status !== 200) stats.errors++
      stats.bytes += r.bytes
      stats.enc.add(r.enc)
      if (stats.lat.length < 20000) stats.lat.push(r.us)
    } catch {
      stats.errors++
      stats.count++
    }
  }
}

function pct(arr, p) {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

console.log(`压测 http://127.0.0.1:${port}  并发=${concurrency}  时长=${durationSec}s/轮  压缩=${acceptEnc ? '开(gzip/br 协商)' : '关'}\n`)
for (const path of targets) {
  const stats = { count: 0, errors: 0, bytes: 0, lat: [], enc: new Set() }
  const deadline = Date.now() + durationSec * 1000
  await Promise.all(Array.from({ length: concurrency }, () => worker(path, deadline, stats)))
  const secs = durationSec
  const rps = Math.round(stats.count / secs)
  const mb = (stats.bytes / 1024 / 1024).toFixed(1)
  console.log(
    `  ${path}\n    ${rps} req/s  |  ${stats.count} 请求  ${stats.errors} 失败  |  p50=${pct(stats.lat, 50).toFixed(1)}ms p95=${pct(stats.lat, 95).toFixed(1)}ms  |  编码: ${[...stats.enc].join(',') || 'identity'}  响应体≈${mb}MB`,
  )
}
agent.destroy()
