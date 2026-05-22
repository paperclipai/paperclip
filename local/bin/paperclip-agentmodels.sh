#!/bin/sh

# Load PAPERCLIP_COMPANY_ID from .env if not set
cd "$(dirname "$0")/../.."
if [ -z "$PAPERCLIP_COMPANY_ID" ] && [ -f .env ]; then
  export PAPERCLIP_COMPANY_ID=$(grep "^PAPERCLIP_COMPANY_ID=" .env | cut -d= -f2 | tr -d '"')
fi

if [ -z "$PAPERCLIP_COMPANY_ID" ]; then
  echo "Error: PAPERCLIP_COMPANY_ID is not set and not found in .env"
  exit 1
fi

./local/bin/paperclip-api.sh GET "/api/companies/${PAPERCLIP_COMPANY_ID}/agents" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if not isinstance(data, list):
    sys.exit(0)

for a in data:
    if not isinstance(a, dict):
        continue
    cfg = a.get('adapterConfig') or {}
    rt = a.get('runtimeConfig') or {}
    cheap = (rt.get('modelProfiles') or {}).get('cheap') or {}
    cheap_model = (cheap.get('adapterConfig') or {}).get('model', 'n/a')
    print(f\"{a.get('name', 'n/a'):20} model={cfg.get('model','')!r:30} cheap={cheap_model!r}\")
"