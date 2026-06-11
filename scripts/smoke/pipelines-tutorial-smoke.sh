#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for the pipeline tutorial smoke." >&2
  exit 1
fi

: "${PAPERCLIP_COMPANY_ID:?Set PAPERCLIP_COMPANY_ID for the target dev company.}"

read -r -a PC_CMD <<< "${PAPERCLIPAI_CMD:-pnpm --silent paperclipai}"
RUN_KEY="${PIPELINE_SMOKE_KEY:-$(date +%Y%m%d%H%M%S)}"
RELEASES_KEY="releases-${RUN_KEY}"
CONTENT_KEY="content-${RUN_KEY}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

pc_json() {
  "${PC_CMD[@]}" "$@" --json -C "$PAPERCLIP_COMPANY_ID"
}

pick_agent_id() {
  if [[ -n "${DRAFTING_AGENT_ID:-}" ]]; then
    echo "$DRAFTING_AGENT_ID"
    return
  fi
  if [[ -n "${PAPERCLIP_AGENT_ID:-}" ]]; then
    echo "$PAPERCLIP_AGENT_ID"
    return
  fi
  pc_json agent list 2>/dev/null | jq -r 'map(select(.status != "terminated"))[0].id // empty'
}

require_json() {
  local json="$1"
  local filter="$2"
  local message="$3"
  if ! jq -e "$filter" >/dev/null <<<"$json"; then
    echo "$message" >&2
    echo "$json" | jq . >&2
    exit 1
  fi
}

