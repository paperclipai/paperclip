#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[openclaw-docker-ui] $*"
}

fail() {
  echo "[openclaw-docker-ui] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
}

require_cmd docker
require_cmd git
require_cmd curl
require_cmd openssl
require_cmd grep

OPENCLAW_REPO_URL="${OPENCLAW_REPO_URL:-https://github.com/openclaw/openclaw.git}"
OPENCLAW_DOCKER_DIR="${OPENCLAW_DOCKER_DIR:-/tmp/openclaw-docker}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"
OPENCLAW_CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_CONFIG_DIR/workspace}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_BRIDGE_PORT="${OPENCLAW_BRIDGE_PORT:-18790}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(openssl rand -hex 32)}"
OPENCLAW_BUILD="${OPENCLAW_BUILD:-1}"
OPENCLAW_WAIT_SECONDS="${OPENCLAW_WAIT_SECONDS:-45}"
OPENCLAW_OPEN_BROWSER="${OPENCLAW_OPEN_BROWSER:-0}"
OPENCLAW_SECRETS_FILE="${OPENCLAW_SECRETS_FILE:-$HOME/.secrets}"
OPENCLAW_DISABLE_DEVICE_AUTH="${OPENCLAW_DISABLE_DEVICE_AUTH:-1}"

case "$OPENCLAW_DISABLE_DEVICE_AUTH" in
  1|true|TRUE|True|yes|YES|Yes)
    OPENCLAW_DISABLE_DEVICE_AUTH_JSON="true"
    ;;
  0|false|FALSE|False|no|NO|No)
    OPENCLAW_DISABLE_DEVICE_AUTH_JSON="false"
    ;;
  *)
    fail "OPENCLAW_DISABLE_DEVICE_AUTH must be one of: 1,0,true,false,yes,no"
    ;;
esac

if [[ -z "${OPENAI_API_KEY:-}" && -f "$OPENCLAW_SECRETS_FILE" ]]; then
  set +u
  # shellcheck source=/dev/null
  source "$OPENCLAW_SECRETS_FILE"
  set -u
fi

[[ -n "${OPENAI_API_KEY:-}" ]] || fail "OPENAI_API_KEY is required (set env var or include it in $OPENCLAW_SECRETS_FILE)"

log "preparing OpenClaw repo at $OPENCLAW_DOCKER_DIR"
if [[ -d "$OPENCLAW_DOCKER_DIR/.git" ]]; then
  git -C "$OPENCLAW_DOCKER_DIR" fetch --quiet origin || true
  git -C "$OPENCLAW_DOCKER_DIR" checkout --quiet main || true
  git -C "$OPENCLAW_DOCKER_DIR" pull --ff-only --quiet origin main || true
else
  rm -rf "$OPENCLAW_DOCKER_DIR"
  git clone "$OPENCLAW_REPO_URL" "$OPENCLAW_DOCKER_DIR"
fi

if [[ "$OPENCLAW_BUILD" == "1" ]]; then
  log "building Docker image $OPENCLAW_IMAGE"
  docker build -t "$OPENCLAW_IMAGE" -f "$OPENCLAW_DOCKER_DIR/Dockerfile" "$OPENCLAW_DOCKER_DIR"
fi

log "writing OpenClaw config under $OPENCLAW_CONFIG_DIR"
mkdir -p "$OPENCLAW_WORKSPACE_DIR" "$OPENCLAW_CONFIG_DIR/identity" "$OPENCLAW_CONFIG_DIR/credentials"
chmod 700 "$OPENCLAW_CONFIG_DIR" "$OPENCLAW_CONFIG_DIR/credentials"

cat > "$OPENCLAW_CONFIG_DIR/openclaw.json" <<EOF
{
  "gateway": {
    "mode": "local",
    "port": ${OPENCLAW_GATEWAY_PORT},
    "bind": "${OPENCLAW_GATEWAY_BIND}",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "controlUi": {
      "enabled": true,
      "dangerouslyDisableDeviceAuth": ${OPENCLAW_DISABLE_DEVICE_AUTH_JSON},
      "allowedOrigins": [
        "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}",
        "http://localhost:${OPENCLAW_GATEWAY_PORT}"
      ]
    }
  },
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  },
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
EOF
chmod 600 "$OPENCLAW_CONFIG_DIR/openclaw.json"

