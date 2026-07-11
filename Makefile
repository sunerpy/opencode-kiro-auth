# opencode-kiro-auth Makefile — single source of truth for install/build/fmt/test gates.
# CI (.github/workflows/ci.yml) calls the same targets as `make ci` below, so
# "what CI runs" and "what runs locally" can never drift.
#
#   make help       list targets
#   make install    bun install
#   make build      tsc + fix-esm-imports -> dist/
#   make test       bun test
#   make typecheck  tsc --noEmit
#   make fmt        prettier --write (writes in place)
#   make fmt-check  prettier --check (CI gate, no writes)
#   make ci         typecheck + fmt-check + test (mirrors CI)
#   make clean      remove dist/

HAS_BUN := $(shell command -v bun 2>/dev/null)

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install dependencies (bun install)
ifdef HAS_BUN
	bun install
else
	$(error bun not found: https://bun.sh)
endif

.PHONY: build
build: ## Build dist/ (tsc + fix-esm-imports)
	bun run build

.PHONY: test
test: ## Run the test suite (bun test)
	bun test

.PHONY: typecheck
typecheck: ## Type-check without emitting (tsc --noEmit)
	bun run typecheck

.PHONY: fmt
fmt: ## Format source files in place (prettier --write)
	bunx prettier --write 'src/**/*.ts'

.PHONY: fmt-check
fmt-check: ## Verify formatting without writing (CI gate)
	bunx prettier --check 'src/**/*.ts'

.PHONY: ci
ci: typecheck fmt-check test ## Full local verification (mirrors CI)
	@echo "All checks passed."

.PHONY: coverage
coverage: ## Generate coverage report (LCOV + text table)
	bun test --coverage --coverage-reporter=lcov --coverage-reporter=text

.PHONY: coverage-gate
coverage-gate: ## Run coverage and verify >= 90% (exits 1 if below)
	bun test --coverage --coverage-reporter=lcov
	node scripts/coverage-gate.mjs

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf dist
