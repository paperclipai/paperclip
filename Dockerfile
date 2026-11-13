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
COPY packages/paperclip-runner/scripts/install-copilot-assets.mjs packages/paperclip-runner/scripts/materialize-copilot-binary.mjs packages/paperclip-runner/scripts/copilot-inner-distribution.mjs packages/paperclip-runner/scripts/
COPY packages/paperclip-runner/src/drivers/acpx/copilot-installation.ts packages/paperclip-runner/src/drivers/acpx/
COPY server/scripts/install-copilot-assets.mjs server/scripts/
COPY server/src/services/copilot-connection-probe.ts server/src/services/

# CI owns repository lock updates. Resolve manifest changes in the image's
# private build tree, then install from that exact generated lock.
RUN pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile && pnpm install --frozen-lockfile

FROM base AS rust-toolchain
WORKDIR /app
# Debian's packaged rust lags the ecosystem (trixie ships 1.85) and the
# runner's dependency tree now requires a newer rustc. Install rustup from a
# version-pinned, checksum-verified installer and let the runner's own
# rust-toolchain.toml choose the compiler — one pin, owned by the runner
# package, shared by CI and image builds alike.
#
# The C toolchain is explicit: apt's cargo used to pull gcc in as a
# dependency, and rustup does not — without it every build script dies on
# "linker `cc` not found".
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*
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
# Install the package-owned compiler before any application source enters the
# stage. rustup-init above installs rustup itself, not the selected compiler.
COPY packages/paperclip-runner/rust-toolchain.toml /tmp/runner-toolchain/rust-toolchain.toml
RUN cd /tmp/runner-toolchain && rustup show

# Pin the recipe generator and its dependency lockfile. It is a build-only tool
# and uses the same package-owned compiler as both native build stages.
FROM rust-toolchain AS rust-chef
RUN cd /tmp/runner-toolchain && cargo install cargo-chef --version 0.1.73 --locked

FROM rust-chef AS runner-plan
WORKDIR /app/packages/paperclip-runner
COPY packages/paperclip-runner/rust-toolchain.toml ./
COPY packages/paperclip-runner/runner ./runner
RUN cd runner && cargo chef prepare --recipe-path /tmp/runner-recipe.json

FROM rust-chef AS runner-deps
WORKDIR /app/packages/paperclip-runner/runner
COPY packages/paperclip-runner/rust-toolchain.toml ../
# The recipe changes only when dependency manifests, the lockfile, or target
# metadata change. Source edits can reuse this compiled dependency layer.
COPY --from=runner-plan /tmp/runner-recipe.json /tmp/runner-recipe.json
RUN cargo chef cook --release --locked --package paperclip-runner-core --bin paperclip-runnerd --recipe-path /tmp/runner-recipe.json \
  && find . -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} +

FROM runner-deps AS runner-build
WORKDIR /app/packages/paperclip-runner
# Rust embeds protocol schemas and fixtures with include_str!. Keep those
# alongside the complete Cargo workspace so every compile-time input keys
# this layer. Ordinary server/UI edits can then reuse the native build.
COPY packages/paperclip-runner/rust-toolchain.toml ./
COPY packages/paperclip-runner/runner ./runner
COPY packages/paperclip-runner/protocol ./protocol
COPY packages/paperclip-runner/acpx-profiles.json packages/paperclip-runner/antigravity-distributions.json ./
# Cargo fingerprints source mtimes. Normalize them here and after the full
# source copy below so a fresh checkout cannot invalidate unchanged inputs.
RUN find runner protocol -type f -exec touch -d @0 {} + \
  && touch -d @0 rust-toolchain.toml acpx-profiles.json antigravity-distributions.json \
  && cargo build --release --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --bin paperclip-runnerd

FROM runner-build AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN find packages/paperclip-runner/runner packages/paperclip-runner/protocol -type f -exec touch -d @0 {} + \
  && touch -d @0 packages/paperclip-runner/rust-toolchain.toml packages/paperclip-runner/acpx-profiles.json packages/paperclip-runner/antigravity-distributions.json
