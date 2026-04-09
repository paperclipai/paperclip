# ── Stage 1: base ─────────────────────────────────────────────
FROM node:22-trixie-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl git tini wget ripgrep python3 \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O/etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && echo "20e0125d6f6e077a9ad46f03371bc26d90b04939fb95170f5a1905099cc6bcc0  /etc/apt/keyrings/githubcli-archive-keyring.gpg" | sha256sum -c - \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# ── Stage 2: deps ─────────────────────────────────────────────
# Install all dependencies (dev + prod) using lockfile.
# This layer is cached unless a package.json or lockfile changes.
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY desktop/package.json desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY patches/ patches/
COPY packages/plugins/create-paperclip-plugin/package.json packages/plugins/create-paperclip-plugin/
COPY packages/plugins/examples/plugin-authoring-smoke-example/package.json packages/plugins/examples/plugin-authoring-smoke-example/
COPY packages/plugins/examples/plugin-file-browser-example/package.json packages/plugins/examples/plugin-file-browser-example/
COPY packages/plugins/examples/plugin-hello-world-example/package.json packages/plugins/examples/plugin-hello-world-example/
COPY packages/plugins/examples/plugin-kitchen-sink-example/package.json packages/plugins/examples/plugin-kitchen-sink-example/

RUN pnpm install --frozen-lockfile

# ── Stage 3: build ────────────────────────────────────────────
FROM base AS build
WORKDIR /app

COPY --from=deps /app /app
COPY . .
RUN pnpm -r build \
  && test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# ── Stage 4: agent CLIs ──────────────────────────────────────
# Separate stage so agent CLI install is cached independently.
# Bump the versions here to update (avoids @latest cache-busting).
FROM base AS agent-clis

RUN npm install --global --omit=dev \
    @openai/codex@0.116.0 \
    opencode-ai@1.3.0 \
  && npm cache clean --force \
  && rm -rf /tmp/*

# ── Stage 5: production ──────────────────────────────────────
FROM node:22-trixie-slim AS production

LABEL org.opencontainers.image.source="https://github.com/paperclipinc/paperclip"
LABEL org.opencontainers.image.description="Paperclip - AI company orchestration platform"
LABEL org.opencontainers.image.vendor="Paperclip Inc."
LABEL org.opencontainers.image.licenses="MIT"

ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini curl git ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy pre-built agent CLIs from separate cached stage
COPY --from=agent-clis /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=agent-clis /usr/local/bin/ /usr/local/bin/

RUN mkdir -p /paperclip && chown node:node /paperclip

WORKDIR /app

COPY --chown=node:node --from=build /app /app

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true

VOLUME ["/paperclip"]
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3100/api/health || exit 1

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "--conditions=production", "server/dist/index.js"]
