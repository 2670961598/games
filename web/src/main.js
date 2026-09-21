// 应用装配：目录拉取 → 袋/统计初始化 → feed/我的/播放器三视图 → 路由 → 计时上报管线。
import { fetchGames, reportEvents, beaconEvents } from './api.js'
import { store, visitorId } from './store.js'
import { newBag, reconcile, draw } from './shuffleBag.js'
import { emptyStats, applyEnter, applyDuration, STATS_VERSION } from './stats.js'
import { createFeed } from './feed.js'
import { createMine } from './mine.js'
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

async function flushEvents() {
  if (pendingEvents.length === 0) return
  const batch = eventsWithVisitor()
  try {
    await reportEvents(batch)
    pendingEvents = pendingEvents.slice(batch.length) // 送达的出队，期间新增的保留
    store.set('events', pendingEvents)
  } catch {
    /* 后端未就绪/离线：仅本地保留，下轮再试 */
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
  if (ref) {
    stats = applyEnter(stats, ref.id, Date.now()) // 进入一次游戏
    persistStats()
    if (document.visibilityState === 'visible') ref.tracker.start()
  }
}

// ---- feed 袋子 ----

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
  if (prev === 'player') setActiveRef(null)

  if (name === 'feed') {
    feed.setRunning(true) // 内部会重发当前游戏句柄 → setActiveRef
  } else if (name === 'mine') {
    setActiveRef(null)
    mine.refresh()
  } else if (name === 'player') {
    setActiveRef(player.getActive())
  }
}

function parseHash() {
  const h = location.hash || '#/feed'
  if (h.startsWith('#/play/')) {
    const id = decodeURIComponent(h.slice('#/play/'.length))
    return catalogById.has(id) ? { view: 'player', id } : { view: 'mine' }
  }
  if (h === '#/mine') return { view: 'mine' }
  return { view: 'feed' }
}

function route() {
  if (!feed || !mine || !player) return // boot 未完成（含加载失败重试中）忽略路由
  const { view, id } = parseHash()
  if (view === 'player') player.open(catalogById.get(id))
  showView(view)
}

// ---- 启动 ----

function renderBoot(message) {
  const app = document.getElementById('app')
  app.innerHTML = `<div class="boot"><div class="boot__logo">GAMES</div><div class="boot__msg">${message}</div></div>`
}

function renderError(detail) {
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

  // 三视图
  const app = document.getElementById('app')
  app.innerHTML = ''
  const viewFeed = document.createElement('div')
  viewFeed.id = 'view-feed'
  const viewMine = document.createElement('div')
  viewMine.id = 'view-mine'
  const viewPlayer = document.createElement('div')
  viewPlayer.id = 'view-player'
  app.append(viewFeed, viewMine, viewPlayer)

  feed = createFeed({
    catalogById,
    initialIds: bag.cycle,
    drawNext,
    onActiveChange: (ref) => setActiveRef(ref),
  })
  viewFeed.appendChild(feed.el)

  mine = createMine({
    getSnapshot: () => ({ stats, catalog }),
    onOpenGame: (id) => {
      location.hash = `#/play/${encodeURIComponent(id)}`
    },
  })
  viewMine.appendChild(mine.el)

  player = createPlayer({
    onClose: () => {
      history.length > 1 ? history.back() : (location.hash = '#/feed')
    },
  })
  viewPlayer.appendChild(player.el)

  wireGlobal() // 全局按钮/周期上报/生命周期/路由等一次性接线（boot 重入安全）
  currentView = 'boot' // 让首个 route() 必定走 showView 切换路径
  route()
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
    flushEventsBeacon()
  })

  window.addEventListener('hashchange', route)
}

boot()
