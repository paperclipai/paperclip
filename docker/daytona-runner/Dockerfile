# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Keep the Rust toolchain explicit so the runner artifact is reproducible and
# is always built for the same platform as the final Daytona image. Base-image
# digests are the reviewed linux/amd64 manifests; the tags are annotations.
FROM rust:1.97-bookworm@sha256:408fe88047cef61a2087653b0c5255fa51c0f2d6d94ddedd7a2562a9b91a46f6 AS runnerd-build

WORKDIR /workspace/packages/paperclip-runner/runner
COPY packages/paperclip-runner/runner/Cargo.toml packages/paperclip-runner/runner/Cargo.lock ./
COPY packages/paperclip-runner/runner/crates ./crates
COPY packages/paperclip-runner/protocol ../protocol
RUN cargo build --locked --release -p paperclip-runner-core --bin paperclip-runnerd \
    && strip /workspace/packages/paperclip-runner/runner/target/release/paperclip-runnerd

FROM node:24-bookworm@sha256:9137a20e25879e0b557227b57e3ee4e9af4bde29eb3db66134cd1723e84f830b AS provider-pack-build
ARG PAPERCLIP_RUNNER_SOURCE_REVISION
RUN test -n "${PAPERCLIP_RUNNER_SOURCE_REVISION}"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
COPY scripts/link-plugin-dev-sdk.mjs ./scripts/link-plugin-dev-sdk.mjs
COPY packages/paperclip-eval-kernel ./packages/paperclip-eval-kernel
COPY packages/paperclip-runner ./packages/paperclip-runner
RUN pnpm install --frozen-lockfile --filter '@paperclipai/paperclip-runner...'
RUN pnpm --filter @paperclipai/paperclip-runner build:typescript \
    && PAPERCLIP_RUNNER_SOURCE_REVISION="${PAPERCLIP_RUNNER_SOURCE_REVISION}" \
      node packages/paperclip-runner/scripts/build-provider-pack.mjs /provider-pack

# Fleet sandbox base image. Keep this section aligned with
# paperclipai/paperclip-cloud/fleet-sandbox-image/Dockerfile. The only Paperclip
# runner-specific addition is /usr/local/bin/paperclip-runnerd below.
FROM daytonaio/sandbox:0.8.0@sha256:eadf88e4391072b7ad4bed27d9cadfc9fe9d8ed375d9219d34c2ccb518f213e3

ARG PAPERCLIP_RUNNER_CONTENT_ID
ARG PAPERCLIP_RUNNER_SOURCE_REVISION
RUN test -n "${PAPERCLIP_RUNNER_CONTENT_ID}" \
    && test -n "${PAPERCLIP_RUNNER_SOURCE_REVISION}"
LABEL io.paperclip.runner.content-id="${PAPERCLIP_RUNNER_CONTENT_ID}" \
      org.opencontainers.image.revision="${PAPERCLIP_RUNNER_SOURCE_REVISION}"

USER root

ENV PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT=/opt/paperclip-runner/provider-pack
ENV PATH=${PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT}/node_modules/.bin:/usr/local/share/nvm/current/bin:/usr/local/python/current/bin:/usr/local/py-utils/bin:${PATH}

RUN npm install -g \
      @anthropic-ai/claude-code@2.1.19 \
      @openai/codex@0.148.0 \
      @xai-official/grok@1.0.3 \
      @google/gemini-cli@0.56.0 \
      @moonshot-ai/kimi-code@0.38.0 \
      opencode-ai@1.18.17 \
    && npm cache clean --force

RUN pip install --no-cache-dir --break-system-packages hermes-agent==0.15.2

ARG CURSOR_VERSION=2026.08.11-e8db854
ARG CURSOR_SHA256_AMD64=bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a
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

ARG GH_VERSION=2.98.0
ARG GH_SHA256_AMD64=3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    [ "$arch" = "amd64" ] || { echo "FATAL: gh pin only covers amd64, not $arch" >&2; exit 1; }; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tgz; \
    printf '%s  /tmp/gh.tgz\n' "${GH_SHA256_AMD64}" > /tmp/gh.sha256; \
    sha256sum -c /tmp/gh.sha256; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz /tmp/gh.sha256 "/tmp/gh_${GH_VERSION}_linux_amd64"

COPY --from=runnerd-build /workspace/packages/paperclip-runner/runner/target/release/paperclip-runnerd /usr/local/bin/paperclip-runnerd
COPY --from=provider-pack-build /provider-pack /opt/paperclip-runner/provider-pack

RUN set -eu; \
    chmod -R a+rX /opt/paperclip-runner/provider-pack; \
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
    test "$(acpx --version)" = "0.13.1"; \
    test "$(claude-agent-acp --version)" = "0.70.0"; \
    test "$(codex-acp --version)" = "@agentclientprotocol/codex-acp 1.6.2"'
