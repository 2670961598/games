// 扫描 games/<type>/<slug>/game.json → 游戏清单 + 非法项报告（/api/games 数据源）。
// 字段口径 = 策划案 v2 §3.3 仲裁（决策 D7，GAMES-13 落地）：平台线实况为准 + tier 收口五枚举，
// 逐键裁定见 docs/game-design-spec.md §32 附录；生产线仍按 spec §2.1 全量严口径（DoD 不放宽）。
// 规则：缺 game.json/JSON 损坏/非对象/字段非法/入口文件不存在 → 跳过该目录并计入 invalid 报告
//       （服务器容错不整体挂，报告供运维排查与冒烟断言）；scanGames() 返回 { games, invalid }。
//       _ 前缀目录（如 games/_pending/ 上传暂存、games/_shared/ 共享资源）与 . 前缀隐藏目录均不扫描。
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** tier 五枚举（spec §2.1；平台线唯一合法值集，D7 收口） */
export const TIERS = ['relaxed', 'simple', 'normal', 'hard', 'master']

/**
 * tier 收口（D7）：五枚举合法；缺省 → normal；存量 standard → normal（迁移）；
 * 其余值返回 null（非法）——scan 侧据此跳过，上传管线 normalizeMeta 据此收敛为 normal
 */
export function toTier(v) {
  if (v === undefined || v === null || v === '') return 'normal'
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (t === 'standard') return 'normal'
  return TIERS.includes(t) ? t : null
}

/**
 * levels 平台值域（§3.3 仲裁）：1–9999 取整——玩家上传无权强制生产线的 10–120，平台不设此门槛；
 * 缺省 → 1；非数字/越界返回 null（非法）
 */
export function toLevels(v) {
  if (v === undefined || v === null || v === '') return 1
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 9999) return null
  return Math.floor(v)
}

/** spec §2.1 其余字段：M4 前不校验，透传进清单（feed 可消费 avgDurationSec/assets.thumb） */
const SPEC_PASSTHROUGH = ['version', 'specVersion', 'orientation', 'controls', 'avgDurationSec', 'scoring', 'assets', 'typeExtra']

/** 入口须为目录内相对路径：绝对路径或含 .. 段 = 非法（防清单 url 指到游戏目录外） */
function safeEntry(entry) {
  return !entry.startsWith('/') && !entry.split('/').some((seg) => seg === '..')
}

/**
 * 校验单个 game.json（已解析）。返回 { game } 或 { reason }（非法原因）。
 * 名称双读（D7）：title 优先、name 兜底、slug 保底，输出键统一 name（/api/games 契约不变）；
 * id 禁用 json 覆盖：一律 "<type>:<slug>" 目录推导（与上架管线 approve 的 delete gm.id 一致）。
 */
function readGame(meta, type, slug) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { reason: 'game.json 不是 JSON 对象' }
  }
  for (const k of ['title', 'name', 'description', 'entry']) {
    if (meta[k] !== undefined && typeof meta[k] !== 'string') return { reason: `字段 ${k} 须为字符串` }
  }
  const tier = toTier(meta.tier)
  if (tier === null) return { reason: `tier "${String(meta.tier).slice(0, 16)}" 不在五枚举 ${TIERS.join('/')}` }
  const levels = toLevels(meta.levels)
  if (levels === null) return { reason: `levels "${String(meta.levels).slice(0, 16)}" 非法（平台值域 1-9999 整数）` }
  const entryFile = typeof meta.entry === 'string' && meta.entry ? meta.entry : 'index.html'
  if (!safeEntry(entryFile)) return { reason: `entry "${entryFile.slice(0, 32)}" 不得为绝对路径或含 ..` }
  const title = typeof meta.title === 'string' ? meta.title.trim() : ''
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const game = {
    id: `${type}:${slug}`, // 目录推导，唯一由 (type, slug) 决定 → 无需查重
    slug,
    type,
    name: title || name || slug,
    description: typeof meta.description === 'string' ? meta.description : '',
    levels,
    tier,
    url: `/games/${type}/${slug}/${entryFile}`,
    entryFile,
  }
  for (const k of SPEC_PASSTHROUGH) {
    if (meta[k] !== undefined) game[k] = meta[k]
  }
  return { game }
}

/**
 * @returns {Promise<{games: Array<{id,slug,type,name,description,levels,tier,url,entryFile}>,
 *                    invalid: Array<{type,slug,reason}>}>}
 *   games 按注入 id 排序；invalid 为扫描报告（跳过的目录与原因），供日志/冒烟断言
 */
export async function scanGames(gamesDir) {
  const games = []
  const invalid = []
  let types = []
  try {
    types = await readdir(gamesDir, { withFileTypes: true })
  } catch {
    return { games, invalid } // games/ 不存在 → 空清单
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
      const type = t.name
      const slug = s.name
      const dir = join(gamesDir, type, slug)
      let meta
      try {
        meta = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'))
      } catch {
        invalid.push({ type, slug, reason: '缺 game.json 或 JSON 解析失败' })
        continue
      }
      const r = readGame(meta, type, slug)
      if (r.reason) {
        invalid.push({ type, slug, reason: r.reason })
        continue
      }
      try {
        const st = await stat(join(dir, r.game.entryFile))
        if (!st.isFile()) throw new Error('not a file')
      } catch {
        invalid.push({ type, slug, reason: `入口文件 ${r.game.entryFile} 不存在` })
        continue
      }
      games.push(r.game)
    }
  }
  games.sort((a, b) => a.id.localeCompare(b.id))
  return { games, invalid }
}
