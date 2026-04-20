#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

readonly SCRIPT_NAME="ticket-block-health-check"
readonly SCRIPT_SOURCE="scripts/ticket-block-health-check.sh"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly JQ_BIN="${JQ_BIN:-jq}"
readonly PYTHON_BIN="${PYTHON_BIN:-python3}"
readonly PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-}"
readonly PAPERCLIP_COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
readonly PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:-}"
readonly PAPERCLIP_RUN_ID="${PAPERCLIP_RUN_ID:-ticket-block-health-check-local}"
readonly BLOCKED_LIMIT="${BLOCKED_LIMIT:-500}"
readonly COMMENT_SCAN_LIMIT="${COMMENT_SCAN_LIMIT:-5}"
readonly STALE_PARTIAL_DAYS="${STALE_PARTIAL_DAYS:-7}"
readonly CURL_MAX_TIME_SEC="${CURL_MAX_TIME_SEC:-20}"
readonly DRY_RUN="${DRY_RUN:-false}"
readonly GHOST_COMMENT_PREFIX="Auto-unblocked: no active blocker (ghost-block cleanup)."
readonly STALE_COMMENT_PREFIX="Auto-unblocked: all blockers"
readonly COMMENT_SOURCE_SUFFIX="Source: ${SCRIPT_SOURCE}"

API_RESPONSE_BODY=""
API_RESPONSE_CODE=""
declare -a ACTION_IDS=()
declare -a HEALTH_ISSUES=()

log() {
  local level="$1"
  shift
  printf '[%s] %s\n' "$SCRIPT_NAME:$level" "$*" >&2
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    log error "Required command missing: $command_name"
    exit 1
  fi
}

require_env() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    log error "Required environment variable missing: $var_name"
    exit 1
  fi
}

is_truthy() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

paperclip_request() {
  local method="$1"
  local path="$2"
  local data="${3-}"
  local tmp
  tmp="$(mktemp)"

  local -a curl_args=(
    --max-time "$CURL_MAX_TIME_SEC"
    -sS
    -o "$tmp"
    -w "%{http_code}"
    -X "$method"
    -H "Authorization: Bearer $PAPERCLIP_API_KEY"
    -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
  )

  if [[ -n "$data" ]]; then
    curl_args+=(-H "Content-Type: application/json" --data "$data")
  fi

  API_RESPONSE_CODE="$("$CURL_BIN" "${curl_args[@]}" "${PAPERCLIP_API_URL}${path}")"
  API_RESPONSE_BODY="$(cat "$tmp")"
  rm -f "$tmp"

  if [[ ! "$API_RESPONSE_CODE" =~ ^2 ]]; then
    log error "API ${method} ${path} failed with HTTP ${API_RESPONSE_CODE}: ${API_RESPONSE_BODY}"
    return 1
  fi
}

paperclip_api_read() {
  paperclip_request GET "$1"
}

paperclip_api_write() {
  local method="$1"
  local path="$2"
  local data="$3"
  paperclip_request "$method" "$path" "$data"
}

record_health_issue() {
  local identifier="$1"
  local message="$2"
  HEALTH_ISSUES+=("$identifier")
  log warn "${identifier}: ${message}"
}

get_all_blocked_tickets() {
  paperclip_api_read "/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=blocked&limit=${BLOCKED_LIMIT}"
  local count
  count="$("$JQ_BIN" 'length' <<<"$API_RESPONSE_BODY")"
  if [[ "$count" -eq "$BLOCKED_LIMIT" ]]; then
    log warn "Blocked issue list hit limit=${BLOCKED_LIMIT}; rerun with a higher BLOCKED_LIMIT if needed."
  fi
  printf '%s\n' "$API_RESPONSE_BODY"
}

issue_has_external_block_comment() {
  local issue_id="$1"
  paperclip_api_read "/api/issues/${issue_id}/comments?limit=${COMMENT_SCAN_LIMIT}"
  "$JQ_BIN" -e 'any(.[]?; (.body // "") | contains("EXTERNAL BLOCK:"))' <<<"$API_RESPONSE_BODY" >/dev/null
}

issue_is_stale_partial_block() {
  local updated_at="$1"
  local threshold_days="$2"
  "$PYTHON_BIN" - "$updated_at" "$threshold_days" <<'PY'
from datetime import datetime, timezone
import sys

updated_at = sys.argv[1]
threshold_days = int(sys.argv[2])

normalized = updated_at.replace("Z", "+00:00")
updated = datetime.fromisoformat(normalized)
now = datetime.now(timezone.utc)
delta_days = (now - updated.astimezone(timezone.utc)).days
print("true" if delta_days >= threshold_days else "false")
PY
}

build_stale_comment() {
  local blockers_csv="$1"
  printf '%s (%s) are done/cancelled. %s' "$STALE_COMMENT_PREFIX" "$blockers_csv" "$COMMENT_SOURCE_SUFFIX"
}

