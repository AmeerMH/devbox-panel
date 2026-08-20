import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { ROOT_DIR, loadConfig, assertUsable } from './config.js'
import { LoginLimiter } from './auth.js'
import { JobManager } from './jobs/job-manager.js'
import { ProjectsService } from './services/projects.js'
import { DockerService } from './services/docker.js'
import { Pm2Service } from './services/pm2.js'
import { NginxService } from './services/nginx.js'
import { SystemService } from './services/system.js'
import { PollerHub, ProcessStreamHub } from './streams.js'
import { createApiRouter } from './routes/api.js'
import { attachWebsocket } from './ws.js'

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
const cfg = loadConfig()

const problems = assertUsable(cfg)
if (problems.length) {
  console.error('devbox-panel cannot start:\n' + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}

fs.mkdirSync(cfg.dataDir, { recursive: true })

const jobs = new JobManager({ dataDir: cfg.dataDir, ...cfg.jobs })
const projects = new ProjectsService(cfg)
const docker = new DockerService(cfg)
const pm2 = new Pm2Service(cfg)
const nginx = new NginxService(cfg)
const system = new SystemService(cfg, { version: pkg.version })
const limiter = new LoginLimiter()

projects.refresh()
// Cheap enough to redo on a timer, so a newly cloned project or an edited Makefile
// shows up without restarting the panel.
setInterval(() => projects.refresh(), 60_000).unref()

const pollers = new PollerHub()
pollers.register('pm2', 3000, () => pm2.list())
pollers.register('docker', 5000, () => docker.list())
pollers.register('system', 5000, () => system.snapshot())

const streams = new ProcessStreamHub()
streams.registerPrefix('dockerlogs', (name) => docker.logsArgv(name))
streams.registerPrefix('pm2logs', (name) => pm2.logsArgv(name))
streams.registerPrefix('nginxlog', (file) => nginx.logsArgv(file))

const app = express()
app.disable('x-powered-by')
if (cfg.behindProxy) app.set('trust proxy', 1)
app.use(express.json({ limit: '64kb' }))

// Static assets. xterm ships as plain UMD/CSS, so it is served straight from
// node_modules — no bundler, no build step, nothing to go stale on the server.
const pub = path.join(ROOT_DIR, 'public')
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
}
for (const [route, file] of Object.entries(VENDOR)) {
  const abs = path.join(ROOT_DIR, file)
  app.get(route, (req, res) => res.sendFile(abs))
}
// No far-future caching: after a panel update, a stale bundle in an open tab is
// a broken UI, and these assets are a few KB served over the LAN.
app.use(express.static(pub, {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: 0,
  // `no-cache` = revalidate every time (cheap 304s), never serve a stale bundle
  // from an open tab after the panel is redeployed.
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}))

app.use('/api', createApiRouter({ cfg, jobs, projects, docker, pm2, nginx, system, limiter }))

app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')))
app.get('/healthz', (req, res) => res.type('text/plain').send('ok\n'))
app.get('*', (req, res) => res.sendFile(path.join(pub, 'index.html')))

const server = http.createServer(app)
attachWebsocket({ server, cfg, jobs, pollers, streams })

server.listen(cfg.port, cfg.host, () => {
  console.log(`devbox-panel ${pkg.version} listening on http://${cfg.host}:${cfg.port}`)
  console.log(`  config : ${cfg.configPath}`)
  console.log(`  data   : ${cfg.dataDir}`)
  console.log(`  roots  : ${cfg.roots.map((r) => `${r.path}${r.user ? ` (as ${r.user})` : ''}`).join(', ')}`)
  console.log(`  projects discovered: ${projects.list().length}`)
})

function shutdown(signal) {
  console.log(`\n[devbox-panel] ${signal} — shutting down`)
  streams.closeAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
