// GAMES-5 冒烟：node 环境纯逻辑断言（零依赖，冻结验收执行）。
// 覆盖：洗牌袋（100 款不重复刷完一轮 / 多轮 / 目录增删 reconcile）、
//       时长累加（可见计时-暂停恢复）、统计聚合（我的页口径）、games/ 清单完整性、
//       /api/games 分页拼全量（GAMES-6 后端契约：默认 pageSize=20，袋子需全量）、
//       游戏大全（GAMES-12：24 类型清单映射 / type×tier 过滤 / 逻辑页拼装 / type 服务端透传）、
//       跨设备历史合并（GAMES-15：mergeStats 并集口径 / fetchStats boot 通道）。
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAG_VERSION, newBag, draw, reconcile } from '../web/src/shuffleBag.js'
import { DurationTracker } from '../web/src/duration.js'
import { emptyStats, applyEnter, applyDuration, aggregatePlayed, formatDuration, mergeStats } from '../web/src/stats.js'
import { collectGames, fetchGamesPage, fetchStats } from '../web/src/api.js'
import { TYPE_CATALOG, TIER_GROUPS, typeName, tierName, filterGames, collectBrowsePage } from '../web/src/browse.js'
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
  const runningAfterDrain = tr2.running
  t2 = 12000
  tr2.stop() // 切走
  recorded += tr2.consume() // 结算
  check('drain 周期落账后 consume 结算不双计（合计 12000）', recorded === 12000, `实际 ${recorded}`)
  check('drain 不中断运行（9000 时 drain 后仍 running）', runningAfterDrain === true)
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
  const { games } = await scanGames(join(ROOT, 'games'))
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

// ---------- 6. /api/games 分页拼全量（GAMES-6 后端契约适配） ----------

section('collectGames：分页 /api/games 拼全量清单（袋子不缺款）')
{
  const mk = (n, off) => Array.from({ length: n }, (_, i) => ({ id: `demo:g${off + i}` }))

  // 最小 server 形状（无 total、单页全量）：一次即收手，不多余请求
  let calls = 0
  const single = await collectGames(async () => {
    calls++
    return { ok: true, games: mk(5, 0) }
  })
  check('无 total 单页全量：拼出全部 5 款', single.length === 5)
  check('无 total 单页全量：仅请求 1 页', calls === 1)

  // 拿满 total 即收手：total=200，两页各满 100，第 2 页后不再请求
  calls = 0
  const full = await collectGames(async (page) => {
    calls++
    return { ok: true, total: 200, games: mk(100, (page - 1) * 100) }
  })
  check('拿满 total 拼全 200 款', full.length === 200)
  check('拿满 total 即收手（恰好 2 页）', calls === 2)
  check('拼全结果无重复 id', new Set(full.map((g) => g.id)).size === full.length)

  // 末页不满页提前收手：total 虚高 250，实给 100+100+45，45<100 即停不等缺额
  calls = 0
  const short = await collectGames(async (page) => {
    calls++
    return { ok: true, total: 250, games: page === 3 ? mk(45, 200) : mk(100, (page - 1) * 100) }
  })
  check('末页不满页：拼得 245 款', short.length === 245)
  check('末页不满页：提前收手（恰好 3 页）', calls === 3)

  // 病态 server（忽略 page 永远回同一页、total 虚高）：不重复灌袋、页数封顶内退出
  const dup = await collectGames(async () => ({ ok: true, total: 250, games: mk(100, 0) }))
  check('病态分页不重复灌袋（恰 100 款唯一）', dup.length === 100 && new Set(dup.map((g) => g.id)).size === 100)
}

// ---------- 7. 游戏大全（GAMES-12）：清单映射 / 过滤纯逻辑 / 分页消费 ----------

