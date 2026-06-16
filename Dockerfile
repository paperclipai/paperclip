# syntax=harbor.blockcast.net/dockerfile/dockerfile:1.20
# Mirrored from docker.io/library/node:lts-trixie-slim to avoid Docker Hub
# anonymous rate limits on self-hosted BuildKit runners.
FROM harbor.blockcast.net/paperclip/node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
# Disable Debian's auto-clean of apt cache so the BuildKit cache mount
# below actually retains downloaded .deb files between builds. Without
# this the docker-clean apt hook nukes /var/cache/apt after each install,
# defeating the cache mount.
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
  && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && corepack enable

# Chromium runtime libs (BLO-3663) — required so headless Playwright works
# inside agent Job pods. Job pods inherit this base image (the heavier
# Dockerfile.agent toolchain isn't deployed for adapter Jobs), so the libs
# must live here. Without them, `mcp__playwright__browser_navigate` fails
# with `libglib-2.0.so.0: cannot open shared object file`, which is what
# blocks UXDesigner's visual STOP gate on BLO-3979 every run.
# Canonical list from `npx playwright install-deps chromium --dry-run` on
# trixie; `t64` suffixes are Debian 13's time_t-64 transition packages.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
       libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
       libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 \
       libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 \
       libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
       libxfixes3 libxkbcommon0 libxrandr2 \
       fonts-liberation fonts-noto-color-emoji

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
COPY packages/mcp-gateway/package.json packages/mcp-gateway/
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
COPY packages/plugins/paperclip-plugin-ccrotate/package.json packages/plugins/paperclip-plugin-ccrotate/
COPY packages/plugins/paperclip-plugin-gbrain/package.json packages/plugins/paperclip-plugin-gbrain/
COPY packages/plugins/paperclip-plugin-linear/package.json packages/plugins/paperclip-plugin-linear/
COPY packages/plugins/paperclip-plugin-alertmanager/package.json packages/plugins/paperclip-plugin-alertmanager/
COPY packages/plugins/paperclip-plugin-slack/package.json packages/plugins/paperclip-plugin-slack/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

# pnpm store mount: re-uses the content-addressable cache of downloaded
# tarballs between builds so we only fetch packages whose hashes
# actually changed since the last build. With --frozen-lockfile, hashes
# are pinned, so most builds get near-100% cache hits.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM base AS vendor
WORKDIR /vendor
# Pinned commit SHAs for the kkroo forks of the two k8s-Job adapters.
# Bump these by pushing the fork branch and updating the ARG. Public repos,
# so no auth required at clone time.
#
# Each repo's build → `pnpm pack` (or `npm pack`) produces the .tgz the
# production stage installs. We never commit the tgz; it's reproduced on
# every image build.
# Re-pinned 2026-06-03 (BLO-8909) to kkroo/paperclip-adapter-opencode-k8s
# master 3bbc0b3 (was 7415df5): default agentDbMode to workspace_subpath so
# the agent DB lives on a per-(agent, task) subPath of the shared RWX
# workspace data PVC instead of a per-agent RWO ceph-rbd PVC. Makes durable
# the BLO-8906 mitigation for the recurring opencode_k8s Multi-Attach on
# cross-node retry; dedicated_pvc remains explicit opt-in. Verified in
# cluster via BLO-8908.
# Re-pinned 2026-06-06 to kkroo/paperclip-adapter-opencode-k8s master 380aea4
# (was 2dba034): when OPENAI_API_KEY is configured, skip the OpenCode OAuth
# bootstrap and clear stale OpenCode auth/account files so API-key backed
# agents do not attempt a stale OAuth token refresh.
# Re-pinned 2026-06-06 to kkroo/paperclip-adapter-opencode-k8s master 2d8c7b4
# (was 380aea4): bound the ccrotate Codex preflight with `timeout 30s` so a
# stuck account probe cannot block opencode_k8s Jobs before OpenCode starts.
# (was 2d8c7b4): point AGENT_HOME at the external instructions-bundle root
# (PR kkroo/paperclip-adapter-opencode-k8s#21, BLO-10267) so opencode_k8s
# agents with an external bundle can read $AGENT_HOME/{HEARTBEAT,SOUL,TOOLS}.md
# + skills/*.md instead of 100%-failing with File-not-found.
ARG CLAUDE_K8S_REF=1d6a08f7c814208caa3bf2333dd7c35ca50b95ae
# Re-pinned 2026-06-14 to kkroo/paperclip-adapter-opencode-k8s master a533d11
# (was 168688e): BLO-10448 — a transient k8s status-read error during the
# completion poll was mislabeled as a deadline, surfacing as the bogus
# "Timed out after 0s" and discarding finished (exit 0) runs (dropped PR
# reviews on the Ally path). PR kkroo/paperclip-adapter-opencode-k8s#23;
# also picks up #22 (BLO-10315 shared-docs symlink, already merged upstream).
# Re-pinned 2026-06-16 (BLO-10651) to 82c3cb2: reconciled type-crash
# classification + 5-strike adapter crashloop circuit-breaker, so a gpt-5.5
# response item missing `type` no longer crashlooped every OpenCode agent.
# Bumped 2026-06-16 (BLO-10651) to e38117b: pin agent runtime caches under the
# writable home (/paperclip/.runtime-cache) instead of inheriting the server's
# /runtime-cache mount, which agent pods don't mount — opencode agents whose
# adapterConfig.env lacked cache overrides were crashing at startup with
# EACCES mkdir '/runtime-cache' (adapter_failed). Makes per-agent cache env
# overrides redundant belt-and-suspenders.
ARG OPENCODE_K8S_REF=e38117bdf54d760685ab002a94ffa810c7412273

