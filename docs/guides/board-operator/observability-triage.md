---
title: Observability Triage
summary: Runbook for high-priority regression and liveness incidents
---

Use this runbook when Paperclip reports a high-priority regression signal, a harness liveness escalation, or an unexpected stuck-task alert.

## First Five Minutes

1. Open the source issue and read the latest system or agent comment.
2. Check the issue status and explicit blockers. If the issue is `blocked`, inspect every blocker before changing ownership.
3. Open the assigned agent's latest run and confirm whether the run ended as `completed`, `advanced`, `blocked`, `needs_followup`, `failed`, `plan_only`, or `empty_response`.
4. Inspect recent activity for `issue.blockers.updated` and `issue.harness_liveness_escalation_created` events.
5. Decide the next owner before commenting: current assignee, escalation assignee, manager, board user, or QA.

## Liveness Escalation Path

The current high-priority signal path is the issue graph liveness recovery flow.

- `server/src/services/recovery/issue-graph-liveness.ts` classifies dependency graph findings such as unresolved blocked issues, invalid review participants, and review issues with no action path.
- `server/src/services/recovery/service.ts` creates or reuses a recovery escalation issue, blocks the original issue on that escalation, comments on the original issue, and writes activity events for auditability.
- `server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts` is the regression suite that verifies blocker updates, escalation comments, and activity log events.

If this path fires correctly, the original issue keeps its existing blockers and gains an additional blocker for the escalation issue. The escalation issue should have a concrete owner and a next action in its description.

## Triage Checklist

- Verify the source issue, recovery target issue, incident key, dependency path, and selected owner in the escalation description.
- Confirm the escalation issue is assigned to an invokable agent. If the agent is paused, terminated, pending approval, or over budget, reassign to that agent's manager.
- If the issue is in review, inspect `executionState.currentParticipant`. A missing, terminated, or paused agent participant is a recovery incident, while a valid user participant is an expected waiting path.
- If the blocker is another issue, prefer first-class `blockedByIssueIds` over a free-text comment.
- If user-facing behavior changed, create or hand off a QA issue with the exact reproduction path and expected state transitions.

## Ownership Handoff

- **Current assignee owns** normal in-progress continuation when a run made durable progress.
- **Escalation assignee owns** resolving the recovery issue created by the liveness flow.
- **Manager owns** budget, pause, terminated-agent, or unclear chain-of-command cases.
- **Board user owns** approval, confirmation, or review decisions where the participant is a user.
- **QA owns** browser or end-to-end verification after a user-facing fix.

Comments should include the observed signal, the chosen owner, the exact unblock action, and the next verification step.

## Instrumentation Gaps

The liveness flow currently records durable activity events and comments, but it does not yet emit dedicated metrics for alerting dashboards. Track these follow-ups when hardening observability:

- Count liveness findings by `findingState`, severity, source issue status, and owner selection reason.
- Count escalation create, reuse, skipped, and race-recovered outcomes.
- Measure time from incident creation to escalation completion.
- Surface repeated incidents for the same recovery leaf as a separate signal from first-time incidents.
