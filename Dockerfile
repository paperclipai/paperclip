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
ARG CCROTATE_REF=882e62ac7111ed29efd56861241eed4b4fe956b0
ARG CLAUDE_K8S_REF=17a44d4f66b03889ca662744b3e7a396d511c6f2
ARG OPENCODE_K8S_REF=241d6f48876e3e9b11c1cd4714264d742e1ae97c

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

# github-mcp-server: official Go binary for GitHub's MCP server. We bundle
# it in the image so claude can spawn it as a stdio MCP, which sidesteps
# the per-request Authorization header dance the http transport requires
# (the binary reads GITHUB_PERSONAL_ACCESS_TOKEN from env at startup).
# Pin to a release tag — bump deliberately, not via :latest.
FROM ghcr.io/github/github-mcp-server:v1.0.3 AS github-mcp

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @kkroo/paperclip-plugin-ccrotate build
RUN pnpm --filter @kkroo/paperclip-plugin-linear build
RUN pnpm --filter paperclip-plugin-alertmanager build
RUN pnpm --filter @paperclipai/mcp-server build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
# The seed-init in the helm chart looks for this file to decide whether
# to write /paperclip/.mcp.json. Fail the build if it's missing instead
# of silently shipping an image where the seed quietly skips.
RUN test -f packages/mcp-server/dist/stdio.js || (echo "ERROR: mcp-server stdio bridge missing" && exit 1)

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
COPY --from=github-mcp /server/github-mcp-server /usr/local/bin/github-mcp-server
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

# Codex 2nd-opinion CLI wrapper for claude_k8s agents (BLO-2413).
# Lets a claude session shell out to `paperclip-consult-codex "<prompt>"`
# and get back codex's JSONL — used by the gstack /codex skill for the
# "200 IQ adversary" external opinion. ccrotate handles per-target cred
# rotation (--target codex). See .planning/codex-second-opinion.md in
# the k8s repo for the full design and risk register.
COPY scripts/paperclip-consult-codex.sh /usr/local/bin/paperclip-consult-codex
RUN chmod +x /usr/local/bin/paperclip-consult-codex

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
