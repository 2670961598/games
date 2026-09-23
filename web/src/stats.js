// 玩家统计（我的页数据源 + 后端上报事件）：GAMES-5 需求 3/4。
// 纯数据模块——不可变更新，scripts/smoke-feed.js 直接导入测试。
//
// stats 形状（可 JSON 序列化，访客级持久化）：
//   { v, games: { [id]: { count, totalMs, lastPlayed } }, totalMs }

export const STATS_VERSION = 1

export function emptyStats() {
  return { v: STATS_VERSION, games: {}, totalMs: 0 }
}

/** 进入一次游戏（count +1、刷新最近玩时间） */
export function applyEnter(stats, gameId, at = Date.now()) {
  const g = stats.games[gameId] || { count: 0, totalMs: 0, lastPlayed: 0 }
  return {
    ...stats,
    games: {
      ...stats.games,
      [gameId]: { ...g, count: g.count + 1, lastPlayed: Math.max(g.lastPlayed, at) },
    },
  }
}

/** 累加一段可见时长（ms <= 0 忽略） */
export function applyDuration(stats, gameId, ms, at = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return stats
  const g = stats.games[gameId] || { count: 0, totalMs: 0, lastPlayed: 0 }
  return {
    ...stats,
    games: {
      ...stats.games,
      [gameId]: { ...g, totalMs: g.totalMs + ms, lastPlayed: Math.max(g.lastPlayed, at) },
    },
    totalMs: stats.totalMs + ms,
  }
}

/**
 * boot 合并（GAMES-15 跨设备历史，D10 口径裁定）：按游戏 id **并集 + 字段级单调合并**。
 *   local  = 本地累计（含未送达上报的离线游玩）
 *   remote = GET /api/stats/<visitorId> 响应体 { games: [{ gameId, seconds, plays, lastAt }] }
 * 两侧是对**同一事件流的重叠聚合**（服务端只收到本地已送达的部分），不是不相交集合：
 *   - 求和 → 正常路径（本地 ⊇ 服务端）整段翻倍，不可取；
 *   - 服务端为准 → 丢掉未上报的离线部分，健康路径反而退数据；
 *   - 时间戳优先 → 跨设备时另一设备较早的累计整段被丢。
 * 故逐游戏取字段最大值（单调、幂等）：totalMs/lastPlayed → max；
 * count 保留本地"进入次数"口径（服务端 plays 是上报次数，含 15s 周期分段，口径不可比），
 * 仅远端才有的游戏用 plays 近似。顶层 totalMs 合并后按 Σ 各游戏重算（维持不变量）。
 * 病态远端条目（非法 id / 非数秒数）逐条跳过，不拖垮整次合并。
 */
export function mergeStats(local, remote) {
  const games = {}
  for (const [id, g] of Object.entries(local.games || {})) {
    games[id] = { count: g.count, totalMs: g.totalMs, lastPlayed: g.lastPlayed }
  }
  const remoteGames = Array.isArray(remote && remote.games) ? remote.games : []
  for (const rg of remoteGames) {
    if (!rg || typeof rg.gameId !== 'string' || !rg.gameId) continue
    const ms = Math.round(Number(rg.seconds) * 1000)
    if (!Number.isFinite(ms) || ms < 0) continue
    const lastAt = Number(rg.lastAt) || 0
    const g = games[rg.gameId]
    if (g) {
      g.totalMs = Math.max(g.totalMs, ms)
      g.lastPlayed = Math.max(g.lastPlayed, lastAt)
    } else if (ms > 0 || lastAt > 0) {
      const plays = Number(rg.plays)
      games[rg.gameId] = {
        count: Number.isFinite(plays) && plays >= 1 ? Math.floor(plays) : 1,
        totalMs: ms,
        lastPlayed: lastAt,
      }
    }
  }
  const totalMs = Object.values(games).reduce((t, g) => t + g.totalMs, 0)
  return { v: STATS_VERSION, games, totalMs }
}

/**
 * 我的页列表：stats ∩ 当前目录 → 按最近游玩倒序。
 * 目录里已下架的游戏不入列（数据保留在 stats 中，重新上架自动回来）。
 */
export function aggregatePlayed(stats, catalog) {
  const byId = new Map(catalog.map((g) => [g.id, g]))
  const rows = []
  for (const [id, g] of Object.entries(stats.games)) {
    const meta = byId.get(id)
    if (!meta) continue
    rows.push({ id, name: meta.name, type: meta.type, count: g.count, totalMs: g.totalMs, lastPlayed: g.lastPlayed })
  }
  rows.sort((a, b) => b.lastPlayed - a.lastPlayed)
  return rows
}

/** 人读时长：89秒 → "1分29秒"；3672000 → "1小时1分" */
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分${s % 60}秒`
  return `${Math.floor(m / 60)}小时${m % 60}分`
}
