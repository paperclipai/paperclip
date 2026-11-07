import { and, eq, isNull, or, sql } from "drizzle-orm";
import { chatConversations, chatEndpoints, chatMessageLinks, heartbeatRuns, issueComments, runIdentityContexts, type Db } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { boundRunIssueId, boundRunIssueIdSql } from "../run-task-binding.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "activeIdentityContextId" | "nativeIssueId" | "issueId" | "contextSnapshot">;
type Context = typeof runIdentityContexts.$inferSelect;

export async function chatRunSourceMessageId(db: Db, run: Run, options: { context?: Context | null; allowLegacyWakeComment?: boolean; provider?: ChatProvider } = {}): Promise<string | null> {
  let legacyMessageId = options.allowLegacyWakeComment && typeof run.contextSnapshot?.wakeCommentId === "string"
    ? run.contextSnapshot.wakeCommentId : null;
  if (!run.activeIdentityContextId) {
    return legacyMessageId;
  }
  let origin = options.context ?? (await db.select().from(runIdentityContexts).where(and(
    eq(runIdentityContexts.id, run.activeIdentityContextId),
    eq(runIdentityContexts.runId, run.id),
    eq(runIdentityContexts.companyId, run.companyId),
    eq(runIdentityContexts.status, "accepted"),
  )).limit(1))[0];
  if (!origin || origin.id !== run.activeIdentityContextId || origin.runId !== run.id ||
      origin.companyId !== run.companyId || origin.status !== "accepted" ||
      origin.responsibleUserId !== run.responsibleUserId) {
    throw forbidden("Chat requester provenance changed");
  }
  const seen = new Set<string>();
  let acceptedMessageSeen = false;
  while (true) {
    if (origin.messageId) {
      acceptedMessageSeen = true;
      if (!options.provider) return origin.messageId;
      const [link] = await db.select({ issueId: chatConversations.issueId, provider: chatEndpoints.provider }).from(chatMessageLinks)
        .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId), eq(chatConversations.companyId, run.companyId)))
        .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId), eq(chatEndpoints.companyId, run.companyId)))
        .where(and(eq(chatMessageLinks.companyId, run.companyId), eq(chatMessageLinks.commentId, origin.messageId), eq(chatMessageLinks.direction, "inbound"))).limit(1);
      if (link) {
        if (link.issueId !== boundRunIssueId(run)) throw forbidden("Chat request belongs to another task");
        if (link.provider !== options.provider) return null;
        return origin.messageId;
      }
      const [message] = await db.select({ authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
        eq(issueComments.id, origin.messageId), eq(issueComments.companyId, run.companyId),
        eq(issueComments.issueId, boundRunIssueId(run) ?? "00000000-0000-0000-0000-000000000000"),
        or(eq(issueComments.authorType, "user"), and(isNull(issueComments.authorType), isNull(issueComments.authorAgentId))),
        isNull(issueComments.deletedAt),
      )).limit(1);
      if (!run.responsibleUserId || message?.authorUserId !== run.responsibleUserId) throw forbidden("Chat requester provenance changed");
      // This verified board message may continue its same-user channel history,
      // but its own wake metadata is not the earlier channel request.
      legacyMessageId = null;
    }
    if (!origin.parentContextId) return legacyMessageId;
    if (seen.has(origin.id)) throw forbidden("Chat source provenance could not be verified");
    seen.add(origin.id);
    const [parent] = await db.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, origin.parentContextId),
      eq(runIdentityContexts.companyId, run.companyId),
      eq(runIdentityContexts.status, "accepted"),
    )).limit(1);
    if (!parent) throw forbidden("Chat requester provenance changed");
    if (parent.responsibleUserId !== run.responsibleUserId) {
      if (acceptedMessageSeen) return null;
      throw forbidden("Chat requester provenance changed");
    }
    const [sourceRun] = await db.select({
      issueId: boundRunIssueIdSql(),
      responsibleUserId: heartbeatRuns.responsibleUserId,
      wakeCommentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeCommentId'`,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, parent.runId),
      eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, run.agentId),
    )).limit(1);
    if (!sourceRun || !boundRunIssueId(run) || sourceRun.issueId !== boundRunIssueId(run)) {
      throw forbidden("Chat tools cannot be inherited by another task");
    }
    if (options.allowLegacyWakeComment && sourceRun.responsibleUserId === run.responsibleUserId &&
        typeof sourceRun.wakeCommentId === "string") legacyMessageId ??= sourceRun.wakeCommentId;
    origin = parent;
  }
}
