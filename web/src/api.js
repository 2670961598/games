// 后端接口封装（同源 /api/*）。失败抛错，由调用方决定降级策略。

export async function fetchGames({ timeout = 8000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch('/api/games', { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`/api/games HTTP ${res.status}`)
    const body = await res.json()
    if (!body || body.ok !== true || !Array.isArray(body.games)) throw new Error('/api/games 响应形状异常')
    return body.games
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 上报游玩时长事件。支持两种通道：
 *   reportEvents()      —— fetch POST（在线时用，可感知成败）
 *   beaconEvents()      —— navigator.sendBeacon（页面卸载时用，尽力而为）
 * 返回 true 表示已送达/已受理。
 */
export async function reportEvents(events) {
  const res = await fetch('/api/play-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  })
  if (!res.ok) throw new Error(`/api/play-events HTTP ${res.status}`)
  return true
}

export function beaconEvents(events) {
  try {
    const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' })
    return navigator.sendBeacon('/api/play-events', blob)
  } catch {
    return false
  }
}
