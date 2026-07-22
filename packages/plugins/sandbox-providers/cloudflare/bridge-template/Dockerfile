FROM docker.io/cloudflare/sandbox:0.7.0

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
