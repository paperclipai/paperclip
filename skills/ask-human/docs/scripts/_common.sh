#!/usr/bin/env bash
# Shared helpers for the `communication` skill.
# Sourced by every other script in this folder.

set -euo pipefail

ROUTING_JSON="${OPENCLAW_ROUTING_JSON:-/Users/vasanth/.gsai/openclaw-routing.json}"

# Dry-run mode prints the openclaw CLI invocation instead of executing it.
DRY_RUN="${DRY_RUN:-0}"
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then DRY_RUN=1; fi
done

# Walk up from this file to find `.gsai/secret` and source it.
_load_gsai_secret() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/.gsai/secret" ]; then
      # shellcheck disable=SC1090
      source "$dir/.gsai/secret"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Patch a Paperclip issue's status. Accepts issue identifier (e.g. VAS-35) or UUID.
# Args: <issue-id-or-uuid> <new-status>
# Silent in dry-run. Returns non-zero on HTTP error (caller decides how to react).
patch_issue_status() {
  local issue="$1"
  local status="$2"
  local api_url="${PAPERCLIP_API_URL:-http://localhost:3100}"

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would PATCH ${api_url%/}/api/issues/${issue} status=${status}" >&2
    return 0
  fi

  if [ -z "${PAPERCLIP_API_KEY:-}" ]; then
    _load_gsai_secret || true
  fi

  local body_file="/tmp/ask-human-patch-body.$$.json"
  local http_code
  if [ -n "${PAPERCLIP_API_KEY:-}" ]; then
    http_code=$(curl -sS -o "$body_file" -w '%{http_code}' \
      -X PATCH "${api_url%/}/api/issues/${issue}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
      -d "{\"status\":\"${status}\"}" 2>/dev/null || echo "000")
  else
    http_code=$(curl -sS -o "$body_file" -w '%{http_code}' \
      -X PATCH "${api_url%/}/api/issues/${issue}" \
      -H "Content-Type: application/json" \
      -d "{\"status\":\"${status}\"}" 2>/dev/null || echo "000")
  fi

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    rm -f "$body_file"
    return 0
  fi

  echo "WARN: PATCH ${issue} → ${status} returned HTTP ${http_code}" >&2
  [ -f "$body_file" ] && cat "$body_file" >&2 && echo >&2
  rm -f "$body_file"
  return 1
}

