#!/usr/bin/env bash
# Paperclip VPS Bootstrap Script
# Run as root on a fresh Ubuntu/Debian VPS:
#   curl -fsSL https://raw.githubusercontent.com/paperclipai/paperclip/main/scripts/vps-bootstrap.sh | bash
#
# Environment variables (optional, for automated/non-interactive installs):
#   PAPERCLIP_BRANCH   - Git branch to clone (default: main)
#   PAPERCLIP_PORT     - Port for the dashboard (default: 3100)
#
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
PAPERCLIP_USER="paperclip"
PAPERCLIP_HOME="/home/${PAPERCLIP_USER}"
INSTALL_DIR="/opt/paperclip"
REPO_URL="${PAPERCLIP_REPO_URL:-https://github.com/paperclipai/paperclip.git}"
REPO_BRANCH="${PAPERCLIP_BRANCH:-master}"
PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
NODE_MAJOR=20

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC}  $*"; }

# ── Phase 1: Pre-flight ─────────────────────────────────────────────────────

check_root() {
  if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root."
    echo "  Usage: sudo bash vps-bootstrap.sh"
    exit 1
  fi
}

check_os() {
  if [[ ! -f /etc/os-release ]]; then
    warn "Cannot detect OS. This script is designed for Ubuntu/Debian."
    return
  fi
  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID}" != "ubuntu" && "${ID}" != "debian" ]]; then
    warn "Detected ${PRETTY_NAME}. This script is designed for Ubuntu/Debian."
    warn "Proceeding anyway -- some packages may need manual installation."
  else
    info "Detected ${PRETTY_NAME}"
  fi
}

# ── Phase 2: User Creation ──────────────────────────────────────────────────

create_user() {
  if id "${PAPERCLIP_USER}" &>/dev/null; then
    success "User '${PAPERCLIP_USER}' already exists"
    return
  fi

  info "Creating user '${PAPERCLIP_USER}'..."
  useradd -m -s /bin/bash "${PAPERCLIP_USER}"

  # Passwordless sudo
  echo "${PAPERCLIP_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${PAPERCLIP_USER}"
  chmod 440 "/etc/sudoers.d/${PAPERCLIP_USER}"

  success "Created user '${PAPERCLIP_USER}' with passwordless sudo"
}

# ── Phase 3: System Dependencies ────────────────────────────────────────────

install_system_deps() {
  info "Installing system dependencies..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq git curl jq build-essential >/dev/null 2>&1
  success "System dependencies installed"
}

# ── Phase 4: Node.js ────────────────────────────────────────────────────────

install_nodejs() {
  if command -v node &>/dev/null; then
    local current_version
    current_version=$(node --version | sed 's/v//' | cut -d. -f1)
    if [[ "${current_version}" -ge "${NODE_MAJOR}" ]]; then
      success "Node.js $(node --version) already installed"
      return
    fi
    info "Node.js version too old ($(node --version)), upgrading..."
  fi

  info "Installing Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
  success "Node.js $(node --version) installed"
}

# ── Phase 5: pnpm ───────────────────────────────────────────────────────────

install_pnpm() {
  info "Enabling pnpm via corepack..."
  corepack enable >/dev/null 2>&1
  # Match the version in Paperclip's package.json packageManager field
  corepack prepare pnpm@9.15.4 --activate >/dev/null 2>&1
  success "pnpm $(pnpm --version) ready"
}

# ── Phase 6: Caddy ──────────────────────────────────────────────────────────

install_caddy() {
  if command -v caddy &>/dev/null; then
    success "Caddy already installed ($(caddy version 2>/dev/null || echo 'unknown'))"
    # Ensure it's stopped and disabled (we start it later when domain is configured)
    systemctl stop caddy 2>/dev/null || true
    systemctl disable caddy 2>/dev/null || true
    return
  fi

  info "Installing Caddy..."
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq caddy >/dev/null 2>&1

  # Install only -- don't start until domain is configured
  systemctl stop caddy 2>/dev/null || true
  systemctl disable caddy 2>/dev/null || true

  # Allow paperclip user to write the Caddyfile and manage caddy via sudo
  chown "${PAPERCLIP_USER}":"${PAPERCLIP_USER}" /etc/caddy/Caddyfile 2>/dev/null || true

  success "Caddy installed (not started -- will activate when domain is configured)"
}

# ── Phase 7: Clone & Build ──────────────────────────────────────────────────

