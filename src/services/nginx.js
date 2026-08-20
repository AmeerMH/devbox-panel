import { run } from '../util/exec.js'

const NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * Everything nginx-related goes through one root-owned helper script
 * (deploy/devbox-panel-nginx) invoked via a single sudoers line.
 *
 * Why: aaPanel keeps vhosts in a 0700 root directory and the binary lives outside
 * PATH, so the panel user cannot read or reload them. Whitelisting `sudo cat` or
 * `sudo nginx` would be far broader than whitelisting one script that only knows
 * six verbs and validates its own arguments.
 */
export class NginxService {
  constructor(cfg) {
    this.cfg = cfg.nginx || {}
    this.enabled = this.cfg.enabled !== false
    this.helper = this.cfg.helper || '/usr/local/bin/devbox-panel-nginx'
    this.useSudo = this.cfg.sudo !== false
  }

  _argv(args) {
    return this.useSudo
      ? { cmd: 'sudo', args: ['-n', this.helper, ...args] }
      : { cmd: this.helper, args }
  }

  async _run(args, timeoutMs = 20000) {
    const { cmd, args: argv } = this._argv(args)
    return run({ cmd, args: argv, timeoutMs })
  }

  async health() {
    if (!this.enabled) return { ok: false, reason: 'disabled in config' }
    const res = await this._run(['status'], 10000)
    if (!res.ok) {
      const msg = (res.stderr || res.stdout).trim().split('\n')[0]
      if (/sudo:.*password/i.test(msg) || /may not run/i.test(msg)) {
        return { ok: false, reason: `sudo refused — install deploy/sudoers.devbox-panel (${msg})` }
      }
      if (/ENOENT|no such file/i.test(msg)) return { ok: false, reason: `helper not installed at ${this.helper}` }
      return { ok: false, reason: msg || 'nginx helper failed' }
    }
    let parsed = {}
    try { parsed = JSON.parse(res.stdout) } catch { parsed = { raw: res.stdout.trim() } }
    return { ok: true, ...parsed }
  }

  async vhosts() {
    const res = await this._run(['list'])
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout).trim(), vhosts: [] }
    let files = []
    try { files = JSON.parse(res.stdout) } catch { return { ok: false, error: 'cannot parse helper output', vhosts: [] } }

    const vhosts = []
    for (const f of files) {
      const shown = await this.show(f.file)
      vhosts.push({ ...f, ...(shown.ok ? parseVhost(shown.text) : { parseError: shown.error }) })
    }
    vhosts.sort((a, b) => a.file.localeCompare(b.file))
    return { ok: true, vhosts }
  }

  async show(file) {
    if (!NAME_RE.test(file)) return { ok: false, error: 'bad file name' }
    const res = await this._run(['show', file])
    return res.ok ? { ok: true, text: res.stdout } : { ok: false, error: (res.stderr || res.stdout).trim() }
  }

  async test() {
    const res = await this._run(['test'], 30000)
    return { ok: res.ok, text: (res.stdout + res.stderr).trim() }
  }

  /** Reload only after a passing config test — a broken reload takes every site down. */
  async reload() {
    if (this.cfg.allowReload === false) {
      const err = new Error('nginx reload is disabled in the panel config')
      err.status = 403
      throw err
    }
    const test = await this.test()
    if (!test.ok) return { ok: false, stage: 'test', text: test.text }
    const res = await this._run(['reload'], 30000)
    return { ok: res.ok, stage: 'reload', text: (res.stdout + res.stderr).trim() }
  }

  async logs() {
    const res = await this._run(['logs'])
    if (!res.ok) return { ok: false, error: (res.stderr || res.stdout).trim(), logs: [] }
    try { return { ok: true, logs: JSON.parse(res.stdout) } } catch { return { ok: false, error: 'cannot parse helper output', logs: [] } }
  }

  logsArgv(file, lines = 200) {
    if (!NAME_RE.test(file)) {
      const err = new Error('bad log name')
      err.status = 400
      throw err
    }
    return this._argv(['tail-follow', file, String(lines)])
  }
}

/**
 * Pull the interesting lines out of a vhost file. Not a real nginx grammar —
 * enough to answer "which hostname maps to which upstream, and is it locked down".
 */
export function parseVhost(text) {
  // Comments first: several of these vhosts document their own history in `#` lines
  // that mention server_name/proxy_pass, and a naive grep reports those as config.
  const uncommented = String(text)
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')

  const grab = (re) => {
    const out = []
    let m
    while ((m = re.exec(uncommented)) !== null) out.push(m[1].trim())
    return [...new Set(out)]
  }

  const serverNames = []
  for (const chunk of grab(/(?:^|[{;\s])server_name\s+([^;]+);/g)) {
    for (const n of chunk.split(/\s+/)) if (n) serverNames.push(n)
  }

  const proxyPass = grab(/(?:^|[{;\s])proxy_pass\s+([^;]+);/g)

  return {
    serverNames: [...new Set(serverNames)],
    listens: grab(/(?:^|[{;\s])listen\s+([^;]+);/g),
    proxyPass,
    roots: grab(/(?:^|[{;\s])root\s+([^;]+);/g),
    ssl: /(?:^|[{;\s])ssl_certificate\s+/.test(uncommented),
    restricted: /(?:^|[{;\s])deny\s+all\s*;/.test(uncommented),
    upstreamPorts: [...new Set(proxyPass.map((p) => (p.match(/:(\d{2,5})/) || [])[1]).filter(Boolean))],
  }
}
