import { z } from "zod";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, chatActions, chatConversations, chatEndpoints, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { DbOrTransaction } from "./runtime-types.js";

export const taskRetryInputSchema = z.object({
  // This is a server-selected snapshot of the durable queue, not client input.
  // Truncating it strands older requests or makes the newer-input guard reject
  // every Retry. Dispatch already carries the full queue with bounded inline text.
  sourceActionIds: z.array(z.string().uuid()).refine(ids => new Set(ids).size === ids.length),
  skippedActionIds: z.array(z.string().uuid()).optional(),
  runtimeFence: z.object({ generation: z.number().int().nonnegative(),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
}).refine(value => !value.skippedActionIds || (
  new Set(value.skippedActionIds).size === value.skippedActionIds.length &&
  value.skippedActionIds.every(id => value.sourceActionIds.includes(id))
));
export type TaskRetryInput = z.infer<typeof taskRetryInputSchema>;

export async function selectTaskRetryInput(tx: DbOrTransaction, input: {
  companyId: string; issueId: string; agentId: string; failedRunId: string;
}) {
  const [conversation] = await tx.select({ id: chatConversations.id, runCreatedAt: heartbeatRuns.createdAt }).from(chatConversations)
    .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId))
    .innerJoin(chatActions, and(eq(chatActions.companyId, chatConversations.companyId),
      eq(chatActions.conversationId, chatConversations.id)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, chatConversations.companyId),
      eq(heartbeatRuns.wakeupRequestId, chatActions.id))).where(and(
      eq(chatConversations.companyId, input.companyId), eq(chatConversations.issueId, input.issueId),
      eq(heartbeatRuns.id, input.failedRunId), eq(heartbeatRuns.agentId, input.agentId),
      eq(chatEndpoints.provider, "github"), eq(chatEndpoints.assignedAgentId, input.agentId),
      eq(chatEndpoints.externalExecutionPolicy, "restricted"),
    )).limit(1);
  if (!conversation) return undefined;
  const pending = await tx.select({ id: chatActions.id, status: agentWakeupRequests.status }).from(chatActions)
    .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.companyId, chatActions.companyId),
      eq(agentWakeupRequests.id, chatActions.id))).where(and(
      eq(chatActions.companyId, input.companyId), eq(chatActions.conversationId, conversation.id),
      eq(chatActions.kind, "inbound_wakeup"), eq(agentWakeupRequests.agentId, input.agentId),
      or(and(eq(chatActions.status, "processed"), eq(agentWakeupRequests.status, "deferred_issue_execution")),
        and(eq(chatActions.status, "failed"), eq(agentWakeupRequests.status, "skipped"),
          inArray(agentWakeupRequests.reason, ["budget.blocked", "agent.not_invokable"]),
          sql`${chatActions.payload}->>'requestedByActorType' = 'user'`,
          gt(chatActions.createdAt, conversation.runCreatedAt))),
      isNull(agentWakeupRequests.runId),
    )).orderBy(asc(chatActions.createdAt), asc(chatActions.id)).for("update", { of: agentWakeupRequests });
  return taskRetryInputSchema.parse({ sourceActionIds: pending.map(row => row.id),
    skippedActionIds: pending.filter(row => row.status === "skipped").map(row => row.id) });
}

export async function claimTaskRetryInput(tx: DbOrTransaction, input: {
  companyId: string; retryActionId: string; sourceActionIds: string[];
}) {
  if (!input.sourceActionIds.length) return;
  await tx.update(agentWakeupRequests).set({ status: "coalesced", updatedAt: new Date(),
    payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({
      coalescedIntoWakeupRequestId: input.retryActionId })}::jsonb`,
  }).where(and(eq(agentWakeupRequests.companyId, input.companyId),
    inArray(agentWakeupRequests.id, input.sourceActionIds), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    isNull(agentWakeupRequests.runId)));
}

export async function settleTaskRetryInput(tx: DbOrTransaction, input: { companyId: string; retryActionId: string; runId: string | null }) {
  if (!input.runId) return;
  await tx.update(agentWakeupRequests).set({ runId: input.runId, updatedAt: new Date() }).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "coalesced"),
    isNull(agentWakeupRequests.runId),
    sql`${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId' = ${input.retryActionId}`,
  ));
}

export async function releaseUnadmittedTaskRetryInput(db: Db, input: { companyId: string; retryActionId: string }) {
  await db.transaction(async tx => {
    const [snapshot] = await tx.select({ payload: chatActions.payload }).from(chatActions).where(and(
      eq(chatActions.companyId, input.companyId), eq(chatActions.id, input.retryActionId),
    ));
    const issueId = z.string().uuid().safeParse(snapshot?.payload.issueId);
    if (!issueId.success) return;
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, issueId.data),
    )).for("update");
    if (!issue) return;
    const [action] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId),
      eq(chatActions.id, input.retryActionId), eq(chatActions.kind, "failed_run_retry"),
      sql`${chatActions.payload}->>'issueId' = ${issue.id}`,
      inArray(chatActions.status, ["failed", "cancelled"]))).for("update");
    if (!action || typeof action.payload.taskRetryIntentId !== "string") return;
    const [receipt] = await tx.select({ runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.retryActionId),
    )).for("update");
    if (receipt?.runId) return;
    await tx.update(agentWakeupRequests).set({ status: "deferred_issue_execution", finishedAt: null,
      payload: sql`${agentWakeupRequests.payload} - 'coalescedIntoWakeupRequestId'`, updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "coalesced"),
      isNull(agentWakeupRequests.runId),
      sql`${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId' = ${input.retryActionId}`));
    await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() }).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, action.payload.taskRetryIntentId),
      eq(agentWakeupRequests.reason, "task_retry"), isNull(agentWakeupRequests.runId),
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued", "claimed"]),
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}' = ${action.id}`,
    ));
  });
}
