import { api } from '../api.js'
import { el, clear, toast, confirmDialog, formDialog, fmtBytes, statusBadge } from '../ui.js'

/**
 * Databases, whether they run in a container or as a host service.
 *
 * Every engine gets the same outside controls (live usage, memory/CPU limits);
 * engines with a driver also expose their own memory settings, because raising a
 * container limit without raising the engine's cache does nothing, and lowering
 * one without lowering the engine's cache buys an OOM kill.
 */
export const databasesView = {
  id: 'databases',
  label: 'Databases',

  async mount(ctx) {
    this.ctx = ctx
    this.expanded = new Set()
    this.root = clear(ctx.root)
    this.root.append(el('div', { class: 'section-title' },
      el('h1', {}, 'Databases'),
      el('button', { class: 'small', onclick: () => this.load() }, 'Refresh'),
    ))
    this.body = el('div', {}, el('div', { class: 'muted' }, 'Looking for databases…'))
    this.root.append(this.body)

    this.unsub = ctx.sock.subscribe('databases', (msg) => {
      if (msg.type === 'snapshot') this.render(msg.payload)
      else if (msg.type === 'error') clear(this.body).append(el('div', { class: 'empty' }, msg.error))
    })
  },

  unmount() {
    this.unsub?.()
  },

  async load() {
    try {
      this.render(await api.get('/databases'))
    } catch (err) {
      clear(this.body).append(el('div', { class: 'empty' }, err.message))
    }
  },

  render(payload) {
    if (!payload?.ok) {
      clear(this.body).append(el('div', { class: 'empty' }, payload?.error || 'Cannot enumerate databases.'))
      return
    }
    if (!payload.databases.length) {
      clear(this.body).append(el('div', { class: 'empty' },
        'No databases found. The panel looks for known engine images among the containers, and for database units among the host services.'))
      return
    }

    const grid = el('div', { class: 'grid' })
    for (const db of payload.databases) grid.append(this.card(db))
    clear(this.body).append(grid)

    // Re-open whatever tuning panel was open before the refresh.
    for (const id of this.expanded) this.loadTuning(id, true)
  },

  card(db) {
    const limits = db.limits || {}
    const usedBytes = db.usage?.memoryBytes ?? parseUsage(db.usage?.memory)
    const pct = limits.memory && usedBytes ? Math.min(100, Math.round((usedBytes / limits.memory) * 100)) : null

    const card = el('div', { class: 'card', dataset: { db: db.id } },
      el('div', { class: 'row' },
        el('h2', {}, db.name),
        el('span', { class: 'badge' }, db.engineLabel),
        el('span', { class: 'badge' }, db.kind === 'container' ? 'container' : 'host service'),
        statusBadge(db.health || db.state),
        el('div', { class: 'spacer' }),
        db.port ? el('span', { class: 'mono small muted' }, `:${db.port}`) : null,
      ),
      el('div', { class: 'small muted mono', style: 'margin:6px 0 12px' }, db.image || db.unit || ''),

      el('div', { class: 'kv', style: 'margin-bottom:10px' },
        el('dt', {}, 'Memory'),
        el('dd', {}, `${db.usage?.memory || '–'}${limits.memory ? ` · limit ${fmtBytes(limits.memory)}` : ' · no limit'}`),
        el('dt', {}, 'CPU'),
        el('dd', {}, `${db.usage?.cpu || '–'}${limits.cpus ? ` · limit ${limits.cpus}` : ' · no limit'}`),
        db.kind === 'container' ? el('dt', {}, 'Restart') : null,
        db.kind === 'container' ? el('dd', {}, limits.restartPolicy || 'no') : null,
      ),

      pct !== null
        ? el('div', { class: 'meter', title: `${pct}% of the limit` },
            el('span', { class: pct > 90 ? 'bad' : pct > 75 ? 'warn' : '', style: `width:${pct}%` }))
        : null,

      limits.composeProject
        ? el('div', { class: 'small muted', style: 'margin-top:10px' },
            `compose project "${limits.composeProject}" — a limit set here is live now, but \`docker compose up\` recreates the container from the file. Mirror it there to keep it.`)
        : null,

      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'small', onclick: () => this.editLimits(db) }, 'Memory / CPU limits'),
        db.tunable
          ? el('button', { class: 'small', onclick: () => this.toggleTuning(db) }, 'Engine settings')
          : el('span', { class: 'small muted' }, 'No engine driver — limits only'),
        db.kind === 'container'
          ? el('button', { class: 'small', onclick: () => this.ctx.dock.open({ key: `dockerlogs:${db.name}`, channel: `dockerlogs:${db.name}`, title: `docker · ${db.name}` }) }, 'Logs')
          : null,
      ),
      el('div', { class: 'tuning', dataset: { for: db.id } }),
    )
    return card
  },

  /* ------------------------------------------------------------- limits */

  async editLimits(db) {
    const limits = db.limits || {}
    const fields = [
      {
        name: 'memory',
        label: 'Memory limit',
        value: limits.memory ? bytesToInput(limits.memory) : 'unlimited',
        placeholder: '2g, 512m, unlimited',
        help: 'Hard ceiling. The kernel kills the process when it goes past this, so leave headroom above the engine cache below.',
      },
      db.kind === 'container' ? {
        name: 'memoryReservation',
        label: 'Memory reservation (soft)',
        value: limits.memoryReservation ? bytesToInput(limits.memoryReservation) : 'unlimited',
        placeholder: '1g',
        help: 'Soft target: under memory pressure the kernel pushes this container back toward it. Never above the hard limit.',
      } : null,
      {
        name: 'cpus',
        label: 'CPU limit',
        value: limits.cpus ? String(limits.cpus) : 'unlimited',
        placeholder: '1.5, unlimited',
        help: 'Cores, fractional allowed. 1.5 means one and a half cores of runtime per second.',
      },
      db.kind === 'container' ? {
        name: 'restartPolicy',
        label: 'Restart policy',
        type: 'select',
        value: limits.restartPolicy || 'no',
        options: ['no', 'on-failure', 'always', 'unless-stopped'],
      } : null,
    ].filter(Boolean)

    const values = await formDialog({
      title: `Limits · ${db.name}`,
      intro: db.kind === 'container'
        ? 'Applied with `docker update` — live, no restart, no downtime.'
        : 'Applied with `systemctl set-property`, which writes a drop-in and takes effect immediately.',
      warning: limits.composeProject
        ? `This container belongs to compose project "${limits.composeProject}". The change applies now, but a later \`docker compose up\` recreates it from the file — put the same values in your compose file.`
        : null,
      fields,
      submitLabel: 'Apply limits',
    })
    if (!values) return

    const payload = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === '') continue
      payload[key] = value
    }
    if (payload.restartPolicy === (limits.restartPolicy || 'no')) delete payload.restartPolicy

    try {
      const { job } = await api.post(`/databases/${encodeURIComponent(db.id)}/limits`, payload)
      this.ctx.dock.openJob(job)
      toast(`Applying new limits to ${db.name}`)
      setTimeout(() => this.load(), 2500)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },

  /* ------------------------------------------------------ engine settings */

  toggleTuning(db) {
    if (this.expanded.has(db.id)) {
      this.expanded.delete(db.id)
      const host = this.root.querySelector(`.tuning[data-for="${cssEscape(db.id)}"]`)
      if (host) clear(host)
      return
    }
    this.expanded.add(db.id)
    this.loadTuning(db.id)
  },

  async loadTuning(id, quiet = false) {
    const host = this.root.querySelector(`.tuning[data-for="${cssEscape(id)}"]`)
    if (!host) return
    if (!quiet) clear(host).append(el('div', { class: 'small muted', style: 'margin-top:12px' }, 'Reading the engine settings…'))

    let detail
    try {
      detail = await api.get(`/databases/${encodeURIComponent(id)}`)
    } catch (err) {
      clear(host).append(el('div', { class: 'small', style: 'margin-top:12px; color:var(--bad)' }, err.message))
      return
    }

    const { database, tunables, settings, version } = detail
    const box = el('div', { style: 'margin-top:14px' },
      el('h3', {}, `${database.engineLabel}${version ? ` ${version}` : ''} settings`),
    )

    if (!settings.ok) {
      box.append(el('div', { class: 'notice' }, settings.error || 'Could not read the current settings.'))
      clear(host).append(box)
      return
    }

    for (const tunable of tunables) {
      const current = settings.values[tunable.key]
      const shown = current?.bytes ? fmtBytes(current.bytes) : (current?.raw ?? '–')
      const input = el('input', {
        class: 'field',
        type: 'text',
        value: current?.bytes ? bytesToInput(current.bytes) : String(current?.raw ?? ''),
      })
      const apply = el('button', {
        class: 'small',
        onclick: async () => {
          apply.disabled = true
          try {
            const result = await api.post(`/databases/${encodeURIComponent(id)}/settings`, { key: tunable.key, value: input.value.trim() })
            toast(`${tunable.label}: ${result.note}`, result.needsRestart ? '' : 'ok')
            this.loadTuning(id, true)
          } catch (err) {
            toast(err.message, 'bad')
          } finally {
            apply.disabled = false
          }
        },
      }, 'Apply')

      box.append(el('div', { class: 'tunable' },
        el('div', { class: 'row' },
          el('div', { style: 'flex:1 1 200px' },
            el('div', {}, tunable.label,
              tunable.apply === 'restart' ? el('span', { class: 'badge warn', style: 'margin-left:8px' }, 'needs restart') : null),
            el('div', { class: 'small muted mono' }, `${tunable.key} · now ${shown}`),
          ),
          tunable.kind === 'enum'
            ? replaceWithSelect(input, tunable, current)
            : input,
          apply,
        ),
        el('div', { class: 'small muted', style: 'margin-top:6px; line-height:1.5' }, tunable.help || ''),
      ))
    }

    clear(host).append(box)
  },
}

function replaceWithSelect(input, tunable, current) {
  const select = el('select', { class: 'field' },
    ...tunable.options.map((o) => el('option', { value: o, selected: o === current?.raw }, o)))
  // The Apply handler reads `.value`, which both elements have.
  input.replaceWith?.(select)
  Object.defineProperty(input, 'value', { get: () => select.value, configurable: true })
  return select
}

function bytesToInput(bytes) {
  if (!bytes) return 'unlimited'
  if (bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}g`
  if (bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}m`
  return String(bytes)
}

function parseUsage(text) {
  // docker stats gives "318MiB / 47GiB"
  const m = /^([\d.]+)\s*([KMGT]?i?B)/i.exec(String(text || ''))
  if (!m) return null
  const units = { b: 1, kib: 1024, kb: 1024, mib: 1024 ** 2, mb: 1024 ** 2, gib: 1024 ** 3, gb: 1024 ** 3, tib: 1024 ** 4, tb: 1024 ** 4 }
  return Math.round(Number(m[1]) * (units[m[2].toLowerCase()] || 1))
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}

export { confirmDialog }
