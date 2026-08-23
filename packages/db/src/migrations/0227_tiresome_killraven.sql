ALTER TABLE "approvals" ADD COLUMN "withdrawn_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "withdrawn_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_withdrawn_by_agent_id_agents_id_fk" FOREIGN KEY ("withdrawn_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;