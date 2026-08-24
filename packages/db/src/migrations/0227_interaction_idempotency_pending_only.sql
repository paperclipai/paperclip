-- Scope the interaction idempotency uniqueness to still-pending rows.
--
-- The old index covered every row with a non-null idempotency key, so a key was
-- burned for good once its interaction went terminal: a confirmation superseded
-- by a board comment could never be asked again on that issue, and no withdraw
-- path exists to free the key. Terminal rows keep their key for the audit trail
-- but no longer block a fresh ask under it.
--
-- Narrowing a partial unique index can never fail on existing data: the new
-- predicate selects a subset of the rows the old one already held unique.
DROP INDEX IF EXISTS "issue_thread_interactions_company_issue_idempotency_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_thread_interactions_company_issue_idempotency_uq" ON "issue_thread_interactions" USING btree ("company_id","issue_id","idempotency_key") WHERE "issue_thread_interactions"."idempotency_key" IS NOT NULL AND "issue_thread_interactions"."status" = 'pending';
