import { el, clear, toast } from './ui.js'
import { api } from './api.js'

const THEME = {
  background: '#0a0e15', foreground: '#d7e0ee', cursor: '#4f9dff',
  black: '#0a0e15', red: '#f85149', green: '#3fb950', yellow: '#d29922',
  blue: '#4f9dff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7e0ee',
  brightBlack: '#8b97ab', brightRed: '#ff7b72', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
}

/**
 * The bottom dock: one xterm pane per live thing being watched — a running make
 * target, a container's logs, a pm2 app's logs, an nginx log.
 *
 * Panes are tabs, so several `make deploy` runs can stream at once and you flip
 * between them; closing a tab unsubscribes, which also stops the server-side
 * `tail -F` when nobody else is watching.
 */
export class Dock {
  constructor({ sock }) {
    this.sock = sock
    this.panes = new Map()
    this.active = null
    this.root = document.getElementById('dock')
    this.tabsEl = document.getElementById('dock-tabs')
    this.panesEl = document.getElementById('dock-panes')
    this._setupResizer()
    window.addEventListener('resize', () => this.fitActive())
  }

  _setupResizer() {
    const resizer = document.getElementById('dock-resizer')
    let startY = 0
    let startH = 320
    const onMove = (e) => {
      const next = Math.min(Math.max(140, startH + (startY - e.clientY)), window.innerHeight - 220)
      this.panesEl.style.setProperty('--dock-height', `${next}px`)
      this.panesEl.style.height = `${next}px`
      this.fitActive()
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    resizer.addEventListener('mousedown', (e) => {
      startY = e.clientY
      startH = this.panesEl.getBoundingClientRect().height
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      e.preventDefault()
    })
  }

  _makeTerm(container) {
    const term = new window.Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 8000,
      theme: THEME,
    })
    const fit = new window.FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(container)
    setTimeout(() => { try { fit.fit() } catch { /* container not laid out yet */ } }, 0)
    return { term, fit }
  }

  /** Generic pane. `channel` decides what streams into it. */
  open({ key, channel, title, actions = [] }) {
    const existing = this.panes.get(key)
    if (existing) {
      this.activate(key)
      return existing
    }

    const termHost = el('div', { class: 'term' })
    const header = el('div', { class: 'row small muted', style: 'padding:2px 4px 6px' })
    const paneEl = el('div', { class: 'pane' }, header, termHost)
    this.panesEl.append(paneEl)

    const { term, fit } = this._makeTerm(termHost)
    const pane = { key, channel, title, el: paneEl, term, fit, header, follow: true, unsub: null }

    header.append(
      el('span', { class: 'mono' }, title),
      el('div', { class: 'spacer' }),
      ...actions.map((a) => el('button', {
        class: `small ${a.class || ''}`,
        onclick: () => a.onClick(pane),
      }, a.label)),
      el('button', { class: 'small', onclick: () => { term.clear() } }, 'Clear'),
    )

    const tab = el('div', { class: 'tab', onclick: () => this.activate(key) },
      el('span', {}, title),
      el('span', { class: 'x', onclick: (e) => { e.stopPropagation(); this.close(key) } }, '✕'),
    )
    this.tabsEl.append(tab)
    pane.tab = tab

    pane.unsub = this.sock.subscribe(channel, (msg) => {
      if (msg.type === 'snapshot' && msg.chunk) term.write(msg.chunk)
      else if (msg.type === 'data' && msg.chunk) term.write(msg.chunk)
      else if (msg.type === 'error') term.write(`\r\n\x1b[31m[panel] ${msg.error}\x1b[0m\r\n`)
      else if (msg.type === 'end') {
        const status = msg.job?.status || 'ended'
        tab.querySelector('span').textContent = `${title} · ${status}`
      }
      if (pane.follow) term.scrollToBottom()
    })

    this.panes.set(key, pane)
    this.root.classList.add('open')
    this.activate(key)
    return pane
  }

  openJob(job) {
    return this.open({
      key: `job:${job.id}`,
      channel: `job:${job.id}`,
      title: job.title || `job ${job.id}`,
      actions: [
        {
          label: 'Cancel',
          class: 'danger',
          onClick: async () => {
            try {
              await api.post(`/jobs/${job.id}/cancel`)
              toast('Cancel signal sent')
            } catch (err) {
              toast(err.message, 'bad')
            }
          },
        },
        { label: 'Download log', onClick: () => window.open(`/api/jobs/${job.id}/log`, '_blank') },
      ],
    })
  }

  activate(key) {
    for (const [k, pane] of this.panes) {
      const on = k === key
      pane.el.classList.toggle('active', on)
      pane.tab.classList.toggle('active', on)
    }
    this.active = key
    this.fitActive()
  }

  fitActive() {
    const pane = this.panes.get(this.active)
    if (!pane) return
    try { pane.fit.fit() } catch { /* hidden pane */ }
  }

  close(key) {
    const pane = this.panes.get(key)
    if (!pane) return
    pane.unsub?.()
    pane.term.dispose()
    pane.el.remove()
    pane.tab.remove()
    this.panes.delete(key)
    if (this.active === key) {
      const next = this.panes.keys().next()
      if (next.done) {
        this.active = null
        this.root.classList.remove('open')
        clear(this.tabsEl)
      } else {
        this.activate(next.value)
      }
    }
  }
}
