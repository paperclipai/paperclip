# syntax=docker/dockerfile:1.6
ARG HERMES_VERSION=0.17.0
FROM node:22-bookworm-slim

ARG HERMES_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    tini \
  && rm -rf /var/lib/apt/lists/*

# The npm package is a pinned bridge that exposes the `hermes` binary. Install
# the matching Python package globally first so the non-root runtime user can
# import the upstream Hermes modules at container start.
RUN python3 -m pip install --break-system-packages --no-cache-dir "hermes-agent[anthropic]==${HERMES_VERSION}" "aiohttp==3.13.4" \
  && rm -f /usr/local/bin/hermes /usr/local/bin/hermes-agent \
  && npm install -g --ignore-scripts "hermes-agent@${HERMES_VERSION}" \
  && python3 -c "import hermes_cli.main" \
  && command -v hermes >/dev/null

RUN useradd --create-home --shell /bin/bash --uid 10001 hermes \
  && mkdir -p /home/hermes/.hermes /home/hermes/workspace \
  && chown -R hermes:hermes /home/hermes

COPY entrypoint.sh /usr/local/bin/hermes-gateway-entrypoint
RUN chmod 0755 /usr/local/bin/hermes-gateway-entrypoint

USER hermes
WORKDIR /home/hermes/workspace

ENV HOME=/home/hermes \
  HERMES_HOME=/home/hermes/.hermes \
  XDG_CONFIG_HOME=/home/hermes/.config \
  XDG_CACHE_HOME=/home/hermes/.cache \
  XDG_DATA_HOME=/home/hermes/.local/share \
  API_SERVER_ENABLED=true \
  API_SERVER_HOST=0.0.0.0 \
  API_SERVER_PORT=8642 \
  NO_COLOR=1

EXPOSE 8642

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hermes-gateway-entrypoint"]
