import fs from 'node:fs'
import { run, parseJsonLines } from '../util/exec.js'
import { nanoCpusToCpus, toDockerBytes, validateLimits } from '../util/units.js'

const ACTIONS = new Set(['start', 'stop', 'restart'])
const RESTART_POLICIES = new Set(['no', 'always', 'unless-stopped', 'on-failure'])

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
    // One inspect for the whole set, so the table can show current limits without
    // a round trip per row.
    const details = await this.inspectMany(containers.map((c) => c.name))
    for (const container of containers) {
      const data = details.get(container.name)
      container.limits = data ? DockerService.limitsFrom(data) : null
    }

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

  /** Inspect many containers in one call — `docker inspect` takes a list. */
  async inspectMany(names) {
    if (!names.length) return new Map()
    const res = await run({ cmd: this.bin, args: ['inspect', ...names], timeoutMs: 20000 })
    if (!res.ok) return new Map()
    try {
      return new Map(JSON.parse(res.stdout).map((d) => [String(d.Name || '').replace(/^\//, ''), d]))
    } catch {
      return new Map()
    }
  }

  /** The limit fields the UI shows, pulled out of an inspect payload. */
  static limitsFrom(data) {
    const host = data?.HostConfig || {}
    const labels = data?.Config?.Labels || {}
    return {
      memory: host.Memory ?? 0,
      memorySwap: host.MemorySwap ?? 0,
      memoryReservation: host.MemoryReservation ?? 0,
      cpus: nanoCpusToCpus(host.NanoCpus ?? 0),
      cpuShares: host.CpuShares ?? 0,
      pidsLimit: host.PidsLimit ?? 0,
      restartPolicy: host.RestartPolicy?.Name || 'no',
      restartRetries: host.RestartPolicy?.MaximumRetryCount ?? 0,
      composeProject: labels['com.docker.compose.project'] || null,
      composeService: labels['com.docker.compose.service'] || null,
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

  /**
   * Current cgroup limits, straight from `docker inspect`, plus the compose labels —
   * the UI needs those to warn that `docker compose up` will undo a live change.
   */
  async resources(name) {
    const res = await this.inspect(name)
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, resources: DockerService.limitsFrom(res.data) }
  }

  /**
   * Apply new limits with `docker update` — live, no recreate, no downtime.
   *
   * Runs as a job so the change lands in the Runs history with its output: a
   * resource limit that silently changed is worse than one you can point at.
   */
  async updateResources({ jobs, name, limits, totalMemoryBytes }) {
    await this.assertExists(name)
    const normalised = validateLimits(limits, { totalMemoryBytes })

    const args = ['update']
    if (normalised.memory !== undefined) {
      args.push('--memory', toDockerBytes(normalised.memory))
      // memory-swap is the COMBINED memory+swap ceiling, and Docker rejects an
      // update where it ends up below the memory limit. Unless the caller asked for
      // something specific, mirror what `docker run -m` does on its own: twice the
      // limit, or unlimited when the limit itself is removed.
      if (normalised.memorySwap === undefined) {
        args.push('--memory-swap', normalised.memory === 0 ? '-1' : toDockerBytes(normalised.memory * 2))
      }
    }
    if (normalised.memorySwap !== undefined) {
      args.push('--memory-swap', normalised.memorySwap === 0 ? '-1' : toDockerBytes(normalised.memorySwap))
    }
    if (normalised.memoryReservation !== undefined) {
      args.push('--memory-reservation', toDockerBytes(normalised.memoryReservation))
    }
    if (normalised.cpus !== undefined) args.push('--cpus', String(normalised.cpus))

    if (limits.restartPolicy !== undefined) {
      const policy = String(limits.restartPolicy)
      if (!RESTART_POLICIES.has(policy)) {
        const err = new Error(`Unsupported restart policy "${policy}"`)
        err.status = 400
        throw err
      }
      args.push('--restart', policy)
    }

    args.push(name)

    return jobs.start({
      kind: 'docker',
      title: `docker update ${name}`,
      target: `update:${name}`,
      cmd: this.bin,
      args,
      cwd: process.cwd(),
    })
  }

  /**
   * Run a command inside a container and capture it. Used by the database drivers
   * to talk to an engine through its own CLI (psql, redis-cli, mongosh) over the
   * container's loopback — which is why the panel never needs stored credentials.
   */
  async exec({ name, args, user = null, env = {}, timeoutMs = 15000 }) {
    const argv = ['exec']
    if (user) argv.push('-u', user)
    for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`)
    argv.push(name, ...args)
    return run({ cmd: this.bin, args: argv, timeoutMs })
  }

  /**
   * Environment and command line of a container. Both matter to the database
   * drivers: credentials live in the environment for Postgres and MySQL, but Redis
   * is usually started with `--requirepass <password>` on the command line instead.
   */
  async config(name) {
    const res = await this.inspect(name)
    if (!res.ok) return { env: {}, cmd: [] }
    const env = {}
    for (const line of res.data?.Config?.Env || []) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return { env, cmd: res.data?.Config?.Cmd || [], entrypoint: res.data?.Config?.Entrypoint || [] }
  }

  async env(name) {
    return (await this.config(name)).env
  }

  /** argv for a follow-the-logs stream; the websocket layer spawns it. */
  logsArgv(name, tail = 200) {
    if (!/^[\w.\-]+$/.test(String(name))) {
      const err = new Error(`Refusing an odd container name: ${name}`)
      err.status = 400
      throw err
    }
    return { cmd: this.bin, args: ['logs', '--tail', String(tail), '--timestamps', '-f', name] }
  }
}
