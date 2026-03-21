# ── Stage 1: base ─────────────────────────────────────────────
# Pinned Node 22 on Debian Trixie slim for reproducibility.
FROM node:22-trixie-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# ── Stage 2: deps ─────────────────────────────────────────────
# Install only production + build dependencies using lockfile.
FROM base AS deps
WORKDIR /app

# Copy workspace manifests first (layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY packages/plugins/create-paperclip-plugin/package.json packages/plugins/create-paperclip-plugin/
COPY desktop/package.json desktop/

RUN pnpm install --frozen-lockfile

# ── Stage 3: build ────────────────────────────────────────────
# Build UI and server from source.
FROM base AS build
WORKDIR /app

COPY --from=deps /app /app
COPY . .

RUN pnpm --filter @paperclipai/ui build \
  && pnpm --filter @paperclipai/server build \
  && test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# Prune dev dependencies after build
RUN pnpm prune --prod --no-optional

# ── Stage 4: production ───────────────────────────────────────
# Minimal runtime image — no build tools, no source code bloat.
FROM node:22-trixie-slim AS production

# Labels for container registries
LABEL org.opencontainers.image.source="https://github.com/paperclipinc/paperclip"
LABEL org.opencontainers.image.description="Paperclip — AI company orchestration platform"
LABEL org.opencontainers.image.vendor="Paperclip Inc."
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Install agent runtimes globally
RUN npm install --global --omit=dev \
    @anthropic-ai/claude-code@latest \
    @openai/codex@latest \
    opencode-ai \
  && npm cache clean --force

# Create data directory
RUN mkdir -p /paperclip && chown node:node /paperclip

WORKDIR /app

# Copy only built artifacts and production dependencies
COPY --chown=node:node --from=build /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server ./server
COPY --chown=node:node --from=build /app/ui/dist ./ui/dist
COPY --chown=node:node --from=build /app/cli ./cli
COPY --chown=node:node --from=build /app/packages ./packages

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

VOLUME ["/paperclip"]
EXPOSE 3100

# Run as non-root
USER node

# Use tini as PID 1 for proper signal handling
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3100/api/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
