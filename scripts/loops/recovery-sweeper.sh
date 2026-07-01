#!/usr/bin/env bash
# Recovery Sweeper local entrypoint — LES §2 scheduled loop.
# SAG-3582: reference adopter for the single-runner guard.
#
# Sources local-loop-guard.sh so only one Recovery Sweeper daemon can run on
# the local box at a time (LES §4 prohibition #1).  A second invocation is
# rejected with exit 1 and a clear message naming the holding PID.
#
# Usage:
#   scripts/loops/recovery-sweeper.sh
#
# The sweeper runs a bounded scan (LES §1 part 4) — never "loop till empty" as
# a daemon.  Termination: exits 0 when the sweep completes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Single-runner guard — exits 1 if another instance is already running.
# shellcheck source=../local-loop-guard.sh
. "${REPO_ROOT}/scripts/local-loop-guard.sh"

# ── Sweep logic ───────────────────────────────────────────────────────────────
# Goal (LES §1 part 1): reconcile stalled/stuck issues and requeue them.
# Tools (LES §1 part 2): Paperclip API (PATCH /api/issues/:id).
# Termination (LES §1 part 4): fixed item list returned by the API query below.
# Error handling (LES §1 part 5): log failures per item; do not abort the sweep.

API_URL="${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"
API_KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is required}"

printf '[recovery-sweeper] starting sweep at %s\n' "$(date -u +%FT%TZ)"

curl -fsSL \
    -H "Authorization: Bearer ${API_KEY}" \
    "${API_URL}/api/agents/me/inbox-lite" \
    | jq -c '.[] | select(.status == "in_progress")' \
    | while IFS= read -r issue; do
        id="$(echo "${issue}" | jq -r '.id')"
        printf '[recovery-sweeper] checking issue %s\n' "${id}"
        # Real sweep logic goes here; this stub proves the LES §1 structure.
    done

printf '[recovery-sweeper] sweep complete at %s\n' "$(date -u +%FT%TZ)"
