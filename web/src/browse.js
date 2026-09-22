// 游戏大全（GAMES-12）：消费 /api/games 分页 + type 过滤的全集浏览视图。
// 纯逻辑（TYPE_CATALOG / TIER_GROUPS / filterGames / collectBrowsePage）与视图（createBrowse）
// 同文件：前者供 scripts/smoke-feed.js 在 node 下直接 import 断言，不依赖 DOM。
//
// 类型清单唯一事实源：docs/game-design-spec.md §6（specVersion 1.0.0，24 类型）；
// 档位体系：同文 §3.1（五档）。spec 修订须开新需求单，此处仅随 spec 同步。

/** 24 类型清单（§6 速查表全量照录；controls 为 §5.4 词表取值，供后续 UI 复用） */
export const TYPE_CATALOG = Object.freeze([
  { slug: 'tap-burst', name: '狂点爆发', controls: 'tap' },
  { slug: 'tap-jump', name: '飞翔跳跃', controls: 'tap' },
  { slug: 'lane-runner', name: '车道跑酷', controls: 'swipe-lr' },
  { slug: 'stacker', name: '叠塔', controls: 'tap' },
  { slug: 'match3', name: '三消', controls: 'swipe-any' },
  { slug: 'slide-merge', name: '滑动合并', controls: 'swipe-any' },
  { slug: 'snake', name: '贪吃蛇', controls: 'swipe-any' },
  { slug: 'breakout', name: '弹珠打砖', controls: 'drag' },
  { slug: 'paddle-pong', name: '挡板生存', controls: 'drag' },
  { slug: 'bullet-shmup', name: '弹幕射击', controls: 'drag' },
  { slug: 'bullet-dodge', name: '弹雨躲避', controls: 'drag' },
  { slug: 'drop-catcher', name: '接落物', controls: 'drag' },
  { slug: 'mole-whack', name: '打地鼠', controls: 'tap' },
  { slug: 'memory-flip', name: '翻牌配对', controls: 'tap' },
  { slug: 'simon-sequence', name: '序列记忆', controls: 'tap' },
  { slug: 'color-reaction', name: '颜色反应', controls: 'tap-zone' },
  { slug: 'fruit-slice', name: '划切水果', controls: 'swipe-any' },
  { slug: 'water-sort', name: '水排序', controls: 'tap' },
  { slug: 'block-drop', name: '方块下落', controls: 'swipe-any' },
  { slug: 'block-fit', name: '块填充', controls: 'drag' },
  { slug: 'chain-shot', name: '珠链消除', controls: 'tap' },
  { slug: 'maze-dash', name: '迷宫冲刺', controls: 'swipe-any' },
  { slug: 'mini-td', name: '简化塔防', controls: 'tap' },
  { slug: 'rhythm-tap', name: '节奏点击', controls: 'tap-zone' },
])

/** 五档档位分组（§3.1；key 为 game.json tier 枚举，顺序 = 难度递增） */
export const TIER_GROUPS = Object.freeze([
  { key: 'relaxed', name: '轻松' },
  { key: 'simple', name: '简单' },
  { key: 'normal', name: '标准' },
  { key: 'hard', name: '困难' },
  { key: 'master', name: '大师' },
])

const TYPE_NAME_MAP = new Map(TYPE_CATALOG.map((t) => [t.slug, t.name]))
const TIER_NAME_MAP = new Map(TIER_GROUPS.map((t) => [t.key, t.name]))

/** type slug → 中文名；清单外类型（如 demo 占位）原样回退，不硬报错 */
export function typeName(slug) {
  return TYPE_NAME_MAP.get(slug) || String(slug || '')
}

/** tier key → 中文名；清单外档位（如历史数据 'standard'）原样回退 */
export function tierName(key) {
  return TIER_NAME_MAP.get(key) || String(key || '')
}

/**
 * 内存过滤（纯逻辑）：type / tier 均为精确匹配，空串 = 该维度不滤。
 * games 条目只需含 type/tier 字段（/api/games 响应形状）。
 */
export function filterGames(games, { type = '', tier = '' } = {}) {
  const list = Array.isArray(games) ? games : []
  return list.filter((g) => g && (!type || g.type === type) && (!tier || g.tier === tier))
}

// ---- 分页消费 ----

export const BROWSE_PAGE_SIZE = 20 // 大全逻辑页大小（用户视角每页条数）
const SERVER_PAGE_SIZE = 100 // 服务端单页默认拉取大小（与 api.js 上限约定一致）
const MAX_SERVER_PAGES = 100 // 防御封顶：病态响应（忽略 page 且 total 虚高）时不死循环

