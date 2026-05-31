ALTER TABLE "issues" ADD COLUMN "reviewer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "reviewer_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;