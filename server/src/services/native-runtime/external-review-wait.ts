import { and, eq, inArray, sql } from "drizzle-orm";
import { chatConversations, chatEndpoints, heartbeatRuns, issues, statusDecisions, type Db } from "@paperclipai/db";
import { readInheritedGitHubReviewWait } from "../chat-channels/github/review-wait.js";
import { authorizeChatConversationForBoundRun } from "./chat-attachment-reuse.js";
import { EXTERNAL_CHAT_QUESTION_RESPONSE_KEY } from "./external-chat-question-response.js";

const authorizationContextKeys = [
  "source", "issueId", "wakeReason", "interactionKind", "interactionStatus", "externalChatContinuation",
  "interactionId", "sourceRunId", "sourceCommentId", "wakeCommentId", "wakeCommentIds",
  "paperclipHarnessCheckedOut", "paperclipExternalChatExecutionBound",
  EXTERNAL_CHAT_QUESTION_RESPONSE_KEY,
] as const;

const authorizationContext = sql<Record<string, unknown> | null>`
  case when ${heartbeatRuns.contextSnapshot} is null then null else (
    select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end) as field(key, value)
    where field.key in (${sql.join(authorizationContextKeys.map(key => sql`${key}`), sql`, `)})
  ) end
`;

export async function listExternalReviewWaits(db: Db, companyId: string, issueIds: string[]) {
  if (!issueIds.length) return [];
  const candidates = await db.selectDistinctOn([issues.id], {
    id: statusDecisions.id,
    companyId: issues.companyId,
    issueId: issues.id,
    status: chatConversations.state,
    createdAt: statusDecisions.createdAt,
    runId: heartbeatRuns.id,
    agentId: heartbeatRuns.agentId,
    contextSnapshot: authorizationContext,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
  }).from(issues)
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, issues.lastStatusDecisionId),
      eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.issueId, issues.id),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.toStatus, "in_review"),
      eq(statusDecisions.reasonCode, "external_chat_response_waiting"),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, statusDecisions.runId),
      eq(heartbeatRuns.companyId, issues.companyId),
      eq(heartbeatRuns.nativeIssueId, issues.id),
      eq(heartbeatRuns.agentId, issues.assigneeAgentId),
      eq(heartbeatRuns.status, "succeeded"),
    ))
    .innerJoin(chatConversations, and(
      eq(chatConversations.companyId, issues.companyId),
      eq(chatConversations.issueId, issues.id),
      inArray(chatConversations.state, ["active", "waiting"]),
    ))
    .innerJoin(chatEndpoints, and(
      eq(chatEndpoints.id, chatConversations.endpointId),
      eq(chatEndpoints.companyId, issues.companyId),
      eq(chatEndpoints.assignedAgentId, issues.assigneeAgentId),
      eq(chatEndpoints.status, "active"),
    ))
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds), eq(issues.status, "in_review")));
  const waits = await Promise.all(candidates.map(async ({ runId, agentId, contextSnapshot, responsibleUserId, activeIdentityContextId, ...wait }) => {
    try {
      const inheritedWait = await readInheritedGitHubReviewWait(db, {
        id: runId, companyId, agentId, responsibleUserId, activeIdentityContextId,
        nativeIssueId: wait.issueId, issueId: wait.issueId, contextSnapshot,
      });
      if (inheritedWait?.kind === "revoked") return null;
      await authorizeChatConversationForBoundRun(db, { companyId, issueId: wait.issueId, runId, agentId }, inheritedWait?.context ?? contextSnapshot, "read");
      return wait;
    } catch (error) {
      if (error instanceof Error && ["paperclip_runner_chat_attachment_binding_denied",
        "paperclip_runner_chat_attachment_destination_denied", "paperclip_runner_chat_attachment_principal_denied"].includes(error.message)) return null;
      throw error;
    }
  }));
  return waits.filter((wait): wait is NonNullable<typeof wait> => wait !== null);
}
