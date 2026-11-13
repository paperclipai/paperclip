import { and, eq, inArray, sql } from "drizzle-orm";
import { chatConversations, chatEndpoints, heartbeatRuns, issues, statusDecisions, type Db } from "@paperclipai/db";
import { readInheritedGitHubReviewWaits } from "../chat-channels/github/review-wait.js";
import { authorizeChatConversationsForBoundRuns } from "./chat-attachment-reuse.js";
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
  // One review read and one publication read for every wait of the page, not
  // two reads per wait. Each wait gets the same inherited result as before.
  const inheritedWaits = await readInheritedGitHubReviewWaits(db, candidates.map(candidate => ({
    id: candidate.runId, companyId, agentId: candidate.agentId, responsibleUserId: candidate.responsibleUserId,
    activeIdentityContextId: candidate.activeIdentityContextId, nativeIssueId: candidate.issueId,
    issueId: candidate.issueId, contextSnapshot: candidate.contextSnapshot,
  })));
  const authorizable = candidates.flatMap(({ runId, agentId, contextSnapshot, responsibleUserId: _user, activeIdentityContextId: _context, ...wait }, index) => {
    const inheritedWait = inheritedWaits[index];
    if (inheritedWait?.kind === "revoked") return [];
    return [{ wait, binding: { companyId, issueId: wait.issueId, runId, agentId },
      contextSnapshot: inheritedWait?.context ?? contextSnapshot }];
  });
  // One authorization read for every wait of the page, not one per wait: the
  // per-wait reads each held a pool connection at the same moment.
  const authorized = await authorizeChatConversationsForBoundRuns(db, companyId, authorizable);
  return authorizable.filter((_candidate, index) => authorized[index] !== null).map(({ wait }) => wait);
}

export type ExternalReviewWait = Awaited<ReturnType<typeof listExternalReviewWaits>>[number];
export type ExternalReviewWaitReader = (issueIds: string[]) => Promise<ExternalReviewWait[]>;

/** Share one company's wait reads between callers that serve one request.
 * Each issue's wait is independent of the other requested issues, so an issue
 * is read at most once. Do not keep a reader beyond its request. */
export function createExternalReviewWaitReader(db: Db, companyId: string,
  list: typeof listExternalReviewWaits = listExternalReviewWaits): ExternalReviewWaitReader {
  const byIssueId = new Map<string, Promise<ExternalReviewWait | null>>();
  return async (issueIds) => {
    const requested = [...new Set(issueIds)];
    const missing = requested.filter(issueId => !byIssueId.has(issueId));
    if (missing.length) {
      const read = list(db, companyId, missing)
        .then(waits => new Map(waits.map(wait => [wait.issueId, wait])));
      for (const issueId of missing) {
        byIssueId.set(issueId, read.then(waits => waits.get(issueId) ?? null));
      }
    }
    const waits = await Promise.all(requested.map(issueId => byIssueId.get(issueId)!));
    return waits.filter((wait): wait is ExternalReviewWait => wait !== null);
  };
}
