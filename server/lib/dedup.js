// 上报事件去重（GAMES-14 幂等）：重发/重试不得重复计时。
// 两级键：新客户端事件带 (cid,seq) → 序号窗去重（客户端内单调序号，天然区分重发与新玩）；
// 旧事件无序号 → (visitorId,at,gameId,s) 内容指纹兜底（内容全同视为重发）。指纹含 s：
// 服务端补时戳是 Date.now()，同毫秒到达的两条不同时长合法事件会被 (visitorId,at,gameId)
// 撞键误杀，s 入指纹后「同一事件」= 内容逐字段全同，重发内容不变仍去重。
// 窗口为内存插入序 Map（超窗逐出最旧）：本机规模 4k 键足够覆盖「flush 周期重试 +
// 服务重启重放（启动时从落盘 JSONL 回播种子，见 index.js）」两个真实重发源；窗口外放过不误杀。
export const CID_RE = /^[A-Za-z0-9._:-]{1,64}$/

/** 行 → 去重键；null = 不可去重（无可用指纹），直接放行 */
export function dedupKey(row) {
  if (row && typeof row.cid === 'string' && CID_RE.test(row.cid) && Number.isInteger(row.seq) && row.seq >= 0) {
    return `c:${row.cid}:${row.seq}`
  }
  if (row && typeof row.visitorId === 'string' && row.visitorId !== 'anonymous' && Number.isFinite(row.at) && typeof row.gameId === 'string' && Number.isFinite(row.s)) {
    return `k:${row.visitorId}|${row.at}|${row.gameId}|${row.s}` // anonymous 是脏数据兜底桶，不作指纹（多访客塌缩会互杀）
  }
  return null
}

export function createDedup({ maxKeys = 4096 } = {}) {
  const seen = new Map() // key → 1；Map 迭代序 = 插入序，最旧在前

  return {
    /** 顺序过筛（批内同键重复同样计 dropped）。返回 { fresh, dropped } */
    check(rows) {
      const fresh = []
      let dropped = 0
      for (const row of rows) {
        const key = dedupKey(row)
        if (key === null) {
          fresh.push(row) // 无指纹：不去重也不占窗口（如 anonymous 兜底行）
          continue
        }
        if (seen.has(key)) {
          dropped++
          continue
        }
        seen.set(key, 1)
        if (seen.size > maxKeys) seen.delete(seen.keys().next().value)
        fresh.push(row)
      }
      return { fresh, dropped }
    },

    /** 从落盘行回播种子（重启不失忆）；只保留末 maxKeys 行，与窗口容量对齐 */
    seed(rows) {
      for (const row of rows.slice(-maxKeys)) {
        const key = dedupKey(row)
        if (key !== null) seen.set(key, 1)
      }
    },
  }
}
