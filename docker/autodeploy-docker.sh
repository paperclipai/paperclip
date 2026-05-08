#!/usr/bin/env bash
set -euo pipefail

DEPLOY_BASE="$PWD"
SCRIPT_VERSION="2"

usage() {
  cat <<'USAGE'
Usage: ./deploy [profile] [options]

Profiles: local-no-auth | local-auth | private | public

Generates a Paperclip deployment in the current directory.

Options:
  --profile <name>              Same as positional profile
  --dir <path>                  Output directory (default: current directory)
  --port <port>                 Host port (default 3100)
  --bind-host <addr>            127.0.0.1, 0.0.0.0, ::1, or :: (also accepted: loopback, all)
  --public-url <url>            Browser URL
  --allowed-hostnames <csv>     Extra hostnames
  --image <image:tag>           Paperclip image
  --admin-email <email>         First admin email
  --admin-name <name>           First admin display name
  --admin-password <pass>       First admin password (random when omitted)
  --bind-mounts                 Use bind-mounted folders for data instead of docker named volumes
  --data-dir <path>             Folder for bind-mounted data (default: data). Implies --bind-mounts.
  --no-auto-admin               Generate bootstrap invite only
  --no-start                    Generate files but do not start
  --no-open                     Do not open browser
  --force                       Overwrite existing deployment files in the target directory
  --reuse-secrets               When --force is set, reuse existing secrets (postgres password, etc.)
  -h, --help                    Show this help
USAGE
}

info() {
  printf '[paperclip] %s\n' "$*"
}

warn() {
  printf '[paperclip] Warning: %s\n' "$*" >&2
}

die() {
  printf '[paperclip] Error: %s\n' "$*" >&2
  exit 1
}

random_hex() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# Memorable but strong: 4 hex blocks separated by dashes (~96 bits entropy)
random_password() {
  local p
  p="$(random_hex 12)"
  printf '%s-%s-%s-%s' "${p:0:6}" "${p:6:6}" "${p:12:6}" "${p:18:6}"
}

prompt_value() {
  local label="$1"
  local default_value="$2"
  local value
  if [ ! -t 0 ]; then
    printf '%s' "$default_value"
    return
  fi
  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value]: " value </dev/tty
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$label: " value </dev/tty
    printf '%s' "$value"
  fi
}

choose_profile() {
  if [ ! -t 0 ]; then
    die "profile is required in non-interactive mode"
  fi

  cat >&2 <<'MENU'
Select Paperclip deployment profile:
  1) local-no-auth  - trusted local mode, no sign-in
  2) local-auth     - local authenticated mode with admin account
  3) private        - authenticated, intended for LAN/VPN
  4) public         - authenticated, intended for the internet (behind reverse proxy)
MENU
  local choice
  read -r -p "Profile [2]: " choice </dev/tty
  case "${choice:-2}" in
    1|local-no-auth) printf 'local-no-auth' ;;
    2|local-auth) printf 'local-auth' ;;
    3|private) printf 'private' ;;
    4|public) printf 'public' ;;
    *) die "unknown profile choice: $choice" ;;
  esac
}

choose_storage() {
  if [ ! -t 0 ]; then
    printf 'volumes'
    return
  fi
  cat >&2 <<'MENU'
Select data storage:
  1) docker volumes  - managed named volumes (default)
  2) bind mounts     - host folder ./data (postgres + paperclip subfolders)
MENU
  local choice
  read -r -p "Storage [1]: " choice </dev/tty
  case "${choice:-1}" in
    1|volumes|named) printf 'volumes' ;;
    2|bind|bind-mounts|folders) printf 'bind' ;;
    *) die "unknown storage choice: $choice" ;;
  esac
}

choose_bind_host() {
  local profile="$1"
  local default_choice
  case "$profile" in
    local-no-auth|local-auth) default_choice="1" ;;
    *) default_choice="2" ;;
  esac
  if [ ! -t 0 ]; then
    case "$default_choice" in
      1) printf '127.0.0.1' ;;
      *) printf '0.0.0.0' ;;
    esac
    return
  fi
  cat >&2 <<'MENU'
Select host port binding:
  1) 127.0.0.1  - loopback only (behind a reverse proxy, or local-only)
  2) 0.0.0.0    - all interfaces (LAN or internet directly)
MENU
  local choice
  read -r -p "Binding [$default_choice]: " choice </dev/tty
  case "${choice:-$default_choice}" in
    1|127.0.0.1|loopback) printf '127.0.0.1' ;;
    2|0.0.0.0|all) printf '0.0.0.0' ;;
    ::1) printf '::1' ;;
    ::) printf '::' ;;
    *) die "unknown binding choice: $choice" ;;
  esac
}

confirm_continue() {
  local prompt="$1"
  local default_yes="${2:-true}"
  if [ ! -t 0 ]; then
    return
  fi
  local default_label="Y/n"
  local fallback="y"
  if [ "$default_yes" != "true" ]; then
    default_label="y/N"
    fallback="n"
  fi
  local answer
  read -r -p "$prompt [$default_label]: " answer </dev/tty
  case "${answer:-$fallback}" in
    y|Y|yes|YES) return 0 ;;
    *) die "Cancelled" ;;
  esac
}

normalize_profile() {
  case "$1" in
    local-no-auth|no-auth|trusted-local|local_trusted) printf 'local-no-auth' ;;
    local-auth|auth-local|authenticated-local) printf 'local-auth' ;;
    private|private-auth|lan|tailnet) printf 'private' ;;
    public|public-auth) printf 'public' ;;
    *) die "unknown profile: $1" ;;
  esac
}

