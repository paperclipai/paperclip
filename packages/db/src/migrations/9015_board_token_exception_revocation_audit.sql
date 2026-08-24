ALTER TABLE "board_token_exceptions"
  ADD COLUMN IF NOT EXISTS "revoked_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "board_token_exceptions"
  ADD COLUMN IF NOT EXISTS "revoked_by_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "board_token_exceptions"
  ADD COLUMN IF NOT EXISTS "revocation_reason" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "board_token_exceptions" ADD CONSTRAINT "board_token_exceptions_revoked_by_agent_id_agents_id_fk" FOREIGN KEY ("revoked_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_token_exceptions_one_unrevoked_scope_idx"
  ON "board_token_exceptions" USING btree ("company_id", "issue_id", COALESCE("agent_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "revoked_at" IS NULL;
