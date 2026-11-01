# Registered daily-loop disposition

A loop task can remain assigned and `todo` after a successful sweep. Register an active routine with that task as `parentIssueId`.
Use the same company and assignee for the routine and its parent. Add an enabled schedule trigger with a saved `nextRunAt`.
The runtime verifies these records. A title or assigned `todo` does not establish recurrence.

The parent is the persistent loop record. Each scheduled tick creates a child execution task.
Complete each child task after its sweep. An open child can coalesce the next tick under the routine's concurrency policy.
Keep the parent assigned and `todo`. Do not use a one-time monitor as recurrence evidence.

Recovery checks Stop, pause, budget, pending waits, active execution, and owner changes before recurrence.
An abandoned `in_progress` task still enters bounded recovery. A disabled or archived schedule does not establish recurrence.
Summary refresh removes an inherited review wait only after it checks current targets.
Pending interactions, approvals, execution stages, and open work products awaiting review retain the wait.
Callers without verified target state retain the old wait.

## Local verification

Use a source checkout with Node, pnpm, and embedded PostgreSQL support:

```sh
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/plugin-sdk build
node scripts/verify-daily-loop-disposition.mjs
```

The command runs the real classifier and summary builder. Persisted tests use an isolated PostgreSQL database.
They call recovery, summary refresh, and the routine scheduler. They complete a child and execute the next scheduled tick.
They also check repeated recovery, ordinary abandoned tasks, retry exhaustion, and current gates.
The original installed-runtime probe is separate baseline evidence. Keep it unchanged.

## Runtime activation

Source tests do not prove live acceptance. The runtime operator owns activation and live verification.

1. Record the reviewed source commit and the installed `dist/build-info.json` commit.
2. Build and qualify the reviewed revision through the normal release procedure.
3. Obtain authorization for the package change and service restart.
4. Activate that exact build through the operator's normal deployment procedure.
5. Verify the installed build stamp before testing the loop.
6. Register the routine through `POST /api/companies/{companyId}/routines`.
7. Set `parentIssueId`, `assigneeAgentId`, `goalId`, and the approved sweep instructions in the request.
8. Add the approved cadence through `POST /api/routines/{routineId}/triggers`.
9. Use `kind: "schedule"`, `cronExpression`, `timezone`, and `enabled: true`.
10. Preserve the source task's blocker until its acceptance owner permits resumption.
11. Observe two scheduled sweeps and the recovery scan after each completion.
12. Record the source run IDs, scheduled routine run IDs, and observation interval.
13. Check ordinary abandoned work in an isolated acceptance task. Confirm two bounded recovery attempts and exhaustion.

Do not retry an existing recovery action to activate this path. Keep pending decisions and existing control gates.
A recurring routine does not override publication or other task approvals.

## Read-only runtime records

Supply the company, parent task, and observation interval. Use a database account with read-only access.
This query starts a read-only transaction and returns no full run contexts or credentials.

```sh
psql "$READ_ONLY_DATABASE_URL" -X \
  -v company_id="$COMPANY_ID" -v issue_id="$LOOP_ISSUE_ID" \
  -v from_utc="$OBSERVATION_START_UTC" -v until_utc="$OBSERVATION_END_UTC" \
  -f scripts/inspect-daily-loop-runs.sql
```

The first result lists loop and child runs with their linked disposition repairs.
The second result lists scheduled routine runs and the saved next trigger.
Expected: no immediate repair for either completed parent sweep, and a later scheduled child execution.
Record any unexpected repairs. Do not infer acceptance from an empty interval or a missing run.
