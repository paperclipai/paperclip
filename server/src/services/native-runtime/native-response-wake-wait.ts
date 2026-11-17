import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
  statusDecisions,
  type Db,
} from "@paperclipai/db";
import { NATIVE_RESPONSE_WAKE_WAITING_REASON } from "./status-arbiter.js";

const NATIVE_CONVERSATION_TURN_FINISHED_REASON = "conversation_turn_finished";

type Binding = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
};

export async function hasCommittedNativeResponseWakeWait(
  db: Db,
  binding: Binding,
): Promise<boolean> {
  const [wait] = await db
    .select({ runStartedAt: heartbeatRuns.startedAt })
    .from(nativeRunFinalizations)
    .innerJoin(
      statusDecisions,
      and(
        eq(statusDecisions.id, nativeRunFinalizations.decisionId),
        eq(statusDecisions.companyId, binding.companyId),
        eq(statusDecisions.issueId, binding.issueId),
        eq(statusDecisions.runId, binding.runId),
        eq(statusDecisions.applicationState, "applied"),
        eq(statusDecisions.reasonCode, NATIVE_RESPONSE_WAKE_WAITING_REASON),
      ),
    )
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.id, binding.runId),
        eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId),
        eq(heartbeatRuns.nativeIssueId, binding.issueId),
        eq(heartbeatRuns.runtimeMode, "native"),
        eq(heartbeatRuns.status, "succeeded"),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.id, binding.issueId),
        eq(issues.companyId, binding.companyId),
        eq(issues.assigneeAgentId, binding.agentId),
        eq(issues.status, "in_progress"),
        eq(issues.lastStatusDecisionId, statusDecisions.id),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
      ),
    )
    .where(
      and(
        eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
        eq(nativeRunFinalizations.runId, binding.runId),
        eq(nativeRunFinalizations.phase, "committed"),
      ),
    )
    .limit(1);
  if (!wait?.runStartedAt) return false;
  const [unanswered] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, binding.companyId),
        eq(issueComments.issueId, binding.issueId),
        eq(issueComments.authorType, "user"),
        isNull(issueComments.createdByRunId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.createdAt} > ${wait.runStartedAt.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return !unanswered;
}

export async function hasCommittedNativeConversationTurnWait(
  db: Db,
  binding: Binding,
): Promise<boolean> {
  const [wait] = await db
    .select({ runId: heartbeatRuns.id })
    .from(nativeRunFinalizations)
    .innerJoin(
      statusDecisions,
      and(
        eq(statusDecisions.id, nativeRunFinalizations.decisionId),
        eq(statusDecisions.companyId, binding.companyId),
        eq(statusDecisions.issueId, binding.issueId),
        eq(statusDecisions.runId, binding.runId),
        eq(statusDecisions.applicationState, "applied"),
        eq(statusDecisions.reasonCode, NATIVE_CONVERSATION_TURN_FINISHED_REASON),
      ),
    )
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.id, binding.runId),
        eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId),
        eq(heartbeatRuns.nativeIssueId, binding.issueId),
        eq(heartbeatRuns.runtimeMode, "native"),
        eq(heartbeatRuns.status, "succeeded"),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.id, binding.issueId),
        eq(issues.companyId, binding.companyId),
        eq(issues.conversationAgentId, binding.agentId),
        isNotNull(issues.conversationUserId),
        isNull(issues.hiddenAt),
      ),
    )
    .where(
      and(
        eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
        eq(nativeRunFinalizations.runId, binding.runId),
        eq(nativeRunFinalizations.phase, "committed"),
      ),
    )
    .limit(1);
  return Boolean(wait);
}
