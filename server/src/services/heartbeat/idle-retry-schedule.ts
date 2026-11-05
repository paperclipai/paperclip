import { legacySourceProcessSettled } from "./legacy-process-settlement.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import { alias } from "drizzle-orm/pg-core";
import { DEFERRED_WAKE_CONTEXT_KEY } from "./queue.js";
import { finishedIdleRun } from "../idle-work-proof.js";
import type { DeadlineReconciliationSnapshot } from "../deadline-reconciliation.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot, type IdleIssueWait } from "../idle-deadline-types.js";

export interface IdleRetrySchedule extends IdleDeadlineSnapshot {
  runIds: string[];
  wakeIds: string[];
  issueWaits: IdleIssueWait[];
}

export async function readIdleRetrySchedule(tx: Pick<Db, "select">, now: number,
  owner: () => DeadlineReconciliationSnapshot): Promise<IdleRetrySchedule> {
  const before = owner();
  const state: unknown[] = [before];
  const blocked = (): IdleRetrySchedule => ({ blocked: true, state, deadlines: [], runIds: [], wakeIds: [], issueWaits: [] });
  if (!before.reconciled) return blocked();
  const source = alias(heartbeatRuns, "retry_source");
  const rows = await tx.select({ run: {
    id: heartbeatRuns.id, scopeKind: heartbeatRuns.scopeKind, issueId: heartbeatRuns.issueId,
    nativeIssueId: heartbeatRuns.nativeIssueId, nativeSessionId: heartbeatRuns.nativeSessionId,
    scopedContinuation: scopedContinuation(heartbeatRuns.contextSnapshot), responsibleUserId: heartbeatRuns.responsibleUserId,
    responsibleUserActive: sql<boolean>`EXISTS (SELECT 1 FROM company_memberships m WHERE m.company_id = ${heartbeatRuns.companyId}
      AND m.principal_type = 'user' AND m.principal_id = ${heartbeatRuns.responsibleUserId} AND m.status = 'active')`,
    companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    agentMemberActive: sql<boolean>`EXISTS (SELECT 1 FROM company_memberships m WHERE m.company_id = ${heartbeatRuns.companyId}
      AND m.principal_type = 'agent' AND m.principal_id = ${heartbeatRuns.agentId}::text AND m.status = 'active')`,
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    wakeupRequestId: heartbeatRuns.wakeupRequestId, status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
    runtimeMode: heartbeatRuns.runtimeMode, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
    costAccountingPending: heartbeatRuns.costAccountingPending,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object('startupCancellation', ${heartbeatRuns.resultJson}->'startupCancellation', 'cancellation', ${heartbeatRuns.resultJson}->'cancellation')`,
    revision: sql<string>`${heartbeatRuns}.xmin::text`,
  }, source: { id: source.id, companyId: source.companyId, agentId: source.agentId,
    scopedContinuation: scopedContinuation(source.contextSnapshot),
    contextIssueId: sql<string | null>`${source.contextSnapshot}->>'issueId'`,
    contextStageId: sql<string | null>`${source.contextSnapshot}->>'currentStageId'`,
    scopeKind: source.scopeKind, issueId: source.issueId, nativeIssueId: source.nativeIssueId, nativeSessionId: source.nativeSessionId,
    hasCancellation: sql<boolean>`COALESCE(${source.resultJson} ?| ARRAY['startupCancellation','cancellation','executionCancellation','nativeCancellation'], false)`,
    safePreparationFailure: sql<boolean>`${source.resultJson}#>>'{executionRecovery,kind}' = 'bootstrap'
      AND ${source.resultJson}#>'{executionRecovery,providerWorkStarted}' = 'false'::jsonb`,
    status: source.status, runtimeMode: source.runtimeMode, processPid: source.processPid, processGroupId: source.processGroupId,
    processStartedAt: source.processStartedAt, finishedAt: source.finishedAt, legacyProcessSettlement: source.legacyProcessSettlement,
    controllerBootId: source.controllerBootId, controllerLeaseExpiresAt: source.controllerLeaseExpiresAt,
    settled: sql<boolean>`${sql.raw(finishedIdleRun("retry_source"))}`,
    revision: sql<string>`${source}.xmin::text`,
  }, wake: { id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId, agentId: agentWakeupRequests.agentId,
    runId: agentWakeupRequests.runId, status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt,
    revision: sql<string>`${agentWakeupRequests}.xmin::text`,
  }, agent: { id: agents.id, companyId: agents.companyId, status: agents.status, revision: sql<string>`${agents}.xmin::text` },
    company: { id: companies.id, status: companies.status, revision: sql<string>`${companies}.xmin::text` },
    issue: { id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
      status: issues.status, hiddenAt: issues.hiddenAt, executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
      conversationAgentId: issues.conversationAgentId, monitorNextCheckAt: issues.monitorNextCheckAt,
      monitorWakeRequestedAt: issues.monitorWakeRequestedAt, executionState: issues.executionState,
      executionPolicy: sql<Record<string, unknown>>`jsonb_build_object('monitor', ${issues.executionPolicy}->'monitor', 'stages', coalesce(${issues.executionPolicy}->'stages', '[]'::jsonb))`,
      revision: sql<string>`${issues}.xmin::text`,
    } })
    .from(heartbeatRuns)
    .leftJoin(source, eq(source.id, heartbeatRuns.retryOfRunId))
    .leftJoin(agentWakeupRequests, eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId))
    .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .leftJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .leftJoin(issues, eq(issues.id, heartbeatRuns.issueId))
    .where(eq(heartbeatRuns.status, "scheduled_retry"))
    .orderBy(heartbeatRuns.id).limit(idleDeadlineRowLimit + 1);
  state.push(rows);
  if (rows.length > idleDeadlineRowLimit) return blocked();
  const deadlines: number[] = [], runIds: string[] = [], wakeIds: string[] = [], issueWaits: IdleIssueWait[] = [];
  for (const { run, source, wake, agent, company, issue } of rows) {
    const at = run.scheduledRetryAt?.getTime() ?? NaN;
    const execution = parseIssueExecutionState(issue?.executionState);
    if (!isFutureIdleDeadline(at, now) || run.startedAt || run.finishedAt || run.costAccountingPending
      || run.runtimeMode === "native" || run.resultJson?.startupCancellation || run.resultJson?.cancellation
      || !agent || agent.companyId !== run.companyId || !["idle", "active", "error"].includes(agent.status)
      || !company || company.status !== "active"
      || !wake || wake.companyId !== run.companyId || wake.agentId !== run.agentId || wake.runId !== run.id
      || wake.id !== run.wakeupRequestId || wake.status !== "queued" || wake.finishedAt
      ) return blocked();
    if (run.scopeKind === "company") {
      if (run.issueId !== null || issue || run.nativeIssueId || run.nativeSessionId || run.runtimeMode !== "legacy"
        || !run.responsibleUserId || !run.responsibleUserActive || !run.agentMemberActive
        || run.processPid || run.processGroupId || run.controllerBootId || run.controllerLeaseExpiresAt
        || !source || source.companyId !== run.companyId || source.agentId !== run.agentId
        || source.scopeKind !== "company" || source.issueId !== null || source.nativeIssueId || source.nativeSessionId
        || source.runtimeMode !== "legacy" || !source.settled || source.hasCancellation
        || !legacySourceProcessSettled(source)
        || run.scopedContinuation || source.scopedContinuation) return blocked();
    } else if (issue?.status === "in_review") {
      const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
      const stage = policy.success ? policy.data.stages.find(stage => stage.id === execution?.currentStageId) : undefined;
      if (run.scopeKind !== "issue" || run.runtimeMode !== "legacy" || run.nativeIssueId || run.nativeSessionId
        || run.processPid || run.processGroupId || run.controllerBootId || run.controllerLeaseExpiresAt
        || run.issueId !== issue.id || issue.companyId !== run.companyId
        || issue.assigneeUserId || issue.hiddenAt || issue.conversationAgentId
        || issue.monitorNextCheckAt || issue.monitorWakeRequestedAt || issue.executionPolicy?.monitor
        || !run.responsibleUserActive || !run.agentMemberActive
        || !execution || execution.status !== "pending" || execution.currentStageType !== "review"
        || execution.currentParticipant?.type !== "agent" || execution.currentParticipant.agentId !== run.agentId
        || !stage || stage.type !== "review" || !policy.success
        || execution.currentStageIndex !== policy.data.stages.findIndex(candidate => candidate.id === stage.id)
        || !stage.participants.some(participant => participant.type === "agent" && participant.agentId === run.agentId)
        || !source || source.companyId !== run.companyId || source.agentId !== run.agentId
        || source.scopeKind !== "issue" || source.issueId !== issue.id || source.contextIssueId !== issue.id
        || source.contextStageId !== stage.id || source.nativeIssueId || source.nativeSessionId
        || source.runtimeMode !== "legacy" || !["failed", "timed_out", "interrupted"].includes(source.status ?? "")
        || !source.settled || source.hasCancellation || source.safePreparationFailure !== true
        || !legacySourceProcessSettled(source)
        || (issue.executionRunId !== null && issue.executionRunId !== run.id)
        || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)) return blocked();
      issueWaits.push({ kind: "current_review_retry", issueId: issue.id, runId: run.id,
        reviewerAgentId: run.agentId, stageId: stage.id });
    } else if (run.scopeKind !== "issue" || run.issueId !== issue?.id
      || !issue || issue.companyId !== run.companyId || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId
      || !["todo", "in_progress"].includes(issue.status) || issue.hiddenAt
      || issue.conversationAgentId || issue.monitorNextCheckAt || issue.monitorWakeRequestedAt || issue.executionPolicy?.monitor
      || (issue.executionState !== null && (!execution || execution.status !== "idle"))
      || (issue.executionRunId !== null && issue.executionRunId !== run.id)
      || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)) return blocked();
    deadlines.push(at); runIds.push(run.id); wakeIds.push(wake.id);
    if (issue && issue.status !== "in_review") issueWaits.push({ kind: "scheduled_retry", issueId: issue.id, runId: run.id });
  }
  if (runIds.length) {
    const receipts = await tx.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId,
      companyId: agentWakeupRequests.companyId, agentId: agentWakeupRequests.agentId,
      status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt,
      unsupportedContinuation: sql<boolean>`COALESCE((${agentWakeupRequests.payload}->${DEFERRED_WAKE_CONTEXT_KEY})
        ?| ARRAY['interactionId','continuationPolicy','chatThreadId','conversationId','chatCompletionDeliveryIds'], false)`,
      represented: sql<boolean>`jsonb_typeof(${agentWakeupRequests.payload}->${DEFERRED_WAKE_CONTEXT_KEY}) = 'object'
        AND (${agentWakeupRequests.payload}->${DEFERRED_WAKE_CONTEXT_KEY}) <@ ${heartbeatRuns.contextSnapshot}
        AND (${agentWakeupRequests.payload} - ${DEFERRED_WAKE_CONTEXT_KEY}) <@ ${heartbeatRuns.contextSnapshot}`,
      revision: sql<string>`${agentWakeupRequests}.xmin::text`,
    }).from(agentWakeupRequests).leftJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
      .where(and(eq(heartbeatRuns.status, "scheduled_retry"), eq(agentWakeupRequests.status, "coalesced")))
      .orderBy(agentWakeupRequests.id).limit(idleDeadlineRowLimit + 1);
    state.push(receipts);
    if (receipts.length > idleDeadlineRowLimit) return blocked();
    const admitted = new Map(rows.map(row => [row.run.id, row.run]));
    for (const receipt of receipts) {
      const run = receipt.runId ? admitted.get(receipt.runId) : undefined;
      if (!run || receipt.companyId !== run.companyId || receipt.agentId !== run.agentId
        || !receipt.finishedAt || receipt.unsupportedContinuation || receipt.represented !== true) return blocked();
      wakeIds.push(receipt.id);
    }
  }
  const after = owner();
  if (!after.reconciled || before.revision !== after.revision) return blocked();
  return { blocked: false, state, deadlines, runIds, wakeIds, issueWaits };
}

