import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/** Creation provenance is independent of the task's current parent or project. */
export function createdFromIssueCondition(companyId: string, sourceIssueId: string) {
  if (!isUuidLike(sourceIssueId)) {
    throw unprocessable("createdFromIssueId must be a UUID");
  }
  const source = alias(issues, "creation_source_issue");
  // Resolve source runs independently of the candidate tasks so the database
  // can reuse this set, rather than scan all company runs for each task.
  const originatingRuns = sql`
    SELECT ${heartbeatRuns.id}::text FROM ${heartbeatRuns}
    INNER JOIN ${issues} AS ${source} ON ${source.id} = ${sourceIssueId}
      AND ${source.companyId} = ${companyId}
    WHERE ${heartbeatRuns.companyId} = ${companyId}
      AND coalesce(
        ${heartbeatRuns.nativeIssueId}::text,
        nullif(${heartbeatRuns.contextSnapshot}->>'issueId', ''),
        nullif(${heartbeatRuns.contextSnapshot}->>'taskId', ''),
        nullif(${heartbeatRuns.contextSnapshot}->>'taskKey', '')
      ) IN (${source.id}::text, ${source.identifier})
  `;
  return sql<boolean>`
    ${issues.id} <> ${sourceIssueId}
    AND (
      ${issues.originRunId} IN (${originatingRuns})
      OR (${issues.originRunId} IS NULL AND EXISTS (
        SELECT 1 FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.action} IN ('issue.created', 'issue.child_created')
          AND ${activityLog.runId}::text IN (${originatingRuns})
      ))
    )
  `;
}
