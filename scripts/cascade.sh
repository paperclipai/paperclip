#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$DIR/.env.cascade"
EXPORT_DIR="$DIR/exports"
OUTPUT_FILE="$EXPORT_DIR/cascade.md"

# Load cascade env vars if they exist
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Verify required vars
missing=0
for var in PAPERCLIP_API_URL PAPERCLIP_API_KEY PAPERCLIP_COMPANY_ID; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set" >&2
    missing=1
  fi
done

if [ "$missing" -eq 1 ]; then
  echo "" >&2
  echo "Hint: Create $ENV_FILE with the required variables or export them manually." >&2
  exit 1
fi

mkdir -p "$EXPORT_DIR"

# Run the cascade export, writing to output file
node "$DIR/scripts/blocked-issues-cascade-export.mjs" --output "$OUTPUT_FILE"
echo "Cascade report written to $OUTPUT_FILE"
