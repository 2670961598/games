// 单游戏播放器：我的页历史项“再次进入该游戏”用的全屏容器（需求 3）。
import { DurationTracker } from './duration.js'

export function createPlayer({ onClose }) {
  const root = document.createElement('div')
  root.className = 'player'

  const bar = document.createElement('div')
  bar.className = 'player__bar'
  const back = document.createElement('button')
  back.className = 'player__back'
  back.type = 'button'
  back.textContent = '‹ 返回'
  const title = document.createElement('div')
  title.className = 'player__title'
  bar.appendChild(back)
  bar.appendChild(title)

  const stage = document.createElement('div')
  stage.className = 'player__stage'
  const iframe = document.createElement('iframe')
  iframe.className = 'player__frame'
  iframe.setAttribute('title', '游戏')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  stage.appendChild(iframe)

  root.appendChild(bar)
  root.appendChild(stage)

  back.addEventListener('click', () => onClose())

  /** 当前游戏句柄（main 据此计时长）——未打开时为 null */
  let current = null

  function open(game) {
    if (current && current.id === game.id) return
    const tracker = new DurationTracker()
    current = { id: game.id, tracker }
    title.textContent = game.name
    iframe.setAttribute('src', game.url)
    return current
  }

  return {
    el: root,
    open,
    getActive() {
      return current // tracker 的 start/stop 由 main 统一管（前台/可见性切换）
    },
  }
}
