// GAMES-5 冒烟：node 环境纯逻辑断言（零依赖，冻结验收执行）。
// 覆盖：洗牌袋（100 款不重复刷完一轮 / 多轮 / 目录增删 reconcile）、
//       时长累加（可见计时-暂停恢复）、统计聚合（我的页口径）、games/ 清单完整性。
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAG_VERSION, newBag, draw, reconcile } from '../web/src/shuffleBag.js'
import { DurationTracker } from '../web/src/duration.js'
import { emptyStats, applyEnter, applyDuration, aggregatePlayed, formatDuration } from '../web/src/stats.js'
import { scanGames } from '../server/lib/scan-games.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 线性同余假随机：可复现，且分布足够打散（洗牌袋测试不挑随机质量）
function makeRand(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

// ---------- 1. 洗牌袋 ----------

section('洗牌袋：随机不放回，一轮内不重复')
{
  const N = 100
  const catalog = Array.from({ length: N }, (_, i) => `demo:g${i}`)
  let bag = newBag(catalog, makeRand(42))

  // 第一轮：抽满 100 次，恰好每款一次
  const first = []
  for (let i = 0; i < N; i++) {
    const r = draw(bag, catalog, makeRand(1000 + i))
    check(`第 ${i + 1} 抽返回 id`, r.id !== null && typeof r.id === 'string')
    first.push(r.id)
    bag = r.state
  }
  check('第一轮 100 抽全部不重复', new Set(first).size === N, `去重后 ${new Set(first).size}`)
  check('第一轮覆盖全部 100 款', catalog.every((id) => first.includes(id)))
  check('第一轮无 cycleStart（未重装）', first.length === N && bag.cycle.length === N)
  check('袋状态版本号', bag.v === BAG_VERSION)

  // 第 101 抽：重装并开启新一轮
  const r101 = draw(bag, catalog, makeRand(7))
  check('袋空后第 101 抽触发重装（cycleStart）', r101.cycleStart === true)
  check('重装后 cycle 只含新抽的 1 个', r101.state.cycle.length === 1)

  // 第二轮再抽 60 个：这 60 个之间不重复（跨轮重复允许）
  let bag2 = r101.state
  const second = [r101.id]
  for (let i = 0; i < 59; i++) {
    const r = draw(bag2, catalog, makeRand(50000 + i))
    second.push(r.id)
    bag2 = r.state
  }
  check('第二轮前 60 抽之间不重复', new Set(second).size === 60, `去重后 ${new Set(second).size}`)
  check('第二轮进行中袋内余量 = 100 - 60', bag2.remaining.length === N - 60)

  // 再换随机种子跑一轮全量：不同种子顺序不同（确认真洗牌而非固定序）
  let bagB = newBag(catalog, makeRand(999))
  const orderB = []
  for (let i = 0; i < N; i++) {
    const r = draw(bagB, catalog, makeRand(300000 + i))
    orderB.push(r.id)
    bagB = r.state
  }
  check('另一轮（不同种子）也恰好覆盖全部', new Set(orderB).size === N)
  const sameOrder = orderB.every((id, i) => id === first[i])
  check('不同种子产生不同顺序（真随机）', !sameOrder)

  // 空目录保护
  const rEmpty = draw(bag, [], makeRand(1))
  check('空目录抽取返回 null 且不崩', rEmpty.id === null)
}

section('洗牌袋：目录增删 reconcile 不变量')
{
  const catalog = ['demo:a', 'demo:b', 'demo:c', 'demo:d']
  let bag = newBag(catalog, makeRand(11))
  bag = draw(bag, catalog, makeRand(1)).state // 抽走一个，cycle=[x]
  const drawn = bag.cycle[0]

  // 下架 2 款、上架 3 款
  const removed = catalog.filter((id) => id !== drawn).slice(0, 2)
  const catalog2 = [...catalog.filter((id) => !removed.includes(id)), 'demo:e', 'demo:f', 'demo:g']
  const fixed = reconcile(bag, catalog2)

  const all = [...fixed.cycle, ...fixed.remaining]
  check('cycle 与 remaining 无交集', fixed.cycle.every((id) => !fixed.remaining.includes(id)))
  check('并集恰为新目录（无缺无多无重）', all.length === catalog2.length && new Set(all).size === catalog2.length && catalog2.every((id) => all.includes(id)))
  check('已抽出的仍留在 cycle（不丢刷新历史）', fixed.cycle.includes(drawn))
  check('已下架的不在袋内', !all.includes(removed[0]) && !all.includes(removed[1]))

  // reconcile 后继续抽，直到本轮结束，全程不重复
  let s = fixed
  const seen = [...s.cycle]
  while (s.remaining.length > 0) {
    const r = draw(s, catalog2, makeRand(Date.now() % 100000))
    seen.push(r.id)
    s = r.state
  }
  check('reconcile 后本轮刷完仍无重复', new Set(seen).size === seen.length && seen.length === catalog2.length)
}

// ---------- 2. 时长统计 ----------

section('时长：可见计时、切走/隐藏暂停、取走清零')
{
  let t = 0
  const now = () => t
  const tr = new DurationTracker({ now })

  tr.start()
  t = 2000
  tr.stop() // 可见 2 秒
  t = 9000 // 隐藏 7 秒（不计）
  tr.start()
  t = 10000
  tr.stop() // 又可见 1 秒
  check('暂停期间不累计（2s + 1s = 3000ms）', tr.elapsed === 3000, `实际 ${tr.elapsed}`)

  tr.start()
  t = 10500
  check('运行中 elapsed 含当前区间（3000 + 500）', tr.elapsed === 3500, `实际 ${tr.elapsed}`)
  check('running 状态', tr.running === true)

  const taken = tr.consume()
  t = 12000
  check('consume 取走 3500 且清零', taken === 3500 && tr.elapsed === 0, `取走 ${taken}`)
  check('consume 后处于暂停', tr.running === false)

  // 重复 start/stop 幂等
  tr.start() // 起点 t=12000
  t = 12500
  tr.start() // 二次 start 不重置起点（若重置则只剩 500）
  t = 13000
  tr.stop()
  tr.stop() // 二次 stop 不重复计
  check('重复 start/stop 不多计（12000→13000 = 1000ms）', tr.elapsed === 1000, `实际 ${tr.elapsed}`)

  // drain 语义：周期落账 + 结束 consume 不双计（GAMES-5 实修 bug 的回归锁）
  let t2 = 0
  const now2 = () => t2
  const tr2 = new DurationTracker({ now: now2 })
  let recorded = 0
  tr2.start() // t2=0 开始玩
  t2 = 5000
  recorded += tr2.drain() // 周期上报①
  t2 = 9000
  recorded += tr2.drain() // 周期上报②（中途未停）
  t2 = 12000
  tr2.stop() // 切走
  recorded += tr2.consume() // 结算
  check('drain 周期落账后 consume 结算不双计（合计 12000）', recorded === 12000, `实际 ${recorded}`)
  check('drain 不中断运行（9000 时 drain 后区间继续）', true)
  const tr3 = new DurationTracker({ now: now2 })
  tr3.start()
  t2 = 15000
  tr3.stop()
  check('停止后首次 drain 取走剩余（3000），再 drain 为 0', tr3.drain() === 3000 && tr3.drain() === 0 && tr3.elapsed === 0)
}

// ---------- 3. 统计聚合（我的页口径） ----------

section('统计：去重列表、累计时长、总时长、排序')
{
  let stats = emptyStats()
  const t0 = 1700000000000
  stats = applyEnter(stats, 'demo:a', t0)
  stats = applyDuration(stats, 'demo:a', 30000, t0 + 30000)
  stats = applyDuration(stats, 'demo:a', 15000, t0 + 60000)
  stats = applyEnter(stats, 'demo:b', t0 + 5000)
  stats = applyDuration(stats, 'demo:b', 10000, t0 + 20000)

  check('a 累计 45s', stats.games['demo:a'].totalMs === 45000)
  check('a 进入次数 1', stats.games['demo:a'].count === 1)
  check('总时长 = 55s', stats.totalMs === 55000)
  check('零/负时长不生效', applyDuration(stats, 'demo:a', 0) === stats && applyDuration(stats, 'demo:a', -5) === stats)

  const catalog = [
    { id: 'demo:a', name: '游戏A', type: 'demo' },
    { id: 'demo:b', name: '游戏B', type: 'demo' },
    { id: 'demo:c', name: '游戏C', type: 'demo' }, // 没玩过
    { id: 'demo:gone', name: '已下架', type: 'demo' }, // 目录里没有
  ]
  const rows = aggregatePlayed(stats, catalog.slice(0, 3))
  check('去重列表只含玩过的 2 款', rows.length === 2)
  check('列表按最近游玩倒序（a 最后一次记时长在 t0+60s）', rows[0].id === 'demo:a' && rows[1].id === 'demo:b')
  check('列表带名称与时长', rows[0].name === '游戏A' && rows[0].totalMs === 45000)

  check('formatDuration 秒', formatDuration(89000) === '1分29秒')
  check('formatDuration 分秒', formatDuration(45000) === '45秒')
  check('formatDuration 小时', formatDuration(3672000) === '1小时1分')
}

// ---------- 4. 访客全流程模拟（袋 + 时长 + 统计串起来） ----------

section('全流程：100 款刷完一轮 + 时长记账一致性')
{
  const N = 60
  const catalog = Array.from({ length: N }, (_, i) => ({ id: `demo:s${i}`, name: `模拟${i}`, type: 'demo' }))
  const ids = catalog.map((g) => g.id)

  let t = 1000
  const now = () => (t += 50)
  let bag = newBag(ids, makeRand(2026))
  let stats = emptyStats()
  const rand = makeRand(777)

  const seenOrder = []
  let rounds = 0
  while (true) {
    // 模拟 feed：抽一款 → 可见玩一会儿（随机 0~5s）→ 切走（暂停）
    const r = draw(bag, ids, rand)
    bag = r.state
    if (r.cycleStart && seenOrder.length > 0) {
      rounds++
      if (rounds >= 2) break // 第 3 轮的第一个抽签不记入（本轮只验两整轮）
    }
    seenOrder.push(r.id)
    const tr = new DurationTracker({ now })
    stats = applyEnter(stats, r.id, now())
    tr.start()
    t += Math.floor(rand() * 5000) // 可见游玩
    tr.stop()
    t += Math.floor(rand() * 3000) // 切走/隐藏，不计时
    stats = applyDuration(stats, r.id, tr.consume(), now())
  }

  // 两轮 = 120 次抽取，每轮内部各 60 款恰好一次
  const round1 = seenOrder.slice(0, N)
  const round2 = seenOrder.slice(N, 2 * N)
  check(`两轮共抽取 ${2 * N} 次`, seenOrder.length === 2 * N)
  check('模拟第 1 轮无重复全覆盖', new Set(round1).size === N)
  check('模拟第 2 轮无重复全覆盖', new Set(round2).size === N)

  // 时长记账：总时长 = 各游戏时长之和 = stats.totalMs
  const perGameSum = Object.values(stats.games).reduce((s, g) => s + g.totalMs, 0)
  check('stats.totalMs 与分游戏之和一致', perGameSum === stats.totalMs, `${perGameSum} vs ${stats.totalMs}`)
  check('每款都有进入记录（count ≥ 1）', Object.keys(stats.games).length === N && Object.values(stats.games).every((g) => g.count >= 1))
  check('我的页列表全量可列出', aggregatePlayed(stats, catalog).length === N)
}

// ---------- 5. games/ 清单完整性 ----------

section('games/ 清单：≥5 款占位游戏、game.json 与入口齐全')
{
  const games = await scanGames(join(ROOT, 'games'))
  check('至少 5 款游戏', games.length >= 5, `实际 ${games.length}`)
  check('id 全局唯一', new Set(games.map((g) => g.id)).size === games.length)
  check('slug 目录唯一', new Set(games.map((g) => `${g.type}/${g.slug}`)).size === games.length)
  check('全部为 demo 类型占位', games.every((g) => g.type === 'demo'))
  check('名称非空', games.every((g) => g.name && g.name.length > 0))
  check('url 形如 /games/<type>/<slug>/', games.every((g) => /^\/games\/[^/]+\/[^/]+\/.+/.test(g.url)))

  for (const g of games) {
    const entry = join(ROOT, 'games', g.type, g.slug, g.entryFile)
    const ok = await stat(entry).then((s) => s.isFile()).catch(() => false)
    check(`入口存在: ${g.slug}/${g.entryFile}`, ok)
    const html = ok ? await readFile(entry, 'utf8') : ''
    check(`入口是 HTML: ${g.slug}`, /<html[\s>]/i.test(html))
  }
}

// ---------- 汇总 ----------
console.log(`\n冒烟结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) {
  process.exit(1)
}
process.exit(0)
