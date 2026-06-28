# Paperclip Recovery Actions

This document describes the server-side recovery-action machinery that wakes
an agent or human owner when an issue's state goes stale or its run handoff
is incomplete. The audience is any agent (or human) debugging a recovery arm,
plus engineers extending the recovery subsystem.

The source of truth is the code in `src/services/recovery/` and
`src/services/heartbeat.ts` (call sites). This doc captures the *why* and the
worked examples the code does not.

---

## Recovery kinds

The current implementation arms (or escalates) recovery actions for these
kinds of issue state:

| Kind | Triggered by | Default owner |
|------|--------------|---------------|
| `stranded_assigned_issue` | An issue has been assigned but its assignee has not produced a wake in the staleness window. | issue assignee |
| `successful_run_missing_state` | A heartbeat run completed `succeeded` but the issue is still `in_progress` with no recognized disposition shape. | assignee → VP-Eng → CTO (escalation chain) |
| `workspace_validation_failed` | The issue's workspace could not be validated. | assignee |
| `configuration_incomplete` | The company/issue config is incomplete enough to block heartbeat. | board |

This document focuses on `successful_run_missing_state`, which historically
produced the most false-positive arms (see SOF-334 / SOF-17 round table
below).

---

## `successful_run_missing_state` — disposition-freshness gate (SOF-334)

### The race we are closing

When a heartbeat run completes, the control plane runs a decision function
(`decideSuccessfulRunHandoff` in
`src/services/recovery/successful-run-handoff.ts`) that asks "did the agent
record a valid issue disposition?" If the answer is no, the server arms a
corrective handoff wake that tells the agent (or its escalation owner) to
choose one.

On 2026-06-28 we observed the following false-positive pattern on SOF-17
([PRISM] E4: Tiers + billing + subscriptions) eight times in one day:

| Round | What the agent did | What the control plane saw |
|------:|--------------------|----------------------------|
| 1..4 | Shipped work without status PATCH | `issue.status === "in_progress"`, no disposition shape |
| 5 | Shipped work + PATCHed status | Recovery armed anyway (race) |
| 6 | Posted ack + idempotent PATCH | Recovery armed anyway |
| 7 | Retry-wake minimal-poll (no PATCH) | Recovery armed anyway |
| 8 | Shipped 14 e2e tests + delegated PM sign-off | Recovery armed anyway |

In every case the agent's disposition was correct. The recovery template
"Choose and record a valid issue disposition without copying transcript
content" was misleading — there was no failed run to inspect. Each false
positive consumed ~$0.50 of compute, a VP-Eng wake, and 3-5 minutes of
agent time.

### The fix (Option A — disposition-freshness gate)

Before arming the corrective handoff wake, the decision function checks
whether the agent has *already* recorded a disposition after the run
finished. If yes, the scan-vs-PATCH race has resolved in the agent's favor
and the recovery would be a false positive.

The freshness signal is:

```sql
SELECT 1 FROM issue_comments
WHERE company_id        = $companyId
  AND issue_id          = $issueId
  AND author_agent_id   = $assigneeAgentId
  AND created_at        > $runFinishedAt
  AND (created_by_run_id IS NULL OR created_by_run_id != $runId)
LIMIT 1;
```

The `createdByRunId != runId` clause is essential: comments persisted as
part of the run's bookkeeping flush can have `createdAt` slightly greater
than `finishedAt` but are not evidence of post-run motion. Only comments
authored *after* the run completed by a separate API call count.

### Worked example (SOF-17 round 5)

1. **T=00**:00.000Z — Backend Lead's heartbeat run starts.
2. **T=03**:15.987Z — Backend Lead posts 22 tests + dunning cron.
3. **T=03**:16.102Z — Run process exits. Control plane sets
   `heartbeat_runs.status = 'succeeded'`, `finished_at = T+3:16.102Z`.
4. **T=03**:16.215Z — Backend Lead's exit checklist PATCHes
   `issues.status = 'in_progress'` (idempotent, intended to clear the
   trap from rounds 1-4).
5. **T=03**:16.260Z — Recovery scan runs.
   * Without the gate: scan sees `in_progress`, no disposition shape,
     arms recovery `0fcc3719` against VP-Eng.
   * With the gate: scan sees the agent's
     `issues.updated_at = T+3:16.215Z` > `run.finished_at`, AND any new
     comment after `finishedAt` confirms the agent has already recorded
     its work. Decision = `skip`.

### Test coverage

`src/services/recovery/successful-run-handoff.test.ts` covers three shapes:

* `hasDispositionAfterRunFinished: true` → `skip` with the SOF-334 reason.
* `hasDispositionAfterRunFinished: false` → still arms the recovery
  (pre-disposition scan).
* `hasDispositionAfterRunFinished` omitted (backwards compat) → still arms.
  This protects against accidental fleet-wide suppression if a deployment
  desync omits the new field.

The `heartbeat-process-recovery.test.ts` suite (57 tests) verifies the
gate does not suppress legitimate wakes — including the
`redacts secret-bearing successful-run detected progress before handoff
disclosure` case, which posts a comment via `createdByRunId = run.id`
during the run. The exclusion clause handles that.

### Observability

When the gate suppresses a recovery, the server emits a structured log
event so the false-positive rate can be derived from Loki:

```
event="successful_run_missing_state.suppressed_by_disposition_freshness"
companyId="…" issueId="…" issueIdentifier="…"
sourceRunId="…" runFinishedAt="…"
```

To compute `successful_run_missing_state.false_positive_rate` over a
rolling 24h window:

```promql
sum(rate(log_events{event="successful_run_missing_state.suppressed_by_disposition_freshness"}[24h]))
/
(
  sum(rate(log_events{event="successful_run_missing_state.suppressed_by_disposition_freshness"}[24h]))
  +
  sum(rate(log_events{event="issue.successful_run_handoff_required"}[24h]))
)
```

A fleet-wide rate above 50% for more than 24 hours indicates the gate
itself may be over-suppressing legitimate recoveries and warrants a
review of the `createdByRunId` exclusion clause.

### Out of scope for SOF-334

* Agent-side disposition fix (already done by Backend Lead in round-5
  trap-breaking — necessary but not sufficient).
* Broader recovery-action refactor (separate epic — see SOF-333).
* Per-tenant false-positive auto-suppression above 50% (Option C). The
  signal is emitted; the auto-suppression is a follow-up.

---

## Resolution endpoints

When a recovery action is real (not a false positive), the canonical
resolution path is:

```
POST /api/issues/{id}/recovery-actions/resolve
{
  "outcome": "restored",
  "sourceIssueStatus": "in_progress" | "done" | "in_review" | "blocked",
  "resolutionNote": "<short, structured>"
}
```

`outcome: "false_positive"` and `outcome: "cancelled"` require board
authority. `outcome: "restored"` is the default and works for any agent
acting on its own issue.

`in_review` requires a real reviewer path (pending issue-thread
interaction, linked pending approval, `assigneeUserId` of a human, or
typed `executionState.currentParticipant`). See
`paperclip-team/20260628-010138-…` for the full validation constraints.

---

## Related

* SOF-17 — source signal (E4 epic, 8 rounds of false positives on
  2026-06-28).
* SOF-333 — VP-Eng escalation to control-plane fix.
* SOF-334 — this ticket; disposition-freshness gate.
* `src/services/recovery/successful-run-handoff.ts` — decision function.
* `src/services/heartbeat.ts` — call site (Promise.all + decision call).