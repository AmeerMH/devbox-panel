import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, signSession, verifySession, newSession, parseCookies, LoginLimiter } from '../src/auth.js'

// Deliberately weak scrypt parameters so the test suite stays fast.
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 }
const SECRET = 'a'.repeat(32)

test('password round-trip', () => {
  const stored = hashPassword('a long enough password', FAST)
  assert.equal(verifyPassword('a long enough password', stored), true)
  assert.equal(verifyPassword('a long enough passworD', stored), false)
  assert.equal(verifyPassword('', stored), false)
})

test('malformed hashes are rejected, never thrown on', () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'md5$1$8$1$aa$bb', null, undefined, 42]) {
    assert.equal(verifyPassword('x', bad), false)
  }
})

test('each hash gets a fresh salt', () => {
  assert.notEqual(hashPassword('same password here', FAST), hashPassword('same password here', FAST))
})

test('session survives a round-trip and carries a csrf token', () => {
  const { token, payload } = newSession({ secret: SECRET, hours: 1 })
  const back = verifySession(token, SECRET)
  assert.equal(back.sub, 'admin')
  assert.equal(back.csrf, payload.csrf)
  assert.ok(payload.csrf.length >= 20)
})

test('a tampered payload or a wrong secret fails verification', () => {
  const { token } = newSession({ secret: SECRET })
  const [body, mac] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ sub: 'root', exp: Date.now() + 10000 })).toString('base64url')
  assert.equal(verifySession(`${forged}.${mac}`, SECRET), null)
  assert.equal(verifySession(token, 'b'.repeat(32)), null)
  assert.equal(verifySession(`${body}.`, SECRET), null)
  assert.equal(verifySession('garbage', SECRET), null)
})

test('an expired session is refused', () => {
  const expired = signSession({ sub: 'admin', exp: Date.now() - 1, csrf: 'x' }, SECRET)
  assert.equal(verifySession(expired, SECRET), null)
})

test('cookie parsing', () => {
  const c = parseCookies('a=1; devbox_panel_session=abc.def; empty=')
  assert.equal(c.a, '1')
  assert.equal(c.devbox_panel_session, 'abc.def')
  assert.equal(c.empty, '')
  assert.deepEqual(parseCookies(''), {})
})

test('login limiter blocks after N failures and resets on success', () => {
  const limiter = new LoginLimiter({ maxFails: 3, windowMs: 60_000 })
  assert.equal(limiter.blocked('1.2.3.4'), false)
  limiter.fail('1.2.3.4')
  limiter.fail('1.2.3.4')
  assert.equal(limiter.blocked('1.2.3.4'), false)
  limiter.fail('1.2.3.4')
  assert.equal(limiter.blocked('1.2.3.4'), true)
  assert.equal(limiter.blocked('5.6.7.8'), false, 'other clients are unaffected')
  limiter.reset('1.2.3.4')
  assert.equal(limiter.blocked('1.2.3.4'), false)
})

test('the limiter window expires', () => {
  const limiter = new LoginLimiter({ maxFails: 1, windowMs: 1 })
  limiter.fail('9.9.9.9')
  assert.equal(limiter.blocked('9.9.9.9'), true)
  const entry = limiter.hits.get('9.9.9.9')
  entry.first = Date.now() - 10
  assert.equal(limiter.blocked('9.9.9.9'), false)
})
