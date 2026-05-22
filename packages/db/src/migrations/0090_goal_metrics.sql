ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "metric_target" numeric;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "metric_current" numeric;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "metric_unit" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "target_date" timestamp with time zone;
