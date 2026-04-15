#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/scripts/kill-dev.sh"

pnpm -s dev | rg -i "error|warn|fatal|failed"
