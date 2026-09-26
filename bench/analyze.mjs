#!/usr/bin/env node
/* GAMES-24 基准分析：读 bench/results.json，产出报告用的 markdown 表（数字不手抄）。
 * 聚合口径：fps 同 (tag,name,dpr,load) 多次重复取中位；start 已在 harness 聚中位；
 * mem 单次。打印到 stdout，供 docs/engine-choice.md 引用核对。 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const R = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results.json'), 'utf8'))
/* 压力档复测（3× 重复）并入：同 tag 的 load16 行以复测为准 */
const S16 = join(dirname(fileURLToPath(import.meta.url)), 'results', 'stress16.json')
if (existsSync(S16)) {
  const V = JSON.parse(readFileSync(S16, 'utf8'))
  R.fps = R.fps.filter(r => !(r.tag === 'swiftshader' && r.load === 16))
  R.fps.push(...V.fps)
  if (V.errors?.length) R.errors = [...(R.errors || []), ...V.errors.map(e => ({ suite: 'stress16', ...e }))]
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
const k = (x) => (x === undefined || x === null) ? '—' : (typeof x === 'number' ? Math.round(x * 10) / 10 : x)
const EN = { native: '原生', phaser3: 'Phaser3', phaser4: 'Phaser4', pixi8: 'Pixi8' }
const nameEng = (n) => EN[n.split('-')[0]]
const nameGame = (n) => n.split('-')[1] === 'tap' ? 'tap-burst' : 'lane-runner'

function fpsAgg(tag, dpr) {
  const m = new Map()
  for (const r of R.fps) {
    if (r.tag !== tag || r.dpr !== dpr) continue
    const key = `${r.name}|${r.load}`
    if (!m.has(key)) m.set(key, [])
    m.get(key).push(r)
  }
  return m
}

console.log('## 环境')
console.log(`${R.meta.chromium} ｜ ${R.meta.model} (${R.meta.cpus} 核) ｜ 视口 375×667`)
console.log(`SwiftShader GL: ${R.meta.gl?.renderer}`)
if (R.meta.glGpu) console.log(`真 GPU GL: ${R.meta.glGpu?.renderer}`)

console.log('\n## 冷启动（中位 ms，冷=空缓存全新context / 暖=vendor缓存二次加载）')
console.log('| 引擎 | 页面 | DPR | 冷 tReady | 冷 DCL | 暖 tReady |')
console.log('|---|---|---|---|---|---|')
for (const r of R.start.filter(x => x.tag === 'swiftshader')) {
  console.log(`| ${nameEng(r.name)} | ${nameGame(r.name)} | ${r.dpr} | ${k(r.tReadyCold)} | ${k(r.dclCold)} | ${k(r.tReadyWarm)} |`)
}

for (const [tag, dpr] of [['swiftshader', 1], ['swiftshader', 2]]) {
  const m = fpsAgg(tag, dpr)
  const loads = [...new Set([...m.keys()].map(x => +x.split('|')[1]))].sort((a, b) => a - b)
  console.log(`\n## 帧率 @${tag} DPR${dpr}（中位；peak=实体峰值，工作负载等价性核对）`)
  console.log('| 引擎 | 玩法 | load | avg fps | p95 ms | long17 | min1s fps | peak实体 | 重启 |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const [key, arr] of m) {
    const [name, load] = key.split('|')
    console.log(`| ${nameEng(name)} | ${nameGame(name)} | ${load} | ${k(med(arr.map(x => x.avg)))} | ${k(med(arr.map(x => x.p95)))} | ${k(med(arr.map(x => x.long17)))} | ${k(med(arr.map(x => x.min1s)))} | ${k(med(arr.map(x => x.peak)))} | ${k(med(arr.map(x => x.restarts)))} |`)
  }
}
if (R.meta.glGpu) {
  const m = fpsAgg('gpu', 1)
  console.log('\n## 帧率 @真GPU(ANGLE Metal) DPR1（复核档）')
  console.log('| 引擎 | 玩法 | load | avg fps | p95 ms | long17 | peak实体 |')
  console.log('|---|---|---|---|---|---|---|')
  for (const [key, arr] of m) {
    const [name, load] = key.split('|')
    console.log(`| ${nameEng(name)} | ${nameGame(name)} | ${load} | ${k(med(arr.map(x => x.avg)))} | ${k(med(arr.map(x => x.p95)))} | ${k(med(arr.map(x => x.long17)))} | ${k(med(arr.map(x => x.peak)))} |`)
  }
  const m2 = fpsAgg('gpu', 2)
  if (m2.size) {
    console.log('\n## 帧率 @真GPU DPR2（复核档）')
    console.log('| 引擎 | 玩法 | load | avg fps | p95 ms | long17 | peak实体 |')
    console.log('|---|---|---|---|---|---|---|')
    for (const [key, arr] of m2) {
      const [name, load] = key.split('|')
      console.log(`| ${nameEng(name)} | ${nameGame(name)} | ${load} | ${k(med(arr.map(x => x.avg)))} | ${k(med(arr.map(x => x.p95)))} | ${k(med(arr.map(x => x.long17)))} | ${k(med(arr.map(x => x.peak)))} |`)
    }
  }
}

console.log('\n## 内存（60s 机器人自动玩，load=1，DPR1）')
console.log('| 引擎 | 页面 | 首样 MB | 末样 MB | 峰值 MB | 增长 MB | 重启 | 事件 |')
console.log('|---|---|---|---|---|---|---|---|')
for (const r of R.mem) {
  console.log(`| ${nameEng(r.name)} | ${nameGame(r.name)} | ${k(r.firstMB)} | ${k(r.lastMB)} | ${k(r.maxMB)} | ${k(r.growthMB)} | ${r.restarts} | ${r.simEvents} |`)
}

console.log('\n## 包体')
console.log('| 引擎 | vendor | vendor gzip | 自有代码 gzip（含共享规则层） | 接线层 LOC |')
console.log('|---|---|---|---|---|')
const seen = new Set()
for (const p of R.size.pages) {
  const key = `${p.engine}|${p.game}`
  if (seen.has(key)) continue
  seen.add(key)
  const v = p.vendor !== '—' ? R.size.vendor[p.vendor] : null
  console.log(`| ${EN[p.engine]} | ${p.vendor} | ${v ? k(v.gzipKB) + ' KB' : '0'} | ${k(p.ownGzip / 1024)} KB | ${p.glueLines} |`)
}
if (R.errors.length) {
  console.log(`\n## 异常（${R.errors.length}）`)
  console.log('```json')
  console.log(JSON.stringify(R.errors.slice(0, 8), null, 1))
  console.log('```')
}
