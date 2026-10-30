import { QueryBuilder } from "drizzle-orm/pg-core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, statusDecisions, statusDecisionEffects } from "@paperclipai/db";
import type { NativeResponsePresentationScope } from "../native-response-presentation-notifications.js";

export function nativeResponsePresentationCandidates(scope?: NativeResponsePresentationScope, after?: string, runId?: string) {
  const db = new QueryBuilder();
  return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    issueId: nativeRunFinalizations.issueId, agentId: heartbeatRuns.agentId, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
  }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.companyId, nativeRunFinalizations.companyId), eq(nativeRunResults.issueId, nativeRunFinalizations.issueId),
      eq(nativeRunResults.runId, heartbeatRuns.id), eq(nativeRunResults.completionContractId, heartbeatRuns.completionContractId)))
    .innerJoin(statusDecisions, and(eq(statusDecisions.id, nativeRunFinalizations.decisionId),
      eq(statusDecisions.companyId, nativeRunFinalizations.companyId), eq(statusDecisions.issueId, nativeRunFinalizations.issueId),
      eq(statusDecisions.runId, heartbeatRuns.id), eq(statusDecisions.assessmentId, nativeRunFinalizations.assessmentId)))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
      isNotNull(heartbeatRuns.finishedAt), eq(nativeRunFinalizations.phase, "committed"), isNull(nativeRunFinalizations.leaseOwner),
      eq(nativeRunResults.schemaStatus, "accepted"),
      sql`jsonb_typeof(${heartbeatRuns.resultJson} #> '{presentationDecision,commentId}') is distinct from 'string'`,
      sql`coalesce(${heartbeatRuns.resultJson} #> '{presentationDecision,commentAction}', '"create"'::jsonb) = '"create"'::jsonb`,
      sql`${heartbeatRuns.contextSnapshot}->'skipIssueComment' is distinct from 'true'::jsonb`,
      sql`coalesce(${statusDecisions.decisionJson}->'externalChatReviewPresentation', 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)`,
      sql`${nativeRunResults.resultJson} #>> '{result,schema}' = 'paperclip.run_result.v1'`,
      sql`${nativeRunResults.resultJson} #>> '{terminal,runTerminalState}' = 'succeeded'`,
      sql`${nativeRunResults.resultJson} #>> '{terminal,turnTerminalState}' = 'completed'`,
      or(
        and(eq(heartbeatRuns.status, "succeeded"),
          sql`(coalesce(${issues.conversationAgentId}::text, '') = '' or coalesce(${issues.conversationUserId}, '') = '')`,
          sql`${nativeRunResults.resultJson} #>> '{result,reportedWorkDisposition}' = 'done'`,
          sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'done'`),
        and(sql`${nativeRunResults.resultJson} #>> '{result,reportedWorkDisposition}' = 'yielded'`,
          sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'yielded'`,
          sql`jsonb_typeof(${nativeRunResults.resultJson} #> '{result,summary}') = 'string'
            and ${nativeRunResults.resultJson} #>> '{result,summary}' ~ '[^[:space:]]'`,
          sql`jsonb_typeof(${nativeRunResults.resultJson} #> '{result,continuation,idempotencyKey}') = 'string'
            and ${nativeRunResults.resultJson} #>> '{result,continuation,idempotencyKey}' ~ '[^[:space:]]'`,
          or(
            and(sql`${nativeRunResults.resultJson} #>> '{result,continuation,kind}' = 'response_wake'`,
              sql`${nativeRunResults.resultJson} #> '{result,attentionRequests}' = '[]'::jsonb`,
              sql`jsonb_typeof(${nativeRunResults.resultJson} #> '{result,continuation,summary}') = 'string'
                and ${nativeRunResults.resultJson} #>> '{result,continuation,summary}' ~ '[^[:space:]]'`),
            and(eq(heartbeatRuns.status, "succeeded"), or(
              and(sql`${nativeRunResults.resultJson} #>> '{result,continuation,kind}' = 'same_agent'`,
                eq(statusDecisions.reasonCode, "live_continuation_registered")),
              and(sql`${nativeRunResults.resultJson} #>> '{result,continuation,kind}' = 'monitor'`,
                inArray(statusDecisions.reasonCode, ["scheduled_monitor_waiting", "scheduled_monitor_dispatched", "scheduled_monitor_preserved"])),
            )),
          )),
      ),
      notExists(db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(and(
        eq(statusDecisionEffects.companyId, nativeRunFinalizations.companyId),
        eq(statusDecisionEffects.issueId, nativeRunFinalizations.issueId),
        eq(statusDecisionEffects.decisionId, nativeRunFinalizations.decisionId),
        inArray(statusDecisionEffects.deliveryState, ["pending", "failed"]),
      ))),
      scope ? and(eq(heartbeatRuns.companyId, scope.companyId), scope.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined) : undefined,
      scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
      scope?.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
      after ? gt(heartbeatRuns.id, after) : undefined, runId ? eq(heartbeatRuns.id, runId) : undefined,
    )).orderBy(asc(heartbeatRuns.id)).limit(100);
}

export function nativeResponsePresentationPendingQuery() {
  return nativeResponsePresentationCandidates();
}
