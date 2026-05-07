# Workflow Optimizer: Preflight Blocker Recheck (MON-307)

**Status**: Implemented (code changes committed)
**Date**: 2026-04-26
**Author**: VP Engineering

## Problem

When a blocker issue transitions to `done`, the system sends `issue_blockers_resolved` wakeups to dependents. However, if this wake is missed, delayed, or race-conditioned away, the stale blocker edge persists. Agents then spin-loop on blocked issues whose blockers are already complete. This has occurred at least 6 times (MON-147, MON-156, MON-162, MON-166, MON-306, MON-304).

## Root Cause

The system relied on a single fire-and-forget wake (`issue_blockers_resolved`) to prune stale blocker edges. There was no fallback mechanism to detect and resolve stale blockers when agents attempted to work on blocked issues through other wake paths.

## Solution: Preflight Blocker Recheck

Two injection points that self-heal stale blocker edges:

### 1. claimQueuedRun preflight (heartbeat.ts ~L3460)

Before rejecting a queued run because of unresolved blockers, attempt to prune any that have since become "done". If the prune resolves all blockers, the run can proceed instead of being discarded.

```
if (unresolvedBlockerCount > 0) {
  prunedBlockers = pruneResolvedBlockers(issueId, { agentId: run.agentId })
  if prunedBlockers.removedBlockedByIssueIds.length > 0:
    re-evaluate dependencyReadiness
    log activity with source "heartbeat.preflight_blocker_recheck"
}
```

### 2. Heartbeat wake preflight (heartbeat.ts ~L4870)

Extended the existing blocker prune beyond `issue_blockers_resolved` and `issue_children_completed` wake reasons. For ANY wake on an issue with unresolved blockers, attempt to prune stale edges before proceeding with the heartbeat.

```
if (issueId && issueContext && !resolvedBlockerPruneSource) {
  readiness = listDependencyReadiness(...)
  if (!readiness.isDependencyReady) {
    prunedBlockers = pruneResolvedBlockers(issueId, { agentId: agent.id })
    if prunedBlockers.removedBlockedByIssueIds.length > 0:
      log activity with source "heartbeat.preflight_blocker_recheck"
      refresh issueContext
  }
}
```

## Observability

Both paths log activity with `action: "issue.blockers_updated"` and `source: "heartbeat.preflight_blocker_recheck"`, making it easy to audit how often the fallback mechanism fires vs. the primary `issue_blockers_resolved` wake path.

## Tests Added

Three new tests in `issues-service.test.ts`:
1. `pruneResolvedBlockers removes done blockers and keeps remaining ones` — verifies partial prune (some blockers still active)
2. `pruneResolvedBlockers resolves dependency readiness when all blockers are done` — verifies full prune cleans edges
3. `pruneResolvedBlockers is idempotent when no blockers are done` — verifies no-op when nothing to prune

## Related Issues

- **MON-335** (child): Bug — non-assignee comments on blocked issues trigger automatic reopen. This is a related but distinct systemic issue: the comment-reopen path (`issue_reopened_via_comment` wake) does not distinguish between dependency-blocked and executive-blocked issues. A well-intentioned comment on a CEO/CTO-blocked issue can undo the block decision. MON-335 tracks the fix; it is independent of MON-307's merge.

## Files Changed

- `server/src/services/heartbeat.ts` — Preflight prune in `claimQueuedRun` and heartbeat wake path
- `server/src/__tests__/issues-service.test.ts` — 3 new tests for `pruneResolvedBlockers`