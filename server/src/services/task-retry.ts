import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, chatActions, chatConversations, chatEndpoints, heartbeatRuns, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { createSystemRecovery, readSystemRecovery } from "./system-recovery-state.js";
import { updateSystemRecovery } from "./system-recovery.js";
import { instanceSettingsService } from "./instance-settings.js";

export async function assertTaskRetryConversationAllowed(
  db: Db,
  issue: { conversationAgentId?: string | null; conversationUserId?: string | null },
  actorId: string,
) {
  if (!issue.conversationAgentId) return;
  if (!(await instanceSettingsService(db).getExperimental()).enableAgentChat) throw notFound("Agent Chat is disabled");
  if (issue.conversationUserId !== actorId) throw forbidden("Only the conversation owner can retry a chat run");
}

const taskRetryIntentSchema = z.object({
  schema: z.literal("paperclip.task-retry.v1"), generationId: z.string().uuid(), sourceRunId: z.string().uuid(),
  actorId: z.string().min(1), actorSource: z.enum(["local_implicit", "session", "board_key", "cloud_tenant"]).default("session"), strategy: z.enum(["evaluate", "continue", "fresh_isolated_workspace", "finalize_result"]),
  chatActionId: z.string().uuid().optional(), canonicalIntentId: z.string().uuid().optional(),
});
export type TaskRetryIntent = z.infer<typeof taskRetryIntentSchema>;
export function readTaskRetryIntent(payload: Record<string, unknown> | null | undefined): TaskRetryIntent | null {
  const result = taskRetryIntentSchema.safeParse(payload?.taskRetry);
  return result.success ? result.data : null;
}

/** Caller holds the issue dispatch lock. Newer work supersedes an unadmitted
 * Retry; retiring its authority does not acknowledge or discard saved input. */
export async function retireSupersededTaskRetry(db: Db, input: {
  companyId: string; issueId: string; requestId: string; sourceRunId: string;
}) {
  const [latest] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (latest?.id === input.sourceRunId) return false;
  const retired = await db.update(agentWakeupRequests).set({ status: "skipped", error: "task_retry_superseded",
    finishedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.requestId),
    eq(agentWakeupRequests.reason, "task_retry"), sql`${agentWakeupRequests.runId} is null`,
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued", "claimed"]),
  )).returning({ id: agentWakeupRequests.id });
  return retired.length > 0;
}

/** Persist a deliberate click under dispatch's issue-first lock order. This
 * transaction never contacts a provider. The normal wake queue owns execution. */
