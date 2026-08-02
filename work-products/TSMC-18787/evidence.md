# TSMC-18787 Evidence

Date: 2026-07-31
Run: `0b645168-4fa6-4572-ab43-38cb9a3e0c2c`

## TSKB / process checks

- Dedup/process citations checked before continuing:
  - `TSKB0312 [TSMC] - Issue Lifecycle Gates: Dedup, Process, and KB Discipline - v1.0 - 07-30.md`
  - `TSKB0314 [TSMC] - Quota Exhaustion Must Stop Continuation Retries - v1.0 - 07-30.md`
- No new canonical TSKB delta was required in this heartbeat; the work was an implementation of already-recorded policy.

## Served-tree code change in scope

- `server/src/services/heartbeat.ts`
  - stale queued-run reaper now reuses the full run-gate decision instead of only special-casing concurrency/retry rows
  - queued runs deferred by `outside_activity_window` now keep `retryNotBefore` / `runGateThrottle` state instead of being cancelled as stale
  - queued runs now detect an active provider-quota cooldown from recent same-agent runs and persist a `queuedPolicyDeferral` with `provider_quota` metadata instead of being cancelled
  - both claim-time and reaper-time paths preserve the queued wake payload by leaving the run queued
- `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts`
  - added regression coverage for closed-window queued runs
  - added regression coverage for provider-quota cooldown queued runs
  - both tests assert the run stays `queued`, the wakeup stays `queued`, and the issue does not get pushed into a fake blocked state

## Verification

Command:

```bash
pnpm -C /Users/glad0s/paperclip exec vitest run server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts
```

Observed result:

- `Test Files  1 passed (1)`
- `Tests  31 passed (31)`

## Remaining acceptance not completed in this heartbeat

- 24-hour post-change reap-count comparison against the `27-52/day` baseline
- live proof that a closed-window deferred run resumes when the window opens, quoting the succeeding production run id

Those remaining items require deployment plus observation on the served instance; they are not satisfiable from a local test-only heartbeat.
