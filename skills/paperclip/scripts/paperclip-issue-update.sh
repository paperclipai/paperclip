#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-issue-update.sh [--issue-id ID] [--status STATUS] [--comment TEXT]
      [--review-for-responsible-user] [--dry-run]

Reads a multiline markdown comment from stdin when stdin is piped. This preserves
newlines when building the JSON payload for PATCH /api/issues/{issueId}.

Examples:
  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status in_progress <<'MD'
  Investigating formatting

  - Pulled the raw comment body
  - Comparing it with the run transcript
  MD

  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done --dry-run <<'MD'
  Done

  - Fixed the issue update helper
  MD

  scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" \
    --review-for-responsible-user <<'MD'
  Ready for review

  - Attached the completed deliverable
  - Verified it opens
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
review_for_responsible_user=0

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
    --review-for-responsible-user)
      review_for_responsible_user=1
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

require_command jq

api_base=""
expected_assignee_user_id=""
if [[ "$review_for_responsible_user" == "1" ]]; then
  if [[ "$dry_run" == "1" ]]; then
    printf '%s\n' '--review-for-responsible-user cannot be combined with --dry-run because it resolves the current responsible user from Paperclip.' >&2
    exit 1
  fi
  if [[ -n "$status" && "$status" != "in_review" ]]; then
    printf '%s\n' '--review-for-responsible-user requires status in_review; omit --status or pass --status in_review.' >&2
    exit 1
  fi
  if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
    printf 'Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, or PAPERCLIP_RUN_ID.\n' >&2
    exit 1
  fi
  require_command curl
  api_base="${PAPERCLIP_API_URL%/}"
  api_base="${api_base%/api}"

  set +e
  issue_response="$(
    curl -sS -m 30 \
      "$api_base/api/issues/$issue_id" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -w '\n%{http_code}'
  )"
  issue_curl_exit=$?
  set -e
  if [[ "$issue_curl_exit" -ne 0 ]]; then
    printf 'Unable to resolve the responsible user (curl exit %s). No issue update was attempted.\n' "$issue_curl_exit" >&2
    exit 1
  fi
  issue_http_code="${issue_response##*$'\n'}"
  issue_body="${issue_response%$'\n'*}"
  if [[ "$issue_http_code" != 2* || -z "$issue_body" ]]; then
    printf 'Unable to resolve the responsible user (HTTP %s). No issue update was attempted.\n' "$issue_http_code" >&2
    [[ -n "$issue_body" ]] && printf '%s\n' "$issue_body" >&2
    exit 1
  fi
  expected_assignee_user_id="$(jq -r '.responsibleUserId // empty' <<<"$issue_body" 2>/dev/null || true)"
  if [[ -z "$expected_assignee_user_id" ]]; then
    printf 'Issue %s has no responsibleUserId. No issue update was attempted.\n' "$issue_id" >&2
    exit 1
  fi
  status="in_review"
fi

payload="$(
  jq -nc \
    --arg status "$status" \
    --arg comment "$comment" \
    --arg assignee_user_id "$expected_assignee_user_id" \
    '
      (if $status == "" then {} else {status: $status} end) +
      (if $comment == "" then {} else {comment: $comment} end) +
      (if $assignee_user_id == "" then {} else {
        assigneeAgentId: null,
        assigneeUserId: $assignee_user_id
      } end)
    '
)"

if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi
require_command curl
if [[ -z "$api_base" ]]; then
  api_base="${PAPERCLIP_API_URL%/}"
  api_base="${api_base%/api}"
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
      "$api_base/api/issues/$issue_id" \
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
      returned_status="$(jq -r '.status // empty' <<<"$body" 2>/dev/null || true)"
      if [[ "$returned_status" != "$status" ]]; then
        printf 'Issue update FAILED: server echoed status %s instead of requested %s.\n' "${returned_status:-<none>}" "$status" >&2
        printf '%s\n' "$body" >&2
        exit 1
      fi
    fi
    if [[ -n "$expected_assignee_user_id" ]]; then
      returned_assignee_user_id="$(jq -r '.assigneeUserId // empty' <<<"$body" 2>/dev/null || true)"
      returned_assignee_agent_id="$(jq -r '.assigneeAgentId // empty' <<<"$body" 2>/dev/null || true)"
      if [[ "$returned_assignee_user_id" != "$expected_assignee_user_id" || -n "$returned_assignee_agent_id" ]]; then
        printf 'Issue update FAILED: server did not confirm review ownership by responsible user %s.\n' "$expected_assignee_user_id" >&2
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

  printf 'Issue update attempt %d/%d failed (curl exit %s, HTTP %s); retrying...\n' "$attempt" "$max_attempts" "$curl_exit" "${http_code:-000}" >&2
  sleep $((attempt * 2))
  attempt=$((attempt + 1))
done
