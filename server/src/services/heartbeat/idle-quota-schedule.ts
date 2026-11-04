import { agents, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME, issueExecutionMonitorPolicySchema, issueExecutionPolicySchema } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
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
  for (const { issue, source, target, company } of rows) {
    const policy = issueExecutionMonitorPolicySchema.safeParse(issue.executionPolicy?.monitor);
    const execution = parseIssueExecutionState(issue.executionState);
    const participant = execution?.status === "pending" ? execution.currentParticipant : null;
    const parsedPolicy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    if (!parsedPolicy.success || (issue.executionState !== null && !execution)) return blocked();
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
  const after = owner();
  if (!after.reconciled || before.revision !== after.revision) return blocked();
  return { blocked: false, state, deadlines, issueWaits };
}
function andSource() {
  // Compare text; malformed externalRef cannot become an unsafe UUID cast.
  return sql`${heartbeatRuns.id}::text = ${issues.executionPolicy}#>>'{monitor,externalRef}'
    AND ${heartbeatRuns.companyId} = ${issues.companyId}`;
}
