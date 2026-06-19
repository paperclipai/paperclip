#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for the release/content pipeline example." >&2
  exit 1
fi

: "${PAPERCLIP_API_URL:?Set PAPERCLIP_API_URL for the target dev instance.}"
: "${PAPERCLIP_COMPANY_ID:?Set PAPERCLIP_COMPANY_ID for the target dev company.}"

read -r -a PC_CMD <<< "${PAPERCLIPAI_CMD:-pnpm --silent paperclipai}"
API_URL="${PAPERCLIP_PIPELINES_API_URL:-$PAPERCLIP_API_URL}"
API_KEY="${PAPERCLIP_PIPELINES_API_KEY:-${PAPERCLIP_BOARD_API_KEY:-${PAPERCLIP_API_KEY:-}}}"
RUN_KEY="${PIPELINE_EXAMPLE_RUN_KEY:-$(date +%Y%m%d%H%M%S)}"
ASSETS_PIPELINE="assets-example"
CONTENT_PIPELINE="content-example"
FEATURES_PIPELINE="features-example"
RELEASES_PIPELINE="releases-example"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

pc_json() {
  env -u PAPERCLIP_RUN_ID PAPERCLIP_API_URL="$API_URL" PAPERCLIP_API_KEY="$API_KEY" "${PC_CMD[@]}" "$@" --json -C "$PAPERCLIP_COMPANY_ID"
}

api_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local auth_args=()
  if [[ -n "$API_KEY" ]]; then
    auth_args=(-H "Authorization: Bearer $API_KEY")
  fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" \
      "${auth_args[@]}" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "${API_URL%/}$path"
  else
    curl -sS -X "$method" \
      "${auth_args[@]}" \
      "${API_URL%/}$path"
  fi
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

case_version() {
  pc_json pipelines case get "$1" | jq -r '.case.version'
}

case_stage() {
  pc_json pipelines case get "$1" | jq -r '.stage.key'
}

pipeline_id_for_key() {
  local key="$1"
  api_json GET "/api/companies/$PAPERCLIP_COMPANY_ID/pipelines" \
    | jq -r --arg key "$key" '.[] | select(.key == $key) | .id' \
    | head -n 1
}

assert_pipeline_absent() {
  local key="$1"
  local existing
  existing="$(pipeline_id_for_key "$key")"
  if [[ -n "$existing" ]]; then
    echo "Pipeline key '$key' already exists ($existing). Use a fresh dev DB or remove the existing example pipeline before reseeding." >&2
    exit 1
  fi
}

