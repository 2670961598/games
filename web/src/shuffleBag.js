// 洗牌袋（随机不放回抽取）：GAMES-5 需求 2。
// 纯数据模块——无 DOM / 无 localStorage 依赖，scripts/smoke-feed.js 直接导入测试。
//
// 状态形状（可 JSON 序列化，访客级持久化）：
//   { v, remaining: [id...] , cycle: [id...] }
//   - remaining：本轮还没抽到的游戏（袋内余量）
//   - cycle：本轮已抽出的顺序（同时是 feed 刷新历史的重建依据）
// 不变量：cycle 与 remaining 无交集、各自无重复、并集 ⊆ 当前目录
//（目录可能增删游戏，故所有入口都先过 reconcile 修正）

export const BAG_VERSION = 1

/** Fisher-Yates 洗牌，返回新数组（不改入参） */
export function shuffle(items, rand = Math.random) {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

function pick(arr, rand) {
  const idx = Math.min(arr.length - 1, Math.floor(rand() * arr.length))
  return arr[idx]
}

/**
 * 目录变化后修正袋状态：剔除已下架游戏、补入新上架游戏（新游仍旧进本轮袋子，
 * 保证「全部刷完一遍前不重复」对增量目录依然成立）。
 */
export function reconcile(state, catalogIds) {
  const catalog = [...new Set(catalogIds)]
  const cycle = state.cycle.filter((id) => catalog.includes(id))
  const seen = new Set(cycle)
  const remaining = []
  for (const id of state.remaining) {
    if (!seen.has(id) && catalog.includes(id)) {
      remaining.push(id)
      seen.add(id)
    }
  }
  for (const id of catalog) {
    if (!seen.has(id)) {
      remaining.push(id)
      seen.add(id)
    }
  }
  return { v: BAG_VERSION, remaining, cycle }
}

/** 新袋子：remaining = 全目录洗牌 */
export function newBag(catalogIds, rand = Math.random) {
  return {
    v: BAG_VERSION,
    remaining: shuffle([...new Set(catalogIds)], rand),
    cycle: [],
  }
}

/**
 * 抽一个游戏：
 *   - remaining 空 → 先用全目录重装（新一轮开始，cycle 清空）
 *   - 每次抽前先 reconcile（目录可能已变化）
 * 返回 { state, id, cycleStart }
 *   id 为 null 表示目录为空（无游戏可抽，调用方跳过）
 */
export function draw(state, catalogIds, rand = Math.random) {
  if (!catalogIds || catalogIds.length === 0) {
    return { state: reconcile(state, []), id: null, cycleStart: false }
  }
  let s = reconcile(state, catalogIds)
  let cycleStart = false
  if (s.remaining.length === 0) {
    s = newBag(catalogIds, rand)
    cycleStart = true
  }
  const id = pick(s.remaining, rand)
  return {
    state: {
      v: BAG_VERSION,
      remaining: s.remaining.filter((x) => x !== id),
      cycle: [...s.cycle, id],
    },
    id,
    cycleStart,
  }
}
