import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBytes, formatBytes, toDockerBytes, parseCpus, nanoCpusToCpus,
  validateLimits, toSystemdMemory, toSystemdCpuQuota, MIN_MEMORY_BYTES,
} from '../src/util/units.js'

test('parses byte sizes with and without units', () => {
  assert.equal(parseBytes('512m'), 512 * 1024 ** 2)
  assert.equal(parseBytes('2G'), 2 * 1024 ** 3)
  assert.equal(parseBytes('1.5g'), Math.round(1.5 * 1024 ** 3))
  assert.equal(parseBytes('1024'), 1024)
  assert.equal(parseBytes(2048), 2048)
  assert.equal(parseBytes('unlimited'), 0)
  assert.equal(parseBytes(''), null)
})

test('rejects nonsense byte sizes instead of coercing them', () => {
  for (const bad of ['abc', '10x', '-5m', '1 2 3', '1/2g', "512m; rm -rf /"]) {
    assert.throws(() => parseBytes(bad), /byte size|Unknown unit/, `should reject ${bad}`)
  }
})

test('formats and re-serialises byte sizes', () => {
  assert.equal(formatBytes(0), 'unlimited')
  assert.equal(formatBytes(512 * 1024 ** 2), '512MiB')
  assert.equal(formatBytes(1536 * 1024 ** 2), '1.5GiB')
  assert.equal(toDockerBytes(2 * 1024 ** 3), '2g')
  assert.equal(toDockerBytes(512 * 1024 ** 2), '512m')
  assert.equal(toDockerBytes(0), '0')
})

test('parses cpu counts', () => {
  assert.equal(parseCpus('1.5'), 1.5)
  assert.equal(parseCpus(2), 2)
  assert.equal(parseCpus('unlimited'), 0)
  assert.equal(nanoCpusToCpus(1.5e9), 1.5)
  assert.throws(() => parseCpus('two'), /CPU count/)
  assert.throws(() => parseCpus('-1'), /CPU count/)
  assert.throws(() => parseCpus('99999'), /absurd/)
})

test('validateLimits enforces docker rules', () => {
  const ok = validateLimits({ memory: '1g', cpus: '1.5' })
  assert.equal(ok.memory, 1024 ** 3)
  assert.equal(ok.cpus, 1.5)

  assert.throws(() => validateLimits({ memory: '1m' }), /at least/)
  assert.throws(() => validateLimits({ memory: '4g' }, { totalMemoryBytes: 2 * 1024 ** 3 }), /exceeds the host/)
  assert.throws(() => validateLimits({ memory: '1g', memoryReservation: '2g' }), /Reservation/)
  assert.throws(() => validateLimits({ memory: '2g', memorySwap: '1g' }), /combined ceiling/)
  assert.throws(() => validateLimits({}), /Nothing to change/)
  assert.equal(validateLimits({ memory: MIN_MEMORY_BYTES }).memory, MIN_MEMORY_BYTES)
})

test('systemd serialisation', () => {
  assert.equal(toSystemdMemory(0), 'infinity')
  assert.equal(toSystemdMemory(1024 ** 3), String(1024 ** 3))
  assert.equal(toSystemdCpuQuota(0), 'infinity')
  assert.equal(toSystemdCpuQuota(1.5), '150%')
})

test('validation failures are client errors, not server errors', () => {
  for (const fn of [
    () => parseBytes('nonsense'),
    () => parseCpus('nonsense'),
    () => validateLimits({ memory: '1k' }),
  ]) {
    try {
      fn()
      assert.fail('should have thrown')
    } catch (err) {
      assert.equal(err.status, 400, err.message)
    }
  }
})
