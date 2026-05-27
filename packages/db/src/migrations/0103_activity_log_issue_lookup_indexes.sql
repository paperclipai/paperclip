-- Support Paperclip issue activity lookups without planner fallbacks to
-- activity_log-wide parallel scans. Production creates these concurrently
-- out-of-band; this migration is intentionally non-concurrent because the
-- app migrator runs pending migrations inside a transaction and reconciles
-- already-present indexes by name.
CREATE INDEX IF NOT EXISTS "idx_activity_log_issue_company_entity_created"
  ON "activity_log" USING btree ("company_id", "entity_id", "created_at" DESC, "id" DESC)
  WHERE "entity_type" = 'issue';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_log_issue_company_entity_action_created"
  ON "activity_log" USING btree ("company_id", "entity_id", "action", "created_at" DESC, "id" DESC)
  WHERE "entity_type" = 'issue';
