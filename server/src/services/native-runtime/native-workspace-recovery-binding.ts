import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { getNativeReviewAssignment } from "./native-review-participant.js";

/** Both operator and platform recovery must still own the task's accepted work.
 * Call with coordinator -> issue -> run rows locked in a short transaction. */
export async function currentNativeWorkspaceRecoveryResult(db: Db, input: {
  companyId: string;
  issue: typeof issues.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
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
  const [result] = await db.select().from(nativeRunResults).where(and(
    eq(nativeRunResults.id, coordinator.resultId), eq(nativeRunResults.companyId, companyId),
    eq(nativeRunResults.issueId, issue.id), eq(nativeRunResults.runId, run.id), eq(nativeRunResults.schemaStatus, "accepted"),
  ));
  if (!result || result.completionContractId !== run.completionContractId) return null;
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), ne(heartbeatRuns.id, run.id),
    or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    or(gt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, ["queued", "running"])),
  )).limit(1);
  return newer ? null : result;
}
