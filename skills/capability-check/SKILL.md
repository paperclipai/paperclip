---
name: capability-check
description: >
  Check your actual runtime permissions before attempting task assignment or
  escalation. Use at the start of every heartbeat (after Step 1 identity) to
  read ground-truth capabilities from the API, overriding any stale session
  history or corrections. Complements the core paperclip skill.
---

# Capability Check

Your **session history**, **corrections.md**, and **AGENTS.md** may contain outdated permission information. Permissions change at runtime — grants are added or revoked between heartbeats. The only source of truth is the live API response from `GET /api/agents/me`.

**Rule: never self-censor based on past failures.** If your session history says "Missing permission: tasks:assign" but the API says `canAssignTasks: true`, the API wins. Always check before deciding what you can or cannot do.

## When to Use

- Every heartbeat, immediately after Step 1 (Identity) of the paperclip skill
- Before any task reassignment or delegation attempt
- When you encounter a 403/422 on assignment and need to confirm whether you actually lack permission
- When session history or workspace docs mention permission denials

## Environment Variable (Fastest Path)

Every heartbeat injects `PAPERCLIP_CAN_ASSIGN_TASKS=true` or `PAPERCLIP_CAN_ASSIGN_TASKS=false` into your environment. This is computed server-side from the live permission grants and is authoritative. Check it before making an API call:

```bash
if [ "$PAPERCLIP_CAN_ASSIGN_TASKS" = "true" ]; then
  # You can PATCH assigneeAgentId directly
fi
```

The heartbeat prompt also includes a `## Live Permissions (this heartbeat)` section confirming the same state. If you see it in your prompt, trust it — it supersedes any stale session history.

## Reading Your Capabilities (API Fallback)

The `GET /api/agents/me` response includes an `access` object:

```json
{
  "id": "...",
  "name": "...",
  "role": "engineer",
  "access": {
    "canAssignTasks": true,
    "grants": [
      {
        "permission": "tasks:assign",
        "scope": "company",
        "grantedAt": "2026-04-02T..."
      }
    ]
  }
}
```

Key fields:

| Field | Meaning |
|-------|---------|
| `access.canAssignTasks` | `true` = you can PATCH `assigneeAgentId` directly. `false` = you must escalate. |
| `access.grants` | Full list of granted permissions with scope and timestamp. |

## Assignment Rules

### When `canAssignTasks` is `true`

You MUST reassign directly. Do not escalate, do not post "I don't have permission", do not use workarounds.

```bash
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -d '{
    "assigneeAgentId": "<target-agent-id>",
    "status": "in_review",
    "comment": "Work complete. Reassigning to QA for validation."
  }'
```

### When `canAssignTasks` is `false`

You cannot reassign directly. Instead:

1. Set status to `in_review` (or appropriate status)
2. `@mention` the target agent in a comment (e.g., `@qa-agent please review`)
3. The server's auto-assign logic will attempt to infer the assignment from your mention
4. If auto-assign doesn't fire, escalate to your manager via `chainOfCommand`

## Role Handoff Table

Follow the assignment policy gate rules. These are the permitted role-to-role handoffs:

| Your role | Can reassign to | Typical trigger |
|-----------|----------------|-----------------|
| `engineer` | `qa` | Work complete, needs validation |
| `devops` | `qa` | Infrastructure work complete, needs validation |
| `qa` | `engineer`, `devops` | QA failed, returning for fixes |
| Control-plane (`ceo`, `cto`) | Any role | Manager override |

**Blocked handoffs** (server will reject):

- Same-role lateral transfers (engineer to engineer) — escalate to manager instead
- Any role to control-plane (only control-plane can self-assign control-plane work)

## Status Consistency

When reassigning, match the status to the handoff direction:

| Direction | Expected status |
|-----------|----------------|
| Engineer/Devops to QA | `in_review` |
| QA back to Engineer/Devops | `in_progress` |
| Manager to anyone | Any appropriate status |

The server logs a warning (but does not block) when status doesn't match the handoff direction.

## Stale History Override

**These phrases in your session history or workspace docs are potentially stale and MUST be verified against the API before acting on them:**

- "Missing permission: tasks:assign"
- "tasks:assign denied"
- "tasks:assign blocked"
- "Cannot reassign — permission not granted"
- "Escalate to manager for reassignment"
- "Use comment-only workaround"

If `access.canAssignTasks` is `true` in the current API response, ignore all of the above. They reflect a past state that no longer applies.

## Critical Rules

- **API response is the single source of truth.** Not session history, not corrections.md, not AGENTS.md capability notes.
- **Check capabilities every heartbeat.** Permissions can be granted or revoked between runs.
- **Never post "I lack permission" without first checking the API.** If you haven't called `GET /api/agents/me` this heartbeat, you don't know your permissions.
- **Assignment is not mention.** When `canAssignTasks` is true, you must PATCH `assigneeAgentId` — an @mention alone is insufficient and will leave the issue assigned to you.
- **`in_review` means reassign to QA.** When transitioning to `in_review`, always reassign to the appropriate QA agent. Do not leave yourself as assignee.
- **`blocked` means external dependency.** Only use `blocked` when you cannot proceed due to something outside your control. Do not use it as a substitute for "I think I lack permission."

## Finding the Right Agent to Reassign To

If you need to find the QA agent or another specific agent:

```bash
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq '.[] | select(.role == "qa") | {id, name, status}'
```

Only reassign to agents with `status: "active"` or `status: "idle"`. The server's dispatchability check will reject assignments to paused, errored, or terminated agents.

## Related

- Core heartbeat workflow: **paperclip** skill
- Assignment policy gate details: `CLAUDE.md` (Assignment policy gate section)
- Agent API reference: `skills/paperclip/references/api-reference.md`
