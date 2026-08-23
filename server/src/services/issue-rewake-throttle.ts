/**
 * PAP-13775: throttle no-information issue re-wakes.
 *
 * After a process death (or any stall), external drivers — assignment pollers,
 * stranded-issue reconcilers, on-demand invokes — can re-wake the same agent
 * for the same issue every few seconds for as long as the issue stays
 * `in_progress`. When each of those runs ends without changing any
 * issue-visible state, every wake pays a full adapter session for zero new
 * information (the Phase 4 interruption-recovery smoke paid 25 sessions and
 * 2.4x cost for one recovery this way).
 *
 * This module decides when such a wake should be skipped: once an issue has
 * accumulated a streak of consecutive succeeded-but-no-issue-progress runs by
 * the same agent, further event-free wakes are held back for an escalating
 * cooldown anchored to the last run's finish time. Fresh issue activity, an
 * explicit resume, forceFreshSession, and event-carrying wake reasons bypass
 * the throttle. Human comment wakes also bypass it. Agent-authored comment
 * wakes deliberately stay in the normal throttle class so a cross-issue write
 * cannot smuggle human wake privileges.
 *
 * Server-side recovery retries (process-loss retries, missing-comment
 * follow-ups) insert their runs directly and never pass through this gate, so
 * crash recovery stays immediate; only repeated no-op re-invocations slow
 * down.
 */

/** Consecutive no-progress runs required before the cooldown engages.
 * 2026-08-21 recalibration: 2 was set when runs were expensive context-burners;
 * with small oneshot runs it throttled 4,695 wakes in 72h and starved lanes
 * that converge over several short runs. 3 keeps loop protection while
 * allowing one extra attempt before cooldowns engage. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 3;

/** Cooldown after the threshold streak; doubles per additional no-progress run.
 * 2026-08-22 recalibration (operator bulk-drain test): a 25-card bulk kick
 * against a healthy fleet had 15 offers eaten by throttle cooldowns carried
 * over from the narration-run era (that no-progress class is now fixed at
 * source — dispositions honored, 470 corrective runs/day gone). 90s base /
 * 6min cap keeps loop damping while halving how long real work parks. */
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 90_000;

/** Upper bound for the escalating cooldown.
 * 2026-08-21: 30min parked deadline work for half-hour stretches on a machine
 * whose runs finish in 1-3 minutes; 10min still damps loops (2→4→8→10) without
 * writing off a lane's whole window. */
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 6 * 60_000;

/** Only runs newer than this feed the streak; older history is ignored.
 * 2026-08-20: shrunk from 6h to 90min — the churn-era no-progress runs
 * seeded max-cooldown streaks fleet-wide, and a 6h memory kept throttling
 * cards for hours after the machinery that caused the no-progress was
 * fixed (measured: 6 of 12 idle-with-work lanes blanket-throttled at
 * 17:37). A 90min window still catches genuine loops (threshold 2 +
 * exponential cooldown) while letting the system exit a bad era fast. */
export const ISSUE_REWAKE_LOOKBACK_MS = 90 * 60_000;

/** How many recent terminal runs to sample when computing the streak. */
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

/**
 * Wake reasons that assert issue state rather than deliver a new event.
 * These (plus reason-less on-demand invokes) are the only wakes the throttle
 * applies to; every event-shaped reason (comments, mentions, blockers
 * resolved, interactions, approvals, monitors, reviews, …) passes through.
 */
export const THROTTLED_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  "issue_graph_liveness_backstop",
]);

/**
 * Lifecycle echoes that contain no new issue input. Unlike a normal
 * reconciliation poll, these are emitted immediately after a successful run.
 * Re-running an adapter in that gap can only repeat the same terminal state,
 * so one succeeded run without issue-visible progress is enough to suppress
 * the echo. Human comments and explicit continuation/recovery paths remain
 * outside this set.
 */
export const IMMEDIATE_NOOP_LIFECYCLE_WAKE_REASONS: ReadonlySet<string> = new Set([
  "finish_successful_run_handoff",
  "source_scoped_recovery_action",
  "issue_execution_promoted",
  "issue_commented",
]);

/**
 * Activity actions that count as issue-visible progress when attributed to a
 * run. Deliberately narrower than run-liveness "concrete action evidence":
 * tool calls inside the workspace do not move the issue, so they do not reset
 * the streak — a run must leave a comment, mutation, document, work product,
 * interaction, or scheduled continuation behind.
 */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.updated",
  // "issue.comment_added" is deliberately NOT progress. A run that only
  // comments has not moved the issue (Run Disposition Law), and counting it
  // let a comment-per-run loop reset the streak forever: BenchmarkOps posted a
  // "no-op" comment every run and was re-offered every ~5s — 1,680 runs/hr,
  // 5,989 comments on one card (2026-08-22). Comments still count as NEW INPUT
  // below, so a human or another agent commenting after the run wakes it.
  "issue.created",
  "issue.child_created",
  "issue.assigned",
  "issue.released",
  "issue.blockers_updated",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.thread_interaction_created",
  "issue.monitor_scheduled",
  "issue.approval_linked",
];

