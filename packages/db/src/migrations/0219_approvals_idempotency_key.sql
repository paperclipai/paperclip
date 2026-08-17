ALTER TABLE "approvals" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_company_idempotency_key_idx" ON "approvals" ("company_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
