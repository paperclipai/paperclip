#!/usr/bin/env bash
# setup.sh — Interactive Paperclip self-hosted installer
# Usage: ./setup.sh
set -euo pipefail
umask 077  # ensure temp files (e.g. .env.tmp.$$) are not world-readable

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${GREEN}✔${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✘${RESET} $*" >&2; }
heading() { echo -e "\n${BOLD}$*${RESET}"; }

# ─── Dependency checks ───────────────────────────────────────────────────────

heading "Checking dependencies..."
MISSING=()
command -v docker  >/dev/null 2>&1 || MISSING+=("docker")
command -v curl    >/dev/null 2>&1 || MISSING+=("curl")
command -v openssl >/dev/null 2>&1 || MISSING+=("openssl")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing dependencies: ${MISSING[*]}"
  echo "Install them before continuing."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  error "Docker is not running. Start Docker and try again."
  exit 1
fi
info "Docker available"

# ─── Instance configuration ──────────────────────────────────────────────────

heading "Instance configuration"

if [[ -f .env ]]; then
  warn ".env already exists. Press Enter to keep it or 's' to recreate."
  read -r RECREATE
  if [[ "$RECREATE" != "s" && "$RECREATE" != "S" ]]; then
    info "Using existing .env."
    ENV_READY=true
    # Read PUBLIC_URL and HTTP_PORT from existing .env so health check uses the correct values
    PUBLIC_URL=$(grep -E '^PAPERCLIP_PUBLIC_URL=' .env | cut -d= -f2- | tr -d '"'"'"'"' || true)
    _ENV_HTTP_PORT=$(grep -E '^HTTP_PORT=' .env | cut -d= -f2- | tr -d '"'"'"'"' || true)
    if [[ "$_ENV_HTTP_PORT" =~ ^[0-9]{1,5}$ ]] && (( _ENV_HTTP_PORT >= 1 && _ENV_HTTP_PORT <= 65535 )); then
      HTTP_PORT="$_ENV_HTTP_PORT"
    fi
  fi
fi

if [[ "${ENV_READY:-false}" != "true" ]]; then
  echo ""
  read -rp "Public URL for this instance (e.g. https://paperclip.example.com): " PUBLIC_URL
  if [[ -z "$PUBLIC_URL" ]]; then
    warn "No URL provided — defaulting to http://localhost:3100"
    PUBLIC_URL="http://localhost:3100"
  elif [[ ! "$PUBLIC_URL" =~ ^https?://[^[:space:]]+$ ]]; then
    error "Invalid URL (must start with http:// or https://): $PUBLIC_URL"
    exit 1
  fi

  AUTH_SECRET=$(openssl rand -hex 32)
  DB_PASSWORD=$(openssl rand -hex 16)
  REDIS_PASSWORD=$(openssl rand -hex 16)
  info "Secrets generated automatically."

  echo ""
  echo "AI API keys (optional — press Enter to use Claude MAX/subscription account):"
  read -rsp "  ANTHROPIC_API_KEY (Enter to skip): " ANTHROPIC_KEY; echo
  read -rsp "  OPENAI_API_KEY    (Enter to skip): " OPENAI_KEY; echo

  if [[ -z "$ANTHROPIC_KEY" && -z "$OPENAI_KEY" ]]; then
    info "No API key provided — agents will use subscription mode (Claude MAX). Sign in when prompted."
  fi

  # Strip any embedded newlines/carriage-returns from user-supplied values before
  # writing to .env to prevent line-injection attacks (e.g., pasted URL with \n).
  PUBLIC_URL="${PUBLIC_URL//$'\n'/}"; PUBLIC_URL="${PUBLIC_URL//$'\r'/}"
  ANTHROPIC_KEY="${ANTHROPIC_KEY//$'\n'/}"; ANTHROPIC_KEY="${ANTHROPIC_KEY//$'\r'/}"
  OPENAI_KEY="${OPENAI_KEY//$'\n'/}"; OPENAI_KEY="${OPENAI_KEY//$'\r'/}"

  # Write to a temp file first, then atomically rename to avoid partial .env on failure.
  ENV_TMP=".env.tmp.$$"
  trap 'rm -f "$ENV_TMP"' EXIT
  printf 'PAPERCLIP_PUBLIC_URL=%s\nBETTER_AUTH_SECRET=%s\nDB_PASSWORD=%s\nREDIS_PASSWORD=%s\nANTHROPIC_API_KEY=%s\nOPENAI_API_KEY=%s\nPAPERCLIP_DEPLOYMENT_MODE=authenticated\nPAPERCLIP_DEPLOYMENT_EXPOSURE=private\n' \
    "$PUBLIC_URL" "$AUTH_SECRET" "$DB_PASSWORD" "$REDIS_PASSWORD" "${ANTHROPIC_KEY:-}" "${OPENAI_KEY:-}" > "$ENV_TMP"
  chmod 600 "$ENV_TMP"
  mv "$ENV_TMP" .env
  trap - EXIT  # temp file successfully renamed; clear the cleanup trap
  info ".env created successfully."
fi

# ─── Start services ──────────────────────────────────────────────────────────

heading "Starting services..."
# Build locally — never pull the app image from a registry (avoids auth errors on private GHCR)
# APP_IMAGE=paperclip:local is the default local build tag. Override with APP_IMAGE=<your-tag> if needed.
APP_IMAGE=paperclip:local docker compose -f docker/docker-compose.prod.yml --env-file .env build
APP_IMAGE=paperclip:local docker compose -f docker/docker-compose.prod.yml --env-file .env up -d --pull never

# ─── Wait for app health ─────────────────────────────────────────────────────

heading "Waiting for the application to become ready..."
APP_URL="${PUBLIC_URL:-http://localhost:3100}"
# Always poll locally via nginx (avoids DNS/TLS dependency during first-time setup)
HTTP_PORT_LOCAL="${HTTP_PORT:-80}"
HEALTH_URL="http://localhost:${HTTP_PORT_LOCAL}/health"

RETRIES=30
for i in $(seq 1 $RETRIES); do
  HEALTH_RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null || true)
  if echo "$HEALTH_RESPONSE" | grep -qE '"status"\s*:\s*"ok"'; then
    echo ""
    info "Application ready!"
    break
  fi
  if [[ $i -eq $RETRIES ]]; then
    error "Timeout waiting for application. Check the logs:"
    echo "  docker compose -f docker/docker-compose.prod.yml logs app"
    echo "  docker compose -f docker/docker-compose.prod.yml logs nginx"
    exit 1
  fi
  echo -n "."
  sleep 3
done

# ─── Summary ─────────────────────────────────────────────────────────────────

heading "Installation complete!"
echo ""
echo -e "  ${BOLD}URL:${RESET}    ${APP_URL}"
echo -e "  ${BOLD}Health:${RESET} ${APP_URL%/}/health"
echo ""
echo "Para verificar os logs:"
echo "  docker compose -f docker/docker-compose.prod.yml logs -f"
echo ""
echo "Para parar:"
echo "  docker compose -f docker/docker-compose.prod.yml down"
echo ""
echo "Para backup do banco:"
echo "  ./scripts/backup-docker.sh"
echo ""
