#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE_FILE="$PROJECT_DIR/.env.example"
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

log()   { printf '[INFO] %s\n' "$*"; }
warn()  { printf '[WARN] %s\n' "$*" >&2; }
error() { printf '[ERROR] %s\n' "$*" >&2; }
die()   { error "$*"; exit 1; }

on_error() {
  local exit_code=$?
  local line_no=$1
  error "Command failed at line ${line_no} with exit code ${exit_code}."
  exit "$exit_code"
}

trap 'on_error $LINENO' ERR

command_exists() { command -v "$1" >/dev/null 2>&1; }

run_root() {
  if [[ ${#SUDO_CMD[@]} -gt 0 ]]; then "${SUDO_CMD[@]}" "$@"; else "$@"; fi
}

ensure_linux()   { [[ "$(uname -s)" == "Linux" ]] || die "run.sh hanya mendukung Linux."; }

ensure_ubuntu() {
  [[ -f /etc/os-release ]] || die "Tidak dapat mendeteksi OS."
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "Script ini dioptimalkan untuk Ubuntu. OS terdeteksi: ${PRETTY_NAME:-unknown}"
}

ensure_sudo() {
  if [[ $EUID -eq 0 ]]; then SUDO_CMD=(); return; fi
  command_exists sudo || die "sudo tidak ditemukan. Jalankan sebagai root atau install sudo."
  SUDO_CMD=(sudo)
}

apt_install() { run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"; }

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
  local need_node=0 need_pnpm=0
  ! command_exists node && need_node=1
  ! command_exists pnpm && need_pnpm=1
  [[ $need_node -eq 0 && $need_pnpm -eq 0 ]] && { log "Node.js dan pnpm sudah tersedia di host."; return; }

  log "Memastikan Node.js 20 dan pnpm tersedia di host..."
  ensure_base_packages
  [[ $need_node -eq 1 ]] && { curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash -; apt_install nodejs; }
  if command_exists corepack; then
    run_root corepack enable
    corepack prepare pnpm@9.15.4 --activate
  else
    npm install -g pnpm@9.15.4
  fi
}

# ------------------------------------------------------------------
# CLI installation helpers
# ------------------------------------------------------------------

install_claude_cli() {
  log "Memastikan Claude Code CLI terpasang dan terkonfigurasi..."
  local claude_config_dir="${HOME}/.claude"
  local claude_settings_file="${claude_config_dir}/settings.json"

  if ! command_exists claude; then
    log "Menginstall @anthropic-ai/claude-code..."
    if command_exists sudo; then
      run_root npm install -g @anthropic-ai/claude-code || die "Gagal menginstall Claude Code CLI."
    else
      npm install -g @anthropic-ai/claude-code || die "Gagal menginstall Claude Code CLI."
    fi
    log "Claude Code CLI berhasil diinstall."
  else
    log "Claude Code CLI sudah terpasang."
  fi

  # Validate required env vars — use correct base URL (no /v1 suffix!)
  [[ -z "${ANTHROPIC_API_KEY:-}" ]] && die "ANTHROPIC_API_KEY tidak diset di .env"
  [[ -z "${ANTHROPIC_BASE_URL:-}" ]] && die "ANTHROPIC_BASE_URL tidak diset di .env"

  mkdir -p "$claude_config_dir" || die "Gagal membuat direktori $claude_config_dir"

  log "Membuat/memperbarui settings.json dari variabel environment..."

  cat > "$claude_settings_file" <<CLAUDE_EOF
{
  "env": {
    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL}",
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY}}",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${ANTHROPIC_DEFAULT_OPUS_MODEL:-deepseek-v4-flash}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${ANTHROPIC_DEFAULT_SONNET_MODEL:-deepseek-v4-flash}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-deepseek-v4-flash}"
  },
  "permissions": {
    "allow": [],
    "deny": []
  },
  "apiKeyHelper": "echo '${ANTHROPIC_API_KEY}'"
}
CLAUDE_EOF
  chmod 600 "$claude_settings_file"
  log "Claude Code CLI berhasil dikonfigurasi di $claude_settings_file"
}

