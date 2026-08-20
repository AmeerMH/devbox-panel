/** DOM + formatting helpers shared by every view. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '–'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function timeAgo(ts) {
  if (!ts) return '–'
  return `${fmtDuration(Date.now() - ts)} ago`
}

export function toast(message, kind = '') {
  const wrap = document.getElementById('toasts')
  const node = el('div', { class: `toast ${kind}` }, message)
  wrap.append(node)
  setTimeout(() => node.remove(), kind === 'bad' ? 9000 : 4500)
}

/** Promise<boolean> confirmation dialog — used before every dangerous make target. */
export function confirmDialog({ title, body, confirmLabel = 'Run it', danger = true }) {
  return new Promise((resolve) => {
    const close = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(value) }
    const onKey = (e) => { if (e.key === 'Escape') close(false) }
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(false) } },
      el('div', { class: 'modal' },
        el('h3', {}, title),
        el('div', { class: 'small muted', style: 'margin-bottom:16px; line-height:1.6' }, body),
        el('div', { class: 'row' },
          el('div', { class: 'spacer' }),
          el('button', { onclick: () => close(false) }, 'Cancel'),
          el('button', { class: danger ? 'danger' : 'primary', onclick: () => close(true) }, confirmLabel),
        ),
      ),
    )
    document.body.append(backdrop)
    document.addEventListener('keydown', onKey)
  })
}

/**
 * Small form dialog. Resolves to an object of values, or null if dismissed.
 * fields: [{ name, label, value, placeholder, help, type: 'text'|'select', options }]
 */
export function formDialog({ title, intro, fields, submitLabel = 'Apply', warning }) {
  return new Promise((resolve) => {
    const inputs = new Map()
    const errorLine = el('div', { class: 'small', style: 'color:var(--bad); min-height:16px; margin-top:8px' })

    const close = (value) => {
      backdrop.remove()
      document.removeEventListener('keydown', onKey)
      resolve(value)
    }
    const submit = () => {
      const out = {}
      for (const [name, input] of inputs) out[name] = input.value.trim()
      close(out)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close(null)
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit()
    }

    const rows = fields.map((f) => {
      const input = f.type === 'select'
        ? el('select', { class: 'field' }, ...f.options.map((o) =>
            el('option', { value: typeof o === 'string' ? o : o.value, selected: (typeof o === 'string' ? o : o.value) === f.value }, typeof o === 'string' ? o : o.label)))
        : el('input', { class: 'field', type: 'text', value: f.value ?? '', placeholder: f.placeholder || '' })
      inputs.set(f.name, input)
      return el('div', { class: 'field-row' },
        el('label', {}, f.label),
        input,
        f.help ? el('div', { class: 'small muted', style: 'margin-top:4px; line-height:1.5' }, f.help) : null,
      )
    })

    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(null) } },
      el('div', { class: 'modal' },
        el('h3', {}, title),
        intro ? el('div', { class: 'small muted', style: 'margin-bottom:14px; line-height:1.6' }, intro) : null,
        warning ? el('div', { class: 'notice', style: 'margin-bottom:14px' }, warning) : null,
        ...rows,
        errorLine,
        el('div', { class: 'row', style: 'margin-top:16px' },
          el('div', { class: 'spacer' }),
          el('button', { onclick: () => close(null) }, 'Cancel'),
          el('button', { class: 'primary', onclick: submit }, submitLabel),
        ),
      ),
    )
    document.body.append(backdrop)
    document.addEventListener('keydown', onKey)
    setTimeout(() => inputs.values().next().value?.focus(), 30)
  })
}

export function statusBadge(status) {
  const map = {
    running: 'run', online: 'ok', done: 'ok', healthy: 'ok',
    failed: 'bad', errored: 'bad', unhealthy: 'bad', exited: 'bad', stopped: 'bad',
    cancelled: 'warn', orphaned: 'warn', starting: 'warn', paused: 'warn',
  }
  return el('span', { class: `badge ${map[status] || ''}` }, status)
}
