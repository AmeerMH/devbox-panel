import { api } from '../api.js'
import { el, clear, toast, confirmDialog, fmtBytes, fmtDuration, statusBadge } from '../ui.js'

/** Live pm2 process table with logs and restart/reload/stop controls. */
export const pm2View = {
  id: 'pm2',
  label: 'PM2',

  async mount(ctx) {
    this.ctx = ctx
    this.root = clear(ctx.root)
    this.root.append(el('div', { class: 'section-title' }, el('h1', {}, 'PM2')))
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

  render(payload) {
    if (!payload?.ok) {
      clear(this.body).append(el('div', { class: 'empty' }, payload?.error || 'pm2 is unreachable.'))
      return
    }

    const rows = payload.apps.map((a) => el('tr', {},
      el('td', {}, statusBadge(a.status)),
      el('td', { class: 'mono' }, a.name, el('span', { class: 'muted small' }, ` #${a.id}`)),
      el('td', { class: 'small muted' }, `${a.mode}${a.port ? ` · :${a.port}` : ''}`),
      el('td', { class: 'mono small' }, fmtDuration(a.uptime)),
      el('td', { class: 'mono small' }, String(a.restarts)),
      el('td', { class: 'mono small' }, `${a.cpu}%`),
      el('td', { class: 'mono small' }, fmtBytes(a.memory)),
      el('td', { class: 'mono small muted ellipsis' }, a.cwd || '–'),
      el('td', { class: 'right' }, el('div', { class: 'row actions' },
        el('button', { class: 'small', onclick: () => this.logs(a) }, 'Logs'),
        el('button', { class: 'small', onclick: () => this.action(a, 'reload') }, 'Reload'),
        el('button', { class: 'small', onclick: () => this.action(a, 'restart') }, 'Restart'),
        a.status === 'online'
          ? el('button', { class: 'small danger', onclick: () => this.action(a, 'stop') }, 'Stop')
          : el('button', { class: 'small', onclick: () => this.action(a, 'start') }, 'Start'),
      )),
    ))

    clear(this.body).append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Status'), el('th', {}, 'Name'), el('th', {}, 'Mode'), el('th', {}, 'Uptime'),
        el('th', {}, '↺'), el('th', {}, 'CPU'), el('th', {}, 'Mem'), el('th', {}, 'Directory'), el('th', {}, ''),
      )),
      el('tbody', {}, rows),
    )))
  },

  logs(app) {
    this.ctx.dock.open({
      key: `pm2logs:${app.name}`,
      channel: `pm2logs:${app.name}`,
      title: `pm2 · ${app.name}`,
    })
  },

  async action(app, action) {
    if (action !== 'start') {
      const ok = await confirmDialog({
        title: `pm2 ${action} ${app.name}`,
        body: action === 'reload'
          ? 'Zero-downtime reload in cluster mode; in fork mode it is a plain restart.'
          : `This interrupts ${app.name}${app.port ? ` on port ${app.port}` : ''}.`,
        confirmLabel: `${action} it`,
        danger: action !== 'reload',
      })
      if (!ok) return
    }
    try {
      const { job } = await api.post(`/pm2/${encodeURIComponent(app.name)}/${action}`)
      this.ctx.dock.openJob(job)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },
}
