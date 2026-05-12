#!/usr/bin/env bash
# Inbox preflight check for heartbeat runs.
#
# Exits 0 if the agent has actionable work in its inbox (LLM should proceed).
# Exits 1 if the inbox is empty / all items are blocked with no new context
# (heartbeat should be recorded as skipped_preflight, saving LLM tokens).
#
# Required env: PAPERCLIP_API_KEY
# Args:
#   --api-url  <url>  Paperclip API base URL, e.g. http://127.0.0.1:3100 (required)

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/heartbeat-inbox-preflight.sh --api-url <url>

Env:
  PAPERCLIP_API_KEY  short-lived run JWT (required, never passed in argv)

Exit codes:
  0  inbox has actionable work — proceed with LLM invocation
  1  inbox is empty — skip LLM invocation (record as skipped_preflight)
  2  fatal error (API unreachable, missing args, etc.) — treat as pass-through (proceed)
EOF
}

api_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      api_url="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$api_url" ]]; then
  printf '[preflight] Missing --api-url\n' >&2
  exit 2
fi

if [[ -z "${PAPERCLIP_API_KEY:-}" ]]; then
  printf '[preflight] Missing PAPERCLIP_API_KEY env var\n' >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '[preflight] jq not found — cannot parse inbox response, proceeding\n' >&2
  exit 0
fi

# Each invocation gets its own temp file to avoid races under concurrent runs.
inbox_tmp=$(mktemp /tmp/paperclip_preflight_inbox.XXXXXX.json)
trap 'rm -f "$inbox_tmp"' EXIT

# Fetch compact inbox. Use --max-time so a hung API server does not block the run.
# The JWT in PAPERCLIP_API_KEY unambiguously identifies the agent — no explicit ID needed.
http_code=$(curl -sS -o "$inbox_tmp" -w "%{http_code}" \
  --max-time 10 \
  "$api_url/api/agents/me/inbox-lite" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" 2>/dev/null) || {
  printf '[preflight] curl failed — proceeding with LLM\n' >&2
  exit 0
}

if [[ "$http_code" != "200" ]]; then
  printf '[preflight] inbox-lite returned HTTP %s — proceeding with LLM\n' "$http_code" >&2
  exit 0
fi

# Count todo / in_progress / in_review items. Blocked items are excluded:
# the agent cannot proceed without external input, so a blocked-only inbox
# is treated as empty.
actionable=$(jq '[.[] | select(.status == "todo" or .status == "in_progress" or .status == "in_review")] | length' \
  "$inbox_tmp" 2>/dev/null) || actionable="-1"

if [[ "$actionable" == "-1" ]]; then
  printf '[preflight] Failed to parse inbox response — proceeding with LLM\n' >&2
  exit 0
fi

if [[ "$actionable" -gt 0 ]]; then
  printf '[preflight] %s actionable item(s) in inbox — proceeding with LLM\n' "$actionable" >&2
  exit 0
fi

printf '[preflight] Inbox empty (0 actionable items) — skipping LLM invocation\n' >&2
exit 1
