import { el, clear, fmtDuration } from './ui.js'
import { LogStream, filterEntries, facets, groupEntries, headline, LEVELS } from './output-parse.js'

const LEVEL_ORDER = ['error', 'warn', 'info', 'debug', 'trace', 'fatal', 'other']
const MAX_ROWS = 1500

/**
 * NOTE ON THE FILE NAME: this used to be `logview.js` / `logparse.js`, and content
 * blockers matched those against their tracker filter lists — the browser refused
 * the request with ERR_BLOCKED_BY_CLIENT and the whole panel failed to boot for
 * anyone running uBlock or similar. Keep asset names free of words like log,
 * track, analytics, collect, ad or stat.
 *
 * The structured half of a log pane: the same stream the terminal shows, parsed
 * into rows that can be filtered by level, kind and cluster instance.
 *
 * Application logs are mostly machine-written JSON these days — a raw terminal
 * shows 400 identical web-vital lines and buries the two Prisma errors between
 * them. This shows the same stream as rows you can narrow down to `error`, or to
 * one instance of a cluster, or to whatever `/preview` matched.
 */
export class LogView {
  constructor({ onDownload } = {}) {
    this.stream = new LogStream({ limit: 5000 })
    this.filters = { levels: new Set(), kinds: new Set(), instances: new Set(), text: '' }
    this.follow = true
    this.grouped = false
    this.onDownload = onDownload

    this.rows = el('div', { class: 'logrows' })
    this.levelBar = el('div', { class: 'row logfilters' })
    this.kindBar = el('div', { class: 'row logfilters' })
    this.search = el('input', {
      class: 'field logsearch',
      type: 'search',
      placeholder: 'filter text — url, message, field value…',
      oninput: () => {
        clearTimeout(this._searchTimer)
        this._searchTimer = setTimeout(() => {
          this.filters.text = this.search.value
          this.rerender()
        }, 150)
      },
    })

    // Two shortcuts for the question people actually open logs with: what is
    // failing, and how often is it the same thing failing again.
    this.errorsBtn = el('button', {
      class: 'small',
      title: 'Show only errors',
      onclick: () => {
        const onlyErrors = this.filters.levels.has('error') && this.filters.levels.size <= 2
        this.filters.levels = onlyErrors ? new Set() : new Set(['error', 'fatal'])
        this.rerender()
      },
    }, 'Errors only')

    this.groupBtn = el('button', {
      class: 'small',
      title: 'Collapse repeats of the same message into one row with a count',
      onclick: () => {
        this.grouped = !this.grouped
        this.rerender()
      },
    }, 'Group repeats')

    this.followBtn = el('button', {
      class: 'small primary',
      onclick: () => {
        this.follow = !this.follow
        this.followBtn.className = `small ${this.follow ? 'primary' : ''}`
        this.followBtn.textContent = this.follow ? 'Following' : 'Paused'
        if (this.follow) this.scrollToEnd()
      },
    }, 'Following')

    this.countLabel = el('span', { class: 'small muted' })

    this.el = el('div', { class: 'logview' },
      el('div', { class: 'logtoolbar' },
        this.levelBar,
        this.kindBar,
        el('div', { class: 'row', style: 'flex:1 1 220px; min-width:180px' }, this.search),
        this.errorsBtn,
        this.groupBtn,
        this.followBtn,
        el('button', { class: 'small', onclick: () => { this.stream.clear(); this.rerender() } }, 'Clear'),
        this.onDownload ? el('button', { class: 'small', onclick: () => this.onDownload(this.visibleText()) }, 'Download') : null,
        this.countLabel,
      ),
      this.rows,
    )

    this.renderFilters()
  }

  /* ------------------------------------------------------------- ingestion */