auto_unblock_issue() {
  local issue_json="$1"
  local comment_body="$2"

  local issue_id issue_identifier
  issue_id="$("$JQ_BIN" -r '.id' <<<"$issue_json")"
  issue_identifier="$("$JQ_BIN" -r '.identifier // .id' <<<"$issue_json")"

  if is_truthy "$DRY_RUN"; then
    ACTION_IDS+=("$issue_identifier")
    log info "[dry-run] would auto-unblock ${issue_identifier}"
    return 0
  fi

  local payload
  # shellcheck disable=SC2016
  payload="$("$JQ_BIN" -nc --arg status "todo" --arg comment "$comment_body" '{status: $status, blockedByIssueIds: [], comment: $comment}')"
  paperclip_api_write PATCH "/api/issues/${issue_id}" "$payload"
  ACTION_IDS+=("$issue_identifier")
  log info "Auto-unblocked ${issue_identifier}"
}

handle_issue() {
  local issue_summary="$1"
  local issue_id
  issue_id="$("$JQ_BIN" -r '.id' <<<"$issue_summary")"

  paperclip_api_read "/api/issues/${issue_id}"
  local issue_detail="$API_RESPONSE_BODY"

  local issue_identifier blocked_count
  issue_identifier="$("$JQ_BIN" -r '.identifier // .id' <<<"$issue_detail")"
  blocked_count="$("$JQ_BIN" '(.blockedBy // []) | length' <<<"$issue_detail")"

  if [[ "$blocked_count" -eq 0 ]]; then
    if issue_has_external_block_comment "$issue_id"; then
      log info "${issue_identifier}: blocked with EXTERNAL BLOCK comment, leaving untouched"
      return 0
    fi
    auto_unblock_issue "$issue_detail" "${GHOST_COMMENT_PREFIX} ${COMMENT_SOURCE_SUFFIX}"
    return 0
  fi

  local blocker_summary_json
  # shellcheck disable=SC2016
  blocker_summary_json="$("$JQ_BIN" -c '
    (.blockedBy // []) as $blockers
    | {
        blockers: $blockers,
        identifiers: ($blockers | map(.identifier // .id)),
        activeIdentifiers: ($blockers | map(select((.status // "") != "done" and (.status // "") != "cancelled") | (.identifier // .id)))
      }
  ' <<<"$issue_detail")"

  local blocker_identifiers_csv active_identifiers_csv active_count
  blocker_identifiers_csv="$("$JQ_BIN" -r '.identifiers | join(", ")' <<<"$blocker_summary_json")"
  active_identifiers_csv="$("$JQ_BIN" -r '.activeIdentifiers | join(", ")' <<<"$blocker_summary_json")"
  active_count="$("$JQ_BIN" '.activeIdentifiers | length' <<<"$blocker_summary_json")"

  if [[ "$active_count" -eq 0 ]]; then
    auto_unblock_issue "$issue_detail" "$(build_stale_comment "$blocker_identifiers_csv")"
    return 0
  fi

  log info "${issue_identifier}: still blocked by active blockers (${active_identifiers_csv})"
  local is_stale
  is_stale="$(issue_is_stale_partial_block "$("$JQ_BIN" -r '.updatedAt' <<<"$issue_detail")" "$STALE_PARTIAL_DAYS")"
  if [[ "$is_stale" == "true" ]]; then
    record_health_issue "$issue_identifier" "still blocked by active blockers (${active_identifiers_csv}) for >= ${STALE_PARTIAL_DAYS} days"
  fi
}

main() {
  cd "$PROJECT_ROOT"

  require_command "$CURL_BIN"
  require_command "$JQ_BIN"
  require_command "$PYTHON_BIN"
  require_env PAPERCLIP_API_URL
  require_env PAPERCLIP_COMPANY_ID
  require_env PAPERCLIP_API_KEY

  local blocked_issues_json
  blocked_issues_json="$(get_all_blocked_tickets)"
  local blocked_count
  blocked_count="$("$JQ_BIN" 'length' <<<"$blocked_issues_json")"
  log info "Inspecting ${blocked_count} blocked issues"

  if [[ "$blocked_count" -eq 0 ]]; then
    echo "clean"
    return 0
  fi

  while IFS= read -r issue_summary; do
    [[ -n "$issue_summary" ]] || continue
    handle_issue "$issue_summary"
  done < <("$JQ_BIN" -c '.[]' <<<"$blocked_issues_json")

  if [[ "${#HEALTH_ISSUES[@]}" -gt 0 ]]; then
    log warn "Potentially stale blocked issues: ${HEALTH_ISSUES[*]}"
  fi

  if [[ "${#ACTION_IDS[@]}" -gt 0 ]]; then
    log info "Auto-unblocked issues this run: ${ACTION_IDS[*]}"
    echo "actions:${#ACTION_IDS[@]}"
    return 0
  fi

  if [[ "${#HEALTH_ISSUES[@]}" -gt 0 ]]; then
    echo "issues:${#HEALTH_ISSUES[@]}"
    return 0
  fi

  echo "clean"
}

main "$@"
