/**
 * Parsing and validation for resource limits.
 *
 * Everything the browser sends for a memory or CPU limit lands here first: these
 * values end up as arguments to `docker update` and `systemctl set-property`, so
 * they are parsed into numbers and re-serialised by us, never passed through.
 */

/** Every rejection here is the caller's mistake, not a server fault — 400, not 500. */
function bad(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

const BYTE_UNITS = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }

/** Docker refuses a memory limit below 6 MiB, so there is no point accepting one. */
export const MIN_MEMORY_BYTES = 6 * 1024 * 1024
export const MAX_CPUS = 1024

export function parseBytes(input) {
  if (input === null || input === undefined || input === '') return null
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw bad(`Not a byte size: ${input}`)
    return Math.round(input)
  }
  const text = String(input).trim().toLowerCase()
  if (text === 'unlimited' || text === 'infinity' || text === '0' || text === 'none') return 0
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]{0,2})$/.exec(text)
  if (!m) throw bad(`Not a byte size: ${input}`)
  const unit = m[2] || 'b'
  if (!(unit in BYTE_UNITS)) throw bad(`Unknown unit "${m[2]}" in ${input}`)
  const bytes = Number(m[1]) * BYTE_UNITS[unit]
  if (!Number.isFinite(bytes) || bytes < 0) throw bad(`Not a byte size: ${input}`)
  return Math.round(bytes)
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null
  if (bytes === 0) return 'unlimited'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded}${units[i]}`
}

/** Docker's own byte suffix form: 512m, 2g. Used when building `docker update` argv. */
export function toDockerBytes(bytes) {
  if (bytes === 0) return '0'
  if (bytes % (1024 ** 3) === 0) return `${bytes / 1024 ** 3}g`
  if (bytes % (1024 ** 2) === 0) return `${bytes / 1024 ** 2}m`
  if (bytes % 1024 === 0) return `${bytes / 1024}k`
  return String(bytes)
}

export function parseCpus(input) {
  if (input === null || input === undefined || input === '') return null
  const text = String(input).trim().toLowerCase()
  if (text === 'unlimited' || text === 'none' || text === '0') return 0
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) throw bad(`Not a CPU count: ${input}`)
  if (value > MAX_CPUS) throw bad(`CPU limit ${value} is absurd (max ${MAX_CPUS})`)
  // Docker stores CPUs as nanoseconds of CPU time per second; 0.01 is its granularity.
  return Math.round(value * 100) / 100
}

export function nanoCpusToCpus(nanoCpus) {
  if (!nanoCpus) return 0
  return Math.round((nanoCpus / 1e9) * 100) / 100
}

export function cpusToNanoCpus(cpus) {
  return Math.round(cpus * 1e9)
}

/**
 * Validate a requested container/service limit set.
 * Returns normalised numbers; throws a user-facing message on anything invalid.
 */
export function validateLimits({ memory, memorySwap, memoryReservation, cpus }, { totalMemoryBytes } = {}) {
  const out = {}

  if (memory !== undefined) {
    const bytes = parseBytes(memory)
    if (bytes !== 0 && bytes < MIN_MEMORY_BYTES) {
      throw bad(`Memory limit must be at least ${formatBytes(MIN_MEMORY_BYTES)} (or "unlimited")`)
    }
    if (totalMemoryBytes && bytes > totalMemoryBytes) {
      throw bad(`Memory limit ${formatBytes(bytes)} exceeds the host's ${formatBytes(totalMemoryBytes)}`)
    }
    out.memory = bytes
  }

  if (memoryReservation !== undefined) {
    const bytes = parseBytes(memoryReservation)
    if (out.memory && bytes > out.memory) {
      throw bad('Reservation (soft limit) cannot be larger than the memory limit')
    }
    out.memoryReservation = bytes
  }

  if (memorySwap !== undefined) {
    const bytes = parseBytes(memorySwap)
    // -1/0 mean unlimited swap; otherwise Docker requires swap >= memory, since the
    // value is the *combined* memory+swap ceiling.
    if (bytes !== 0 && out.memory && bytes < out.memory) {
      throw bad('Memory+swap must be at least the memory limit (it is the combined ceiling)')
    }
    out.memorySwap = bytes
  }

  if (cpus !== undefined) out.cpus = parseCpus(cpus)

  if (!Object.keys(out).length) throw bad('Nothing to change')
  return out
}

/** systemd wants MemoryMax=2G / CPUQuota=150% — or the literal word `infinity`. */
export function toSystemdMemory(bytes) {
  if (!bytes) return 'infinity'
  return `${bytes}`
}

export function toSystemdCpuQuota(cpus) {
  if (!cpus) return 'infinity'
  return `${Math.round(cpus * 100)}%`
}
