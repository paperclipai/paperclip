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
  && usermod -g $USER_GID -d /valadrien-os node

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
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/valadrien-os-plugin-fake-sandbox/package.json packages/plugins/valadrien-os-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @valadrien-os/ui build
RUN pnpm --filter @valadrien-os/plugin-sdk build
RUN pnpm --filter @valadrien-os/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /valadrien-os \
  && chown node:node /valadrien-os

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/valadrien-os \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  VALADRIEN_OS_HOME=/valadrien-os \
  VALADRIEN_OS_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  VALADRIEN_OS_CONFIG=/valadrien-os/instances/default/config.json \
  VALADRIEN_OS_DEPLOYMENT_MODE=authenticated \
  VALADRIEN_OS_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  IS_SANDBOX=1 \
  CLAUDE_CODE_FORCE_SANDBOX=0

# CLAUDE_CODE_FORCE_SANDBOX=0 (the operative fix) + IS_SANDBOX=1: this container IS the
# isolation boundary, so the claude CLI must NOT spawn its own nested Bash sandbox. That
# sandbox runs shell commands as a synthetic unprivileged uid (e.g. 1051) with no
# /etc/passwd entry -> it synthesizes a home at /home/sbx_user<uid> and can't create it
# (/home is root:root 755), AND can't write the node-owned /valadrien-os/.claude/session-env
# -> every Bash-using agent run dies (`adapter_failed: ENOENT mkdir /home/sbx_user<uid>`).
# It engages on the OS's --allowedTools execution path. Verified in-container: with
# CLAUDE_CODE_FORCE_SANDBOX=0, `--allowedTools Bash` runs `whoami` -> `node` and succeeds.
# Coordination-only agents (the CEO) historically masked it by not running Bash.

# VOLUME removed for Railway: Railway provisions persistent storage via its own
# Volume system (attached to the service), not the Dockerfile VOLUME instruction,
# which it rejects ("docker VOLUME ... is not supported, use Railway Volumes").
# Local docker-compose still mounts /valadrien-os via its own volume config.
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
