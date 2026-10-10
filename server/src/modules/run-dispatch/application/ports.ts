import type { GateDecision, UpstreamRecoveryEvidence } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

/** A scheduled retry pinned past the bounded backoff ceiling, before any recovery evidence is read. */
export type EarlyUpstreamReprobeCandidate = {
  runId: string;
  companyId: string;
  agentId: string;
  /** Adapter used by the failed predecessor; absent means recovery cannot be proven. */
  adapterType: string | null;
  retryReason: string | null;
  scheduledRetryAt: Date | null;
  pinSetAt: Date | null;
  createdAt: Date;
};

export type EarlyUpstreamReprobeCursor = {
  scheduledRetryAt: Date;
  createdAt: Date;
  runId: string;
};

export type ListEarlyUpstreamReprobeCandidatesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
  after?: EarlyUpstreamReprobeCursor | null;
};

export type FindUpstreamRecoveryEvidenceInput = {
  companyId: string;
  agentId: string;
  adapterType: string;
  now: Date;
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
  listEarlyUpstreamReprobeCandidates(
    input: ListEarlyUpstreamReprobeCandidatesInput,
  ): Promise<EarlyUpstreamReprobeCandidate[]>;
  /** A recent success by the same agent and adapter, if any. */
  findUpstreamRecoveryEvidence(
    input: FindUpstreamRecoveryEvidenceInput,
  ): Promise<UpstreamRecoveryEvidence | null>;
}

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type AdvanceScheduledRetryPinInput = {
  runId: string;
  companyId: string;
  now: Date;
  /** The pin being replaced, recorded on the run's lifecycle event. */
  originalScheduledRetryAt: Date | null;
  /** The successful run that proved the upstream recovered. */
  evidenceRunId: string;
};

export type AdvanceScheduledRetryPinOutcome = { advanced: true } | { advanced: false };

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
};

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  /** Pulls a still-future retry pin forward to `now`; a lost race leaves the pin untouched. */
  advanceScheduledRetryPin(
    input: AdvanceScheduledRetryPinInput,
  ): Promise<AdvanceScheduledRetryPinOutcome>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}
