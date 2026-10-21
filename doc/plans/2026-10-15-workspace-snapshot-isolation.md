# Isolate workspace snapshot work from the controller

## Measured problem

A warm native Codex run spent 12.2 seconds capturing an 11,380-entry workspace
baseline. A separate process on the same host produced the exact saved snapshot
hash in 4.3–4.6 seconds. These were separate observation windows; their difference
alone does not establish a controlled performance result.

A local full tracked-tree fixture reproduces controller contention with a fixed
60% main-thread busy load. Alternating inline and worker captures preserves every
entry and hash. The compiled JavaScript implementation reduced the median from
1,511ms to 947ms across three samples of each path, exceeding the declared 30%
reduction criterion. This fixture measures snapshot work, not complete agent
response latency.

## Change boundary

- Move disk-backed native sandbox snapshot capture into at most two concurrent workers.
- Keep legacy adapter snapshot capture inline; worker startup must not enter their
  existing lifecycle deadlines.
- Keep the existing snapshot algorithm, privacy decisions and restore semantics.
- Give each worker a private temporary directory; transfer sealed manifest
  ownership only after successful completion and clean failed captures before
  releasing capacity.
- Preserve in-memory captures and filesystem error codes.
- Keep source-worker loading available in development without requiring a
  development loader for compiled JavaScript workers.

## Finish conditions

Correctness, confinement, cleanup, checkpoint, restore and native recovery tests
must pass, as must full repository validation and current-head PR checks/review.
Then repeat a real warm Codex greeting on the intended staging workspace using
the same model, effort, Daytona provider and isolated Git worktree. Snapshot
benchmarks, passing checks and deployment success do not establish the separate
under-30-second reply objective.
