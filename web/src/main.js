// 应用装配：目录拉取 → 袋/统计初始化 → feed/我的/上传/大全/审核/播放器六视图 → 路由 → 计时上报管线。
import { fetchGames, fetchGamesPage, reportEvents, beaconEvents, fetchStats } from './api.js'
import { store, visitorId } from './store.js'
import { newBag, reconcile, draw } from './shuffleBag.js'
import { emptyStats, applyEnter, applyDuration, mergeStats, STATS_VERSION } from './stats.js'
import { createFeed } from './feed.js'
import { createMine } from './mine.js'
import { createUpload } from './upload.js'
import { createBrowse } from './browse.js'
import { createReview } from './review.js'
import { createPlayer } from './player.js'

const FLUSH_MS = 15000 // 上报间隔
const QUEUE_CAP = 500 // 未送达事件上限（超出丢最旧）

// ---- 全局状态（boot 后填充） ----
let catalog = []
let catalogById = new Map()
let bag = null
let stats = emptyStats()
let pendingEvents = [] // 未送达 {gameId, ms, at}

// 计时句柄：当前正在玩的游戏 {id, tracker} | null
let activeRef = null

let feed = null
let mine = null
let upload = null
let browse = null
let review = null
let player = null
let currentView = 'boot'

// ---- 统计与事件 ----

function persistStats() {
  store.set('stats', stats)
}

function recordDuration(gameId, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  stats = applyDuration(stats, gameId, ms, Date.now())
  persistStats()
  pendingEvents.push({ gameId, ms, at: Date.now() })
  if (pendingEvents.length > QUEUE_CAP) pendingEvents = pendingEvents.slice(-QUEUE_CAP)
  store.set('events', pendingEvents)
}

/** 把当前 tracker 的增量落账（周期 flush / 隐藏 / 卸载共用；drain 语义，无水位双计） */
function recordActiveDelta() {
  if (!activeRef) return
  recordDuration(activeRef.id, activeRef.tracker.drain())
}

function eventsWithVisitor() {
  const vid = visitorId()
  return pendingEvents.map((e) => ({ ...e, visitorId: vid }))
}

let flushing = false // 上报互斥：慢请求期间周期触发不得重发同批事件（服务端无幂等去重）
async function flushEvents() {
  if (pendingEvents.length === 0 || flushing) return
  flushing = true
  const batch = eventsWithVisitor()
  try {
    await reportEvents(batch)
    pendingEvents = pendingEvents.slice(batch.length) // 送达的出队，期间新增的保留
    store.set('events', pendingEvents)
  } catch {
    /* 后端未就绪/离线：仅本地保留，下轮再试 */
  } finally {
    flushing = false
  }
}

function flushEventsBeacon() {
  if (pendingEvents.length === 0) return
  const batch = eventsWithVisitor()
  if (beaconEvents(batch)) {
    pendingEvents = pendingEvents.slice(batch.length)
    store.set('events', pendingEvents)
  }
}

// ---- 计时句柄切换 ----

function setActiveRef(ref) {
  if (ref === activeRef) return
  if (activeRef) {
    activeRef.tracker.stop()
    const ms = activeRef.tracker.consume()
    recordDuration(activeRef.id, ms)
  }
  activeRef = ref
  if (ref && document.visibilityState === 'visible') ref.tracker.start()
}

/** 记一次“进入游戏”（feed 切到新屏 / 播放器打开时各调一次） */
function enterGame(gameId) {
  stats = applyEnter(stats, gameId, Date.now())
  persistStats()
}

/**
 * boot 时把服务端历史并入本地（GAMES-15 跨设备恢复，合并口径见 stats.js mergeStats 注释）。
 * 后台执行不阻塞首屏；失败静默——服务端不可达时我的页维持本地口径，下次 boot 再试。
 * 期间产生的新游玩在 await 返回后一并参与合并（字段级取 max，与到达顺序无关）。
 */
async function syncRemoteStats() {
  try {
    const remote = await fetchStats(visitorId())
    stats = mergeStats(stats, remote)
    persistStats()
    if (mine && currentView === 'mine') mine.refresh() // 我的页已打开时把合并结果刷上屏
  } catch {
    /* 离线/后端未就绪：本地口径兜底 */
  }
}

// ---- feed 袋子 ----

