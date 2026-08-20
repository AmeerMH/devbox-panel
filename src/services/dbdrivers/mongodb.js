import { validateSetting, findTunable } from './common.js'

/**
 * MongoDB. The WiredTiger cache is the memory knob that matters, and it can be
 * resized on a running server through setParameter.
 */
export const mongodb = {
  id: 'mongodb',
  label: 'MongoDB',
  imagePattern: /(^|\/)(mongo|mongodb|percona-server-mongodb)/i,
  processPattern: /^mongod$/,
  unitPattern: /^mongod(b)?\.service$/,
  defaultPort: 27017,

  tunables: [
    { key: 'wiredTigerCacheSize', label: 'WiredTiger cache', kind: 'bytes', apply: 'live', min: 256 * 1024 ** 2, help: 'The document/index cache. Mongo defaults to half the machine\'s RAM minus 1 GB — which is wrong the moment the container has a smaller limit than the host.' },
    { key: 'internalQueryExecMaxBlockingSortBytes', label: 'Max blocking sort', kind: 'bytes', apply: 'live', min: 1024 ** 2, help: 'Memory a sort without an index may use before it fails. Raising it hides a missing index.' },
  ],

  /** mongosh on 5+, the legacy mongo shell before that. */
  async shell(ctx) {
    if (ctx._shell) return ctx._shell
    for (const candidate of ['mongosh', 'mongo']) {
      const res = await ctx.cli([candidate, '--quiet', '--eval', 'quit(0)'])
      if (res.ok) {
        ctx._shell = candidate
        return candidate
      }
    }
    return null
  },

  async evaluate(ctx, expression) {
    const shell = await this.shell(ctx)
    if (!shell) return { ok: false, stdout: '', stderr: 'neither mongosh nor mongo is available in this container' }
    return ctx.cli([shell, '--quiet', '--eval', expression])
  },

  async version(ctx) {
    const res = await this.evaluate(ctx, 'db.version()')
    return res.ok ? String(res.stdout).trim().split('\n').pop().trim() : null
  },

  async settings(ctx) {
    const res = await this.evaluate(ctx, 'JSON.stringify({cache: db.serverStatus().wiredTiger ? db.serverStatus().wiredTiger.cache["maximum bytes configured"] : null, sort: db.adminCommand({getParameter:1, internalQueryExecMaxBlockingSortBytes:1}).internalQueryExecMaxBlockingSortBytes})')
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || '').trim(), values: {} }
    const jsonLine = String(res.stdout).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
    let parsed = {}
    try {
      parsed = JSON.parse(jsonLine || '{}')
    } catch {
      return { ok: false, error: 'could not parse the server status output', values: {} }
    }
    return {
      ok: true,
      values: {
        wiredTigerCacheSize: { raw: parsed.cache ?? null, bytes: parsed.cache ?? null },
        internalQueryExecMaxBlockingSortBytes: { raw: parsed.sort ?? null, bytes: parsed.sort ?? null },
      },
    }
  },

  async apply(ctx, key, rawValue) {
    const tunable = findTunable(this, key)
    const bytes = validateSetting(tunable, rawValue)

    const expression = key === 'wiredTigerCacheSize'
      // WiredTiger takes its cache size in whole megabytes.
      ? `JSON.stringify(db.adminCommand({setParameter:1, wiredTigerEngineRuntimeConfig:"cache_size=${Math.max(256, Math.round(bytes / 1024 ** 2))}M"}))`
      : `JSON.stringify(db.adminCommand({setParameter:1, internalQueryExecMaxBlockingSortBytes:${bytes}}))`

    const res = await this.evaluate(ctx, expression)
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || '').trim() }
    if (!/"ok"\s*:\s*1/.test(res.stdout)) return { ok: false, error: String(res.stdout).trim().slice(0, 300) }

    return {
      ok: true,
      applied: String(bytes),
      needsRestart: false,
      note: key === 'wiredTigerCacheSize'
        ? 'Applied live. Mongo does not persist setParameter — add it to mongod.conf (storage.wiredTiger.engineConfig.cacheSizeGB) to survive a restart.'
        : 'Applied live. Not persisted across a restart.',
    }
  },
}
