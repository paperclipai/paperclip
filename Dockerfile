FROM node:22-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl git wget ripgrep python3 unzip \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O/etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && echo "6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b  /etc/apt/keyrings/githubcli-archive-keyring.gpg" | sha256sum -c - \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
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
RUN pnpm --filter @paperclipai/adapter-utils build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
# Set home directory early to avoid conflicts in incremental builds
RUN usermod -d /paperclip node
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# --- Skill-pack persistence: ensure all 25 bundled skills are present in /app/skills ---
# The .agents/skills/ directory holds 6 Paperclip operational skills (company-creator,
# create-agent-adapter, doc-maintenance, pr-report, release, release-changelog).
# The poly-weather/skills/ directory holds 12 Poly-weather reliability+wallet skills.
# Copy them explicitly so the pi-local adapter can discover them at /app/skills/*/SKILL.md.
COPY --chown=node:node .agents/skills/company-creator /app/skills/company-creator
COPY --chown=node:node .agents/skills/create-agent-adapter /app/skills/create-agent-adapter
COPY --chown=node:node .agents/skills/doc-maintenance /app/skills/doc-maintenance
COPY --chown=node:node .agents/skills/pr-report /app/skills/pr-report
COPY --chown=node:node .agents/skills/release /app/skills/release
COPY --chown=node:node .agents/skills/release-changelog /app/skills/release-changelog
COPY --chown=node:node poly-weather/skills/exit-event-integrity-check /app/skills/exit-event-integrity-check
COPY --chown=node:node poly-weather/skills/trade-contract-validator /app/skills/trade-contract-validator
COPY --chown=node:node poly-weather/skills/scan-invariant-monitor /app/skills/scan-invariant-monitor
COPY --chown=node:node poly-weather/skills/config-parity-auditor /app/skills/config-parity-auditor
COPY --chown=node:node poly-weather/skills/forecast-provenance-auditor /app/skills/forecast-provenance-auditor
COPY --chown=node:node poly-weather/skills/probability-calibration-evaluator /app/skills/probability-calibration-evaluator
COPY --chown=node:node poly-weather/skills/wallet-intel-resolver /app/skills/wallet-intel-resolver
COPY --chown=node:node poly-weather/skills/wallet-strategy-profiler /app/skills/wallet-strategy-profiler
COPY --chown=node:node poly-weather/skills/wallet-edge-attribution /app/skills/wallet-edge-attribution
COPY --chown=node:node poly-weather/skills/wallet-cohort-monitor /app/skills/wallet-cohort-monitor
COPY --chown=node:node poly-weather/skills/wallet-copytrade-simulator /app/skills/wallet-copytrade-simulator
COPY --chown=node:node poly-weather/skills/wallet-anomaly-flagger /app/skills/wallet-anomaly-flagger

COPY scripts/docker-entrypoint.sh /usr/local/bin/
COPY scripts/verify-skills.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/verify-skills.sh

# hermes-bridge.sh bridges the hermes_local adapter to the hermes-agent sidecar container.
# hermes CLI is at /opt/hermes/.venv/bin/hermes inside hermes-agent — NOT in its $PATH.
COPY scripts/hermes-bridge.sh /app/scripts/hermes-bridge.sh
RUN chmod +x /app/scripts/hermes-bridge.sh

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

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
