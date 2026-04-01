#!/usr/bin/env bash

set -euo pipefail

VPS_HOST=""
VPS_USER=""
EXPECTED_SHA=""
RETRIES=0
RETRY_INTERVAL_SECONDS=30

while (($#)); do
  case "$1" in
    --host)
      VPS_HOST="${2:-}"
      shift 2
      ;;
    --user)
      VPS_USER="${2:-}"
      shift 2
      ;;
    --expected-sha)
      EXPECTED_SHA="${2:-}"
      shift 2
      ;;
    --retries)
      RETRIES="${2:-}"
      shift 2
      ;;
    --retry-interval-seconds)
      RETRY_INTERVAL_SECONDS="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

[ -n "$VPS_HOST" ] || { echo "--host is required" >&2; exit 1; }
[ -n "$VPS_USER" ] || { echo "--user is required" >&2; exit 1; }
[ -n "$EXPECTED_SHA" ] || { echo "--expected-sha is required" >&2; exit 1; }
[ -n "${RETRIES}" ] || { echo "--retries is required" >&2; exit 1; }
[ -n "${RETRY_INTERVAL_SECONDS}" ] || { echo "--retry-interval-seconds is required" >&2; exit 1; }
[[ "$RETRIES" =~ ^[0-9]+$ ]] || { echo "--retries must be a non-negative integer" >&2; exit 1; }
[[ "$RETRY_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || { echo "--retry-interval-seconds must be a non-negative integer" >&2; exit 1; }

attempt=0
while :; do
  if ssh \
    -i "$HOME/.ssh/id_ed25519" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$HOME/.ssh/known_hosts" \
    "${VPS_USER}@${VPS_HOST}" \
    "EXPECTED_SHA='$EXPECTED_SHA' bash -s" <<'EOF'
set -euo pipefail

printf "EXPECTED_SHA=%s\n" "$EXPECTED_SHA"

if [ ! -f /opt/paperclip/current-release ]; then
  echo "WARN: /opt/paperclip/current-release not found (likely pre-provenance deployment)"
else
  current_release=$(cat /opt/paperclip/current-release)
  release_sha=$(basename "$current_release" | cut -d- -f1)
  printf "CURRENT_RELEASE=%s\n" "$current_release"
  printf "RELEASE_SHA=%s\n" "$release_sha"
  [ "$release_sha" = "$EXPECTED_SHA" ] || {
    printf "DRIFT: release SHA mismatch expected=%s found=%s\n" "$EXPECTED_SHA" "$release_sha" >&2
    exit 1
  }
fi

container_revision=$(docker inspect paperclip-server-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
printf "CONTAINER_REVISION=%s\n" "$container_revision"
if [ -z "$container_revision" ]; then
  if [ -f /opt/paperclip/current-release ]; then
    echo "DRIFT: container revision label missing while current-release exists" >&2
    exit 1
  fi
  echo "WARN: container revision label missing (likely pre-provenance deployment)"
else
  [ "$container_revision" = "$EXPECTED_SHA" ] || {
    printf "DRIFT: container revision mismatch expected=%s found=%s\n" "$EXPECTED_SHA" "$container_revision" >&2
    exit 1
  }
fi

curl -fsS --max-time 10 http://localhost:3100/api/health > /dev/null || {
  echo "DRIFT: health check failed on localhost" >&2
  exit 1
}

echo "DRIFT_CHECK=PASS"
EOF
  then
    break
  fi

  if [ "$attempt" -ge "$RETRIES" ]; then
    exit 1
  fi

  attempt=$((attempt + 1))
  printf "RETRY: drift check failed, waiting %ss before retry %s/%s\n" "$RETRY_INTERVAL_SECONDS" "$attempt" "$RETRIES" >&2
  sleep "$RETRY_INTERVAL_SECONDS"
done
