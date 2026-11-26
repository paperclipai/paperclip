export function completedTelegramAction(a: string): string {
  return `(${a}.kind = 'telegram_stop_subscription' AND ${a}.status = 'processed'
      AND ${a}.result->>'code' = 'telegram_stop_subscription_confirmed' AND ${a}.payload->>'version' = '1'
      AND ${a}.payload->>'botUserId' ~ '^[1-9][0-9]{0,15}$'
      AND ${a}.payload->>'credentialFingerprint' ~ '^[a-f0-9]{64}$'
      AND ${a}.payload->>'webhookUrlSha256' ~ '^[a-f0-9]{64}$'
      AND ${a}.payload->>'runtimeGeneration' ~ '^[0-9]+$'
      AND ${a}.provider_action_id = 'telegram-stop-subscription:' || (${a}.payload->>'runtimeGeneration') || ':'
        || (${a}.payload->>'credentialFingerprint') || ':' || (${a}.payload->>'webhookUrlSha256'))
    OR (${a}.kind = 'telegram_maintenance' AND (
      (${a}.status = 'processed' AND (${a}.result->>'providerConfirmed' = 'true'
        OR ${a}.result->>'code' = 'telegram_stop_subscription_confirmed'))
      OR (${a}.status = 'cancelled' AND ${a}.result->>'code' = 'telegram_maintenance_credentials_superseded')
      OR (${a}.status = 'failed' AND ${a}.result->>'retryable' = 'false'
        AND ${a}.result->>'code' = 'telegram_maintenance_failed')))
    OR (${a}.kind = 'telegram_draft' AND (
      (${a}.status = 'processed' AND ${a}.result->>'phase' = 'published' AND length(${a}.result->>'providerMessageId') > 0)
      OR (${a}.status = 'cancelled' AND (${a}.result->>'phase' = 'stopped'
        OR ${a}.result->>'code' = 'telegram_draft_presentation_stopped'))))`;
}
