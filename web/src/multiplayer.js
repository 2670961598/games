// 联机大厅（GAMES-40 第二界面）：正在对战 feed（3s 轮询，5s 红线内反映变化）
// + 联机游戏目录 21 槽（目录与 docs/multiplayer-roadmap.md §3 一一对应，上线即点亮）。
// 网关地址自适应：?gw= 可覆盖，默认本机 hostname:4400（LAN 可玩）。
const GW_PORT = 4400

function gwHttp() {
  const q = new URLSearchParams(location.search).get('gw')
  if (q) return q.replace(/\/+$/, '')
  return `${location.protocol}//${location.hostname}:${GW_PORT}`
}

/* 21 槽目录（roadmap §3；on = 已上线可点，url = 游戏页路径） */
const CATALOG = [
  { name: '净斗坦克', track: 'T4 物理', tech: 'S4', on: true, url: '/games/multiplayer/net-tank/index.html' },
  { name: '指挥官战场', track: 'T1 帧同步', tech: 'S1', on: true, url: '/games/multiplayer/slg-battlefield/index.html' },
  { name: '战棋对决', track: 'T1 帧同步', tech: 'S1+S5' },
  { name: '炸弹乱斗', track: 'T1 帧同步', tech: 'S1' },
  { name: '星海小镇', track: 'T2 状态同步', tech: 'S2' },
  { name: '迷你 MOBA', track: 'T2 状态同步', tech: 'S2' },
  { name: '缩圈大逃杀', track: 'T2 状态同步', tech: 'S2' },
  { name: '帝国萌芽', track: 'T3 混合', tech: 'S3' },
  { name: '街头足球', track: 'T3 混合', tech: 'S3+S4' },
  { name: '极限接力', track: 'T3 混合', tech: 'S3' },
  { name: '八球台球', track: 'T4 物理', tech: 'S4' },
  { name: '苍穹争锋', track: 'T4 物理', tech: 'S4' },
  { name: '元素对决', track: 'T5 回合', tech: 'S5' },
  { name: '弈界棋阁', track: 'T5 回合', tech: 'S5' },
  { name: '深夜狼人', track: 'T5 回合', tech: 'S5' },
  { name: '蛇王争霸', track: 'T6 海量', tech: 'S6' },
  { name: '深海食物链', track: 'T6 海量', tech: 'S6' },
  { name: '派对大乱斗', track: 'T6 海量', tech: 'S6' },
  { name: '极速卡丁', track: 'T7 预测', tech: 'S7' },
  { name: '幸存者小队', track: 'T7 预测', tech: 'S7' },
  { name: '迷宫突击', track: 'T7 预测', tech: 'S7' },
]

const GW = gwHttp()
const $feed = document.getElementById('mp-feed')
const $net = document.getElementById('mp-net')
const $count = document.getElementById('mp-count')
const $grid = document.getElementById('mp-grid')

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function renderFeed(matches) {
  const live = matches.filter((m) => m.joinable || m.spectators > 0)
  if (live.length === 0) {
    $feed.innerHTML = '<div class="mp-empty" id="mp-feed-empty">暂无对局——网关 Bot 宿主补房中…</div>'
    return
  }
  $feed.innerHTML = live.map((m) => {
    const joinLabel = m.joinable ? '加入' : '旁观'
    const cls = m.joinable ? 'mp-card__join' : 'mp-card__join spectate'
    const href = m.joinable
      ? `${m.url}?room=${encodeURIComponent(m.roomId)}&gw=${encodeURIComponent(GW)}`
      : `${m.url}?room=${encodeURIComponent(m.roomId)}&gw=${encodeURIComponent(GW)}&mode=spectate`
    return `<a class="mp-card" href="${href}">
      <div class="mp-card__name">${esc(m.name)}</div>
      <div class="mp-card__meta"><span>${esc(m.mode)}</span><span>真人 ${m.humans}</span><span>Bot ${m.bots}</span>${m.spectators > 0 ? `<span>观战 ${m.spectators}</span>` : ''}</div>
      <div class="mp-card__foot"><span class="mp-card__time">已进行 ${mmss(m.elapsedMs)}</span><span class="${cls}">${joinLabel}</span></div>
    </a>`
  }).join('')
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function poll() {
  try {
    const r = await fetch(`${GW}/api/matches`, { cache: 'no-store' })
    const b = await r.json()
    if (!b.ok) throw new Error('bad feed')
    $net.textContent = `网关在线 · ${b.matches.length} 对局`
    $net.className = 'mp-net on'
    renderFeed(b.matches)
  } catch {
    $net.textContent = '网关未连接'
    $net.className = 'mp-net off'
    $feed.innerHTML = '<div class="mp-empty" id="mp-feed-empty">网关未连接——实时网关(:4400)未运行或不可达</div>'
  }
}

function renderCatalog() {
  const on = CATALOG.filter((g) => g.on).length
  $count.textContent = `${on}/${CATALOG.length} 已上线`
  $grid.innerHTML = CATALOG.map((g) => {
    const cls = g.on ? 'mp-slot on' : 'mp-slot soon'
    const tag = g.on ? `${g.tech} · 可玩` : `${g.tech} · 即将推出`
    return g.on
      ? `<a class="${cls}" href="${g.url}?quick=1&gw=${encodeURIComponent(GW)}"><div class="mp-slot__name">${esc(g.name)}</div><div class="mp-slot__tag">${esc(tag)}</div></a>`
      : `<div class="${cls}"><div class="mp-slot__name">${esc(g.name)}</div><div class="mp-slot__tag">${esc(tag)}</div></div>`
  }).join('')
}

poll()
renderCatalog()
setInterval(() => { if (document.visibilityState === 'visible') poll() }, 3000) // 5s 红线内反映变化
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll() })
