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
 *
 * A run whose only issue-visible trace is its own comment is bounded
 * separately (see ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK below): a
 * comment alone resets the streak like any other progress action, but only
 * for a limited number of runs in a row. Without that bound, a heartbeat
 * protocol that always posts a status comment — including a "nothing to
 * report" confirmation — renews its own exemption on every run, so the
 * no-progress streak this module exists to count can never form and the
 * throttle never engages for that agent on that issue.
 */

/** Consecutive no-progress runs required before the cooldown engages. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;

/** Cooldown after the threshold streak; doubles per additional no-progress run. */
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 120_000;

/** Upper bound for the escalating cooldown. */
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 30 * 60_000;

/** Only runs newer than this feed the streak; older history is ignored. */
export const ISSUE_REWAKE_LOOKBACK_MS = 6 * 60 * 60_000;

/** How many recent terminal runs to sample when computing the streak. */
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

/**
 * How many consecutive runs a comment alone can exempt from the no-progress
 * streak before the exemption stops applying. Below the cap, a run whose
 * only issue-visible trace is its own comment behaves exactly like any other
 * progress action (matches a genuine one-off status update). At or above the
 * cap, that run is counted toward the no-progress streak instead, so a
 * protocol that comments on every run cannot hold the throttle open forever.
 * Override with the environment variable of the same name; floor 1.
 */
export function resolveCommentOnlyProgressStreakCap(
  raw: string | undefined,
  fallback = 1,
): number {
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

export const ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK =
  resolveCommentOnlyProgressStreakCap(
    process.env.ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK,
  );

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
 * The one progress action that a run can leave purely by narrating itself: a
 * comment requires no other state to change. Exported so callers that split
 * runIdsWithIssueProgress from runIdsWithCommentOnlyProgress (see
 * ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK) agree with this module on
 * which action that split turns on.
 */
export const ISSUE_COMMENT_ADDED_ACTIVITY_ACTION = "issue.comment_added";

/**
 * Activity actions that count as issue-visible progress when attributed to a
 * run. Deliberately narrower than run-liveness "concrete action evidence":
 * tool calls inside the workspace do not move the issue, so they do not reset
 * the streak — a run must leave a comment, mutation, document, work product,
 * interaction, or scheduled continuation behind.
 */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.updated",
  ISSUE_COMMENT_ADDED_ACTIVITY_ACTION,
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
  /**
   * Runs among the sample whose only issue-visible trace was a comment (no
   * other progress action). Disjoint from runIdsWithIssueProgress: a run
   * that left a comment and some other trace belongs there instead. Bounded
   * by ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK below.
   */
  runIdsWithCommentOnlyProgress: ReadonlySet<string>;
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

  // Measure the leading run of consecutive comment-only "progress" before
  // deciding whether any of it is exempt. A single evaluation only ever sees
  // a fresh slice of an ongoing loop — every run in a self-sustaining storm
  // posts its own comment, so the newest run alone can never distinguish a
  // one-off status update from the 50th repeat. Counting the whole
  // consecutive prefix first makes that distinction possible.
  let leadingCommentOnlyStreak = 0;
  for (const run of runs) {
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    if (!input.runIdsWithCommentOnlyProgress.has(run.id)) break;
    leadingCommentOnlyStreak += 1;
  }
  const commentOnlyGraceExhausted =
    leadingCommentOnlyStreak > ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK;

  let noProgressStreak = 0;
  for (const run of runs) {
    // A failed/cancelled/interrupted run breaks the streak: its follow-up is
    // recovery, not a redundant re-poll, and must not be delayed.
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    const isCommentOnly = input.runIdsWithCommentOnlyProgress.has(run.id);
    if (isCommentOnly && !commentOnlyGraceExhausted) break;
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
