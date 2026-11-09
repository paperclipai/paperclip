import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";

/**
 * Finished runs of one issue that have no liveness classification yet.
 * A run belongs to the issue when its context names the issue or when an
 * issue activity row records the run. Each branch reads only this issue's
 * rows through its own index, so the cost does not grow with the number of
 * unclassified runs in other issues of the company.
 */
export function missingRunLivenessCandidatesQuery(db: Db, companyId: string, issueId: string, limit: number) {
  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      resultJson: heartbeatRuns.resultJson,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      stderrExcerpt: heartbeatRuns.stderrExcerpt,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      continuationAttempt: heartbeatRuns.continuationAttempt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        isNull(heartbeatRuns.livenessState),
        sql`${heartbeatRuns.status} not in ('queued', 'running')`,
        sql`${heartbeatRuns.id} in (
          select issue_run.id
          from ${heartbeatRuns} as issue_run
          where issue_run.company_id = ${companyId}
            and issue_run.context_snapshot ->> 'issueId' = ${issueId}
          union all
          select ${activityLog.runId}
          from ${activityLog}
          where ${activityLog.companyId} = ${companyId}
            and ${activityLog.entityType} = 'issue'
            and ${activityLog.entityId} = ${issueId}
            and ${activityLog.runId} is not null
        )`,
      ),
    )
    .limit(limit);
}
