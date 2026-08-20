import { api } from './api.js'
import { Sock } from './ws.js'
import { Dock } from './dock.js'
import { el, clear, toast } from './ui.js'
import { projectsView } from './views/projects.js'
import { jobsView } from './views/jobs.js'
import { dockerView } from './views/docker.js'
import { databasesView } from './views/databases.js'
import { pm2View } from './views/pm2.js'
import { nginxView } from './views/nginx.js'
import { systemView } from './views/system.js'

const VIEWS = [projectsView, jobsView, databasesView, dockerView, pm2View, nginxView, systemView]

const state = {
  current: null,
  counts: { projects: 0, jobs: 0 },
  health: {},
  version: null,
  updateNoticed: false,
}

async function boot() {
  try {
    await api.init()
  } catch {
    location.href = '/login'
    return
  }

  try {
    await start()
  } catch (err) {
    // A blank page is the worst possible failure mode for a control panel: say
    // what broke and offer the one action that fixes most of it.
    clear(document.getElementById('view')).append(
      el('div', { class: 'card' },
        el('h2', {}, 'The panel failed to start'),
        el('div', { class: 'small muted', style: 'margin:8px 0 14px' }, err?.message || String(err)),
        el('button', { class: 'primary', onclick: () => location.reload() }, 'Reload'),
      ),
    )
  } finally {
    window.__panelBooted = true
  }
}

async function start() {

  const dot = document.getElementById('conn-dot')
  const sock = new Sock({
    onStatus: (up) => {
      dot.classList.toggle('off', !up)
      dot.title = up ? 'websocket connected' : 'websocket reconnecting…'
    },
  })
  const dock = new Dock({ sock })
  const ctx = { root: document.getElementById('view'), sock, dock, state }

  buildNav(ctx)

  // The running-jobs badge is global: you can start a deploy, switch to Docker,
  // and still see that something is in flight.
  sock.subscribe('jobs', () => refreshBadges())
  sock.subscribe('system', (msg) => {
    if (msg.type !== 'snapshot') return
    document.getElementById('host-label').textContent =
      `${msg.payload.host} · load ${msg.payload.load[0].toFixed(2)} · ${msg.payload.panel.user}@panel`

    // The panel deploys itself. When the version underneath this tab changes, the
    // loaded scripts are stale — say so rather than letting it drift.
    const version = msg.payload.panel?.version
    if (!state.version) state.version = version
    else if (version && version !== state.version && !state.updateNoticed) {
      state.updateNoticed = true
      toast(`The panel was updated to v${version} — reload to pick it up.`, 'ok')
    }
  })

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api.post('/logout').catch(() => {})
    location.href = '/login'
  })
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (state.current) route(ctx, true)
  })

  window.addEventListener('hashchange', () => route(ctx))
  await route(ctx)
  await refreshBadges()
  await loadHealth()
  setInterval(refreshBadges, 10000)
  setInterval(loadHealth, 60000)
}

function buildNav(ctx) {
  const nav = clear(document.getElementById('nav'))
  for (const view of VIEWS) {
    nav.append(el('a', { href: `#${view.id}`, id: `nav-${view.id}` },
      el('span', {}, view.label),
      el('span', { class: 'count', id: `count-${view.id}` }, ''),
    ))
  }
  nav.append(el('div', { class: 'small muted', style: 'margin-top:16px; padding:0 12px; line-height:1.7', id: 'nav-health' }))
  ctx.nav = nav
}

async function route(ctx, force = false) {
  const id = (location.hash || '#projects').slice(1)
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0]
  if (state.current === view && !force) return

  state.current?.unmount?.()
  state.current = view
  for (const v of VIEWS) document.getElementById(`nav-${v.id}`)?.classList.toggle('active', v === view)
  try {
    await view.mount(ctx)
  } catch (err) {
    clear(ctx.root).append(el('div', { class: 'empty' }, err.message))
  }
}

async function refreshBadges() {
  try {
    const [{ jobs }, { projects }] = await Promise.all([api.get('/jobs'), api.get('/projects')])
    const running = jobs.filter((j) => j.status === 'running').length
    document.getElementById('jobs-badge').textContent = `${running} running`
    document.getElementById('jobs-badge').className = `badge ${running ? 'run' : ''}`
    document.getElementById('count-jobs').textContent = running ? String(running) : ''
    document.getElementById('count-projects').textContent = String(projects.length)
  } catch { /* a failed poll is not worth a toast */ }
}

/** Surface capability problems (no docker group, missing sudoers) instead of empty tabs. */
async function loadHealth() {
  try {
    const health = await api.get('/health')
    state.health = health
    const box = clear(document.getElementById('nav-health'))
    for (const key of ['docker', 'pm2', 'nginx']) {
      const h = health[key]
      document.getElementById(`count-${key}`).textContent = h?.ok ? '' : '!'
      if (!h?.ok) box.append(el('div', { title: h?.reason || '' }, `${key}: unavailable`))
    }
    for (const root of health.roots || []) {
      box.append(el('div', { class: 'mono', style: 'font-size:11px' }, `${root.path}${root.user ? ` (${root.user})` : ''}`))
    }
  } catch { /* ignore */ }
}

window.addEventListener('error', (e) => toast(`UI error: ${e.message}`, 'bad'))
boot()
