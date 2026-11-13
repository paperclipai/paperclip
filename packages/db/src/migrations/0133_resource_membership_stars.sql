ALTER TABLE "agent_memberships" ADD COLUMN IF NOT EXISTS "starred_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN IF NOT EXISTS "starred_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memberships_company_user_starred_idx" ON "agent_memberships" USING btree ("company_id","user_id","starred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_memberships_company_user_starred_idx" ON "project_memberships" USING btree ("company_id","user_id","starred_at");
