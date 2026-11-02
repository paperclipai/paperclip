export function completedSlackAction(a: string): string {
  return `(${a}.kind = 'slack_session_sync' AND (
      (${a}.status = 'processed' AND ${a}.result->>'outcome' IN ('updated', 'unsupported')
        AND (${a}.result->>'outcome' <> 'updated' OR ${a}.result->>'sessionStatus' <> 'processing'))
      OR (${a}.status = 'cancelled' AND ${a}.result->>'code' IN ('slack_session_no_published_state', 'slack_session_destination_changed'))
      OR (${a}.status = 'failed' AND ${a}.result->>'code' = 'slack_session_sync_rejected')))
    OR (${a}.kind = 'slash_task_start' AND ${a}.status = 'processed'
      AND length(${a}.result->>'providerMessageId') > 0 AND length(${a}.result->>'threadId') > 0)
    OR (${a}.kind = 'slack_file_upload_receipt' AND ${a}.status = 'processed'
      AND ${a}.result->>'code' = 'slack_file_upload_identity_confirmed')
    OR (${a}.kind = 'slack_session_stop' AND ${a}.status IN ('processed', 'cancelled')
      AND ${a}.result->>'code' IN ('slack_session_stop_cancelled', 'slack_session_stop_target_superseded', 'slack_session_stop_no_current_work')
      AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id::text = ${a}.result->>'runId'
        AND (r.company_id <> ${a}.company_id OR r.status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
          OR r.finished_at IS NULL OR r.cost_accounting_pending)))`;
}