section('游戏大全：24 类型清单映射（game-design-spec §6）')
{
  check('TYPE_CATALOG 共 24 类', TYPE_CATALOG.length === 24, `实际 ${TYPE_CATALOG.length}`)
  check('类型 slug 唯一', new Set(TYPE_CATALOG.map((t) => t.slug)).size === 24)
  check('类型名非空且唯一', new Set(TYPE_CATALOG.map((t) => t.name)).size === 24 && TYPE_CATALOG.every((t) => t.name.length > 0))
  check('类型主交互全在 §5.4 词表内', TYPE_CATALOG.every((t) => ['tap', 'tap-zone', 'swipe-lr', 'swipe-any', 'drag'].includes(t.controls)))

  // spec §6 速查表逐项按序对照（slug 漂移 = 照录错误，当场红）
  const SPEC_TYPES = [
    'tap-burst', 'tap-jump', 'lane-runner', 'stacker', 'match3', 'slide-merge', 'snake',
    'breakout', 'paddle-pong', 'bullet-shmup', 'bullet-dodge', 'drop-catcher', 'mole-whack',
    'memory-flip', 'simon-sequence', 'color-reaction', 'fruit-slice', 'water-sort',
    'block-drop', 'block-fit', 'chain-shot', 'maze-dash', 'mini-td', 'rhythm-tap',
  ]
  check('24 类型与 spec §6 清单一致（按序）', TYPE_CATALOG.every((t, i) => t.slug === SPEC_TYPES[i]))

  check('映射：tap-burst → 狂点爆发', typeName('tap-burst') === '狂点爆发')
  check('映射：water-sort → 水排序', typeName('water-sort') === '水排序')
  check('映射：rhythm-tap → 节奏点击', typeName('rhythm-tap') === '节奏点击')
  check('清单外类型原样回退（demo 占位）', typeName('demo') === 'demo')

  check(
    '五档分组与 spec §3.1 一致（难度递增序）',
    TIER_GROUPS.map((t) => `${t.key}:${t.name}`).join(',') === 'relaxed:轻松,simple:简单,normal:标准,hard:困难,master:大师',
  )
  check('档位映射：master → 大师；清单外档位原样回退', tierName('master') === '大师' && tierName('standard') === 'standard')
}

section('游戏大全：filterGames 过滤纯逻辑（type × tier 组合）')
{
  const games = [
    { id: 'stacker:a', type: 'stacker', tier: 'relaxed' },
    { id: 'stacker:b', type: 'stacker', tier: 'master' },
    { id: 'snake:a', type: 'snake', tier: 'normal' },
    { id: 'demo:x', type: 'demo', tier: 'standard' },
  ]
  check('空条件全通过（含缺省参数）', filterGames(games, {}).length === 4 && filterGames(games).length === 4)
  check('type 精确过滤', filterGames(games, { type: 'stacker' }).map((g) => g.id).join() === 'stacker:a,stacker:b')
  check('tier 精确过滤', filterGames(games, { tier: 'master' }).map((g) => g.id).join() === 'stacker:b')
  check('type+tier 组合收窄', filterGames(games, { type: 'stacker', tier: 'master' }).map((g) => g.id).join() === 'stacker:b')
  check('无匹配为空', filterGames(games, { type: 'demo', tier: 'master' }).length === 0)
  check('非数组输入安全', filterGames(null, { type: 'stacker' }).length === 0)
}

