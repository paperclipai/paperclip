#!/usr/bin/env bash
set -euo pipefail

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY must be set}"
PAPERCLIP_COMPANY_ID="${PAPERCLIP_COMPANY_ID:?PAPERCLIP_COMPANY_ID must be set}"
PAPERCLIP_OVERLAY_PATH="${PAPERCLIP_OVERLAY_PATH:-$HOME/Projects/linkcast/crew/paperclip/companies}"
COMPANY_SLUG="${COMPANY_SLUG:-linkcast}"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-paperclip-linkcast-server-1}"

echo "Fetching agents for company ${PAPERCLIP_COMPANY_ID}..."
AGENTS_JSON=$(curl -s -f -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" "${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/agents")

# Use jq to extract the IDs as a space-separated list
AGENT_IDS=$(echo "$AGENTS_JSON" | jq -r '.[].id')

for AGENT_ID in $AGENT_IDS; do
  # Extract the specific agent's data
  AGENT_DATA=$(echo "$AGENTS_JSON" | jq -c ".[] | select(.id == \"${AGENT_ID}\")")
  URL_KEY=$(echo "$AGENT_DATA" | jq -r '.urlKey')
  BUNDLE_MODE=$(echo "$AGENT_DATA" | jq -r '.adapterConfig.instructionsBundleMode // "managed"')
  
  if [[ "$BUNDLE_MODE" == "external" ]]; then
    echo "⏭️  $URL_KEY → already external, skipping"
    continue
  fi

  # Docker paths
  DOCKER_INSTRUCTIONS_PATH="/paperclip/instances/default/companies/${PAPERCLIP_COMPANY_ID}/agents/${AGENT_ID}/instructions/"
  
  # Local paths (assumes companies mount strategy)
  LOCAL_INSTRUCTIONS_PATH="${PAPERCLIP_OVERLAY_PATH}/${COMPANY_SLUG}/agents/${URL_KEY}"
  CONTAINER_INSTRUCTIONS_ROOT="/paperclip/companies/${COMPANY_SLUG}/agents/${URL_KEY}"

  # Check if directory exists in docker and is not empty
  if ! docker exec "$DOCKER_CONTAINER" sh -c "[ -d \"$DOCKER_INSTRUCTIONS_PATH\" ] && [ \"\$(ls -A \"$DOCKER_INSTRUCTIONS_PATH\")\" ]"; then
    echo "⚠️  $URL_KEY → no instructions found in managed bundle, skipping"
    continue
  fi

  # Copy files from Docker container
  mkdir -p "$LOCAL_INSTRUCTIONS_PATH"
  # Use docker cp. DOCKER_INSTRUCTIONS_PATH/. will copy contents of the directory.
  if ! docker cp "$DOCKER_CONTAINER:$DOCKER_INSTRUCTIONS_PATH." "$LOCAL_INSTRUCTIONS_PATH/"; then
    echo "✗ $URL_KEY — FAILED (could not copy files from Docker)"
    continue
  fi

  # Patch the agent via API, merging into existing adapterConfig
  PATCH_DATA=$(echo "$AGENT_DATA" | jq \
    --arg mode "external" \
    --arg root "$CONTAINER_INSTRUCTIONS_ROOT" \
    --arg entry "AGENTS.md" \
    --arg file "$CONTAINER_INSTRUCTIONS_ROOT/AGENTS.md" \
    '{ adapterConfig: (.adapterConfig + { instructionsBundleMode: $mode, instructionsRootPath: $root, instructionsEntryFile: $entry, instructionsFilePath: $file }) }')
  
  if ! curl -s -f -X PATCH -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" -H "Content-Type: application/json" \
    -d "$PATCH_DATA" \
    "${PAPERCLIP_API_URL}/api/agents/${AGENT_ID}" > /dev/null; then
    echo "✗ $URL_KEY — FAILED (API PATCH failed)"
    continue
  fi

  # Verify
  VERIFY_JSON=$(curl -s -f -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" "${PAPERCLIP_API_URL}/api/agents/${AGENT_ID}")
  VERIFY_MODE=$(echo "$VERIFY_JSON" | jq -r '.adapterConfig.instructionsBundleMode')

  if [[ "$VERIFY_MODE" == "external" ]]; then
    echo "✓ $URL_KEY → external ($CONTAINER_INSTRUCTIONS_ROOT)"
  else
    echo "✗ $URL_KEY — FAILED (verification failed, mode is $VERIFY_MODE)"
  fi
done
