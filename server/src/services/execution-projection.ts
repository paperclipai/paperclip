import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type { ExecutionProjection } from "@paperclipai/shared";
import { EXECUTION_CONTROL_DEADLINE_MS } from "./execution-control-deadline.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
const text = (v: unknown) => (typeof v === "string" ? v : null);
const executionRunColumns = {
  id: heartbeatRuns.id,
  errorCode: heartbeatRuns.errorCode,
  executionControlDeadlineAt: heartbeatRuns.executionControlDeadlineAt,
  finishedAt: heartbeatRuns.finishedAt,
  lastOutputAt: heartbeatRuns.lastOutputAt,
  lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
  nativeIssueId: heartbeatRuns.nativeIssueId,
  nextAction: heartbeatRuns.nextAction,
  processPid: heartbeatRuns.processPid,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  runtimeMode: heartbeatRuns.runtimeMode,
  scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
  scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
  scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
  startedAt: heartbeatRuns.startedAt,
  status: heartbeatRuns.status,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
    'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
    'failureRetriesBeforeWorkspaceWait', ${heartbeatRuns.contextSnapshot}->'failureRetriesBeforeWorkspaceWait')`,
};
type Run = Pick<typeof heartbeatRuns.$inferSelect, keyof typeof executionRunColumns>;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
type Recovery = Pick<
  typeof issueRecoveryActions.$inferSelect,
  "cause" | "nextAction"
> &
  Partial<
    Pick<typeof issueRecoveryActions.$inferSelect, "status" | "evidence">
  >;

/** Batched reads; list consumers do not perform per-task polling. */
export async function executionProjectionsForRuns(
  db: Db,
  companyId: string,
  runIds: string[],
  now = new Date(),
) {
  const projections = new Map<string, ExecutionProjection>();
  if (!runIds.length) return projections;
  const runs = await db
    .select(executionRunColumns)
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.id, runIds),
      ),
    );
  const coordinators = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        inArray(nativeRunFinalizations.runId, runIds),
      ),
    );
  const issueIds = [
    ...new Set(
      runs
        .map((run) => run.nativeIssueId ?? text(run.contextSnapshot?.issueId))
        .filter((id): id is string => !!id),
    ),
  ];
  const pending = issueIds.length
    ? await db
        .select({
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.issueId, issueIds),
            eq(issueThreadInteractions.status, "pending"),
          ),
        )
    : [];
  const recovery = issueIds.length
    ? await db
        .select({
          issueId: issueRecoveryActions.sourceIssueId,
          cause: issueRecoveryActions.cause,
          nextAction: issueRecoveryActions.nextAction,
          evidence: issueRecoveryActions.evidence,
          status: issueRecoveryActions.status,
        })
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.companyId, companyId),
            inArray(issueRecoveryActions.sourceIssueId, issueIds),
            inArray(issueRecoveryActions.status, [
              "active",
              "escalated",
              "resolved",
            ]),
          ),
        )
        .orderBy(desc(issueRecoveryActions.updatedAt))
    : [];
  const coordinatorByRun = new Map(coordinators.map((row) => [row.runId, row]));
  for (const run of runs) {
    const issueId = run.nativeIssueId ?? text(run.contextSnapshot?.issueId);
    const matching = recovery.filter(
      (row) =>
        row.issueId === issueId &&
        (row.status !== "resolved" || row.evidence.executionReconciliation || row.evidence.automaticRecovery) &&
        (row.evidence.runId === run.id || row.evidence.sourceRunId === run.id),
    );
    const action =
      matching.find((row) => row.status !== "resolved") ?? matching[0];
    projections.set(
      run.id,
      projectExecution(
        run,
        coordinatorByRun.get(run.id),
        pending.filter((row) => row.issueId === issueId),
        action,
        now,
      ),
    );
  }
  return projections;
}
export async function executionProjectionForRun(
  db: Db,
  companyId: string,
  runId: string,
  now = new Date(),
): Promise<ExecutionProjection | null> {
  return (
    (await executionProjectionsForRuns(db, companyId, [runId], now)).get(
      runId,
    ) ?? null
  );
}
export function projectExecution(
  run: Run,
  coordinator: Coordinator | undefined,
  pending: Array<{ kind: string }>,
  recoveryAction: Recovery | undefined,
  now = new Date(),
): ExecutionProjection {
  const detail = coordinator?.failureDetail ?? {};
  const successorRunId = text(detail.successorRunId);
  const projection: ExecutionProjection = {
    phase: "queued",
    label: "Queued",
    cause: run.errorCode ?? coordinator?.failureCode ?? null,
    lastConfirmedActivityAt:
      (
        run.lastUsefulActionAt ??
        run.lastOutputAt ??
        run.startedAt
      )?.toISOString() ?? null,
    retryAt:
      (coordinator?.nextAttemptAt ?? run.scheduledRetryAt)?.toISOString() ??
      null,
    attempt: coordinator?.attempt ?? executionFailureRetryCount(run) + 1,
    maxAttempts: 3,
    recoveryOwner: null,
    nextAction: text(detail.nextAction) ?? run.nextAction,
    permittedActions: ["inspect_run"],
    predecessorRunId: run.retryOfRunId,
    successorRunId,
  };
  const set = (phase: ExecutionProjection["phase"], label: string) =>
    Object.assign(projection, { phase, label });
  if (recoveryAction?.status === "resolved" && recoveryAction.evidence?.automaticRecovery) {
    projection.cause = recoveryAction.cause;
    projection.nextAction = recoveryAction.nextAction;
    const continuation = recoveryAction.evidence.explicitUserContinuation as
      { previousRunId?: unknown; runId?: unknown } | undefined;
    const explicitSuccessor = text(continuation?.runId);
    if (continuation?.previousRunId === run.id && explicitSuccessor && explicitSuccessor !== run.id) {
      // The admission transaction already recorded the user's successor. Keep
      // the old failure diagnostic without making it hold the newer attempt.
      projection.successorRunId = explicitSuccessor;
      projection.nextAction = null;
      return set("completed", "Continued in another run");
    }
    // Diagnostic projection only: no user decision or replay affordance.
    return set("recovery_needed", "Stopped");
  }
  if (
    recoveryAction?.status === "resolved" &&
    recoveryAction.evidence?.executionReconciliation
  ) {
    if (recoveryAction.evidence.continuationDelivery === "invalidated") {
      projection.cause = "continuation_ownership_changed";
      projection.nextAction =
        "The task was closed or reassigned before delivery. Inspect the current task owner and status.";
      return set("failed", "Continuation cancelled");
    }
    const deliveredRunId = text(recoveryAction.evidence.continuationRunId);
    projection.successorRunId = deliveredRunId;
    projection.cause = null;
    projection.nextAction = deliveredRunId
      ? null
      : "The previous execution is reconciled. Its continuation is queued for delivery.";
    return set(
      deliveredRunId ? "completed" : "queued",
      deliveredRunId ? "Continued in another run" : "Continuation queued",
    );
  }
  if (
    (run.status === "running" &&
      (run.executionControlDeadlineAt || coordinator?.controlDeadlineAt)) ||
    [
      "result_persisted",
      "ready_for_assessment",
      "arbitrating",
      "workspace_pending",
    ].includes(coordinator?.phase ?? "")
  )
    return set("finishing", "Finishing");
  if (successorRunId) return set("completed", "Continued in another run");
  if (run.status === "scheduled_retry" && run.scheduledRetryReason === "workspace_busy") {
    projection.nextAction = "Waiting for the live workspace holder to finish; the scheduled check will revalidate ownership.";
    return set("retry_scheduled", "Waiting for workspace");
  }
  if (
    coordinator?.phase === "retryable_failure" ||
    run.status === "scheduled_retry"
  ) {
    projection.recoveryOwner = "agent";
    return set(
      projection.retryAt && new Date(projection.retryAt) > now
        ? "retry_scheduled"
        : "reconnecting",
      projection.retryAt && new Date(projection.retryAt) > now
        ? "Retry scheduled"
        : "Reconnecting",
    );
  }
  if (coordinator?.phase === "terminal_failure" || recoveryAction) {
    if (
      coordinator?.failureCode === "native_provider_terminal_failed" &&
      !detail.replacementDenied &&
      run.finishedAt &&
      now.getTime() - run.finishedAt.getTime() < EXECUTION_CONTROL_DEADLINE_MS
    ) {
      projection.recoveryOwner = "agent";
      projection.nextAction =
        "Checking that the previous provider stopped and its action outcomes are known before continuing.";
      return set("reconnecting", "Checking recovery");
    }
    projection.recoveryOwner = "board";
    projection.cause =
      recoveryAction?.cause ??
      text(detail.replacementDenied) ??
      projection.cause;
    projection.nextAction = recoveryAction?.nextAction ?? projection.nextAction;
    projection.permittedActions.push("inspect_recovery");
    return set("recovery_needed", "Recovery needed");
  }
  if (run.status === "succeeded") {
    if (pending.length)
      return set(
        pending.some((row) => row.kind === "connection_intent")
          ? "waiting_for_access"
          : "waiting_for_answer",
        pending.some((row) => row.kind === "connection_intent")
          ? "Waiting for access"
          : "Waiting for answer",
      );
    return set("completed", "Completed");
  }
  if (["failed", "cancelled", "timed_out", "interrupted"].includes(run.status))
    return set("failed", run.status === "cancelled" ? "Cancelled" : "Failed");
  if (run.status === "running") {
    const leaseConfirmed =
      coordinator?.phase === "observed" &&
      coordinator.leaseExpiresAt &&
      coordinator.leaseExpiresAt > now;
    let processConfirmed = false;
    if (run.runtimeMode === "legacy" && run.processPid) {
      try {
        process.kill(run.processPid, 0);
        processConfirmed = true;
      } catch {
        /* No execution confirmation. */
      }
    }
    return leaseConfirmed || processConfirmed
      ? set("working", "Working")
      : set("reconnecting", "Confirming execution");
  }
  return projection;
}