# Pack paperclip's in-tree adapter-utils so the bundled adapters consume
# the workspace version (may include exports newer than the latest
# npm-published canary). Source is pulled from the `deps` stage rather
# than the build context — local pnpm leaves a node_modules symlink in
# packages/adapter-utils that targets the workspace's .pnpm store outside
# the build context, and BuildKit's cache-key walker follows it and
# fails with `short read: unexpected EOF` even when .dockerignore
# excludes node_modules. The deps stage already has properly-resolved
# node_modules baked into its image layer.
# Source from the build context (the deps stage only has package.json,
# not src/ — pnpm install doesn't materialize source). The CI workflow
# nukes stale node_modules pre-build (.github/workflows/docker.yml) and
# .dockerignore excludes **/node_modules; local builds use a git-archive
# context that has no node_modules at all. Either way, BuildKit doesn't
# trip on the pnpm symlinks during context walk.
#
# `npm install --no-save` gets a freestanding copy of typescript, and
# the printf rewrites tsconfig.json to a self-contained version (the
# original extends `../../tsconfig.base.json`, which doesn't resolve
# here since we only copied the package, not the monorepo).
COPY packages/adapter-utils /vendor/adapter-utils-src
RUN cd /vendor/adapter-utils-src \
  && rm -rf node_modules \
  && printf '%s\n' '{' \
       '  "compilerOptions": {' \
       '    "target": "ES2023",' \
       '    "module": "NodeNext",' \
       '    "moduleResolution": "NodeNext",' \
       '    "esModuleInterop": true,' \
       '    "strict": true,' \
       '    "skipLibCheck": true,' \
       '    "declaration": true,' \
       '    "declarationMap": true,' \
       '    "sourceMap": true,' \
       '    "outDir": "dist",' \
       '    "rootDir": "src",' \
       '    "forceConsistentCasingInFileNames": true,' \
       '    "resolveJsonModule": true,' \
       '    "isolatedModules": true' \
       '  },' \
       '  "include": ["src"],' \
       '  "exclude": ["**/*.test.ts"]' \
       '}' > tsconfig.json \
  && npm install --no-save --cache /root/.npm typescript@^5.7.3 @types/node@^24.6.0 \
  && npx tsc \
  && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(!p.publishConfig||!p.publishConfig.exports){console.error('FATAL: package.json missing publishConfig.exports — cannot rewrite for npm pack');process.exit(1);}Object.assign(p,p.publishConfig);delete p.publishConfig.exports;delete p.publishConfig.main;delete p.publishConfig.types;if(typeof p.exports!=='object'||!p.exports['.']||!p.exports['./*']){console.error('FATAL: rewritten exports missing required entries (./* and .)',p.exports);process.exit(1);}fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
  && npm pack \
  && mv paperclipai-adapter-utils-*.tgz /vendor/adapter-utils.tgz \
  && rm -rf /vendor/adapter-utils-src