section('游戏大全：collectBrowsePage 消费 /api/games 分页（tier 逻辑页拼装）')
{
  const mk = (n, off, tierOf) => Array.from({ length: n }, (_, i) => ({ id: `g${off + i}`, type: 'stacker', tier: tierOf(off + i) }))
  const evenTier = (i) => (i % 3 === 2 ? 'master' : 'normal') // 每 3 款 1 款 master

  // A. 无 tier：服务端序直通切片，不必多拉
  let calls = []
  const a1 = await collectBrowsePage(async (sp) => {
    calls.push(sp)
    return { ok: true, total: 45, pageSize: 20, games: sp === 3 ? mk(5, 40, evenTier) : mk(20, (sp - 1) * 20, evenTier) }
  }, { page: 1, pageSize: 20 })
  check('无 tier 第 1 逻辑页取 20 条', a1.games.length === 20 && a1.games[0].id === 'g0')
  check('无 tier 透传服务端 total', a1.total === 45)
  check('凑满即收手（只拉 1 个服务端页）', calls.join() === '1')
  check('未翻完不判尽', a1.exhausted === false)

  calls = []
  const a3 = await collectBrowsePage(async (sp) => {
    calls.push(sp)
    return { ok: true, total: 45, pageSize: 20, games: sp === 3 ? mk(5, 40, evenTier) : mk(20, (sp - 1) * 20, evenTier) }
  }, { page: 3, pageSize: 20 })
  check('无 tier 末逻辑页取剩余 5 条', a3.games.length === 5 && a3.games[0].id === 'g40')
  check('无 tier 翻到流尽判 exhausted', a3.exhausted === true)
  check('第 3 逻辑页恰好拉 3 个服务端页', calls.join() === '1,2,3')

  // B. tier 过滤：跨服务端页凑满逻辑页，不出现"整页被滤空"
  calls = []
  const b = await collectBrowsePage(async (sp) => {
    calls.push(sp)
    return { ok: true, total: 60, pageSize: 20, games: mk(20, (sp - 1) * 20, evenTier) }
  }, { page: 1, pageSize: 20, tier: 'master' })
  check('tier=master 跨页攒满 20 条（60 款中 20 款 master）', b.games.length === 20 && b.games.every((g) => g.tier === 'master'))
  check('tier 过滤跨满全部 3 个服务端页', calls.join() === '1,2,3')
  check('tier 过滤后流尽判定正确（20 <= 20）', b.exhausted === true)

  // C. 无 total 单页全量形状（GAMES-5 最小 server 兼容）
  const c = await collectBrowsePage(async () => ({ ok: true, games: mk(5, 0, evenTier) }), { page: 1 })
  check('无 total 单页全量：返回 5 条', c.games.length === 5)
  check('无 total 单页全量：total 为 null 且判尽', c.total === null && c.exhausted === true)

  // D. 病态 server（永远回同一页、total 虚高）：零新 id 判流尽，不重复灌入
  calls = []
  const d = await collectBrowsePage(async (sp) => {
    calls.push(sp)
    return { ok: true, total: 500, pageSize: 20, games: mk(20, 0, evenTier) }
  }, { page: 2, pageSize: 20 })
  check('病态重复回页：零新 id 即判流尽（恰 2 次请求）', calls.join() === '1,2')
  check('病态重复回页：第 2 逻辑页为空且判尽', d.games.length === 0 && d.exhausted === true)

  // E. 服务端 type 过滤（整页同 type 被 tier 滤空后，下一页仍有货不被误判流尽）
  const e = await collectBrowsePage(async (sp) => ({
    ok: true,
    total: 40,
    pageSize: 20,
    games: sp === 1 ? mk(20, 0, () => 'normal') : mk(20, 20, () => 'master'),
  }), { page: 1, pageSize: 20, tier: 'master' })
  check('整页滤空不误判流尽（第 2 页攒满 master）', e.games.length === 20 && e.games.every((g) => g.tier === 'master') && e.exhausted === true)
}

section('游戏大全：fetchGamesPage 把 type 过滤交给服务端（/api/games?type=）')
{
  const realFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, json: async () => ({ ok: true, total: 1, pageSize: 100, games: [{ id: 'stacker:a', type: 'stacker', tier: 'normal', name: '静心叠塔' }] }) }
  }
  try {
    const body = await fetchGamesPage(2, { type: 'stacker' })
    check('返回服务端响应体（透传 games/total）', body.ok === true && body.total === 1 && body.games[0].id === 'stacker:a')
  } finally {
    globalThis.fetch = realFetch
  }
  const u = urls[0] || ''
  check('请求打到 /api/games 且带 page=2', u.startsWith('/api/games?') && u.includes('page=2'))
  check('type=stacker 走服务端过滤', u.includes('type=stacker'))
  check('大页拉取 pageSize=100', u.includes('pageSize=100'))
}

// ---------- 8. 跨设备历史合并（GAMES-15）：mergeStats 并集口径 + fetchStats boot 通道 ----------

