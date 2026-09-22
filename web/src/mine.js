// 我的页：GAMES-5 需求 3（玩过的游戏去重列表、每款累计时长、总时长、点击再进）。
// GAMES-11：顶部加「上传我的游戏」入口（→ #/upload），带待审计数角标（读上传台账）。
import { aggregatePlayed, formatDuration } from './stats.js'
import { store } from './store.js'

export function createMine({ getSnapshot, onOpenGame }) {
  const root = document.createElement('div')
  root.className = 'mine'

  root.innerHTML = `
    <header class="mine__head">
      <button class="mine__back" type="button">‹ 刷一刷</button>
      <div class="mine__title">我的</div>
    </header>
    <div class="mine__total">
      <div class="mine__total-num" id="mine-total">—</div>
      <div class="mine__total-label">累计游玩时长</div>
    </div>
    <div class="mine__uploads">
      <button class="mine__upload" type="button" id="mine-upload">
        <div class="mine__upload-icon">⬆</div>
        <div class="mine__upload-text">
          <div class="mine__upload-title">上传我的游戏</div>
          <div class="mine__upload-sub">zip / 单 html，审核后上架刷玩</div>
        </div>
        <span class="mine__upload-badge" id="mine-upload-badge" hidden></span>
        <div class="mine__item-arrow">›</div>
      </button>
    </div>
    <div class="mine__list" id="mine-list"></div>`

  root.querySelector('.mine__back').addEventListener('click', () => {
    location.hash = '#/feed'
  })
  root.querySelector('#mine-upload').addEventListener('click', () => {
    location.hash = '#/upload'
  })

  function refresh() {
    const { stats, catalog } = getSnapshot()
    root.querySelector('#mine-total').textContent = formatDuration(stats.totalMs)

    // 上传入口角标：待审数（台账在上传视图轮询时更新，这里只读）
    const tracked = store.get('uploads', [])
    const pending = Array.isArray(tracked) ? tracked.filter((t) => t && t.state === 'pending').length : 0
    const badge = root.querySelector('#mine-upload-badge')
    badge.hidden = pending === 0
    badge.textContent = `${pending} 待审`

    const list = root.querySelector('#mine-list')
    const rows = aggregatePlayed(stats, catalog)
    list.innerHTML = ''
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mine__empty'
      empty.textContent = '还没玩过游戏，去刷一刷吧'
      list.appendChild(empty)
      return
    }
    for (const row of rows) {
      const item = document.createElement('button')
      item.className = 'mine__item'
      item.type = 'button'
      const name = document.createElement('div')
      name.className = 'mine__item-name'
      name.textContent = row.name
      const meta = document.createElement('div')
      meta.className = 'mine__item-meta'
      meta.textContent = `${formatDuration(row.totalMs)} · 玩过 ${row.count} 次`
      item.appendChild(name)
      item.appendChild(meta)
      const arrow = document.createElement('div')
      arrow.className = 'mine__item-arrow'
      arrow.textContent = '›'
      item.appendChild(arrow)
      item.addEventListener('click', () => onOpenGame(row.id))
      list.appendChild(item)
    }
  }

  return { el: root, refresh }
}
