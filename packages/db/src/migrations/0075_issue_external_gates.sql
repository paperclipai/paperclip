ALTER TABLE "issues" ADD COLUMN "blocked_reason_code" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_gate" jsonb;