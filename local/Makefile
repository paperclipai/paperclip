ADAPTER_SRC    := packages/adapters/openrouter-agent
ADAPTER_DEPLOY := $(HOME)/Projects/linkcast/crew/paperclip/companies/linkcast/adapters/paperclip-openrouter-agent

PROJECT       := paperclip-linkcast
COMPOSE_FILES := -f docker/docker-compose.yml -f local/compose/paperclip-boot-linkcast.yaml

.PHONY: all build-adapter sync-adapter build-container deploy-adapter deploy-container restart help

all: build-container build-adapter sync-adapter restart ## Full rebuild (container + adapter), sync, and restart

build-container: ## Rebuild the server Docker image (no cache for app source layers)
	docker compose -p $(PROJECT) $(COMPOSE_FILES) build \
	    --build-arg GIT_SHA=$$(git rev-parse --short HEAD) \
	    --build-arg BUILD_DATE=$$(date -u +%Y-%m-%dT%H:%M:%SZ) \
	    server

build-adapter: ## Compile the openrouter-agent adapter (npm run build only)
	cd $(ADAPTER_SRC) && npm run build
	printf '{"version":"%s","gitSha":"%s","buildDate":"%s"}\n' \
	    "$$(node -p "require('./$(ADAPTER_SRC)/package.json').version")" \
	    "$$(git rev-parse --short HEAD)" \
	    "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	    > $(ADAPTER_SRC)/dist/build-info.json

sync-adapter: ## Sync compiled adapter to the linkcast crew overlay
	mkdir -p $(ADAPTER_DEPLOY)
	rsync -a --delete --exclude=node_modules $(ADAPTER_SRC)/ $(ADAPTER_DEPLOY)/

deploy-adapter: build-adapter sync-adapter restart ## Compile adapter, sync to overlay, and restart

deploy-container: build-container restart ## Rebuild server image and restart

restart: ## Restart the Paperclip stack (via paperclip-control.sh)
	./local/bin/paperclip-control.sh restart

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'
