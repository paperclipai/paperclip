import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, chatCompletionDeliveries as deliveries, chatTaskHandoffs as handoffs,
  heartbeatRuns, issueComments, issueDocuments, issues, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";

export const CHAT_COMPLETION_WAKE_REASON = "chat_task_completed";
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;
type Issue = typeof issues.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Connection = Db | Tx;
const pending = ["pending", "queued"] as const;
const activeRuns = ["queued", "scheduled_retry", "running"];
function ids(run: Run): string[] {
  const value = run.contextSnapshot?.chatCompletionDeliveryIds;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function recordChatHandoff(tx: Connection, task: Issue, actorRunId: string | null | undefined) {
  if (!actorRunId || task.conversationAgentId || !task.createdByAgentId) return;
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actorRunId),
    eq(heartbeatRuns.companyId, task.companyId), eq(heartbeatRuns.agentId, task.createdByAgentId)));
  const sourceId = run?.nativeIssueId ?? run?.contextSnapshot?.issueId;
  if (typeof sourceId !== "string" || sourceId === task.id) return;
  const [source] = await tx.select().from(issues).where(and(eq(issues.id, sourceId), eq(issues.companyId, task.companyId)));
  if (!source?.conversationAgentId || source.conversationAgentId !== run.agentId ||
    source.conversationSessionGeneration !== run.contextSnapshot?.conversationSessionGeneration) return;
  await tx.insert(handoffs).values({ taskId: task.id, companyId: task.companyId,
    conversationId: source.id, agentId: source.conversationAgentId, sessionGeneration: source.conversationSessionGeneration }).onConflictDoNothing();
}

/** Must run on the same transaction as status projection (including native arbitration). */
export async function recordChatCompletion(tx: Connection, before: Issue, after: Issue) {
  if (before.status === after.status) return;
  await tx.update(deliveries).set({ status: "superseded" }).where(and(eq(deliveries.taskId, after.id),
    eq(deliveries.companyId, after.companyId), inArray(deliveries.status, [...pending])));
  if (after.status !== "done") return;
  const [handoff] = await tx.select().from(handoffs).where(and(eq(handoffs.taskId, after.id), eq(handoffs.companyId, after.companyId)));
  if (handoff) await tx.insert(deliveries).values({ companyId: after.companyId, taskId: after.id, statusVersion: after.statusVersion }).onConflictDoNothing();
}

async function loadAudience(tx: Connection, deliveryId: string) {
  const [row] = await tx.select({ delivery: deliveries, handoff: handoffs, task: issues }).from(deliveries)
    .innerJoin(handoffs, and(eq(handoffs.taskId, deliveries.taskId), eq(handoffs.companyId, deliveries.companyId)))
    .innerJoin(issues, and(eq(issues.id, deliveries.taskId), eq(issues.companyId, deliveries.companyId)))
    .where(eq(deliveries.id, deliveryId));
  if (!row) return null;
  const [source] = await tx.select().from(issues).where(and(eq(issues.id, row.handoff.conversationId), eq(issues.companyId, row.handoff.companyId)));
  return { ...row, source };
}
function current(row: NonNullable<Awaited<ReturnType<typeof loadAudience>>>) {
  return row.task.status === "done" && !["superseded", "exhausted"].includes(row.delivery.status) &&
    row.source?.conversationAgentId === row.handoff.agentId &&
    row.source.conversationSessionGeneration === row.handoff.sessionGeneration;
}

async function taskResult(tx: Connection, task: Issue) {
  // Never copy worker-authored titles, comments or document bodies into the
  // source agent's instructions. These links and lifecycle facts are generated
  // by the server; the saved work remains on its normal access-controlled task.
  const documents = await tx.select({ id: issueDocuments.documentId }).from(issueDocuments)
    .where(and(eq(issueDocuments.companyId, task.companyId), eq(issueDocuments.issueId, task.id))).limit(1);
  return { id: task.id, identifier: task.identifier, status: task.status,
    completedAt: task.completedAt, url: `/issues/${task.identifier ?? task.id}`,
    hasSavedDocuments: documents.length > 0 };
}

/** A completed onboarding parent still owes the result of its own child handoff.
 * This permits a reporting turn without reopening Done or reviving cancellation. */
