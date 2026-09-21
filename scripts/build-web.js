// 前端构建：web/ → dist/（零依赖，只需 Node 自身）。
//
// 为什么不用打包器：冻结验收命令为 `npm run build && node scripts/smoke-feed.js`，
// 其中不含 npm install——构建必须在一个只有 Node 的检出上也能确定变绿。
// web/ 本身是原生 ES 模块（浏览器直接 import），无需转译。“构建” = 拷贝 + 校验：
//   1. 在 dist.tmp/ 原子构建：校验全部通过后一次性替换 dist/（失败保留上一次好产物）
//   2. 校验 index.html 引用的本地资源（支持 ./相对、/绝对、?query、#hash）都存在
//   3. 每个产物 .js 过一遍 ESM 语法检查（node --check）
//   4. 写 build.json（构建时间与文件清单）
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'web')
const DIST = join(ROOT, 'dist')
const TMP = join(ROOT, 'dist.tmp')

async function copyDir(srcDir, destDir, files) {
  let entries
  try {
    entries = await readdir(srcDir, { withFileTypes: true })
  } catch {
    return // 可选目录（如 web/public）不存在 → 跳过
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
      files.push({ path: relative(TMP, to), bytes: content.length })
    } else {
      // 符号链接等非常规文件：静默跳过 = 产物缺文件且无诊断，不如直接失败
      throw new Error(`不支持的文件类型（符号链接/设备文件等）: ${from}`)
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

/** index.html 的 src/href 本地引用解析到产物内路径（剥 query/hash；跳过外链/data/锚点） */
function localRefs(html) {
  const refs = []
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    let ref = m[1]
    if (/^(https?:|data:|about:|#)/i.test(ref)) continue
    ref = ref.split('#')[0].split('?')[0]
    if (!ref) continue
    refs.push(ref)
  }
  return refs
}

async function main() {
  // 1. 原子构建：先写 dist.tmp/，全绿后替换 dist/
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  const files = []
  const indexHtml = await readFile(join(SRC, 'index.html'), 'utf8').catch(() => {
    throw new Error('缺少 web/index.html')
  })
  await writeFile(join(TMP, 'index.html'), indexHtml)
  files.push({ path: 'index.html', bytes: Buffer.byteLength(indexHtml) })
  await copyDir(join(SRC, 'src'), join(TMP, 'src'), files)
  await copyDir(join(SRC, 'public'), TMP, files) // 可选目录

  if (!files.some((f) => f.path === 'src/main.js')) {
    throw new Error('web/src/main.js 缺失')
  }

  // 2. index.html 本地引用必须落在产物里（裸相对路径按 index.html 所在层级解析）
  for (const ref of localRefs(indexHtml)) {
    const rel = ref.startsWith('/') ? ref.slice(1) : ref.replace(/^\.\//, '')
    const target = join(TMP, rel)
    await stat(target).catch(() => {
      throw new Error(`index.html 引用缺失: ${ref}（期望产物 ${target}）`)
    })
  }

  // 3. 产物 JS 语法检查
  for (const f of files) {
    if (!f.path.endsWith('.js') && !f.path.endsWith('.mjs')) continue
    const content = await readFile(join(TMP, f.path), 'utf8')
    await checkEsmSyntax(f.path, content)
  }

  // 4. 构建戳
  const buildInfo = { builtAt: new Date().toISOString(), files: files.length, totalBytes: files.reduce((s, f) => s + f.bytes, 0) }
  await writeFile(join(TMP, 'build.json'), JSON.stringify(buildInfo, null, 2) + '\n')

  // 5. 全部通过 → 原子上线
  await rm(DIST, { recursive: true, force: true })
  await rename(TMP, DIST)

  console.log(`[build-web] web/ → dist/  ${files.length} 个文件, ${buildInfo.totalBytes} 字节`)
}

try {
  await main()
} catch (err) {
  await rm(TMP, { recursive: true, force: true }) // 失败清理临时目录，保留上一次好产物
  console.error(`[build-web] 失败: ${err.message}`)
  process.exit(1)
}