  push(chunk) {
    const added = this.stream.push(chunk)
    if (!added.length) return

    if (this.grouped) {
      // Counts change with every line; redoing the whole list per chunk would
      // thrash, so coalesce into one repaint every half second.
      if (!this._groupTimer) {
        this._groupTimer = setTimeout(() => {
          this._groupTimer = null
          this.rerender()
        }, 500)
      }
      this.renderFilters()
      return
    }

    const visible = filterEntries(added, this.filters)
    for (const entry of visible) this.rows.append(this.row(entry))
    this.trimRows()
    this.renderFilters()
    this.updateCount()
    if (this.follow && visible.length) this.scrollToEnd()
  }

  rerender() {
    const matching = filterEntries(this.stream.entries, this.filters)
    const fragment = document.createDocumentFragment()

    if (this.grouped) {
      this.groups = groupEntries(matching)
      for (const group of this.groups.slice(0, MAX_ROWS)) fragment.append(this.groupRow(group))
    } else {
      this.groups = null
      for (const entry of matching.slice(-MAX_ROWS)) fragment.append(this.row(entry))
    }

    clear(this.rows).append(fragment)
    this.rows.classList.toggle('grouped', this.grouped)
    this.renderFilters()
    this.updateCount(matching.length)
    // A grouped list is sorted by frequency, so following the tail is meaningless.
    if (this.follow && !this.grouped) this.scrollToEnd()
  }

  trimRows() {
    while (this.rows.childElementCount > MAX_ROWS) this.rows.firstChild.remove()
  }

  scrollToEnd() {
    this.rows.scrollTop = this.rows.scrollHeight
  }

  updateCount(matching) {
    const total = this.stream.entries.length
    const shown = matching ?? this.rows.childElementCount
    this.errorsBtn.className = `small ${this.filters.levels.has('error') && this.filters.levels.size <= 2 ? 'primary' : ''}`
    this.groupBtn.className = `small ${this.grouped ? 'primary' : ''}`
    const groups = this.groups?.length ?? 0
    this.countLabel.textContent = this.grouped
      ? `${groups} ${groups === 1 ? 'group' : 'groups'} · ${shown} of ${total} lines`
      : shown === total ? `${total} lines` : `${shown} of ${total}`
  }

  visibleText() {
    const matching = filterEntries(this.stream.entries, this.filters)
    if (!this.grouped) return matching.map((e) => e.raw).join('\n')
    // Grouped download: the summary you are looking at, one line per problem.
    return groupEntries(matching)
      .map((g) => `${String(g.count).padStart(5)} × [${g.level}] ${g.sample.msg || g.sample.fallback || g.sample.raw}`)
      .join('\n')
  }

  /* --------------------------------------------------------------- filters */

  chip(label, count, active, onClick, extraClass = '') {
    return el('button', {
      class: `chip logchip ${active ? 'active' : ''} ${extraClass}`,
      onclick: onClick,
    }, label, count !== null ? el('span', { class: 'chipcount' }, String(count)) : null)
  }

  toggle(set, value) {
    if (set.has(value)) set.delete(value)
    else set.add(value)
    this.rerender()
  }

  renderFilters() {
    const { levels, kinds, instances } = facets(this.stream.entries)

    clear(this.levelBar)
    for (const level of LEVEL_ORDER) {
      const count = levels.get(level)
      if (!count) continue
      this.levelBar.append(this.chip(level, count, this.filters.levels.has(level), () => this.toggle(this.filters.levels, level), `lvl-${level}`))
    }

    clear(this.kindBar)
    const topKinds = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    for (const [kind, count] of topKinds) {
      this.kindBar.append(this.chip(kind, count, this.filters.kinds.has(kind), () => this.toggle(this.filters.kinds, kind)))
    }

    // Only worth showing for a cluster: one chip per pm2 instance, so the merged
    // stream can be narrowed to the worker that is actually misbehaving.
    if (instances.size > 1) {
      this.kindBar.append(el('span', { class: 'small muted', style: 'margin-left:6px' }, 'instance'))
      for (const [instance, count] of [...instances.entries()].sort()) {
        this.kindBar.append(this.chip(`#${instance}`, count, this.filters.instances.has(instance), () => this.toggle(this.filters.instances, instance)))
      }
    }

    if (this.filters.levels.size || this.filters.kinds.size || this.filters.instances.size || this.filters.text) {
      this.kindBar.append(el('button', {
        class: 'chip logchip clearfilters',
        onclick: () => {
          this.filters = { levels: new Set(), kinds: new Set(), instances: new Set(), text: '' }
          this.search.value = ''
          this.rerender()
        },
      }, 'clear filters'))
    }
  }

