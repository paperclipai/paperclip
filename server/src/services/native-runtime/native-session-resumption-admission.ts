import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { issueService } from "../issues.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "../recovery/pause-hold-guard.js";
import { readRunCancellation } from "../run-cancellation.js";
import { getNativeReviewAssignment } from "./native-review-participant.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { notifyStatusCardIssueChange } from "../status-card-notifications.js";
import { normalizeAgentNameKey } from "../agent-name-key.js";
import { NATIVE_SESSION_RESUMPTION_ISSUE_STATUSES } from "./native-session-resumption-statuses.js";

export async function releaseNativeCheckpointRetryWaits(db: Db, input: {
  issue: Pick<typeof issues.$inferSelect, "id">;
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">;
}) {
  const { issue, run } = input;
  const ownWait = and(eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.reason, "task_retry"),
    eq(agentWakeupRequests.requestedByActorType, "user"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,schema}' = 'paperclip.task-retry.v1'`,
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}' = ${run.id}`,
    sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' = 'native_checkpoint_recovery_pending'`);
  const waits = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .where(ownWait).for("update").limit(25);
  for (const { id } of waits) await notifyDeferredExecutionWork(db, { companyId: run.companyId, requestId: id });
  if (waits.length) await db.update(agentWakeupRequests).set({ payload: sql`${agentWakeupRequests.payload} - 'executionWait'` })
    .where(and(ownWait, inArray(agentWakeupRequests.id, waits.map(wait => wait.id))));
}

export async function restoreNativeSessionExecution(db: Db, input: {
  issue: Pick<typeof issues.$inferSelect, "id" | "executionRunId">;
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">;
  agentName: string;
  now: Date;
}) {
  const { issue, run, now } = input;
  await notifyStatusCardIssueChange(db, run.companyId);
  await releaseNativeCheckpointRetryWaits(db, { issue, run });
  const restored = await db.update(issues).set({ executionRunId: run.id,
    executionAgentNameKey: normalizeAgentNameKey(input.agentName), executionLockedAt: now, updatedAt: now,
  }).where(and(eq(issues.id, issue.id), eq(issues.companyId, run.companyId),
    or(isNull(issues.executionRunId), eq(issues.executionRunId, run.id)),
  )).returning({ id: issues.id });
  if (!restored.length) throw new Error("native_session_execution_binding_changed");
  if (issue.executionRunId !== run.id) await appendHeartbeatRunEvent(db, {
    companyId: run.companyId, runId: run.id, agentId: run.agentId,
    eventType: "native.recovery.execution_reclaimed", stream: "system", level: "info",
    message: "Reclaimed the original task execution for native session recovery.", payload: { issueId: issue.id },
  });
}

function nativeSessionResumptionStopped(run: typeof heartbeatRuns.$inferSelect,
  coordinator: typeof nativeRunFinalizations.$inferSelect) {
  const cancellation = readRunCancellation(run.resultJson);
  const nativeCancellation = run.resultJson?.nativeCancellation as { scope?: unknown; dispatchState?: unknown } | undefined;
  return (cancellation?.source === "operator" && cancellation.expected) ||
    (["run", "issue"].includes(String(nativeCancellation?.scope)) &&
      ["pending", "acknowledged"].includes(String(nativeCancellation?.dispatchState))) ||
    typeof coordinator.failureDetail?.successorRunId === "string";
}

export async function readNativeSessionResumptionAgent(db: Db, input: {
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "executionRunId" | "checkoutRunId" | "assigneeAgentId">;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
}) {
  const { issue, run, coordinator } = input;
  if (issue.companyId !== run.companyId || issue.id !== run.nativeIssueId ||
      coordinator.companyId !== run.companyId || coordinator.issueId !== issue.id || coordinator.runId !== run.id ||
      !(NATIVE_SESSION_RESUMPTION_ISSUE_STATUSES as readonly string[]).includes(issue.status) ||
      (issue.executionRunId && issue.executionRunId !== run.id) ||
      (issue.checkoutRunId && issue.checkoutRunId !== run.id)) return null;
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.companyId, run.companyId), eq(agents.id, run.agentId),
  )).limit(1);
  if (!agent || !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return null;
  if (issue.assigneeAgentId !== run.agentId && !await getNativeReviewAssignment(db, {
    companyId: run.companyId, issueId: issue.id, agentId: run.agentId, contextSnapshot: run.contextSnapshot,
  })) return null;
  if (await isAutomaticRecoverySuppressedByPauseHold(db, run.companyId, issue.id)) return null;
  if (!(await issueService(db).getDependencyReadiness(issue.id, db)).isDependencyReady) return null;
  const [competing] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
    inArray(heartbeatRuns.status, issue.executionRunId === run.id
      ? ["running", "scheduled_retry"] : ["queued", "running", "scheduled_retry"]),
    or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
  )).limit(1);
  if (competing) return null;
  if (nativeSessionResumptionStopped(run, coordinator)) return null;
  return agent;
}

export async function pendingNativeCheckpointRetry(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
}): Promise<boolean> {
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, input.issueId),
    eq(nativeRunFinalizations.runId, input.runId),
  )).for("update").limit(1);
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
  )).for("update").limit(1);
  return Boolean(run && coordinator && run.runtimeMode === "native" && run.status === "failed"
    && run.runnerProfileJson?.legacyWorkspaceRecoveryMigration == null
    && coordinator.phase === "retryable_failure" && coordinator.resultId === null
    && coordinator.failureDetail?.recoveryMode === "exact_checkpoint_resume"
    && !nativeSessionResumptionStopped(run, coordinator));
}
