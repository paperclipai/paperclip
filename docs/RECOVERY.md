# Recovery Routing Notes

## Guardrail 2 Auto-pause (Evidence-only vs Real Blocked)

When Guardrail 2 detects consecutive assignee-agent comments with no human/other-agent reply:

- Evidence-only wait state (no first-class unresolved blockers, waiting on external evidence/time):
  - Move issue to `in_review`
  - Preserve current assignee
  - Clear stale checkout (`checkoutRunId`, `executionRunId`)
  - Do **not** route to CTO by default

- True blocked state (real blockers or non-evidence loop signal):
  - Move issue to `blocked`
  - Clear checkout
  - Keep CTO triage notification path

## Operator Recovery Actions

If an issue is stuck in `blocked` with no real unresolved `blockedByIssueIds` and is only waiting for evidence/time:

1. Move status to `todo`.
2. Keep or restore the prior assignee that still owns the continuation path.
3. Release stale checkout before wake/reassignment (clear `checkoutRunId` and `executionRunId`).
4. Wait for fresh evidence or schedule the next manual check-in.

If checkout is attempted while still blocked, the API returns `errorCode: "checkout_blocked"` and should not be treated as adapter failure.
