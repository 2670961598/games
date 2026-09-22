// 确定性洗牌袋：seed → 全列表稳定排列。
// 同一 seed 永远同序（分页翻页不乱序、刷新不跳游戏），走完一整圈才会"重复"（排列即洗牌袋）。
// FNV-1a 哈希 seed → mulberry32 PRNG → Fisher-Yates。纯函数、无副作用、跨进程稳定。

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 返回新数组；seed 为空返回原序拷贝 */
export function seededShuffle(list, seed) {
  const arr = [...list]
  if (!seed) return arr
  const rand = mulberry32(fnv1a(String(seed)))
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}
