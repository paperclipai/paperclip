#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  paperclip-upload-artifact.sh FILE [options]

Uploads a generated file from the current workspace to the current Paperclip
issue, then creates an attachment-backed artifact work product by default.

Required environment for live uploads:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID

Options:
  --issue-id ID          Issue id to attach to (default: PAPERCLIP_TASK_ID)
  --company-id ID        Company id (default: PAPERCLIP_COMPANY_ID)
  --title TEXT           Work product title (default: file basename)
  --summary TEXT         Work product summary
  --content-type TYPE    Override detected upload content type
  --status STATUS        Work product status (default: ready_for_review)
  --chat-comment TEXT    Bind this file to an explicit external-chat response
  --retry-unknown-upload Retry after an unresolved transport failure (duplicate risk)
  --no-work-product      Only upload the issue attachment
  --no-primary           Do not mark the artifact work product primary for its type
  --output FORMAT        markdown or json (default: markdown)
  --dry-run              Print resolved upload settings without calling the API
  --help, -h             Show this help

Examples:
  scripts/paperclip-upload-artifact.sh dist/demo.mp4 \
    --title "Demo video render" \
    --summary "MP4 render for board review"

  scripts/paperclip-upload-artifact.sh out/walkthrough.webm \
    --title "Walkthrough video" \
    --content-type video/webm

  scripts/paperclip-upload-artifact.sh out/result.png \
    --title "Generated image" \
    --chat-comment "Here is the requested image."
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

json_bool() {
  if [[ "${1:-0}" == "1" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

detect_content_type() {
  local path="$1"
  local lower
  lower="$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"

  case "$lower" in
    *.mp4|*.m4v) printf 'video/mp4' ;;
    *.webm) printf 'video/webm' ;;
    *.mov|*.qt) printf 'video/quicktime' ;;
    *.png) printf 'image/png' ;;
    *.jpg|*.jpeg) printf 'image/jpeg' ;;
    *.gif) printf 'image/gif' ;;
    *.webp) printf 'image/webp' ;;
    *.svg) printf 'image/svg+xml' ;;
    *.pdf) printf 'application/pdf' ;;
    *.txt|*.log) printf 'text/plain' ;;
    *.md|*.markdown) printf 'text/markdown' ;;
    *.json) printf 'application/json' ;;
    *.csv) printf 'text/csv' ;;
    *.html|*.htm) printf 'text/html' ;;
    *.zip) printf 'application/zip' ;;
    *)
      if command -v file >/dev/null 2>&1; then
        file --brief --mime-type "$path"
      else
        printf 'application/octet-stream'
      fi
      ;;
  esac
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$path" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$path" | awk '{print tolower($1)}'
  else
    printf 'Missing required command: sha256sum or shasum\n' >&2
    exit 1
  fi
}

sha256_text() {
  local value="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print tolower($1)}'
  else
    printf 'Missing required command: sha256sum or shasum\n' >&2
    exit 1
  fi
}

request_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local response_file
  local status_code

  response_file="$(mktemp)"
  if [[ -n "$body" ]]; then
    status_code="$(
      curl -sS -X "$method" -w '%{http_code}' -o "$response_file" \
        "$url" \
        -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
        -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
        -H 'Content-Type: application/json' \
        --data-binary "$body"
    )"
  else
    status_code="$(
      curl -sS -X "$method" -w '%{http_code}' -o "$response_file" \
        "$url" \
        -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
        -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
    )"
  fi

  if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
    printf 'Request failed (%s): %s\n' "$status_code" "$url" >&2
    cat "$response_file" >&2
    printf '\n' >&2
    rm -f "$response_file"
    exit 1
  fi

  cat "$response_file"
  rm -f "$response_file"
}

upload_file() {
  local url="$1"
  local path="$2"
  local content_type="$3"
  local escaped_path
  local response_file
  local status_code
  local curl_status=0

  escaped_path="${path//\\/\\\\}"
  escaped_path="${escaped_path//\"/\\\"}"
  response_file="$(mktemp)"
  status_code="$(
    curl -sS -X POST -w '%{http_code}' -o "$response_file" \
      "$url" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
      -F "file=@\"${escaped_path}\";type=${content_type}"
  )" || curl_status=$?

  if [[ "$curl_status" -ne 0 ]]; then
    rm -f "$response_file"
    return 75
  fi

  if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
    printf 'Upload failed (%s): %s\n' "$status_code" "$url" >&2
    cat "$response_file" >&2
    printf '\n' >&2
    rm -f "$response_file"
    if [[ "$status_code" == "408" || "$status_code" -ge 500 ]]; then
      return 75
    fi
    return 1
  fi

  cat "$response_file"
  rm -f "$response_file"
}

