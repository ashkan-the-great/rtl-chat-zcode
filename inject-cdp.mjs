import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.ZCODE_CDP_PORT || '9229'
const BASE = `http://127.0.0.1:${PORT}`
const VERIFY = process.argv.includes('--verify')
const SHOT_ARG = process.argv.find(a => a.startsWith('--shot='))
const SHOT_PATH = SHOT_ARG ? SHOT_ARG.slice('--shot='.length) : join(__dirname, 'verify.png')

const source = `window.__RTL_CHAT_VIA = 'cdp';\n` +
  readFileSync(join(__dirname, 'rtl-chat.js'), 'utf8')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function listTargets() {
  const res = await fetch(`${BASE}/json`)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${BASE}/json`)
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const listeners = []
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id
            pending.set(mid, { res, rej })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        on(fn) { listeners.push(fn) },
        close() { try { ws.close() } catch (_) {} }
      })
    })
    ws.addEventListener('message', ev => {
      let msg
      try { msg = JSON.parse(ev.data) } catch (_) { return }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.rej(new Error(msg.error.message || String(msg.error)))
        else p.res(msg.result)
      } else {
        for (const fn of listeners) fn(msg)
      }
    })
    ws.addEventListener('error', () => reject(new Error('WebSocket error')))
    ws.addEventListener('close', () => {
      for (const [, p] of pending) p.rej(new Error('WebSocket closed'))
      pending.clear()
    })
  })
}

async function attach(target) {
  const c = await connect(target.webSocketDebuggerUrl)
  await c.send('Page.enable').catch(() => {})
  await c.send('Runtime.enable').catch(() => {})
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {})
  await c.send('Runtime.evaluate', {
    expression: source,
    awaitPromise: false,
    returnByValue: false
  }).catch(() => {})
  return c
}

async function evalIn(c, expression) {
  const r = await c.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed')
  return r.result && r.result.value
}

async function main() {
  // wait for ZCode CDP port
  let targets = null
  for (let i = 0; i < 60; i++) {
    try {
      targets = await listTargets()
      break
    } catch (_) {
      await sleep(500)
    }
  }
  if (!targets) {
    console.error(`CDP not reachable at ${BASE} — is ZCode running with --remote-debugging-port=${PORT}?`)
    process.exit(1)
  }

  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pages.length) {
    console.error('No page targets found')
    process.exit(1)
  }

  const conns = []
  for (const t of pages) {
    try {
      conns.push({ target: t, c: await attach(t) })
      console.log(`attached: ${t.title || t.url}`)
    } catch (e) {
      console.error(`attach failed for ${t.url}: ${e.message}`)
    }
  }

  if (VERIFY) {
    await sleep(800)
    for (const { target, c } of conns) {
      try {
        const info = await evalIn(c, `JSON.stringify({
          booted: !!window.__RTL_CHAT_BOOTED,
          via: window.__RTL_CHAT_VIAS || [],
          style: !!document.getElementById('rtl-chat-style'),
          badge: !!document.getElementById('rtl-chat-badge'),
          badgeText: (document.getElementById('rtl-chat-badge')||{}).textContent || '',
          rtlAttr: document.documentElement.getAttribute('data-rtl-chat'),
          chat: !!document.querySelector('[data-workspace-conversation-frame]'),
          timeline: !!document.querySelector('[data-v4-timeline-scroll]'),
          composer: !!document.querySelector('[data-lexical-editor="true"]'),
          userMsgs: document.querySelectorAll('[data-trajectory-message-role="user"]').length,
          asstMsgs: document.querySelectorAll('[data-trajectory-message-role="assistant"]').length
        })`)
        console.log(`--- ${target.title || target.url} ---`)
        console.log(info)
        try {
          const shot = await c.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'))
          console.log(`screenshot: ${SHOT_PATH}`)
        } catch (e) {
          console.error(`screenshot failed: ${e.message}`)
        }
      } catch (e) {
        console.error(`eval failed: ${e.message}`)
      }
    }
    for (const { c } of conns) c.close()
    process.exit(0)
  }

  // daemon: re-scan for new targets every 3s
  const known = new Set(conns.map(x => x.target.id))
  setInterval(async () => {
    let ts
    try { ts = await listTargets() } catch (_) { return }
    for (const t of ts) {
      if (t.type !== 'page' || !t.webSocketDebuggerUrl || known.has(t.id)) continue
      known.add(t.id)
      try {
        const c = await attach(t)
        conns.push({ target: t, c })
        console.log(`attached (new): ${t.title || t.url}`)
      } catch (e) {
        console.error(`new attach failed: ${e.message}`)
      }
    }
  }, 3000)

  console.log(`RTL Chat injector running (daemon) on port ${PORT}, ${conns.length} page(s) attached`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
