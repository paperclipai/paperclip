FROM docker.io/cloudflare/sandbox:0.7.0

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    python3 \
    python3-pip \
    python3-venv \
    tar \
  && rm -rf /var/lib/apt-lists/*

RUN python3 -m pip install --break-system-packages hatch 2>/dev/null \
  || python3 -m pip install --user hatch 2>/dev/null \
  || true

RUN npm install -g typescript 2>/dev/null || true

WORKDIR /workspace