export async function isCompletedOnboardingHandoffWake(db: Connection, input: {
  companyId: string; issueId: string; agentId: string; reason: string | null;
  contextSnapshot: Record<string, unknown>;
}) {
  if (input.reason !== "issue_children_completed" || typeof input.contextSnapshot.completedChildIssueId !== "string") return false;
  const [source] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (source?.originKind !== "onboarding_first_task" || source.status !== "done" || source.assigneeAgentId !== input.agentId) return false;
  const children = await db.select({ id: issues.id, status: issues.status }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.parentId, source.id)));
  return children.some(child => child.id === input.contextSnapshot.completedChildIssueId && child.status === "done") &&
    children.every(child => ["done", "cancelled"].includes(child.status));
}

/** Freeze the input at turn start. New completions cannot be consumed by an already-running turn. */
export async function prepareChatCompletionTurn(db: Db, run: Run): Promise<Run> {
  const issueId = run.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return run;
  return db.transaction(async tx => {
    const [source] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).for("update");
    if (!source) return run;
    if (source.originKind === "onboarding_first_task" && run.contextSnapshot?.wakeReason === "issue_children_completed") {
      const children = await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.parentId, source.id), eq(issues.status, "done"))).orderBy(issues.createdAt).limit(20);
      const contextSnapshot = { ...run.contextSnapshot, onboardingCompletion: true,
        chatCompletionUpdates: await Promise.all(children.map(child => taskResult(tx, child))) };
      await tx.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, run.id));
      return { ...run, contextSnapshot };
    }
    const initialIds = ids(run);
    // Only completion wakes absorb pending events; ordinary user turns retain their existing input.
    if (initialIds.length === 0 && run.contextSnapshot?.wakeReason !== CHAT_COMPLETION_WAKE_REASON) return run;
    if (run.contextSnapshot?.conversationSessionGeneration !== source.conversationSessionGeneration) throw new Error("chat_completion_superseded");
    const rows = await tx.select({ delivery: deliveries }).from(deliveries).innerJoin(handoffs, eq(handoffs.taskId, deliveries.taskId))
      .where(and(eq(deliveries.companyId, run.companyId), eq(handoffs.conversationId, issueId),
        eq(handoffs.agentId, run.agentId), eq(handoffs.sessionGeneration, source.conversationSessionGeneration),
        inArray(deliveries.status, [...pending]),
        sql`(${deliveries.targetRunId} is null or ${deliveries.targetRunId} = ${run.id})`))
      .orderBy(asc(deliveries.createdAt)).limit(20);
    const updates: Awaited<ReturnType<typeof taskResult>>[] = [];
    const accepted: string[] = [];
    for (const { delivery } of rows) {
      const row = await loadAudience(tx, delivery.id);
      if (!row || !current(row)) {
        await tx.update(deliveries).set({ status: "superseded" }).where(eq(deliveries.id, delivery.id));
        continue;
      }
      accepted.push(delivery.id); updates.push(await taskResult(tx, row.task));
      await tx.update(deliveries).set({ status: "queued", targetRunId: run.id }).where(eq(deliveries.id, delivery.id));
    }
    if (accepted.length === 0) throw new Error("chat_completion_superseded");
    const contextSnapshot = { ...run.contextSnapshot, chatCompletionDeliveryIds: accepted, chatCompletionUpdates: updates };
    await tx.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, run.id));
    return { ...run, contextSnapshot };
  });
}

export function chatCompletionInstruction(context: Record<string, unknown>) {
  if (!Array.isArray(context.chatCompletionUpdates) || !context.chatCompletionUpdates.length) return "";
  return `\n\nDelegated work has completed. Tell the user in this conversation what finished and provide access using the supplied task links. Report completion only for the tasks listed in this update; other tasks receive their own completion updates. Use the recorded status and result locations; do not repeat a promise to do work that is already Done. Do not start more work or change these tasks. The following JSON contains server-recorded lifecycle facts and result locations:\n${JSON.stringify(context.chatCompletionUpdates)}`;
}

