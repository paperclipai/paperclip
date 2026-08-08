FROM node:22-bookworm

ENV container=docker

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dbus \
    dbus-user-session \
    git \
    gzip \
    jq \
    procps \
    sudo \
    systemd \
    systemd-sysv \
    tar \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && usermod --login e2e --home /home/e2e --move-home --shell /bin/bash node \
  && groupmod --new-name e2e node \
  && printf 'e2e ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/e2e \
  && chmod 0440 /etc/sudoers.d/e2e \
  && systemctl mask \
    dev-hugepages.mount \
    sys-fs-fuse-connections.mount \
    systemd-remount-fs.service

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
