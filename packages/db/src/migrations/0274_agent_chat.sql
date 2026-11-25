-- Idempotent for development instances that applied the pre-release chat migrations.
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "client_request_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "conversation_session_generation" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_state" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_session_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "conversation_boundary_comment_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issues_conversation_agent_id_agents_id_fk' AND conrelid = 'issues'::regclass) THEN
    ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_agent_id_agents_id_fk" FOREIGN KEY ("conversation_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_conversation_identity_idx" ON "issues" USING btree ("company_id","conversation_agent_id","conversation_user_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_client_request_uq' AND conrelid = 'issue_comments'::regclass) THEN
    ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_client_request_uq" UNIQUE("issue_id","author_user_id","client_request_id");
  END IF;
END $$;--> statement-breakpoint
-- The first development guard allowed NULL through SQL three-valued logic.
-- Recover the server-owned idle/active state before enforcing the stronger guard.
UPDATE "issues" SET "conversation_state" = CASE WHEN "status" = 'in_review' THEN 'waiting' ELSE 'active' END
WHERE "conversation_agent_id" IS NOT NULL AND "conversation_state" IS NULL;--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_conversation_identity_check";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_identity_check" CHECK ((
      "issues"."conversation_agent_id" is null and "issues"."conversation_user_id" is null and "issues"."conversation_state" is null
    ) or (
      "issues"."conversation_agent_id" is not null and "issues"."conversation_user_id" is not null
      and "issues"."assignee_agent_id" = "issues"."conversation_agent_id" and "issues"."assignee_agent_id" is not null
      and "issues"."assignee_user_id" is null and "issues"."conversation_state" is not null
      and "issues"."conversation_state" in ('active', 'waiting')
      and "issues"."status" not in ('done', 'cancelled')
    ));
