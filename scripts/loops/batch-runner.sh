#!/usr/bin/env bash
# Enrichment batch-runner local entrypoint — LES §2 domain loop.
# SAG-3582: reference adopter for the single-runner guard.
#
# Sources local-loop-guard.sh so only one enrichment batch-runner can run on
# the local box at a time (LES §4 prohibition #1).  A second invocation is
# rejected with exit 1 and a clear message naming the holding PID.
#
# The underlying Python script (enrichment/batch_runner.py) carries its own
# in-process flock guard (SAG-3529).  This shell wrapper adds a second,
# outer, well-known-path guard so the prohibition is enforced even before the
# Python process starts.
#
# Usage:
#   scripts/loops/batch-runner.sh [-- EXTRA_ARGS...]
#
# Environment:
#   ENRICHMENT_DIR   path to the enrichment package (default: auto-detected)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Single-runner guard — exits 1 if another local loop daemon is already running.
# shellcheck source=../local-loop-guard.sh
. "${REPO_ROOT}/scripts/local-loop-guard.sh"

# ── Dispatch to the Python batch runner ──────────────────────────────────────
ENRICHMENT_DIR="${ENRICHMENT_DIR:-}"

# Try to locate batch_runner.py relative to the known project layout.
if [[ -z "${ENRICHMENT_DIR}" ]]; then
    # Resolve from the Paperclip instance root by looking for the canonical path.
    INSTANCE_ROOT="$(cd "${REPO_ROOT}/../../.." && pwd)"
    ENRICHMENT_CANDIDATE="${INSTANCE_ROOT}/projects/${PAPERCLIP_COMPANY_ID:-}/*/enrichment"
    # shellcheck disable=SC2206
    candidates=( ${ENRICHMENT_CANDIDATE} )
    if [[ ${#candidates[@]} -gt 0 && -d "${candidates[0]}" ]]; then
        ENRICHMENT_DIR="${candidates[0]}"
    fi
fi

if [[ -z "${ENRICHMENT_DIR}" || ! -f "${ENRICHMENT_DIR}/batch_runner.py" ]]; then
    printf 'batch-runner: ERROR — cannot locate enrichment/batch_runner.py\n' \
        'Set ENRICHMENT_DIR to the enrichment package directory.\n' >&2
    exit 1
fi

printf '[batch-runner] starting at %s (pid %d)\n' "$(date -u +%FT%TZ)" "$$"
exec python3 "${ENRICHMENT_DIR}/batch_runner.py" "$@"
