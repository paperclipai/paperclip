import { notifyNativeFinalizationWork } from "./native-finalization-notifications.js";
import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { readSystemRecovery } from "./system-recovery-state.js";
import { preservedResultHasStop } from "./native-runtime/preserved-native-result-finalization.js";
import { readWorkspaceRecovery, verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

function isLockNotAvailable(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The durable facts that let a terminal run's accepted result be applied once
 * its files are saved: the coordinator names an accepted, succeeded result of
 * this run; the run's own saved-work recovery completed with a verified receipt;
 * nobody stopped the run; and no newer run, owner or applied generation exists.
 * Any missing or contradicting fact returns null, so callers keep their existing
 * behaviour. `lock` takes the row locks that resumption needs. */
type Lock = false | "nowait" | "wait";

async function readPreservedResult(db: Db, companyId: string, runId: string, lock: Lock) {
  const applicable = await readApplicableResult(db, companyId, runId, lock);
  if (!applicable) return null;
  const { coordinator, issue, run, result } = applicable;
  const [action] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}`,
  )).orderBy(desc(issueRecoveryActions.createdAt)).limit(1);
  const recovery = readSystemRecovery(action?.evidence);
  const workspace = readWorkspaceRecovery(action?.evidence ?? null);
  if (recovery?.state !== "complete" || recovery.sourceRunId !== run.id || !recovery.preservationOperationIds.length
    || workspace?.status !== "recovered" || workspace.runId !== run.id
    || !await verifiedWorkspaceRepairReceipt(db, run)) return null;
  const [intent] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.reason, "task_retry"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}' = ${runId}`,
  )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1);
  const generationId = intent?.id ?? recovery.generationId;
  if (coordinator.recoveryHistory.some(entry => entry.kind === "preserved_result_finalization" &&
      entry.generationId === generationId)) return null;
  return { coordinator, issue, run, result, recovery, intent, generationId };
}

/** The facts that do not depend on the saved-work proof: an accepted, succeeded
 * result held by a terminal coordinator, no Stop, no newer run, and the same
 * agent owner with no current execution. */
async function readApplicableResult(db: Db, companyId: string, runId: string, lock: Lock) {
  // The finalizer and owner-stop confirmation lock the coordinator before the
  // issue; Retry dispatch locks the issue first. This takes the coordinator
  // first (like the finalizer). With "nowait" it does not wait for the issue or
  // run while it holds the coordinator: a busy row fails the attempt
  // (lock_not_available) and the caller tries again.
  const coordinatorQuery = db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)));
  const [coordinator] = lock ? await coordinatorQuery.for("update") : await coordinatorQuery;
  // A result retired as superseded is never applied, even after its files are saved.
  if (!coordinator?.resultId || coordinator.phase !== "terminal_failure" || coordinator.leaseOwner ||
      coordinator.failureDetail?.successorRunId || coordinator.failureCode === "native_finalization_superseded") return null;
  const issueQuery = db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, coordinator.issueId)));
  const [issue] = lock === "nowait" ? await issueQuery.for("update", { noWait: true })
    : lock ? await issueQuery.for("update") : await issueQuery;
  const runQuery = db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  const [run] = lock === "nowait" ? await runQuery.for("update", { noWait: true })
    : lock ? await runQuery.for("update") : await runQuery;
  if (!issue || !run || run.status === "cancelled" || preservedResultHasStop(run.resultJson)
      || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId || ["done", "cancelled"].includes(issue.status) ||
      issue.executionRunId || issue.checkoutRunId) return null;
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), ne(heartbeatRuns.id, runId),
    or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    gte(heartbeatRuns.createdAt, run.createdAt),
  )).limit(1);
  if (newer) return null;
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.issueId, issue.id),
    eq(nativeRunResults.runId, runId), eq(nativeRunResults.id, coordinator.resultId),
    eq(nativeRunResults.schemaStatus, "accepted"),
    sql`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}' = 'succeeded'`,
  ));
  return result ? { coordinator, issue, run, result } : null;
}

/** Read-only: whether resumePreservedResultFinalization would apply this run's
 * saved accepted result now (`ready`), or could once the run's saved-work
 * recovery completes (`pending`). Retry admission uses it to wait for that
 * result instead of starting a new agent turn. It takes no locks. */
export async function canResumePreservedResultFinalization(db: Db, companyId: string, runId: string,
  when: "ready" | "pending" = "ready") {
  return (when === "ready" ? await readPreservedResult(db, companyId, runId, false)
    : await readApplicableResult(db, companyId, runId, false)) !== null;
}

/** Re-enter the existing finalizer only after preservation. This does not
 * recreate a result, grant an executor budget, or apply it over newer work. */
export async function resumePreservedResultFinalization(db: Db, companyId: string, runId: string) {
  // Each attempt rereads every fact. A row held by another writer (usually a
  // Retry dispatch for this task) is briefly retried without waiting while the
  // coordinator is held. The last attempt waits for its locks, as this
  // resumption always did, so a recovered result is never left unapplied
  // because a row stayed busy.
  for (let attempt = 1; ; attempt += 1) {
    const wait = attempt >= PRESERVED_RESULT_LOCK_ATTEMPTS;
    const resumed = await attemptPreservedResultFinalization(db, companyId, runId, wait);
    if (resumed !== "busy") return resumed;
    await new Promise(resolve => setTimeout(resolve, PRESERVED_RESULT_LOCK_DELAY_MS));
  }
}

const PRESERVED_RESULT_LOCK_ATTEMPTS = 10;
const PRESERVED_RESULT_LOCK_DELAY_MS = 100;

async function attemptPreservedResultFinalization(db: Db, companyId: string, runId: string, wait: boolean): Promise<boolean | "busy"> {
  const resumed = await db.transaction(async tx => {
    const found = await readPreservedResult(tx as unknown as Db, companyId, runId, wait ? "wait" : "nowait");
    if (!found) return null;
    const { coordinator, issue, run, result, recovery, intent, generationId } = found;
    await notifyNativeFinalizationWork(tx, { companyId, runId });
    await tx.update(nativeRunFinalizations).set({
      phase: coordinator.assessmentId ? "arbitrating" : "workspace_finalizing",
      nextAttemptAt: new Date(), failureCode: null, failureDetail: null, updatedAt: new Date(),
      recoveryHistory: [...coordinator.recoveryHistory, {
        kind: "preserved_result_finalization", generationId,
        preservationGenerationId: recovery.generationId,
        resultId: result.id, previousFailureCode: coordinator.failureCode,
        previousFailureDetail: coordinator.failureDetail, at: new Date().toISOString(),
      }],
    }).where(eq(nativeRunFinalizations.runId, runId));
    if (intent) await tx.update(agentWakeupRequests).set({
      status: "coalesced", runId, finishedAt: new Date(), updatedAt: new Date(),
      payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"finalize_result"'::jsonb)`,
    }).where(eq(agentWakeupRequests.id, intent.id));
    return persistActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "task-recovery",
      action: "issue.saved_result_finalization_resumed", entityType: "issue", entityId: issue.id, runId: run.id,
      details: { resultId: result.id, preservationGenerationId: recovery.generationId,
        ...(intent ? { requestId: intent.id, strategy: "finalize_result" } : {}) } });
  }).catch(error => {
    if (isLockNotAvailable(error)) return "busy" as const;
    throw error;
  });
  if (resumed === "busy") return "busy";
  if (!resumed) return false;
  try { publishActivity(resumed.publication); } catch { logger.warn({ runId }, "Saved result activity delivery deferred"); }
  return true;
}
