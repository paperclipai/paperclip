# Paperclip on Cloudflare Sandbox containers.
#
# The base image tag MUST match the @cloudflare/sandbox version pinned in
# ../package.json — the SDK and the in-container runtime are versioned
# together. test/config.test.ts enforces this.
FROM docker.io/cloudflare/sandbox:0.12.4

# Quality-of-life tools for agent workloads (subset of the tools the root
# Dockerfile's production stage installs; the sandbox base already ships
# git, curl, python3 and node).
RUN apt-get update \
  && apt-get install -y --no-install-recommends jq ripgrep openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Paperclip (npm release) plus the local-adapter agent CLIs, mirroring the
# root Dockerfile's production stage.
RUN npm install -g \
  paperclipai@latest \
  @anthropic-ai/claude-code@latest \
  @openai/codex@latest \
  opencode-ai \
  @google/gemini-cli@latest

# Paperclip runtime defaults (mirrors the root Dockerfile / quadlet unit).
ENV HOST=0.0.0.0 \
  PORT=3100 \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

# Embedded Postgres refuses to run as root, so Paperclip gets its own user.
# The uid is pinned (must match PAPERCLIP_UID in src/lib.ts — enforced by
# test/config.test.ts) so the optional R2 attachments mount can be exposed
# as owned by this user. embedded-postgres also creates symlinks inside the
# package directory on first boot, hence the chown of the installed package.
RUN useradd -m -u 4100 -s /bin/bash paperclip \
  && mkdir -p /paperclip \
  && chown -R paperclip:paperclip /paperclip \
  && chown -R paperclip:paperclip /usr/local/lib/node_modules/paperclipai

COPY start-paperclip.sh /opt/start-paperclip.sh
RUN chmod +x /opt/start-paperclip.sh

# Local dev (wrangler dev) requires exposed ports to be declared.
EXPOSE 3100

# No USER directive on purpose (trivy DS-0002): the Cloudflare Sandbox
# runtime daemon in the base image must run as root; the Paperclip workload
# itself drops to the non-root `paperclip` user in start-paperclip.sh.
