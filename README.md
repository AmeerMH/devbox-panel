# devbox-panel

A web control panel for a single dev/showcase server. It runs on the box, behind
nginx and a password, and gives you one screen for the four things you would
otherwise SSH in for:

- **Make targets** — every project's Makefile is parsed and each target becomes a
  button. Output streams live into a terminal pane; several targets can run at
  once, each in its own tab; anything can be cancelled mid-run.
- **Docker** — containers with state, health, ports; start/stop/restart; live logs.
- **PM2** — apps with status, uptime, restarts, CPU/memory; reload/restart/stop; live logs.
- **Nginx** — `nginx -t`, a guarded reload, the vhost → upstream map, and log tails.

Plus a Runs history (every command the panel has ever launched, with its full log)
and a System tab (load, memory, disks, listening ports).

The typical loop it replaces: merge to `main` → open the panel → click `deploy` on
the project → watch the build stream → check PM2 came back online.

## Security — read this before exposing it

This panel executes `make`, `docker`, `pm2` and `nginx -s reload` on your server.
**Anyone who gets in owns the box.** What it does about that:

| Control | Detail |
|---|---|
| Password login | scrypt hash in `.env`, never in git. Minimum 10 characters. |
| Session cookie | HMAC-signed, httpOnly, SameSite=Lax, `Secure` when behind TLS, 12h expiry. |
| Brute force | 5 failed logins per IP per 15 minutes, then locked out. |
| CSRF | Every mutating request must echo the session's CSRF token in `X-Panel-CSRF`. |
| Websocket | The upgrade is rejected without a valid session cookie. |
| No shell strings | Commands are spawned as argv arrays. A target name can never become `; rm -rf /`. |
| Allowlists | Only targets parsed from that project's Makefile, only containers/apps that exist right now, only the docker/pm2 verbs in the code. |
| Deny list | `projectOverrides.<project>.deny` removes targets from the UI and the API entirely (e.g. `db-reset`). |
| Confirmation | Targets matching `dangerPatterns` need an explicit confirm; the API returns 428 without it. |
| Guarded reload | `nginx -s reload` only runs after `nginx -t` passes. |
| Root surface | Exactly one sudoers line, for one script that takes six fixed verbs. |

It binds `127.0.0.1` by default — nginx is the only way in. If you want a second
lock, uncomment the `allow`/`deny` block in the vhost template.

## Requirements

- Node.js 20+ (22 recommended — that is what the server runs)
- The panel user must own the projects it runs `make` for (this repo assumes `deploy`)
- Optional: `docker` group membership (Docker tab), the sudoers rule (Nginx tab)

Each capability degrades on its own: without the docker group the Docker tab says
so and everything else keeps working.

## Quick start (dev machine)

```bash
npm install
cp config/panel.config.example.json config/panel.config.json   # edit roots
npm run gen-secret        # -> PANEL_SESSION_SECRET in .env
npm run hash-password     # -> PANEL_PASSWORD_HASH in .env
npm run dev               # http://127.0.0.1:7070
npm test
```

## Install on the server

```bash
# 1. as the panel user (deploy)
cd ~ && git clone git@github.com:<you>/devbox-panel.git && cd devbox-panel
npm ci --omit=dev

# 2. root pieces: nginx helper + sudoers + /etc/devbox-panel/panel.config.json
sudo bash deploy/install.sh --user deploy

# 3. secrets (never commit these)
npm run gen-secret        # -> PANEL_SESSION_SECRET in .env
npm run hash-password     # -> PANEL_PASSWORD_HASH in .env

# 4. edit /etc/devbox-panel/panel.config.json — roots, deny lists, pm2 bin

# 5. start it under pm2
pm2 start deploy/ecosystem.config.cjs && pm2 save

# 6. publish it
sudo cp deploy/nginx-public-domain.conf /www/server/panel/vhost/nginx/panel.<domain>.conf
sudo sed -i 's/PANEL_DOMAIN/panel.<domain>/g' /www/server/panel/vhost/nginx/panel.<domain>.conf
# issue a certificate for panel.<domain>, then:
sudo /usr/local/bin/devbox-panel-nginx reload
```

If you added the panel user to the `docker` group in step 2, restart the process
(`pm2 restart devbox-panel`) — a new group only applies to new processes.

Updating later: `make deploy` in the checkout, or click `self-update` in the panel
(that target detaches itself, because reloading the panel from inside the panel
would kill the job streaming its own output).

## Configuration

`/etc/devbox-panel/panel.config.json` (or `config/panel.config.json` locally):

