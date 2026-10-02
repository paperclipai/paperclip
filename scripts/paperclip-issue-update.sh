#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-issue-update.sh [--issue-id ID] [--status STATUS] [--comment TEXT] [--dry-run]

Reads a multiline markdown comment from stdin when stdin is piped. This preserves
newlines when building the JSON payload for PATCH /api/issues/{issueId}.

Examples:
  # Intentional status + multiline comment. Do not use --status in_progress
  # just to attach a comment (that can request-changes on in_review). Omitting
  # --status still PATCHes; board/human comments on done/blocked can move the
  # issue to todo. Agent note-only updates: POST /api/issues/{id}/comments
  # (see skills/paperclip/SKILL.md):
  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
  Done

  - Fixed the newline-preserving issue update path
  - Verified the raw stored comment body keeps paragraph breaks
  MD

  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done --dry-run <<'MD'
  Done

  - Fixed the issue update helper
  MD
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

issue_id="${PAPERCLIP_TASK_ID:-}"
status=""
comment_arg=""
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id)
      issue_id="${2:-}"
      shift 2
      ;;
    --status)
      status="${2:-}"
      shift 2
      ;;
    --comment)
      comment_arg="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$issue_id" ]]; then
  printf 'Missing issue id. Pass --issue-id or set PAPERCLIP_TASK_ID.\n' >&2
  exit 1
fi

comment=""
if [[ -n "$comment_arg" ]]; then
  comment="$comment_arg"
elif [[ ! -t 0 ]]; then
  comment="$(cat)"
fi

require_command node

payload="$(
  node -e "
    const status = process.argv[1];
    const comment = process.argv[2];
    const payload = {};
    if (status) payload.status = status;
    if (comment) payload.comment = comment;
    console.log(JSON.stringify(payload));
  " "$status" "$comment"
)"

if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi

# A successful PATCH always returns the updated issue JSON. An empty body or a
# connection-level failure means the write did NOT land, even when a pipeline
# exit code says otherwise, so verify the response instead of inferring success.
# Two attempts total: the shared heartbeat policy stops a control-plane write
# after two consecutive failures, so the helper must not send a third.
max_attempts=2
attempt=1
while :; do
  http_code=""
  body=""
  set +e
  response="$(
    curl -sS -m 30 -X PATCH \
      "$PAPERCLIP_API_URL/api/issues/$issue_id" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
      -H 'Content-Type: application/json' \
      --data-binary "$payload" \
      -w '\n%{http_code}'
  )"
  curl_exit=$?
  set -e

  if [[ "$curl_exit" -eq 0 ]]; then
    http_code="${response##*$'\n'}"
    body="${response%$'\n'*}"
  fi

  if [[ "$curl_exit" -eq 0 && "$http_code" == 2* ]]; then
    if [[ -z "$body" ]]; then
      printf 'Issue update FAILED: HTTP %s with an empty response body. A real update echoes the issue JSON; treat this write as not saved.\n' "$http_code" >&2
      exit 1
    fi
    if [[ -n "$status" ]]; then
      returned_status="$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(v && v.status != null ? String(v.status) : "")' "$body" 2>/dev/null || true)"
      if [[ "$returned_status" != "$status" ]]; then
        printf 'Issue update FAILED: server echoed status %s instead of requested %s.\n' "${returned_status:-<none>}" "$status" >&2
        printf '%s\n' "$body" >&2
        exit 1
      fi
    fi
    printf '%s\n' "$body"
    exit 0
  fi

  # 4xx (other than 429) is a definitive rejection; retrying cannot change it.
  if [[ "$curl_exit" -eq 0 && "$http_code" == 4* && "$http_code" != "429" ]]; then
    printf 'Issue update rejected (HTTP %s).\n' "$http_code" >&2
    [[ -n "$body" ]] && printf '%s\n' "$body" >&2
    exit 1
  fi

  if (( attempt >= max_attempts )); then
    printf 'Issue update FAILED after %d attempts (curl exit %s, HTTP %s). The status/comment was NOT saved — report this write as failed, do not assume it landed.\n' "$max_attempts" "$curl_exit" "${http_code:-000}" >&2
    [[ -n "$body" ]] && printf '%s\n' "$body" >&2
    exit 1
  fi

  # Ambiguous transport failure with a comment: the PATCH may already have
  # landed and a blind retry would duplicate it. Probe comments before
  # re-sending. HTTP 5xx still retries (server rejected/did not commit).
  if [[ -n "$comment" && "$curl_exit" -ne 0 ]]; then
    set +e
    comments_resp="$(
      curl -sS -m 30 -X GET         "$PAPERCLIP_API_URL/api/issues/$issue_id/comments?order=desc"         -H "Authorization: Bearer $PAPERCLIP_API_KEY"         -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"         -w '\n%{http_code}'
    )"
    comments_exit=$?
    set -e
    if [[ "$comments_exit" -eq 0 ]]; then
      comments_code="${comments_resp##*$'\n'}"
      comments_body="${comments_resp%$'\n'*}"
      if [[ "$comments_code" == 2* && -n "$comments_body" ]]; then
        comment_found="$(
          node -e '
            const wanted = process.argv[1];
            const runId = process.argv[2];
            let rows = [];
            try { rows = JSON.parse(process.argv[3]); } catch {}
            if (!Array.isArray(rows) && rows && Array.isArray(rows.comments)) rows = rows.comments;
            if (!Array.isArray(rows)) rows = [];
            // Require this run id — identical older bodies must not confirm an unsaved update.
            const hit = rows.some((row) => row && row.body === wanted && (
              row.createdByRunId === runId || row.derivedCreatedByRunId === runId
            ));
            process.stdout.write(hit ? "yes" : "no");
          ' "$comment" "$PAPERCLIP_RUN_ID" "$comments_body" 2>/dev/null || true
        )"
        if [[ "$comment_found" == "yes" ]]; then
          set +e
          issue_resp="$(
            curl -sS -m 30 -X GET               "$PAPERCLIP_API_URL/api/issues/$issue_id"               -H "Authorization: Bearer $PAPERCLIP_API_KEY"               -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"               -w '\n%{http_code}'
          )"
          issue_exit=$?
          set -e
          if [[ "$issue_exit" -eq 0 ]]; then
            issue_code="${issue_resp##*$'\n'}"
            issue_body="${issue_resp%$'\n'*}"
            if [[ "$issue_code" == 2* && -n "$issue_body" ]]; then
              if [[ -n "$status" ]]; then
                issue_status="$(node -e 'const v = JSON.parse(process.argv[1]); process.stdout.write(v && v.status != null ? String(v.status) : "")' "$issue_body" 2>/dev/null || true)"
                if [[ "$issue_status" != "$status" ]]; then
                  printf 'Issue update FAILED: comment was saved but status is %s instead of requested %s.\n' "${issue_status:-<none>}" "$status" >&2
                  printf '%s\n' "$issue_body" >&2
                  exit 1
                fi
              fi
              printf '%s\n' "$issue_body"
              exit 0
            fi
          fi
        fi
      fi
    fi
  fi

  printf 'Issue update attempt %d/%d failed (curl exit %s, HTTP %s); retrying...\n' "$attempt" "$max_attempts" "$curl_exit" "${http_code:-000}" >&2
  sleep $((attempt * 2))
  attempt=$((attempt + 1))
done