cat > "$OPENCLAW_DOCKER_DIR/.env" <<EOF
OPENCLAW_CONFIG_DIR=$OPENCLAW_CONFIG_DIR
OPENCLAW_WORKSPACE_DIR=$OPENCLAW_WORKSPACE_DIR
OPENCLAW_GATEWAY_PORT=$OPENCLAW_GATEWAY_PORT
OPENCLAW_BRIDGE_PORT=$OPENCLAW_BRIDGE_PORT
OPENCLAW_GATEWAY_BIND=$OPENCLAW_GATEWAY_BIND
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
OPENCLAW_IMAGE=$OPENCLAW_IMAGE
OPENAI_API_KEY=$OPENAI_API_KEY
EOF

COMPOSE_OVERRIDE="${OPENCLAW_DOCKER_DIR}/.paperclip-openclaw.override.yml"
cat > "$COMPOSE_OVERRIDE" <<EOF
services:
  openclaw-gateway:
    tmpfs:
      - /tmp:exec,size=512M
  openclaw-cli:
    tmpfs:
      - /tmp:exec,size=512M
EOF

compose() {
  docker compose \
    -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" \
    -f "$COMPOSE_OVERRIDE" \
    "$@"
}

log "starting OpenClaw gateway container"
compose up -d openclaw-gateway

log "waiting for gateway health on http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/"
READY="0"
for _ in $(seq 1 "$OPENCLAW_WAIT_SECONDS"); do
  code="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/" || true)"
  if [[ "$code" == "200" ]]; then
    READY="1"
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  compose logs --tail=100 openclaw-gateway || true
  fail "gateway did not become healthy in ${OPENCLAW_WAIT_SECONDS}s"
fi

dashboard_output="$(compose run --rm openclaw-cli dashboard --no-open)"
dashboard_url="$(grep -Eo 'https?://[^[:space:]]+#token=[^[:space:]]+' <<<"$dashboard_output" | head -n1 || true)"
if [[ -z "$dashboard_url" ]]; then
  dashboard_url="http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/#token=${OPENCLAW_GATEWAY_TOKEN}"
fi

cat <<EOF

OpenClaw gateway is running.

Dashboard URL:
$dashboard_url

Pairing mode:
  OPENCLAW_DISABLE_DEVICE_AUTH=$OPENCLAW_DISABLE_DEVICE_AUTH
EOF

if [[ "$OPENCLAW_DISABLE_DEVICE_AUTH_JSON" == "true" ]]; then
  cat <<EOF
  Device pairing is disabled for this local smoke run.
  (Security tradeoff: enable pairing with OPENCLAW_DISABLE_DEVICE_AUTH=0.)

Useful commands:
  docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" -f "$COMPOSE_OVERRIDE" logs -f openclaw-gateway
  docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" -f "$COMPOSE_OVERRIDE" down
EOF
else
  cat <<EOF
  Device pairing is enabled.
  If UI shows "pairing required", run:
    docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" -f "$COMPOSE_OVERRIDE" run --rm openclaw-cli devices list
    docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" -f "$COMPOSE_OVERRIDE" run --rm openclaw-cli devices approve --latest

Useful commands:
  docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" -f "$COMPOSE_OVERRIDE" logs -f openclaw-gateway
  docker compose -f "$OPENCLAW_DOCKER_DIR/docker-compose.yml" -f "$COMPOSE_OVERRIDE" down
EOF
fi

if [[ "$OPENCLAW_OPEN_BROWSER" == "1" ]] && command -v open >/dev/null 2>&1; then
  log "opening dashboard in browser"
  open "$dashboard_url"
fi
