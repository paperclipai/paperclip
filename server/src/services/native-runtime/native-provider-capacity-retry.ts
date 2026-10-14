import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { accountingForScheduledRetry, executionFailureRetryCount } from "../execution-recovery-attempt.js";
import { NATIVE_PROVIDER_CAPACITY_MAX_RETRIES, NATIVE_PROVIDER_OVERLOADED_CODE, NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";

/** Called under the finalizer's issue/coordinator locks, in the status-effect transaction. */
export async function materializeNativeProviderCapacityRetry(input: {
  tx: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
}) {
  const [run] = await input.tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
  )).for("update");
  if (!run || run.runtimeMode !== "native") throw new Error("native_capacity_retry_run_binding_mismatch");
  // Share the predecessor claim with every other failure-retry lane.
  const [existing] = await input.tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.retryOfRunId, run.id),
  )).limit(1);
  if (existing) return existing.id;
  const attempt = executionFailureRetryCount(run) + 1;
  if (attempt > NATIVE_PROVIDER_CAPACITY_MAX_RETRIES) throw new Error("native_capacity_retry_exhausted");
  const now = new Date();
  const dueAt = new Date(now.getTime() + 60_000 * 2 ** (attempt - 1));
  const retryId = randomUUID();
  const predecessorContext = { ...run.contextSnapshot };
  // Resume receipts and delivered wake input belong to the failed run. The
  // new turn has ordinary task authority; history comes from retryOfRunId.
  // Match the consumed-input boundary used by native safe replacements.
  for (const key of [
    "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
    "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
    "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
    "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
  ]) delete predecessorContext[key];
  const contextSnapshot = {
    ...predecessorContext,
    issueId: input.issueId,
    taskId: input.issueId,
    forceFreshSession: true,
    retryOfRunId: run.id,
    retryReason: NATIVE_PROVIDER_OVERLOADED_CODE,
    wakeReason: NATIVE_PROVIDER_OVERLOADED_CODE,
    scheduledRetryAttempt: attempt,
    scheduledRetryAt: dueAt.toISOString(),
    executionRetryAccounting: accountingForScheduledRetry(run, NATIVE_PROVIDER_OVERLOADED_CODE, attempt),
  };
  const [wake] = await input.tx.insert(agentWakeupRequests).values({
    companyId: run.companyId, agentId: run.agentId, source: "automation", triggerDetail: "system",
    reason: NATIVE_PROVIDER_OVERLOADED_CODE, status: "queued", runId: retryId,
    idempotencyKey: `native-capacity:${run.companyId}:${run.id}`,
    requestedByActorType: "system", requestedByActorId: "native_finalizer",
    payload: contextSnapshot,
  }).returning({ id: agentWakeupRequests.id });
  await input.tx.insert(heartbeatRuns).values({
    id: retryId, companyId: run.companyId, agentId: run.agentId,
    invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry",
    responsibleUserId: run.responsibleUserId, wakeupRequestId: wake.id,
    retryOfRunId: run.id, scheduledRetryReason: NATIVE_PROVIDER_OVERLOADED_CODE,
    scheduledRetryAttempt: attempt, scheduledRetryAt: dueAt,
    error: NATIVE_PROVIDER_OVERLOADED_MESSAGE, errorCode: NATIVE_PROVIDER_OVERLOADED_CODE,
    contextSnapshot,
  });
  return retryId;
}
