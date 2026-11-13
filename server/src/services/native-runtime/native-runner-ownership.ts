import { createHash } from "node:crypto";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { remoteExecutionHasStopped } from "../remote-execution-termination.js";
import { readSystemRecovery } from "../system-recovery-state.js";

type NativeRemoteExecutionScope = {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "runnerProfileJson">;
  issueId: string;
};

export async function readNativeRemoteExecutionOwnershipForRuns(db: Db, inputs: readonly NativeRemoteExecutionScope[]) {
  const key = (companyId: string, issueId: string, runId: string) => `${companyId}:${issueId}:${runId}`;
  const leases = inputs.length ? await db.select({ id: environmentLeases.id, companyId: environmentLeases.companyId,
    issueId: environmentLeases.issueId, runId: environmentLeases.heartbeatRunId,
    metadata: sql<Record<string, unknown>>`jsonb_build_object('runnerTaskStartup', ${environmentLeases.metadata}->'runnerTaskStartup')`,
  }).from(environmentLeases).where(and(
    or(...inputs.map(input => and(eq(environmentLeases.companyId, input.run.companyId),
      eq(environmentLeases.issueId, input.issueId), eq(environmentLeases.heartbeatRunId, input.run.id)))),
    sql`${environmentLeases.metadata}->>'runnerTaskLease' = 'true'`,
  )).orderBy(desc(environmentLeases.createdAt)) : [];
  const byScope = new Map<string, typeof leases[number]>();
  for (const lease of leases) {
    const scope = key(lease.companyId, lease.issueId!, lease.runId!);
    if (!byScope.has(scope)) byScope.set(scope, lease);
  }
  return inputs.map(input => {
    const pluginTask = byScope.get(key(input.run.companyId, input.issueId, input.run.id));
    return { pluginTask, remoteProcess: input.run.runnerProfileJson?.nativeWorkspaceSync != null
      || input.run.runnerProfileJson?.remoteWorkspace != null || !!pluginTask };
  });
}

export async function readNativeRemoteExecutionOwnership(db: Db, input: NativeRemoteExecutionScope) {
  return (await readNativeRemoteExecutionOwnershipForRuns(db, [input]))[0]!;
}

export const nativeManualAdmissionOwnerColumns = {
  runId: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
  issueId: nativeRunFinalizations.issueId, phase: nativeRunFinalizations.phase,
  resultId: nativeRunFinalizations.resultId, failureCode: nativeRunFinalizations.failureCode,
  failureDetail: sql<Record<string, unknown>>`jsonb_build_object('systemRecovery', ${nativeRunFinalizations.failureDetail}->'systemRecovery')`,
};
type ManualAdmissionOwner = Pick<typeof nativeRunFinalizations.$inferSelect,
  "runId" | "companyId" | "issueId" | "phase" | "resultId" | "failureCode" | "failureDetail">;

export function nativeManualAdmissionHoldMatches(scope: { companyId: string; runId: string; issueId?: string },
  owner: Partial<ManualAdmissionOwner> | null | undefined): boolean {
  const policy = readSystemRecovery(owner?.failureDetail);
  return Boolean(owner?.runId === scope.runId && owner.companyId === scope.companyId &&
    (!scope.issueId || owner.issueId === scope.issueId) && owner.phase === "terminal_failure" && owner.resultId === null &&
    ["native_restart_recovery_blocked", "native_retry_cancelled"].includes(owner.failureCode ?? "") &&
    policy?.state === "exhausted" && policy.sourceRunId === scope.runId);
}

export async function nativeManualAdmissionHoldsExecution(db: Db, scope: {
  companyId: string; runId: string; issueId?: string;
}): Promise<boolean> {
  const [hold] = await db.select(nativeManualAdmissionOwnerColumns).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.runId, heartbeatRuns.id), eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId)))
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId),
      eq(heartbeatRuns.runtimeMode, "native"), scope.issueId ? eq(heartbeatRuns.nativeIssueId, scope.issueId) : undefined,
      eq(nativeRunFinalizations.phase, "terminal_failure"), inArray(nativeRunFinalizations.failureCode, ["native_restart_recovery_blocked", "native_retry_cancelled"]),
      isNull(nativeRunFinalizations.resultId),
    )).limit(1);
  return nativeManualAdmissionHoldMatches(scope, hold) && !await remoteExecutionHasStopped(db, scope.companyId, scope.runId);
}

export const NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE =
  "native_execution_ownership_unverified";
export const NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT =
  "native_adopted_runner_authentication_timeout";

/** An unauthenticated retained process is not evidence that execution stopped. */
export class NativeRunnerOwnershipUnverifiedError extends Error {
  constructor(
    readonly reason:
      | "adopted_runner_authentication_timeout"
      | "native_chat_workspace_scope_mismatch" = "adopted_runner_authentication_timeout",
  ) {
    super(NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE);
    this.name = "NativeRunnerOwnershipUnverifiedError";
  }
}

export function isNativeRunnerOwnershipHeld(run: {
  runtimeMode?: string | null;
  status?: string | null;
  errorCode?: string | null;
  nativePhase?: string | null;
}): boolean {
  return (
    run.runtimeMode === "native" &&
    run.status === "running" &&
    ((run.errorCode === NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE &&
      run.nativePhase === "terminal_failure") ||
      run.errorCode === NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT)
  );
}

/** Null-safe database counterpart, evaluated atomically by claims and writes. */
export function nativeRunnerOwnershipNotHeldCondition() {
  return sql`not coalesce(
    ${heartbeatRuns.runtimeMode} = 'native'
    and ${heartbeatRuns.status} = 'running'
    and (
      (${heartbeatRuns.errorCode} = ${NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE}
        and ${heartbeatRuns.nativePhase} = 'terminal_failure')
      or ${heartbeatRuns.errorCode} = ${NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT}
    ), false
  )`;
}

/** Opaque binding for an operator's exact observed controller authority. Never
 * expose the token itself. expiryEpoch must come from Postgres numeric epoch
 * text, which is timezone independent and retains timestamp microseconds. */
export function nativeControllerAuthorityDigest(owner: Pick<typeof nativeRunFinalizations.$inferSelect,
  "companyId" | "issueId" | "runId" | "leaseOwner" | "controllerGeneration" | "controllerBootId" |
  "controllerHostHash" | "controllerPid" | "controllerProcessStartedAt">, expiryEpoch: string | null): string {
  return createHash("sha256").update(JSON.stringify([
    "paperclip.native-controller-authority.v1", owner.companyId, owner.issueId, owner.runId,
    owner.leaseOwner, owner.controllerGeneration, owner.controllerBootId, owner.controllerHostHash,
    owner.controllerPid, owner.controllerProcessStartedAt?.toISOString() ?? null, expiryEpoch,
  ])).digest("hex");
}
