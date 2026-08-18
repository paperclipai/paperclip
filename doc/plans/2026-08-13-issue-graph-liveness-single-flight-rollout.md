# Issue graph liveness single-flight rollout

## Purpose

This plan deploys the periodic issue graph liveness fix without editing an installed `npx` cache in place. The change serializes the full periodic recovery chain, gives each dependency-wake census one cursor owner, and emits telemetry that can prove the rollout is healthy.

The rollout is complete only after an authenticated API probe stays responsive during a slow-page test and one full census completes without a repeated page.

## Invariants

- At most one periodic heartbeat recovery invocation is active in one server process.
- An interval that fires during an active pass is skipped. Other scheduler timer work continues.
- A census page owns one immutable `cursorIn`. The next cursor is committed only after that page finishes.
- An empty page after a non-null cursor ends the current census. It does not re-query page zero in the same interval.
- A failed page retains its input cursor for a later retry.
- Targeted workspace-finalization reconciliation does not read or mutate the global census cursor.
- The company run-cap claimers still serialize. Unrelated foreign-key-style company writes must not wait behind that claim lock.

## Pre-deployment gates

1. Merge the reviewed patch through the normal upstream release process.
2. Build an immutable package from the reviewed commit. Record the commit, package version, and SHA-256 manifest.
3. Compare the candidate package with the installed package. Inventory every local production patch before replacement.
4. Confirm that the candidate contains the production company-lock mode and its two concurrency tests:
   - the multi-claimer test proves the company cap remains enforced;
   - the `FOR KEY SHARE` test proves unrelated company writes remain live.
5. Run the server typecheck and the focused tests:

   ```text
   vitest run server/src/lib/scheduler-single-flight.test.ts
   vitest run server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts
   vitest run server/src/__tests__/heartbeat-company-concurrency.test.ts
   ```

6. Run a staging slow-page test with an interval shorter than the injected page delay. Capture structured logs for the active invocation and the skipped interval.
7. Obtain the normal deployment approval. Do not treat a passing build or a matching hash as deployment authorization.

## Deployment

1. Choose an attended maintenance window. Record the live package version, process start time, source hashes for the changed files, and authenticated health latency.
2. Stop the server through its supported service or launcher boundary.
3. Install the immutable candidate package through the supported package path. Do not edit, rename, or partially replace files in the live `npx` cache.
4. Start the server through the same service or launcher boundary.
5. Read back the bound process, package version, process start time, and source hashes. Stop if any value differs from the approved candidate.

## Acceptance probes

Run these checks in order:

1. Confirm that the static health probe and an authenticated API probe both succeed.
2. Confirm that unrelated authenticated issue reads and a disposable non-financial write stay responsive while a slow backstop page runs.
3. Observe at least one complete census. Group telemetry by `censusId` and order it by `pageIndex`.
4. For every census, verify:
   - one active `invocationId` at a time;
   - each `cursorIn` appears once before `censusCompleted=true`;
   - each page's `cursorOut` equals the next page's `cursorIn`;
   - `candidateCount` is at most 500;
   - `companyCount` and `wakeCount` are present;
   - an overlapping tick reports the active invocation and does not start a page.
5. Confirm that heartbeat timer work continues while an overlap is skipped.
6. Run the company run-cap claim tests against the deployed candidate or an executable-identical staging build.
7. Confirm that no authenticated-read starvation, unrelated-write starvation, repeated page, or recovery burst appears during the observation window.

## Telemetry fields

The recovery chain reports `invocationId` and `durationMs`. The dependency-wake backstop reports:

- `invocationId`
- `censusId`
- `pageIndex`
- `cursorIn` and `cursorOut`
- `candidateCount` and `candidateLimitSkipped`
- `companyCount`
- `wakeCount`
- `censusCompleted` and `cursorResetReason`
- `durationMs`

A failed page reports the same identity and cursor fields before cursor commit. An overlapping pass reports the active invocation and its current duration.

## Stop and rollback conditions

Stop or roll back if any of these conditions occurs:

- two periodic recovery invocations overlap;
- a cursor repeats before its census completes;
- a failed page advances the cursor;
- authenticated issue reads or unrelated writes become unresponsive;
- the company claim cap or non-key-write concurrency tests fail;
- the deployed version or file hashes do not match the approved package.

Restore the complete prior immutable package through the supported installer, restart through the launcher, and read back the version and hashes. A restart resets the process-local census cursor to page zero, so verify one fresh census after rollback. Preserve the failed candidate logs and package for review.
