import { sql } from "drizzle-orm";
import { issueRecoveryActions } from "@paperclipai/db";

export const FRESH_CONTINUATION_SCHEMA = "paperclip.fresh-continuation.v1" as const;

export const ISOLATING_CONTINUATIONS = ["fresh_isolated_workspace", "remote_epoch"] as const;

export function supersededByIsolatedContinuationPredicate() {
  const holdRunId = sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`;
  return sql`coalesce((${issueRecoveryActions.ownerUserId} is null
    and not (${issueRecoveryActions.evidence} ?| array['ownerGoneAttestation', 'explicitUserContinuation', 'executionReconciliation'])
    and coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
    and exists (select 1 from ${issueRecoveryActions} continuation
      where continuation.company_id = ${issueRecoveryActions.companyId}
        and continuation.source_issue_id = ${issueRecoveryActions.sourceIssueId}
        and continuation.id <> ${issueRecoveryActions.id}
        and continuation.evidence#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}
        and continuation.evidence#>>'{freshContinuation,sourceRunId}' = ${holdRunId}
        and continuation.evidence#>>'{freshContinuation,isolation}' in (${sql.join(ISOLATING_CONTINUATIONS.map(isolation => sql`${isolation}`), sql`, `)}))), false)`;
}
