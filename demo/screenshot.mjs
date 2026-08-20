/**
 * Regenerates docs/screenshots/*.png from the demo panel.
 *
 *     make demo        # in one terminal
 *     make screenshots # in another
 *
 * Drives headless Chrome over the DevTools protocol with the `ws` dependency the
 * panel already ships — no Puppeteer/Playwright download. Everything it captures
 * is invented data from demo/bin and demo/projects.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs/screenshots')
const PANEL = process.env.PANEL_URL || 'http://127.0.0.1:7071'
const PORT = 9333
const WIDTH = 1600
const HEIGHT = 1000

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPanel() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${PANEL}/healthz`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error(`No panel on ${PANEL} — start it with \`make demo\` first`)
}

function launchBrowser() {
  const bin = BROWSERS.find((b) => fs.existsSync(b))
  if (!bin) throw new Error('No Chrome/Chromium/Edge found — install one or set BROWSERS in demo/screenshot.mjs')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-panel-shots-'))
  const child = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    '--force-color-profile=srgb',
    'about:blank',
  ], { stdio: 'ignore', detached: true })
  return { child, profile }
}

async function debuggerUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* browser still starting */ }
    await sleep(250)
  }
  throw new Error('Chrome did not expose a debugging target')
}

/** Minimal CDP client: send(method, params) and waitFor(event). */
function cdp(ws) {
  let nextId = 1
  const pending = new Map()
  const waiters = new Map()

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method && waiters.has(msg.method)) {
      const list = waiters.get(msg.method)
      waiters.delete(msg.method)
      for (const resolve of list) resolve(msg.params)
    }
  })

  return {
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    waitFor(event, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const list = waiters.get(event) || []
        list.push(resolve)
        waiters.set(event, list)
        setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs).unref()
      })
    },
  }
}

async function main() {
  await waitForPanel()
  fs.mkdirSync(OUT, { recursive: true })

  const { child, profile } = launchBrowser()
  const ws = new WebSocket(await debuggerUrl(), { perMessageDeflate: false })
  await new Promise((r) => ws.on('open', r))
  const client = cdp(ws)

  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  })

  const goto = async (url, settleMs = 1500) => {
    const loaded = client.waitFor('Page.loadEventFired')
    await client.send('Page.navigate', { url })
    await loaded
    await sleep(settleMs)
  }

  // Switching tabs is a hash change, which fires no load event — drive it in-page.
  const show = async (tab, settleMs = 2500) => {
    await evaluate(`location.hash = '#${tab}'`)
    await sleep(settleMs)
  }

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed')
    return result.value
  }

  const shot = async (name) => {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  ✓ ${path.relative(ROOT, file)}`)
  }

  const clickTarget = (project, target) => evaluate(`(() => {
    const chip = [...document.querySelectorAll('.chip[data-key]')]
      .find((c) => c.dataset.key.includes('${project}') && c.dataset.key.endsWith('::${target}'))
    if (!chip) throw new Error('chip not found: ${project}/${target}')
    chip.click()
    return true
  })()`)

  const confirmModal = () => evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => /Run make/.test(b.textContent))
    if (!btn) throw new Error('no confirmation dialog')
    btn.click()
    return true
  })()`)

  console.log('capturing:')

  await goto(`${PANEL}/login`)
  await shot('login')

  await goto(`${PANEL}/#projects`, 2500)
  await shot('projects')

  // A dangerous target must be confirmed — that dialog is worth showing.
  await clickTarget('storefront', 'deploy')
  await sleep(600)
  await shot('confirm-dangerous-target')

  // Confirm it, start a second build alongside it, and catch both streaming.
  await confirmModal()
  await sleep(1200)
  await clickTarget('api-gateway', 'build')
  await sleep(3000)
  await shot('running-jobs')

  await show('jobs', 2000)
  await shot('runs-history')

  await show('databases', 3500)
  await shot('databases')

  // The engine settings panel, expanded on the Postgres container.
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card[data-db]')].find((c) => c.dataset.db === 'container:demo-postgres')
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Engine settings')
    btn.click()
    card.scrollIntoView({ block: 'start' })
    return true
  })()`)
  await sleep(1500)
  await shot('database-engine-settings')

  // The limits dialog, on a container that compose owns.
  await evaluate(`(() => {
    window.scrollTo(0, 0)
    const card = [...document.querySelectorAll('.card[data-db]')].find((c) => c.dataset.db === 'container:demo-redis')
    ;[...card.querySelectorAll('button')].find((b) => b.textContent === 'Memory / CPU limits').click()
    return true
  })()`)
  await sleep(800)
  await shot('database-limits')
  await evaluate(`(() => { document.querySelector('.modal-backdrop')?.remove(); return true })()`)

  await show('docker', 3500)
  await shot('docker')

  await show('pm2', 3500)
  await shot('pm2')

  // Open the merged cluster log, let it fill, then filter it down to the errors.
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('storefront'))
    ;[...row.querySelectorAll('button')].find((b) => b.textContent === 'Logs').click()
    return true
  })()`)
  await sleep(26000) // the demo app emits its periodic error every ~12s
  await shot('logs-structured')

  await evaluate(`(() => {
    const chip = [...document.querySelectorAll('.logchip')].find((c) => c.textContent.startsWith('error'))
    if (chip) chip.click()
    const first = document.querySelector('.logrow.expandable')
    if (first) first.click()
    return true
  })()`)
  await sleep(1200)
  await shot('logs-filtered')

  // Expanded cluster: the two workers behind the grouped row.
  await evaluate(`(() => {
    document.querySelectorAll('#dock .tab .x').forEach((x) => x.click())
    const caret = document.querySelector('button.caret')
    if (caret) caret.click()
    return true
  })()`)
  await sleep(1200)
  await shot('pm2-cluster-expanded')

  await show('nginx', 2500)
  await shot('nginx')

  await show('system', 3000)
  await shot('system')

  ws.close()
  try { process.kill(-child.pid) } catch { try { child.kill() } catch { /* gone */ } }
  await sleep(800) // Chrome flushes its profile on the way out
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* left behind in /tmp */ }
  console.log(`\ndone — ${fs.readdirSync(OUT).length} files in docs/screenshots`)
}

main().catch((err) => {
  console.error(`screenshot failed: ${err.message}`)
  process.exit(1)
})