/** Called under the comment transaction, before insertion. An event can publish only once. */
export async function existingChatCompletionReply(tx: Connection, runId: string, issueId: string) {
  const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!run || ids(run).length === 0) return null;
  const rows = await tx.select().from(deliveries).where(and(eq(deliveries.companyId, run.companyId), inArray(deliveries.id, ids(run))));
  for (const delivery of rows) {
    // Match the status writer's task-first lock order, then reload the outbox
    // row so a concurrent reopen cannot leave us with its pre-commit snapshot.
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, delivery.taskId), eq(issues.companyId, run.companyId))).for("update");
    const row = await loadAudience(tx, delivery.id);
    if (!row || row.source?.id !== issueId || row.handoff.agentId !== run.agentId || !current(row)) throw new Error("chat_completion_superseded");
    if (row.delivery.responseCommentId) {
      const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, row.delivery.responseCommentId), eq(issueComments.issueId, issueId)));
      if (comment) return comment;
    }
    if (row.delivery.status !== "queued" || row.delivery.targetRunId !== runId) throw new Error("chat_completion_superseded");
  }
  if (rows.length !== ids(run).length) throw new Error("chat_completion_superseded");
  return null;
}
export async function acknowledgeChatCompletionReply(tx: Connection, runId: string, commentId: string) {
  const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!run || ids(run).length === 0) return;
  await tx.update(deliveries).set({ status: "delivered", responseCommentId: commentId, error: null })
    .where(and(eq(deliveries.companyId, run.companyId), inArray(deliveries.id, ids(run)),
      eq(deliveries.targetRunId, runId), eq(deliveries.status, "queued")));
}

/** Only the server's final presentation decision may acknowledge an ordinary
 * provider comment. Progress comments do not pass through this boundary. */
export async function acknowledgeReusedChatCompletionReply(db: Db, input: {
  companyId: string; issueId: string; runId: string; commentId: string;
}) {
  return db.transaction(async tx => {
    // Share the publication/reset fence and task-first lock order of addComment.
    const [source] = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    ));
    if (!source || !run || ids(run).length === 0) return;
    const [comment] = await tx.select().from(issueComments).where(and(
      eq(issueComments.id, input.commentId), eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId), eq(issueComments.createdByRunId, run.id),
      eq(issueComments.authorAgentId, run.agentId),
    )).for("share");
    if (!comment) return;
    const existing = await existingChatCompletionReply(tx, run.id, source.id);
    if (existing && existing.id !== comment.id) return;
    await acknowledgeChatCompletionReply(tx, run.id, comment.id);
  });
}

