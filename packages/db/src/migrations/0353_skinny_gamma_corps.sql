ALTER TABLE "muse_agent_bindings" ADD COLUMN IF NOT EXISTS "grant_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.muse_agent_bindings'::regclass
      AND conname = 'muse_agent_bindings_grant_id_mcp_oauth_grants_id_fk'
  ) THEN
    ALTER TABLE "muse_agent_bindings" ADD CONSTRAINT "muse_agent_bindings_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "muse_bindings_active_grant_uq" ON "muse_agent_bindings" USING btree ("grant_id") WHERE "muse_agent_bindings"."revoked_at" IS NULL AND "muse_agent_bindings"."grant_id" IS NOT NULL;