# Validate IPv4 (octets 0-255), accept the four common bind addresses, plus IPv6 short forms.
validate_bind_host() {
  local host="$1"
  case "$host" in
    127.0.0.1|0.0.0.0|::1|::) return 0 ;;
  esac
  # IPv4 strict validation
  if [[ "$host" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    local i
    for i in "${BASH_REMATCH[@]:1}"; do
      [ "$i" -le 255 ] || return 1
    done
    return 0
  fi
  # IPv6 (loose check; we don't fully validate, but reject obvious garbage)
  if [[ "$host" =~ ^[0-9a-fA-F:]+$ ]] && [[ "$host" == *:* ]]; then
    return 0
  fi
  return 1
}

url_hostname() {
  local raw="$1"
  local without_scheme="${raw#*://}"
  local host_port="${without_scheme%%/*}"
  # Handle bracketed IPv6: [::1]:3100 -> ::1
  if [[ "$host_port" =~ ^\[([^]]+)\] ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  printf '%s' "${host_port%%:*}"
}

# Merge two CSVs, deduplicate while preserving order.
merge_csv() {
  local existing="$1"
  local addition="$2"
  local combined
  if [ -z "$addition" ]; then
    combined="$existing"
  elif [ -z "$existing" ]; then
    combined="$addition"
  else
    combined="$existing,$addition"
  fi
  printf '%s' "$combined" | awk -v RS=',' 'NF && !seen[$0]++ { if (out) printf ","; printf "%s", $0; out=1 }'
}

read_env_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die "Docker Compose was not found. Install Docker Desktop or docker compose."
  fi
}

open_url() {
  local url="$1"
  if [ "${NO_OPEN:-0}" = "1" ]; then
    return
  fi
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

# ---------- arg parsing ----------

PROFILE=""
DEPLOY_DIR=""
HOST_PORT="3100"
BIND_HOST=""
PUBLIC_URL=""
ALLOWED_HOSTNAMES=""
IMAGE="ghcr.io/paperclipai/paperclip:latest"
ADMIN_EMAIL=""
ADMIN_NAME="Paperclip Admin"
ADMIN_PASSWORD=""
AUTO_ADMIN="true"
START_CONTAINERS="true"
NO_OPEN="0"
FORCE="false"
REUSE_SECRETS="false"
USE_BIND_MOUNTS="false"
DATA_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
    --port) HOST_PORT="${2:-}"; shift 2 ;;
    --bind-host) BIND_HOST="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --allowed-hostnames) ALLOWED_HOSTNAMES="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --bind-mounts) USE_BIND_MOUNTS="true"; shift ;;
    --data-dir) DATA_DIR="${2:-}"; USE_BIND_MOUNTS="true"; shift 2 ;;
    --no-auto-admin) AUTO_ADMIN="false"; shift ;;
    --no-start) START_CONTAINERS="false"; shift ;;
    --no-open) NO_OPEN="1"; shift ;;
    --force) FORCE="true"; shift ;;
    --reuse-secrets) REUSE_SECRETS="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown option: $1" ;;
    *)
      if [ -n "$PROFILE" ]; then die "unexpected argument: $1"; fi
      PROFILE="$1"; shift ;;
  esac
done

if [ -z "$PROFILE" ]; then
  PROFILE="$(choose_profile)"
fi
PROFILE="$(normalize_profile "$PROFILE")"

if ! [[ "$HOST_PORT" =~ ^[0-9]+$ ]] || [ "$HOST_PORT" -lt 1 ] || [ "$HOST_PORT" -gt 65535 ]; then
  die "--port must be an integer between 1 and 65535"
fi

case "$PROFILE" in
  local-no-auth)
    DEPLOYMENT_MODE="local_trusted"
    DEPLOYMENT_EXPOSURE="private"
    AUTO_ADMIN="false"
    PUBLIC_URL="${PUBLIC_URL:-http://localhost:$HOST_PORT}"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "localhost,127.0.0.1")"
    ;;
  local-auth)
    DEPLOYMENT_MODE="authenticated"
    DEPLOYMENT_EXPOSURE="private"
    PUBLIC_URL="${PUBLIC_URL:-http://localhost:$HOST_PORT}"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "localhost,127.0.0.1")"
    ;;
  private)
    DEPLOYMENT_MODE="authenticated"
    DEPLOYMENT_EXPOSURE="private"
    PUBLIC_URL="${PUBLIC_URL:-$(prompt_value "Public/browser URL" "http://localhost:$HOST_PORT")}"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "$(url_hostname "$PUBLIC_URL")")"
    ;;
  public)
    DEPLOYMENT_MODE="authenticated"
    DEPLOYMENT_EXPOSURE="public"
    PUBLIC_URL="${PUBLIC_URL:-$(prompt_value "Public URL, for example https://paperclip.example.com" "")}"
    [ -n "$PUBLIC_URL" ] || die "--public-url is required for public profile"
    ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "$(url_hostname "$PUBLIC_URL")")"
    ;;
esac

if [ "$DEPLOYMENT_MODE" = "authenticated" ]; then
  ALLOWED_HOSTNAMES="$(merge_csv "$ALLOWED_HOSTNAMES" "paperclip")"
fi

if [ -z "$BIND_HOST" ]; then
  BIND_HOST="$(choose_bind_host "$PROFILE")"