operation_lock_path=""
operation_lock_owner=""
operation_lock_held=0
operation_state_root=""

process_start_identity() {
  local pid="$1"
  ps -p "$pid" -o lstart= 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//'
}

release_operation_lock() {
  if [[ "$operation_lock_held" == "1" && -n "$operation_lock_path" ]]; then
    local current_owner=""
    current_owner="$(readlink "$operation_lock_path" 2>/dev/null || true)"
    if [[ "$current_owner" == "$operation_lock_owner" ]]; then
      rm -f "$operation_lock_path"
    fi
    operation_lock_held=0
  fi
}

acquire_operation_lock() {
  local operation_key="$1"
  local attempts=0

  umask 077
  operation_state_root="${PAPERCLIP_HELPER_STATE_DIR:-${TMPDIR:-/tmp}/paperclip-upload-artifact}"
  mkdir -p "$operation_state_root"
  operation_lock_path="$operation_state_root/$operation_key.lock"
  operation_lock_owner="$$|$(process_start_identity "$$" || true)"
  while ! ln -s "$operation_lock_owner" "$operation_lock_path" 2>/dev/null; do
    local owner_pid=""
    local owner_start=""
    local current_lock_owner=""
    current_lock_owner="$(readlink "$operation_lock_path" 2>/dev/null || true)"
    IFS='|' read -r owner_pid owner_start <<<"$current_lock_owner"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]]; then
      local current_owner_start=""
      current_owner_start="$(process_start_identity "$owner_pid" || true)"
      if ! kill -0 "$owner_pid" 2>/dev/null ||
        [[ -n "$owner_start" && -n "$current_owner_start" && "$owner_start" != "$current_owner_start" ]]; then
        # Serialize stale-lock reclamation separately. Without this guard, two
        # contenders can both observe the old owner and the slower one can
        # delete the faster contender's newly acquired live lock.
        local reclaim_lock_path="$operation_lock_path.reclaim"
        if mkdir "$reclaim_lock_path" 2>/dev/null; then
          local guarded_owner=""
          guarded_owner="$(readlink "$operation_lock_path" 2>/dev/null || true)"
          if [[ "$guarded_owner" == "$current_lock_owner" ]]; then
            rm -f "$operation_lock_path"
          fi
          rmdir "$reclaim_lock_path" 2>/dev/null || true
          continue
        fi
      fi
    fi
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 400 ]]; then
      printf 'Another matching artifact upload is still in progress; retry after it finishes.\n' >&2
      exit 1
    fi
    sleep 0.05
  done
  operation_lock_held=1
}

file_path=""
issue_id="${PAPERCLIP_TASK_ID:-}"
company_id="${PAPERCLIP_COMPANY_ID:-}"
title=""
summary=""
content_type=""
status="ready_for_review"
chat_comment=""
create_work_product=1
is_primary=1
output_format="markdown"
dry_run=0
retry_unknown_upload=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id)
      issue_id="${2:-}"
      shift 2
      ;;
    --company-id)
      company_id="${2:-}"
      shift 2
      ;;
    --title)
      title="${2:-}"
      shift 2
      ;;
    --summary)
      summary="${2:-}"
      shift 2
      ;;
    --content-type)
      content_type="${2:-}"
      shift 2
      ;;
    --status)
      status="${2:-}"
      shift 2
      ;;
    --chat-comment)
      chat_comment="${2:-}"
      shift 2
      ;;
    --no-work-product)
      create_work_product=0
      shift
      ;;
    --retry-unknown-upload)
      retry_unknown_upload=1
      shift
      ;;
    --no-primary)
      is_primary=0
      shift
      ;;
    --output)
      output_format="${2:-}"
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
    --*)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$file_path" ]]; then
        printf 'Unexpected positional argument: %s\n' "$1" >&2
        usage >&2
        exit 1
      fi
      file_path="$1"
      shift
      ;;
  esac
done

if [[ -z "$file_path" ]]; then
  printf 'Missing file path.\n' >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$file_path" ]]; then
  printf 'Artifact file does not exist: %s\n' "$file_path" >&2
  exit 1
fi

