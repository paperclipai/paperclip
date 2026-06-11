#!/usr/bin/env bash
# opencode-local-model-backfill.sh
#
# Idempotent scan of all opencode_local agents in the company. Reports any
# agent whose adapterConfig.model is missing, empty, or matches the deprecated
# "openai/gpt-5.1-codex-mini" value that the old cheap profile used to inject.
#
# Usage (dry-run, report only):
#   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... ./scripts/opencode-local-model-backfill.sh
#
# Usage (apply — patch empty/deprecated model to DEFAULT_MODEL):
#   DRY_RUN=false DEFAULT_MODEL=lmstudio/meta/llama-3.3-70b \
#     PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... PAPERCLIP_COMPANY_ID=... \
#     ./scripts/opencode-local-model-backfill.sh
#
# The script never changes an agent whose model is already set and is not the
# deprecated value, so re-running is safe.

set -euo pipefail

API_URL="${PAPERCLIP_API_URL:?Must set PAPERCLIP_API_URL}"
API_KEY="${PAPERCLIP_API_KEY:?Must set PAPERCLIP_API_KEY}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:?Must set PAPERCLIP_COMPANY_ID}"
DRY_RUN="${DRY_RUN:-true}"
DEPRECATED_MODEL="openai/gpt-5.1-codex-mini"
DEFAULT_MODEL="${DEFAULT_MODEL:-}"

AUTH_HEADER="Authorization: Bearer ${API_KEY}"

echo "[opencode-local-backfill] Scanning opencode_local agents in company ${COMPANY_ID} (dry_run=${DRY_RUN})"

# Fetch all agents; the list endpoint redacts adapterConfig so we enumerate IDs first
page=1
agent_ids=()
while :; do
  response=$(curl -sf -H "${AUTH_HEADER}" \
    "${API_URL}/api/companies/${COMPANY_ID}/agents?adapterType=opencode_local&page=${page}&pageSize=100" 2>/dev/null || echo "{}")
  ids=$(echo "${response}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
agents = data.get('agents', data.get('items', []))
if not agents:
    sys.exit(0)
for a in agents:
    print(a['id'])
" 2>/dev/null || true)
  [[ -z "${ids}" ]] && break
  while IFS= read -r id; do
    agent_ids+=("${id}")
  done <<< "${ids}"
  # check if there are more pages
  has_more=$(echo "${response}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
agents = data.get('agents', data.get('items', []))
print('true' if len(agents) >= 100 else 'false')
" 2>/dev/null || echo "false")
  [[ "${has_more}" == "true" ]] || break
  page=$((page + 1))
done

echo "[opencode-local-backfill] Found ${#agent_ids[@]} opencode_local agent(s)"

needs_fix=()
for id in "${agent_ids[@]}"; do
  detail=$(curl -sf -H "${AUTH_HEADER}" "${API_URL}/api/agents/${id}" 2>/dev/null || echo "{}")
  model=$(echo "${detail}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
cfg = data.get('adapterConfig') or {}
print(cfg.get('model', '') or '')
" 2>/dev/null || echo "")
  name=$(echo "${detail}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('name', data.get('id', '?')))
" 2>/dev/null || echo "${id}")

  if [[ -z "${model}" || "${model}" == "${DEPRECATED_MODEL}" ]]; then
    echo "[opencode-local-backfill] NEEDS FIX  agent=${id} name=${name} model=${model:-<empty>}"
    needs_fix+=("${id}")
  else
    echo "[opencode-local-backfill] OK         agent=${id} name=${name} model=${model}"
  fi
done

echo ""
echo "[opencode-local-backfill] Summary: ${#needs_fix[@]} agent(s) need attention (missing or deprecated model)"

if [[ "${#needs_fix[@]}" -eq 0 ]]; then
  echo "[opencode-local-backfill] Nothing to do."
  exit 0
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[opencode-local-backfill] DRY_RUN=true — no changes made."
  echo "[opencode-local-backfill] Re-run with DRY_RUN=false DEFAULT_MODEL=<model> to patch."
  exit 0
fi

if [[ -z "${DEFAULT_MODEL}" ]]; then
  echo "[opencode-local-backfill] ERROR: DRY_RUN=false requires DEFAULT_MODEL to be set." >&2
  exit 1
fi

echo "[opencode-local-backfill] Patching ${#needs_fix[@]} agent(s) to model=${DEFAULT_MODEL}"
patched=0
failed=0
for id in "${needs_fix[@]}"; do
  result=$(curl -sf -X PATCH \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d "{\"adapterConfig\":{\"model\":\"${DEFAULT_MODEL}\"}}" \
    "${API_URL}/api/agents/${id}" 2>/dev/null || echo "ERROR")
  if echo "${result}" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('id') else 1)" 2>/dev/null; then
    echo "[opencode-local-backfill] PATCHED    agent=${id}"
    patched=$((patched + 1))
  else
    echo "[opencode-local-backfill] FAILED     agent=${id}" >&2
    failed=$((failed + 1))
  fi
done

echo ""
echo "[opencode-local-backfill] Done: ${patched} patched, ${failed} failed."
[[ "${failed}" -eq 0 ]] || exit 1
