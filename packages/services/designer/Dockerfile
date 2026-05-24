# Pod / container reference image for designer.
#
# Provides: real Chrome on a virtual display (Xvfb), agent-browser, the
# designer CLI/MCP, and an entrypoint that supervises Chrome + delegates
# argv to the actual agent process.
#
# Profile bootstrap (Google sign-in to claude.ai/design as a per-agent
# identity, e.g. ally@blockcast.net) happens OUTSIDE this image — see
# README pod section for the one-time setup. The profile is mounted at
# /data/chrome-designer-profile (PVC or initContainer-seeded from a Secret).
#
# Build:
#   docker buildx build --platform linux/amd64 -t blockcast/designer-runtime:pod -f Dockerfile.pod .
#
# Use as a base layer for paperclip-agent:
#   FROM blockcast/designer-runtime:pod AS designer-runtime
#   FROM paperclip-agent:base
#   COPY --from=designer-runtime /usr/lib/node_modules/@blockcast/designer /usr/lib/node_modules/@blockcast/designer
#   COPY --from=designer-runtime /usr/bin/google-chrome-stable /usr/bin/
#   ... (or use designer-runtime as base directly and add agent on top)

FROM node:24-bookworm-slim

# Chrome + Xvfb + minimal fonts/libs + utilities for the launcher script.
# google-chrome-stable is the official Debian package from dl.google.com.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg wget procps tini \
        xvfb dbus-x11 fonts-liberation fonts-noto-color-emoji \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
        libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
        libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
        libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
        ; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-chrome-stable; \
    rm -rf /var/lib/apt/lists/*

# agent-browser is the CDP client designer drives.
RUN npm i -g agent-browser@latest

# Install designer from this build context (rather than the public npm tag)
# so pod-only patches ship before they're upstreamed.
WORKDIR /opt/designer-src
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build && npm pack && \
    npm i -g ./pro-vi-designer-*.tgz && \
    rm -rf /opt/designer-src

# Place the designer-loop skill in a system location; the entrypoint links
# it into ~/.claude/skills/ at boot so per-agent HOME mounts pick it up.
RUN mkdir -p /opt/claude-skills/designer-loop && \
    cp -r /usr/lib/node_modules/@pro-vi/designer/skills/designer-loop/* /opt/claude-skills/designer-loop/

# Bring the pod entrypoint + launcher script in.
COPY scripts/designer-chrome-pod.sh /usr/local/bin/designer-chrome-pod
COPY scripts/entrypoint-pod.sh /usr/local/bin/designer-entrypoint
RUN chmod +x /usr/local/bin/designer-chrome-pod /usr/local/bin/designer-entrypoint

ENV DESIGNER_CDP=9222 \
    DESIGNER_CHROME_PROFILE=/data/chrome-designer-profile \
    DESIGNER_DISPLAY=:99 \
    DESIGNER_PID_DIR=/run/designer \
    NODE_ENV=production

# Reasonable defaults; real agent images will mount a PVC at /data and a
# Secret-derived bootstrap at /data/chrome-designer-profile.
VOLUME ["/data"]

# tini handles PID 1 + zombie reaping so Xvfb/Chrome teardown is clean.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/designer-entrypoint"]
CMD ["sleep", "infinity"]
