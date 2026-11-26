# Task-list canonical activity index

The main task list ranks tasks by the greatest task update, comment, or canonical
activity timestamp. The activity subquery used the existing entity index, then
read every activity row for each candidate task. The new B-tree index orders
`(company_id, entity_type, entity_id, created_at)`. PostgreSQL can read backward
until the first activity that passes the existing exclusions.

The task service, conversation-state helper, and authorization helper are
unchanged. Permissions and waiting-conversation filters still run before
pagination. The index preserves raw text entity IDs, company scope, automatic
read-cleanup and local inbox exclusions, null behavior, all sort directions,
priority order, offsets, and one-child-per-parent selection.

## Why this change needs a migration

Query-only alternatives failed a required control. Reusing live conversation
state was neutral on the measured six-Slack-conversation workload: SQL
56.09 to 52.94 ms, service 67.66 to 72.93 ms. Grouping all company activity
improved a broad list but regressed a one-visible-task list from 23.70 to
52.09 ms. A direct join kept the narrow case fast but retained 1,199 history
probes and improved the broad case only 1.14 times. An eligible-ID CTE and
array lookup repaired the narrow case but still touched 67,401 activity buffers
and improved the broad case only 1.06 times. Those rewrites were rejected.

All seven existing activity indexes were inspected. None orders timestamps after
both company and entity equality. The new index permits the original query and
all its filters to stay intact. It does not encode JSON or bound action values
in a partial-index predicate. The ordinary index build was rejected by the
migration safety gate. The final migration uses the existing concurrent-index
runner path and its existing invalid-index retry recovery.

## Local paired query proof

Initial baseline: `71b448b9cb841e6fa18fe883585430c5081245da`. Those query
sources also matched the earlier follow-up base `820c458465fa40137c81fe510f3e6dc573b4f895`.
The reproduction commands now pin `929e840595c8933ca485ac7a2e99413e1e11ca64`
after upstream migrations advanced. Upstream query helpers have changed since
the initial measurements; the historical timings below remain labeled with their
original baseline. This PR leaves the current task service and its helpers
unchanged. Our index is migration `0414_closed_edwin_jarvis.sql`. Both database arms contain
identical synthetic rows. The only physical difference is the new index.
The harness asserts identical generated SQL and parameters. It compares every
positional SQL column in order and the complete real service response outside
the timing interval. It uses two warmups and five alternating measured samples.
Plans are captured outside ordinary timing.

The main fixture has 1,200 tasks, 300,000 activity rows, 7,200 comments,
4,802 runs, 33,810 wakes, and 701 conversations. Six conversations are eligible
Slack conversations, with one waiting; 642 GitHub conversations and 53 removed
Slack conversations are controls. Run contexts are about 27 KiB and contain
incompressible synthetic content. Descriptions include null, short Unicode,
and long Unicode content. The primary query includes the full description
preview, the real unchanged actor-privacy predicate, and canonical activity,
update timestamp, and ID descending order with limit 100. It does not use the
index-only list projection.

Initial paired samples on Docker PostgreSQL 17.11, ordinary Docker storage,
4 MiB work memory, and JIT off:

| Case | SQL median before → after | SQL range before → after | Service median before → after |
| --- | --- | --- | --- |
| Full scoped list, 100 rows | 96.78 → 45.07 ms | 84.44–109.24 → 39.35–49.09 ms | 126.74 → 70.19 ms |
| Same company, one visible task | 10.55 → 12.67 ms | 9.84–12.07 → 10.53–13.58 ms | 19.82 → 20.20 ms |

The primary SQL gain is 2.15 times. Activity work falls from 50 rows per probe
and 63,547 buffer hits to one qualifying row per probe and 4,796 hits. The
one-visible-task SQL median increases 20.1%; this remains within the declared
25% or 2 ms control budget and is retained explicitly.

A later 15-case matrix preserved all positional rows and complete service
responses. Host load reached 364–370 with about 32 GiB swap in use. Those timings
are **inconclusive** and are not the performance claim. The matrix also exposed
a benchmark selector bug that applied the broad 1,000-probe requirement to a
two-ID control; the selector now excludes explicit ID filters.

A local dense-Slack experiment demonstrated JIT overhead, but the hosted target
had zero recorded JIT functions. This index makes no claim that hosted latency
was caused by JIT. SQL, full service timing, and HTTP request timing are separate
claims. No HTTP speedup or deployed improvement has been established.

