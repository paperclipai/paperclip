#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  paperclip-upload-artifact.sh FILE [options]

Uploads a generated file from the current workspace to the current Paperclip
issue, then creates an attachment-backed artifact work product by default.

Required environment for live uploads:
  PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_TASK_ID, PAPERCLIP_RUN_ID

API URL resolution:
  Uses PAPERCLIP_API_URL when reachable, then runtime candidates and the local
  listener fallback from PAPERCLIP_LISTEN_HOST/PAPERCLIP_LISTEN_PORT.

Options:
  --issue-id ID          Issue id to attach to (default: PAPERCLIP_TASK_ID)
  --company-id ID        Company id (default: PAPERCLIP_COMPANY_ID)
  --title TEXT           Work product title (default: file basename)
  --summary TEXT         Work product summary
  --content-type TYPE    Override detected upload content type
  --status STATUS        Work product status (default: ready_for_review)
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

request_json() {
  local method="$1"
  local path_suffix="$2"
  local body="${3:-}"
  local response_file error_file status_code curl_status url saw_failure
  response_file="$(mktemp)"
  error_file="$(mktemp)"
  saw_failure=0

  while IFS= read -r url; do
    : >"$response_file"
    : >"$error_file"
    set +e
    if [[ -n "$body" ]]; then
      status_code="$(
        curl -sS -X "$method" -w '%{http_code}' -o "$response_file" \
          "$url" \
          -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
          -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
          -H 'Content-Type: application/json' \
          --data-binary "$body" \
          2>"$error_file"
      )"
    else
      status_code="$(
        curl -sS -X "$method" -w '%{http_code}' -o "$response_file" \
          "$url" \
          -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
          -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
          2>"$error_file"
      )"
    fi
    curl_status=$?
    set -e

    if [[ "$curl_status" -ne 0 ]]; then
      saw_failure=1
      continue
    fi

    if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
      printf 'Request failed (%s): %s\n' "$status_code" "$url" >&2
      cat "$response_file" >&2
      printf '\n' >&2
      rm -f "$response_file" "$error_file"
      exit 1
    fi

    if [[ "$saw_failure" == "1" ]]; then
      printf 'Paperclip API primary URL was unavailable; used fallback %s.\n' "${url%/api/*}" >&2
    fi
    cat "$response_file"
    rm -f "$response_file" "$error_file"
    return 0
  done < <(api_path_candidates "$path_suffix")

  printf 'Could not reach the Paperclip API using configured or local runtime URLs.\n' >&2
  if [[ -s "$error_file" ]]; then
    cat "$error_file" >&2
  fi
  rm -f "$response_file" "$error_file"
  exit 1
}

resolve_local_api_url() {
  local host="${PAPERCLIP_LISTEN_HOST:-${HOST:-127.0.0.1}}"
  local port="${PAPERCLIP_LISTEN_PORT:-${PORT:-3100}}"
  case "$host" in
    ""|"0.0.0.0"|"::") host="127.0.0.1" ;;
  esac
  if [[ "$host" == *:* && "$host" != \[* ]]; then
    host="[$host]"
  fi
  printf 'http://%s:%s' "$host" "$port"
}

api_base_candidates() {
  local seen=""
  add_candidate() {
    local candidate="${1:-}"
    candidate="${candidate%/}"
    if [[ -z "$candidate" || "$seen" == *"|$candidate|"* ]]; then
      return
    fi
    seen="${seen}|${candidate}|"
    printf '%s\n' "$candidate"
  }

  add_candidate "${PAPERCLIP_API_URL:-}"
  add_candidate "${PAPERCLIP_RUNTIME_API_URL:-}"
  if [[ -n "${PAPERCLIP_RUNTIME_API_CANDIDATES_JSON:-}" ]]; then
    while IFS= read -r candidate; do
      add_candidate "$candidate"
    done < <(jq -r '.[]? | select(type == "string" and length > 0)' <<<"$PAPERCLIP_RUNTIME_API_CANDIDATES_JSON" 2>/dev/null || true)
  fi
  add_candidate "$(resolve_local_api_url)"
}

api_path_candidates() {
  local path="$1"
  local api_base
  while IFS= read -r api_base; do
    printf '%s/api/%s\n' "${api_base%/}" "${path#/}"
  done < <(api_base_candidates)
}