# Both the browser bundle and server stamp need the source commit. Declare it
# after the stable dependency layers, before either application build.
ARG PAPERCLIP_BUILD_COMMIT=""
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
# The server build runs scripts/write-build-stamp.mjs, which stamps the built
# commit into dist/build-info.json. The build context has no .git, so the
# script reads PAPERCLIP_BUILD_COMMIT instead. Docker exposes an ARG to the
# next RUN as an environment variable. The production stage below declares the
# same ARG again for the runtime fallback; an ARG goes out of scope at the
# end of its stage. Empty for local `docker build`, which then writes no stamp.
# NODE_OPTIONS covers the Node build steps. tsc is a native binary and ignores it.
ENV NODE_OPTIONS=--max-old-space-size=4096
# The image needs no declarations, and CI type-checks this source separately.
# Emitting without either cuts the tsc step from more than 10 GiB to about 2.5 GiB.
RUN PAPERCLIP_TSC_EMIT_ONLY=1 pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
RUN pnpm --filter @paperclipai/server build:runtime \
  && test -f server/dist-runtime/index.mjs || (echo "ERROR: server runtime bundle missing" && exit 1)
RUN rm -rf packages/paperclip-runner/runner/target

# Remote OpenCode and ACPX runs require a controller-owned provider pack to
# verify the sandbox installation or stage matching assets. Ship it in the
# standard image so downstream Cloud compositions inherit the same artifacts.
# Grok's native executable stays an external sandbox prerequisite; this pack
# contains only its launcher.
FROM build AS runner-provider-pack
# Unstamped local builds remain usable, but cannot qualify a remote pack.
# Never invent a source revision to make an unqualified pack look verified.
# Managed deployments can remap node's UID at startup, so the pack must stay
# readable by any UID. Grant that here, in the same layer that writes the
# files: COPY keeps these modes. A `chmod -R` after the COPY into production
# rewrote every changed file into a second copy of the pack (187 MB compressed
# and ~50 s of build time on amd64), and the production stage still checks
# readability as an unrelated UID below.
RUN mkdir -p /provider-pack /provider-pack-transport \
  && if [ -n "${PAPERCLIP_BUILD_COMMIT}" ]; then \
    PAPERCLIP_RUNNER_SOURCE_REVISION="${PAPERCLIP_BUILD_COMMIT}" node packages/paperclip-runner/scripts/build-provider-pack.mjs /provider-pack \
      && node scripts/create-provider-pack-archive.mjs /provider-pack \
      && mv /provider-pack.archives /provider-pack.archive.json /provider-pack-transport/; \
  else \
    echo "Skipping remote provider pack: supply a full PAPERCLIP_BUILD_COMMIT to enable remote OpenCode/ACPX execution"; \
  fi \
  && chmod -R a+rX /provider-pack
# The pack is ~2.5 GB of provider binaries that change only when a provider
# version does, next to small files that change on every commit (the manifest
# carries the source revision). Move the large files to their own tree, after
# the transport archive has read the whole pack, so production can copy them
# as a layer that stays identical between commits. Normalized mtimes keep that
# layer's bytes identical when this stage reruns.
RUN mkdir -p /provider-pack-large \
  && cd /provider-pack \
  && find . -type f -size +1048575c -exec sh -c 'mkdir -p "/provider-pack-large/$(dirname "$1")" && mv "$1" "/provider-pack-large/$1"' _ {} \; \
  && find /provider-pack-large -exec touch -h -d @0 {} +

