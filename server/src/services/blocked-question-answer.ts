import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { queuedInteractionId } from "./queued-interaction-response.js";
import { ordinaryQuestionCondition } from "./issue-question-context.js";

const AGENT_REPORTED_BLOCKER_REASON_CODES = ["current_track_blocker_waiting", "task_wide_blocker_bound"];
const PERSON_RESOLVED_BLOCKER_OWNER_KINDS = ["user", "board", "external", "unspecified"];

export type AgentBlockingQuestionState = { lastStatusDecisionId: string | null; statusVersion: number };

export async function questionsAwaitedByAgentBlock(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string | null | undefined; reasonCode: string | null;
  toStatus: string; unblockOwner: unknown; blockerOwnerKind?: string;
}): Promise<string[]> {
  const personResolves = input.blockerOwnerKind === undefined
    ? input.unblockOwner === "board"
    : PERSON_RESOLVED_BLOCKER_OWNER_KINDS.includes(input.blockerOwnerKind);
  if (!input.agentId || input.toStatus !== "blocked" || !personResolves
    || !AGENT_REPORTED_BLOCKER_REASON_CODES.includes(input.reasonCode ?? "")) return [];
  const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.createdByAgentId, input.agentId),
    eq(issueThreadInteractions.status, "pending"),
    isNull(issueThreadInteractions.dismissedAt),
    ordinaryQuestionCondition(),
  ));
  return rows.map((row) => row.id).sort();
}

export async function agentBlockingQuestionState(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<AgentBlockingQuestionState | null> {
  const interactionId = queuedInteractionId(input.context);
  if (!interactionId) return null;
  return (await nativeBlockingQuestionState(db, { ...input, interactionId }))
    ?? await ownQuestionAnswerOnUnrecordedBlock(db, { ...input, interactionId });
}

async function ownQuestionAnswerOnUnrecordedBlock(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown; interactionId: string;
}): Promise<AgentBlockingQuestionState | null> {
  const interactionStatus = (input.context as Record<string, unknown>).interactionStatus;
  const [row] = await db
    .select({ statusVersion: issues.statusVersion })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, input.interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.createdByAgentId, input.agentId),
      eq(issueThreadInteractions.status, String(interactionStatus)),
      isNotNull(issueThreadInteractions.resolvedAt),
      or(
        isNotNull(issueThreadInteractions.resolvedByUserId),
        and(isNotNull(issueThreadInteractions.resolvedByAgentId), ne(issueThreadInteractions.resolvedByAgentId, input.agentId)),
      ),
      eq(issues.status, "blocked"),
      eq(issues.assigneeAgentId, input.agentId),
      isNull(issues.lastStatusDecisionId),
      or(
        isNull(issues.blockedTransitionAt),
        and(
          sql`${issues.blockedTransitionAt} >= ${issueThreadInteractions.createdAt}`,
          sql`${issues.blockedTransitionAt} <= ${issueThreadInteractions.resolvedAt}`,
        ),
      ),
    ))
    .limit(1);
  if (!row) return null;
  const readiness = await issueService(db as unknown as Db)
    .listDependencyReadiness(input.companyId, [input.issueId], db);
  if (readiness.get(input.issueId)?.isDependencyReady === false) return null;
  return { lastStatusDecisionId: null, statusVersion: Number(row.statusVersion) };
}

async function nativeBlockingQuestionState(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown; interactionId: string;
}): Promise<AgentBlockingQuestionState | null> {
  const interactionId = input.interactionId;
  const interactionStatus = (input.context as Record<string, unknown>).interactionStatus;
  const [row] = await db
    .select({ lastStatusDecisionId: statusDecisions.id, statusVersion: issues.statusVersion })
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
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.toStatus, "blocked"),
      inArray(statusDecisions.reasonCode, AGENT_REPORTED_BLOCKER_REASON_CODES),
      sql`coalesce(${statusDecisions.decisionJson}->'awaitingInteractionIds', '[]'::jsonb) ? ${interactionId}`,
      sql`${statusDecisions.decisionJson}->>'projectedStatusVersion' = ${issues.statusVersion}::text`,
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .limit(1);
  return row ? { lastStatusDecisionId: row.lastStatusDecisionId, statusVersion: Number(row.statusVersion) } : null;
}
