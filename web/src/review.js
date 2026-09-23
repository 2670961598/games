// 审核后台（GAMES-16，v2 缺口 G8）：列出待审上传（game.json 元信息）→ approve/reject 带原因。
// 全部走后端既有接口（GAMES-6 管线）：GET /api/uploads 待审列表、POST /api/uploads/<id>/approve|reject。
// 预览口径：待审内容不经 /games/ 外露（后端既定安全口径，smoke 有断言），上架前无可点预览；
// approve 应答带回终版 game.url → 已审卡片给「预览 ↗」（新开页）与「去玩」（进站内播放器）。
import { fetchPendingUploads, approveUpload, rejectUpload } from './api.js'

const POLL_MS = 5000 // 待审队列轮询：审核人常驻页面上，新提交 5s 内可见
const REASON_MAX = 200 // 服务端 reject reason 截断口径（≤200 字）

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function createReview({ onOpenGame }) {
  const root = document.createElement('div')
  root.className = 'review'

  root.innerHTML = `
    <header class="mine__head">
      <button class="mine__back" type="button">‹ 我的</button>
      <div class="mine__title">审核后台</div>
    </header>
    <div class="review__body">
      <div class="rv-result rv-result--ok" id="rv-ok" hidden></div>
      <div class="rv-result rv-result--err" id="rv-err" hidden></div>
      <div class="rv-list-head" id="rv-pend-head">待审上传</div>
      <div class="rv-list" id="rv-pending"></div>
      <div class="rv-list-head" id="rv-done-head" hidden>本会话已审</div>
      <div class="rv-list" id="rv-done"></div>
      <div class="rv-rules" id="rv-rules"></div>
    </div>`

  // 说明走 textContent：含尖括号字面量（/games/ 路径段），不进 innerHTML
  root.querySelector('#rv-rules').textContent =
    '口径：approve/reject 调用既有 /api/uploads 接口；待审内容不经 /games/ 外露（后端安全口径），' +
    '上架前无预览——approve 后此处给出终版入口链接（同名冲突自动 -2 后缀）。驳回必附原因（≤200 字，服务端截断）。'

  const $ = (sel) => root.querySelector(sel)
  const okStrip = $('#rv-ok')
  const errStrip = $('#rv-err')
  const pendHead = $('#rv-pend-head')
  const pendList = $('#rv-pending')
  const doneHead = $('#rv-done-head')
  const doneList = $('#rv-done')

  let pending = [] // 服务端待审记录（listPending 口径）
  let reviewed = [] // 本会话审毕 { rec, state, game?, reason?, at }（新者在前）
  let sig = '' // 待审清单签名：不变则跳过重渲染（防轮询闪掉正在填的驳回原因）
  const drafts = new Map() // 驳回原因草稿 id → string（重渲染后回填）
  const openForm = new Set() // 展开驳回原因表单的 id

  $('.mine__back').addEventListener('click', () => {
    location.hash = '#/mine'
  })

  function showOk(msg) {
    errStrip.hidden = true
    okStrip.textContent = msg
    okStrip.hidden = false
  }
  function showError(msg) {
    okStrip.hidden = true
    errStrip.textContent = msg
    errStrip.hidden = false
  }

  // ---- 元信息行（textContent 装配，服务端字符串不当 HTML） ----

  function metaLine(rec) {
    const slug = rec.slug || '（按名称生成）'
    const parts = [
      `${rec.type || 'community'}:${slug}`,
      `tier ${rec.tier || 'standard'}`,
      `${rec.levels || 1} 关`,
      `入口 ${rec.entryFile || 'index.html'}`,
    ]
    return parts.join(' · ')
  }
  function fileLine(rec) {
    const kind = rec.kind === 'zip' ? 'zip 包' : '单 html'
    return `${rec.filename || ''}（${kind}） · ${fmtBytes(rec.bytes || 0)} · ${fmtTime(rec.submittedAt || Date.now())} · ${rec.id}`
  }

  function appendMeta(box, text, cls) {
    const el = document.createElement('div')
    el.className = cls
    el.textContent = text
    box.appendChild(el)
    return el
  }

  // ---- 待审卡片（结构：head 行 = 元信息 + 角标；下接 驳回表单 / 动作区，纵向堆叠） ----

  function cardHead(rec) {
    const head = document.createElement('div')
    head.className = 'rv-card__head'
    const main = document.createElement('div')
    main.className = 'rv-card__main'
    appendMeta(main, rec.name || rec.slug || rec.id, 'rv-card__name')
    return { head, main }
  }

  function renderPendingCard(rec) {
    const card = document.createElement('div')
    card.className = 'rv-card'

    const { head, main } = cardHead(rec)
    appendMeta(main, metaLine(rec), 'rv-card__meta')
    if (rec.description) appendMeta(main, rec.description, 'rv-card__desc')
    appendMeta(main, fileLine(rec), 'rv-card__meta')

    const badge = document.createElement('span')
    badge.className = 'rv-badge rv-badge--pending'
    badge.textContent = '待审'
    head.append(main, badge)
    card.appendChild(head)

    // 驳回原因表单（默认收起；草稿回填）
    const form = document.createElement('div')
    form.className = 'rv-reason'
    form.hidden = !openForm.has(rec.id)
    const input = document.createElement('input')
    input.className = 'rv-input'
    input.type = 'text'
    input.maxLength = REASON_MAX
    input.placeholder = `驳回原因（必填，≤${REASON_MAX} 字）`
    input.value = drafts.get(rec.id) || ''
    input.addEventListener('input', () => drafts.set(rec.id, input.value))
    const row = document.createElement('div')
    row.className = 'rv-actions'
    const confirmBtn = document.createElement('button')
    confirmBtn.className = 'rv-btn rv-btn--reject'
    confirmBtn.type = 'button'
    confirmBtn.textContent = '确认驳回'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'rv-btn rv-btn--ghost'
    cancelBtn.type = 'button'
    cancelBtn.textContent = '取消'
    cancelBtn.addEventListener('click', () => {
      openForm.delete(rec.id)
      form.hidden = true
    })
    confirmBtn.addEventListener('click', () => onReject(rec, input))
    row.append(confirmBtn, cancelBtn)
    form.append(input, row)
    card.appendChild(form)

    // 动作区
    const actions = document.createElement('div')
    actions.className = 'rv-actions'
    const okBtn = document.createElement('button')
    okBtn.className = 'rv-btn rv-btn--approve'
    okBtn.type = 'button'
    okBtn.textContent = '✓ 通过上架'
    okBtn.addEventListener('click', () => onApprove(rec, okBtn))
    const noBtn = document.createElement('button')
    noBtn.className = 'rv-btn rv-btn--rejectghost'
    noBtn.type = 'button'
    noBtn.textContent = '✕ 驳回'
    noBtn.addEventListener('click', () => {
      openForm.add(rec.id)
      form.hidden = false
      input.focus()
    })
    actions.append(okBtn, noBtn)
    card.appendChild(actions)

    return card
  }

  // ---- 已审卡片（本会话） ----

  function renderDoneCard(item) {
    const card = document.createElement('div')
    card.className = `rv-card rv-card--${item.state}`

    const { head, main } = cardHead(item.rec)
    if (item.state === 'published' && item.game) {
      appendMeta(main, `已上架：${item.game.id || `${item.game.type}:${item.game.slug}`}`, 'rv-card__meta')
      const links = document.createElement('div')
      links.className = 'rv-actions'
      const preview = document.createElement('a')
      preview.className = 'rv-btn rv-btn--approve'
      preview.href = item.game.url
      preview.target = '_blank'
      preview.rel = 'noopener'
      preview.textContent = '预览 ↗'
      links.appendChild(preview)
      if (item.game.id && onOpenGame) {
        const play = document.createElement('button')
        play.className = 'rv-btn rv-btn--ghost'
        play.type = 'button'
        play.textContent = '去玩 ›'
        play.addEventListener('click', async () => {
          play.disabled = true
          try {
            const ok = await onOpenGame(item.game.id) // 清单没有时由宿主重拉目录再路由
            if (!ok) showError('暂时找不到该游戏（清单尚未同步），稍后再试')
          } catch {
            showError('暂时找不到该游戏（清单拉取失败），稍后再试')
          } finally {
            play.disabled = false
          }
        })
        links.appendChild(play)
      }
      main.appendChild(links)
    } else if (item.state === 'rejected') {
      appendMeta(main, `驳回原因：${item.reason || '（未附原因）'}`, 'rv-card__reason')
    }
    appendMeta(main, `${item.rec.id} · ${fmtTime(item.at)}`, 'rv-card__meta')

    const badge = document.createElement('span')
    badge.className = `rv-badge rv-badge--${item.state}`
    badge.textContent = item.state === 'published' ? '已上架' : '已驳回'
    head.append(main, badge)
    card.appendChild(head)

    return card
  }

  // ---- 渲染 ----

  function render() {
    pendHead.textContent = pending.length ? `待审上传（${pending.length}）` : '待审上传'
    pendList.innerHTML = ''
    if (pending.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'rv-empty'
      empty.textContent = '没有待审上传'
      pendList.appendChild(empty)
    } else {
      for (const rec of pending) pendList.appendChild(renderPendingCard(rec))
    }

    doneHead.hidden = reviewed.length === 0
    doneList.innerHTML = ''
    for (const item of reviewed) doneList.appendChild(renderDoneCard(item))
  }

  // ---- 轮询（仅视图活跃时跑；单飞防堆积） ----

  let pollTimer = null
  let polling = false

  async function refresh({ force = false } = {}) {
    if (polling) return
    polling = true
    try {
      const list = await fetchPendingUploads()
      pending = Array.isArray(list) ? list.filter((p) => p && p.id) : []
      const next = pending.map((p) => `${p.id}@${p.submittedAt}`).join(',')
      if (force || next !== sig) {
        sig = next
        render()
      }
    } catch (err) {
      showError(`待审列表拉取失败：${String(err && err.message ? err.message : err)}`)
    } finally {
      polling = false
    }
  }

  // ---- 审核动作（调既有 /api/uploads 接口；成功即出队入「本会话已审」） ----

  function settle(rec, patch) {
    pending = pending.filter((p) => p.id !== rec.id)
    reviewed = [{ rec, at: Date.now(), ...patch }, ...reviewed.filter((r) => r.rec.id !== rec.id)].slice(0, 20)
    sig = pending.map((p) => `${p.id}@${p.submittedAt}`).join(',')
    openForm.delete(rec.id)
    drafts.delete(rec.id)
    render()
  }

  async function onApprove(rec, btn) {
    btn.disabled = true
    try {
      const r = await approveUpload(rec.id)
      settle(rec, { state: 'published', game: r.game })
      showOk(`已上架：${r.game ? r.game.url : rec.id}（清单即时生效）`)
    } catch (err) {
      showError(`上架失败：${String(err && err.message ? err.message : err)}`)
      btn.disabled = false
      refresh() // 状态机口径（404/409）多为已被并发流转 → 拉最新队列对齐
    }
  }

  async function onReject(rec, input) {
    const reason = input.value.trim()
    if (!reason) {
      showError(`驳回需附原因（≤${REASON_MAX} 字）`)
      input.focus()
      return
    }
    input.disabled = true
    try {
      await rejectUpload(rec.id, reason)
      settle(rec, { state: 'rejected', reason })
      showOk(`已驳回：${rec.id}`)
    } catch (err) {
      showError(`驳回失败：${String(err && err.message ? err.message : err)}`)
      input.disabled = false
      input.focus()
      refresh()
    }
  }

  function activate() {
    refresh({ force: true })
    if (!pollTimer) pollTimer = setInterval(() => refresh(), POLL_MS)
  }

  function deactivate() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return { el: root, activate, deactivate }
}
