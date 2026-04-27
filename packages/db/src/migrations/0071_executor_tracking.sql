ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "executor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "checkout_history" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_executor_agent_id_agents_id_fk" FOREIGN KEY ("executor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
