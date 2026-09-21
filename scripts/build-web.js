// 前端构建：web/ → dist/（零依赖，只需 Node 自身）。
//
// 为什么不用打包器：冻结验收命令为 `npm run build && node scripts/smoke-feed.js`，
// 其中不含 npm install——构建必须在一个只有 Node 的检出上也能确定变绿。
// web/ 本身是原生 ES 模块（浏览器直接 import），无需转译；“构建”= 拷贝 + 校验：
//   1. 清空 dist/，拷贝 web/index.html 与 web/src/**（及 web/public/** 若存在）
//   2. 校验 index.html 引用的本地资源都存在
//   3. 每个产物 .js 过一遍 ESM 语法检查（node --check）
//   4. 写 dist/build.json（构建时间与文件清单）
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'web')
const DIST = join(ROOT, 'dist')

async function copyDir(srcDir, destDir, files) {
  let entries
  try {
    entries = await readdir(srcDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const from = join(srcDir, e.name)
    const to = join(destDir, e.name)
    if (e.isDirectory()) {
      await copyDir(from, to, files)
    } else if (e.isFile()) {
      const content = await readFile(from)
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, content)
      files.push({ path: relative(DIST, to), bytes: content.length })
    }
  }
}

async function checkEsmSyntax(file, content) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check', '-'], {
    input: content,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(`ESM 语法检查失败: ${file}\n${r.stderr}`)
  }
}

async function main() {
  // 1. 清空并重建 dist/
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  // 2. 拷贝
  const files = []
  const indexHtml = await readFile(join(SRC, 'index.html'), 'utf8').catch(() => {
    throw new Error('缺少 web/index.html')
  })
  await writeFile(join(DIST, 'index.html'), indexHtml)
  files.push({ path: 'index.html', bytes: Buffer.byteLength(indexHtml) })
  await copyDir(join(SRC, 'src'), join(DIST, 'src'), files)
  await copyDir(join(SRC, 'public'), join(DIST), files) // 可选目录

  if (!files.some((f) => f.path.endsWith('main.js'))) {
    throw new Error('web/src/main.js 缺失')
  }

  // 3. index.html 的本地引用必须落在产物里
  const refs = [...indexHtml.matchAll(/(?:src|href)="(\/[^"]+|\.\/[^"]+)"/g)].map((m) => m[1])
  for (const ref of refs) {
    if (/^https?:/.test(ref)) continue
    const target = join(DIST, ref.replace(/^\//, '').replace(/^\.\//, ''))
    await stat(target).catch(() => {
      throw new Error(`index.html 引用缺失: ${ref}（期望产物 ${target}）`)
    })
  }

  // 4. 产物 JS 语法检查
  for (const f of files) {
    if (!f.path.endsWith('.js') && !f.path.endsWith('.mjs')) continue
    const content = await readFile(join(DIST, f.path), 'utf8')
    await checkEsmSyntax(f.path, content)
  }

  // 5. 构建戳
  const buildInfo = { builtAt: new Date().toISOString(), files: files.length, totalBytes: files.reduce((s, f) => s + f.bytes, 0) }
  await writeFile(join(DIST, 'build.json'), JSON.stringify(buildInfo, null, 2) + '\n')

  console.log(`[build-web] web/ → dist/  ${files.length} 个文件, ${buildInfo.totalBytes} 字节`)
}

try {
  await main()
} catch (err) {
  console.error(`[build-web] 失败: ${err.message}`)
  process.exit(1)
}
