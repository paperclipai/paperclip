import { notifyRoutineExecutionStatus, type RoutineExecutionStatusScope } from "./routine-execution-status-notifications.js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routineRuns, routines } from "@paperclipai/db";

const EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE = "execution_issue_status";
const EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES = ["blocked", "cancelled"] as const;

type ExecutionIssueTransientFailureStatus = (typeof EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES)[number];

function executionIssueTransientFailureReason(status: ExecutionIssueTransientFailureStatus) {
  return `Execution issue moved to ${status}`;
}

function executionIssueTransientFailureStatusFromPayload(payload: unknown): ExecutionIssueTransientFailureStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transientFailure = (payload as Record<string, unknown>).transientFailure;
  if (!transientFailure || typeof transientFailure !== "object" || Array.isArray(transientFailure)) return null;
  const record = transientFailure as Record<string, unknown>;
  if (record.code !== EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE) return null;
  return EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES.find((status) => record.status === status) ?? null;
}

function executionIssueTransientFailureClearedAtFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transientFailure = (payload as Record<string, unknown>).transientFailure;
  if (!transientFailure || typeof transientFailure !== "object" || Array.isArray(transientFailure)) return null;
  const clearedAt = (transientFailure as Record<string, unknown>).clearedAt;
  return typeof clearedAt === "string" ? clearedAt : null;
}

function legacyExecutionIssueTransientFailureStatus(
  failureReason: string | null,
): ExecutionIssueTransientFailureStatus | null {
  return EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES.find(
    (status) => failureReason === executionIssueTransientFailureReason(status),
  ) ?? null;
}

export async function finalizeRoutineRun(executor: Db, runId: string, patch: Partial<typeof routineRuns.$inferInsert>) {
  if (patch.linkedIssueId) await notifyRoutineExecutionStatus(executor, patch.linkedIssueId);
  return executor
    .update(routineRuns)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(routineRuns.id, runId))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function syncRoutineRunStatusForIssue(executor: Db, issueId: string) {
  return executor.transaction(tx => syncLockedRoutineRunStatusForIssue(tx as unknown as Db, issueId));
}

async function syncLockedRoutineRunStatusForIssue(executor: Db, issueId: string) {
  const issue = await executor
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.originKind, "routine_execution")))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
  const run = await executor
    .select({
      id: routineRuns.id,
      status: routineRuns.status,
      failureReason: routineRuns.failureReason,
      triggerPayload: routineRuns.triggerPayload,
      completedAt: routineRuns.completedAt,
    })
    .from(routineRuns)
    .innerJoin(routines, and(eq(routines.id, routineRuns.routineId), eq(routines.companyId, issue.companyId)))
    .where(and(eq(routineRuns.id, issue.originRunId), eq(routineRuns.companyId, issue.companyId),
      eq(routineRuns.linkedIssueId, issue.id)))
    .for("update", { of: routineRuns })
    .then((rows) => rows[0] ?? null);
  if (!run || ["received", "skipped", "coalesced"].includes(run.status)) return null;
  if (issue.status === "done") {
    if (run.status === "completed" && run.failureReason === null && run.completedAt) return null;
    const transientFailureStatus = executionIssueTransientFailureStatusFromPayload(run.triggerPayload)
      ?? legacyExecutionIssueTransientFailureStatus(run.failureReason);
    const transientFailureClearedAt = executionIssueTransientFailureClearedAtFromPayload(run.triggerPayload);
    return finalizeRoutineRun(executor, issue.originRunId, {
      status: "completed",
      failureReason: null,
      completedAt: new Date(),
      ...(transientFailureStatus
        ? {
          triggerPayload: {
            ...(run.triggerPayload ?? {}),
            transientFailure: {
              code: EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE,
              status: transientFailureStatus,
              reason: executionIssueTransientFailureReason(transientFailureStatus),
              clearedAt: transientFailureClearedAt ?? new Date().toISOString(),
            },
          },
        }
        : {}),
    });
  }
  if (issue.status === "blocked" || issue.status === "cancelled") {
    const failureReason = executionIssueTransientFailureReason(issue.status);
    if (run.status === "failed" && run.failureReason === failureReason && run.completedAt) return null;
    return finalizeRoutineRun(executor, issue.originRunId, {
      status: "failed",
      failureReason,
      completedAt: new Date(),
      triggerPayload: {
        ...(run.triggerPayload ?? {}),
        transientFailure: {
          code: EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE,
          status: issue.status,
          reason: failureReason,
          recordedAt: new Date().toISOString(),
        },
      },
    });
  }
  const transientFailureStatus = executionIssueTransientFailureStatusFromPayload(run.triggerPayload)
    ?? legacyExecutionIssueTransientFailureStatus(run.failureReason);
  if (run.status === "failed" && transientFailureStatus) {
    return finalizeRoutineRun(executor, issue.originRunId, {
      status: "issue_created",
      failureReason: null,
      completedAt: null,
      triggerPayload: {
        ...(run.triggerPayload ?? {}),
        transientFailure: {
          code: EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE,
          status: transientFailureStatus,
          reason: executionIssueTransientFailureReason(transientFailureStatus),
          clearedAt: new Date().toISOString(),
        },
      },
    });
  }
  return null;
}


