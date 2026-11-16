/** Form-open tokens stay issued: resolving the canonical question revokes their
 * authority. A processed submission additionally needs its exact answer receipt. */
export function completedQuestionFormAction(a: string): string {
  const resolved = `EXISTS (SELECT 1 FROM issue_thread_interactions interaction
    JOIN chat_conversations conversation ON conversation.issue_id = interaction.issue_id AND conversation.company_id = interaction.company_id
    JOIN chat_publications publication ON publication.id::text = ${a}.payload->>'publicationId'
      AND publication.company_id = interaction.company_id AND publication.issue_id = interaction.issue_id
      AND publication.conversation_id = conversation.id AND publication.endpoint_id = conversation.endpoint_id
    WHERE interaction.id::text = ${a}.payload->>'interactionId' AND interaction.company_id = ${a}.company_id
      AND (interaction.kind = 'ask_user_questions' OR (interaction.kind = 'request_item_verdicts' AND EXISTS (
        SELECT 1 FROM chat_endpoints endpoint WHERE endpoint.id = ${a}.endpoint_id AND endpoint.company_id = ${a}.company_id AND endpoint.provider = 'slack'))) AND interaction.status IN ('answered', 'cancelled', 'expired')
      AND interaction.resolved_at IS NOT NULL AND conversation.id = ${a}.conversation_id
      AND conversation.endpoint_id = ${a}.endpoint_id AND publication.payload->>'interactionId' = interaction.id::text)`;
  return `(${a}.kind IN ('question_form_open', 'question_form_submit') AND ${a}.payload->>'version' = '1'
    AND ${resolved} AND (
      (${a}.kind = 'question_form_open' AND (${a}.status = 'issued' OR (${a}.status = 'expired'
        AND ${a}.result->>'code' IN ('question_form_submitted', 'interaction_resolved_elsewhere'))) AND EXISTS (
        SELECT 1 FROM chat_actions submit WHERE submit.company_id = ${a}.company_id AND submit.endpoint_id = ${a}.endpoint_id
          AND submit.conversation_id = ${a}.conversation_id AND submit.kind = 'question_form_submit'
          AND submit.provider_action_id = ${a}.payload->>'formActionId'
          AND submit.payload->>'formActionId' = submit.provider_action_id
          AND submit.payload->>'interactionId' = ${a}.payload->>'interactionId'
          AND submit.payload->>'publicationId' = ${a}.payload->>'publicationId'
          AND submit.payload->>'expiresAt' = ${a}.payload->>'expiresAt'
          AND (submit.status = 'issued' OR (submit.status = 'expired' AND submit.result->>'code' = 'interaction_resolved_elsewhere') OR (submit.status = 'processed'
            AND submit.result->>'code' = 'question_form_answered'
            AND submit.result->>'interactionId' = submit.payload->>'interactionId'))))
      OR (${a}.kind = 'question_form_submit' AND ${a}.payload->>'formActionId' = ${a}.provider_action_id
        AND (${a}.status = 'issued' OR (${a}.status = 'expired' AND ${a}.result->>'code' = 'interaction_resolved_elsewhere') OR (${a}.status = 'processed' AND ${a}.result->>'code' = 'question_form_answered'
          AND ${a}.result->>'interactionId' = ${a}.payload->>'interactionId')))))
    OR (${a}.kind = 'question_answer' AND ${resolved}
      AND (${a}.status = 'issued' OR (${a}.status = 'processed'
        AND ${a}.result->>'interactionId' = ${a}.payload->>'interactionId')
        OR (${a}.status = 'expired' AND ${a}.result->>'code' IN ('interaction_resolved_by_sibling_action', 'interaction_resolved_elsewhere'))))
    OR (${a}.kind = 'question_form_open_attempt' AND ${a}.status = 'processed'
      AND ${a}.result->>'code' = 'question_form_opened')`;
}

/** The terminal interaction writer expires its unused callback tokens after a
 * board/sibling resolution. Expiry alone never proves canonical completion. */
export function completedExpiredChatControl(a: string): string {
  return `${a}.kind = 'confirmation_response' AND ${a}.status = 'expired'
    AND ${a}.result->>'code' = 'interaction_resolved_elsewhere' AND ${a}.payload->>'version' = '1'
    AND ${a}.payload->>'decision' IN ('accept', 'reject') AND EXISTS (
      SELECT 1 FROM issue_thread_interactions interaction JOIN chat_publications publication
        ON publication.id::text = ${a}.payload->>'publicationId' AND publication.company_id = interaction.company_id
          AND publication.issue_id = interaction.issue_id AND publication.payload->>'interactionId' = interaction.id::text
        JOIN chat_conversations conversation ON conversation.id = publication.conversation_id
          AND conversation.company_id = interaction.company_id AND conversation.issue_id = interaction.issue_id
      WHERE interaction.id::text = ${a}.payload->>'interactionId' AND interaction.company_id = ${a}.company_id
        AND interaction.kind IN ('request_confirmation', 'request_checkbox_confirmation', 'suggest_tasks', 'connection_intent')
        AND interaction.status IN ('accepted', 'rejected', 'cancelled', 'expired') AND interaction.resolved_at IS NOT NULL
        AND publication.endpoint_id = ${a}.endpoint_id AND conversation.id = ${a}.conversation_id)`;
}
