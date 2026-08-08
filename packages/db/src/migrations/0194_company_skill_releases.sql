ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "release_id" text;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "release_name" text;--> statement-breakpoint
ALTER TABLE "company_skill_versions" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_versions_skill_release_idx" ON "company_skill_versions" USING btree ("company_skill_id","release_id") WHERE "company_skill_versions"."release_id" is not null;