function scopedContinuation(context: SQLWrapper) {
  return sql<boolean>`COALESCE(${context} ?| ARRAY['issueId','taskId','taskKey','nativeIssueId',
    'conversationId','chatThreadId','interactionId','continuationPolicy','chatCompletionDeliveryIds'], false)`;
}

export function idleRetryWorkChecks(snapshot: Pick<IdleRetrySchedule, "runIds" | "wakeIds">) {
  const exclude = (column: string, ids: string[]) => ids.length
    ? sql` AND ${sql.identifier(column)} NOT IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})` : sql``;
  return {
    heartbeat_runs: sql`SELECT 1 FROM heartbeat_runs WHERE (status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted')
      OR (scheduled_retry_at IS NOT NULL AND (finished_at IS NULL OR scheduled_retry_at > finished_at))
      OR cost_accounting_pending)${exclude("id", snapshot.runIds)}`,
    agent_wakeup_requests: sql`SELECT 1 FROM agent_wakeup_requests w WHERE
      (w.status NOT IN ('completed','failed','cancelled','skipped','timed_out','coalesced')
      OR (w.status = 'coalesced' AND (w.finished_at IS NULL OR NOT EXISTS (
        SELECT 1 FROM heartbeat_runs r WHERE r.id=w.run_id AND r.company_id=w.company_id AND r.agent_id=w.agent_id
          AND ${sql.raw(finishedIdleRun("r"))}))))
      ${exclude("id", snapshot.wakeIds)}`,
  };
}
