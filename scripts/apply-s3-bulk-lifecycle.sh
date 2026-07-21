#!/usr/bin/env bash
set -euo pipefail

: "${PAPERCLIP_STORAGE_S3_BUCKET:?PAPERCLIP_STORAGE_S3_BUCKET is required}"
prefix="${PAPERCLIP_STORAGE_S3_PREFIX:-}"
prefix="${prefix#/}"
prefix="${prefix%/}"
base="${prefix:+${prefix}/}"
config="$(mktemp)"
trap 'rm -f "$config"' EXIT
cat >"$config" <<JSON
{"Rules":[{"ID":"paperclip-run-logs-90d","Status":"Enabled","Filter":{"Prefix":"${base}run-logs/"},"Expiration":{"Days":90}},{"ID":"paperclip-retained-snapshots-90d","Status":"Enabled","Filter":{"Prefix":"${base}retention/90-days/"},"Expiration":{"Days":90}}]}
JSON

if [[ "${PAPERCLIP_LIFECYCLE_DRY_RUN:-false}" == "true" ]]; then
  cat "$config"
  exit 0
fi

aws s3api put-bucket-lifecycle-configuration \
  --bucket "$PAPERCLIP_STORAGE_S3_BUCKET" \
  --lifecycle-configuration "file://$config"
