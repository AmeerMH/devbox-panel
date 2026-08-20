import { run } from '../util/exec.js'
import { DRIVERS, KNOWN_ENGINES, driverForImage, engineForImage, driverForUnit } from './dbdrivers/index.js'
import { findTunable } from './dbdrivers/common.js'
import { validateLimits, toSystemdMemory, toSystemdCpuQuota, nanoCpusToCpus } from '../util/units.js'

const UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/

/**
 * Databases, wherever they run.
 *
 * Two sources: containers (matched by image) and host services (matched by unit
 * name). Everything gets the outside view — status, live memory/CPU usage and
 * editable limits. Engines with a driver additionally expose their own memory
 * knobs, because a container limit without matching engine settings just moves
 * the crash: Postgres with 4 GB of shared_buffers in a 2 GB container is an OOM
 * kill waiting for traffic.
 */
export class DatabasesService {
  constructor(cfg, { docker, system }) {
    this.cfg = cfg.databases || {}
    this.enabled = this.cfg.enabled !== false
    this.docker = docker
    this.system = system
    this.helper = this.cfg.helper || '/usr/local/bin/devbox-panel-dbadmin'
    this.useSudo = this.cfg.sudo !== false
    this.scanServices = this.cfg.scanServices !== false
  }

  /* --------------------------------------------------------------- helper */

  _helperArgv(args) {
    return this.useSudo
      ? { cmd: 'sudo', args: ['-n', this.helper, ...args] }
      : { cmd: this.helper, args }
  }

  async _helper(args, timeoutMs = 20000) {
    const { cmd, args: argv } = this._helperArgv(args)
    return run({ cmd, args: argv, timeoutMs })
  }

  async helperHealth() {
    const res = await this._helper(['ping'], 8000)
    if (res.ok) return { ok: true }
    const msg = (res.stderr || res.stdout || '').trim().split('\n')[0]
    if (/sudo:.*password|may not run/i.test(msg)) return { ok: false, reason: 'sudo refused — install deploy/sudoers.devbox-panel' }
    if (/ENOENT|no such file/i.test(msg)) return { ok: false, reason: `helper not installed at ${this.helper}` }
    return { ok: false, reason: msg || 'db helper unavailable' }
  }

  /* ------------------------------------------------------------ discovery */

  async list() {
    if (!this.enabled) return { ok: false, error: 'disabled in config', databases: [] }

    const [containers, services] = await Promise.all([this._containerDatabases(), this._serviceDatabases()])
    const databases = [...containers, ...services].sort((a, b) => a.name.localeCompare(b.name))
    return { ok: true, databases }
  }

  async _containerDatabases() {
    const listed = await this.docker.list()
    if (!listed.ok) return []

    const candidates = listed.containers.filter((c) => engineForImage(c.image))
    if (!candidates.length) return []

    // One stats sample for the whole set — `docker stats` is slow, so it is not
    // worth calling per container.
    const stats = await this.docker.stats()
    const byName = new Map((stats.stats || []).map((s) => [s.name, s]))

    const out = []
    for (const container of candidates) {
      const engine = engineForImage(container.image)
      const sample = byName.get(container.name)
      out.push({
        id: `container:${container.name}`,
        kind: 'container',
        name: container.name,
        engine: engine.id,
        engineLabel: engine.label,
        tunable: engine.tunable,
        image: container.image,
        state: container.state,
        health: container.health,
        status: container.status,
        ports: container.ports,
        port: firstPublishedPort(container.ports) ?? engine.defaultPort,
        compose: container.compose,
        limits: container.limits,
        usage: sample ? { memory: sample.mem, memoryPercent: sample.memPerc, cpu: sample.cpu, pids: sample.pids } : null,
      })
    }
    return out
  }

