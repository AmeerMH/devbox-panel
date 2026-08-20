import { validateSetting, findTunable, firstLine } from './common.js'

/** Redis and Valkey — CONFIG SET is live, CONFIG REWRITE makes it stick. */
export const redis = {
  id: 'redis',
  label: 'Redis / Valkey',
  imagePattern: /(^|\/)(redis|valkey|keydb)/i,
  processPattern: /^(redis-server|valkey-server|keydb-server)$/,
  unitPattern: /^(redis|redis-server|valkey)(@[\w.-]+)?\.service$/,
  defaultPort: 6379,

  tunables: [
    { key: 'maxmemory', label: 'Max memory', kind: 'bytes', apply: 'live', help: 'The ceiling Redis keeps itself under. Leave headroom below the container limit — 0 means no limit, which is how a cache becomes an OOM kill.' },
    { key: 'maxmemory-policy', label: 'Eviction policy', kind: 'enum', apply: 'live', options: ['noeviction', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl'], help: 'What to do at the ceiling. A cache wants allkeys-lru; a datastore wants noeviction (and writes will then fail rather than lose data).' },
    { key: 'appendonly', label: 'Append-only file', kind: 'enum', apply: 'live', options: ['yes', 'no'], help: 'Durability: every write is journalled. Costs disk IO.' },
    { key: 'maxclients', label: 'Max clients', kind: 'int', apply: 'live', min: 1, max: 1000000, help: 'Connection ceiling.' },
    { key: 'timeout', label: 'Idle timeout (s)', kind: 'int', apply: 'live', min: 0, max: 100000, help: 'Close idle client connections after this many seconds. 0 disables.' },
  ],

  /**
   * Redis is nearly always password-protected by a `--requirepass` argument rather
   * than an environment variable, so both are checked. The password is handed to
   * redis-cli through REDISCLI_AUTH, which keeps it out of the argument list (and
   * therefore out of `ps`, the job log and anything the panel returns).
   */
  credentials({ env = {}, cmd = [], entrypoint = [] } = {}) {
    const argv = [...entrypoint, ...cmd]
    const flagIndex = argv.findIndex((a) => a === '--requirepass')
    if (flagIndex !== -1 && argv[flagIndex + 1]) return { password: argv[flagIndex + 1] }

    const inline = argv.find((a) => typeof a === 'string' && a.startsWith('--requirepass='))
    if (inline) return { password: inline.split('=').slice(1).join('=') }

    const fromEnv = env.REDISCLI_AUTH || env.REDIS_PASSWORD || env.REDIS_ARGS?.match(/--requirepass\s+(\S+)/)?.[1]
    return { password: fromEnv || null }
  },

  /** redis-cli exits 0 even when the server refuses, so the text has to be checked. */
  _rejected(res) {
    const text = `${res.stdout || ''}${res.stderr || ''}`
    if (/NOAUTH|WRONGPASS/i.test(text)) {
      return 'this Redis requires a password and the panel could not find one — it looks for --requirepass on the command line and REDIS_PASSWORD/REDISCLI_AUTH in the environment'
    }
    if (/^ERR/im.test(text)) return text.trim().split('\n')[0]
    return null
  },

  async version(ctx) {
    const res = await ctx.cli(['redis-cli', 'INFO', 'server'])
    if (!res.ok || this._rejected(res)) return null
    const m = /redis_version:([^\r\n]+)/.exec(res.stdout) || /valkey_version:([^\r\n]+)/.exec(res.stdout)
    return m ? m[1].trim() : null
  },

  async settings(ctx) {
    const values = {}
    for (const tunable of this.tunables) {
      const res = await ctx.cli(['redis-cli', 'CONFIG', 'GET', tunable.key])
      const rejected = this._rejected(res)
      if (!res.ok || rejected) return { ok: false, error: rejected || (res.stderr || res.stdout || '').trim(), values }
      // CONFIG GET answers with the name on one line and the value on the next.
      const lines = String(res.stdout).split('\n').map((l) => l.trim()).filter(Boolean)
      const raw = lines[1] ?? ''
      values[tunable.key] = {
        raw,
        bytes: tunable.kind === 'bytes' && Number.isFinite(Number(raw)) ? Number(raw) : null,
      }
    }
    return { ok: true, values }
  },

  async apply(ctx, key, rawValue) {
    const tunable = findTunable(this, key)
    const value = validateSetting(tunable, rawValue)

    const res = await ctx.cli(['redis-cli', 'CONFIG', 'SET', key, String(value)])
    const rejected = this._rejected(res)
    if (!res.ok || rejected || /^ERR/i.test(firstLine(res.stdout))) {
      return { ok: false, error: rejected || (res.stderr || res.stdout || '').trim() }
    }

    const rewrite = await ctx.cli(['redis-cli', 'CONFIG', 'REWRITE'])
    const persisted = rewrite.ok && !/^ERR/i.test(firstLine(rewrite.stdout))
    return {
      ok: true,
      applied: String(value),
      needsRestart: false,
      note: persisted
        ? 'Applied and written back to redis.conf.'
        : 'Applied to the running server. This instance has no config file, so the change is lost on restart.',
    }
  },
}
