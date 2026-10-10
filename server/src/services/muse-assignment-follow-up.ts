import { withExternalAdmissionGuard } from "../modules/external-agents/index.js";
import { and, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { museAgentBindings, museMailboxItems, museRunnerAssignments, museRunnerOperations, agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";

/** Call inside the issue admission transaction, while its execution lock is held.
 * The caller preserves explicit fresh-session and durable actor receipt policy.
 */
export async function publishActiveMuseComment(db: Db, input: {
  companyId: string; agentId: string; bindingId: string;
  runId: string; issueId: string; commentId: string;
}): Promise<false | { assignmentId: string; consumed: boolean }> {
  // Mailbox writers and cursor readers share the binding lock. An event is a
  // reference to task input; it never grants tools or steers the provider.
  const [binding] = await db.select().from(museAgentBindings).where(and(
    eq(museAgentBindings.id, input.bindingId), eq(museAgentBindings.companyId, input.companyId),
    eq(museAgentBindings.agentId, input.agentId), eq(museAgentBindings.status, "ready"),
    isNull(museAgentBindings.revokedAt))).for("update");
  if (!binding) return false;
  const [assignment] = await db.select({ id: museRunnerAssignments.id }).from(museRunnerAssignments)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, museRunnerAssignments.runId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.runtimeMode, "native"), sql`${heartbeatRuns.nativeSessionId}::text = ${museRunnerAssignments.normalizedSessionId}`))
    .innerJoin(issueComments, and(eq(issueComments.id, input.commentId),
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), isNull(issueComments.deletedAt),
      gte(issueComments.createdAt, museRunnerAssignments.createdAt),
      sql`(${issueComments.authorAgentId} is null or ${issueComments.authorAgentId} <> ${input.agentId})`))
    .where(and(eq(museRunnerAssignments.companyId, input.companyId), eq(museRunnerAssignments.agentId, input.agentId),
      eq(museRunnerAssignments.bindingId, binding.id), eq(museRunnerAssignments.bindingGeneration, binding.generation),
      eq(museRunnerAssignments.runId, input.runId), eq(museRunnerAssignments.status, "accepted"),
      gt(museRunnerAssignments.expiresAt, new Date()))).limit(1);
  if (!assignment) return false;
  // Same key as the event scanner: either path may discover the comment first.
  await db.insert(museMailboxItems).values({ companyId: input.companyId, bindingId: binding.id,
    bindingGeneration: binding.generation, assignmentId: assignment.id, kind: "follow_up",
    sourceEventId: `muse-follow-up:${assignment.id}:${input.commentId}`,
    references: { assignmentId: assignment.id, commentId: input.commentId } }).onConflictDoNothing();
  const [item] = await db.select({ references: museMailboxItems.references }).from(museMailboxItems).where(and(
    eq(museMailboxItems.bindingId, binding.id), eq(museMailboxItems.bindingGeneration, binding.generation),
    eq(museMailboxItems.sourceEventId, `muse-follow-up:${assignment.id}:${input.commentId}`)));
  return { assignmentId: assignment.id, consumed: item?.references.consumed === true };
}

/** A successful history receipt exposes exact comment IDs to Muse. Merely
 * writing a mailbox item, delivering its webhook, or reading its reference
 * does not consume a comment. Keep its wake deferred until this boundary.
 */
