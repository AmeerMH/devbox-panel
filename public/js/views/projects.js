import { api } from '../api.js'
import { el, clear, toast, confirmDialog, statusBadge } from '../ui.js'

/** Cards for every discovered project: git state, pm2 hints, and one chip per make target. */
export const projectsView = {
  id: 'projects',
  label: 'Projects',

  async mount(ctx) {
    this.ctx = ctx
    this.running = new Map() // `${projectId}::${target}` -> jobId
    this.root = clear(ctx.root)

    this.root.append(
      el('div', { class: 'section-title' },
        el('h1', {}, 'Projects'),
        el('div', { class: 'row' },
          el('button', { class: 'small', onclick: () => this.rescan() }, 'Rescan roots'),
          el('button', { class: 'small', onclick: () => this.load() }, 'Reload'),
        ),
      ),
    )
    this.grid = el('div', { class: 'grid' })
    this.root.append(this.grid)

    this.unsub = ctx.sock.subscribe('jobs', (msg) => {
      if (msg.type !== 'job') return
      const key = `${msg.job.projectId}::${msg.job.target}`
      if (msg.job.status === 'running') this.running.set(key, msg.job.id)
      else this.running.delete(key)
      this.paintRunning()
    })

    await this.load()
  },

  unmount() {
    this.unsub?.()
  },

  async rescan() {
    await api.post('/projects/refresh')
    toast('Roots rescanned')
    await this.load()
  },

  async load() {
    clear(this.grid).append(el('div', { class: 'muted' }, 'Loading…'))
    let projects = []
    try {
      ;({ projects } = await api.get('/projects?git=1'))
    } catch (err) {
      clear(this.grid).append(el('div', { class: 'empty' }, err.message))
      return
    }
    const jobs = (await api.get('/jobs')).jobs.filter((j) => j.status === 'running')
    this.running = new Map(jobs.map((j) => [`${j.projectId}::${j.target}`, j.id]))

    clear(this.grid)
    if (!projects.length) this.grid.append(el('div', { class: 'empty' }, 'No projects found under the configured roots.'))
    for (const project of projects) this.grid.append(this.card(project))
    this.paintRunning()
  },

  card(project) {
    const git = project.git
    const header = el('div', { class: 'row' },
      el('h2', {}, project.name),
      el('span', { class: 'badge' }, project.root),
      project.user ? el('span', { class: 'badge warn' }, `as ${project.user}`) : null,
      el('div', { class: 'spacer' }),
      project.isRepo ? el('button', { class: 'small', onclick: (e) => this.fetch(project, e.target) }, 'git fetch') : null,
    )

    const gitLine = git
      ? el('div', { class: 'small muted mono', style: 'margin:6px 0 10px' },
          `${git.branch ?? '?'} · ${git.commit ?? '?'} · ${git.subject ? git.subject.slice(0, 60) : ''} · ${git.when ?? ''}`,
          git.dirty ? el('span', { class: 'badge warn', style: 'margin-left:6px' }, `${git.dirty} dirty`) : null,
          git.behind ? el('span', { class: 'badge warn', style: 'margin-left:6px' }, `${git.behind} behind`) : null,
          git.ahead ? el('span', { class: 'badge', style: 'margin-left:6px' }, `${git.ahead} ahead`) : null,
        )
      : el('div', { class: 'small muted', style: 'margin:6px 0 10px' }, project.error || 'not a git checkout')

    const card = el('div', { class: 'card' }, header, gitLine, el('div', { class: 'small muted mono', style: 'margin-bottom:10px' }, project.path))

    if (!project.hasMakefile) {
      card.append(el('div', { class: 'small muted' }, 'No Makefile — nothing to run from here.'))
      return card
    }

    const sections = new Map()
    for (const target of project.targets) {
      const key = target.section || 'targets'
      if (!sections.has(key)) sections.set(key, [])
      sections.get(key).push(target)
    }

    for (const [section, targets] of sections) {
      card.append(el('h3', { style: 'margin-top:12px' }, section))
      const row = el('div', { class: 'row' })
      for (const target of targets) {
        const chip = el('button', {
          class: `chip ${target.dangerous ? 'danger' : ''}`,
          title: target.description || `make ${target.name}`,
          dataset: { key: `${project.id}::${target.name}` },
          onclick: () => this.run(project, target),
        }, target.name)
        row.append(chip)
      }
      card.append(row)
    }

    if (project.denied?.length) {
      card.append(el('div', { class: 'small muted', style: 'margin-top:10px' },
        `blocked by config: ${project.denied.join(', ')}`))
    }
    return card
  },

  paintRunning() {
    for (const chip of this.root.querySelectorAll('.chip[data-key]')) {
      const jobId = this.running.get(chip.dataset.key)
      chip.classList.toggle('running', !!jobId)
      chip.style.borderColor = jobId ? 'var(--accent)' : ''
      const label = chip.dataset.key.split('::')[1]
      chip.textContent = jobId ? `${label} ▸ running` : label
    }
  },

  async run(project, target) {
    if (target.dangerous) {
      const ok = await confirmDialog({
        title: `make ${target.name}`,
        body: el('div', {},
          el('div', {}, target.description || 'No description in the Makefile.'),
          el('div', { class: 'mono', style: 'margin-top:10px' }, `cd ${project.path} && make ${target.name}`),
          el('div', { style: 'margin-top:10px' }, 'This target is flagged as destructive or service-affecting.'),
        ),
        confirmLabel: `Run make ${target.name}`,
      })
      if (!ok) return
    }
    try {
      const { job } = await api.post(`/projects/${project.id}/run`, { target: target.name, confirm: true })
      this.running.set(`${project.id}::${target.name}`, job.id)
      this.paintRunning()
      this.ctx.dock.openJob(job)
    } catch (err) {
      toast(err.message, 'bad')
    }
  },

  async fetch(project, button) {
    button.disabled = true
    try {
      const { job } = await api.post(`/projects/${project.id}/fetch`)
      this.ctx.dock.openJob(job)
      setTimeout(() => this.load(), 4000)
    } catch (err) {
      toast(err.message, 'bad')
    } finally {
      button.disabled = false
    }
  },
}

export { statusBadge }
