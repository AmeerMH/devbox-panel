/**
 * Log line parsing, shared by the structured log viewer and its tests.
 *
 * Application logs arriving from pm2, docker or nginx are a mix of formats on the
 * same stream: pino/JSON one-liners, framework text lines, multi-line Prisma or
 * stack-trace blocks, and nginx access/error lines. This module turns all of that
 * into one shape so the UI can filter it, and it is deliberately DOM-free so it
 * can be unit-tested under node.
 */

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

// pm2 prefixes clustered output with `0|app-name  | …` — that is how a line is
// attributed to one instance of a cluster.
const PM2_PREFIX = /^(\d+)\|([\w@.\-/]+)\s*\|\s?/
const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/
const NGINX_ERROR = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\]/
const NGINX_ACCESS = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\w+) ([^"]*?) [^"]*" (\d{3}) (\d+)/
const PM2_HEADER = /last \d+ lines:$/

const PINO_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }
export const LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'fatal', 'other']

/** Lines that open a block: everything after them belongs to them until a new entry starts. */
const OPENERS = [/^prisma:(error|warn)/i, /^[A-Za-z.]*Error:/, /^(Unhandled|Uncaught)/i]

function levelName(value) {
  if (typeof value === 'number') return PINO_LEVELS[value] || 'other'
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (LEVELS.includes(lower)) return lower
    if (lower === 'warning') return 'warn'
    if (lower === 'err') return 'error'
    if (lower === 'log' || lower === 'notice') return 'info'
  }
  return 'other'
}

