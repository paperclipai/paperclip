FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
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
COPY packages/adapters/openclaw/package.json packages/adapters/openclaw/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
WORKDIR /app

# 1. Install system tools + create user (cached, rarely changes)
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/* \
  && useradd -m -d /paperclip -s /bin/bash paperclip

# 2. Install global CLI tools (cached unless version changes)
RUN pnpm add -g @anthropic-ai/claude-code@2.1.71 @openai/codex@0.111.0

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

# 3. Copy built app last (busts on every source change, doesn't bust steps 1-2)
COPY --from=build /app /app
RUN pnpm prune --prod \
  && chown -R paperclip:paperclip /app /paperclip

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
