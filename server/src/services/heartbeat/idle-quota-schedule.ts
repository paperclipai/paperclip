import { finishedIdleRun, finishedIdleWake } from "../idle-work-proof.js";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME, issueExecutionMonitorPolicySchema, issueExecutionPolicySchema } from "@paperclipai/shared";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DeadlineReconciliationSnapshot } from "../deadline-reconciliation.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot, type IdleIssueWait } from "../idle-deadline-types.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";

export interface IdleQuotaSchedule extends IdleDeadlineSnapshot { issueWaits: IdleIssueWait[] }

/** The reserved monitor belongs to legacy recovery, including its current
 * reviewer target. Native recovery and an already claimed monitor stay awake. */
export async function readIdleQuotaSchedule(tx: Pick<Db, "select">, now: number,
  owner: () => DeadlineReconciliationSnapshot): Promise<IdleQuotaSchedule> {
  const before = owner();
  const state: unknown[] = [before];
  const blocked = (): IdleQuotaSchedule => ({ blocked: true, state, deadlines: [], issueWaits: [] });
  if (!before.reconciled) return blocked();
  const rows = await tx.select({ issue: {
    id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    status: issues.status, monitorNextCheckAt: issues.monitorNextCheckAt, monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
    monitorAttemptCount: issues.monitorAttemptCount, executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
    hiddenAt: issues.hiddenAt, conversationAgentId: issues.conversationAgentId, executionState: issues.executionState,
    executionPolicy: sql<Record<string, unknown>>`jsonb_build_object('monitor', ${issues.executionPolicy}->'monitor', 'stages', coalesce(${issues.executionPolicy}->'stages', '[]'::jsonb))`,
    revision: sql<string>`${issues}.xmin::text`,
  }, source: { id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId')`,
    status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, runtimeMode: heartbeatRuns.runtimeMode,
    costAccountingPending: heartbeatRuns.costAccountingPending, revision: sql<string>`${heartbeatRuns}.xmin::text`,
  }, target: { id: agents.id, companyId: agents.companyId, status: agents.status, revision: sql<string>`${agents}.xmin::text` },
    company: { id: companies.id, status: companies.status, revision: sql<string>`${companies}.xmin::text` } }).from(issues)
    .leftJoin(heartbeatRuns, andSource())
    .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .leftJoin(companies, eq(companies.id, issues.companyId))
    .where(sql`${issues.executionPolicy}#>>'{monitor,serviceName}' = ${PROVIDER_QUOTA_MONITOR_SERVICE_NAME}`)
    .orderBy(issues.id).limit(idleDeadlineRowLimit + 1);
  state.push(rows);
  if (rows.length > idleDeadlineRowLimit) return blocked();
  const deadlines: number[] = [], issueWaits: IdleIssueWait[] = [];
  const terminal: { issueId: string; companyId: string; sourceId: string }[] = [];
  for (const { issue, source, target, company } of rows) {
    const policy = issueExecutionMonitorPolicySchema.safeParse(issue.executionPolicy?.monitor);
    const execution = parseIssueExecutionState(issue.executionState);
    const participant = execution?.status === "pending" ? execution.currentParticipant : null;
    const parsedPolicy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    if (!parsedPolicy.success || (issue.executionState !== null && !execution)) return blocked();
    if (["done", "cancelled"].includes(issue.status)) {
      // Status disarms the scheduler; normal completion intentionally retains
      // its policy and timestamp. A terminal label alone is not settlement.
      if (!policy.success || issue.monitorWakeRequestedAt || issue.executionRunId || issue.checkoutRunId || issue.conversationAgentId
        || (execution && (execution.status !== "idle" || execution.currentStageId !== null
          || execution.currentStageType !== null || execution.currentStageIndex !== null || execution.currentParticipant !== null))
        || !Number.isSafeInteger(issue.monitorAttemptCount) || issue.monitorAttemptCount < 0
        || (issue.monitorNextCheckAt !== null && (!Number.isFinite(issue.monitorNextCheckAt.getTime())
          || issue.monitorNextCheckAt.getTime() !== Date.parse(policy.data.nextCheckAt)))
        || !source || policy.data.externalRef !== source.id || source.companyId !== issue.companyId
        || source.contextSnapshot?.issueId !== issue.id || source.runtimeMode === "native"
        || !["failed", "timed_out", "interrupted", "cancelled"].includes(source.status) || !source.finishedAt || source.costAccountingPending)
        return blocked();
      terminal.push({ issueId: issue.id, companyId: issue.companyId, sourceId: source.id });
      continue;
    }
    if (issue.status === "in_progress" && execution && execution.status !== "idle") return blocked();
    if (issue.status === "in_review") {
      const stage = parsedPolicy.data.stages.find(stage => stage.id === execution?.currentStageId);
      if (!execution || execution.status !== "pending" || execution.currentStageType !== "review"
        || !stage || stage.type !== "review" || participant?.type !== "agent"
        || !stage.participants.some(candidate => candidate.type === "agent" && candidate.agentId === participant.agentId)) return blocked();
    }
    const targetId = issue.status === "in_review" ? participant?.type === "agent" ? participant.agentId : null : issue.assigneeAgentId;
    const at = issue.monitorNextCheckAt?.getTime() ?? NaN;
    if (!policy.success || !isFutureIdleDeadline(at, now) || Date.parse(policy.data.nextCheckAt) !== at
      || issue.monitorWakeRequestedAt || !["in_progress", "in_review"].includes(issue.status) || issue.assigneeUserId
      || issue.hiddenAt || issue.executionRunId || issue.checkoutRunId || issue.conversationAgentId
      || !Number.isSafeInteger(issue.monitorAttemptCount) || issue.monitorAttemptCount < 0
      || (policy.data.timeoutAt && Date.parse(policy.data.timeoutAt) <= at)
      || (policy.data.maxAttempts !== null && issue.monitorAttemptCount >= policy.data.maxAttempts)
      || !source || source.companyId !== issue.companyId || source.agentId !== targetId
      || policy.data.externalRef !== source.id || source.contextSnapshot?.issueId !== issue.id || source.runtimeMode === "native"
      || !["failed", "timed_out", "interrupted", "cancelled"].includes(source.status) || !source.finishedAt
      || source.costAccountingPending || !target || target.id !== source.agentId || target.companyId !== issue.companyId
      || !["idle", "active", "error"].includes(target.status) || !company || company.status !== "active") return blocked();
    deadlines.push(at); issueWaits.push({ kind: "provider_quota", issueId: issue.id, sourceRunId: source.id, targetAgentId: source.agentId, reviewer: issue.status === "in_review" });
  }
  if (terminal.length) {
    const ids = terminal.map(row => row.issueId), companyIds = [...new Set(terminal.map(row => row.companyId))];
    const sourceIds = terminal.map(row => row.sourceId);
    // Batch the absence proof instead of one history scan per retained task.
    const pendingRuns = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      inArray(heartbeatRuns.companyId, companyIds),
      or(inArray(heartbeatRuns.issueId, ids), inArray(heartbeatRuns.nativeIssueId, ids), inArray(heartbeatRuns.id, sourceIds),
        inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, ids), inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, ids)),
      sql`(${sql.raw(finishedIdleRun("heartbeat_runs"))}) IS NOT TRUE`,
    )).limit(1);
    const pendingWakes = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      inArray(agentWakeupRequests.companyId, companyIds),
      or(inArray(sql`${agentWakeupRequests.payload}->>'issueId'`, ids), inArray(sql`${agentWakeupRequests.payload}->>'taskId'`, ids),
        inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId'`, ids),
        inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId'`, ids),
        sql`${agentWakeupRequests.runId} IN (SELECT r.id FROM heartbeat_runs r
          WHERE r.company_id = ${agentWakeupRequests.companyId} AND (r.issue_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
            OR r.native_issue_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
            OR r.id IN (${sql.join(sourceIds.map(id => sql`${id}::uuid`), sql`, `)})
            OR r.context_snapshot->>'issueId' IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
            OR r.context_snapshot->>'taskId' IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})))`),
      sql`(${sql.raw(finishedIdleWake("agent_wakeup_requests"))}) IS NOT TRUE`,
    )).limit(1);
    state.push({ pendingRuns, pendingWakes });
    if (pendingRuns.length || pendingWakes.length) return blocked();
  }
  const after = owner();
  if (!after.reconciled || before.revision !== after.revision) return blocked();
  return { blocked: false, state, deadlines, issueWaits };
}
function andSource() {
  // Compare text; malformed externalRef cannot become an unsafe UUID cast.
  return sql`${heartbeatRuns.id}::text = ${issues.executionPolicy}#>>'{monitor,externalRef}'
    AND ${heartbeatRuns.companyId} = ${issues.companyId}`;
}
