// 扫描 games/<type>/<slug>/game.json → 游戏清单。
// /api/games 数据源。与 GAMES-5 骨架口径一致，本单在其基础上补 levels（关卡数）/ tier（数值档位）。
// 规则：目录缺失/无 game.json/JSON 损坏/入口文件不存在 → 跳过该目录（服务器容错，不整体挂）
//       _ 前缀目录（如 games/_pending/ 上传暂存、games/_shared/ 共享资源）与 . 前缀隐藏目录均不扫描
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

function toLevels(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1
}

function toTier(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : 'standard'
}

/**
 * @returns {Promise<Array<{id,slug,type,name,description,levels,tier,url,entryFile}>>}
 *   id 默认 "<type>:<slug>"（game.json 可用 id 字段覆盖，须全局唯一）
 *   url 为入口文件直链（iframe 游戏入口）
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
      seenIds.add(id) // 登记在校验通过之后，坏目录才不会占住 id 挤掉有效目录
      out.push({
        id,
        slug,
        type,
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : slug,
        description: typeof meta.description === 'string' ? meta.description : '',
        levels: toLevels(meta.levels),
        tier: toTier(meta.tier),
        url: `/games/${type}/${slug}/${entryFile}`,
        entryFile,
      })
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
