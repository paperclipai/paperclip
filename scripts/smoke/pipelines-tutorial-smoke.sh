#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for the pipeline tutorial smoke." >&2
  exit 1
fi

: "${PAPERCLIP_API_URL:?Set PAPERCLIP_API_URL for the target dev instance.}"
: "${PAPERCLIP_API_KEY:?Set PAPERCLIP_API_KEY for the target dev instance.}"
: "${PAPERCLIP_COMPANY_ID:?Set PAPERCLIP_COMPANY_ID for the target dev company.}"

read -r -a PC_CMD <<< "${PAPERCLIPAI_CMD:-pnpm --silent paperclipai}"
RUN_KEY="${PIPELINE_SMOKE_KEY:-$(date +%Y%m%d%H%M%S)}"
RELEASE_PIPELINE="release-coverage-${RUN_KEY}"
FEATURE_PIPELINE="feature-content-${RUN_KEY}"
CONTENT_PIPELINE="content-production-${RUN_KEY}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

pc_json() {
  "${PC_CMD[@]}" "$@" --json -C "$PAPERCLIP_COMPANY_ID"
}

api_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "${PAPERCLIP_API_URL%/}$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
      "${PAPERCLIP_API_URL%/}$path"
  fi
}

pick_agent_id() {
  if [[ -n "${DRAFTING_AGENT_ID:-}" ]]; then
    echo "$DRAFTING_AGENT_ID"
    return
  fi
  local company_agent_id
  company_agent_id="$(pc_json agent list 2>/dev/null | jq -r 'map(select(.status != "terminated"))[0].id // empty')"
  if [[ -n "$company_agent_id" ]]; then
    echo "$company_agent_id"
    return
  fi
  echo ""
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

case_id() {
  local json="$1"
  local key="$2"
  jq -r --arg key "$key" '.[] | select(.case.caseKey == $key) | .case.id' <<<"$json"
}

case_version() {
  pc_json pipelines case get "$1" | jq -r '.case.version'
}

case_stage() {
  pc_json pipelines case get "$1" | jq -r '.stage.key'
}

cat >"$TMP_DIR/release-stages.json" <<'JSON'
[
  {
    "key": "intake",
    "name": "Intake",
    "kind": "open",
    "position": 100,
    "config": { "autoAdvanceOnChildrenTerminal": "covered" }
  },
  { "key": "covered", "name": "Covered", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

cat >"$TMP_DIR/feature-stages.json" <<'JSON'
[
  { "key": "suggesting", "name": "Suggesting", "kind": "open", "position": 100 },
  {
    "key": "suggestion_review",
    "name": "Suggestion Review",
    "kind": "review",
    "position": 200,
    "config": {
      "approveToStageKey": "producing",
      "rejectToStageKey": "cancelled",
      "requestChangesToStageKey": "suggesting",
      "requireRejectReason": true,
      "reviewerKind": "human"
    }
  },
  {
    "key": "producing",
    "name": "Producing",
    "kind": "working",
    "position": 300,
    "config": { "autoAdvanceOnChildrenTerminal": "covered" }
  },
  { "key": "covered", "name": "Covered", "kind": "done", "position": 900 },
  { "key": "cancelled", "name": "Cancelled", "kind": "cancelled", "position": 1000 }
]
JSON

cat >"$TMP_DIR/content-stages.json" <<'JSON'
[
  {
    "key": "drafting",
    "name": "Drafting",
    "kind": "working",
    "position": 100,
    "config": { "autonomy": "suggest" }
  },
  {
    "key": "assets",
    "name": "Assets",
    "kind": "working",
    "position": 200
  },
  {
    "key": "assembly",
    "name": "Assembly",
    "kind": "working",
    "position": 300,
    "config": { "autoAdvanceOnChildrenTerminal": "final_review" }
  },
  {
    "key": "final_review",
    "name": "Final Review",
    "kind": "review",
    "position": 400,
    "config": {
      "approveToStageKey": "publishing",
      "rejectToStageKey": "dropped",
      "requestChangesToStageKey": "drafting",
      "requireRejectReason": true,
      "reviewerKind": "human"
    }
  },
  { "key": "publishing", "name": "Publishing", "kind": "working", "position": 500 },
  { "key": "published", "name": "Published", "kind": "done", "position": 900 },
  { "key": "dropped", "name": "Dropped", "kind": "cancelled", "position": 1000 }
]
JSON

cat >"$TMP_DIR/release-transitions.json" <<'JSON'
{
  "enforceTransitions": true,
  "transitions": [
    { "fromStageKey": "intake", "toStageKey": "covered", "label": "all features terminal" },
    { "fromStageKey": "intake", "toStageKey": "cancelled", "label": "cancel release coverage" }
  ]
}
JSON

cat >"$TMP_DIR/content-guidance.md" <<'MD'
# Content Production guidance

Final Review has three exits:

- approve to Publishing when the pinned revisions are ready to ship
- request changes back to Drafting when the same work issue should continue
- drop to Dropped when the content should not ship

Convention: asset cases store `briefedFromVersion` in `fields` so assembly review can compare a pinned brief against the current upstream case `version`.
MD

agent_id="$(pick_agent_id)"
routine_payload="$(jq -cn --arg agentId "$agent_id" '{
  title: "Pipeline tutorial drafting routine",
  description: "Template convention: draft the content case from the Pipeline Case Context, keep typed work references in case fields, and suggest Drafting -> Assets when ready.",
  priority: "medium",
  status: "active",
  concurrencyPolicy: "always_enqueue",
  catchUpPolicy: "skip_missed"
} + (if $agentId != "" then { assigneeAgentId: $agentId } else {} end)')"
routine="$(pc_json routine create --payload-json "$routine_payload")"
routine_id="$(jq -r '.id' <<<"$routine")"

release_pipeline="$(pc_json pipelines create --key "$RELEASE_PIPELINE" --name "Smoke Release Coverage $RUN_KEY" --stages-file "$TMP_DIR/release-stages.json")"
feature_pipeline="$(pc_json pipelines create --key "$FEATURE_PIPELINE" --name "Smoke Feature Content $RUN_KEY" --stages-file "$TMP_DIR/feature-stages.json")"
content_pipeline="$(pc_json pipelines create --key "$CONTENT_PIPELINE" --name "Smoke Content Production $RUN_KEY" --stages-file "$TMP_DIR/content-stages.json")"
require_json "$release_pipeline" '.id and (.stages | length == 3)' "Release Coverage pipeline creation failed."
require_json "$feature_pipeline" '.id and (.stages | length == 5)' "Feature Content pipeline creation failed."
require_json "$content_pipeline" '.id and (.stages | length == 7)' "Content Production pipeline creation failed."

pc_json pipelines set-transitions "$RELEASE_PIPELINE" --file "$TMP_DIR/release-transitions.json" >/dev/null
pc_json pipelines guidance put "$CONTENT_PIPELINE" --file "$TMP_DIR/content-guidance.md" >/dev/null
pc_json pipelines set-automation "$CONTENT_PIPELINE" --stage drafting --routine "$routine_id" --note "Template-versioned with the routine prompt." >/dev/null

release="$(pc_json pipelines ingest "$RELEASE_PIPELINE" \
  --case-key "release-${RUN_KEY}" \
  --stage intake \
  --title "Release $RUN_KEY: Pipeline primitives" \
  --summary "Rollup root for the tutorial smoke." \
  --fields-json '{"release":"v0.pipeline-smoke","templateVersionConvention":"routine-prompt"}')"
release_case_id="$(jq -r '.case.id' <<<"$release")"

jq -n --arg parent "$release_case_id" '{
  items: [
    {
      caseKey: "feature-pipelines-ui",
      title: "Feature: Pipelines UI",
      summary: "Worth a content package.",
      parentCaseId: $parent,
      stageKey: "suggestion_review",
      fields: { releaseTag: "v0.pipeline-smoke", source: "release-notes" }
    },
    {
      caseKey: "feature-routine-webhooks",
      title: "Feature: Routine webhooks",
      summary: "Rejected by the gate for this release.",
      parentCaseId: $parent,
      stageKey: "suggestion_review",
      fields: { releaseTag: "v0.pipeline-smoke", source: "release-notes" }
    }
  ]
}' >"$TMP_DIR/feature-cases.json"

features="$(pc_json pipelines ingest-batch "$FEATURE_PIPELINE" --file "$TMP_DIR/feature-cases.json")"
require_json "$features" 'length == 2 and all(.ok == true)' "Feature batch ingest did not create two cases."
feature_main="$(case_id "$features" feature-pipelines-ui)"
feature_dropped="$(case_id "$features" feature-routine-webhooks)"

jq -n --arg main "$feature_main" --arg dropped "$feature_dropped" '{
  items: [
    { caseId: $main, decision: "approve", expectedVersion: 1 },
    { caseId: $dropped, decision: "reject", reason: "Fold webhooks into the broader launch post.", expectedVersion: 1 }
  ]
}' >"$TMP_DIR/feature-review.json"
feature_review="$(pc_json pipelines review-bulk --file "$TMP_DIR/feature-review.json")"
require_json "$feature_review" '.results | length == 2 and all(.ok == true)' "Feature review decisions failed."
require_json "$(pc_json pipelines case get "$feature_main")" '.stage.key == "producing" and .case.version == 2' "Approved feature should enter Producing."
require_json "$(pc_json pipelines case get "$feature_dropped")" '.stage.key == "cancelled" and .case.terminalKind == "cancelled"' "Rejected feature should be cancelled."

