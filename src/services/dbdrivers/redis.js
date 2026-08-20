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

  async version(ctx) {
    const res = await ctx.cli(['redis-cli', 'INFO', 'server'])
    if (!res.ok) return null
    const m = /redis_version:([^\r\n]+)/.exec(res.stdout) || /valkey_version:([^\r\n]+)/.exec(res.stdout)
    return m ? m[1].trim() : null
  },

  async settings(ctx) {
    const values = {}
    for (const tunable of this.tunables) {
      const res = await ctx.cli(['redis-cli', 'CONFIG', 'GET', tunable.key])
      if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || '').trim(), values }
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
    if (!res.ok || /^ERR/i.test(firstLine(res.stdout))) {
      return { ok: false, error: (res.stderr || res.stdout || '').trim() }
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
