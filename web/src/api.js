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
 * 事件形状 { gameId, ms, at, cid, seq }：cid+seq 为客户端事件身份（GAMES-14），
 * 服务端据此幂等去重——fetch 与 beacon 竞态/离线重试导致的重发不会重复计时。
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

// ---- 玩家上传（GAMES-11；后端管线 GAMES-6）----

/**
 * multipart 表单上传：FormData 需含 file 字段（zip / 单 html）+ 可选元数据字段
 * （name/slug/levels/tier/description；空值勿 append，后端跳过空字段、不覆盖 zip 内 game.json 同名字段）。
 * 用 XHR 而非 fetch：上传字节进度只有 xhr.upload.onprogress 提供。
 * 成功 resolve { id, state }；失败 reject Error（message 直取服务端口径，可直接展示给用户）。
 */
export function uploadGame(form, { onProgress, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/upload')
    xhr.timeout = timeout
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      const body = xhr.response
      if (xhr.status === 201 && body && body.ok === true && typeof body.id === 'string') {
        resolve({ id: body.id, state: body.state })
      } else {
        reject(new Error((body && body.error) || `/api/upload HTTP ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误：上传中断或服务不可达，请稍后重试'))
    xhr.ontimeout = () => reject(new Error('上传超时，请检查网络后重试'))
    xhr.send(form)
  })
}

/**
 * 单查上传状态 GET /api/uploads/<id>。resolve 服务端记录
 * （state: pending/published/rejected/lost；rejected 带 reason，published 带 type/slug）。
 * 404（待审目录与台账均无此 id，如数据被清理）→ resolve null；其它失败 reject。
 */
export async function fetchUpload(id, { timeout = 8000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`/api/uploads/${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`/api/uploads/${id} HTTP ${res.status}`)
    const body = await res.json()
    if (!body || body.ok !== true || !body.upload) throw new Error('/api/uploads/<id> 响应形状异常')
    return body.upload
  } finally {
    clearTimeout(timer)
  }
}
