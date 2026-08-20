import { EventEmitter } from 'node:events'

/**
 * Channel pub/sub shared by the HTTP layer and the websocket layer.
 * Channels are strings like `job:abc123`, `pm2`, `dockerlogs:api-db`.
 */
class Bus extends EventEmitter {
  publish(channel, message) {
    this.emit(channel, message)
    this.emit('*', channel, message)
  }

  subscribe(channel, handler) {
    this.on(channel, handler)
    return () => this.off(channel, handler)
  }

  subscriberCount(channel) {
    return this.listenerCount(channel)
  }
}

export const bus = new Bus()
bus.setMaxListeners(0)
