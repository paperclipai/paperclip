#!/usr/bin/env bash
# Route deterministic board operations to the shell-handler lane.
#
# This is deliberately a narrow, auditable alternative to sending one-to-three
# API calls through an LLM. It never invents prose, guesses an assignee, or
# runs an arbitrary probe command. Callers supply the concrete operation and
# payload; anything ambiguous exits non-zero for normal task routing.
#
# Usage:
#   mechanical-demotion-router.sh <title> <issue-uuid> [action] [value]
#
# Set MECHANICAL_ROUTER_DRY_RUN=1 to print the request instead of mutating the
# control plane. Live calls require PAPERCLIP_API_URL and PAPERCLIP_API_KEY.

set -euo pipefail

title="${1:-}"
issue_id="${2:-}"
action="${3:-}"
value="${4:-}"

if [[ -z "$title" || -z "$issue_id" ]]; then
  echo "Usage: $0 <title> <issue-uuid> [action] [value]" >&2
  exit 64
fi

if [[ -z "$action" ]]; then
  case "$title" in
    [Rr]eassign*|[Rr]oute-to*) action="reassign" ;;
    [Aa]ttach*|[Uu]pload*|[Mm]irror*) action="attach" ;;
    [Aa]ck-*|[Cc]ourier*) action="courier" ;;
    [Bb]ackup*) action="backup" ;;
    [Ww]atch*|[Pp]robe*|[Hh]ealth*|[Mm]onitor*) action="probe" ;;
    *)
      echo "No deterministic route for title: $title" >&2
      exit 65
      ;;
  esac
fi

dry_run="${MECHANICAL_ROUTER_DRY_RUN:-0}"
api_base="${PAPERCLIP_API_URL%/}"
case "$api_base" in
  */api) ;;
  *) api_base="$api_base/api" ;;
esac

require_live_api() {
  if [[ "$dry_run" == "1" ]]; then return 0; fi
  if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" ]]; then
    echo "Live routing requires PAPERCLIP_API_URL and PAPERCLIP_API_KEY; use MECHANICAL_ROUTER_DRY_RUN=1 for inspection." >&2
    exit 77
  fi
}

api_json() {
  local method="$1" path="$2" payload="$3"
  if [[ "$dry_run" == "1" ]]; then
    jq -cn --arg method "$method" --arg path "$path" --argjson payload "$payload" '{dryRun:true, method:$method, path:$path, payload:$payload}'
    return 0
  fi
  local -a headers=(-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json")
  if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then headers+=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"); fi
  curl --fail-with-body --silent --show-error -X "$method" "$api_base$path" "${headers[@]}" --data-binary "$payload"
}

api_get() {
  local path="$1"
  if [[ "$dry_run" == "1" ]]; then jq -cn --arg path "$path" '{dryRun:true, method:"GET", path:$path}'; return 0; fi
  curl --fail-with-body --silent --show-error "$api_base$path" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
}

post_comment() {
  local body="$1" payload
  payload="$(jq -cn --arg body "$body" '{body:$body}')"
  api_json POST "/issues/$issue_id/comments" "$payload" >/dev/null
  echo "comment posted for $issue_id"
}

case "$action" in
  reassign)
    require_live_api
    if [[ ! "$value" =~ ^[0-9a-fA-F-]{36}$ ]]; then echo "reassign requires an assignee agent UUID as the fourth argument" >&2; exit 64; fi
    payload="$(jq -cn --arg assignee "$value" '{assigneeAgentId:$assignee}')"
    api_json PATCH "/issues/$issue_id" "$payload" >/dev/null
    echo "reassigned $issue_id to $value"
    ;;
  comment|ack|courier)
    require_live_api
    if [[ -z "$value" ]]; then echo "$action requires the already-approved templated text as the fourth argument" >&2; exit 64; fi
    post_comment "$value"
    ;;
  attach|upload|mirror)
    require_live_api
    if [[ -z "$value" || ! -f "$value" ]]; then echo "$action requires an existing local file as the fourth argument" >&2; exit 64; fi
    if [[ "$dry_run" == "1" ]]; then printf 'dry-run attachment: %s -> %s\n' "$value" "$issue_id"; exit 0; fi
    company_id="$(api_get "/issues/$issue_id" | jq -r '.companyId // empty')"
    if [[ ! "$company_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then echo "Unable to resolve a companyId for issue $issue_id" >&2; exit 65; fi
    headers=(-H "Authorization: Bearer $PAPERCLIP_API_KEY")
    if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then headers+=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"); fi
    curl --fail-with-body --silent --show-error -X POST "$api_base/companies/$company_id/issues/$issue_id/attachments" "${headers[@]}" -F "file=@$value" >/dev/null
    echo "attached $(basename "$value") to $issue_id"
    ;;
  backup)
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ "$dry_run" == "1" ]]; then echo "dry-run backup: $script_dir/backup-db.sh"; else exec "$script_dir/backup-db.sh"; fi
    ;;
  probe)
    require_live_api
    result="${MECHANICAL_PROBE_RESULT:-$value}"
    if [[ -z "$result" ]]; then echo "probe requires MECHANICAL_PROBE_RESULT or the fourth argument from an already-run deterministic probe" >&2; exit 64; fi
    post_comment "## Deterministic probe result\n\n$result"
    ;;
  *)
    echo "Unsupported mechanical action: $action" >&2
    exit 64
    ;;
esac