fi
case "$BIND_HOST" in
  loopback) BIND_HOST="127.0.0.1" ;;
  all) BIND_HOST="0.0.0.0" ;;
esac
validate_bind_host "$BIND_HOST" || die "--bind-host is not a valid IPv4/IPv6 address: $BIND_HOST"

if [ "$DEPLOYMENT_MODE" = "authenticated" ]; then
  ADMIN_EMAIL="${ADMIN_EMAIL:-$(prompt_value "Admin email" "admin@paperclip.local")}"
  ADMIN_NAME="${ADMIN_NAME:-Paperclip Admin}"
fi

PAPERCLIP_BIND_MODE="lan"
if [ "$DEPLOYMENT_MODE" = "local_trusted" ]; then
  PAPERCLIP_BIND_MODE="loopback"
fi
PAPERCLIP_PORT="3100"

if [ -z "$DEPLOY_DIR" ]; then
  DEPLOY_DIR="$DEPLOY_BASE"
fi
mkdir -p "$DEPLOY_DIR"
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd)"

# ---------- detect existing deployment ----------

EXISTING_DEPLOYMENT="false"
EXISTING_PG_PASSWORD=""
EXISTING_BETTER_AUTH_SECRET=""
EXISTING_AGENT_JWT_SECRET=""
EXISTING_DEPLOY_ID=""

if [ -f "$DEPLOY_DIR/.env" ]; then
  EXISTING_DEPLOYMENT="true"
  EXISTING_PG_PASSWORD="$(read_env_value "$DEPLOY_DIR/.env" POSTGRES_PASSWORD || true)"
  EXISTING_BETTER_AUTH_SECRET="$(read_env_value "$DEPLOY_DIR/.env" BETTER_AUTH_SECRET || true)"
  EXISTING_AGENT_JWT_SECRET="$(read_env_value "$DEPLOY_DIR/.env" PAPERCLIP_AGENT_JWT_SECRET || true)"
  EXISTING_DEPLOY_ID="$(read_env_value "$DEPLOY_DIR/.env" PAPERCLIP_DEPLOY_ID || true)"
fi

if [ "$EXISTING_DEPLOYMENT" = "true" ] && [ "$FORCE" != "true" ]; then
  for existing in docker-compose.yml .env manage.sh; do
    if [ -e "$DEPLOY_DIR/$existing" ]; then
      die "$DEPLOY_DIR/$existing already exists. Use --force to overwrite, or --dir for a different directory."
    fi
  done
fi

if [ "$EXISTING_DEPLOYMENT" = "true" ] && [ "$FORCE" = "true" ]; then
  if [ -d "$DEPLOY_DIR" ] && [ -n "$EXISTING_PG_PASSWORD" ] && [ "$REUSE_SECRETS" != "true" ]; then
    warn "Existing deployment detected at $DEPLOY_DIR with secrets in .env."
    warn "Generating new secrets will break existing postgres data and sessions."
    if [ -t 0 ]; then
      cat >&2 <<MENU
Choose how to handle existing secrets:
  1) reuse  - keep existing postgres password, auth secrets (recommended)
  2) rotate - generate new secrets (destroys existing postgres data and sessions)
MENU
      local_reuse=""
      read -r -p "Choice [1]: " local_reuse </dev/tty || true
      case "${local_reuse:-1}" in
        1|reuse|keep) REUSE_SECRETS="true" ;;
        2|rotate|new) REUSE_SECRETS="false" ;;
        *) die "unknown choice: $local_reuse" ;;
      esac
    fi
  fi
fi

if [ "$USE_BIND_MOUNTS" != "true" ] && [ -z "$DATA_DIR" ] && [ -t 0 ] && [ "$EXISTING_DEPLOYMENT" != "true" ]; then
  if [ "$(choose_storage)" = "bind" ]; then
    USE_BIND_MOUNTS="true"
  fi
fi

# Reuse existing data-dir choice on --force unless overridden
if [ "$EXISTING_DEPLOYMENT" = "true" ] && [ -z "$DATA_DIR" ]; then
  existing_data_dir="$(read_env_value "$DEPLOY_DIR/.env" PAPERCLIP_DATA_DIR || true)"
  if [ -n "$existing_data_dir" ]; then
    DATA_DIR="$existing_data_dir"
    USE_BIND_MOUNTS="true"
  fi
fi

PG_VOLUME_MOUNT="postgres-data:/var/lib/postgresql/data"
PAPERCLIP_VOLUME_MOUNT="paperclip-data:/paperclip"
TOP_LEVEL_VOLUMES_BLOCK="volumes:
  postgres-data:
  paperclip-data:"
PAPERCLIP_USER_ENV=""
DATA_DIR_ABS=""
DATA_DIR_REL=""
HOST_UID=""
HOST_GID=""

