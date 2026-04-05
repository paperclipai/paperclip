#!/usr/bin/env bash
# System packages needed for `pnpm install` on Linux (sharp/libvips, node-gyp, optional native builds).
# Debian/Ubuntu: run as root: sudo ./scripts/ensure-linux-build-deps.sh
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  exec sudo "$0" "$@"
fi

if [[ -f /etc/debian_version ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    python3 \
    pkg-config \
    libvips-dev
  echo "ok: Debian/Ubuntu packages installed."
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache python3 make g++ vips-dev fftw-dev
  echo "ok: Alpine packages installed."
else
  echo "Unsupported OS: install a C++ toolchain, python3, pkg-config, and vips dev headers (libvips-dev / vips-dev)." >&2
  exit 1
fi
