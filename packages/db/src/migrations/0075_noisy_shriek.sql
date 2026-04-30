ALTER TABLE "issues" ADD COLUMN "consecutive_task_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_task_failure_at" timestamp with time zone;