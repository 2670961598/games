// 冒烟：临时端口拉起 server → GET /api/health → 断言 {"ok":true} → 干净退出。
// 后续单的验收会在此基础上扩展（静态产物、games 伺服等）。
// 用临时端口而非默认 4399：避免与本机已在跑的 dev/生产实例冲突。
// 教训沉淀：macOS 上 0.0.0.0 与 127.0.0.1 可同端口并存绑定，server "listening" 不代表
// 回环流量归你——断言必须落在响应体内容上，而非"连得上"。
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEALTH_PATH = '/api/health'
const READY_TIMEOUT_MS = 10_000

function pickFreePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePromise(port))
    })
  })
}

async function getHealth(port) {
  const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
    headers: { 'accept': 'application/json' },
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function waitForHealth(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      return await getHealth(port)
    } catch (err) {
      lastErr = err
      await delay(100)
    }
  }
  throw new Error(`server ${READY_TIMEOUT_MS}ms 内未就绪：${lastErr}`)
}

const port = await pickFreePort()
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

function killServer() {
  return new Promise((done) => {
    if (server.exitCode !== null) return done()
    server.once('exit', done)
    server.kill('SIGTERM')
    setTimeout(() => { server.kill('SIGKILL') }, 2_000).unref()
  })
}

let exitCode = 1
try {
  const { status, text } = await waitForHealth(port)
  let ok = false
  try {
    ok = status === 200 && JSON.parse(text).ok === true
  } catch {
    ok = false
  }
  if (ok) {
    console.log(`[smoke] PASS  http://127.0.0.1:${port}${HEALTH_PATH} → ${status} ${text.trim()}`)
    exitCode = 0
  } else {
    console.error(`[smoke] FAIL  http://127.0.0.1:${port}${HEALTH_PATH} → ${status} ${text.trim()}`)
  }
} catch (err) {
  console.error(`[smoke] FAIL  ${err.message}`)
} finally {
  await killServer()
  if (exitCode !== 0 && serverLog.trim()) {
    console.error('[smoke] server 输出 ----')
    console.error(serverLog.trim())
    console.error('[smoke] server 输出结束 --')
  }
  process.exit(exitCode)
}
