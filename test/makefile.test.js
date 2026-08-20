import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMakefile, isDangerous } from '../src/services/makefile.js'

const SAMPLE = `
SHELL := /bin/bash
NVM := export NVM_DIR="$$HOME/.nvm";

.DEFAULT_GOAL := help

.PHONY: help setup install run dev \\
        db-up db-down deploy

help: ## Show this help
	@echo hi

# ---------------------------------------------------------------- run / setup
run: db-up dev ## Run the project: start Postgres then the dev server

install: ## Install npm dependencies
	@$(NVM) npm install

%.o: %.c
	cc -c $<

$(GENERATED): ## computed
	touch $@

deploy: ## Full production deploy
	@echo deploying
`

test('parses targets with descriptions', () => {
  const targets = parseMakefile(SAMPLE)
  const names = targets.map((t) => t.name)
  assert.ok(names.includes('help'))
  assert.ok(names.includes('run'))
  assert.ok(names.includes('install'))
  assert.ok(names.includes('deploy'))
  assert.equal(targets.find((t) => t.name === 'run').description, 'Run the project: start Postgres then the dev server')
})

test('skips variables, pattern rules, computed and special targets', () => {
  const names = parseMakefile(SAMPLE).map((t) => t.name)
  assert.ok(!names.includes('SHELL'))
  assert.ok(!names.includes('NVM'))
  assert.ok(!names.includes('.PHONY'))
  assert.ok(!names.includes('.DEFAULT_GOAL'))
  assert.ok(!names.some((n) => n.includes('%')))
  assert.ok(!names.some((n) => n.includes('$')))
})

test('records prerequisites and section headings', () => {
  const run = parseMakefile(SAMPLE).find((t) => t.name === 'run')
  assert.equal(run.prereqs, 'db-up dev')
  assert.equal(run.section, 'run / setup')
})

test('does not invent targets from recipe lines', () => {
  const names = parseMakefile('build:\n\t@echo "note: this is not a target"\n').map((t) => t.name)
  assert.deepEqual(names, ['build'])
})

test('danger detection', () => {
  const patterns = ['reset', 'drop', 'down', 'deploy']
  assert.equal(isDangerous('db-reset', patterns), true)
  assert.equal(isDangerous('deploy', patterns), true)
  assert.equal(isDangerous('db-down', patterns), true)
  assert.equal(isDangerous('typecheck', patterns), false)
  assert.equal(isDangerous('lint', patterns), false)
})
