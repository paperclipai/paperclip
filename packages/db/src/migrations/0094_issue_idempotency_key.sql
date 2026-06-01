ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_company_idempotency_key_uq" ON "issues" USING btree ("company_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