resolve_invokable_agent() {
  local preferred_id="$1"
  local label="$2"
  local agents selected
  agents="$(api_json GET "/api/companies/$PAPERCLIP_COMPANY_ID/agents")"
  selected="$(jq -r --arg id "$preferred_id" '
    map(select(.status == "active" or .status == "idle" or .status == "running"))
    | (map(select(.id == $id))[0] // .[0] // empty)
    | .id // empty
  ' <<<"$agents")"
  if [[ -z "$selected" ]]; then
    echo "No invokable agent found for $label. Need an agent with status active, idle, or running." >&2
    echo "$agents" | jq -r '.[] | [.id, .name, .status] | @tsv' >&2
    exit 1
  fi
  local status name
  status="$(jq -r --arg id "$selected" '.[] | select(.id == $id) | .status' <<<"$agents")"
  name="$(jq -r --arg id "$selected" '.[] | select(.id == $id) | .name' <<<"$agents")"
  echo "Resolved $label agent: $name ($selected, $status)" >&2
  echo "$selected"
}

assert_health_ok() {
  local key="$1"
  local pipeline_id="$2"
  local health
  health="$(api_json GET "/api/pipelines/$pipeline_id/health")"
  require_json "$health" '.ok == true and (.warnings | length == 0)' "Pipeline health was not ok for $key."
  jq -cn --arg key "$key" --arg id "$pipeline_id" --argjson ok "$(jq '.ok' <<<"$health")" \
    --argjson warnings "$(jq '.warnings | length' <<<"$health")" \
    '{key:$key,id:$id,ok:$ok,warnings:$warnings}'
}

breakdown_case() {
  local case_id="$1"
  local file="$2"
  api_json POST "/api/cases/$case_id/breakdown" "$(cat "$file")"
}

set_stage_automation() {
  local pipeline_id="$1"
  local stage_key="$2"
  local agent_id="$3"
  local instructions_body="$4"
  local detail stage_id config body

  detail="$(api_json GET "/api/pipelines/$pipeline_id")"
  stage_id="$(jq -r --arg key "$stage_key" '.stages[] | select(.key == $key) | .id' <<<"$detail")"
  if [[ -z "$stage_id" || "$stage_id" == "null" ]]; then
    echo "Stage '$stage_key' not found on pipeline $pipeline_id." >&2
    echo "$detail" | jq . >&2
    exit 1
  fi
  config="$(jq -c --arg key "$stage_key" --arg agent "$agent_id" --arg instructions "$instructions_body" '
    .stages[]
    | select(.key == $key)
    | (.config // {}) + { automation: { assigneeAgentId: $agent, instructionsBody: $instructions } }
  ' <<<"$detail")"
  body="$(jq -cn --argjson config "$config" '{config:$config}')"
  api_json PATCH "/api/pipelines/$pipeline_id/stages/$stage_id" "$body" >/dev/null
}

STRAT_AGENT_ID="$(resolve_invokable_agent "c4fec7d0-26f6-4223-a148-36288402d47e" "STRAT")"
WRITE_AGENT_ID="$(resolve_invokable_agent "726fa3f6-8644-47dc-96fa-e0a721c7d2bb" "WRITE")"
PROD_AGENT_ID="$(resolve_invokable_agent "a8424431-16fd-4267-b4b9-484aa1810307" "PROD")"

assert_pipeline_absent "$ASSETS_PIPELINE"
assert_pipeline_absent "$CONTENT_PIPELINE"
assert_pipeline_absent "$FEATURES_PIPELINE"
assert_pipeline_absent "$RELEASES_PIPELINE"

jq -n --arg prod "$PROD_AGENT_ID" '[
  {
    key: "produce-asset",
    name: "Produce Asset",
    kind: "working",
    position: 100,
    config: {
      automation: {
        assigneeAgentId: $prod,
        instructionsBody: "Produce this asset to spec from the brief (image, card, diagram, or clip). Attach or link the output, then send it to review."
      },
      variables: [
        { name: "contentType", key: "contentType", label: "Content type", type: "select", options: ["blog", "docs", "tweetstorm"], required: false, showInAddForm: true },
        { name: "assetType", key: "assetType", label: "Asset type", type: "select", options: ["image", "card", "diagram", "clip"], required: false, showInAddForm: true }
      ]
    }
  },
  {
    key: "asset-review",
    name: "Asset Review",
    kind: "review",
    position: 200,
    config: {
      requireApproval: true,
      approver: { kind: "any_human" },
      approveToStageKey: "delivered",
      rejectToStageKey: "discarded",
      requestChangesToStageKey: "produce-asset",
      requireRejectReason: true
    }
  },
  { key: "delivered", name: "Delivered", kind: "done", position: 900 },
  { key: "discarded", name: "Discarded", kind: "cancelled", position: 1000 }
]' >"$TMP_DIR/assets-stages.json"

assets_pipeline="$(pc_json pipelines create --key "$ASSETS_PIPELINE" --name "Example Assets" --stages-file "$TMP_DIR/assets-stages.json")"
assets_pipeline_id="$(jq -r '.id' <<<"$assets_pipeline")"
require_json "$assets_pipeline" '.id and (.stages | length == 4)' "Assets pipeline creation failed."
set_stage_automation "$assets_pipeline_id" "produce-asset" "$PROD_AGENT_ID" "Produce this asset to spec from the brief (image, card, diagram, or clip). Attach or link the output, then send it to review."

jq -n --arg write "$WRITE_AGENT_ID" --arg assets "$assets_pipeline_id" '[
  {
    key: "intake-content",
    name: "Intake Content",
    kind: "working",
    position: 100,
    config: {
      automation: {
        assigneeAgentId: $write,
        instructionsBody: "Draft this content piece from the brief; keep the draft in the case summary / work refs. Send it to review when the draft is solid."
      },
      variables: [
        { name: "releaseTag", key: "releaseTag", label: "Release tag", type: "text", required: false, showInAddForm: true },
        { name: "featureAngle", key: "featureAngle", label: "Feature angle", type: "text", required: false, showInAddForm: true },
        { name: "contentType", key: "contentType", label: "Content type", type: "select", options: ["blog", "docs", "tweetstorm"], required: false, showInAddForm: true }
      ]
    }
  },
  {
    key: "content-review",
    name: "Content Review",
    kind: "review",
    position: 200,
    config: {
      requireApproval: true,
      approver: { kind: "any_human" },
      approveToStageKey: "break-assets",
      rejectToStageKey: "shelved",
      requestChangesToStageKey: "intake-content",
      requireRejectReason: true
    }
  },
  {
    key: "break-assets",
    name: "Break Assets",
    kind: "working",
    position: 300,
    config: {
      automation: {
        assigneeAgentId: $write,
        instructionsBody: "List the assets this piece needs (hero image, social card, diagram, clip) -- one per piece with the asset type."
      },
      breakdown: {
        targetPipelineId: $assets,
        targetStageKey: "produce-asset",
        pieceNoun: "asset",
        inheritFields: ["contentType"],
        advanceTo: "assembling",
        waitForPieces: true,
        whenFinishedMoveTo: "published"
      }
    }
  },
  {
    key: "assembling",
    name: "Assembling",
    kind: "working",
    position: 400,
    config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "published" }
  },
  { key: "published", name: "Published", kind: "done", position: 900 },
  { key: "shelved", name: "Shelved", kind: "cancelled", position: 1000 }
]' >"$TMP_DIR/content-stages.json"