upload_file() {
  local path_suffix="$1"
  local path="$2"
  local content_type="$3"
  local escaped_path
  local response_file error_file status_code curl_status url saw_failure

  escaped_path="${path//\\/\\\\}"
  escaped_path="${escaped_path//\"/\\\"}"
  response_file="$(mktemp)"
  error_file="$(mktemp)"
  saw_failure=0

  while IFS= read -r url; do
    : >"$response_file"
    : >"$error_file"
    set +e
    status_code="$(
      curl -sS -X POST -w '%{http_code}' -o "$response_file" \
        "$url" \
        -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
        -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
        -F "file=@\"${escaped_path}\";type=${content_type}" \
        2>"$error_file"
    )"
    curl_status=$?
    set -e

    if [[ "$curl_status" -ne 0 ]]; then
      saw_failure=1
      continue
    fi

    if [[ "$status_code" -lt 200 || "$status_code" -ge 300 ]]; then
      printf 'Upload failed (%s): %s\n' "$status_code" "$url" >&2
      cat "$response_file" >&2
      printf '\n' >&2
      rm -f "$response_file" "$error_file"
      exit 1
    fi

    if [[ "$saw_failure" == "1" ]]; then
      printf 'Paperclip API primary URL was unavailable; used fallback %s.\n' "${url%/api/*}" >&2
    fi
    cat "$response_file"
    rm -f "$response_file" "$error_file"
    return 0
  done < <(api_path_candidates "$path_suffix")

  printf 'Could not reach the Paperclip API using configured or local runtime URLs.\n' >&2
  if [[ -s "$error_file" ]]; then
    cat "$error_file" >&2
  fi
  rm -f "$response_file" "$error_file"
  exit 1
}

file_path=""
issue_id="${PAPERCLIP_TASK_ID:-}"
company_id="${PAPERCLIP_COMPANY_ID:-}"
title=""
summary=""
content_type=""
status="ready_for_review"
create_work_product=1
is_primary=1
output_format="markdown"
dry_run=0

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
    --no-work-product)
      create_work_product=0
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
    --argjson createWorkProduct "$create_work_product_json" \
    --argjson isPrimary "$is_primary_json" \
    '{file: $file, issueId: $issueId, companyId: $companyId, title: $title, summary: $summary, contentType: $contentType, status: $status, createWorkProduct: $createWorkProduct, isPrimary: $isPrimary}'
  exit 0
fi

if [[ -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_RUN_ID:-}" ]]; then
  printf 'Missing PAPERCLIP_API_KEY or PAPERCLIP_RUN_ID.\n' >&2
  exit 1
fi

if [[ -z "$issue_id" || -z "$company_id" ]]; then
  printf 'Missing issue or company id. Pass --issue-id/--company-id or set PAPERCLIP_TASK_ID/PAPERCLIP_COMPANY_ID.\n' >&2
  exit 1
fi

attachment="$(
  upload_file \
    "companies/$company_id/issues/$issue_id/attachments" \
    "$file_path" \
    "$content_type"
)"

work_product="null"
if [[ "$create_work_product" == "1" ]]; then
  is_primary_json="$(json_bool "$is_primary")"
  attachment_id="$(jq -r '.id // empty' <<<"$attachment")"
  byte_size="$(jq -r '.byteSize // 0' <<<"$attachment")"
  content_path="$(jq -r '.contentPath // empty' <<<"$attachment")"
  open_path="$(jq -r '.openPath // .contentPath // empty' <<<"$attachment")"
  download_path="$(jq -r '.downloadPath // (if .contentPath then (.contentPath + "?download=1") else "" end)' <<<"$attachment")"
  original_filename="$(jq -r '.originalFilename // empty' <<<"$attachment")"

  if [[ -z "$attachment_id" || -z "$content_path" || -z "$download_path" ]]; then
    printf 'Upload response did not include attachment path metadata.\n' >&2
    printf '%s\n' "$attachment" >&2
    exit 1
  fi

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
      "issues/$issue_id/work-products" \
      "$work_product_payload"
  )"
fi

if [[ "$output_format" == "json" ]]; then
  jq -n --argjson attachment "$attachment" --argjson workProduct "$work_product" \
    '{attachment: $attachment, workProduct: $workProduct}'
  exit 0
fi

content_path="$(jq -r '.contentPath // empty' <<<"$attachment")"
download_path="$(jq -r '.downloadPath // (if .contentPath then (.contentPath + "?download=1") else "" end)' <<<"$attachment")"
attachment_id="$(jq -r '.id // empty' <<<"$attachment")"
work_product_id="$(jq -r '.id // empty' <<<"$work_product")"

printf 'Uploaded artifact\n\n'
printf -- '- Attachment: [%s](%s)\n' "$title" "$content_path"
printf -- '- Download: [%s](%s)\n' "$title" "$download_path"
printf -- '- Attachment ID: `%s`\n' "$attachment_id"
if [[ -n "$work_product_id" ]]; then
  printf -- '- Work product ID: `%s`\n' "$work_product_id"
fi
printf '\nFinal comment snippet:\n\n'
printf -- '- Artifact: [%s](%s)\n' "$title" "$content_path"
