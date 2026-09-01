# syntax=docker/dockerfile:1.20
FROM node:24-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 tini \
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
COPY packages/google-sheets-mcp-server/package.json packages/google-sheets-mcp-server/
COPY packages/kv-demo-mcp-server/package.json packages/kv-demo-mcp-server/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/paperclip-eval-kernel/package.json packages/paperclip-eval-kernel/
COPY packages/paperclip-runner/package.json packages/paperclip-runner/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/tailscale-https-broker/package.json packages/tailscale-https-broker/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/kimi-local/package.json packages/adapters/kimi-local/
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
# Debian's packaged rust lags the ecosystem (trixie ships 1.85) and the
# runner's dependency tree now requires a newer rustc. Install rustup from a
# version-pinned, checksum-verified installer and let the runner's own
# rust-toolchain.toml choose the compiler — one pin, owned by the runner
# package, shared by CI and image builds alike.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
ARG RUSTUP_VERSION=1.29.0
ARG RUSTUP_SHA256_AMD64=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10
ARG RUSTUP_SHA256_ARM64=9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) rustTarget="x86_64-unknown-linux-gnu"; sha256="$RUSTUP_SHA256_AMD64" ;; \
      arm64) rustTarget="aarch64-unknown-linux-gnu"; sha256="$RUSTUP_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rustTarget}/rustup-init"; \
    echo "${sha256}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none; \
    rm /tmp/rustup-init
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
# The server build runs scripts/write-build-stamp.mjs, which stamps the built
# commit into dist/build-info.json. The build context has no .git, so the
# script reads PAPERCLIP_BUILD_COMMIT instead. Docker exposes an ARG to the
# next RUN as an environment variable, so declare it here — in the build
# stage — before the server build. The production stage below declares the
# same ARG again for the runtime fallback; an ARG goes out of scope at the
# end of its stage. Empty for local `docker build`, which then writes no stamp.
ARG PAPERCLIP_BUILD_COMMIT=""
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
RUN rm -rf packages/paperclip-runner/runner/target

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
# Real version for this build, computed from `git describe` on the CI runner
# (the image has no .git, so the server cannot derive it at runtime). Empty for
# local `docker build`, which just leaves the server on its normal fallbacks.
ARG PAPERCLIP_BUILD_VERSION=""
# The exact commit this image was built from, for the same reason: server-info
# falls back to PAPERCLIP_BUILD_COMMIT when git is unavailable, which feeds the
# /api/health `commit` field that deploy tooling verifies. Empty locally.
ARG PAPERCLIP_BUILD_COMMIT=""
# Refreshes the tool layer below when it changes (CI stamps an ISO week, so
# the @latest CLI tools advance weekly). Without it the cached layer would
# freeze the tools until an unrelated cache bust.
ARG CLI_TOOLS_CACHE_EPOCH=""
WORKDIR /app
# Tool and OS layer BEFORE the app copy: it references nothing from /app, and
# the app copy changes on every commit — ordered the other way around, this
# (the single most expensive layer: four CLI toolchains + apt, per arch) can
# never hit the layer cache and rebuilds on every build.
RUN echo "cli-tools-epoch: ${CLI_TOOLS_CACHE_EPOCH}" \
  && npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest @moonshot-ai/kimi-code@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --chown=node:node --from=build /app /app

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_BUILD_VERSION=${PAPERCLIP_BUILD_VERSION} \
  PAPERCLIP_BUILD_COMMIT=${PAPERCLIP_BUILD_COMMIT} \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

EXPOSE 3100

# tini, not node, is PID 1. The entrypoint ends in `exec`, so without an init
# node inherits PID 1 and never wait()s the orphans the kernel re-parents onto
# it -- agent runs spawn git/claude/esbuild/sh descendants that outlive their
# leader, so they pile up as permanent zombies (~79/h measured) until the
# cgroup pid limit is exhausted and *every* fork() in the container fails.
# tini reaps adopted orphans and forwards signals, so the exec chain below and
# graceful shutdown are unchanged. Mirrors docker/agent-runtime/Dockerfile.base.
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]

