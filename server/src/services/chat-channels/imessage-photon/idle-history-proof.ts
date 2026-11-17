/** Photon tokens and immutable provenance receipts do not own a turn once their
 * exact canonical owner has settled. Receiver ownership remains a separate gate. */
export function completedPhotonAction(a: string): string {
  const publication = (id: string) => `EXISTS (SELECT 1 FROM chat_publications publication
    WHERE publication.id::text = ${id} AND publication.company_id = ${a}.company_id
      AND publication.endpoint_id = ${a}.endpoint_id AND publication.conversation_id = ${a}.conversation_id
      AND ((publication.state = 'published' AND publication.published_at IS NOT NULL)
        OR (publication.state IN ('failed', 'cancelled') AND publication.next_attempt_at IS NULL)))`;
  return `(${a}.kind = 'photon_interaction' AND (${a}.status IN ('issued', 'processed') OR (${a}.status = 'expired' AND ${a}.result->>'code' = 'interaction_resolved_elsewhere'))
      AND ${a}.payload->>'version' = '1' AND length(${a}.payload->>'reference') > 0
      AND ${a}.provider_action_id = 'photon:' || (${a}.payload->>'reference')
      AND EXISTS (SELECT 1 FROM issue_thread_interactions interaction JOIN chat_publications publication
        ON publication.id::text = ${a}.payload->>'publicationId' AND publication.company_id = interaction.company_id
          AND publication.issue_id = interaction.issue_id AND publication.payload->>'interactionId' = interaction.id::text
        JOIN chat_conversations conversation ON conversation.id = publication.conversation_id
          AND conversation.company_id = interaction.company_id AND conversation.issue_id = interaction.issue_id
        WHERE interaction.id::text = ${a}.payload->>'interactionId' AND interaction.company_id = ${a}.company_id
          AND interaction.kind IN ('ask_user_questions', 'request_confirmation')
          AND interaction.status IN ('answered', 'accepted', 'rejected', 'cancelled', 'expired') AND interaction.resolved_at IS NOT NULL
          AND publication.endpoint_id = ${a}.endpoint_id AND conversation.id = ${a}.conversation_id
          AND conversation.session_generation::text = ${a}.payload->>'sessionGeneration'))
    OR (${a}.kind = 'photon_publication_retry' AND ${a}.status = 'processed'
      AND length(${a}.result->>'authorizedByUserId') > 0 AND ${a}.payload->>'attempt' ~ '^[1-9][0-9]*$'
      AND ${a}.provider_action_id = 'photon-retry:' || (${a}.payload->>'publicationId') || ':' || (${a}.payload->>'attempt')
      AND ${publication(`${a}.payload->>'publicationId'`)})
    OR (${a}.kind = 'photon_response_notice' AND ${a}.status = 'processed' AND ${a}.result IS NULL
      AND length(${a}.payload->>'reference') > 0 AND ${a}.payload->>'questionIndex' ~ '^[0-9]+$'
      AND EXISTS (SELECT 1 FROM chat_publications notice WHERE notice.company_id = ${a}.company_id
        AND notice.endpoint_id = ${a}.endpoint_id AND notice.conversation_id = ${a}.conversation_id
        AND ${a}.provider_action_id = 'photon-notice:' || notice.idempotency_key
        AND ((notice.state = 'published' AND notice.published_at IS NOT NULL)
          OR (notice.state IN ('failed', 'cancelled') AND notice.next_attempt_at IS NULL)))
      AND EXISTS (SELECT 1 FROM chat_publications source WHERE source.id::text = ${a}.payload->>'publicationId'
        AND source.company_id = ${a}.company_id AND source.endpoint_id = ${a}.endpoint_id
        AND source.conversation_id = ${a}.conversation_id))
    OR (${a}.kind IN ('attachment_derivative', 'attachment_companion') AND ${a}.status = 'processed' AND ${a}.result IS NULL
      AND EXISTS (SELECT 1 FROM chat_endpoints endpoint WHERE endpoint.id = ${a}.endpoint_id
        AND endpoint.company_id = ${a}.company_id AND endpoint.provider = 'imessage-photon')
      AND ${a}.delivery_id IS NOT NULL
      AND ((${a}.kind = 'attachment_derivative' AND ${a}.payload->>'kind' = 'heif_jpeg_preview')
        OR (${a}.kind = 'attachment_companion' AND ${a}.payload->>'kind' = 'live_photo_video'))
      AND ${a}.payload->>'originalAttachmentId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND ${a}.payload->>'derivativeAttachmentId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND ${a}.payload->>'originalAttachmentId' <> ${a}.payload->>'derivativeAttachmentId'
      AND ${a}.payload->>'originalSha256' ~ '^[a-f0-9]{64}$' AND ${a}.payload->>'derivativeSha256' ~ '^[a-f0-9]{64}$'
      AND ${a}.provider_action_id = 'photon-' || (${a}.payload->>'kind') || ':' || ${a}.delivery_id::text || ':' || (${a}.payload->>'originalAttachmentId')
      AND NOT EXISTS (SELECT 1 FROM issue_attachments attachment WHERE attachment.id::text IN
        (${a}.payload->>'originalAttachmentId', ${a}.payload->>'derivativeAttachmentId')
        AND (attachment.company_id <> ${a}.company_id OR NOT EXISTS (SELECT 1 FROM assets asset
          WHERE asset.id = attachment.asset_id AND asset.company_id = ${a}.company_id AND asset.sha256 = CASE
            WHEN attachment.id::text = ${a}.payload->>'originalAttachmentId' THEN ${a}.payload->>'originalSha256'
            ELSE ${a}.payload->>'derivativeSha256' END)))
      AND NOT EXISTS (SELECT 1 FROM issue_attachments original JOIN issue_attachments derivative
        ON derivative.id::text = ${a}.payload->>'derivativeAttachmentId'
        WHERE original.id::text = ${a}.payload->>'originalAttachmentId'
          AND (original.company_id <> derivative.company_id OR original.issue_id <> derivative.issue_id
            OR original.issue_comment_id IS DISTINCT FROM derivative.issue_comment_id)))`;
}
