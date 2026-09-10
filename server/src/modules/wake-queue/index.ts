import type { Db } from "@paperclipai/db";
import {
  createAdmissionTransactionScope as buildAdmissionTransactionScope,
  createPostgresWakeQueueAdapter,
  createWakeAdmissionReader,
  createWakeAdmissionWriter,
} from "./adapters/postgres.js";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "./application/use-cases.js";
import type {
  IssueSnapshot,
  RecoveryEscalationPort,
  RunSnapshot,
  TransactionScope,
  WakeAdmissionHeartbeatHelpers,
  WakeQueueHost,
} from "./application/ports.js";

export type {
  PostCommitEffect,
  ReleaseOutcome,
  RunSummary,
} from "./application/types.js";
export { WakeQueueApplicationError } from "./application/types.js";
export type {
  IssueSnapshot,
  RunSnapshot,
  RecoveryEscalationPort,
  ReleaseRecoveryBlockedNoticeKind,
  TransactionScope,
} from "./application/ports.js";
export type { AdmitWakeBehindIssueExecutionInput, AdmitWakeBehindIssueExecutionResult, ReleaseIssueExecutionInput } from "./application/use-cases.js";

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

/**
 * Composes the wake-queue module: the Postgres adapter (which owns the
 * release transaction) and the release use case. `heartbeat.ts` holds the
 * only caller: it builds one instance per process next to
 * `createRunDispatch(db)` and delegates `releaseIssueExecutionAndPromote`'s
 * body to `releaseIssueExecution`.
 *
 * The admission half is temporary: `heartbeat.ts` still opens and owns the
 * transaction that admits a wake behind an active issue execution, so it
 * builds a `TransactionScope` through `createAdmissionTransactionScope`
 * before it calls `admitWakeBehindIssueExecution`.
 */
export function createWakeQueue(db: Db, deps: WakeQueueDeps) {
  const issueLock = createPostgresWakeQueueAdapter(db, {
    resolveResponsibleUserId: deps.resolveResponsibleUserId,
    getRoutineEnv: deps.getRoutineEnv,
    resolveSessionBeforeForWakeup: deps.resolveSessionBeforeForWakeup,
  });

  return {
    releaseIssueExecution: createReleaseIssueExecution({ issueLock, recovery: deps.recovery }),
    admitWakeBehindIssueExecution: createAdmitWakeBehindIssueExecution({
      reader: createWakeAdmissionReader(),
      writer: createWakeAdmissionWriter(),
      helpers: deps.wakeAdmissionHelpers,
    }),
    createAdmissionTransactionScope(companyId: string, tx: Db): TransactionScope {
      return buildAdmissionTransactionScope(companyId, tx);
    },
  };
}

export type WakeQueue = ReturnType<typeof createWakeQueue>;