/**
 * 大全逻辑页拼装（纯逻辑，冒烟可注入假 fetchPage）。
 *
 * 服务端已按 type 过滤并分页（fetchPage(serverPage) → { games, total?, pageSize? }）；
 * tier 为客户端二次过滤：跨服务端页按序攒够第 page 个逻辑页（pageSize 条匹配项），
 * 避免出现"整页被档位滤空"的毛刺。按 id 去重——服务端若重复回同一页不得重复灌入。
 * 无状态设计（每次从服务端第 1 页扫起）：视图侧可对 fetchPage 做 memo 消掉重复请求。
 *
 * 返回 { games: 本逻辑页条目, total: 服务端 total（无则 null）, exhausted: 本页之后是否再无匹配 }。
 */
export async function collectBrowsePage(fetchPage, { page = 1, pageSize = BROWSE_PAGE_SIZE, tier = '' } = {}) {
  const need = page * pageSize // 要攒到的匹配条数水位
  const seen = new Set()
  const matched = []
  let total = null
  let streamEnd = false // 服务端分页流是否已到尽头

  for (let sp = 1; sp <= MAX_SERVER_PAGES && !streamEnd && matched.length < need; sp++) {
    const body = await fetchPage(sp)
    const wellFormed = Boolean(body && Array.isArray(body.games))
    const games = wellFormed ? body.games : []
    const seenBefore = seen.size
    for (const g of games) {
      if (!g || typeof g.id !== 'string' || !g.id || seen.has(g.id)) continue
      seen.add(g.id) // 原始去重先于 tier 过滤：整页滤空但有条目 ≠ 流尽
      if (!tier || g.tier === tier) matched.push(g)
    }
    const t = Number(body && body.total)
    if (Number.isFinite(t)) total = t
    // 流尽判定：形状异常 / 无 total（单页全量语义）/ 病态重复回页（零新 id）/ 已过最后一页
    if (!wellFormed || !Number.isFinite(t) || seen.size === seenBefore) streamEnd = true
    else if (sp * (Number(body.pageSize) || SERVER_PAGE_SIZE) >= t) streamEnd = true
  }

  const start = (page - 1) * pageSize
  return {
    games: matched.slice(start, start + pageSize),
    total,
    exhausted: streamEnd && matched.length <= need,
  }
}

// ---- 视图 ----

/**
 * 游戏大全视图（#/catalog）。
 * fetchCatalogPage(serverPage, type) → Promise<服务端响应体>（api.js fetchGamesPage 包装）；
 * onOpenGame(id) 由宿主接路由进播放器。
 */
