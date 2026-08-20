import crypto from 'node:crypto'

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 }
export const COOKIE_NAME = 'devbox_panel_session'

export function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p })
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, N, r, p, saltB64, keyB64] = parts
  let expected
  try {
    expected = Buffer.from(keyB64, 'base64')
  } catch {
    return false
  }
  let actual
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    })
  } catch {
    return false
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

/* ------------------------------------------------------------------ sessions */

export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
  return payload
}

export function newSession({ secret, hours = 12 }) {
  const csrf = crypto.randomBytes(24).toString('base64url')
  const payload = { sub: 'admin', iat: Date.now(), exp: Date.now() + hours * 3600_000, csrf }
  return { token: signSession(payload, secret), payload }
}

export function parseCookies(header = '') {
  const out = {}
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/* -------------------------------------------------------------- rate limiter */

/**
 * Per-IP failed-login limiter. Deliberately in memory: a restart clearing it is
 * fine, and it keeps the panel dependency-free.
 */
export class LoginLimiter {
  constructor({ maxFails = 5, windowMs = 15 * 60_000 } = {}) {
    this.maxFails = maxFails
    this.windowMs = windowMs
    this.hits = new Map()
  }

  _entry(ip) {
    const now = Date.now()
    const e = this.hits.get(ip)
    if (!e || now - e.first > this.windowMs) {
      const fresh = { count: 0, first: now }
      this.hits.set(ip, fresh)
      return fresh
    }
    return e
  }

  blocked(ip) {
    const e = this._entry(ip)
    return e.count >= this.maxFails
  }

  retryAfterMs(ip) {
    const e = this.hits.get(ip)
    if (!e) return 0
    return Math.max(0, this.windowMs - (Date.now() - e.first))
  }

  fail(ip) {
    const e = this._entry(ip)
    e.count += 1
    return e.count
  }

  reset(ip) {
    this.hits.delete(ip)
  }
}
