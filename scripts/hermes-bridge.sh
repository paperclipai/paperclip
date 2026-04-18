#!/bin/bash
# hermes-bridge.sh — Bridges the hermes_local adapter to the hermes-agent sidecar container.
#
# The hermes_local adapter calls `hermesCommand chat -q "..." -Q -m model`.
# This script forwards that invocation into the hermes-agent Docker container
# via `docker exec`, using the host Docker socket mounted at /var/run/docker.sock.
#
# Configure: adapter_config.hermesCommand = "/app/scripts/hermes-bridge.sh"

HERMES_CONTAINER="${HERMES_CONTAINER_NAME:-hermes-agent}"

# hermes CLI is at /opt/hermes/.venv/bin/hermes — NOT in the container's $PATH,
# so we must use the absolute path to avoid "executable not found in $PATH".
docker exec -i "$HERMES_CONTAINER" /opt/hermes/.venv/bin/hermes "$@"
rc=$?

# Hermes CLI occasionally exits with 134 (SIGABRT) during cleanup after
# completing work successfully.  Treat 134 as success so the heartbeat
# run is not marked "failed" when the actual output is fine.
if [ "$rc" -eq 134 ]; then
  echo "[hermes-bridge] Masked exit code 134 (SIGABRT during cleanup) as success" >&2
  exit 0
fi

exit "$rc"
