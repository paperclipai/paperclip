import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routineRuns } from "@paperclipai/db";

const EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE = "execution_issue_status";
const EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES = ["blocked", "cancelled"] as const;

type ExecutionIssueTransientFailureStatus =
  (typeof EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES)[number];

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

async function finalizeRoutineRun(
  db: Db,
  runId: string,
  patch: Partial<typeof routineRuns.$inferInsert>,
) {
  return db
    .update(routineRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(routineRuns.id, runId))
    .returning()
    .then((rows) => rows[0] ?? null);
}

/**
 * Mirrors a routine-execution issue's status onto the linked `routine_run`.
 *
 * The issues route calls this after every issue write (`issues.ts`), but a
 * service-layer status write (for example the recovery scan finalizing a
 * completed poll) does not pass through that route. Extracting it here lets
 * every writer sync the run without pulling the heavy routines service (which
 * imports heartbeat) into the recovery service.
 */
export async function syncRoutineRunStatusForIssue(db: Db, issueId: string) {
  const issue = await db
    .select({
      id: issues.id,
      status: issues.status,
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
  const run = await db
    .select({
      id: routineRuns.id,
      status: routineRuns.status,
      failureReason: routineRuns.failureReason,
      triggerPayload: routineRuns.triggerPayload,
    })
    .from(routineRuns)
    .where(eq(routineRuns.id, issue.originRunId))
    .then((rows) => rows[0] ?? null);
  if (!run) return null;
  if (issue.status === "done") {
    const transientFailureStatus = executionIssueTransientFailureStatusFromPayload(run.triggerPayload)
      ?? legacyExecutionIssueTransientFailureStatus(run.failureReason);
    const transientFailureClearedAt = executionIssueTransientFailureClearedAtFromPayload(run.triggerPayload);
    return finalizeRoutineRun(db, issue.originRunId, {
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
    return finalizeRoutineRun(db, issue.originRunId, {
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
    return finalizeRoutineRun(db, issue.originRunId, {
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
