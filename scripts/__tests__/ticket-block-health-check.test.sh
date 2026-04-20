#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_SCRIPT="$PROJECT_ROOT/scripts/ticket-block-health-check.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_CURL="$TMP_DIR/fake-curl.sh"

cat >"$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
write_format=""
method="GET"
data=""
url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    -w)
      write_format="$2"
      shift 2
      ;;
    -X)
      method="$2"
      shift 2
      ;;
    -H|--max-time|--data)
      if [[ "$1" == "--data" ]]; then
        data="$2"
      fi
      shift 2
      ;;
    -s|-S|-sS)
      shift
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$output_file" || -z "$url" ]]; then
  echo "fake curl missing required arguments" >&2
  exit 1
fi

python3 - "$FAKE_CURL_STATE" "$method" "$url" "$data" "$output_file" "$write_format" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

state_path, method, url, data, output_file, write_format = sys.argv[1:]
state = json.loads(Path(state_path).read_text())
parsed = urlparse(url)
path = parsed.path
query = parse_qs(parsed.query)

issues = state["issues"]
comments = state.setdefault("comments", {})
patches = state.setdefault("patches", [])
comment_counter = state.setdefault("commentCounter", 1000)

body: object
status = 200

def blocked_issue_summaries():
    limit = int(query.get("limit", ["500"])[0])
    rows = []
    for issue in issues.values():
        if issue.get("status") != "blocked":
            continue
        rows.append({
            "id": issue["id"],
            "identifier": issue["identifier"],
            "title": issue["title"],
            "status": issue["status"],
            "updatedAt": issue["updatedAt"],
            "assigneeAgentId": issue.get("assigneeAgentId"),
        })
    return rows[:limit]

if method == "GET" and path.endswith("/issues"):
    body = blocked_issue_summaries()
elif method == "GET" and "/comments" in path:
    issue_id = path.split("/api/issues/", 1)[1].split("/comments", 1)[0]
    limit = int(query.get("limit", ["5"])[0])
    issue_comments = comments.get(issue_id, [])
    body = list(reversed(issue_comments))[:limit]
elif method == "GET" and "/api/issues/" in path:
    issue_id = path.rsplit("/", 1)[-1]
    issue = issues[issue_id]
    body = issue
elif method == "PATCH" and "/api/issues/" in path:
    issue_id = path.rsplit("/", 1)[-1]
    patch = json.loads(data or "{}")
    issue = issues[issue_id]
    if "status" in patch:
      issue["status"] = patch["status"]
    if "blockedByIssueIds" in patch:
      next_ids = patch["blockedByIssueIds"]
      issue["blockedBy"] = [issues[blocker_id] for blocker_id in next_ids]
    if "comment" in patch:
      comment_counter += 1
      comments.setdefault(issue_id, []).append({
          "id": f"comment-{comment_counter}",
          "body": patch["comment"],
      })
    patches.append({
        "issueId": issue_id,
        "payload": patch,
    })
    state["commentCounter"] = comment_counter
    body = issue
else:
    status = 404
    body = {"error": f"Unhandled fake curl route: {method} {path}"}

Path(output_file).write_text(json.dumps(body))
Path(state_path).write_text(json.dumps(state))

if write_format == "%{http_code}":
    sys.stdout.write(str(status))
PY
EOF
chmod +x "$FAKE_CURL"

run_script() {
  local state_path="$1"
  shift
  (
    cd "$PROJECT_ROOT"
    CURL_BIN="$FAKE_CURL" \
    FAKE_CURL_STATE="$state_path" \
    PAPERCLIP_API_URL="http://example.test" \
    PAPERCLIP_API_KEY="test-token" \
    PAPERCLIP_COMPANY_ID="company-1" \
    PAPERCLIP_RUN_ID="run-1" \
    "$@" \
    bash "$TARGET_SCRIPT"
  )
}

write_state() {
  local path="$1"
  local json="$2"
  printf '%s' "$json" >"$path"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "Assertion failed: $message" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    exit 1
  fi
}

test_ghost_block_auto_unblocks() {
  local state="$TMP_DIR/ghost.json"
  write_state "$state" '{
    "issues": {
      "issue-ghost": {
        "id": "issue-ghost",
        "identifier": "SNAAA-3000",
        "title": "Ghost blocked ticket",
        "status": "blocked",
        "assigneeAgentId": "agent-1",
        "updatedAt": "2026-04-20T07:00:00.000Z",
        "blockedBy": []
      }
    },
    "comments": { "issue-ghost": [] },
    "patches": []
  }'

  local output
  output="$(run_script "$state")"
  assert_eq "actions:1" "$output" "ghost blocked ticket should be auto-unblocked"

  local status patch_comment patch_count
  status="$(jq -r '.issues["issue-ghost"].status' "$state")"
  patch_comment="$(jq -r '.comments["issue-ghost"][0].body' "$state")"
  patch_count="$(jq -r '.patches | length' "$state")"

  assert_eq "todo" "$status" "ghost blocked ticket should move back to todo"
  assert_eq "1" "$patch_count" "ghost blocked ticket should be patched once"
  if [[ "$patch_comment" != *"ghost-block cleanup"* ]]; then
    echo "Expected ghost-block cleanup comment, got: $patch_comment" >&2
    exit 1
  fi
}

