# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
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
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/paperclip-plugin-ccrotate/package.json packages/plugins/paperclip-plugin-ccrotate/
COPY packages/plugins/paperclip-plugin-linear/package.json packages/plugins/paperclip-plugin-linear/
COPY packages/plugins/paperclip-plugin-alertmanager/package.json packages/plugins/paperclip-plugin-alertmanager/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @kkroo/paperclip-plugin-ccrotate build
RUN pnpm --filter @kkroo/paperclip-plugin-linear build
RUN pnpm --filter paperclip-plugin-alertmanager build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
# ccrotate is the per-account token rotator that the heartbeat ccrotate-tier-gate
# (server/src/services/ccrotate-tier-gate.ts) shells out to. With HOME=/paperclip,
# its profilesDir/claudeDir/configFile resolve into /paperclip/.ccrotate and
# /paperclip/.claude on the shared RWX PVC, so a single `ccrotate refresh` from
# inside this pod populates the gate's tier-cache in place.
#
# Vendored from ~/src/ccrotate@1.1.0 (upstream somersby10ml/ccrotate). 1.1.0 adds
# `--target codex`, `tier-cache` JSON output, and the `serviceTier` reporting the
# gate depends on — npm latest (1.0.13) lacks all three. Upgrade procedure:
#   cd ~/src/ccrotate && npm run build && cd dist && npm pack
#   mv ccrotate-<NEW>.tgz <kkroo>/vendor/
#   bump ARG CCROTATE_TARBALL below
COPY vendor/ccrotate-1.1.0.tgz /tmp/ccrotate.tgz
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai /tmp/ccrotate.tgz \
  && rm /tmp/ccrotate.tgz \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client rsync jq zsh \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip /paperclip/.local/bin \
  && ln -sf /usr/local/bin/claude /paperclip/.local/bin/claude \
  && chown -R node:node /paperclip

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

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
