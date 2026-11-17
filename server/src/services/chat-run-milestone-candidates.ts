import { sql, Subquery } from "drizzle-orm";
import { chatConversations, heartbeatRuns } from "@paperclipai/db";
import { boundRunIssueIdSql } from "./run-task-binding.js";

/**
 * Match the cheap chat binding before evaluating publication lineage. Without
 * this fence PostgreSQL can read/decompress a run's context many times for the
 * origin predicates even when the run has no matching conversation at all.
 * This is a prefilter only: the caller still owns every publication check.
 */
export function chatRunMilestoneSource(since: Date) {
  const selectedFields = {
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    updatedAt: heartbeatRuns.updatedAt,
    nativeIssueId: heartbeatRuns.nativeIssueId,
    issueId: heartbeatRuns.issueId,
    contextSnapshot: heartbeatRuns.contextSnapshot,
    resultJson: heartbeatRuns.resultJson,
  };
  return new Subquery(sql`
    with chat_milestone_runs as materialized (
      select ${heartbeatRuns.id}, ${heartbeatRuns.companyId},
        ${heartbeatRuns.agentId}, ${heartbeatRuns.status},
        ${heartbeatRuns.errorCode}, ${heartbeatRuns.updatedAt},
        ${heartbeatRuns.nativeIssueId}, ${heartbeatRuns.issueId},
        ${heartbeatRuns.contextSnapshot}, ${heartbeatRuns.resultJson}
      from ${heartbeatRuns}
      where ${heartbeatRuns.updatedAt} >= ${since.toISOString()}
        and exists (
          select 1 from ${chatConversations}
          where ${chatConversations.companyId} = ${heartbeatRuns.companyId}
            and ${chatConversations.issueId}::text = ${boundRunIssueIdSql()}
            and ${chatConversations.state} in ('active', 'waiting')
        )
    )
    select * from chat_milestone_runs
  `, selectedFields, "heartbeat_runs");
}
