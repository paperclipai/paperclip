import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { ordinaryQuestionCondition } from "../issue-question-context.js";
import { enqueueWake } from "./status-decision-committer.js";

const PROVIDER_MESSAGE_REF = /^provider:[a-z0-9_-]+:agent-message$/i;

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

export function reportsOnlyProviderMessage(result: unknown): boolean {
  const refs = [
    ...list(field(result, "evidence")).map((entry) => field(entry, "ref")),
    ...list(field(field(result, "completionClaim"), "criteria")).flatMap((criterion) => list(field(criterion, "evidenceRefs"))),
  ];
  return refs.length > 0 && refs.every((ref) => typeof ref === "string" && PROVIDER_MESSAGE_REF.test(ref))
    && list(field(result, "artifacts")).length === 0 && list(field(result, "verification")).length === 0;
}

export async function pendingOwnQuestionId(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string;
}): Promise<string | null> {
  const [row] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.createdByAgentId, input.agentId),
    eq(issueThreadInteractions.status, "pending"),
    isNull(issueThreadInteractions.dismissedAt),
    ordinaryQuestionCondition(),
  )).limit(1);
  return row?.id ?? null;
}

export const OWN_QUESTION_UNANSWERED_REASON = "own_question_unanswered";

export async function ownQuestionWaitReleasedByDismissal(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; interactionId: string;
}): Promise<{ agentId: string } | null> {
  const [row] = await db.select({ agentId: issues.assigneeAgentId })
    .from(issues)
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, issues.lastStatusDecisionId),
      eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.issueId, issues.id),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, statusDecisions.runId),
      eq(heartbeatRuns.companyId, statusDecisions.companyId),
      eq(heartbeatRuns.agentId, issues.assigneeAgentId),
    ))
    .innerJoin(issueThreadInteractions, and(
      eq(issueThreadInteractions.id, input.interactionId),
      eq(issueThreadInteractions.companyId, issues.companyId),
      eq(issueThreadInteractions.issueId, issues.id),
      eq(issueThreadInteractions.createdByAgentId, issues.assigneeAgentId),
    ))
    .where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
      eq(issues.status, "in_review"),
      isNull(issues.assigneeUserId),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.toStatus, "in_review"),
      eq(statusDecisions.reasonCode, OWN_QUESTION_UNANSWERED_REASON),
    ))
    .limit(1);
  if (!row?.agentId) return null;
  if (await pendingOwnQuestionId(db, { companyId: input.companyId, issueId: input.issueId, agentId: row.agentId })) return null;
  return { agentId: row.agentId };
}

export async function enqueueOwnQuestionDismissalWake(tx: Db, input: {
  companyId: string; issueId: string; interactionId: string;
}): Promise<string | null> {
  const released = await ownQuestionWaitReleasedByDismissal(tx, input);
  if (!released) return null;
  return enqueueWake({
    tx, companyId: input.companyId, issueId: input.issueId, agentId: released.agentId,
    reason: "issue_question_dismissed",
    idempotencyKey: `issue_question_dismissed:${input.interactionId}`,
    payload: { dismissedInteractionId: input.interactionId },
    contextSnapshot: { dismissedInteractionId: input.interactionId },
  });
}
