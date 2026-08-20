import test from 'node:test'
import assert from 'node:assert/strict'
import { LogStream, parseLine, isEntryStart, filterEntries, facets } from '../public/js/logparse.js'

// Verbatim from a real pm2 stream: pino JSON, a multi-line Prisma error, plain text.
const SAMPLE = `{"level":"info","time":"2026-08-20T20:14:17.581Z","msg":"web-vital","kind":"web-vital","name":"TTFB","value":642.3999999910593,"rating":"good","url":"/offers"}
{"level":"info","time":"2026-08-20T21:13:54.349Z","msg":"web-vital","kind":"web-vital","name":"FCP","value":9028,"rating":"poor","url":"/preview"}
prisma:error 
Invalid \`prisma.store.findUnique()\` invocation:


The column \`Store.translationReview\` does not exist in the current database.
prisma:error 
Invalid \`prisma.platformSetting.findUnique()\` invocation:


The column \`PlatformSetting.aiEnrichMaxImages\` does not exist in the current database.
{"level":"info","time":"2026-08-20T22:06:18.021Z","msg":"web-vital","kind":"web-vital","name":"TTFB","value":312.59999999403954,"rating":"good","url":"/orders"}
`

test('parses pino JSON lines into level, time, message and fields', () => {
  const stream = new LogStream()
  stream.push(SAMPLE)
  const first = stream.entries[0]
  assert.equal(first.level, 'info')
  assert.equal(first.msg, 'web-vital')
  assert.equal(first.kind, 'web-vital')
  assert.equal(first.fields.name, 'TTFB')
  assert.equal(first.fields.rating, 'good')
  assert.equal(first.fields.url, '/offers')
  assert.equal(new Date(first.time).toISOString(), '2026-08-20T20:14:17.581Z')
})

test('a multi-line prisma error becomes ONE error entry, not five text lines', () => {
  const stream = new LogStream()
  stream.push(SAMPLE)
  const errors = stream.entries.filter((e) => e.level === 'error')
  assert.equal(errors.length, 2, 'two prisma errors, each collapsed into one entry')
  assert.equal(errors[0].kind, 'prisma')
  assert.match(errors[0].msg, /Invalid `prisma\.store\.findUnique\(\)` invocation/)
  assert.match(errors[0].detail, /Store\.translationReview.*does not exist/s)
  assert.ok(!errors[0].detail.includes('platformSetting'), 'the next error must not be swallowed into this one')
})

test('the whole sample yields exactly the entries a human would count', () => {
  const stream = new LogStream()
  stream.push(SAMPLE)
  assert.equal(stream.entries.length, 5, '3 json lines + 2 prisma errors')
})

test('partial lines are held back until their newline arrives', () => {
  const stream = new LogStream()
  stream.push('{"level":"info","msg":"half')
  assert.equal(stream.entries.length, 0)
  stream.push('-line"}\n')
  assert.equal(stream.entries.length, 1)
  assert.equal(stream.entries[0].msg, 'half-line')
})

test('pm2 cluster prefixes identify the instance', () => {
  const stream = new LogStream()
  stream.push('0|shop-bui | GET /orders 200 in 41ms\n1|shop-bui | GET / 200 in 12ms\n')
  assert.deepEqual(stream.entries.map((e) => e.instance), [0, 1])
  assert.equal(stream.entries[0].source, 'shop-bui')
  assert.equal(stream.entries[0].msg, 'GET /orders 200 in 41ms')
})

test('docker timestamps and nginx lines are understood', () => {
  const docker = parseLine('2026-08-20T21:14:02.104Z LOG:  database system is ready')
  assert.equal(new Date(docker.time).toISOString(), '2026-08-20T21:14:02.104Z')
  assert.match(docker.msg, /database system is ready/)

  const access = parseLine('203.0.113.10 - - [20/Aug/2026:21:41:02 +0000] "GET /products/42 HTTP/2.0" 200 9120 "-" "Mozilla/5.0"')
  assert.equal(access.kind, 'access')
  assert.equal(access.level, 'info')
  assert.equal(access.fields.status, 200)
  assert.match(access.msg, /GET \/products\/42 → 200/)

  const failing = parseLine('203.0.113.10 - - [20/Aug/2026:21:41:02 +0000] "GET /boom HTTP/2.0" 502 120 "-" "Mozilla/5.0"')
  assert.equal(failing.level, 'error')

  const nginxError = parseLine('2026/08/20 21:38:11 [error] 1071#0: *84213 upstream timed out')
  assert.equal(nginxError.level, 'error')
  assert.equal(nginxError.kind, 'nginx')
})

test('stack traces attach to the error above them', () => {
  const stream = new LogStream()
  stream.push('TypeError: cannot read x of undefined\n    at handler (/srv/app/server.js:42:11)\n    at run (/srv/app/index.js:8:3)\n{"level":"info","msg":"next request"}\n')
  assert.equal(stream.entries.length, 2)
  assert.equal(stream.entries[0].level, 'error')
  assert.match(stream.entries[0].detail, /at handler.*at run/s)
  assert.equal(stream.entries[1].msg, 'next request')
})

