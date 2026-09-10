import type { ReleaseRecoveryBlockedNoticeKind } from "../domain/policy.js";
import type {
  InvokableAgentSnapshot,
  IssueSnapshot,
  PostCommitEffect,
  ReleaseOutcome,
  RunSnapshot,
  RunSummary,
} from "./types.js";

export type { InvokableAgentSnapshot, IssueSnapshot, RunSnapshot, RunSummary };

/** The primary issue a locked release resolves to, plus the finishing run the lock step already loaded. */
export type LockedIssueExecution = {
  primaryIssue: IssueSnapshot;
  run: RunSnapshot;
};

export type ReleaseTransactionResult = {
  outcome: ReleaseOutcome;
  postCommitEffects: PostCommitEffect[];
};

/** Read-only lookups the release use case needs, each scoped to a company. */
export interface WakeQueueReader {
  findInvokableAgent(input: { companyId: string; agentId: string }): Promise<InvokableAgentSnapshot | null>;
  /**
   * Takes the transaction-scoped issue snapshot, not an issue id, so this
   * port never re-reads the issue on a separate connection while the
   * module's own transaction is open.
   */
  resolveResponsibleUserId(input: {
    companyId: string;
    contextSnapshot: Record<string, unknown>;
    issue: IssueSnapshot;
    /** From a prior `getRoutineEnv` call against the same issue; pass `{ routineId: null, env: null, responsibleUserId: null }` when the issue is not a routine execution. */
    routineEnvContext: { routineId: string | null; env: unknown; responsibleUserId: string | null };
    requestedByActorType: "user" | "agent" | "system" | null;
    requestedByActorId: string | null;
    source: string;
    triggerDetail: string | null;
    existingRunResponsibleUserId: string | null;
  }): Promise<string | null>;
  /**
   * Takes the transaction-scoped issue snapshot, not an issue id, so this
   * port never re-reads the issue on a separate connection while the
   * module's own transaction is open.
   */
  getRoutineEnv(input: {
    companyId: string;
    issue: IssueSnapshot;
  }): Promise<{ routineId: string | null; env: unknown; responsibleUserId: string | null }>;
  resolveSessionBeforeForWakeup(input: {
    companyId: string;
    agentId: string;
    taskKey: string | null;
  }): Promise<string | null>;
}

export type DeferredWakeCandidate = {
  id: string;
  companyId: string;
  agentId: string;
  reason: string | null;
  source: string | null;
  triggerDetail: string | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  payload: Record<string, unknown>;
  /** The queued comment ids the wake's queued-comment context carries, already extracted from the payload. */
  queuedCommentIds: string[];
  /** True when the wake carries an independent reason to continue even with no live queued comments. */
  preservesIndependentContinuation: boolean;
  /** `payload._paperclipWakeContext`, already parsed to a plain object. */
  deferredContextSeed: Record<string, unknown>;
  /** The comment ids the wake's context snapshot carries (a separate set from queuedCommentIds), used for the reopen check. */
  deferredCommentIds: string[];
  wakeReason: string | null;
};

export type PromoteDeferredWakeInput = {
  companyId: string;
  wakeId: string;
  deferredAgent: InvokableAgentSnapshot;
  issue: IssueSnapshot;
  finishingRun: RunSnapshot;
  contextSnapshot: Record<string, unknown>;
  reason: string;
  source: string;
  triggerDetail: string | null;
  payload: Record<string, unknown>;
  responsibleUserId: string;
  sessionBefore: string | null;
  now: Date;
};

