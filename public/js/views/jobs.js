import { api } from '../api.js'
import { el, clear, toast, fmtDuration, statusBadge, timeAgo } from '../ui.js'

/** Every command the panel has run: live ones on top, with cancel and log download. */
export const jobsView = {
  id: 'jobs',
  label: 'Runs',

  async mount(ctx) {
    this.ctx = ctx
    this.root = clear(ctx.root)
    this.root.append(el('div', { class: 'section-title' }, el('h1', {}, 'Runs')))
    this.body = el('div', { class: 'card' })
    this.root.append(this.body)

    this.unsub = ctx.sock.subscribe('jobs', () => this.load())
    await this.load()
    this.timer = setInterval(() => this.load(), 5000)
  },

  unmount() {
    this.unsub?.()
    clearInterval(this.timer)
  },

  async load() {
    let jobs = []
    try {
      ;({ jobs } = await api.get('/jobs'))
    } catch (err) {
      clear(this.body).append(el('div', { class: 'empty' }, err.message))
      return
    }

    const table = el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Status'), el('th', {}, 'What'), el('th', {}, 'Command'),
        el('th', {}, 'Started'), el('th', {}, 'Duration'), el('th', {}, 'Exit'), el('th', {}, ''),
      )),
      el('tbody', {}, jobs.map((job) => el('tr', {},
        el('td', {}, statusBadge(job.status)),
        el('td', {}, job.title),
        el('td', { class: 'mono small muted ellipsis' }, `${job.user ? `[${job.user}] ` : ''}${job.command}`),
        el('td', { class: 'small muted' }, timeAgo(job.startedAt)),
        el('td', { class: 'small muted' }, fmtDuration((job.endedAt || Date.now()) - job.startedAt)),
        el('td', { class: 'mono small' }, job.exitCode === null ? '–' : String(job.exitCode)),
        el('td', { class: 'right' },
          el('div', { class: 'row actions' },
            el('button', { class: 'small', onclick: () => this.ctx.dock.openJob(job) }, 'Output'),
            job.status === 'running'
              ? el('button', { class: 'small danger', onclick: () => this.cancel(job) }, 'Cancel')
              : el('button', { class: 'small', onclick: () => window.open(`/api/jobs/${job.id}/log`, '_blank') }, 'Log'),
          ),
        ),
      ))),
    ))

    clear(this.body).append(jobs.length ? table : el('div', { class: 'empty' }, 'Nothing has been run yet.'))
  },

  async cancel(job) {
    try {
      await api.post(`/jobs/${job.id}/cancel`)
      toast(`Cancelling ${job.title}`)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },
}
