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
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
# Koenig customization 2026-04-30: also build the CLI so `paperclipai` is available inside the container.
# The CLI package is published as `paperclipai` (not `@paperclipai/cli`) — pnpm filter must match.
RUN pnpm --filter paperclipai build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
RUN test -f cli/dist/index.js || (echo "ERROR: cli build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
# Koenig customization 2026-05-01: add chromium + lighthouse + Playwright for QA Verifier (KOEA-251)
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai lighthouse playwright \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq chromium fonts-liberation libnss3 libasound2t64 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Koenig customization 2026-04-30: install `paperclipai` CLI wrapper so company import / onboard
# work inside the container the same way they would on a host.
RUN printf '#!/bin/sh\nexec node /app/cli/dist/index.js "$@"\n' > /usr/local/bin/paperclipai \
    && chmod +x /usr/local/bin/paperclipai

# Koenig customization 2026-05-01: hermes-agent install for hermes_local adapter.
# The host-side hermes binary is a Mach-O Python launcher that won't run in this
# Linux container; install hermes-agent into a container-local venv and provide a
# wrapper script. The hermes-agent SOURCE is bind-mounted at runtime via the
# compose file (/paperclip/.hermes/hermes-agent/) — install from that path.
# Runtime dep: the source must be present at /paperclip/.hermes/hermes-agent before
# any hermes_local agent runs. The wrapper handles the case where it isn't yet.
# 2026-05-01 (revised): venv create requires python3-venv apt package + build-essential
# for editable installs. Install hermes-agent eagerly at build time so the wrapper
# is just `exec /opt/hermes-venv/bin/hermes "$@"`. Bind-mount of host ~/.hermes is
# still required at runtime (provides the editable source it was installed from).
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends python3-venv python3-pip python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/hermes-venv \
    && /opt/hermes-venv/bin/pip install --no-cache-dir --upgrade pip \
    && chown -R ${USER_UID}:${USER_GID} /opt/hermes-venv
# hermes-py: thin wrapper that delegates to the venv hermes binary.
# The venv is populated at runtime from the bind-mounted ~/.hermes source
# by docker-entrypoint.sh. At image build time the source is not yet
# available, so we point directly at the venv binary — no lazy-install
# check needed since entrypoint handles install before any agent runs.
RUN printf '#!/bin/sh\nexec /opt/hermes-venv/bin/hermes "$@"\n' > /usr/local/bin/hermes-py \
    && chmod +x /usr/local/bin/hermes-py \
    && ln -sf /usr/local/bin/hermes-py /usr/local/bin/hermes-container

# Koenig customization 2026-05-01: cursor-agent Linux install for cursor adapter.
# The host's cursor-agent install is Mac arm64 only — bind-mounting it doesn't work
# on Linux. Download the Linux build directly + create a wrapper that uses the
# bundled node binary. Auth is API-key-based (CURSOR_API_KEY env var) since the
# Linux build can't read Mac Keychain.
ARG CURSOR_AGENT_VERSION=2026.04.30-4edb302
RUN mkdir -p /opt/cursor-agent/versions/${CURSOR_AGENT_VERSION} \
    && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/arm64/agent-cli-package.tar.gz" \
       -o /tmp/cursor-agent.tgz \
    && tar -xzf /tmp/cursor-agent.tgz -C /opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}/ \
    && rm /tmp/cursor-agent.tgz \
    && chmod +x /opt/cursor-agent/versions/${CURSOR_AGENT_VERSION}/dist-package/node \
    && printf '#!/bin/bash\nset -e\nSCRIPT_DIR=/opt/cursor-agent/versions/%s/dist-package\nexport CURSOR_INVOKED_AS="$(basename "$0")"\nexport NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-/tmp/cursor-compile-cache}"\nexec -a "$0" "$SCRIPT_DIR/node" --use-system-ca "$SCRIPT_DIR/index.js" "$@"\n' "${CURSOR_AGENT_VERSION}" > /usr/local/bin/cursor-agent \
    && chmod +x /usr/local/bin/cursor-agent \
    && ln -sf /usr/local/bin/cursor-agent /usr/local/bin/cursor \
    && ln -sf /usr/local/bin/cursor-agent /usr/local/bin/agent

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
  OPENCODE_ALLOW_ALL_MODELS=true \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
  NODE_PATH=/usr/local/lib/node_modules

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