content_pipeline="$(pc_json pipelines create --key "$CONTENT_PIPELINE" --name "Example Content" --stages-file "$TMP_DIR/content-stages.json")"
content_pipeline_id="$(jq -r '.id' <<<"$content_pipeline")"
require_json "$content_pipeline" '.id and (.stages | length == 6)' "Content pipeline creation failed."
set_stage_automation "$content_pipeline_id" "intake-content" "$WRITE_AGENT_ID" "Draft this content piece from the brief; keep the draft in the case summary / work refs. Send it to review when the draft is solid."

jq -n --arg strat "$STRAT_AGENT_ID" --arg content "$content_pipeline_id" '[
  {
    key: "intake-feature",
    name: "Intake Feature",
    kind: "working",
    position: 100,
    config: {
      automation: {
        assigneeAgentId: $strat,
        instructionsBody: "Draft a short coverage brief: audience, the angle, and which content types fit (blog post, documentation, tweetstorm). Send it to review when ready."
      },
      variables: [
        { name: "releaseTag", key: "releaseTag", label: "Release tag", type: "text", required: false, showInAddForm: true },
        { name: "featureAngle", key: "featureAngle", label: "Feature angle", type: "text", required: false, showInAddForm: true }
      ]
    }
  },
  {
    key: "feature-review",
    name: "Feature Review",
    kind: "review",
    position: 200,
    config: {
      requireApproval: true,
      approver: { kind: "any_human" },
      approveToStageKey: "break-content",
      rejectToStageKey: "dropped",
      requestChangesToStageKey: "intake-feature",
      requireRejectReason: true
    }
  },
  {
    key: "break-content",
    name: "Break Content",
    kind: "working",
    position: 300,
    config: {
      automation: {
        assigneeAgentId: $strat,
        instructionsBody: "Create the content pieces for this approved feature -- one per piece (blog post, documentation, tweetstorm). Give each a clear title and summary."
      },
      breakdown: {
        targetPipelineId: $content,
        targetStageKey: "intake-content",
        pieceNoun: "content piece",
        inheritFields: ["releaseTag", "featureAngle"],
        advanceTo: "producing-content",
        waitForPieces: true,
        whenFinishedMoveTo: "covered"
      }
    }
  },
  {
    key: "producing-content",
    name: "Producing Content",
    kind: "working",
    position: 400,
    config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "covered" }
  },
  { key: "covered", name: "Covered", kind: "done", position: 900 },
  { key: "dropped", name: "Dropped", kind: "cancelled", position: 1000 }
]' >"$TMP_DIR/features-stages.json"

features_pipeline="$(pc_json pipelines create --key "$FEATURES_PIPELINE" --name "Example Features" --stages-file "$TMP_DIR/features-stages.json")"
features_pipeline_id="$(jq -r '.id' <<<"$features_pipeline")"
require_json "$features_pipeline" '.id and (.stages | length == 6)' "Features pipeline creation failed."
set_stage_automation "$features_pipeline_id" "intake-feature" "$STRAT_AGENT_ID" "Draft a short coverage brief: audience, the angle, and which content types fit (blog post, documentation, tweetstorm). Send it to review when ready."