section('统计合并：健康路径 no-op（本地 ⊇ 服务端，不改口径不双计）')
{
  // 正常单设备：本地含未上报离线游玩（45s），服务端只收到已送达的同一份（45s）
  const local = { v: 1, games: { 'demo:a': { count: 3, totalMs: 45000, lastPlayed: 1700000060000 } }, totalMs: 45000 }
  const remote = {
    ok: true,
    visitorId: 'v-test',
    totalSeconds: 45,
    games: [{ gameId: 'demo:a', seconds: 45, plays: 7, firstAt: 1700000000000, lastAt: 1700000060000 }],
  }
  const merged = mergeStats(local, remote)
  check('同一份历史合并不双计（45s 仍 45s）', merged.games['demo:a'].totalMs === 45000, `实际 ${merged.games['demo:a'].totalMs}`)
  check('count 保留本地进入次数口径（不被上报次数 7 污染）', merged.games['demo:a'].count === 3)
  check('lastPlayed 不变', merged.games['demo:a'].lastPlayed === 1700000060000)
  check('总时长不变', merged.totalMs === 45000)
  check('合并幂等：再合一次结果不变', JSON.stringify(mergeStats(merged, remote)) === JSON.stringify(merged))
}

section('统计合并：新设备恢复（本地空 → 服务端历史完整落地）')
{
  const remote = {
    ok: true,
    visitorId: 'v-test',
    totalSeconds: 42.5,
    games: [
      { gameId: 'demo:a', seconds: 30.5, plays: 2, firstAt: 1000, lastAt: 1000 },
      { gameId: 'demo:b', seconds: 12, plays: 1, firstAt: 1500, lastAt: 2000 },
    ],
  }
  const merged = mergeStats(emptyStats(), remote)
  check('远端游戏全量出现（并集）', Object.keys(merged.games).length === 2)
  check('秒数换算毫秒（30.5s → 30500ms）', merged.games['demo:a'].totalMs === 30500, `实际 ${merged.games['demo:a'].totalMs}`)
  check('仅远端游戏 count 取 plays 近似（2 次）', merged.games['demo:a'].count === 2)
  check('lastPlayed 取服务端 lastAt', merged.games['demo:b'].lastPlayed === 2000)
  check('总时长 = 各游戏之和（42500ms）', merged.totalMs === 42500, `实际 ${merged.totalMs}`)
  const rows = aggregatePlayed(merged, [
    { id: 'demo:a', name: 'A', type: 'demo' },
    { id: 'demo:b', name: 'B', type: 'demo' },
    { id: 'demo:c', name: 'C', type: 'demo' },
  ])
  check('恢复的历史进我的页列表（按最近倒序 b→a）', rows.length === 2 && rows[0].id === 'demo:b' && rows[1].id === 'demo:a')
}

section('统计合并：跨设备并集 + 字段级取最大')
{
  // 设备甲玩了 a（10 分钟，较新）与 c；设备乙玩了 a（5 分钟，较旧）与 b（1 分钟，最新）
  const local = {
    v: 1,
    games: {
      'demo:a': { count: 5, totalMs: 600000, lastPlayed: 900 },
      'demo:c': { count: 1, totalMs: 1000, lastPlayed: 50 },
    },
    totalMs: 601000,
  }
  const remote = {
    ok: true,
    visitorId: 'v-test',
    totalSeconds: 360,
    games: [
      { gameId: 'demo:a', seconds: 300, plays: 9, firstAt: 100, lastAt: 800 },
      { gameId: 'demo:b', seconds: 60, plays: 4, firstAt: 700, lastAt: 950 },
    ],
  }
  const merged = mergeStats(local, remote)
  check('并集：a/b/c 三款都在', ['demo:a', 'demo:b', 'demo:c'].every((id) => merged.games[id]))
  check('a 本地更大：时长取本地（600000）', merged.games['demo:a'].totalMs === 600000)
  check('a count 仍本地进入次数（5，不取 plays 9）', merged.games['demo:a'].count === 5)
  check('a lastPlayed 取较新（900）', merged.games['demo:a'].lastPlayed === 900)
  check('b 仅远端：时长/次数/时间全落地（60000/4/950）', merged.games['demo:b'].totalMs === 60000 && merged.games['demo:b'].count === 4 && merged.games['demo:b'].lastPlayed === 950)
  check('c 仅本地：原样保留', merged.games['demo:c'].totalMs === 1000 && merged.games['demo:c'].count === 1)
  check('总时长 = 合并后各游戏之和（661000）', merged.totalMs === 661000, `实际 ${merged.totalMs}`)
  check('不变量：totalMs 恒等于 Σ 各游戏 totalMs', Object.values(merged.games).reduce((t, g) => t + g.totalMs, 0) === merged.totalMs)
}