/**
 * 打开「我上传的游戏」：刚上架的游戏不在本会话清单里 → 重拉目录并 reconcile 袋，再路由进播放器。
 * catalogById 原地清空重填（不换 Map）：feed/player 持有旧引用，换新实例会让他们看不见新游戏。
 * 返回 false = 重拉后仍未见该 id（同步延迟/已下架），由调用方提示。
 */
async function openUploadedGame(gameId) {
  if (!catalogById.has(gameId)) {
    try {
      const fresh = await fetchGames()
      catalog = fresh
      catalogById.clear()
      for (const g of fresh) catalogById.set(g.id, g)
      bag = reconcile(bag, fresh.map((g) => g.id))
      store.set('bag', bag)
    } catch {
      /* 重拉失败：走未命中分支 */
    }
  }
  if (!catalogById.has(gameId)) return false
  location.hash = `#/play/${encodeURIComponent(gameId)}`
  return true
}

function drawNext() {
  if (catalog.length === 0) return null
  const r = draw(bag, catalog.map((g) => g.id))
  bag = r.state
  store.set('bag', bag)
  return r.id
}

// ---- 视图与路由 ----

function showView(name) {
  if (name === currentView) return
  const prev = currentView
  currentView = name
  document.body.dataset.view = name

  if (prev === 'feed') {
    feed.setRunning(false)
    feed.deactivateAll()
  }
  if (prev === 'upload') upload.deactivate() // 停审核状态轮询
  if (prev === 'review') review.deactivate() // 停待审队列轮询
  if (prev === 'player') setActiveRef(null)

  if (name === 'feed') {
    feed.setRunning(true) // 内部会重发当前游戏句柄 → setActiveRef
  } else if (name === 'mine') {
    setActiveRef(null)
    mine.refresh()
  } else if (name === 'upload') {
    setActiveRef(null)
    upload.activate() // 重读台账 + 立即探一轮 + 起轮询
  } else if (name === 'review') {
    setActiveRef(null)
    review.activate() // 立即拉待审队列 + 起轮询
  } else if (name === 'browse') {
    setActiveRef(null)
    browse.refresh()
  } else if (name === 'player') {
    setActiveRef(player.getActive())
  }
}

function parseHash() {
  const h = location.hash || '#/feed'
  if (h.startsWith('#/play/')) {
    let id = h.slice('#/play/'.length)
    try {
      id = decodeURIComponent(id)
    } catch {
      return { view: 'feed' } // 畸形编码（如 %ZZ）：回首页，不让路由抛错卡死
    }
    return catalogById.has(id) ? { view: 'player', id } : { view: 'mine' }
  }
  if (h === '#/mine') return { view: 'mine' }
  if (h === '#/upload') return { view: 'upload' }
  if (h === '#/review') return { view: 'review' }
  if (h === '#/catalog') return { view: 'browse' }
  return { view: 'feed' }
}

function route() {
  if (!feed || !mine || !upload || !browse || !review || !player) return // boot 未完成（含加载失败重试中）忽略路由
  const { view, id } = parseHash()
  if (view === 'player') {
    setActiveRef(null) // 先结算上一个 tracker（feed 当前屏或播放器里的旧游戏）
    player.open(catalogById.get(id))
    enterGame(id)
    if (currentView === 'player') setActiveRef(player.getActive()) // 同视图换游戏：showView 会早退，手动重绑
  }
  showView(view)
  try {
    sessionStorage.setItem('games5:nav', '1') // 应用内已有导航（播放器返回据此决定 back 还是回首页）
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用：忽略 */
  }
}

// ---- 启动 ----

function renderBoot(message) {
  const app = document.getElementById('app')
  app.innerHTML = `<div class="boot"><div class="boot__logo">GAMES</div><div class="boot__msg">${message}</div></div>`
}

function renderError(detail) {
  document.body.dataset.view = 'error'
  const app = document.getElementById('app')
  app.innerHTML = `<div class="error"><div class="error__msg">游戏清单加载失败</div><div class="error__detail">${detail}</div><button class="error__retry" type="button">重试</button></div>`
  app.querySelector('.error__retry').addEventListener('click', () => {
    renderBoot('正在重新连接…')
    boot()
  })
}

