# Triaging adapter-failure auto-issues

When an agent's adapter fails on two or more consecutive heartbeat runs, the harness
automatically creates an issue with labels `auto-generated` + `adapter-failure`.

## How to identify

- **Labels:** every auto-created issue carries both `auto-generated` and `adapter-failure`.
- **Title pattern:** `Adapter failure: <agent name> (<N> consecutive runs)`.
- **Billing code:** `platform-ops`.
- **Assignee:** the failing agent's manager, falling back to CTO, then CEO. If none resolved, the issue also gets the `unassigned-platform-fallback` label.

## Triage checklist

1. **Check the provider status page.** The issue body links the adapter provider and model. If the provider reports an outage, wait and monitor — the counter resets on the next successful run.

2. **Inspect adapter config + credentials.** Open the linked agent page, review:
   - Is the API key valid and not expired?
   - Is the model identifier correct for the provider?
   - Has the provider deprecated the model?

3. **Try a smoke task.** Assign a trivial issue to the agent. If it succeeds, the failure was transient — close this issue.

4. **Deliberate shutdown?** If the agent was intentionally paused or its adapter removed, cancel this issue (not close — cancel signals "not a real incident").

5. **Escalate.** If the root cause is unclear after steps 1–4, reassign to CTO or the platform-ops team.

## Key log lines

Every hook firing produces a structured log:

```json
{
  "agentId": "...",
  "runId": "...",
  "counter": 2,
  "decision": "create",
  "msg": "adapter-failure-hook"
}
```

Decision values:
- `create` — threshold met, auto-issue created.
- `skipped_idempotent` — threshold met but an open auto-issue already exists.
- `reset` — a successful run cleared the counter.
- `noop` — no action needed (counter below threshold, or non-failure run with counter already at 0).

## Telemetry events

| Event | Type | Dimensions |
|-------|------|-----------|
| `agent.adapter_failure.consecutive_count` | gauge | `agent_id`, `count` |
| `agent.adapter_failure.auto_issue_created` | counter | `agent_id`, `provider` |

## Feature flag

Toggle: **Instance Settings → Experimental → enableAdapterFailureAutoIssue**.

Flip to `false` to disable without restart. The hook checks the flag on every invocation.

## Rollback

Set `enableAdapterFailureAutoIssue` to `false` in instance experimental settings. Existing auto-issues stay open; no new ones will be created. The failure counter continues to update in the background but will not trigger issue creation.
