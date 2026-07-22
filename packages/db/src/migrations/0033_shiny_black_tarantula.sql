ALTER TABLE "companies" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "paused_at" timestamp with time zone;
