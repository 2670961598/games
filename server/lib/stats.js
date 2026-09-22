// 游玩时长统计：追加写 JSONL（崩溃安全：行级 O_APPEND，损坏行读取时跳过），
// 查询全量读入后按 visitorId 聚合。个人本机规模（MB 级文件）全量扫毫秒级，够用。
import { appendFile, mkdir, readFile } from 'node:fs/promises'

export function createStats({ dir, file }) {
  /** rows: [{ at, visitorId, gameId, s }]（s = 秒，可小数） */
  async function record(rows) {
    if (!rows.length) return 0
    await mkdir(dir, { recursive: true })
    await appendFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return rows.length
  }

  /** 该访客玩过列表（按最近游玩倒序）与累计秒数 */
  async function summary(visitorId) {
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return { visitorId, totalSeconds: 0, games: [] } // 无文件 = 没玩过
    }
    const agg = new Map()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue // 损坏行跳过，不拖垮整个查询
      }
      if (!ev || ev.visitorId !== visitorId || typeof ev.gameId !== 'string') continue
      const s = Number(ev.s) || 0
      const at = Number(ev.at) || 0
      const g = agg.get(ev.gameId) || { gameId: ev.gameId, seconds: 0, plays: 0, firstAt: at, lastAt: at }
      g.seconds += s
      g.plays++
      if (at && at < g.firstAt) g.firstAt = at
      if (at > g.lastAt) g.lastAt = at
      agg.set(ev.gameId, g)
    }
    const games = [...agg.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((g) => ({ ...g, seconds: Math.round(g.seconds * 1000) / 1000 }))
    const totalSeconds = Math.round(games.reduce((t, g) => t + g.seconds, 0) * 1000) / 1000
    return { visitorId, totalSeconds, games }
  }

  return { record, summary }
}
