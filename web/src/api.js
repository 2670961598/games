// 后端接口封装（同源 /api/*）。失败抛错，由调用方决定降级策略。

// /api/games 服务端默认 pageSize=20（GAMES-6 后端起）；洗牌袋要全量清单才能保证
// "一轮不重复"，故显式拉大页并按 total 翻页拼全。响应无 total 时视为单页全量
// （GAMES-5 最小 server 形状兼容：忽略查询参数、一次回全部、无分页字段）。
const GAMES_PAGE_SIZE = 100
const GAMES_MAX_PAGES = 100 // 防御封顶：病态响应（忽略 page 参数且 total 虚高）时不死循环

/**
 * 翻页拼全量（纯逻辑，便于冒烟断言）。fetchPage(page) → { games, total? }。
 * 按 id 去重后追加——服务端若忽略 page 参数重复回同一页，不得把重复项灌进袋子。
 */
export async function collectGames(fetchPage) {
  const all = []
  const seen = new Set()
  for (let page = 1; page <= GAMES_MAX_PAGES; page++) {
    const body = await fetchPage(page)
    const wellFormed = Boolean(body && Array.isArray(body.games))
    const games = wellFormed ? body.games : []
    for (const g of games) {
      if (!g || typeof g.id !== 'string' || !g.id || seen.has(g.id)) continue
      seen.add(g.id)
      all.push(g)
    }
    const total = Number(body && body.total)
    // 收手条件：形状异常 / 无 total（单页全量语义）/ 拿满 total / 末页不满页
    if (!wellFormed || !Number.isFinite(total) || all.length >= total || games.length < GAMES_PAGE_SIZE) break
  }
  return all
}

/**
 * 单页拉取（GAMES-12 游戏大全用）：type 走服务端过滤，pageSize 用大页减少翻页轮次。
 * 返回服务端原始响应体 { ok, total, page, pageSize, pages, games }。
 */
export async function fetchGamesPage(page, { type = '', pageSize = GAMES_PAGE_SIZE, timeout = 8000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('pageSize', String(pageSize))
    if (type) qs.set('type', type)
    const res = await fetch(`/api/games?${qs}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`/api/games HTTP ${res.status}`)
    const body = await res.json()
    if (!body || body.ok !== true || !Array.isArray(body.games)) throw new Error('/api/games 响应形状异常')
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchGames({ timeout = 8000 } = {}) {
  return collectGames((page) => fetchGamesPage(page, { timeout }))
}

/**
 * 上报游玩时长事件。支持两种通道：
 *   reportEvents()      —— fetch POST（在线时用，可感知成败）
 *   beaconEvents()      —— navigator.sendBeacon（页面卸载时用，尽力而为）
 * 返回 true 表示已送达/已受理。
 */
export async function reportEvents(events, { timeout = 8000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch('/api/play-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`/api/play-events HTTP ${res.status}`)
    return true
  } finally {
    clearTimeout(timer)
  }
}

export function beaconEvents(events) {
  try {
    const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' })
    return navigator.sendBeacon('/api/play-events', blob)
  } catch {
    return false
  }
}
