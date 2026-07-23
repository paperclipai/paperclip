# Paperclip on Cloudflare Sandboxes
# Base image must match the @cloudflare/sandbox SDK version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.4

# Build tooling for node-pty's native addon plus quality-of-life tools.
RUN apt-get update \
  && apt-get install -y --no-install-recommends make g++ python3 tmux ripgrep jq \
  && rm -rf /var/lib/apt/lists/*

# Paperclip itself plus the coding agents users can run from the web terminal.
RUN npm install -g paperclipai@latest \
  && npm install -g opencode-ai@latest || true
RUN npm install -g @anthropic-ai/claude-code@latest || true
RUN npm install -g @earendil-works/pi-coding-agent@latest || true

# ghostty-web browser terminal server (node-pty + ws).
COPY terminal /opt/terminal
RUN cd /opt/terminal && npm install --omit=dev

# Paperclip runtime defaults (mirrors docker/quadlet/paperclip.container).
ENV HOST=0.0.0.0 \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

# Embedded Postgres refuses to run as root, so Paperclip runs as its own user.
RUN useradd -m -s /bin/bash paperclip \
  && mkdir -p /paperclip \
  && chown -R paperclip:paperclip /paperclip \
  # embedded-postgres creates symlinks inside the package dir at first boot
  && chown -R paperclip:paperclip /usr/local/lib/node_modules/paperclipai

COPY start-paperclip.sh /opt/start-paperclip.sh
RUN chmod +x /opt/start-paperclip.sh
