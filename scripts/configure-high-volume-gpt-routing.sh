#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: configure-high-volume-gpt-routing.sh [--apply] [--agent-id <id>]

Dry-run is the default. --apply is intentionally required because switching the
high-volume Cloud Iterator lane is a Tier-3 model-routing change.

Required environment:
  PAPERCLIP_API_URL
  PAPERCLIP_API_KEY
  PAPERCLIP_COMPANY_ID

Optional environment:
  PAPERCLIP_RUN_ID  Run id for Paperclip mutation attribution
EOF
}

apply=false
agent_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      apply=true
      shift
      ;;
    --agent-id)
      [[ $# -ge 2 ]] || { echo "--agent-id requires a value" >&2; exit 2; }
      agent_id="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for variable in PAPERCLIP_API_URL PAPERCLIP_API_KEY PAPERCLIP_COMPANY_ID; do
  if [[ -z "${!variable:-}" ]]; then
    echo "Missing required environment variable: $variable" >&2
    exit 2
  fi
done

api_url="${PAPERCLIP_API_URL%/}"
auth_header="Authorization: Bearer $PAPERCLIP_API_KEY"

request() {
  curl --fail-with-body --silent --show-error \
    -H "$auth_header" \
    "$@"
}

if [[ -n "$agent_id" ]]; then
  agent_json="$(request "$api_url/api/agents/$agent_id")"
  agent_company_id="$(jq -r '.companyId // empty' <<<"$agent_json")"
  if [[ "$agent_company_id" != "$PAPERCLIP_COMPANY_ID" ]]; then
    echo "Refusing to update agent from company '$agent_company_id'; expected '$PAPERCLIP_COMPANY_ID'." >&2
    exit 1
  fi
else
  agents_json="$(request "$api_url/api/companies/$PAPERCLIP_COMPANY_ID/agents")"
  matches="$(jq '[.[] | select(.name | startswith("Cloud Iterator"))]' <<<"$agents_json")"
  match_count="$(jq 'length' <<<"$matches")"
  if [[ "$match_count" != "1" ]]; then
    echo "Expected exactly one Cloud Iterator agent, found $match_count; pass --agent-id to disambiguate." >&2
    exit 1
  fi
  agent_json="$(jq '.[0]' <<<"$matches")"
fi

current_id="$(jq -r '.id // empty' <<<"$agent_json")"
current_name="$(jq -r '.name // empty' <<<"$agent_json")"
current_adapter="$(jq -r '.adapterType // empty' <<<"$agent_json")"
current_model="$(jq -r '.adapterConfig.model // "(not exposed)"' <<<"$agent_json")"

if [[ -z "$current_id" || -z "$current_name" ]]; then
  echo "Agent response did not contain an id and name." >&2
  exit 1
fi
if [[ "$current_name" != Cloud\ Iterator* ]]; then
  echo "Refusing to update non-Cloud-Iterator agent '$current_name'." >&2
  exit 1
fi
if [[ "$current_adapter" != "codex_local" && "$current_adapter" != "claude_local" ]]; then
  echo "Refusing to update '$current_name': expected codex_local or claude_local, found '$current_adapter'." >&2
  exit 1
fi

desired_payload='{"adapterType":"codex_local","adapterConfig":{"model":"gpt-5.6-luna"}}'

echo "Cloud Iterator: $current_name ($current_id)"
echo "Current adapter/model: $current_adapter / $current_model"
echo "Desired adapter/model: codex_local / gpt-5.6-luna"

if [[ "$apply" != true ]]; then
  echo "Dry-run only. Apply only after this PR is merged and the CEO instruction-file approval is granted (not merely after the review gate); then promote only after three consecutive clean canary runs."
  exit 0
fi

headers=(
  -H "$auth_header"
  -H "Content-Type: application/json"
)
if [[ -n "${PAPERCLIP_RUN_ID:-}" ]]; then
  headers+=(-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID")
fi

updated_json="$(curl --fail-with-body --silent --show-error \
  "${headers[@]}" \
  -X PATCH \
  --data "$desired_payload" \
  "$api_url/api/agents/$current_id")"

jq -e '
  .adapterType == "codex_local" and
  .adapterConfig.model == "gpt-5.6-luna"
' <<<"$updated_json" >/dev/null

echo "Applied and verified: codex_local / gpt-5.6-luna"
