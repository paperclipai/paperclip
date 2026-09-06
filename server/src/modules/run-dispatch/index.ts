import type { Db } from "@paperclipai/db";
import { createPostgresRunDispatchAdapter } from "./adapters/postgres.js";
import {
  createCancelDecidedStaleQueuedRun,
  createCancelStaleQueuedRun,
  createPromoteDueScheduledRetries,
  createPromoteScheduledRetry,
} from "./application/use-cases.js";
import type { QueuedRunReader, RunDispatchWriter, ScheduledRetryReader } from "./application/ports.js";

export { decideScheduledRetryGate, decideQueuedRunStaleness } from "./domain/policy.js";
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
  HeartbeatRunRecord,
  PostCommitEffect,
  PromoteScheduledRetryOutcome,
  CancelStaleQueuedRunOutcome,
} from "./application/types.js";
export { RunDispatchApplicationError } from "./application/types.js";
export type {
  LoadGateFactsInput,
  LoadGateFactsResult,
} from "./application/ports.js";

export type RunDispatchDeps = {
  /** Overrides the Postgres adapter; a test builds its module against a fake instead. */
  adapter?: ScheduledRetryReader & QueuedRunReader & RunDispatchWriter;
};

/**
 * Composes the run-dispatch module: the Postgres adapter and the three
 * semantic use cases. `heartbeat.ts` holds the only caller: it builds one
 * instance per process and delegates the scheduled-retry promotion gate and
 * the queued-run staleness gate to it.
 */
export function createRunDispatch(db: Db, deps: RunDispatchDeps = {}) {
  const adapter = deps.adapter ?? createPostgresRunDispatchAdapter(db);

  const promoteScheduledRetry = createPromoteScheduledRetry({
    reader: adapter,
    writer: adapter,
  });

  return {
    loadGateFacts: adapter.loadGateFacts,
    loadStalenessFacts: adapter.loadStalenessFacts,
    promoteScheduledRetry,
    promoteDueScheduledRetries: createPromoteDueScheduledRetries({
      reader: adapter,
      promoteScheduledRetry,
    }),
    cancelStaleQueuedRun: createCancelStaleQueuedRun({
      reader: adapter,
      writer: adapter,
    }),
    cancelDecidedStaleQueuedRun: createCancelDecidedStaleQueuedRun({
      writer: adapter,
    }),
  };
}

export type RunDispatch = ReturnType<typeof createRunDispatch>;