jq -n --arg parent "$feature_main" '{
  items: [
    {
      caseKey: "blog-post",
      title: "Launch blog post",
      summary: "Draft the release narrative.",
      parentCaseId: $parent,
      stageKey: "drafting",
      fields: {
        contentType: "blog",
        typedWorkRefs: { draftPath: "workspaces/release/blog.md" },
        briefedFromVersion: null
      }
    },
    {
      caseKey: "changelog-entry",
      title: "Product changelog",
      summary: "Compact changelog entry.",
      parentCaseId: $parent,
      stageKey: "drafting",
      fields: {
        contentType: "changelog",
        typedWorkRefs: { draftPath: "workspaces/release/changelog.md" },
        briefedFromVersion: null
      }
    },
    {
      caseKey: "launch-tweet",
      title: "Launch tweet",
      summary: "Tweet after the blog is approved.",
      parentCaseId: $parent,
      stageKey: "drafting",
      blockedByCaseKeys: ["blog-post"],
      fields: {
        contentType: "social",
        typedWorkRefs: { draftPath: "workspaces/release/tweet.md" },
        briefedFromVersion: 1
      }
    }
  ]
}' >"$TMP_DIR/content-cases.json"

content_cases="$(pc_json pipelines ingest-batch "$CONTENT_PIPELINE" --file "$TMP_DIR/content-cases.json")"
require_json "$content_cases" 'length == 3 and all(.ok == true)' "Content batch ingest did not create three cases."
blog_case="$(case_id "$content_cases" blog-post)"
changelog_case="$(case_id "$content_cases" changelog-entry)"
tweet_case="$(case_id "$content_cases" launch-tweet)"

