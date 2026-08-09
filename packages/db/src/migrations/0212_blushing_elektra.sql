SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "enforce_agent_ownership" boolean DEFAULT false NOT NULL;
