#!/usr/bin/env bash
# Start the panel against invented projects, containers, processes and vhosts.
#
#     make demo     # -> http://127.0.0.1:7071
#
# Nothing here touches a real service: demo/bin holds stub `git`, `docker`, `pm2`
# and nginx-helper commands, and PATH is pointed at them. Used for the README
# screenshots and to try the panel without a server.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${PANEL_PORT:-7071}
DATA="$HERE/data/demo"
# The fixtures are staged outside the checkout so the UI shows a server-shaped
# path (/tmp/devbox-panel-demo/apps/storefront) instead of somebody's home directory.
APPS=${DEMO_APPS_DIR:-/tmp/devbox-panel-demo/apps}

mkdir -p "$DATA" "$APPS"
# Fresh limit/settings state on every demo run, so screenshots are reproducible.
rm -f /tmp/devbox-panel-demo/docker-state.json /tmp/devbox-panel-demo/systemd-state.json /tmp/devbox-panel-demo/pg-native.json
for p in storefront api-gateway admin-console marketing-site; do
  mkdir -p "$APPS/$p"
  cp -R "$HERE/demo/projects/$p/." "$APPS/$p/"
  # The panel only reads git state for directories that look like checkouts.
  mkdir -p "$APPS/$p/.git"
done

cat > "$DATA/panel.config.json" <<JSON
{
  "port": $PORT,
  "host": "127.0.0.1",
  "dataDir": "$DATA",
  "jobs": { "maxConcurrent": 6, "historyLimit": 40 },
  "roots": [{ "label": "apps", "path": "$APPS", "user": null }],
  "projectOverrides": { "storefront": { "deny": ["db-reset"] } },
  "pm2": { "bin": "$HERE/demo/bin/pm2" },
  "docker": { "bin": "$HERE/demo/bin/docker" },
  "nginx": { "helper": "$HERE/demo/bin/nginx-helper", "sudo": false },
  "databases": { "enabled": true, "helper": "$HERE/demo/bin/devbox-panel-dbadmin", "sudo": false, "scanServices": true },
  "demoSystem": {
    "host": "app-server-01",
    "platform": "Linux 6.8.0-generic",
    "uptimeSec": 1893600,
    "load": [0.42, 0.51, 0.6],
    "cpus": 12,
    "memory": { "total": 50465865728, "available": 34359738368, "used": 16106127360 },
    "disks": [
      { "device": "/dev/sda1", "mount": "/", "total": 421000000000, "used": 138000000000, "available": 283000000000 },
      { "device": "/dev/sdb1", "mount": "/srv", "total": 214000000000, "used": 41000000000, "available": 173000000000 }
    ],
    "ports": [
      { "address": "0.0.0.0:22", "port": 22 }, { "address": "0.0.0.0:80", "port": 80 },
      { "address": "0.0.0.0:443", "port": 443 }, { "address": "127.0.0.1:3000", "port": 3000 },
      { "address": "127.0.0.1:4000", "port": 4000 }, { "address": "127.0.0.1:5000", "port": 5000 },
      { "address": "127.0.0.1:5432", "port": 5432 }, { "address": "127.0.0.1:6379", "port": 6379 },
      { "address": "127.0.0.1:7070", "port": 7070 }, { "address": "127.0.0.1:27017", "port": 27017 }
    ],
    "panel": {
      "pid": 21406, "node": "v22.14.0", "user": "deploy", "rssBytes": 68157440,
      "dataDir": "/home/deploy/.devbox-panel", "configPath": "/etc/devbox-panel/panel.config.json"
    }
  }
}
JSON

export PATH="$HERE/demo/bin:$PATH"
export PANEL_DEMO=1
export PANEL_CONFIG="$DATA/panel.config.json"
cd "$HERE"
exec node src/server.js