async function boot() {
  if (feed) {
    feed.destroy() // 错误重试重入：释放上一轮 feed（IO/键盘监听）
    feed = null
  }
  document.body.dataset.view = 'boot'
  renderBoot('正在加载游戏清单…')
  try {
    catalog = await fetchGames()
  } catch (err) {
    renderError(String(err && err.message ? err.message : err))
    return
  }
  catalogById = new Map(catalog.map((g) => [g.id, g]))
  const ids = catalog.map((g) => g.id)

  // 袋：已有则 reconcile（目录增删修正），没有则新袋
  const savedBag = store.get('bag', null)
  bag = savedBag && Array.isArray(savedBag.remaining) && Array.isArray(savedBag.cycle) ? reconcile(savedBag, ids) : newBag(ids)
  store.set('bag', bag)

  // 统计：形状不符重置
  const savedStats = store.get('stats', null)
  stats = savedStats && savedStats.v === STATS_VERSION && savedStats.games && typeof savedStats.games === 'object' ? savedStats : emptyStats()
  persistStats()

  pendingEvents = Array.isArray(store.get('events', [])) ? store.get('events', []) : []

  // 六视图
  const app = document.getElementById('app')
  app.innerHTML = ''
  const viewFeed = document.createElement('div')
  viewFeed.id = 'view-feed'
  const viewMine = document.createElement('div')
  viewMine.id = 'view-mine'
  const viewUpload = document.createElement('div')
  viewUpload.id = 'view-upload'
  const viewBrowse = document.createElement('div')
  viewBrowse.id = 'view-browse'
  const viewReview = document.createElement('div')
  viewReview.id = 'view-review'
  const viewPlayer = document.createElement('div')
  viewPlayer.id = 'view-player'
  app.append(viewFeed, viewMine, viewUpload, viewBrowse, viewReview, viewPlayer)

  feed = createFeed({
    catalogById,
    initialIds: bag.cycle,
    drawNext,
    onActiveChange: (ref) => setActiveRef(ref),
    onEnter: (id) => enterGame(id),
  })
  viewFeed.appendChild(feed.el)

  mine = createMine({
    getSnapshot: () => ({ stats, catalog }),
    onOpenGame: (id) => {
      location.hash = `#/play/${encodeURIComponent(id)}`
    },
  })
  viewMine.appendChild(mine.el)

  upload = createUpload({
    onOpenGame: openUploadedGame,
  })
  viewUpload.appendChild(upload.el)

  browse = createBrowse({
    fetchCatalogPage: (page, type) => fetchGamesPage(page, { type }),
    onOpenGame: (id) => {
      location.hash = `#/play/${encodeURIComponent(id)}`
    },
  })
  viewBrowse.appendChild(browse.el)

  review = createReview({
    onOpenGame: openUploadedGame, // 已审「去玩」与上传页同机制：重拉目录 + reconcile 袋再进播放器
  })
  viewReview.appendChild(review.el)

  player = createPlayer({
    onClose: () => {
      // 外链直达播放器时 history.back() 会退出站点：仅在应用内导航过才走历史栈
      if (sessionStorage.getItem('games5:nav') === '1') history.back()
      else location.hash = '#/feed'
    },
  })
  viewPlayer.appendChild(player.el)

  wireGlobal() // 全局按钮/周期上报/生命周期/路由等一次性接线（boot 重入安全）
  currentView = 'boot' // 让首个 route() 必定走 showView 切换路径
  route()
  syncRemoteStats() // 后台并入服务端历史，不阻塞首屏（GAMES-15）
}

/** 一次性全局接线：boot 重入（错误重试）不重复挂监听 */
let wired = false
function wireGlobal() {
  if (wired) return
  wired = true

  document.getElementById('exit-bar').addEventListener('click', () => {
    if (feed) feed.deactivateAll()
  })
  document.getElementById('mine-btn').addEventListener('click', () => {
    location.hash = '#/mine'
  })
  document.getElementById('catalog-btn').addEventListener('click', () => {
    location.hash = '#/catalog'
  })
  document.getElementById('rotate-ok').addEventListener('click', () => {
    document.body.classList.add('wide-ok')
    store.set('wideOk', true)
  })
  if (store.get('wideOk', false) === true) document.body.classList.add('wide-ok')

  setInterval(() => {
    recordActiveDelta()
    flushEvents()
  }, FLUSH_MS)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      recordActiveDelta()
      if (activeRef) activeRef.tracker.stop()
      flushEvents() // 尽力同步发一次
    } else if (activeRef) {
      activeRef.tracker.start()
    }
  })
  window.addEventListener('pagehide', () => {
    recordActiveDelta()
    if (!flushing) flushEventsBeacon() // 有在途 fetch 时不重发同批（fetch 随卸载取消）
  })

  window.addEventListener('hashchange', route)
}

boot()
