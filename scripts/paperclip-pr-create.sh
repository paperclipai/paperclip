#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/paperclip-pr-create.sh [gh pr create args...] --body-file PATH
  scripts/paperclip-pr-create.sh [gh pr create args...] --body-stdin < PR_BODY.md

Creates a GitHub pull request through `gh pr create` while forcing the PR body
through a file/stdin path. This preserves literal newlines and avoids the common
failure mode where a shell-escaped `\n` sequence is rendered in GitHub instead
of becoming a line break.

Examples:
  scripts/paperclip-pr-create.sh --title "Fix widget" --base master --body-stdin <<'MD'
  ## Thinking Path
  > - ...
  MD

  scripts/paperclip-pr-create.sh --title "Fix widget" --body-file /tmp/pr-body.md
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

args=()
body_file=""
body_stdin=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --body|-b)
      printf 'Do not pass PR markdown via --body. Use --body-file or --body-stdin so newlines are preserved.\n' >&2
      exit 2
      ;;
    --body-file|-F)
      body_file="${2:-}"
      if [[ -z "$body_file" ]]; then
        printf 'Missing value for --body-file.\n' >&2
        exit 2
      fi
      shift 2
      ;;
    --body-stdin)
      body_stdin=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

if [[ -n "$body_file" && "$body_stdin" == "1" ]]; then
  printf 'Pass only one of --body-file or --body-stdin.\n' >&2
  exit 2
fi

if [[ -z "$body_file" && "$body_stdin" != "1" ]]; then
  printf 'Missing PR body source. Pass --body-file or --body-stdin.\n' >&2
  exit 2
fi

require_command gh

if [[ "$body_stdin" == "1" ]]; then
  tmp_body="$(mktemp)"
  trap 'rm -f "$tmp_body"' EXIT
  cat >"$tmp_body"
  body_file="$tmp_body"
fi

if [[ ! -f "$body_file" ]]; then
  printf 'PR body file does not exist: %s\n' "$body_file" >&2
  exit 2
fi

if grep -q '\\n' "$body_file"; then
  printf 'PR body contains literal \\n sequences. Replace them with real newlines before creating the PR.\n' >&2
  exit 2
fi

exec gh pr create "${args[@]}" --body-file "$body_file"
