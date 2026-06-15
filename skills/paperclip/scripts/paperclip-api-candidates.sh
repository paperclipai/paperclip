#!/usr/bin/env bash

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

append_api_curl_failure() {
  local errors_file="$1"
  local url="$2"
  local error_file="$3"
  local curl_status="$4"

  {
    printf 'Request failed before reaching Paperclip: %s\n' "$url"
    if [[ -s "$error_file" ]]; then
      sed 's/^/  /' "$error_file"
    else
      printf '  curl exited with status %s\n' "$curl_status"
    fi
  } >>"$errors_file"
}
