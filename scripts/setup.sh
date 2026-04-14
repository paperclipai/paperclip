#!/usr/bin/env bash
# ============================================================
# COS v2 — Mac 초기 세팅 스크립트
#
# 포맷 후 이 스크립트 하나로 전체 환경 복구.
# 로컬 직접 실행 또는 SSH 원격 실행 모두 지원.
#
# 사용법:
#   직접:  ./scripts/setup.sh
#   원격:  ssh mac-studio "cd ~/Projects/company-os-v2 && ./scripts/setup.sh"
#   최초:  curl -fsSL <raw-url> | bash  (repo 클론 전)
#
# 환경변수 (선택):
#   COS_DB_URL        — 외부 DB URL (기본: embedded-postgres)
#   COS_PORT          — 서버 포트 (기본: 3100)
#   COS_HOST          — 서버 바인딩 (기본: 0.0.0.0)
#   COS_TAILSCALE_HOST — Tailscale 호스트명 (allowedHostnames에 추가)
#   COS_SKIP_DOCKER   — "1"이면 Neon Docker 건너뜀
# ============================================================
set -euo pipefail

# ── 색상 ─────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
step() { echo -e "\n${YELLOW}──${NC} $1"; }

# ── 설정 ─────────────────────────────────────────────────────
COS_PORT="${COS_PORT:-3100}"
COS_HOST="${COS_HOST:-0.0.0.0}"
COS_TAILSCALE_HOST="${COS_TAILSCALE_HOST:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PAPERCLIP_HOME="${HOME}/.paperclip"
INSTANCE_DIR="${PAPERCLIP_HOME}/instances/default"
CONFIG_FILE="${INSTANCE_DIR}/config.json"

echo "=== COS v2 초기 세팅 ==="
echo "    프로젝트: ${PROJECT_DIR}"
echo "    포트:     ${COS_PORT}"
echo ""

# ── 1. Homebrew ──────────────────────────────────────────────
step "1/9 Homebrew"
if command -v brew &>/dev/null; then
  ok "Homebrew 설치됨"
else
  echo "→ Homebrew 설치 중..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  ok "Homebrew 설치 완료"
fi

# PATH에 homebrew 추가 (현재 세션)
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# ── 2. Node.js 24 ───────────────────────────────────────────
step "2/9 Node.js 24 (node-pty ABI 호환성: <25 필수)"
if command -v node &>/dev/null && node --version | grep -q "^v24"; then
  ok "Node.js $(node --version) 설치됨"
else
  echo "→ Node.js 24 설치 중..."
  brew install node@24
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
  ok "Node.js $(node --version) 설치 완료"
fi

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm --version) 설치됨"
else
  echo "→ pnpm 설치 중..."
  brew install pnpm
  ok "pnpm 설치 완료"
fi

# ── 3. 셸 PATH 영구 설정 ────────────────────────────────────
step "3/9 셸 PATH (zshenv — SSH non-interactive에서도 동작)"

ZSHENV_FILE="${HOME}/.zshenv"
ZSHENV_MARKER="# cos-v2-path"

if [ -f "$ZSHENV_FILE" ] && grep -q "$ZSHENV_MARKER" "$ZSHENV_FILE" 2>/dev/null; then
  ok ".zshenv PATH 이미 설정됨"
else
  cat >> "$ZSHENV_FILE" <<'ZSHENV'

# cos-v2-path — COS v2 setup.sh가 추가. 삭제하지 마세요.
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
ZSHENV
  ok ".zshenv PATH 추가 완료 (SSH에서도 node/pnpm/pm2 바로 사용 가능)"
fi

# ── 4. Docker 확인 ──────────────────────────────────────────
step "4/9 Docker"
if [ "${COS_SKIP_DOCKER:-}" = "1" ]; then
  warn "Docker 건너뜀 (COS_SKIP_DOCKER=1)"
else
  if ! command -v docker &>/dev/null; then
    warn "Docker 미설치 — Docker Desktop을 수동 설치하세요: https://www.docker.com/products/docker-desktop/"
    warn "설치 후 이 스크립트를 다시 실행하세요."
  elif ! docker info &>/dev/null 2>&1; then
    warn "Docker Desktop이 실행 중이 아닙니다. 시작 후 다시 실행하세요."
  else
    ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
  fi
fi

# ── 5. 프로젝트 의존성 ──────────────────────────────────────
step "5/9 프로젝트 의존성 (pnpm install + 빌드)"
cd "$PROJECT_DIR"

if [ -d "node_modules" ] && [ -f "pnpm-lock.yaml" ]; then
  ok "node_modules 존재 — pnpm install 건너뜀 (강제: pnpm install 직접 실행)"
else
  echo "→ pnpm install..."
  pnpm install
  ok "의존성 설치 완료"
fi

# 필수 워크스페이스 빌드
echo "→ 워크스페이스 빌드..."
pnpm --filter @paperclipai/shared build 2>/dev/null || true
pnpm --filter @paperclipai/db build 2>/dev/null || true
pnpm --filter @paperclipai/plugin-sdk build 2>/dev/null || true
ok "워크스페이스 빌드 완료"

# ── 6. Paperclip config.json ────────────────────────────────
step "6/9 Paperclip config.json"
mkdir -p "$INSTANCE_DIR"

