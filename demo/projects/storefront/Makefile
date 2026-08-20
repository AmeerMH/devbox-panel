# Storefront — demo project for devbox-panel screenshots. Nothing here touches a real service.
SHELL := /bin/bash
.DEFAULT_GOAL := help
C_OK := \033[32m
C_INFO := \033[36m
C_WARN := \033[33m
C_OFF := \033[0m

.PHONY: help install dev build start typecheck lint test db-up db-down db-migrate db-seed db-reset deploy deploy-migrate pm2-logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ------------------------------------------------------------------ dev loop
install: ## Install npm dependencies
	@echo -e "$(C_INFO)→ installing 412 packages$(C_OFF)"; sleep 1; echo "added 412 packages in 9s"

dev: ## Dev server on http://localhost:3000
	@echo "ready on http://localhost:3000"; sleep 30

build: ## Production build
	@echo -e "$(C_INFO)→ next build$(C_OFF)"
	@for s in "collecting page data" "generating static pages (0/48)" "generating static pages (24/48)" "generating static pages (48/48)" "finalizing page optimization"; do echo "  $$s"; sleep 1; done
	@echo -e "$(C_OK)✓ compiled successfully in 21.4s$(C_OFF)"

start: ## Start the production server
	@echo "listening on :3000"; sleep 30

typecheck: ## Type-check without emitting
	@echo -e "$(C_INFO)→ tsc --noEmit$(C_OFF)"; sleep 2; echo -e "$(C_OK)✓ no type errors$(C_OFF)"

lint: ## Run ESLint
	@echo -e "$(C_INFO)→ eslint .$(C_OFF)"; sleep 1; echo -e "$(C_WARN)2 warnings, 0 errors$(C_OFF)"

test: ## Run the test suite
	@echo -e "$(C_INFO)→ vitest run$(C_OFF)"; sleep 2; echo -e "$(C_OK)✓ 84 passed (84)$(C_OFF)"

# -------------------------------------------------------------------- database
db-up: ## Start Postgres in Docker
	@echo "container demo-postgres is up"

db-down: ## Stop the Postgres container
	@echo "container demo-postgres stopped"

db-migrate: ## Apply migrations
	@echo "3 migrations applied"

db-seed: ## Seed demo data
	@echo "seeded 120 rows"

db-reset: ## DANGER: drop, re-migrate and re-seed
	@echo "database reset"

db-studio: ## Open the database browser
	@echo "studio on :5555"; sleep 20

# ---------------------------------------------------------------------- deploy
deploy: ## Full deploy: pull main → install → build → migrate → PM2 reload
	@echo -e "$(C_INFO)→ pulling main$(C_OFF)"; sleep 1; echo "  HEAD is now at 4f2a9c1"
	@echo -e "$(C_INFO)→ npm ci$(C_OFF)"; sleep 2; echo "  added 412 packages"
	@echo -e "$(C_INFO)→ building$(C_OFF)"; sleep 2; echo -e "  $(C_OK)✓ compiled successfully$(C_OFF)"
	@echo -e "$(C_INFO)→ applying migrations$(C_OFF)"; sleep 1; echo "  no pending migrations"
	@echo -e "$(C_INFO)→ reloading pm2$(C_OFF)"; sleep 1; echo -e "$(C_OK)✓ storefront reloaded (2 instances)$(C_OFF)"

deploy-migrate: ## Apply pending migrations on the deployed database
	@echo "no pending migrations"

pm2-logs: ## Tail the app logs
	@echo "streaming logs"; sleep 20

clean: ## Remove the build cache
	@echo "removed .next"
