// 上传我的游戏（GAMES-11，v2 缺口 G3）：我的页入口 → multipart 表单（zip / 单 html + 元数据）
// → POST /api/upload（XHR 字节进度）→ 轮询 GET /api/uploads/<id> → 待审/已上架/已驳回（含原因）展示。
// 校验按后端现有口径（GAMES-6）：客户端只做轻量前置检查（文件必选、扩展名、≤2MB 体积预检），
// 结构校验（html 根/script src 白名单等）以服务端 4xx 信息原样展示——G9 增强不在本单。
import { store } from './store.js'
import { uploadGame, fetchUpload } from './api.js'

const MAX_TRACKED = 20 // 「我的上传」本地记录上限（超出丢最旧）
const POLL_MS = 5000 // 审核状态轮询间隔（人工审核以分钟/小时计，5s 探测绰绰有余）
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // 服务端默认口径（UPLOAD_MAX_MB=2）；预检挡在前端，免整包白传后吃 413 连接重置

const BADGE_TEXT = { pending: '待审核', published: '已上架', rejected: '已驳回', lost: '已失效' }

// ---- 本地上传台账（localStorage；形状不符整体丢弃，不让脏数据卡死渲染） ----

function loadTracked() {
  const raw = store.get('uploads', [])
  if (!Array.isArray(raw)) return []
  return raw.filter((t) => t && typeof t.id === 'string' && /^up-[a-z0-9-]+$/.test(t.id) && typeof t.state === 'string')
}

