#!/usr/bin/env bash
set -euo pipefail
ROOT=${1:-$(pwd)}
BASE_PORT=${BASE_PORT:-3210}
TMP_ROOT=$(mktemp -d /tmp/paperclip-e2e-smoke-XXXXXX)
export PAPERCLIP_HOME="$TMP_ROOT/home"
export PAPERCLIP_INSTANCE_ID=e2e
INSTANCE_ROOT="$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID"
mkdir -p "$INSTANCE_ROOT" "$TMP_ROOT/runtime/secrets"
cat > "$INSTANCE_ROOT/config.json" <<'CONF'
{
  "$meta": { "version": 1, "updatedAt": "2026-01-01T00:00:00.000Z", "source": "github-pr-sync-smoke" },
  "database": { "mode": "embedded-postgres" },
  "logging": { "mode": "file" },
  "server": { "deploymentMode": "local_trusted", "host": "127.0.0.1", "port": 3210 },
  "auth": { "baseUrlMode": "auto" },
  "storage": { "provider": "local_disk" },
  "secrets": { "provider": "local_encrypted", "strictMode": false }
}
CONF
printf 'PAPERCLIP_AGENT_JWT_SECRET=test-secret\n' > "$INSTANCE_ROOT/.env"
printf 'test-master-key-material' > "$TMP_ROOT/runtime/secrets/master.key"
(
  cd "$ROOT"
  pnpm --filter @paperclipai/server dev > "$TMP_ROOT/server.log" 2>&1
) &
SERVER_PID=$!
cleanup(){ kill $SERVER_PID >/dev/null 2>&1 || true; }
trap cleanup EXIT
for _ in $(seq 1 120); do
  ACTUAL_BASE=$(grep -o 'http://127.0.0.1:[0-9]\+' "$TMP_ROOT/server.log" | head -n1 || true)
  if [[ -n "$ACTUAL_BASE" ]] && curl -sf "$ACTUAL_BASE/api/health" >/dev/null 2>&1; then
    BASE="$ACTUAL_BASE"
    break
  fi
  sleep 1
done
: "${BASE:?server did not become healthy}"
company=$(curl -sf -X POST "$BASE/api/companies" -H 'content-type: application/json' -d '{"name":"E2E Sync Co"}')
company_id=$(python3 - <<'PY' "$company"
import json,sys
print(json.loads(sys.argv[1])["id"])
PY
)
founder=$(curl -sf -X POST "$BASE/api/companies/$company_id/agents" -H 'content-type: application/json' -d '{"name":"Founding Engineer","role":"engineer","adapterType":"process","adapterConfig":{}}')
founder_id=$(python3 - <<'PY' "$founder"
import json,sys
print(json.loads(sys.argv[1])["id"])
PY
)
reviewer=$(curl -sf -X POST "$BASE/api/companies/$company_id/agents" -H 'content-type: application/json' -d '{"name":"Code Reviewer","role":"engineer","adapterType":"process","adapterConfig":{}}')
reviewer_id=$(python3 - <<'PY' "$reviewer"
import json,sys
print(json.loads(sys.argv[1])["id"])
PY
)
issue=$(curl -sf -X POST "$BASE/api/companies/$company_id/issues" -H 'content-type: application/json' -d "{\"title\":\"E2E PR sync\",\"status\":\"todo\",\"assigneeAgentId\":\"$founder_id\"}")
issue_id=$(python3 - <<'PY' "$issue"
import json,sys
print(json.loads(sys.argv[1])["id"])
PY
)
sync=$(curl -sf -X POST "$BASE/api/issues/$issue_id/github-pr-sync" -H 'content-type: application/json' -d '{"repositoryFullName":"acme/supportopia","pullRequestNumber":61,"pullRequestUrl":"https://github.com/acme/supportopia/pull/61","pullRequestTitle":"E2E sync PR","eventKey":"github:pr-61:review-1","eventKind":"review_requested","pullRequestStatus":"ready_for_review","summary":"Review requested from Code Reviewer.","stage":"review_requested","waitingOnRole":"Code Reviewer","nextAction":"Please review the PR.","labels":["needs-review"],"wakeAssignee":true,"wakeAgentRefs":["Code Reviewer"],"syncComment":true}')
work_products=$(curl -sf "$BASE/api/issues/$issue_id/work-products")
comments=$(curl -sf "$BASE/api/issues/$issue_id/comments")
python3 - <<'PY' "$sync" "$work_products" "$comments" "$reviewer_id" "$BASE"
import json,sys
sync=json.loads(sys.argv[1])
products=json.loads(sys.argv[2])
comments=json.loads(sys.argv[3])
reviewer_id=sys.argv[4]
base=sys.argv[5]
assert sync["ok"] is True
assert reviewer_id in sync["wokenAgentIds"], sync
assert any(p["type"]=="pull_request" and p["externalId"]=="61" for p in products), products
assert any("STATE: review_requested" in c["body"] for c in comments), comments
print(json.dumps({"base": base, "sync": sync, "workProductCount": len(products), "commentCount": len(comments)}, indent=2))
PY

cat > "$TMP_ROOT/github-pull-request.json" <<JSON
{
  "action": "ready_for_review",
  "repository": { "full_name": "acme/supportopia" },
  "pull_request": {
    "number": 62,
    "html_url": "https://github.com/acme/supportopia/pull/62",
    "title": "Webhook bridge sync",
    "body": "Paperclip-Issue: $issue_id\\n\\nPlease review this PR.",
    "draft": false,
    "labels": []
  }
}
JSON
PAPERCLIP_API_URL="$BASE/api" node "$ROOT/scripts/github-pr-webhook-bridge.mjs" pull_request "$TMP_ROOT/github-pull-request.json" >/dev/null
bridge_products=$(curl -sf "$BASE/api/issues/$issue_id/work-products")
python3 - <<'PY' "$bridge_products"
import json,sys
products=json.loads(sys.argv[1])
assert any(p["type"]=="pull_request" and p["externalId"]=="62" for p in products), products
print(json.dumps({"bridgeWorkProductCount": len(products)}, indent=2))
PY
