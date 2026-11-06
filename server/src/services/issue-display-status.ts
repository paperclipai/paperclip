import { sql, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME, type IssueDisplayStatus } from "@paperclipai/shared";

/** Read-only projection shared by task reads, search, filters and counts.
 * Lifecycle status and locks remain admission/recovery inputs. Neither alone
 * proves that an agent still has active execution.
 */
export function issueDisplayStatusSql(): SQL<IssueDisplayStatus> {
  // Drizzle removes column qualifiers in a single-table SELECT. Keep these
  // outer references explicitly qualified so correlated reads cannot bind to
  // the run/recovery table's own id or company_id instead.
  const issueId = sql`"issues"."id"`;
  const companyId = sql`"issues"."company_id"`;
  return sql<IssueDisplayStatus>`CASE
    WHEN ${issues.status} <> 'in_progress'
      OR ${issues.assigneeAgentId} IS NULL OR ${issues.assigneeUserId} IS NOT NULL
      THEN ${issues.status}
    WHEN EXISTS (
      SELECT 1 FROM heartbeat_runs display_run
      WHERE display_run.company_id = ${companyId}
        AND display_run.issue_id = ${issueId}
        AND display_run.status IN ('queued', 'running')
    ) THEN 'in_progress'
    WHEN EXISTS (
      SELECT 1 FROM issue_recovery_actions display_recovery
      WHERE display_recovery.company_id = ${companyId}
        AND display_recovery.source_issue_id = ${issueId}
        AND display_recovery.status IN ('active', 'escalated')
    ) THEN 'blocked'
    WHEN ${issues.executionState}->>'currentParticipant' IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM issue_thread_interactions display_interaction
        WHERE display_interaction.company_id = ${companyId}
          AND display_interaction.issue_id = ${issueId}
          AND display_interaction.status = 'pending'
      ) THEN 'in_review'
    WHEN ${issues.monitorNextCheckAt} IS NOT NULL
      AND ${issues.executionRunId} IS NULL AND ${issues.checkoutRunId} IS NULL
      AND COALESCE(${issues.executionState}#>>'{monitor,status}', 'scheduled') = 'scheduled'
      AND ${issues.executionPolicy}->'monitor' IS NOT NULL
      AND COALESCE(${issues.executionPolicy}#>>'{monitor,serviceName}', '') <> ${PROVIDER_QUOTA_MONITOR_SERVICE_NAME}
      THEN 'monitoring'
    ELSE 'todo' END`;
}
