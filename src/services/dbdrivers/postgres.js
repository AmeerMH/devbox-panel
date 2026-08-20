import { validateSetting, findTunable, bytesToMegabyteString, firstLine } from './common.js'

const RESTART_NOTE = 'takes effect after a restart'

/**
 * PostgreSQL (including pgvector/TimescaleDB images).
 *
 * Settings are written with ALTER SYSTEM, which lands in postgresql.auto.conf —
 * so a change survives a restart and can be undone from the same place, unlike
 * editing the packaged postgresql.conf.
 */
export const postgres = {
  id: 'postgres',
  label: 'PostgreSQL',
  imagePattern: /(^|\/)(postgres|pgvector|timescale|postgis|supabase\/postgres)/i,
  processPattern: /^postgres(ql)?$/,
  unitPattern: /^postgresql(@[\w.-]+)?\.service$/,
  defaultPort: 5432,

  tunables: [
    { key: 'shared_buffers', label: 'Shared buffers', kind: 'bytes', apply: 'restart', min: 128 * 1024, help: `The engine's own page cache. Rule of thumb: 25% of the memory you give this database. ${RESTART_NOTE}.` },
    { key: 'effective_cache_size', label: 'Effective cache size', kind: 'bytes', apply: 'live', help: 'A hint, not an allocation: roughly what the planner may assume is cached, typically 50-75% of the memory available to this database.' },
    { key: 'work_mem', label: 'Work memory', kind: 'bytes', apply: 'live', min: 64 * 1024, help: 'Per sort/hash operation, per connection — a busy query can use several. Raise carefully: this multiplies.' },
    { key: 'maintenance_work_mem', label: 'Maintenance work memory', kind: 'bytes', apply: 'live', min: 1024 * 1024, help: 'Used by VACUUM, CREATE INDEX and ALTER TABLE. Bigger makes those much faster.' },
    { key: 'autovacuum_work_mem', label: 'Autovacuum work memory', kind: 'bytes', apply: 'live', help: 'Per autovacuum worker; -1 means "use maintenance_work_mem".' },
    { key: 'max_connections', label: 'Max connections', kind: 'int', apply: 'restart', min: 4, max: 10000, help: `Each connection costs memory. Prefer a pooler over a big number here. ${RESTART_NOTE}.` },
    { key: 'temp_buffers', label: 'Temp buffers', kind: 'bytes', apply: 'live', help: 'Per session, for temporary tables.' },
    { key: 'wal_buffers', label: 'WAL buffers', kind: 'bytes', apply: 'restart', help: `Write-ahead log buffer. ${RESTART_NOTE}.` },
    { key: 'max_wal_size', label: 'Max WAL size', kind: 'bytes', apply: 'live', help: 'How much WAL may accumulate between checkpoints. Larger means fewer, bigger checkpoints.' },
    { key: 'checkpoint_completion_target', label: 'Checkpoint completion target', kind: 'float', apply: 'live', min: 0, max: 1, help: 'Spread checkpoint writes over this fraction of the interval. 0.9 is the modern default.' },
    { key: 'random_page_cost', label: 'Random page cost', kind: 'float', apply: 'live', min: 0.1, max: 100, help: 'Lower it (1.1) on SSDs so the planner stops avoiding index scans.' },
    { key: 'effective_io_concurrency', label: 'Effective IO concurrency', kind: 'int', apply: 'live', min: 0, max: 1000, help: 'Concurrent random reads the storage can serve. 200 for SSD/NVMe, 1-2 for spinning disks.' },
  ],

  async version(ctx) {
    const res = await ctx.sql('SHOW server_version')
    return res.ok ? firstLine(res.stdout) : null
  },

  async settings(ctx) {
    const keys = this.tunables.map((t) => `'${t.key}'`).join(',')
    // pg_settings reports the value in `unit`s (8kB pages for shared_buffers, kB for
    // work_mem …), so the numbers are normalised to bytes here rather than in the UI.
    const res = await ctx.sql(
      `SELECT name || '|' || setting || '|' || COALESCE(unit,'') || '|' || source FROM pg_settings WHERE name IN (${keys})`,
    )
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || '').trim(), values: {} }

    const values = {}
    for (const line of String(res.stdout).split('\n')) {
      const [name, setting, unit, source] = line.trim().split('|')
      if (!name) continue
      values[name] = { raw: setting, unit: unit || null, source, bytes: toBytes(setting, unit) }
    }
    return { ok: true, values }
  },

  async apply(ctx, key, rawValue) {
    const tunable = findTunable(this, key)
    const value = validateSetting(tunable, rawValue)
    const literal = tunable.kind === 'bytes' ? bytesToMegabyteString(value) : String(value)

    // The key came from our own tunables list and the value is a number or an
    // enum member we re-serialised, so this cannot carry anything else in.
    const res = await ctx.sql(`ALTER SYSTEM SET ${key} = '${literal}'`)
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || '').trim() }

    const reload = await ctx.sql('SELECT pg_reload_conf()')
    return {
      ok: true,
      applied: literal,
      needsRestart: tunable.apply === 'restart',
      note: tunable.apply === 'restart'
        ? 'Written to postgresql.auto.conf — restart the database for it to take effect.'
        : reload.ok ? 'Applied and reloaded.' : 'Written, but the reload failed — restart to pick it up.',
    }
  },
}

function toBytes(setting, unit) {
  const n = Number(setting)
  if (!Number.isFinite(n)) return null
  switch (unit) {
    case '8kB': return n * 8 * 1024
    case 'kB': return n * 1024
    case 'MB': return n * 1024 ** 2
    case 'GB': return n * 1024 ** 3
    case 'B': return n
    default: return null
  }
}
