#!/usr/bin/env bash
set -euo pipefail

# Service-manager entrypoint for delegate mode.
#
# The platform supervisor (systemd user unit / launchd agent) invokes the
# configured shim as: <shim> run --instance <id>. Those CLI-style args belong
# to the managed `paperclipai` shim and are intentionally ignored here: the
# instance is selected via PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID environment
# variables that the service definition sets.
#
# Delegate server defaults come from run-delegate plus the instance .env file.
# Background services must never attempt to open a browser on boot.

delegate_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
export PAPERCLIP_OPEN_ON_LISTEN="${PAPERCLIP_OPEN_ON_LISTEN:-false}"

exec "$delegate_repo_root/run-delegate"