export async function consumeMuseHistoryReceipt(db: Db, operation: typeof museRunnerOperations.$inferSelect): Promise<void> {
  const input = operation.command.input as Record<string, unknown> | undefined;
  const result = operation.outcome?.result as { comments?: Array<{ id?: unknown }> } | undefined;
  if (operation.status !== "settled" || operation.command.action !== "tool" || input?.name !== "get_task_history"
      || operation.outcome?.status !== "completed" || operation.outcome?.isError === true || !Array.isArray(result?.comments)) return;
  const ids = result.comments.flatMap(comment => typeof comment?.id === "string" ? [comment.id] : []);
  if (!ids.length) return;
  await db.transaction(async tx => {
    const [source] = await tx.select().from(museRunnerAssignments).where(and(
      eq(museRunnerAssignments.id, operation.assignmentId), eq(museRunnerAssignments.companyId, operation.companyId)));
    if (!source) return;
    const [run] = await tx.select({issueId:heartbeatRuns.nativeIssueId}).from(heartbeatRuns).where(eq(heartbeatRuns.id,source.runId));
    if (!run?.issueId) return;
    // Match queue ownership order before touching any binding or deferred wake.
    await tx.select({id:issues.id}).from(issues).where(and(eq(issues.id,run.issueId),eq(issues.companyId,source.companyId))).for("update");
    const wakes = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, source.companyId), eq(agentWakeupRequests.agentId, source.agentId),
      isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      sql`${agentWakeupRequests.payload}->>'museAssignmentFollowUp' = ${source.id}`)).orderBy(agentWakeupRequests.createdAt,agentWakeupRequests.id).for("update");
    await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(eq(heartbeatRuns.id,source.runId)).for("update");
    return withExternalAdmissionGuard(tx,source.companyId,source.agentId,async()=>{
    const [binding] = await tx.select().from(museAgentBindings).where(and(
      eq(museAgentBindings.id, source.bindingId), eq(museAgentBindings.companyId, source.companyId),
      eq(museAgentBindings.agentId, source.agentId), eq(museAgentBindings.generation, source.bindingGeneration),
      eq(museAgentBindings.status, "ready"), isNull(museAgentBindings.revokedAt))).for("update");
    if (!binding) return;
    const [current] = await tx.select({ issueId: heartbeatRuns.nativeIssueId })
      .from(museRunnerAssignments).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, museRunnerAssignments.runId),
        eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.agentId, source.agentId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "native"),
        sql`${heartbeatRuns.nativeSessionId}::text = ${museRunnerAssignments.normalizedSessionId}`))
      .where(and(eq(museRunnerAssignments.id, source.id), eq(museRunnerAssignments.status, "accepted"),
        gt(museRunnerAssignments.expiresAt, new Date())));
    if (!current?.issueId) return; // A receipt read after completion cannot eat queued work.
    const comments = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, source.companyId), eq(issueComments.issueId, current.issueId),
      inArray(issueComments.id, ids), isNull(issueComments.deletedAt), gte(issueComments.createdAt, source.createdAt),
      sql`(${issueComments.authorAgentId} is null or ${issueComments.authorAgentId} <> ${source.agentId})`));
    if (!comments.length) return;
    // Materialize consumption even if the comment wake has not yet been admitted.
    // Admission, event scanning and receipt reads all serialize on this binding.
    for (const comment of comments) await tx.insert(museMailboxItems).values({
      companyId: source.companyId, bindingId: binding.id, bindingGeneration: binding.generation,
      assignmentId: source.id, kind: "follow_up", sourceEventId: `muse-follow-up:${source.id}:${comment.id}`,
      references: { assignmentId: source.id, commentId: comment.id, consumed: true },
    }).onConflictDoUpdate({ target: [museMailboxItems.bindingId, museMailboxItems.bindingGeneration, museMailboxItems.sourceEventId],
      set: { references: sql`${museMailboxItems.references} || '{"consumed":true}'::jsonb` } });
    const now = new Date();
    const consumed = new Set(comments.map(comment => comment.id));
    for (const wake of wakes) {
      const queued = queuedCommentIdsFromWakePayload(wake.payload);
      const remaining = queued.filter(id => !consumed.has(id));
      if (!queued.length || remaining.length === queued.length) continue;
      await tx.update(agentWakeupRequests).set({
        ...(remaining.length ? { payload: withQueuedCommentIdsInWakePayload(wake.payload, remaining) }
          : { status: "coalesced", runId: source.runId, finishedAt: now }),
        updatedAt: now,
      }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, source.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
    }
    });
  });
}
