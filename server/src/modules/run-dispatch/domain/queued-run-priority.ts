/**
 * Pure priority helpers for the heartbeat queued-run comparator.
 *
 * Rank (dependency readiness / in_progress) is applied by the caller before
 * these values. Aging only moves a wake within the priority dimension, so it
 * cannot promote work ahead of rank-0 `in_progress` runs.
 *
 * External contract for the age step: two hours per priority notch, capped at
 * three notches, so a `low` wake reaches critical-equivalent after 6h and then
 * stops climbing. Values are product choices for PER-2366, not derived from a
 * platform constant elsewhere.
 *
 * Aging clock: time spent in the *claimable* queue, not wall-clock since the
 * run row was first created. Scheduled retries keep the original `createdAt`
 * while `promoteDueRetryInTx` bumps `updatedAt` at promotion
 * (`server/src/modules/run-dispatch/adapters/postgres.ts`); using `createdAt`
 * would let retry delay inflate priority the moment the run becomes claimable.
 */

export const QUEUE_PRIORITY_AGE_STEP_MS = 2 * 60 * 60 * 1000;
export const QUEUE_PRIORITY_MAX_AGE_STEPS = 3;

/** Wake reasons whose comment id may bypass a terminal issue status. */
export const TERMINAL_COMMENT_WAKE_REASONS = [
  "issue_comment_mentioned",
  "issue_reopened_via_comment",
  "issue_commented",
] as const;

export type TerminalCommentWakeReason =
  (typeof TERMINAL_COMMENT_WAKE_REASONS)[number];

export type QueueWaitClockFields = {
  createdAt: Date;
  updatedAt: Date;
  /** Non-null when this row was (or still is) a scheduled retry. */
  scheduledRetryAt: Date | null;
};

export type QueuedRunClaimSortFacts = {
  /** 0 = ready+in_progress, 1 = ready, 2 = no issue, 3 = not ready, 4 = terminal demotion */
  readinessRank: number;
  priority: string | null | undefined;
  queueWaitStartedAt: Date;
};

export function issueRunPriorityRank(
  priority: string | null | undefined,
): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

/**
 * Instant the run entered the claimable (`queued`) pool for aging purposes.
 *
 * Fresh wakes: `createdAt` (insert time == first queue entry).
 * Promoted scheduled retries: `updatedAt` (set to promotion time while
 * `createdAt` still reflects the pre-queue wait). Detected via
 * `scheduledRetryAt != null`, which survives promotion.
 */
export function queueWaitStartedAt(run: QueueWaitClockFields): Date {
  if (run.scheduledRetryAt != null) {
    return run.updatedAt;
  }
  return run.createdAt;
}

/**
 * @param queuedSince — claimable-queue entry time from {@link queueWaitStartedAt},
 *   not the run row's original `createdAt` when those differ.
 */
export function agedPriorityRank(
  priority: string | null | undefined,
  queuedSince: Date,
  now: Date = new Date(),
): number {
  const base = issueRunPriorityRank(priority);
  const ageMs = Math.max(0, now.getTime() - queuedSince.getTime());
  const steps = Math.min(
    QUEUE_PRIORITY_MAX_AGE_STEPS,
    Math.floor(ageMs / QUEUE_PRIORITY_AGE_STEP_MS),
  );
  return Math.max(0, base - steps);
}

/**
 * Pure comparator used by `startNextQueuedRunForAgent` after readiness rank is
 * computed. Negative ⇒ left claims first.
 */
export function compareQueuedRunClaimOrder(
  left: QueuedRunClaimSortFacts,
  right: QueuedRunClaimSortFacts,
  now: Date = new Date(),
): number {
  if (left.readinessRank !== right.readinessRank) {
    return left.readinessRank - right.readinessRank;
  }
  const leftPriorityRank = agedPriorityRank(
    left.priority,
    left.queueWaitStartedAt,
    now,
  );
  const rightPriorityRank = agedPriorityRank(
    right.priority,
    right.queueWaitStartedAt,
    now,
  );
  if (leftPriorityRank !== rightPriorityRank) {
    return leftPriorityRank - rightPriorityRank;
  }
  return (
    left.queueWaitStartedAt.getTime() - right.queueWaitStartedAt.getTime()
  );
}

/**
 * Whether a queued run may claim against a done/cancelled issue.
 *
 * `wakeCommentId` alone is not enough: assignment and review wakes often carry
 * a comment id and were burning full slots on closed tickets (PER-2366).
 * Resume intent always wins; otherwise only comment-shaped wake reasons bypass.
 */
export function allowsTerminalStatusBypass(facts: {
  resumeIntent: boolean;
  wakeCommentIdPresent: boolean;
  wakeReason: string | null;
}): boolean {
  if (facts.resumeIntent) return true;
  if (!facts.wakeCommentIdPresent) return false;
  const reason = facts.wakeReason;
  if (reason == null) return false;
  return (TERMINAL_COMMENT_WAKE_REASONS as readonly string[]).includes(reason);
}