cat >"$TMP_DIR/releases-stages.json" <<'JSON'
[
  { "key": "released", "name": "Released", "kind": "open", "position": 100 },
  { "key": "complete", "name": "Complete", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

cat >"$TMP_DIR/content-stages.json" <<'JSON'
[
  {
    "key": "review",
    "name": "Human review",
    "kind": "review",
    "position": 100,
    "config": {
      "approveToStageKey": "drafting",
      "rejectToStageKey": "cancelled",
      "requireRejectReason": true,
      "reviewerKind": "human"
    }
  },
  { "key": "drafting", "name": "Drafting", "kind": "working", "position": 200 },
  { "key": "ready", "name": "Ready to publish", "kind": "working", "position": 300 },
  { "key": "published", "name": "Published", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

cat >"$TMP_DIR/content-transitions.json" <<'JSON'
{
  "transitions": [
    { "fromStageKey": "review", "toStageKey": "drafting", "label": "approve" },
    { "fromStageKey": "review", "toStageKey": "cancelled", "label": "reject" },
    { "fromStageKey": "drafting", "toStageKey": "ready", "label": "draft ready" },
    { "fromStageKey": "drafting", "toStageKey": "published", "label": "publish directly" },
    { "fromStageKey": "drafting", "toStageKey": "cancelled", "label": "cancel" },
    { "fromStageKey": "ready", "toStageKey": "published", "label": "publish" }
  ]
}
JSON

cat >"$TMP_DIR/guidance.md" <<'MD'
# Content pipeline guidance

Approve content suggestions that can teach users what changed and reject suggestions
that are too narrow, duplicative, or disconnected from the release.
MD

agent_id="$(pick_agent_id)"
routine_payload="$(jq -cn --arg agentId "$agent_id" '{
  title: "Pipeline smoke drafting routine",
  description: "Draft the approved content case using the embedded Pipeline Case Context, then transition the case when the draft is ready.",
  priority: "medium",
  status: "active",
  concurrencyPolicy: "always_enqueue",
  catchUpPolicy: "skip_missed"
} + (if $agentId != "" then { assigneeAgentId: $agentId } else {} end)')"
routine="$(pc_json routine create --payload-json "$routine_payload")"
routine_id="$(jq -r '.id' <<<"$routine")"

releases="$(pc_json pipelines create --key "$RELEASES_KEY" --name "Smoke Releases $RUN_KEY" --stages-file "$TMP_DIR/releases-stages.json")"
content="$(pc_json pipelines create --key "$CONTENT_KEY" --name "Smoke Content $RUN_KEY" --stages-file "$TMP_DIR/content-stages.json")"
require_json "$releases" '.id and (.stages | length == 3)' "Releases pipeline creation failed."
require_json "$content" '.id and (.stages | length == 5)' "Content pipeline creation failed."

pc_json pipelines set-transitions "$CONTENT_KEY" --file "$TMP_DIR/content-transitions.json" >/dev/null
pc_json pipelines guidance put "$CONTENT_KEY" --file "$TMP_DIR/guidance.md" >/dev/null
pc_json pipelines set-automation "$CONTENT_KEY" --stage drafting --routine "$routine_id" >/dev/null

release="$(pc_json pipelines ingest "$RELEASES_KEY" \
  --case-key "release-$RUN_KEY" \
  --title "Release $RUN_KEY: Pipeline primitive" \
  --summary "A release case that fans out into content suggestions." \
  --fields-json '{"release":"v0.pipeline-smoke","source":"tutorial-smoke"}')"
release_case_id="$(jq -r '.case.id' <<<"$release")"

pc_json pipelines case edit "$release_case_id" --expected-version 1 --summary "Release case edited by the CLI smoke." >/dev/null
claim="$(pc_json pipelines case claim "$release_case_id" --lease-seconds 60)"
lease_token="$(jq -r '.leaseToken' <<<"$claim")"
pc_json pipelines case release "$release_case_id" --lease-token "$lease_token" >/dev/null

jq -n --arg parent "$release_case_id" '{
  items: [
    { caseKey: "suggestion-01", title: "Launch blog post", summary: "Explain the release end to end.", fields: { channel: "blog" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-02", title: "Product changelog", summary: "Concise changelog entry.", fields: { channel: "docs" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-03", title: "Launch tweet", summary: "Short tweet after the blog is ready.", fields: { channel: "x" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-04", title: "Customer email", summary: "Email announcement.", fields: { channel: "email" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-05", title: "LinkedIn post", summary: "Professional network announcement.", fields: { channel: "linkedin" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-06", title: "Discord update", summary: "Community update.", fields: { channel: "discord" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-07", title: "Release notes", summary: "Detailed release notes.", fields: { channel: "release_notes" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-08", title: "Overly niche post", summary: "Reject: too niche.", fields: { channel: "blog" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-09", title: "Duplicate tweet", summary: "Reject: duplicate.", fields: { channel: "x" }, parentCaseId: $parent, stageKey: "review" },
    { caseKey: "suggestion-10", title: "Short-form video", summary: "Needs edit before approval.", fields: { channel: "video" }, parentCaseId: $parent, stageKey: "review" }
  ]
}' >"$TMP_DIR/suggestions.json"

batch="$(pc_json pipelines ingest-batch "$CONTENT_KEY" --file "$TMP_DIR/suggestions.json")"
require_json "$batch" 'length == 10 and all(.ok == true)' "Batch ingest did not create/find 10 suggestions."

case_id() {
  jq -r --arg key "$1" '.[] | select(.case.caseKey == $key) | .case.id' <<<"$batch"
}

case1="$(case_id suggestion-01)"
case2="$(case_id suggestion-02)"
case3="$(case_id suggestion-03)"
case4="$(case_id suggestion-04)"
case5="$(case_id suggestion-05)"
case6="$(case_id suggestion-06)"
case7="$(case_id suggestion-07)"
case8="$(case_id suggestion-08)"
case9="$(case_id suggestion-09)"
case10="$(case_id suggestion-10)"

inbox="$(pc_json pipelines review-inbox --pipeline "$CONTENT_KEY")"
require_json "$inbox" 'length == 10' "Review inbox should contain the 10 suggestion cases."

jq -n \
  --arg c1 "$case1" --arg c2 "$case2" --arg c3 "$case3" --arg c4 "$case4" --arg c5 "$case5" \
  --arg c6 "$case6" --arg c7 "$case7" --arg c8 "$case8" --arg c9 "$case9" '{
  items: [
    { caseId: $c1, decision: "approve", expectedVersion: 1 },
    { caseId: $c2, decision: "approve", expectedVersion: 1 },
    { caseId: $c3, decision: "approve", expectedVersion: 1 },
    { caseId: $c4, decision: "approve", expectedVersion: 1 },
    { caseId: $c5, decision: "approve", expectedVersion: 1 },
    { caseId: $c6, decision: "approve", expectedVersion: 1 },
    { caseId: $c7, decision: "approve", expectedVersion: 1 },
    { caseId: $c8, decision: "reject", reason: "Too niche for this launch.", expectedVersion: 1 },
    { caseId: $c9, decision: "reject", reason: "Duplicates the launch tweet.", expectedVersion: 1 }
  ]
}' >"$TMP_DIR/decisions.json"

bulk="$(pc_json pipelines review-bulk --file "$TMP_DIR/decisions.json")"
require_json "$bulk" '.results | length == 9 and all(.ok == true)' "Bulk review failed."

pc_json pipelines case review "$case10" \
  --approve \
  --expected-version 1 \
  --title "Edited short-form video" \
  --fields-json '{"channel":"video","edited":true}' >/dev/null

case1_detail="$(pc_json pipelines case get "$case1")"
require_json "$case1_detail" '(.links | length) >= 1' "Approved case should have an automation issue link."

suggestion="$(pc_json pipelines case suggest "$case1" --to ready --rationale "Draft is complete enough to publish." --confidence 0.9)"
suggestion_id="$(jq -r '.suggestion.id' <<<"$suggestion")"
pc_json pipelines case resolve-suggestion "$case1" --suggestion "$suggestion_id" --accept --expected-version 2 >/dev/null
pc_json pipelines case transition "$case1" --to published --expected-version 3 --reason "Suggestion accepted and content published." >/dev/null

pc_json pipelines case block "$case3" --by "$case2" >/dev/null
set +e
blocked_output="$(pc_json pipelines case transition "$case3" --to published --expected-version 2 --reason "Try before blog is published." 2>&1)"
blocked_status=$?
set -e
if [[ "$blocked_status" -eq 0 || "$blocked_output" != *"code=blocked"* ]]; then
  echo "Expected blocked transition to fail with code=blocked." >&2
  echo "$blocked_output" >&2
  exit 1
fi
pc_json pipelines case transition "$case2" --to published --expected-version 2 --reason "Blog published; unblocks tweet." >/dev/null
pc_json pipelines case transition "$case3" --to published --expected-version 2 --reason "Blocker resolved." >/dev/null

pc_json pipelines case transition "$case4" --to cancelled --expected-version 2 --reason "Cancelled after review." >/dev/null
pc_json pipelines case transition "$case5" --to published --expected-version 2 --reason "Published." >/dev/null
pc_json pipelines case transition "$case6" --to published --expected-version 2 --reason "Published." >/dev/null
pc_json pipelines case transition "$case7" --to published --expected-version 2 --reason "Published." >/dev/null
pc_json pipelines case transition "$case10" --to published --expected-version 3 --reason "Edited and published." >/dev/null

rollup="$(pc_json pipelines case rollup "$release_case_id")"
require_json "$rollup" '.complete == true and .done == 7 and .cancelled == 3 and .open == 0' "Release rollup did not report the expected done/cancelled split."

events="$(pc_json pipelines case events "$case1")"
require_json "$events" '.items | map(.type) | index("ingested") and index("review_decided") and index("automation_executed") and index("transition_suggested") and index("suggestion_resolved") and index("transitioned")' "Event history is missing expected provenance events."

pc_json pipelines cases "$CONTENT_KEY" --parent "$release_case_id" --terminal >/dev/null
pc_json pipelines case open-conversation "$case3" >/dev/null

echo "Pipeline tutorial smoke passed for $RUN_KEY"
