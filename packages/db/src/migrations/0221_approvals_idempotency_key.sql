-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The idempotency_key column is new and NULL for all existing rows, so the partial unique index (WHERE idempotency_key IS NOT NULL) covers an empty set on all deployed databases and is safe to create atomically.
ALTER TABLE "approvals" ADD COLUMN "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_company_idempotency_uq" ON "approvals" USING btree ("company_id","idempotency_key") WHERE "approvals"."idempotency_key" IS NOT NULL;
