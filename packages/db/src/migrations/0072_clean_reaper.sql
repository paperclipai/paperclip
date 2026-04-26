ALTER TABLE "agent_wakeup_requests" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_wakeup_requests_status_scheduled_idx" ON "agent_wakeup_requests" USING btree ("status","scheduled_at");--> statement-breakpoint