install_9router() {
  log "Memastikan 9Router terpasang..."
  if ! command_exists 9router; then
    log "Menginstall 9Router secara global via npm..."
    if command_exists sudo; then
      run_root npm install -g 9router || die "Gagal menginstall 9Router."
    else
      npm install -g 9router || die "Gagal menginstall 9Router."
    fi
    log "9Router berhasil diinstall."
  else
    log "9Router sudah terpasang."
  fi
}

start_9router() {
  local router_port="${NINE_ROUTER_PORT:-20128}"
  local log_file="$PROJECT_DIR/9router.log"
  local pid_file="$PROJECT_DIR/9router.pid"

  log "Memastikan 9Router berjalan di background..."

  # Hentikan instance lama jika ada
  if [[ -f "$pid_file" ]]; then
    local old_pid
    old_pid=$(cat "$pid_file")
    if kill -0 "$old_pid" 2>/dev/null; then
      log "9Router instance lama ditemukan (PID: $old_pid), menghentikan..."
      kill "$old_pid" 2>/dev/null || true
      sleep 1
    fi
  fi

  # Kill any orphan 9router on the port
  local existing_pid
  existing_pid=$(ss -tlnp "( sport = :${router_port} )" 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
  if [[ -n "$existing_pid" ]]; then
    log "Proses lain di port ${router_port} (PID: $existing_pid), menghentikan..."
    kill "$existing_pid" 2>/dev/null || true
    sleep 1
  fi

  # Start 9Router di background
  # Pipe "1" untuk auto-select "Web UI (Open in Browser)" secara non-interaktif
  echo "1" | nohup 9router > "$log_file" 2>&1 &
  local pid=$!
  echo "$pid" > "$pid_file"
  log "9Router berjalan di background (PID: $pid) — log: $log_file"

  # Tunggu startup
  sleep 4

  # Verifikasi port
  if ss -ltn "( sport = :${router_port} )" 2>/dev/null | awk 'NR>1 {found=1} END {exit found ? 0 : 1}'; then
    log "9Router aktif di port ${router_port}"
  else
    warn "9Router mungkin belum siap di port ${router_port}. Cek log: $log_file"
  fi

  # Tampilkan URL (browser jika ada display, log URL jika headless)
  if [[ -n "${DISPLAY:-}" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
    command_exists xdg-open && xdg-open "http://localhost:${router_port}/login" 2>/dev/null || true
  fi
  log "9Router WebUI : http://localhost:${router_port}/login"
  log "9Router Dashboard : http://localhost:${router_port}/dashboard"
  log "9Router API      : http://localhost:${router_port}/v1"
}

install_codex_cli() {
  log "Memastikan OpenAI Codex CLI terpasang dan terkonfigurasi..."
  local codex_config_dir="${HOME}/.codex"
  local codex_auth_file="${codex_config_dir}/auth.json"
  local codex_config_file="${codex_config_dir}/config.toml"

  if ! command_exists codex; then
    log "Menginstall @openai/codex..."
    if command_exists sudo; then
      run_root npm install -g @openai/codex || die "Gagal menginstall OpenAI Codex CLI."
    else
      npm install -g @openai/codex || die "Gagal menginstall OpenAI Codex CLI."
    fi
    log "OpenAI Codex CLI berhasil diinstall."
  else
    log "OpenAI Codex CLI sudah terpasang."
  fi

  [[ -z "${OPENAI_API_KEY:-}" ]] && die "OPENAI_API_KEY tidak diset di .env"

  mkdir -p "$codex_config_dir" || die "Gagal membuat direktori $codex_config_dir"

  log "Membuat/memperbarui auth.json dari variabel environment..."
  cat > "$codex_auth_file" <<CODEX_AUTH_EOF
{
  "OPENAI_API_KEY": "${OPENAI_API_KEY}"
}
CODEX_AUTH_EOF

  log "Membuat/memperbarui config.toml dari variabel environment..."
  cat > "$codex_config_file" <<CODEX_CONFIG_EOF
model_provider = "${CODEX_MODEL_PROVIDER:-openmodel}"
model = "${CODEX_MODEL:-deepseek-v4-flash}"
model_reasoning_effort = "${CODEX_MODEL_REASONING_EFFORT:-high}"
disable_response_storage = ${CODEX_DISABLE_RESPONSE_STORAGE:-true}
preferred_auth_method = "${CODEX_PREFERRED_AUTH_METHOD:-apikey}"

[model_providers.openmodel]
name = "openmodel"
base_url = "${CODEX_OPENMODEL_BASE_URL:-https://api.openmodel.ai/v1}"
wire_api = "responses"
CODEX_CONFIG_EOF

  log "OpenAI Codex CLI berhasil dikonfigurasi di $codex_config_dir"
}

# ------------------------------------------------------------------
# Docker compose helpers
# ------------------------------------------------------------------

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
  if [[ -n "$ip" ]]; then printf '%s\n' "$ip"; return; fi
  ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i=1; i<=NF; i++) if ($i=="src") {print $(i+1); exit}}')"
  if [[ -n "$ip" ]]; then printf '%s\n' "$ip"; return; fi
  printf '127.0.0.1\n'
}

