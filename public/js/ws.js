/**
 * Reconnecting websocket with channel subscriptions.
 * Subscriptions are re-sent after a reconnect, so a panel restart (or a laptop
 * waking up) resumes every open log stream without user action.
 */
export class Sock {
  constructor({ onStatus } = {}) {
    this.handlers = new Map() // channel -> Set<fn>
    this.last = new Map()     // channel -> last snapshot, replayed to late subscribers
    this.ws = null
    this.backoff = 500
    this.onStatus = onStatus || (() => {})
    this.connect()
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws`)

    this.ws.onopen = () => {
      this.backoff = 500
      this.onStatus(true)
      for (const channel of this.handlers.keys()) this.send({ type: 'subscribe', channel })
    }
    this.ws.onclose = () => {
      this.onStatus(false)
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 15000)
    }
    this.ws.onerror = () => this.ws?.close()
    this.ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'snapshot') this.last.set(msg.channel, msg)
      const set = this.handlers.get(msg.channel)
      if (set) for (const fn of set) fn(msg)
    }
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  subscribe(channel, handler) {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
      this.send({ type: 'subscribe', channel })
    }
    set.add(handler)
    // A second subscriber to an already-open channel would otherwise sit blank
    // until the next tick (up to 5s) — replay what we already have.
    const last = this.last.get(channel)
    if (last) queueMicrotask(() => handler(last))
    return () => {
      set.delete(handler)
      if (set.size === 0) {
        this.handlers.delete(channel)
        this.last.delete(channel)
        this.send({ type: 'unsubscribe', channel })
      }
    }
  }
}
