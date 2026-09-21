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
