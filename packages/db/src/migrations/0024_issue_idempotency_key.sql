ALTER TABLE "issues" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_company_idempotency_key_open_idx" ON "issues" ("company_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL AND "status" NOT IN ('done', 'cancelled');