set +e
blocked_output="$(pc_json pipelines case transition "$tweet_case" --to assets --expected-version 1 --reason "Try before upstream blog is published." 2>&1)"
blocked_status=$?
set -e
if [[ "$blocked_status" -eq 0 || "$blocked_output" != *"code=blocked"* ]]; then
  echo "Expected blocked transition to fail with code=blocked." >&2
  echo "$blocked_output" >&2
  exit 1
fi

work_issue="$(pc_json issue create \
  --title "Smoke work issue for launch tweet $RUN_KEY" \
  --description "Receives drift comments from the upstream blog case." \
  --status todo \
  --priority low)"
work_issue_id="$(jq -r '.id' <<<"$work_issue")"
api_json POST "/api/cases/$tweet_case/issue-links" "$(jq -cn --arg issueId "$work_issue_id" '{ issueId: $issueId, role: "work" }')" >/dev/null

suggestion="$(pc_json pipelines case suggest "$blog_case" --to assets --rationale "Draft is stable enough to brief asset work." --confidence 0.9)"
suggestion_id="$(jq -r '.suggestion.id' <<<"$suggestion")"
pc_json pipelines case resolve-suggestion "$blog_case" --suggestion "$suggestion_id" --accept --expected-version 1 >/dev/null
require_json "$(pc_json pipelines case get "$blog_case")" '.stage.key == "assets" and .case.version == 2' "Accepted readiness suggestion should move blog to Assets."

pc_json pipelines case edit "$blog_case" \
  --expected-version 2 \
  --summary "Draft changed while dependent tweet work was already briefed." \
  --fields-json '{"contentType":"blog","typedWorkRefs":{"draftPath":"workspaces/release/blog.md"},"briefedFromVersion":null,"materialChange":"new-positioning"}' >/dev/null

comments="$(api_json GET "/api/issues/$work_issue_id/comments")"
require_json "$comments" 'length >= 1 and (.[-1].body | contains("changed (v2"))' "Dependent work issue did not receive the upstream drift comment."

set +e
conflict_output="$(pc_json pipelines case edit "$blog_case" --expected-version 2 --title "Stale edit" 2>&1)"
conflict_status=$?
set -e
if [[ "$conflict_status" -eq 0 || "$conflict_output" != *"code=version_conflict"* ]]; then
  echo "Expected stale edit to fail with code=version_conflict." >&2
  echo "$conflict_output" >&2
  exit 1
fi
blog_version="$(case_version "$blog_case")"

jq -n --arg parent "$feature_main" --argjson briefVersion "$blog_version" '{
  items: [
    {
      caseKey: "blog-hero-image",
      title: "Hero image",
      parentCaseId: $parent,
      stageKey: "assets",
      fields: { assetType: "image", briefedFromVersion: $briefVersion }
    },
    {
      caseKey: "blog-social-card",
      title: "Social card",
      parentCaseId: $parent,
      stageKey: "assets",
      fields: { assetType: "image", briefedFromVersion: $briefVersion }
    }
  ]
}' >"$TMP_DIR/asset-cases.json"
asset_cases="$(pc_json pipelines ingest-batch "$CONTENT_PIPELINE" --file "$TMP_DIR/asset-cases.json")"
require_json "$asset_cases" 'length == 2 and all(.ok == true)' "Asset batch ingest failed."
asset_hero="$(case_id "$asset_cases" blog-hero-image)"
asset_card="$(case_id "$asset_cases" blog-social-card)"

