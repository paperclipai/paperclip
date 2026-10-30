import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { chatTaskHandoffs, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { AttentionItem, ConversationTaskHandoff, ConversationTaskHandoffPage, DecisionHistoryPage, DecisionHistoryQuery } from "@paperclipai/shared";
import { issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { attentionService } from "./attention.js";
import { decisionHistoryService, pageDecisionHistory } from "./decision-history.js";
import { badRequest, notFound } from "../errors.js";
import { z } from "zod";

const handoffCursorIdSchema = z.uuid();

/** Read the same canonical decisions as Needs You, without copying content into
 * comments or scheduling an agent turn. Stable source IDs are timeline identity.
 * Both the source chat's current audience and every task's current access are
 * checked on every read, including history pagination after a chat reset. */
export function conversationDecisionReceiptsService(db: Db) {
  async function source(companyId: string, conversationId: string, options: { actor: AuthorizationActor; userId: string }) {
    const readable = await issueReadSqlCondition(db, options.actor);
    const [conversation] = await db.select().from(issues).where(and(eq(issues.id, conversationId), eq(issues.companyId, companyId),
      isNotNull(issues.conversationAgentId), eq(issues.conversationUserId, options.userId), readable));
    if (!conversation) throw notFound("Conversation not found");
    return conversation;
  }
  async function taskScopes(companyId: string, conversation: typeof issues.$inferSelect, options: {
    actor: AuthorizationActor; userId: string;
  }) {
    const readable = await issueReadSqlCondition(db, options.actor);
    const handoffTaskIds = db.select({ id: chatTaskHandoffs.taskId }).from(chatTaskHandoffs)
      .innerJoin(issues, and(eq(issues.id, chatTaskHandoffs.conversationId), eq(issues.companyId, chatTaskHandoffs.companyId)))
      .where(and(eq(chatTaskHandoffs.companyId, companyId), eq(chatTaskHandoffs.conversationId, conversation.id),
        eq(chatTaskHandoffs.agentId, issues.conversationAgentId),
        eq(chatTaskHandoffs.sessionGeneration, issues.conversationSessionGeneration),
        eq(issues.conversationUserId, options.userId), readable));
    const [handoffTasks, directTasks] = await Promise.all([
      db.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, companyId), inArray(issues.id, handoffTaskIds), readable,
      )),
      db.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, companyId), isNull(issues.conversationAgentId),
        eq(issues.createdByUserId, options.userId), eq(issues.assigneeAgentId, conversation.conversationAgentId!), readable,
        // An older or different chat handoff must not re-enter through the
        // direct-task branch and bypass its original session/audience scope.
        sql`not exists (select 1 from ${chatTaskHandoffs} where ${chatTaskHandoffs.taskId} = ${issues.id})`,
      )),
    ]);
    return { handoffIds: handoffTasks.map(task => task.id), directIds: directTasks.map(task => task.id) };
  }
  return {
    async listPendingQuestions(companyId: string, conversationId: string, options: {
      actor: AuthorizationActor; userId: string;
    }): Promise<AttentionItem[]> {
      const conversation = await source(companyId, conversationId, options);
      const { handoffIds, directIds } = await taskScopes(companyId, conversation, options);
      // The conversation already renders its own forms in the transcript.
      // Direct-task questions remain current obligations across chat resets.
      const taskIds = new Set([...handoffIds, ...directIds].filter(id => id !== conversationId));
      if (taskIds.size === 0) return [];

      // One on-demand canonical company snapshot, not one query per task. The
      // attention owner applies current audience, privacy, dismissal, snooze and
      // archive policy, including its existing queue/retention bookkeeping.
      // Cost grows with the company feed, not only the returned task questions;
      // there is currently no task-scoped attention API. Do not poll this read.
      const feed = await attentionService(db).list(companyId, {
        all: true, allowUnscopedAll: true, actor: options.actor, userId: options.userId,
      });
      return feed.items.filter(item => item.sourceKind === "issue_thread_interaction"
        && item.detail?.kind === "questions"
        && item.relatedIssue !== null && taskIds.has(item.relatedIssue.id));
    },
    async listCreatedTasks(companyId: string, conversationId: string, options: {
      actor: AuthorizationActor; userId: string; cursor?: string; limit?: number;
    }): Promise<ConversationTaskHandoffPage> {
      const conversation = await source(companyId, conversationId, options);
      const limit = Math.max(1, Math.min(options.limit ?? 40, 100));
      let cursor: { at: string; id: string } | null = null;
      if (options.cursor) {
        try {
          const value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
          if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
            || !handoffCursorIdSchema.safeParse(value.id).success) throw new Error();
          cursor = value;
        } catch { throw badRequest("Invalid chat handoff cursor"); }
      }
      const readable = await issueReadSqlCondition(db, options.actor);
      const rows = await db.select({ issueId: issues.id, identifier: issues.identifier, title: issues.title,
        status: issues.status, createdAt: chatTaskHandoffs.createdAt, sourceRunId: issues.originRunId,
        createdAtCursor: sql<string>`${chatTaskHandoffs.createdAt}::text`,
        suggestionInteractionId: sql<string | null>`(select ${issueThreadInteractions.id} from ${issueThreadInteractions}
          where ${issueThreadInteractions.companyId} = ${companyId} and ${issueThreadInteractions.issueId} = ${conversationId}
          and ${issueThreadInteractions.kind} = 'suggest_tasks' and ${issueThreadInteractions.status} = 'accepted'
          and ${issueThreadInteractions.result}->'createdTasks' @> jsonb_build_array(jsonb_build_object('issueId', ${issues.id}::text))
          order by ${issueThreadInteractions.resolvedAt} desc limit 1)`,
      }).from(chatTaskHandoffs).innerJoin(issues, and(eq(issues.id, chatTaskHandoffs.taskId), eq(issues.companyId, companyId)))
        .where(and(eq(chatTaskHandoffs.companyId, companyId), eq(chatTaskHandoffs.conversationId, conversationId),
          eq(chatTaskHandoffs.agentId, conversation.conversationAgentId!),
          eq(chatTaskHandoffs.sessionGeneration, conversation.conversationSessionGeneration), readable,
          cursor ? sql`(${chatTaskHandoffs.createdAt}, ${issues.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined))
        .orderBy(desc(chatTaskHandoffs.createdAt), desc(issues.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ createdAtCursor: _cursor, ...row }) => ({ ...row, id: `chat_handoff:${row.issueId}`, status: row.status as ConversationTaskHandoff["status"], createdAt: row.createdAt.toISOString() })),
        nextCursor: rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.createdAtCursor, id: last.issueId })).toString("base64url") : null,
      };
    },
    async list(companyId: string, conversationId: string, options: {
      actor: AuthorizationActor;
      userId: string;
    } & Pick<DecisionHistoryQuery, "cursor" | "limit">): Promise<DecisionHistoryPage> {
      const conversation = await source(companyId, conversationId, options);
      const { handoffIds, directIds } = await taskScopes(companyId, conversation, options);
      const [boundary] = conversation.conversationBoundaryCommentId
        ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
          eq(issueComments.id, conversation.conversationBoundaryCommentId), eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, conversationId),
        )) : [];
      // /new resets the standing chat's receipt timeline, but does not reset an
      // ordinary task. Missing reset provenance fails closed for direct history.
      const directSince = boundary?.createdAt
        ?? (conversation.conversationSessionGeneration === 0 ? conversation.createdAt : null);
      // Only IDs cross this boundary; the history owner applies task privacy and
      // decision audience checks before selecting a title, answer or artifact.
      const history = decisionHistoryService(db);
      const [handoffs, direct] = await Promise.all([
        history.list(companyId, { ...options, issueIds: handoffIds, sort: "newest" }),
        history.list(companyId, { ...options, issueIds: directSince ? directIds : [],
          since: directSince?.toISOString(), sort: "newest" }),
      ]);
      const page = pageDecisionHistory([...handoffs.items, ...direct.items], Math.max(1, Math.min(options.limit ?? 40, 100)), "newest");
      // Both sources use the same stable cursor ordering. If only one fills the
      // page, retain its overflow cursor instead of losing the next page.
      return { ...page, nextCursor: page.nextCursor ?? handoffs.nextCursor ?? direct.nextCursor };
    },
  };
}
