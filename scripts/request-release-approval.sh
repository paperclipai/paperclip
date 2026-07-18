#!/usr/bin/env bash
# request-release-approval.sh — raise (or spool) a weekly release-approval request_confirmation.
#
# HOOK MODE  (positional args, called by cortex-weekly-train.sh as $CORTEX_RELEASE_APPROVAL_REQUEST_CMD):
#   request-release-approval.sh <CANDIDATE_SHA> <SUMMARY>
#   Writes the candidate + summary to spool files and emits a journald ALERT.
#   Always exits 0 — must never fail the train.
#
# ROUTINE MODE (no args, called by the Paperclip weekly routine in agent-context):
#   request-release-approval.sh
#   Reads the spool files; if a green candidate lacks a matching approval token, POSTs a
#   request_confirmation to the board issue (idempotent).
#
# STATUS MODE:
#   request-release-approval.sh --status
#   Prints candidate/token/api state; no side effects.
#
# DRY-RUN MODE:
#   request-release-approval.sh --dry-run
#   Prints the interaction payload JSON without POSTing.
#
# Env vars (with defaults):
#   CORTEX_RELEASE_PENDING_FILE   /var/tmp/cortex-release-pending.ref
#   CORTEX_RELEASE_APPROVAL_FILE  /var/tmp/cortex-release-approval.token
#   CORTEX_RELEASE_SUMMARY_FILE   /var/tmp/cortex-release-summary.txt
#   CORTEX_RELEASE_APPROVAL_ISSUE <required for routine/dry-run modes>
#   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID  (injected by heartbeat)
set -euo pipefail

CORTEX_RELEASE_PENDING_FILE="${CORTEX_RELEASE_PENDING_FILE:-/var/tmp/cortex-release-pending.ref}"
CORTEX_RELEASE_APPROVAL_FILE="${CORTEX_RELEASE_APPROVAL_FILE:-/var/tmp/cortex-release-approval.token}"
CORTEX_RELEASE_SUMMARY_FILE="${CORTEX_RELEASE_SUMMARY_FILE:-/var/tmp/cortex-release-summary.txt}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

alert() { printf 'ALERT: %s\n' "$*" >&2; }

# ── Detect mode ──────────────────────────────────────────────────────────────

# Hook mode: first arg looks like a SHA (not a flag)
if [[ $# -ge 1 && "$1" != --* ]]; then
  HOOK_CANDIDATE="$1"
  HOOK_SUMMARY="${2:-}"

  printf '%s\n' "$HOOK_CANDIDATE" >"$CORTEX_RELEASE_PENDING_FILE" 2>/dev/null \
    || { printf 'ALERT: could not write pending-ref to %s\n' "$CORTEX_RELEASE_PENDING_FILE" >&2; }
  printf '%s\n' "$HOOK_SUMMARY" >"$CORTEX_RELEASE_SUMMARY_FILE" 2>/dev/null \
    || { printf 'ALERT: could not write summary to %s\n' "$CORTEX_RELEASE_SUMMARY_FILE" >&2; }

  alert "release candidate ${HOOK_CANDIDATE} awaiting CTO approval."
  alert "to approve, write the token and restart the train:"
  alert "  echo ${HOOK_CANDIDATE} > ${CORTEX_RELEASE_APPROVAL_FILE}"
  alert "  systemctl start cortex-weekly-train.service"
  exit 0
fi

MODE="routine"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --status)  MODE="status"  ;;
  esac
done

# ── Read candidate from spool ─────────────────────────────────────────────────

CANDIDATE=""
if [[ -r "$CORTEX_RELEASE_PENDING_FILE" ]]; then
  CANDIDATE=$(awk '!/^[[:space:]]*#/ && NF { print $1; exit }' "$CORTEX_RELEASE_PENDING_FILE" 2>/dev/null || true)
fi

if [[ -z "$CANDIDATE" ]]; then
  echo "no pending release candidate (${CORTEX_RELEASE_PENDING_FILE} absent or empty)"
  exit 0
fi

# ── Status mode ───────────────────────────────────────────────────────────────

if [[ "$MODE" == "status" ]]; then
  echo "candidate:    $CANDIDATE"
  echo "target issue: ${CORTEX_RELEASE_APPROVAL_ISSUE:-<unset>}"
  if [[ -n "${PAPERCLIP_API_URL:-}${PAPERCLIP_API_KEY:-}" ]]; then
    echo "api: present"
  else
    echo "api: <absent — no PAPERCLIP_API_URL / PAPERCLIP_API_KEY>"
  fi
  if [[ -r "$CORTEX_RELEASE_APPROVAL_FILE" ]]; then
    echo "token file: $(cat "$CORTEX_RELEASE_APPROVAL_FILE")"
  else
    echo "token file: <none>"
  fi
  exit 0
fi

# ── Already approved? (idempotency guard) ─────────────────────────────────────

if [[ -r "$CORTEX_RELEASE_APPROVAL_FILE" ]]; then
  TOKEN=$(awk '!/^[[:space:]]*#/ && NF { print $1; exit }' "$CORTEX_RELEASE_APPROVAL_FILE" 2>/dev/null || true)
  if [[ "$TOKEN" == "$CANDIDATE" ]]; then
    echo "candidate ${CANDIDATE:0:12} already has a matching CTO approval token — nothing to raise."
    exit 0
  fi
fi

# ── Read summary ──────────────────────────────────────────────────────────────

SUMMARY=""
if [[ -r "$CORTEX_RELEASE_SUMMARY_FILE" ]]; then
  SUMMARY=$(cat "$CORTEX_RELEASE_SUMMARY_FILE")
fi

# ── Dry-run mode ──────────────────────────────────────────────────────────────

if [[ "$MODE" == "dry-run" ]]; then
  exec node "$HERE/request-release-approval.mjs" \
    --candidate "$CANDIDATE" \
    --issue "${CORTEX_RELEASE_APPROVAL_ISSUE:-}" \
    --summary "$SUMMARY" \
    --dry-run
fi

# ── Routine mode: emit ALERT fallback then attempt live POST ──────────────────

alert "release candidate ${CANDIDATE} awaiting CTO approval."
alert "to approve, write the token and restart the train:"
alert "  echo ${CANDIDATE} > ${CORTEX_RELEASE_APPROVAL_FILE}"
alert "  systemctl start cortex-weekly-train.service"

if [[ -z "${CORTEX_RELEASE_APPROVAL_ISSUE:-}" ]]; then
  alert "CORTEX_RELEASE_APPROVAL_ISSUE is unset — cannot raise request_confirmation"
  exit 2
fi

if [[ -z "${PAPERCLIP_API_URL:-}${PAPERCLIP_API_KEY:-}" ]]; then
  alert "no Paperclip API creds (PAPERCLIP_API_URL / PAPERCLIP_API_KEY unset) — cannot raise request_confirmation"
  exit 2
fi

exec node "$HERE/request-release-approval.mjs" \
  --candidate "$CANDIDATE" \
  --issue "$CORTEX_RELEASE_APPROVAL_ISSUE" \
  --summary "$SUMMARY"
