COMPOSE_FILE     := docker-compose.quickstart.yml
CONTAINER        := paperclip-paperclip-1
DATA_DIR         := $(or $(PAPERCLIP_DATA_DIR),./data/docker-paperclip)
CLI              := node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts

.PHONY: up down build logs restart clean onboard bootstrap-ceo exec claude codex

## up: Build (if needed) and start all services
up: .env
	docker compose -f $(COMPOSE_FILE) up --build -d

## down: Stop and remove containers
down:
	docker compose -f $(COMPOSE_FILE) down

## build: Build the Docker image without starting
build:
	docker compose -f $(COMPOSE_FILE) build

## logs: Tail container logs
logs:
	docker compose -f $(COMPOSE_FILE) logs -f

## restart: Restart all services
restart: down up

## onboard: Run onboard inside the container
onboard:
	docker exec -it $(CONTAINER) $(CLI) onboard --yes

## bootstrap-ceo: Generate the first admin invite URL
bootstrap-ceo:
	docker exec -it $(CONTAINER) $(CLI) auth bootstrap-ceo

## claude: Run Claude Code inside the container
claude:
	docker exec -it $(CONTAINER) claude

## codex: Run Codex inside the container
codex:
	docker exec -it $(CONTAINER) codex

## exec: Open a shell inside the container
exec:
	docker exec -it $(CONTAINER) bash

## clean: Stop containers and wipe the data directory for a fresh start
clean: down
	rm -rf $(DATA_DIR)

## help: Show available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | column -t -s ':'

.env:
	@echo "BETTER_AUTH_SECRET=$$(openssl rand -base64 32)" > .env
	@echo "Generated .env with BETTER_AUTH_SECRET"