# Runner image (`--target runner-artifacts`).
#
# The stages below build the Runner once, from its own inputs only, as a plain
# file tree: the daemon, the Runner package's build output with its build
# stamp, the remote provider pack with its transport archives, and the few
# source files a sandbox image reads. The tree is the image
# ghcr.io/paperclipai/paperclip-runner, named `inputs-<digest>` after its
# inputs. doc/runner-image-contract.md is the contract;
# scripts/runner-image-layout.mjs and scripts/runner-image-identity.mjs
# enforce it.
#
# These stages are independent of every stage above. They install with a
# filtered, frozen lockfile and never read the server, the UI or the `deps`
# stage, so a change outside the Runner's inputs leaves them cached, and the
# default targets never build them.
#
# Consumers must only `COPY --from=runner-artifacts <path>`, or from
# `runner-artifacts-slim`, the same tree without the pack's transport
# archives. A build can then replace the stage with an image built earlier:
#   --build-context runner-artifacts=docker-image://ghcr.io/paperclipai/paperclip-runner@sha256:<digest>
#
# The image identity is a digest of this whole file and of every file under
# the paths `runner-artifacts-context` copies. A test
# (runner-image-identity.test.ts) holds the three rules that make that enough:
# every base image of these stages is pinned by digest, only
# `runner-artifacts-context` reads the build context, and it copies only paths
# in RUNNER_IMAGE_CONTEXT_INPUTS (scripts/runner-image-identity.mjs).

# The Runner's inputs, exactly as the build context supplies them (after
# .dockerignore). Later stages copy from here, so each one is keyed by the
# content of the paths it reads and by nothing else in the repository.
FROM scratch AS runner-artifacts-context
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json /
COPY patches /patches
COPY scripts/create-provider-pack-archive.mjs scripts/link-plugin-dev-sdk.mjs scripts/runner-image-identity.mjs scripts/runner-image-layout.mjs /scripts/
COPY packages/paperclip-eval-kernel /packages/paperclip-eval-kernel
COPY packages/paperclip-runner /packages/paperclip-runner
# build:typescript checks the Runner's generated provider-failure contract
# against this copy, which @paperclipai/shared owns.
COPY packages/shared/src/provider-failure.generated.ts /packages/shared/src/

# Debian bookworm is the oldest glibc any consumer runs, so a daemon compiled
# here also runs on trixie. The pack copies this Node binary as its own
# interpreter, which is why the exact Node release is pinned and part of the
# image identity. The digest is the multi-platform index (amd64 and arm64).
FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS runner-artifacts-node
RUN corepack enable

# The image identity, computed inside the build from the files the build
# actually receives. `--target runner-artifacts-identity` exports it alone, so
# CI can read the digest before it builds. The Dockerfile is copied here
# only: the identity covers its text.
FROM runner-artifacts-node AS runner-artifacts-identity-compute
WORKDIR /workspace
COPY --from=runner-artifacts-context / ./
COPY Dockerfile ./
RUN node scripts/runner-image-identity.mjs --json > /runner-image-identity.json

FROM scratch AS runner-artifacts-identity
COPY --from=runner-artifacts-identity-compute /runner-image-identity.json /runner-image-identity.json

# Same checksum-verified rustup as the `rust-toolchain` stage above, on the
# bookworm base. The compiler is the one packages/paperclip-runner/rust-toolchain.toml
# names. The base image supplies the C toolchain.
FROM runner-artifacts-node AS runner-artifacts-toolchain
# cargo strips the release binary itself. The Runner's build stamp records the
# size of every file under dist, so the binary must not change after the build.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    CARGO_PROFILE_RELEASE_STRIP=symbols
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
COPY --from=runner-artifacts-context /packages/paperclip-runner/rust-toolchain.toml /tmp/runner-toolchain/rust-toolchain.toml
RUN cd /tmp/runner-toolchain && rustup toolchain install && rustc --version

# Compile the daemon from the files Cargo reads, so a TypeScript-only change
# reuses this layer. The Runner's own build below runs the same cargo command
# and finds the target current.
FROM runner-artifacts-toolchain AS runner-artifacts-runnerd
WORKDIR /workspace/packages/paperclip-runner
COPY --from=runner-artifacts-context /packages/paperclip-runner/rust-toolchain.toml ./
COPY --from=runner-artifacts-context /packages/paperclip-runner/runner ./runner
COPY --from=runner-artifacts-context /packages/paperclip-runner/protocol ./protocol
COPY --from=runner-artifacts-context /packages/paperclip-runner/acpx-profiles.json /packages/paperclip-runner/antigravity-distributions.json ./
# Cargo fingerprints source mtimes; see the `runner-build` stage above.
RUN find runner protocol -type f -exec touch -d @0 {} + \
  && touch -d @0 rust-toolchain.toml acpx-profiles.json antigravity-distributions.json \
  && cargo build --release --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --bin paperclip-runnerd

