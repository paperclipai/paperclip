-- Rename "board" → "operator" across the auth model.
-- Code-side rename: actor.type = "board" → "operator", schema/services/routes
-- all renamed in the matching commit. This migration brings the DB into line.

-- Table rename
ALTER TABLE "board_api_keys" RENAME TO "operator_api_keys";--> statement-breakpoint

-- Indexes on the renamed table
ALTER INDEX "board_api_keys_key_hash_idx" RENAME TO "operator_api_keys_key_hash_idx";--> statement-breakpoint
ALTER INDEX "board_api_keys_user_idx" RENAME TO "operator_api_keys_user_idx";--> statement-breakpoint

-- Foreign-key constraint on the renamed table (auto-named by drizzle)
ALTER TABLE "operator_api_keys" RENAME CONSTRAINT "board_api_keys_user_id_user_id_fk" TO "operator_api_keys_user_id_user_id_fk";--> statement-breakpoint

-- Referencing column + FK on cli_auth_challenges
ALTER TABLE "cli_auth_challenges" RENAME COLUMN "board_api_key_id" TO "operator_api_key_id";--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" RENAME CONSTRAINT "cli_auth_challenges_board_api_key_id_board_api_keys_id_fk" TO "cli_auth_challenges_operator_api_key_id_operator_api_keys_id_fk";--> statement-breakpoint

-- requested_access enum-ish column: existing rows + default were the literal "board"
UPDATE "cli_auth_challenges" SET "requested_access" = 'operator' WHERE "requested_access" = 'board';--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ALTER COLUMN "requested_access" SET DEFAULT 'operator';--> statement-breakpoint

-- companies.require_board_approval_for_new_agents
ALTER TABLE "companies" RENAME COLUMN "require_board_approval_for_new_agents" TO "require_operator_approval_for_new_agents";--> statement-breakpoint

-- Update the local-trusted implicit user_id literal everywhere it was persisted
UPDATE "user" SET "id" = 'local-operator' WHERE "id" = 'local-board';--> statement-breakpoint
UPDATE "instance_user_roles" SET "user_id" = 'local-operator' WHERE "user_id" = 'local-board';--> statement-breakpoint
UPDATE "operator_api_keys" SET "user_id" = 'local-operator' WHERE "user_id" = 'local-board';
