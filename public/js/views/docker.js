import { api } from '../api.js'
import { el, clear, toast, confirmDialog, statusBadge } from '../ui.js'

/** Live container table (pushed every 5s from the server) with logs and lifecycle actions. */
export const dockerView = {
  id: 'docker',
  label: 'Docker',

  async mount(ctx) {
    this.ctx = ctx
    this.root = clear(ctx.root)
    this.root.append(el('div', { class: 'section-title' },
      el('h1', {}, 'Docker'),
      el('button', { class: 'small', onclick: () => this.loadStats() }, 'Load CPU/memory'),
    ))
    this.statsBox = el('div')
    this.body = el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Waiting for the first snapshot…'))
    this.root.append(this.statsBox, this.body)

    this.unsub = ctx.sock.subscribe('docker', (msg) => {
      if (msg.type === 'snapshot') this.render(msg.payload)
      else if (msg.type === 'error') clear(this.body).append(el('div', { class: 'empty' }, msg.error))
    })
  },

  unmount() {
    this.unsub?.()
  },

  render(payload) {
    if (!payload?.ok) {
      clear(this.body).append(el('div', { class: 'empty' }, payload?.error || 'Docker is unreachable.'))
      return
    }
    const rows = payload.containers.map((c) => el('tr', {},
      el('td', {}, statusBadge(c.health || c.state)),
      el('td', { class: 'mono' }, c.name),
      el('td', { class: 'mono small muted ellipsis' }, c.image),
      el('td', { class: 'small muted' }, c.status),
      el('td', { class: 'mono small' }, c.ports.join(', ') || '–'),
      el('td', { class: 'right' }, el('div', { class: 'row actions' },
        el('button', { class: 'small', onclick: () => this.logs(c) }, 'Logs'),
        el('button', { class: 'small', onclick: () => this.inspect(c) }, 'Inspect'),
        c.state === 'running'
          ? el('button', { class: 'small', onclick: () => this.action(c, 'restart') }, 'Restart')
          : el('button', { class: 'small', onclick: () => this.action(c, 'start') }, 'Start'),
        c.state === 'running' ? el('button', { class: 'small danger', onclick: () => this.action(c, 'stop') }, 'Stop') : null,
      )),
    ))

    clear(this.body).append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'State'), el('th', {}, 'Name'), el('th', {}, 'Image'),
        el('th', {}, 'Status'), el('th', {}, 'Ports'), el('th', {}, ''),
      )),
      el('tbody', {}, rows),
    )))
  },

  async loadStats() {
    clear(this.statsBox).append(el('div', { class: 'card muted' }, 'Sampling…'))
    try {
      const { stats } = await api.get('/docker/stats')
      clear(this.statsBox).append(el('div', { class: 'card' },
        el('h3', {}, 'Resource usage'),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Container'), el('th', {}, 'CPU'), el('th', {}, 'Memory'), el('th', {}, 'Net I/O'), el('th', {}, 'PIDs'))),
          el('tbody', {}, (stats || []).map((s) => el('tr', {},
            el('td', { class: 'mono' }, s.name), el('td', { class: 'mono' }, s.cpu),
            el('td', { class: 'mono' }, s.mem), el('td', { class: 'mono small' }, s.net), el('td', { class: 'mono' }, s.pids),
          ))),
        ),
      )))
    } catch (err) {
      clear(this.statsBox).append(el('div', { class: 'card' }, err.message))
    }
  },

  logs(container) {
    this.ctx.dock.open({
      key: `dockerlogs:${container.name}`,
      channel: `dockerlogs:${container.name}`,
      title: `docker · ${container.name}`,
    })
  },

  async inspect(container) {
    try {
      const res = await api.get(`/docker/${encodeURIComponent(container.name)}/inspect`)
      const pre = el('pre', { class: 'code' }, JSON.stringify(res.data ?? res, null, 2))
      const card = el('div', { class: 'card' },
        el('div', { class: 'row' }, el('h2', {}, `inspect ${container.name}`), el('div', { class: 'spacer' }),
          el('button', { class: 'small', onclick: () => card.remove() }, 'Close')),
        pre,
      )
      this.root.insertBefore(card, this.body)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },

  async action(container, action) {
    if (action !== 'start') {
      const ok = await confirmDialog({
        title: `docker ${action} ${container.name}`,
        body: `This container serves ${container.image}. Anything connected to it will drop.`,
        confirmLabel: `${action} it`,
      })
      if (!ok) return
    }
    try {
      const { job } = await api.post(`/docker/${encodeURIComponent(container.name)}/${action}`)
      this.ctx.dock.openJob(job)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },
}