export const ROUTINE_EXECUTION_STATUS_PAGE_SIZE = 50;

export function routineExecutionStatusDebtCondition() {
  const transientFailure = sql`((${routineRuns.triggerPayload} -> 'transientFailure' ->> 'code' = ${EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE}
      and ${routineRuns.triggerPayload} -> 'transientFailure' ->> 'status' in ('blocked', 'cancelled'))
    or ${routineRuns.failureReason} in ('Execution issue moved to blocked', 'Execution issue moved to cancelled'))`;
  return or(
    and(eq(routineRuns.status, "issue_created"), inArray(issues.status, ["done", "blocked", "cancelled"])),
    and(eq(routineRuns.status, "completed"), or(inArray(issues.status, ["blocked", "cancelled"]),
      and(eq(issues.status, "done"), sql`(${routineRuns.completedAt} is null or ${routineRuns.failureReason} is not null)`))),
    and(eq(routineRuns.status, "failed"), transientFailure,
      sql`(${issues.status} not in ('blocked', 'cancelled')
        or ${routineRuns.completedAt} is null
        or ${routineRuns.failureReason} is distinct from 'Execution issue moved to ' || ${issues.status})`),
  );
}

export function routineExecutionStatusService(db: Db) {
  async function load(scope?: RoutineExecutionStatusScope, afterId?: string) {
    return db.select({ id: routineRuns.id, companyId: routineRuns.companyId,
      issueId: issues.id, routineId: routineRuns.routineId })
      .from(routineRuns)
      .innerJoin(routines, and(eq(routines.id, routineRuns.routineId), eq(routines.companyId, routineRuns.companyId)))
      .innerJoin(issues, and(eq(issues.id, routineRuns.linkedIssueId), eq(issues.companyId, routineRuns.companyId),
        eq(issues.originKind, "routine_execution"), sql`${issues.originRunId} = ${routineRuns.id}::text`))
      .where(and(routineExecutionStatusDebtCondition(),
        ...(scope?.issueId ? [eq(issues.id, scope.issueId)] : []),
        ...(scope?.companyId ? [eq(routineRuns.companyId, scope.companyId)] : []),
        ...(afterId ? [sql`${routineRuns.id} > ${afterId}::uuid`] : [])))
      .orderBy(routineRuns.id).limit(ROUTINE_EXECUTION_STATUS_PAGE_SIZE);
  }
  async function settle(candidate: Awaited<ReturnType<typeof load>>[number]) {
    return db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const [routine] = await tx.select({ id: routines.id }).from(routines).where(and(
        eq(routines.id, candidate.routineId), eq(routines.companyId, candidate.companyId))).for("share");
      if (!routine) return false;
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, candidate.issueId),
        eq(issues.companyId, candidate.companyId), eq(issues.originKind, "routine_execution"),
        eq(issues.originRunId, candidate.id))).for("update");
      if (!issue) return false;
      const [run] = await tx.select({ id: routineRuns.id }).from(routineRuns)
        .innerJoin(issues, eq(issues.id, routineRuns.linkedIssueId))
        .where(and(eq(routineRuns.id, candidate.id), eq(routineRuns.companyId, candidate.companyId),
          eq(routineRuns.routineId, candidate.routineId), eq(routineRuns.linkedIssueId, issue.id),
          routineExecutionStatusDebtCondition())).for("update", { of: routineRuns });
      if (!run) return false;
      return (await syncRoutineRunStatusForIssue(tx as unknown as Db, issue.id)) !== null;
    });
  }
  return { load, settle };
}
