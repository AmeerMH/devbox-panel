import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { spawnStream } from '../util/exec.js'
import { bus } from '../bus.js'

const RUNNING = 'running'
const DONE = 'done'
const FAILED = 'failed'
const CANCELLED = 'cancelled'
const ORPHANED = 'orphaned'

export const JOB_STATUS = { RUNNING, DONE, FAILED, CANCELLED, ORPHANED }

function newId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

/**
 * Runs and tracks every command the panel launches: make targets, git fetches,
 * nginx reloads. One place so the UI has a single "Runs" list and every command
 * gets the same streaming, cancellation and log-persistence treatment.
 */
export class JobManager {
  constructor({ dataDir, maxConcurrent = 6, bufferBytes = 512 * 1024, historyLimit = 200, killGraceMs = 8000 }) {
    this.dir = path.join(dataDir, 'jobs')
    this.maxConcurrent = maxConcurrent
    this.bufferBytes = bufferBytes
    this.historyLimit = historyLimit
    this.killGraceMs = killGraceMs
    this.jobs = new Map()
    fs.mkdirSync(this.dir, { recursive: true })
    this._loadHistory()
  }

  /* ------------------------------------------------------------- persistence */

  get indexFile() {
    return path.join(this.dir, 'index.json')
  }

  _loadHistory() {
    let saved = []
    try {
      saved = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
    } catch {
      saved = []
    }
    for (const meta of saved) {
      // The panel restarting (a self-deploy, a reboot) leaves jobs that were mid-flight.
      // The child survives — it is detached — but we can no longer stream it, so say so
      // instead of showing a permanently spinning row.
      if (meta.status === RUNNING) meta.status = ORPHANED
      this.jobs.set(meta.id, { ...meta, buffer: null, child: null })
    }
  }

