# Admin console — demo project for devbox-panel screenshots.
SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install dev build check deploy restart status logs cron-install cron-list

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	@sleep 1; echo "added 260 packages"

dev: ## Dev server on http://localhost:5000
	@echo "ready on :5000"; sleep 30

build: ## Production build
	@sleep 2; echo "✓ compiled successfully"

check: ## Everything CI checks — run before pushing
	@sleep 2; echo "✓ typecheck, lint and tests passed"

# ------------------------------------------------------------------- server
deploy: ## [SERVER] Deploy main: pull, migrate, build, reload PM2
	@echo "→ pulling main"; sleep 1; echo "→ building"; sleep 2; echo "✓ admin-console reloaded"

restart: ## [SERVER] Reload the app without a rebuild
	@echo "✓ reloaded"

status: ## [SERVER] Process status
	@echo "admin-console online"

logs: ## [SERVER] Tail the app logs
	@echo "streaming"; sleep 20

cron-install: ## [SERVER] Install the scheduled jobs
	@echo "4 jobs installed"

cron-list: ## [SERVER] Show the installed scheduled jobs
	@echo "4 jobs"
