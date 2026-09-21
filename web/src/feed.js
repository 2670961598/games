// 竖屏无限 feed：GAMES-5 需求 1（方案 B——docs/explore/feed-scroll.md 结论）。
//   CSS scroll-snap（一屏一游）+ 保留式 DOM（iframe 永不换绑 src）
//   + IntersectionObserver 懒挂载（相邻预加载）+ LRU iframe 池（内存上限）
//   + 激活层（feed 态盖手势层保滚动，点击进入游戏，显式退出回来——规避 iframe 吞手势）
import { DurationTracker } from './duration.js'

const LOOKAHEAD = 3 // 视口外至少再备 3 屏（相邻预加载）
const MAX_LIVE = 6 // 同时存活的 iframe 上限（LRU 池，超出销毁最久未见的）

export function createFeed({ catalogById, initialIds, drawNext, onActiveChange, onEnter }) {
  const scroller = document.createElement('div')
  scroller.className = 'feed'

  /** @type {Array<{id, game, el, stage, iframe, mounted, tracker, lastVisibleAt, activated, ratio}>} */
  const slots = []
  let activeSlot = null
  let running = false // feed 视图是否处于前台
  let positioned = false // 是否已定位到“最近刷到的一屏”
  let lastEntered = null // 上次已计“进入”的 slot（视图往返不重复计）

  // ---- LRU 依据：可见时间戳 ----
  const lruIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const slot = slots[Number(en.target.dataset.idx)]
        if (slot) slot.lastVisibleAt = Date.now()
      }
    },
    { root: scroller },
  )

  // ---- 懒挂载：接近视口（±150%）才创建 iframe；接近尾部 → 无限追加 ----
  // 注意：追加量以“当前可见屏”为基准（不是被观察到的最远屏——150% rootMargin 本身
  // 已超前 2~3 屏，若按它再叠加 LOOKAHEAD 会开机连抽 7 张，小目录直接抽穿一轮）。
  function visibleIdxEstimate() {
    return Math.max(0, Math.round(scroller.scrollTop / Math.max(1, scroller.clientHeight)))
  }
  const lazyIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const slot = slots[Number(en.target.dataset.idx)]
        if (slot && en.isIntersecting) mount(slot)
      }
      if (entries.length > 0) ensureAhead(visibleIdxEstimate())
    },
    { root: scroller, rootMargin: '150% 0px' },
  )

  // ---- 滚动停稳后补抽（IO 回调只在交叉变化时触发；若邻居屏在滚动途中已被
  //      观察，停稳位置不会再有回调，尾部就断了——scroll 事件兜底）----
  let settleTimer = null
  scroller.addEventListener(
    'scroll',
    () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => ensureAhead(visibleIdxEstimate()), 120)
    },
    { passive: true },
  )

  // ---- 活动屏判定：交叉占比最大的 slot 为“当前游戏”（>0.5 才算）----
  const activeIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const slot = slots[Number(en.target.dataset.idx)]
        if (slot) slot.ratio = en.isIntersecting ? en.intersectionRatio : 0
      }
      recomputeActive()
    },
    { root: scroller, threshold: [0, 0.25, 0.5, 0.75, 1] },
  )

  function recomputeActive() {
    let best = null
    for (const s of slots) {
      if (s.ratio > 0.5 && (!best || s.ratio > best.ratio)) best = s
    }
    if (best === activeSlot) return
    if (activeSlot) {
      activeSlot.tracker.stop()
      deactivate(activeSlot) // 滑走的游戏自动退出激活态
    }
    activeSlot = best
    if (best && running) {
      best.tracker.start()
      if (best !== lastEntered) {
        lastEntered = best // 真正切到新游戏才计“进入一次”（视图往返/重发不重复计）
        onEnter(best.id)
      }
    }
    onActiveChange(best && running ? { id: best.id, tracker: best.tracker } : null)
  }

  // ---- iframe 池 ----
  function mount(slot) {
    if (slot.mounted) return
    slot.mounted = true
    slot.lastVisibleAt = Date.now()
    slot.stage.innerHTML = '' // 清掉 LRU 卸载时补的占位符，防反复挂载累积
    const iframe = document.createElement('iframe')
    iframe.className = 'slot__frame'
    iframe.setAttribute('src', slot.game.url)
    iframe.setAttribute('title', slot.game.name)
    iframe.setAttribute('loading', 'lazy')
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    slot.iframe = iframe
    slot.stage.appendChild(iframe)
    evictLRU(slot)
  }

  function unmount(slot) {
    if (!slot.mounted) return
    slot.mounted = false
    slot.iframe.remove()
    slot.iframe = null
    slot.stage.appendChild(placeholder(slot.game)) // 占位；滑回来时 lazyIO 重挂（状态丢失为 LRU 已知代价）
  }

  function evictLRU(keep) {
    // live = keep + 其余已挂载；超出 MAX_LIVE 时从“最久未见”开始驱逐（activeSlot 豁免）
    const mounted = slots.filter((s) => s.mounted && s !== keep)
    mounted.sort((a, b) => a.lastVisibleAt - b.lastVisibleAt)
    let excess = mounted.length + 1 - MAX_LIVE
    for (const s of mounted) {
      if (excess <= 0) break
      if (s === activeSlot) continue
      unmount(s)
      excess--
    }
  }

  function placeholder(game) {
    const d = document.createElement('div')
    d.className = 'slot__ph'
    d.textContent = game.name
    return d
  }

  // ---- 激活层（feed 态手势层 → 点击进入游戏）----
  function activate(slot) {
    for (const s of slots) if (s !== slot) deactivate(s)
    slot.activated = true
    slot.el.classList.add('is-active')
    document.body.classList.add('feed-active') // 全局退出把手（#exit-bar）依据
  }
  function deactivate(slot) {
    slot.activated = false
    slot.el.classList.remove('is-active')
    if (!slots.some((s) => s.activated)) document.body.classList.remove('feed-active')
  }

  // ---- slot 构建 ----
  function appendSlot(id) {
    const game = catalogById.get(id)
    if (!game) return null // 已下架 → 跳过
    const el = document.createElement('section')
    el.className = 'slot'
    const stage = document.createElement('div')
    stage.className = 'slot__stage'
    stage.appendChild(placeholder(game))
    const tap = document.createElement('div')
    tap.className = 'slot__tap'
    const name = document.createElement('div')
    name.className = 'slot__name'
    name.textContent = game.name
    const play = document.createElement('button')
    play.className = 'slot__play'
    play.type = 'button'
    play.textContent = '开始玩'
    const tip = document.createElement('div')
    tip.className = 'slot__tip'
    tip.textContent = '上滑刷下一个 · 点击进入游戏'
    tap.appendChild(name)
    tap.appendChild(play)
    tap.appendChild(tip)
    const slot = { id, game, el, stage, iframe: null, mounted: false, tracker: new DurationTracker(), lastVisibleAt: Date.now(), activated: false, ratio: 0 }
    tap.addEventListener('click', () => {
      mount(slot) // 点击即确保挂载
      activate(slot)
    })
    el.appendChild(stage)
    el.appendChild(tap)
    el.dataset.idx = String(slots.length)
    slots.push(slot)
    scroller.appendChild(el)
    lazyIO.observe(el)
    activeIO.observe(el)
    lruIO.observe(el)
    return slot
  }

  function ensureAhead(visibleIdx) {
    let guard = 0
    while (slots.length < visibleIdx + 1 + LOOKAHEAD && guard++ < 50) {
      const id = drawNext()
      if (id == null) break // 目录空
      appendSlot(id)
    }
  }

  // ---- 初始化：从袋的当前轮次重建，落到最近刷到的一屏 ----
  // display:none 子树里 offsetTop=0、scrollTop 赋值无效（如重载在 #/mine 时 boot 同步
  // 切走了视图），因此定位动作可重入：首次真正可见时（rAF 或 setRunning(true)）再执行。
  function scrollToLatest() {
    if (positioned || slots.length === 0 || scroller.clientHeight === 0) return
    const last = slots[slots.length - 1]
    scroller.scrollTop = last.el.offsetTop // 末屏对齐（snap 定位）
    positioned = true
  }

  for (const id of initialIds) appendSlot(id)
  if (slots.length === 0) ensureAhead(0)
  if (slots.length > 0) {
    requestAnimationFrame(() => {
      scrollToLatest()
      recomputeActive()
    })
  }

  const onKey = (e) => {
    if (e.key === 'Escape') for (const s of slots) deactivate(s)
  }
  document.addEventListener('keydown', onKey)

  return {
    el: scroller,
    /** feed 前台/后台切换：后台暂停计时；前台定位+强制重发当前游戏句柄 */
    setRunning(on) {
      running = on
      if (!on) {
        if (activeSlot) activeSlot.tracker.stop()
        onActiveChange(null)
      } else {
        scrollToLatest() // 重载入口不在 feed 时，rAF 期间 feed 是 display:none，这里补定位
        activeSlot = null // 清掉再重算，保证切换分支必走（重新 start + 上报句柄）
        recomputeActive()
      }
    },
    deactivateAll() {
      for (const s of slots) deactivate(s)
    },
    destroy() {
      onActiveChange(null) // 让 main 先结算当前 tracker，再整体拆
      if (settleTimer) clearTimeout(settleTimer)
      lazyIO.disconnect()
      activeIO.disconnect()
      lruIO.disconnect()
      document.removeEventListener('keydown', onKey)
      for (const s of slots) {
        s.tracker.stop()
        if (s.mounted) unmount(s)
      }
    },
  }
}