# Cloud image variant (build with `--target cloud`): the production image
# plus built bundled sandbox-provider plugins. Managed instances receive a
# `plugins.autoInstall` key list through PAPERCLIP_MANAGED_CONFIG and
# install those plugins from the bundled catalog at boot
# (server/src/services/bundled-plugins.ts), which requires each plugin's
# dist/ to exist in the image — the default image ships only their source,
# so auto-install logs "bundle not present" and skips. The plugins are
# built in this separate target so the default (self-hosted) image stays
# lean; CI pins the default build to `--target production`, which is
# byte-identical to before this stage existed.
#
# The sandbox providers are intentionally excluded from the pnpm workspace
# (see pnpm-workspace.yaml), so each installs standalone exactly as its
# README prescribes. Installing in a `build`-based stage (not `production`)
# keeps devDependencies available for tsc: `production` sets
# NODE_ENV=production, which would make pnpm skip them.
#
# CLOUD_BUNDLED_PLUGINS is the space-separated list of sandbox-provider
# directory names to build into the variant. Only what managed deployments
# actually auto-install belongs here — every entry adds its node_modules
# to the image. Growing the list is a one-line workflow change.
FROM build AS cloud-plugins
ARG CLOUD_BUNDLED_PLUGINS="daytona"
RUN set -eu; \
  for name in $CLOUD_BUNDLED_PLUGINS; do \
    dir="packages/plugins/sandbox-providers/$name"; \
    test -d "$dir" || { echo "ERROR: unknown sandbox provider '$name'" >&2; exit 1; }; \
    pnpm -C "$dir" install --ignore-workspace --no-lockfile; \
    pnpm -C "$dir" build; \
    test -f "$dir/dist/manifest.js" || { echo "ERROR: $dir is missing dist/manifest.js after build" >&2; exit 1; }; \
  done

# The hosted image variant ships selected optional peer packages
# pre-installed. A managed tenant then needs no separate install step.
# The self-hosted image stays on the opt-in contract: it never runs this
# stage, so a package like `@sentry/node` stays a true optional peer
# dependency. A self-hosted operator installs it by hand (see
# doc/observability.md).
#
# CLOUD_BUNDLED_SERVER_DEPS names the optional peer packages to install.
# The value is a space-separated list, the same shape as
# CLOUD_BUNDLED_PLUGINS above. The stage reads each package's version
# from the `peerDependencies` block of `server/package.json` at build
# time, so the version has one committed home.
#
# The stage fails the build in three cases:
# - the argument is empty
# - server/package.json declares no version for a named package
# - the named package is not an optional peer
#
# This check keeps the argument limited to packages the server already
# treats as optional.
#
# The install happens in its own isolated directory, not inside
# `server`'s own workspace install. The self-hosted target above never
# gains these packages this way. The directory sits under `/app`, not
# `server/`, and `--ignore-workspace` below excludes it from the pnpm
# workspace. From that directory, pnpm still finds the `packageManager`
# pin in the repo's own `package.json` by walking up — the same pnpm
# version the rest of the build uses.
#
# The install writes no lock file (`--no-lockfile`, the same flag the
# `cloud-plugins` stage above uses). Two builds of the same commit can
# therefore install different transitive versions of a named package.
# Three facts make this an accepted trade-off:
# - the `cloud-plugins` stage above already has the same property, with
#   the same flag
# - the direct version of each named package comes from one exact,
#   single-sourced place: the `peerDependencies` block of
#   `server/package.json`
# - an automated check asserts the installed direct version after every
#   build, so a transitive drift that breaks the package still fails the
#   build
FROM build AS cloud-server-deps
WORKDIR /app/.cloud-server-deps
ARG CLOUD_BUNDLED_SERVER_DEPS="@sentry/node"
RUN set -eu; \
  test -n "$CLOUD_BUNDLED_SERVER_DEPS" || { echo "ERROR: CLOUD_BUNDLED_SERVER_DEPS is empty; name at least one optional peer package to install" >&2; exit 1; }; \
  echo '{"name":"paperclip-cloud-server-deps","private":true}' > package.json; \
  specifiers=""; \
  for name in $CLOUD_BUNDLED_SERVER_DEPS; do \
    version="$(node -e "const pkg=require('/app/server/package.json'); const name=process.argv[1]; const version=(pkg.peerDependencies||{})[name]; if(!version){console.error('ERROR: server/package.json declares no peerDependencies version for '+JSON.stringify(name));process.exit(1);} const meta=(pkg.peerDependenciesMeta||{})[name]; if(!meta||meta.optional!==true){console.error('ERROR: '+JSON.stringify(name)+' is not declared as an optional peer dependency in server/package.json; CLOUD_BUNDLED_SERVER_DEPS may name only optional peer packages');process.exit(1);} process.stdout.write(version);" "$name")"; \
    test -n "$version" || { echo "ERROR: could not resolve a version for '$name'" >&2; exit 1; }; \
    specifiers="$specifiers ${name}@${version}"; \
  done; \
  test -n "$specifiers" || { echo "ERROR: CLOUD_BUNDLED_SERVER_DEPS names no package" >&2; exit 1; }; \
  pnpm add --ignore-workspace --no-lockfile $specifiers

FROM production AS cloud
COPY --chown=node:node --from=cloud-plugins /app/packages/plugins/sandbox-providers /app/packages/plugins/sandbox-providers
# Land the isolated install inside the server's own `node_modules`, the
# directory Node's module resolution walks up to from `/app/server` for
# both a CommonJS `require.resolve` and an ECMAScript `import` — an entry
# on `NODE_PATH` would satisfy only the first and silently fail the second.
COPY --chown=node:node --from=cloud-server-deps /app/.cloud-server-deps/node_modules /app/server/node_modules
