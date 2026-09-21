// 我的页：GAMES-5 需求 3（玩过的游戏去重列表、每款累计时长、总时长、点击再进）。
import { aggregatePlayed, formatDuration } from './stats.js'

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
    <div class="mine__list" id="mine-list"></div>`

  root.querySelector('.mine__back').addEventListener('click', () => {
    location.hash = '#/feed'
  })

  function refresh() {
    const { stats, catalog } = getSnapshot()
    root.querySelector('#mine-total').textContent = formatDuration(stats.totalMs)

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