jq -n --arg strat "$STRAT_AGENT_ID" --arg features "$features_pipeline_id" '[
  {
    key: "plan-coverage",
    name: "Plan Coverage",
    kind: "working",
    position: 100,
    config: {
      automation: {
        assigneeAgentId: $strat,
        instructionsBody: "Pick the features in this release worth their own coverage. Add one feature per piece with a one-line angle; explain each in the case summary."
      },
      variables: [
        { name: "releaseTag", key: "releaseTag", label: "Release tag", type: "text", required: false, showInAddForm: true },
        { name: "releaseNotesUrl", key: "releaseNotesUrl", label: "Release notes URL", type: "text", required: false, showInAddForm: true }
      ],
      breakdown: {
        targetPipelineId: $features,
        targetStageKey: "intake-feature",
        pieceNoun: "feature",
        inheritFields: ["releaseTag"],
        advanceTo: "covering",
        waitForPieces: true,
        whenFinishedMoveTo: "shipped"
      }
    }
  },
  {
    key: "covering",
    name: "Covering",
    kind: "working",
    position: 200,
    config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "shipped" }
  },
  { key: "shipped", name: "Shipped", kind: "done", position: 900 },
  { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 }
]' >"$TMP_DIR/releases-stages.json"

releases_pipeline="$(pc_json pipelines create --key "$RELEASES_PIPELINE" --name "Example Releases" --stages-file "$TMP_DIR/releases-stages.json")"
releases_pipeline_id="$(jq -r '.id' <<<"$releases_pipeline")"
require_json "$releases_pipeline" '.id and (.stages | length == 4)' "Releases pipeline creation failed."

health_results="$TMP_DIR/health-results.jsonl"
assert_health_ok "$ASSETS_PIPELINE" "$assets_pipeline_id" >>"$health_results"
assert_health_ok "$CONTENT_PIPELINE" "$content_pipeline_id" >>"$health_results"
assert_health_ok "$FEATURES_PIPELINE" "$features_pipeline_id" >>"$health_results"
assert_health_ok "$RELEASES_PIPELINE" "$releases_pipeline_id" >>"$health_results"

release="$(pc_json pipelines ingest "$RELEASES_PIPELINE" \
  --case-key "release-${RUN_KEY}" \
  --stage plan-coverage \
  --title "Release ${RUN_KEY}: Content workflow primitives" \
  --summary "Canonical release-to-assets example root." \
  --fields-json "{\"releaseTag\":\"v${RUN_KEY}\",\"releaseNotesUrl\":\"https://example.com/releases/${RUN_KEY}\"}")"
release_case_id="$(jq -r '.case.id' <<<"$release")"

jq -n '{
  items: [
    {
      key: "pipeline-builder",
      title: "Feature: Pipeline builder",
      summary: "Coverage angle: explain how the new builder turns release work into visible stages.",
      fields: { featureAngle: "Pipeline builder turns release work into visible stages." }
    },
    {
      key: "legacy-importer",
      title: "Feature: Legacy importer",
      summary: "Rejected for this release because the audience overlap is low.",
      fields: { featureAngle: "Legacy importer is less relevant for launch coverage." }
    }
  ]
}' >"$TMP_DIR/feature-breakdown.json"

features="$(breakdown_case "$release_case_id" "$TMP_DIR/feature-breakdown.json")"
require_json "$features" '.parentCase.version == 2 and (.items | length == 2 and all(.ok == true))' "Release breakdown did not create two feature cases."
feature_main="$(jq -r '.items[] | select(.case.requestKey == "feature:pipeline-builder") | .case.id' <<<"$features")"
feature_rejected="$(jq -r '.items[] | select(.case.requestKey == "feature:legacy-importer") | .case.id' <<<"$features")"
require_json "$(pc_json pipelines case get "$release_case_id")" '.stage.key == "covering" and .case.version == 2' "Release should be covering after feature breakdown."
require_json "$(pc_json pipelines case get "$feature_main")" '.stage.key == "intake-feature" and .case.fields.releaseTag != null and .case.fields.featureAngle != null' "Feature child did not start at intake with inherited fields."

pc_json pipelines case transition "$feature_main" --to feature-review --expected-version 1 --reason "Coverage brief ready for review." >/dev/null
pc_json pipelines case transition "$feature_rejected" --to feature-review --expected-version 1 --reason "Coverage brief ready for review." >/dev/null

jq -n --arg main "$feature_main" --arg rejected "$feature_rejected" '{
  items: [
    { caseId: $main, decision: "approve", expectedVersion: 2 },
    { caseId: $rejected, decision: "reject", reason: "Drop this feature from the launch content set.", expectedVersion: 2 }
  ]
}' >"$TMP_DIR/feature-review.json"
feature_review="$(pc_json pipelines review-bulk --file "$TMP_DIR/feature-review.json")"
require_json "$feature_review" '.results | length == 2 and all(.ok == true)' "Feature review decisions failed."
require_json "$(pc_json pipelines case get "$feature_main")" '.stage.key == "break-content" and .case.version == 3' "Approved feature should enter break-content."
require_json "$(pc_json pipelines case get "$feature_rejected")" '.stage.key == "dropped" and .case.terminalKind == "cancelled"' "Rejected feature should be dropped."

