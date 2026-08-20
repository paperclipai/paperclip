-- JAC-4533: Add composite privacy index to cost_events mirroring run_events.
-- The visibility_class, retention_class, redaction_state columns already
-- exist from migration 0210. This index supports retention-policy queries
-- and fail-closed coverage audits across (company_id, visibility_class,
-- retention_class, redaction_state) — mirroring run_events_privacy_idx.
CREATE INDEX IF NOT EXISTS "cost_events_company_privacy_idx"
  ON "cost_events" ("company_id", "visibility_class", "retention_class", "redaction_state");
