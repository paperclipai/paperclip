export function completedTelegramAction(a: string): string {
  return `(${a}.kind = 'telegram_maintenance' AND (
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