function toTime(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/**
 * Split off pm2's `0|app | ` prefix. Every line of a multi-line error carries it
 * too, so it has to come off before deciding whether the line starts a new entry.
 */
export function splitPrefix(line) {
  const text = String(line).replace(ANSI, '')
  const m = PM2_PREFIX.exec(text)
  if (!m) return { instance: null, source: null, rest: text }
  return { instance: Number(m[1]), source: m[2], rest: text.slice(m[0].length) }
}

/** Does this line begin a new entry, or continue the previous one? */
export function isEntryStart(line) {
  const text = splitPrefix(line).rest
  if (!text.trim()) return false
  if (/^\s/.test(text)) return false // indented: stack frame, SQL block, YAML-ish detail
  return (
    text.trimStart().startsWith('{') ||
    DOCKER_TS.test(text) ||
    NGINX_ERROR.test(text) ||
    NGINX_ACCESS.test(text) ||
    OPENERS.some((re) => re.test(text))
  )
}

/**
 * Parse one line into an entry. Never throws: an unparseable line becomes a plain
 * text entry, because dropping log lines is worse than showing them unstructured.
 */
export function parseLine(rawLine) {
  const raw = rawLine.replace(/\r$/, '')
  let text = raw.replace(ANSI, '')
  const entry = {
    level: 'info',
    time: null,
    msg: '',
    kind: 'text',
    fields: {},
    source: null,
    instance: null,
    raw,
    open: false,
    detail: '',
    fallback: '',
  }

  const pm2 = PM2_PREFIX.exec(text)
  if (pm2) {
    entry.instance = Number(pm2[1])
    entry.source = pm2[2]
    text = text.slice(pm2[0].length)
  }

  const dockerTs = DOCKER_TS.exec(text)
  if (dockerTs) {
    entry.time = toTime(dockerTs[1])
    text = text.slice(dockerTs[0].length)
  }

  const trimmed = text.trim()

  if (!trimmed) {
    entry.msg = ''
    entry.kind = 'blank'
    return entry
  }

  if (PM2_HEADER.test(trimmed)) {
    entry.kind = 'meta'
    entry.level = 'debug'
    entry.msg = trimmed
    return entry
  }

  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed)
      const { level, time, msg, message, kind, ...rest } = json
      entry.level = levelName(level)
      entry.time = toTime(time) ?? entry.time
      entry.msg = String(msg ?? message ?? '')
      entry.kind = String(kind ?? msg ?? message ?? 'json')
      entry.fields = rest
      return entry
    } catch {
      // Not valid JSON after all — fall through and keep it as text.
    }
  }

  const nginxError = NGINX_ERROR.exec(trimmed)
  if (nginxError) {
    entry.level = levelName(nginxError[2])
    entry.time = toTime(nginxError[1].replace(/\//g, '-').replace(' ', 'T'))
    entry.kind = 'nginx'
    entry.msg = trimmed.slice(nginxError[0].length).replace(/^:\s*/, '').trim()
    return entry
  }

  const access = NGINX_ACCESS.exec(trimmed)
  if (access) {
    const status = Number(access[5])
    entry.level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
    entry.kind = 'access'
    entry.msg = `${access[3]} ${access[4]} → ${status}`
    entry.fields = { client: access[1], status, bytes: Number(access[6]) }
    return entry
  }

  if (/^prisma:error/i.test(trimmed)) {
    entry.level = 'error'
    entry.kind = 'prisma'
    // Prisma prints `prisma:error` on its own line and the actual message on the
    // next one, so the headline is left empty for the first continuation to fill.
    entry.msg = trimmed.replace(/^prisma:error\s*/i, '')
    entry.fallback = 'prisma error'
    entry.open = true
    return entry
  }
  if (/^prisma:(warn|info|query)/i.test(trimmed)) {
    entry.level = /warn/i.test(trimmed) ? 'warn' : 'info'
    entry.kind = 'prisma'
    entry.msg = trimmed.replace(/^prisma:\w+\s*/i, '')
    return entry
  }

  if (OPENERS.some((re) => re.test(trimmed))) {
    entry.level = 'error'
    entry.kind = 'error'
    entry.msg = trimmed
    entry.open = true
    return entry
  }

  // Plain framework output. Pick a level out of the words when one is obvious.
  if (/\b(error|failed|exception)\b/i.test(trimmed)) entry.level = 'error'
  else if (/\b(warn|warning|deprecated)\b/i.test(trimmed)) entry.level = 'warn'
  entry.msg = trimmed
  entry.kind = 'text'
  return entry
}

/**
 * Turns a byte stream into entries, joining multi-line blocks and holding back a
 * partial trailing line until its newline arrives.
 */
export class LogStream {
  constructor({ limit = 5000 } = {}) {
    this.limit = limit
    this.entries = []
    this.partial = ''
    this.seq = 0
    // One open block per pm2 instance: two workers of a cluster interleave their
    // output, so a stack trace from #0 must not attach to a JSON line from #1 that
    // happened to arrive in the middle of it.
    this.openByInstance = new Map()
  }

  push(chunk, now = Date.now()) {
    const added = []
    const text = this.partial + String(chunk)
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''

    for (const line of lines) {
      const { instance, rest } = splitPrefix(line)
      const key = instance === null ? 'main' : instance
      const open = this.openByInstance.get(key)

      if (open && !isEntryStart(line)) {
        const piece = rest.trimEnd()
        // The first non-empty continuation line becomes the headline (Prisma and
        // friends print the marker and the message on separate lines) — it then
        // stays out of the detail block so it is not shown twice.
        if (!open.msg && piece.trim()) {
          open.msg = piece.trim()
          continue
        }
        // Collapse the runs of blank lines Prisma likes to print.
        if (piece.trim() || open.detail.slice(-1) !== '\n') {
          open.detail = open.detail ? `${open.detail}\n${piece}` : piece
        }
        continue
      }

      const entry = parseLine(line)
      if (entry.kind === 'blank') {
        this.openByInstance.delete(key)
        continue
      }
      // Plenty of lines carry no timestamp of their own (pm2 prefixes have none,
      // Prisma prints none). Arrival time is off by at most the stream latency and
      // is far more useful than a row of dashes.
      if (entry.time === null) {
        entry.time = now
        entry.timeSource = 'received'
      }
      entry.seq = this.seq++
      this.entries.push(entry)
      added.push(entry)

      if (entry.open) this.openByInstance.set(key, entry)
      else this.openByInstance.delete(key)
    }

    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    return added
  }

  clear() {
    this.entries = []
    this.partial = ''
  }
}

/** Level + kind + instance + free-text filter. All optional. */
export function filterEntries(entries, { levels, kinds, instances, text } = {}) {
  const needle = (text || '').trim().toLowerCase()
  return entries.filter((entry) => {
    if (levels?.size && !levels.has(entry.level)) return false
    if (kinds?.size && !kinds.has(entry.kind)) return false
    if (instances?.size && !instances.has(entry.instance === null ? 'main' : String(entry.instance))) return false
    if (needle) {
      const haystack = `${entry.msg} ${entry.detail} ${entry.raw} ${JSON.stringify(entry.fields)}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** Counts per level and per kind, for the filter chips. */
export function facets(entries) {
  const levels = new Map()
  const kinds = new Map()
  const instances = new Map()
  for (const entry of entries) {
    levels.set(entry.level, (levels.get(entry.level) || 0) + 1)
    kinds.set(entry.kind, (kinds.get(entry.kind) || 0) + 1)
    const key = entry.instance === null ? 'main' : String(entry.instance)
    instances.set(key, (instances.get(key) || 0) + 1)
  }
  return { levels, kinds, instances }
}