clone_and_build() {
  # Stop service if running (for re-runs)
  systemctl stop paperclip 2>/dev/null || true

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "Repository exists at ${INSTALL_DIR}, pulling latest..."
    cd "${INSTALL_DIR}"
    sudo -u "${PAPERCLIP_USER}" git pull --quiet 2>/dev/null || {
      warn "git pull failed, continuing with existing code"
    }
  else
    info "Cloning Paperclip to ${INSTALL_DIR}..."
    git clone --quiet --branch "${REPO_BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
    chown -R "${PAPERCLIP_USER}":"${PAPERCLIP_USER}" "${INSTALL_DIR}"
  fi

  info "Installing dependencies (this may take a few minutes)..."
  sudo -u "${PAPERCLIP_USER}" bash -c "cd ${INSTALL_DIR} && pnpm install --frozen-lockfile" 2>&1 | tail -1

  info "Building UI..."
  sudo -u "${PAPERCLIP_USER}" bash -c "cd ${INSTALL_DIR} && pnpm --filter @paperclipai/ui build" 2>&1 | tail -1

  info "Building plugin SDK..."
  sudo -u "${PAPERCLIP_USER}" bash -c "cd ${INSTALL_DIR} && pnpm --filter @paperclipai/plugin-sdk build" 2>&1 | tail -1

  info "Building server..."
  sudo -u "${PAPERCLIP_USER}" bash -c "cd ${INSTALL_DIR} && pnpm --filter @paperclipai/server build" 2>&1 | tail -1

  # Verify build output
  if [[ ! -f "${INSTALL_DIR}/server/dist/index.js" ]]; then
    error "Server build failed: ${INSTALL_DIR}/server/dist/index.js not found"
    exit 1
  fi

  success "Paperclip built successfully"
}

# ── Phase 8: Claude Code & Codex CLI ────────────────────────────────────────

install_cli_tools() {
  # Ensure ~/.local/bin is in PATH for the paperclip user
  local bashrc="${PAPERCLIP_HOME}/.bashrc"
  if ! grep -q '.local/bin' "${bashrc}" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${bashrc}"
    chown "${PAPERCLIP_USER}":"${PAPERCLIP_USER}" "${bashrc}"
  fi

  # Claude Code
  if sudo -u "${PAPERCLIP_USER}" bash -lc 'command -v claude' &>/dev/null; then
    success "Claude Code CLI already installed"
  else
    info "Installing Claude Code CLI..."
    sudo -u "${PAPERCLIP_USER}" bash -c \
      'export PATH="$HOME/.local/bin:$PATH" && curl -fsSL https://claude.ai/install.sh | bash' 2>&1 | tail -3 || {
      warn "Claude Code install failed. You can install it later:"
      warn "  su - ${PAPERCLIP_USER} && curl -fsSL https://claude.ai/install.sh | bash"
    }
  fi

  # Codex (install globally as root since npm global dir is /usr/lib/node_modules)
  if command -v codex &>/dev/null; then
    success "Codex CLI already installed"
  else
    info "Installing Codex CLI..."
    npm install --global @openai/codex@latest 2>&1 | tail -1 || {
      warn "Codex install failed. You can install it later:"
      warn "  sudo npm install --global @openai/codex@latest"
    }
  fi
}

# ── Phase 9: Configuration ──────────────────────────────────────────────────

