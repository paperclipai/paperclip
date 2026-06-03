#!/usr/bin/env bash
# paperclip-api-curl.sh — safe wrapper for all Paperclip internal API curl calls.
#
# Enforces mandatory timeouts so no call to 127.0.0.1:3100 can hang indefinitely.
# Use this instead of bare `curl` for any call to $PAPERCLIP_API_URL.
#
# Usage:
#   paperclip-api-curl.sh [curl-args...]
#
# Environment overrides:
#   PAPERCLIP_CURL_CONNECT_TIMEOUT  — TCP connect timeout in seconds (default: 2)
#   PAPERCLIP_CURL_MAX_TIME         — total request timeout in seconds (default: 10)
#   PAPERCLIP_CURL_RETRIES          — max retry attempts on transient failure (default: 2)
#   PAPERCLIP_CURL_RETRY_DELAY      — initial retry delay in seconds (default: 1)
#
# Non-2xx responses are treated as failure via --fail-with-body (curl ≥7.76).
# Falls back to --fail for older curl.

set -euo pipefail

CONNECT_TIMEOUT="${PAPERCLIP_CURL_CONNECT_TIMEOUT:-2}"
MAX_TIME="${PAPERCLIP_CURL_MAX_TIME:-10}"
MAX_RETRIES="${PAPERCLIP_CURL_RETRIES:-2}"
RETRY_DELAY="${PAPERCLIP_CURL_RETRY_DELAY:-1}"

# Detect --fail-with-body support (curl >= 7.76)
FAIL_FLAG="--fail"
if curl --fail-with-body --version >/dev/null 2>&1; then
  FAIL_FLAG="--fail-with-body"
fi

attempt=0
delay="$RETRY_DELAY"

while true; do
  if curl \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" \
    $FAIL_FLAG \
    "$@"; then
    exit 0
  fi

  exit_code=$?
  attempt=$((attempt + 1))

  if [[ $attempt -gt $MAX_RETRIES ]]; then
    echo "[paperclip-api-curl] All $MAX_RETRIES retries exhausted (exit $exit_code)" >&2
    exit "$exit_code"
  fi

  # Retry only on transient errors: timeout (28), connection refused (7), network (6)
  if [[ $exit_code -ne 7 && $exit_code -ne 6 && $exit_code -ne 28 ]]; then
    exit "$exit_code"
  fi

  echo "[paperclip-api-curl] Retry $attempt/$MAX_RETRIES after exit $exit_code (delay ${delay}s)" >&2
  sleep "$delay"
  delay=$((delay * 2))
done