export function createBrowse({ fetchCatalogPage, onOpenGame }) {
  const root = document.createElement('div')
  root.className = 'browse'

  root.innerHTML = `
    <header class="browse__head">
      <button class="browse__back" type="button">‹ 刷一刷</button>
      <div class="browse__title">游戏大全</div>
    </header>
    <div class="browse__filters">
      <div class="browse__filter-row">
        <div class="browse__filter-label">类型</div>
        <div class="browse__chips" id="browse-types"></div>
      </div>
      <div class="browse__filter-row">
        <div class="browse__filter-label">档位</div>
        <div class="browse__chips" id="browse-tiers"></div>
      </div>
    </div>
    <div class="browse__count" id="browse-count"></div>
    <div class="browse__list" id="browse-list"></div>
    <button class="browse__more" id="browse-more" type="button">加载更多</button>`

  const elList = root.querySelector('#browse-list')
  const elCount = root.querySelector('#browse-count')
  const elMore = root.querySelector('#browse-more')
  const elTypes = root.querySelector('#browse-types')
  const elTiers = root.querySelector('#browse-tiers')

  // 视图状态：type/tier 当前筛选，page/items 已加载逻辑页，failed 本次加载失败
  const state = { type: '', tier: '', page: 1, items: [], total: null, exhausted: false, loading: false, loaded: false, failed: false }

  // 服务端页 memo：无状态 collectBrowsePage 每次从头扫，同一 (type, serverPage) 的响应
  // 在视图生命周期内只发一次；目录重启上架的新游戏由重进页面（重建视图）带出
  let pageCache = new Map()
  function fetchMemo(serverPage) {
    if (!pageCache.has(serverPage)) {
      pageCache.set(serverPage, fetchCatalogPage(serverPage, state.type))
    }
    return pageCache.get(serverPage)
  }

  root.querySelector('.browse__back').addEventListener('click', () => {
    location.hash = '#/feed'
  })

  /** 失败重试与翻页共用入口：首屏失败回第 1 页，翻页失败重试下一页（已成功页不重复 concat） */
  function retryOrMore() {
    if (state.failed) load(state.items.length === 0 ? 1 : state.page + 1)
    else load(state.page + 1)
  }
  elMore.addEventListener('click', retryOrMore)

  function renderChips() {
    elTypes.innerHTML = ''
    const mkType = (value, label) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip' + (state.type === value ? ' chip--on' : '')
      b.textContent = label
      b.addEventListener('click', () => setFilter({ type: value, tier: state.tier }))
      return b
    }
    elTypes.appendChild(mkType('', '全部'))
    for (const t of TYPE_CATALOG) elTypes.appendChild(mkType(t.slug, t.name))

    elTiers.innerHTML = ''
    const mkTier = (value, label) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip' + (state.tier === value ? ' chip--on' : '')
      b.textContent = label
      b.addEventListener('click', () => setFilter({ type: state.type, tier: value }))
      return b
    }
    elTiers.appendChild(mkTier('', '全部'))
    for (const t of TIER_GROUPS) elTiers.appendChild(mkTier(t.key, t.name))
  }

  function setFilter({ type, tier }) {
    if (type === state.type && tier === state.tier) return
    if (type !== state.type) pageCache = new Map() // 换 type 服务端响应不同；仅换 tier 可复用
    state.type = type
    state.tier = tier
    state.page = 1
    state.items = []
    state.exhausted = false
    state.failed = false
    renderChips()
    renderList()
    load(1)
  }

  async function load(page) {
    if (state.loading) return
    state.loading = true
    state.failed = false
    renderFoot()
    try {
      const r = await collectBrowsePage(fetchMemo, { page, pageSize: BROWSE_PAGE_SIZE, tier: state.tier })
      state.total = r.total
      state.items = page === 1 ? r.games : state.items.concat(r.games)
      state.page = page
      state.exhausted = r.exhausted
    } catch {
      state.failed = true // 后端不可达：保留已加载内容，脚部给重试
    } finally {
      state.loading = false
      state.loaded = true
      renderList()
      renderFoot()
    }
  }

  function renderList() {
    elList.innerHTML = ''
    if (state.items.length === 0 && !state.loading) {
      const empty = document.createElement('div')
      empty.className = 'browse__empty'
      empty.textContent = state.failed ? '加载失败，请重试' : '该筛选下暂无游戏'
      elList.appendChild(empty)
      return
    }
    for (const g of state.items) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'browse__item'
      const name = document.createElement('div')
      name.className = 'browse__item-name'
      name.textContent = g.name || g.slug || g.id
      const meta = document.createElement('div')
      meta.className = 'browse__item-meta'
      const parts = [typeName(g.type), tierName(g.tier)]
      if (Number.isFinite(g.levels) && g.levels > 0) parts.push(`${g.levels}关`)
      meta.textContent = parts.filter(Boolean).join(' · ')
      item.appendChild(name)
      item.appendChild(meta)
      const arrow = document.createElement('div')
      arrow.className = 'browse__item-arrow'
      arrow.textContent = '›'
      item.appendChild(arrow)
      item.addEventListener('click', () => onOpenGame(g.id))
      elList.appendChild(item)
    }
  }

  function renderFoot() {
    // 计数：tier 未滤时 total 是准确口径；滤了则服务端不知情，只报已列出数
    const filtered = Boolean(state.tier)
    elCount.textContent =
      state.items.length === 0 && !state.loading
        ? ''
        : filtered || state.total === null
          ? `已列出 ${state.items.length} 款`
          : `已列出 ${state.items.length} / ${state.total} 款`

    elMore.style.display = state.loading || state.exhausted || state.failed ? 'none' : 'block'
    elMore.textContent = state.page > 1 ? `加载更多（已到第 ${state.page} 页）` : '加载更多'
    if (state.failed) {
      elMore.style.display = 'block'
      elMore.textContent = '加载失败，点此重试'
    } else if (state.exhausted && state.items.length > 0) {
      elMore.style.display = 'block'
      elMore.disabled = true
      elMore.textContent = `已全部列出 ${state.items.length} 款`
    } else {
      elMore.disabled = false
    }
  }

  renderChips()
  renderList()
  renderFoot()

  /** 进入视图时兜底：未加载过拉第 1 页，上次失败自动重试；正常已加载不重复拉 */
  function refresh() {
    if (state.failed) retryOrMore()
    else if (!state.loaded) load(1)
  }

  return { el: root, refresh }
}
