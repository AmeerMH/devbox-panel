import os from 'node:os'
import fs from 'node:fs'
import { run } from '../util/exec.js'

/** Host vitals: load, memory, disks, listening ports, and who the panel runs as. */
export class SystemService {
  constructor(cfg, { version }) {
    this.cfg = cfg
    this.version = version
  }

  async snapshot() {
    const [disk, ports] = await Promise.all([this.disks(), this.ports()])
    const mem = await this.memory()
    return {
      host: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSec: os.uptime(),
      load: os.loadavg(),
      cpus: os.cpus().length,
      memory: mem,
      disks: disk,
      ports,
      panel: {
        version: this.version,
        pid: process.pid,
        node: process.version,
        user: os.userInfo().username,
        uptimeSec: Math.round(process.uptime()),
        rssBytes: process.memoryUsage().rss,
        dataDir: this.cfg.dataDir,
        configPath: this.cfg.configPath,
      },
    }
  }

  /** os.freemem() counts page cache as used on Linux; /proc/meminfo MemAvailable is the honest number. */
  async memory() {
    const total = os.totalmem()
    let available = os.freemem()
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
      const m = /MemAvailable:\s+(\d+) kB/.exec(meminfo)
      if (m) available = Number(m[1]) * 1024
    } catch { /* not Linux — os.freemem() will do */ }
    return { total, available, used: total - available }
  }

  async disks() {
    const res = await run({ cmd: 'df', args: ['-PB1'], timeoutMs: 8000 })
    if (!res.ok) return []
    return res.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 6 && /^\/dev\//.test(p[0]))
      .map((p) => ({ device: p[0], total: Number(p[1]), used: Number(p[2]), available: Number(p[3]), mount: p[5] }))
  }

  async ports() {
    const res = await run({ cmd: 'ss', args: ['-tlnH'], timeoutMs: 8000 })
    if (!res.ok) return []
    const seen = new Set()
    const out = []
    for (const line of res.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4) continue
      const local = cols[3]
      const port = Number(local.split(':').pop())
      if (!port || seen.has(`${local}`)) continue
      seen.add(local)
      out.push({ address: local, port })
    }
    return out.sort((a, b) => a.port - b.port)
  }
}