| Key | Meaning |
|---|---|
| `port`, `host` | Listen address. Keep `127.0.0.1` and let nginx do TLS. |
| `dataDir` | Job logs and history. Relative paths resolve against the repo. |
| `jobs.maxConcurrent` | Refuses to start more than this many at once (default 6). |
| `jobs.bufferBytes` | In-memory tail kept per job for late viewers (default 512 KB). |
| `jobs.historyLimit` | How many runs to keep; older logs are deleted with their entry. |
| `roots[]` | `{ label, path, user, enabled }`. `user` makes the panel run that root's targets via `sudo -u <user> make` (see the dev-hop warning below). |
| `projectOverrides` | Per project: `deny` (targets removed entirely), `danger` (extra confirm-required patterns). |
| `dangerPatterns` | Substrings that mark a target as destructive/service-affecting. |
| `pm2.bin` | `auto` searches `~/.npm-global/bin`, `/usr/local/bin`, nvm. Set a full path if it guesses wrong. |
| `pm2.home` | Sets `PM2_HOME` if the daemon does not live in the panel user's home. |
| `docker.allowStop` | Set `false` to make the Docker tab start/restart-only. |
| `nginx.helper`, `nginx.sudo`, `nginx.allowReload` | Path to the helper script and whether to invoke it via sudo / allow reloads. |

Secrets live in `.env` next to the code, never in the JSON:
`PANEL_PASSWORD_HASH`, `PANEL_SESSION_SECRET`, and optionally `PANEL_PORT`,
`PANEL_HOST`, `PANEL_BEHIND_PROXY`, `PANEL_SESSION_HOURS`, `PANEL_CONFIG`.

### The `/srv/projects` dev-hop

A root with `"user": "dev"` makes the panel run `sudo -n -u dev /usr/bin/make …`,
which needs `deploy/sudoers.devbox-panel-devhop`. Understand what that grants:
`make` runs whatever the Makefile says, so it is arbitrary code as `dev` — and if
`dev` has passwordless sudo, that is a path to root. The root ships **disabled**
(`"enabled": false`) for that reason. Turn it on only if you accept the bridge.

## How a target becomes a button

`src/services/makefile.js` parses each project's Makefile: real targets only —
variable assignments, pattern rules, `.PHONY`/`.DEFAULT_GOAL` and recipe bodies are
skipped. The `## comment` after a target becomes its tooltip, and `# ---- section`
comment banners group the chips. A target is flagged dangerous when its name
matches `dangerPatterns` (`deploy`, `reset`, `drop`, `down`, `clean`, `stop`, …),
which is why `deploy` asks before it runs.

Projects are rediscovered every 60 seconds, so a new clone or an edited Makefile
appears without restarting the panel.

## Architecture

```
src/
  server.js            composition root: express + ws + pollers
  config.js            config file + .env, refuses to boot without a password hash
  auth.js              scrypt hashing, signed sessions, login rate limiter
  bus.js               channel pub/sub
  streams.js           ref-counted pollers (pm2/docker/system) and follow processes (logs)
  ws.js                one websocket, many channels, cookie-authenticated
  jobs/job-manager.js  spawn, stream, cancel, persist, trim
  routes/api.js        the REST surface
  services/            projects, makefile, docker, pm2, nginx, system
  util/exec.js         argv-only spawn helpers, sudo hop, login shell
public/                vanilla ES modules + xterm.js served from node_modules (no build step)
deploy/                nginx helper, sudoers, vhost templates, pm2 ecosystem, installer
```

Websocket channels: `jobs`, `job:<id>`, `pm2`, `docker`, `system`,
`pm2logs:<app>`, `dockerlogs:<container>`, `nginxlog:<file>`. Pollers and follow
processes are reference-counted — nothing runs on the server while nobody is
watching that tab.

Jobs are spawned **detached, in their own process group**: cancel signals the whole
tree (a `make` that spawned npm that spawned next), and a panel restart does not
kill a running deploy. Such a job is marked `orphaned` afterwards — its log file is
still complete and readable, but the live stream is gone.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Docker tab: "no access to the docker socket" | Panel user is not in the `docker` group, or the process predates the change. `usermod -aG docker deploy && pm2 restart devbox-panel`. |
| Nginx tab: "sudo refused" | `/etc/sudoers.d/devbox-panel` missing or names a different user. Re-run `deploy/install.sh --user <user>`. |
| PM2 tab: "pm2 not found" | pm2 is not on the panel's PATH (a login shell does not read `~/.bashrc` non-interactively). Set `pm2.bin` to the full path. |
| PM2 list is empty but apps are running | The daemon belongs to another user. Run the panel as that user, or set `pm2.home`. |
| Logs stall or arrive in bursts | nginx buffering. The vhost needs `proxy_buffering off` and — on aaPanel — `proxy_cache off`, because `conf/proxy.conf` enables a cache at the http level. |
| Websocket never connects (page loads, dot is red) | The vhost is missing the `Upgrade`/`Connection` headers, or `$connection_upgrade` is undefined on a stock nginx. Add the `map` shown in the template. |
| `make deploy` works in SSH but fails here | The recipe depends on an interactive-shell PATH. The panel prepends `~/.npm-global/bin` and `/usr/local/bin`; anything else should be made explicit in the Makefile. |

## Tests

```bash
npm test
```

Covers the Makefile parser, the nginx vhost parser, password/session/CSRF/rate-limit
logic, and the job manager (exit codes, process-group cancellation, concurrency cap,
history trimming, restart orphaning).
