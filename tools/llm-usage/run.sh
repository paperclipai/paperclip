#!/usr/bin/env bash
# run.sh — täglicher LLM-Nutzungs-Digest (Vortag) an Walter, via Mailhub.
# Rein deterministisch (kein LLM). Aufruf durch launchd (08:00) oder manuell.
# Optionen werden 1:1 an digest.py durchgereicht (z.B. --dry-run, --day YYYY-MM-DD).
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/python3 "$DIR/digest.py" "$@"
