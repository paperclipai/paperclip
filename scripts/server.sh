#!/usr/bin/env bash
# Сборка Paperclip локально и выкладка на сервер (rsync + pnpm install + systemd).
# Запуск в продакшене как в Docker: node + tsx loader + server/dist/index.js из корня репо.
#
# Использование:
#   ./scripts/deploy-server.sh deploy
#   ./scripts/deploy-server.sh clean-remote   # остановить сервис и удалить REMOTE_DIR
#
# Переменные: SERVER_HOST, REMOTE_DIR, SERVICE_NAME, SSH_PORT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SERVER_HOST="${SERVER_HOST:-ms@nrazum.ru}"
SSH_PORT="${SSH_PORT:-22}"
SSH=(ssh -p "$SSH_PORT" -o BatchMode=yes)
SCP=(scp -P "$SSH_PORT" -o BatchMode=yes)
RSYNC=(rsync -az -e "ssh -p $SSH_PORT -o BatchMode=yes")

REMOTE_DIR="${REMOTE_DIR:-/home/ms/paperclip-run}"
SERVICE_NAME="${SERVICE_NAME:-paperclip}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err() { echo -e "${RED}[ERR]${NC} $1"; }

ensure_tools() {
  command -v pnpm >/dev/null 2>&1 || { log_err "Нужен pnpm (corepack enable)"; exit 1; }
  command -v rsync >/dev/null 2>&1 || { log_err "Нужен rsync"; exit 1; }
}

build_local() {
  log_info "Сборка монорепозитория (локально)..."
  cd "$REPO_ROOT"
  pnpm install --frozen-lockfile
  pnpm -r build
  pnpm --filter @paperclipai/server prepare:ui-dist
  test -f server/dist/index.js || { log_err "Нет server/dist/index.js"; exit 1; }
  test -f server/ui-dist/index.html || { log_err "Нет server/ui-dist/index.html"; exit 1; }
  log_ok "Сборка готова"
}

upload_tree() {
  log_info "Rsync репозитория → $SERVER_HOST:$REMOTE_DIR (без .git и node_modules)..."
  "${SSH[@]}" "$SERVER_HOST" "mkdir -p '$REMOTE_DIR'"
  "${RSYNC[@]}" --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '**/node_modules' \
    --exclude '.env' \
    --exclude 'coverage' \
    --exclude '.turbo' \
    --exclude '**/*.tsbuildinfo' \
    --exclude 'ui/dist' \
    "$REPO_ROOT/" "$SERVER_HOST:$REMOTE_DIR/"
  log_ok "Файлы скопированы"
}

remote_install() {
  log_info "pnpm install на сервере..."
  "${SSH[@]}" "$SERVER_HOST" bash -s <<REMOTE
set -euo pipefail
cd '$REMOTE_DIR'
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
  corepack prepare pnpm@9.15.4 --activate
fi
pnpm install --frozen-lockfile
REMOTE
  log_ok "Зависимости установлены"
}

copy_env_from_legacy() {
  log_info "Проверка .env на сервере..."
  "${SSH[@]}" "$SERVER_HOST" bash -s <<EOS
set -euo pipefail
REMOTE_DIR="$REMOTE_DIR"
if [ -f /home/ms/dev/paperclip/.env ] && [ ! -f "\$REMOTE_DIR/.env" ]; then
  cp /home/ms/dev/paperclip/.env "\$REMOTE_DIR/.env"
  chmod 600 "\$REMOTE_DIR/.env" || true
  echo "Скопирован .env из /home/ms/dev/paperclip/.env"
fi
EOS
}

write_systemd_unit() {
  log_info "Запись systemd unit ($SERVICE_NAME)..."
  "${SSH[@]}" "root@${SERVER_HOST#*@}" env REMOTE_DIR="$REMOTE_DIR" SERVICE_NAME="$SERVICE_NAME" bash -s <<'EOS'
set -euo pipefail
NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Paperclip (production, local build)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ms
Group=ms
WorkingDirectory=${REMOTE_DIR}
Environment=NODE_ENV=production
EnvironmentFile=-${REMOTE_DIR}/.env
ExecStart=${NODE_BIN} --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=paperclip

KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"
EOS
  log_ok "Сервис $SERVICE_NAME перезапущен"
}

stop_old_dev_service() {
  log_info "Остановка paperclip-dev (если был)..."
  "${SSH[@]}" "root@${SERVER_HOST#*@}" \
    "systemctl stop paperclip-dev 2>/dev/null; systemctl disable paperclip-dev 2>/dev/null; true" || true
  log_ok "Готово"
}

remove_legacy_repo() {
  log_warn "Удаление старого клона: /home/ms/dev/paperclip (требуется root)..."
  "${SSH[@]}" "root@${SERVER_HOST#*@}" \
    "rm -rf /home/ms/dev/paperclip" && log_ok "Удалено" || log_warn "Путь отсутствовал или нет прав"
}

deploy_cmd() {
  echo "Деплой Paperclip → $SERVER_HOST:$REMOTE_DIR"
  ensure_tools
  build_local
  stop_old_dev_service
  upload_tree
  copy_env_from_legacy
  remote_install
  write_systemd_unit
  remove_legacy_repo
  log_ok "Деплой завершён: systemctl status $SERVICE_NAME (от root на сервере)"
}

clean_remote_cmd() {
  log_warn "Останавливаю $SERVICE_NAME и удаляю $REMOTE_DIR на $SERVER_HOST"
  "${SSH[@]}" "root@${SERVER_HOST#*@}" \
    "systemctl stop '$SERVICE_NAME' 2>/dev/null || true; systemctl disable '$SERVICE_NAME' 2>/dev/null || true; rm -f /etc/systemd/system/${SERVICE_NAME}.service; systemctl daemon-reload; rm -rf '$REMOTE_DIR'"
  log_ok "Очищено"
}

status_cmd() {
  "${SSH[@]}" "root@${SERVER_HOST#*@}" "systemctl status '$SERVICE_NAME' --no-pager || true"
  "${SSH[@]}" "$SERVER_HOST" "ss -tlnp | grep -E ':3100|:54329' || true"
}

logs_cmd() {
  "${SSH[@]}" "root@${SERVER_HOST#*@}" "journalctl -u '$SERVICE_NAME' -n 80 --no-pager"
}

print_help() {
  cat <<EOF
Использование: $0 <команда>

  deploy       Локальная сборка + rsync + pnpm install на сервере + systemd ($SERVICE_NAME)
  clean-remote Остановить сервис и удалить \$REMOTE_DIR
  clean-legacy Удалить только /home/ms/dev/paperclip (старый git-клон)
  status       systemctl status + порты
  logs         journalctl -u $SERVICE_NAME

Переменные окружения:
  SERVER_HOST=${SERVER_HOST}
  REMOTE_DIR=${REMOTE_DIR}
  SERVICE_NAME=${SERVICE_NAME}
  SSH_PORT=${SSH_PORT}

Запуск процесса (как в Dockerfile): node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
Рабочая директория — корень монорепозитория на сервере.
EOF
}

cmd="${1:-}"

case "$cmd" in
  deploy) deploy_cmd ;;
  clean-remote) clean_remote_cmd ;;
  clean-legacy) remove_legacy_repo ;;
  status) status_cmd ;;
  logs) logs_cmd ;;
  help|--help|-h|"") print_help ;;
  *)
    log_err "Неизвестная команда: $cmd"
    print_help
    exit 1
    ;;
esac
