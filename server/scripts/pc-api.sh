#!/usr/bin/env bash
# pc-api.sh — Blessed client for Paperclip API requests.
# Prints only JSON response body on success,
# writes server errors to stderr, exits non-zero on 4xx/5xx.
set -euo pipefail

METHOD="${1:-}"
PATH_ARG="${2:-}"
BODY="${3-}"
BODY_SET=0
if [[ $# -ge 3 ]]; then
  BODY_SET=1
elif [[ ! -t 0 ]]; then
  BODY=$(cat)
  [[ -n "$BODY" ]] && BODY_SET=1
fi

if [[ -z "$METHOD" || -z "$PATH_ARG" ]]; then
  echo "Usage: $0 <get|post|patch|put|delete> <path> [json-body]" >&2
  exit 1
fi

# Normalize method to upper case — curl -X is case-sensitive.
METHOD=$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')

# --- URL assembly: strip /api suffix then prepend caller path verbatim ---
BASE="${PAPERCLIP_API_URL%/}"
BASE="${BASE%/api}"
case "$PATH_ARG" in
  /*) ;;
  *) PATH_ARG="/$PATH_ARG" ;;
esac
URL="${BASE}${PATH_ARG}"

CURL_ARGS=(-sS --fail-with-body -X "$METHOD")
CURL_ARGS+=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")

# Run-id header belongs on mutations only.
if [[ "$METHOD" != "GET" && -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  CURL_ARGS+=(-H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID}")
fi

if [[ "$BODY_SET" -eq 1 ]]; then
  CURL_ARGS+=(-H "Content-Type: application/json")
  curl "${CURL_ARGS[@]}" "$URL" --data-binary "$BODY"
else
  curl "${CURL_ARGS[@]}" "$URL"
fi