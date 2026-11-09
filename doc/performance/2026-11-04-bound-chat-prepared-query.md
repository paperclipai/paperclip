# Bound-chat authorization query compilation

`authorizeChatConversationForBoundRun` reads four joined tables to establish the
current endpoint, conversation, delivery and comment binding. It runs in shared
external-review wait and attention-retention paths. In the November 3 staging
sample, this SQL shape accounted for 16.2% of sampled SQL serialization CPU
(32 builds, mean 478.5 microseconds). That share describes SQL serialization,
not total server CPU or request latency.

The service now retains its Drizzle compiled query in a `WeakMap` keyed by the
exact supplied database or transaction object. It creates only the requested
read, `FOR UPDATE`, or `FOR UPDATE NOWAIT` variant. Each execution supplies fresh
company, issue, agent, provider and comment IDs. An `ANY(uuid[])` placeholder
keeps the template count at three per live handle for every comment-list size.
It retains no result or authorization decision. Transactions and nested
savepoints cannot borrow a root query session. Setup, credential, resource and
principal checks still read current state.

## Reproduce

From the source checkout with dependencies and the plugin SDK built:

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs \
  server/scripts/benchmark-bound-chat-authorization.ts \
  --baseline-ref=e54f9fbf828e06e385e0c62dc381ccb46190aa30
```

Use Node 24.22.2 to match this measurement. The command seeds an isolated real
PostgreSQL database and invokes the actual service function. It imports the
baseline module from the supplied Git revision with its relative imports
resolved against the same checkout. It uses one active Slack conversation,
one processed message, a linked member and an enabled destination. It warms
each implementation with 500 successful calls, then alternates order across
seven pairs of 500 successful calls per implementation. Each result is checked.
Query compilation counts are measured separately after all timed rounds.

## Recorded result

Baseline: `e54f9fbf828e06e385e0c62dc381ccb46190aa30`.
Treatment: `8386eb78d118faaf6c2fd7f7471b38c0f4b2ef54`.
Node 24.22.2, macOS arm64, source execution through tsx.

| Metric per 500 calls | Baseline median (range), ms | Treatment median (range), ms | Median change |
| --- | --- | --- | --- |
| Node process CPU | 379.033 (286.092–424.702) | 277.048 (247.341–332.123) | -26.91% |
| Wall time | 742.109 (557.337–901.323) | 648.005 (560.198–662.265) | -12.68% |

CPU improved in all seven matched pairs, by 13.54–33.52%. One wall-time pair
increased by 0.51%. Warm-call SQL compilations fell from five to four: the
joined authorization query no longer recompiles. All database reads still run.

The owning team stopped other builds and tests during this measurement.
Unrelated Rust compilation was observed on the host. Process CPU excludes those
other processes, but shared host contention can affect scheduling, caches and
wall time. This local source-mode fixture does not establish a production
latency improvement, a whole-server CPU reduction, or a deployed result. It
measures repeated calls on one live root handle. A new transaction still pays
its first compilation cost. An alternating measurement does not remove every
host-load effect.

## Correctness and retained setup failures

The focused real PostgreSQL suite passed 17 tests: four new authorization tests
and 13 existing attachment-reuse tests. The new cases exercise changed binding
values and comment arities, duplicate and empty inputs, invalid UUID errors,
company/agent/provider isolation, current setup generation and credential
fingerprints, transaction and savepoint rollback, read mode during a held row
lock, blocking lock timeout and NOWAIT contention.

The first attempt failed before test collection because plugin SDK build output
was absent. Building shared and plugin SDK packages corrected that prerequisite.
Subsequent attempts failed before assertions because the installed embedded
PostgreSQL package lacked version aliases for bundled native libraries. Setting
`DYLD_LIBRARY_PATH` did not fix that child-process setup. Restoring the missing
aliases inside the isolated worktree's dependency directory corrected it; no
repository dependency, lockfile or production source workaround was added.
Those setup failures are not passing behavior evidence. The final 17-test run
passed after the local repair. The benchmark then completed with empty stderr.
