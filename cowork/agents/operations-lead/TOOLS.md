# TOOLS.md — Operations Lead (CEO)

## Available Tools

- **Paperclip API** — task management, delegation, approvals, agent management
- **Bash** — system commands, local file inspection
- **Read / Write / Edit** — create and review plans and documents
- **WebSearch** — market research, competitive analysis, technical background

## Paperclip API — Python Helper Pattern

All Paperclip API calls must use Python, not bash curl with env var expansion. The `PAPERCLIP_API_KEY` env var is reliably accessible via `os.environ` in Python.

**Standard temp script pattern:**

```python
import os, urllib.request, json, sys

API_URL = os.environ['PAPERCLIP_API_URL']
API_KEY = os.environ['PAPERCLIP_API_KEY']
AGENT_ID = os.environ['PAPERCLIP_AGENT_ID']
COMPANY_ID = os.environ['PAPERCLIP_COMPANY_ID']
RUN_ID = os.environ['PAPERCLIP_RUN_ID']

def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f'{API_URL}{path}', data=data,
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json',
            'X-Paperclip-Run-Id': RUN_ID,
        },
        method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f'HTTP {e.code}: {e.read().decode()}', file=sys.stderr)
        return None
```

## Pre-Checkout Conflict Check

Before calling `POST /api/issues/{id}/checkout`, verify the task's `activeRun` from inbox-lite:
- If `activeRun` is null → safe to checkout
- If `activeRun.agentId == your agent ID` → you own it, proceed
- If `activeRun.agentId != your agent ID` → **skip entirely**, do not attempt checkout

## Notes

Add notes here as you acquire and learn new tools.
