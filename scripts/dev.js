// npm run dev：并行拉起 API server（4399）与 vite dev（5173，/api 已代理到 server）。
// 任一子进程退出即全组退出；Ctrl-C 信号透传，不留孤儿进程。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const children = [
  spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '4399' }, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: ROOT, stdio: 'inherit' }),
]

console.log('[dev] server →  http://localhost:4399（API + 构建产物）')
console.log('[dev] web    →  http://localhost:5173（热更新，/api 代理到 4399；手机同局域网访问此地址）')

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
    process.exit(code)
  }, 2_000).unref()
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] 子进程 pid=${child.pid} 意外退出（code=${code}），全组关闭`)
      shutdown(code ?? 1)
    }
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[dev] ${sig} received，关闭子进程…`)
    shutdown(0)
  })
}

process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL')
})
