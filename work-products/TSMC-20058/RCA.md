# TSMC-20058 RCA — recovery-engine sibling self-close exit

Date: 2026-08-06
Branch: `fix/tsmc-20058-recovery-sibling-self-close`
Base served head at start: `e8929d919` (deploy receipt TSMC-19813 / close-guard)

## CEO hypothesis

> TSMC-17880 patched the self-close-into-blocked contradiction ONLY for recovery kind `missing_disposition`. Guard live rows are now dominated by sibling kinds (`stranded_assigned_issue`, `issue_graph_liveness`) that share the same exit shape.

**Verdict: CONFIRMED (with precise path refinement).**

17880-era behavior for missing-disposition is still kind-gated in two places:

1. `sweepStaleRecoveryActions` candidate SQL only auto-folds by **source status** when `kind = 'missing_disposition'` and status is in `todo|in_review|done|cancelled` (not when source stays `blocked`).
2. `shouldFoldOrDelayMissingDispositionRecovery` **keeps** a missing-disposition action active when the source is still `blocked` (self-created wait is not treated as a valid independent disposition).

Sibling kinds do **not** get that hold. When their recovery **wrapper issue** becomes terminal (`done`/`cancelled`), the same `sweepStaleRecoveryActions` path folds the action as `resolved/restored` for **any** kind via:

```sql
or recoveryIssue.status in ('done', 'cancelled')
```

Pre-fix, that fold left the source `blocked` with:

- no independent unresolved `blockedByIssueIds`, and/or
- only recovery-stamped external-gate prose / `executionPolicy.externalWait` (from `strandedBlockedGatePatch` / `withRecoveryExternalGateDescription`)

…so the enter-blocked 422 never fired on a bare blocker-edge drop, nothing re-fires, and `stranded-recovery-guard.py` stays red.

## (a) Defective exit path

**Primary path (hourly regenerate class)**

| Item | Detail |
|------|--------|
| File | `server/src/services/recovery/service.ts` |
| Function | `sweepStaleRecoveryActions` |
| Pre-fix behavior | On terminal recovery issue: `recoveryActionsSvc.resolveActiveForIssue(... outcome: "restored")` only — no source status release |
| Call site | `reconcileStrandedAssignedIssues` → increments `staleRecoveryActionsFolded` |
| Related kinds | Any kind with `recovery_issue_id` pointing at a now-terminal wrapper — observed: `stranded_assigned_issue`, `issue_graph_liveness` (and would include other wrapper-linked kinds) |

**Secondary path (liveness wrapper cleanup)**

| Item | Detail |
|------|--------|
| File | same |
| Function | `removeRecoveryBlockerFromSource` |
| Pre-fix behavior | Tried bare `blockedByIssueIds` patch; 422 catch released to `todo`. Recovery-stamped external gate made bare patch **succeed**, leaving `status=blocked` with no live owner |

## (b) Why 17880 does not cover siblings

17880 / missing-disposition hardening is **kind-specific**:

- Source-status sweep fold only for `missing_disposition` when source left `in_progress` for a non-blocked disposition.
- Explicit **do-not-fold-while-blocked** branch in `shouldFoldOrDelayMissingDispositionRecovery` for missing-disposition only.

It never generalized “if the recovery wait path went terminal and no independent blockers remain, restore pick-work (`todo`)” to:

- terminal-wrapper sweeps for other kinds, or
- intentional release inside `removeRecoveryBlockerFromSource` when external-gate prose makes 422 unreachable.

TSMC-19842 (board visibility / receipt) is a different class (board-owned actions with null `recovery_issue_id`) and does not fix this self-close exit.

## (c) Fix implemented

Branch commit (this worktree): see `fix-commit.txt` after land.

1. **`releaseSourceAfterTerminalRecoveryIssue`**
   - If source is `blocked` and recovery wrapper is terminal:
     - Drop terminal recovery edge from blockers always when present.
     - If independent unresolved blockers remain → keep `blocked`.
     - Else → `status: todo` + remaining blockers (empty or resolved-only edges filtered by update path).
2. **`sweepStaleRecoveryActions`**
   - Before folding a terminal-recovery-issue action with source `blocked`, call release helper.
   - Counter: `staleRecoverySourcesReleased` (surfaced on reconcile result).
   - Resolution note distinguishes release vs bare fold.
3. **`removeRecoveryBlockerFromSource`**
   - Prefer intentional release to `todo` when no independent unresolved blockers remain, instead of relying on 422.

### Tests

`server/src/__tests__/heartbeat-process-recovery.test.ts`

- releases stranded blocked sources when liveness recovery issue goes terminal (TSMC-20058)
- keeps source blocked when independent unresolved blockers remain (TSMC-20058)

Focused run (this heartbeat):

```text
pnpm exec vitest run src/__tests__/heartbeat-process-recovery.test.ts -t "TSMC-20058|..."
→ 2 passed
```

## (d) Verification plan (live guard)

Guard is report-only:  
`work-products/TSMC-19842/stranded-recovery-guard.py`  
(company copy under Paperclip work-products).

After this SHA is on the **served** tree (`PAPERCLIP_DEPLOY_ROOT` / promote receipt):

1. Wait for at least one stranded reconcile cycle (or trigger platform reconcile if available).
2. Run guard thrice ≥5 minutes apart (or three hourly routine fires):

```bash
python3 work-products/TSMC-19842/stranded-recovery-guard.py
# expect exit 0 and stranded count 0 for the self-close class
```

3. Note: pre-existing **board-owned-no-receipt** rows are TSMC-19842-class residual, not this exit; do not treat those as fail of 20058 unless the stranded blocked+resolved section is non-zero.
4. Baseline pre-fix: `work-products/TSMC-20058/guard-run-pre-deploy.txt` (5 stranded rows).

## Out of scope

- Per-row manual cleanup of historical stranded issues (rows regenerate from the engine defect; release on next sweep after deploy is the systemic fix).
- Unpausing codex_local family (operator scope; parent TSMC-20057).
- Unrelated untracked `server/src/services/live-assignee-resolution.ts` (TSMC-19788) — not part of this fix.
