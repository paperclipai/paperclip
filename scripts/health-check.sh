#!/usr/bin/env bash
# Health check for Paperclip server + embedded PostgreSQL
# Usage: ./scripts/health-check.sh [--fix]
set -euo pipefail

PORT="${PAPERCLIP_PORT:-3100}"
PG_PORT="${PAPERCLIP_EMBEDDED_PG_PORT:-5432}"
FIX="${1:-}"

pass() { echo "[OK]  $1"; }
fail() { echo "[FAIL] $1"; FAILED=1; }
FAILED=0

# 1. PM2 process running?
if pm2 list 2>/dev/null | grep -q "paperclip.*online"; then
  pass "PM2 process 'paperclip' is online"
else
  fail "PM2 process 'paperclip' is NOT online"
  if [[ "$FIX" == "--fix" ]]; then
    echo "  => Restarting via PM2..."
    pm2 restart paperclip
  fi
fi

# 2. HTTP /health endpoint returns 200
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:${PORT}/health" 2>/dev/null || echo "000")
if [[ "$HTTP_STATUS" == "200" ]]; then
  pass "HTTP localhost:${PORT}/health → 200 OK"
else
  fail "HTTP localhost:${PORT}/health → ${HTTP_STATUS} (expected 200)"
fi

# 3. PostgreSQL port accepting connections?
if command -v pg_isready &>/dev/null; then
  if pg_isready -h 127.0.0.1 -p "$PG_PORT" -q 2>/dev/null; then
    pass "PostgreSQL port ${PG_PORT} is accepting connections"
  else
    fail "PostgreSQL port ${PG_PORT} is NOT accepting connections"
  fi
else
  # Fallback: TCP check via /dev/tcp
  if (echo >/dev/tcp/127.0.0.1/"$PG_PORT") 2>/dev/null; then
    pass "PostgreSQL port ${PG_PORT} is open (TCP check)"
  else
    fail "PostgreSQL port ${PG_PORT} is NOT open"
  fi
fi

# 4. postmaster.pid stale check
PG_DATA_DIR="${PAPERCLIP_EMBEDDED_PG_DATA_DIR:-$HOME/.paperclip/pg-data}"
PID_FILE="$PG_DATA_DIR/postmaster.pid"
if [[ -f "$PID_FILE" ]]; then
  PG_PID=$(head -1 "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$PG_PID" ]] && kill -0 "$PG_PID" 2>/dev/null; then
    pass "postmaster.pid exists and process pid=${PG_PID} is alive"
  else
    fail "postmaster.pid exists but process pid=${PG_PID} is DEAD (stale lock file)"
    if [[ "$FIX" == "--fix" ]]; then
      echo "  => Removing stale postmaster.pid..."
      rm -f "$PID_FILE"
      echo "  => Restarting PM2 paperclip..."
      pm2 restart paperclip
    fi
  fi
else
  echo "[INFO] postmaster.pid not found (normal if PostgreSQL managed externally)"
fi

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo "All health checks passed."
  exit 0
else
  echo "One or more health checks FAILED."
  echo "Run with --fix to attempt automatic recovery: $0 --fix"
  exit 1
fi