  _saveHistory() {
    const metas = [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, this.historyLimit)
      .map((j) => this.toJSON(j))
    // Anything trimmed off the index loses its log file too, otherwise the disk grows forever.
    const keep = new Set(metas.map((m) => m.id))
    for (const id of [...this.jobs.keys()]) if (!keep.has(id)) this.jobs.delete(id)
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(metas, null, 2))
      for (const file of fs.readdirSync(this.dir)) {
        if (!file.endsWith('.log')) continue
        if (!keep.has(file.replace(/\.log$/, ''))) fs.unlinkSync(path.join(this.dir, file))
      }
    } catch { /* history is best-effort; never break a running job over it */ }
  }

  /* -------------------------------------------------------------- accessors */

  toJSON(job) {
    return {
      id: job.id,
      kind: job.kind,
      title: job.title,
      projectId: job.projectId ?? null,
      target: job.target ?? null,
      cwd: job.cwd ?? null,
      user: job.user ?? null,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode ?? null,
      startedAt: job.startedAt,
      endedAt: job.endedAt ?? null,
      bytes: job.bytes ?? 0,
      truncated: !!job.truncated,
    }
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((j) => this.toJSON(j))
  }

  get(id) {
    return this.jobs.get(id) || null
  }

  runningCount() {
    return [...this.jobs.values()].filter((j) => j.status === RUNNING).length
  }

  isRunning(projectId, target) {
    return [...this.jobs.values()].some(
      (j) => j.status === RUNNING && j.projectId === projectId && j.target === target,
    )
  }

  /** Buffered output for a late subscriber (the tail, capped at bufferBytes). */
  output(id) {
    const job = this.jobs.get(id)
    if (!job) return null
    if (job.buffer != null) return job.buffer
    try {
      const file = path.join(this.dir, `${id}.log`)
      const stat = fs.statSync(file)
      const start = Math.max(0, stat.size - this.bufferBytes)
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      return (start > 0 ? '…[earlier output truncated]…\n' : '') + buf.toString('utf8')
    } catch {
      return ''
    }
  }

  /* ------------------------------------------------------------------ start */

  start({ kind = 'command', title, projectId = null, target = null, cmd, args = [], cwd, user = null, login = false, env = {} }) {
    if (this.runningCount() >= this.maxConcurrent) {
      const err = new Error(`Too many jobs running (${this.maxConcurrent}). Wait for one to finish or cancel it.`)
      err.status = 429
      throw err
    }

    const id = newId()
    const job = {
      id,
      kind,
      title: title || `${cmd} ${args.join(' ')}`.trim(),
      projectId,
      target,
      cwd,
      user,
      command: [cmd, ...args].join(' '),
      status: RUNNING,
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      bytes: 0,
      truncated: false,
      buffer: '',
      child: null,
    }
    this.jobs.set(id, job)

    // Synchronous appends on purpose: a buffered WriteStream can leave the tail of
    // a build unwritten if the panel is restarted mid-job, and the file does not
    // even exist until the first flush — which makes "download log" a 404 race.
    const logFile = path.join(this.dir, `${id}.log`)
    const fd = fs.openSync(logFile, 'a')
    job.fd = fd
    const writeLog = (text) => {
      try { fs.writeSync(fd, text) } catch { /* disk full / fd closed — keep the job alive */ }
    }
    const header = `$ ${user ? `sudo -u ${user} ` : ''}${job.command}\n  cwd: ${cwd}\n\n`
    writeLog(header)
    job.buffer += header

    let child
    try {
      child = spawnStream({ cmd, args, cwd, user, login, env })
    } catch (err) {
      this._finish(job, -1, FAILED, `spawn failed: ${err.message}\n`, writeLog)
      return this.toJSON(job)
    }
    job.child = child
    job.pid = child.pid

    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
    const onChunk = (stream) => (chunk) => {
      const text = decoders[stream].write(chunk)
      if (!text) return
      job.bytes += Buffer.byteLength(text)
      writeLog(text)
      job.buffer += text
      if (job.buffer.length > this.bufferBytes) {
        job.buffer = job.buffer.slice(job.buffer.length - this.bufferBytes)
        job.truncated = true
      }
      bus.publish(`job:${id}`, { type: 'data', jobId: id, stream, chunk: text })
    }
    child.stdout.on('data', onChunk('out'))
    child.stderr.on('data', onChunk('err'))

    child.on('error', (err) => {
      const text = `\n[devbox-panel] process error: ${err.message}\n`
      this._finish(job, -1, FAILED, text, writeLog)
    })
    child.on('close', (code, signal) => {
      if (job.status !== RUNNING) return
      const status = job.cancelling ? CANCELLED : code === 0 ? DONE : FAILED
      const text = `\n[devbox-panel] ${status} — exit ${code ?? 'null'}${signal ? ` (${signal})` : ''} after ${((Date.now() - job.startedAt) / 1000).toFixed(1)}s\n`
      this._finish(job, code, status, text, writeLog)
    })

    bus.publish('jobs', { type: 'job', job: this.toJSON(job) })
    this._saveHistory()
    return this.toJSON(job)
  }

  _finish(job, code, status, tailText, writeLog) {
    job.status = status
    job.exitCode = code
    job.endedAt = Date.now()
    job.child = null
    if (tailText) {
      job.buffer += tailText
      writeLog(tailText)
      bus.publish(`job:${job.id}`, { type: 'data', jobId: job.id, stream: 'meta', chunk: tailText })
    }
    if (job.fd !== undefined) {
      try { fs.closeSync(job.fd) } catch { /* already closed */ }
      job.fd = undefined
    }
    bus.publish(`job:${job.id}`, { type: 'end', jobId: job.id, job: this.toJSON(job) })
    bus.publish('jobs', { type: 'job', job: this.toJSON(job) })
    this._saveHistory()
  }

  /* ----------------------------------------------------------------- cancel */

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) return { ok: false, error: 'No such job' }
    if (job.status !== RUNNING || !job.child) return { ok: false, error: `Job is ${job.status}` }

    job.cancelling = true
    const pid = job.child.pid
    // Negative pid = the whole process group. `make` spawns npm spawns next; killing
    // just the make PID would orphan the build and leave the port held.
    try { process.kill(-pid, 'SIGTERM') } catch { try { job.child.kill('SIGTERM') } catch { /* gone */ } }
    bus.publish(`job:${id}`, { type: 'data', jobId: id, stream: 'meta', chunk: '\n[devbox-panel] SIGTERM sent…\n' })

    setTimeout(() => {
      if (job.status !== RUNNING) return
      try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
      bus.publish(`job:${id}`, { type: 'data', jobId: id, stream: 'meta', chunk: '[devbox-panel] SIGKILL sent\n' })
    }, this.killGraceMs).unref()

    return { ok: true }
  }
}
