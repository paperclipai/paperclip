import { decideQueuedRunStaleness } from "../domain/policy.js";
import type { StalenessDecision } from "../domain/policy.js";
import type {
  QueuedRunReader,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "./ports.js";
import type {
  CancelStaleQueuedRunOutcome,
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type PromoteScheduledRetryDeps = {
  writer: RunDispatchWriter;
};

export type PromoteScheduledRetryInput = {
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  wakeupRequestId: string | null;
  now?: Date;
};

/**
 * Promotes one due scheduled retry, or cancels it when the gate rejects it.
 * The writer reads the gate facts, decides the gate, and applies the
 * promotion or the cancellation in one transaction with the issue row
 * locked for its duration, so a concurrent reassignment, pause, dependency,
 * or status change on the same issue cannot land between the decision and
 * the write. The write still compares and sets on the run's own status, so
 * a concurrent promoter or canceller on the SAME run can still win the
 * race; that outcome comes back as `not_promoted`, distinct from a rejected
 * gate (`gate_suppressed`).
 */
export function createPromoteScheduledRetry(deps: PromoteScheduledRetryDeps) {
  return async function promoteScheduledRetry(
    input: PromoteScheduledRetryInput,
  ): Promise<PromoteScheduledRetryOutcome> {
    return deps.writer.promoteOrCancelDueRetry({
      runId: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      contextSnapshot: input.contextSnapshot,
      scheduledRetryReason: input.scheduledRetryReason,
      wakeupRequestId: input.wakeupRequestId,
      now: input.now ?? new Date(),
    });
  };
}

export type PromoteDueScheduledRetriesDeps = {
  reader: ScheduledRetryReader;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
};

export type PromoteDueScheduledRetriesInput = {
  now?: Date;
  cutoff: Date | null;
};

const MAX_DUE_RETRIES_PER_SWEEP = 50;

/**
 * Promotes every scheduled retry that is due, in the order it became due,
 * capped at 50 runs per sweep so one sweep cannot grow unbounded.
 */
export function createPromoteDueScheduledRetries(deps: PromoteDueScheduledRetriesDeps) {
  return async function promoteDueScheduledRetries(
    input: PromoteDueScheduledRetriesInput = { cutoff: null },
  ) {
    const now = input.now ?? new Date();
    const dueRuns = (
      await deps.reader.listDueRetries({
        now,
        cutoff: input.cutoff,
        limit: MAX_DUE_RETRIES_PER_SWEEP,
      })
    ).slice(0, MAX_DUE_RETRIES_PER_SWEEP);

    const promotedRunIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];

    for (const dueRun of dueRuns) {
      const result = await deps.promoteScheduledRetry({
        runId: dueRun.runId,
        companyId: dueRun.companyId,
        agentId: dueRun.agentId,
        contextSnapshot: dueRun.contextSnapshot,
        scheduledRetryReason: dueRun.scheduledRetryReason,
        wakeupRequestId: dueRun.wakeupRequestId,
        now,
      });
      if (result.outcome === "promoted") {
        promotedRunIds.push(dueRun.runId);
        postCommitEffects.push(...result.postCommitEffects);
      }
    }

    return {
      promoted: promotedRunIds.length,
      runIds: promotedRunIds,
      postCommitEffects,
    };
  };
}

export type CancelStaleQueuedRunDeps = {
  reader: QueuedRunReader;
  writer: RunDispatchWriter;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  wakeupRequestId: string | null;
  /** The run's own `resultJson` column, as the caller last read it. */
  resultJson: unknown;
  now?: Date;
  /** An opaque handle to a transaction the caller already opened; passed through to the fact read only. */
  tx?: unknown;
  /** The run's status right before this check; see `CancelDecidedStaleQueuedRunInput.expectedStatus`. */
  expectedStatus: "queued" | "running";
};

/**
 * Cancels a queued run that went stale before it could start. The staleness
 * read can join a caller's open transaction (the final dispatch gate reads
 * staleness inside its own row-locked transaction); the cancellation write
 * always runs after that transaction commits, in its own transaction.
 */
export function createCancelStaleQueuedRun(deps: CancelStaleQueuedRunDeps) {
  const cancelDecidedStaleQueuedRun = createCancelDecidedStaleQueuedRun(deps);
  return async function cancelStaleQueuedRun(
    input: CancelStaleQueuedRunInput,
  ): Promise<CancelStaleQueuedRunOutcome> {
    const now = input.now ?? new Date();
    const facts = await deps.reader.loadStalenessFacts(
      {
        runId: input.runId,
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        contextSnapshot: input.contextSnapshot,
        scheduledRetryReason: input.scheduledRetryReason,
      },
      now,
      input.tx,
    );

    const decision = decideQueuedRunStaleness(facts, now);
    if (!decision.stale) return { outcome: "not_stale" };

    return cancelDecidedStaleQueuedRun({
      runId: input.runId,
      companyId: input.companyId,
      issueId: input.issueId,
      wakeupRequestId: input.wakeupRequestId,
      resultJson: input.resultJson,
      expectedStatus: input.expectedStatus,
      decision,
    });
  };
}

export type CancelDecidedStaleQueuedRunDeps = {
  writer: RunDispatchWriter;
};

export type CancelDecidedStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  issueId: string;
  wakeupRequestId: string | null;
  resultJson: unknown;
  decision: Extract<StalenessDecision, { stale: true }>;
  /**
   * The run's status right before this cancellation. The write compares and
   * sets on this value, so a concurrent status change (a claim, a manual
   * cancel, a process-recovery terminal write) wins the race instead of
   * being silently overwritten back to `cancelled`.
   */
  expectedStatus: "queued" | "running";
};

/**
 * Cancels a queued run against a staleness decision a caller already made.
 * The final dispatch gate decides staleness inside its own row-locked
 * transaction, together with a lock check the staleness decision itself does
 * not cover; this use case only performs the write, after that transaction
 * commits. The write itself still compares and sets on `expectedStatus`, so
 * a status change in the gap between that transaction and this write is
 * never lost.
 */
export function createCancelDecidedStaleQueuedRun(deps: CancelDecidedStaleQueuedRunDeps) {
  return async function cancelDecidedStaleQueuedRun(
    input: CancelDecidedStaleQueuedRunInput,
  ): Promise<Extract<CancelStaleQueuedRunOutcome, { outcome: "cancelled" | "lost_race" }>> {
    const cancelled = await deps.writer.cancelStaleQueuedRun({
      runId: input.runId,
      companyId: input.companyId,
      issueId: input.issueId,
      wakeupRequestId: input.wakeupRequestId,
      reason: input.decision.reason,
      errorCode: input.decision.errorCode,
      details: input.decision.details,
      resultJson: input.resultJson,
      expectedStatus: input.expectedStatus,
    });

    if (!cancelled.applied) return { outcome: "lost_race" };

    return {
      outcome: "cancelled",
      run: cancelled.run,
      reason: input.decision.reason,
      errorCode: input.decision.errorCode,
      postCommitEffects: cancelled.postCommitEffects,
    };
  };
}
