# Production enablement: adapter-failure auto-issue

## Pre-enablement checklist

- [x] Feature flag `enableAdapterFailureAutoIssue` exists in experimental settings
- [x] Hook code landed with structured logging and telemetry
- [x] Idempotency guard prevents duplicate issues per failure sequence
- [x] `clearSlotOnIssueClosed` lifecycle hook resets slot on issue close/cancel
- [x] Runbook merged: `docs/guides/board-operator/adapter-failure-auto-issue-runbook.md`
- [x] Unit tests pass (7/7)

## Enablement steps

1. **Flip flag on.** Instance Settings → Experimental → `enableAdapterFailureAutoIssue` = `true`. No restart required.

2. **Staging smoke test.** Force two consecutive adapter failures on a test agent:
   - Temporarily set the agent's adapter config to an invalid API key or unreachable endpoint.
   - Trigger two heartbeat runs.
   - Confirm exactly one auto-issue appears with labels `auto-generated` + `adapter-failure`.
   - Verify the issue body contains correct run links, agent link, and adapter snapshot.
   - Restore the agent's adapter config.
   - Trigger a successful run; confirm the counter resets (log line with `decision: reset`).
   - Record: staging run IDs and auto-issue identifier.

3. **Production flip.** Set `enableAdapterFailureAutoIssue` = `true` on the production instance.

## 7-day false-positive watch

**Duration:** 7 calendar days from production enablement.

**What to track:**
- Total auto-issues created (telemetry: `agent.adapter_failure.auto_issue_created` counter).
- False positives: auto-issues where the agent recovered on its own within one subsequent run (counter reset immediately after issue creation).
- Issues with `unassigned-platform-fallback` label (indicates assignee resolution failure).

**Success criteria:**
- False-positive rate < 20% of total auto-issues.
- No `unassigned-platform-fallback` issues (all agents have a reachable manager/CTO/CEO).
- No duplicate issues for the same failure sequence (idempotency guard holds).

**Rollback trigger:**
- False-positive rate > 50%, OR
- Duplicate issues appear, OR
- Hook errors in logs (non-idempotency `adapter-failure-hook: failed to create auto-issue`).

**Rollback:** Set `enableAdapterFailureAutoIssue` = `false`. Existing issues stay; no new ones created.
