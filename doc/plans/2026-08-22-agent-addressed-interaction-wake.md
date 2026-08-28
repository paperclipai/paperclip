# Agent-addressed interaction wake authorization

## Problem

Creating a pending issue-thread interaction with a named `addresseeAgentId`
queues that agent with `wakeReason: interaction_pending`. If the addressee is
not also the issue assignee (or current review participant), queued-run
staleness invalidation cancels the run as `issue_assignee_changed`. The named
agent therefore never receives the interaction that only it is authorized to
resolve.

## Design

Treat a named pending interaction as a narrow execution authorization, not as
issue ownership. At claim time, read `interactionId` from the queued run context
and verify the backing `issue_thread_interactions` row against the database. The
row must:

- belong to the run's company and issue;
- still have status `pending`; and
- name the run's agent as `addresseeAgentId`.

Only a wake satisfying all of those conditions may bypass the non-assignee and
non-review-participant staleness checks. Context containing only
`wakeReason: interaction_pending` is insufficient, so forged, stale, resolved,
cross-company, cross-issue, and wrong-agent wakes remain rejected.

The authorization is also valid while issue dependencies are blocked: the
addressee must be able to answer the interaction without acquiring the issue's
execution lock or performing issue implementation work. Existing verified
comment-based interaction wakes retain their current behavior.

## Verification

Add embedded-Postgres heartbeat tests proving that a valid named addressee run
executes while wrong-agent, wrong-issue, resolved, and missing-interaction
contexts are cancelled before adapter execution. Run the focused heartbeat
suite, server typecheck, and the repository's required PR-ready checks.
