// 前端构建：web/ → dist/（零依赖，只需 Node 自身）。
//
// 为什么不用打包器：冻结验收命令为 `npm run build && node scripts/smoke-feed.js`，
// 其中不含 npm install——构建必须在一个只有 Node 的检出上也能确定变绿。
// web/ 本身是原生 ES 模块（浏览器直接 import），无需转译。“构建” = 拷贝 + 校验：
//   1. 在本进程临时目录 dist.tmp-<pid>/ 原子构建：校验全部通过后一次性替换 dist/（失败保留上一次好产物）
//   2. 校验 index.html 引用的本地资源（支持 ./相对、/绝对、?query、#hash）都存在
//   3. 每个产物 .js 过一遍 ESM 语法检查（node --check）
//   4. 写 build.json（构建时间与文件清单）
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { rmSync, renameSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'web')
const DIST = join(ROOT, 'dist')
// 每进程独立临时目录：games lane 的工作树被多个 worker 共享，并行构建互不撕写对方产物
const TMP = join(ROOT, `dist.tmp-${process.pid}`)

/** pid 是否还活着（EPERM = 进程存在但属别的用户，保守视为活） */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** 清掉崩溃残留的临时目录：pid 已死（或旧版无 pid 名）且 >10 分钟没动过 */
async function sweepStaleTmp() {
  const entries = await readdir(ROOT, { withFileTypes: true }).catch(() => [])
  const now = Date.now()
  for (const e of entries) {
    if (!e.isDirectory() || !/^dist\.tmp/.test(e.name)) continue
    const m = e.name.match(/^dist\.tmp-(\d+)$/)
    if (m && pidAlive(Number(m[1]))) continue // 属主进程还在跑，别动
    const p = join(ROOT, e.name)
    const mtime = await stat(p).then((s) => s.mtimeMs).catch(() => 0)
    if (now - mtime > 10 * 60 * 1000) await rm(p, { recursive: true, force: true })
  }
}

/**
 * 原子上线：rename(tmp→dist)。默认先直接换入（dist 缺席/为空目录时成）；
 * 目标被并行构建占着（ENOTEMPTY/EEXIST）才清掉紧贴重试，退避重试至多 5 次（≈0.75s）。
 * 其它错误（如 tmp 已丢失）立即抛出且不动 dist——保住上一次好产物。
 */
async function swapDirIntoPlace(tmp, dist, attempts = 5) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(tmp, dist)
      return
    } catch (err) {
      lastErr = err
      // 只对"目标被占"类错误清场重试；ENOENT(tmp 丢了)等重试无意义且不得删 dist
      if (!['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) break
      rmSync(dist, { recursive: true, force: true })
      try {
        renameSync(tmp, dist) // 同步紧贴清场：把可被击中的窗口压到微秒级
        return
      } catch (err2) {
        lastErr = err2
      }
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 50 * 2 ** i))
  }
  throw lastErr
}

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
  // 1. 原子构建：先写本进程临时目录，全绿后替换 dist/
  await sweepStaleTmp()
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

  // 根级其余 .html（第二界面等独立页面，GAMES-40 起）：原样入产物根
  const rootHtml = []
  for (const e of await readdir(SRC, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.html') && e.name !== 'index.html') rootHtml.push(e.name)
  }
  for (const name of rootHtml) {
    const content = await readFile(join(SRC, name), 'utf8')
    await writeFile(join(TMP, name), content)
    files.push({ path: name, bytes: Buffer.byteLength(content) })
  }

  if (!files.some((f) => f.path === 'src/main.js')) {
    throw new Error('web/src/main.js 缺失')
  }

  // 2. 各根级 html 本地引用必须落在产物里（裸相对路径按所在层级解析）
  for (const [name, html] of [['index.html', indexHtml], ...rootHtml.map((n) => [n, null])]) {
    const content = html !== null ? html : await readFile(join(SRC, name), 'utf8')
    for (const ref of localRefs(content)) {
      const rel = ref.startsWith('/') ? ref.slice(1) : ref.replace(/^\.\//, '')
      const target = join(TMP, rel)
      await stat(target).catch(() => {
        throw new Error(`${name} 引用缺失: ${ref}（期望产物 ${target}）`)
      })
    }
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
  await swapDirIntoPlace(TMP, DIST)

  console.log(`[build-web] web/ → dist/  ${files.length} 个文件, ${buildInfo.totalBytes} 字节`)
}

// 入口判定：ESM loader 对 import.meta.url 取 realpath，argv[1] 须同样 realpath 才对得上（经符号链接调用时不至静默空跑）
let entryArgv1 = process.argv[1] || ''
try {
  entryArgv1 = realpathSync(entryArgv1)
} catch {
  /* 文件已不存在等 → 保留原值比较 */
}
const isEntry = import.meta.url === pathToFileURL(entryArgv1).href
if (isEntry) {
  try {
    await main()
  } catch (err) {
    await rm(TMP, { recursive: true, force: true }) // 失败清理临时目录，保留上一次好产物
    console.error(`[build-web] 失败: ${err.message}`)
    process.exit(1)
  }
}

export { swapDirIntoPlace } // 供并发竞争场景的独立测试导入