if [ -f "$CONFIG_FILE" ]; then
  ok "config.json 이미 존재: ${CONFIG_FILE}"
  echo "    $(cat "$CONFIG_FILE" | python3 -c 'import sys,json; c=json.load(sys.stdin); print(f"DB: {c.get(\"database\",{}).get(\"mode\",\"?\")} | Port: {c.get(\"server\",{}).get(\"port\",\"?\")}")' 2>/dev/null || true)"
else
  # allowedHostnames 구성
  HOSTNAMES='["localhost"]'
  if [ -n "$COS_TAILSCALE_HOST" ]; then
    # Tailscale IP도 자동 추가
    TS_IP=$(dig +short "$COS_TAILSCALE_HOST" 2>/dev/null || true)
    HOSTNAMES="[\"localhost\", \"${COS_TAILSCALE_HOST}\""
    [ -n "$TS_IP" ] && HOSTNAMES="${HOSTNAMES}, \"${TS_IP}\""
    HOSTNAMES="${HOSTNAMES}]"
  fi

  # DB 설정
  if [ -n "${COS_DB_URL:-}" ]; then
    DB_SECTION=$(cat <<DBJSON
    "mode": "postgres",
    "connectionString": "${COS_DB_URL}"
DBJSON
)
  else
    DB_SECTION=$(cat <<'DBJSON'
    "mode": "embedded-postgres",
    "embeddedPostgresPort": 54329
DBJSON
)
  fi

  cat > "$CONFIG_FILE" <<CONFIGJSON
{
  "\$meta": { "version": 1, "source": "cos-v2-setup.sh" },
  "database": {
${DB_SECTION}
  },
  "server": {
    "deploymentMode": "local_trusted",
    "exposure": "private",
    "host": "${COS_HOST}",
    "port": ${COS_PORT},
    "serveUi": true,
    "allowedHostnames": ${HOSTNAMES}
  },
  "auth": { "baseUrlMode": "auto" },
  "storage": {
    "provider": "local_disk",
    "localDisk": { "baseDir": "${INSTANCE_DIR}/data/storage" }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": { "keyFilePath": "${INSTANCE_DIR}/secrets/master.key" }
  }
}
CONFIGJSON

  mkdir -p "${INSTANCE_DIR}/data/storage" "${INSTANCE_DIR}/secrets" "${INSTANCE_DIR}/data/backups"
  ok "config.json 생성 완료"
fi

# ── 7. .env ─────────────────────────────────────────────────
step "7/9 .env"
ENV_FILE="${PROJECT_DIR}/.env"

if [ -f "$ENV_FILE" ]; then
  ok ".env 이미 존재"
else
  echo "PORT=${COS_PORT}" > "$ENV_FILE"
  [ -n "${COS_DB_URL:-}" ] && echo "DATABASE_URL=${COS_DB_URL}" >> "$ENV_FILE"
  ok ".env 생성 완료"
fi

# ── 8. PM2 + ecosystem.config.cjs ───────────────────────────
step "8/9 PM2 ecosystem"

# PM2 설치 확인
if command -v pm2 &>/dev/null; then
  ok "PM2 $(pm2 --version) 설치됨"
else
  echo "→ PM2 설치 중..."
  pnpm add -g pm2
  ok "PM2 설치 완료"
fi

ECOSYSTEM_FILE="${PROJECT_DIR}/ecosystem.config.cjs"
if [ ! -f "$ECOSYSTEM_FILE" ]; then
  cat > "$ECOSYSTEM_FILE" <<'ECOSYSTEM'
// COS v2 PM2 ecosystem — 포맷 후 `pm2 start ecosystem.config.cjs`로 복구
module.exports = {
  apps: [
    {
      name: "cos-v2-server",
      script: "/bin/bash",
      args: "-c 'pnpm dev:server'",
      cwd: __dirname,
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      restart_delay: 2000,
      max_restarts: 10,
      env: {
        PATH: `/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH}`,
      },
    },
  ],
};
ECOSYSTEM
  ok "ecosystem.config.cjs 생성 완료"
else
  ok "ecosystem.config.cjs 이미 존재"
fi

# ── 9. macOS 방화벽 ─────────────────────────────────────────
step "9/9 macOS 방화벽 (Node.js 수신 연결 허용)"

NODE_PATH="$(which node 2>/dev/null || echo "/opt/homebrew/opt/node@24/bin/node")"
if sudo -n true 2>/dev/null; then
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_PATH" 2>/dev/null || true
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$NODE_PATH" 2>/dev/null || true
  ok "방화벽에 Node.js 허용 추가"
else
  warn "sudo 권한 없음 — 수동으로 실행하세요:"
  echo "    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add ${NODE_PATH}"
  echo "    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ${NODE_PATH}"
fi

# ── 완료 ─────────────────────────────────────────────────────
echo ""
echo "=== COS v2 세팅 완료 ==="
echo ""
echo "  서버 시작:"
echo "    pm2 start ecosystem.config.cjs     # PM2 데몬 (권장)"
echo "    pnpm dev                           # 직접 실행"
echo ""
echo "  서버 확인:"
echo "    curl http://localhost:${COS_PORT}/api/health"
echo ""
echo "  리더 에이전트 (서버 시작 후 자동 기동):"
echo "    pm2 list"
echo ""
if [ -n "$COS_TAILSCALE_HOST" ]; then
  echo "  외부 접속:"
  echo "    http://${COS_TAILSCALE_HOST}:${COS_PORT}"
  echo ""
fi
echo "  포맷 후 복구:"
echo "    git clone <repo-url> ~/Projects/company-os-v2"
echo "    cd ~/Projects/company-os-v2"
echo "    ./scripts/setup.sh"
echo "    pm2 start ecosystem.config.cjs"
echo ""