if [[ "$output_format" != "markdown" && "$output_format" != "json" ]]; then
  printf 'Unsupported output format: %s\n' "$output_format" >&2
  exit 1
fi

if [[ -n "$chat_comment" && "$create_work_product" != "1" ]]; then
  printf '%s\n' '--chat-comment requires the attachment-backed work product created by this helper.' >&2
  exit 1
fi

require_command curl
require_command jq

if [[ -z "$title" ]]; then
  title="$(basename "$file_path")"
fi

if [[ -z "$content_type" ]]; then
  content_type="$(detect_content_type "$file_path")"
fi

if [[ "$dry_run" == "1" ]]; then
  create_work_product_json="$(json_bool "$create_work_product")"
  is_primary_json="$(json_bool "$is_primary")"
  jq -n \
    --arg file "$file_path" \
    --arg issueId "$issue_id" \
    --arg companyId "$company_id" \
    --arg title "$title" \
    --arg summary "$summary" \
    --arg contentType "$content_type" \
    --arg status "$status" \
    --arg chatComment "$chat_comment" \
    --argjson createWorkProduct "$create_work_product_json" \
    --argjson isPrimary "$is_primary_json" \
    '{file: $file, issueId: $issueId, companyId: $companyId, title: $title, summary: $summary, contentType: $contentType, status: $status, chatComment: (if $chatComment == "" then null else $chatComment end), createWorkProduct: $createWorkProduct, isPrimary: $isPrimary}'
  exit 0
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_URL, PAPERCLIP_API_KEY, or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi

if [[ -z "$issue_id" || -z "$company_id" ]]; then
  printf 'Missing issue or company id. Pass --issue-id/--company-id or set PAPERCLIP_TASK_ID/PAPERCLIP_COMPANY_ID.\n' >&2
  exit 1
fi

api_root="${PAPERCLIP_API_URL%/}"
case "$api_root" in
  */api) api_base="$api_root" ;;
  *) api_base="$api_root/api" ;;
esac
file_sha256="$(sha256_file "$file_path")"
original_filename="$(basename "$file_path")"
operation_key="$(
  sha256_text "$api_base|$company_id|$issue_id|$PAPERCLIP_RUN_ID|$original_filename|$file_sha256|$content_type"
)"
acquire_operation_lock "$operation_key"
trap release_operation_lock EXIT

attachment=""
reused_attachment=0
unknown_upload_marker="$operation_state_root/$operation_key.uncertain"
lookup_attempts=1
if [[ -f "$unknown_upload_marker" && "$retry_unknown_upload" != "1" ]]; then
  lookup_attempts=20