generate_config() {
  local config_dir="${PAPERCLIP_HOME}/.paperclip/instances/default"
  local config_file="${config_dir}/config.json"
  local env_file="${config_dir}/.env"

  mkdir -p "${config_dir}/data/storage" "${config_dir}/data/backups" "${config_dir}/logs" "${config_dir}/secrets"
  chown -R "${PAPERCLIP_USER}":"${PAPERCLIP_USER}" "${PAPERCLIP_HOME}/.paperclip"

  # Preserve existing secrets on re-run
  local BETTER_AUTH_SECRET=""
  local AGENT_JWT_SECRET=""
  if [[ -f "${env_file}" ]]; then
    # shellcheck source=/dev/null
    source "${env_file}" 2>/dev/null || true
    BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-}"
    AGENT_JWT_SECRET="${PAPERCLIP_AGENT_JWT_SECRET:-}"
    info "Preserving existing secrets"
  fi

  # Generate new secrets if needed
  if [[ -z "${BETTER_AUTH_SECRET}" ]]; then
    BETTER_AUTH_SECRET=$(openssl rand -hex 32)
  fi
  if [[ -z "${AGENT_JWT_SECRET}" ]]; then
    AGENT_JWT_SECRET=$(openssl rand -hex 32)
  fi

  # Detect VPS public IP
  local VPS_IP
  VPS_IP=$(curl -4 -sf --max-time 5 https://icanhazip.com 2>/dev/null \
    || curl -4 -sf --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I | awk '{print $1}')
  VPS_IP=$(echo "${VPS_IP}" | tr -d '[:space:]')

  info "Detected VPS IP: ${VPS_IP}"

  # Write .env file with secrets
  cat > "${env_file}" << EOF
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
PAPERCLIP_AGENT_JWT_SECRET=${AGENT_JWT_SECRET}
EOF
  chmod 600 "${env_file}"

  # Write config.json
  cat > "${config_file}" << EOF
{
  "\$meta": {
    "version": 1,
    "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "source": "vps-bootstrap"
  },
  "database": {
    "mode": "embedded-postgres",
    "embeddedPostgresDataDir": "${config_dir}/db",
    "embeddedPostgresPort": 54329,
    "backup": {
      "enabled": true,
      "intervalMinutes": 60,
      "retentionDays": 30,
      "dir": "${config_dir}/data/backups"
    }
  },
  "logging": {
    "mode": "file",
    "logDir": "${config_dir}/logs"
  },
  "server": {
    "deploymentMode": "authenticated",
    "exposure": "public",
    "host": "0.0.0.0",
    "port": ${PAPERCLIP_PORT},
    "allowedHostnames": [],
    "serveUi": true
  },
  "auth": {
    "baseUrlMode": "explicit",
    "publicBaseUrl": "http://${VPS_IP}:${PAPERCLIP_PORT}",
    "disableSignUp": false
  },
  "storage": {
    "provider": "local_disk",
    "localDisk": {
      "baseDir": "${config_dir}/data/storage"
    },
    "s3": {
      "bucket": "paperclip",
      "region": "us-east-1",
      "endpoint": "",
      "prefix": "",
      "forcePathStyle": false
    }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": {
      "keyFilePath": "${config_dir}/secrets/master.key"
    }
  }
}
EOF
  chmod 600 "${config_file}"
  chown -R "${PAPERCLIP_USER}":"${PAPERCLIP_USER}" "${PAPERCLIP_HOME}/.paperclip"

  success "Configuration written (publicBaseUrl: http://${VPS_IP}:${PAPERCLIP_PORT})"
}

# ── Phase 10: Systemd Service ───────────────────────────────────────────────

