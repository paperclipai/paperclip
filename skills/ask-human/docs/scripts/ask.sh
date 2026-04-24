#!/usr/bin/env bash
# Send a Discord notification for a Paperclip issue.
#
# Usage:
#   ./ask.sh <channel-name> <issue-id> <kind> <body>  [--dry-run]
#
# Examples:
#   ./ask.sh "#cfw" "CFW-87" "video_script_request" "$(cat script.md)"
#   ./ask.sh --dry-run "#gsai" "GRO-142" "review_request" "Please check the new copy."
#
# Kinds:
#   video_script_request | review_request | approval_request | question | handoff
#
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/_common.sh"

filter_args "$@"; ARGS=("${CLEAN_ARGS[@]+"${CLEAN_ARGS[@]}"}")

CHANNEL="${ARGS[0]:?Usage: ask.sh <channel-name> <issue-id> <kind> <body>}"
ISSUE="${ARGS[1]:?Provide issue-id, e.g. CFW-87}"
KIND="${ARGS[2]:?Provide kind (video_script_request|review_request|approval_request|question|handoff)}"
BODY="${ARGS[3]:?Provide body text (use \$(cat file.md) for long content)}"

case "$KIND" in
  video_script_request|review_request|approval_request|question|handoff) ;;
  *)
    echo "ERR: unknown kind '$KIND'. See SKILL.md for supported kinds." >&2
    exit 7
    ;;
esac

# For video_script_request, enforce the TTS delimiter structure. The whole
# value prop of the attachment (paste-ready-into-TTS, zero cleanup) depends
# on the body having a production-context-above / TTS-below shape.
if [ "$KIND" = "video_script_request" ]; then
  if ! printf '%s' "$BODY" | grep -qF "=== TTS-READY SCRIPT ==="; then
    cat >&2 <<'MSG'
ERR: video_script_request body must include `=== TTS-READY SCRIPT ===` delimiter.

Shape it like:

  [Scene 1 — Hook] (8s) [visual notes...]
  "Spoken line..."
  ...full production script with scene markers, visuals, timing, etc...

  === TTS-READY SCRIPT ===

  Spoken line...

  (rest of spoken text ONLY — no brackets, no scene headers, no timing notes)

The attachment will contain ONLY the text below the delimiter, so the human
can paste it straight into ElevenLabs/HeyGen without deleting a single char.
Production context above the delimiter goes inline into the Discord message.

See SKILL.md → "Body structure requirements by <kind>".
MSG
    exit 9
  fi
fi

# Resolve channel → record {id, name, paperclipPrefix, paperclipApi}.
RECORD="$(resolve_channel "$CHANNEL")"
CHANNEL_ID="$(printf '%s' "$RECORD" | jq -r '.id')"
CHANNEL_NAME="$(printf '%s' "$RECORD" | jq -r '.name')"
PREFIX="$(printf '%s' "$RECORD" | jq -r '.paperclipPrefix')"

assert_prefix_match "$ISSUE" "$PREFIX"

# Compose payload — sets PAYLOAD_BODY and PAYLOAD_ATTACH globals.
# Long bodies (> 1500 chars) are written to a .txt attachment so OpenClaw
# does not chunk the message across multiple Discord posts.
compose_payload "$KIND" "$ISSUE" "$BODY"

if [ "$DRY_RUN" = "1" ]; then
  ATTACH_NOTE=""
  [ -n "${PAYLOAD_ATTACH}" ] && ATTACH_NOTE=" attach=${PAYLOAD_ATTACH}"
  echo "[dry-run] channel=${CHANNEL_NAME} (id=${CHANNEL_ID}) issue=${ISSUE} kind=${KIND}${ATTACH_NOTE}" >&2
fi

send_via_openclaw "$CHANNEL_ID" "$PAYLOAD_BODY" "$PAYLOAD_ATTACH"
SEND_RC=$?

if [ "$SEND_RC" -eq 0 ]; then
  # If this was a video_script_request (TTS-split mode), archive the full
  # production context as a comment on the issue. The Discord message itself
  # is minimal (link + reply hint); the human clicks through to Paperclip to
  # see scene headers, visuals, timing, etc. This keeps Discord clean on
  # mobile without losing the brief.
  if [ -n "${PAYLOAD_PRODUCTION:-}" ]; then
    ARCHIVE_BODY="## Full production brief (sent to Discord thread for review)

${PAYLOAD_PRODUCTION}

---
_The TTS-only spoken text is attached to the Discord message as \`${ISSUE}-tts-script.txt\`. Reply in the Discord thread with the outcome — it will land back on this issue as a comment._"
    post_issue_comment "$ISSUE" "$ARCHIVE_BODY" || true
  fi

  # Transition the issue to in_review. Paperclip's stranded-issue reconciler
  # only sweeps `todo`/`in_progress`, so `in_review` issues never get auto-
  # blocked while parked waiting for a human. The worker agent flips status
  # back to `in_progress` when it posts the reply comment.
  patch_issue_status "$ISSUE" "in_review" || true
fi

exit $SEND_RC
