ALTER TABLE "issues" ADD COLUMN "idempotency_key" text;
CREATE UNIQUE INDEX "issues_idempotency_key_uq" ON "issues" USING btree ("company_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL AND "status" NOT IN ('cancelled');
