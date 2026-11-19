import type { Db, heartbeatRuns } from "@paperclipai/db";
import {
  createPostgresIssueWakeAdmission,
  createPostgresWakeQueueAdapter,
  type IssueAdmissionDbTransaction,
  type IssueAdmissionRow,
  type IssueAdmissionTarget,
} from "./adapters/postgres.js";
import { createQueuedCommentIssueLockWriter } from "./adapters/queued-comment-postgres.js";
import { createQueuedCommentSteeringAdapter, lockBoardQueuedComments, readBoardQueuedComments } from "./adapters/queued-comment-board-postgres.js";
import type { QueuedCommentQueuePostgresAdapterDeps } from "./adapters/queued-comment-postgres.js";
import { createFreshIssueRunAdmission } from "./application/fresh-issue-run.js";
import { admitIssueWake, type IssueWakeAdmissionEffects, type IssueWakeAdmissionOutcome } from "./application/issue-wake-admission.js";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "./application/use-cases.js";
import {
  createDiscardQueuedComment,
  createEditQueuedComment,
  createReorderQueuedComments,
  createSteerQueuedComment,
} from "./application/queued-comment-use-cases.js";
import type {
  IssueSnapshot,
  RecoveryEscalationPort,
  RunSnapshot,
  WakeAdmissionHeartbeatHelpers,
  WakeQueueHost,
} from "./application/ports.js";

export type {
  PostCommitEffect,
  ReleaseOutcome,
  RunSummary,
} from "./application/types.js";
export { createAutomaticGoalCommentSteering } from "./application/automatic-goal-comment-steering.js";
export { WakeQueueApplicationError } from "./application/types.js";
export { hasRetainedExternalChatRetry } from "./domain/context.js";
export { QUEUED_MESSAGES_DELIVERED_REASON } from "./domain/policy.js";
export type {
  IssueSnapshot,
  RunSnapshot,
  RecoveryEscalationPort,
  ReleaseRecoveryBlockedNoticeKind,
} from "./application/ports.js";
export type { ReleaseIssueExecutionInput } from "./application/use-cases.js";
export {
  QueuedCommentMutationError,
  QueuedCommentMutationForbiddenError,
  requireQueuedCommentMutationTarget,
} from "./application/queued-comment-use-cases.js";
export type {
  DiscardQueuedCommentInput,
  DiscardQueuedCommentResult,
  EditQueuedCommentInput,
  EditQueuedCommentResult,
  QueuedCommentMutationErrorCode,
  ReorderQueuedCommentsInput,
  ReorderQueuedCommentsResult,
} from "./application/queued-comment-use-cases.js";
export type {
  QueuedCommentActivityPublication,
  QueuedCommentActor,
  QueuedCommentIssueContext,
  QueuedCommentQueueSnapshot,
} from "./application/queued-comment-ports.js";
export type { QueuedCommentQueuePostgresAdapterDeps } from "./adapters/queued-comment-postgres.js";

export type WakeQueueDeps = {
  /** Stays in `heartbeat.ts`; resolves the responsible user for a promoted or recovery run seed. */
  resolveResponsibleUserId: WakeQueueHost["resolveResponsibleUserId"];
  /** Stays in `heartbeat.ts`; reads the routine environment context for an execution issue. */
  getRoutineEnv: WakeQueueHost["getRoutineEnv"];
  /** Stays in `heartbeat.ts`; resolves the session-before display id for a wakeup. */
  resolveSessionBeforeForWakeup: WakeQueueHost["resolveSessionBeforeForWakeup"];
  /**
   * The four wake-admission decision helpers stay in `heartbeat.ts` today;
   * the module receives them here so it never imports the service it is
   * extracted from.
   */
  wakeAdmissionHelpers: WakeAdmissionHeartbeatHelpers;
  /** `services/recovery`'s stranded-issue escalation, called only after the release transaction commits. */
  recovery: RecoveryEscalationPort;
};

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type LockedIssueAdmission = {
  lockedIssue: IssueAdmissionRow | null;
  lockIssue: () => Promise<IssueAdmissionRow | null>;
  admitWakeBehindIssueExecution: ReturnType<typeof createAdmitWakeBehindIssueExecution>;
  admitFreshIssueRun: ReturnType<typeof createFreshIssueRunAdmission<HeartbeatRun>>;
};

/** Composes the issue admission and release workflows with their Postgres locks. */
export function createWakeQueue(db: Db, deps: WakeQueueDeps) {
  const issueLock = createPostgresWakeQueueAdapter(db, {
    resolveResponsibleUserId: deps.resolveResponsibleUserId,
    getRoutineEnv: deps.getRoutineEnv,
    resolveSessionBeforeForWakeup: deps.resolveSessionBeforeForWakeup,
  });
  const withIssueAdmission = createPostgresIssueWakeAdmission(db);

  return {
    releaseIssueExecution: createReleaseIssueExecution({ issueLock, recovery: deps.recovery }),
    admitIssueWake(
      { companyId, issueId, durableChatRequest }: IssueAdmissionTarget,
      // Specialized heartbeat gates and continuation writes still use this locked transaction.
      evaluateHeartbeatPolicy: (tx: IssueAdmissionDbTransaction, admission: LockedIssueAdmission) => Promise<IssueWakeAdmissionOutcome<HeartbeatRun>>,
      effects: IssueWakeAdmissionEffects<HeartbeatRun>,
    ) {
      return admitIssueWake(() => withIssueAdmission({ companyId, issueId, durableChatRequest }, (tx, { lockedIssue, lockIssue, reader, writer, fresh }) => {
        const admitBusy = createAdmitWakeBehindIssueExecution({ reader, writer, helpers: deps.wakeAdmissionHelpers });
        const admitFresh = createFreshIssueRunAdmission(fresh);
        return evaluateHeartbeatPolicy(tx, {
          lockedIssue,
          lockIssue,
          async admitWakeBehindIssueExecution(input) {
            if (input.companyId !== companyId || input.issueId !== issueId || input.contextSnapshot.issueId !== issueId) {
              throw new Error("wake-queue: admission does not match the locked company and issue");
            }
            return admitBusy(input);
          },
          async admitFreshIssueRun(input) {
            if (input.issue.id !== issueId || input.contextSnapshot.issueId !== issueId) {
              throw new Error("wake-queue: admission does not match the locked issue");
            }
            return admitFresh(input);
          },
        });
      }), effects);
    },
  };
}

export type WakeQueue = ReturnType<typeof createWakeQueue>;

/**
 * Composes the queued-comment reads and mutations with their Postgres
 * adapters. This is a separate factory
 * from `createWakeQueue` because these mutations need none of the release
 * or admission host callbacks -- only the small set of comment-reference
 * and external-object sync callbacks in `deps`, which a caller outside
 * `heartbeat.ts` (the queued-comment route) can supply directly.
 */
export function createQueuedCommentQueue(db: Db, deps: QueuedCommentQueuePostgresAdapterDeps) {
  const issueLock = createQueuedCommentIssueLockWriter(db, deps);
  return {
    readBoardQueue: readBoardQueuedComments,
    lockBoardQueue: lockBoardQueuedComments,
    steerQueuedComment: createSteerQueuedComment(createQueuedCommentSteeringAdapter(db)),
    editQueuedComment: createEditQueuedComment({ issueLock }),
    reorderQueuedComments: createReorderQueuedComments({ issueLock }),
    discardQueuedComment: createDiscardQueuedComment({ issueLock }),
  };
}

export type QueuedCommentQueue = ReturnType<typeof createQueuedCommentQueue>;
