import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JobManager } from '../src/jobs/job-manager.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-panel-test-'))
}

const settle = (job, jm) => new Promise((resolve) => {
  const timer = setInterval(() => {
    const current = jm.get(job.id)
    if (current && current.status !== 'running') {
      clearInterval(timer)
      resolve(current)
    }
  }, 25)
})

test('runs a command, captures output and persists the log', async () => {
  const dir = tmpDir()
  const jm = new JobManager({ dataDir: dir })
  const job = jm.start({ cmd: '/bin/echo', args: ['hello panel'], cwd: os.tmpdir(), title: 'echo' })
  const done = await settle(job, jm)

  assert.equal(done.status, 'done')
  assert.equal(done.exitCode, 0)
  assert.match(jm.output(job.id), /hello panel/)
  assert.match(fs.readFileSync(path.join(dir, 'jobs', `${job.id}.log`), 'utf8'), /hello panel/)
})

test('a non-zero exit is reported as failed', async () => {
  const jm = new JobManager({ dataDir: tmpDir() })
  const job = jm.start({ cmd: '/bin/sh', args: ['-c', 'exit 3'], cwd: os.tmpdir(), title: 'fail' })
  const done = await settle(job, jm)
  assert.equal(done.status, 'failed')
  assert.equal(done.exitCode, 3)
})

test('a missing binary fails instead of crashing the manager', async () => {
  const jm = new JobManager({ dataDir: tmpDir() })
  const job = jm.start({ cmd: '/definitely/not/here', args: [], cwd: os.tmpdir(), title: 'enoent' })
  const done = await settle(job, jm)
  assert.equal(done.status, 'failed')
  assert.match(jm.output(job.id), /process error/)
})

test('cancel kills the whole process group', async () => {
  const jm = new JobManager({ dataDir: tmpDir(), killGraceMs: 200 })
  // sh spawns a child sleep: killing only the sh pid would leave the sleep behind.
  const job = jm.start({ cmd: '/bin/sh', args: ['-c', 'sleep 30 & wait'], cwd: os.tmpdir(), title: 'sleeper' })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(jm.cancel(job.id).ok, true)
  const done = await settle(job, jm)
  assert.equal(done.status, 'cancelled')
  assert.equal(jm.cancel(job.id).ok, false, 'cancelling twice is a no-op')
})

test('the concurrency cap is enforced', async () => {
  const jm = new JobManager({ dataDir: tmpDir(), maxConcurrent: 1 })
  const first = jm.start({ cmd: '/bin/sh', args: ['-c', 'sleep 2'], cwd: os.tmpdir(), title: 'one' })
  assert.throws(() => jm.start({ cmd: '/bin/echo', args: ['x'], cwd: os.tmpdir(), title: 'two' }), /Too many jobs/)
  jm.cancel(first.id)
  await settle(first, jm)
})

test('the same project+target cannot be started twice', async () => {
  const jm = new JobManager({ dataDir: tmpDir() })
  const job = jm.start({ cmd: '/bin/sh', args: ['-c', 'sleep 2'], cwd: os.tmpdir(), projectId: 'p1', target: 'deploy', title: 'deploy' })
  assert.equal(jm.isRunning('p1', 'deploy'), true)
  assert.equal(jm.isRunning('p1', 'build'), false)
  assert.equal(jm.isRunning('p2', 'deploy'), false)
  jm.cancel(job.id)
  await settle(job, jm)
  assert.equal(jm.isRunning('p1', 'deploy'), false)
})

test('history is capped and trimmed logs are deleted', async () => {
  const dir = tmpDir()
  const jm = new JobManager({ dataDir: dir, historyLimit: 3 })
  for (let i = 0; i < 5; i += 1) {
    const job = jm.start({ cmd: '/bin/echo', args: [`run ${i}`], cwd: os.tmpdir(), title: `echo ${i}` })
    await settle(job, jm)
  }
  assert.equal(jm.list().length, 3)
  assert.equal(fs.readdirSync(path.join(dir, 'jobs')).filter((f) => f.endsWith('.log')).length, 3)
})

test('jobs left running by a restart come back as orphaned, not running', async () => {
  const dir = tmpDir()
  const first = new JobManager({ dataDir: dir })
  const job = first.start({ cmd: '/bin/sh', args: ['-c', 'sleep 5'], cwd: os.tmpdir(), title: 'survivor' })

  const restarted = new JobManager({ dataDir: dir })
  assert.equal(restarted.get(job.id).status, 'orphaned')
  assert.match(restarted.output(job.id), /sleep 5/, 'the log file is still readable after a restart')

  first.cancel(job.id)
  await settle(job, first)
})
