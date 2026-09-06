import type { QueuedRunFacts, ScheduledRetryFacts } from "../domain/policy.js";
import type { HeartbeatRunRecord, PostCommitEffect } from "./types.js";

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
  loadGateFacts(input: LoadGateFactsInput, now: Date): Promise<LoadGateFactsResult>;
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
};

export type CancelStaleQueuedRunWriteResult = {
  run: HeartbeatRunRecord;
  postCommitEffects: PostCommitEffect[];
};

/**
 * Writes run-dispatch state. Every method is one semantic operation: it owns
 * every row the operation touches inside one transaction. `promoteDueRetry`
 * and `cancelSuppressedRetry` each hold a compare-and-set on the run's
 * current status, so a caller can tell a rejected gate apart from a lost
 * race against a concurrent writer. `cancelStaleQueuedRun` has no such race
 * in its caller today, so it writes unconditionally, matching current
 * behavior.
 */
export interface RunDispatchWriter {
  promoteDueRetry(input: PromoteDueRetryInput): Promise<PromoteDueRetryResult>;
  cancelSuppressedRetry(input: CancelSuppressedRetryInput): Promise<CancelSuppressedRetryResult>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunWriteResult>;
}
