import { api } from '../api.js'
import { el, clear, toast, confirmDialog, fmtBytes, fmtDuration, statusBadge } from '../ui.js'

const GROUP_KEY = 'devbox-panel.pm2.group'

/**
 * Live pm2 process table with logs and restart/reload/stop controls.
 *
 * Cluster apps are collapsed into one row by default: two `shop-builder` rows that
 * always get restarted together are noise, and the numbers you actually want are
 * the totals. Expanding shows each worker, and the log button on the group opens
 * the merged stream with per-instance filter chips.
 */
export const pm2View = {
  id: 'pm2',
  label: 'PM2',

  async mount(ctx) {
    this.ctx = ctx
    this.grouped = localStorage.getItem(GROUP_KEY) !== '0'
    this.expanded = new Set()
    this.root = clear(ctx.root)

    this.groupToggle = el('button', {
      class: `small ${this.grouped ? 'primary' : ''}`,
      onclick: () => {
        this.grouped = !this.grouped
        localStorage.setItem(GROUP_KEY, this.grouped ? '1' : '0')
        this.groupToggle.className = `small ${this.grouped ? 'primary' : ''}`
        this.groupToggle.textContent = this.grouped ? 'Cluster: grouped' : 'Cluster: one row each'
        if (this.last) this.render(this.last)
      },
    }, this.grouped ? 'Cluster: grouped' : 'Cluster: one row each')

    this.root.append(el('div', { class: 'section-title' }, el('h1', {}, 'PM2'), this.groupToggle))
    this.body = el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Waiting for the first snapshot…'))
    this.root.append(this.body)

    this.unsub = ctx.sock.subscribe('pm2', (msg) => {
      if (msg.type === 'snapshot') this.render(msg.payload)
      else if (msg.type === 'error') clear(this.body).append(el('div', { class: 'empty' }, msg.error))
    })
  },

  unmount() {
    this.unsub?.()
  },

  /** One entry per app name, carrying its instances and their totals. */
  groups(apps) {
    const byName = new Map()
    for (const app of apps) {
      const list = byName.get(app.name) || []
      list.push(app)
      byName.set(app.name, list)
    }
    return [...byName.entries()].map(([name, instances]) => ({
      name,
      instances,
      count: instances.length,
      status: instances.some((a) => a.status !== 'online') ? (instances.find((a) => a.status !== 'online')?.status ?? 'online') : 'online',
      mode: instances[0].mode,
      port: instances.find((a) => a.port)?.port ?? null,
      cwd: instances[0].cwd,
      cpu: instances.reduce((sum, a) => sum + (a.cpu || 0), 0),
      memory: instances.reduce((sum, a) => sum + (a.memory || 0), 0),
      restarts: instances.reduce((sum, a) => sum + (a.restarts || 0), 0),
      uptime: Math.min(...instances.map((a) => a.uptime ?? Infinity)),
    }))
  },

  render(payload) {
    this.last = payload
    if (!payload?.ok) {
      clear(this.body).append(el('div', { class: 'empty' }, payload?.error || 'pm2 is unreachable.'))
      return
    }

    const rows = []
    if (this.grouped) {
      for (const group of this.groups(payload.apps)) {
        rows.push(this.groupRow(group))
        if (group.count > 1 && this.expanded.has(group.name)) {
          for (const app of group.instances) rows.push(this.instanceRow(app))
        }
      }
    } else {
      for (const app of payload.apps) rows.push(this.instanceRow(app, true))
    }

    clear(this.body).append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Status'), el('th', {}, 'Name'), el('th', {}, 'Mode'), el('th', {}, 'Uptime'),
        el('th', {}, '↺'), el('th', {}, 'CPU'), el('th', {}, 'Mem'), el('th', {}, 'Directory'), el('th', {}, ''),
      )),
      el('tbody', {}, rows),
    )))
  },

  groupRow(group) {
    const clustered = group.count > 1
    const open = this.expanded.has(group.name)
    return el('tr', { class: clustered ? 'grouprow' : '' },
      el('td', {}, statusBadge(group.status)),
      el('td', { class: 'mono' },
        clustered
          ? el('button', {
              class: 'small caret',
              onclick: () => {
                if (open) this.expanded.delete(group.name)
                else this.expanded.add(group.name)
                this.render(this.last)
              },
            }, open ? '▾' : '▸')
          : null,
        group.name,
        clustered ? el('span', { class: 'badge', style: 'margin-left:8px' }, `×${group.count}`) : null,
      ),
      el('td', { class: 'small muted' }, `${group.mode}${group.port ? ` · :${group.port}` : ''}`),
      el('td', { class: 'mono small' }, fmtDuration(group.uptime)),
      el('td', { class: 'mono small' }, String(group.restarts)),
      el('td', { class: 'mono small' }, `${Math.round(group.cpu * 10) / 10}%`),
      el('td', { class: 'mono small' }, fmtBytes(group.memory)),
      el('td', { class: 'mono small muted ellipsis' }, group.cwd || '–'),
      el('td', { class: 'right' }, el('div', { class: 'row actions' },
        el('button', { class: 'small', onclick: () => this.logs(group.name, clustered ? `pm2 · ${group.name} (×${group.count})` : `pm2 · ${group.name}`) }, 'Logs'),
        el('button', { class: 'small', onclick: () => this.action({ name: group.name }, 'reload') }, 'Reload'),
        el('button', { class: 'small', onclick: () => this.action({ name: group.name }, 'restart') }, 'Restart'),
        group.status === 'online'
          ? el('button', { class: 'small danger', onclick: () => this.action({ name: group.name, port: group.port }, 'stop') }, 'Stop')
          : el('button', { class: 'small', onclick: () => this.action({ name: group.name }, 'start') }, 'Start'),
      )),
    )
  },

  instanceRow(app, standalone = false) {
    return el('tr', { class: standalone ? '' : 'instancerow' },
      el('td', {}, statusBadge(app.status)),
      el('td', { class: 'mono' }, standalone ? app.name : el('span', { class: 'muted' }, `└ instance`), el('span', { class: 'muted small' }, ` #${app.id}`)),
      el('td', { class: 'small muted' }, `${app.mode}${app.port ? ` · :${app.port}` : ''}`),
      el('td', { class: 'mono small' }, fmtDuration(app.uptime)),
      el('td', { class: 'mono small' }, String(app.restarts)),
      el('td', { class: 'mono small' }, `${app.cpu}%`),
      el('td', { class: 'mono small' }, fmtBytes(app.memory)),
      el('td', { class: 'mono small muted ellipsis' }, app.cwd || '–'),
      el('td', { class: 'right' }, el('div', { class: 'row actions' },
        el('button', { class: 'small', onclick: () => this.logs(String(app.id), `pm2 · ${app.name} #${app.id}`) }, 'Logs'),
        el('button', { class: 'small', onclick: () => this.action(app, 'reload') }, 'Reload'),
        el('button', { class: 'small', onclick: () => this.action(app, 'restart') }, 'Restart'),
        app.status === 'online'
          ? el('button', { class: 'small danger', onclick: () => this.action(app, 'stop') }, 'Stop')
          : el('button', { class: 'small', onclick: () => this.action(app, 'start') }, 'Start'),
      )),
    )
  },

  logs(target, title) {
    this.ctx.dock.open({ key: `pm2logs:${target}`, channel: `pm2logs:${target}`, title })
  },

  async action(app, action) {
    if (action !== 'start') {
      const ok = await confirmDialog({
        title: `pm2 ${action} ${app.name}`,
        body: action === 'reload'
          ? 'Zero-downtime reload in cluster mode; in fork mode it is a plain restart. Applies to every instance of this app.'
          : `This interrupts ${app.name}${app.port ? ` on port ${app.port}` : ''}${app.id === undefined ? ' — every instance of it' : ` (instance #${app.id})`}.`,
        confirmLabel: `${action} it`,
        danger: action !== 'reload',
      })
      if (!ok) return
    }
    try {
      const target = app.id === undefined ? app.name : String(app.id)
      const { job } = await api.post(`/pm2/${encodeURIComponent(target)}/${action}`)
      this.ctx.dock.openJob(job)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },
}