# Vendor-stage installs benefit from cache mounts too: pinned REFs mean
# the layer invalidates only on bumps, but inside each invalidated
# rebuild we still re-resolve every transitive dep. The pnpm and npm
# caches let those resolutions reuse tarballs from prior builds.

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=secret,id=gh_token \
    GH="$(cat /run/secrets/gh_token)" \
 && git -c "url.https://x-access-token:${GH}@github.com/.insteadOf=https://github.com/" \
      clone https://github.com/kkroo/paperclip-adapter-claude-k8s.git claude-k8s \
  && cd claude-k8s && git checkout "${CLAUDE_K8S_REF}" && rm -rf .git \
  && npm ci \
  && npm install --no-save /vendor/adapter-utils.tgz \
  && npm run build \
  && npm pack \
  && mv paperclip-adapter-claude-k8s-*.tgz /vendor/paperclip-adapter-claude-k8s.tgz

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=secret,id=gh_token \
    GH="$(cat /run/secrets/gh_token)" \
 && git -c "url.https://x-access-token:${GH}@github.com/.insteadOf=https://github.com/" \
      clone https://github.com/kkroo/paperclip-adapter-opencode-k8s.git opencode-k8s \
  && cd opencode-k8s && git checkout "${OPENCODE_K8S_REF}" && rm -rf .git \
  && npm ci \
  && npm install --no-save /vendor/adapter-utils.tgz \
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
RUN pnpm --filter @kkroo/paperclip-plugin-gbrain build
RUN pnpm --filter @kkroo/paperclip-plugin-linear build
RUN pnpm --filter paperclip-plugin-alertmanager build
RUN pnpm --filter paperclip-plugin-slack build
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
# The kkroo forks of paperclip-adapter-claude-k8s /
# paperclip-adapter-opencode-k8s are built from source in the `vendor` stage
# above and installed here.
#
# Do not install a local ccrotate CLI in this image. Paperclip production uses
# ccrotate-auth-bot / ccrotate-serve as the source of truth; a baked local
# rotator can read stale PVC state and switch agents onto exhausted accounts.
# Refresh procedure:
#   1. push the relevant kkroo fork branch (kkroo/paperclip-adapter-claude-k8s#master,
#      kkroo/paperclip-adapter-opencode-k8s#master)
#   2. bump the *_REF ARG in the `vendor` stage
RUN mkdir -p /tmp/paperclip-bundled-adapters
COPY --from=vendor /vendor/paperclip-adapter-claude-k8s.tgz /tmp/paperclip-bundled-adapters/
COPY --from=vendor /vendor/paperclip-adapter-opencode-k8s.tgz /tmp/paperclip-bundled-adapters/
# Bundle the in-tree adapter-utils alongside the adapter tgzs so the
# `npm install` below resolves `@paperclipai/adapter-utils` from local source
# (matching what the adapter built against in the vendor stage) instead of
# falling back to whatever npm publishes today.
COPY --from=vendor /vendor/adapter-utils.tgz /tmp/paperclip-bundled-adapters/
COPY --from=github-mcp /server/github-mcp-server /usr/local/bin/github-mcp-server
# Pin OpenCode for k8s agent pods (BLO-10651). opencode_k8s runs inside this
# image, so `opencode-ai@latest` lets unrelated rebuilds pick up parser/runtime
# changes that can crash every OpenCode-backed agent. Bump only after adapter
# smoke/regression tests pass.
ARG OPENCODE_AI_VERSION=1.4.3
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    npm install --global --omit=dev --cache /root/.npm @anthropic-ai/claude-code@latest @openai/codex@latest "opencode-ai@${OPENCODE_AI_VERSION}" @google/gemini-cli@latest \
  && test "$(opencode --version)" = "${OPENCODE_AI_VERSION}" \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client rsync jq zsh \
  && mkdir -p /paperclip /paperclip/.local/bin /opt/paperclip-bundled-adapters \
  && npm install --prefix /opt/paperclip-bundled-adapters --omit=dev --no-save --legacy-peer-deps --cache /root/.npm /tmp/paperclip-bundled-adapters/*.tgz \
  && rm -rf /tmp/paperclip-bundled-adapters \
  && ln -sf /usr/local/bin/claude /paperclip/.local/bin/claude \
  && chown -R node:node /paperclip /opt/paperclip-bundled-adapters

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Codex 2nd-opinion CLI wrapper for claude_k8s agents (BLO-2413).
# Lets a claude session shell out to `paperclip-consult-codex "<prompt>"`
# and get back codex's JSONL — used by the gstack /codex skill for external
# review. Production no longer installs a local ccrotate CLI, so this wrapper
# uses whatever Codex auth the pod already has.
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
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
