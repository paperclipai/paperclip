import type { Db } from "@paperclipai/db";
import { createPostgresRunDispatchAdapter } from "./adapters/postgres.js";
import {
  createCancelStaleQueuedRun,
  createDispatchResolvedInteractionIfCurrent,
  createEvaluateScheduledRetryGate,
  createPromoteDueScheduledRetries,
  createPromoteScheduledRetry,
} from "./application/use-cases.js";
import type { RunDispatchWriter, ScheduledRetryReader } from "./application/ports.js";

export {
  QUOTA_RECOVERY_RETRY_REASON,
  DEFAULT_QUOTA_RECOVERY_CAP_PER_AGENT,
  DEFAULT_QUOTA_RECOVERY_DECORRELATION_WINDOW_MS,
  decorrelateRetryAt,
  planDueQuotaRecoveryReleases,
} from "./domain/quota-recovery-release.js";
export type {
  DueQuotaRetry,
  ReleaseDecision,
  ReleasePlan,
  AgentReleaseState,
  QuotaRecoveryReleaseReport,
} from "./domain/quota-recovery-release.js";
export {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON,
  AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  WAKE_COMMENT_IDS_KEY,
  RESOLVED_INTERACTION_CONTINUATION_STATUSES,
  isNonAssigneeWorkspaceBusyRetry,
  extractWakeCommentIds,
  deriveCommentId,
  allowsIssueInteractionWake,
  isResolvedInteractionContinuationWakeContext,
} from "./domain/wake-context.js";
export type {
  RetryReasonKind,
  BudgetBlockFacts,
  PauseHoldFacts,
  DependencyBlockFacts,
  DispositionRepairFacts,
  ReviewParticipantFacts,
  ScheduledRetryGateErrorCode,
  GateDecision,
  ScheduledRetryFacts,
  QueuedRunStalenessErrorCode,
  StalenessDecision,
  QueuedRunFacts,
} from "./domain/policy.js";
export type {
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
  CancelStaleQueuedRunOutcome,
} from "./application/types.js";
export { RunDispatchApplicationError } from "./application/types.js";

export type RunDispatchDeps = {
  /** Overrides the Postgres adapter; a test builds its module against a fake instead. */
  adapter?: ScheduledRetryReader & RunDispatchWriter;
};

/**
 * Composes the run-dispatch module: the Postgres adapter and its semantic
 * use cases. `heartbeat.ts` holds the only caller: it builds one
 * instance per process and delegates the scheduled-retry promotion gate and
 * the queued-run staleness gate to it.
 */
export function createRunDispatch(db: Db, deps: RunDispatchDeps = {}) {
  const adapter = deps.adapter ?? createPostgresRunDispatchAdapter(db);

  const promoteScheduledRetry = createPromoteScheduledRetry({
    writer: adapter,
  });

  return {
    evaluateScheduledRetryGate: createEvaluateScheduledRetryGate({ reader: adapter }),
    promoteScheduledRetry,
    promoteDueScheduledRetries: createPromoteDueScheduledRetries({
      reader: adapter,
      promoteScheduledRetry,
      deferScheduledRetry: (input) => adapter.deferScheduledRetry(input),
    }),
    cancelStaleQueuedRun: createCancelStaleQueuedRun({
      writer: adapter,
    }),
    dispatchResolvedInteractionIfCurrent: createDispatchResolvedInteractionIfCurrent({
      writer: adapter,
    }),
  };
}

export type RunDispatch = ReturnType<typeof createRunDispatch>;