## Migration cost and recovery

The normal application migrator was exercised on a larger synthetic database:
5,000 tasks, 1.25 million activity rows, 30,000 comments, 20,004 runs, and
140,420 wakes. Activity occupied about 2.19 GB including prior indexes and TOAST.
The new index is 129,163,264 bytes, about 123 MiB. The 300,000-row query fixture
index is about 30 MiB. This is an extra index on every activity write.

The exact concurrent migration completed its first full normal-runner apply,
inspection, journal write, and commit in 2.577 seconds. A simultaneous write
took 5.16 ms and a read took 2.43 ms. A second trial cancelled an actual table
scan after 3,070 of 61,112 blocks. PostgreSQL left an invalid, unjournaled index.
The existing runner removed it and completed retry in 1.892 seconds; concurrent
write/read probes took 7.13/2.76 ms. The valid index was journaled once, and an
applied rerun took 26.8 ms. Deterministic tests also cover concurrent replay,
invalid-index recovery, retained data, and one journal receipt.

These are local timings, including observed host contention. They do not predict
Neon storage or compute performance. The rejected ordinary-build trial blocked
a writer for 1.2–2.0 seconds; the final migration uses `CONCURRENTLY`. No hosted
DDL or deployment was performed.

## Regression and reproduction

The final work assertion fails on the pre-index schema: eight activity rows per
probe exceed the required one qualifying row. The indexed test passes. A real
service oracle checks excluded cleanup and all four inbox actions, foreign
company and malformed/uppercase entity IDs, comments, timestamp ties, ascending,
default and descending order, pagination, permissions, empty results, and
one-child-per-parent selection.

Run the focused tests with the repository's normal PostgreSQL test support:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/task-list-projection-query.test.ts
pnpm --filter @paperclipai/db exec vitest run src/task-list-activity-index-migration.test.ts src/voice-inbound-cleanup-migration.test.ts src/question-response-history-migration.test.ts
```

The query harness is `server/scripts/benchmark-task-list-projection.ts`. It
requires a loopback admin URL in `TASK_PROJECTION_DATABASE_URL` and a disposable
`task_projection_*` database. For a fresh baseline fixture, use `--seed-only
--pre-index`: this applies the normal schema, then removes only this index and
its exact migration receipt before seeding. Existing fixtures use `--reuse`
and are not silently migrated. Set `--fixture-file=/tmp/task-projection.json`
to retain fixture IDs at a known portable path.

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/benchmark-task-list-projection.ts \
  --baseline-ref=929e840595c8933ca485ac7a2e99413e1e11ca64 \
  --db-name=task_projection_base --seed-only --pre-index \
  --fixture-file=/tmp/task-projection.json --count=1200 --chat-count=6 \
  --history=4 --payload-bytes=20480 --activity-per-issue=50 \
  --comments-per-issue=6 --activity-decoys=240000 --description-bytes=4096 --hosted-shape
```

Clone that stopped database to `task_projection_index` with PostgreSQL's normal
`CREATE DATABASE ... TEMPLATE ...` command. Apply its pending migration through
the normal application migrator. Then run an alternating pair:

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/benchmark-task-list-projection.ts \
  --baseline-ref=929e840595c8933ca485ac7a2e99413e1e11ca64 \
  --db-name=task_projection_base --treatment-db-name=task_projection_index \
  --fixture-file=/tmp/task-projection.json --reuse --all-read-modes --jit=off \
  --assert-performance --output=/tmp/task-projection-report.json
```

Use `--quick --full-projection --scoped --read-one` for the one-visible-task
control and `--jit=on` for the compiler control. Reports retain settings,
source hashes, index catalogs, complete samples, SQL, parameters, plans, and
host load. Per-case checkpoints preserve completed work if a later case stops.
The separate root scripts `benchmark-task-activity-index-migration.ts` and
`benchmark-task-activity-index-writes.ts` measure the normal migration and
committed write transactions. Their URLs must also name disposable loopback
`task_projection_*` databases.

The first useful baseline parse, seed, execution, and plan evidence took about
24 seconds. Focused final work red and green loops took 12.16 and 26.29 seconds.
Schema generation and the owning database typecheck/migration gates passed.
Full workspace verification belongs to the final PR head; older discarded
runtime checks are not final-index evidence.
