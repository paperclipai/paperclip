import type { ReleaseRecoveryBlockedNoticeKind } from "../domain/policy.js";
import type {
  InvokableAgentSnapshot,
  IssueSnapshot,
  PostCommitEffect,
  ReleaseOutcome,
  RunSnapshot,
  RunSummary,
} from "./types.js";

export type { InvokableAgentSnapshot, IssueSnapshot, ReleaseRecoveryBlockedNoticeKind, RunSnapshot, RunSummary };

/** The primary issue a locked release resolves to, plus the finishing run the lock step already loaded. */
export type LockedIssueExecution = {
  /** Plan bounded recovery without draining messages while the finishing owner cleans up. */
  recoveryOnly?: boolean;
  primaryIssue: IssueSnapshot;
  run: RunSnapshot;
};

export type ReleaseTransactionResult = {
  outcome: ReleaseOutcome;
  postCommitEffects: PostCommitEffect[];
};

/**
 * The three host callbacks the release use case needs. These members do
 * not run on the module's own transaction, which is why two of them take
 * the transaction-scoped issue snapshot instead of an issue id.
 */
export interface WakeQueueHost {
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
  requestedByActorType: "user" | "agent" | "system" | null;
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
  /** Exact failed-chat retry authority revalidated by the transaction-bound adapter. */
  authorizedFailedChatRetry?: boolean;
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
  /** Only a proven failed-chat retry may retain its original retry lineage. */
  authorizedFailedChatRetry?: boolean;
  now: Date;
};

/**
 * Every member is bound to the one transaction that `withIssueExecutionLock`
 * owns. The interface holds both reads and writes that drain and resolve
 * the deferred-wake queue.
 */
