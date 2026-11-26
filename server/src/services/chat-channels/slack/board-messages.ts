import { dueChatAction } from "../../chat-action-work.js";
import { notifyChatPublicationWork, notifyChatActionWork } from "../../chat-work-notifications.js";
import { withSlackBoardLease } from "../../slack-board-lease.js";
import { slackBoardReplyBindings } from "../../slack-board-messages.js";
import { authorizeSlackBoardPublication } from "../../slack-board-authority.js";
import { assertSlackBoardWorkAllowed } from "../../slack-board-resume.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions, chatConversations, chatEndpoints, chatPublications, issues } from "@paperclipai/db";
import { HttpError, forbidden } from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";
import { logActivity } from "../../activity-log.js";
import { issueService } from "../../issues.js";
import type { EndpointRecord } from "../runtime-types.js";
import type { createChatCredentials } from "../credentials.js";
import type { IssueAssignmentWakeupDeps } from "../../issue-assignment-wakeup.js";
type BoardMessageOptions = {
 endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
 resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
 fetchImpl: typeof globalThis.fetch;
 readonly heartbeat: IssueAssignmentWakeupDeps;
};
export function createSlackBoardMessages(db: Db, options: BoardMessageOptions) {
 const { endpointRecord, resolveCredentials, fetchImpl } = options;
 async function processPendingSlackBoardMessages(limit = 25) {
    const pending = await db.select({ id: chatActions.id, companyId: chatActions.companyId, endpointId: chatActions.endpointId }).from(chatActions)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .where(dueChatAction("slack_board_message"))
      .orderBy(asc(chatActions.createdAt)).limit(limit);
    for (const candidate of pending) {
      await withSlackBoardLease(db, { ...candidate, actionId: candidate.id }, fetchImpl, async (lease) => {
        const [action] = await db.select().from(chatActions).where(and(eq(chatActions.id, candidate.id), eq(chatActions.status, "received")));
        if (!action) return;
        const issueId = String(action.payload.issueId);
        const userId = String(action.payload.userId);
        const agentId = String(action.payload.agentId);
        const commentId = String(action.payload.commentId);
        async function cancelWork(message: string) {
          await lease.commit(async (tx) => {
            await notifyChatActionWork(tx, "slack_board_message");
            await tx.update(chatActions).set({ status: "cancelled", result: { code: "slack_board_work_not_authorized", message }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
            await notifyChatPublicationWork(tx);
            await tx.update(chatPublications).set({ state: "cancelled", redactedError: message, nextAttemptAt: null, updatedAt: new Date() }).where(and(
              eq(chatPublications.companyId, action.companyId), eq(chatPublications.endpointId, action.endpointId),
              eq(chatPublications.conversationId, action.conversationId!), eq(chatPublications.commentId, commentId),
              inArray(chatPublications.state, ["pending", "retry"]),
            ));
          });
        }
        const currentEndpoint = await endpointRecord(action.endpointId);
        if (currentEndpoint && ["paused", "attention"].includes(currentEndpoint.endpoint.status)) return;
        const bindings = await slackBoardReplyBindings(db, { companyId: action.companyId, issueId, userId, agentId, commentIds: [commentId] });
        if (!bindings.some(binding => binding.endpointId === action.endpointId && binding.conversationId === action.conversationId)) {
          await cancelWork("The Slack message author no longer has access to this conversation");
          return;
        }
        try {
          const [publication] = await db.select().from(chatPublications).where(and(eq(chatPublications.companyId, action.companyId), eq(chatPublications.endpointId, action.endpointId), eq(chatPublications.commentId, commentId))).limit(1);
          const [conversation] = await db.select().from(chatConversations).where(and(eq(chatConversations.companyId, action.companyId), eq(chatConversations.id, action.conversationId!)));
          const credentials = currentEndpoint ? await resolveCredentials(currentEndpoint.endpoint) : null;
          if (!publication || !conversation || !currentEndpoint || !await authorizeSlackBoardPublication(db, currentEndpoint.endpoint, conversation, publication, credentials?.botToken ?? "", lease.fetch)) {
            throw forbidden("The Slack message author no longer has access to this conversation");
          }
          // Persist the resume and its marker together before waking. If a
          // scheduler response is lost, retry cannot reopen work a second time.
          const issue = await lease.commit(async (tx) => {
            const [current] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, action.companyId), eq(issues.assigneeAgentId, agentId))).for("update");
            if (!current) throw forbidden("The task is no longer assigned to the Slack agent");
            await assertSlackBoardWorkAllowed(tx as unknown as Db, current);
            if (action.result?.resumeApplied !== true) {
              if (["done", "blocked"].includes(current.status)) {
                await issueService(tx as unknown as Db).update(current.id, { status: "todo", actorUserId: userId });
                await logActivity(tx as unknown as Db, { companyId: current.companyId, actorType: "user", actorId: userId, action: "issue.updated", entityType: "issue", entityId: current.id, details: { status: "todo", source: "slack_board_message" } });
              }
              await notifyChatActionWork(tx, "slack_board_message");
              await tx.update(chatActions).set({ result: { resumeApplied: true }, updatedAt: new Date() }).where(eq(chatActions.id, action.id));
            }
            return current;
          });
          await lease.commit(async () => {});
          await options.heartbeat.wakeup(agentId, {
            source: "automation", triggerDetail: "system", reason: "issue_commented",
            idempotencyKey: `slack-board-comment:${action.id}`, allowRunCoalescing: false,
            requestedByActorType: "user", requestedByActorId: userId,
            payload: { issueId, commentId, resumeIntent: true, followUpRequested: true },
            contextSnapshot: { issueId, taskId: issueId, taskKey: issue.identifier ?? issueId, wakeCommentId: commentId, source: "issue.comment", resumeIntent: true, followUpRequested: true },
          });
          await lease.commit(async (tx) => {
            await notifyChatPublicationWork(tx);
            await notifyChatActionWork(tx, "slack_board_message");
            await tx.update(chatActions).set({ status: "processed", updatedAt: new Date() }).where(eq(chatActions.id, action.id));
          });
        } catch (error) {
          if (error instanceof HttpError && [400, 403, 404, 409].includes(error.status)) {
            await cancelWork(error.message);
            return;
          }
          logger.warn({ actionId: action.id, error: error instanceof Error ? error.message : "Wakeup failed" }, "Slack Board message wakeup will retry");
        }
      });
    }
  }
 return { processPendingSlackBoardMessages };
}
