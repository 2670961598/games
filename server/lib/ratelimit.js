// 每 IP 固定窗口限速（内存态，重启清零——单机个人场景足够）。
// 用在上传接口：每 IP 每分钟 N 次（默认 10，单据要求）。

export function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const buckets = new Map()

  return function hit(key) {
    const now = Date.now()
    let b = buckets.get(key)
    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 }
      buckets.set(key, b)
    }
    b.count++
    // 桶多了顺手清扫过期的，防长跑内存增长
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k)
    }
    return {
      allowed: b.count <= max,
      count: b.count,
      retryAfterSec: Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)),
    }
  }
}
