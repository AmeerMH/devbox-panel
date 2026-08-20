# devbox-panel — the panel manages other projects through their Makefiles;
# this one is its own.

SHELL := /bin/bash
.DEFAULT_GOAL := help
PM2 := $(shell command -v pm2 2>/dev/null || echo $$HOME/.npm-global/bin/pm2)

.PHONY: help install dev demo start test lint deploy self-update logs status hash-password gen-secret install-server screenshots

help: ## Show this help
	@echo "devbox-panel — make targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (dev machine)
	npm install

dev: ## Run locally with auto-restart on file changes
	npm run dev

demo: ## Run against invented projects/containers/processes — no login, loopback only
	@bash demo/run.sh

screenshots: ## Regenerate docs/screenshots from the demo (needs Chrome or Edge)
	@node demo/screenshot.mjs

start: ## Run the server in the foreground
	npm start

test: ## Run the unit tests
	npm test

deploy: ## [SERVER] Pull main, install production deps, restart the service
	@echo "→ Pulling main"
	git fetch --all --prune
	git reset --hard origin/main
	@echo "→ Installing production dependencies"
	npm ci --omit=dev
	@echo "→ Restarting"
	@if systemctl list-unit-files devbox-panel.service >/dev/null 2>&1 && \
	    systemctl is-enabled devbox-panel >/dev/null 2>&1; then \
		sudo systemctl restart devbox-panel; \
	else \
		$(PM2) reload devbox-panel --update-env || $(PM2) start deploy/ecosystem.config.cjs; \
	fi

self-update: ## [SERVER] Same as deploy, detached — use this when triggering it FROM the panel
	@# Reloading the panel from inside the panel kills the job streaming its own
	@# output. setsid detaches the update so it survives, and the UI reconnects.
	@setsid bash -c 'cd $(CURDIR) && make deploy >> $(CURDIR)/data/self-update.log 2>&1' &
	@echo "self-update started in the background — see data/self-update.log"

logs: ## [SERVER] Tail the panel's own logs
	@if systemctl is-enabled devbox-panel >/dev/null 2>&1; then \
		journalctl -u devbox-panel -n 100 -f; \
	else \
		$(PM2) logs devbox-panel --lines 100; \
	fi

status: ## [SERVER] Service status for the panel
	@if systemctl is-enabled devbox-panel >/dev/null 2>&1; then \
		systemctl status devbox-panel --no-pager; \
	else \
		$(PM2) describe devbox-panel; \
	fi

install-server: ## [SERVER, once, needs root] Install the nginx helper + sudoers + config skeleton
	sudo bash deploy/install.sh

hash-password: ## Generate PANEL_PASSWORD_HASH for .env
	npm run hash-password

gen-secret: ## Generate PANEL_SESSION_SECRET for .env
	npm run gen-secret