if [ "$USE_BIND_MOUNTS" = "true" ]; then
  if [ -z "$DATA_DIR" ]; then
    DATA_DIR="data"
  fi
  case "$DATA_DIR" in
    /*) DATA_DIR_ABS="$DATA_DIR"; DATA_DIR_REL="$DATA_DIR" ;;
    ./*) DATA_DIR_ABS="$DEPLOY_DIR/${DATA_DIR#./}"; DATA_DIR_REL="$DATA_DIR" ;;
    *) DATA_DIR_ABS="$DEPLOY_DIR/$DATA_DIR"; DATA_DIR_REL="./$DATA_DIR" ;;
  esac
  PG_VOLUME_MOUNT="$DATA_DIR_REL/postgres:/var/lib/postgresql/data"
  PAPERCLIP_VOLUME_MOUNT="$DATA_DIR_REL/paperclip:/paperclip"
  TOP_LEVEL_VOLUMES_BLOCK=""

  # Pick the UID/GID we'll force the in-container `node` user to take.
  # NEVER use 0:0 — that would remap node -> root, defeating privilege
  # separation and creating two /etc/passwd entries with the same UID.
  # When running as root (or when the override env vars say 0): silently
  # fall back to 1000:1000. The bind-mounted data will be owned by uid 1000
  # on the host, which is fine — root can still read/edit/back it up, and
  # the container runs as a non-privileged user.
  HOST_UID="${PAPERCLIP_RUNTIME_UID:-$(id -u)}"
  HOST_GID="${PAPERCLIP_RUNTIME_GID:-$(id -g)}"

  if [ "$HOST_UID" = "0" ] || [ "$HOST_GID" = "0" ]; then
    HOST_UID="1000"
    HOST_GID="1000"
    info "Running as root with bind mounts — using UID/GID 1000 inside the container"
    info "(data dir on host will be chowned to 1000:1000; root retains full access)"
  fi

  PAPERCLIP_USER_ENV="
      USER_UID: \"$HOST_UID\"
      USER_GID: \"$HOST_GID\""
fi

# ---------- review ----------

if [ -t 0 ]; then
  printf >&2 '\nReview deployment plan:\n'
  printf >&2 '  Profile      : %s\n' "$PROFILE"
  printf >&2 '  Public URL   : %s\n' "$PUBLIC_URL"
  printf >&2 '  Host port    : %s:%s -> container %s\n' "$BIND_HOST" "$HOST_PORT" "$PAPERCLIP_PORT"
  printf >&2 '  Output dir   : %s\n' "$DEPLOY_DIR"
  printf >&2 '  Image        : %s\n' "$IMAGE"
  if [ "$USE_BIND_MOUNTS" = "true" ]; then
    printf >&2 '  Data dir     : %s (bind mounts, uid %s)\n' "$DATA_DIR_ABS" "$HOST_UID"
  else
    printf >&2 '  Data dir     : docker named volumes\n'
  fi
  if [ "$DEPLOYMENT_MODE" = "authenticated" ] && [ "$AUTO_ADMIN" = "true" ]; then
    printf >&2 '  Admin email  : %s\n' "$ADMIN_EMAIL"
  fi
  if [ "$EXISTING_DEPLOYMENT" = "true" ] && [ "$FORCE" = "true" ]; then
    if [ "$REUSE_SECRETS" = "true" ]; then
      printf >&2 '  Existing dir : reusing secrets from existing .env\n'
    else
      printf >&2 '  Existing dir : ROTATING secrets, postgres data will be wiped\n'
    fi
  fi
  printf >&2 '\n'
  confirm_continue "Continue?"
fi

# ---------- teardown old deployment if forced ----------

if [ "$FORCE" = "true" ] && [ -x "$DEPLOY_DIR/manage.sh" ]; then
  if [ "$REUSE_SECRETS" = "true" ]; then
    info "Stopping existing containers (keeping volumes)"
    (cd "$DEPLOY_DIR" && ./manage.sh stop >/dev/null 2>&1) || true
  else
    info "Tearing down previous deployment at $DEPLOY_DIR (volumes will be deleted)"
    if [ -t 0 ]; then
      confirm_continue "Confirm: delete all data volumes for the existing deployment?" "false"
    fi
    (cd "$DEPLOY_DIR" && ./manage.sh reset --yes >/dev/null 2>&1) || true
  fi
fi

rm -f "$DEPLOY_DIR/docker-compose.yml" "$DEPLOY_DIR/.env" "$DEPLOY_DIR/.env.bootstrap" \
      "$DEPLOY_DIR/manage.sh" "$DEPLOY_DIR/admin-credentials.txt"
rm -rf "$DEPLOY_DIR/scripts"
mkdir -p "$DEPLOY_DIR/scripts"

if [ "$USE_BIND_MOUNTS" = "true" ]; then
  mkdir -p "$DATA_DIR_ABS/postgres" "$DATA_DIR_ABS/paperclip"
  # Make sure ownership matches the in-container UID we'll be remapping `node` to.
  # Without this, files left by a previous run as root would be unwritable for
  # the container process running as $HOST_UID:$HOST_GID.
  if [ "$(id -u)" = "0" ] && [ -n "$HOST_UID" ] && [ -n "$HOST_GID" ]; then
    chown -R "$HOST_UID:$HOST_GID" "$DATA_DIR_ABS" 2>/dev/null || \
      warn "could not chown $DATA_DIR_ABS to $HOST_UID:$HOST_GID — bind mount writes may fail"
  fi
fi

# ---------- secrets ----------

if [ "$REUSE_SECRETS" = "true" ] && [ -n "$EXISTING_PG_PASSWORD" ]; then
  POSTGRES_PASSWORD="$EXISTING_PG_PASSWORD"
  BETTER_AUTH_SECRET="${EXISTING_BETTER_AUTH_SECRET:-$(random_hex 32)}"
  AGENT_JWT_SECRET="${EXISTING_AGENT_JWT_SECRET:-$(random_hex 32)}"
  DEPLOY_ID="${EXISTING_DEPLOY_ID:-$(random_hex 4)}"
  info "Reusing existing postgres password and auth secrets"
else
  POSTGRES_PASSWORD="$(random_hex 24)"
  BETTER_AUTH_SECRET="$(random_hex 32)"
  AGENT_JWT_SECRET="$(random_hex 32)"
  DEPLOY_ID="$(random_hex 4)"
fi

if [ "$DEPLOYMENT_MODE" = "authenticated" ] && [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(random_password)"
fi

PROJECT_NAME="paperclip-$DEPLOY_ID"

# ---------- .env (no admin credentials!) ----------

cat > "$DEPLOY_DIR/.env" <<ENV
# Generated by paperclip deploy script v$SCRIPT_VERSION
# Edit values here, then run ./manage.sh restart

NODE_ENV=production
HOST=0.0.0.0
PORT=$PAPERCLIP_PORT
PAPERCLIP_HOME=/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_BIND=$PAPERCLIP_BIND_MODE
PAPERCLIP_PUBLIC_URL=$PUBLIC_URL
PAPERCLIP_ALLOWED_HOSTNAMES=$ALLOWED_HOSTNAMES
BETTER_AUTH_TRUSTED_ORIGINS=$PUBLIC_URL
PAPERCLIP_DEPLOYMENT_MODE=$DEPLOYMENT_MODE
PAPERCLIP_DEPLOYMENT_EXPOSURE=$DEPLOYMENT_EXPOSURE
PAPERCLIP_AUTH_DISABLE_SIGN_UP=false
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
PAPERCLIP_AGENT_JWT_SECRET=$AGENT_JWT_SECRET

# Provider keys: fill in and run ./manage.sh restart
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Internal — do not edit
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
PAPERCLIP_DATA_DIR=$DATA_DIR_REL
PAPERCLIP_DEPLOY_ID=$DEPLOY_ID
PAPERCLIP_PROJECT_NAME=$PROJECT_NAME

# Allow opencode/all-models in agent runner (set to false to restrict)
OPENCODE_ALLOW_ALL_MODELS=true
ENV
chmod 600 "$DEPLOY_DIR/.env"

# Bootstrap-only env (admin credentials live here, deleted after first successful bootstrap)
if [ "$DEPLOYMENT_MODE" = "authenticated" ] && [ "$AUTO_ADMIN" = "true" ]; then
  cat > "$DEPLOY_DIR/.env.bootstrap" <<ENVBOOT
# Generated by paperclip deploy. Used ONLY by the bootstrap container.
# This file is automatically deleted after the admin account is created.
AUTOMATED_AUTO_ADMIN=true
AUTOMATED_ADMIN_EMAIL=$ADMIN_EMAIL
AUTOMATED_ADMIN_PASSWORD=$ADMIN_PASSWORD
AUTOMATED_ADMIN_NAME=$ADMIN_NAME
ENVBOOT
  chmod 600 "$DEPLOY_DIR/.env.bootstrap"
else
  cat > "$DEPLOY_DIR/.env.bootstrap" <<ENVBOOT
AUTOMATED_AUTO_ADMIN=false
ENVBOOT
  chmod 600 "$DEPLOY_DIR/.env.bootstrap"
fi

# ---------- docker-compose.yml ----------

# Healthcheck uses node (always present in the image) instead of curl/wget
# so it works regardless of installed userspace tools.
cat > "$DEPLOY_DIR/docker-compose.yml" <<COMPOSE
name: $PROJECT_NAME

services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: paperclip
      POSTGRES_DB: paperclip
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paperclip -d paperclip"]
      interval: 2s
      timeout: 5s
      retries: 30
    volumes:
      - $PG_VOLUME_MOUNT

  paperclip:
    image: $IMAGE
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "$BIND_HOST:$HOST_PORT:$PAPERCLIP_PORT"
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://paperclip:\${POSTGRES_PASSWORD}@db:5432/paperclip$PAPERCLIP_USER_ENV
    volumes:
      - $PAPERCLIP_VOLUME_MOUNT
    healthcheck:
      test:
        - "CMD"
        - "node"
        - "-e"
        - "fetch('http://127.0.0.1:$PAPERCLIP_PORT/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

  bootstrap:
    image: $IMAGE
    profiles: ["bootstrap"]
    depends_on:
      db:
        condition: service_healthy
      paperclip:
        condition: service_healthy
    entrypoint: ["node", "/paperclip-automated/bootstrap-admin.mjs"]
    env_file:
      - .env
      - .env.bootstrap
    environment:
      DATABASE_URL: postgres://paperclip:\${POSTGRES_PASSWORD}@db:5432/paperclip
      AUTOMATED_INTERNAL_URL: http://paperclip:$PAPERCLIP_PORT
      AUTOMATED_PUBLIC_URL: \${PAPERCLIP_PUBLIC_URL}
    volumes:
      - ./scripts:/paperclip-automated:ro
      - ./:/paperclip-output

$TOP_LEVEL_VOLUMES_BLOCK
COMPOSE

# ---------- shared bash lib ----------

cat > "$DEPLOY_DIR/scripts/lib.sh" <<'LIB'
# Shared helpers for deploy + manage.sh
read_env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    printf 'Docker Compose was not found. Install Docker Desktop or docker compose.\n' >&2
    exit 1
  fi
}

log() {
  printf '[paperclip] %s\n' "$*"
}

warn() {
  printf '[paperclip] Warning: %s\n' "$*" >&2
}

# Returns the container ID for the running paperclip service, or empty.
paperclip_container_id() {
  compose ps -q paperclip 2>/dev/null | head -n1
}
LIB

# ---------- bootstrap-admin.mjs ----------

cat > "$DEPLOY_DIR/scripts/bootstrap-admin.mjs" <<'BOOTSTRAP'
#!/usr/bin/env node
import { spawn } from "node:child_process";

const CLI_ROOT = "/app/cli";
const LOG_PREFIX = "[paperclip]";

const log = (m) => console.log(`${LOG_PREFIX} ${m}`);
const logError = (m) => console.error(`${LOG_PREFIX} ${m}`);

const baseUrl = () =>
  (process.env.AUTOMATED_INTERNAL_URL || "http://paperclip:3100").replace(/\/+$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPaperclip() {
  const deadline =
    Date.now() + Number(process.env.AUTOMATED_BOOTSTRAP_WAIT_MS || "180000");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl()}/api/health`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Paperclip did not become healthy before timeout");
}

async function runAppModuleScript(source) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module"],
      { cwd: CLI_ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `child script exited with code ${code}`));
    });
    child.stdin.end(source);
  });
}

async function ensureBootstrapInvite() {
  const source = String.raw`
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { createDb, instanceUserRoles, invites } from "@paperclipai/db";

const dbUrl = process.env.DATABASE_URL;
const baseUrl = (process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || "http://localhost:3100").replace(/\/+$/, "");
const expiresHoursRaw = Number(process.env.AUTOMATED_BOOTSTRAP_EXPIRES_HOURS || "168");
const expiresHours = Math.max(1, Math.min(24 * 30, Number.isFinite(expiresHoursRaw) ? expiresHoursRaw : 168));
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const db = createDb(dbUrl);

try {
  const adminCount = await db
    .select({ count: count() })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"))
    .then((rows) => Number(rows[0]?.count ?? 0));

  if (adminCount > 0) {
    console.log("AUTOMATED_BOOTSTRAP_JSON:" + JSON.stringify({ adminExists: true }));
  } else {
    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(invites.inviteType, "bootstrap_ceo"),
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      ));

    const token = "pcp_bootstrap_" + randomBytes(24).toString("hex");
    const created = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: hashToken(token),
        allowedJoinTypes: "human",
        expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning()
      .then((rows) => rows[0]);

    console.log("AUTOMATED_BOOTSTRAP_JSON:" + JSON.stringify({
      token,
      inviteUrl: baseUrl + "/invite/" + token,
      expiresAt: created.expiresAt.toISOString(),
    }));
  }
} finally {
  const client = db["$" + "client"];
  await client?.end?.({ timeout: 5 }).catch(() => undefined);
}
`;
  const output = await runAppModuleScript(source);
  const marker = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("AUTOMATED_BOOTSTRAP_JSON:"));
  if (!marker) throw new Error("bootstrap script did not return an invite payload");
  const payload = JSON.parse(marker.slice("AUTOMATED_BOOTSTRAP_JSON:".length));
  if (payload.adminExists) {
    log("Admin account already exists");
  } else if (payload.inviteUrl) {
    log(`First-admin invite created: ${payload.inviteUrl}`);
  }
  return payload;
}

function setCookieHeader(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=[^;,]+=)/).map((c) => c.split(";")[0]).join("; ") : "";
}

async function createAdminFromInvite(inviteToken) {
  if (process.env.AUTOMATED_AUTO_ADMIN !== "true") return false;
  if (!inviteToken) return false;
  const email = process.env.AUTOMATED_ADMIN_EMAIL?.trim();
  const password = process.env.AUTOMATED_ADMIN_PASSWORD?.trim();
  const name = process.env.AUTOMATED_ADMIN_NAME?.trim() || "Paperclip Admin";
  if (!email || !password) {
    log("Auto-admin requested but email or password is missing; invite left active");
    return false;
  }

  const base = baseUrl();
  const origin = new URL(
    process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || base,
  ).origin;
  const authHeaders = {
    "content-type": "application/json",
    accept: "application/json",
    origin,
  };
  let signResponse = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name, email, password }),
  });
  let responseText = await signResponse.text();
  let cookie = setCookieHeader(signResponse.headers);

  if (!signResponse.ok && /already|exist/i.test(responseText)) {
    signResponse = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ email, password }),
    });
    responseText = await signResponse.text();
    cookie = setCookieHeader(signResponse.headers);
  }

  if (!signResponse.ok || !cookie) {
    throw new Error(`admin sign-up/sign-in failed (${signResponse.status}): ${responseText}`);
  }

  const acceptResponse = await fetch(`${base}/api/invites/${inviteToken}/accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin,
      cookie,
    },
    body: JSON.stringify({ requestType: "human" }),
  });
  const acceptText = await acceptResponse.text();
  if (!acceptResponse.ok) {
    throw new Error(`admin invite acceptance failed (${acceptResponse.status}): ${acceptText}`);
  }

  log(`Admin account created: ${email}`);
  return true;
}

async function verifyAdminSignIn() {
  if (process.env.AUTOMATED_AUTO_ADMIN !== "true") return false;
  const email = process.env.AUTOMATED_ADMIN_EMAIL?.trim();
  const password = process.env.AUTOMATED_ADMIN_PASSWORD?.trim();
  if (!email || !password) return false;

  const base = baseUrl();
  const origin = new URL(
    process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || base,
  ).origin;
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin,
    },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`admin sign-in verification failed (${res.status}): ${text}`);
  }
  log(`Admin sign-in verified: ${email}`);
  return true;
}

async function writeAdminCredentials() {
  if (process.env.AUTOMATED_AUTO_ADMIN !== "true") return;
  const fs = await import("node:fs/promises");
  const url = (process.env.AUTOMATED_PUBLIC_URL || process.env.PAPERCLIP_PUBLIC_URL || "").trim();
  const email = (process.env.AUTOMATED_ADMIN_EMAIL || "").trim();
  const password = (process.env.AUTOMATED_ADMIN_PASSWORD || "").trim();
  if (!email || !password) return;
  const content = [
    "Paperclip admin account",
    "(IMPORTANT: delete this file after the first successful login)",
    "",
    `URL:      ${url}`,
    `Email:    ${email}`,
    `Password: ${password}`,
    "",
  ].join("\n");
  const target = "/paperclip-output/admin-credentials.txt";
  await fs.writeFile(target, content, { mode: 0o600 });
  log(`Credentials written to admin-credentials.txt`);
}

async function bootstrap() {
  log("Waiting for Paperclip to become healthy");
  await waitForPaperclip();
  log("Paperclip is healthy");

  const payload = await ensureBootstrapInvite();
  let adminReady = false;
  if (payload?.adminExists) {
    adminReady = await verifyAdminSignIn();
  } else if (payload?.token) {
    try {
      adminReady = await createAdminFromInvite(payload.token);
    } catch (err) {
      logError(`Admin creation failed: ${err?.message || err}`);
      process.exit(1);
    }
  }
  if (adminReady) await writeAdminCredentials();
}

bootstrap().catch((err) => {
  logError(`Bootstrap failed: ${err?.message || err}`);
  process.exit(1);
});
BOOTSTRAP

# ---------- manage.sh ----------

cat > "$DEPLOY_DIR/manage.sh" <<'MANAGE'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=scripts/lib.sh
. ./scripts/lib.sh

usage() {
  cat <<'USAGE'
Usage: ./manage.sh [command]

Commands:
  start        Start db + paperclip; run bootstrap once if admin not yet provisioned
  stop         Stop containers
  restart      Restart paperclip
  bootstrap    Force-run the first-admin bootstrap
  logs         Follow paperclip logs (or another service: ./manage.sh logs db)
  status       Show container status
  credentials  Print admin credentials
  shell        Open a shell inside the paperclip container as the node user
  reset        Stop containers and delete data volumes
USAGE
}

remove_data_dir() {
  local target="$1"
  [ -n "$target" ] || return 0
  local abs
  case "$target" in
    /*) abs="$target" ;;
    ./*) abs="$(pwd)/${target#./}" ;;
    *) abs="$(pwd)/$target" ;;
  esac
  [ -d "$abs" ] || return 0
  log "Removing bind-mounted data at $target"
  rm -rf "$abs/postgres" "$abs/paperclip" 2>/dev/null \
    || docker run --rm -v "$abs:/data" alpine sh -c 'rm -rf /data/postgres /data/paperclip' >/dev/null 2>&1 \
    || true
  rmdir "$abs" 2>/dev/null || true
}

disable_sign_up_after_admin() {
  [ -f admin-credentials.txt ] || return 0
  grep -q '^PAPERCLIP_AUTH_DISABLE_SIGN_UP=false$' .env || return 0
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  awk '/^PAPERCLIP_AUTH_DISABLE_SIGN_UP=/ { print "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true"; next } { print }' .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
  compose up -d --force-recreate paperclip >/dev/null
  log "Sign-up disabled after admin creation; paperclip recreated"
}

# After successful bootstrap, remove the admin password from .env.bootstrap so
# the password is no longer exposed via env vars in the running container or
# in `docker inspect`. Credentials remain available in admin-credentials.txt
# (mode 0600) until the user deletes it.
purge_bootstrap_secrets() {
  [ -f .env.bootstrap ] || return 0
  [ -f admin-credentials.txt ] || return 0
  cat > .env.bootstrap <<'PURGED'
# Bootstrap completed — admin credentials have been removed from env.
# See admin-credentials.txt (delete after first login).
AUTOMATED_AUTO_ADMIN=false
PURGED
  chmod 600 .env.bootstrap
  log "Removed admin credentials from .env.bootstrap"
}

print_shell_hint() {
  local cid project public_url
  project="$(read_env_value .env PAPERCLIP_PROJECT_NAME)"
  public_url="$(read_env_value .env PAPERCLIP_PUBLIC_URL)"
  cid="$(paperclip_container_id)"
  echo
  log "Open the Paperclip UI:"
  log "  ${public_url}"
  echo
  log "Open a shell inside the container as the 'node' user that runs the server:"
  log "  ./manage.sh shell"
  echo
  log "Equivalent raw docker commands (use 'gosu node bash' — see NOTE below):"
  if [ -n "$cid" ]; then
    log "  docker exec -it ${cid} gosu node bash"
  fi
  log "  docker compose -p ${project} exec paperclip gosu node bash"
}

run_bootstrap() {
  local force="${1:-false}"
  local deployment_mode
  deployment_mode="$(read_env_value .env PAPERCLIP_DEPLOYMENT_MODE)"
  if [ "$deployment_mode" != "authenticated" ]; then
    return
  fi
  if [ "$force" != "true" ] && [ -f admin-credentials.txt ]; then
    log "Admin already provisioned; skipping bootstrap"
    log "(run './manage.sh bootstrap' to force re-run)"
    return
  fi
  rm -f admin-credentials.txt
  compose --profile bootstrap run --rm bootstrap
  if [ -f admin-credentials.txt ]; then
    log "Admin credentials saved to $(pwd)/admin-credentials.txt"
    disable_sign_up_after_admin
    purge_bootstrap_secrets
    print_shell_hint
  fi
}

start_stack() {
  local public_url
  public_url="$(read_env_value .env PAPERCLIP_PUBLIC_URL)"
  compose up -d db paperclip
  run_bootstrap
  log "Paperclip is ready at $public_url"
}

cmd="${1:-start}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  start|up)
    start_stack
    ;;
  stop|down)
    compose down
    ;;
  restart)
    compose up -d db paperclip
    compose restart paperclip
    run_bootstrap
    ;;
  bootstrap)
    run_bootstrap true
    ;;
  logs)
    compose logs -f "${1:-paperclip}"
    ;;
  status|ps)
    compose ps
    ;;
  credentials)
    if [ -f admin-credentials.txt ]; then
      cat admin-credentials.txt
    else
      printf 'admin-credentials.txt does not exist yet. Run ./manage.sh start first.\n' >&2
      exit 1
    fi
    ;;
  shell)
    cid="$(paperclip_container_id)"
    if [ -z "$cid" ]; then
      log "paperclip container is not running; starting first"
      compose up -d db paperclip
      cid="$(paperclip_container_id)"
    fi
    if [ -z "$cid" ]; then
      printf 'Could not find paperclip container.\n' >&2
      exit 1
    fi
    # Use `gosu node bash` instead of `docker exec -u node`. The image's
    # entrypoint remaps the `node` user to USER_UID; if that UID happens to
    # collide with another /etc/passwd entry (e.g. 0/root), `-u node` resolves
    # to the wrong account. `gosu node` always selects by name.
    exec docker exec -it "$cid" gosu node bash
    ;;
  reset)
    if [ "${1:-}" != "--yes" ]; then
      printf 'This deletes the generated Paperclip containers and volumes for this deployment.\n'
      read -r -p 'Continue? [y/N] ' answer
      case "$answer" in
        y|Y|yes|YES) ;;
        *) printf 'Cancelled.\n'; exit 0 ;;
      esac
    fi
    compose down -v
    rm -f admin-credentials.txt
    remove_data_dir "$(read_env_value .env PAPERCLIP_DATA_DIR)"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
MANAGE
chmod +x "$DEPLOY_DIR/manage.sh"

# ---------- README ----------

if [ "$USE_BIND_MOUNTS" = "true" ]; then
  STORAGE_LINE="- Data: bind-mounted at \`$DATA_DIR_REL\` (postgres + paperclip subfolders)"
else
  STORAGE_LINE="- Data: docker named volumes (\`postgres-data\`, \`paperclip-data\`)"
fi

cat > "$DEPLOY_DIR/README.md" <<README
# Paperclip — \`$PROFILE\`

- URL: <$PUBLIC_URL>
- Project: \`$PROJECT_NAME\`
$STORAGE_LINE

\`\`\`sh
./manage.sh start         # start db + paperclip
./manage.sh credentials   # print admin login
./manage.sh shell         # shell inside container as node user
./manage.sh logs          # follow paperclip logs
./manage.sh stop          # stop containers
./manage.sh reset --yes   # remove containers + volumes
\`\`\`

The Paperclip server runs as the \`node\` user inside the container (UID/GID
1000 by default; mapped to your host UID when using bind mounts, but never to
0/root). Persistent data lives under \`/paperclip\`. The recommended way to
get a shell is:

\`\`\`sh
./manage.sh shell
\`\`\`

This runs \`docker exec -it <container> gosu node bash\`. Use \`gosu node\`
rather than \`docker exec -u node\`: when the container's \`node\` user has
been remapped to a UID that collides with another \`/etc/passwd\` entry,
\`-u node\` may resolve to the colliding account (e.g. you'd land at
\`root@\` even though you asked for \`node\`). \`gosu node\` always selects
the user by name.

\`\`\`sh
docker compose -p $PROJECT_NAME exec paperclip gosu node bash
\`\`\`

If you accidentally exec as root and create root-owned files under
\`/paperclip\`, fix them with:

\`\`\`sh
docker compose -p $PROJECT_NAME exec paperclip chown -R node:node /paperclip
\`\`\`

Provider keys (\`OPENAI_API_KEY\`, \`ANTHROPIC_API_KEY\`, \`GEMINI_API_KEY\`)
live in \`.env\`; \`./manage.sh restart\` applies changes.

## Files

- \`.env\` — main config (no admin password)
- \`.env.bootstrap\` — admin credentials, only used during first boot, then purged
- \`admin-credentials.txt\` — created after first successful bootstrap, mode 0600.
  **Delete this after your first login.**
README

info "Generated deployment at $DEPLOY_DIR"
info "Profile: $PROFILE | URL: $PUBLIC_URL | Bound to ${BIND_HOST}:${HOST_PORT} | Project: $PROJECT_NAME"

if [ "$START_CONTAINERS" = "true" ]; then
  info "Starting containers"
  (cd "$DEPLOY_DIR" && ./manage.sh start)
  open_url "$PUBLIC_URL"
else
  info "Skipping container start (--no-start)"
fi
