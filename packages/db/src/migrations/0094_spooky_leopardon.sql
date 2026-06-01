ALTER TABLE "issue_comments" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "redacted_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "redacted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "redaction_reason" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_redacted_by_agent_id_agents_id_fk" FOREIGN KEY ("redacted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;