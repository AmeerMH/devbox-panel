import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSetting, findTunable } from '../src/services/dbdrivers/common.js'
import { postgres } from '../src/services/dbdrivers/postgres.js'
import { redis } from '../src/services/dbdrivers/redis.js'
import { mongodb } from '../src/services/dbdrivers/mongodb.js'
import { mysql } from '../src/services/dbdrivers/mysql.js'
import { engineForImage, driverForImage, driverForUnit } from '../src/services/dbdrivers/index.js'

test('images are matched to the right engine', () => {
  assert.equal(driverForImage('pgvector/pgvector:pg16')?.id, 'postgres')
  assert.equal(driverForImage('postgres:17-alpine')?.id, 'postgres')
  assert.equal(driverForImage('mariadb:11')?.id, 'mysql')
  assert.equal(driverForImage('redis:7-alpine')?.id, 'redis')
  assert.equal(driverForImage('valkey/valkey:8')?.id, 'redis')
  assert.equal(driverForImage('mongo:7')?.id, 'mongodb')
  assert.equal(driverForImage('nginx:1.27'), null)
})

test('engines without a driver are still recognised, marked untunable', () => {
  const opensearch = engineForImage('opensearchproject/opensearch:2')
  assert.equal(opensearch.id, 'elasticsearch')
  assert.equal(opensearch.tunable, false)
  assert.equal(engineForImage('clickhouse/clickhouse-server:24').tunable, false)
  assert.equal(engineForImage('pgvector/pgvector:pg16').tunable, true)
  assert.equal(engineForImage('node:22'), null)
})

test('host units are matched too', () => {
  assert.equal(driverForUnit('postgresql@16-main.service')?.id, 'postgres')
  assert.equal(driverForUnit('mariadb.service')?.id, 'mysql')
  assert.equal(driverForUnit('redis-server.service')?.id, 'redis')
  assert.equal(driverForUnit('nginx.service'), null)
})

test('setting values are validated per tunable kind', () => {
  const workMem = findTunable(postgres, 'work_mem')
  assert.equal(validateSetting(workMem, '16m'), 16 * 1024 ** 2)
  assert.throws(() => validateSetting(workMem, 'plenty'), /byte size/)
  assert.throws(() => validateSetting(workMem, '1'), /at least/)

  const maxConn = findTunable(postgres, 'max_connections')
  assert.equal(validateSetting(maxConn, '200'), 200)
  assert.throws(() => validateSetting(maxConn, '1.5'), /whole number/)
  assert.throws(() => validateSetting(maxConn, '2'), /at least/)

  const policy = findTunable(redis, 'maxmemory-policy')
  assert.equal(validateSetting(policy, 'allkeys-lru'), 'allkeys-lru')
  assert.throws(() => validateSetting(policy, 'drop-everything'), /must be one of/)

  const target = findTunable(postgres, 'checkpoint_completion_target')
  assert.equal(validateSetting(target, '0.9'), 0.9)
  assert.throws(() => validateSetting(target, '3'), /at most/)
})

test('an unknown setting key is refused before any engine call', () => {
  assert.equal(findTunable(postgres, 'archive_command'), null)
  assert.throws(() => validateSetting(null, 'anything'), /Unknown setting/)
})

/** A driver must never interpolate the raw request value into its command. */
test('postgres re-serialises the value it was given', async () => {
  const sent = []
  const ctx = { sql: async (q) => { sent.push(q); return { ok: true, stdout: 't', stderr: '' } } }
  const result = await postgres.apply(ctx, 'work_mem', '16m')
  assert.equal(result.ok, true)
  assert.equal(result.applied, '16MB')
  assert.match(sent[0], /^ALTER SYSTEM SET work_mem = '16MB'$/)

  await assert.rejects(() => postgres.apply(ctx, 'work_mem', "16m'; DROP DATABASE x; --"), /byte size/)
})

test('redis applies then persists, and reports when it could not persist', async () => {
  const calls = []
  const ctx = {
    cli: async (args) => {
      calls.push(args.join(' '))
      if (args.includes('REWRITE')) return { ok: true, stdout: 'ERR The server is running without a config file', stderr: '' }
      return { ok: true, stdout: 'OK', stderr: '' }
    },
  }
  const result = await redis.apply(ctx, 'maxmemory', '256m')
  assert.equal(result.applied, String(256 * 1024 ** 2))
  assert.match(result.note, /lost on restart/)
  assert.deepEqual(calls, ['redis-cli CONFIG SET maxmemory 268435456', 'redis-cli CONFIG REWRITE'])
})

test('mongo converts the cache size to whole megabytes', async () => {
  const seen = []
  const ctx = {
    cli: async (args) => {
      seen.push(args.join(' '))
      return { ok: true, stdout: '{"ok":1}', stderr: '' }
    },
    _shell: 'mongosh',
  }
  const result = await mongodb.apply(ctx, 'wiredTigerCacheSize', '2g')
  assert.equal(result.ok, true)
  assert.match(seen.join('\n'), /cache_size=2048M/)
})

test('mysql falls back to SET GLOBAL when SET PERSIST is unsupported', async () => {
  const tried = []
  const ctx = {
    sql: async (q) => {
      tried.push(q)
      return q.startsWith('SET PERSIST') ? { ok: false, stdout: '', stderr: 'You have an error in your SQL syntax' } : { ok: true, stdout: '', stderr: '' }
    },
  }
  const result = await mysql.apply(ctx, 'max_connections', '250')
  assert.equal(result.ok, true)
  assert.match(result.note, /my\.cnf/)
  assert.deepEqual(tried, ['SET PERSIST max_connections = 250', 'SET GLOBAL max_connections = 250'])
})
