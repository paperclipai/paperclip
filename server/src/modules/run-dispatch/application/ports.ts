import type { QueuedRunFacts, ScheduledRetryFacts } from "../domain/policy.js";
import type { HeartbeatRunRecord, PostCommitEffect, PromoteScheduledRetryOutcome } from "./types.js";

export type LoadGateFactsInput = {
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  /** The run's own `scheduledRetryReason` column; the fallback source when no override applies. */
  scheduledRetryReason: string | null;
  /** An explicit reason a caller already resolved; takes priority over the context snapshot and the run column. */
  retryReasonOverride?: string | null;
  wakeupRequestId: string | null;
};

export type LoadGateFactsResult =
  | { agentFound: true; facts: ScheduledRetryFacts }
  | { agentFound: false; issueId: string | null };

export type DueRetryRun = {
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  wakeupRequestId: string | null;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

/** Reads the facts a scheduled-retry promotion gate decides on. */
export interface ScheduledRetryReader {
  /**
   * `tx` is an opaque handle to a transaction a caller already opened. Pass
   * it through unchanged when the caller supplies one, so every read this
   * function makes — including the issue row, which the caller locks with
   * `for update` before calling — joins that same transaction; omit it to
   * read against the plain database handle.
   */
  loadGateFacts(input: LoadGateFactsInput, now: Date, tx?: unknown): Promise<LoadGateFactsResult>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
}

export type LoadStalenessFactsInput = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
};

/** Reads the facts a queued-run staleness check decides on. */
export interface QueuedRunReader {
  /**
   * `tx` is an opaque handle to a transaction a caller already opened. Pass
   * it through unchanged when the caller supplies one, so the staleness read
   * joins the caller's own row lock; omit it to read against the plain
   * database handle.
   */
  loadStalenessFacts(
    input: LoadStalenessFactsInput,
    now: Date,
    tx?: unknown,
  ): Promise<QueuedRunFacts>;
}

export type PromoteDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type PromoteDueRetryResult =
  | { applied: true; run: HeartbeatRunRecord; postCommitEffects: PostCommitEffect[] }
  | { applied: false };

export type CancelSuppressedRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
  reason: string;
  errorCode: string;
  issueId: string | null;
  details: Record<string, unknown>;
};

export type CancelSuppressedRetryResult =
  | { applied: true; run: HeartbeatRunRecord }
  | { applied: false };

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  issueId: string;
  wakeupRequestId: string | null;
  reason: string;
  errorCode: string;
  details: Record<string, unknown>;
  /** The run's own `resultJson` column, as the caller last read it; the write merges the stop-reason fields into it. */
  resultJson: unknown;
  /**
   * The run's status right before this cancellation, matched with a
   * compare-and-set. The pre-claim staleness check expects `"queued"`; the
   * final pre-dispatch staleness check, which runs after the run has already
   * claimed, expects `"running"`. A caller must name the phase it is in so a
   * concurrent status change wins the race instead of being overwritten.
   */
  expectedStatus: "queued" | "running";
};

export type CancelStaleQueuedRunWriteResult =
  | { applied: true; run: HeartbeatRunRecord; postCommitEffects: PostCommitEffect[] }
  | { applied: false };

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  scheduledRetryReason: string | null;
  wakeupRequestId: string | null;
  now: Date;
};

/**
 * Writes run-dispatch state. Every method is one semantic operation: it owns
 * every row the operation touches inside one transaction, and every method
 * holds a compare-and-set on the run's current status, so a caller can tell
 * a rejected gate or a stale decision apart from a lost race against a
 * concurrent writer.
 */
export interface RunDispatchWriter {
  promoteDueRetry(input: PromoteDueRetryInput): Promise<PromoteDueRetryResult>;
  cancelSuppressedRetry(input: CancelSuppressedRetryInput): Promise<CancelSuppressedRetryResult>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunWriteResult>;
  /**
   * Reads the scheduled-retry gate facts, decides the gate, and applies the
   * promotion or the cancellation it decides on — all inside one
   * transaction, with the issue row locked for its duration. This is what
   * keeps the decision correct: a concurrent reassignment, pause, or status
   * change on the same issue blocks on the lock instead of landing in the
   * gap between a separate fact read and a separate compare-and-set write.
   */
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
}