/**
 * Activity on the issue that counts as new external input since the last run
 * finished — anything a waiting agent should be woken for, including board
 * responses to interactions.
 */
export const ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: string[] = [
  ...ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  "issue.comment_added",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.blockers_resolved_wake_emitted",
];

export interface IssueRewakeCandidateInput {
  reason: string | null;
  wakeCommentId: string | null;
  requestedByActorType?: "user" | "agent" | "system" | null;
  forceFreshSession: boolean;
  hasExplicitResume: boolean;
}

/**
 * Whether a wake is even a candidate for throttling. Wakes that carry new
 * information or an explicit operator escalation always pass.
 */
export function isThrottleCandidateIssueRewake(input: IssueRewakeCandidateInput): boolean {
  if (input.forceFreshSession) return false;
  // Explicit resume is an operator privilege, not an actor-class escape hatch.
  // Agent-authored resume comments remain subject to the normal rewake throttle.
  if (input.hasExplicitResume && input.requestedByActorType !== "agent") return false;
  if (input.wakeCommentId) return input.requestedByActorType === "agent";
  if (input.reason === null) return true;
  return THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason);
}

/** True only for automated lifecycle echoes that add no new task context. */
export function isImmediateNoopLifecycleIssueRewake(input: IssueRewakeCandidateInput & {
  isAutomatedWake: boolean;
}): boolean {
  if (!input.isAutomatedWake) return false;
  if (input.forceFreshSession || input.wakeCommentId || input.hasExplicitResume) return false;
  return input.reason !== null && IMMEDIATE_NOOP_LIFECYCLE_WAKE_REASONS.has(input.reason);
}

/**
 * A successful run that left no issue-visible state cannot be advanced by one
 * of its own lifecycle echoes. Unlike an external poll, this is not a
 * time-based retry: it stays suppressed until real issue input/progress lands,
 * or a failed run creates a recovery path.
 */
export function shouldSuppressImmediateNoopLifecycleRewake(input: IssueRewakeThrottleInput): boolean {
  if (input.hasNewIssueInputSinceLastRun) return false;
  const latestRun = input.recentTerminalRuns[0];
  return Boolean(
    latestRun &&
    latestRun.status === "succeeded" &&
    latestRun.finishedAt &&
    !input.runIdsWithIssueProgress.has(latestRun.id),
  );
}

export interface RecentIssueRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
}

export interface IssueRewakeThrottleInput {
  now: Date;
  /** Terminal runs for the same (agent, issue), newest finish first. */
  recentTerminalRuns: RecentIssueRunSample[];
  /** Runs among the sample that produced issue-visible progress. */
  runIdsWithIssueProgress: ReadonlySet<string>;
  /** New issue input landed after the newest run finished. */
  hasNewIssueInputSinceLastRun: boolean;
}

export type IssueRewakeThrottleDecision =
  | { blocked: false; noProgressStreak: number }
  | {
      blocked: true;
      noProgressStreak: number;
      cooldownMs: number;
      lastRunFinishedAt: Date;
      nextAllowedAt: Date;
    };

export function computeIssueRewakeCooldownMs(noProgressStreak: number): number {
  const doublings = Math.max(0, noProgressStreak - ISSUE_REWAKE_NO_PROGRESS_THRESHOLD);
  // Guard the exponent so an absurd streak can't overflow into Infinity.
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_REWAKE_BASE_COOLDOWN_MS * factor, ISSUE_REWAKE_MAX_COOLDOWN_MS);
}

export function evaluateIssueRewakeThrottle(input: IssueRewakeThrottleInput): IssueRewakeThrottleDecision {
  const runs = input.recentTerminalRuns;
  if (runs.length === 0) return { blocked: false, noProgressStreak: 0 };
  if (input.hasNewIssueInputSinceLastRun) return { blocked: false, noProgressStreak: 0 };

  let noProgressStreak = 0;
  for (const run of runs) {
    // A failed/cancelled/interrupted run breaks the streak: its follow-up is
    // recovery, not a redundant re-poll, and must not be delayed.
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { blocked: false, noProgressStreak };
  }

  const lastRunFinishedAt = runs[0]?.finishedAt;
  if (!lastRunFinishedAt) return { blocked: false, noProgressStreak };

  const cooldownMs = computeIssueRewakeCooldownMs(noProgressStreak);
  const nextAllowedAt = new Date(lastRunFinishedAt.getTime() + cooldownMs);
  if (input.now.getTime() < nextAllowedAt.getTime()) {
    return { blocked: true, noProgressStreak, cooldownMs, lastRunFinishedAt, nextAllowedAt };
  }
  return { blocked: false, noProgressStreak };
}

