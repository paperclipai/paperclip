import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";

const UNSTARTED_SUPERSEDED_RUN_CODES = ["recovery_no_longer_needed", "issue_closed_before_start", "issue_execution_lock_changed"];

export function taskAttemptCondition(run: { status: SQL | typeof heartbeatRuns.status; startedAt: SQL | typeof heartbeatRuns.startedAt;
  errorCode: SQL | typeof heartbeatRuns.errorCode } = heartbeatRuns) {
  return sql`not (${run.status} = 'cancelled' and ${run.startedAt} is null
    and coalesce(${run.errorCode}, '') in (${sql.join(UNSTARTED_SUPERSEDED_RUN_CODES.map(code => sql`${code}`), sql`, `)}))`;
}

export function liveExecutionOwnerCondition(companyId: string, issueId: SQL | string) {
  return sql`${heartbeatRuns.status} in ('queued', 'running') and ${heartbeatRuns.id} = (select ${issues.executionRunId} from ${issues}
    where ${issues.companyId} = ${companyId} and ${issues.id} = ${issueId})`;
}

const REFUSALS_A_CLICK_CANNOT_CHANGE: ReadonlySet<string> = new Set([
  "cancelled_by_operator", "retry_source_changed", "workspace_owner_stop_required", "previous_execution_unverified",
]);

export function heldRetryOffersRetry(reason: string | null | undefined, cleanupSettling = false): boolean {
  if (!reason) return true;
  return !REFUSALS_A_CLICK_CANNOT_CHANGE.has(reason) && (reason !== "cleanup_quarantined" || !cleanupSettling);
}

export async function heldTaskRetryRefusals(db: Pick<Db, "selectDistinctOn">, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (!issueIds.length) return new Map();
  const issueId = sql<string>`${agentWakeupRequests.payload}->>'issueId'`;
  const rows = await db.selectDistinctOn([issueId], { issueId, sourceRunId: sql<string | null>`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'`,
    reason: sql<string | null>`${agentWakeupRequests.payload}#>>'{executionWait,reason}'`,
    latestRunId: sql<string | null>`(select latest.id::text from ${heartbeatRuns} latest
      where latest.company_id = ${companyId} and (latest.issue_id::text = ${agentWakeupRequests.payload}->>'issueId'
        or latest.native_issue_id::text = ${agentWakeupRequests.payload}->>'issueId'
        or latest.context_snapshot->>'issueId' = ${agentWakeupRequests.payload}->>'issueId')
        and ${taskAttemptCondition({ status: sql`latest.status`, startedAt: sql`latest.started_at`, errorCode: sql`latest.error_code` })}
      order by latest.created_at desc, latest.id desc limit 1)` })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId), inArray(issueId, issueIds),
      sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' is not null`))
    .orderBy(issueId, desc(agentWakeupRequests.requestedAt));
  return new Map(rows.flatMap(row => row.reason && row.sourceRunId && row.sourceRunId === row.latestRunId
    ? [[row.issueId, row.reason] as const] : []));
}
