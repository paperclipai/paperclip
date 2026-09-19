.PHONY: help install onboard dev bootstrap-ceo setup

APP_PORT = 3100

## Show available targets
help:
	@echo "Usage:"
	@echo "  make setup          First-time setup (.env + install + onboard)"
	@echo "  make dev            Start dev server with hot reload"
	@echo "  make bootstrap-ceo  Generate the first admin invite URL"

## Create .env for local development (no external DB needed)
.env:
	@echo "BETTER_AUTH_SECRET=$$(openssl rand -hex 32)" > .env
	@echo "PAPERCLIP_PUBLIC_URL=http://localhost:$(APP_PORT)" >> .env
	@echo "PORT=$(APP_PORT)" >> .env
	@echo "SERVE_UI=true" >> .env
	@echo ".env created."

## Install dependencies
install:
	pnpm install

## Run onboard (first-time config, skips prompts)
onboard:
	pnpm paperclipai onboard --yes

## Generate the first admin invite URL
bootstrap-ceo:
	pnpm paperclipai auth bootstrap-ceo

## Start dev server with hot reload
dev: .env
	pnpm dev

## Full first-time setup: .env + install + onboard
setup: .env install onboard
	@echo ""
	@echo "Setup complete. Run 'make dev' to start, then 'make bootstrap-ceo' to create the first admin."
