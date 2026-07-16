CREATE TABLE IF NOT EXISTS "issue_create_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_create_idempotency_keys_company_key_uq"
  ON "issue_create_idempotency_keys" USING btree ("company_id", "idempotency_key");
