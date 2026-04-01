FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
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
COPY patches/ patches/

RUN pnpm install --no-frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @ironworksai/ui build
RUN pnpm --filter @ironworksai/plugin-sdk build
RUN pnpm --filter @ironworksai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
WORKDIR /app
COPY --chown=node:node --from=build /app /app
# SEC-INFRA-001: Pin AI CLI tools to specific versions for reproducible builds
RUN npm install --global --omit=dev @anthropic-ai/claude-code@1.0.16 @openai/codex@0.1.2 opencode-ai@0.3.0 \
  && mkdir -p /ironworks \
  && chown node:node /ironworks

ENV NODE_ENV=production \
  HOME=/ironworks \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  IRONWORKS_HOME=/ironworks \
  IRONWORKS_INSTANCE_ID=default \
  IRONWORKS_CONFIG=/ironworks/instances/default/config.json \
  IRONWORKS_DEPLOYMENT_MODE=authenticated \
  IRONWORKS_DEPLOYMENT_EXPOSURE=private

VOLUME ["/ironworks"]
EXPOSE 3100

USER node
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