function saveTracked(list) {
  store.set('uploads', list.slice(0, MAX_TRACKED))
}

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function createUpload({ onOpenGame }) {
  const root = document.createElement('div')
  root.className = 'upload'

  root.innerHTML = `
    <header class="mine__head">
      <button class="mine__back" type="button">‹ 我的</button>
      <div class="mine__title">上传我的游戏</div>
    </header>
    <div class="upload__body">
      <form class="up-form" id="up-form" novalidate>
        <label class="up-file" id="up-file">
          <input type="file" id="up-file-input" accept=".zip,.html,.htm" hidden>
          <div class="up-file__main" id="up-file-main">点击选择游戏文件</div>
          <div class="up-file__hint">自包含单 .html 或 .zip 包（zip 需含入口 index.html）</div>
        </label>
        <div class="up-error" id="up-error" hidden></div>
        <div class="up-done" id="up-done" hidden></div>
        <input class="up-input" id="up-name" type="text" maxlength="64" placeholder="游戏名（可选，≤64 字）">
        <input class="up-input" id="up-slug" type="text" maxlength="64" placeholder="slug（可选，默认按游戏名生成）">
        <div class="up-row">
          <input class="up-input" id="up-levels" type="number" inputmode="numeric" min="1" max="9999" placeholder="关卡数">
          <select class="up-input" id="up-tier">
            <option value="">难度档位</option>
            <option value="relaxed">轻松 relaxed</option>
            <option value="simple">简单 simple</option>
            <option value="normal">标准 normal</option>
            <option value="hard">困难 hard</option>
            <option value="master">大师 master</option>
          </select>
        </div>
        <textarea class="up-input" id="up-desc" rows="2" maxlength="256" placeholder="简介（可选，≤256 字）"></textarea>
        <button class="up-submit" id="up-submit" type="submit">提交审核</button>
        <div class="up-progress" id="up-progress" hidden>
          <span class="up-progress__track"><i class="up-progress__bar" id="up-progress-bar"></i></span>
          <em class="up-progress__text" id="up-progress-text">0%</em>
        </div>
      </form>
      <div class="up-rules" id="up-rules"></div>
      <div class="up-list-head">我的上传</div>
      <div class="up-list" id="up-list"></div>
    </div>`

  // 规则文案走 textContent：含尖括号写法（<html>），进 innerHTML 会被当标签解析
  root.querySelector('#up-rules').textContent =
    '校验口径（与后端一致）：≤2MB；html 需含 <html> 根元素；script src 仅允许相对路径或 jsdelivr/unpkg/cdnjs/esm.sh 白名单外域。' +
    '元数据也可写进 zip 内 game.json，与表单互补（表单非空字段优先）。审核通过后上架到 games/community/ 并进入刷玩。'

  const $ = (sel) => root.querySelector(sel)
  const fileInput = $('#up-file-input')
  const fileBox = $('#up-file')
  const fileMain = $('#up-file-main')
  const errBox = $('#up-error')
  const doneBox = $('#up-done')
  const submitBtn = $('#up-submit')
  const progressBox = $('#up-progress')
  const progressBar = $('#up-progress-bar')
  const progressText = $('#up-progress-text')
  const nameInput = $('#up-name')
  const slugInput = $('#up-slug')
  const levelsInput = $('#up-levels')
  const tierSelect = $('#up-tier')
  const descInput = $('#up-desc')
  const listBox = $('#up-list')

  let tracked = loadTracked()

  $('.mine__back').addEventListener('click', () => {
    location.hash = '#/mine'
  })

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0]
    hideError()
    if (f) {
      fileMain.textContent = `${f.name}（${fmtBytes(f.size)}）`
      fileBox.classList.add('has-file')
    } else {
      fileMain.textContent = '点击选择游戏文件'
      fileBox.classList.remove('has-file')
    }
  })

  function showError(msg) {
    doneBox.hidden = true
    errBox.textContent = msg
    errBox.hidden = false
  }
  function hideError() {
    errBox.hidden = true
  }
  function showDone(msg) {
    errBox.hidden = true
    doneBox.textContent = msg
    doneBox.hidden = false
  }

  function setBusy(busy, ratio) {
    submitBtn.disabled = busy
    fileInput.disabled = busy
    progressBox.hidden = !busy
    if (busy) {
      const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)))
      progressBar.style.width = `${pct}%`
      progressText.textContent = `${pct}%`
      submitBtn.textContent = pct > 0 ? `上传中 ${pct}%` : '上传中…'
    } else {
      submitBtn.textContent = '提交审核'
    }
  }

  function resetForm() {
    fileInput.value = ''
    nameInput.value = ''
    slugInput.value = ''
    levelsInput.value = ''
    tierSelect.value = ''
    descInput.value = ''
    fileMain.textContent = '点击选择游戏文件'
    fileBox.classList.remove('has-file')
  }

  async function onSubmit(e) {
    e.preventDefault()
    hideError()
    const file = fileInput.files && fileInput.files[0]
    if (!file) return showError('请先选择游戏文件（.zip 或 .html）')
    if (!/\.(zip|html|htm)$/i.test(file.name)) return showError('仅支持 .zip 或 .html 文件')
    if (file.size > MAX_UPLOAD_BYTES) {
      return showError(`文件 ${fmtBytes(file.size)} 超过大小上限 2MB（服务端口径，压缩后再来）`)
    }

    const meta = {
      name: nameInput.value.trim(),
      slug: slugInput.value.trim(),
      levels: levelsInput.value.trim(),
      tier: tierSelect.value,
      description: descInput.value.trim(),
    }
    const fd = new FormData()
    fd.append('file', file, file.name)
    for (const [k, v] of Object.entries(meta)) {
      if (v !== '') fd.append(k, v) // 空字段不上送：后端跳过空值、不覆盖 zip 内 game.json 的同名字段
    }

    setBusy(true, 0)
    try {
      const { id } = await uploadGame(fd, {
        onProgress: (loaded, total) => setBusy(true, total > 0 ? loaded / total : 0),
      })
      tracked.unshift({
        id,
        state: 'pending',
        name: meta.name || file.name,
        filename: file.name,
        bytes: file.size,
        submittedAt: Date.now(),
      })
      saveTracked(tracked)
      resetForm()
      renderList()
      showDone('已提交，等待人工审核——状态见下方「我的上传」')
      pollPending() // 立即探一次（不等下一个周期）
    } catch (err) {
      showError(String(err && err.message ? err.message : err))
    } finally {
      setBusy(false, 0)
    }
  }
  $('#up-form').addEventListener('submit', onSubmit)

  // ---- 状态轮询（仅视图活跃时跑；后台/隐藏页签静默跳过本轮） ----

  let pollTimer = null
  let polling = false // 单飞：上一轮未收完不叠加（慢网络下防请求堆积）

  function applyRemote(t, rec) {
    if (!rec) {
      // 404：待审目录与台账均已无此 id（数据被清理）→ 本地标失效
      t.state = 'lost'
      t.reviewedAt = Date.now()
    } else if (rec.state === 'pending') {
      return
    } else {
      t.state = rec.state
      t.reviewedAt = rec.reviewedAt
      if (rec.state === 'rejected') t.reason = rec.reason || '（审核未附原因）'
      if (rec.state === 'published') t.gameId = rec.type && rec.slug ? `${rec.type}:${rec.slug}` : ''
    }
    saveTracked(tracked)
    renderList()
  }

  async function pollPending() {
    if (polling) return
    polling = true
    try {
      for (const t of tracked) {
        if (t.state !== 'pending') continue
        let rec
        try {
          rec = await fetchUpload(t.id)
        } catch {
          continue // 后端未就绪/网络抖动：保留现状，下轮再探
        }
        applyRemote(t, rec)
      }
    } finally {
      polling = false
    }
  }

  function activate() {
    tracked = loadTracked() // 回视图时重读（其他入口也可能更新台账）
    renderList()
    pollPending()
    if (!pollTimer) pollTimer = setInterval(pollPending, POLL_MS)
  }

  function deactivate() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // ---- 我的上传列表 ----

  function renderList() {
    listBox.innerHTML = ''
    if (tracked.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'up-empty'
      empty.textContent = '还没有上传记录'
      listBox.appendChild(empty)
      return
    }
    for (const t of tracked) {
      const item = document.createElement('div')
      item.className = `up-item up-item--${t.state}`

      const main = document.createElement('div')
      main.className = 'up-item__main'

      const name = document.createElement('div')
      name.className = 'up-item__name'
      name.textContent = t.name || t.id
      main.appendChild(name)

      const meta = document.createElement('div')
      meta.className = 'up-item__meta'
      meta.textContent = `${fmtBytes(t.bytes || 0)} · ${fmtTime(t.submittedAt || Date.now())} · ${t.id}`
      main.appendChild(meta)

      if (t.state === 'rejected') {
        const reason = document.createElement('div')
        reason.className = 'up-item__reason'
        reason.textContent = `驳回原因：${t.reason || '（审核未附原因）'}`
        main.appendChild(reason)
      }

      if (t.state === 'published') {
        const info = document.createElement('div')
        info.className = 'up-item__meta'
        info.textContent = t.gameId ? `已入清单：${t.gameId}` : '已入清单'
        main.appendChild(info)
        if (t.gameId) {
          const play = document.createElement('button')
          play.className = 'up-item__play'
          play.type = 'button'
          play.textContent = '去玩 ›'
          play.addEventListener('click', async () => {
            play.disabled = true
            try {
              const ok = await onOpenGame(t.gameId) // 清单没有时由宿主重拉目录再路由
              if (!ok) showError('暂时找不到该游戏（清单尚未同步），稍后再试')
            } catch {
              showError('暂时找不到该游戏（清单拉取失败），稍后再试')
            } finally {
              play.disabled = false
            }
          })
          main.appendChild(play)
        }
      }

      item.appendChild(main)

      const badge = document.createElement('span')
      badge.className = `up-badge up-badge--${t.state}`
      badge.textContent = BADGE_TEXT[t.state] || t.state
      item.appendChild(badge)

      listBox.appendChild(item)
    }
  }

  return { el: root, activate, deactivate }
}
