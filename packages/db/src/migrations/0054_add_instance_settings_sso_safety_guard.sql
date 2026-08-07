-- Follow-up to 0053_regular_robin_chapel.sql: 0053 already shipped and must not
-- be edited (its content hash is used to detect already-applied migrations).
-- This migration re-applies the same column addition idempotently, guarded by
-- lock/statement timeouts, so it is safe to run directly on any environment --
-- including one where 0053 has already run.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "sso" jsonb DEFAULT '{}'::jsonb NOT NULL;