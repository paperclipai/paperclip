ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "idempotency_digest" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "payload_digest" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_company_idempotency_key_uq"
  ON "cost_events" USING btree ("company_id", "idempotency_key");