export function chatCompletionDeliveryService(db: Db, heartbeat: { wakeup(agentId: string, options: {
  source: "automation"; triggerDetail: "system"; reason: string; idempotencyKey: string; allowRunCoalescing: boolean;
  requestedByActorType: "system"; requestedByActorId: string; payload: Record<string, unknown>; contextSnapshot: Record<string, unknown>;
}): Promise<{ id: string } | null> }) {
  async function deliver(id: string): Promise<void> {
    // Lease outbox work before leaving the transaction; recovery reuses the same wake key.
    const claimed = await db.update(deliveries).set({ nextAttemptAt: new Date(Date.now() + LEASE_MS) })
      .where(and(eq(deliveries.id, id), inArray(deliveries.status, [...pending]), lte(deliveries.nextAttemptAt, new Date())))
      .returning().then(rows => rows[0]);
    if (!claimed) return;
    try {
      const row = await loadAudience(db, id);
      if (!row || !current(row)) {
        await db.update(deliveries).set({ status: "superseded" }).where(eq(deliveries.id, id)); return;
      }
      if (!(await instanceSettingsService(db).getExperimental()).enableAgentChat) return;
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, row.handoff.agentId), eq(agents.companyId, claimed.companyId)));
      if (!agent || ["paused", "terminated"].includes(agent.status)) return;
      const key = `chat-completion:${id}:${claimed.attempts}`;
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, claimed.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
      const runId = claimed.targetRunId ?? wakes.find(w => w.runId)?.runId;
      if (runId) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        if (run && activeRuns.includes(run.status)) return;
        // A published reply is acknowledged in its own transaction, independent of run outcome.
        const [latest] = await db.select().from(deliveries).where(eq(deliveries.id, id));
        if (!latest || !pending.includes(latest.status as typeof pending[number])) return;
        await db.update(deliveries).set({ status: claimed.attempts + 1 >= MAX_ATTEMPTS ? "exhausted" : "pending",
          attempts: claimed.attempts + 1, targetRunId: null, nextAttemptAt: new Date(),
          error: run?.error ?? "Completion turn ended without a reply" })
          .where(and(eq(deliveries.id, id), inArray(deliveries.status, [...pending])));
        // The failed run is already terminal. Reclaim the advanced attempt now;
        // a second lease interval would only delay restart recovery. The atomic
        // claim and fresh wake key still serialize competing sweepers.
        if (claimed.attempts + 1 < MAX_ATTEMPTS) await deliver(id);
        return;
      }
      if (wakes.some(w => ["queued", "claimed", "deferred_issue_execution", "coalesced"].includes(w.status))) return;
      if (wakes.length) {
        // Terminal receipts must advance the key; reusing them collides forever.
        const dailyCap = wakes.some(w => w.reason?.startsWith("heartbeat.daily_"));
        const next = new Date(Date.now() + LEASE_MS);
        if (dailyCap) next.setUTCHours(24, 0, 0, 0);
        await db.update(deliveries).set({ attempts: claimed.attempts + 1, targetRunId: null,
          status: !dailyCap && claimed.attempts + 1 >= MAX_ATTEMPTS ? "exhausted" : "pending",
          nextAttemptAt: next, error: wakes[0].reason ?? "Completion wake did not start" })
          .where(and(eq(deliveries.id, id), inArray(deliveries.status, [...pending])));
        return;
      }
      // One undispatched head per conversation. Its turn absorbs the remaining
      // events at admission; events arriving after admission need a later turn.
      const siblings = await db.select({ delivery: deliveries, run: heartbeatRuns }).from(deliveries)
        .innerJoin(handoffs, eq(handoffs.taskId, deliveries.taskId))
        .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, deliveries.targetRunId))
        .where(and(eq(deliveries.companyId, claimed.companyId), eq(handoffs.conversationId, row.handoff.conversationId),
          eq(handoffs.sessionGeneration, row.handoff.sessionGeneration), inArray(deliveries.status, [...pending])))
        .orderBy(asc(deliveries.createdAt), asc(deliveries.id));
      if (siblings.some(s => s.run && activeRuns.includes(s.run.status) &&
        !Array.isArray(s.run.contextSnapshot?.chatCompletionUpdates))) return;
      if (siblings.find(s => !s.delivery.targetRunId)?.delivery.id !== id) return;
      const run = await heartbeat.wakeup(row.handoff.agentId, {
        source: "automation", triggerDetail: "system", reason: CHAT_COMPLETION_WAKE_REASON, idempotencyKey: key, allowRunCoalescing: false,
        requestedByActorType: "system", requestedByActorId: "chat_completion_delivery",
        payload: { issueId: row.handoff.conversationId, chatCompletionDeliveryIds: [id] },
        contextSnapshot: { issueId: row.handoff.conversationId, taskId: row.handoff.conversationId,
          wakeReason: CHAT_COMPLETION_WAKE_REASON, chatCompletionDeliveryIds: [id], conversationSessionGeneration: row.handoff.sessionGeneration },
      });
      if (!run) {
        const receipts = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, claimed.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
        if (!receipts.length) throw new Error("Completion wake returned no run or durable receipt");
      }
      if (run) await db.update(deliveries).set({ targetRunId: run.id, status: "queued" })
        .where(and(eq(deliveries.id, id), inArray(deliveries.status, [...pending]), sql`${deliveries.targetRunId} is null`));
    } catch (error) {
      const receipts = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, claimed.companyId), eq(agentWakeupRequests.idempotencyKey, `chat-completion:${id}:${claimed.attempts}`)));
      await db.update(deliveries).set({ error: error instanceof Error ? error.message : String(error),
        ...(receipts.length ? {} : { attempts: claimed.attempts + 1,
          status: claimed.attempts + 1 >= MAX_ATTEMPTS ? "exhausted" as const : "pending" as const }) })
        .where(and(eq(deliveries.id, id), inArray(deliveries.status, [...pending])));
    }
  }
  async function sweepPending(scope?: { companyId: string; taskId: string }) {
    const due = await db.select({ id: deliveries.id }).from(deliveries)
      .where(and(inArray(deliveries.status, [...pending]), lte(deliveries.nextAttemptAt, new Date()),
        ...(scope ? [eq(deliveries.companyId, scope.companyId), eq(deliveries.taskId, scope.taskId)] : [])))
      .orderBy(asc(deliveries.nextAttemptAt)).limit(100);
    for (const row of due) await deliver(row.id);
  }
  return { deliver, sweepPending };
}
