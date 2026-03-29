#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================="
echo "  Paperclip v2 배포 시작"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# 1. 소스 업데이트
echo "[1/5] Git pull..."
git pull origin master

# 2. 의존성 설치
echo "[2/5] pnpm install..."
pnpm install --frozen-lockfile

# 3. UI 빌드 (Vite)
echo "[3/5] UI 빌드 (Vite)..."
pnpm --filter @paperclipai/ui build

# 4. 서버 빌드 (TypeScript)
echo "[4/5] 서버 빌드 (tsc)..."
pnpm --filter @paperclipai/server build

# 5. PM2 reload (zero-downtime)
echo "[5/5] PM2 reload..."
pm2 reload ecosystem.config.cjs

echo "========================================="
echo "  배포 완료!"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# 헬스체크
sleep 3
if curl -sf http://127.0.0.1:3050/api/health > /dev/null 2>&1; then
    echo "  헬스체크: OK"
else
    echo "  헬스체크 실패 - 로그 확인 필요"
    pm2 logs paperclip-v2 --lines 20 --nostream
    exit 1
fi