  async _serviceDatabases() {
    if (!this.scanServices) return []

    // `systemctl` reads fine unprivileged; only changing a property needs root.
    const listed = await run({
      cmd: 'systemctl',
      args: ['list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager'],
      timeoutMs: 12000,
    })
    if (!listed.ok) return []

    const units = String(listed.stdout)
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((u) => UNIT_RE.test(u || ''))

    const portsByPid = await this._listeningPortsByPid()

    const out = []
    for (const unit of units) {
      const driver = driverForUnit(unit)
      const known = driver ? null : KNOWN_ENGINES.find((e) => new RegExp(`^${e.id}`, 'i').test(unit))
      if (!driver && !known) continue

      const props = await this._unitProperties(unit)
      if (props.LoadState === 'not-found' || props.UnitFileState === 'masked') continue
      // Distributions ship a wrapper unit (postgresql.service) that starts the real
      // per-cluster units and then exits. It has no process and no port — listing it
      // would just be a second, dead-looking copy of the database next to it.
      const mainPid = Number(props.MainPID) || 0
      if (!mainPid && props.SubState === 'exited') continue

      // Unprivileged `ss` hides other users' sockets, so a database running as its
      // own user shows no port. The helper (root) can answer that.
      let ports = portsByPid.get(mainPid) || []
      if (!ports.length && mainPid) ports = await this._helperPorts(unit)

      out.push({
        id: `service:${unit}`,
        kind: 'service',
        name: unit.replace(/\.service$/, ''),
        unit,
        engine: driver?.id || known.id,
        engineLabel: driver?.label || known.label,
        tunable: !!driver,
        state: props.ActiveState === 'active' ? 'running' : props.ActiveState,
        status: `${props.ActiveState}${props.SubState ? ` (${props.SubState})` : ''}`,
        health: null,
        ports: ports.map((p) => `127.0.0.1:${p}`),
        // The real port, not the engine's default: a second Postgres cluster on the
        // same host is on 5433, and asking 5432 would talk to the wrong one.
        port: ports[0] ?? driver?.defaultPort ?? known?.defaultPort ?? null,
        limits: {
          memory: numberOrZero(props.MemoryMax),
          memorySwap: null,
          memoryReservation: numberOrZero(props.MemoryLow),
          cpus: quotaToCpus(props.CPUQuotaPerSecUSec),
          restartPolicy: props.Restart || 'no',
        },
        usage: {
          memory: numberOrZero(props.MemoryCurrent) ? formatMiB(numberOrZero(props.MemoryCurrent)) : null,
          memoryBytes: numberOrZero(props.MemoryCurrent),
          cpu: null,
        },
        mainPid: mainPid || null,
      })
    }
    return out
  }

  /** pid -> listening ports, from one `ss` call. Used to find a service's real port. */
  async _listeningPortsByPid() {
    const res = await run({ cmd: 'ss', args: ['-tlnpH'], timeoutMs: 8000 })
    const byPid = new Map()
    if (!res.ok) return byPid
    for (const line of String(res.stdout).split('\n')) {
      const local = line.trim().split(/\s+/)[3]
      if (!local) continue
      const port = Number(local.split(':').pop())
      if (!port) continue
      for (const m of line.matchAll(/pid=(\d+)/g)) {
        const pid = Number(m[1])
        const list = byPid.get(pid) || []
        if (!list.includes(port)) list.push(port)
        byPid.set(pid, list)
      }
    }
    for (const list of byPid.values()) list.sort((a, b) => a - b)
    return byPid
  }

  async _helperPorts(unit) {
    const res = await this._helper(['unit-ports', unit], 10000)
    if (!res.ok) return []
    try {
      const parsed = JSON.parse(String(res.stdout).trim() || '[]')
      return Array.isArray(parsed) ? parsed.filter((n) => Number.isFinite(n)) : []
    } catch {
      return []
    }
  }

