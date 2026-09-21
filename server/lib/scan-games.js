// 扫描 games/<type>/<slug>/game.json → 游戏清单。
// server（/api/games）与 scripts/smoke-feed.js 共用，保证清单口径一致。
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @returns {Promise<Array<{id,slug,type,name,description,url,entryFile}>>}
 *   id 默认 "<type>:<slug>"（game.json 可用 id 字段覆盖，须全局唯一）
 *   url 指向目录（server 会补 index.html），供 feed iframe 直用
 * 规则：目录缺失/无 game.json/JSON 损坏 → 跳过该目录（服务器容错，不整体挂）
 *       _ 前缀目录为共享资源（如 games/_shared/），. 前缀为隐藏目录，均不扫描
 */
export async function scanGames(gamesDir) {
  const out = []
  const seenIds = new Set()
  let types = []
  try {
    types = await readdir(gamesDir, { withFileTypes: true })
  } catch {
    return out // games/ 不存在 → 空清单
  }
  for (const t of types) {
    if (!t.isDirectory() || t.name.startsWith('_') || t.name.startsWith('.')) continue
    let slugs = []
    try {
      slugs = await readdir(join(gamesDir, t.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of slugs) {
      if (!s.isDirectory() || s.name.startsWith('.')) continue
      const dir = join(gamesDir, t.name, s.name)
      let meta = null
      try {
        meta = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
      } catch {
        continue // 无 game.json 或损坏 → 不入清单
      }
      const type = t.name
      const slug = s.name
      const id = typeof meta.id === 'string' && meta.id.trim() ? meta.id.trim() : `${type}:${slug}`
      if (seenIds.has(id)) continue // id 冲突：后者跳过，保证清单唯一
      const entryFile = typeof meta.entry === 'string' && meta.entry ? meta.entry : 'index.html'
      try {
        const st = await stat(join(dir, entryFile))
        if (!st.isFile()) continue
      } catch {
        continue // 入口文件不存在 → 不入清单
      }
      seenIds.add(id) // 登记必须在校验通过之后，否则坏目录会占住 id 挤掉后面的有效目录
      out.push({
        id,
        slug,
        type,
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : slug,
        description: typeof meta.description === 'string' ? meta.description : '',
        url: `/games/${type}/${slug}/${entryFile}`,
        entryFile,
      })
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