jq -n '{
  items: [
    {
      key: "blog",
      title: "Launch blog post",
      summary: "Long-form launch narrative for the approved feature.",
      fields: { contentType: "blog" }
    },
    {
      key: "docs",
      title: "Documentation guide",
      summary: "Docs page showing how teams use the feature.",
      fields: { contentType: "docs" }
    },
    {
      key: "tweetstorm",
      title: "Launch tweetstorm",
      summary: "Social thread with concise feature proof points.",
      fields: { contentType: "tweetstorm" }
    }
  ]
}' >"$TMP_DIR/content-breakdown.json"
content_breakdown="$(breakdown_case "$feature_main" "$TMP_DIR/content-breakdown.json")"
require_json "$content_breakdown" '.parentCase.version == 4 and (.items | length == 3 and all(.ok == true))' "Feature breakdown did not create three content pieces."
blog_case="$(jq -r '.items[] | select(.case.requestKey == "content piece:blog") | .case.id' <<<"$content_breakdown")"
docs_case="$(jq -r '.items[] | select(.case.requestKey == "content piece:docs") | .case.id' <<<"$content_breakdown")"
tweet_case="$(jq -r '.items[] | select(.case.requestKey == "content piece:tweetstorm") | .case.id' <<<"$content_breakdown")"
require_json "$(pc_json pipelines case get "$feature_main")" '.stage.key == "producing-content" and .case.version == 4' "Feature should wait in producing-content."

for content_case in "$blog_case" "$docs_case" "$tweet_case"; do
  pc_json pipelines case transition "$content_case" --to content-review --expected-version 1 --reason "Draft is ready for content review." >/dev/null
  pc_json pipelines case review "$content_case" --approve --expected-version 2 >/dev/null
  require_json "$(pc_json pipelines case get "$content_case")" '.stage.key == "break-assets" and .case.version == 3' "Approved content should enter break-assets."
done

break_assets_for_content() {
  local content_case="$1"
  local key="$2"
  local title="$3"
  local asset_type="$4"
  jq -n --arg key "$key" --arg title "$title" --arg assetType "$asset_type" '{
    items: [
      {
        key: $key,
        title: $title,
        summary: "Production asset for the approved content piece.",
        fields: { assetType: $assetType }
      }
    ]
  }' >"$TMP_DIR/assets-$key.json"
  local result asset_case
  result="$(breakdown_case "$content_case" "$TMP_DIR/assets-$key.json")"
  require_json "$result" '.parentCase.version == 4 and (.items | length == 1 and all(.ok == true))' "Content breakdown did not create expected asset."
  asset_case="$(jq -r --arg requestKey "asset:$key" '.items[] | select(.case.requestKey == $requestKey) | .case.id' <<<"$result")"
  require_json "$(pc_json pipelines case get "$content_case")" '.stage.key == "assembling" and .case.version == 4' "Content should wait in assembling after asset breakdown."
  pc_json pipelines case transition "$asset_case" --to asset-review --expected-version 1 --reason "Asset produced for review." >/dev/null
  pc_json pipelines case review "$asset_case" --approve --expected-version 2 >/dev/null
  require_json "$(pc_json pipelines case get "$asset_case")" '.stage.key == "delivered" and .case.terminalKind == "done"' "Asset should be delivered."
  require_json "$(pc_json pipelines case get "$content_case")" '.stage.key == "published" and .case.terminalKind == "done"' "Content parent should publish after asset terminal."
}

break_assets_for_content "$blog_case" "hero-image" "Hero image" "image"
break_assets_for_content "$docs_case" "setup-diagram" "Setup diagram" "diagram"
break_assets_for_content "$tweet_case" "social-card" "Social card" "card"

require_json "$(pc_json pipelines case get "$feature_main")" '.stage.key == "covered" and .case.terminalKind == "done"' "Feature should be covered after all content children are terminal."
require_json "$(pc_json pipelines case get "$release_case_id")" '.stage.key == "shipped" and .case.terminalKind == "done"' "Release should be shipped after feature children are terminal."

rollup="$(pc_json pipelines case rollup "$release_case_id")"
require_json "$rollup" '.complete == true and .done == 7 and .cancelled == 1 and .open == 0 and .total == 8' "Release rollup did not report the expected complete tree."

echo "Release/content pipeline example passed for $RUN_KEY"
echo "Health results:"
jq -s . "$health_results"
echo "Release case: $release_case_id"
echo "Release final stage: $(case_stage "$release_case_id")"
echo "Release rollup:"
jq . <<<"$rollup"