  async _unitProperties(unit) {
    const res = await run({
      cmd: 'systemctl',
      args: ['show', unit, '--no-pager',
        '-p', 'ActiveState', '-p', 'SubState', '-p', 'LoadState', '-p', 'UnitFileState',
        '-p', 'MemoryCurrent', '-p', 'MemoryMax', '-p', 'MemoryLow',
        '-p', 'CPUQuotaPerSecUSec', '-p', 'MainPID', '-p', 'Restart'],
      timeoutMs: 8000,
    })
    const props = {}
    for (const line of String(res.stdout).split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1).trim()
    }
    return props
  }

  async get(id) {
    const { databases } = await this.list()
    const found = databases.find((d) => d.id === id)
    if (!found) {
      const err = new Error(`No database "${id}"`)
      err.status = 404
      throw err
    }
    return found
  }

  /* ------------------------------------------------------ engine settings */

  driverFor(database) {
    if (database.kind === 'container') return driverForImage(database.image)
    return driverForUnit(database.unit)
  }

  /**
   * The bridge a driver talks through. Container engines are reached with
   * `docker exec` over the container's own loopback — which is why no database
   * password is ever stored by the panel. Host services go through the root
   * helper, which only knows how to run one engine client with one query.
   */
  async _context(database, driver) {
    if (database.kind === 'container') {
      const config = await this.docker.config(database.name)
      const env = config.env
      const cliEnv = {}
      if (driver.id === 'redis') {
        const { password } = driver.credentials(config)
        if (password) cliEnv.REDISCLI_AUTH = password
      }
      const ctx = {
        cli: (args, extraEnv = {}) => this.docker.exec({ name: database.name, args, env: { ...cliEnv, ...extraEnv } }),
      }
      if (driver.id === 'postgres') {
        const user = env.POSTGRES_USER || 'postgres'
        const db = env.POSTGRES_DB || user
        ctx.sql = (query) => this.docker.exec({ name: database.name, args: ['psql', '-U', user, '-d', db, '-tAc', query] })
      } else if (driver.id === 'mysql') {
        const { user, password } = driver.credentials(env)
        ctx.sql = (query) => this.docker.exec({
          name: database.name,
          args: ['mysql', '-u', user, '-N', '-B', '-e', query],
          // MYSQL_PWD keeps the password off the command line, so it never shows in
          // `ps`, in the job log, or in anything the panel returns.
          env: password ? { MYSQL_PWD: password } : {},
        })
      }
      return ctx
    }

    // Host service. The helper deliberately has no "run this SQL" verb, so this
    // adapter maps the driver's three queries onto the fixed verbs it does have.
    // The helper re-validates the setting name and value itself — this side is a
    // convenience, not the security boundary.
    const port = String(database.port ?? driver.defaultPort)
    return {
      sql: async (query) => {
        const text = String(query).trim()
        if (/FROM pg_settings/i.test(text)) return this._helper(['pg-show', port], 20000)
        if (/^SHOW server_version/i.test(text)) return this._helper(['pg-version', port], 15000)
        if (/^SELECT pg_reload_conf/i.test(text)) return { ok: true, stdout: 't', stderr: '' }
        const alter = /^ALTER SYSTEM SET ([a-z_]+) = '([^']+)'$/i.exec(text)
        if (alter) return this._helper(['pg-set', port, alter[1], alter[2]], 20000)
        return { ok: false, stdout: '', stderr: `unsupported query for a host service: ${text.slice(0, 60)}` }
      },
      cli: async () => ({
        ok: false,
        stdout: '',
        stderr: `engine settings for a host ${driver.label} service are not supported yet — memory and CPU limits still work`,
      }),
    }
  }

  async detail(id) {
    const database = await this.get(id)
    const driver = this.driverFor(database)
    if (!driver) {
      return {
        database,
        tunables: [],
        settings: { ok: false, error: `No engine driver for ${database.engineLabel} — memory and CPU limits still apply.`, values: {} },
        version: null,
      }
    }

    const ctx = await this._context(database, driver)
    const [version, settings] = await Promise.all([
      driver.version(ctx).catch(() => null),
      driver.settings(ctx).catch((err) => ({ ok: false, error: err.message, values: {} })),
    ])

    return { database, tunables: driver.tunables, settings, version, driver: driver.id }
  }

  async applySetting({ id, key, value }) {
    const database = await this.get(id)
    const driver = this.driverFor(database)
    if (!driver) {
      const err = new Error(`${database.engineLabel} has no engine driver — only memory and CPU limits can be changed`)
      err.status = 400
      throw err
    }
    if (!findTunable(driver, key)) {
      const err = new Error(`"${key}" is not a tunable setting for ${driver.label}`)
      err.status = 400
      throw err
    }

    const ctx = await this._context(database, driver)
    const result = await driver.apply(ctx, key, value)
    if (!result.ok) {
      const err = new Error(result.error || 'the engine rejected the change')
      err.status = 400
      throw err
    }
    return result
  }

  /* -------------------------------------------------------------- limits */

  async applyLimits({ jobs, id, limits }) {
    const database = await this.get(id)
    const totalMemoryBytes = (await this.system.memory()).total

    if (database.kind === 'container') {
      return this.docker.updateResources({ jobs, name: database.name, limits, totalMemoryBytes })
    }

    const normalised = validateLimits(limits, { totalMemoryBytes })
    if (!UNIT_RE.test(database.unit)) {
      const err = new Error('Refusing an odd unit name')
      err.status = 400
      throw err
    }

    const args = ['systemd-set', database.unit]
    args.push(normalised.memory !== undefined ? toSystemdMemory(normalised.memory) : '-')
    args.push(normalised.cpus !== undefined ? toSystemdCpuQuota(normalised.cpus) : '-')

    const { cmd, args: argv } = this._helperArgv(args)
    return jobs.start({
      kind: 'database',
      title: `systemd limits · ${database.name}`,
      target: `limits:${database.id}`,
      cmd,
      args: argv,
      cwd: process.cwd(),
    })
  }

  /** Engines the panel knows about, for the UI's "supported" list. */
  static engines() {
    return [
      ...DRIVERS.map((d) => ({ id: d.id, label: d.label, tunable: true })),
      ...KNOWN_ENGINES.map((e) => ({ id: e.id, label: e.label, tunable: false })),
    ]
  }
}

function firstPublishedPort(ports = []) {
  for (const p of ports) {
    const m = /:(\d+)->/.exec(p)
    if (m) return Number(m[1])
  }
  return null
}

function numberOrZero(value) {
  if (value === undefined || value === null) return 0
  if (value === 'infinity' || value === '[not set]') return 0
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function quotaToCpus(value) {
  // systemd reports CPUQuotaPerSecUSec as e.g. "1500ms" or "infinity".
  if (!value || value === 'infinity') return 0
  const m = /^(\d+(?:\.\d+)?)(ms|us|s)$/.exec(String(value).trim())
  if (!m) return 0
  const n = Number(m[1])
  const seconds = m[2] === 's' ? n : m[2] === 'ms' ? n / 1000 : n / 1e6
  return Math.round(seconds * 100) / 100
}

function formatMiB(bytes) {
  return `${(bytes / 1024 ** 2).toFixed(1)}MiB`
}

export { nanoCpusToCpus }
