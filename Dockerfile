# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 ffmpeg espeak-ng fonts-dejavu-core \
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
# Safe one-shot source patch: mounts the SINK DINK direct Gemini bridge route before TypeScript build.
# This script is idempotent and does not execute any external API call.
RUN node scripts/patch-sink-dink-gemini-bridge.mjs
# Safe one-shot source patch: mounts the SINK DINK media output route before TypeScript build.
# This script is idempotent and does not execute any external API call.
RUN node scripts/patch-sink-dink-media-output.mjs
# Safe one-shot source patch: lowers ffmpeg render cost for Render/free-tier stability.
# This script is idempotent and does not execute any external API call.
RUN node scripts/patch-media-output-low-resource.mjs
# Safe one-shot source patch: mounts the controlled SINK DINK agent workflow route.
# This script is idempotent and does not execute any external API call.
RUN node scripts/patch-sink-dink-agent-workflow.mjs
# Safe one-shot source patch: fixes strict TypeScript annotations needed by Hugging Face Docker build.
# This script is idempotent and only changes local build context files.
RUN node scripts/patch-hf-typecheck.mjs
# NOTE: Gemini direct API patch script is intentionally not executed here.
# The previous build hook broke Docker deploy due nested generated template strings.
# Keep the script in the repo for future repair, but do not run it during production build.
# Production-targeted build: avoid plugin examples and smoke-test packages in Render.
RUN pnpm run preflight:workspace-links \
  && pnpm --filter @paperclipai/ui build \
  && pnpm --filter @paperclipai/server... build \
  && pnpm --filter @paperclipai/server prepare:ui-dist
RUN node scripts/patch-production-workspace-exports.mjs
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
RUN test -f packages/db/dist/index.js || (echo "ERROR: db build output missing" && exit 1)
RUN test -f packages/shared/dist/index.js || (echo "ERROR: shared build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq ffmpeg espeak-ng fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    PATH="/app/cli/bin:/app/node_modules/.bin:${PATH}"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
USER node
EXPOSE 8080
CMD ["node", "/app/server/dist/index.js"]