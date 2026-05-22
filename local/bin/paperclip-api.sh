#!/usr/bin/env bash
#
# Helper script to call the Paperclip API using project secrets from 1Password.
#
# Usage:
#   ./paperclip-api.sh GET /api/health
#   ./paperclip-api.sh GET /api/issues/123
#   ./paperclip-api.sh POST /api/comments '{"body": "Hello"}'
#
set -euo pipefail

# Navigate to the project root (script lives in local/bin/)
cd "$(dirname "$0")/../.."

# Source .envrc to get the authoritative OP_SERVICE_ACCOUNT_TOKEN
if [[ -f .envrc ]]; then
  source .envrc
  export OP_SERVICE_ACCOUNT_TOKEN
fi

# Arguments
METHOD="${1:-GET}"
PATH_URL="${2:-/api/health}"
DATA="${3:-}"

# Get the base URL from .env or default to localhost:3100
BASE_URL=$(grep -E '^PAPERCLIP_PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "http://localhost:3100")

# Full URL construction
URL="${BASE_URL}${PATH_URL}"

# We use 'env -i' to isolate the environment. This prevents 'op run' from
# attempting to resolve inherited personal secrets (like a personal PAPERCLIP_API_KEY)
# using the project's service account token, which would cause a vault access error.
env -i \
  HOME="${HOME}" \
  PATH="${PATH}" \
  OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}" \
  _PAPERCLIP_DATA="${DATA}" \
  op run --env-file .env -- bash -c '
    CFG=$(mktemp)
    # Ensure the temp file is deleted even if the script is interrupted
    trap "rm -f \"$CFG\"" EXIT

    # Write the header to the temp config file
    printf "header = \"Authorization: Bearer %s\"\n" "$PAPERCLIP_API_KEY" > "$CFG"

    # Execute curl using the config file.
    # _PAPERCLIP_DATA is passed via env (not embedded in the script string) so
    # the inner shell never applies brace expansion or word-splitting to the value.
    curl -s -K "$CFG" -X "'"$METHOD"'" "'"$URL"'" \
      -H "Content-Type: application/json" \
      ${_PAPERCLIP_DATA:+ -d "$_PAPERCLIP_DATA"} \
      | jq "."
'