export async function requestTaskRetry(input: {
  db: Db; companyId: string; issueId: string; actorId: string;
  idempotencyKey: string; observedRunId: string | null; actorSource?: string;
  prepareChatRetry?: (tx: Db, scope: { companyId: string; issueId: string; agentId: string;
    failedRunId: string; initiatedByUserId: string; retryIntentId?: string }) => Promise<{ actionId: string }>;
}) {
  return input.db.transaction(async tx => {
    const db = tx as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("update");
    if (!issue) throw notFound("Task not found");
    await assertTaskRetryConversationAllowed(db, issue, input.actorId);
    const key = `task-retry:${input.idempotencyKey}`;
    const [sameRequest] = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    if (sameRequest) {
      if (sameRequest.payload?.issueId !== issue.id || sameRequest.requestedByActorId !== input.actorId)
        throw conflict("This retry request belongs to a different task or user.");
      const intent = readTaskRetryIntent(sameRequest.payload);
      return { requestId: intent?.canonicalIntentId ?? sameRequest.id, accepted: true, stale: false,
        observedRunId: intent?.sourceRunId ?? null, chatActionId: intent?.chatActionId };
    }
    const [latest] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId),
      or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (["done", "cancelled"].includes(issue.status) || !issue.assigneeAgentId || !latest ||
        latest.agentId !== issue.assigneeAgentId || input.observedRunId !== latest.id) {
      return { requestId: null, accepted: false, stale: true, observedRunId: latest?.id ?? null };
    }
    let active = (await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
      sql`${agentWakeupRequests.payload}->'taskRetry'->>'schema' = 'paperclip.task-retry.v1'`,
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued", "claimed"]),
    )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1)).at(0);
    const activeIntent = readTaskRetryIntent(active?.payload);
    if (active && !active.runId && activeIntent && await retireSupersededTaskRetry(db, {
      companyId: issue.companyId, issueId: issue.id, requestId: active.id, sourceRunId: activeIntent.sourceRunId,
    })) active = undefined;
    if (active && !active.runId && issue.conversationAgentId && active.requestedByActorId !== issue.conversationUserId) {
      // A former owner's unadmitted receipt cannot own the new owner's Retry.
      await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, active.id));
      active = undefined;
    }
    const busy = ["queued", "running", "scheduled_retry"].includes(latest.status);
    const records = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${latest.id}`)).for("update");
    // An unadmitted request can outlive its exhausted repair. A new deliberate
    // click replaces that generation; a replay of the same key returned above.
    if (active && !busy && !active.runId && records.some(action =>
      readSystemRecovery(action.evidence)?.state === "exhausted")) {
      await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, active.id));
      active = undefined;
    }
    const id = randomUUID();
    const intent: TaskRetryIntent = { schema: "paperclip.task-retry.v1", generationId: active?.id ?? id,
      sourceRunId: latest.id, actorId: input.actorId,
      actorSource: taskRetryIntentSchema.shape.actorSource.parse(input.actorSource ?? "session"), strategy: "evaluate",
      ...(active ? { canonicalIntentId: active.id } : {}) };
    // Preserve external chat authority through its existing admission owner.
    // Generic board Retry must never manufacture a chat-inbound request.
    const [chat] = await tx.select({ id: chatConversations.id }).from(chatConversations)
      .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId)).where(and(
        eq(chatConversations.companyId, issue.companyId), eq(chatConversations.issueId, issue.id),
        eq(chatEndpoints.externalExecutionPolicy, "restricted"))).limit(1);
    await tx.insert(agentWakeupRequests).values({ id, companyId: issue.companyId, agentId: issue.assigneeAgentId,
      source: "on_demand", triggerDetail: "manual", reason: "task_retry", idempotencyKey: key,
      requestedByActorType: "user", requestedByActorId: input.actorId,
      status: active || busy ? "coalesced" : "deferred_issue_execution",
      runId: active?.runId ?? (busy ? latest.id : null),
      payload: { issueId: issue.id, taskRetry: intent }, finishedAt: active || busy ? new Date() : null });
    if (chat && !active && !busy) {
      if (!input.prepareChatRetry) throw conflict("Retry is unavailable for this connected conversation.");
      intent.chatActionId = (await input.prepareChatRetry(db, { companyId: issue.companyId, issueId: issue.id,
        agentId: issue.assigneeAgentId, failedRunId: latest.id, initiatedByUserId: input.actorId, retryIntentId: id })).actionId;
      await tx.update(agentWakeupRequests).set({ payload: { issueId: issue.id, taskRetry: intent } })
        .where(eq(agentWakeupRequests.id, id));
    }
    if (!busy) {
      for (const action of records) {
        const previous = readSystemRecovery(action.evidence);
        if (!previous || previous.state === "complete") continue;
        // Active repair keeps its attempt and cooldown. An exhausted generation
        // gets a new budget only because this click is a new durable intent.
        const next = previous.state === "exhausted"
          ? { ...createSystemRecovery(latest.id, id), revision: previous.revision + 1,
            preservationOperationIds: previous.preservationOperationIds,
            providerCooldownAt: previous.providerCooldownAt, nextAttemptAt: previous.providerCooldownAt }
          : { ...previous, revision: previous.revision + 1, intentId: active?.id ?? id,
            // Retry may advance our backoff, never a provider's cooldown and
            // never an operation whose physical owner is still running.
            nextAttemptAt: previous.state === "running" ? previous.nextAttemptAt
              : Math.max(Date.now(), previous.providerCooldownAt ?? 0) };
        if (next.generationId !== previous.generationId) await persistActivity(db, {
          companyId: issue.companyId, actorType: "system", actorId: "task-retry", entityType: "issue", entityId: issue.id,
          action: "issue.recovery_generation_replaced", runId: latest.id,
          details: { recoveryActionId: action.id, previousGeneration: previous, nextGenerationId: next.generationId },
        });
        await updateSystemRecovery(db, { companyId: issue.companyId, issueId: issue.id, runId: latest.id,
          actionId: action.id }, previous, next);
      }
    }
    await persistActivity(db, { companyId: issue.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.retry_requested", entityType: "issue", entityId: issue.id, runId: latest.id,
      details: { requestId: active?.id ?? id, sourceRunId: latest.id, attachedToExistingWork: Boolean(active || busy) } });
    return { requestId: active?.id ?? id, accepted: true, stale: false, observedRunId: latest.id,
      chatActionId: intent.chatActionId };
  });
}

/** Chat owns admission and authorization. The task receipt follows that
 * durable outcome; it never launches a parallel generic board execution. */
export async function reconcileTaskChatRetryReceipts(db: Db) {
  const pending = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}' is not null`,
  )).orderBy(agentWakeupRequests.updatedAt).limit(50);
  for (const wake of pending) {
    const intent = readTaskRetryIntent(wake.payload);
    if (!intent?.chatActionId) continue;
    const [chat] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, wake.companyId),
      eq(chatActions.id, intent.chatActionId), eq(chatActions.kind, "failed_run_retry"),
      sql`${chatActions.payload}->>'issueId' = ${String(wake.payload?.issueId)}`));
    const [receipt] = chat ? await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, wake.companyId), eq(agentWakeupRequests.id, chat.id),
      eq(agentWakeupRequests.agentId, wake.agentId))) : [];
    const failed = chat && ["failed", "cancelled"].includes(chat.status);
    await db.update(agentWakeupRequests).set({
      ...(receipt?.runId ? { status: "coalesced", runId: receipt.runId, finishedAt: new Date() }
        : failed ? { status: "failed", finishedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution")));
  }
}
