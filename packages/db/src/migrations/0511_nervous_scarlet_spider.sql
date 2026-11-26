ALTER TABLE "agents" ADD COLUMN "delegated_hire" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "reporting_line_policy" jsonb;