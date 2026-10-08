# Bounded liveness recovery

Legacy successful-run continuation is owned by the structured, persisted
`legacyDispositionEpisode` path. Diagnostic prose/liveness labels must not select
another legacy retry policy or replenish that episode. The retained native
compatibility liveness path uses the issue, liveness cause, attempt and latest
useful-output epoch to deduplicate replacement attempts. Documents and work
products count as useful output; commentary and setup events alone do not.

Issue monitors default to three attempts unless an explicit maximum is supplied.
Exhaustion leaves a board-owned blocked disposition only when the atomic update
still has authority over the issue:

- A monitor requires both checkout and execution ownership to be absent. Its
  claim timestamp, monitor date/count, company, assignment and status must still
  match. Clearing monitor state preserves concurrent review policy/state fields.
- A liveness finish may clear only its own checkout/execution pointers or null
  pointers, for its company and unchanged assignee. A newer pointer in either
  column prevents the transition and its exhausted comment/activity effects.
- PostgreSQL evaluates these conditions in the update itself, including after
  waiting on a concurrent owner transaction. A preliminary read is not a fence.

## Retry-lineage migration

`0318_oval_blade.sql` adds
`heartbeat_runs_retry_of_run_id_not_self_check`. Before validation it repairs
legacy self-links in batches of at most 1,000 rows using a temporary partial
index. Valid ancestor references and other run fields are unchanged. The index
is removed after repair. The migration still needs normal deployment review:
index construction and constraint validation scan the table and acquire locks.

The snapshot and journal were regenerated against the upstream migration chain,
not merged by hand. Migration execution remains a deployment action; source and
isolated test validation do not authorize applying it to an operator database.

## Regression coverage

- `liveness-exhaustion.test.ts`: both owner columns, true PostgreSQL row-lock
  contention and predicate recheck, valid exhaustion, replay, tenant and changed
  assignment boundaries.
- `issue-monitor-scheduler.test.ts`: existing owners survive monitor exhaustion;
  no competing wake or exhausted activity is created.
- `legacy-continuation-authority.test.ts`: concurrent causal replay, reconstructed
  service/controller state, persistent episode budgets and owned escalation.
- `retry-lineage-migration.test.ts`: full fresh migration chain, reconstructed
  predecessor schema/journal, more than one repair batch, valid ancestor
  preservation, constraint rejection and production migration-entrypoint replay.

Service reconstruction and reopened clients are not an operating-system crash or
an in-place production upgrade. Native provider execution and full CI remain
separate qualification lanes.
