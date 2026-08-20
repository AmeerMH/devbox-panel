import fs from 'node:fs'
import { run, parseJsonLines } from '../util/exec.js'

const ACTIONS = new Set(['start', 'stop', 'restart'])

/** Docker containers: list, inspect, start/stop/restart, live logs. */
export class DockerService {
  constructor(cfg) {
    this.cfg = cfg.docker || {}
    this.bin = this.cfg.bin || 'docker'
    this.enabled = this.cfg.enabled !== false
  }

  /**
   * Docker access is a group membership, not a config flag — report the real reason
   * so the UI can say "add the panel user to the docker group" instead of "error".
   */
  async health() {
    if (!this.enabled) return { ok: false, reason: 'disabled in config' }
    const res = await run({ cmd: this.bin, args: ['version', '--format', '{{.Server.Version}}'], timeoutMs: 8000 })
    if (res.ok) return { ok: true, version: res.stdout.trim() }
    const msg = `${res.stderr}${res.stdout}`.trim()
    if (/permission denied/i.test(msg)) {
      return { ok: false, reason: `no access to the docker socket — add this user to the "docker" group (socket: ${fs.existsSync('/var/run/docker.sock') ? 'present' : 'missing'})` }
    }
    if (/ENOENT|not found/i.test(msg)) return { ok: false, reason: `docker binary not found (${this.bin})` }
    return { ok: false, reason: msg.split('\n')[0] || 'docker unreachable' }
  }

  async list() {
    const res = await run({ cmd: this.bin, args: ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], timeoutMs: 15000 })
    if (!res.ok) {
      const raw = (res.stderr || res.stdout).trim()
      const error = /permission denied/i.test(raw)
        ? 'no access to the docker socket — add the panel user to the "docker" group and restart the panel'
        : /ENOENT/.test(raw)
          ? `docker not found at "${this.bin}" — set "docker": { "bin": "/full/path/to/docker" } in panel.config.json`
          : raw
      return { ok: false, error, containers: [] }
    }

    const containers = parseJsonLines(res.stdout).map((c) => {
      const status = c.Status || ''
      const health = /\(healthy\)/.test(status) ? 'healthy'
        : /\(unhealthy\)/.test(status) ? 'unhealthy'
        : /\(health: starting\)/.test(status) ? 'starting' : null
      return {
        id: (c.ID || '').slice(0, 12),
        name: c.Names || '',
        image: c.Image || '',
        state: (c.State || '').toLowerCase(),
        status,
        health,
        ports: (c.Ports || '').split(',').map((p) => p.trim()).filter(Boolean),
        createdAt: c.CreatedAt || '',
        compose: c.Labels?.match?.(/com\.docker\.compose\.project=([^,]+)/)?.[1] || null,
      }
    })
    containers.sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'running' ? -1 : 1))
    return { ok: true, containers }
  }

  /** CPU/memory snapshot; separate call because `docker stats` is slow (~1s+). */
  async stats() {
    const res = await run({ cmd: this.bin, args: ['stats', '--no-stream', '--format', '{{json .}}'], timeoutMs: 20000 })
    if (!res.ok) return { ok: false, stats: [] }
    return {
      ok: true,
      stats: parseJsonLines(res.stdout).map((s) => ({
        name: s.Name, cpu: s.CPUPerc, mem: s.MemUsage, memPerc: s.MemPerc, net: s.NetIO, block: s.BlockIO, pids: s.PIDs,
      })),
    }
  }

  async inspect(name) {
    await this.assertExists(name)
    const res = await run({ cmd: this.bin, args: ['inspect', name], timeoutMs: 15000 })
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout).trim() }
    try {
      return { ok: true, data: JSON.parse(res.stdout)[0] }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /** Container names come from the client, so they are checked against the live list. */
  async assertExists(name) {
    const { ok, containers } = await this.list()
    if (!ok) {
      const err = new Error('Cannot reach docker')
      err.status = 503
      throw err
    }
    if (!containers.some((c) => c.name === name)) {
      const err = new Error(`No container named "${name}"`)
      err.status = 404
      throw err
    }
    return true
  }

  async action({ jobs, name, action }) {
    if (!ACTIONS.has(action)) {
      const err = new Error(`Unsupported docker action "${action}"`)
      err.status = 400
      throw err
    }
    if (action === 'stop' && this.cfg.allowStop === false) {
      const err = new Error('Stopping containers is disabled in the panel config')
      err.status = 403
      throw err
    }
    await this.assertExists(name)
    return jobs.start({
      kind: 'docker',
      title: `docker ${action} ${name}`,
      target: `${action}:${name}`,
      cmd: this.bin,
      args: [action, name],
      cwd: process.cwd(),
    })
  }

  /** argv for a follow-the-logs stream; the websocket layer spawns it. */
  logsArgv(name, tail = 200) {
    return { cmd: this.bin, args: ['logs', '--tail', String(tail), '--timestamps', '-f', name] }
  }
}
