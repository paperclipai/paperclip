/**
 * Bound automatic retries on a single invariant "retry root".
 *
 * Terminal-run recovery, process-loss retries, and continuation-needed wakes
 * each re-drive a failed issue by inserting a *new* heartbeat run with a *new*
 * run/wake id. Every one of those paths carries its own per-lineage counter
 * (`scheduledRetryAttempt`, `processLossRetryCount`, `continuationAttempt`),
 * so no single limiter sees the whole chain. When a run keeps dying for a
 * reason that cannot heal itself (OOM, a permanently misconfigured adapter,
 * an auth wall), the chain retries **forever**: each recovery mints a fresh id
 * that resets the counter it is measured against. A single such chain has been
 * observed producing ~150 runs / 144 consecutive failures at a ~30s median
 * interval, monopolizing a `maxConcurrentRuns: 1` agent so every other wake
 * starves (see paperclipai/paperclip#9734, #7535).
 *
 * This module defines the invariant that closes that gap: a **retry root** —
 * the id of the first run in an automatic retry/recovery lineage, propagated
 * unchanged through every downstream recovery run regardless of which path
 * mints it or what fresh ids it allocates. Automatic runs sharing a root are
 * capped at the first run plus {@link SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES}
 * retries. While waiting between retries the run sits in `scheduled_retry` and
 * holds no concurrency slot; on exhaustion the root is *parked* — no further
 * automatic run, recovery issue, or recovery comment is created, and the last
 * failure reason plus the next owner/action are left operator-visible.
 *
 * A park is not permanent. Genuinely new external input — a human comment, a
 * new issue event, an explicit operator retry, or a monitor signal — opens a
 * new **retry epoch**: the cap is counted per `(root, epoch)`, so a fresh
 * epoch resumes the chain with a clean budget. Recovery-internal wakes (the
 * retry/recovery reasons this module drives) do **not** advance the epoch, so
 * a self-referential recovery loop cannot resurrect its own budget.
 *
 * The functions here are pure and side-effect free; callers supply the counts
 * and reasons they read from the database and apply the returned decisions.
 */

/** First run + this many automatic retries per `(root, epoch)`; a 4th is parked. */
export const SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES = 3;

/** Total automatic runs allowed per `(root, epoch)`: the first run + retries. */
export const SAME_ROOT_AUTOMATIC_RETRY_MAX_RUNS = SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES + 1;

/** Exponential backoff ladder (ms) for same-root retries 1..N, before jitter. */
export const SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS = [
  2 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
] as const;

/** Symmetric jitter applied to each backoff delay: ±25%. */
export const SAME_ROOT_AUTOMATIC_RETRY_JITTER_RATIO = 0.25;

/** Floor for any computed delay so a degenerate ladder entry never busy-loops. */
export const SAME_ROOT_AUTOMATIC_RETRY_MIN_DELAY_MS = 1_000;

/**
 * Wake reasons that continue an existing automatic retry/recovery lineage.
 * A run woken for one of these inherits its source run's epoch, so it counts
 * against the same `(root, epoch)` budget instead of opening a new one. Every
 * other wake reason (human comments, status/blocker/child events, explicit
 * retries, monitor ticks, fresh assignments) is treated as new external input
 * and advances the epoch — see {@link isEpochAdvancingWakeReason}.
 *
 * Defaulting *unknown* reasons to epoch-advancing is deliberate: a stuck root
 * that resumes one extra time is a bounded, self-correcting error, whereas a
 * misclassified recovery reason that advances the epoch would re-open the
 * unbounded loop this module exists to close.
 */
export const AUTOMATIC_RETRY_LINEAGE_WAKE_REASONS: ReadonlySet<string> = new Set([
  "transient_failure_retry",
  "max_turns_continuation_retry",
  "interaction_continuation_infra_retry",
  "execution_review_participant_recovery",
  "process_lost_retry",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  "issue_graph_liveness_backstop",
  "source_scoped_recovery_action",
]);

/**
 * Whether a wake reason represents new external input that should open a fresh
 * retry epoch (resuming a parked root) rather than continuing the automatic
 * lineage. Anything not recognized as recovery-internal advances the epoch.
 */
export function isEpochAdvancingWakeReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return !AUTOMATIC_RETRY_LINEAGE_WAKE_REASONS.has(reason);
}

export interface RetryRootLineageSource {
  /** The source run being retried/recovered from. */
  id: string;
  /** Its root, if it is itself part of a lineage; null for a first run. */
  retryRootRunId: string | null;
  /** Its epoch, if tracked; treated as 0 when absent. */
  retryEpoch: number | null;
}

/**
 * The invariant root id a new automatic run inherits from its source: the
 * source's own root, or — when the source is the first run of a lineage — the
 * source's id. Propagating this at every mint point is what makes the cap
 * immune to fresh run/wake ids.
 */
export function resolveRetryRootRunId(source: RetryRootLineageSource): string {
  return source.retryRootRunId ?? source.id;
}

