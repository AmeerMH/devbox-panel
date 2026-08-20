import { api } from '../api.js'
import { el, clear, toast, confirmDialog, fmtBytes } from '../ui.js'

/** nginx: config test, guarded reload, the vhost → upstream map, and log tails. */
export const nginxView = {
  id: 'nginx',
  label: 'Nginx',

  async mount(ctx) {
    this.ctx = ctx
    this.root = clear(ctx.root)
    this.root.append(el('div', { class: 'section-title' },
      el('h1', {}, 'Nginx'),
      el('div', { class: 'row' },
        el('button', { class: 'small', onclick: () => this.test() }, 'nginx -t'),
        el('button', { class: 'small primary', onclick: () => this.reload() }, 'Reload'),
        el('button', { class: 'small', onclick: () => this.load() }, 'Refresh'),
      ),
    ))
    this.status = el('div', { class: 'card' }, el('div', { class: 'muted' }, 'Loading…'))
    this.output = el('div')
    this.vhosts = el('div', { class: 'card' })
    this.logs = el('div', { class: 'card' })
    this.root.append(this.status, this.output, this.vhosts, this.logs)
    await this.load()
  },

  unmount() {},

  async load() {
    let data
    try {
      data = await api.get('/nginx')
    } catch (err) {
      clear(this.status).append(el('div', { class: 'empty' }, err.message))
      return
    }

    const h = data.health || {}
    clear(this.status).append(
      el('div', { class: 'row' },
        el('span', { class: `badge ${h.ok ? 'ok' : 'bad'}` }, h.ok ? (h.running ? 'running' : 'reachable') : 'unavailable'),
        h.version ? el('span', { class: 'mono small muted' }, h.version) : null,
        h.pid ? el('span', { class: 'mono small muted' }, `pid ${h.pid}`) : null,
        h.reason ? el('span', { class: 'small muted' }, h.reason) : null,
      ),
    )

    clear(this.vhosts).append(el('h3', {}, `Virtual hosts (${data.vhosts.length})`))
    if (data.vhostError) this.vhosts.append(el('div', { class: 'empty' }, data.vhostError))
    else {
      this.vhosts.append(el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'File'), el('th', {}, 'server_name'), el('th', {}, 'Listen'),
          el('th', {}, 'Upstream'), el('th', {}, 'TLS'), el('th', {}, 'Access'), el('th', {}, ''),
        )),
        el('tbody', {}, data.vhosts.map((v) => el('tr', {},
          el('td', { class: 'mono small' }, v.file),
          el('td', { class: 'mono small' }, (v.serverNames || []).join(' ') || '–'),
          el('td', { class: 'small muted' }, (v.listens || []).join(' · ') || '–'),
          el('td', { class: 'mono small' }, (v.proxyPass || []).join(' ') || (v.roots || []).join(' ') || '–'),
          el('td', {}, v.ssl ? el('span', { class: 'badge ok' }, 'ssl') : el('span', { class: 'badge' }, 'plain')),
          el('td', {}, v.restricted ? el('span', { class: 'badge warn' }, 'restricted') : el('span', { class: 'badge' }, 'public')),
          el('td', { class: 'right' }, el('button', { class: 'small', onclick: () => this.showConf(v.file) }, 'View')),
        ))),
      )))
    }

    clear(this.logs).append(el('h3', {}, 'Logs'))
    if (!data.logs?.length) this.logs.append(el('div', { class: 'muted small' }, 'No log files reported by the helper.'))
    else {
      this.logs.append(el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'File'), el('th', {}, 'Size'), el('th', {}, ''))),
        el('tbody', {}, data.logs.map((l) => el('tr', {},
          el('td', { class: 'mono small' }, l.file),
          el('td', { class: 'mono small muted' }, fmtBytes(l.size)),
          el('td', { class: 'right' }, el('button', {
            class: 'small',
            onclick: () => this.ctx.dock.open({ key: `nginxlog:${l.file}`, channel: `nginxlog:${l.file}`, title: `nginx · ${l.file}` }),
          }, 'Tail')),
        ))),
      )))
    }
  },

  async showConf(file) {
    try {
      const res = await api.get(`/nginx/vhost/${encodeURIComponent(file)}`)
      const card = el('div', { class: 'card' },
        el('div', { class: 'row' }, el('h2', {}, file), el('div', { class: 'spacer' }),
          el('button', { class: 'small', onclick: () => card.remove() }, 'Close')),
        el('pre', { class: 'code' }, res.text || res.error || ''),
      )
      clear(this.output).append(card)
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch (err) {
      toast(err.message, 'bad')
    }
  },

  async test() {
    try {
      const res = await api.post('/nginx/test')
      clear(this.output).append(el('div', { class: 'card' },
        el('h3', {}, `nginx -t · ${res.ok ? 'ok' : 'failed'}`),
        el('pre', { class: 'code' }, res.text || '(no output)'),
      ))
      toast(res.ok ? 'Config test passed' : 'Config test failed', res.ok ? 'ok' : 'bad')
    } catch (err) {
      toast(err.message, 'bad')
    }
  },

  async reload() {
    const ok = await confirmDialog({
      title: 'Reload nginx',
      body: 'The config is tested first and the reload is skipped if the test fails. A passing reload is graceful — open connections finish on the old workers.',
      confirmLabel: 'Test and reload',
      danger: false,
    })
    if (!ok) return
    try {
      const res = await api.post('/nginx/reload')
      clear(this.output).append(el('div', { class: 'card' },
        el('h3', {}, `reload · ${res.ok ? 'ok' : `failed at ${res.stage}`}`),
        el('pre', { class: 'code' }, res.text || '(no output)'),
      ))
      toast(res.ok ? 'nginx reloaded' : `Reload failed at ${res.stage}`, res.ok ? 'ok' : 'bad')
    } catch (err) {
      clear(this.output).append(el('div', { class: 'card' },
        el('h3', {}, 'reload · failed'),
        el('pre', { class: 'code' }, err.data?.text || err.message),
      ))
      toast(err.message, 'bad')
    }
  },
}
