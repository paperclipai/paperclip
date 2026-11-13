import { VOICE_CALL_REPORT_WINDOW_MS } from "./voice-call-reports.js";

/** Available reports still own refresh work for the owner's whole 24h window.
 * The accepted push receipt proves submission, never unobservable playback. */
export function completedVoiceAction(a: string): string {
  const closedSession = (s: string) => `${s}.state IN ('ended', 'failed', 'expired') AND ${s}.ended_at IS NOT NULL
    AND COALESCE(${s}.error_code, '') <> 'cleanup_pending'
    AND (${s}.provider_session_id IS NULL OR ${s}.ended_at < now() - interval '${VOICE_CALL_REPORT_WINDOW_MS} milliseconds')`;
  const submitted = (alias: string) => `(${alias}.status = 'completed' AND length(${alias}.result->>'messageId') > 0
      AND ${alias}.result->>'playback' = 'unknown' AND ${alias}.result->>'acceptedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')
    OR (${alias}.status = 'call_ended' AND ${alias}.result->>'errorCode' = 'provider_unavailable')
    OR (${alias}.status = 'failed' AND ${alias}.result->>'errorCode' IN
      ('credentials_rejected', 'insufficient_credits', 'provider_unavailable', 'voice_authority_unavailable'))`;
  // Nonnull company/endpoint keys let PostgreSQL hash each debt set once,
  // rather than rescanning every old session for every retained voice marker.
  const settled = `(${a}.company_id, ${a}.endpoint_id) NOT IN (
      SELECT session.company_id, session.endpoint_id FROM chat_voice_sessions session
        WHERE (${closedSession('session')}) IS NOT TRUE)
    AND (${a}.company_id, ${a}.endpoint_id) NOT IN (
      SELECT admission.company_id, admission.endpoint_id FROM chat_voice_inbound_calls admission
        WHERE admission.state NOT IN ('denied', 'expired', 'ended')
          OR admission.cleanup_confirmed_at IS NULL OR admission.cleanup_next_attempt_at IS NOT NULL)
    AND (${a}.company_id, ${a}.endpoint_id) NOT IN (
      SELECT push.company_id, push.endpoint_id FROM chat_actions push
        WHERE push.kind = 'speko_voice_reply_push' AND (${submitted('push')}) IS NOT TRUE)`;
  // Configuration records this existing audit event only after tools, webhook,
  // voice defaults and runtime setup all succeeded. A partial setup cannot use
  // individual resource receipts to certify the rest of the owning operation.
  const setupCommitted = `EXISTS (SELECT 1 FROM activity_log receipt JOIN chat_endpoints endpoint
    ON endpoint.id = ${a}.endpoint_id AND endpoint.company_id = ${a}.company_id
    WHERE receipt.company_id = ${a}.company_id AND receipt.entity_type = 'tool_connection'
      AND receipt.entity_id = endpoint.connection_id::text AND receipt.details->>'endpointId' = endpoint.id::text
      AND receipt.details->>'provider' = 'speko' AND receipt.action IN ('chat_endpoint.credentials_verified', 'chat_endpoint.reconnected')
      AND receipt.created_at >= ${a}.updated_at)`;
  return `EXISTS (SELECT 1 FROM chat_endpoints endpoint WHERE endpoint.id = ${a}.endpoint_id
      AND endpoint.company_id = ${a}.company_id AND endpoint.provider = 'speko') AND ${settled} AND (
    (${a}.kind = 'speko_tool_setup' AND ${a}.status = 'completed' AND ${setupCommitted}
      AND ${a}.payload->>'name' IN ('submit_request', 'get_updates', 'answer_question')
      AND ${a}.payload->>'fingerprint' ~ '^[a-f0-9]{64}$' AND ${a}.payload->>'ownershipDefinitionHash' ~ '^[a-f0-9]{64}$'
      AND length(${a}.payload->>'ownershipAgentId') > 0 AND length(${a}.result->>'toolId') > 0
      AND ${a}.provider_action_id = 'speko_tool:' || (${a}.payload->>'name') || ':' || (${a}.payload->>'fingerprint'))
    OR (${a}.kind = 'speko_lifecycle_setup' AND ${a}.status = 'completed' AND ${setupCommitted}
      AND ${a}.payload->>'fingerprint' ~ '^[a-f0-9]{64}$' AND length(${a}.payload->>'ownershipAgentId') > 0
      AND ${a}.payload->>'ownershipUrl' LIKE 'https://%/events' AND length(${a}.result->>'webhookId') > 0
      AND ${a}.provider_action_id = 'speko_lifecycle:' || (${a}.payload->>'fingerprint'))
    OR (${a}.kind = 'speko_lifecycle_receipt' AND ${a}.status = 'completed' AND ${a}.result->>'accepted' = 'true'
      AND ${a}.payload->>'type' IN ('call.status', 'call.report') AND ${a}.payload->>'fingerprint' ~ '^[a-f0-9]{64}$'
      AND ${a}.provider_action_id LIKE 'speko_event:%' AND (
        EXISTS (SELECT 1 FROM chat_voice_sessions session WHERE session.id::text = ${a}.payload->>'sessionId'
          AND session.company_id = ${a}.company_id AND session.endpoint_id = ${a}.endpoint_id AND ${closedSession('session')})
        OR (${a}.payload->'sessionId' = 'null'::jsonb AND EXISTS (
          SELECT 1 FROM chat_voice_inbound_calls admission WHERE admission.company_id = ${a}.company_id
            AND admission.endpoint_id = ${a}.endpoint_id AND admission.state IN ('denied', 'expired', 'ended')
            AND admission.cleanup_confirmed_at IS NOT NULL AND admission.cleanup_next_attempt_at IS NULL))))
    OR (${a}.kind = 'speko_voice_reply_push' AND (${submitted(a)})
      AND ${a}.payload->>'textDigest' ~ '^[a-f0-9]{64}$'
      AND ${a}.payload->>'partIndex' ~ '^[0-9]+$' AND ${a}.payload->>'partCount' ~ '^[1-9][0-9]*$'
      AND CASE WHEN ${a}.payload->>'partIndex' ~ '^[0-9]+$' AND ${a}.payload->>'partCount' ~ '^[1-9][0-9]*$'
        THEN (${a}.payload->>'partIndex')::numeric < (${a}.payload->>'partCount')::numeric ELSE false END
      AND EXISTS (SELECT 1 FROM chat_voice_sessions session JOIN chat_voice_replies reply
        ON reply.session_id = session.id AND reply.company_id = session.company_id
        JOIN chat_publications publication ON publication.id = reply.publication_id AND publication.company_id = reply.company_id
        WHERE session.id::text = ${a}.payload->>'sessionId' AND session.company_id = ${a}.company_id
          AND session.endpoint_id = ${a}.endpoint_id AND session.conversation_id = ${a}.conversation_id
          AND session.provider_session_id = ${a}.payload->>'providerSessionId' AND session.generation::text = ${a}.payload->>'generation'
          AND reply.id::text = ${a}.payload->>'replyId' AND publication.id::text = ${a}.payload->>'publicationId'
          AND ${a}.provider_action_id = 'voice_reply_push:' || reply.id::text || CASE WHEN ${a}.payload->>'partIndex' = '0'
            THEN '' ELSE ':part:' || (${a}.payload->>'partIndex') END
          AND publication.endpoint_id = session.endpoint_id AND publication.conversation_id = session.conversation_id
          AND publication.issue_id = session.issue_id AND publication.state = 'published' AND publication.published_at IS NOT NULL AND ${closedSession('session')})))`;
}
