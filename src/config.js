import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from './util/env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(here, '..')

loadEnvFile(path.join(ROOT_DIR, '.env'))

const DEFAULTS = {
  port: 7070,
  host: '127.0.0.1',
  dataDir: './data',
  jobs: { maxConcurrent: 6, bufferBytes: 512 * 1024, historyLimit: 200, killGraceMs: 8000 },
  roots: [{ label: 'deploy', path: '/home/deploy', user: null }],
  projectOverrides: {},
  dangerPatterns: ['reset', 'drop', 'wipe', 'prune', 'destroy', 'delete', 'purge', 'down', 'clean', 'stop', 'seed', 'deploy', 'restart'],
  pm2: { enabled: true, bin: 'auto', home: null, allowDelete: false },
  docker: { enabled: true, bin: 'docker', allowStop: true },
  nginx: { enabled: true, helper: '/usr/local/bin/devbox-panel-nginx', sudo: true, allowReload: true },
  databases: { enabled: true, helper: '/usr/local/bin/devbox-panel-dbadmin', sudo: true, scanServices: true },
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v
  }
  return out
}

function resolveConfigPath() {
  if (process.env.PANEL_CONFIG) return process.env.PANEL_CONFIG
  const local = path.join(ROOT_DIR, 'config', 'panel.config.json')
  if (fs.existsSync(local)) return local
  return path.join(ROOT_DIR, 'config', 'panel.config.example.json')
}

export function loadConfig() {
  const configPath = resolveConfigPath()
  let fileConfig = {}
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot parse ${configPath}: ${err.message}`)
  }

  const cfg = deepMerge(DEFAULTS, fileConfig)

  if (process.env.PANEL_PORT) cfg.port = Number(process.env.PANEL_PORT)
  if (process.env.PANEL_HOST) cfg.host = process.env.PANEL_HOST

  cfg.configPath = configPath
  cfg.dataDir = path.resolve(ROOT_DIR, cfg.dataDir)
  cfg.roots = (cfg.roots || []).filter((r) => r && r.path && r.enabled !== false)
  // Demo mode powers `make demo` and the README screenshots: fake docker/pm2/nginx
  // CLIs, fake projects, and no login. It is loopback-only by construction (see
  // assertUsable) so it can never become an unauthenticated panel on a real host.
  cfg.demo = process.env.PANEL_DEMO === '1'
  cfg.behindProxy = process.env.PANEL_BEHIND_PROXY === '1'
  cfg.sessionHours = Number(process.env.PANEL_SESSION_HOURS || 12)
  cfg.passwordHash = process.env.PANEL_PASSWORD_HASH || ''
  cfg.sessionSecret = process.env.PANEL_SESSION_SECRET || ''

  return cfg
}

/** Fatal misconfiguration checks — refuse to boot rather than serve something unauthenticated. */
export function assertUsable(cfg) {
  const problems = []
  if (!cfg.roots.length) problems.push('No project roots configured')

  if (cfg.demo) {
    // The only thing demo mode may never do is listen anywhere but loopback.
    if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
      problems.push(`PANEL_DEMO=1 skips authentication, so it refuses to bind ${cfg.host} — use 127.0.0.1`)
    }
    return problems
  }

  if (!cfg.passwordHash) problems.push('PANEL_PASSWORD_HASH is empty — run `npm run hash-password` and put it in .env')
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 16) problems.push('PANEL_SESSION_SECRET is missing or too short — run `npm run gen-secret`')
  return problems
}
