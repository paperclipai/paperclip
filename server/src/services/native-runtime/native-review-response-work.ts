import { and, asc, eq, gt, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, nativeRunFinalizations, statusDecisions, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeReviewResponseScope } from "../native-review-response-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { recoverCommittedNativeReviewResponse } from "./native-run-finalizer.js";

export function registerNativeReviewResponseWork(db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
  return nativeReviewResponseWork(db).register(coordinator, canRun);
}

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };

export function nativeReviewResponseWork(db: Db) {
  function candidates(scope?: NativeReviewResponseScope, after?: string, runId?: string) {
    return db.select({ id: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId,
      issueId: nativeRunFinalizations.issueId, agentId: heartbeatRuns.agentId,
      decisionId: nativeRunFinalizations.decisionId, resultId: nativeRunFinalizations.resultId,
      assessmentId: nativeRunFinalizations.assessmentId, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
      .innerJoin(statusDecisions, and(eq(statusDecisions.id, nativeRunFinalizations.decisionId),
        eq(statusDecisions.companyId, nativeRunFinalizations.companyId), eq(statusDecisions.issueId, nativeRunFinalizations.issueId),
        eq(statusDecisions.runId, nativeRunFinalizations.runId), eq(statusDecisions.assessmentId, nativeRunFinalizations.assessmentId)))
      .where(and(eq(nativeRunFinalizations.phase, "committed"), isNull(nativeRunFinalizations.leaseOwner),
        isNotNull(nativeRunFinalizations.resultId), isNotNull(nativeRunFinalizations.assessmentId),
        eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "succeeded"),
        eq(statusDecisions.reasonCode, "governed_response_waiting"), eq(statusDecisions.applicationState, "applied"),
        sql`${statusDecisions.decisionJson}->'externalChatReviewPresentation'->>'schema' = 'paperclip.chat_review_response_presentation.v1'`,
        notExists(db.select({ id: issueComments.id }).from(issueComments).where(and(
          eq(issueComments.companyId, nativeRunFinalizations.companyId), eq(issueComments.issueId, nativeRunFinalizations.issueId),
          eq(issueComments.createdByRunId, nativeRunFinalizations.runId), eq(issueComments.authorAgentId, heartbeatRuns.agentId),
          eq(issueComments.authorType, "agent"), sql`${issueComments.metadata}->>'authorizationReason' = 'allow_chat_run_presentation'`,
          sql`${heartbeatRuns.resultJson}->'externalChatReviewPresentation'->>'decisionId' = ${nativeRunFinalizations.decisionId}::text`,
        ))),
        scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
        scope?.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
        runId ? eq(nativeRunFinalizations.runId, runId) : undefined,
        after ? gt(nativeRunFinalizations.runId, after) : undefined,
      )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
  }
  async function load(scope?: NativeReviewResponseScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await candidates(scope, after);
      for (const row of rows) entries.push({ id: row.id, companyId: row.companyId,
        issueId: row.issueId, agentId: row.agentId, dueAt: row.nextAttemptAt?.getTime() ?? 0 });
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Governed review response discovery stopped");
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Governed review response recovery stopped");
    const scope = { companyId: entry.companyId, issueId: entry.issueId };
    const [current] = await candidates(scope, undefined, entry.id);
    if (!current) return null;
    if (current.nextAttemptAt && current.nextAttemptAt.getTime() > Date.now()) return { ...entry, dueAt: current.nextAttemptAt.getTime() };
    if (signal?.aborted) throw new Error("Governed review response recovery stopped");
    const recoveryStartedAt = Date.now();
    await recoverCommittedNativeReviewResponse(db, { ...scope, runId: entry.id,
      decisionId: current.decisionId!, resultId: current.resultId!, assessmentId: current.assessmentId!, onlyWhenDue: true });
    const [remaining] = await candidates(scope, undefined, entry.id);
    return remaining?.nextAttemptAt && remaining.nextAttemptAt.getTime() > recoveryStartedAt
      ? { ...entry, dueAt: remaining.nextAttemptAt.getTime() } : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeReviewResponse,
      decodeScope: (hint: string): NativeReviewResponseScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Entry, scope?: NativeReviewResponseScope) => !scope || entry.companyId === scope.companyId
        && (!scope.issueId || entry.issueId === scope.issueId) && (!scope.runId || entry.id === scope.runId)
        && (!scope.agentId || entry.agentId === scope.agentId),
      load: (scope, signal) => load(scope, signal, canRun),
      check: (entry, signal) => {
        if (!canRun()) throw new Error("Governed review response recovery paused");
        return check(entry, signal);
      },
    }, canRun);
  }
  return { load, check, register };
}