install_systemd_service() {
  local config_dir="${PAPERCLIP_HOME}/.paperclip/instances/default"

  # Detect VPS IP for PAPERCLIP_PUBLIC_URL
  local VPS_IP
  VPS_IP=$(curl -4 -sf --max-time 5 https://icanhazip.com 2>/dev/null \
    || curl -4 -sf --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I | awk '{print $1}')
  VPS_IP=$(echo "${VPS_IP}" | tr -d '[:space:]')

  cat > /etc/systemd/system/paperclip.service << EOF
[Unit]
Description=Paperclip Server
After=network.target

[Service]
Type=simple
User=${PAPERCLIP_USER}
Group=${PAPERCLIP_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js

# Environment
Environment=NODE_ENV=production
Environment=HOME=${PAPERCLIP_HOME}
Environment=HOST=0.0.0.0
Environment=PORT=${PAPERCLIP_PORT}
Environment=SERVE_UI=true
Environment=PAPERCLIP_HOME=${PAPERCLIP_HOME}/.paperclip
Environment=PAPERCLIP_INSTANCE_ID=default
Environment=PAPERCLIP_CONFIG=${config_dir}/config.json
Environment=PAPERCLIP_DEPLOYMENT_MODE=authenticated
Environment=PAPERCLIP_DEPLOYMENT_EXPOSURE=public
Environment=PAPERCLIP_PUBLIC_URL=http://${VPS_IP}:${PAPERCLIP_PORT}
Environment=PAPERCLIP_MIGRATION_AUTO_APPLY=true

# Secrets
EnvironmentFile=${config_dir}/.env

# Process management
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=paperclip

# Security
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${PAPERCLIP_HOME}/.paperclip ${INSTALL_DIR} /tmp /etc/caddy
PrivateTmp=false

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable paperclip >/dev/null 2>&1

  success "Systemd service installed and enabled"
}

# ── Phase 11: Firewall ──────────────────────────────────────────────────────

configure_firewall() {
  if ! command -v ufw &>/dev/null; then
    warn "ufw not found. Ensure port ${PAPERCLIP_PORT} is open in your firewall/security group."
    return
  fi

  info "Configuring firewall..."
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow "${PAPERCLIP_PORT}/tcp" >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  success "Firewall configured (SSH + HTTP/HTTPS + port ${PAPERCLIP_PORT})"
}

# ── Phase 12: Caddyfile Template ────────────────────────────────────────────

write_caddyfile_template() {
  cat > "${INSTALL_DIR}/Caddyfile.template" << 'EOF'
# Paperclip Caddy Configuration
# This file is managed by Paperclip's domain setup.
# Manual edits will be overwritten when domain is reconfigured.

{$PAPERCLIP_DOMAIN} {
    reverse_proxy localhost:{$PAPERCLIP_PORT:3100}
}
EOF
  chown "${PAPERCLIP_USER}":"${PAPERCLIP_USER}" "${INSTALL_DIR}/Caddyfile.template"
}

# ── Phase 13: Start & Verify ────────────────────────────────────────────────

start_and_verify() {
  info "Starting Paperclip..."
  systemctl start paperclip

  local max_wait=90
  local waited=0
  while [[ ${waited} -lt ${max_wait} ]]; do
    if curl -sf "http://localhost:${PAPERCLIP_PORT}/api/health" >/dev/null 2>&1; then
      success "Paperclip is running!"
      return
    fi
    sleep 2
    waited=$((waited + 2))
    if (( waited % 10 == 0 )); then
      info "Still waiting for startup... (${waited}s / ${max_wait}s)"
    fi
  done

  warn "Paperclip may still be starting (embedded Postgres first-run can take a moment)."
  warn "Check logs: journalctl -u paperclip -f"
}

# ── Phase 14: Banner ────────────────────────────────────────────────────────

print_banner() {
  local VPS_IP
  VPS_IP=$(curl -4 -sf --max-time 5 https://icanhazip.com 2>/dev/null \
    || curl -4 -sf --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I | awk '{print $1}')
  VPS_IP=$(echo "${VPS_IP}" | tr -d '[:space:]')

  echo ""
  echo -e "${GREEN}================================================================${NC}"
  echo -e "${GREEN}           Paperclip VPS Installation Complete!${NC}"
  echo -e "${GREEN}================================================================${NC}"
  echo ""
  echo -e "  Dashboard:   ${BLUE}http://${VPS_IP}:${PAPERCLIP_PORT}${NC}"
  echo -e "  API Health:  ${BLUE}http://${VPS_IP}:${PAPERCLIP_PORT}/api/health${NC}"
  echo ""
  echo -e "  ${YELLOW}NEXT STEPS:${NC}"
  echo ""
  echo "  1. (Optional) Authenticate Claude Code / Codex CLI:"
  echo ""
  echo "     su - ${PAPERCLIP_USER}"
  echo "     claude          # Follow browser auth prompt"
  echo "     # or set: export ANTHROPIC_API_KEY=sk-ant-..."
  echo ""
  echo "  2. Open your dashboard in a browser:"
  echo ""
  echo "     http://${VPS_IP}:${PAPERCLIP_PORT}"
  echo ""
  echo "  3. You will be guided through:"
  echo "     - Creating your admin account (password protection)"
  echo "     - Setting up a domain name (optional, enables HTTPS)"
  echo "     - Creating your first company and agent"
  echo ""
  echo -e "  ${YELLOW}USEFUL COMMANDS:${NC}"
  echo ""
  echo "    journalctl -u paperclip -f       # Live server logs"
  echo "    systemctl restart paperclip       # Restart server"
  echo "    systemctl status paperclip        # Check status"
  echo "    su - ${PAPERCLIP_USER}                   # Switch to paperclip user"
  echo ""
  echo -e "${GREEN}================================================================${NC}"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${GREEN}================================================================${NC}"
  echo -e "${GREEN}           Paperclip VPS Bootstrap${NC}"
  echo -e "${GREEN}================================================================${NC}"
  echo ""

  check_root
  check_os

  create_user
  install_system_deps
  install_nodejs
  install_pnpm
  install_caddy
  clone_and_build
  install_cli_tools
  generate_config
  install_systemd_service
  configure_firewall
  write_caddyfile_template
  start_and_verify
  print_banner
}

main "$@"
