import { el, clear, toast } from './ui.js'
import { api } from './api.js'
import { LogView } from './logview.js'

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

  /**
   * Generic pane. `channel` decides what streams into it.
   *
   * Log channels get two views of the same bytes: a terminal (raw, colours intact)
   * and a parsed one with level/kind/instance filters. Both are fed every chunk, so
   * flipping between them never loses backlog.
   */
  open({ key, channel, title, actions = [], structured = true }) {
    const existing = this.panes.get(key)
    if (existing) {
      this.activate(key)
      return existing
    }

    const termHost = el('div', { class: 'term' })
    const header = el('div', { class: 'row small muted', style: 'padding:2px 4px 6px' })
    const logView = structured
      ? new LogView({ onDownload: (text) => downloadText(`${key.replace(/[^\w.-]+/g, '-')}.log`, text) })
      : null
    const body = el('div', { class: 'panebody' }, termHost, logView ? logView.el : null)
    const paneEl = el('div', { class: 'pane' }, header, body)
    this.panesEl.append(paneEl)

    const { term, fit } = this._makeTerm(termHost)
    const pane = { key, channel, title, el: paneEl, term, fit, header, logView, mode: structured ? 'pretty' : 'raw', follow: true, unsub: null }

    const applyMode = () => {
      const pretty = pane.mode === 'pretty'
      termHost.style.display = pretty ? 'none' : 'block'
      if (logView) logView.el.style.display = pretty ? 'flex' : 'none'
      if (!pretty) setTimeout(() => { try { fit.fit() } catch { /* hidden */ } }, 0)
      if (modeBtn) {
        modeBtn.textContent = pretty ? 'Raw' : 'Filtered'
        modeBtn.title = pretty ? 'Switch to the raw terminal' : 'Switch to the filtered view'
      }
    }
    const modeBtn = structured
      ? el('button', { class: 'small', onclick: () => { pane.mode = pane.mode === 'pretty' ? 'raw' : 'pretty'; applyMode() } }, 'Raw')
      : null

    header.append(
      el('span', { class: 'mono' }, title),
      el('div', { class: 'spacer' }),
      modeBtn,
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
      if ((msg.type === 'snapshot' || msg.type === 'data') && msg.chunk) {
        term.write(msg.chunk)
        logView?.push(msg.chunk)
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31m[panel] ${msg.error}\x1b[0m\r\n`)
        logView?.push(`[panel] ${msg.error}\n`)
      }
      if (msg.type === 'end') {
        const status = msg.job?.status || 'ended'
        tab.querySelector('span').textContent = `${title} · ${status}`
      }
      if (pane.follow) term.scrollToBottom()
    })

    applyMode()
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
      // Build output is meant to be read as a terminal, not as filterable records.
      structured: false,
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

/** Client-side file save: the log the user is looking at, filters applied. */
function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
