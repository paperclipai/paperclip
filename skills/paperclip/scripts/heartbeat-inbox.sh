#!/usr/bin/env bash

# Fetch the compact heartbeat inbox without turning transport failures into an
# empty assignment list. This is intentionally a small shell boundary so local
# adapters can use the same status/exit-code contract as the agent scaffold.
set -u

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"

scratch_dir="${PAPERCLIP_RUN_SCRATCH_DIR:-${PAPERCLIP_SCRATCH_DIR:-}}"
owns_scratch_dir=0
if [[ -z "$scratch_dir" ]]; then
  scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-heartbeat.XXXXXX")"
  owns_scratch_dir=1
else
  mkdir -p -- "$scratch_dir"
fi

inbox_file="$scratch_dir/inbox-lite.json"
trap 'rm -f -- "$inbox_file"; if [[ "$owns_scratch_dir" -eq 1 ]]; then rmdir -- "$scratch_dir" 2>/dev/null || true; fi' EXIT

loopback_url="http://127.0.0.1:${PAPERCLIP_LISTEN_PORT:-3100}"
retry_delay="${PAPERCLIP_HEARTBEAT_RETRY_DELAY_SECONDS:-1}"
api_url="$PAPERCLIP_API_URL"
http_status="000"
curl_exit=1
attempted_loopback=0

for endpoint in "$api_url" "$loopback_url"; do
  if [[ "$endpoint" == "$api_url" && "$attempted_loopback" -eq 1 ]]; then
    continue
  fi
  if [[ "$endpoint" == "$loopback_url" ]]; then
    attempted_loopback=1
  fi

  : > "$inbox_file"
  http_status="$(curl -sS -o "$inbox_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY:-}" \
    "$endpoint/api/agents/me/inbox-lite")"
  curl_exit=$?
  http_status="${http_status:-000}"

  if [[ "$curl_exit" -eq 0 && "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    cat -- "$inbox_file"
    exit 0
  fi

  if [[ "$endpoint" == "$api_url" && "$loopback_url" != "$api_url" ]]; then
    printf '[paperclip] WARNING: inbox-lite failed at %s (exit=%s, http=%s); trying loopback fallback\n' \
      "$endpoint" "$curl_exit" "$http_status" >&2
    if [[ "$retry_delay" != "0" ]]; then
      sleep "$retry_delay"
    fi
  fi
done

printf '[paperclip] ERROR: Paperclip API unreachable — tried %s and loopback fallback. exit=%s http=%s\n' \
  "$api_url" "$curl_exit" "$http_status" >&2
exit 1