FROM runner-artifacts-runnerd AS runner-artifacts-build
WORKDIR /workspace
COPY --from=runner-artifacts-context / ./
COPY --from=runner-artifacts-identity /runner-image-identity.json /runner-image-identity.json
# The source revision is provenance, not identity: the commit whose build
# produced this image. PAPERCLIP_BUILD_COMMIT is the fallback so one argument
# stamps a whole `docker build`. Without either, the tree has the daemon and
# the Runner build but no provider pack, as in the `runner-provider-pack` stage.
ARG PAPERCLIP_RUNNER_SOURCE_REVISION=""
ARG PAPERCLIP_BUILD_COMMIT=""
# Set to 1 only by .github/workflows/runner-image.yml, which builds the
# publication form of the image. Only then does the pack record
# `runnerInputsDigest`, the identity of this image. Another image build that
# runs this stage inline, with PAPERCLIP_BUILD_COMMIT, builds the same Runner
# but must not claim to be this image.
ARG PAPERCLIP_RUNNER_IMAGE_PUBLICATION=""
# One layer: the install tree and the pnpm store are removed before the layer
# is committed, and the pack is granted a+rX in the layer that writes it (see
# the `runner-provider-pack` stage above for why).
#
# The Runner is built with its own scripts, in the order its `build` script
# runs them: the two steps that write build output, between the two that record
# the build stamp. The stamp lets a later build reuse this output
# (server/scripts/prepare-runner-vendor.mjs). The other steps of `build` are
# drift checks that compare committed files across the repository; they write
# nothing, they need files outside the Runner's inputs, and repository CI runs
# them on every pull request. A test fails when `build` gains a step, so that
# a new output step cannot be missed here.
#
# The install is frozen: the identity above covers pnpm-lock.yaml as the build
# received it, and resolving again here would build from a lockfile the
# identity never saw.
#
# The pack's large dependency files get a fixed timestamp before their
# transport archives are written, so each archive has the same bytes while its
# file does. The last commands sort the tree into the layers of the two final
# stages. `dist` is what the Runner's own build writes: its large files change
# with the Runner's source, so they stay with the content that does.
RUN set -eu; \
    revision="${PAPERCLIP_RUNNER_SOURCE_REVISION:-${PAPERCLIP_BUILD_COMMIT}}"; \
    publication="${PAPERCLIP_RUNNER_IMAGE_PUBLICATION}"; \
    case "$publication" in ""|1) ;; *) echo "ERROR: PAPERCLIP_RUNNER_IMAGE_PUBLICATION must be 1 or unset" >&2; exit 1 ;; esac; \
    if [ -n "$publication" ] && [ -z "$revision" ]; then echo "ERROR: a publication build needs PAPERCLIP_RUNNER_SOURCE_REVISION" >&2; exit 1; fi; \
    find packages/paperclip-runner/runner packages/paperclip-runner/protocol -type f -exec touch -d @0 {} +; \
    touch -d @0 packages/paperclip-runner/rust-toolchain.toml packages/paperclip-runner/acpx-profiles.json packages/paperclip-runner/antigravity-distributions.json; \
    pnpm install --frozen-lockfile --filter '@paperclipai/paperclip-runner...' || { \
      echo "ERROR: the frozen install failed. If pnpm reported ERR_PNPM_OUTDATED_LOCKFILE, the committed pnpm-lock.yaml is behind the Runner's manifests. The repository's lockfile refresh fixes that on master. For a local build only, resolve it first: pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile" >&2; \
      exit 1; \
    }; \
    cd packages/paperclip-runner; \
    node scripts/record-build-inputs.mjs --begin; \
    pnpm run build:typescript; \
    pnpm run build:binary; \
    node scripts/record-build-inputs.mjs --finish; \
    cd /workspace; \
    mkdir -p /out /out-large /out-archives /out-transport; \
    if [ -n "$revision" ]; then \
      if [ -n "$publication" ]; then \
        PAPERCLIP_RUNNER_INPUTS_DIGEST="$(node -p 'require("/runner-image-identity.json").digest')"; \
        export PAPERCLIP_RUNNER_INPUTS_DIGEST; \
      fi; \
      PAPERCLIP_RUNNER_SOURCE_REVISION="$revision" node packages/paperclip-runner/scripts/build-provider-pack.mjs /out/provider-pack; \
      find /out/provider-pack -path /out/provider-pack/dist -prune -o -type f -size +1048575c -exec touch -d @0 {} +; \
      node scripts/create-provider-pack-archive.mjs /out/provider-pack; \
      node_modules/.bin/esbuild /out/provider-pack/dist/live/runnerd-codex-transport.js \
        --bundle --platform=node --format=esm --log-level=warning \
        --banner:js='import { createRequire as paperclipCreateRequire } from "node:module"; const require = paperclipCreateRequire(import.meta.url);' \
        --outfile=/out/bundles/runnerd-codex-transport.mjs; \
      node scripts/runner-image-layout.mjs write --out /out --workspace /workspace --identity /runner-image-identity.json --source-revision "$revision" ${publication:+--publication}; \
      chmod -R a+rX /out; \
      node scripts/runner-image-layout.mjs check /out --variant full --expect-source-revision "$revision" ${publication:+--expect-inputs-digest "$PAPERCLIP_RUNNER_INPUTS_DIGEST"}; \
      cd / && /out/provider-pack/node_modules/node/bin/node --input-type=module -e 'const transport = await import("/out/bundles/runnerd-codex-transport.mjs"); if (typeof transport.createCapabilityRunnerdCodexTransport !== "function") process.exit(1);'; \
    else \
      echo "Skipping the provider pack: supply a full PAPERCLIP_RUNNER_SOURCE_REVISION or PAPERCLIP_BUILD_COMMIT to build a complete Runner image"; \
      node scripts/runner-image-layout.mjs write --out /out --workspace /workspace --identity /runner-image-identity.json; \
      chmod -R a+rX /out; \
      node scripts/runner-image-layout.mjs check /out --variant full --allow-unstamped; \
    fi; \
    /out/paperclip-runnerd --build-metadata > /dev/null; \
    cd /out; \
    find provider-pack -path provider-pack/dist -prune -o -type f -size +1048575c \
      -exec sh -c 'mkdir -p "/out-large/$(dirname "$1")" && mv "$1" "/out-large/$1"' _ {} \; ; \
    if [ -f provider-pack.archive.json ]; then \
      mkdir -p /out-archives/provider-pack.archives /out-transport; \
      node -e 'for (const [index, file] of require("/out/provider-pack.archive.json").files.entries()) if (!file.path.startsWith("dist/")) console.log(index)' > /tmp/stable-archives; \
      while read -r index; do mv "provider-pack.archives/$index.tar.zst" /out-archives/provider-pack.archives/; done < /tmp/stable-archives; \
      rm /tmp/stable-archives; \
      mv provider-pack.archives provider-pack.archive.json /out-transport/; \
    fi; \
    find /out-large /out-archives -exec touch -h -d @0 {} +; \
    cd /; \
    rm -rf /workspace /root/.local/share/pnpm /root/.cache