pc_json pipelines case transition "$asset_hero" --to published --expected-version 1 --reason "Hero image done." >/dev/null
pc_json pipelines case transition "$asset_card" --to dropped --expected-version 1 --reason "Social card not needed." >/dev/null
blog_assets_version="$(case_version "$blog_case")"
pc_json pipelines case transition "$blog_case" --to assembly --expected-version "$blog_assets_version" --reason "Assets complete; assemble the package." >/dev/null
require_json "$(pc_json pipelines case get "$blog_case")" '.stage.key == "assembly"' "Blog should enter Assembly after assets are complete."

jq -n --arg parent "$blog_case" '{
  items: [
    {
      caseKey: "blog-assembly-package",
      title: "Assembled blog package",
      parentCaseId: $parent,
      stageKey: "assembly",
      fields: { packageType: "blog", assembledFrom: ["blog-hero-image", "blog-social-card"] }
    }
  ]
}' >"$TMP_DIR/assembly-cases.json"
assembly_cases="$(pc_json pipelines ingest-batch "$CONTENT_PIPELINE" --file "$TMP_DIR/assembly-cases.json")"
require_json "$assembly_cases" 'length == 1 and all(.ok == true)' "Assembly batch ingest failed."
assembly_package="$(case_id "$assembly_cases" blog-assembly-package)"
pc_json pipelines case transition "$assembly_package" --to published --expected-version 1 --reason "Assembly complete." >/dev/null
require_json "$(pc_json pipelines case get "$blog_case")" '.stage.key == "final_review"' "Blog should auto-advance from Assembly to Final Review."

blog_review_version="$(case_version "$blog_case")"
pc_json pipelines case review "$blog_case" --approve --expected-version "$blog_review_version" >/dev/null
pc_json pipelines case transition "$blog_case" --to published --expected-version "$((blog_review_version + 1))" --reason "Approved package published." >/dev/null

pc_json pipelines case transition "$changelog_case" --to final_review --expected-version 1 --reason "Draft ready for final review." >/dev/null
pc_json pipelines case review "$changelog_case" --request-changes --reason "Tighten the framing before publishing." --expected-version 2 >/dev/null
require_json "$(pc_json pipelines case get "$changelog_case")" '.stage.key == "drafting" and .case.version == 3' "Request changes should return changelog to Drafting."
pc_json pipelines case edit "$changelog_case" \
  --expected-version 3 \
  --summary "Revised changelog entry after requested changes." \
  --fields-json '{"contentType":"changelog","typedWorkRefs":{"draftPath":"workspaces/release/changelog.md"},"changeRequestAddressed":true}' >/dev/null
pc_json pipelines case transition "$changelog_case" --to final_review --expected-version 4 --reason "Revised draft ready." >/dev/null
pc_json pipelines case review "$changelog_case" --approve --expected-version 5 >/dev/null
pc_json pipelines case transition "$changelog_case" --to published --expected-version 6 --reason "Published after request-changes loop." >/dev/null

pc_json pipelines case transition "$tweet_case" --to final_review --expected-version 1 --reason "Blog blocker is now done." >/dev/null
pc_json pipelines case review "$tweet_case" --reject --reason "Drop this tweet; blog already covers the announcement." --expected-version 2 >/dev/null

require_json "$(pc_json pipelines case get "$feature_main")" '.stage.key == "covered" and .case.terminalKind == "done"' "Feature case should be covered after content children are terminal."
require_json "$(pc_json pipelines case get "$release_case_id")" '.stage.key == "covered" and .case.terminalKind == "done"' "Release case should be covered after feature children are terminal."

rollup="$(pc_json pipelines case rollup "$release_case_id")"
require_json "$rollup" '.complete == true and .done == 5 and .cancelled == 3 and .open == 0 and .total == 8' "Release rollup did not report the expected done/cancelled split."

events="$(pc_json pipelines case events "$changelog_case")"
require_json "$events" '([.items[].type] | index("review_decided")) and ([.items[] | select(.type == "review_decided") | .payload.decision] | index("request_changes") and index("approve"))' "Changelog event history is missing request-changes and approval decisions."

release_events="$(pc_json pipelines case events "$release_case_id")"
require_json "$release_events" '.items | map(.type) | index("children_terminal") and index("transitioned")' "Release event history is missing rollup provenance."

echo "Pipeline tutorial smoke passed for $RUN_KEY"
