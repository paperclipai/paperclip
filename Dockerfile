# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches ./patches
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/claude-tui/package.json packages/adapters/claude-tui/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/deepseek-api/package.json packages/adapters/deepseek-api/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY packages/plugins/create-paperclip-plugin/package.json packages/plugins/create-paperclip-plugin/
COPY packages/plugins/examples/plugin-authoring-smoke-example/package.json packages/plugins/examples/plugin-authoring-smoke-example/
COPY packages/plugins/examples/plugin-file-browser-example/package.json packages/plugins/examples/plugin-file-browser-example/
COPY packages/plugins/examples/plugin-hello-world-example/package.json packages/plugins/examples/plugin-hello-world-example/
COPY packages/plugins/examples/plugin-kitchen-sink-example/package.json packages/plugins/examples/plugin-kitchen-sink-example/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-operator-assistant/package.json packages/plugins/plugin-operator-assistant/

RUN pnpm install

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
ARG CACHE_BUST=1
COPY . .
RUN rm -rf ui/dist server/ui-dist server/dist \
  && pnpm --filter "@paperclipai/ui..." build \
  && mkdir -p server/ui-dist \
  && cp -R ui/dist/. server/ui-dist/ \
  && node -e "const fs=require('fs');const path=require('path');const root='server/ui-dist';const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const refs=[...html.matchAll(/(?:src|href)=['\\\"](\\/assets\\/[^'\\\"]+)/g)].map((m)=>m[1]);const missing=refs.filter((ref)=>!fs.existsSync(path.join(root,ref)));if(missing.length){console.error('Missing UI assets referenced by index.html:',missing.join(', '));process.exit(1);}"
RUN pnpm --filter "@paperclipai/server..." build
RUN pnpm --filter "@paperclipai/mcp-server" build
RUN pnpm --filter "@paperclipai/plugin-llm-wiki" build
RUN pnpm --filter "@paperclipai/plugin-operator-assistant" build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
RUN test -f packages/mcp-server/dist/stdio.js || (echo "ERROR: Paperclip MCP build output missing" && exit 1)
RUN node --import ./server/node_modules/tsx/dist/loader.mjs -e "import('./packages/mcp-server/dist/tools.js')"

FROM base AS production
WORKDIR /app
COPY --from=build /app /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu postgresql-client bsdextrautils zbar-tools ffmpeg python3 python3-pip python3-venv libgtk-3-0t64 && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=2.1.141
ARG CODEX_VERSION=0.144.1
ARG AGENT_BROWSER_VERSION=0.27.0
ARG CAMOUFOX_VERSION=0.4.11
ARG CAMOUFOX_PLAYWRIGHT_VERSION=1.49.1
# claude-p: drop-in `claude -p` replacement that drives the interactive Claude
# Code TUI in a PTY (used by the claude_tui adapter). Ships a prebuilt glibc
# binary via npm postinstall; base image is Debian (glibc) so it runs as-is.
ARG CLAUDE_P_VERSION=0.1.0
RUN npm install --global --omit=dev @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} claude-p@${CLAUDE_P_VERSION} playwright agent-browser@${AGENT_BROWSER_VERSION}

# Camoufox is the managed fallback when Chromium automation reaches a durable
# bot challenge. Keep it isolated from the system Python and fetch its pinned
# Firefox build during image creation so agent runs never install code at runtime.
RUN python3 -m venv /opt/camoufox \
  && /opt/camoufox/bin/pip install --no-cache-dir "camoufox==${CAMOUFOX_VERSION}" "playwright==${CAMOUFOX_PLAYWRIGHT_VERSION}" \
  && mkdir -p /opt/runtime-cache \
  && XDG_CACHE_HOME=/opt/runtime-cache /opt/camoufox/bin/python -m camoufox fetch \
  && chmod 1777 /opt/runtime-cache \
  && ln -s /opt/camoufox/bin/camoufox /usr/local/bin/camoufox
RUN install -m 0755 /app/scripts/browser/paperclip-camoufox /usr/local/bin/paperclip-camoufox \
  && install -m 0755 /app/scripts/browser/paperclip-camoufox-python /usr/local/bin/paperclip-camoufox-python \
  && install -m 0755 /app/scripts/browser/paperclip-browser-open /usr/local/bin/paperclip-browser-open \
  && ln -sf /usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64 /usr/local/bin/agent-browser-real \
  && rm -f /usr/local/bin/agent-browser \
  && install -m 0755 /app/scripts/browser/agent-browser-managed /usr/local/bin/agent-browser

# Install Chromium + all system dependencies for headless browser automation
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install --with-deps chromium

# Create non-root user so Claude Code allows --dangerously-skip-permissions
RUN groupadd -r paperclip && useradd -r -g paperclip -m -d /paperclip -s /bin/bash paperclip
RUN mkdir -p /paperclip/instances/default && chown -R paperclip:paperclip /paperclip
RUN mkdir -p /app/data && chown paperclip:paperclip /app/data
RUN chmod 755 /app/entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  XDG_CACHE_HOME=/opt/runtime-cache \
  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["/app/entrypoint.sh"]
