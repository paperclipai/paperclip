#!/usr/bin/env bash
# pc-api.sh — Blessed client for Paperclip API requests.
#
# Why this exists: bare `curl -sS` exits 0 on 4xx/5xx. Piping it into
# `jq -r '.id'` turns a 403 rejection into the string "null", which reads as an
# empty success. A wrong-route typo and a successful write become
# indistinguishable, and writes get silently dropped.
#
# This wrapper fails loudly instead: any non-2xx status exits non-zero and
# writes the server's error to stderr (so it lands in run logs). On success it
# emits only the JSON body on stdout, so it is a drop-in for raw curl:
#
#   scripts/pc-api.sh get /api/agents/me | jq -r '.name'
#
# Usage:
#   scripts/pc-api.sh get /api/agents/me
#   scripts/pc-api.sh get "/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=todo"
#   scripts/pc-api.sh post /api/issues/{id}/checkout '{"agentId":"...","expectedStatuses":["todo"]}'
#   scripts/pc-api.sh patch /api/issues/{id} '{"status":"done","comment":"Done"}'
#   scripts/pc-api.sh delete /api/attachments/{id}
#
# Bodies may also be fed on stdin, which avoids argv-escaping multiline JSON:
#   jq -n --arg comment "$body" '{comment:$comment}' | scripts/pc-api.sh patch /api/issues/{id}
#
# To process a response in Python, write it to a file first — never pipe an API
# response into an interpreter:
#   scripts/pc-api.sh get /api/agents/me > /tmp/pc_resp.json
#   python3 -c "import json; print(json.load(open('/tmp/pc_resp.json'))['name'])"
#
# Environment (required): PAPERCLIP_API_URL, PAPERCLIP_API_KEY
# Environment (optional): PAPERCLIP_RUN_ID (sent as X-Paperclip-Run-Id on mutations)

set -euo pipefail

usage() {
  echo "Usage: pc-api.sh <get|post|patch|put|delete> <path> [json-body]" >&2
  echo "       body may also be supplied on stdin" >&2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--py" ]]; then
  echo "Error: --py was removed. It eval()'d caller input against the HTTP response." >&2
  echo "       Pipe to jq instead: pc-api.sh get /api/agents/me | jq -r '.name'" >&2
  exit 2
fi

METHOD="${1:-}"
PATH_ARG="${2:-}"

if [[ -z "$METHOD" || -z "$PATH_ARG" ]]; then
  usage
  exit 2
fi

# Normalize method to upper case.
METHOD=$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')

# --- env validation ---
if [[ -z "${PAPERCLIP_API_URL:-}" ]]; then
  echo "Error: PAPERCLIP_API_URL not set" >&2
  exit 1
fi
if [[ -z "${PAPERCLIP_API_KEY:-}" ]]; then
  echo "Error: PAPERCLIP_API_KEY not set" >&2
  exit 1
fi

# --- URL assembly ---
# Normalize the /api-suffix dance once, here, so callers never have to. The base
# is reduced to an origin (no trailing slash, no trailing /api) and the caller's
# path is used verbatim, whether or not it starts with /api.
BASE="${PAPERCLIP_API_URL%/}"
BASE="${BASE%/api}"
case "$PATH_ARG" in
  /*) ;;
  *) PATH_ARG="/$PATH_ARG" ;;
esac
URL="${BASE}${PATH_ARG}"

# --- body resolution: argv wins, else stdin when it is not a TTY ---
BODY="${3-}"
BODY_SET=0
if [[ $# -ge 3 ]]; then
  BODY_SET=1
elif [[ ! -t 0 ]]; then
  BODY=$(cat)
  [[ -n "$BODY" ]] && BODY_SET=1
fi

CURL_ARGS=(-sS -X "$METHOD")
CURL_ARGS+=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")

# Run-id header belongs on mutations only.
if [[ "$METHOD" != "GET" && -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  CURL_ARGS+=(-H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID}")
fi

case "$METHOD" in
  GET | DELETE) ;;
  POST | PATCH | PUT)
    if [[ "$BODY_SET" -ne 1 ]]; then
      echo "Error: $METHOD requires a JSON body (argv or stdin)" >&2
      exit 2
    fi
    ;;
  *)
    echo "Error: unsupported method $METHOD" >&2
    exit 2
    ;;
esac

if [[ "$BODY_SET" -eq 1 ]]; then
  CURL_ARGS+=(-H "Content-Type: application/json")
  CURL_ARGS+=(--data-binary "$BODY")
fi

# --- request ---
# Body goes to a temp file so the status code can be inspected before anything
# is written to stdout. This is the whole point of the wrapper.
BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/pc-api.XXXXXX")
cleanup() { rm -f "$BODY_FILE"; }
trap cleanup EXIT

HTTP_CODE=$(curl "${CURL_ARGS[@]}" -o "$BODY_FILE" -w '%{http_code}' "$URL") || {
  CURL_STATUS=$?
  echo "pc-api: request to $METHOD $URL failed (curl exit $CURL_STATUS)" >&2
  if [[ -s "$BODY_FILE" ]]; then cat "$BODY_FILE" >&2; fi
  exit 1
}

# --- the status gate ---
if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
  echo "pc-api: $METHOD $URL failed with HTTP $HTTP_CODE" >&2
  if [[ -s "$BODY_FILE" ]]; then
    # Surface the server's `error` string when the response is JSON; otherwise
    # dump the raw body. Either way it goes to stderr, so it reaches run logs.
    if command -v jq >/dev/null 2>&1; then
      ERR=$(jq -r 'if type == "object" then (.error // .message // empty) else empty end' \
        <"$BODY_FILE" 2>/dev/null || true)
      if [[ -n "$ERR" && "$ERR" != "null" ]]; then
        echo "pc-api: error: $ERR" >&2
      else
        cat "$BODY_FILE" >&2
        echo >&2
      fi
    else
      cat "$BODY_FILE" >&2
      echo >&2
    fi
  else
    echo "pc-api: (empty response body)" >&2
  fi
  exit 1
fi

# Success: JSON body only, nothing else, so `| jq` is a drop-in.
cat "$BODY_FILE"
