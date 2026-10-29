import { and, asc, eq, gt, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, statusDecisions, statusDecisionEffects, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeResponsePresentationScope } from "../native-response-presentation-notifications.js";
import { onCommittedChatResponseAuthorityRegistered } from "../durable-chat-wakeup.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { recoverCommittedNativeChatResponse } from "./native-run-finalizer.js";

export function registerNativeResponsePresentationWork(db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
  return nativeResponsePresentationWork(db).register(coordinator, canRun);
}

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };

export function nativeResponsePresentationWork(db: Db) {
  function candidates(scope?: NativeResponsePresentationScope, after?: string, runId?: string) {
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
  async function load(scope?: NativeResponsePresentationScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await candidates(scope, after);
      for (const row of rows) entries.push({ id: row.id, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, dueAt: row.nextAttemptAt?.getTime() ?? 0 });
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native response presentation discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native response presentation recovery stopped");
    const scope = { companyId: entry.companyId, issueId: entry.issueId };
    const [current] = await candidates(scope, undefined, entry.id);
    if (!current) return null;
    if (current.nextAttemptAt && current.nextAttemptAt.getTime() > Date.now()) return { ...entry, dueAt: current.nextAttemptAt.getTime() };
    if (signal?.aborted) throw new Error("Native response presentation recovery stopped");
    const recoveryStartedAt = Date.now();
    await recoverCommittedNativeChatResponse(db, { ...scope, runId: entry.id, onlyWhenDue: true });
    const [remaining] = await candidates(scope, undefined, entry.id);
    return remaining?.nextAttemptAt && remaining.nextAttemptAt.getTime() > recoveryStartedAt
      ? { ...entry, dueAt: remaining.nextAttemptAt.getTime() } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    const worker = registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeResponsePresentation,
      decodeScope: (hint: string): NativeResponsePresentationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeResponsePresentationScope) => !scope || entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.runId || entry.id === scope.runId) && (!scope.agentId || entry.agentId === scope.agentId),
      load: (scope, signal) => load(scope, signal, canRun),
      check: (entry, signal) => {
        if (!canRun()) throw new Error("Native response presentation recovery paused");
        return check(entry, signal);
      },
    }, canRun);
    const unsubscribe = onCommittedChatResponseAuthorityRegistered(db, () => worker.invalidate());
    return { ...worker, stop: unsubscribe };
  }
  return { load, check, register };
}