fi
for ((lookup_attempt = 1; lookup_attempt <= lookup_attempts; lookup_attempt++)); do
  existing_attachments="$(request_json GET "$api_base/issues/$issue_id/attachments")"
  attachment="$(
    jq -nc \
      --argjson attachments "$existing_attachments" \
      --arg runId "$PAPERCLIP_RUN_ID" \
      --arg sha256 "$file_sha256" \
      --arg originalFilename "$original_filename" \
      --arg contentType "$content_type" \
      'first(
        $attachments[]
        | select(
            .originatingRunId == $runId
            and ((.sha256 // "") | ascii_downcase) == ($sha256 | ascii_downcase)
            and (.originalFilename // "") == $originalFilename
            and ((.contentType // "") | ascii_downcase) == ($contentType | ascii_downcase)
          )
      ) // empty'
  )"
  if [[ -n "$attachment" ]]; then
    reused_attachment=1
    rm -f "$unknown_upload_marker"
    break
  fi
  if [[ "$lookup_attempt" -lt "$lookup_attempts" ]]; then
    sleep 0.25
  fi
done

if [[ -z "$attachment" && -f "$unknown_upload_marker" && "$retry_unknown_upload" != "1" ]]; then
  printf '%s\n' 'A previous matching upload ended without a definitive response, and Paperclip has not exposed its durable attachment yet.' >&2
  printf '%s\n' 'Retry this command later. If the upload definitely did not commit, pass --retry-unknown-upload to accept the duplicate-file risk.' >&2
  exit 1
fi

if [[ -z "$attachment" ]]; then
  rm -f "$unknown_upload_marker"
  : >"$unknown_upload_marker"
  upload_status=0
  attachment="$(
    upload_file \
      "$api_base/companies/$company_id/issues/$issue_id/attachments" \
      "$file_path" \
      "$content_type"
  )" || upload_status=$?
  if [[ "$upload_status" -ne 0 ]]; then
    if [[ "$upload_status" -ne 75 ]]; then
      rm -f "$unknown_upload_marker"
    fi
    exit 1
  fi
fi

attachment_id="$(jq -r '.id // empty' <<<"$attachment")"
content_path="$(jq -r '.contentPath // empty' <<<"$attachment")"
download_path="$(jq -r '.downloadPath // (if .contentPath then (.contentPath + "?download=1") else "" end)' <<<"$attachment")"
if [[ -z "$attachment_id" || -z "$content_path" || -z "$download_path" ]]; then
  printf 'Upload response did not include attachment path metadata.\n' >&2
  printf '%s\n' "$attachment" >&2
  exit 1
fi
rm -f "$unknown_upload_marker"

work_product="null"
if [[ "$create_work_product" == "1" ]]; then
  is_primary_json="$(json_bool "$is_primary")"
  byte_size="$(jq -r '.byteSize // 0' <<<"$attachment")"
  open_path="$(jq -r '.openPath // .contentPath // empty' <<<"$attachment")"
  original_filename="$(jq -r '.originalFilename // empty' <<<"$attachment")"

  work_product_payload="$(
    jq -nc \
      --arg title "$title" \
      --arg summary "$summary" \
      --arg status "$status" \
      --arg runId "$PAPERCLIP_RUN_ID" \
      --arg attachmentId "$attachment_id" \
      --arg contentType "$content_type" \
      --argjson byteSize "$byte_size" \
      --arg contentPath "$content_path" \
      --arg openPath "$open_path" \
      --arg downloadPath "$download_path" \
      --arg originalFilename "$original_filename" \
      --argjson isPrimary "$is_primary_json" \
      '{
        type: "artifact",
        provider: "paperclip",
        title: $title,
        status: $status,
        reviewState: "none",
        isPrimary: $isPrimary,
        healthStatus: "unknown",
        summary: (if $summary == "" then null else $summary end),
        createdByRunId: $runId,
        metadata: {
          attachmentId: $attachmentId,
          contentType: $contentType,
          byteSize: $byteSize,
          contentPath: $contentPath,
          openPath: $openPath,
          downloadPath: $downloadPath,
          originalFilename: (if $originalFilename == "" then null else $originalFilename end)
        }
      }'
  )"

  work_product="$(
    request_json \
      POST \
      "$api_base/issues/$issue_id/work-products" \
      "$work_product_payload"
  )"
fi

chat_response="null"
if [[ -n "$chat_comment" ]]; then
  chat_comment_payload="$(
    jq -nc \
      --arg body "$chat_comment" \
      --arg attachmentId "$attachment_id" \
      '{body: $body, attachmentIds: [$attachmentId]}'
  )"
  chat_response="$(
    request_json \
      POST \
      "$api_base/issues/$issue_id/comments" \
      "$chat_comment_payload"
  )"
  chat_comment_id="$(jq -r '.id // empty' <<<"$chat_response")"
  if [[ -z "$chat_comment_id" ]]; then
    printf 'Chat attachment response did not include a comment id.\n' >&2
    exit 1
  fi
fi

if [[ "$output_format" == "json" ]]; then
  jq -n \
    --argjson attachment "$attachment" \
    --argjson workProduct "$work_product" \
    --argjson chatComment "$chat_response" \
    '{attachment: $attachment, workProduct: $workProduct, chatComment: $chatComment}'
  exit 0
fi

work_product_id="$(jq -r '.id // empty' <<<"$work_product")"

if [[ "$reused_attachment" == "1" ]]; then
  printf 'Reused matching artifact from this run\n\n'
else
  printf 'Uploaded artifact\n\n'
fi
printf -- '- Attachment: [%s](%s)\n' "$title" "$content_path"
printf -- '- Download: [%s](%s)\n' "$title" "$download_path"
printf -- '- Attachment ID: `%s`\n' "$attachment_id"
if [[ -n "$work_product_id" ]]; then
  printf -- '- Work product ID: `%s`\n' "$work_product_id"
fi
if [[ -n "$chat_comment" ]]; then
  printf -- '- Paperclip comment binding: saved. External publication requires an authorized active chat origin; this helper does not confirm provider delivery.\n'
fi
printf '\nFinal comment snippet:\n\n'
printf -- '- Artifact: [%s](%s)\n' "$title" "$content_path"
