import { sql } from "drizzle-orm";
import { activityLog, issueComments, issues } from "@paperclipai/db";

// Mine participation fails closed. Add new user-authored issue mutation actions
// here instead of admitting every issue activity, because reads, previews, and
// denied resource requests are audited too.
const ISSUE_USER_PARTICIPATION_ACTIVITY_ACTIONS = [
  "issue.accepted_plan_decomposition_updated",
  "issue.admin_force_release",
  "issue.approval_linked",
  "issue.approval_unlinked",
  "issue.approvers_updated",
  "issue.assigned",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.blockers.updated",
  "issue.blockers_updated",
  "issue.checked_out",
  "issue.checkout",
  "issue.child_created",
  "issue.comment_cancelled",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_remapped",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.document_deleted",
  "issue.document_locked",
  "issue.document_restored",
  "issue.document_unlocked",
  "issue.document_updated",
  "issue.document_upserted",
  "issue.feedback_vote_saved",
  "issue.inbox_touched",
  "issue.low_trust_output_promoted",
  "issue.monitor_cleared",
  "issue.monitor_scheduled",
  "issue.recovery_action_resolved",
  "issue.relations.updated",
  "issue.released",
  "issue.reviewers_updated",
  "issue.scheduled_retry_retry_now",
  "issue.successful_run_handoff_resolved",
  "issue.task_watchdog_fingerprint_reviewed",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_cancelled",
  "issue.thread_interaction_created",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.thread_interaction_withdrawn",
  "issue.tree_cancel_status_updated",
  "issue.tree_hold_created",
  "issue.tree_hold_released",
  "issue.tree_restore_status_updated",
  "issue.updated",
  "issue.watchdog_created",
  "issue.watchdog_removed",
  "issue.work_product_created",
  "issue.work_product_deleted",
  "issue.work_product_updated",
] as const;

// Old read projections attributed this automatic cleanup to the reader. Keep
// the audit rows, but do not count them as participation or issue activity.
export function automaticReadRecoveryCleanupCondition() {
  return sql<boolean>`(
    ${activityLog.action} = 'issue.recovery_action_resolved'
    AND COALESCE(${activityLog.details}->>'source', '') = 'source_revalidation'
    AND COALESCE(${activityLog.details}->>'trigger', '') = 'read_projection'
  )`;
}

export function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.companyId} = ${companyId}
          AND ${activityLog.actorType} = 'user'
          AND ${activityLog.actorId} = ${userId}
          AND NOT ${automaticReadRecoveryCleanupCondition()}
          AND ${activityLog.action} IN (${sql.join(
            ISSUE_USER_PARTICIPATION_ACTIVITY_ACTIONS.map(
              (action) => sql`${action}`,
            ),
            sql`, `,
          )})
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

