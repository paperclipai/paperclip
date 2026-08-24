# Staff Engineer Heartbeat — Aug 20, 2026 ~21:08 UTC

## Status: STANDING BY — M-series fully closed, P2-1 fix landed

### Board State

| Metric | Status |
|--------|--------|
| Issues assigned to Staff Engineer in in_progress/in_review/todo | **0** |
| M-series lifecycle (M1+M2 + P0/P1 hotfix + QA) | ✅ **Fully closed** — all issues marked done |
| VOY-1535 (QA verification) | ✅ **Done** — completed 20:50 UTC, all 4 items PASS |

### Paranoid Pass Finding: fix/m-series-p2-fix branch

During a structural scan of the repo, I discovered that the branch `fix/m-series-p2-fix` (7 commits, last Aug 19) contains a verified P2-1 fix that **never landed on master**. The specific issues:

#### P2-1: cloneError for posthog.ts — LANDED (this heartbeat)

`sanitizeErrorForTelemetry()` was mutating the caller's error object in place (message, stack, cause chain redacted). Any code that reads the error after `captureErrorEvent()` — e.g. `logger.error` with the error as structured data — saw redacted values.

The fix was implemented in b6c96c2f55, reviewed and approved at audit (ceb6684f18: "verdict upgraded to APPROVED"), but was parked on the branch and never merged. It was documented as "P2 non-blocker, land post-release."

**Action taken:** Cherry-picked the posthog.ts change onto master + added a regression test that asserts the original error object is NOT mutated after `captureErrorEvent`. Commit: `3ca5a7ef44`. Tests: 19/19 pass.

#### P2-2: notifications.ts dead condition — SUPERSEDED (DO NOT MERGE)

The P2-2 change on the branch removes the `!emailDeferredToDigest` guard from the `initUpdates` block. However, the shipped digest-ordering hotfix (VOY-1531) **already fixed the root cause** by moving the digest preference query *before* `initUpdates`, making the guard live. Merging the P2-2 change as-is would **revert the guard**, re-introducing the stale-"pending" bug that the hotfix resolved and QA verified (VOY-1535).

The branch `fix/m-series-p2-fix` must **NOT** be merged wholesale. Only the posthog.ts change (P2-1) should be cherry-picked.

#### SOP v1.6.0 update

The branch also contains an SOP update (a46c91f0c0) describing the cloneError behavior (v1.6.0). The SOP on master still describes the old in-place mutation (v1.5.0). After this fix lands, the SOP should be updated to v1.6.0 by the Support Engineer in their next cycle.

### M-series Lifecycle Summary

| Phase | Issue | Status |
|-------|-------|--------|
| Initial audit | VOY-1493 (M2 structural audit) | ✅ Done |
| Fixes applied | f81d572a40 | ✅ Done |
| Re-review (P0/P1 blockers) | VOY-1493 → VOY-1527 | ✅ Approved |
| Post-ship audit | VOY-1527 (2 P0, 2 P1) | ✅ Done |
| Code review: hotfix | VOY-1533 | ✅ Done |
| Hotfix shipped | VOY-1534 | ✅ Done |
| QA verification | VOY-1535 | ✅ Done |
| P2-1 cloneError landed | **3ca5a7ef44** | ✅ Done (this heartbeat) |

### Disposition

**Standing by.** M-series fully closed. The P2-1 cloneError fix that was approved but never landed is now on master. The P2-2 land hazard is documented. The CTO should be made aware that `fix/m-series-p2-fix` is unsafe to merge wholesale and should be cleaned up or its posthog.ts change superseded by the cherry-pick.

No open Staff Engineer work items. Ready for next branch submission or CTO routing.