# Two variants of one build. Both are plain file trees, and each `COPY --link`
# is one layer, independent of the layers under it. The layers are split by
# how often their content changes, so a new image shares its large layers with
# the one before it; the stage above gives the files of layers 1 and 3 a fixed
# timestamp, so those layers have the same bytes whenever their files do.
#   1. provider pack dependency files of 1 MiB or more (provider binaries and
#      Node), which change with a provider version or the Node pin;
#   2. everything else, which changes with every Runner source change.
# `runner-artifacts-slim` is these two layers: the Runner without the pack's
# transport form. `runner-artifacts` is the same two layers, then
#   3. the transport archive of each file in layer 1, as stable as layer 1;
#   4. the other transport archives, the overlay archive and the receipt,
#      which change with layer 2.
# Layers 3 and 4 hold the transport archives and their receipt and nothing
# else, so a reader can fetch all of them without the pack.
# `runner-image-oci.mjs check-layers` checks all of this on built images.
# Every path is where it would be in a single layer; consumers copy by path.
FROM scratch AS runner-artifacts-slim
COPY --link --from=runner-artifacts-build /out-large/ /
COPY --link --from=runner-artifacts-build /out/ /

FROM runner-artifacts-slim AS runner-artifacts
COPY --link --from=runner-artifacts-build /out-archives/ /
COPY --link --from=runner-artifacts-build /out-transport/ /

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
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

