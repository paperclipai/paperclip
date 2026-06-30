-- CMP-60: actor audit fields for account.password writes.
-- Adds nullable audit columns to `account` and a new append-only
-- `account_password_change_log` table. Both are backward-compatible
-- (no NOT NULL without default, no FK changes on existing columns).

ALTER TABLE "account"
  ADD COLUMN IF NOT EXISTS "last_password_changed_by_user_id" text,
  ADD COLUMN IF NOT EXISTS "last_password_changed_by_agent_id" text,
  ADD COLUMN IF NOT EXISTS "last_password_change_source" text,
  ADD COLUMN IF NOT EXISTS "last_password_changed_at" timestamptz;

CREATE TABLE IF NOT EXISTS "account_password_change_log" (
  "id" text PRIMARY KEY,
  "account_id" text,
  "target_user_id" text,
  "actor_type" text NOT NULL,
  "actor_user_id" text,
  "actor_agent_id" text,
  "actor_source" text,
  "action" text NOT NULL,
  "method" text NOT NULL,
  "request_path" text NOT NULL,
  "status_code" integer NOT NULL,
  "success" boolean NOT NULL,
  "error_message" text,
  "ip_address" text,
  "user_agent" text,
  "occurred_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "account_password_change_log_occurred_at_idx"
  ON "account_password_change_log" ("occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "account_password_change_log_target_user_id_idx"
  ON "account_password_change_log" ("target_user_id");

CREATE INDEX IF NOT EXISTS "account_password_change_log_actor_user_id_idx"
  ON "account_password_change_log" ("actor_user_id");
