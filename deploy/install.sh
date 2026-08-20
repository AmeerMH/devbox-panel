#!/usr/bin/env bash
# Server-side installer for devbox-panel. Run as root, from the checkout:
#
#     sudo bash deploy/install.sh [--user deploy] [--config /etc/devbox-panel/panel.config.json]
#
# Idempotent: safe to re-run after a `git pull`. It installs the root pieces
# (nginx helper + sudoers) and the config skeleton. It does NOT start the app —
# that is `make deploy` / pm2, so a bad start never happens as root.
set -euo pipefail

PANEL_USER=deploy
CONFIG_DIR=/etc/devbox-panel
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --user) PANEL_USER=$2; shift 2 ;;
    --config-dir) CONFIG_DIR=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
id "$PANEL_USER" >/dev/null 2>&1 || { echo "no such user: $PANEL_USER" >&2; exit 1; }

echo "→ repo:  $REPO_DIR"
echo "→ user:  $PANEL_USER"

echo "→ installing the nginx helper"
install -m 0755 -o root -g root "$REPO_DIR/deploy/devbox-panel-nginx" /usr/local/bin/devbox-panel-nginx

echo "→ installing the sudoers rule"
sed "s/^deploy /$PANEL_USER /" "$REPO_DIR/deploy/sudoers.devbox-panel" > /tmp/devbox-panel.sudoers
visudo -cf /tmp/devbox-panel.sudoers >/dev/null
install -m 0440 -o root -g root /tmp/devbox-panel.sudoers /etc/sudoers.d/devbox-panel
rm -f /tmp/devbox-panel.sudoers

echo "→ config directory $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/panel.config.json" ]; then
  cp "$REPO_DIR/config/panel.config.example.json" "$CONFIG_DIR/panel.config.json"
  chown root:"$PANEL_USER" "$CONFIG_DIR/panel.config.json"
  chmod 0640 "$CONFIG_DIR/panel.config.json"
  echo "   created $CONFIG_DIR/panel.config.json from the example"
else
  echo "   $CONFIG_DIR/panel.config.json already exists — left untouched"
fi

if getent group docker >/dev/null; then
  if id -nG "$PANEL_USER" | tr ' ' '\n' | grep -qx docker; then
    echo "→ $PANEL_USER is already in the docker group"
  else
    echo "→ adding $PANEL_USER to the docker group (docker group == root-equivalent; this is the trade for the Docker tab)"
    usermod -aG docker "$PANEL_USER"
    echo "   the panel process must be restarted for the new group to apply"
  fi
else
  echo "→ no docker group on this host; the Docker tab will report itself unavailable"
fi

echo "→ verifying the helper"
sudo -n -u "$PANEL_USER" sudo -n /usr/local/bin/devbox-panel-nginx status || {
  echo "   helper check FAILED — the Nginx tab will be unavailable" >&2
}

cat <<NEXT

Root-side install done. Now, as $PANEL_USER:

  cd $REPO_DIR
  npm ci --omit=dev
  npm run gen-secret        # -> PANEL_SESSION_SECRET in .env
  npm run hash-password     # -> PANEL_PASSWORD_HASH in .env
  pm2 start deploy/ecosystem.config.cjs && pm2 save

Then publish it: copy deploy/nginx-public-domain.conf into the vhost directory,
replace PANEL_DOMAIN, issue a certificate, and reload nginx.
NEXT
