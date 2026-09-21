import './style.css'

// 骨架占位页的唯一样本逻辑：验证前后端链路（/api/health）。
// feed/游戏逻辑是后续单，此处刻意保持最小。
async function checkHealth(): Promise<void> {
  const el = document.getElementById('health')
  if (!el) return
  try {
    const res = await fetch('/api/health')
    const body: unknown = await res.json()
    if (res.ok && body !== null && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
      el.dataset.state = 'ok'
      el.textContent = '● 后端就绪（/api/health → ok:true）'
    } else {
      throw new Error(`unexpected body: ${JSON.stringify(body)}`)
    }
  } catch (err) {
    el.dataset.state = 'fail'
    el.textContent = `● 后端未就绪（${String(err)}）`
  }
}

void checkHealth()