random_hex()   { openssl rand -hex "$1"; }
random_base64(){ openssl rand -base64 "$1" | tr -d '\n'; }

# ------------------------------------------------------------------
# Env file handling
# ------------------------------------------------------------------

create_env_file() {
  local server_ip public_url auth_secret db_password
  server_ip="$(detect_server_ip)"
  public_url="${PAPERCLIP_PUBLIC_URL:-https://paperclip.carisinternational.com}"
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
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
BETTER_AUTH_SECRET=${auth_secret}
TRUST_PROXY=172.19.0.0/16
SERVE_UI=true
PAPERCLIP_HOME=/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_SECRETS_STRICT_MODE=true

# API Keys for CLIs and Paperclip Adapters
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.openmodel.ai
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
OPENAI_API_KEY=
CODE_DISABLE_RESPONSE_STORAGE=true
CODEX_MODEL=deepseek-v4-flash
CODEX_OPENMODEL_BASE_URL=https://api.openmodel.ai/v1
GEMINI_API_KEY=
GOOGLE_API_KEY=
EOF

  chmod 600 "$ENV_FILE"
  warn ".env belum ada, jadi saya buat otomatis dengan default aman."
  warn "Silakan review $ENV_FILE — pastikan ANTHROPIC_API_KEY dan OPENAI_API KEY diisi."
}

create_env_example_file() {
  cat > "$ENV_EXAMPLE_FILE" <<'EOF'
# .env.example
# Copy this file to .env and fill in your actual credentials.

# Docker Compose Project Name
COMPOSE_PROJECT_NAME=paperclip

# Host IP and Port for local binding (ignored when Traefik is used)
HOST_BIND_IP=0.0.0.0
APP_PORT=3100

# PostgreSQL Credentials
POSTGRES_USER=paperclip
POSTGRES_PASSWORD=REPLACE_WITH_STRONG_DB_PASSWORD
POSTGRES_DB=paperclip

# Paperclip Application Configuration
PAPERCLIP_PUBLIC_URL=https://paperclip.carisinternational.com
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
BETTER_AUTH_SECRET=REPLACE_WITH_LONG_RANDOM_SECRET
TRUST_PROXY=172.19.0.0/16

# Paperclip Internal Configuration
SERVE_UI=true
PAPERCLIP_HOME=/paperclip
PAPERCLIP_INSTANCE_ID=default
PAPERCLIP_SECRETS_STRICT_MODE=true

# API Keys for CLIs and Paperclip Adapters
ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_ANTHROPIC_API_KEY
# IMPORTANT: Do NOT append /v1 — Claude CLI adds it automatically.
ANTHROPIC_BASE_URL=https://api.openmodel.ai
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash

OPENAI_API_KEY=REPLACE_WITH_YOUR_OPENAI_API_KEY
CODEX_DISABLE_RESPONSE_STORAGE=true
CODEX_MODEL=deepseek-v4-flash
CODEX_OPENMODEL_BASE_URL=https://api.openmodel.ai/v1

# Other API keys (optional)
GEMINI_API_KEY=
GOOGLE_API_KEY=
EOF
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    log "Menggunakan env file yang sudah ada: $ENV_FILE"
  else
    [[ -f "$ENV_EXAMPLE_FILE" ]] || create_env_example_file
    log "File .env belum ada. Membuat dari template .env.example..."
    cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    warn "File .env telah dibuat dari .env.example."
    warn "WAJIB: isi ANTHROPIC_API_KEY dan OPENAI_API_KEY sebelum menjalankan up lagi."
    exit 1
  fi
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
  : "${PAPERCLIP_PUBLIC_URL:=https://paperclip.carisinternational.com}"
  : "${PAPERCLIP_DEPLOYMENT_MODE:=authenticated}"
  : "${PAPERCLIP_DEPLOYMENT_EXPOSURE:=public}"
  : "${BETTER_AUTH_SECRET:=}"
  : "${SERVE_UI:=true}"
  : "${PAPERCLIP_HOME:=/paperclip}"
  : "${PAPERCLIP_INSTANCE_ID:=default}"
  : "${PAPERCLIP_SECRETS_STRICT_MODE:=true}"
  : "${ANTHROPIC_API_KEY:=}"
  : "${ANTHROPIC_BASE_URL:=}"
  : "${OPENAI_API_KEY:=}"

  [[ -n "$BETTER_AUTH_SECRET" ]] || die "BETTER_AUTH_SECRET kosong di $ENV_FILE."
  [[ -n "$ANTHROPIC_API_KEY" ]] || die "ANTHROPIC_API_KEY kosong di $ENV_FILE. Claude CLI tidak akan berfungsi."
  [[ -n "$OPENAI_API_KEY" ]] || die "OPENAI_API_KEY kosong di $ENV_FILE. Codex CLI tidak akan berfungsi."

  DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
  DATABASE_MIGRATION_URL="$DATABASE_URL"
  export DATABASE_URL DATABASE_MIGRATION_URL
}