# Installed dependencies are ~2.9 GB of /app and change only with the lockfile.
# Copied from the deps stage as their own layer, a commit that leaves the
# lockfile alone does not push or pull them again. The build stage writes
# nothing under the root node_modules, so the rest of /app is copied without it.
COPY --chown=node:node --from=deps /app/node_modules /app/node_modules
COPY --chown=node:node --exclude=node_modules --from=build /app /app

# Large provider binaries first, linked so the layer does not depend on the
# per-commit /app layer above; then the small per-commit remainder of the pack.
COPY --link --chown=0:0 --from=runner-provider-pack /provider-pack-large/ /opt/paperclip-runner/provider-pack/
COPY --chown=0:0 --from=runner-provider-pack /provider-pack /opt/paperclip-runner/provider-pack
COPY --from=runner-provider-pack /provider-pack-transport/ /opt/paperclip-runner/
# Managed deployments can remap node's UID at startup. This immutable pack
# contains public code and integrity metadata, never credentials; it must remain
# readable afterward. The runner-provider-pack stage grants a+rX before this
# COPY, which preserves modes.
# Keep it root-owned and verify access as an unrelated unprivileged UID.
RUN if [ -f /opt/paperclip-runner/provider-pack/provider-pack.json ]; then \
    gosu 65534:65534 node -e 'const fs = require("node:fs"); const path = require("node:path"); const root = "/opt/paperclip-runner/provider-pack"; const manifest = JSON.parse(fs.readFileSync(path.join(root, "provider-pack.json"), "utf8")); for (const artifact of Object.values(manifest.payload.artifacts)) fs.readFileSync(path.join(root, artifact.path)); fs.accessSync(path.join(root, manifest.payload.artifacts.nodeCommand.path), fs.constants.X_OK);'; \
  fi
ENV PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH=/opt/paperclip-runner/provider-pack

# Declare per-build metadata after the stable RUN layers. Docker includes
# in-scope ARG values in a RUN's environment even when its command does not
# mention them; declaring these earlier invalidates the weekly tool cache.
# The build stage still receives the commit before writing dist/build-info.json.
# Empty for local builds, preserving the server's normal version fallbacks.
ARG PAPERCLIP_BUILD_VERSION=""
ARG PAPERCLIP_BUILD_COMMIT=""
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
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "docker-entrypoint.sh"]
CMD ["node", "server/dist-runtime/index.mjs"]

# Cloud image variant (build with `--target cloud`): the production image
# plus built bundled sandbox-provider plugins. Managed instances receive a
# `plugins.autoInstall` key list through PAPERCLIP_MANAGED_CONFIG and
# install those plugins from the bundled catalog at boot
# (server/src/services/bundled-plugins.ts), which requires each plugin's
# dist/ to exist in the image — the default image ships only their source,
# so auto-install logs "bundle not present" and skips. The plugins are
# built in this separate target so the default (self-hosted) image stays
# lean; CI pins the default build to `--target production`. Both targets
# inherit the build-owned remote provider pack from the standard image.
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
