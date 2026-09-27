const PORT = process.env.ZCODE_CDP_PORT || '9229'
const BASE = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function listTargets() {
  const res = await fetch(`${BASE}/json`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id
            pending.set(mid, { res, rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        close() { try { ws.close() } catch {} }
      })
    })
    ws.addEventListener('message', ev => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.rej(new Error(msg.error.message || String(msg.error)))
        else p.res(msg.result)
      }
    })
    ws.addEventListener('error', () => reject(new Error('WebSocket error')))
  })
}

async function main() {
  let targets = null
  for (let i = 0; i < 40; i++) {
    try { targets = await listTargets(); break } catch { await sleep(500) }
  }
  if (!targets) { console.error('CDP not reachable'); process.exit(1) }
  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
  console.log('pages', pages.length, pages.map(p => p.url))
  if (!pages.length) { console.error('No pages'); process.exit(1) }

  for (const t of pages) {
    const c = await connect(t.webSocketDebuggerUrl)
    await c.send('Runtime.enable').catch(() => {})
    const r = await c.send('Runtime.evaluate', {
      expression: 'document.title + " | ready=" + document.readyState + " | badge=" + !!document.getElementById("rtl-chat-badge") + " | style=" + !!document.getElementById("rtl-chat-style") + " | vias=" + JSON.stringify(window.__RTL_CHAT_VIAS || []) + " | booted=" + !!window.__RTL_CHAT_BOOTED + " | rtlAttr=" + document.documentElement.getAttribute("data-rtl-chat") + " | bodyLen=" + (document.body ? document.body.innerHTML.length : -1)',
      returnByValue: true,
      awaitPromise: false,
      userGesture: true
    })
    console.log('---', t.title || t.url)
    console.log(JSON.stringify(r, null, 2))
    c.close()
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
