FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN corepack prepare pnpm@9.15.4 --activate

FROM base AS build
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

RUN pnpm fetch --frozen-lockfile \
  && pnpm install --frozen-lockfile --offline

COPY tsconfig.json tsconfig.base.json ./
COPY cli/src cli/src
COPY server server
COPY ui ui
COPY packages packages
COPY scripts/prepare-server-ui-dist.sh scripts/prepare-server-ui-dist.sh

RUN pnpm --filter @paperclipai/server prepare:ui-dist \
  && pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
WORKDIR /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && mkdir -p /paperclip \
  && printf '%s\n' '#!/bin/sh' 'exec node /app/cli/node_modules/tsx/dist/cli.mjs /app/cli/src/index.ts "$@"' > /usr/local/bin/paperclipai \
  && chmod +x /usr/local/bin/paperclipai \
  && chown node:node /paperclip
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json /app/
COPY --from=build /app/cli/package.json /app/cli/package.json
COPY --from=build /app/cli/node_modules /app/cli/node_modules
COPY --from=build /app/cli/src /app/cli/src
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/server/package.json /app/server/package.json
COPY --from=build /app/server/node_modules /app/server/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/server/ui-dist /app/server/ui-dist
COPY --from=build /app/packages /app/packages
COPY --chown=node:node skills /app/skills

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
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD sh -c 'curl -fsS "http://127.0.0.1:${PORT:-3100}/api/health" >/dev/null || exit 1'

USER node
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
