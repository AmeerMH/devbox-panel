import { validateSetting, findTunable, firstLine } from './common.js'

/**
 * MySQL and MariaDB.
 *
 * The root password is read from the container's own environment and handed to
 * the client through MYSQL_PWD for the duration of one exec — it is never logged,
 * never returned to the browser, and never stored by the panel.
 */
export const mysql = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  imagePattern: /(^|\/)(mysql|mariadb|percona)/i,
  processPattern: /^(mysqld|mariadbd)$/,
  unitPattern: /^(mysql|mysqld|mariadb)\.service$/,
  defaultPort: 3306,

  tunables: [
    { key: 'innodb_buffer_pool_size', label: 'InnoDB buffer pool', kind: 'bytes', apply: 'live', min: 5 * 1024 ** 2, help: 'The one that matters: InnoDB caches data and indexes here. 50-70% of the memory you give this database. Resizing is online but takes a moment.' },
    { key: 'innodb_log_buffer_size', label: 'InnoDB log buffer', kind: 'bytes', apply: 'live', min: 1024 ** 2, help: 'Buffer for transactions before they hit the redo log. Raise it for write-heavy loads with large transactions.' },
    { key: 'max_connections', label: 'Max connections', kind: 'int', apply: 'live', min: 4, max: 100000, help: 'Each connection has its own buffers — this multiplies the per-connection settings below.' },
    { key: 'tmp_table_size', label: 'Temp table size', kind: 'bytes', apply: 'live', help: 'In-memory temporary tables larger than this spill to disk. Keep it equal to max_heap_table_size.' },
    { key: 'max_heap_table_size', label: 'Max heap table size', kind: 'bytes', apply: 'live', help: 'Ceiling for MEMORY tables and in-memory temp tables.' },
    { key: 'sort_buffer_size', label: 'Sort buffer', kind: 'bytes', apply: 'live', help: 'Per connection, per sort. Small is usually right; large values hurt.' },
    { key: 'join_buffer_size', label: 'Join buffer', kind: 'bytes', apply: 'live', help: 'Per connection, for joins without indexes. Fix the index instead where you can.' },
    { key: 'table_open_cache', label: 'Table open cache', kind: 'int', apply: 'live', min: 1, help: 'Open table handles kept around. Raise it when Opened_tables climbs steadily.' },
    { key: 'innodb_io_capacity', label: 'InnoDB IO capacity', kind: 'int', apply: 'live', min: 100, max: 100000, help: 'IOPS the storage can sustain for background flushing. 2000+ on SSD/NVMe.' },
  ],

  credentials(env = {}) {
    const password = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || env.MYSQL_PASSWORD || env.MARIADB_PASSWORD || null
    const user = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD ? 'root' : (env.MYSQL_USER || env.MARIADB_USER || 'root')
    return { user, password }
  },

  async version(ctx) {
    const res = await ctx.sql('SELECT VERSION()')
    return res.ok ? firstLine(res.stdout) : null
  },

  async settings(ctx) {
    const names = this.tunables.map((t) => `'${t.key}'`).join(',')
    const res = await ctx.sql(
      `SELECT CONCAT(VARIABLE_NAME,'|',VARIABLE_VALUE) FROM performance_schema.global_variables WHERE LOWER(VARIABLE_NAME) IN (${names})`,
    )
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || '').trim(), values: {} }

    const values = {}
    for (const line of String(res.stdout).split('\n')) {
      const [name, value] = line.trim().split('|')
      if (!name) continue
      const key = name.toLowerCase()
      const tunable = findTunable(this, key)
      values[key] = {
        raw: value,
        bytes: tunable?.kind === 'bytes' && Number.isFinite(Number(value)) ? Number(value) : null,
      }
    }
    return { ok: true, values }
  },

  async apply(ctx, key, rawValue) {
    const tunable = findTunable(this, key)
    const value = validateSetting(tunable, rawValue)

    // SET PERSIST (MySQL 8+) survives a restart; MariaDB and MySQL 5.7 only have
    // SET GLOBAL, so the change is live but has to be mirrored in my.cnf to stick.
    const persisted = await ctx.sql(`SET PERSIST ${key} = ${value}`)
    if (persisted.ok) return { ok: true, applied: String(value), needsRestart: false, note: 'Applied and persisted (SET PERSIST).' }

    const live = await ctx.sql(`SET GLOBAL ${key} = ${value}`)
    if (!live.ok) return { ok: false, error: (live.stderr || live.stdout || '').trim() }
    return {
      ok: true,
      applied: String(value),
      needsRestart: false,
      note: 'Applied to the running server. This build has no SET PERSIST, so add it to my.cnf to survive a restart.',
    }
  },
}