  /* ------------------------------------------------------------------ rows */

  /** One row per distinct problem: how many, over what span, from which workers. */
  groupRow(group) {
    const entry = group.sample
    const span = group.first && group.last && group.last > group.first
      ? `over ${fmtDuration(group.last - group.first)}`
      : 'once'

    const detail = el('pre', { class: 'logdetail' },
      [
        `last seen: ${group.last ? new Date(group.last).toLocaleTimeString() : 'unknown'}`,
        group.first && group.first !== group.last ? `first seen: ${new Date(group.first).toLocaleTimeString()}` : null,
        /\n/.test(entry.msg || '') ? entry.msg : null,
        entry.detail,
        Object.keys(entry.fields || {}).length ? JSON.stringify(entry.fields, null, 2) : '',
        `raw: ${entry.raw}`,
      ].filter(Boolean).join('\n\n'))
    detail.style.display = 'none'

    const row = el('div', { class: `logrow lvl-${entry.level} expandable` },
      el('span', { class: `logcount lvl-${entry.level}` }, `×${group.count}`),
      el('span', { class: `logbadge lvl-${entry.level}` }, entry.level),
      ...[...group.instances].sort().map((i) => el('span', { class: 'logbadge inst' }, `#${i}`)),
      el('span', { class: 'logmsg' }, headline(entry.msg || entry.fallback || entry.raw)),
      el('span', { class: 'logfield' }, el('i', {}, group.count > 1 ? 'seen' : ''), span),
    )
    row.addEventListener('click', () => {
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
    })
    return el('div', { class: 'logentry' }, row, detail)
  }

  row(entry) {
    const time = entry.time ? new Date(entry.time) : null
    const stamp = time
      ? `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`
      : '--:--:--'

    const fieldChips = []
    for (const [key, value] of Object.entries(entry.fields || {})) {
      if (value === null || typeof value === 'object') continue
      const text = typeof value === 'number' ? shortNumber(value) : String(value)
      if (text.length > 60) continue
      fieldChips.push(el('span', { class: 'logfield' }, el('i', {}, key), text))
      if (fieldChips.length >= 6) break
    }

    const multiline = /\n/.test(entry.msg || '')
    const expandable = multiline || !!entry.detail || Object.keys(entry.fields || {}).length > fieldChips.length
    const row = el('div', { class: `logrow lvl-${entry.level}${expandable ? ' expandable' : ''}` },
      el('span', {
        class: 'logtime',
        title: entry.timeSource === 'received' ? 'no timestamp in the line — this is when the panel received it' : '',
      }, entry.timeSource === 'received' ? `~${stamp}` : stamp),
      el('span', { class: `logbadge lvl-${entry.level}` }, entry.level),
      entry.instance !== null ? el('span', { class: 'logbadge inst' }, `#${entry.instance}`) : null,
      el('span', { class: 'logmsg' }, headline(entry.msg || entry.fallback || entry.raw)),
      ...fieldChips,
    )

    if (expandable) {
      const detail = el('pre', { class: 'logdetail' },
        [
          multiline ? entry.msg : '',
          entry.detail,
          Object.keys(entry.fields || {}).length ? JSON.stringify(entry.fields, null, 2) : '',
        ].filter(Boolean).join('\n\n'))
      detail.style.display = 'none'
      row.addEventListener('click', () => {
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
      })
      const wrap = el('div', { class: 'logentry' }, row, detail)
      return wrap
    }

    return el('div', { class: 'logentry' }, row)
  }
}

function shortNumber(value) {
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}

export { fmtDuration }
