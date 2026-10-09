#!/usr/bin/env bash

# Keep the repository command compatible; the deployable implementation belongs
# to the skill so agents do not need a checkout of this repository.
set -euo pipefail
paperclip_repo_scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$paperclip_repo_scripts/../skills/paperclip/scripts/paperclip-issue-update.sh" "$@"
