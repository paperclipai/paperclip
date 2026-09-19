#!/usr/bin/env bash
# Argv-free transport for the Paperclip API.
#
# WHY THIS EXISTS
# ---------------
# On Linux a process's arguments are world-readable: /proc/<pid>/cmdline is
# mode 0444 and `ps -ww -eo args` shows it to every account on the box. So
#
#     curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" ...
#
# publishes this run's credential to every other process on the host for the
# lifetime of the call, and drops it into any `ps` output, crash dump or
# monitoring snapshot taken during that window. A run JWT is a bearer
# credential with no revocation path, so a neighbour that copies one can act as
# this agent until the token expires.
#
# These helpers pass the header to curl on stdin instead. `printf` is a shell
# builtin, so the expanded value never becomes any process's argv either.
#
# USAGE
# -----
#     . "$(dirname "$0")/paperclip-api.sh"      # or: source paperclip-api.sh
#
#     pc_api GET  /api/agents/me
#     pc_api POST "/api/issues/$PAPERCLIP_TASK_ID/comments" body.json
#     pc_api PATCH "/api/issues/$PAPERCLIP_TASK_ID" body.json
#     pc_api_upload "/api/companies/$PAPERCLIP_COMPANY_ID/issues/$ID/attachments" ./evidence.png image/png
#
# Each helper prints the response body on stdout and leaves the HTTP status in
# $PC_API_STATUS. Non-2xx is reported by that variable, not by the exit code of
# curl, so callers must check it.
#
# Retry policy: GET/HEAD may be retried freely. Do NOT blindly retry a mutation
# that returned an empty status -- the request may already be queued server
# side, and a retry creates duplicates.

pc_api_base() {
  local base="${PAPERCLIP_API_URL%/}"
  printf '%s' "${base%/api}"
}

# Emit the curl config for one request on stdout. Never called with the
# credential as an argument -- it is read from the environment here.
_pc_api_config() {
  local method="$1" url="$2" body_file="$3" out_file="$4" form="$5"
  printf 'url = "%s"\n' "$url"
  printf 'request = "%s"\n' "$method"
  printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY"
  if [ -n "${PAPERCLIP_RUN_ID-}" ]; then
    printf 'header = "X-Paperclip-Run-Id: %s"\n' "$PAPERCLIP_RUN_ID"
  fi
  if [ -n "$body_file" ]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data = "@%s"\n' "$body_file"
  fi
  if [ -n "$form" ]; then
    printf 'form = "%s"\n' "$form"
  fi
  printf 'silent\nshow-error\nmax-time = %s\n' "${PC_API_MAX_TIME:-90}"
  printf 'output = "%s"\n' "$out_file"
  printf 'write-out = "%%{http_code}"\n'
}

_pc_api_run() {
  local method="$1" path="$2" body_file="$3" form="$4"
  local url out
  url="$(pc_api_base)$path"
  out="$(mktemp "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/pc-api.XXXXXX")" || return 1
  PC_API_STATUS="$(_pc_api_config "$method" "$url" "$body_file" "$out" "$form" | curl --config -)"
  cat "$out"
  rm -f "$out"
  case "$PC_API_STATUS" in
    2*) return 0 ;;
    *) return 1 ;;
  esac
}

pc_api() {
  local method="${1:?usage: pc_api METHOD PATH [BODY_FILE]}"
  local path="${2:?usage: pc_api METHOD PATH [BODY_FILE]}"
  _pc_api_run "$method" "$path" "${3-}" ""
}

pc_api_upload() {
  local path="${1:?usage: pc_api_upload PATH FILE [MIME_TYPE]}"
  local file="${2:?usage: pc_api_upload PATH FILE [MIME_TYPE]}"
  local type="${3-application/octet-stream}"
  _pc_api_run POST "$path" "" "file=@${file};type=${type}"
}

# After changing this file, prove the property still holds by running the
# regression harness next to it:
#
#     python3 "$(dirname "$0")/argv-leak-regression.py"
#
# It samples /proc/<pid>/cmdline and `ps` while a request is in flight, and
# fails unless the credential is absent from both AND the header actually
# reached the server.
