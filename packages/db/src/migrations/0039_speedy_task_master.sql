ALTER TABLE "issues" ADD COLUMN "process_lost_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "issues_process_lost_retry_at_idx" ON "issues" USING btree ("process_lost_retry_at") WHERE "process_lost_retry_at" IS NOT NULL;
