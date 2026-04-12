#!/usr/bin/env bash
# ============================================================
# COS v2 — Neon 셀프호스팅 (Docker Compose) 세팅 스크립트
# Mac Studio에서 실행: ./scripts/setup-local-postgres.sh
#
# 수행 내용:
#   1. Neon docker-compose 구성 확인/클론
#   2. Neon 서비스 시작 (minio, pageserver, safekeeper, compute)
#   3. Neon Cloud에서 데이터 마이그레이션 (선택)
#   4. config.json/env의 connectionString을 로컬로 업데이트
# ============================================================
set -euo pipefail

# ── 설정 ──────────────────────────────────────────────────────
NEON_DIR="${HOME}/neon-local"
NEON_COMPUTE_PORT="55433"
PG_USER="cloud_admin"
PG_DB="postgres"
LOCAL_DB_URL="postgresql://${PG_USER}@localhost:${NEON_COMPUTE_PORT}/${PG_DB}"

# Neon Cloud 원본 (마이그레이션 소스) — 환경변수로 전달
NEON_CLOUD_URL="${NEON_CLOUD_URL:-}"

# Paperclip 인스턴스 경로
PAPERCLIP_HOME="${HOME}/.paperclip"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== COS v2 Neon 셀프호스팅 세팅 ==="

# ── 1. Docker 확인 ───────────────────────────────────────────
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v docker &>/dev/null; then
  echo "❌ Docker가 설치되어 있지 않습니다."
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "❌ Docker 데몬이 실행되고 있지 않습니다. Docker Desktop을 시작하세요."
  exit 1
fi

echo "✓ Docker 확인 완료"

# ── 2. Neon docker-compose 확인/클론 ─────────────────────────
if [ ! -f "${NEON_DIR}/docker-compose.yml" ]; then
  echo "→ Neon docker-compose 클론 중..."
  mkdir -p "${NEON_DIR}"
  git clone --depth 1 --filter=blob:none --sparse \
    https://github.com/neondatabase/neon.git "${NEON_DIR}/temp"
  cd "${NEON_DIR}/temp"
  git sparse-checkout set docker-compose
  cp -r docker-compose/* "${NEON_DIR}/"
  rm -rf "${NEON_DIR}/temp"
  echo "✓ Neon docker-compose 클론 완료"
else
  echo "✓ Neon docker-compose 이미 존재: ${NEON_DIR}"
fi

# ── 3. Neon 서비스 시작 ──────────────────────────────────────
cd "${NEON_DIR}"

echo "→ Neon 서비스 시작 중..."
docker compose up -d

echo "→ compute 노드 준비 대기..."
RETRIES=0
MAX_RETRIES=60
until docker compose exec -T compute1 pg_isready -h localhost -p 55433 -U "${PG_USER}" &>/dev/null; do
  RETRIES=$((RETRIES + 1))
  if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
    echo "❌ compute 노드가 ${MAX_RETRIES}초 내에 준비되지 않았습니다."
    echo "   docker compose logs compute1 으로 로그를 확인하세요."
    exit 1
  fi
  sleep 1
done

echo "✓ Neon 서비스 실행 중 (compute: localhost:${NEON_COMPUTE_PORT})"

# ── 4. COS용 DB 생성 ────────────────────────────────────────
echo "→ COS 데이터베이스 확인/생성..."
DB_EXISTS=$(docker compose exec -T compute1 psql -h localhost -p 55433 -U "${PG_USER}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='cos'" 2>/dev/null || true)
if [ "$DB_EXISTS" != "1" ]; then
  docker compose exec -T compute1 psql -h localhost -p 55433 -U "${PG_USER}" -d postgres -c "CREATE DATABASE cos"
  echo "✓ 'cos' 데이터베이스 생성됨"
else
  echo "✓ 'cos' 데이터베이스 이미 존재"
fi

LOCAL_DB_URL="postgresql://${PG_USER}@localhost:${NEON_COMPUTE_PORT}/cos"

# ── 5. 데이터 마이그레이션 (Neon Cloud → 로컬) ────────────────
echo ""
read -p "Neon Cloud에서 데이터를 마이그레이션할까요? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "→ Neon Cloud에서 덤프 중..."
  DUMP_FILE="/tmp/cos-neon-dump.sql"

  if command -v pg_dump &>/dev/null; then
    pg_dump "${NEON_CLOUD_URL}" --no-owner --no-acl --clean --if-exists > "${DUMP_FILE}" 2>/dev/null
  else
    docker run --rm -e PGPASSWORD=npg_YmibwR86QGpg postgres:16 \
      pg_dump "postgresql://neondb_owner:npg_YmibwR86QGpg@ep-winter-sky-a15sf4oy.ap-southeast-1.aws.neon.tech/neondb?sslmode=require" \
      --no-owner --no-acl --clean --if-exists > "${DUMP_FILE}" 2>/dev/null
  fi

  DUMP_SIZE=$(du -h "${DUMP_FILE}" | cut -f1)
  echo "✓ 덤프 완료 (${DUMP_SIZE})"

  echo "→ 로컬 Neon에 복원 중..."
  docker compose exec -T compute1 psql -h localhost -p 55433 -U "${PG_USER}" -d cos \
    < "${DUMP_FILE}" 2>/dev/null

  rm -f "${DUMP_FILE}"
  echo "✓ 데이터 마이그레이션 완료"
else
  echo "→ 마이그레이션 건너뜀 (서버 시작 시 자동 마이그레이션 실행)"
fi

# ── 6. config.json 업데이트 ──────────────────────────────────
echo ""
echo "→ Paperclip config.json 업데이트 중..."

UPDATED=0
for config_file in "${PAPERCLIP_HOME}"/instances/*/config.json; do
  [ -f "$config_file" ] || continue
  if command -v jq &>/dev/null; then
    tmp=$(mktemp)
    jq ".database.connectionString = \"${LOCAL_DB_URL}\"" "$config_file" > "$tmp" && mv "$tmp" "$config_file"
  else
    sed -i '' "s|\"connectionString\":.*|\"connectionString\": \"${LOCAL_DB_URL}\"|" "$config_file"
  fi
  echo "  ✓ $(basename "$(dirname "$config_file")")/config.json 업데이트됨"
  UPDATED=$((UPDATED + 1))
done

if [ "$UPDATED" -eq 0 ]; then
  echo "  ⚠ config.json을 찾지 못했습니다. 수동 설정 필요: ${LOCAL_DB_URL}"
fi

# ── 7. .env 업데이트 ─────────────────────────────────────────
ENV_FILE="${PROJECT_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -q "^DATABASE_URL=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=${LOCAL_DB_URL}|" "$ENV_FILE"
  else
    echo "DATABASE_URL=${LOCAL_DB_URL}" >> "$ENV_FILE"
  fi
  echo "  ✓ .env 업데이트됨"
fi

# ── 완료 ─────────────────────────────────────────────────────
echo ""
echo "=== Neon 셀프호스팅 세팅 완료 ==="
echo ""
echo "  DB URL:     ${LOCAL_DB_URL}"
echo "  Neon Dir:   ${NEON_DIR}"
echo "  상태 확인:   cd ${NEON_DIR} && docker compose ps"
echo "  로그:       cd ${NEON_DIR} && docker compose logs -f compute1"
echo "  psql 접속:  psql ${LOCAL_DB_URL}"
echo ""
echo "  시작:       cd ${NEON_DIR} && docker compose up -d"
echo "  중지:       cd ${NEON_DIR} && docker compose down"
echo ""
echo "서버를 재시작하면 로컬 Neon을 사용합니다."
