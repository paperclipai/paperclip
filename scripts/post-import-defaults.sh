#!/usr/bin/env bash
#
# post-import-defaults.sh — Apply defaults to agents in a company via JSON input.
#
# Usage:
#   echo '<json>' | ./scripts/post-import-defaults.sh <company-id> [paperclip-url]
#
# Reads a JSON array from stdin with the plan to apply:
#   [
#     {"id": "agent-uuid", "name": "CEO", "model": "claude-opus-4-6", "intervalSec": 30},
#     ...
#   ]
#
# If no stdin is provided (tty), fetches agents and prints them for review.
#
# This script is the executor. Use the /post-import-defaults skill for
# intelligent tier analysis, or pipe your own JSON plan.

set -euo pipefail

COMPANY_ID="${1:?Usage: $0 <company-id> [paperclip-url]}"
BASE_URL="${2:-${PAPERCLIP_API_URL:-http://127.0.0.1:3101}}"
API="${BASE_URL}/api"

if [ -t 0 ]; then
  # No stdin — print current agents for review
  echo "Fetching agents for company ${COMPANY_ID}..."
  curl -sf "${API}/companies/${COMPANY_ID}/agents" | python3 -c "
import json, sys
agents = json.load(sys.stdin)
print(f'Found {len(agents)} agents:\n')
print(f'{\"Name\":35s} {\"Type\":20s} {\"Model\":20s} {\"Heartbeat\":>10s}  {\"SkipPerms\":>9s}')
print('─' * 100)
for a in agents:
    ac = a.get('adapterConfig') or {}
    rc = a.get('runtimeConfig') or {}
    hb = rc.get('heartbeat') or {}
    model = ac.get('model', '(default)')
    interval = f'{hb.get(\"intervalSec\", \"off\")}s' if hb.get('enabled') else 'off'
    skip = str(ac.get('dangerouslySkipPermissions', False))
    print(f'{a[\"name\"]:35s} {a[\"adapterType\"]:20s} {model:20s} {interval:>10s}  {skip:>9s}')
"
  echo ""
  echo "To apply defaults, pipe a JSON plan to this script."
  echo "Or use the /post-import-defaults skill for intelligent analysis."
  exit 0
fi

# Read plan from stdin
PLAN=$(cat)
COUNT=$(echo "$PLAN" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "Applying defaults to ${COUNT} agents..."
echo ""

echo "$PLAN" | python3 -c "
import json, sys, urllib.request

plan = json.load(sys.stdin)
api = '${API}'

for entry in plan:
    agent_id = entry['id']
    name = entry['name']
    model = entry.get('model', 'claude-sonnet-4-6')
    interval = entry.get('intervalSec', 180)
    adapter_type = entry.get('adapterType', 'claude_local')

    patch = {
        'adapterConfig': {
            'dangerouslySkipPermissions': True,
        },
        'runtimeConfig': {
            'heartbeat': {
                'enabled': True,
                'intervalSec': interval,
            }
        }
    }

    # Only set model for claude_local adapters
    if adapter_type == 'claude_local':
        patch['adapterConfig']['model'] = model

    body = json.dumps(patch).encode()
    req = urllib.request.Request(
        f'{api}/agents/{agent_id}',
        data=body, method='PATCH',
        headers={'Content-Type': 'application/json'}
    )
    try:
        resp = json.loads(urllib.request.urlopen(req).read())
        ac = resp.get('adapterConfig') or {}
        rc = resp.get('runtimeConfig') or {}
        hb = rc.get('heartbeat') or {}
        m = ac.get('model', '(default)')
        print(f'  {name:35s} model={m:20s} heartbeat={hb.get(\"intervalSec\",\"?\")}s')
    except Exception as e:
        print(f'  {name:35s} FAILED: {e}', flush=True)
"

echo ""
echo "Done."