/** The transaction-scoped write operations that drain and resolve the deferred-wake queue. */
export interface WakeQueueWriter {
  claimNextDeferredWake(input: { companyId: string; issueId: string }): Promise<DeferredWakeCandidate | null>;
  getQueuedCommentLiveness(input: {
    companyId: string;
    issueId: string;
    wakeAgentId: string;
    finishingRunId: string;
    finishingRunAgentId: string;
    queuedCommentIds: string[];
  }): Promise<{ liveNonSelfCommentIds: string[]; containedSelfAuthoredComment: boolean }>;
  /** Cancels the wake with `status = 'deferred_issue_execution'` as an atomic compare-and-set guard. */
  cancelDeferredWake(input: {
    companyId: string;
    wakeId: string;
    reason: string;
    now: Date;
  }): Promise<boolean>;
  normalizeDeferredWakeCommentIds(input: {
    companyId: string;
    wakeId: string;
    /** The wake's current payload, as already read by `claimNextDeferredWake`, used as the rewrite base. */
    payload: Record<string, unknown>;
    liveCommentIds: string[];
    now: Date;
  }): Promise<DeferredWakeCandidate | null>;
  /** Sets `status = 'failed'` guarded by the current `deferred_issue_execution` status. */
  failDeferredWake(input: { companyId: string; wakeId: string; now: Date }): Promise<boolean>;
  getPauseHoldFacts(input: {
    companyId: string;
    issueId: string;
    wakeAgentId: string;
    deferredContextSeed: Record<string, unknown>;
    requestedByActorType: string | null;
    requestedByActorId: string | null;
  }): Promise<{
    activePauseHold: boolean;
    treeHoldInteractionWake: boolean;
    holdId: string | null;
    rootIssueId: string | null;
    mode: string | null;
    reason: string | null;
    releasePolicy: unknown;
  }>;
  getCommentSelfAuthorship(input: {
    companyId: string;
    issueId: string;
    finishingRunId: string;
    commentIds: string[];
  }): Promise<{ allSelfAuthored: boolean }>;
  reopenIssue(input: { companyId: string; issueId: string; runId: string }): Promise<IssueSnapshot | null>;
  /**
   * Atomically claims the wake for promotion, guarded on its current
   * `deferred_issue_execution` status. Call this before any other write in
   * the promotion path (including a reopen), so a lost race here can never
   * leave another write committed underneath it. Returns `false` when a
   * concurrent writer already changed the wake's status.
   */
  claimDeferredWakeForPromotion(input: { companyId: string; wakeId: string; now: Date }): Promise<boolean>;
  /**
   * Finalizes a wake that `claimDeferredWakeForPromotion` already claimed:
   * inserts the queued run, links it back onto the wake row, and takes the
   * issue's execution lock. Call only after that claim returns `true`.
   */
  finalizePromotedWake(input: PromoteDeferredWakeInput): Promise<RunSummary>;
  /** An open run already on this issue (optionally scoped to one agent) that would race a new recovery run. */
  hasExistingExecutionPath(input: {
    companyId: string;
    issueId: string;
    excludeRunId: string;
    agentId: string | null;
  }): Promise<boolean>;
  /** An open, non-hidden issue that still lists this issue as a `blocks` predecessor. */
  hasExplicitBlockerPath(input: { companyId: string; issueId: string }): Promise<boolean>;
  isAutomaticRecoverySuppressedByPauseHold(input: { companyId: string; issueId: string }): Promise<boolean>;
  /** Builds the stranded-recovery notice content for a `blocked` outcome; pure formatting, kept behind the writer so `services/recovery/stranded-notice` stays out of the application layer. */
  buildBlockedRecoveryNotice(input: {
    noticeKind: ReleaseRecoveryBlockedNoticeKind;
    issueStatus: "todo" | "in_progress";
    finishingRun: RunSnapshot;
  }): Promise<{ notice: Record<string, unknown>; recoveryCause: string | null }>;
  queueReviewParticipantRecoveryRun(input: {
    companyId: string;
    issue: IssueSnapshot;
    finishingRun: RunSnapshot;
    recoveryAgent: InvokableAgentSnapshot;
    sessionBefore: string | null;
    now: Date;
  }): Promise<RunSummary>;
  /**
   * Builds the recovery context snapshot, resolves the responsible user
   * from it, and queues the run. Throws `WakeQueueApplicationError` with
   * code `responsible_user_unresolved` when no responsible user resolves,
   * without queuing anything.
   */
  queueImmediateRecoveryRun(input: {
    companyId: string;
    issue: IssueSnapshot;
    finishingRun: RunSnapshot;
    recoveryAgent: InvokableAgentSnapshot;
    sessionBefore: string | null;
    now: Date;
  }): Promise<RunSummary>;
}

/**
 * Owns the module's own transaction: loads the finishing run, locks the
 * context issue and every sibling issue in id order, clears the two
 * release-lock columns, and picks the primary issue. When the primary
 * issue is missing, already reclaimed, or resolved by an early exit
 * (workspace-validation block, legacy reconciliation, a native-runtime
 * terminal failure), the adapter returns that outcome directly without
 * calling `fn`. Otherwise it calls `fn` with the locked issue and run, and
 * with `reader`/`writer` ports bound to the same transaction, so every
 * call `fn` makes through them participates in the one transaction this
 * method owns.
 */
export interface IssueLockWriter {
  withIssueExecutionLock(
    input: { companyId: string; runId: string; now: Date },
    fn: (
      locked: LockedIssueExecution,
      ports: { reader: WakeQueueReader; writer: WakeQueueWriter },
    ) => Promise<ReleaseTransactionResult>,
  ): Promise<ReleaseTransactionResult & { run: RunSnapshot }>;
}

export type StrandedAssignedIssueEscalationInput = {
  issue: IssueSnapshot;
  previousStatus: "todo" | "in_progress" | "in_review";
  latestRun: RunSnapshot;
  notice: Record<string, unknown>;
  recoveryCause: string | null;
};

export type StrandedRecoveryInPlaceEscalationInput = {
  issue: IssueSnapshot;
  previousStatus: "todo" | "in_progress" | "in_review";
  latestRun: RunSnapshot;
};

/** Wraps `services/recovery`'s stranded-issue escalation, called only after the release transaction commits. */
export interface RecoveryEscalationPort {
  escalateStrandedAssignedIssue(input: StrandedAssignedIssueEscalationInput): Promise<void>;
  escalateStrandedRecoveryIssueInPlace(input: StrandedRecoveryInPlaceEscalationInput): Promise<void>;
}

export type { PostCommitEffect, ReleaseOutcome };