test_external_block_stays_blocked() {
  local state="$TMP_DIR/external.json"
  write_state "$state" '{
    "issues": {
      "issue-ext": {
        "id": "issue-ext",
        "identifier": "SNAAA-3001",
        "title": "External blocker",
        "status": "blocked",
        "assigneeAgentId": "agent-1",
        "updatedAt": "2026-04-20T07:00:00.000Z",
        "blockedBy": []
      }
    },
    "comments": {
      "issue-ext": [
        { "id": "comment-1", "body": "EXTERNAL BLOCK: waiting on vendor" }
      ]
    },
    "patches": []
  }'

  local output
  output="$(run_script "$state")"
  assert_eq "clean" "$output" "external blocks should not be auto-unblocked"
  assert_eq "0" "$(jq -r '.patches | length' "$state")" "external block should not be patched"
  assert_eq "blocked" "$(jq -r '.issues["issue-ext"].status' "$state")" "external block should remain blocked"
}

test_stale_blocker_auto_unblocks() {
  local state="$TMP_DIR/stale.json"
  write_state "$state" '{
    "issues": {
      "issue-stale": {
        "id": "issue-stale",
        "identifier": "SNAAA-3002",
        "title": "Resolved blockers",
        "status": "blocked",
        "assigneeAgentId": "agent-1",
        "updatedAt": "2026-04-20T07:00:00.000Z",
        "blockedBy": [
          { "id": "blocker-done", "identifier": "SNAAA-10", "status": "done" },
          { "id": "blocker-cancelled", "identifier": "SNAAA-11", "status": "cancelled" }
        ]
      }
    },
    "comments": { "issue-stale": [] },
    "patches": []
  }'

  local output
  output="$(run_script "$state")"
  assert_eq "actions:1" "$output" "done/cancelled blockers should auto-unblock"
  assert_eq "todo" "$(jq -r '.issues["issue-stale"].status' "$state")" "stale blockers should clear blocked status"
  if [[ "$(jq -r '.comments["issue-stale"][0].body' "$state")" != *"SNAAA-10, SNAAA-11"* ]]; then
    echo "Expected stale blocker comment to include blocker identifiers" >&2
    exit 1
  fi
}

test_partial_blocker_is_untouched() {
  local state="$TMP_DIR/partial.json"
  write_state "$state" '{
    "issues": {
      "issue-partial": {
        "id": "issue-partial",
        "identifier": "SNAAA-3003",
        "title": "Partially blocked",
        "status": "blocked",
        "assigneeAgentId": "agent-1",
        "updatedAt": "2026-04-20T07:00:00.000Z",
        "blockedBy": [
          { "id": "blocker-active", "identifier": "SNAAA-12", "status": "in_progress" },
          { "id": "blocker-done", "identifier": "SNAAA-13", "status": "done" }
        ]
      }
    },
    "comments": { "issue-partial": [] },
    "patches": []
  }'

  local output
  output="$(run_script "$state")"
  assert_eq "clean" "$output" "partial blockers should be logged only"
  assert_eq "0" "$(jq -r '.patches | length' "$state")" "partial blocker should not be patched"
  assert_eq "blocked" "$(jq -r '.issues["issue-partial"].status' "$state")" "partial blocker should stay blocked"
}

test_repeated_run_is_not_spammy() {
  local state="$TMP_DIR/repeat.json"
  write_state "$state" '{
    "issues": {
      "issue-repeat": {
        "id": "issue-repeat",
        "identifier": "SNAAA-3004",
        "title": "Repeat ghost block",
        "status": "blocked",
        "assigneeAgentId": "agent-1",
        "updatedAt": "2026-04-20T07:00:00.000Z",
        "blockedBy": []
      }
    },
    "comments": { "issue-repeat": [] },
    "patches": []
  }'

  assert_eq "actions:1" "$(run_script "$state")" "first run should auto-unblock"
  assert_eq "clean" "$(run_script "$state")" "second run should do nothing"
  assert_eq "1" "$(jq -r '.comments["issue-repeat"] | length' "$state")" "second run should not add a duplicate comment"
}

test_dry_run_skips_patch() {
  local state="$TMP_DIR/dry-run.json"
  write_state "$state" '{
    "issues": {
      "issue-dry": {
        "id": "issue-dry",
        "identifier": "SNAAA-3005",
        "title": "Dry-run ghost block",
        "status": "blocked",
        "assigneeAgentId": "agent-1",
        "updatedAt": "2026-04-20T07:00:00.000Z",
        "blockedBy": []
      }
    },
    "comments": { "issue-dry": [] },
    "patches": []
  }'

  local output
  output="$(run_script "$state" env DRY_RUN=true)"
  assert_eq "actions:1" "$output" "dry run should still report planned action"
  assert_eq "0" "$(jq -r '.patches | length' "$state")" "dry run should not patch the issue"
  assert_eq "blocked" "$(jq -r '.issues["issue-dry"].status' "$state")" "dry run should leave issue blocked"
}

test_ghost_block_auto_unblocks
test_external_block_stays_blocked
test_stale_blocker_auto_unblocks
test_partial_blocker_is_untouched
test_repeated_run_is_not_spammy
test_dry_run_skips_patch

echo "ticket-block-health-check tests passed"