# POST a comment on a Paperclip issue. Used by ask.sh to archive the full
# production context (scene headers, visuals, timing, etc.) on the issue
# after a video_script_request send, so clicking through from Discord shows
# the full brief.
# Args: <issue-id> <body>
post_issue_comment() {
  local issue="$1"
  local body="$2"
  local api_url="${PAPERCLIP_API_URL:-http://localhost:3100}"

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would POST ${api_url%/}/api/issues/${issue}/comments (${#body} chars)" >&2
    return 0
  fi

  if [ -z "${PAPERCLIP_API_KEY:-}" ]; then
    _load_gsai_secret || true
  fi

  # Build JSON body safely — escape the body via python (handles quotes, newlines).
  local json_payload
  json_payload=$(python3 -c 'import sys, json; body = sys.stdin.read(); print(json.dumps({"body": body}))' <<<"$body")

  local body_file="/tmp/ask-human-comment-body.$$.json"
  local http_code
  if [ -n "${PAPERCLIP_API_KEY:-}" ]; then
    http_code=$(curl -sS -o "$body_file" -w '%{http_code}' \
      -X POST "${api_url%/}/api/issues/${issue}/comments" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
      -d "$json_payload" 2>/dev/null || echo "000")
  else
    http_code=$(curl -sS -o "$body_file" -w '%{http_code}' \
      -X POST "${api_url%/}/api/issues/${issue}/comments" \
      -H "Content-Type: application/json" \
      -d "$json_payload" 2>/dev/null || echo "000")
  fi

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    rm -f "$body_file"
    return 0
  fi

  echo "WARN: POST ${issue}/comments returned HTTP ${http_code}" >&2
  [ -f "$body_file" ] && cat "$body_file" >&2 && echo >&2
  rm -f "$body_file"
  return 1
}

# Strip --dry-run from positional args, populate CLEAN_ARGS.
filter_args() {
  CLEAN_ARGS=()
  for a in "$@"; do
    [ "$a" = "--dry-run" ] || CLEAN_ARGS+=("$a")
  done
}

# Normalize a channel name: lowercase, strip leading '#'.
normalize_channel() {
  local name="$1"
  name="${name#\#}"
  printf '%s' "$name" | tr '[:upper:]' '[:lower:]'
}

# Resolve a channel name to its routing record.
# Prints JSON { id, name, paperclipPrefix, paperclipApi } to stdout.
# Exits non-zero with a message if the channel is unknown.
resolve_channel() {
  local want
  want="$(normalize_channel "$1")"

  if [ ! -f "$ROUTING_JSON" ]; then
    echo "ERR: routing file not found at $ROUTING_JSON" >&2
    return 2
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "ERR: jq is required to parse $ROUTING_JSON" >&2
    return 2
  fi

  local record
  record="$(jq -r --arg want "$want" '
    .channels | to_entries
    | map({id: .key} + .value)
    | map(select((.name // "" | ltrimstr("#") | ascii_downcase) == $want))
    | .[0] // empty
    | {id, name, paperclipPrefix: (.paperclip.prefix // null), paperclipApi: "" }
  ' "$ROUTING_JSON")"

  if [ -z "$record" ] || [ "$record" = "null" ]; then
    echo "ERR: channel '$1' not found in $ROUTING_JSON" >&2
    return 3
  fi

  local api
  api="$(jq -r '.paperclipApi // ""' "$ROUTING_JSON")"

  jq -n --argjson rec "$record" --arg api "$api" '$rec + {paperclipApi: $api}'
}

# Assert that <issue-id> uses the channel's org prefix.
# Args: <issue-id> <expected-prefix>
assert_prefix_match() {
  local issue="$1"
  local prefix="$2"

  if [ -z "$prefix" ] || [ "$prefix" = "null" ]; then
    echo "ERR: channel has no Paperclip org binding (prefix=null). Use a company channel." >&2
    return 4
  fi

  case "$issue" in
    "${prefix}-"[0-9]*) return 0 ;;
  esac

  echo "ERR: issue '$issue' does not match channel prefix '$prefix' (expected '${prefix}-N')." >&2
  return 5
}

# Pick an emoji/title phrase for a given `kind`.
render_title() {
  local kind="$1"
  local issue="$2"
  case "$kind" in
    video_script_request) printf '🎬 Video Script Request — [%s]' "$issue" ;;
    review_request)       printf '👀 Review Request — [%s]' "$issue" ;;
    approval_request)     printf '✅ Approval Request — [%s]' "$issue" ;;
    question)             printf '❓ Question — [%s]' "$issue" ;;
    handoff)              printf '🤝 Hand-off — [%s]' "$issue" ;;
    *)                    printf '📨 [%s]' "$issue" ;;
  esac
}