/**
 * The epoch a new automatic run belongs to. A recovery-internal wake continues
 * the source epoch; new external input advances it by one so the `(root,
 * epoch)` budget resets and a parked root resumes.
 */
export function resolveRetryEpochForNewRun(input: {
  source: RetryRootLineageSource;
  wakeReason: string | null | undefined;
}): number {
  const sourceEpoch = input.source.retryEpoch ?? 0;
  return isEpochAdvancingWakeReason(input.wakeReason) ? sourceEpoch + 1 : sourceEpoch;
}

export type SameRootRetryDecision =
  | {
      allowed: true;
      /** 1-based index of the retry about to be scheduled within this epoch. */
      attempt: number;
      maxRetries: number;
    }
  | {
      allowed: false;
      outcome: "root_retry_cap_exhausted";
      attempt: number;
      maxRetries: number;
    };

/**
 * Decide whether one more automatic retry may be scheduled for a `(root,
 * epoch)`, given how many automatic runs it already holds (the first run plus
 * any retries already created in this epoch). The next retry's 1-based index is
 * the current count; it is allowed while that index stays within the cap.
 */
export function evaluateSameRootRetry(input: {
  /** Automatic runs already persisted for this `(root, epoch)`, incl. the first. */
  priorAutomaticRunCount: number;
  maxRetries?: number;
}): SameRootRetryDecision {
  const maxRetries = Math.max(0, Math.floor(input.maxRetries ?? SAME_ROOT_AUTOMATIC_RETRY_MAX_RETRIES));
  const attempt = Math.max(1, Math.floor(input.priorAutomaticRunCount));
  if (attempt <= maxRetries) {
    return { allowed: true, attempt, maxRetries };
  }
  return { allowed: false, outcome: "root_retry_cap_exhausted", attempt, maxRetries };
}

/**
 * Exponential-backoff delay (with symmetric jitter) for a same-root retry.
 * `attempt` is 1-based; attempts past the ladder reuse its last rung so a
 * caller that raises the cap still gets a bounded, non-zero delay.
 */
export function computeSameRootRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ladder = SAME_ROOT_AUTOMATIC_RETRY_BACKOFF_MS;
  const index = Math.min(Math.max(1, Math.floor(attempt)), ladder.length) - 1;
  const baseDelayMs = ladder[index];
  const sample = Math.min(1, Math.max(0, random()));
  const jitterMultiplier = 1 + ((sample * 2 - 1) * SAME_ROOT_AUTOMATIC_RETRY_JITTER_RATIO);
  return Math.max(SAME_ROOT_AUTOMATIC_RETRY_MIN_DELAY_MS, Math.round(baseDelayMs * jitterMultiplier));
}

export interface SameRootRetryParkInput {
  rootRunId: string;
  epoch: number;
  attempt: number;
  maxRetries: number;
  /** Error code of the run that exhausted the budget, if any. */
  lastErrorCode: string | null;
  /** Human-readable failure detail from the last run, if any. */
  lastErrorMessage: string | null;
  /** Who should look at the parked issue next (e.g. the responsible user/owner). */
  nextOwner: string | null;
}

// A type alias (not an interface) so it stays assignable to the
// `Record<string, unknown>` payload/details shapes the run-event and
// activity-log sinks accept.
export type SameRootRetryPark = {
  status: "parked";
  reason: "root_retry_cap_exhausted";
  rootRunId: string;
  epoch: number;
  attempt: number;
  maxRetries: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextOwner: string | null;
  nextAction: string;
  /** One-line, operator-facing summary safe to surface on the issue. */
  summary: string;
}

/**
 * Build the operator-visible park descriptor recorded when a root exhausts its
 * automatic-retry budget. Callers persist this (and release the agent slot)
 * instead of minting another recovery run/issue/comment; the chain only
 * resumes when new external input advances the epoch.
 */
export function buildSameRootRetryPark(input: SameRootRetryParkInput): SameRootRetryPark {
  const lastFailure = input.lastErrorCode
    ? `\`${input.lastErrorCode}\`${input.lastErrorMessage ? ` — ${input.lastErrorMessage}` : ""}`
    : input.lastErrorMessage ?? "unknown failure";
  const nextAction =
    "Automatic retries are paused. Fix the underlying failure (or reassign/reconfigure the agent), " +
    "then add a comment, retry explicitly, or otherwise deliver new input to resume.";
  const summary =
    `Automatic retry paused after ${input.maxRetries} retries for this run chain ` +
    `(last failure: ${lastFailure}). ${nextAction}`;
  return {
    status: "parked",
    reason: "root_retry_cap_exhausted",
    rootRunId: input.rootRunId,
    epoch: input.epoch,
    attempt: input.attempt,
    maxRetries: input.maxRetries,
    lastErrorCode: input.lastErrorCode,
    lastErrorMessage: input.lastErrorMessage,
    nextOwner: input.nextOwner,
    nextAction,
    summary,
  };
}
