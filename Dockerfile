# syntax=docker/dockerfile:1.20

# ---------- Hermes runtime from pinned stable release ----------
# The verifier stage gates the COPY --from= chain below: if the pinned Hermes
# image restructures and any of the binaries the production stage expects goes
# missing, the build aborts here with a clear diagnostic instead of producing
# a broken runtime. Probe paths come from
# openspec/changes/fix-docker-deploy-and-verify-hermes/image-inspection.md
# (PR #1); if inspection turns up a different layout, update the probes and
# the COPY --from lines in one shot.
ARG HERMES_AGENT_IMAGE=nousresearch/hermes-agent:v2026.6.19
FROM ${HERMES_AGENT_IMAGE} AS hermes_runtime_verify
RUN set -eux; \
  test -f /opt/hermes/.venv/bin/hermes      || { echo "Hermes verify FAILED: /opt/hermes/.venv/bin/hermes missing (see openspec/changes/fix-docker-deploy-and-verify-hermes/image-inspection.md probe 4)"; exit 1; }; \
  test -f /opt/hermes/.venv/bin/hermes-agent || { echo "Hermes verify FAILED: /opt/hermes/.venv/bin/hermes-agent missing (probe 5)"; exit 1; }; \
  test -f /opt/hermes/.venv/bin/hermes-acp   || { echo "Hermes verify FAILED: /opt/hermes/.venv/bin/hermes-acp missing (probe 6)"; exit 1; }; \
  test -f /usr/local/bin/uv                 || { echo "Hermes verify FAILED: /usr/local/bin/uv missing (probe 7)"; exit 1; }; \
  test -f /usr/local/bin/uvx                || { echo "Hermes verify FAILED: /usr/local/bin/uvx missing (probe 8)"; exit 1; }

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
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# Hermes runtime from pinned image (production COPYs chain through
# hermes_runtime_verify, so the test-f probes above must succeed first).
COPY --from=hermes_runtime_verify /opt/hermes /opt/hermes
COPY --from=hermes_runtime_verify /usr/local/bin/uv /usr/local/bin/uv
COPY --from=hermes_runtime_verify /usr/local/bin/uvx /usr/local/bin/uvx
RUN ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
  && ln -s /opt/hermes/.venv/bin/hermes-agent /usr/local/bin/hermes-agent \
  && ln -s /opt/hermes/.venv/bin/hermes-acp /usr/local/bin/hermes-acp \
  && chown -R node:node /opt/hermes \
  && mkdir -p /paperclip/.hermes \
  && chown node:node /paperclip/.hermes \
  && hermes --version

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
  HERMES_HOME=/paperclip/.hermes \
  PYTHONUNBUFFERED=1 \
  PATH=/opt/hermes/.venv/bin:${PATH} \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
