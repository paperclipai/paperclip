import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { continueFreshInTransaction, type FreshContinuationResult } from "../fresh-continuation-fallback.js";
import { canContinueRecoveryRunAutomatically } from "../continuation-cause.js";
import { continuationActivityMessage, type AssignedWorkFacts, type ViolationReason } from "./assigned-work-invariant.js";

type SweepTask = { companyId: string; issueId: string; latestRun: AssignedWorkFacts["latestRun"] };
type SweepClaim = { activityId: string; reason: ViolationReason };

function continueAndSettleClaim(db: Db, task: SweepTask, runId: string, at: Date, claim?: SweepClaim) {
  return db.transaction(async tx => {
    const result = await continueFreshInTransaction(tx as unknown as Db, { companyId: task.companyId, runId, trigger: "assigned_work", now: at });
    if (result.kind === "continued" && claim) {
      const update = { outcome: "queued", message: continuationActivityMessage(claim.reason), continuedFromSavedWork: "true" };
      await tx.update(activityLog).set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify(update)}::jsonb` })
        .where(and(eq(activityLog.companyId, task.companyId), eq(activityLog.id, claim.activityId)));
    }
    return result;
  });
}

/** The sweep's continuation of a task from saved work: from its failed latest run, or from the run a refused continuation was for. */
export async function continueSweepTaskFromSavedWork(db: Db, task: SweepTask, at: Date, claim?: SweepClaim): Promise<FreshContinuationResult | null> {
  const source = task.latestRun;
  if (!source?.finishedAt || !["failed", "timed_out", "interrupted", "cancelled"].includes(source.status)) return null;
  if (source.status === "cancelled" && source.errorCode === "execution_reconciliation_required") {
    const [refusedFor] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, task.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]), sql`${heartbeatRuns.finishedAt} is not null`,
      sql`not (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is null
        and coalesce(${heartbeatRuns.errorCode}, '') = 'execution_reconciliation_required')`))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (!refusedFor) return null;
    return continueAndSettleClaim(db, task, refusedFor.id, at, claim)
      .catch(error => {
        logger.warn({ err: error, companyId: task.companyId, issueId: task.issueId }, "assigned-work continuation behind a refused run deferred");
        return null;
      });
  }
  const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error,
    retryOfRunId: heartbeatRuns.retryOfRunId, scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
    contextSnapshot: heartbeatRuns.contextSnapshot, runnerProfileJson: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, task.companyId), eq(heartbeatRuns.id, source.id)));
  if (!run || !canContinueRecoveryRunAutomatically(run)) return null;
  return continueAndSettleClaim(db, task, source.id, at, claim)
    .catch(error => {
      logger.warn({ err: error, companyId: task.companyId, issueId: task.issueId }, "assigned-work continuation from saved work deferred");
      return null;
    });
}
