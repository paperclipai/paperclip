import type { GateDecision } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
  /** The release planner caps per agent and scopes by reason, so the sweep has
   * to read both off the row rather than look them up per candidate. */
  agentId: string;
  scheduledRetryAt: Date;
  scheduledRetryReason: string | null;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

export type EvaluateScheduledRetryGateInput = {
  runId: string;
  companyId: string;
  retryReasonOverride: string;
  now: Date;
};

/** Read-only scheduled-retry operations exposed to application use cases. */
export interface ScheduledRetryReader {
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
  /**
   * Per-agent count of `provider_quota_recovery` retries that are queued or
   * running and therefore still competing for the agent's execution slots.
   *
   * Returns `null` when the count could not be read. The caller must treat
   * that as "release nothing": assuming zero in flight would admit releases
   * exactly when the control plane is already degraded.
   */
  countInflightQuotaRecoveryRetries(): Promise<ReadonlyMap<string, number> | null>;
}

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
};

export type DeferScheduledRetryInput = {
  runId: string;
  companyId: string;
  /** The new due time. Must be later than the row's current one. */
  scheduledRetryAt: Date;
  now: Date;
};

export type DeferScheduledRetryOutcome =
  /** The row was still a due `scheduled_retry` and its due time moved. */
  | { deferred: true }
  /** A concurrent writer moved or promoted the row first; leave it alone. */
  | { deferred: false };

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  /**
   * Pushes a due retry's due time forward without changing its status, so a
   * held-back retry is delayed rather than cancelled or lost.
   */
  deferScheduledRetry(input: DeferScheduledRetryInput): Promise<DeferScheduledRetryOutcome>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}