# Compose the final payload.
#
# Sets two globals:
#   PAYLOAD_BODY    — the Discord message text
#   PAYLOAD_ATTACH  — path to a .txt attachment, or empty string
#
# Two modes:
#
# 1) Body contains `=== TTS-READY SCRIPT ===` delimiter (video_script_request):
#    - ATTACHMENT is the TTS-only text below the delimiter — pure spoken words,
#      nothing else, no delimiter line. Designed for copy → paste → TTS tool
#      with zero cleanup. User should never have to delete a single character.
#    - DISCORD MESSAGE is header + production context above the delimiter.
#      May chunk across multiple Discord posts if long — that's fine, the
#      routing tag `[<PREFIX>-<N>]` is always in the first chunk, and reply-
#      to-first still routes correctly.
#
# 2) No delimiter (everything else — review_request, approval_request, etc.):
#    - Short (≤1500 chars) stays inline in a fenced code block.
#    - Long goes to a .txt attachment with the whole body.
compose_payload() {
  local kind="$1"
  local issue="$2"
  local body="$3"

  local title
  title="$(render_title "$kind" "$issue")"

  local delimiter="=== TTS-READY SCRIPT ==="

  if printf '%s' "$body" | grep -qF "$delimiter"; then
    # Split body at the delimiter line.
    local production_part tts_part
    production_part="$(printf '%s' "$body" | awk -v d="$delimiter" '
      BEGIN{keep=1}
      index($0,d){keep=0; next}
      keep{print}
    ')"
    tts_part="$(printf '%s' "$body" | awk -v d="$delimiter" '
      BEGIN{keep=0}
      index($0,d){keep=1; next}
      keep{print}
    ')"

    # Trim leading blank lines from both parts (trailing blank lines are fine).
    production_part="$(printf '%s\n' "$production_part" | sed -e '/./,$!d')"
    tts_part="$(printf '%s\n' "$tts_part" | sed -e '/./,$!d')"

    # Write TTS-only payload to the attachment file.
    local media_dir="${ASK_HUMAN_MEDIA_DIR:-${OPENCLAW_HOME:-$HOME/.openclaw}/media}"
    mkdir -p "$media_dir" 2>/dev/null || true
    local fname="${issue}-tts-script.txt"
    PAYLOAD_ATTACH="${media_dir%/}/${fname}"
    printf '%s' "$tts_part" > "$PAYLOAD_ATTACH"

    # Export production context so ask.sh can archive it as an issue comment
    # after the send succeeds. Consumer checks if PAYLOAD_PRODUCTION is set.
    PAYLOAD_PRODUCTION="$production_part"

    # Minimal Discord message. NO production context inline — the human wants
    # a quick notification on mobile, not a wall of scene headers. Full brief
    # lives on the Paperclip issue (accessible via the link below) and is also
    # archived there as a comment by ask.sh post-send.
    local ui_base="${PAPERCLIP_UI_URL:-${PAPERCLIP_API_URL:-http://localhost:3100}}"
    local prefix="${issue%%-*}"
    local issue_url="${ui_base%/}/${prefix}/issues/${issue}"

    PAYLOAD_BODY="$(cat <<MSG
${title}
📄 ${issue_url}
Reply in this thread with the outcome.
MSG
)"
    return 0
  fi

  # No delimiter — freeform body (review_request, approval_request, etc.).
  local body_len=${#body}
  if [ "$body_len" -gt 1500 ]; then
    local media_dir="${ASK_HUMAN_MEDIA_DIR:-${OPENCLAW_HOME:-$HOME/.openclaw}/media}"
    mkdir -p "$media_dir" 2>/dev/null || true
    local fname="ask-human-${issue}-${kind}.txt"
    PAYLOAD_ATTACH="${media_dir%/}/${fname}"
    printf '%s\n' "$body" > "$PAYLOAD_ATTACH"

    PAYLOAD_BODY="$(cat <<MSG
${title}
Reply in this thread with the outcome. Tracked as Paperclip issue ${issue}.

📎 Full content is attached as \`${fname}\` — tap to open, long-press to copy.
MSG
)"
  else
    PAYLOAD_ATTACH=""
    PAYLOAD_BODY="$(cat <<MSG
${title}
Reply in this thread with the outcome. Tracked as Paperclip issue ${issue}.

\`\`\`\`
${body}
\`\`\`\`
MSG
)"
  fi
}

# Back-compat shim: old code still calling render_message now returns the
# composed body text (no attachment). Prefer compose_payload for new code.
render_message() {
  compose_payload "$1" "$2" "$3"
  printf '%s' "$PAYLOAD_BODY"
}

# Invoke \`openclaw message send\` (or print the command in dry-run).
# Args: <channel-id> <message-body> [attachment-path]
send_via_openclaw() {
  local channel_id="$1"
  local body="$2"
  local attach="${3:-}"

  if [ "$DRY_RUN" = "1" ]; then
    local preview
    preview="$(printf '%s' "$body" | head -c 160 | tr '\n' ' ')"
    local cmd="openclaw message send --channel discord --target ${channel_id}"
    [ -n "$attach" ] && cmd="${cmd} --media ${attach}"
    cmd="${cmd} -m <body>"
    jq -n \
      --arg channel_id "$channel_id" \
      --arg preview "$preview" \
      --arg cmd "$cmd" \
      --arg attach "$attach" \
      '{dry_run: true, channel_id: $channel_id, preview: $preview, attachment: $attach, cmd: $cmd}'
    return 0
  fi

  if ! command -v openclaw >/dev/null 2>&1; then
    echo "ERR: 'openclaw' CLI not found on PATH. Install OpenClaw or run with --dry-run." >&2
    return 6
  fi

  if [ -n "$attach" ]; then
    if [ ! -f "$attach" ]; then
      echo "ERR: attachment file '$attach' not found." >&2
      return 8
    fi
    openclaw message send \
      --channel discord \
      --target "$channel_id" \
      --media "$attach" \
      -m "$body"
  else
    openclaw message send \
      --channel discord \
      --target "$channel_id" \
      -m "$body"
  fi
}
