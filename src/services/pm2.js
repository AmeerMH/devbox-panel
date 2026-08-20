import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { run } from '../util/exec.js'

const ACTIONS = new Set(['restart', 'reload', 'stop', 'start', 'flush'])

/** PM2 apps: status, restart/reload/stop/start, live logs. */
export class Pm2Service {
  constructor(cfg) {
    this.cfg = cfg.pm2 || {}
    this.enabled = this.cfg.enabled !== false
    this.bin = this._resolveBin(this.cfg.bin)
    this.home = this.cfg.home || null
  }

  _resolveBin(configured) {
    if (configured && configured !== 'auto') return configured
    const home = process.env.HOME || os.homedir()
    const candidates = [
      path.join(home, '.npm-global/bin/pm2'),
      '/usr/local/bin/pm2',
      '/usr/bin/pm2',
      ...(fs.existsSync(path.join(home, '.nvm/versions/node'))
        ? fs.readdirSync(path.join(home, '.nvm/versions/node')).map((v) => path.join(home, '.nvm/versions/node', v, 'bin/pm2'))
        : []),
    ]
    return candidates.find((c) => fs.existsSync(c)) || 'pm2'
  }

  env() {
    return this.home ? { PM2_HOME: this.home } : {}
  }

  async health() {
    if (!this.enabled) return { ok: false, reason: 'disabled in config' }
    const res = await run({ cmd: this.bin, args: ['-v'], timeoutMs: 10000, env: this.env() })
    if (!res.ok) {
      const raw = (res.stderr || res.stdout).trim().split('\n')[0]
      return {
        ok: false,
        reason: /ENOENT/.test(raw)
          ? `pm2 not found at "${this.bin}" — set "pm2": { "bin": "/full/path/to/pm2" } in panel.config.json`
          : `cannot run ${this.bin}: ${raw}`,
      }
    }
    return { ok: true, version: res.stdout.trim().split('\n').pop(), bin: this.bin }
  }

  async list() {
    const res = await run({ cmd: this.bin, args: ['jlist'], timeoutMs: 15000, env: this.env() })
    if (!res.ok) {
      const raw = (res.stderr || res.stdout).trim()
      const error = /ENOENT/.test(raw)
        ? `pm2 not found at "${this.bin}" — set "pm2": { "bin": "/full/path/to/pm2" } in panel.config.json`
        : raw
      return { ok: false, error, apps: [] }
    }

    // `pm2 jlist` can prefix banner noise; the payload starts at the first bracket.
    const start = res.stdout.indexOf('[')
    let raw = []
    try {
      raw = JSON.parse(res.stdout.slice(start === -1 ? 0 : start))
    } catch (err) {
      return { ok: false, error: `cannot parse pm2 jlist: ${err.message}`, apps: [] }
    }

    const apps = raw.map((a) => {
      const e = a.pm2_env || {}
      return {
        id: a.pm_id,
        name: a.name,
        status: e.status,
        mode: e.exec_mode,
        instances: e.instances ?? 1,
        pid: a.pid,
        uptime: e.pm_uptime ? Date.now() - e.pm_uptime : null,
        restarts: e.restart_time ?? 0,
        unstableRestarts: e.unstable_restarts ?? 0,
        cpu: a.monit?.cpu ?? 0,
        memory: a.monit?.memory ?? 0,
        cwd: e.pm_cwd || null,
        script: e.pm_exec_path || null,
        port: e.PORT || e.env?.PORT || null,
        node: e.node_version || null,
        outLog: e.pm_out_log_path || null,
        errLog: e.pm_err_log_path || null,
        user: e.username || null,
      }
    })
    apps.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    return { ok: true, apps }
  }

  async assertExists(name) {
    const { ok, apps } = await this.list()
    if (!ok) {
      const err = new Error('Cannot reach pm2')
      err.status = 503
      throw err
    }
    if (!apps.some((a) => a.name === name || String(a.id) === String(name))) {
      const err = new Error(`No pm2 app named "${name}"`)
      err.status = 404
      throw err
    }
    return true
  }

  async action({ jobs, name, action }) {
    if (!ACTIONS.has(action)) {
      const err = new Error(`Unsupported pm2 action "${action}"`)
      err.status = 400
      throw err
    }
    await this.assertExists(name)
    return jobs.start({
      kind: 'pm2',
      title: `pm2 ${action} ${name}`,
      target: `${action}:${name}`,
      cmd: this.bin,
      args: [action, name],
      cwd: process.cwd(),
      env: this.env(),
    })
  }

  /** argv for a follow stream. `pm2 logs --raw` merges stdout+stderr and survives rotation. */
  logsArgv(name, lines = 200) {
    return { cmd: this.bin, args: ['logs', name, '--raw', '--lines', String(lines)], env: this.env() }
  }

  async describe(name) {
    await this.assertExists(name)
    const res = await run({ cmd: this.bin, args: ['describe', name], timeoutMs: 15000, env: this.env() })
    return { ok: res.ok, text: res.stdout + res.stderr }
  }
}
