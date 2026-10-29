import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, ne, not, notExists, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueThreadInteractions, issueWorkProducts, nativeRunFinalizations,
  statusDecisionEffects, statusDecisions, workAssessments, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { NativeStatusReassessmentScope } from "../native-status-reassessment-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { reassessNativeStatusFromSource } from "./native-status-reassessment.js";

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };

export function nativeStatusReassessmentWork(db: Db) {
  function candidates(scope?: NativeStatusReassessmentScope, after?: string, runId?: string) {
    const projectedVersion = sql`case
      when jsonb_typeof(${statusDecisions.decisionJson}->'projectedStatusVersion') = 'number'
        then (${statusDecisions.decisionJson}->>'projectedStatusVersion')::numeric
      else ${statusDecisions.decisionVersion} - case when ${statusDecisions.decisionJson}->>'statusAction' = 'preserve' then 1 else 0 end
      end`;
    const matchesDecision = sql`coalesce(${issues.lastStatusDecisionId} = ${nativeRunFinalizations.decisionId}
      and ${statusDecisions.assessmentId} = ${workAssessments.id} and ${statusDecisions.toStatus} = ${issues.status}
      and ${projectedVersion} = ${issues.statusVersion}, false)`;
    const statusChanged = and(not(matchesDecision), or(ne(workAssessments.priorIssueStatus, issues.status),
      ne(workAssessments.priorStatusVersion, issues.statusVersion)));
    const evidenceChanged = exists(db.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, nativeRunFinalizations.companyId), eq(issueWorkProducts.issueId, nativeRunFinalizations.issueId),
      or(gt(issueWorkProducts.createdAt, workAssessments.createdAt), gt(issueWorkProducts.updatedAt, workAssessments.createdAt)),
    )));
    const retiredReview = exists(db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, nativeRunFinalizations.companyId), eq(issueThreadInteractions.issueId, nativeRunFinalizations.issueId),
      eq(issueThreadInteractions.status, "cancelled"), sql`${issueThreadInteractions.result}->>'reason' = 'automatic_completion_review_removed'`,
      sql`(${issueThreadInteractions.payload}->'target'->>'revisionId' = ${statusDecisions.id}::text
        or ${statusDecisions.decisionJson}->'effects' @> jsonb_build_array(jsonb_build_object('gate',
          jsonb_build_object('kind', 'interaction', 'id', ${issueThreadInteractions.id}::text))))`,
    )));
    return db.select({ runId: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: issues.id, issueStatus: issues.status, issueStatusVersion: issues.statusVersion,
      issueDecisionId: issues.lastStatusDecisionId, coordinatorPhase: nativeRunFinalizations.phase,
      assessmentId: workAssessments.id, decisionId: nativeRunFinalizations.decisionId, nativeStatusWakeIntentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'nativeStatusWakeIntentId'`,
      nextAttemptAt: nativeRunFinalizations.nextAttemptAt, leaseOwner: nativeRunFinalizations.leaseOwner,
      leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
      .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
      .innerJoin(workAssessments, and(eq(workAssessments.id, nativeRunFinalizations.assessmentId),
        eq(workAssessments.companyId, nativeRunFinalizations.companyId), eq(workAssessments.issueId, nativeRunFinalizations.issueId),
        eq(workAssessments.runId, nativeRunFinalizations.runId)))
      .leftJoin(statusDecisions, and(eq(statusDecisions.id, nativeRunFinalizations.decisionId),
        eq(statusDecisions.companyId, nativeRunFinalizations.companyId), eq(statusDecisions.issueId, nativeRunFinalizations.issueId)))
      .where(and(eq(heartbeatRuns.runtimeMode, "native"), nativeRunnerOwnershipNotHeldCondition(),
        ne(nativeRunFinalizations.phase, "terminal_failure"), isNotNull(nativeRunFinalizations.resultId),
        or(isNull(nativeRunFinalizations.leaseOwner), isNotNull(nativeRunFinalizations.leaseExpiresAt)),
        sql`not coalesce(${nativeRunFinalizations.phase} = 'committed'
          and ${nativeRunFinalizations.decisionId} is not null and ${issues.lastStatusDecisionId} is not null
          and ${issues.lastStatusDecisionId} <> ${nativeRunFinalizations.decisionId}
          and not coalesce(${statusDecisions.decisionJson}->>'statusAction' = 'preserve'
            and ${workAssessments.priorDecisionId} = ${issues.lastStatusDecisionId}, false), false)`,
        or(statusChanged, evidenceChanged, and(matchesDecision, retiredReview)),
        notExists(db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(and(
          eq(statusDecisionEffects.companyId, nativeRunFinalizations.companyId), eq(statusDecisionEffects.issueId, nativeRunFinalizations.issueId),
          eq(statusDecisionEffects.decisionId, nativeRunFinalizations.decisionId), inArray(statusDecisionEffects.deliveryState, ["pending", "failed"]),
        ))),
        scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
        scope?.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
        after ? gt(nativeRunFinalizations.runId, after) : undefined,
        runId ? eq(nativeRunFinalizations.runId, runId) : undefined,
      )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
  }
  function entry(row: Awaited<ReturnType<typeof candidates>>[number]): Entry {
    return { id: row.runId, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId,
      dueAt: Math.max(row.nextAttemptAt?.getTime() ?? 0, row.leaseOwner !== null ? row.leaseExpiresAt!.getTime() : 0) };
  }
  async function load(scope?: NativeStatusReassessmentScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await candidates(scope, after);
      entries.push(...rows.map(entry));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].runId;
    }
    throw new Error("Native status reassessment discovery stopped");
  }
  async function check(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native status reassessment stopped");
    const scope = { companyId: current.companyId, issueId: current.issueId, runId: current.id };
    const [source] = await candidates(scope);
    if (!source) return null;
    const due = entry(source);
    if (due.dueAt > Date.now()) return due;
    if (signal?.aborted) throw new Error("Native status reassessment stopped");
    const outcome = await reassessNativeStatusFromSource(db, source, { onlyWhenDue: true });
    if (outcome.kind !== "deferred" || !outcome.retry) return null;
    const [remaining] = await candidates(scope);
    if (!remaining) return null;
    const retry = entry(remaining);
    return retry.dueAt > Date.now() ? retry : { ...retry, dueAt: Date.now() + 30_000 };
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeStatusReassessment,
      decodeScope: (hint: string): NativeStatusReassessmentScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (item: Entry, scope?: NativeStatusReassessmentScope) => !scope || item.companyId === scope.companyId
        && (!scope.issueId || item.issueId === scope.issueId) && (!scope.runId || item.id === scope.runId)
        && (!scope.agentId || item.agentId === scope.agentId),
      load: (scope, signal) => load(scope, signal, canRun),
      check: (item, signal) => {
        if (!canRun()) throw new Error("Native status reassessment paused");
        return check(item, signal);
      },
    }, canRun);
  }
  return { load, check, register };
}
