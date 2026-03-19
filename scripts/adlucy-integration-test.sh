#!/bin/bash
set -uo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Ad-Lucy Integration Tests
# Requires: Paperclip running on :3100, jq, plugin built
# ═══════════════════════════════════════════════════════════════════════════════

API="http://localhost:3100/api"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
TEST_LAB=""
COMPANY_ID=""
OLD_COMPANY_ID=""
STATE_FILE="$SCRIPT_DIR/.adlucy-state.json"

# ── Helpers ──

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 — $2"; }

assert_eq() {
  [ "$1" = "$2" ] && pass "$3" || fail "$3" "expected '$2', got '$1'"
}

assert_neq() {
  [ "$1" != "$2" ] && pass "$3" || fail "$3" "expected != '$2', got '$1'"
}

assert_gte() {
  [ "$1" -ge "$2" ] 2>/dev/null && pass "$3" || fail "$3" "expected >= $2, got '$1'"
}

assert_contains() {
  echo "$1" | grep -q "$2" && pass "$3" || fail "$3" "expected to contain '$2'"
}

cleanup() {
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Cleanup"
  echo "═══════════════════════════════════════════════════"
  rm -f "$STATE_FILE"
  echo "  Removed state file"
  if [ -n "$TEST_LAB" ] && [ -d "$TEST_LAB" ]; then
    rm -rf "$TEST_LAB"
    echo "  Removed temp lab: $TEST_LAB"
  fi
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  Results: $PASS passed, $FAIL failed"
  echo "═══════════════════════════════════════════════════"
  [ "$FAIL" -gt 0 ] && exit 1 || exit 0
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 0: Pre-flight
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 0: Pre-flight"
echo "═══════════════════════════════════════════════════"

# 0.1 Paperclip health
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
  pass "0.1 Paperclip health → 200"
else
  fail "0.1 Paperclip health" "got $HTTP_CODE (is Paperclip running on :3100?)"
  echo ""
  echo "FATAL: Paperclip must be running. Start with: pnpm dev"
  exit 1
fi

# 0.2 Create temp lab with fake repos
TEST_LAB=$(mktemp -d "${TMPDIR:-/tmp}/adlucy-integ-XXXXXX")
for repo in repo-alpha repo-beta repo-gamma; do
  mkdir -p "$TEST_LAB/$repo"
  cat > "$TEST_LAB/$repo/CLAUDE.md" << REPOEOF
# $repo
This is the $repo service.
It handles important business logic.
Tech stack: TypeScript, Node.js, Express
REPOEOF
done
export ADLUCY_LAB_PATH="$TEST_LAB"
pass "0.2 Created temp lab with 3 repos at $TEST_LAB"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: Clean slate
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 1: Clean slate"
echo "═══════════════════════════════════════════════════"

bash "$SCRIPT_DIR/adlucy-setup.sh" --clean > /dev/null 2>&1
if [ ! -f "$STATE_FILE" ]; then
  pass "1.1 --clean removes state file"
else
  fail "1.1 --clean removes state file" "state file still exists"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Default mode provisioning
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 2: Default mode provisioning"
echo "═══════════════════════════════════════════════════"

SETUP_OUTPUT=$(bash "$SCRIPT_DIR/adlucy-setup.sh" 2>&1)
SETUP_EXIT=$?

# 2.1 Exits 0
assert_eq "$SETUP_EXIT" "0" "2.1 setup exits 0"

# 2.2 State file exists
if [ -f "$STATE_FILE" ]; then
  pass "2.2 state file exists"
else
  fail "2.2 state file exists" "not found"
fi

# 2.3–2.7 State contents
STATE=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')
COMPANY_ID=$(echo "$STATE" | jq -r '.companyId // empty')
MISSION_ID=$(echo "$STATE" | jq -r '.missionId // empty')
PROJECT_COUNT=$(echo "$STATE" | jq -r '.projects | length // 0')
AGENT_COUNT_STATE=$(echo "$STATE" | jq -r '.agents | length // 0')
ISSUES_CREATED=$(echo "$STATE" | jq -r '.issuesCreated // empty')

[ -n "$COMPANY_ID" ] && pass "2.3 state has companyId: $COMPANY_ID" || fail "2.3 state has companyId" "empty"
[ -n "$MISSION_ID" ] && pass "2.4 state has missionId: $MISSION_ID" || fail "2.4 state has missionId" "empty"
assert_eq "$PROJECT_COUNT" "3" "2.5 state has 3 projects"
assert_eq "$AGENT_COUNT_STATE" "3" "2.6 state has 3 agents"
assert_eq "$ISSUES_CREATED" "true" "2.7 state has issuesCreated=true"

# 2.8 Company exists via API
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/companies/$COMPANY_ID" 2>/dev/null)
assert_eq "$HTTP_CODE" "200" "2.8 GET /api/companies/\$COMPANY_ID → 200"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: Entity verification via API
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 3: Entity verification via API"
echo "═══════════════════════════════════════════════════"

# 3.1 Agents count
AGENTS_JSON=$(curl -sf "$API/companies/$COMPANY_ID/agents" 2>/dev/null || echo '[]')
AGENT_API_COUNT=$(echo "$AGENTS_JSON" | jq 'length')
assert_gte "$AGENT_API_COUNT" "3" "3.1 GET .../agents → length >= 3"

# 3.2 Issues count
ISSUES_JSON=$(curl -sf "$API/companies/$COMPANY_ID/issues" 2>/dev/null || echo '[]')
ISSUE_API_COUNT=$(echo "$ISSUES_JSON" | jq 'length')
assert_gte "$ISSUE_API_COUNT" "4" "3.2 GET .../issues → length >= 4"

# 3.3 Goal exists (check via list since single-get may not exist)
GOAL_FOUND=$(curl -sf "$API/companies/$COMPANY_ID/goals" 2>/dev/null | jq -r --arg id "$MISSION_ID" '[.[] | select(.id == $id)] | length' 2>/dev/null || echo "0")
assert_gte "$GOAL_FOUND" "1" "3.3 Goal exists in goals list"

# 3.4–3.6 Agents named Lucy, Rex, Shield
for agent_name in Lucy Rex Shield; do
  FOUND=$(echo "$AGENTS_JSON" | jq -r --arg n "$agent_name" '[.[] | select(.name == $n)] | length')
  [ "$FOUND" -ge 1 ] && pass "3.$(echo $agent_name | head -c1) Agent $agent_name found" \
    || fail "3.$(echo $agent_name | head -c1) Agent $agent_name found" "not found"
done

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4: Idempotency
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 4: Idempotency"
echo "═══════════════════════════════════════════════════"

# Save agent IDs before re-run
AGENTS_BEFORE=$(echo "$STATE" | jq -cS '.agents')

# 4.1 Re-run exits 0
bash "$SCRIPT_DIR/adlucy-setup.sh" > /dev/null 2>&1
RERUN_EXIT=$?
assert_eq "$RERUN_EXIT" "0" "4.1 re-run exits 0"

STATE2=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')
COMPANY_ID2=$(echo "$STATE2" | jq -r '.companyId // empty')

# 4.2 companyId unchanged
assert_eq "$COMPANY_ID2" "$COMPANY_ID" "4.2 companyId unchanged"

# 4.3 Agent IDs unchanged
AGENTS_AFTER=$(echo "$STATE2" | jq -cS '.agents')
assert_eq "$AGENTS_AFTER" "$AGENTS_BEFORE" "4.3 agent IDs unchanged"

# 4.4 No duplicate agents/issues
AGENTS_JSON2=$(curl -sf "$API/companies/$COMPANY_ID/agents" 2>/dev/null || echo '[]')
AGENT_COUNT2=$(echo "$AGENTS_JSON2" | jq 'length')
assert_eq "$AGENT_COUNT2" "$AGENT_API_COUNT" "4.4 agent count unchanged (no duplicates)"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 5: Clean + skip-permissions
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 5: Clean + skip-permissions"
echo "═══════════════════════════════════════════════════"

OLD_COMPANY_ID="$COMPANY_ID"

# 5.1 --clean
bash "$SCRIPT_DIR/adlucy-setup.sh" --clean > /dev/null 2>&1
if [ ! -f "$STATE_FILE" ]; then
  pass "5.1 --clean → state file gone"
else
  fail "5.1 --clean → state file gone" "still exists"
fi

# 5.2 --skip-permissions exits 0
SKIP_OUTPUT=$(bash "$SCRIPT_DIR/adlucy-setup.sh" --skip-permissions 2>&1)
SKIP_EXIT=$?
assert_eq "$SKIP_EXIT" "0" "5.2 --skip-permissions exits 0"

STATE3=$(cat "$STATE_FILE" 2>/dev/null || echo '{}')
NEW_COMPANY_ID=$(echo "$STATE3" | jq -r '.companyId // empty')

# 5.3 New companyId (different from phase 2)
assert_neq "$NEW_COMPANY_ID" "$OLD_COMPANY_ID" "5.3 new companyId differs from phase 2"

# 5.4 Lucy agent has dangerouslySkipPermissions (look up via list since single-get may 404)
LUCY_ID=$(echo "$STATE3" | jq -r '.agents.LUCY // empty')
if [ -n "$LUCY_ID" ]; then
  LUCY_JSON=$(curl -sf "$API/companies/$NEW_COMPANY_ID/agents" 2>/dev/null | jq --arg id "$LUCY_ID" '.[] | select(.id == $id)' 2>/dev/null || echo '{}')
  SKIP_PERMS=$(echo "$LUCY_JSON" | jq -r '.adapterConfig.dangerouslySkipPermissions // empty')
  assert_eq "$SKIP_PERMS" "true" "5.4 Lucy has dangerouslySkipPermissions: true"
else
  fail "5.4 Lucy has dangerouslySkipPermissions" "Lucy agent ID not found in state"
fi

# 5.5 Output contains "Wakeup sent"
assert_contains "$SKIP_OUTPUT" "Wakeup sent" "5.5 stdout contains 'Wakeup sent'"

# Update COMPANY_ID for plugin tests
COMPANY_ID="$NEW_COMPANY_ID"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 6: Plugin API
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Phase 6: Plugin API"
echo "═══════════════════════════════════════════════════"

# 6.1 Plugin listed (check pluginKey, not id which is a UUID)
PLUGINS_JSON=$(curl -sf "$API/plugins" 2>/dev/null || echo '[]')
PLUGIN_FOUND=$(echo "$PLUGINS_JSON" | jq '[.[] | select(.pluginKey // .packageName | contains("adlucy-kb"))] | length')
assert_gte "$PLUGIN_FOUND" "1" "6.1 GET /api/plugins contains adlucy-kb"

# 6.2 Plugin health
PLUGIN_HEALTH=$(curl -sf "$API/plugins/paperclipai.adlucy-kb/health" 2>/dev/null || echo '{"status":"unreachable"}')
PLUGIN_STATUS=$(echo "$PLUGIN_HEALTH" | jq -r '.status // "unreachable"')
if [ "$PLUGIN_STATUS" = "ok" ] || [ "$PLUGIN_STATUS" = "degraded" ] || [ "$PLUGIN_STATUS" = "ready" ]; then
  pass "6.2 Plugin health status: $PLUGIN_STATUS (not error/unreachable)"
else
  # Retry once after a short wait — plugin may still be initializing
  sleep 3
  PLUGIN_HEALTH=$(curl -sf "$API/plugins/paperclipai.adlucy-kb/health" 2>/dev/null || echo '{"status":"unreachable"}')
  PLUGIN_STATUS=$(echo "$PLUGIN_HEALTH" | jq -r '.status // "unreachable"')
  if [ "$PLUGIN_STATUS" = "ok" ] || [ "$PLUGIN_STATUS" = "degraded" ] || [ "$PLUGIN_STATUS" = "ready" ]; then
    pass "6.2 Plugin health status: $PLUGIN_STATUS (not error/unreachable) [retry]"
  else
    fail "6.2 Plugin health status" "got '$PLUGIN_STATUS', expected ok, degraded, or ready"
  fi
fi

# 6.3 Config validation — valid path
VALID_RESULT=$(curl -sf -X POST "$API/plugins/paperclipai.adlucy-kb/config/test" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg p "$TEST_LAB" '{configJson: {labPath: $p}}')" 2>/dev/null || echo '{}')
VALID=$(echo "$VALID_RESULT" | jq -r '.valid // false')
assert_eq "$VALID" "true" "6.3 config/test with valid path → valid: true"

# 6.4 Config validation — invalid path
INVALID_RESULT=$(curl -sf -X POST "$API/plugins/paperclipai.adlucy-kb/config/test" \
  -H "Content-Type: application/json" \
  -d '{"configJson":{"labPath":"/no/such/dir"}}' 2>/dev/null || echo '{}')
INVALID=$(echo "$INVALID_RESULT" | jq -r 'if .valid == false then "false" else "true" end')
assert_eq "$INVALID" "false" "6.4 config/test with invalid path → valid: false"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 7: Exit (cleanup runs via trap)
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════"
echo "  All phases complete"
echo "═══════════════════════════════════════════════════"
