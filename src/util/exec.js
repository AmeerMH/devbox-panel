import { spawn } from 'node:child_process'

/**
 * Build the argv for a command, optionally hopping to another OS user.
 *
 * Nothing here ever goes through a shell string: the caller passes an argv array
 * and it stays an argv array, so a project name or a make target can never turn
 * into `; rm -rf /`.
 *
 * `login` runs the command through a login shell so that ~/.profile PATH additions
 * (nvm, ~/.npm-global/bin) are present. The `exec "$0" "$@"` form keeps the argv
 * separation intact — the target string is passed as data, not interpolated.
 */
export function buildArgv({ cmd, args = [], user = null, login = false }) {
  if (user) {
    // The sudo hop is deliberately NOT a shell: /etc/sudoers.d only whitelists
    // specific binaries for it, and `sudo -u other /bin/bash` would be a blank cheque.
    return { file: 'sudo', argv: ['-n', '-u', user, '-H', cmd, ...args] }
  }
  if (login) {
    return { file: '/bin/bash', argv: ['-lc', 'exec "$0" "$@"', cmd, ...args] }
  }
  return { file: cmd, argv: args }
}

/**
 * Spawn a long-running, streamable process in its own process group so the whole
 * tree can be signalled (a `make` recipe spawns npm, which spawns next — killing
 * only the make PID leaves the build running).
 */
export function spawnStream({ cmd, args = [], cwd, user = null, login = false, env = {} }) {
  const { file, argv } = buildArgv({ cmd, args, user, login })
  return spawn(file, argv, {
    cwd,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color', CI: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Run a short command and capture its output. Never throws on a non-zero exit. */
export function run({ cmd, args = [], cwd, user = null, login = false, timeoutMs = 20000, env = {} }) {
  return new Promise((resolve) => {
    const { file, argv } = buildArgv({ cmd, args, user, login })
    let child
    try {
      child = spawn(file, argv, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message), error: err })
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        stderr += `\n[devbox-panel] timed out after ${timeoutMs}ms`
      }
    }, timeoutMs)

    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout, stderr: stderr + String(err.message), error: err })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** JSON-per-line output (docker --format '{{json .}}') into an array. */
export function parseJsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* skip malformed line */ }
  }
  return out
}
