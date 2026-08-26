#!/usr/bin/env bash
# Verify fork patches + build artifacts after a sync-upstream.sh run.
# Usage: ./verify-patches.sh
set -uo pipefail
cd "$(dirname "$0")"

FAIL=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1"; FAIL=1; }

echo "=== Patch 1: no raw delta onLog (PR #9909) ==="
# The buggy duplicate line must be absent from BOTH source and built adapter.
if grep -q 'onLog("stdout", sanitizedDelta)' packages/adapters/hermes/src/gateway/server/execute.ts; then
  bad "raw delta onLog present in SOURCE (patch lost)"
else
  ok "source clean"
fi
if [ -f packages/adapters/hermes/dist/gateway/server/execute.js ]; then
  if grep -q 'onLog("stdout", sanitizedDelta)' packages/adapters/hermes/dist/gateway/server/execute.js; then
    bad "raw delta onLog present in BUILT adapter (patch lost)"
  else
    ok "built adapter clean"
  fi
else
  bad "built adapter execute.js not found — build incomplete?"
fi

echo "=== Patch 2: board auth-token pass-through as PAPERCLIP_API_KEY (f69b69cf7) ==="
if grep -q "supportsLocalAgentJwt: true" packages/adapters/hermes/src/gateway/index.ts; then
  ok "supportsLocalAgentJwt present in gateway/index.ts source"
else
  bad "supportsLocalAgentJwt missing in gateway/index.ts source"
fi
if grep -q "PAPERCLIP_API_KEY" packages/adapters/hermes/src/gateway/server/execute.ts; then
  ok "PAPERCLIP_API_KEY env injection present in execute.ts source"
else
  bad "PAPERCLIP_API_KEY env injection missing in execute.ts source"
fi
BUILT_EXEC=packages/adapters/hermes/dist/gateway/server/execute.js
BUILT_IDX=packages/adapters/hermes/dist/gateway/index.js
if grep -q "PAPERCLIP_API_KEY" "$BUILT_EXEC" 2>/dev/null && grep -q "supportsLocalAgentJwt" "$BUILT_IDX" 2>/dev/null; then
  ok "both markers present in built adapter"
else
  bad "markers missing in built adapter"
fi

echo "=== Service ==="
HEALTH=$(curl -s -m 8 http://127.0.0.1:3100/api/health || true)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "health: ok"
else
  bad "health endpoint not ok: ${HEALTH:-<no response>}"
fi

AGENTS=$(docker exec paperclip-postgres psql -U paperclip -d paperclip -t -A -c \
  "SELECT count(*) FROM agents;" 2>/dev/null || echo "?")
echo "ℹ️  agents in DB: $AGENTS"

echo "=== DB migrations ==="
docker exec paperclip-postgres psql -U paperclip -d paperclip -t -A -c \
  "SELECT count(*)||' migrations applied (max id '||max(id)||')' FROM __drizzle_migrations;" 2>/dev/null \
  || echo "ℹ️  __drizzle_migrations table not queryable"

exit $FAIL
