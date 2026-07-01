#!/usr/bin/env bash
set -euo pipefail

if command -v systemd-detect-virt >/dev/null 2>&1; then
  if ! systemd-detect-virt --quiet --container; then
    echo "This script is intended to run inside a Proxmox LXC container." >&2
    exit 1
  fi
fi

cat <<'EOF'
Before running Docker inside Proxmox LXC, the container should usually be configured with:
  - features: nesting=1,keyctl=1
  - privileged container preferred
  - enough disk/RAM for image builds
If Docker fails to start, check the matching guidance in doc/PROXMOX.md.
EOF

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/bootstrap-ubuntu.sh"
