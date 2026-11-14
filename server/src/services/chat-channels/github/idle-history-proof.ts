function completedIngress(a: string): string {
  return `(${a}.status = 'processed' AND ${a}.result->>'httpStatus' ~ '^2[0-9][0-9]$' AND ${a}.result->>'retryable' = 'false')
    OR (${a}.status = 'failed' AND ${a}.result->>'retryable' = 'false' AND (
      ${a}.result->>'code' = 'github_webhook_ingress_payload_invalid'
      OR ${a}.result->>'httpStatus' ~ '^4[0-9][0-9]$'
      OR (jsonb_typeof(${a}.result->'attempts') = 'number' AND (${a}.result->>'attempts')::numeric >= 5)))
    OR (${a}.status = 'cancelled' AND ${a}.result->>'retryable' = 'false'
      AND ${a}.result->>'code' IN ('github_webhook_ingress_runtime_superseded', 'github_webhook_recovery_source_changed'))`;
}

export function completedGithubAction(a: string): string {
  return `(${a}.kind = 'github_omission_navigation' AND ${a}.status = 'processed' AND ${a}.result IS NULL
      AND ${a}.payload->>'version' = '1' AND ${a}.payload->>'preparedTextSha256' ~ '^[a-f0-9]{64}$'
      AND ${a}.provider_action_id = 'github-omission-navigation:' || (${a}.payload->>'publicationId')
      AND EXISTS (SELECT 1 FROM chat_publications publication JOIN heartbeat_runs run
        ON run.id::text = ${a}.payload->>'runId' AND run.company_id = publication.company_id
        AND run.native_issue_id = publication.issue_id AND run.runtime_mode = 'native'
        JOIN native_run_finalizations finalization ON finalization.run_id = run.id AND finalization.company_id = run.company_id
          AND finalization.issue_id = run.native_issue_id AND finalization.result_id::text = ${a}.payload->>'resultId' AND finalization.phase = 'committed'
        WHERE publication.id::text = ${a}.payload->>'publicationId' AND publication.company_id = ${a}.company_id
          AND publication.endpoint_id = ${a}.endpoint_id AND publication.conversation_id = ${a}.conversation_id
          AND run.status = 'succeeded' AND run.finished_at IS NOT NULL AND run.cost_accounting_pending = false
          AND ((publication.state = 'published' AND publication.published_at IS NOT NULL)
            OR (publication.state IN ('failed', 'cancelled') AND publication.next_attempt_at IS NULL))))
    OR (${a}.kind = 'github_response_comment' AND ${a}.result->>'final' = 'true'
      AND (${a}.status = 'processed' OR (${a}.status = 'cancelled' AND ${a}.result->>'code'
        IN ('run_already_answered', 'passive_response_wait', 'response_deleted'))))
    OR (${a}.kind = 'github_pr_response_comment' AND ${a}.status = 'processed'
      AND (${a}.result IS NULL OR (${a}.result->>'final' = 'true' AND length(${a}.result->>'id') > 0
        AND length(${a}.result->>'url') > 0))
      AND EXISTS (SELECT 1 FROM chat_conversations conversation WHERE conversation.id = ${a}.conversation_id
        AND conversation.company_id = ${a}.company_id AND conversation.endpoint_id = ${a}.endpoint_id)
      AND NOT EXISTS (SELECT 1 FROM chat_actions request WHERE request.kind = 'github_response_comment'
        AND request.company_id = ${a}.company_id AND request.endpoint_id = ${a}.endpoint_id
        AND request.conversation_id = ${a}.conversation_id AND (request.result->>'final' = 'true') IS NOT TRUE))
    OR (${a}.kind = 'github_webhook_ingress' AND (${completedIngress(a)}))
    OR (${a}.kind = 'github_review_check' AND (
      (${a}.status = 'processed' AND (${a}.result->>'state' IN ('manual_required', 'incomplete', 'error')
        OR (${a}.result->>'code' = 'assessment_owns_check' AND EXISTS (
          SELECT 1 FROM chat_github_reviews review WHERE review.id::text = ${a}.result->>'reviewId'
            AND review.company_id = ${a}.company_id AND review.endpoint_id = ${a}.endpoint_id AND review.assessment IS NOT NULL))))
      OR (${a}.status = 'cancelled' AND ${a}.result->>'code' IN ('connection_changed', 'stale_head')
        AND (${a}.result->>'code' <> 'stale_head' OR NOT EXISTS (
          SELECT 1 FROM chat_github_reviews review JOIN chat_deliveries delivery
            ON delivery.id::text = review.delivery_id AND delivery.endpoint_id = review.endpoint_id
          WHERE review.company_id = ${a}.company_id AND review.endpoint_id = ${a}.endpoint_id
            AND review.state IN ('queued', 'running') AND review.assessment IS NULL
            AND delivery.normalized_event->'githubAutomatic'->'context'->>'deliveryId' = ${a}.payload->'event'->>'deliveryId')))))
    OR (${a}.kind = 'github_review_publication' AND (
      (${a}.status = 'processed' AND (
        (${a}.payload->>'operation' IN ('comment', 'update_comment', 'formal_review')
          AND length(${a}.result->>'id') > 0 AND length(${a}.result->>'url') > 0)
        OR (${a}.payload->>'operation' = 'assessment' AND EXISTS (SELECT 1 FROM chat_github_reviews review
          WHERE review.id::text = ${a}.payload->>'reviewId' AND review.id::text = ${a}.result->>'reviewId'
            AND review.company_id = ${a}.company_id AND review.endpoint_id = ${a}.endpoint_id
            AND review.assessment IS NOT NULL AND review.check_url = ${a}.result->>'checkUrl'))))
      OR (${a}.status = 'cancelled' AND ${a}.result->>'retryable' = 'false'
        AND ${a}.result->>'code' IN ('publication_binding_unavailable', 'stale_head', 'authorization_changed'))))
    OR (${a}.kind = 'github_webhook_recovery' AND (
      (${a}.status = 'cancelled' AND ${a}.result->>'code' IN ('not_eligible_for_recovery', 'source_changed_or_unavailable'))
      OR (${a}.status = 'processed' AND EXISTS (SELECT 1 FROM chat_actions ingress
        WHERE ingress.kind = 'github_webhook_ingress' AND ingress.company_id = ${a}.company_id
          AND ingress.endpoint_id = ${a}.endpoint_id AND ingress.payload->>'deliveryId' = ${a}.payload->'original'->>'guid'
          AND (${completedIngress('ingress')})))))`;
}
