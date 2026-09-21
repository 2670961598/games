// localStorage 访客级持久化（袋状态 / 统计 / 未送达上报事件 / 访客id）。
// 全部容错：隐私模式、配额、禁用 localStorage 时静默降级为内存态。
const PREFIX = 'games5:'

const memory = new Map()

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      if (raw != null) return JSON.parse(raw)
    } catch {
      /* fallthrough */
    }
    return memory.has(key) ? memory.get(key) : fallback
  },
  set(key, value) {
    memory.set(key, value)
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      /* 静默：内存态兜底 */
    }
  },
}

/** 访客 id：首次生成后长期复用（用于后端上报关联）。生成循环补齐，保证满足读取校验的长度 */
export function visitorId() {
  let id = store.get('visitor', null)
  if (typeof id !== 'string' || !/^v-[a-z0-9]{8,}$/.test(id)) {
    let body = ''
    while (body.length < 10) body += Math.random().toString(36).slice(2, 10)
    id = 'v-' + body.slice(0, 10)
    store.set('visitor', id)
  }
  return id
}
