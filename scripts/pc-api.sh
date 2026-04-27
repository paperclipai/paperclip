#!/usr/bin/env bash
# pc-api.sh — Convenience wrapper for Paperclip API requests.
# Handles auth headers and env vars so agents don't need raw curl + pipe patterns.
#
# Usage:
#   scripts/pc-api.sh get /api/agents/me
#   scripts/pc-api.sh get "/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=todo"
#   scripts/pc-api.sh post /api/issues/{id}/checkout '{"agentId":"...","expectedStatuses":["todo"]}'
#   scripts/pc-api.sh patch /api/issues/{id} '{"status":"done","comment":"Done"}'
#   scripts/pc-api.sh delete /api/attachments/{id}
#
# Output goes to stdout (raw JSON). To process in Python, write to a temp file:
#   scripts/pc-api.sh get /api/agents/me > /tmp/pc_resp.json
#   python3 -c "import json; d=json.load(open('/tmp/pc_resp.json')); print(d['name'])"
#
# Or use the --py flag to auto-extract a field:
#   scripts/pc-api.sh --py '.name' get /api/agents/me
#
# Environment (required): PAPERCLIP_API_URL, PAPERCLIP_API_KEY
# Environment (optional): PAPERCLIP_RUN_ID (added as X-Paperclip-Run-Id on mutating requests)

set -euo pipefail

# --- arg parsing ---
PY_EXPR=""
if [[ "${1:-}" == "--py" ]]; then
  PY_EXPR="${2:?--py requires a Python expression (e.g. '.name' or 'len(_)')}"
  shift 2
fi

METHOD="${1:?Usage: pc-api.sh [--py EXPR] <get|post|patch|put|delete> <path> [body]}"
PATH_ARG="${2:?Missing API path}"
BODY="${3:-}"

# Normalize method
METHOD=$(echo "$METHOD" | tr '[:lower:]' '[:upper:]')

# Validate env
if [[ -z "${PAPERCLIP_API_URL:-}" ]]; then
  echo "Error: PAPERCLIP_API_URL not set" >&2; exit 1
fi
if [[ -z "${PAPERCLIP_API_KEY:-}" ]]; then
  echo "Error: PAPERCLIP_API_KEY not set" >&2; exit 1
fi

# Build URL
URL="${PAPERCLIP_API_URL}${PATH_ARG}"

# Build curl args
CURL_ARGS=(-sS)
CURL_ARGS+=(-H "Authorization: Bearer ${PAPERCLIP_API_KEY}")
CURL_ARGS+=(-H "Content-Type: application/json")

# Add run-id header on mutating requests
if [[ "$METHOD" != "GET" && -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  CURL_ARGS+=(-H "X-Paperclip-Run-Id: ${PAPERCLIP_RUN_ID}")
fi

# Method-specific
case "$METHOD" in
  GET)
    CURL_ARGS+=("$URL")
    ;;
  POST|PATCH|PUT)
    if [[ -z "$BODY" ]]; then
      echo "Error: $METHOD requires a JSON body argument" >&2; exit 1
    fi
    CURL_ARGS+=(-X "$METHOD" --data-binary "$BODY" "$URL")
    ;;
  DELETE)
    CURL_ARGS+=(-X DELETE "$URL")
    ;;
  *)
    echo "Error: unsupported method $METHOD" >&2; exit 1
    ;;
esac

# Execute
RAW=$(curl "${CURL_ARGS[@]}")

# If --py, process with Python
if [[ -n "$PY_EXPR" ]]; then
  python3 -c "
import json, sys
data = json.loads('''${RAW}''')
# Support dotted path like .name or .data.id
expr = '${PY_EXPR}'
if expr.startswith('.'):
    parts = expr[1:].split('.')
    result = data
    for p in parts:
        if isinstance(result, dict):
            result = result[p]
        elif isinstance(result, list) and p.isdigit():
            result = result[int(p)]
        else:
            result = getattr(result, p)
    print(result)
else:
    _ = data
    print(eval(expr))
"
else
  echo "$RAW"
fi
