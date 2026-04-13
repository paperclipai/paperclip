ALTER TABLE "issues" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "issues_status_scheduled_for_idx" ON "issues" ("status","scheduled_for");--> statement-breakpoint
