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

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN cd server && npx tsc --noCheck && mkdir -p dist/onboarding-assets && cp -R src/onboarding-assets/. dist/onboarding-assets/
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
WORKDIR /app
COPY --from=build /app /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/* \
  && npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && mkdir -p /paperclip/instances/default/logs \
  && chown -R node:node /paperclip

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

EXPOSE 3100

COPY <<'ENTRYPOINT' /entrypoint.sh
#!/bin/sh
set -e

# Resolve Claude config dir: prefer CLAUDE_CONFIG_DIR, then $HOME/.claude
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-/paperclip}/.claude}"
export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"

echo "[entrypoint] whoami=$(whoami) uid=$(id -u) HOME=$HOME CLAUDE_CONFIG_DIR=$CLAUDE_DIR"

# Provision Claude Code OAuth credentials from env var (subscription auth)
if [ -n "$CLAUDE_CREDENTIALS_JSON" ]; then
  mkdir -p "$CLAUDE_DIR"
  printf '%s' "$CLAUDE_CREDENTIALS_JSON" > "$CLAUDE_DIR/.credentials.json"
  chown node:node "$CLAUDE_DIR" "$CLAUDE_DIR/.credentials.json"
  chmod 700 "$CLAUDE_DIR"
  chmod 600 "$CLAUDE_DIR/.credentials.json"
  echo "[entrypoint] Wrote credentials to $CLAUDE_DIR/.credentials.json"
fi

# Log auth env vars (redacted)
echo "[entrypoint] CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:+set (${#CLAUDE_CODE_OAUTH_TOKEN} chars)}"
echo "[entrypoint] ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+set}"
echo "[entrypoint] config dir contents:"
ls -la "$CLAUDE_DIR" 2>/dev/null || echo "  (dir does not exist)"

chown -R node:node /paperclip
exec gosu node node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
ENTRYPOINT
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
