# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Keep the Rust toolchain explicit so the runner artifact is reproducible and
# is always built for the same platform as the final Daytona image. Base-image
# digests are the reviewed linux/amd64 manifests; the tags are annotations.
FROM rust:1.97-bookworm@sha256:408fe88047cef61a2087653b0c5255fa51c0f2d6d94ddedd7a2562a9b91a46f6 AS runnerd-build

WORKDIR /workspace/packages/paperclip-runner/runner
COPY packages/paperclip-runner/runner/Cargo.toml packages/paperclip-runner/runner/Cargo.lock ./
COPY packages/paperclip-runner/runner/crates ./crates
COPY packages/paperclip-runner/protocol ../protocol
RUN cargo build --locked --release -j 2 -p paperclip-runner-core --bin paperclip-runnerd \
    && strip /workspace/packages/paperclip-runner/runner/target/release/paperclip-runnerd

FROM node:24.21.0-bookworm@sha256:5a750d3be5e5c80275f8c9a5367c3aed99c2875656590c8d0701c7ee687f5f0a AS provider-pack-build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
# Bound build-time memory on hosts that expose many CPUs but little RAM.
# These settings belong only to this build stage, never the runtime image.
ENV NODE_OPTIONS=--max-old-space-size=1024 \
    npm_config_child_concurrency=1 \
    npm_config_network_concurrency=4
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY scripts/link-plugin-dev-sdk.mjs ./scripts/link-plugin-dev-sdk.mjs
# Include the complete workspace manifest graph so source-owned patches apply.
# Verify the reviewed lockfile as supplied; never resolve dependencies again
# against the registry during an immutable image build.
COPY packages ./packages
COPY server/package.json ./server/package.json
COPY ui/package.json ./ui/package.json
COPY cli/package.json ./cli/package.json
# The complete resolved lock (including transitive integrity hashes) is reviewed.
# Reject registry-time drift BEFORE installing packages or running lifecycle code.
# Refresh this digest together with source/provider dependency changes.
ARG PAPERCLIP_RUNNER_LOCK_SHA256=70af8ab3d7051c85fc1a55c11e9afe8887d9711232e3c6e97666006562217e5f
# pnpm 9 subtracts PNPM_WORKERS from available CPUs; it is not a worker count.
# Subtract all available CPUs to select its minimum (one tarball worker).
RUN export PNPM_WORKERS="$(node -p 'require("node:os").availableParallelism()')" \
    && printf '%s  pnpm-lock.yaml\n' "${PAPERCLIP_RUNNER_LOCK_SHA256}" > /tmp/provider-lock.sha256 \
    && sha256sum -c /tmp/provider-lock.sha256 \
    && pnpm install --frozen-lockfile --filter '@paperclipai/paperclip-runner...'
ARG PAPERCLIP_RUNNER_SOURCE_REVISION
# Optional qualification assets; this never promotes candidate profiles.
ARG PAPERCLIP_RUNNER_CANDIDATE_PROVIDERS=
RUN test -n "${PAPERCLIP_RUNNER_SOURCE_REVISION}"
RUN export PNPM_WORKERS="$(node -p 'require("node:os").availableParallelism()')" \
    && pnpm --filter @paperclipai/paperclip-runner build:typescript \
    && PAPERCLIP_RUNNER_SOURCE_REVISION="${PAPERCLIP_RUNNER_SOURCE_REVISION}" \
      node packages/paperclip-runner/scripts/build-provider-pack.mjs /provider-pack \
        "--candidate-providers=${PAPERCLIP_RUNNER_CANDIDATE_PROVIDERS}" \
    && chmod -R a+rX /provider-pack

# Fleet sandbox base image. Keep this section aligned with
# paperclipai/paperclip-cloud/fleet-sandbox-image/Dockerfile. The only Paperclip
# runner-specific addition is /usr/local/bin/paperclip-runnerd below.
FROM daytonaio/sandbox:0.8.0@sha256:eadf88e4391072b7ad4bed27d9cadfc9fe9d8ed375d9219d34c2ccb518f213e3

USER root

ENV PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT=/opt/paperclip-runner/provider-pack
ENV PATH=${PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT}/node_modules/.bin:/usr/local/share/nvm/current/bin:/usr/local/python/current/bin:/usr/local/py-utils/bin:${PATH}

# Share the pack's latest stable Codex, Claude and OpenCode with every adapter.
# Never add a second CLI version to work around a runner compatibility pin.
RUN npm uninstall -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    && npm install -g \
      @xai-official/grok@1.0.41 \
      @google/gemini-cli@0.60.0 \
      @moonshot-ai/kimi-code@2.0.2 \
    && npm cache clean --force

# Hermes requires Python >=3.11,<3.14; the image's default Python is newer.
# Use the distro interpreter in a dedicated environment without changing PATH
# or keeping an older Hermes CLI. Everything is installed before sandbox boot.
# Debian 13 in the sandbox base already includes Python 3.13 and python3-venv.
RUN /usr/bin/python3 -m venv /opt/hermes \
    && /opt/hermes/bin/pip install --no-cache-dir hermes-agent==0.19.0 \
    && ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes

