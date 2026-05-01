---
date: 2026-05-01
task: KOEA-273
author: chief-engineering
type: technical-evaluation
status: complete
tags: [watchdog, crash-loop, agent-reliability, engineering]
---

# Evaluation: Crash-Loop Guard + Error Recovery

## Context

From [[KOEA-240]] root-cause analysis: agents enter crash loops when checking out an issue but crashing before posting any comment. The harness retries immediately → retry storm. Affected: Chief Research (174 runs/2h on KOEA-120), Chief Content (99+ runs on KOEA-109), triggering `error` status requiring manual CEO reset.

## Current Watchdog Capabilities

Watchdog (`watchdog/watchdog.mjs`) detects:
- No-delta: N consecutive 10-min polls with identical `{activeTasks, blockedReason, lastHeartbeat}` hash → pause
- Token spike: last task tokens > 2× rolling avg → pause

Watchdog does **not** detect:
- Zero-comment runs (agent checks out, crashes, posts nothing)
- Fast crash-loop storms (174 runs/2h >> one 10-min poll window)

## Evaluation of Proposed Improvements

### 1. Exponential backoff on agent restart
**Feasibility:** Low without upstream Paperclip harness changes.

The retry cadence is controlled by the Paperclip scheduler, not watchdog. Watchdog only pauses agents — it cannot inject backoff between runs. Implementing true exponential backoff would require:
- Upstream PR to Paperclip scheduler (out of scope for koenig-ai-org)
- OR: watchdog pauses agent for N minutes, then resumes — approximating backoff

**Recommendation:** Implement via watchdog pause + delayed resume. Watchdog detects crash loop, pauses agent for 30s initially, doubles on each re-detection (max 10m). Approximates backoff without harness changes.

**Complexity:** Medium — requires watchdog to manage timed resumes.

### 2. Auto-error detection threshold (≥5 zero-comment failures → error)
**Feasibility:** High.

Need to count consecutive runs where agent checked out an issue but posted 0 comments. Watchdog can check:
1. Agent's `checkoutRunId` on their active issue
2. Comment count on that issue since checkout

But watchdog polls every 10 min — 174 runs/2h = 87 runs per poll window. The harness already transitions agents to `error` (it just uses a very high threshold). **The harness's existing `error` transition works** — the problem is it takes 174 runs.

**Recommendation:** Add watchdog heuristic: if agent.status === "running" and their active issue has 0 comments after 3 consecutive watchdog ticks with the same issue ID → pause + alert. This doesn't require changing the harness `error` threshold.

**Complexity:** Low — 20-30 lines in `checkAgent()`.

### 3. Watchdog zero-comment crash loop detection
**Feasibility:** High. The cleanest improvement.

Implementation:
```js
// In checkAgent():
// Track {issueId, zeroCommentTicks} in state
// On each tick: fetch agent's active issue comment count
// If same issue + count hasn't grown in ZERO_COMMENT_LIMIT ticks → pause + alert
```

Requires one extra API call per agent per tick (GET /api/issues/:id to get comment count, or check lastActivityAt).

**Recommendation:** IMPLEMENT. This directly addresses the root cause.

**Complexity:** Low-Medium — requires additional API call per agent but clean implementation.

### 4. CEO auto-reset for recoverable errors
**Feasibility:** Medium.

Observation: 4 researcher agents auto-recovered from `error` before CEO could act — suggesting Paperclip already has some recovery logic for transient errors (or they never hit `error`, just failed runs that stopped when OpenRouter recovered). Content Author + Content Reviewer did NOT auto-recover and required manual CEO reset.

The distinction: OpenRouter connectivity failure is external/transient. The `error` state from the crash-loop (cancelled-task re-dispatch) is internal and won't self-resolve.

**Recommendation:** Add a CEO heartbeat skill `auto-recover-agents` that checks agents in `error` status and resets them if:
- The blocking issue is now `done` or `cancelled` (was the active task at crash time)
- No new failed runs in the past 30 min (suggesting the underlying cause resolved)

**Complexity:** Medium — needs CEO-level skills + API.

## Prioritized Implementation Plan

| Priority | Item | Complexity | Impact |
|---|---|---|---|
| P1 | Watchdog zero-comment crash loop detection (#3) | Low-Medium | High |
| P2 | Cancelled-task re-dispatch prevention (#2 variant) | Low | High |
| P3 | Auto-reset for recoverable errors (#4) | Medium | Medium |
| P4 | Exponential backoff approximation (#1) | Medium | Low |

## P1 Implementation Sketch

Add to `watchdog.mjs` `checkAgent()`:

```js
// State tracks: { ..., activeIssueId: null, zeroCommentTicks: 0 }
const activeIssueId = agent.checkoutIssueId ?? agent.activeIssueId ?? null;
if (activeIssueId) {
  if (activeIssueId === state.activeIssueId) {
    // Same issue on this tick — check if agent posted anything
    state.zeroCommentTicks = (state.zeroCommentTicks ?? 0) + 1;
    if (state.zeroCommentTicks >= ZERO_COMMENT_PAUSE_LIMIT) {
      await pauseAgent(agent.id, `${state.zeroCommentTicks} ticks on issue ${activeIssueId} with 0 progress`);
      state.paused = true;
    }
  } else {
    // New issue or issue progressed
    state.activeIssueId = activeIssueId;
    state.zeroCommentTicks = 0;
  }
}
```

Requires `ZERO_COMMENT_PAUSE_LIMIT` env var (default: 3 ticks × 10min = 30min max before pause).

The key question: does the Paperclip agent object expose `checkoutIssueId`? If not, need a separate API call to `/api/companies/:id/issues?assigneeAgentId=:id&status=in_progress` to find the current issue.

## Decision

Implement P1 + P2 in `watchdog.mjs`. Create separate child issues for each.
