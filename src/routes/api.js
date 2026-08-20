import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { COOKIE_NAME, newSession, parseCookies, verifyPassword, verifySession } from '../auth.js'
import { DatabasesService } from '../services/databases.js'

export function clientIp(req, behindProxy) {
  if (behindProxy) {
    const fwd = req.headers['x-forwarded-for']
    if (fwd) return String(fwd).split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

export const DEMO_SESSION = { sub: 'demo', csrf: 'demo', exp: Number.MAX_SAFE_INTEGER, demo: true }

export function sessionFromRequest(req, cfg) {
  if (cfg.demo) return DEMO_SESSION
  const cookies = parseCookies(req.headers.cookie || '')
  const token = cookies[COOKIE_NAME]
  if (!token) return null
  return verifySession(token, cfg.sessionSecret)
}

function cookieOptions(cfg) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.behindProxy,
    path: '/',
    maxAge: cfg.sessionHours * 3600_000,
  }
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function createApiRouter(ctx) {
  const { cfg, jobs, projects, docker, pm2, nginx, system, databases, limiter } = ctx
  const router = express.Router()

  /* ------------------------------------------------------------------ auth */

  router.post('/login', (req, res) => {
    const ip = clientIp(req, cfg.behindProxy)
    if (limiter.blocked(ip)) {
      const mins = Math.ceil(limiter.retryAfterMs(ip) / 60000)
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` })
    }
    const password = String(req.body?.password ?? '')
    if (!password || !verifyPassword(password, cfg.passwordHash)) {
      const fails = limiter.fail(ip)
      console.warn(`[auth] failed login from ${ip} (${fails})`)
      return res.status(401).json({ error: 'Wrong password' })
    }
    limiter.reset(ip)
    const { token, payload } = newSession({ secret: cfg.sessionSecret, hours: cfg.sessionHours })
    res.cookie(COOKIE_NAME, token, cookieOptions(cfg))
    console.log(`[auth] login from ${ip}`)
    res.json({ ok: true, csrf: payload.csrf, expiresAt: payload.exp })
  })

  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.json({ ok: true })
  })

  // Everything below this line requires a session.
  router.use((req, res, next) => {
    const session = sessionFromRequest(req, cfg)
    if (!session) return res.status(401).json({ error: 'Not signed in' })
    if (cfg.demo) {
      req.session = session
      return next()
    }
    // Double-submit CSRF: the token lives in the signed session, and the browser
    // must echo it in a header — which a cross-site form post cannot do.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-panel-csrf') !== session.csrf) {
      return res.status(403).json({ error: 'Bad CSRF token — reload the page' })
    }
    req.session = session
    next()
  })

  router.get('/me', (req, res) => {
    res.json({ user: req.session.sub, csrf: req.session.csrf, expiresAt: req.session.exp, demo: !!cfg.demo })
  })

  /* --------------------------------------------------------------- health */

  router.get('/health', asyncRoute(async (req, res) => {
    const [d, p, n, db] = await Promise.all([docker.health(), pm2.health(), nginx.health(), databases.helperHealth()])
    res.json({
      docker: d,
      pm2: p,
      nginx: n,
      dbHelper: db,
      roots: cfg.roots.map((r) => ({ label: r.label, path: r.path, user: r.user || null })),
    })
  }))

  /* ------------------------------------------------------------- projects */

  router.get('/projects', asyncRoute(async (req, res) => {
    const list = projects.list()
    const withGit = req.query.git === '1'
    const payload = withGit
      ? await Promise.all(list.map(async (p) => ({ ...p, git: await projects.gitInfo(p) })))
      : list
    res.json({ projects: payload })
  }))

  router.post('/projects/refresh', (req, res) => {
    res.json({ projects: projects.refresh() })
  })

  router.get('/projects/:id', asyncRoute(async (req, res) => {
    const project = projects.get(req.params.id)
    if (!project) return res.status(404).json({ error: 'Unknown project' })
    res.json({ project: { ...project, git: await projects.gitInfo(project) } })
  }))

  router.post('/projects/:id/run', (req, res) => {
    const project = projects.get(req.params.id)
    if (!project) return res.status(404).json({ error: 'Unknown project' })
    const target = String(req.body?.target ?? '')
    const found = projects.target(project, target)
    if (!found) return res.status(400).json({ error: `Unknown target "${target}"` })
    if (found.dangerous && req.body?.confirm !== true) {
      return res.status(428).json({ error: `\`make ${target}\` is marked dangerous — confirm required`, needsConfirm: true })
    }
    const job = projects.runTarget({ jobs, projectId: project.id, target })
    console.log(`[run] ${project.name} make ${target} -> job ${job.id}`)
    res.json({ job })
  })

  router.post('/projects/:id/fetch', (req, res) => {
    res.json({ job: projects.fetch({ jobs, projectId: req.params.id }) })
  })

  /* ----------------------------------------------------------------- jobs */

  router.get('/jobs', (req, res) => res.json({ jobs: jobs.list() }))

  router.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Unknown job' })
    res.json({ job: jobs.toJSON(job), output: jobs.output(req.params.id) })
  })

  router.get('/jobs/:id/log', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ error: 'Unknown job' })
    const file = path.join(jobs.dir, `${req.params.id}.log`)
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Log file is gone' })
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.log"`)
    fs.createReadStream(file).pipe(res)
  })

  router.post('/jobs/:id/cancel', (req, res) => {
    const result = jobs.cancel(req.params.id)
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  })

  /* --------------------------------------------------------------- docker */

  router.get('/docker', asyncRoute(async (req, res) => res.json(await docker.list())))
  router.get('/docker/stats', asyncRoute(async (req, res) => res.json(await docker.stats())))
  router.get('/docker/:name/inspect', asyncRoute(async (req, res) => res.json(await docker.inspect(req.params.name))))
  router.get('/docker/:name/resources', asyncRoute(async (req, res) => res.json(await docker.resources(req.params.name))))
  router.post('/docker/:name/limits', asyncRoute(async (req, res) => {
    const totalMemoryBytes = (await system.memory()).total
    const job = await docker.updateResources({ jobs, name: req.params.name, limits: req.body || {}, totalMemoryBytes })
    console.log(`[limits] docker ${req.params.name} <- ${JSON.stringify(req.body)}`)
    res.json({ job })
  }))
  router.post('/docker/:name/:action', asyncRoute(async (req, res) => {
    const job = await docker.action({ jobs, name: req.params.name, action: req.params.action })
    res.json({ job })
  }))

  /* ------------------------------------------------------------------ pm2 */

  router.get('/pm2', asyncRoute(async (req, res) => res.json(await pm2.list())))
  router.get('/pm2/:name/describe', asyncRoute(async (req, res) => res.json(await pm2.describe(req.params.name))))
  router.post('/pm2/:name/:action', asyncRoute(async (req, res) => {
    const job = await pm2.action({ jobs, name: req.params.name, action: req.params.action })
    res.json({ job })
  }))

  /* ---------------------------------------------------------------- nginx */

  router.get('/nginx', asyncRoute(async (req, res) => {
    const [health, vhosts, logs] = await Promise.all([nginx.health(), nginx.vhosts(), nginx.logs()])
    res.json({ health, vhosts: vhosts.vhosts || [], vhostError: vhosts.error || null, logs: logs.logs || [] })
  }))
  router.get('/nginx/vhost/:file', asyncRoute(async (req, res) => res.json(await nginx.show(req.params.file))))
  router.post('/nginx/test', asyncRoute(async (req, res) => res.json(await nginx.test())))
  router.post('/nginx/reload', asyncRoute(async (req, res) => {
    const result = await nginx.reload()
    console.log(`[nginx] reload requested — ${result.ok ? 'ok' : `failed at ${result.stage}`}`)
    res.status(result.ok ? 200 : 400).json(result)
  }))

  /* ------------------------------------------------------------ databases */

  router.get('/databases', asyncRoute(async (req, res) => res.json(await databases.list())))
  router.get('/databases/engines', (req, res) => res.json({ engines: DatabasesService.engines() }))
  router.get('/databases/:id', asyncRoute(async (req, res) => res.json(await databases.detail(req.params.id))))

  router.post('/databases/:id/limits', asyncRoute(async (req, res) => {
    const job = await databases.applyLimits({ jobs, id: req.params.id, limits: req.body || {} })
    console.log(`[limits] ${req.params.id} <- ${JSON.stringify(req.body)}`)
    res.json({ job })
  }))

  router.post('/databases/:id/settings', asyncRoute(async (req, res) => {
    const { key, value } = req.body || {}
    const result = await databases.applySetting({ id: req.params.id, key: String(key ?? ''), value })
    // Values are logged; they are sizes and counts, never credentials.
    console.log(`[db] ${req.params.id} ${key} = ${result.applied}`)
    res.json(result)
  }))

  /* --------------------------------------------------------------- system */

  router.get('/system', asyncRoute(async (req, res) => res.json(await system.snapshot())))

  /* -------------------------------------------------------- error handler */

  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500
    if (status >= 500) console.error('[api]', err)
    res.status(status).json({ error: err.message || 'Internal error' })
  })

  return router
}