ARG CURSOR_VERSION=2026.09.26-dd393fe
ARG CURSOR_SHA256_AMD64=8085fd120f5c71f4eae7fea26a043718e5644e3071e4fab3220a0e58c51f9593
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    [ "$arch" = "amd64" ] || { echo "FATAL: cursor pin only covers amd64, not $arch" >&2; exit 1; }; \
    dir="/opt/cursor/versions/${CURSOR_VERSION}"; mkdir -p "$dir"; \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/x64/agent-cli-package.tar.gz" -o /tmp/cursor.tgz; \
    printf '%s  /tmp/cursor.tgz\n' "${CURSOR_SHA256_AMD64}" > /tmp/cursor.sha256; \
    sha256sum -c /tmp/cursor.sha256; \
    tar --strip-components=1 -xzf /tmp/cursor.tgz -C "$dir"; \
    rm -f /tmp/cursor.tgz /tmp/cursor.sha256; \
    ln -sf "$dir/cursor-agent" /usr/local/bin/cursor-agent; \
    ln -sf /usr/local/bin/cursor-agent /usr/local/bin/agent; \
    chmod -R a+rX /opt/cursor

ARG GH_VERSION=2.101.0
ARG GH_SHA256_AMD64=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    [ "$arch" = "amd64" ] || { echo "FATAL: gh pin only covers amd64, not $arch" >&2; exit 1; }; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tgz; \
    printf '%s  /tmp/gh.tgz\n' "${GH_SHA256_AMD64}" > /tmp/gh.sha256; \
    sha256sum -c /tmp/gh.sha256; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz /tmp/gh.sha256 "/tmp/gh_${GH_VERSION}_linux_amd64"

COPY packages/paperclip-runner/scripts/provision-grok.mjs /tmp/grok-provision/scripts/provision-grok.mjs
COPY packages/paperclip-runner/src/providers/grok/platforms.json /tmp/grok-provision/src/providers/grok/platforms.json
RUN node /tmp/grok-provision/scripts/provision-grok.mjs /opt/paperclip/providers/grok/1.0.13/grok && rm -rf /tmp/grok-provision

COPY --from=runnerd-build /workspace/packages/paperclip-runner/runner/target/release/paperclip-runnerd /usr/local/bin/paperclip-runnerd
COPY --from=provider-pack-build /provider-pack /opt/paperclip-runner/provider-pack
RUN set -eu; for cli in codex claude opencode; do \
      printf '#!/bin/sh\nexec /opt/paperclip-runner/provider-pack/node_modules/.bin/%s "$@"\n' "$cli" > "/usr/local/bin/$cli"; \
      chmod 755 "/usr/local/bin/$cli"; \
    done

# Keep revision-dependent metadata below the stable agent CLI installation
# layers. A source-only image miss can then reuse those expensive layers from
# the trusted registry cache.
ARG PAPERCLIP_RUNNER_CONTENT_ID
ARG PAPERCLIP_RUNNER_SOURCE_REVISION
RUN test -n "${PAPERCLIP_RUNNER_CONTENT_ID}" \
    && test -n "${PAPERCLIP_RUNNER_SOURCE_REVISION}"

RUN set -eu; \
    printf '%s\n' 'export PATH=/opt/paperclip-runner/provider-pack/node_modules/.bin:$PATH' \
      > /etc/profile.d/01-paperclip-runner-provider-pack.sh; \
    chmod 0644 /etc/profile.d/01-paperclip-runner-provider-pack.sh; \
    for command_name in acpx claude-agent-acp codex-acp claude codex grok gemini kimi opencode cursor-agent agent hermes gh paperclip-runnerd; do \
      command -v "$command_name" >/dev/null || { echo "FATAL: $command_name not on PATH after build" >&2; exit 1; }; \
    done; \
    metadata="$(paperclip-runnerd --build-metadata)"; \
    /opt/paperclip-runner/provider-pack/node_modules/node/bin/node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number); if (major<24 || (major===24 && (minor<11 || (minor===11 && patch<0)))) process.exit(1)"; \
    test -f /opt/paperclip-runner/provider-pack/provider-pack.json; \
    printf '%s' "$metadata" | grep -q '"dial_ws_loopback"'; \
    printf '%s' "$metadata" | grep -q '"dial_wss"'; \
    printf '%s' "$metadata" | grep -q '"listen_ws"'; \
    echo "all agent CLIs and runnerd transport modes are available"

USER daytona

RUN /bin/sh -lc 'set -eu; \
    test -r /opt/paperclip-runner/provider-pack/provider-pack.json; \
    /opt/paperclip-runner/provider-pack/node_modules/node/bin/node -e \
      "JSON.parse(require(\"node:fs\").readFileSync(\"/opt/paperclip-runner/provider-pack/provider-pack.json\", \"utf8\"))"; \
    for command_name in acpx claude-agent-acp codex-acp; do \
      command -v "$command_name" >/dev/null || { echo "FATAL: $command_name not on PATH for daytona user" >&2; exit 1; }; \
    done; \
    test "$(codex --version)" = "codex-cli 0.156.0"; \
    test "$(claude --version)" = "2.1.280 (Claude Code)"; \
    test "$(opencode --version)" = "1.18.32"; \
    test "$(acpx --version)" = "0.13.1"; \
    test "$(claude-agent-acp --version)" = "0.73.0"; \
    test "$(codex-acp --version)" = "@agentclientprotocol/codex-acp 1.6.2"'

LABEL io.paperclip.runner.content-id="${PAPERCLIP_RUNNER_CONTENT_ID}" \
      org.opencontainers.image.revision="${PAPERCLIP_RUNNER_SOURCE_REVISION}"