section('统计合并：病态远端输入逐条跳过（不拖垮合并）')
{
  const local = emptyStats()
  const t0 = 1700000000000
  const applied = applyDuration(applyEnter(local, 'demo:a', t0), 'demo:a', 2500, t0)
  const bad = {
    ok: true,
    visitorId: 'v-test',
    games: [
      null,
      { gameId: '', seconds: 10, plays: 1, lastAt: 1 }, // 空 id
      { gameId: 42, seconds: 10, plays: 1, lastAt: 1 }, // id 非字符串
      { seconds: 10, plays: 1, lastAt: 1 }, // 缺 id
      { gameId: 'demo:x', seconds: NaN, plays: 1, lastAt: 1 }, // 秒数非数
      { gameId: 'demo:y', seconds: -3, plays: 1, lastAt: 1 }, // 负秒数
      { gameId: 'demo:a', seconds: 2.5, plays: 99, lastAt: t0 }, // 合法：并入已有 a
    ],
  }
  const merged = mergeStats(applied, bad)
  check('非法条目全跳过，仅合法 1 条生效', Object.keys(merged.games).length === 1)
  check('a 时长取 max（等值不叠成 5000）', merged.games['demo:a'].totalMs === 2500, `实际 ${merged.games['demo:a'].totalMs}`)
  check('remote 为 null/缺 games：返回本地原样', JSON.stringify(mergeStats(applied, null)) === JSON.stringify(applied) && JSON.stringify(mergeStats(applied, {})) === JSON.stringify(applied))
}

section('统计合并：fetchStats 通道（GET /api/stats/<visitorId>）')
{
  const realFetch = globalThis.fetch
  let stub = null
  globalThis.fetch = async (url, opts) => {
    stub = { url: String(url), opts }
    return { ok: true, json: async () => ({ ok: true, visitorId: 'v-test', totalSeconds: 1, games: [{ gameId: 'demo:a', seconds: 1, plays: 1, firstAt: 1, lastAt: 1 }] }) }
  }
  try {
    const body = await fetchStats('v-abc123')
    check('返回服务端聚合体（透传 games）', body.ok === true && Array.isArray(body.games) && body.games[0].gameId === 'demo:a')
  } finally {
    globalThis.fetch = realFetch
  }
  check('请求打到 /api/stats/<visitorId>', stub && stub.url === '/api/stats/v-abc123')
  check('禁用缓存（no-store，boot 合并不吃缓存）', stub && stub.opts && stub.opts.cache === 'no-store')

  let encoded = ''
  globalThis.fetch = async (url) => {
    encoded = String(url)
    return { ok: true, json: async () => ({ ok: true, games: [] }) }
  }
  try {
    await fetchStats('v/a b')
  } finally {
    globalThis.fetch = realFetch
  }
  check('visitorId 做 URL 编码（/ 与空格转义）', encoded === '/api/stats/v%2Fa%20b')

  let threw = false
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  try {
    await fetchStats('v-x')
  } catch {
    threw = true
  } finally {
    globalThis.fetch = realFetch
  }
  check('HTTP 非 2xx 抛错（调用方降级为本地口径）', threw === true)

  threw = false
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) })
  try {
    await fetchStats('v-x')
  } catch {
    threw = true
  } finally {
    globalThis.fetch = realFetch
  }
  check('响应形状异常抛错', threw === true)
}

// ---------- 汇总 ----------
console.log(`\n冒烟结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) {
  process.exit(1)
}
process.exit(0)
