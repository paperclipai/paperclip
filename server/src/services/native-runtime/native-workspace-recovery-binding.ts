import { and, eq, gt, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { getNativeReviewAssignment } from "./native-review-participant.js";

export async function currentNativeWorkspaceRecoveryResult(db: Db, input: {
  companyId: string;
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "executionRunId" | "checkoutRunId" | "assigneeAgentId">;
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "runtimeMode" | "status" | "agentId"
    | "contextSnapshot" | "completionContractId" | "createdAt">;
  coordinator: Pick<typeof nativeRunFinalizations.$inferSelect, "companyId" | "issueId" | "runId" | "phase" | "resultId">;
}) {
  const { companyId, issue, run, coordinator } = input;
  if (issue.companyId !== companyId || run.companyId !== companyId || coordinator.companyId !== companyId
    || run.nativeIssueId !== issue.id || coordinator.issueId !== issue.id || coordinator.runId !== run.id
    || run.runtimeMode !== "native" || run.status !== "running"
    || !["result_accepted", "workspace_finalizing", "retryable_failure"].includes(coordinator.phase)
    || !coordinator.resultId || ["done", "cancelled"].includes(issue.status)
    || issue.executionRunId !== run.id || (issue.checkoutRunId && issue.checkoutRunId !== run.id)) return null;
  if (issue.assigneeAgentId !== run.agentId && !await getNativeReviewAssignment(db, {
    companyId, issueId: issue.id, agentId: run.agentId,
    contextSnapshot: run.contextSnapshot, actingRunId: run.id, issueExecutionRunId: issue.executionRunId,
    allowResolvedByRunId: run.id,
  })) return null;
  const [result] = await db.select({ id: nativeRunResults.id, completionContractId: nativeRunResults.completionContractId }).from(nativeRunResults).where(and(
    eq(nativeRunResults.id, coordinator.resultId), eq(nativeRunResults.companyId, companyId),
    eq(nativeRunResults.issueId, issue.id), eq(nativeRunResults.runId, run.id), eq(nativeRunResults.schemaStatus, "accepted"),
  ));
  if (!result || result.completionContractId !== run.completionContractId) return null;
  // The assignee's later wakes, such as an answer to this run's question,
  // cannot claim while this run holds the execution lock. They wait for this
  // copyback, so they are not newer work. Other agents' runs are not blocked.
  const waitingWake = issue.assigneeAgentId === run.agentId ? and(
    eq(heartbeatRuns.status, "queued"), isNull(heartbeatRuns.startedAt),
    eq(heartbeatRuns.agentId, run.agentId), gt(heartbeatRuns.createdAt, run.createdAt),
    sql`coalesce(${heartbeatRuns.contextSnapshot}->>'wakeReason', '') <> 'source_scoped_recovery_action'`,
  ) : undefined;
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), ne(heartbeatRuns.id, run.id),
    or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    or(gt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, ["queued", "running"])),
    waitingWake ? not(waitingWake) : undefined,
  )).limit(1);
  return newer ? null : result;
}
