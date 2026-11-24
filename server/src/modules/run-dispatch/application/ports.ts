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
  /** Rows read per retry-mechanism class, not per sweep. See `listDueRetries`. */
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
  /**
   * Earliest `scheduled_retry` due time across every retry mechanism.
   *
   * `excludeReason` narrows the read to the rows scheduled for another reason.
   * A caller that owes one mechanism a backoff — a degraded quota-recovery
   * sweep, whose parked rows keep their own past due time on purpose — still
   * has to see the retries that mechanism does not gate, otherwise that
   * mechanism's window delays work that never depended on it.
   */
  nextScheduledRetryAt(input: { cutoff: Date | null; excludeReason?: string }): Promise<number | null>;
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  /**
   * Due `scheduled_retry` rows, oldest due time first.
   *
   * `limit` bounds each retry-mechanism class separately, so a parked cohort of
   * one mechanism cannot fill the read and starve the others. A
   * `provider_quota_recovery` cohort is parked exactly when the in-flight count
   * is unreadable: those rows keep their own due time by design, so they sort
   * to the head of every later sweep until the count is readable again.
   */
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
  /**
   * The due time this sweep read for the row, used as a compare-and-set guard.
   * An operator "retry now" moves the due time without leaving
   * `scheduled_retry`, so a status-only guard lets a stale sweep push a row an
   * operator just released back into the future, and the promotion that
   * followed then finds nothing due. When the row's due time no longer matches
   * this value the deferral is skipped instead of winning the race.
   */
  previousScheduledRetryAt: Date;
  now: Date;
};

export type DeferScheduledRetryOutcome =
  /** The row was still a due `scheduled_retry` and its due time moved. */
  | { deferred: true }
  /** A concurrent writer moved or promoted the row first; leave it alone. */
  | { deferred: false };

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  reservationId: string;
  recoveryLeaseOwner?: string;
  enforceContinuationOwnership?: boolean;
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; admissionBlockReason: string }
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
