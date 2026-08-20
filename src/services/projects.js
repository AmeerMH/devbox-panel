import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseMakefile, isDangerous } from './makefile.js'
import { run } from '../util/exec.js'

const IGNORE_DIRS = new Set(['node_modules', 'lost+found', 'snap', 'uploads', 'acme-webroot', 'vhost-backups'])

function safeId(rootLabel, name) {
  return `${rootLabel}--${name}`.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * Discovers projects under the configured roots and exposes their make targets.
 *
 * A project qualifies if it has a Makefile (runnable) or is a git checkout
 * (still worth showing: Tayf and Portfolio-Builder have no Makefile but do have
 * pm2 apps and a branch worth seeing).
 */
export class ProjectsService {
  constructor(cfg) {
    this.cfg = cfg
    this.projects = new Map()
    this.pathAdditions = this._pathAdditions()
  }

  _pathAdditions() {
    const home = process.env.HOME || os.homedir()
    const candidates = [path.join(home, '.npm-global/bin'), '/usr/local/bin', '/usr/bin']
    return candidates.filter((p) => fs.existsSync(p))
  }

  /** PATH for spawned jobs: ~/.npm-global/bin holds pm2, which several deploy targets call. */
  jobEnv() {
    return { PATH: [...this.pathAdditions, process.env.PATH || ''].join(':') }
  }

  refresh() {
    const next = new Map()
    for (const root of this.cfg.roots) {
      let entries = []
      try {
        entries = fs.readdirSync(root.path, { withFileTypes: true })
      } catch (err) {
        next.set(safeId(root.label, '_error'), {
          id: safeId(root.label, '_error'),
          name: root.path,
          root: root.label,
          error: `Cannot read ${root.path}: ${err.code}`,
          targets: [],
        })
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue
        const dir = path.join(root.path, entry.name)
        const makefile = ['Makefile', 'makefile', 'GNUmakefile'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
        const isRepo = fs.existsSync(path.join(dir, '.git'))
        if (!makefile && !isRepo) continue

        const id = safeId(root.label, entry.name)
        const override = this.cfg.projectOverrides?.[entry.name] || this.cfg.projectOverrides?.[id] || {}
        const deny = new Set(override.deny || [])

        let targets = []
        if (makefile) {
          try {
            targets = parseMakefile(fs.readFileSync(makefile, 'utf8'))
              .filter((t) => !deny.has(t.name))
              .map((t) => ({
                ...t,
                dangerous: isDangerous(t.name, [...(this.cfg.dangerPatterns || []), ...(override.danger || [])]),
              }))
          } catch (err) {
            targets = []
            console.error(`[projects] cannot parse ${makefile}: ${err.message}`)
          }
        }

        next.set(id, {
          id,
          name: entry.name,
          path: dir,
          root: root.label,
          user: root.user || null,
          hasMakefile: !!makefile,
          isRepo,
          denied: [...deny],
          targets,
        })
      }
    }
    this.projects = next
    return this.list()
  }

  list() {
    return [...this.projects.values()]
  }

  get(id) {
    return this.projects.get(id) || null
  }

  target(project, name) {
    return project.targets.find((t) => t.name === name) || null
  }

  /** Read-only git snapshot. `safe.directory=*` because /srv/projects is owned by another user. */
  async gitInfo(project) {
    if (!project.isRepo) return null
    const git = (args) => run({ cmd: 'git', args: ['-c', 'safe.directory=*', '-C', project.path, ...args], timeoutMs: 10000 })

    const [branch, last, status, upstream] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['log', '-1', '--format=%h%x1f%an%x1f%ar%x1f%s']),
      git(['status', '--porcelain']),
      git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    ])

    const [hash, author, when, subject] = (last.stdout.trim() || '').split('\x1f')
    let ahead = null
    let behind = null
    if (upstream.ok) {
      const [a, b] = upstream.stdout.trim().split(/\s+/)
      ahead = Number(a)
      behind = Number(b)
    }

    return {
      branch: branch.stdout.trim() || null,
      commit: hash || null,
      author: author || null,
      when: when || null,
      subject: subject || null,
      dirty: status.stdout.split('\n').filter(Boolean).length,
      ahead,
      behind,
    }
  }

  /** Start a make target as a job. Every argument is validated against the parsed Makefile. */
  runTarget({ jobs, projectId, target }) {
    const project = this.get(projectId)
    if (!project) {
      const err = new Error('Unknown project')
      err.status = 404
      throw err
    }
    if (!project.hasMakefile) {
      const err = new Error(`${project.name} has no Makefile`)
      err.status = 400
      throw err
    }
    const found = this.target(project, target)
    if (!found) {
      const err = new Error(`Target "${target}" is not one of ${project.name}'s make targets`)
      err.status = 400
      throw err
    }
    if (jobs.isRunning(project.id, target)) {
      const err = new Error(`\`make ${target}\` is already running for ${project.name}`)
      err.status = 409
      throw err
    }

    return jobs.start({
      kind: 'make',
      title: `${project.name} · make ${target}`,
      projectId: project.id,
      target,
      cmd: 'make',
      args: ['-C', project.path, target],
      cwd: project.path,
      user: project.user,
      login: !project.user,
      env: this.jobEnv(),
    })
  }

  /** `git fetch --prune` as a job, so the ahead/behind counters can be refreshed. */
  fetch({ jobs, projectId }) {
    const project = this.get(projectId)
    if (!project?.isRepo) {
      const err = new Error('Not a git checkout')
      err.status = 400
      throw err
    }
    return jobs.start({
      kind: 'git',
      title: `${project.name} · git fetch`,
      projectId: project.id,
      target: 'git-fetch',
      cmd: 'git',
      args: ['-c', 'safe.directory=*', '-C', project.path, 'fetch', '--all', '--prune'],
      cwd: project.path,
      user: project.user,
      login: !project.user,
      env: this.jobEnv(),
    })
  }
}
