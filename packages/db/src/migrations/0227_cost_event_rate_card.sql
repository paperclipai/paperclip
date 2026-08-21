ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "rate_card_cents" integer DEFAULT 0 NOT NULL;
