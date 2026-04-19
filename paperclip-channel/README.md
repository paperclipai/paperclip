# paperclip-channel

Channel-driven MCP + HTTP heartbeat shim for claude+ agents (Maya, Nova, Sentinel).
Deployed to `/opt/paperclip-channel/` on each channel-driven LXC.

## Deploy

`paperclip-channel.ts` is copied verbatim to `/opt/paperclip-channel/paperclip-channel.ts`
on each LXC (760=maya, 761=sentinel, 762=nova). Dependencies (`package.json`, `bun.lock`,
`node_modules`) live only on the LXC and are not tracked in this repo.

Smoke-test after deploy: one heartbeat per agent should produce both a
`cost-events` emit and — for skipIssueCreation routines — a `routine_heartbeat`
with the routine's `description` in `content` (not the bare "Heartbeat received" fallback).

## Drift note — 2026-04-18 (SHA-1901)

When editing this file, always diff against the deployed copy before pushing:

```bash
for ct in 760 761 762; do
  ssh proxmox "pct exec $ct -- cat /opt/paperclip-channel/paperclip-channel.ts" > /tmp/channel-$ct.ts
done
diff paperclip-channel.ts /tmp/channel-760.ts
```

The three deployed copies should be identical. If the repo copy is missing
features that are live in prod (as happened with `routineId` / skipIssueCreation
fetch logic in SHA-1865), port them before committing — otherwise a redeploy
from main silently regresses prod.

Required features the repo copy must always carry:
- `routineId` context + `/routines/{id}` fetch for `routine_heartbeat` + skipIssueCreation
- `messageText` context + `message_approved` wake branch (append approved Crisp body)
- `paperclip_create_issue` schema with `status`, `label_ids`, `assignee_agent_id`
- Cost-events JSONL tail diff + `cost-events` notification emit
