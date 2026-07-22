#!/usr/bin/env bash
set -euo pipefail

# Stable, localhost-only Paperclip API client. This exists so Codex can use one
# durable approval prefix instead of asking for every issue URL and JSON body.
# It cannot address remote hosts or non-API routes.
method="${1:-GET}"
path="${2:-}"
body="${3:-}"

case "$method" in
  GET|POST|PATCH|PUT|DELETE) ;;
  *) echo "unsupported method" >&2; exit 2 ;;
esac

case "$path" in
  /api/*) ;;
  *) echo "path must begin with /api/" >&2; exit 2 ;;
esac

url="http://127.0.0.1:3100${path}"
if [[ -n "$body" ]]; then
  exec curl -sS -X "$method" "$url" -H "Content-Type: application/json" --data "$body"
fi
exec curl -sS -X "$method" "$url"
