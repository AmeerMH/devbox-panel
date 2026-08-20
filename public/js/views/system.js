import { el, clear, fmtBytes, fmtDuration } from '../ui.js'

/** Host vitals plus what the panel itself is running as. */
export const systemView = {
  id: 'system',
  label: 'System',

  async mount(ctx) {
    this.root = clear(ctx.root)
    this.root.append(el('div', { class: 'section-title' }, el('h1', {}, 'System')))
    this.body = el('div')
    this.root.append(this.body)
    this.unsub = ctx.sock.subscribe('system', (msg) => {
      if (msg.type === 'snapshot') this.render(msg.payload)
    })
  },

  unmount() {
    this.unsub?.()
  },

  render(s) {
    const memPct = Math.round((s.memory.used / s.memory.total) * 100)
    clear(this.body).append(
      el('div', { class: 'grid' },
        el('div', { class: 'card' },
          el('h3', {}, 'Host'),
          el('div', { class: 'mono' }, s.host),
          el('div', { class: 'small muted' }, s.platform),
          el('div', { class: 'small muted' }, `up ${fmtDuration(s.uptimeSec * 1000)} · ${s.cpus} vCPU · load ${s.load.map((l) => l.toFixed(2)).join(' ')}`),
        ),
        el('div', { class: 'card' },
          el('h3', {}, 'Memory'),
          el('div', { class: 'mono' }, `${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)} (${memPct}%)`),
          el('div', { class: 'small muted' }, `${fmtBytes(s.memory.available)} available`),
        ),
        el('div', { class: 'card' },
          el('h3', {}, 'Panel'),
          el('div', { class: 'mono small' }, `v${s.panel.version} · pid ${s.panel.pid} · node ${s.panel.node}`),
          el('div', { class: 'small muted' }, `user ${s.panel.user} · up ${fmtDuration(s.panel.uptimeSec * 1000)} · rss ${fmtBytes(s.panel.rssBytes)}`),
          el('div', { class: 'small muted mono' }, s.panel.configPath),
        ),
      ),
      el('div', { class: 'card' },
        el('h3', {}, 'Disks'),
        s.disks.length ? null : el('div', { class: 'small muted' }, 'No data — `df` returned nothing on this host.'),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Mount'), el('th', {}, 'Device'), el('th', {}, 'Used'), el('th', {}, 'Total'), el('th', {}, 'Free'))),
          el('tbody', {}, s.disks.map((d) => el('tr', {},
            el('td', { class: 'mono' }, d.mount), el('td', { class: 'mono small muted' }, d.device),
            el('td', { class: 'mono' }, `${fmtBytes(d.used)} (${Math.round((d.used / d.total) * 100)}%)`),
            el('td', { class: 'mono' }, fmtBytes(d.total)), el('td', { class: 'mono' }, fmtBytes(d.available)),
          ))),
        )),
      ),
      el('div', { class: 'card' },
        el('h3', {}, `Listening ports (${s.ports.length})`),
        s.ports.length
          ? el('div', { class: 'row' }, s.ports.map((p) => el('span', { class: 'badge mono', title: p.address }, String(p.port))))
          : el('div', { class: 'small muted' }, 'No data — `ss` is not available on this host.'),
      ),
    )
  },
}
