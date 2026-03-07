ALTER TABLE "agent_wakeup_requests" ADD COLUMN "scheduled_for" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "agent_wakeup_requests_scheduled_idx" ON "agent_wakeup_requests" USING btree ("status","scheduled_for") WHERE "status" = 'scheduled' AND "scheduled_for" IS NOT NULL;
