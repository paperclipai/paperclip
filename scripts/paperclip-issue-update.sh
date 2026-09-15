#!/usr/bin/env bash
# Keep repository callers working; the installed runtime skill owns this helper.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/../skills/paperclip/scripts/paperclip-issue-update.sh" "$@"