# ------------------------------------------------------------------
# Docker compose file generation
# ------------------------------------------------------------------

ensure_runtime_dirs() {
  mkdir -p "$RUNTIME_DIR" "$PROJECT_DIR/volumes/postgres" "$PROJECT_DIR/volumes/paperclip"
  if [[ ! -w "$PROJECT_DIR/volumes/postgres" || ! -w "$PROJECT_DIR/volumes/paperclip" ]]; then
    run_root chown -R "$(id -u):$(id -g)" "$PROJECT_DIR/volumes"
  fi
  chmod 700 "$PROJECT_DIR/volumes/paperclip" || true
}

ensure_compose_file() {
  cat > "$COMPOSE_FILE" <<EOF
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
    networks:
      - paperclip-private

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
      # API keys for adapters inside the container
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      # IMPORTANT: base URL without /v1 — Claude CLI adds it
      ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL}
      # Bearer token for /v1/models pre-flight check
      ANTHROPIC_AUTH_TOKEN: ${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY}}
      # Default model must be compatible with OpenModel
      ANTHROPIC_DEFAULT_OPUS_MODEL: ${ANTHROPIC_DEFAULT_OPUS_MODEL:-deepseek-v4-flash}
      ANTHROPIC_DEFAULT_SONNET_MODEL: ${ANTHROPIC_DEFAULT_SONNET_MODEL:-deepseek-v4-flash}
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ${ANTHROPIC_DEFAULT_HAIKU_MODEL:-deepseek-v4-flash}
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      GOOGLE_API_KEY: ${GOOGLE_API_KEY:-}
    labels:
      - traefik.enable=true
      - traefik.docker.network=afiacloud-containers
      - traefik.http.routers.paperclip.rule=Host(\`${PAPERCLIP_PUBLIC_URL#*//}\`)
      - traefik.http.routers.paperclip.entrypoints=websecure
      - traefik.http.routers.paperclip.tls=true
      - traefik.http.routers.paperclip.tls.certresolver=letsencrypt
      - traefik.http.services.paperclip.loadbalancer.server.port=3100
    volumes:
      - ${PROJECT_DIR}/volumes/paperclip:/paperclip
    networks:
      - paperclip-private
      - afiacloud-containers

networks:
  paperclip-private:
    driver: bridge
  afiacloud-containers:
    external: true
EOF
}

compose() {
  export PROJECT_DIR
  "${DOCKER_CMD[@]}" compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_FILE" \
    "$@"
}

is_stack_running() { compose ps --services --status running 2>/dev/null | grep -qx "$APP_SERVICE"; }

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
  [[ "$auto_pull" == "1" ]] || { log "AUTO_GIT_PULL=0, skip git pull."; return; }
  git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return
  if ! git -C "$PROJECT_DIR" diff --quiet || ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    warn "Worktree git tidak clean, auto pull saya skip."
    return
  fi
  if ! git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    warn "Branch tidak punya upstream, auto pull saya skip."
    return
  fi
  log "Mengambil update terbaru dari repository..."
  git -C "$PROJECT_DIR" fetch --all --prune
  git -C "$PROJECT_DIR" pull --ff-only
}

# ------------------------------------------------------------------
# Health check & deploy
# ------------------------------------------------------------------

health_check() {
  local health_url attempts max_attempts
  health_url="http://127.0.0.1:${APP_PORT}/api/health"
  attempts=0
  max_attempts="${HEALTHCHECK_RETRIES:-60}"
  log "Menunggu health check aplikasi di ${health_url}..."
  until curl -fsS "$health_url" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if (( attempts >= max_attempts )); then
      compose logs --tail=50 "$APP_SERVICE" "$DB_SERVICE" || true
      die "Health check gagal setelah ${max_attempts} percobaan."
    fi
    sleep 2
  done
  log "Health check sukses."
}

deploy_paperclip() {
  log "Memulai deployment Paperclip service..."
  ensure_env_file
  load_env_file

  export HOST_UID="$(id -u)"
  export HOST_GID="$(id -g)"

  ensure_runtime_dirs
  ensure_compose_file
  ensure_port_available

  log "Memvalidasi docker compose config..."
  compose config -q

  log "Membangun image dan menyalakan stack Paperclip..."
  compose up -d --build --remove-orphans
  health_check
  log "Paperclip service berhasil dideploy."
}

# ------------------------------------------------------------------
# Paperclip onboard + bootstrap (inside container)
# ------------------------------------------------------------------

onboard_paperclip() {
  log "Menjalankan onboard Paperclip (first-run setup)..."

  # Check if already configured
  if docker exec "$APP_SERVICE" test -f /paperclip/instances/default/config.json 2>/dev/null; then
    log "Paperclip sudah di-onboard, melewati onboard."
    return
  fi

  log "Paperclip perlu onboard — menjalankan konfigurasi awal..."
  # Write config directly to avoid interactive prompt
  docker exec -i "$APP_SERVICE" sh -c 'mkdir -p /paperclip/instances/default' 2>/dev/null || true

  # Run onboard non-interactively — --yes quickstart, then we override
  docker exec "$APP_SERVICE" sh -c 'pnpm paperclipai onboard --yes 2>&1' && {
    log "Onboard quickstart selesai."
    return
  } || {
    warn "Onboard quickstart gagal, coba konfigurasi manual..."
    # Fallback: write config directly like we did before
    return 1
  }
}

configure_paperclip() {
  log "Mengkonfigurasi Paperclip untuk mode authenticated/public..."

  local config_path="/paperclip/instances/default/config.json"

  # Rewrite config with proper values using Node
  docker exec -i "$APP_SERVICE" sh -c "cat > /tmp/update-config.js << 'JSEOF'
const fs = require('fs');
const path = '$config_path';
let config;
try {
  config = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch {
  config = { \\\$meta: { version: 1, updatedAt: new Date().toISOString(), source: 'run-sh' } };
}
config.server = config.server || {};
config.server.deploymentMode = 'authenticated';
config.server.exposure = 'public';
config.server.bind = 'custom';
config.server.host = '0.0.0.0';
config.server.customBindHost = '0.0.0.0';
config.server.port = 3100;
config.server.serveUi = true;
config.server.allowedHostnames = ['paperclip.carisinternational.com'];
config.auth = config.auth || {};
config.auth.baseUrlMode = 'explicit';
config.auth.publicUrl = '${PAPERCLIP_PUBLIC_URL}';
config.auth.publicBaseUrl = '${PAPERCLIP_PUBLIC_URL}';
config.auth.disableSignUp = false;
config.database = config.database || {};
config.database.mode = 'postgres';
config.database.connectionString = '${DATABASE_URL}';
config.secrets = config.secrets || {};
config.secrets.strictMode = true;
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log('Config updated successfully');
JSEOF
node /tmp/update-config.js" 2>&1 || true
}

restart_paperclip() {
  log "Merestart Paperclip dengan konfigurasi baru..."
  docker restart "$APP_SERVICE" 2>&1 || true
  sleep 10
}

bootstrap_admin() {
  log "Membuat invite admin pertama..."
  local invite_url
  invite_url=$(docker exec "$APP_SERVICE" pnpm paperclipai auth bootstrap-ceo --base-url "$PAPERCLIP_PUBLIC_URL" 2>&1 | grep -o 'https://[^ ]*invite/[^ ]*' || true)
  if [[ -n "$invite_url" ]]; then
    log "=============================================="
    log "  INVITE ADMIN URL (buka di browser):"
    log "  $invite_url"
    log "=============================================="
    log "  URL ini hanya bisa dipakai sekali."
    log "  Expired dalam 48 jam."
  else
    warn "Tidak bisa generate invite URL. Jalankan manual:"
    printf "  docker exec %s pnpm paperclipai auth bootstrap-ceo --base-url %%s\\n" \
      "$APP_SERVICE" "$PAPERCLIP_PUBLIC_URL"
  fi
}

# ------------------------------------------------------------------
# Verification
# ------------------------------------------------------------------

verify_claude_probe() {
  log "Verifikasi Claude CLI dengan hello probe..."
  local result
  result=$(docker exec "$APP_SERVICE" bash -c \
    'ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash timeout 45 claude --print - 2>&1' <<< "Respond with hello" 2>&1 || true)
  if echo "$result" | grep -qi "hello"; then
    log "Claude hello probe: PASS"
    return 0
  else
    warn "Claude hello probe: FAIL (${result:0:200})"
    return 1
  fi
}

verify_codex_probe() {
  log "Verifikasi OpenAI Codex CLI..."
  local codex_version
  codex_version=$(command_exists codex && codex -V 2>&1 || true)
  if [[ -n "$codex_version" ]]; then
    log "OpenAI Codex CLI: PASS (Versi: $codex_version)"
    return 0
  else
    warn "OpenAI Codex CLI: FAIL"
    return 1
  fi
}

verify_9router_probe() {
  local router_port="${NINE_ROUTER_PORT:-20128}"
  log "Verifikasi 9Router endpoint di http://localhost:${router_port}/v1..."

  # Cek endpoint /v1 (OpenAI-compatible)
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:${router_port}/v1" 2>&1 || true)
  if [[ -n "$http_code" ]] && [[ "$http_code" =~ ^(200|401|404)$ ]]; then
    log "9Router /v1 endpoint: PASS (HTTP $http_code)"
  else
    warn "9Router /v1 endpoint: FAIL (HTTP $http_code)"
    return 1
  fi

  # Cek dashboard
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:${router_port}/dashboard" 2>&1 || true)
  if [[ -n "$http_code" ]] && [[ "$http_code" =~ ^(200|3[0-9][0-9])$ ]]; then
    log "9Router Dashboard: PASS (HTTP $http_code)"
  else
    warn "9Router Dashboard: FAIL (HTTP $http_code)"
    return 1
  fi

  return 0
}

verify_all() {
  log "Memulai verifikasi deployment..."
  local overall_status=0

  # 1. Paperclip HTTPS
  log "Verifikasi Paperclip service di https://paperclip.carisinternational.com..."
  local curl_output
  curl_output=$(curl -sSI "https://paperclip.carisinternational.com" 2>&1 || true)
  if echo "$curl_output" | grep -q "200 OK"; then
    log "Paperclip service: PASS (HTTPS 200 OK)"
  else
    warn "Paperclip service: FAIL"
    overall_status=1
  fi

  # 2. Claude probe inside container
  log "Verifikasi Claude Code CLI hello probe di dalam container..."
  local claude_result
  claude_result=$(docker exec "$APP_SERVICE" env ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash timeout 45 claude --print - 2>&1 <<< "Respond with hello" 2>&1 | tr -d '\0' || true)
  if echo "$claude_result" | grep -qi "hello"; then
    log "Claude Code CLI: PASS (hello probe sukses)"
  else
    warn "Claude Code CLI: FAIL — probe gagal"
    overall_status=1
  fi

  # 3. Codex CLI version
  log "Verifikasi OpenAI Codex CLI..."
  if command_exists codex; then
    local codex_ver
    codex_ver=$(codex -V 2>&1 || true)
    if [[ -n "$codex_ver" ]]; then
      log "OpenAI Codex CLI: PASS (Versi: $codex_ver)"
    else
      warn "OpenAI Codex CLI: FAIL"
      overall_status=1
    fi
  else
    warn "OpenAI Codex CLI: FAIL (command tidak ditemukan)"
    overall_status=1
  fi

  # 4. 9Router probe
  log "Verifikasi 9Router..."
  verify_9router_probe || overall_status=1

  log "--- Verifikasi Selesai ---"
  if [[ "$overall_status" -eq 0 ]]; then
    log "Semua verifikasi berhasil. Paperclip siap digunakan!"
  else
    warn "Beberapa verifikasi gagal — Paperclip tetap berjalan."
  fi
}

show_access_info() {
  local router_port="${NINE_ROUTER_PORT:-20128}"
  log "Aplikasi berjalan."
  printf '  URL       : %s\n' "$PAPERCLIP_PUBLIC_URL"
  printf '  Health    : http://127.0.0.1:%s/api/health\n' "$APP_PORT"
  printf '  Logs      : ./run.sh logs\n'
  printf '  Bootstrap : docker exec %s pnpm paperclipai auth bootstrap-ceo --base-url %%s\n' \
      "$APP_SERVICE" "$PAPERCLIP_PUBLIC_URL"
  printf '\n'
  printf '  9Router WebUI    : http://localhost:%s/login\n' "$router_port"
  printf '  9Router Dashboard: http://localhost:%s/dashboard\n' "$router_port"
  printf '  9Router API      : http://localhost:%s/v1\n' "$router_port"
  printf '  9Router PID file : %s\n' "$PROJECT_DIR/9router.pid"
  printf '  9Router Log      : %s\n' "$PROJECT_DIR/9router.log"
}

# ------------------------------------------------------------------
# Commands
# ------------------------------------------------------------------

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

  # 1. Deploy Paperclip stack
  deploy_paperclip

  # 2. Install CLIs on host
  install_claude_cli
  install_codex_cli

  # 3. Install & start 9Router
  install_9router
  start_9router

  # 4. Onboard & configure Paperclip inside container
  onboard_paperclip || true
  configure_paperclip
  restart_paperclip

  # 5. Bootstrap admin
  bootstrap_admin

  # 6. Final verification
  verify_all
  show_access_info
}

cmd_down() {
  ensure_linux
  ensure_sudo
  ensure_docker
  detect_docker_cmd

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    warn "Compose runtime file belum ada. Tidak ada stack yang perlu dimatikan."
  else
    ensure_env_file 2>/dev/null || true
    load_env_file 2>/dev/null || true
    log "Menghentikan stack..."
    compose down --remove-orphans
  fi

  # Stop 9Router
  if [[ -f "$PROJECT_DIR/9router.pid" ]]; then
    local pid
    pid=$(cat "$PROJECT_DIR/9router.pid")
    if kill -0 "$pid" 2>/dev/null; then
      log "Menghentikan 9Router (PID: $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$PROJECT_DIR/9router.pid"
  fi
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
  ensure_env_file 2>/dev/null || true
  load_env_file 2>/dev/null || true
  ensure_compose_file

  log "Menampilkan logs aplikasi dan database..."
  compose logs -f --tail=200 "$APP_SERVICE" "$DB_SERVICE"
}

main() {
  local command="${1:-}"

  case "$command" in
    up)      cmd_up ;;
    down)    cmd_down ;;
    restart) cmd_restart ;;
    logs)    cmd_logs ;;
    -h|--help|help|"") usage ;;
    *) usage; die "Command tidak dikenal: $command" ;;
  esac
}

main "$@"
