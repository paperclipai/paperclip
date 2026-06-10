ALTER TABLE "goals" ADD COLUMN "metric_target" numeric;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "metric_current" numeric;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "metric_unit" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "target_date" timestamp with time zone;