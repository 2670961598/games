import { chromium } from 'playwright'
const WEB = 'http://127.0.0.1:4399'
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)))
await page.addInitScript(() => {
  window.__wsLog = []
  const OW = window.WebSocket
  window.WebSocket = function (u) { const w = new OW(u); window.__wsLog.push({ ev: 'open-ctor', u }); 
    w.addEventListener('open', () => window.__wsLog.push({ ev: 'open' }))
    w.addEventListener('close', (e) => window.__wsLog.push({ ev: 'close', code: e.code, reason: e.reason }))
    w.addEventListener('error', () => window.__wsLog.push({ ev: 'error' }))
    const os = w.send.bind(w); w.send = (d) => { window.__wsLog.push({ ev: 'send', d: String(d).slice(0, 120) }); os(d) }
    w.addEventListener('message', (e) => { const t = String(e.data); window.__wsLog.push({ ev: 'recv', d: t.slice(0, 90) }) })
    return w }
})
await page.goto(`${WEB}/games/multiplayer/tactics-duel/index.html?quick=1`, { waitUntil: 'load', timeout: 20000 })
await page.waitForFunction(() => window.__GAMES_DEBUG__ && window.__GAMES_DEBUG__.events.some((e) => e.event === 'boot'), null, { timeout: 15000 })
await page.waitForFunction(() => { const st = window.__GAMES_DEBUG__.state(); return st && st.view && st.view.phase }, null, { timeout: 10000 })
const entry = await page.evaluate(() => { const st = window.__GAMES_DEBUG__.state(); return { seat: st.seat, phase: st.view.phase } })
console.log('entry:', JSON.stringify(entry), 'wsLog len:', await page.evaluate(() => window.__wsLog.length))
await page.waitForFunction(() => { const v = window.__GAMES_DEBUG__.state().view; const s = window.__GAMES_DEBUG__.seat(); return v && v.phase === 'act' && v.turn === s && v.ap > 0 }, null, { timeout: 90000 })
const sent = await page.evaluate(() => {
  const dbg = window.__GAMES_DEBUG__, v = dbg.state().view, seat = dbg.seat()
  const u = v.units.find((x) => x.seat === seat && x.type === 'lance' && x.ph === 'idle')
  if (!u) return { err: 'no idle lance' }
  const rs = window.TDuelSim.reach(v, u.id).filter((d) => d.path.length > 1)
  const pick = rs[rs.length - 1]
  dbg.sendOp({ k: 'move', unit: u.id, path: pick.path })
  return { unit: u.id, path: pick.path, wsLen: window.__wsLog.length }
})
console.log('sent:', JSON.stringify(sent))
await new Promise((r) => setTimeout(r, 2000))
const post = await page.evaluate(() => {
  const dbg = window.__GAMES_DEBUG__, v = dbg.state().view, seat = dbg.seat()
  const u = v.units.find((x) => x.seat === seat && x.type === 'lance')
  return { turn: v.turn, ap: v.ap, cell: u && u.cell, ph: u && u.ph, wsTail: window.__wsLog.slice(-8) }
})
console.log('post:', JSON.stringify(post, null, 1))
await browser.close()
