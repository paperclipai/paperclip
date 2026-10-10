-- Extend "adapter_auth_sessions" to hold both login flows. The migration adds
-- the public session id and the claim marker, and it re-scopes the active
-- credential slot to company + owner + adapter. The migration copies no rows
-- from "claude_setup_token_sessions"; that table stays in place for a later drop.
--
-- NOT NULL on a live table: "public_session_id" is a new non-null column with no
-- default, and "adapter_auth_sessions" can hold rows when the migration runs. The
-- rows are short-lived login sessions, and the board excluded deploy-window
-- support, so the migration deletes the existing rows instead of a backfill of a
-- generated value. A dropped login session re-starts on the next request. The
-- table stays small because the reaper removes finished rows, so the one-time
-- full delete is safe.
DELETE FROM "adapter_auth_sessions";--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD COLUMN "public_session_id" varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD COLUMN "bound_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "adapter_auth_sessions_company_adapter_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_auth_sessions_company_owner_adapter_active_uq" ON "adapter_auth_sessions" USING btree ("company_id","started_by_user_id","adapter_type") WHERE "adapter_auth_sessions"."status" IN ('starting', 'waiting_for_user', 'promoting', 'awaiting_code', 'submitting');--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_auth_sessions_public_session_id_uq" ON "adapter_auth_sessions" USING btree ("public_session_id");
