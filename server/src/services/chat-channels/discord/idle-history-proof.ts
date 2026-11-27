/** Command acceptance is final history; a staged control publication remains an
 * independent obligation and must settle before its command receipt is quiet. */
export function completedDiscordAction(a: string): string {
  return `${a}.kind = 'discord_native_command' AND ${a}.status = 'processed'
    AND ${a}.payload->>'version' = '1' AND ${a}.payload->'invocation'->>'schema' = 'paperclip.discord.native-command.v1'
    AND ${a}.payload->'invocation'->>'command' IN ('status', 'new', 'close')
    AND ${a}.payload->'invocation'->>'digest' ~ '^[a-f0-9]{64}$'
    AND ${a}.provider_action_id = 'discord-native-command:' || (${a}.payload->'invocation'->>'interactionId')
    AND ${a}.result->>'kind' = 'discord_native_command_recorded' AND length(${a}.result->>'content') > 0
    AND EXISTS (SELECT 1 FROM chat_external_principals principal WHERE principal.id = ${a}.principal_id
      AND principal.company_id = ${a}.company_id AND principal.provider = 'discord'
      AND principal.external_id = ${a}.payload->'invocation'->>'actorExternalId')
    AND ((${a}.conversation_id IS NULL AND ${a}.payload->'target' = 'null'::jsonb)
      OR EXISTS (SELECT 1 FROM chat_conversations conversation WHERE conversation.id = ${a}.conversation_id
        AND conversation.company_id = ${a}.company_id AND conversation.endpoint_id = ${a}.endpoint_id
        AND conversation.id::text = ${a}.payload->'target'->>'conversationId'
        AND conversation.issue_id::text = ${a}.payload->'target'->>'issueId'
        AND conversation.session_generation::text = ${a}.payload->'target'->>'sessionGeneration'))
    AND (${a}.result->'publicationId' = 'null'::jsonb OR EXISTS (
      SELECT 1 FROM chat_publications publication WHERE publication.id::text = ${a}.result->>'publicationId'
        AND publication.company_id = ${a}.company_id AND publication.endpoint_id = ${a}.endpoint_id
        AND publication.conversation_id = ${a}.conversation_id
        AND ((publication.state = 'published' AND publication.published_at IS NOT NULL)
          OR (publication.state IN ('failed', 'cancelled') AND publication.next_attempt_at IS NULL))))`;
}
