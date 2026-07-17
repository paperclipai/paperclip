#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  paperclip-save-document.sh --key KEY --title TITLE --body-file FILE [options]

Safely writes (creates or updates) a Paperclip issue document, honoring the
optimistic-concurrency contract of PUT /api/issues/{id}/documents/{key}:

  - Reads the current document first to obtain latestRevisionId.
  - Sends baseRevisionId on updates; omits it on create.
  - On HTTP 409, retries ONCE using details.currentRevisionId.
  - Refuses to report success on any non-2xx response (exits non-zero).
  - Verifies the write by re-reading and confirming the revision advanced.

This exists because the API returns 409 (not a silent no-op) when baseRevisionId
is missing or stale. Hand-rolled callers that ignore the status report false
success. This helper never does. Use it instead of a bare curl PUT.

Required environment:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID
  PAPERCLIP_TASK_ID (used as the default issue id)

Options:
  --key KEY              Document key (e.g. plan, facebook-groups) [required]
  --title TITLE          Document title [required]
  --body-file FILE       File whose contents become the document body [required]
  --issue-id ID          Issue id to write to (default: PAPERCLIP_TASK_ID)
  --format FORMAT        Document format (default: markdown)
  --change-summary TEXT  Optional change summary recorded on the revision
  --output FORMAT        markdown or json (default: markdown)
  --dry-run              Print the resolved request without calling the API
  --help, -h             Show this help

Example:
  scripts/paperclip-save-document.sh --key plan --title Plan \
    --body-file plan.md --change-summary "initial plan"
EOF
}

fail() { echo "paperclip-save-document: $*" >&2; exit 1; }

KEY=""; TITLE=""; BODY_FILE=""; ISSUE_ID="${PAPERCLIP_TASK_ID:-}"
FORMAT="markdown"; CHANGE_SUMMARY=""; OUTPUT="markdown"; DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="$2"; shift 2;;
    --title) TITLE="$2"; shift 2;;
    --body-file) BODY_FILE="$2"; shift 2;;
    --issue-id) ISSUE_ID="$2"; shift 2;;
    --format) FORMAT="$2"; shift 2;;
    --change-summary) CHANGE_SUMMARY="$2"; shift 2;;
    --output) OUTPUT="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --help|-h) usage; exit 0;;
    *) fail "unknown argument: $1 (see --help)";;
  esac
done

[ -n "$KEY" ] || fail "--key is required"
[ -n "$TITLE" ] || fail "--title is required"
[ -n "$BODY_FILE" ] || fail "--body-file is required"
[ -f "$BODY_FILE" ] || fail "body file not found: $BODY_FILE"
[ -n "$ISSUE_ID" ] || fail "--issue-id or PAPERCLIP_TASK_ID is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

BODY="$(cat "$BODY_FILE")"

emit() { # $1 status ("ok"/"failed"), $2 revision number, $3 revision id, $4 message
  if [ "$OUTPUT" = "json" ]; then
    jq -n --arg s "$1" --arg k "$KEY" --argjson rn "${2:-0}" --arg ri "${3:-}" --arg m "${4:-}" \
      '{status:$s, key:$k, revisionNumber:$rn, revisionId:$ri, message:$m}'
  else
    echo "paperclip-save-document: $1 $KEY -> revision ${2:-?} (${3:-})${4:+ — $4}"
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN: PUT $PAPERCLIP_API_URL/api/issues/$ISSUE_ID/documents/$KEY"
  echo "  title=$TITLE format=$FORMAT bodyBytes=${#BODY} changeSummary=${CHANGE_SUMMARY:-<none>}"
  exit 0
fi

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"
: "${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY is required}"
: "${PAPERCLIP_RUN_ID:?PAPERCLIP_RUN_ID is required}"

BASE="$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/documents/$KEY"
AUTH=(-H "Authorization: Bearer $PAPERCLIP_API_KEY")
RUN=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")

mkbody() { # $1 = baseRevisionId ("" -> omitted, create path)
  jq -n --arg t "$TITLE" --arg f "$FORMAT" --arg b "$BODY" \
        --arg cs "$CHANGE_SUMMARY" --arg br "$1" \
    '{title:$t, format:$f, body:$b}
     | (if $cs != "" then .changeSummary=$cs else . end)
     | (if $br != "" then .baseRevisionId=$br else . end)'
}

put() { # $1 = baseRevisionId ; echoes "<body>\n<httpStatus>"
  curl -sS -w $'\n%{http_code}' -X PUT "$BASE" "${AUTH[@]}" "${RUN[@]}" \
    -H "Content-Type: application/json" -d "$(mkbody "$1")"
}

read_state() { # sets GET_CODE, GET_REV, GET_REVNUM
  local out; out="$(curl -sS -w $'\n%{http_code}' "$BASE" "${AUTH[@]}")"
  GET_CODE="${out##*$'\n'}"; local json="${out%$'\n'*}"
  if [ "$GET_CODE" = "200" ]; then
    GET_REV="$(jq -r '.latestRevisionId // empty' <<<"$json")"
    GET_REVNUM="$(jq -r '.latestRevisionNumber // 0' <<<"$json")"
  else GET_REV=""; GET_REVNUM=0; fi
}

# 1. Read current state (404 => create path, 200 => update path).
read_state
[ "$GET_CODE" = "200" ] || [ "$GET_CODE" = "404" ] || fail "unexpected GET $GET_CODE for $KEY"
BEFORE_REV="$GET_REVNUM"

# 2. First write.
resp="$(put "$GET_REV")"; code="${resp##*$'\n'}"; payload="${resp%$'\n'*}"

# 3. Recover once from a 409 using the server-reported current revision.
if [ "$code" = "409" ]; then
  cur="$(jq -r '.details.currentRevisionId // empty' <<<"$payload")"
  [ -n "$cur" ] || fail "409 without currentRevisionId, cannot recover: $payload"
  echo "paperclip-save-document: 409 (stale/missing baseRevisionId); retrying with $cur" >&2
  resp="$(put "$cur")"; code="${resp##*$'\n'}"; payload="${resp%$'\n'*}"
fi

# 4. Never report success on a non-2xx.
[ "${code:0:1}" = "2" ] || { emit failed 0 "" "write failed (HTTP $code): $payload" >&2; exit 1; }

# 5. Verify the revision actually advanced.
read_state
if [ "$GET_CODE" != "200" ] || [ "$GET_REVNUM" -le "$BEFORE_REV" ]; then
  emit failed "$GET_REVNUM" "$GET_REV" "post-write verify failed (before=$BEFORE_REV after=$GET_REVNUM code=$GET_CODE)" >&2
  exit 1
fi

emit ok "$GET_REVNUM" "$GET_REV" "verified"
