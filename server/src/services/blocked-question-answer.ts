import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { queuedInteractionId } from "./queued-interaction-response.js";

const AGENT_REPORTED_BLOCKER_REASON_CODES = ["current_track_blocker_waiting", "task_wide_blocker_bound"];

export async function isAnswerToAgentBlockingQuestion(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<boolean> {
  const interactionId = queuedInteractionId(input.context);
  if (!interactionId) return false;
  const interactionStatus = (input.context as Record<string, unknown>).interactionStatus;
  const rows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, issues.lastStatusDecisionId),
      eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.issueId, issues.id),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, statusDecisions.runId),
      eq(heartbeatRuns.companyId, statusDecisions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.createdByAgentId, input.agentId),
      eq(issueThreadInteractions.status, String(interactionStatus)),
      isNotNull(issueThreadInteractions.resolvedByUserId),
      isNotNull(issueThreadInteractions.resolvedAt),
      eq(issues.status, "blocked"),
      eq(issues.assigneeAgentId, input.agentId),
      isNotNull(issues.blockedTransitionAt),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.toStatus, "blocked"),
      inArray(statusDecisions.reasonCode, AGENT_REPORTED_BLOCKER_REASON_CODES),
      gte(statusDecisions.createdAt, issueThreadInteractions.createdAt),
      sql`${statusDecisions.createdAt} <= ${issueThreadInteractions.resolvedAt}`,
      sql`${statusDecisions.appliedAt} >= ${issues.blockedTransitionAt}`,
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .limit(1);
  return rows.length > 0;
}
