/** Teams keeps immutable provider-effect and recipient-intent receipts after
 * delivery. Only the exact closed transfer/publication retires that authority. */
export function completedTeamsAction(a: string): string {
  return `${a}.status = 'processed' AND ${a}.kind IN ('teams_file_effect_intent', 'teams_file_consent', 'teams_board_file_intent')
    AND EXISTS (SELECT 1 FROM chat_teams_file_transfers transfer JOIN chat_publications publication
      ON publication.id = transfer.publication_id AND publication.company_id = transfer.company_id
      WHERE transfer.company_id = ${a}.company_id AND transfer.endpoint_id = ${a}.endpoint_id
        AND transfer.conversation_id = ${a}.conversation_id
        AND publication.id::text = ${a}.payload->>'publicationId'
        AND publication.endpoint_id = ${a}.endpoint_id AND publication.conversation_id = ${a}.conversation_id
        AND transfer.phase IN ('delivered', 'declined', 'expired', 'cancelled')
        AND transfer.attempt_id IS NULL AND transfer.attempt_expires_at IS NULL
        AND ((publication.state = 'published' AND publication.published_at IS NOT NULL)
          OR (publication.state IN ('failed', 'cancelled') AND publication.next_attempt_at IS NULL))
        AND CASE WHEN ${a}.kind = 'teams_file_effect_intent' THEN
          ${a}.payload->>'schema' = 'paperclip.teams.file-effect-intent.v1'
          AND ${a}.payload->>'transferId' = transfer.id::text
          AND ${a}.provider_action_id = 'teams-file-effect:' || (${a}.payload->>'attemptId')
          AND ${a}.payload->>'stage' IN ('consent', 'upload', 'file_info')
        WHEN ${a}.kind = 'teams_file_consent' THEN
          ${a}.payload->>'schema' = 'paperclip.teams.consent-receipt.v1'
          AND ${a}.payload->>'transferId' = transfer.id::text
          AND ${a}.payload->>'receiptDigest' = transfer.response_digest
          AND ${a}.payload->>'action' IN ('accept', 'decline')
          AND ${a}.principal_id IS NOT DISTINCT FROM transfer.principal_id
        ELSE ${a}.payload->>'schema' = 'paperclip.teams.board-file-intent.v1'
          AND ${a}.provider_action_id = 'teams_board_file_intent:' || publication.id::text
          AND ${a}.payload->>'issueId' = transfer.issue_id::text
          AND ${a}.payload->>'attachmentId' = transfer.attachment_id::text
          AND ${a}.payload->>'commentId' = publication.comment_id::text
          AND ${a}.payload->>'sourceScopeSha256' ~ '^[a-f0-9]{64}$'
          AND ${a}.payload->>'recipientBindingSha256' ~ '^[a-f0-9]{64}$'
          AND ${a}.payload->>'byteIdentitySha256' ~ '^[a-f0-9]{64}$'
          AND ${a}.payload->>'commentBodySha256' ~ '^[a-f0-9]{64}$' END)`;
}