export interface WakeQueueTransaction {
  findInvokableAgent(input: { companyId: string; agentId: string }): Promise<InvokableAgentSnapshot | null>;
  findNextDeferredWake(input: { companyId: string; issueId: string }): Promise<DeferredWakeCandidate | null>;
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
    /** The wake's current payload, as already read by `findNextDeferredWake`, used as the rewrite base. */
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
  /** Deny-only facts from the exact finishing run and its durable chat wake owner. */
  isImmediateRecoverySourceBlocked(input: { companyId: string; runId: string }): Promise<boolean>;
  queueReviewParticipantRecoveryRun(input: {
    companyId: string;
    issue: IssueSnapshot;
    finishingRun: RunSnapshot;
    recoveryAgent: InvokableAgentSnapshot;
    sessionBefore: string | null;
    now: Date;
  }): Promise<RunSummary>;
  /**
   * Queues the run with the context snapshot and the responsible user the
   * caller already resolved.
   */
  queueImmediateRecoveryRun(input: {
    companyId: string;
    issue: IssueSnapshot;
    finishingRun: RunSnapshot;
    recoveryAgent: InvokableAgentSnapshot;
    /** The wakeup request's reason and the run's context-snapshot wakeReason; the caller derives it from the issue status. */
    reason: string;
    contextSnapshot: Record<string, unknown>;
    responsibleUserId: string;
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
 * with `host`/`transaction` ports, so every call `fn` makes through the
 * transaction port participates in the one transaction this method owns.
 */
export interface IssueLockWriter {
  withIssueExecutionLock(
    input: { companyId: string; runId: string; now: Date },
    fn: (
      locked: LockedIssueExecution,
      ports: { host: WakeQueueHost; transaction: WakeQueueTransaction },
    ) => Promise<ReleaseTransactionResult>,
  ): Promise<ReleaseTransactionResult & { run: RunSnapshot }>;
}

export type StrandedAssignedIssueEscalationInput = {
  issue: IssueSnapshot;
  previousStatus: "todo" | "in_progress" | "in_review";
  latestRun: RunSnapshot;
  noticeKind: ReleaseRecoveryBlockedNoticeKind;
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

/**
 * Temporary port: `heartbeat.ts` still opens and owns the transaction that
 * admits a wake behind an active issue execution; the module does not own
 * that transaction yet. A later change will decompose `enqueueWakeup` so
 * the module owns the transaction itself. That change removes this handle
 * and replaces it with a transaction the module opens on its own.
 *
 * Only this module builds a scope. `createWakeQueue` exposes a method that
 * builds one for a caller outside the module. That caller receives an
 * opaque handle back and never touches this class directly.
 */
export class TransactionScope {
  private constructor(
    private readonly companyId: string,
    private readonly rawTx: unknown,
  ) {}

  static create(companyId: string, rawTx: unknown): TransactionScope {
    return new TransactionScope(companyId, rawTx);
  }

  /** Returns the bound transaction only when `companyId` matches the scope's own company. */
  requireTx(companyId: string): unknown {
    if (companyId !== this.companyId) {
      throw new Error(
        "wake-queue: the transaction scope belongs to a different company than the requested write",
      );
    }
    return this.rawTx;
  }
}

/** Reads a scope's bound transaction. Rejects a missing scope with the same clear error as a mismatched one; never falls back to any other executor. */
export function requireTransactionScopeTx(
  scope: TransactionScope | null | undefined,
  companyId: string,
): unknown {
  if (!scope) {
    throw new Error("wake-queue: this call carries no transaction scope");
  }
  return scope.requireTx(companyId);
}

/** The active execution run a new wake arrives behind. */
export type WakeAdmissionActiveExecutionRun = {
  id: string;
  agentId: string;
  status: string;
  contextSnapshot: unknown;
  wakeupRequestId?: string | null;
};

/** Already authorized by the heartbeat admission transaction; identity, not a grant. */
export type DurableWakeAdmissionReceipt = {
  id: string;
  requestedAt: Date;
};

export type CoalescedDeferredAdmissionReceipt = DurableWakeAdmissionReceipt & {
  agentId: string;
  source: string;
  triggerDetail: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  runId: string | null;
};

export type ExistingDeferredWake = {
  id: string;
  runId?: string | null;
  payload: Record<string, unknown>;
  /** `payload._paperclipWakeContext`, already parsed to a plain object. */
  deferredContext: Record<string, unknown>;
  coalescedCount: number | null;
};

/**
 * The four wake-admission decision helpers that stay in `heartbeat.ts`
 * today. The application layer receives them through this port so it never
 * imports the service it is extracted from.
 */
export type WakeAdmissionHeartbeatHelpers = {
  /** `filterZombieCoalesceTarget` in `heartbeat.ts`. */
  filterZombieCoalesceTarget(
    target: WakeAdmissionActiveExecutionRun | null,
    liveRunExecutions: { has(id: string): boolean },
  ): WakeAdmissionActiveExecutionRun | null;
  /** `mergeCoalescedContextSnapshot` in `heartbeat.ts`. */
  mergeCoalescedContextSnapshot(
    existingRaw: unknown,
    incoming: Record<string, unknown>,
    options?: { preserveExistingInteractionContinuation?: boolean },
  ): Record<string, unknown>;
  /** `shouldDeferFollowupWakeForSameIssue` in `heartbeat.ts`. */
  shouldDeferFollowupWakeForSameIssue(input: {
    activeRunStatus: string | null | undefined;
    isSameExecutionAgent: boolean;
    wakeCommentId: string | null | undefined;
    forceFreshSession: boolean;
  }): boolean;
  /** `shouldQueueFollowupForRunningIssueWake` in `heartbeat.ts`. */
  shouldQueueFollowupForRunningIssueWake(input: {
    contextSnapshot: Record<string, unknown> | null | undefined;
    wakeCommentId: string | null;
  }): boolean;
};

export type AdmitWakeBehindIssueExecutionResult =
  | { kind: "proceed" }
  | { kind: "coalesced"; run: Record<string, unknown> }
  | { kind: "deferred" };

/** Read-only lookups the admission use case needs, each scoped to a company. */
export interface WakeAdmissionReader {
  /** A durable incoming request may share an active run only with the exact actor on its persisted wake receipt. */
  matchesActiveWakeActor(
    scope: TransactionScope,
    input: {
      companyId: string;
      wakeupRequestId: string | null;
      requestedByActorType: string | null;
      requestedByActorId: string | null;
    },
  ): Promise<boolean>;
  /** True when the active execution run's agent and this wake's own agent share an execution-agent-name key. */
  isSameExecutionAgent(
    scope: TransactionScope,
    input: {
      companyId: string;
      activeExecutionRunAgentId: string;
      issueExecutionAgentNameKey: string | null;
      agentNameKey: string | null;
    },
  ): Promise<boolean>;
  findExistingDeferredWake(
    scope: TransactionScope,
    input: {
      companyId: string;
      agentId: string;
      issueId: string;
      durableActor?: { type: string | null; id: string | null };
    },
  ): Promise<ExistingDeferredWake | null>;
}

/** The transaction-scoped write operations that admit a wake behind an active issue execution. */
export interface WakeAdmissionWriter {
  /** Merges the wake's context into the active execution run and records the wake as coalesced. Returns the updated run row. */
  coalesceIntoActiveExecutionRun(
    scope: TransactionScope,
    input: {
      companyId: string;
      activeExecutionRunId: string;
      mergedContextSnapshot: Record<string, unknown>;
      durableReceipt?: DurableWakeAdmissionReceipt;
      agentId: string;
      source: string;
      triggerDetail: string | null;
      payload: Record<string, unknown> | null;
      requestedByActorType: string | null;
      requestedByActorId: string | null;
      idempotencyKey: string | null;
    },
  ): Promise<Record<string, unknown>>;
  /** Merges the wake's context into an already-queued deferred wake, guarded by its current status. */
  mergeIntoExistingDeferredWake(
    scope: TransactionScope,
    input: {
      companyId: string;
      existingDeferredWakeId: string;
      mergedPayload: Record<string, unknown>;
      nextCoalescedCount: number;
      /** Persist each durable input's own receipt atomically with the merge. */
      coalescedReceipt?: CoalescedDeferredAdmissionReceipt;
    },
  ): Promise<void>;
  /** Queues a new deferred wake behind the active execution run. */
  insertNewDeferredWake(
    scope: TransactionScope,
    input: {
      companyId: string;
      agentId: string;
      source: string;
      triggerDetail: string | null;
      payload: Record<string, unknown>;
      requestedByActorType: string | null;
      requestedByActorId: string | null;
      idempotencyKey: string | null;
      durableReceipt?: DurableWakeAdmissionReceipt;
    },
  ): Promise<void>;
}
