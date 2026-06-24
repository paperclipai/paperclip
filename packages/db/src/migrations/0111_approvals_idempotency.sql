ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_company_idempotency_uq"
  ON "approvals" USING btree ("company_id","idempotency_key")
  WHERE "approvals"."idempotency_key" IS NOT NULL;
