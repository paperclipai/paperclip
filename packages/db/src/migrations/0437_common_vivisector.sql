DROP INDEX IF EXISTS "issues_conversation_identity_idx";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_default" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_conversation_identity_idx" ON "issues" USING btree ("company_id","conversation_agent_id","conversation_user_id") WHERE "issues"."conversation_default" = true;