test('numeric pino levels are named', () => {
  assert.equal(parseLine('{"level":50,"msg":"boom"}').level, 'error')
  assert.equal(parseLine('{"level":40,"msg":"careful"}').level, 'warn')
  assert.equal(parseLine('{"level":30,"msg":"fyi"}').level, 'info')
})

test('unparseable lines survive as text rather than being dropped', () => {
  const entry = parseLine('{ this is not json after all')
  assert.equal(entry.kind, 'text')
  assert.equal(entry.msg, '{ this is not json after all')
})

test('entry-start detection keeps indented detail out of the entry list', () => {
  assert.equal(isEntryStart('{"level":"info"}'), true)
  assert.equal(isEntryStart('prisma:error '), true)
  assert.equal(isEntryStart('    at handler (x.js:1:1)'), false)
  assert.equal(isEntryStart(''), false)
})

test('filters cut by level, kind, instance and free text', () => {
  const stream = new LogStream()
  stream.push(SAMPLE)
  stream.push('0|shop-bui | GET /orders 200\n')

  assert.equal(filterEntries(stream.entries, { levels: new Set(['error']) }).length, 2)
  assert.equal(filterEntries(stream.entries, { kinds: new Set(['web-vital']) }).length, 3)
  assert.equal(filterEntries(stream.entries, { text: '/preview' }).length, 1)
  assert.equal(filterEntries(stream.entries, { text: 'translationReview' }).length, 1, 'searches the collapsed detail too')
  assert.equal(filterEntries(stream.entries, { instances: new Set(['0']) }).length, 1)
  assert.equal(filterEntries(stream.entries, {}).length, stream.entries.length)
})

test('facets count what the filter chips display', () => {
  const stream = new LogStream()
  stream.push(SAMPLE)
  const { levels, kinds } = facets(stream.entries)
  assert.equal(levels.get('info'), 3)
  assert.equal(levels.get('error'), 2)
  assert.equal(kinds.get('web-vital'), 3)
  assert.equal(kinds.get('prisma'), 2)
})

test('the ring buffer keeps memory bounded', () => {
  const stream = new LogStream({ limit: 10 })
  for (let i = 0; i < 100; i += 1) stream.push(`{"level":"info","msg":"line ${i}"}\n`)
  assert.equal(stream.entries.length, 10)
  assert.equal(stream.entries.at(-1).msg, 'line 99')
})

test('a multi-line error keeps its shape when pm2 prefixes every line', () => {
  const stream = new LogStream()
  stream.push([
    '0|storefro | prisma:error ',
    '0|storefro | Invalid `prisma.store.findUnique()` invocation:',
    '0|storefro | ',
    '0|storefro | The column `Store.translationReview` does not exist in the current database.',
    '0|storefro | {"level":"info","msg":"back to normal"}',
    '',
  ].join('\n'))

  assert.equal(stream.entries.length, 2, 'the prisma block is one entry, then the json line')
  assert.equal(stream.entries[0].level, 'error')
  assert.equal(stream.entries[0].instance, 0)
  assert.match(stream.entries[0].msg, /Invalid `prisma\.store\.findUnique\(\)`/)
  assert.match(stream.entries[0].detail, /translationReview/)
  assert.equal(stream.entries[1].msg, 'back to normal')
})

test('interleaved cluster output does not cross-contaminate blocks', () => {
  const stream = new LogStream()
  // Worker 0 is printing a stack trace while worker 1 keeps serving requests.
  stream.push([
    '0|storefro | TypeError: boom',
    '1|storefro | {"level":"info","msg":"request","url":"/orders"}',
    '0|storefro |     at handler (/srv/app/server.js:42:11)',
    '1|storefro | {"level":"info","msg":"request","url":"/cart"}',
    '0|storefro |     at run (/srv/app/index.js:8:3)',
    '',
  ].join('\n'))

  const error = stream.entries.find((e) => e.level === 'error')
  assert.equal(stream.entries.length, 3, 'one error from #0, two requests from #1')
  assert.equal(error.instance, 0)
  assert.match(error.detail, /at handler/)
  assert.match(error.detail, /at run/)
  assert.ok(!error.detail.includes('/cart'), "worker 1's line must not land in worker 0's trace")
  assert.deepEqual(stream.entries.filter((e) => e.instance === 1).map((e) => e.fields.url), ['/orders', '/cart'])
})

test('lines without a timestamp fall back to arrival time, and say so', () => {
  const stream = new LogStream()
  stream.push('0|storefro | GET /orders 200\n', 1_700_000_000_000)
  assert.equal(stream.entries[0].time, 1_700_000_000_000)
  assert.equal(stream.entries[0].timeSource, 'received')

  stream.push('{"level":"info","time":"2026-08-20T20:14:17.581Z","msg":"has its own"}\n', 1_700_000_000_000)
  const own = stream.entries[1]
  assert.equal(new Date(own.time).toISOString(), '2026-08-20T20:14:17.581Z')
  assert.equal(own.timeSource, undefined, 'a real timestamp is not overwritten')
})
