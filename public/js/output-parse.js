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

/**
 * True when a line starts a JSON object that has not been closed yet — a logger
 * whose message contains a raw newline (a stack trace, a SQL statement) emits an
 * object spanning several physical lines, and parsing each line alone produces
 * garbage rows starting mid-string.
 */
export function looksIncompleteJson(text) {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return false
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    let depth = 0
    let inString = false
    let escaped = false
    for (const ch of trimmed) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    return depth > 0
  }
}

/** Lines that open a block: everything after them belongs to them until a new entry starts. */
const OPENERS = [
  /^prisma:(error|warn)/i,
  // Next.js prefixes server errors with ⨯ / ✖ before the Error: itself.
  /^[⨯✖✗×!]?\s*[A-Za-z.]*Error:/,
  /^(Unhandled|Uncaught)/i,
  /^[⨯✖✗×]\s/,
]

function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

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
    // Two attempts: as-is (covers pretty-printed objects), then with newlines
    // escaped (covers a message field that embedded a raw stack trace — valid
    // JSON forbids that, but loggers emit it anyway).
    const json = tryJson(trimmed) ?? tryJson(trimmed.replace(/\r?\n/g, '\\n'))
    if (json && typeof json === 'object') {
      const { level, time, msg, message, kind, ...rest } = json
      entry.level = levelName(level)
      entry.time = toTime(time) ?? entry.time
      entry.msg = String(msg ?? message ?? '')

      // Loggers routinely emit a stub message with the real text in a field —
      // `{"msg":"server error: ","message":"…"}`. Left alone, every one of those
      // groups together under the stub, which is exactly the noise grouping is
      // supposed to remove.
      if (!entry.msg || /[:\-]\s*$/.test(entry.msg)) {
        // `message` is destructured above, so it is not in `rest` — check both.
        const sources = [['message', message], ['error', rest.error], ['err', rest.err], ['reason', rest.reason], ['detail', rest.detail]]
        for (const [key, value] of sources) {
          const text = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : null
          if (!text || text === entry.msg) continue
          entry.msg = `${entry.msg.trimEnd()} ${text}`.trim()
          if (key !== 'message') delete rest[key]
          break
        }
      }

      // The `kind` field is meant for grouping; falling back to `msg` only works
      // when the message is short and stable. A paragraph would become a chip.
      const derived = String(kind ?? msg ?? message ?? 'json')
      entry.kind = kind
        ? String(kind).slice(0, 32)
        : (derived.length <= 32 && !derived.includes('\n') ? derived : 'json')
      entry.fields = rest
      return entry
    }
    // Not JSON after all — fall through and keep it as text.
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
    this.lastByInstance = new Map()
    this.pendingJson = new Map()
    // pm2 writes a multi-line record with ONE prefix on its first line, so the
    // lines that follow have to inherit the instance from the line above them.
    this.sawPrefix = false
    this.lastKey = 'main'
  }

  push(chunk, now = Date.now()) {
    const added = []
    const text = this.partial + String(chunk)
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''

    for (const line of lines) {
      const { instance, source, rest } = splitPrefix(line)
      if (instance !== null) {
        this.sawPrefix = true
        this.lastKey = instance
      }
      const key = instance !== null ? instance : (this.sawPrefix ? this.lastKey : 'main')

      // Continue collecting a JSON object that spans physical lines.
      const pending = this.pendingJson.get(key)
      if (pending) {
        pending.text += `\n${rest}`
        pending.raw += `\n${line}`
        pending.lines += 1
        if (!looksIncompleteJson(pending.text) || pending.lines > 60 || pending.text.length > 64_000) {
          this.pendingJson.delete(key)
          const entry = parseLine(pending.text)
          entry.instance = pending.instance
          entry.source = pending.source
          entry.raw = pending.raw
          if (entry.time === null) { entry.time = now; entry.timeSource = 'received' }
          entry.seq = this.seq++
          this.entries.push(entry)
          added.push(entry)
          this.lastByInstance.set(key, entry)
          if (entry.open) this.openByInstance.set(key, entry)
          else this.openByInstance.delete(key)
        }
        continue
      }

      if (looksIncompleteJson(rest)) {
        this.pendingJson.set(key, { text: rest, raw: line, instance, source, lines: 1 })
        continue
      }
      // An indented line is a continuation by universal convention (stack frames,
      // wrapped SQL, YAML) — even when the line above it did not announce a block.
      const indented = /^\s+\S/.test(rest)
      const open = this.openByInstance.get(key) || (indented ? this.lastByInstance.get(key) : null)

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

      this.lastByInstance.set(key, entry)
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

/* ------------------------------------------------------------- grouping */

/**
 * A stable fingerprint for "the same problem happening again".
 *
 * The volatile parts of a log line — ids, hashes, durations, counts, timestamps —
 * are what make 300 copies of one bug look like 300 bugs. They get replaced by
 * placeholders; everything that identifies the failure (the model, the column, the
 * route shape, the message itself) is kept.
 */
export function normalizeMessage(text) {
  return String(text || '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    // cuid / nanoid / build-hash style: a long token mixing letters and digits,
    // which no English word does. Twelve characters is short enough to catch a
    // webpack chunk name (3fas1fb8ivkc7) and long enough to leave prose alone.
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{12,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .replace(/(:\/\/[^/\s]+)?(\/[^\s?]*)/g, (match) => match.replace(/\/\d+\b/g, '/<n>'))
    .replace(/\b\d+(?:\.\d+)?(ms|s|kb|mb|gb|b)?\b/gi, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fingerprint(entry) {
  const head = normalizeMessage(entry.msg || entry.fallback || entry.raw)
  // The first line of a block is what distinguishes two errors that share a
  // headline — `Store.translationReview` from `PlatformSetting.aiEnrichMaxImages`.
  const detailHead = normalizeMessage(String(entry.detail || '').split('\n').find((l) => l.trim()) || '')
  return `${entry.level}|${entry.kind}|${head}|${detailHead}`
}

/**
 * Collapse repeats into one row each, most frequent first. Counts, the time span
 * and which cluster instances were involved are what you actually want to see
 * once the same failure has happened 300 times.
 */
export function groupEntries(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = fingerprint(entry)
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        level: entry.level,
        kind: entry.kind,
        count: 0,
        first: entry.time,
        last: entry.time,
        instances: new Set(),
        sample: entry,
      }
      groups.set(key, group)
    }
    group.count += 1
    group.last = entry.time ?? group.last
    if (entry.time && (!group.first || entry.time < group.first)) group.first = entry.time
    if (entry.instance !== null) group.instances.add(entry.instance)
    // Keep the newest occurrence as the sample: its detail is the freshest.
    group.sample = entry
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (b.last ?? 0) - (a.last ?? 0))
}
