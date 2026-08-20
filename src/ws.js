import { WebSocketServer } from 'ws'
import { bus } from './bus.js'
import { sessionFromRequest } from './routes/api.js'

/**
 * One websocket, many channels. The client subscribes to `job:<id>`,
 * `pm2`, `dockerlogs:<name>` … and the server pushes to whoever is listening.
 *
 * Auth is the same session cookie as the REST API: the upgrade is rejected
 * outright when it is missing, so no stream can be opened by an anonymous client.
 */
export function attachWebsocket({ server, cfg, jobs, pollers, streams }) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) {
      socket.destroy()
      return
    }
    const session = sessionFromRequest(req, cfg)
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, session))
  })

  wss.on('connection', (ws) => {
    const subs = new Map() // channel -> unsubscribe fn
    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
    }

    const subscribe = (channel) => {
      if (subs.has(channel)) return
      const off = bus.subscribe(channel, (msg) => send({ ...msg, channel }))
      subs.set(channel, () => {
        off()
        if (pollers.has(channel)) pollers.release(channel)
        else if (streams.handles(channel)) streams.release(channel)
      })

      if (channel.startsWith('job:')) {
        const id = channel.slice(4)
        const job = jobs.get(id)
        if (!job) {
          send({ type: 'error', channel, error: 'Unknown job' })
          return
        }
        send({ type: 'snapshot', channel, chunk: jobs.output(id), job: jobs.toJSON(job) })
        return
      }
      if (pollers.has(channel)) {
        const last = pollers.acquire(channel)
        if (last) send({ type: 'snapshot', channel, payload: last })
        return
      }
      if (streams.handles(channel)) {
        const scrollback = streams.acquire(channel)
        if (scrollback) send({ type: 'snapshot', channel, chunk: scrollback })
        return
      }
      if (channel !== 'jobs') send({ type: 'error', channel, error: `Unknown channel "${channel}"` })
    }

    const unsubscribe = (channel) => {
      const off = subs.get(channel)
      if (!off) return
      off()
      subs.delete(channel)
    }

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'subscribe' && typeof msg.channel === 'string') subscribe(msg.channel)
      else if (msg.type === 'unsubscribe' && typeof msg.channel === 'string') unsubscribe(msg.channel)
      else if (msg.type === 'ping') send({ type: 'pong', t: Date.now() })
    })

    ws.on('close', () => {
      for (const channel of [...subs.keys()]) unsubscribe(channel)
    })

    send({ type: 'hello', t: Date.now() })
  })

  // Drop connections that stopped answering, so their stream refs get released.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate()
        continue
      }
      client.isAlive = false
      client.ping()
    }
  }, 30000)
  heartbeat.unref()
  wss.on('connection', (ws) => {
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
  })

  return wss
}
