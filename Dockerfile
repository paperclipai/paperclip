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

FROM base AS vendor
WORKDIR /vendor
# Pinned commit SHAs for the kkroo forks of ccrotate + the two k8s-Job
# adapters. Bump these together by pushing the fork branch and updating the
# ARG. Public repos, so no auth required at clone time.
#
# Each repo's build → `pnpm pack` (or `npm pack`) produces the .tgz the
# production stage installs. We never commit the tgz; it's reproduced on
# every image build.
ARG CCROTATE_REF=ac21f34918ca3d440b235f5fe3b511db5860d4ee
ARG CLAUDE_K8S_REF=41f6eef46d0c215ce27e04d2f40597e7fcb2b95a
ARG OPENCODE_K8S_REF=5b75cfdb050e62b2007109fe0b428c9ebc255352

RUN git clone https://github.com/kkroo/ccrotate.git ccrotate \
  && cd ccrotate && git checkout "${CCROTATE_REF}" \
  && pnpm install --frozen-lockfile \
  && pnpm run build \
  && cd dist && npm pack \
  && mv ccrotate-*.tgz /vendor/ccrotate.tgz

RUN git clone https://github.com/kkroo/paperclip-adapter-claude-k8s.git claude-k8s \
  && cd claude-k8s && git checkout "${CLAUDE_K8S_REF}" \
  && npm ci \
  && npm run build \
  && npm pack \
  && mv paperclip-adapter-claude-k8s-*.tgz /vendor/paperclip-adapter-claude-k8s.tgz

RUN git clone https://github.com/kkroo/paperclip-adapter-opencode-k8s.git opencode-k8s \
  && cd opencode-k8s && git checkout "${OPENCODE_K8S_REF}" \
  && npm ci \
  && npm run build \
  && npm pack \
  && mv paperclip-adapter-opencode-k8s-*.tgz /vendor/paperclip-adapter-opencode-k8s.tgz

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
# ccrotate (per-account token rotator the heartbeat ccrotate-tier-gate at
# server/src/services/ccrotate-tier-gate.ts shells out to) and the kkroo
# forks of paperclip-adapter-claude-k8s / paperclip-adapter-opencode-k8s
# are built from source in the `vendor` stage above and installed here.
# Refresh procedure:
#   1. push the relevant kkroo fork branch (kkroo/ccrotate#main,
#      kkroo/paperclip-adapter-claude-k8s#master,
#      kkroo/paperclip-adapter-opencode-k8s#master)
#   2. bump the *_REF ARG in the `vendor` stage
COPY --from=vendor /vendor/ccrotate.tgz /tmp/ccrotate.tgz
RUN mkdir -p /tmp/paperclip-bundled-adapters
COPY --from=vendor /vendor/paperclip-adapter-claude-k8s.tgz /tmp/paperclip-bundled-adapters/
COPY --from=vendor /vendor/paperclip-adapter-opencode-k8s.tgz /tmp/paperclip-bundled-adapters/
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai /tmp/ccrotate.tgz \
  && rm /tmp/ccrotate.tgz \
  # Upstream ccrotate@1.1.0 bug: dist/cli.js reads `new URL("../package.json", import.meta.url)`,
  # which resolves to /usr/local/lib/node_modules/package.json (one level above the ccrotate
  # package dir) when installed globally — that file does not exist. Source layout (dist/cli.js
  # next to dist/package.json) makes `..` jump out of the package. Rewrite to `./package.json`
  # so the bundled CLI finds its own manifest. Remove this line when the upstream fix lands.
  && sed -i 's|new URL("../package.json"|new URL("./package.json"|' /usr/local/lib/node_modules/ccrotate/cli.js \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client rsync jq zsh \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip /paperclip/.local/bin /opt/paperclip-bundled-adapters \
  && npm install --prefix /opt/paperclip-bundled-adapters --omit=dev --no-save /tmp/paperclip-bundled-adapters/*.tgz \
  && rm -rf /tmp/paperclip-bundled-adapters \
  && ln -sf /usr/local/bin/claude /paperclip/.local/bin/claude \
  && chown -R node:node /paperclip /opt/paperclip-bundled-adapters

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
