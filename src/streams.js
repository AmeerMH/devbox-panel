import { StringDecoder } from 'node:string_decoder'
import { spawnStream } from './util/exec.js'
import { bus } from './bus.js'

/**
 * Channels that publish a periodic snapshot (pm2 list, docker list, host vitals).
 *
 * Ref-counted: the `docker ps` / `pm2 jlist` processes only run while somebody is
 * actually looking at that tab, so an idle panel costs nothing.
 */
export class PollerHub {
  constructor() {
    this.pollers = new Map()
  }

  register(channel, intervalMs, produce) {
    this.pollers.set(channel, { intervalMs, produce, timer: null, refs: 0, last: null })
  }

  has(channel) {
    return this.pollers.has(channel)
  }

  async _tick(channel) {
    const p = this.pollers.get(channel)
    if (!p) return
    try {
      const payload = await p.produce()
      p.last = payload
      bus.publish(channel, { type: 'snapshot', channel, payload })
    } catch (err) {
      bus.publish(channel, { type: 'error', channel, error: err.message })
    }
  }

  acquire(channel) {
    const p = this.pollers.get(channel)
    if (!p) return null
    p.refs += 1
    if (p.refs === 1) {
      this._tick(channel)
      p.timer = setInterval(() => this._tick(channel), p.intervalMs)
      p.timer.unref()
    }
    return p.last
  }

  release(channel) {
    const p = this.pollers.get(channel)
    if (!p) return
    p.refs = Math.max(0, p.refs - 1)
    if (p.refs === 0 && p.timer) {
      clearInterval(p.timer)
      p.timer = null
    }
  }
}

/**
 * Channels backed by a long-running follow process (`docker logs -f`,
 * `pm2 logs`, `tail -F` on an nginx log).
 *
 * One process per channel no matter how many browsers watch it, killed when the
 * last one leaves — otherwise every reopened tab leaks a `tail -F`.
 */
export class ProcessStreamHub {
  constructor({ scrollbackBytes = 256 * 1024 } = {}) {
    this.streams = new Map()
    this.scrollbackBytes = scrollbackBytes
    this.factories = new Map()
  }

  /** factory(channelArg) -> { cmd, args, cwd?, user?, env? } */
  registerPrefix(prefix, factory) {
    this.factories.set(prefix, factory)
  }

  _resolve(channel) {
    const idx = channel.indexOf(':')
    if (idx === -1) return null
    const prefix = channel.slice(0, idx)
    const arg = channel.slice(idx + 1)
    const factory = this.factories.get(prefix)
    return factory ? { factory, arg } : null
  }

  handles(channel) {
    return !!this._resolve(channel)
  }

  acquire(channel) {
    const resolved = this._resolve(channel)
    if (!resolved) return null

    let s = this.streams.get(channel)
    if (s) {
      s.refs += 1
      return s.buffer
    }

    let spec
    try {
      spec = resolved.factory(resolved.arg)
    } catch (err) {
      bus.publish(channel, { type: 'error', channel, error: err.message })
      return null
    }

    let child
    try {
      child = spawnStream({ ...spec, cwd: spec.cwd || process.cwd() })
    } catch (err) {
      bus.publish(channel, { type: 'error', channel, error: `cannot start stream: ${err.message}` })
      return null
    }

    s = { child, refs: 1, buffer: '' }
    this.streams.set(channel, s)

    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
    const push = (stream) => (chunk) => {
      const text = decoders[stream].write(chunk)
      if (!text) return
      s.buffer += text
      if (s.buffer.length > this.scrollbackBytes) s.buffer = s.buffer.slice(s.buffer.length - this.scrollbackBytes)
      bus.publish(channel, { type: 'data', channel, chunk: text })
    }
    child.stdout.on('data', push('out'))
    child.stderr.on('data', push('err'))
    child.on('error', (err) => bus.publish(channel, { type: 'error', channel, error: err.message }))
    child.on('close', (code) => {
      bus.publish(channel, { type: 'data', channel, chunk: `\n[devbox-panel] stream ended (exit ${code})\n` })
      this.streams.delete(channel)
    })

    return ''
  }

  release(channel) {
    const s = this.streams.get(channel)
    if (!s) return
    s.refs -= 1
    if (s.refs > 0) return
    this.streams.delete(channel)
    const pid = s.child?.pid
    if (!pid) return
    try { process.kill(-pid, 'SIGTERM') } catch { try { s.child.kill('SIGTERM') } catch { /* gone */ } }
  }

  closeAll() {
    for (const channel of [...this.streams.keys()]) {
      const s = this.streams.get(channel)
      if (s) { s.refs = 1; this.release(channel) }
    }
  }
}