/* ---------------------------------------------------------------------------
 * Externally-blocked re-poll suppression (2026-08-23)
 *
 * The ladder above is shaped for TIGHT LOOPS: it needs 3 no-progress runs
 * inside a 90-minute lookback and then holds for 90s..6min. Measured on the
 * live fleet, the dominant remaining churn has the opposite shape — a slow
 * drip. 187 issues burned 1,010 completed codex runs in 24h (5.4 each, worst
 * 32) re-deriving a blocker that had not changed, at roughly one run every
 * 4.4 hours. That never accumulates a streak inside a 90-minute window, and a
 * 6-minute cooldown is meaningless at a 4-hour cadence, so the sample is
 * usually EMPTY and the throttle returns "not blocked" immediately.
 *
 * These runs are not wrong — 92.5% name a real external owner (board
 * ratification, a host-side executor, another lane's prerequisite). They are
 * simply re-stating, in fresh prose each time, something nobody has acted on.
 *
 * So: once a run has confirmed an issue is blocked, hold further ASSERTION
 * wakes for hours, escalating while the answer keeps coming back the same.
 * This is deliberately narrow — it only applies to wakes that are already
 * throttle candidates, so every event-shaped wake still passes straight
 * through: blockers resolved, human comments, interactions, approvals,
 * monitors. New issue input also clears it. The issue therefore wakes the
 * instant anything actually changes; what stops is only the re-asking.
 */

/** First hold after a run confirms the issue is blocked. */
export const ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS = 60 * 60_000;

/** Ceiling for the escalating hold — a blocked card is still re-checked daily. */
export const ISSUE_BLOCKED_REPOLL_MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/** How many recent terminal runs to sample when counting the blocked streak. */
export const ISSUE_BLOCKED_REPOLL_SAMPLE_LIMIT = 8;

export function computeBlockedRepollCooldownMs(blockedStreak: number): number {
  const doublings = Math.max(0, blockedStreak - 1);
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS * factor, ISSUE_BLOCKED_REPOLL_MAX_COOLDOWN_MS);
}

export interface BlockedRepollRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
  /** True when this run's recorded disposition was `blocked`. */
  reportedBlocked: boolean;
}

export interface BlockedRepollInput {
  now: Date;
  /** Current issue status; the suppressor only engages while it is `blocked`. */
  issueStatus: string | null;
  /** Terminal runs for the same (agent, issue), newest finish first. */
  recentTerminalRuns: BlockedRepollRunSample[];
  /** New issue input landed after the newest run finished. */
  hasNewIssueInputSinceLastRun: boolean;
}

export type BlockedRepollDecision =
  | { blocked: false; blockedStreak: number }
  | {
      blocked: true;
      blockedStreak: number;
      cooldownMs: number;
      lastRunFinishedAt: Date;
      nextAllowedAt: Date;
    };

export function evaluateBlockedRepollThrottle(input: BlockedRepollInput): BlockedRepollDecision {
  if (input.issueStatus !== "blocked") return { blocked: false, blockedStreak: 0 };
  // Anything new on the issue is exactly the signal worth waking for.
  if (input.hasNewIssueInputSinceLastRun) return { blocked: false, blockedStreak: 0 };

  const runs = input.recentTerminalRuns;
  const latest = runs[0];
  // Only a clean run that actually reported `blocked` earns a hold. A failed or
  // cancelled run is a recovery path and must never be delayed.
  if (!latest || latest.status !== "succeeded" || !latest.finishedAt || !latest.reportedBlocked) {
    return { blocked: false, blockedStreak: 0 };
  }

  let blockedStreak = 0;
  for (const run of runs) {
    if (run.status !== "succeeded" || !run.finishedAt || !run.reportedBlocked) break;
    blockedStreak += 1;
  }

  const cooldownMs = computeBlockedRepollCooldownMs(blockedStreak);
  const nextAllowedAt = new Date(latest.finishedAt.getTime() + cooldownMs);
  if (input.now.getTime() < nextAllowedAt.getTime()) {
    return { blocked: true, blockedStreak, cooldownMs, lastRunFinishedAt: latest.finishedAt, nextAllowedAt };
  }
  return { blocked: false, blockedStreak };
}
