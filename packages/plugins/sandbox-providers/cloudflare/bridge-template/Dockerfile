FROM docker.io/cloudflare/sandbox:0.12.10

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

RUN git config --system --add safe.directory '*'
ENV TAR_OPTIONS=--no-same-owner
RUN printf 'export TAR_OPTIONS=--no-same-owner\n' > /etc/profile.d/paperclip-tar.sh

WORKDIR /workspace
