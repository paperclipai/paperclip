/** Completion receipts are retained for idempotency. Fixed aliases only. */
export const idleMcpHistoryChecks = [
  { reason: "mcp_oauth_grants", query: `SELECT 1 FROM mcp_oauth_grants g WHERE
    (g.revoked_at IS NOT NULL AND EXISTS (SELECT 1 FROM companies c WHERE c.id = g.company_id)) IS NOT TRUE` },
  { reason: "mcp_mutation_receipts", query: `SELECT 1 FROM mcp_mutation_receipts m WHERE (
    m.status = 'completed' AND jsonb_typeof(m.result) = 'object'
    AND EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.id = m.grant_id
      AND g.company_id = m.company_id AND g.user_id = m.user_id)) IS NOT TRUE` },
  // Stopped subscriptions no longer scan for events. Expiry alone is not a
  // handoff of responsibility for active subscriptions or unfinished delivery.
  { reason: "mcp_event_subscriptions", query: `SELECT 1 FROM mcp_event_subscriptions s WHERE (
    s.stopped_at IS NOT NULL AND EXISTS (SELECT 1 FROM mcp_oauth_grants g
      WHERE g.id = s.grant_id AND g.company_id = s.company_id)) IS NOT TRUE` },
  { reason: "mcp_event_deliveries", query: `SELECT 1 FROM mcp_event_deliveries d WHERE (
    d.finished_at IS NOT NULL AND (d.outcome IN ('delivered', 'filtered', 'inactive', 'delivery_exhausted')
      OR (d.outcome ~ '^http_[1-5][0-9][0-9]$' AND d.outcome !~ '^http_2'
        AND (d.attempts >= 6 OR (d.outcome NOT IN ('http_408', 'http_429') AND d.outcome !~ '^http_5'))))
    AND EXISTS (SELECT 1 FROM mcp_event_subscriptions s WHERE s.id = d.subscription_id
      AND EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.id = s.grant_id AND g.company_id = s.company_id)
      AND ((d.activity_id IS NOT NULL AND d.mailbox_item_id IS NULL AND EXISTS (
        SELECT 1 FROM activity_log a WHERE a.id = d.activity_id AND a.company_id = s.company_id))
        OR (d.mailbox_item_id IS NOT NULL AND d.activity_id IS NULL AND EXISTS (
          SELECT 1 FROM dot_mailbox_items m WHERE m.id = d.mailbox_item_id
            AND m.company_id = s.company_id AND m.binding_id = s.binding_id))))) IS NOT TRUE` },
  // Upload identity survives user deletion. Only the new owner-verified
  // absence stamp can retire cleanup; legacy cleaned_at alone was optimistic.
  { reason: "mcp_attachment_uploads", query: `SELECT 1 FROM mcp_attachment_uploads u WHERE (
    EXISTS (SELECT 1 FROM companies c WHERE c.id = u.company_id)
    AND NOT EXISTS (SELECT 1 FROM issues contradiction WHERE contradiction.id = u.task_id AND contradiction.company_id <> u.company_id)
    AND (u.grant_id IS NULL OR EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.id = u.grant_id
      AND g.company_id = u.company_id AND g.user_id = u.user_id))
    AND ((u.cleaned_at IS NOT NULL AND u.cleanup_verified_at IS NOT NULL AND u.cleanup_verified_at >= u.cleaned_at
        AND (u.attachment_id IS NULL OR NOT EXISTS (SELECT 1 FROM issue_attachments live WHERE live.id = u.attachment_id)))
      OR (u.cleaned_at IS NULL AND u.cleanup_verified_at IS NULL AND u.attachment_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM issues i WHERE i.id = u.task_id AND i.company_id = u.company_id) AND EXISTS (
        SELECT 1 FROM issue_attachments a JOIN assets stored ON stored.id = a.asset_id
        WHERE a.id = u.attachment_id AND a.company_id = u.company_id AND a.issue_id = u.task_id
          AND stored.company_id = u.company_id AND stored.object_key = u.object_key
          AND stored.provider = u.storage_provider)))) IS NOT TRUE` },
] as const;
