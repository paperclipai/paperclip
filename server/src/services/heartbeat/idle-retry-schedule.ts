import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
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
  const rows = await tx.select({ run: {
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    wakeupRequestId: heartbeatRuns.wakeupRequestId, status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
    runtimeMode: heartbeatRuns.runtimeMode, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
    costAccountingPending: heartbeatRuns.costAccountingPending,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object('startupCancellation', ${heartbeatRuns.resultJson}->'startupCancellation', 'cancellation', ${heartbeatRuns.resultJson}->'cancellation')`,
    revision: sql<string>`${heartbeatRuns}.xmin::text`,
  }, wake: { id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId, agentId: agentWakeupRequests.agentId,
    runId: agentWakeupRequests.runId, status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt,
    revision: sql<string>`${agentWakeupRequests}.xmin::text`,
  }, agent: { id: agents.id, companyId: agents.companyId, status: agents.status, revision: sql<string>`${agents}.xmin::text` },
    company: { id: companies.id, status: companies.status, revision: sql<string>`${companies}.xmin::text` },
    issue: { id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
      status: issues.status, hiddenAt: issues.hiddenAt, executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
      conversationAgentId: issues.conversationAgentId, monitorNextCheckAt: issues.monitorNextCheckAt,
      monitorWakeRequestedAt: issues.monitorWakeRequestedAt, executionState: issues.executionState,
      executionPolicy: sql<Record<string, unknown>>`jsonb_build_object('monitor', ${issues.executionPolicy}->'monitor')`,
      revision: sql<string>`${issues}.xmin::text`,
    } })
    .from(heartbeatRuns)
    .leftJoin(agentWakeupRequests, eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId))
    .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .leftJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .leftJoin(issues, eq(issues.id, heartbeatRuns.issueId))
    .where(eq(heartbeatRuns.status, "scheduled_retry"))
    .orderBy(heartbeatRuns.id).limit(idleDeadlineRowLimit + 1);
  state.push(rows);
  if (rows.length > idleDeadlineRowLimit) return blocked();
  const deadlines: number[] = [], runIds: string[] = [], wakeIds: string[] = [], issueWaits: IdleIssueWait[] = [];
  for (const { run, wake, agent, company, issue } of rows) {
    const at = run.scheduledRetryAt?.getTime() ?? NaN;
    const execution = parseIssueExecutionState(issue?.executionState);
    if (!isFutureIdleDeadline(at, now) || run.startedAt || run.finishedAt || run.costAccountingPending
      || run.runtimeMode === "native" || run.resultJson?.startupCancellation || run.resultJson?.cancellation
      || !agent || agent.companyId !== run.companyId || !["idle", "active", "error"].includes(agent.status)
      || !company || company.status !== "active"
      || !wake || wake.companyId !== run.companyId || wake.agentId !== run.agentId || wake.runId !== run.id
      || wake.id !== run.wakeupRequestId || wake.status !== "queued" || wake.finishedAt
      || !issue || issue.companyId !== run.companyId || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId
      || !["todo", "in_progress"].includes(issue.status) || issue.hiddenAt
      || issue.conversationAgentId || issue.monitorNextCheckAt || issue.monitorWakeRequestedAt || issue.executionPolicy?.monitor
      || (issue.executionState !== null && (!execution || execution.status !== "idle"))
      || (issue.executionRunId !== null && issue.executionRunId !== run.id)
      || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)) return blocked();
    deadlines.push(at); runIds.push(run.id); wakeIds.push(wake.id); issueWaits.push({ kind: "scheduled_retry", issueId: issue.id, runId: run.id });
  }
  const after = owner();
  if (!after.reconciled || before.revision !== after.revision) return blocked();
  return { blocked: false, state, deadlines, runIds, wakeIds, issueWaits };
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
