#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env.production"
ENV_TEMPLATE="$PROJECT_DIR/.env.production.example"
RUNTIME_DIR="$PROJECT_DIR/.run"
COMPOSE_FILE="$RUNTIME_DIR/docker-compose.runtime.yml"
COMPOSE_PROJECT_NAME_DEFAULT="paperclip"
APP_SERVICE="paperclip"
DB_SERVICE="postgres"
DEFAULT_APP_PORT="3100"

DOCKER_CMD=()
SUDO_CMD=()

usage() {
  cat <<'EOF'
Usage: ./run.sh <command>

Commands:
  up       Install dependencies, prepare env, build image, and start services
  down     Stop services and clean compose resources for this stack
  restart  Restart the full stack cleanly
  logs     Stream application and database logs
EOF
}

log() {
  printf '[INFO] %s\n' "$*"
}

warn() {
  printf '[WARN] %s\n' "$*" >&2
}

error() {
  printf '[ERROR] %s\n' "$*" >&2
}

die() {
  error "$*"
  exit 1
}

on_error() {
  local exit_code=$?
  local line_no=$1
  error "Command failed at line ${line_no} with exit code ${exit_code}."
  exit "$exit_code"
}

trap 'on_error $LINENO' ERR

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

run_root() {
  if [[ ${#SUDO_CMD[@]} -gt 0 ]]; then
    "${SUDO_CMD[@]}" "$@"
  else
    "$@"
  fi
}

ensure_linux() {
  [[ "$(uname -s)" == "Linux" ]] || die "run.sh hanya mendukung Linux."
}

ensure_ubuntu() {
  [[ -f /etc/os-release ]] || die "Tidak dapat mendeteksi OS."
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "Script ini dioptimalkan untuk Ubuntu. OS terdeteksi: ${PRETTY_NAME:-unknown}"
}

ensure_sudo() {
  if [[ $EUID -eq 0 ]]; then
    SUDO_CMD=()
    return
  fi

  command_exists sudo || die "sudo tidak ditemukan. Jalankan sebagai root atau install sudo."
  SUDO_CMD=(sudo)
}

apt_install() {
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

ensure_base_packages() {
  log "Memastikan package dasar host terpasang..."
  run_root apt-get update -y
  apt_install ca-certificates curl gnupg lsb-release git openssl iproute2 jq
}

ensure_docker() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    log "Docker dan Docker Compose sudah tersedia."
    return
  fi

  log "Docker belum tersedia. Menginstall Docker Engine dan Compose plugin..."
  ensure_base_packages

  run_root install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | run_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    run_root chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  local codename
  codename="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")"
  cat <<EOF | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

  run_root apt-get update -y
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_root systemctl enable docker
  run_root systemctl start docker
}

ensure_node_and_pnpm() {
  local need_node=0
  local need_pnpm=0

  if ! command_exists node; then
    need_node=1
  fi
  if ! command_exists pnpm; then
    need_pnpm=1
  fi

  if [[ $need_node -eq 0 && $need_pnpm -eq 0 ]]; then
    log "Node.js dan pnpm sudah tersedia di host."
    return
  fi

  log "Memastikan Node.js 20 dan pnpm tersedia di host..."
  ensure_base_packages

  if [[ $need_node -eq 1 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash -
    apt_install nodejs
  fi

  if command_exists corepack; then
    run_root corepack enable
    corepack prepare pnpm@9.15.4 --activate
  else
    npm install -g pnpm@9.15.4
  fi
}

detect_docker_cmd() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
    return
  fi

  if [[ ${#SUDO_CMD[@]} -gt 0 ]] && sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo docker)
    return
  fi

  die "Docker tidak bisa diakses. Coba logout/login ulang atau jalankan script ini dengan sudo."
}

require_project_files() {
  [[ -f "$PROJECT_DIR/Dockerfile" ]] || die "Dockerfile tidak ditemukan di $PROJECT_DIR."
  [[ -f "$PROJECT_DIR/package.json" ]] || die "package.json tidak ditemukan di $PROJECT_DIR."
}

detect_server_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
    return
  fi

  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}')"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
    return
  fi

  printf '127.0.0.1\n'
}

random_hex() {
  openssl rand -hex "$1"
}

random_base64() {
  openssl rand -base64 "$1" | tr -d '\n'
}

create_env_file() {
  local server_ip public_url auth_secret db_password
  server_ip="$(detect_server_ip)"
  public_url="${PAPERCLIP_PUBLIC_URL:-http://${server_ip}:${DEFAULT_APP_PORT}}"
  auth_secret="$(random_hex 32)"
  db_password="$(random_base64 24)"

  cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME_DEFAULT}
HOST_BIND_IP=0.0.0.0
APP_PORT=${DEFAULT_APP_PORT}
POSTGRES_USER=paperclip
POSTGRES_PASSWORD=${db_password}
POSTGRES_DB=paperclip
PAPERCLIP_PUBLIC_URL=${public_url}
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
BETTER_AUTH_SECRET=${auth_secret}
SERVE_UI=true
PAPERCLIP_HOME=/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_SECRETS_STRICT_MODE=true
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GOOGLE_API_KEY=
EOF

  chmod 600 "$ENV_FILE"
  warn ".env.production belum ada, jadi saya buat otomatis dengan default aman."
  warn "Silakan review $ENV_FILE jika Anda ingin mengganti URL, port, atau secret provider."
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    log "Menggunakan env file yang sudah ada: $ENV_FILE"
    return
  fi

  if [[ -f "$ENV_TEMPLATE" ]]; then
    log "Membuat $ENV_FILE dari template..."
  fi
  create_env_file
}

load_env_file() {
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  : "${COMPOSE_PROJECT_NAME:=${COMPOSE_PROJECT_NAME_DEFAULT}}"
  : "${APP_PORT:=${DEFAULT_APP_PORT}}"
  : "${HOST_BIND_IP:=0.0.0.0}"
  : "${POSTGRES_USER:=paperclip}"
  : "${POSTGRES_PASSWORD:=paperclip}"
  : "${POSTGRES_DB:=paperclip}"
  : "${PAPERCLIP_PUBLIC_URL:=http://127.0.0.1:${APP_PORT}}"
  : "${PAPERCLIP_DEPLOYMENT_MODE:=authenticated}"
  : "${PAPERCLIP_DEPLOYMENT_EXPOSURE:=private}"
  : "${BETTER_AUTH_SECRET:=}"
  : "${SERVE_UI:=true}"
  : "${PAPERCLIP_HOME:=/paperclip}"
  : "${PAPERCLIP_INSTANCE_ID:=default}"
  : "${PAPERCLIP_SECRETS_STRICT_MODE:=true}"

  [[ -n "$BETTER_AUTH_SECRET" ]] || die "BETTER_AUTH_SECRET kosong di $ENV_FILE."

  DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
  DATABASE_MIGRATION_URL="$DATABASE_URL"
  export DATABASE_URL DATABASE_MIGRATION_URL
}

ensure_runtime_dirs() {
  mkdir -p "$RUNTIME_DIR" "$PROJECT_DIR/volumes/postgres" "$PROJECT_DIR/volumes/paperclip"

  if [[ ! -w "$PROJECT_DIR/volumes/postgres" || ! -w "$PROJECT_DIR/volumes/paperclip" ]]; then
    run_root chown -R "$(id -u):$(id -g)" "$PROJECT_DIR/volumes"
  fi

  chmod 700 "$PROJECT_DIR/volumes/paperclip" || true
}

ensure_compose_file() {
  cat > "$COMPOSE_FILE" <<'EOF'
services:
  postgres:
    image: postgres:17-alpine
    container_name: ${COMPOSE_PROJECT_NAME}-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 20
    volumes:
      - ${PROJECT_DIR}/volumes/postgres:/var/lib/postgresql/data

  paperclip:
    build:
      context: ${PROJECT_DIR}
      dockerfile: ${PROJECT_DIR}/Dockerfile
      args:
        USER_UID: "${HOST_UID}"
        USER_GID: "${HOST_GID}"
    container_name: ${COMPOSE_PROJECT_NAME}-app
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: ${DATABASE_URL}
      DATABASE_MIGRATION_URL: ${DATABASE_MIGRATION_URL}
      PORT: "3100"
      HOST: "0.0.0.0"
      SERVE_UI: ${SERVE_UI}
      PAPERCLIP_HOME: ${PAPERCLIP_HOME}
      PAPERCLIP_INSTANCE_ID: ${PAPERCLIP_INSTANCE_ID}
      PAPERCLIP_PUBLIC_URL: ${PAPERCLIP_PUBLIC_URL}
      PAPERCLIP_DEPLOYMENT_MODE: ${PAPERCLIP_DEPLOYMENT_MODE}
      PAPERCLIP_DEPLOYMENT_EXPOSURE: ${PAPERCLIP_DEPLOYMENT_EXPOSURE}
      PAPERCLIP_SECRETS_STRICT_MODE: ${PAPERCLIP_SECRETS_STRICT_MODE}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      GOOGLE_API_KEY: ${GOOGLE_API_KEY}
    ports:
      - "${HOST_BIND_IP}:${APP_PORT}:3100"
    volumes:
      - ${PROJECT_DIR}/volumes/paperclip:/paperclip
EOF
}

compose() {
  export PROJECT_DIR HOST_UID HOST_GID
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"

  "${DOCKER_CMD[@]}" compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_FILE" \
    "$@"
}

is_stack_running() {
  compose ps --services --status running 2>/dev/null | grep -qx "$APP_SERVICE"
}

port_in_use() {
  local port="$1"
  ss -ltn "( sport = :${port} )" 2>/dev/null | awk 'NR>1 {found=1} END {exit found ? 0 : 1}'
}

ensure_port_available() {
  if port_in_use "$APP_PORT" && ! is_stack_running; then
    die "Port ${APP_PORT} sedang dipakai proses lain. Ubah APP_PORT di $ENV_FILE atau stop service yang konflik."
  fi
}

ensure_repo_updated() {
  local auto_pull="${AUTO_GIT_PULL:-1}"
  [[ "$auto_pull" == "1" ]] || {
    log "AUTO_GIT_PULL=0, skip git pull."
    return
  }

  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return

  if ! git -C "$PROJECT_DIR" diff --quiet || ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    warn "Worktree git tidak clean, jadi auto pull saya skip agar aman."
    return
  fi

  if ! git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    warn "Branch saat ini tidak punya upstream tracking, jadi auto pull saya skip."
    return
  fi

  log "Mengambil update terbaru dari repository..."
  git -C "$PROJECT_DIR" fetch --all --prune
  git -C "$PROJECT_DIR" pull --ff-only
}

health_check() {
  local health_url attempts max_attempts
  health_url="http://127.0.0.1:${APP_PORT}/api/health"
  attempts=0
  max_attempts="${HEALTHCHECK_RETRIES:-60}"

  log "Menunggu health check aplikasi di ${health_url}..."
  until curl -fsS "$health_url" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if (( attempts >= max_attempts )); then
      compose logs --tail=100 "$APP_SERVICE" "$DB_SERVICE" || true
      die "Health check gagal setelah ${max_attempts} percobaan."
    fi
    sleep 2
  done

  log "Health check sukses."
}

show_access_info() {
  log "Aplikasi berjalan."
  printf '  URL       : %s\n' "$PAPERCLIP_PUBLIC_URL"
  printf '  Health    : http://127.0.0.1:%s/api/health\n' "$APP_PORT"
  printf '  Logs      : ./run.sh logs\n'
  if [[ "$PAPERCLIP_DEPLOYMENT_MODE" == "authenticated" && "$PAPERCLIP_DEPLOYMENT_EXPOSURE" == "private" ]]; then
    printf '  Onboarding: buka URL di atas, lalu sign up / sign in dan klaim instance dari browser.\n'
  else
    printf '  Bootstrap : docker compose -f %s exec %s pnpm paperclipai auth bootstrap-ceo --base-url %s\n' \
      "$COMPOSE_FILE" "$APP_SERVICE" "$PAPERCLIP_PUBLIC_URL"
  fi
}

cmd_up() {
  ensure_linux
  ensure_ubuntu
  ensure_sudo
  require_project_files
  ensure_base_packages
  ensure_docker
  ensure_node_and_pnpm
  detect_docker_cmd
  ensure_repo_updated
  ensure_env_file
  load_env_file
  ensure_runtime_dirs
  ensure_compose_file
  ensure_port_available

  log "Memvalidasi docker compose config..."
  compose config -q

  log "Membangun image dan menyalakan stack..."
  compose up -d --build --remove-orphans
  health_check
  show_access_info
}

cmd_down() {
  ensure_linux
  ensure_sudo
  ensure_docker
  detect_docker_cmd

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    warn "Compose runtime file belum ada. Tidak ada stack yang perlu dimatikan."
    return
  fi

  ensure_env_file
  load_env_file
  log "Menghentikan stack..."
  compose down --remove-orphans
}

cmd_restart() {
  cmd_down
  cmd_up
}

cmd_logs() {
  ensure_linux
  ensure_sudo
  ensure_docker
  detect_docker_cmd
  ensure_env_file
  load_env_file
  ensure_compose_file

  log "Menampilkan logs aplikasi dan database..."
  compose logs -f --tail=200 "$APP_SERVICE" "$DB_SERVICE"
}

main() {
  local command="${1:-}"

  case "$command" in
    up)
      cmd_up
      ;;
    down)
      cmd_down
      ;;
    restart)
      cmd_restart
      ;;
    logs)
      cmd_logs
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      usage
      die "Command tidak dikenal: $command"
      ;;
  esac
}

main "$@"
