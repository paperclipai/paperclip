/**
 * Bounds repeated issue wakes that carry no new input and follow successful
 * runs with no issue-visible delivery evidence. This is deliberately stricter
 * than generic run liveness: comments, status churn, and workspace tool calls
 * do not prove that the deliverable moved forward.
 */

export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 2 * 60_000;
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 30 * 60_000;
export const ISSUE_REWAKE_LOOKBACK_MS = 6 * 60 * 60_000;
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

export const THROTTLED_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "assignment_recovery",
  "issue_assignment_recovery",
  "issue_continuation_needed",
  "issue_graph_liveness_backstop",
]);

/**
 * Evidence-bearing actions only. Intentionally excludes `issue.updated`,
 * comments, recovery bookkeeping, and ordinary system activity.
 */
export const ISSUE_EVIDENCE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.attachment_added",
  "issue.thread_interaction_created",
  "issue.monitor_scheduled",
  "issue.approval_linked",
];

/** External input that must always be admitted even if it is not delivery progress. */
export const ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: string[] = [
  "issue.comment_added",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.blockers_resolved_wake_emitted",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.attachment_added",
  "issue.approval_linked",
  "issue.delivery_event_recorded",
  "issue.delivery_legacy_backfilled",
  "issue.external_operation_created",
  "issue.external_operation_updated",
  "issue.external_operation_verified",
];

export function isThrottleCandidateIssueRewake(input: {
  reason: string | null;
  wakeCommentId: string | null;
  forceFreshSession: boolean;
  hasExplicitResume: boolean;
}) {
  if (input.forceFreshSession || input.wakeCommentId || input.hasExplicitResume) return false;
  if (input.reason === null) return true;
  return THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason);
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

export function computeIssueRewakeCooldownMs(noProgressStreak: number) {
  const doublings = Math.max(0, noProgressStreak - ISSUE_REWAKE_NO_PROGRESS_THRESHOLD);
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_REWAKE_BASE_COOLDOWN_MS * factor, ISSUE_REWAKE_MAX_COOLDOWN_MS);
}

export function evaluateIssueRewakeThrottle(input: {
  now: Date;
  recentTerminalRuns: Array<{ id: string; status: string; finishedAt: Date | null }>;
  runIdsWithIssueProgress: ReadonlySet<string>;
  hasNewIssueInputSinceLastRun: boolean;
}): IssueRewakeThrottleDecision {
  if (input.recentTerminalRuns.length === 0 || input.hasNewIssueInputSinceLastRun) {
    return { blocked: false, noProgressStreak: 0 };
  }

  let noProgressStreak = 0;
  for (const run of input.recentTerminalRuns) {
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { blocked: false, noProgressStreak };
  }

  const lastRunFinishedAt = input.recentTerminalRuns[0]?.finishedAt;
  if (!lastRunFinishedAt) return { blocked: false, noProgressStreak };
  const cooldownMs = computeIssueRewakeCooldownMs(noProgressStreak);
  const nextAllowedAt = new Date(lastRunFinishedAt.getTime() + cooldownMs);
  if (input.now < nextAllowedAt) {
    return { blocked: true, noProgressStreak, cooldownMs, lastRunFinishedAt, nextAllowedAt };
  }
  return { blocked: false, noProgressStreak };
}
