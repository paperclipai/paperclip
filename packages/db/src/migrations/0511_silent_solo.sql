ALTER TABLE "agents" ADD COLUMN "hired_through_staffing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "staffing_policy" jsonb;